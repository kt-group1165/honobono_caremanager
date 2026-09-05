// ケアプラン→モニタリング→支援経過 連鎖のサンプル投入 (H割当・user承認済み・2026-09-05)
//
//   node migrations/seed_sample_careplan_chain_g.mjs              # DRY RUN
//   node migrations/seed_sample_careplan_chain_g.mjs --execute    # 投入
//   node migrations/seed_sample_careplan_chain_g.mjs --delete             # 撤去 DRY RUN
//   node migrations/seed_sample_careplan_chain_g.mjs --delete --execute   # 撤去
//
// ── 経緯 (2026-09-05) ──────────────────────────────────────────────────
//   当初「高品267名中1名しかkaigo_care_plansに紐付いていない、その3件も
//   status全部null」という前提で調査を始めたが、実データを直接確認したところ
//   ★ 誤りだった (旗振り役のselectに存在しない列があり、エラーJSONを結果配列と
//   誤集計していた)。実際は高品269名中138名がケアプランを保有し、status は
//   全件 "active" (kaigo_care_plans.status は NOT NULL 制約があり null 自体が
//   物理的に入らないことを実機で確認済み)。
//
//   訂正の過程で見つかった **実在するロジックの穴** (③) を主役にする:
//     どの画面 (reports/monitoring/support-records/meeting-minutes) も
//     end_date (計画の有効期間終了日) を一切チェックせず、
//     status='active' の中で start_date が最新の行を無条件に選ぶ。
//     → 期限切れの計画が「現在有効」として選ばれることがある。
//   選択ロジックは src/lib/careplan-selection.ts に統合済み
//   (旧: 5箇所に別々のインラインコピーがあった)。
//   純関数としての境界値検証は scripts/careplan-selection-verify.mts。
//   このscriptは「実データの形」で同じ状況を作り、実際の画面が読むクエリの
//   往復 (scripts/careplan-chain-sample-verify.mts) を検証するためのもの。
//
// ── 投入するシナリオ (すべて実在しうる状態。null状態は使わない) ──────────
//   クライアントA: status='active' の計画が1件だけ、かつ既に期限切れ (シナリオA)
//   クライアントB: 期限切れ(active・start_date新しい) + 現在有効(active・start_date古い) (シナリオB)
//   クライアントC: status='completed' の計画のみ (シナリオC)
//   クライアントD: 計画0件 (シナリオD。「有効なケアプランがありません」の正常系確認用)
//   モニタリングシート・支援経過・第2表は「現在有効であるべき計画」にのみ紐付ける。
//   選択ロジックが正しければ見える。バグがあれば (B) の場合に見えない。
//
// ⚠ サンプルは 2026-12 のみ (MONTH)。2026-06/07 には触れない。
// ⚠ office は触らない。既存の「Ｈａｎａ居宅支援センター高品」を使う。
// ⚠ 撤去は接頭辞+氏名マーカーの両方一致 (deleteByTag)。
import {
  sb, TAGS, MONTH, marker,
  sampleClient, sampleInsurance, sampleAssignment,
  insertRows, deleteByTag, assertSafeMonth,
} from "./_sample_data.mjs";

assertSafeMonth(MONTH);
const TAG = TAGS.g; // "g"
const MK = marker(TAG); // "[sample-g]"
const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");

// 高品居宅支援センター (実在。offices は変更しない)
const OFFICE_ID = "18dab72e-0445-49f1-a8fc-44637f9fd676";

async function doDelete() {
  console.log(`=== 撤去 (tag=${TAG} / ${MK}) ===`);
  await deleteByTag(TAG, {
    dryRun: !EXECUTE,
    extraTables: [
      { table: "kaigo_support_records", key: "user_id" },
      { table: "kaigo_monitoring_sheets", key: "user_id" },
      ...(await (async () => {
        const { data: cs } = await sb.from("clients").select("id,name").like("user_number", `Z${TAG.toUpperCase()}%`);
        const mine = (cs ?? []).filter((c) => String(c.name ?? "").includes(MK));
        if (mine.length === 0) return [];
        const { data: plans } = await sb.from("kaigo_care_plans").select("id").in("user_id", mine.map((c) => c.id));
        const planIds = (plans ?? []).map((p) => p.id);
        if (planIds.length === 0) return [];
        if (!EXECUTE) {
          console.log(`  [DRY] kaigo_care_plan_services から care_plan_id in (${planIds.length}件) を削除`);
          console.log(`  [DRY] kaigo_care_plans から id in (${planIds.length}件) を削除`);
          return [];
        }
        const { error: e1 } = await sb.from("kaigo_care_plan_services").delete().in("care_plan_id", planIds);
        if (e1) throw new Error(`kaigo_care_plan_services DELETE 失敗: ${e1.message}`);
        const { error: e2 } = await sb.from("kaigo_care_plans").delete().in("id", planIds);
        if (e2) throw new Error(`kaigo_care_plans DELETE 失敗: ${e2.message}`);
        console.log(`  kaigo_care_plan_services / kaigo_care_plans 削除完了 (${planIds.length} 件のプラン)`);
        return [];
      })()),
    ],
  });
}

