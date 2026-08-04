// ============================================================================
// Ｈａｎａヘルパーステーションおゆみ野 の**動作確認用テストデータを削除**する。
//
//   背景: 売上ダッシュボードに 185,013 円が立っていたが、中身は
//     ① seed_fake_houmonkaigo_clients.mjs が作った fake 利用者 10 名 (OY001-OY010)
//     ② 障害請求の動作確認用に足した 3 名 (990000-990002)
//   だけで、ほのぼのからの実データは 1 件も入っていない。
//   実態は「未取込」なので 0 円が正しい。
//
//   ⚠ **OY001-OY010 は 5 つの訪問入浴事業所のテスト利用者を兼ねている**。
//     利用者ごと消すと訪問入浴の動作確認データ (bath_schedule/visit_records/patterns
//     238 行) まで道連れになるので、既定では**訪問介護 (おゆみ野) の足跡だけ**を消す。
//
//   削除の内訳:
//     A) おゆみ野専用の 3 名 (990000-990002) … 利用者ごと全削除
//     B) 訪問入浴と兼用の 10 名 (OY001-OY010) … おゆみ野の訪問介護データのみ削除
//        (利用者・認定・訪問入浴データは残す)
//
//   FULL=1 を付けると B も利用者ごと消す (= 訪問入浴のテストデータも消える)。
//
//   使い方:
//     node migrations/delete_fake_oyumino_test_data.mjs              # DRY RUN
//     node migrations/delete_fake_oyumino_test_data.mjs --execute    # 実削除
//     FULL=1 node migrations/delete_fake_oyumino_test_data.mjs       # 13名まるごと (DRY)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const FULL = process.env.FULL === "1";
const OFFICE_ID = "4f14d50c-76b5-4f44-ac41-ed6d01f53a30"; // Ｈａｎａヘルパーステーションおゆみ野 (訪問介護)

/** これに一致する利用者番号だけ削除してよい (実データの巻き込み防止) */
const TEST_USER_NUMBER = /^(OY0\d{2}|99000\d)$/;

/** office_id を持つ table = おゆみ野の行だけ狙い撃ちできる */
const BY_OFFICE = [
  "kaigo_visit_schedule",
  "kaigo_visit_addon_lines",
  "kaigo_visit_month_addons",
  "kaigo_billing_status",
  "kaigo_user_contracts",
  "kaigo_houmon_care_plans",
  "shogai_service_records",
  "kaigo_idou_shien_records",
];

/**
 * office_id を持たないが**訪問介護の実績系**なので、対象利用者の分は消してよい table。
 * (訪問入浴は kaigo_bath_* に分かれているので巻き込まない)
 */
const VISIT_SCOPED = ["kaigo_visit_patterns", "kaigo_service_records"];

/** FULL=1 のときだけ消す、利用者そのものにぶら下がる table */
const CLIENT_SCOPED = [
  "kaigo_bath_schedule",
  "kaigo_bath_patterns",
  "kaigo_bath_visit_records",
  "kaigo_health_records",
  "kaigo_adl_records",
  "kaigo_assessments",
  "kaigo_care_plan_services",
  "kaigo_care_plans",
  "kaigo_monitoring_items",
  "kaigo_monitoring_sheets",
  "kaigo_care_conferences",
  "kaigo_support_records",
  "kaigo_emergency_sheets",
  "kaigo_emergency_status",
  "kaigo_emergency_tokens",
  "kaigo_family_contacts",
  "kaigo_medical_history",
  "kaigo_medical_insurance",
  "kaigo_report_documents",
  "kaigo_billing_addons",
  "kaigo_billing_details",
  "kaigo_billing_records",
  "kaigo_benefit_management",
  "kaigo_gendo_allocation",
  "kaigo_monthly_plan_units",
  "bath_monthly_plan_units",
  "kaigo_riyou_settings",
  "client_insurance_records",
  "client_kohi_records",
  "client_disability_certifications",
  "client_hospitalizations",
  "client_memos",
  "chiiki_recipient_certs",
  "shougai_certifications",
  "shogai_billing_status",
  "shogai_jogen_kanri_results",
  "shogai_seikyu_payments",
  "riyou_jippi_entries",
  "riyou_seikyu_payments",
  "signatures",
];

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
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** table に存在する利用者キー列 (無ければ null)。table 自体が無いときも null */
async function keyColumnOf(table) {
  for (const col of ["client_id", "user_id"]) {
    const { error } = await sb.from(table).select(col).limit(1);
    if (!error) return col;
    if (error.code === "42P01" || error.code === "PGRST205") return null;
  }
  return null;
}

