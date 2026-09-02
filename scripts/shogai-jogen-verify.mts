/**
 * 障害: 利用者負担 と 上限額管理 の検証
 *
 * ⚠ DB には書き込まない。§A は supabase をモックして分岐を決定的に通し、
 *   §B は本番 DB の READ ONLY 参照。
 *
 * 制度: 利用者負担 = min(floor(総費用額 × 10%), 負担上限月額)  ※生保は 0 円
 *       上限額管理結果 区分 1 (管理事業所で充当済) / 3 (管理結果票のとおり調整)
 *         → 当事業所分は管理結果の調整後額に置換
 *       区分 2 (合算が上限以下 = 調整不要) → 置換しない
 *
 * 使い方: npx tsx scripts/shogai-jogen-verify.mts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateMonthlyShogaiSeikyu } from "../src/lib/shogai-seikyu/aggregate";

let pass = 0, fail = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         期待: ${e}\n         実際: ${a}`); }
};

type Row = Record<string, unknown>;
const CLIENT = "11111111-1111-1111-1111-111111111111";
const OFFICE = "22222222-2222-2222-2222-222222222222";

interface MockData {
  records: Row[];
  certs: Row[];
  kanri: Row[];
  serviceCodes: Row[];
}
const makeMock = (d: MockData): SupabaseClient => {
  const build = (table: string) => {
    const calls: { fn: string; args: unknown[] }[] = [];
    const resolve = () => {
      switch (table) {
        case "shogai_service_records": return { data: d.records, error: null };
        case "shougai_certifications": return { data: d.certs, error: null };
        case "shogai_jogen_kanri_results": return { data: d.kanri, error: null };
        case "kaigo_service_codes": return { data: d.serviceCodes, error: null };
        case "clients":
          return { data: [{ id: CLIENT, name: "検証太郎", furigana: "ケンショウタロウ" }], error: null };
        default: return { data: [], error: null };
      }
    };
    const p: Record<string, unknown> = {};
    for (const fn of ["select","in","not","eq","neq","ilike","like","or","gte","lte","gt","lt","order","limit","range","filter","is","contains","overlaps"]) {
      p[fn] = (...args: unknown[]) => { calls.push({ fn, args }); return p; };
    }
    p.then = (res: (v: { data: Row[]; error: null }) => unknown) => res(resolve());
    return p;
  };
  return { from: (t: string) => build(t) } as unknown as SupabaseClient;
};

/** 1 サービス = 1,000 単位 × 単価 10.00 = 10,000 円 になる最小データ */
const baseData = (over: Partial<MockData> = {}): MockData => ({
  records: [{
    client_id: CLIENT, service_type: "居宅介護", service_category: "居宅介護",
    service_code: "111111", unit_count: 1000, service_date: "2026-06-03",
    status: "confirmed", office_id: OFFICE,
  }],
  certs: [{
    client_id: CLIENT, beneficiary_number: "1234567890", insurer_municipality: "121012",
    support_level: "区分3", self_payment_limit: 9300, seiho_flag: false,
    jogen_kanri_kubun: "なし", jogen_kanri_office_number: null, jogen_kanri_office_name: null,
    certification_start_date: "2026-01-01", certification_end_date: "2027-12-31",
    contract_start_date: "2026-01-01",
  }],
  kanri: [],
  serviceCodes: [],
  ...over,
});

const run = (d: MockData) =>
  aggregateMonthlyShogaiSeikyu(makeMock(d), { year: 2026, month: 6, unitPrice: 10.0, officeId: OFFICE });

const row0 = async (d: MockData) => (await run(d)).rows[0];

console.log("\n=== §A-1 基本: 利用者負担 = min(1割, 負担上限月額) ===");
{
  // 総費用 10,000 円 → 1割 1,000 円 < 上限 9,300 円 → 1,000 円
  const r = await row0(baseData());
  check("総費用 10,000 円", r?.totalAmount, 10000);
  check("利用者負担 = 1割の 1,000 円 (上限 9,300 より小さい)", r?.userAmount, 1000);
  check("給付費 = 総費用 - 利用者負担", r?.benefitAmount, 9000);
}

