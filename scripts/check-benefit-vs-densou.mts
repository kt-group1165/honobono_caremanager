/**
 * 負担割合 (copay_rate) と 給付率 (benefit_rate) の どちらが正しいかを
 * **ほのぼのの伝送 (KK 7131 項29 保険給付率)** で決める。READ ONLY。
 *
 *   ⚠ 材料は 7131 (訪問介護等の介護給付費明細書) だけ。
 *     居宅の 8124 には 保険給付率 の項目が無いので、**居宅しか使っていない
 *     利用者は判定不能**になる。これは仕様であって取りこぼしではない。
 *
 *   キー: (証記載保険者番号の末尾6桁, 被保険者番号, サービス提供年月)
 *     ⚠ 伝送は 8桁 前0埋め (00121012) / 当方は 6桁 (121012)。末尾6桁で合わせる。
 *     ⚠ 被保険者番号は保険者の中でしか一意でないので、必ず対で引く。
 *
 *   分類:
 *     ① ほのぼの = 100 − 負担割合×10  → 負担割合が正。給付率を直してよい
 *     ② ほのぼの = 給付率              → ★ 給付率が正。**直してはいけない**
 *     ③ どちらとも違う / 伝送に無い     → 判定不能
 *
 *   使い方: npx tsx scripts/check-benefit-vs-densou.mts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ⚠ URL.pathname は %E4%BC%9D… のまま。decodeURIComponent しないとフォルダが見つからず
//   「伝送に無い」が全件に出る (実際に踏んだ)。Windows は先頭の / も落とす。
const ROOT = decodeURIComponent(new URL("../伝送データ/", import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, "");
const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------- 伝送を読む
/** 解説CSV を走査して *_解説.csv のパスを全部集める */
function walk(dir: string, out: string[] = []): string[] {
  let ents: string[];
  try { ents = readdirSync(dir); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (/^KK.*_解説\.csv$/i.test(e)) out.push(p);
  }
  return out;
}

const dec = new TextDecoder("shift_jis");
/** (保険者末尾6|被保番|提供年月) → 給付率 の集合 (複数出たら食い違いとして残す) */
const densou = new Map<string, Set<string>>();
let files = 0;
let rec7131 = 0;

for (const f of walk(ROOT)) {
  const text = dec.decode(readFileSync(f));
  // 解説CSV は  レコード番号,項番,項目名,="値",注記
  const byRec = new Map<number, Map<number, string>>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+),(\d+),[^,]*,="([^"]*)"/.exec(line);
    if (!m) continue;
    const rid = Number(m[1]);
    if (!byRec.has(rid)) byRec.set(rid, new Map());
    byRec.get(rid)!.set(Number(m[2]), m[3]);
  }
  let used = false;
  for (const v of byRec.values()) {
    if (v.get(1) !== "7131") continue;
    const ym = v.get(3) ?? "";
    const insurer = (v.get(5) ?? "").slice(-6); // 8桁前0埋め → 末尾6桁
    const insured = v.get(6) ?? "";
    const rate = v.get(29) ?? "";
    if (!ym || !insurer || !insured || !rate) continue;
    rec7131 += 1;
    used = true;
    const k = `${insurer}|${insured}|${ym}`;
    if (!densou.has(k)) densou.set(k, new Set());
    densou.get(k)!.add(rate);
  }
  if (used) files += 1;
}
console.log(`伝送 (KK 7131): ${files} ファイル / ${rec7131} 明細 / キー ${densou.size} 件\n`);

// ---------------------------------------------------------------- DB を読む
type Cert = {
  id: string; client_id: string; insurer_number: string | null; insured_number: string | null;
  certification_start_date: string | null; certification_end_date: string | null;
  copay_rate: string | null; benefit_rate: string | number | null;
};
const all: Cert[] = [];
for (let off = 0; ; off += 1000) {
  const { data, error } = await sb
    .from("client_insurance_records")
    .select("id,client_id,insurer_number,insured_number,certification_start_date,certification_end_date,copay_rate,benefit_rate")
    .order("id", { ascending: true })
    .range(off, off + 999);
  if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
  const rows = (data ?? []) as unknown as Cert[];
  all.push(...rows);
  if (rows.length < 1000) break;
}
console.log(`認定行: ${all.length} 行`);

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
/** 負担割合 → 給付率 (1割→90 / 2割→80 / 3割→70) */
const benefitFromCopay = (c: number) => 100 - c * 10;

// ⚠ benefit_rate は **単位が混在**している。9 / 8 / 7 は「割」で入っていて 90 / 80 / 70 と同義。
//   正規化せずに比べると「矛盾」を 40 件ほど水増しする (実際に踏んだ)。
const benefitPct = (b: number) => (b > 0 && b <= 10 ? b * 10 : b);

// ★ 対象 = benefit と copay が矛盾する行 (単位を揃えたうえで)
const contradictory = all.filter((r) => {
  const c = num(r.copay_rate), b = num(r.benefit_rate);
  return c != null && b != null && c >= 1 && c <= 3 && benefitPct(b) !== benefitFromCopay(c);
});
const unitOnly = all.filter((r) => {
  const c = num(r.copay_rate), b = num(r.benefit_rate);
  return c != null && b != null && c >= 1 && c <= 3 && b !== benefitFromCopay(c) && benefitPct(b) === benefitFromCopay(c);
}).length;
console.log(`★ benefit と copay が矛盾する行: ${contradictory.length} 行`);
console.log(`  (別に「割で入っているだけで整合している」行が ${unitOnly} 行。矛盾ではない)\n`);

