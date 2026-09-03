// 認定 (client_insurance_records) の重複を「実装がどう選ぶか」の観点で分解する。READ ONLY。
//
//   実装の規則 (src/lib/cert-for-month.ts):
//     対象月に有効な行を certification_start_date DESC → effective_date DESC で並べ、**先頭**を採る。
//   → 重複していても **並べ替えで一意に決まるなら結果は同じ**。
//     問題になるのは「内容が違うのに start も effective も同着」= **並び順で結果が変わる**組。
//
//   使い方: npx tsx scripts/check-cert-overlap.mts [YYYY-MM]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const MONTH = process.argv[2] ?? "2026-06";
const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

type Cert = {
  id: string; client_id: string;
  certification_start_date: string | null; certification_end_date: string | null;
  effective_date: string | null; care_level: string | null;
  insurer_number: string | null; insured_number: string | null;
  copay_rate: string | null; benefit_rate: string | null; service_limit_amount: number | null;
  created_at: string | null;
};

async function all<T>(t: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from(t).select(cols).order("id").range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...(data as unknown as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

const from = `${MONTH}-01`;
const to = `${MONTH}-31`;
const certs = await all<Cert>("client_insurance_records",
  "id,client_id,certification_start_date,certification_end_date,effective_date,care_level,insurer_number,insured_number,copay_rate,benefit_rate,service_limit_amount,created_at");
console.log(`client_insurance_records: ${certs.length} 行 ← 分母`);

const validIn = (c: Cert) =>
  !(c.certification_start_date && c.certification_start_date > to) &&
  !(c.certification_end_date && c.certification_end_date < from);
const live = certs.filter(validIn);
const byClient = new Map<string, Cert[]>();
for (const c of live) {
  const l = byClient.get(c.client_id) ?? []; l.push(c); byClient.set(c.client_id, l);
}
const dup = [...byClient.entries()].filter(([, l]) => l.length > 1);
console.log(`  ${MONTH} に有効な認定を持つ利用者: ${byClient.size} 名`);
console.log(`  そのうち **2 件以上**持つ (= 重複): ${dup.length} 名\n`);

// 実装が見る値だけを比べる (id/created_at 等は無視)
const sig = (c: Cert) => JSON.stringify([c.care_level, c.insurer_number, c.insured_number, c.copay_rate, c.benefit_rate, c.service_limit_amount]);
// 実装の並べ替えキー
const sortKey = (a: Cert, b: Cert) =>
  (b.certification_start_date ?? "").localeCompare(a.certification_start_date ?? "") ||
  (b.effective_date ?? "").localeCompare(a.effective_date ?? "");

let same = 0, deterministic = 0, ambiguous = 0;
const ambiguousList: { cid: string; l: Cert[] }[] = [];
const detList: { cid: string; l: Cert[] }[] = [];
for (const [cid, l] of dup) {
  const sigs = new Set(l.map(sig));
  if (sigs.size === 1) { same += 1; continue; }        // 内容が同じ → どれを採っても同じ
  const sorted = [...l].sort(sortKey);
  const top = sorted[0];
  const tie = sorted.filter((c) =>
    c.certification_start_date === top.certification_start_date &&
    c.effective_date === top.effective_date);
  if (tie.length > 1 && new Set(tie.map(sig)).size > 1) {
    ambiguous += 1; ambiguousList.push({ cid, l: sorted });
  } else { deterministic += 1; detList.push({ cid, l: sorted }); }
}
console.log(`重複 ${dup.length} 名 ← 分母`);
console.log(`  ① 内容が完全に同じ (どれを採っても同じ)          : ${same} 名`);
console.log(`  ② 内容は違うが **並べ替えで一意に決まる**          : ${deterministic} 名`);
console.log(`  ③ ★ 内容が違い start も effective も同着 (不定)   : ${ambiguous} 名`);

// 実害の分母: 対象月に実績がある人
const ids = dup.map(([cid]) => cid);
const withActual = new Set<string>();
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const { data: sc } = await sb.from("kaigo_visit_schedule").select("user_id")
    .in("user_id", chunk).gte("visit_date", from).lte("visit_date", to);
  for (const r of sc ?? []) withActual.add(r.user_id);
  // ⚠ 重複者は **居宅の利用者**が多い。訪問シフトだけを見ると 0 件になり分母を取り違える
  const { data: cs } = await sb.from("kaigo_care_support_claims").select("user_id")
    .in("user_id", chunk).eq("billing_month", MONTH);
  for (const r of cs ?? []) withActual.add(r.user_id);
}
console.log(`\n  重複者のうち ${MONTH} に動きがある (訪問シフト or 居宅レセプト): ${withActual.size} 名 ← **実害の分母**`);
console.log(`     うち ② (一意に決まる): ${detList.filter((x) => withActual.has(x.cid)).length} 名`);
console.log(`     うち ③ ★不定        : ${ambiguousList.filter((x) => withActual.has(x.cid)).length} 名`);

const { data: cl } = await sb.from("clients").select("id,name").in("id", dup.map(([cid]) => cid));
const nameOf = new Map((cl ?? []).map((c) => [c.id, c.name]));
{
  let nullOnly = 0, realConflict = 0;
  for (const { l } of ambiguousList) {
    // ⚠ 2026-09-03 是正: 最初 null を除いて比べ「null との差だけ」を無害に分類したが **誤り**。
    //   copay_rate が null の行が採用されると aggregate.ts:1310 が **既定 1 割**に倒す。
    //   実際は 2割/3割 の人なら **保険請求が 10〜20% 過大**になる (後 貞雄で実測 1,231円/月)。
    //   → null と値の食い違いは「差が無い」のではなく **最も危険な競合**。
    const vals = (k: keyof Cert) => new Set(l.map((c) => c[k]).filter((v) => v !== null && v !== ""));
    const conflict = (["care_level", "benefit_rate", "service_limit_amount", "insurer_number", "insured_number", "copay_rate"] as (keyof Cert)[])
      .some((k) => vals(k).size > 1);
    const isNull = (v: unknown) => v === null || v === "";
    const copayNullSplit =
      l.some((c) => isNull(c.copay_rate)) && l.some((c) => !isNull(c.copay_rate) && Number(c.copay_rate) > 1);
    if (conflict || copayNullSplit) realConflict += 1; else nullOnly += 1;
  }
  console.log(`
  ③ の内訳: **値どうしが食い違う ${realConflict} 名** / null と値の差だけ ${nullOnly} 名`);
  // ★ 本当に危ないのは 「値が食い違う」× 「当月に動きがある」の積
  const hot = ambiguousList.filter(({ cid, l }) => {
    if (!withActual.has(cid)) return false;
    const vals = (k: keyof Cert) => new Set(l.map((c) => c[k]).filter((v) => v !== null && v !== ""));
    const isNull = (v: unknown) => v === null || v === "";
    const copayNullSplit =
      l.some((c) => isNull(c.copay_rate)) && l.some((c) => !isNull(c.copay_rate) && Number(c.copay_rate) > 1);
    return copayNullSplit || (["care_level", "benefit_rate", "service_limit_amount", "insurer_number", "insured_number", "copay_rate"] as (keyof Cert)[])
      .some((k) => vals(k).size > 1);
  });
  console.log(`  ★★ 値が食い違い かつ 当月に動きがある: **${hot.length} 名** ← 保険請求が 10〜20% 過大になりうる本命`);
  // 値が食い違う 5 名を名指しで出す (0 名が偽陰性でないかの確認)
  const conflictAll = ambiguousList.filter(({ l }) => {
    const vals = (k: keyof Cert) => new Set(l.map((c) => c[k]).filter((v) => v !== null && v !== ""));
    return (["care_level", "benefit_rate", "service_limit_amount", "insurer_number", "insured_number", "copay_rate"] as (keyof Cert)[])
      .some((k) => vals(k).size > 1);
  });
  console.log(`  値が食い違う ${conflictAll.length} 名 (当月の動きの有無つき):`);
  for (const { cid, l } of conflictAll) {
    console.log(`     ${nameOf.get(cid) ?? cid.slice(0, 8)}  ${withActual.has(cid) ? "★動きあり" : "動きなし"}`);
    for (const c of l) console.log(`        ${c.care_level} 負担${c.copay_rate} 給付${c.benefit_rate} 限度${c.service_limit_amount} (作成 ${String(c.created_at).slice(0, 10)})`);
  }
  for (const { cid, l } of hot) {
    console.log(`     ${nameOf.get(cid) ?? cid.slice(0, 8)}`);
    for (const c of l) console.log(`        ${c.certification_start_date}〜${c.certification_end_date} eff=${c.effective_date} ${c.care_level} 負担${c.copay_rate} 給付${c.benefit_rate} 限度${c.service_limit_amount} (作成 ${String(c.created_at).slice(0, 10)})`);
  }
}
if (ambiguousList.length) {
  console.log(`\n=== ③ 不定な組 (実装の並べ替えでは決まらない) ===`);
  for (const { cid, l } of ambiguousList.slice(0, 8)) {
    console.log(`  ${nameOf.get(cid) ?? cid.slice(0, 8)}${withActual.has(cid) ? "  ★実績あり" : ""}`);
    for (const c of l) console.log(`     ${c.certification_start_date}〜${c.certification_end_date} eff=${c.effective_date} ${c.care_level} 負担${c.copay_rate} 給付${c.benefit_rate} 限度${c.service_limit_amount} (作成 ${String(c.created_at).slice(0, 10)})`);
  }
}
console.log(`\n=== ② 一意に決まる組の例 (先頭が採用される) ===`);
for (const { cid, l } of detList.slice(0, 5)) {
  console.log(`  ${nameOf.get(cid) ?? cid.slice(0, 8)}${withActual.has(cid) ? "  ★実績あり" : ""}`);
  for (const [i, c] of l.entries()) console.log(`     ${i === 0 ? "→採用" : "     "} ${c.certification_start_date}〜${c.certification_end_date} eff=${c.effective_date} ${c.care_level} 負担${c.copay_rate} 給付${c.benefit_rate} 限度${c.service_limit_amount}`);
}

// 出どころ (created_at が同一 = 一括取込で二重に入った疑い)
const sameCreated = dup.filter(([, l]) => new Set(l.map((c) => String(c.created_at).slice(0, 19))).size === 1).length;
console.log(`\n=== 出どころ ===`);
console.log(`  重複の created_at が **秒まで同一** (= 同じ取込で二重に入った疑い): ${sameCreated} / ${dup.length} 名`);
const cd = new Map<string, number>();
for (const [, l] of dup) for (const c of l) { const d = String(c.created_at).slice(0, 10); cd.set(d, (cd.get(d) ?? 0) + 1); }
console.log(`  作成日の分布: ${[...cd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d, n]) => `${d}=${n}`).join(" / ")}`);

// ①(給付率矛盾 36件) と重なるか
const bad = live.filter((c) => {
  const cp = Number(c.copay_rate), bf = Number(c.benefit_rate);
  if (!Number.isFinite(cp) || !Number.isFinite(bf) || cp <= 0 || bf <= 0) return false;
  const cpPct = cp >= 10 ? cp : cp * 10;   // "1"/"10" の揺れを吸収
  const bfPct = bf >= 10 ? bf : bf * 10;
  return cpPct + bfPct !== 100;
});
const badClients = new Set(bad.map((c) => c.client_id));
const both = dup.filter(([cid]) => badClients.has(cid)).length;
console.log(`\n=== ① 負担割合と給付率が矛盾する認定との重なり ===`);
console.log(`  矛盾する行: ${bad.length} 行 / ${live.length} 行 (${MONTH} 有効) ← 分母`);
console.log(`  矛盾を持つ利用者: ${badClients.size} 名`);
console.log(`  ★ 重複と矛盾の **両方**に該当: ${both} 名`);
