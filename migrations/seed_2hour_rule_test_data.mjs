// ============================================================================
// 「2時間ルール」合算ロジック検証用のテストデータを一式 seed する。
//
//   ⚠ 本番データには一切触れない設計:
//     - 専用の fake office (id 固定 OFFICE_ID 参照) を新規作成し、以後の
//       import_meisai_shougai_records.mjs 実行はこの office_id にのみ書き込む
//       (削除も office_id スコープなので、本番 office の実データには触れない)。
//     - client / staff もこの検証専用の新規行のみ (既存 client/member とは無関係)。
//
//   生成するもの:
//     ① offices                 1行 (fake office)
//     ② clients                 1行 (検証花子。利用者マスタ基本情報)
//     ③ client_office_assignments 1行
//     ④ shougai_certifications  1行 (受給者証情報)
//     ⑤ shogai_contracts        2行 (支給決定: 身体111000 / 家事112000)
//     ⑥ client_kohi_records     1行 (公費情報)
//     ⑦ members                 2行 (検証職員A/B)
//     ⑧ member_offices          2行
//     ⑨ MEISAI CSV (サービス実績データ/_2時間ルール検証テスト/202606/MEISAI_2h検証.csv)
//
//   マーカー:
//     - notes 系: 末尾/先頭に "[fake テスト用-2hour-20260903]"
//     - clients.name / members.name 自体が "検証花子" 等の識別しやすい名前
//
//   使い方:
//     node migrations/seed_2hour_rule_test_data.mjs              # DRY RUN
//     node migrations/seed_2hour_rule_test_data.mjs --execute    # 本番実行
//
//   削除は migrations/delete_2hour_rule_test_data.mjs
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import { SCENARIOS, CLIENT_NAME, CLIENT_NUM, STAFF_A, STAFF_B } from "./_2hour_rule_test_scenarios.mjs";

const EXECUTE = process.argv.includes("--execute");
const MARKER = "[fake テスト用-2hour-20260903]";
const TENANT_ID = "kt-group";

export const OFFICE_ID = "383a296f-f6b3-4088-bf67-c5d274d78a62";
export const CLIENT_ID = "a6495a94-9442-4128-b55c-8fcf17eefa79";
export const OFFICE_BN = "9999999901"; // 事業所番号(障害) fake
export const OFFICE_NAME = "【テスト用】2時間ルール検証事業所";
export const MAP_TAG = "2h検証";
export const AREA_DIR = "_2時間ルール検証テスト";
export const TARGET_MONTH = "2026-06";

