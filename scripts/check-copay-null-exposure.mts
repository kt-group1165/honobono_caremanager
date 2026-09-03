/**
 * copay_rate が null の認定が「対象月に採用されている」ことの実害測定。
 *
 *   aggregate.ts:1310 は copay_rate が null のとき **既定 1 割**に倒す。
 *   本当は 2割/3割 の利用者なら **保険請求が 10〜20% 過大**になる。
 *
 *   重複 (同着) ぶんは check:cert-tiebreak が見る。こちらは **単独行を含む全体**。
 *
 *   「本当は 2割/3割」の判定材料は同じ行の benefit_rate。
 *     benefit_rate 90 → 1割 (null でも結果が同じ = 無害)
 *     benefit_rate 80 → 2割 / 70 → 3割 (★ 過大請求)
 *   ⚠ benefit_rate 自体が誤っている可能性は否定できないので、
 *     ここで出るのは **「要確認」の母集団**であって確定した過大額ではない。
 *     確定させるには ほのぼの伝送 KK 7131 項29 (保険給付率) と突合する。
 *
 *   使い方: npx tsx scripts/check-copay-null-exposure.mts [YYYY-MM]
 *   READ ONLY。
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { pickAmongTies } from "../src/lib/cert-for-month";

const MONTH = process.argv[2] ?? "2026-06";
const mStart = `${MONTH}-01`;
const mEnd = `${MONTH}-${String(new Date(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0).getDate()).padStart(2, "0")}`;

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** order 付き page-loop (order 無しページングは行が抜ける) */
async function pageAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const acc: T[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await build(off, off + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    acc.push(...rows);
    if (rows.length < 1000) break;
  }
  return acc;
}

type Cert = {
  client_id: string; certification_start_date: string | null; certification_end_date: string | null;
  effective_date: string | null; care_level: string | null; copay_rate: string | null;
  benefit_rate: string | number | null; service_limit_amount: number | null;
};

console.log(`=== copay_rate null の実害測定 ${MONTH} ===\n`);

const certs = await pageAll<Cert>((f, t) =>
  sb.from("client_insurance_records")
    .select("client_id,certification_start_date,certification_end_date,effective_date,care_level,copay_rate,benefit_rate,service_limit_amount")
    .lte("certification_start_date", mEnd)
    .order("client_id", { ascending: true })
    .order("certification_start_date", { ascending: false, nullsFirst: false })
    .order("effective_date", { ascending: false, nullsFirst: false })
    .range(f, t));

const byClient = new Map<string, Cert[]>();
for (const r of certs) {
  if (!r.certification_start_date) continue;
  if (r.certification_end_date && r.certification_end_date < mStart) continue;
  if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
  byClient.get(r.client_id)!.push(r);
}
console.log(`対象月に有効な認定を持つ client: ${byClient.size} 名`);

// 採用行 (本番と同じ規則)
const picked = new Map<string, Cert>();
for (const [cid, rows] of byClient) {
  const p = pickAmongTies(rows as never) as unknown as Cert | undefined;
  if (p) picked.set(cid, p);
}
const nullCopay = [...picked].filter(([, c]) => c.copay_rate == null || c.copay_rate === "");
console.log(`  うち 採用行の copay_rate が null: **${nullCopay.length} 名** (= 既定 1 割で計算される)`);

// --- 当月に動きがあるか (訪問介護シフト + 居宅レセプト) -------------------
const active = new Set<string>();
// ⚠ 列名は src/lib/active-clients.ts に合わせる。
//   kaigo_visit_schedule は client_id ではなく **user_id / visit_date**、
//   居宅レセプトは care_support_claims ではなく **kaigo_care_support_claims**。
const sched = await pageAll<{ user_id: string }>((f, t) =>
  sb.from("kaigo_visit_schedule").select("user_id")
    .gte("visit_date", mStart).lte("visit_date", mEnd).eq("status", "completed")
    .order("user_id", { ascending: true }).range(f, t));
for (const r of sched) active.add(r.user_id);
const schedOnly = active.size;

