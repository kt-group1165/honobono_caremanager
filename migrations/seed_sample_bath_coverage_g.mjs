// 訪問入浴 網羅率向上のための追加サンプル (H割当・user承認済み・2026-09-05)
//
//   node migrations/seed_sample_bath_coverage_g.mjs              # DRY RUN
//   node migrations/seed_sample_bath_coverage_g.mjs --execute    # 投入
//   node migrations/seed_sample_bath_coverage_g.mjs --delete             # 撤去 DRY RUN
//   node migrations/seed_sample_bath_coverage_g.mjs --delete --execute   # 撤去
//
// ── 背景 ────────────────────────────────────────────────────────────────
//   既存の migrations/seed_sample_bath_c.mjs (ZC001-005) が通していない因子を
//   追加投入する。既存分でカバー済み: サービス区分4種(全身浴/部分浴×看護あり/
//   職員のみ)・要介護度(要介護+要支援=B-1w再現)・初回加算・認知症Ⅱ・限度額
//   (内側/超過)・生保公費単独。
//
//   ★ 未カバーだったもの (このscriptで追加):
//     G1 中山間地域等提供加算 (128110)
//     G2 部分公費 (生保以外。振替なしのケース)
//     G3 認知症専門ケアⅠ (126133。既存はⅡのみ)
//     G4 月内の要介護度変更 (detectMidMonthChange)
//     G5 限度額「ちょうど」(bath_monthly_plan_units で計画単位数を明示指定)
//     G6 虐防/業未 減算 (kaigo_office_gensan_periods。事業所単位の一時フラグ)
//
// ⚠ サンプルは2026-12のみ。マーカー必須。撤去後0件確認まで。
// ⚠ office(offices本体)は変更しない。既存の訪問入浴事業所(ムツミ)を使う。
//   G6のみ kaigo_office_gensan_periods という「別テーブル」に一時フラグを
//   立てる(offices行そのものは触らない)。
import {
  sb, TAGS, MONTH, marker,
  sampleClient, sampleInsurance, sampleAssignment, sampleKohi, KOHI_TABLE,
  insertRows, deleteByTag, assertSafeMonth,
} from "./_sample_data.mjs";

assertSafeMonth(MONTH);
const TAG = TAGS.g;
const MK = marker(TAG);
const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");

// ムツミ訪問入浴 (既存サンプルと同じ事業所。offices は変更しない)
const OFFICE_ID = "ec87a203-53e2-40a5-b706-7fea402cde16";

async function doDelete() {
  console.log(`=== 撤去 (tag=${TAG} / ${MK}) ===`);
  await deleteByTag(TAG, {
    dryRun: !EXECUTE,
    extraTables: [
      { table: "kaigo_bath_visit_records", key: "client_id" },
      { table: "bath_monthly_plan_units", key: "client_id" },
    ],
  });
  // 事業所レベルの一時フラグ (client_id を持たないので個別に消す)
  if (!EXECUTE) {
    console.log(`  [DRY] kaigo_office_gensan_periods から notes LIKE '%${MK}%' を削除`);
    return;
  }
  const { data: periods, error: pe } = await sb.from("kaigo_office_gensan_periods").select("id,notes").eq("office_id", OFFICE_ID);
  if (pe) throw new Error(`kaigo_office_gensan_periods取得失敗: ${pe.message}`);
  const mine = (periods ?? []).filter((p) => String(p.notes ?? "").includes(MK));
  if (mine.length > 0) {
    const { error: de } = await sb.from("kaigo_office_gensan_periods").delete().in("id", mine.map((p) => p.id));
    if (de) throw new Error(`kaigo_office_gensan_periods削除失敗: ${de.message}`);
    console.log(`  kaigo_office_gensan_periods 削除完了 (${mine.length} 件)`);
  }
}

