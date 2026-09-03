/**
 * 認定の「同着重複」で採用行が未定義になっていた問題の 検査 + 実害測定。
 *
 *   背景: cert-for-month.ts の DB order は (start DESC, effective DESC) の 2 キーだけ。
 *   両方が同値の重複行は **並びが Postgres の物理順まかせ = 未定義**で、
 *   `inMonth[0]` がどれになるか実行ごとに変わりうる。
 *   copay_rate が null の行が採られると aggregate.ts が **既定 1 割**に倒すため、
 *   2割/3割 の利用者の **保険請求が 10〜20% 過大**になる。
 *
 *   使い方:
 *     npx tsx scripts/check-cert-tiebreak.mts [YYYY-MM]     # 既定 2026-06
 *
 *   READ ONLY。DB は書き換えない。
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { pickAmongTies } from "../src/lib/cert-for-month";

const MONTH = process.argv[2] ?? "2026-06";
const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------- 単体テスト
type Row = Parameters<typeof pickAmongTies>[0][number];
const row = (o: Partial<Row>): Row =>
  ({
    client_id: "c", insurer_number: null, insurer_name: null, insured_number: null,
    care_level: null, copay_rate: null, certification_start_date: "2025-10-01",
    certification_end_date: null, certification_status: null, service_limit_amount: null,
    care_office_id: null, care_office_number: null, care_office_name: null,
    effective_date: "2025-10-01", ...o,
  }) as Row;

let ng = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  if (!ok) ng += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got=${String(got)} want=${String(want)}`}`);
};

console.log("=== 単体テスト pickAmongTies ===");
// 後 貞雄 の実データ形 (copay: 2, null, 2)。null が先頭に来ても値のある行を採る
t("null が先頭でも値のある行を採る",
  pickAmongTies([row({ copay_rate: null }), row({ copay_rate: "2" })])?.copay_rate, "2");
t("値が先頭ならそのまま",
  pickAmongTies([row({ copay_rate: "2" }), row({ copay_rate: null })])?.copay_rate, "2");
t("同点なら先頭 (安定)",
  pickAmongTies([row({ copay_rate: "2", insured_number: "A" }), row({ copay_rate: "3" })])?.insured_number, "A");
t("空文字も未入力扱い",
  pickAmongTies([row({ copay_rate: "" }), row({ copay_rate: "3" })])?.copay_rate, "3");
t("start が違う行は同着ではない (先頭を採る)",
  pickAmongTies([row({ certification_start_date: "2026-04-01", copay_rate: null }),
                 row({ certification_start_date: "2025-10-01", copay_rate: "2" })])?.certification_start_date,
  "2026-04-01");
t("effective が違う行は同着ではない",
  pickAmongTies([row({ effective_date: "2026-04-01", copay_rate: null }),
                 row({ effective_date: "2025-10-01", copay_rate: "2" })])?.effective_date, "2026-04-01");
t("care_level も完全性に効く",
  pickAmongTies([row({ care_level: null }), row({ care_level: "要介護3" })])?.care_level, "要介護3");
t("空配列は undefined", pickAmongTies([]), undefined);

// ---------------------------------------------------------------- 実害測定
const mStart = `${MONTH}-01`;
const mEnd = `${MONTH}-${String(new Date(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0).getDate()).padStart(2, "0")}`;

console.log(`\n=== 実害測定 ${MONTH} ===`);
type Cert = Row & { id: string };
const all: Cert[] = [];
for (let off = 0; ; off += 1000) {
  const { data, error } = await sb
    .from("client_insurance_records")
    .select("id,client_id,certification_start_date,certification_end_date,effective_date,care_level,copay_rate,service_limit_amount")
    .lte("certification_start_date", mEnd)
    .order("id", { ascending: true }) // ⚠ order 無しページングは行が抜ける
    .range(off, off + 999);
  if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
  const rows = (data ?? []) as unknown as Cert[];
  all.push(...rows);
  if (rows.length < 1000) break;
}

const byClient = new Map<string, Cert[]>();
for (const r of all) {
  if (r.certification_end_date && r.certification_end_date < mStart) continue;
  if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
  byClient.get(r.client_id)!.push(r);
}

const risky: { cid: string; copays: string[] }[] = [];
let dup = 0;
for (const [cid, rows] of byClient) {
  if (rows.length < 2) continue;
  dup += 1;
  // DB order を再現: start DESC, effective DESC
  const sorted = [...rows].sort(
    (a, b) =>
      String(b.certification_start_date ?? "").localeCompare(String(a.certification_start_date ?? "")) ||
      String(b.effective_date ?? "").localeCompare(String(a.effective_date ?? "")),
  );
  const head = sorted[0];
  const tie = sorted.filter(
    (r) => r.certification_start_date === head.certification_start_date && r.effective_date === head.effective_date,
  );
  if (tie.length < 2) continue;
  // ★ 同着の中で copay が「null」と「2割/3割」に割れている = 並び次第で 1割 に化ける
  const hasNull = tie.some((r) => r.copay_rate == null || r.copay_rate === "");
  const hasHigh = tie.some((r) => r.copay_rate != null && r.copay_rate !== "" && Number(r.copay_rate) > 1);
  if (hasNull && hasHigh) risky.push({ cid, copays: tie.map((r) => r.copay_rate ?? "null") });
}

console.log(`  対象月に有効・重複あり: ${dup} 名 (= 分母)`);
console.log(`  ★ 同着内で copay が null と 2割/3割 に割れている: **${risky.length} 名**`);
console.log(`     → 修正前は並び次第で 1 割に化け、保険請求が 10〜20% 過大になりうる`);

if (risky.length) {
  const { data: cl } = await sb.from("clients").select("id,name").in("id", risky.map((r) => r.cid));
  const nameOf = new Map((cl ?? []).map((c) => [c.id as string, c.name as string]));
  for (const r of risky) console.log(`     - ${nameOf.get(r.cid) ?? r.cid}  copay: ${r.copays.join(", ")}`);
}

// 修正後は必ず値のある行が選ばれることを実データで確認する
let stillNull = 0;
for (const r of risky) {
  const rows = byClient.get(r.cid)!;
  const sorted = [...rows].sort(
    (a, b) =>
      String(b.certification_start_date ?? "").localeCompare(String(a.certification_start_date ?? "")) ||
      String(b.effective_date ?? "").localeCompare(String(a.effective_date ?? "")),
  );
  const picked = pickAmongTies(sorted);
  if (picked?.copay_rate == null || picked?.copay_rate === "") stillNull += 1;
}
console.log(`\n  修正後に なお null を採る: ${stillNull} 名 ${stillNull === 0 ? "✓" : "✗"}`);
if (stillNull > 0) ng += 1;

console.log(`\n${ng === 0 ? "✅ PASS" : `❌ FAIL (${ng})`}`);
process.exit(ng === 0 ? 0 : 1);