console.log("\n=== §A-2 上限が効く (1割 > 負担上限月額) ===");
{
  // 総費用 200,000 円 → 1割 20,000 円 > 上限 9,300 円 → 9,300 円
  const d = baseData();
  (d.records[0] as Row).unit_count = 20000;
  const r = await row0(d);
  check("総費用 200,000 円", r?.totalAmount, 200000);
  check("利用者負担は上限の 9,300 円で頭打ち", r?.userAmount, 9300);
  check("給付費 190,700 円", r?.benefitAmount, 190700);
}

console.log("\n=== §A-3 境界値: 1割 == 負担上限額 ちょうど / 上限0円 / 総費用0円 ===");
{
  const d = baseData();
  (d.records[0] as Row).unit_count = 9300; // 93,000 円 → 1割 9,300 = 上限ちょうど
  const r = await row0(d);
  check("1割==上限ちょうど なら その額 (二重に引かない)", r?.userAmount, 9300);
}
{
  const d = baseData();
  (d.certs[0] as Row).self_payment_limit = 0; // 低所得等で負担 0 円
  const r = await row0(d);
  check("負担上限 0 円 → 利用者負担 0 円", r?.userAmount, 0);
  check("給付費 = 総費用全額", r?.benefitAmount, 10000);
}
{
  const d = baseData();
  (d.certs[0] as Row).self_payment_limit = null; // 未設定
  const r = await row0(d);
  // ⚠ 上限が未設定だと 1割がそのまま出る (上限で守られない)
  check("負担上限 未設定 → 1割がそのまま (上限で守られない)", r?.userAmount, 1000);
}
{
  const d = baseData();
  (d.records[0] as Row).unit_count = 0;
  const r = await run(d);
  // 実績 0 単位の行が残るか落ちるかは実装依存。落ちるなら「行なし」を明示する
  console.log(`  (総費用 0 円のとき 行は ${r.rows.length} 件)`);
  if (r.rows[0]) {
    check("総費用 0 → 利用者負担 0", r.rows[0].userAmount, 0);
    check("総費用 0 → 給付費 0", r.rows[0].benefitAmount, 0);
  }
}

console.log("\n=== §A-4 生活保護は負担 0 円 (上限より優先) ===");
{
  const d = baseData();
  (d.certs[0] as Row).seiho_flag = true;
  (d.certs[0] as Row).self_payment_limit = 37200; // 生保なら無視される想定
  const r = await row0(d);
  check("生保 → 利用者負担 0 円", r?.userAmount, 0);
  check("生保 → 給付費 = 総費用全額", r?.benefitAmount, 10000);
}

console.log("\n=== §A-5 端数処理の向き (1割は切り捨て) ===");
{
  const d = baseData();
  (d.records[0] as Row).unit_count = 999; // 9,990 円 → 1割 999 円 (割り切れる)
  check("9,990 円 → 999 円", (await row0(d))?.userAmount, 999);
}
{
  const d = baseData();
  (d.records[0] as Row).unit_count = 1; // 10 円 → 1割 1 円
  check("10 円 → 1 円", (await row0(d))?.userAmount, 1);
  const d2 = baseData();
  // 単価 10.05 → 1 単位 = floor(1×1005/100) = 10 円。端数が出る組合せを作る
  (d2.records[0] as Row).unit_count = 3;
  const r2 = (await aggregateMonthlyShogaiSeikyu(makeMock(d2), { year: 2026, month: 6, unitPrice: 10.05, officeId: OFFICE })).rows[0];
  // 3 単位 × 10.05 = 30.15 → floor 30 円 → 1割 floor(3.0) = 3 円
  check("30 円 → 3 円 (切り捨て。切り上げなら 4 円)", r2?.userAmount, Math.floor((r2?.totalAmount ?? 0) / 10));
}