/** その認定が有効な月 (伝送にある月だけ) を返す */
const monthsOf = (r: Cert): string[] => {
  const out: string[] = [];
  const s = r.certification_start_date, e = r.certification_end_date;
  for (const k of densou.keys()) {
    const [ins, num2, ym] = k.split("|");
    if (ins !== (r.insurer_number ?? "").slice(-6) || num2 !== (r.insured_number ?? "")) continue;
    const d = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`;
    if (s && s > `${ym.slice(0, 4)}-${ym.slice(4, 6)}-28`) continue;
    if (e && e < d) continue;
    out.push(ym);
  }
  return out;
};

const cls = new Map<string, string>();
for (let i = 0; i < contradictory.length; i += 150) {
  const { data } = await sb.from("clients").select("id,name").in("id", contradictory.slice(i, i + 150).map((r) => r.client_id));
  for (const c of data ?? []) cls.set(c.id as string, c.name as string);
}

const buckets: Record<"1" | "2" | "3", string[]> = { "1": [], "2": [], "3": [] };
for (const r of contradictory) {
  const c = num(r.copay_rate)!, b = num(r.benefit_rate)!;
  const ms = monthsOf(r);
  const rates = new Set<string>();
  for (const ym of ms) for (const v of densou.get(`${(r.insurer_number ?? "").slice(-6)}|${r.insured_number}|${ym}`) ?? []) rates.add(v);
  const name = cls.get(r.client_id) ?? r.client_id;
  const line = `${name}  当方 負担${c}割(→給付${benefitFromCopay(c)}) / 給付列${b}  伝送 ${[...rates].join(",") || "—"}`;
  if (rates.size === 0) { buckets["3"].push(`${line}   [伝送に無い]`); continue; }
  const only = [...rates];
  if (only.length === 1 && Number(only[0]) === benefitFromCopay(c)) buckets["1"].push(line);
  else if (only.length === 1 && Number(only[0]) === benefitPct(b)) buckets["2"].push(line);
  else buckets["3"].push(`${line}   [どちらとも違う]`);
}

console.log(`① 負担割合が正 (伝送 = 100−負担割合): ${buckets["1"].length} 件  → 給付率を直してよい`);
console.log(`② ★ 給付率が正 (伝送 = 給付率列)   : ${buckets["2"].length} 件  → 直してはいけない`);
console.log(`③ 判定不能                          : ${buckets["3"].length} 件`);
for (const [k, label] of [["1", "①"], ["2", "②"], ["3", "③"]] as const) {
  if (!buckets[k as "1"].length) continue;
  console.log(`\n--- ${label} ---`);
  for (const l of buckets[k as "1"].slice(0, 40)) console.log(`   ${l}`);
  if (buckets[k as "1"].length > 40) console.log(`   … 他 ${buckets[k as "1"].length - 40} 件`);
}

// ------------------------------------------------- copay null 行も同じ材料で見る
//   check:copay-null が出す「当月に動きがある 54 名」を伝送で裏取りする。
//   ⚠ 居宅しか使っていない利用者は 7131 に出ないので材料が無い (8124 に給付率が無い)。
const nullRows = all.filter((r) => (r.copay_rate == null || r.copay_rate === "") && r.insured_number);
const nullHit: string[] = [];
const seen = new Set<string>();
for (const r of nullRows) {
  const rates = new Set<string>();
  for (const ym of monthsOf(r)) {
    for (const v of densou.get(`${(r.insurer_number ?? "").slice(-6)}|${r.insured_number}|${ym}`) ?? []) rates.add(v);
  }
  if (rates.size === 0) continue;
  const key = `${r.client_id}|${[...rates].join(",")}`;
  if (seen.has(key)) continue;
  seen.add(key);
  nullHit.push(`${r.client_id}\t${[...rates].join(",")}\t給付率列=${r.benefit_rate ?? "null"}`);
}
console.log(`\n=== copay null の行を伝送で裏取り ===`);
console.log(`  copay null かつ被保番あり: ${nullRows.length} 行 / 伝送に出た: ${nullHit.length} 名`);
const notTen = nullHit.filter((l) => !/\t90\t/.test(l));
console.log(`  ★ 伝送の給付率が 90 (1割) でない: ${notTen.length} 名  ← 既定 1 割が誤りになるのはここだけ`);
if (notTen.length) {
  const ids = notTen.map((l) => l.split("\t")[0]);
  const { data } = await sb.from("clients").select("id,name").in("id", ids.slice(0, 150));
  const nm = new Map((data ?? []).map((c) => [c.id as string, c.name as string]));
  for (const l of notTen) {
    const [cid, rate, bcol] = l.split("\t");
    console.log(`     - ${nm.get(cid) ?? cid}  伝送 給付率 ${rate}  ${bcol}`);
  }
}

if (buckets["2"].length > 0) {
  console.log(`\n🔴 ② が ${buckets["2"].length} 件ある。「100−負担割合で一律に直す」前提は成り立たない。`);
  process.exit(2);
}