async function doSeed() {
  console.log(`=== サンプル投入 (tag=${TAG} / ${MK} / MONTH=${MONTH}・DRY=${!EXECUTE}) ===`);

  const off = await sb.from("offices").select("id,name").eq("id", OFFICE_ID).maybeSingle();
  if (!off.data) throw new Error(`事業所 ${OFFICE_ID} が実在しない。offices は触らない前提が崩れています`);
  console.log(`事業所: ${off.data.name} (${OFFICE_ID})`);

  const clientA = sampleClient({ tag: TAG, seq: 1, careLevel: "要介護2", copayIdx: 0 }); // シナリオA: 期限切れのみ
  const clientB = sampleClient({ tag: TAG, seq: 2, careLevel: "要介護3", copayIdx: 0 }); // シナリオB: 期限切れ+現在有効
  const clientC = sampleClient({ tag: TAG, seq: 3, careLevel: "要介護1", copayIdx: 0 }); // シナリオC: completedのみ
  const clientD = sampleClient({ tag: TAG, seq: 4, careLevel: "要支援2", copayIdx: 0 }); // シナリオD: 計画0件

  const clientIds = await insertRows("clients", [clientA, clientB, clientC, clientD], { dryRun: !EXECUTE });
  const [idA, idB, idC, idD] = EXECUTE ? clientIds : ["dry-A", "dry-B", "dry-C", "dry-D"];

  const insurance = [
    sampleInsurance(idA, { careLevel: "要介護2", copayIdx: 0, tag: TAG, seq: 1 }),
    sampleInsurance(idB, { careLevel: "要介護3", copayIdx: 0, tag: TAG, seq: 2 }),
    sampleInsurance(idC, { careLevel: "要介護1", copayIdx: 0, tag: TAG, seq: 3 }),
    sampleInsurance(idD, { careLevel: "要支援2", copayIdx: 0, tag: TAG, seq: 4 }),
  ];
  await insertRows("client_insurance_records", insurance, { dryRun: !EXECUTE });

  const assignments = [idA, idB, idC, idD].map((id) => sampleAssignment(id, OFFICE_ID));
  await insertRows("client_office_assignments", assignments, { dryRun: !EXECUTE });

  // ── kaigo_care_plans (status は 'active' / 'completed' のみ。null は使わない = NOT NULL制約) ──
  const planRows = [
    // A: active・期限切れ (2026-12 の「今」から見て過去に終わっている)
    {
      user_id: idA, plan_number: 9001, plan_type: "居宅サービス計画",
      start_date: "2026-01-01", end_date: "2026-06-30", status: "active",
      long_term_goals: `サンプル長期目標(A-期限切れ) ${MK}`, short_term_goals: `サンプル短期目標(A) ${MK}`,
      tenant_id: "kt-group",
    },
    // B: plan1 = active・期限切れだが start_date が新しい (誤って選ばれる想定)
    {
      user_id: idB, plan_number: 9002, plan_type: "居宅サービス計画",
      start_date: "2026-08-01", end_date: "2026-08-31", status: "active",
      long_term_goals: `サンプル長期目標(B-期限切れ・新しいstart_date) ${MK}`, short_term_goals: `サンプル短期目標(B-期限切れ) ${MK}`,
      tenant_id: "kt-group",
    },
    // B: plan2 = active・現在有効だが start_date が古い (正しくはこちらが選ばれるべき)
    {
      user_id: idB, plan_number: 9003, plan_type: "居宅サービス計画",
      start_date: "2026-06-01", end_date: "2027-05-31", status: "active",
      long_term_goals: `サンプル長期目標(B-現在有効・古いstart_date) ${MK}`, short_term_goals: `サンプル短期目標(B-現在有効) ${MK}`,
      tenant_id: "kt-group",
    },
    // C: completed のみ
    {
      user_id: idC, plan_number: 9004, plan_type: "居宅サービス計画",
      start_date: "2026-04-01", end_date: "2027-03-31", status: "completed",
      long_term_goals: `サンプル長期目標(C-completed) ${MK}`, short_term_goals: `サンプル短期目標(C) ${MK}`,
      tenant_id: "kt-group",
    },
    // D: 計画なし (行を作らない)
  ];
  const planIds = await insertRows("kaigo_care_plans", planRows, { dryRun: !EXECUTE });
  const [planA, planB1, planB2, planC] = EXECUTE ? planIds : ["dry-A", "dry-B1", "dry-B2", "dry-C"];

  // ── kaigo_care_plan_services (第2表) ──
  // Bは「現在有効であるべき」planB2にのみ紐付ける (期限切れのplanB1には紐付けない)
  const serviceRows = [
    { care_plan_id: planA, service_type: "訪問介護", service_content: `サンプル サービス内容(A) ${MK}`, frequency: "週3回", provider: "サンプル事業所", display_order: 1, tenant_id: "kt-group" },
    { care_plan_id: planB2, service_type: "訪問介護", service_content: `サンプル サービス内容(B-現在有効) ${MK}`, frequency: "週2回", provider: "サンプル事業所", display_order: 1, tenant_id: "kt-group" },
    { care_plan_id: planC, service_type: "福祉用具貸与", service_content: `サンプル サービス内容(C) ${MK}`, frequency: "継続", provider: "サンプル事業所", display_order: 1, tenant_id: "kt-group" },
  ];
  await insertRows("kaigo_care_plan_services", serviceRows, { dryRun: !EXECUTE });

  // ── kaigo_monitoring_sheets ── (実データ0行のテーブル。MONTH内の日付で登録)
  const monitoringRows = [
    { user_id: idA, care_plan_id: planA, monitoring_date: "2026-12-08", status: "draft", form_type: "要介護", assessor_name: `サンプル担当 ${MK}`, tenant_id: "kt-group" },
    { user_id: idB, care_plan_id: planB2, monitoring_date: "2026-12-12", status: "draft", form_type: "要介護", assessor_name: `サンプル担当 ${MK}`, tenant_id: "kt-group" },
    { user_id: idC, care_plan_id: planC, monitoring_date: "2026-12-15", status: "draft", form_type: "要介護", assessor_name: `サンプル担当 ${MK}`, tenant_id: "kt-group" },
  ];
  await insertRows("kaigo_monitoring_sheets", monitoringRows, { dryRun: !EXECUTE });

  // ── kaigo_support_records (支援経過) ──
  const supportRows = [
    { user_id: idA, care_plan_id: planA, record_date: "2026-12-05", record_time: "10:00", category: "訪問", content: `サンプル支援経過(A) ${MK}`, staff_name: `サンプル担当 ${MK}`, tenant_id: "kt-group" },
    { user_id: idB, care_plan_id: planB2, record_date: "2026-12-06", record_time: "11:00", category: "電話", content: `サンプル支援経過(B-現在有効) ${MK}`, staff_name: `サンプル担当 ${MK}`, tenant_id: "kt-group" },
    { user_id: idC, care_plan_id: planC, record_date: "2026-12-07", record_time: "12:00", category: "来所", content: `サンプル支援経過(C) ${MK}`, staff_name: `サンプル担当 ${MK}`, tenant_id: "kt-group" },
  ];
  await insertRows("kaigo_support_records", supportRows, { dryRun: !EXECUTE });

  console.log(EXECUTE ? "✅ 投入完了" : "【DRY RUN】--execute で実際に投入します");
  if (EXECUTE) {
    console.log(`A(期限切れのみ)=${idA} plan=${planA}`);
    console.log(`B(期限切れ+現在有効)=${idB} plan1(期限切れ・新しいstart)=${planB1} plan2(現在有効・古いstart)=${planB2}`);
    console.log(`C(completedのみ)=${idC} plan=${planC}`);
    console.log(`D(計画0件)=${idD}`);
    console.log(`次: npx tsx scripts/careplan-chain-sample-verify.mts`);
  }
}

(DELETE ? doDelete() : doSeed()).catch((e) => { console.error("✗ " + e.message); process.exit(1); });