/** 削除計画の 1 手順 */
const steps = [];
const addStep = (table, apply, label, count) => steps.push({ table, apply, label, count });

async function countBy(table, build) {
  const { count, error } = await build(sb.from(table).select("*", { count: "exact", head: true }));
  if (error) return { count: 0, error };
  return { count: count ?? 0 };
}

async function main() {
  console.log(
    `=== おゆみ野 テストデータ削除 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"}${FULL ? " [FULL=1 利用者ごと]" : " [訪問介護のみ]"} ===\n`,
  );

  // 1) 対象利用者を確定し、テスト番号以外が混ざっていたら中断
  const { data: asg, error: asgErr } = await sb
    .from("client_office_assignments")
    .select("client_id")
    .eq("office_id", OFFICE_ID);
  if (asgErr) throw new Error(`assignment 取得失敗: ${asgErr.message}`);
  const ids = [...new Set(asg.map((a) => a.client_id))];
  if (ids.length === 0) {
    console.log("おゆみ野に紐付く利用者がいません。削除対象なし。");
    return;
  }
  const { data: clients, error: clErr } = await sb
    .from("clients")
    .select("id, name, user_number")
    .in("id", ids);
  if (clErr) throw new Error(`clients 取得失敗: ${clErr.message}`);

  const bad = clients.filter((c) => !TEST_USER_NUMBER.test(String(c.user_number ?? "")));
  if (bad.length) {
    console.error(`✗ 中断: テスト用の利用者番号 (OY0nn / 99000n) 以外が ${bad.length} 名います。`);
    console.error(`  → ${bad.map((c) => `${c.user_number} ${c.name}`).join(" / ")}`);
    console.error(`  実データを巻き込む恐れがあるため何も削除しません。`);
    process.exit(2);
  }

  // 他事業所 (訪問入浴) にも紐付いている利用者は「利用者ごと削除」しない
  const { data: allAsg } = await sb
    .from("client_office_assignments")
    .select("client_id, office_id")
    .in("client_id", ids);
  const otherOffices = new Map(); // client_id -> [office_id]
  for (const a of allAsg ?? []) {
    if (a.office_id === OFFICE_ID) continue;
    if (!otherOffices.has(a.client_id)) otherOffices.set(a.client_id, []);
    otherOffices.get(a.client_id).push(a.office_id);
  }
  const dropWhole = FULL ? ids : ids.filter((id) => !otherOffices.has(id));
  const keepClient = ids.filter((id) => !dropWhole.includes(id));

  const nameOf = Object.fromEntries(clients.map((c) => [c.id, `${c.user_number} ${c.name}`]));
  console.log(`対象 ${ids.length} 名 (全員テスト番号):`);
  console.log(`  利用者ごと削除 ${dropWhole.length} 名: ${dropWhole.map((i) => nameOf[i]).join(" / ") || "なし"}`);
  console.log(
    `  訪問介護分のみ ${keepClient.length} 名: ${keepClient.map((i) => nameOf[i]).join(" / ") || "なし"}`,
  );
  if (keepClient.length) {
    console.log(`    ↑ 訪問入浴のテスト利用者を兼ねているので利用者レコードは残す`);
  }

  // 2) 計画を組む
  //   (a) おゆみ野 office の行 (全利用者)
  for (const table of BY_OFFICE) {
    const { count, error } = await countBy(table, (q) => q.eq("office_id", OFFICE_ID));
    if (error) continue;
    if (count) addStep(table, (q) => q.eq("office_id", OFFICE_ID), "office=おゆみ野", count);
  }
  //   (b) 訪問介護の実績系 (対象利用者ぶん)
  for (const table of VISIT_SCOPED) {
    const col = await keyColumnOf(table);
    if (!col) continue;
    const { count, error } = await countBy(table, (q) => q.in(col, ids));
    if (error) continue;
    if (count) addStep(table, (q) => q.in(col, ids), `${col}=対象13名`, count);
  }
  //   (c) 訪問記録は office_id を持たないので、おゆみ野の予定に紐づく分を先に拾う
  const { data: schedRows } = await sb
    .from("kaigo_visit_schedule")
    .select("id")
    .eq("office_id", OFFICE_ID);
  const schedIds = (schedRows ?? []).map((r) => r.id);
  if (schedIds.length) {
    const { count } = await countBy("kaigo_visit_records", (q) => q.in("schedule_id", schedIds));
    if (count) {
      addStep("kaigo_visit_records", (q) => q.in("schedule_id", schedIds), "予定に紐づく実績", count);
    }
  }
  {
    // seed script ごとにマーカーの接尾辞が違う (-houmon / -visit) ので前方一致で拾う
    const MARK = "%fake テスト用%";
    const { count } = await countBy("kaigo_visit_records", (q) =>
      q.in("user_id", ids).like("notes", MARK),
    );
    if (count) {
      addStep("kaigo_visit_records", (q) => q.in("user_id", ids).like("notes", MARK), "fake マーカー", count);
    }
  }
  //   (d) 利用者ごと消す分の子テーブル
  if (dropWhole.length) {
    for (const table of CLIENT_SCOPED) {
      const col = await keyColumnOf(table);
      if (!col) continue;
      const { count, error } = await countBy(table, (q) => q.in(col, dropWhole));
      if (error) continue;
      if (count) addStep(table, (q) => q.in(col, dropWhole), `${col}=全削除対象`, count);
    }
  }
  //   (e) 紐付けを外す
  addStep(
    "client_office_assignments",
    (q) => q.eq("office_id", OFFICE_ID),
    "office=おゆみ野",
    (await countBy("client_office_assignments", (q) => q.eq("office_id", OFFICE_ID))).count,
  );
  if (dropWhole.length) {
    const { count } = await countBy("client_office_assignments", (q) => q.in("client_id", dropWhole));
    if (count) {
      addStep("client_office_assignments", (q) => q.in("client_id", dropWhole), "全削除対象の残り", count);
    }
  }

  console.log(`\n=== 削除対象 ===`);
  for (const s of steps) {
    console.log(`  ${s.table.padEnd(30)} ${s.label.padEnd(18)} ${String(s.count).padStart(5)} 行`);
  }
  if (dropWhole.length) {
    console.log(`  ${"clients".padEnd(30)} ${"全削除対象".padEnd(18)} ${String(dropWhole.length).padStart(5)} 行`);
  }
  console.log(`\n合計 ${steps.reduce((s, x) => s + x.count, 0) + dropWhole.length} 行`);
  if (keepClient.length) {
    console.log(
      `\n残すもの: 利用者 ${keepClient.length} 名と その訪問入浴データ (kaigo_bath_*)・認定・家族連絡先 等`,
    );
  }

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で削除します。");
    return;
  }

  // 3) バックアップ (削除前の中身を JSON で残す)
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const backup = { office_id: OFFICE_ID, full: FULL, at: new Date().toISOString(), clients, rows: [] };
  for (const s of steps) {
    const { data } = await s.apply(sb.from(s.table).select("*"));
    backup.rows.push({ table: s.table, label: s.label, data: data ?? [] });
  }
  const backupPath = fileURLToPathSafe(new URL(`./_backup_oyumino_testdata_${stamp}.json`, import.meta.url));
  writeFileSync(backupPath, JSON.stringify(backup, null, 1), "utf8");
  console.log(`\nバックアップ: ${backupPath}`);

  // 4) 削除
  console.log(`\n=== 削除 ===`);
  for (const s of steps) {
    const { error } = await s.apply(sb.from(s.table).delete());
    if (error) {
      console.error(`✗ ${s.table} (${s.label}): ${error.message}`);
      process.exit(1);
    }
    console.log(`  ✓ ${s.table.padEnd(30)} ${s.label.padEnd(18)} ${s.count} 行`);
  }
  if (dropWhole.length) {
    const { error } = await sb.from("clients").delete().in("id", dropWhole);
    if (error) {
      console.error(`✗ clients: ${error.message}`);
      process.exit(1);
    }
    console.log(`  ✓ ${"clients".padEnd(30)} ${"全削除対象".padEnd(18)} ${dropWhole.length} 行`);
  }

  console.log(`\n✓ 完了。おゆみ野 訪問介護は「実データ未取込 = 売上 0 円」になりました。`);
}

function fileURLToPathSafe(u) {
  return decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