console.log("\n=== §A-6 上限額管理結果 区分 1/2/3 ===");
{
  // 区分1 = 管理事業所で充当済。当事業所分は 0 円になることがある
  const d = baseData({ kanri: [{ client_id: CLIENT, kanri_result: 1, kanri_result_amount: 0, office_id: OFFICE }] });
  (d.records[0] as Row).unit_count = 20000; // 1割 20,000 / 上限 9,300
  const r = await row0(d);
  check("区分1・調整後 0 円 → 利用者負担 0 円", r?.userAmount, 0);
  check("区分1 → 給付費は総費用全額", r?.benefitAmount, 200000);
}
{
  // 区分3 = 管理結果票のとおり調整
  const d = baseData({ kanri: [{ client_id: CLIENT, kanri_result: 3, kanri_result_amount: 4300, office_id: OFFICE }] });
  (d.records[0] as Row).unit_count = 20000;
  const r = await row0(d);
  check("区分3・調整後 4,300 円 → その額", r?.userAmount, 4300);
}
{
  // 区分2 = 合算が上限以下で調整不要 → 置換しない (1割 or 上限のまま)
  const d = baseData({ kanri: [{ client_id: CLIENT, kanri_result: 2, kanri_result_amount: 99999, office_id: OFFICE }] });
  (d.records[0] as Row).unit_count = 20000;
  const r = await row0(d);
  check("区分2 は置換しない (上限 9,300 のまま)", r?.userAmount, 9300);
}
{
  // 調整後額が総費用を超えるケースは総費用で頭打ち (給付費が負にならない)
  const d = baseData({ kanri: [{ client_id: CLIENT, kanri_result: 3, kanri_result_amount: 999999, office_id: OFFICE }] });
  const r = await row0(d);
  check("調整後額 > 総費用 なら総費用で頭打ち", r?.userAmount, 10000);
  check("給付費が負にならない", (r?.benefitAmount ?? -1) >= 0, true);
}

console.log("\n=== §A-7 ★ 上限管理が他事業所なのに管理結果が未入力 ===");
{
  const d = baseData({ kanri: [] });
  (d.certs[0] as Row).jogen_kanri_kubun = "他事業所";
  (d.certs[0] as Row).jogen_kanri_office_number = "1234567890";
  (d.records[0] as Row).unit_count = 20000; // 1割 20,000 / 上限 9,300
  const res = await run(d);
  const r = res.rows[0];
  // 実測: 管理結果が無いと min(1割, 上限) = 9,300 円 をそのまま請求する
  check("管理結果が無くても 9,300 円を請求する (fail-open)", r?.userAmount, 9300);
  const warned = res.warnings.some((w) => w.includes("上限") || w.includes("管理結果"));
  check("★ この集計層は警告を出さない (出るのは check:densou だけ)", warned, false);
  console.log(
    "     ⚠ 他事業所が上限を管理している場合、当事業所の負担額は管理結果票で決まる。" +
      "\n       未入力のまま 9,300 円を立てると **過大請求** になりうる (fail-closed ではない)。",
  );
}