function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function main() {
  console.log(`=== 2時間ルール検証データ seed ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 既存チェック (二重 seed 防止)
  const { data: existingOffice } = await sb.from("offices").select("id").eq("id", OFFICE_ID);
  const { data: existingClient } = await sb.from("clients").select("id").eq("id", CLIENT_ID);
  console.log(`既存確認: office=${existingOffice?.length ?? 0}件 / client=${existingClient?.length ?? 0}件`);

  // ── CSV 生成 (常に作る。DRY RUN でも内容確認用に書き出す) ──
  const rows = [];
  for (const sc of SCENARIOS) {
    for (const v of sc.visits) {
      rows.push({
        jigyoNum: OFFICE_BN,
        staffName: v.staff,
        clientName: CLIENT_NAME,
        date: sc.date.replace(/-/g, "/"),
        start: v.start, end: v.end,
        svc: "身体介護(自立)",
        santei: "0:30",
        santeiStart: v.start, santeiEnd: v.end,
        jikantai: "", holiday: "", code: "021001", clientNum: CLIENT_NUM,
      });
    }
  }
  const header = ["事業所番号", "職員名", "利用者名", "日付", "派遣開始時間", "派遣終了時間",
    "サービス", "算定時間", "算定開始時刻", "算定終了時刻", "時間帯", "休日区分", "サービスコード", "利用者番号"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([r.jigyoNum, r.staffName, r.clientName, r.date, r.start, r.end, r.svc, r.santei,
      r.santeiStart, r.santeiEnd, r.jikantai, r.holiday, r.code, r.clientNum].join(","));
  }
  const csvText = lines.join("\r\n") + "\r\n";
  const csvDir = fileURLToPath(new URL(`../サービス実績データ/${AREA_DIR}/${TARGET_MONTH.replace("-", "")}/`, import.meta.url));
  const csvPath = csvDir + "MEISAI_2h検証.csv";
  console.log(`CSV 出力先: ${csvPath}`);
  console.log(`CSV 行数: ${rows.length} (${SCENARIOS.length} シナリオ)`);

  if (EXECUTE) {
    mkdirSync(csvDir, { recursive: true });
    writeFileSync(csvPath, iconv.encode(csvText, "Shift_JIS"));
    console.log("✓ CSV 書込完了 (Shift_JIS)");
  } else {
    console.log("(DRY RUN のため CSV は書き込んでいません)");
    console.log("--- CSV プレビュー (先頭5行) ---");
    console.log(lines.slice(0, 6).join("\n"));
  }

  if (!EXECUTE) {
    console.log("\n※ DRY RUN のため DB には書き込んでいません。--execute で本番実行。");
    return;
  }

  if (existingOffice?.length) {
    console.log("⚠ office は既に存在します。DB 系 INSERT はスキップ (CSV のみ再生成)。");
    return;
  }

  // ① offices
  {
    const { error } = await sb.from("offices").insert({
      id: OFFICE_ID, tenant_id: TENANT_ID, name: OFFICE_NAME,
      service_type: "訪問介護", designation_type: "介護保険",
      shogai_business_number: OFFICE_BN,
      is_active: true,
      notes: `${MARKER} 障害2時間ルール合算ロジック検証専用の一時テスト事業所。検証終了後は delete_2hour_rule_test_data.mjs で削除すること。`,
    });
    if (error) { console.error(`✗ offices: ${error.message}`); process.exit(1); }
    console.log("✓ offices INSERT");
  }

  // ② clients (利用者マスタ基本情報)
  {
    const { error } = await sb.from("clients").insert({
      id: CLIENT_ID, tenant_id: TENANT_ID,
      user_number: "TEST2H001", name: CLIENT_NAME, furigana: "ケンショウ ハナコ",
      gender: "女", birth_date: "1965-04-10",
      postal_code: "266-0006", address: "千葉県千葉市緑区おゆみ野中央9-9-9(テスト住所)",
      phone: "043-000-0000",
      office_id: OFFICE_ID,
      status: "active", is_facility: false, is_provisional: false,
    });
    if (error) { console.error(`✗ clients: ${error.message}`); process.exit(1); }
    console.log("✓ clients INSERT");
  }

  // ③ client_office_assignments
  {
    const { error } = await sb.from("client_office_assignments").insert({
      tenant_id: TENANT_ID, client_id: CLIENT_ID, office_id: OFFICE_ID,
      start_date: "2026-04-01",
      service_notes: MARKER,
    });
    if (error) { console.error(`✗ client_office_assignments: ${error.message}`); process.exit(1); }
    console.log("✓ client_office_assignments INSERT");
  }

  // ④ shougai_certifications (受給者証情報。実運用に近い厚みで)
  {
    const { error } = await sb.from("shougai_certifications").insert({
      tenant_id: TENANT_ID, client_id: CLIENT_ID,
      support_level: "区分3", primary_disability: "身体障害",
      certification_start_date: "2026-04-01", certification_end_date: "2027-03-31",
      beneficiary_number: "9999900001",
      insurer_municipality: "121004", // 千葉市 (実在パターンに合わせたテスト値)
      service_types: ["居宅介護"],
      copay_rate: 0.1,
      self_payment_limit: 37200,
      income_category: "一般２",
      jogen_kanri_kubun: "自事業所",
      issue_date: "2026-04-01",
      is_applying: false,
      contract_entry_number: "1",
      shikyuryo_details: { shintai: { hours: 50, minutes: 0 }, kaji: { hours: 20, minutes: 0 } },
      notes: `${MARKER} 2時間ルール検証用の受給者証(架空)。実データではない。`,
    });
    if (error) { console.error(`✗ shougai_certifications: ${error.message}`); process.exit(1); }
    console.log("✓ shougai_certifications INSERT");
  }

  // ⑤ shogai_contracts (支給決定: 身体・家事 両方を持たせて 4b-0b の
  //    「契約に無い種別を寄せる」ロジックが誤発火しないようにする)
  {
    const contracts = [
      { decision_code: "111000", amount_x100: 5000 },
      { decision_code: "112000", amount_x100: 2000 },
    ];
    for (const c of contracts) {
      const { error } = await sb.from("shogai_contracts").insert({
        tenant_id: TENANT_ID, client_id: CLIENT_ID, office_id: OFFICE_ID,
        decision_code: c.decision_code, amount_x100: c.amount_x100, amount_unit: "時間",
        entry_number: 1, start_date: "2026-04-01", end_date: "2027-03-31",
        reason: "新規契約", notes: `${MARKER} decision=${c.decision_code}`,
      });
      if (error) { console.error(`✗ shogai_contracts(${c.decision_code}): ${error.message}`); process.exit(1); }
    }
    console.log("✓ shogai_contracts INSERT ×2");
  }

  // ⑥ client_kohi_records (公費情報。実運用に近い厚みで)
  {
    const { error } = await sb.from("client_kohi_records").insert({
      tenant_id: TENANT_ID, client_id: CLIENT_ID,
      kohi_hobetsu: "12", // 生活保護法 等でよく使われる法別番号のテスト値
      futansha_number: "99999999",
      jukyusha_number: "9999999",
      start_date: "2026-04-01", end_date: "2027-03-31",
      priority: 1, honnin_futan: 0,
      notes: `${MARKER} 検証用の公費情報(架空)`,
    });
    if (error) { console.error(`✗ client_kohi_records: ${error.message}`); process.exit(1); }
    console.log("✓ client_kohi_records INSERT");
  }

  // ⑦ members (検証職員A/B)
  const staffIds = {};
  for (const nm of [STAFF_A, STAFF_B]) {
    const { data, error } = await sb.from("members").insert({
      tenant_id: TENANT_ID, name: nm, furigana: nm,
      role: "ヘルパー", status: "active", gender: "女性",
    }).select("id").single();
    if (error) { console.error(`✗ members(${nm}): ${error.message}`); process.exit(1); }
    staffIds[nm] = data.id;
  }
  console.log(`✓ members INSERT ×2 (${STAFF_A}=${staffIds[STAFF_A]} / ${STAFF_B}=${staffIds[STAFF_B]})`);

  // ⑧ member_offices
  for (const nm of [STAFF_A, STAFF_B]) {
    const { error } = await sb.from("member_offices").insert({
      member_id: staffIds[nm], office_id: OFFICE_ID, is_primary: true,
    });
    if (error) { console.error(`✗ member_offices(${nm}): ${error.message}`); process.exit(1); }
  }
  console.log("✓ member_offices INSERT ×2");

  console.log("\n✅ seed 完了。次は import_meisai_shougai_records.mjs を下記 env で実行:");
  console.log(`   TARGET_MONTH=${TARGET_MONTH} AREA_DIR=${AREA_DIR} OFFICE_ID=${OFFICE_ID} OFFICE_BN=${OFFICE_BN} MAP_TAG=${MAP_TAG} node migrations/import_meisai_shougai_records.mjs            # DRY RUN`);
  console.log(`   TARGET_MONTH=${TARGET_MONTH} AREA_DIR=${AREA_DIR} OFFICE_ID=${OFFICE_ID} OFFICE_BN=${OFFICE_BN} MAP_TAG=${MAP_TAG} node migrations/import_meisai_shougai_records.mjs --execute`);
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
