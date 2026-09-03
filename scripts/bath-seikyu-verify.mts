/**
 * 訪問入浴介護 請求集計の検証
 *
 * ⚠ DB には書き込まない。§A は supabase をモックして分岐を決定的に通す。
 * ⚠ `kaigo_bath_visit_records` は **0 行 = 稼働前**。実データが無いので
 *   「実データで確認した」とは言えない。**コードで分かる範囲**の検証であることを明記する (3-6)。
 *   稼働前だからこそ、金額が動く前に捕まえられる。
 *
 * 制度 (memory project_kaigo_bath_visit):
 *   減算軸は **「看護職員が入ったか (staff_only)」** と **「部分浴・清拭か」**。
 *   ⚠「3人体制/2人体制で単価が変わる」ではない。
 *     121111 全身浴 / 121112 部分浴・清拭 / 121121・121122 が職員のみ(看護職員同行なし)減算
 *   加算: 初回 124113 (200単位/月・限度額管理**対象**) /
 *         認知症専門ケア 126133・126134 (/回) /
 *         中山間 128110 (所定×5%・限度額管理**対象外**)
 *
 * 使い方: npx tsx scripts/bath-seikyu-verify.mts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateBathVisitSeikyu } from "../src/lib/bath-seikyu/aggregate";
import { buildKokuhoDensou } from "../src/lib/kokuho-densou/build";

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
  serviceCodes: Row[];
  planUnits: Row[];
  formulaCodes: Row[];
}
const makeMock = (d: MockData): SupabaseClient => {
  const build = (table: string) => {
    const calls: { fn: string; args: unknown[] }[] = [];
    const resolve = () => {
      switch (table) {
        case "kaigo_bath_visit_records": return { data: d.records, error: null };
        case "kaigo_bath_schedule": return { data: [], error: null };
        case "client_insurance_records": return { data: d.certs, error: null };
        case "client_kohi_records": return { data: [], error: null };
        case "bath_monthly_plan_units": return { data: d.planUnits, error: null };
        case "kaigo_office_addon_periods": return { data: [], error: null };
        case "care_offices": return { data: [], error: null };
        case "clients":
          return { data: [{ id: CLIENT, name: "入浴太郎", furigana: "ニュウヨクタロウ", user_number: "1", gender: "男", birth_date: "1940-01-01" }], error: null };
        case "kaigo_service_codes":
          // formula 付きの問い合わせ (処遇改善の率解決) だけ formulaCodes を返す
          return calls.some((c) => c.fn === "not")
            ? { data: d.formulaCodes, error: null }
            : { data: d.serviceCodes, error: null };
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

const MASTER: Row[] = [
  { service_code: "121111", service_name: "訪問入浴介護", short_name: "全身浴", units: 1266 },
  { service_code: "121112", service_name: "訪問入浴介護・部分浴", short_name: "部分浴", units: 1140 },
  { service_code: "121121", service_name: "訪問入浴介護・職員のみ", short_name: "全身浴職員のみ", units: 1140 },
  { service_code: "124113", service_name: "訪問入浴初回加算", short_name: "初回", units: 200 },
  { service_code: "126133", service_name: "訪問入浴認知症専門ケア加算Ⅰ", short_name: "認知Ⅰ", units: 3 },
  { service_code: "126134", service_name: "訪問入浴認知症専門ケア加算Ⅱ", short_name: "認知Ⅱ", units: 4 },
  { service_code: "128110", service_name: "訪問入浴中山間地域等提供加算", short_name: "中山間", units: 0 },
];

const rec = (over: Row = {}): Row => ({
  client_id: CLIENT, visit_date: "2026-06-03", service_code: "121111",
  addon_shokai: false, addon_ninchi: null, addon_chuusankan: false,
  actual: true, planned: true, status: "confirmed", office_id: OFFICE, ...over,
});
const baseData = (over: Partial<MockData> = {}): MockData => ({
  records: [rec()],
  certs: [{
    client_id: CLIENT, insurer_number: "121012", insured_number: "0000000001",
    care_level: "要介護3", copay_rate: "1", service_limit_amount: 27048,
    certification_start_date: "2026-01-01", certification_end_date: "2027-12-31",
    care_office_id: null, care_office_number: null, care_office_name: null,
    certification_status: "認定済み",
  }],
  serviceCodes: MASTER,
  planUnits: [],
  formulaCodes: [],
  ...over,
});

const run = (d: MockData, opts: Record<string, unknown> = {}) =>
  aggregateBathVisitSeikyu(makeMock(d), {
    officeId: OFFICE, tenantId: "kt-group", year: 2026, month: 6, unitPrice: 10.0, ...opts,
  });
const row0 = async (d: MockData, opts: Record<string, unknown> = {}) => (await run(d, opts)).rows[0];

console.log("\n=== §A-1 基本: 全身浴 1 回 ===");
{
  const r = await row0(baseData());
  check("単位数 1266", r?.totalUnits, 1266);
  check("総額 = 1266 × 10.00 = 12,660 円", r?.totalAmount, 12660);
  check("保険 9 割 = 11,394 円", r?.insuranceAmount, 11394);
  check("利用者 1 割 = 1,266 円", r?.userAmount, 1266);
  check("恒等式: 総額 = 保険 + 利用者", (r?.insuranceAmount ?? 0) + (r?.userAmount ?? 0), r?.totalAmount);
}

console.log("\n=== §A-2 減算軸は「看護職員が入ったか」と「部分浴か」 ===");
{
  const d = baseData({ records: [rec({ service_code: "121112" })] });
  check("部分浴 121112 = 1140 単位", (await row0(d))?.totalUnits, 1140);
}
{
  const d = baseData({ records: [rec({ service_code: "121121" })] });
  check("職員のみ (看護職員同行なし) 121121 = 1140 単位", (await row0(d))?.totalUnits, 1140);
}

console.log("\n=== §A-3 加算 ===");
{
  // 初回加算 200単位/月。月1回だけ (2回入浴しても 1 回)
  const d = baseData({ records: [rec({ addon_shokai: true }), rec({ visit_date: "2026-06-10", addon_shokai: true })] });
  const r = await row0(d);
  check("全身浴2回 + 初回200 = 1266×2 + 200 = 2,732", r?.totalUnits, 2732);
  check("初回加算は月1回だけ", r?.details?.filter((x) => x.service_code === "124113").length, 1);
}
{
  // 認知症専門ケアは「回」ごと
  const d = baseData({ records: [rec({ addon_ninchi: "I" }), rec({ visit_date: "2026-06-10", addon_ninchi: "I" })] });
  const r = await row0(d);
  const n = r?.details?.find((x) => x.service_code === "126133");
  check("認知症専門ケアⅠ は 2 回", n?.count, 2);
  check("認知症専門ケアⅠ 3単位 × 2 回 = 6", n?.units, 6);
}
{
  // 中山間 = 所定単位 × 5%
  const d = baseData({ records: [rec({ addon_chuusankan: true })] });
  const r = await row0(d);
  const c = r?.details?.find((x) => x.service_code === "128110");
  check("中山間 = 1266 × 5% = 63 単位", c?.units, Math.round(1266 * 0.05));
  check("中山間を含む合計 = 1266 + 63", r?.totalUnits, 1266 + 63);
}

console.log("\n=== §A-4 限度額超過は全額自費に分離 ===");
{
  // 要介護3 の限度額 27,048。全身浴 1266 × 25 回 = 31,650 → 超過 4,602
  const recs = Array.from({ length: 25 }, (_, i) =>
    rec({ visit_date: `2026-06-${String(i + 1).padStart(2, "0")}` }));
  const r = await row0(baseData({ records: recs }));
  check("総単位 (基準内) = 27,048", r?.baseUnits, 27048);
  check("超過単位 = 31,650 − 27,048 = 4,602", r?.overUnits, 31650 - 27048);
  check("超過は全額自費 (10割)", r?.selfPayAmount, 46020);
  check("保険請求は基準内のみ", r?.insuranceAmount, Math.floor((27048 * 1000) / 100 / 10 * 9));
}

console.log("\n=== §A-5 ★ 計画単位数 > 認定の限度額 で警告が出るか (今回追加) ===");
{
  // 認定 27,048 に対し 計画 40,000 → 警告。⚠ 金額は変えない (min で切り詰めない)
  const recs = Array.from({ length: 25 }, (_, i) =>
    rec({ visit_date: `2026-06-${String(i + 1).padStart(2, "0")}` }));
  const d = baseData({ records: recs, planUnits: [{ client_id: CLIENT, target_month: "2026-06", planned_units: 40000 }] });
  const res = await run(d);
  const warned = res.warnings.some((w) => w.includes("計画単位数") && w.includes("超えています"));
  check("★ 警告が出る", warned, true);
  // 負のコントロール: 計画 < 認定 なら出ない (3-9)
  const d2 = baseData({ records: recs, planUnits: [{ client_id: CLIENT, target_month: "2026-06", planned_units: 20000 }] });
  const res2 = await run(d2);
  check("計画 < 認定 なら警告は出ない (負のコントロール)", res2.warnings.some((w) => w.includes("計画単位数")), false);
  // 挙動は変えていないこと: 計画 40,000 が基準値になり超過 0
  check("金額は変えない (計画が基準値になり超過 0)", res.rows[0]?.overUnits, 0);
}

console.log("\n=== §A-6 負担割合の正規化 / 単価 0 の扱い ===");
{
  const d = baseData();
  (d.certs[0] as Row).copay_rate = "3"; // 3割
  const r = await row0(d);
  check("copay_rate 3 → 3割負担 (12,660 の 30%)", r?.userAmount, 12660 - Math.floor((12660 * 7) / 10));
}
{
  // 単価 0 は「未設定」扱いで 10.00 に倒す (0 円請求を防ぐ)
  const r = await row0(baseData(), { unitPrice: 0 });
  check("単価 0 → 10.00 円に倒す (総額 12,660)", r?.totalAmount, 12660);
}

console.log("\n=== §A-7 処遇改善 (月次%) ===");
{
  const d = baseData({
    formulaCodes: [{ service_code: "126275", service_name: "訪問入浴処遇改善加算Ⅰ", formula: { type: "monthly_aggregate", numerator: 100, denominator: 1000 } }],
  });
  const r = await row0(d, { appliedFormulaCodes: ["126275"] });
  check("処遇改善 10% = round(1266 × 100/1000) = 127", r?.addonUnits, Math.round((1266 * 100) / 1000));
  check("限度額管理対象外に算入される", r?.kanriTaishougaiUnits, Math.round((1266 * 100) / 1000));
}
{
  // 適用コードが空 = 処遇改善 0 (今の3事業所の状態)
  const r = await row0(baseData(), { appliedFormulaCodes: [] });
  check("適用コードが空 → 処遇改善 0 単位", r?.addonUnits, 0);
}

console.log("\n=== §B 加算が **明細書 (7131-02)** にも出るか ===");
// ⚠ ここまでの §A は **集計 (aggregate) の値**しか見ていない。
//   加算が合計単位に入っていても **明細行として伝送に出ない**ことがありうる。
//   移動支援で実際に起きた型 (memory feedback_addon_rows_leak_downstream:
//   「加算行は notes にしか無く下流に漏れる」/「記録票には○が出るのに明細書に出ない」)。
//   ★ 集計と伝送の両方を見ないと、この非対称は捕まらない。
{
  const d = baseData({
    records: [
      rec({ addon_shokai: true, addon_ninchi: "II", addon_chuusankan: true }),
      rec({ visit_date: "2026-06-17" }),
    ],
  });
  const r = await run(d, { appliedFormulaCodes: [] });
  const built = buildKokuhoDensou(r.rows as never[], {
    officeNumber: "1272401058", year: 2026, month: 6, unitPrice: 10,
    seikyuYear: 2026, seikyuMonth: 7,
  });
  const lines = built.content.split(/\r?\n/).filter((l) => l.length > 0);
  const col = (l: string, i: number) => (l.split(",")[i] ?? "").replace(/"/g, "").trim();
  // 7131 の 4 列目: 01 = 明細ヘッダ / 02 = 明細行 (bath-sample-check.mts と同じ読み方)
  const meisai = lines.filter((l) => col(l, 2) === "7131" && col(l, 3) === "02");
  // ★ 長さの検査を先に置く (空配列に every/some は無意味 — 規律 2章⑪)
  check("明細行が 1 行以上ある", meisai.length > 0, true);
  const detailCodes = [...new Set((r.rows[0]?.details ?? []).map((x) => x.service_code))];
  check("集計の明細が 4 種 (全身浴/初回/認知Ⅱ/中山間)", detailCodes.length, 4);
  // 伝送の明細行はサービスコードを「種類2桁 + 項目4桁」に分けて持つ
  // (memory feedback_... 2章⑩: 6桁の連番で grep すると別のものに当たる)
  // ⚠ 先頭2列 (種別・連番) があるので 項7/項8 は col 8/9。
  //   最初 col 6+7 で組んで "001210120000000001" (保険者+被保番) が出た。
  //   ★ 値の桁数・書式が想定と違ったら、まず自分のオフセットを疑う (規律 2章)
  const codesInDensou = new Set(meisai.map((l) => col(l, 8) + col(l, 9)));
  console.log(`     集計の明細 ${detailCodes.join("/")} → 伝送 ${[...codesInDensou].join("/")}`);
  for (const c of ["121111", "124113", "126134", "128110"]) {
    check(`★ ${c} が明細書 (7131-02) に出る`, codesInDensou.has(c), true);
  }
}

console.log(`\n=== 結果: PASS ${pass} / FAIL ${fail} ===`);
console.log("⚠ kaigo_bath_visit_records は本番 0 行 (稼働前) のため、これは");
console.log("   **コードで分かる範囲**の検証。実データでの裏取りは稼働後に別途必要。");
if (fail > 0) process.exit(1);