console.log("\n=== §B 本番データ: 他事業所管理で管理結果が未入力の件数 (READ ONLY) ===");
const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL("../.env.local", import.meta.url)), "utf8")
    .split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean)
    .map((m) => [m![1], m![2].replace(/^["']|["']$/g, "")]),
);
const rest = async (p: string) => {
  const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`REST 失敗 (${p.slice(0, 70)}): ${JSON.stringify(j).slice(0, 200)}`);
  return j as Row[];
};
const MONTH = process.env.MONTH ?? "2026-06";
// 月末日は月ごとに違う。"-31" 決め打ちは 6月で date out of range になる
const [MY, MM] = MONTH.split("-").map(Number);
const MEND = `${MONTH}-${String(new Date(MY, MM, 0).getDate()).padStart(2, "0")}`;
const page = async (p: string) => {
  const out: Row[] = [];
  for (let off = 0; ; off += 1000) { const j = await rest(`${p}&order=id&offset=${off}&limit=1000`); out.push(...j); if (j.length < 1000) break; }
  return out;
};
const certs = await rest(
  "shougai_certifications?select=client_id,jogen_kanri_kubun,jogen_kanri_office_number,self_payment_limit," +
    "certification_start_date,certification_end_date",
);
const other = certs.filter((c) => String(c.jogen_kanri_kubun ?? "").trim() === "他事業所");
const otherClients = [...new Set(other.map((c) => String(c.client_id)))];
const results = await rest(`shogai_jogen_kanri_results?select=client_id&target_month=eq.${MONTH}`);
const haveResult = new Set(results.map((r) => String(r.client_id)));
const missing = otherClients.filter((c) => !haveResult.has(c));
console.log(`  受給者証 ${certs.length} 件 (分母) / 上限管理が「他事業所」: ${otherClients.length} 名`);
console.log(`  ${MONTH} の管理結果が登録済み: ${results.length} 件`);
console.log(`  ★ 管理結果が未入力: ${missing.length} 名 (これが check:densou と同じ数え方)`);

// ⚠ 「未入力 = 過大請求」ではない。実際に過大になるのは
//    (a) その月に実績があって請求が立つ かつ (b) 負担上限額 > 0 の人だけ。
//    上限 0 円なら利用者負担も 0 円なので、管理結果が無くても過大にならない。
// ⚠ 障害の実績は **kaigo_visit_schedule (system=障害)** に入っている。
//    shogai_service_records は 0 件なので、そちらだけ見ると「該当0名」に化ける
//    (2026-09-03 に実際に踏んだ)。
const rec = await page(
  `shogai_service_records?select=client_id,status&service_date=gte.${MONTH}-01&service_date=lte.${MEND}`,
);
const sched = await page(
  `kaigo_visit_schedule?select=user_id,status&system=eq.${encodeURIComponent("障害")}` +
    `&visit_date=gte.${MONTH}-01&visit_date=lte.${MEND}`,
);
console.log(`  ${MONTH} の障害実績: shogai_service_records ${rec.length} 件 / kaigo_visit_schedule(障害) ${sched.length} 件`);
const active = new Set<string>([
  ...rec.filter((r) => r.status === "confirmed").map((r) => String(r.client_id)),
  ...sched.filter((s) => s.status === "completed").map((s) => String(s.user_id)),
]);
console.log(`  実績のある実人数: ${active.size}`);
if (otherClients.length === 0) {
  console.log("  ⚠ 分母が 0 のため、この月については判定していません");
} else {
  const billed = missing.filter((c) => active.has(c));
  const limitOf = (c: string) => Number(other.find((o) => String(o.client_id) === c)?.self_payment_limit ?? 0);
  const risky = billed.filter((c) => limitOf(c) > 0);
  console.log(`  └ うち当月に実績がある (= 請求が立つ): ${billed.length} 名`);
  console.log(`    └ ★ うち負担上限額 > 0 (= 実際に過大請求になりうる): ${risky.length} 名`);
  if (risky.length) {
    const names = await rest(`clients?select=id,name&id=in.(${risky.join(",")})`);
    for (const c of risky) {
      const nm = names.find((n) => String(n.id) === c)?.name ?? c.slice(0, 8);
      console.log(`        ${nm}: 負担上限 ${limitOf(c).toLocaleString()} 円/月`);
    }
    console.log("    ⚠ 過大額は「管理結果票の調整後額との差」なので、票が来るまで確定できない");
  }
}

console.log(`\n=== 結果: PASS ${pass} / FAIL ${fail} ===`);
if (fail > 0) process.exit(1);