const claims = await pageAll<{ user_id: string }>((f, t) =>
  sb.from("kaigo_care_support_claims").select("user_id").eq("billing_month", MONTH)
    .order("user_id", { ascending: true }).range(f, t));
for (const r of claims) active.add(r.user_id);
console.log(`当月に動きがある client: ${active.size} 名 (訪問介護 ${schedOnly} + 居宅レセプト)`);

// --- benefit_rate で「本当は何割か」を推し量る ---------------------------
const hot = nullCopay.filter(([cid]) => active.has(cid));
const bucket = new Map<string, string[]>();
for (const [cid, c] of hot) {
  const b = c.benefit_rate == null || c.benefit_rate === "" ? "null" : String(c.benefit_rate);
  if (!bucket.has(b)) bucket.set(b, []);
  bucket.get(b)!.push(cid);
}

console.log(`\n★ copay null かつ 当月に動きがある: **${hot.length} 名**`);
console.log(`   給付率 (benefit_rate) の内訳:`);
const label: Record<string, string> = {
  "90": "1割 → 既定と同じ。無害",
  "80": "2割 → ★ 保険請求が 10% 過大",
  "70": "3割 → ★ 保険請求が 20% 過大",
  null: "不明 → 判定不能",
};
const over: string[] = [];
for (const [b, ids] of [...bucket].sort((a, b2) => b2[1].length - a[1].length)) {
  console.log(`     給付率 ${b.padEnd(5)} ${String(ids.length).padStart(5)} 名   ${label[b] ?? "★ 想定外の値 — 要確認"}`);
  if (b === "80" || b === "70") over.push(...ids);
}

if (over.length) {
  const names: string[] = [];
  for (let i = 0; i < over.length; i += 150) {
    const { data } = await sb.from("clients").select("id,name").in("id", over.slice(i, i + 150));
    for (const c of data ?? []) names.push(c.name as string);
  }
  console.log(`\n   ★ 過大の疑い ${over.length} 名:`);
  console.log(`     ${names.slice(0, 40).join(" / ")}${names.length > 40 ? ` … 他 ${names.length - 40} 名` : ""}`);
}

// --- 第2の材料: 同じ利用者の **他の認定行** に負担割合が入っていないか ------
//   採用行が null でも、過去/未来の行に 2割/3割 が入っていれば「本当は 1 割ではない」
//   疑いが強まる。DB 内だけで取れる独立した材料なので先に当てる。
const otherIds = hot.map(([cid]) => cid);
const otherCopay = new Map<string, Set<string>>();
for (let i = 0; i < otherIds.length; i += 150) {
  const { data, error } = await sb
    .from("client_insurance_records")
    .select("client_id,copay_rate")
    .in("client_id", otherIds.slice(i, i + 150));
  if (error) { console.error(`✗ ${error.message}`); break; }
  for (const r of (data ?? []) as { client_id: string; copay_rate: string | null }[]) {
    if (r.copay_rate == null || r.copay_rate === "") continue;
    if (!otherCopay.has(r.client_id)) otherCopay.set(r.client_id, new Set());
    otherCopay.get(r.client_id)!.add(String(r.copay_rate));
  }
}
const suspect = hot.filter(([cid]) => {
  const v = otherCopay.get(cid);
  return v && [...v].some((x) => Number(x) > 1);
});
console.log(`\n★★ 採用行は null だが **他の認定行に 2割/3割 が入っている**: ${suspect.length} 名`);
if (suspect.length) {
  const { data } = await sb.from("clients").select("id,name").in("id", suspect.map(([c]) => c));
  const nm = new Map((data ?? []).map((c) => [c.id as string, c.name as string]));
  for (const [cid] of suspect) {
    console.log(`     - ${nm.get(cid) ?? cid}  他行の copay: ${[...(otherCopay.get(cid) ?? [])].join(", ")}`);
  }
}
console.log(`   残り ${hot.length - suspect.length} 名は DB 内に材料が無い (他行も全部 null / 1割)`);

console.log(`\n⚠ benefit_rate 自体が誤っている可能性があるので、これは「要確認」の母集団。`);
console.log(`   確定には ほのぼの伝送 KK 7131 項29 (保険給付率) との突合が要る。`);