async function doSeed() {
  console.log(`=== サンプル投入 (tag=${TAG} / ${MK} / MONTH=${MONTH}・DRY=${!EXECUTE}) ===`);
  const off = await sb.from("offices").select("id,name").eq("id", OFFICE_ID).maybeSingle();
  if (!off.data) throw new Error(`事業所 ${OFFICE_ID} が実在しない`);
  console.log(`事業所: ${off.data.name}`);

  const clients = [
    sampleClient({ tag: TAG, seq: 1, careLevel: "要介護2", copayIdx: 0 }), // G1 中山間
    sampleClient({ tag: TAG, seq: 2, careLevel: "要介護2", copayIdx: 0 }), // G2 部分公費
    sampleClient({ tag: TAG, seq: 3, careLevel: "要介護2", copayIdx: 0 }), // G3 認知症Ⅰ
    sampleClient({ tag: TAG, seq: 4, careLevel: "要介護1", copayIdx: 0 }), // G4 月内変更(開始時点)
    sampleClient({ tag: TAG, seq: 5, careLevel: "要介護2", copayIdx: 0 }), // G5 限度額ちょうど
    sampleClient({ tag: TAG, seq: 6, careLevel: "要介護2", copayIdx: 0 }), // G6 虐防/業未
  ];
  const clientIds = await insertRows("clients", clients, { dryRun: !EXECUTE });
  const [g1, g2, g3, g4, g5, g6] = EXECUTE ? clientIds : clients.map((_, i) => `dry-g${i + 1}`);

  const insuranceRows = [
    sampleInsurance(g1, { careLevel: "要介護2", copayIdx: 0, tag: TAG, seq: 1 }),
    sampleInsurance(g2, { careLevel: "要介護2", copayIdx: 0, tag: TAG, seq: 2 }),
    sampleInsurance(g3, { careLevel: "要介護2", copayIdx: 0, tag: TAG, seq: 3 }),
    // G4: 月内変更 — 12/1-12/15 要介護1、12/16-12/31 要介護3 の2世代
    sampleInsurance(g4, { careLevel: "要介護1", copayIdx: 0, tag: TAG, seq: 4, extra: { effective_date: "2026-04-01", certification_start_date: "2026-04-01", certification_end_date: "2026-12-15" } }),
    sampleInsurance(g5, { careLevel: "要介護2", copayIdx: 0, tag: TAG, seq: 5 }),
    sampleInsurance(g6, { careLevel: "要介護2", copayIdx: 0, tag: TAG, seq: 6 }),
  ];
  await insertRows("client_insurance_records", insuranceRows, { dryRun: !EXECUTE });
  // G4の2世代目 (12/16〜要介護3)
  await insertRows("client_insurance_records", [
    sampleInsurance(g4, { careLevel: "要介護3", copayIdx: 0, tag: TAG, seq: 4, extra: { effective_date: "2026-12-16", certification_start_date: "2026-12-16", certification_end_date: "2027-03-31" } }),
  ], { dryRun: !EXECUTE });

  await insertRows("client_office_assignments", [g1, g2, g3, g4, g5, g6].map((id) => sampleAssignment(id, OFFICE_ID)), { dryRun: !EXECUTE });

  // G2: 部分公費 (法別21=障害(精神通院)。生保ではないので振替されない想定)
  await insertRows(KOHI_TABLE, [sampleKohi(g2, { hohei: "21", futansha: "21123456", jukyusha: "0000021" })], { dryRun: !EXECUTE });

  // ── kaigo_bath_visit_records ──
  const commonFields = { tenant_id: "kt-group", office_id: OFFICE_ID, status: "confirmed", planned: false, actual: true, scheme: "介護保険", staff_ids: [] };
  const visitRows = [
    // G1: 中山間加算あり (全身浴+看護あり ×2)
    { ...commonFields, client_id: g1, visit_date: "2026-12-05", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: null, addon_chuusankan: true },
    { ...commonFields, client_id: g1, visit_date: "2026-12-19", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: null, addon_chuusankan: true },
    // G2: 部分公費 (全身浴+看護あり ×2)
    { ...commonFields, client_id: g2, visit_date: "2026-12-05", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: null, addon_chuusankan: false },
    { ...commonFields, client_id: g2, visit_date: "2026-12-19", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: null, addon_chuusankan: false },
    // G3: 認知症専門ケアⅠ (全身浴+看護あり ×2)
    { ...commonFields, client_id: g3, visit_date: "2026-12-05", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: "I", addon_chuusankan: false },
    { ...commonFields, client_id: g3, visit_date: "2026-12-19", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: "I", addon_chuusankan: false },
    // G4: 月内変更。前半(要介護1期間)と後半(要介護3期間)にそれぞれ訪問
    { ...commonFields, client_id: g4, visit_date: "2026-12-03", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: null, addon_chuusankan: false },
    { ...commonFields, client_id: g4, visit_date: "2026-12-20", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: null, addon_chuusankan: false },
    // G5: 限度額ちょうど用 (全身浴+看護あり ×4 = 5,064単位。bath_monthly_plan_unitsで計画単位数=5,064に設定)
    { ...commonFields, client_id: g5, visit_date: "2026-12-03", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: null, addon_chuusankan: false },
    { ...commonFields, client_id: g5, visit_date: "2026-12-10", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: null, addon_chuusankan: false },
    { ...commonFields, client_id: g5, visit_date: "2026-12-17", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: null, addon_chuusankan: false },
    { ...commonFields, client_id: g5, visit_date: "2026-12-24", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: null, addon_chuusankan: false },
    // G6: 虐防/業未検証用の通常訪問 (全身浴+看護あり ×2)
    { ...commonFields, client_id: g6, visit_date: "2026-12-05", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: null, addon_chuusankan: false },
    { ...commonFields, client_id: g6, visit_date: "2026-12-19", bath_type: "全身浴", staff_only: false, service_code: "121111", addon_shokai: false, addon_ninchi: null, addon_chuusankan: false },
  ];
  await insertRows("kaigo_bath_visit_records", visitRows, { dryRun: !EXECUTE });

  // G5: 計画単位数 = 実際の合計 (4回×1266=5,064) にして「限度額ちょうど」を作る
  await insertRows("bath_monthly_plan_units", [
    { tenant_id: "kt-group", client_id: g5, office_id: OFFICE_ID, target_month: "2026-12-01", planned_units: 5064 },
  ], { dryRun: !EXECUTE });

  // G6: 虐防(高齢者虐待防止措置未実施)減算を事業所単位で一時適用
  await insertRows("kaigo_office_gensan_periods", [
    { tenant_id: "kt-group", office_id: OFFICE_ID, gensan_type: "gyakutai", start_month: "2026-12", end_month: "2026-12", notes: `${MK} 虐防減算 検証用一時フラグ` },
  ], { dryRun: !EXECUTE });

  console.log(EXECUTE ? "✅ 投入完了" : "【DRY RUN】--execute で実際に投入します");
  if (EXECUTE) {
    console.log(`G1(中山間)=${g1} G2(部分公費)=${g2} G3(認知症Ⅰ)=${g3}`);
    console.log(`G4(月内変更)=${g4} G5(限度額ちょうど)=${g5} G6(虐防業未)=${g6}`);
  }
}

(DELETE ? doDelete() : doSeed()).catch((e) => { console.error("✗ " + e.message); process.exit(1); });
