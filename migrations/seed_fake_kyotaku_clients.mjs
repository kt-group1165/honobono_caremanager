/**
 * 動作確認用 居宅介護支援 fake 利用者 50 名 + 関連書類を kaigo-app の各 table に seed する。
 *
 * 利用者マスタは apps/payroll-app/migrations/gen_sample_kyotaku_csv.mjs の STAFF_CLIENTS を
 * そのまま流用 (A001〜A009 / B001〜B014 / C001〜C008 / D001〜D009 / E001〜E010 / X001)。
 *
 * 対象 table:
 *   - clients (shared)                 ... user_number=A001…X001 を INSERT (既存と user_number で重複 check)
 *   - client_memos                     ... '[fake テスト用]' を tenant scope で 1 件
 *   - kaigo_care_plans                 ... 各利用者に 1 件 (居宅サービス計画書 第1〜3表 のベース)
 *   - kaigo_assessments                ... 各利用者に 1 件 (アセスメント)
 *   - kaigo_monitoring_sheets          ... 各利用者に 1 件 (モニタリング記録)
 *   - kaigo_report_documents (utilization)
 *                                      ... 各利用者 × 6 ヶ月 (2026/01〜2026/06) で report_type='service-usage' (利用票・提供票)
 *   - kaigo_report_documents (meeting) ... 1 件のみ (代表利用者) サービス担当者会議録
 *
 * 担当 ケアマネ resolution:
 *   payroll_employees.name で 坂本 祐香 / 天野 恵子 / 本庄 麻子 / 森田 尚子 / 清水 治美 を
 *   居宅事業所 (offices.business_number='1270501172') の office_id 一致で絞り込む。
 *   clients.care_manager (text) と clients.care_manager_id に書き込む。
 *
 * Usage:
 *   node migrations/seed_fake_kyotaku_clients.mjs              # DRY RUN (件数表示のみ)
 *   node migrations/seed_fake_kyotaku_clients.mjs --execute    # 本番実行
 *
 * 削除する場合:
 *   - clients.memo 経由ではなく client_memos.body LIKE '%[fake テスト用]%' で client_id を抽出 → cascade で OK。
 *   - or: clients.user_number IN ('A001',…,'X001') AND tenant_id='kt-group' AND care_office_id=居宅office.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── env 読み取り (kaigo-app .env.local → calendar-app .env.local fallback) ──
function loadEnvFile(path) {
  try {
    const env = readFileSync(path, "utf8");
    const vars = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL =
  envKaigo.NEXT_PUBLIC_SUPABASE_URL ||
  envCal.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY =
  envKaigo.SUPABASE_SERVICE_ROLE_KEY ||
  envCal.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}

const TENANT_ID = "kt-group";
const KYOTAKU_OFFICE_NUMBER = "1270501172"; // Ｈａｎａ居宅支援センターおゆみ野
const INSURER_NUMBER = "122192";
const FAKE_MARKER = "[fake テスト用]";

const EXECUTE = process.argv.includes("--execute");

// ── 50 名 利用者マスタ (CSV 生成スクリプト と同一定義) ──
const STAFF_CLIENTS = {
  "坂本 祐香": [
    { user_no: "A001", name: "青木 一郎", insured: "0001000001", gender: "男", birth: "1940-01-15", care_level: "要介護2", started: null, ended: null },
    { user_no: "A002", name: "石井 花子", insured: "0001000002", gender: "女", birth: "1938-03-22", care_level: "要介護1", started: null, ended: null },
    { user_no: "A003", name: "上田 三郎", insured: "0001000003", gender: "男", birth: "1942-07-08", care_level: "要介護3", started: null, ended: null },
    { user_no: "A004", name: "江口 静子", insured: "0001000004", gender: "女", birth: "1935-11-30", care_level: "要介護4", started: null, ended: null },
    { user_no: "A005", name: "大野 五郎", insured: "0001000005", gender: "男", birth: "1939-05-19", care_level: "要介護2", started: null, ended: null },
    { user_no: "A006", name: "加藤 千代", insured: "0001000006", gender: "女", birth: "1937-09-25", care_level: "要介護5", started: null, ended: null },
    { user_no: "A007", name: "木下 七郎", insured: "0001000007", gender: "男", birth: "1941-12-03", care_level: "要介護1", started: null, ended: null },
    { user_no: "A008", name: "久保 八重", insured: "0001000008", gender: "女", birth: "1933-02-14", care_level: "要介護3", started: null, ended: null },
    { user_no: "A009", name: "小林 信吾", insured: "0001000009", gender: "男", birth: "1945-08-07", care_level: "要介護1", started: "2026-03", ended: null },
    { user_no: "X001", name: "佐藤 月遅", insured: "0001999001", gender: "男", birth: "1944-06-10", care_level: "要介護2", started: null, ended: null },
  ],
  "天野 恵子": [
    { user_no: "B001", name: "鈴木 京子", insured: "0002000001", gender: "女", birth: "1936-04-12", care_level: "要介護3", started: null, ended: null },
    { user_no: "B002", name: "高橋 健一", insured: "0002000002", gender: "男", birth: "1942-08-23", care_level: "要介護2", started: null, ended: null },
    { user_no: "B003", name: "田中 道子", insured: "0002000003", gender: "女", birth: "1940-11-05", care_level: "要介護1", started: null, ended: null },
    { user_no: "B004", name: "中村 隆", insured: "0002000004", gender: "男", birth: "1934-01-18", care_level: "要介護4", started: null, ended: null },
    { user_no: "B005", name: "西田 さくら", insured: "0002000005", gender: "女", birth: "1938-10-09", care_level: "要介護2", started: null, ended: null },
    { user_no: "B006", name: "野口 茂", insured: "0002000006", gender: "男", birth: "1941-03-27", care_level: "要介護1", started: null, ended: null },
    { user_no: "B007", name: "橋本 美智子", insured: "0002000007", gender: "女", birth: "1937-07-14", care_level: "要介護3", started: null, ended: null },
    { user_no: "B008", name: "藤田 義雄", insured: "0002000008", gender: "男", birth: "1933-12-01", care_level: "要介護5", started: null, ended: null },
    { user_no: "B009", name: "前田 緑", insured: "0002000009", gender: "女", birth: "1939-05-31", care_level: "要介護2", started: null, ended: null },
    { user_no: "B010", name: "松本 太郎", insured: "0002000010", gender: "男", birth: "1942-09-16", care_level: "要介護1", started: null, ended: null },
    { user_no: "B011", name: "宮本 涼子", insured: "0002000011", gender: "女", birth: "1935-02-22", care_level: "要介護3", started: null, ended: null },
    { user_no: "B012", name: "森 健二", insured: "0002000012", gender: "男", birth: "1940-06-04", care_level: "要介護2", started: null, ended: null },
    { user_no: "B013", name: "山本 久美子", insured: "0002000013", gender: "女", birth: "1938-08-17", care_level: "要介護4", started: null, ended: null },
    { user_no: "B014", name: "吉田 武", insured: "0002000014", gender: "男", birth: "1936-10-29", care_level: "要介護2", started: null, ended: "2026-04" },
  ],
  "本庄 麻子": [
    { user_no: "C001", name: "斎藤 文子", insured: "0003000001", gender: "女", birth: "1937-01-25", care_level: "要介護2", started: null, ended: null },
    { user_no: "C002", name: "酒井 治男", insured: "0003000002", gender: "男", birth: "1942-04-11", care_level: "要介護3", started: null, ended: null },
    { user_no: "C003", name: "坂田 みつ", insured: "0003000003", gender: "女", birth: "1939-07-28", care_level: "要介護1", started: null, ended: null },
    { user_no: "C004", name: "佐々木 進", insured: "0003000004", gender: "男", birth: "1934-09-14", care_level: "要介護4", started: null, ended: null },
    { user_no: "C005", name: "篠原 智子", insured: "0003000005", gender: "女", birth: "1941-11-06", care_level: "要介護2", started: null, ended: null },
    { user_no: "C006", name: "杉山 浩二", insured: "0003000006", gender: "男", birth: "1938-12-19", care_level: "要介護3", started: null, ended: null },
    { user_no: "C007", name: "瀬戸 過誤", insured: "0003999001", gender: "女", birth: "1936-05-22", care_level: "要介護2", started: null, ended: null },
    { user_no: "C008", name: "曽根 一夫", insured: "0003000007", gender: "男", birth: "1946-02-14", care_level: "要介護1", started: "2026-06", ended: null },
  ],
  "森田 尚子": [
    { user_no: "D001", name: "高木 春雄", insured: "0004000001", gender: "男", birth: "1941-02-08", care_level: "要介護1", started: null, ended: null },
    { user_no: "D002", name: "高山 房子", insured: "0004000002", gender: "女", birth: "1937-05-20", care_level: "要介護3", started: null, ended: null },
    { user_no: "D003", name: "竹内 正夫", insured: "0004000003", gender: "男", birth: "1939-08-13", care_level: "要介護2", started: null, ended: null },
    { user_no: "D004", name: "立花 のぶ", insured: "0004000004", gender: "女", birth: "1933-10-26", care_level: "要介護4", started: null, ended: null },
    { user_no: "D005", name: "谷口 利夫", insured: "0004000005", gender: "男", birth: "1940-01-05", care_level: "要介護2", started: null, ended: null },
    { user_no: "D006", name: "塚本 トキ", insured: "0004000006", gender: "女", birth: "1936-03-18", care_level: "要介護5", started: null, ended: null },
    { user_no: "D007", name: "土屋 義男", insured: "0004000007", gender: "男", birth: "1942-06-30", care_level: "要介護1", started: null, ended: null },
    { user_no: "D008", name: "寺田 静江", insured: "0004000008", gender: "女", birth: "1938-09-12", care_level: "要介護3", started: null, ended: null },
    { user_no: "D009", name: "戸田 五郎", insured: "0004000009", gender: "男", birth: "1934-11-24", care_level: "要介護2", started: null, ended: null },
  ],
  "清水 治美": [
    { user_no: "E001", name: "永井 雄一", insured: "0005000001", gender: "男", birth: "1941-04-22", care_level: "要介護2", started: null, ended: null },
    { user_no: "E002", name: "中島 順子", insured: "0005000002", gender: "女", birth: "1937-06-15", care_level: "要介護3", started: null, ended: null },
    { user_no: "E003", name: "長島 茂", insured: "0005000003", gender: "男", birth: "1939-08-08", care_level: "要介護1", started: null, ended: null },
    { user_no: "E004", name: "西山 千恵", insured: "0005000004", gender: "女", birth: "1934-10-30", care_level: "要介護4", started: null, ended: null },
    { user_no: "E005", name: "野田 健太", insured: "0005000005", gender: "男", birth: "1942-12-12", care_level: "要介護2", started: null, ended: null },
    { user_no: "E006", name: "畑中 あや", insured: "0005000006", gender: "女", birth: "1943-02-03", care_level: "要支援1", started: null, ended: null },
    { user_no: "E007", name: "原 信夫", insured: "0005000007", gender: "男", birth: "1944-05-16", care_level: "要支援2", started: null, ended: null },
    { user_no: "E008", name: "東 さなえ", insured: "0005000008", gender: "女", birth: "1945-07-28", care_level: "要支援1", started: null, ended: null },
    { user_no: "E009", name: "平岡 進", insured: "0005000009", gender: "男", birth: "1942-09-09", care_level: "要支援2", started: null, ended: null },
    { user_no: "E010", name: "福島 紀子", insured: "0005000010", gender: "女", birth: "1943-11-21", care_level: "要支援1", started: null, ended: null },
  ],
};

// 利用者の "active" 月レンジ (2026-01〜2026-06 のうち、started 以降 / ended 未満)
const TICKET_MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
function isActive(client, ym) {
  if (client.started && ym < client.started) return false;
  if (client.ended && ym >= client.ended) return false;
  return true;
}

// ── ページング fetch ──
async function fetchAll(sb, table, select, filters = {}) {
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + 999);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

// ── main ──
async function main() {
  console.log(`\n📂 fake 居宅 利用者 seed`);
  console.log(`🏢 tenant_id = ${TENANT_ID}`);
  console.log(`🏪 office = ${KYOTAKU_OFFICE_NUMBER}`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (実書込)" : "🔍 DRY RUN (件数のみ)");
  console.log("");

  const sb = createClient(SB_URL, SB_KEY);

  // ── 居宅事業所 ID 解決 ──
  // clients.office_id     → offices.id
  // clients.care_office_id → care_offices.id  (居宅介護支援事業所マスタは別 table)
  const offices = await fetchAll(sb, "offices", "id, name, business_number", { tenant_id: TENANT_ID });
  const office = offices.find((o) => (o.business_number ?? "").replace(/-/g, "") === KYOTAKU_OFFICE_NUMBER);
  if (!office) {
    console.error(`❌ office business_number=${KYOTAKU_OFFICE_NUMBER} が見つかりません`);
    process.exit(1);
  }
  console.log(`   offices: ${office.name} (${office.id})`);

  const { data: coRow, error: coErr } = await sb
    .from("care_offices")
    .select("id, name, office_number")
    .eq("office_number", KYOTAKU_OFFICE_NUMBER)
    .maybeSingle();
  if (coErr) {
    console.error("❌ care_offices 取得:", coErr.message);
    process.exit(1);
  }
  if (!coRow) {
    console.warn(`   ⚠️  care_offices に office_number=${KYOTAKU_OFFICE_NUMBER} が無いため clients.care_office_id は null で挿入`);
  } else {
    console.log(`   care_offices: ${coRow.name} (${coRow.id})`);
  }
  const careOfficeId = coRow?.id ?? null;

  // ── ケアマネ care_managers.id 解決 ──
  // clients.care_manager_id FK は care_managers を指す。
  // 不足名は今回 fake seed として INSERT する (active=true)。
  const careManagerNames = Object.keys(STAFF_CLIENTS);
  const cmRows = await sb
    .from("care_managers")
    .select("id, name, tenant_id, care_office_id, active")
    .in("name", careManagerNames)
    .eq("tenant_id", TENANT_ID);
  if (cmRows.error) {
    console.error("❌ care_managers 取得:", cmRows.error.message);
    process.exit(1);
  }
  const empByName = new Map();
  for (const e of cmRows.data ?? []) {
    if (!empByName.has(e.name) || e.active) empByName.set(e.name, e.id);
  }
  // 不足分は INSERT
  for (const n of careManagerNames) {
    if (empByName.has(n)) continue;
    if (!EXECUTE) {
      console.log(`     ${n}: (要新規 INSERT)`);
      continue;
    }
    const { data, error } = await sb.from("care_managers").insert({
      tenant_id: TENANT_ID,
      care_office_id: careOfficeId,
      name: n,
      active: true,
    }).select("id").single();
    if (error) {
      console.warn(`   ⚠️  care_managers insert ${n}: ${error.message}`);
    } else {
      empByName.set(n, data.id);
      console.log(`     ${n}: ${data.id} (新規 INSERT)`);
    }
  }
  console.log(`   ケアマネ resolve:`);
  for (const n of careManagerNames) {
    console.log(`     ${n}: ${empByName.get(n) ?? "(見つからず)"}`);
  }
  // 不足分は staff_id を null にして続行
  const missingCM = careManagerNames.filter((n) => !empByName.has(n));
  if (missingCM.length > 0) {
    console.warn(`   ⚠️  以下のケアマネは見つからず (担当 staff 紐付け skip): ${missingCM.join(", ")}`);
  }

  // ── 既存 clients (user_number で existing check) ──
  const allUserNos = [];
  for (const [, list] of Object.entries(STAFF_CLIENTS)) for (const c of list) allUserNos.push(c.user_no);
  const existing = await sb
    .from("clients")
    .select("id, user_number")
    .eq("tenant_id", TENANT_ID)
    .in("user_number", allUserNos);
  if (existing.error) {
    console.error("❌ clients existing check:", existing.error.message);
    process.exit(1);
  }
  const existingByUserNo = new Map();
  for (const c of existing.data ?? []) existingByUserNo.set(c.user_number, c.id);
  const skipCount = existingByUserNo.size;
  const insertCount = allUserNos.length - skipCount;
  console.log(`\n👤 clients: 既存 ${skipCount} 名 / 新規 INSERT 予定 ${insertCount} 名`);

  // ── ticket 件数 試算 ──
  let ticketEstimate = 0;
  for (const [, list] of Object.entries(STAFF_CLIENTS)) {
    for (const c of list) for (const ym of TICKET_MONTHS) if (isActive(c, ym)) ticketEstimate++;
  }
  console.log(`📝 kaigo_report_documents (service-usage): ${ticketEstimate} 件 (50名 × 6ヶ月 − 不在月)`);
  console.log(`📋 kaigo_care_plans: 50 件`);
  console.log(`🔍 kaigo_assessments: 50 件`);
  console.log(`📊 kaigo_monitoring_sheets: 50 件`);
  console.log(`💬 kaigo_report_documents (meeting-minutes): 1 件 (代表利用者のみ)`);

  if (!EXECUTE) {
    console.log("\n✅ DRY RUN 完了。--execute を付けて再実行で本番反映。");
    return;
  }

  // ── 1. clients INSERT (skip if existing) ──
  console.log("\n👤 clients INSERT 中...");
  const clientIdByUserNo = new Map(existingByUserNo);
  const memoRows = [];
  let cIns = 0, cFail = 0;
  for (const [staffName, list] of Object.entries(STAFF_CLIENTS)) {
    const careManagerId = empByName.get(staffName) ?? null;
    for (const c of list) {
      if (clientIdByUserNo.has(c.user_no)) continue;
      const payload = {
        tenant_id: TENANT_ID,
        office_id: office.id,
        user_number: c.user_no,
        name: c.name,
        furigana: c.name, // dummy 仮置
        birth_date: c.birth,
        gender: c.gender,
        care_level: c.care_level,
        insured_number: c.insured,
        insurer_number: INSURER_NUMBER,
        care_office_id: careOfficeId,
        care_manager_id: careManagerId,
        care_manager: staffName,
        certification_start_date: "2025-04-01",
        certification_end_date: "2027-03-31",
        is_facility: false,
        is_provisional: false,
        status: "active",
        deleted_at: null,
        admission_date: c.started ? `${c.started}-01` : "2025-04-01",
        discharge_date: c.ended ? `${c.ended}-01` : null,
      };
      const { data, error } = await sb.from("clients").insert(payload).select("id").single();
      if (error) {
        cFail++;
        console.warn(`   ⚠️  ${c.user_no} ${c.name}: ${error.message}`);
        continue;
      }
      clientIdByUserNo.set(c.user_no, data.id);
      memoRows.push({
        client_id: data.id,
        scope: "tenant",
        tenant_id: TENANT_ID,
        body: `${FAKE_MARKER} 担当: ${staffName} / user_no: ${c.user_no} / 居宅介護支援 fake 利用者`,
        pinned: false,
      });
      cIns++;
    }
  }
  console.log(`   clients inserted=${cIns} / failed=${cFail}`);

  // ── 2. client_memos INSERT (新規 client 分のみ) ──
  if (memoRows.length > 0) {
    console.log(`\n💭 client_memos INSERT (${memoRows.length} 件)...`);
    let mIns = 0;
    const BATCH = 100;
    for (let i = 0; i < memoRows.length; i += BATCH) {
      const batch = memoRows.slice(i, i + BATCH);
      const { error } = await sb.from("client_memos").insert(batch);
      if (error) console.warn(`   ⚠️  batch ${i}: ${error.message}`);
      else mIns += batch.length;
    }
    console.log(`   client_memos inserted=${mIns}`);
  }

  // ── 3. kaigo_care_plans INSERT ──
  console.log("\n📋 kaigo_care_plans INSERT...");
  const planIdByUserNo = new Map();
  let pIns = 0;
  let planNumber = 1;
  for (const [staffName, list] of Object.entries(STAFF_CLIENTS)) {
    for (const c of list) {
      const cid = clientIdByUserNo.get(c.user_no);
      if (!cid) continue;
      const startYm = c.started ?? "2025-04";
      const payload = {
        user_id: cid,
        plan_number: planNumber++,
        plan_type: "居宅サービス計画",
        start_date: `${startYm}-01`,
        end_date: "2027-03-31",
        long_term_goals: `${FAKE_MARKER} 自宅で安全に生活を継続できる`,
        short_term_goals: `${FAKE_MARKER} 担当 ${staffName} / 月1回モニタリング実施`,
        status: "active",
        tenant_id: TENANT_ID,
      };
      const { data, error } = await sb.from("kaigo_care_plans").insert(payload).select("id").single();
      if (error) {
        console.warn(`   ⚠️  care_plan ${c.user_no}: ${error.message}`);
        continue;
      }
      planIdByUserNo.set(c.user_no, data.id);
      pIns++;
    }
  }
  console.log(`   kaigo_care_plans inserted=${pIns}`);

  // ── 4. kaigo_assessments INSERT ──
  console.log("\n🔍 kaigo_assessments INSERT...");
  let aIns = 0;
  for (const [staffName, list] of Object.entries(STAFF_CLIENTS)) {
    for (const c of list) {
      const cid = clientIdByUserNo.get(c.user_no);
      if (!cid) continue;
      const payload = {
        user_id: cid,
        assessment_date: c.started ? `${c.started}-15` : "2025-04-15",
        assessor_name: staffName,
        status: "completed",
        overall_summary: `${FAKE_MARKER} 担当 ${staffName} による初回アセスメント (fake データ)`,
        form_data: { _fake: true, _assessor: staffName, _care_level: c.care_level },
        tenant_id: TENANT_ID,
      };
      const { error } = await sb.from("kaigo_assessments").insert(payload);
      if (error) console.warn(`   ⚠️  assessment ${c.user_no}: ${error.message}`);
      else aIns++;
    }
  }
  console.log(`   kaigo_assessments inserted=${aIns}`);

  // ── 5. kaigo_monitoring_sheets INSERT ──
  console.log("\n📊 kaigo_monitoring_sheets INSERT...");
  let msIns = 0;
  for (const [staffName, list] of Object.entries(STAFF_CLIENTS)) {
    for (const c of list) {
      const cid = clientIdByUserNo.get(c.user_no);
      if (!cid) continue;
      const planId = planIdByUserNo.get(c.user_no) ?? null;
      const payload = {
        user_id: cid,
        monitoring_date: "2026-05-15",
        assessor_name: staffName,
        status: "draft",
        care_plan_id: planId,
        tenant_id: TENANT_ID,
      };
      const { error } = await sb.from("kaigo_monitoring_sheets").insert(payload);
      if (error) console.warn(`   ⚠️  monitoring ${c.user_no}: ${error.message}`);
      else msIns++;
    }
  }
  console.log(`   kaigo_monitoring_sheets inserted=${msIns}`);

  // ── 6. kaigo_report_documents (service-usage / 利用票・提供票) INSERT ──
  console.log("\n📝 kaigo_report_documents (service-usage) INSERT...");
  let ruIns = 0;
  const BATCH = 200;
  const rows = [];
  for (const [staffName, list] of Object.entries(STAFF_CLIENTS)) {
    for (const c of list) {
      const cid = clientIdByUserNo.get(c.user_no);
      if (!cid) continue;
      const planId = planIdByUserNo.get(c.user_no) ?? null;
      for (const ym of TICKET_MONTHS) {
        if (!isActive(c, ym)) continue;
        rows.push({
          user_id: cid,
          report_type: "service-usage",
          title: `${FAKE_MARKER} 利用票・提供票 (${ym}) — ${staffName} 担当`,
          report_month: ym,
          care_plan_id: planId,
          content: { _fake: true, _care_manager: staffName, _user_no: c.user_no, _month: ym },
          status: "draft",
          tenant_id: TENANT_ID,
        });
      }
    }
  }
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await sb.from("kaigo_report_documents").insert(batch);
    if (error) console.warn(`   ⚠️  batch ${i}: ${error.message}`);
    else ruIns += batch.length;
  }
  console.log(`   kaigo_report_documents (service-usage) inserted=${ruIns}`);

  // ── 7. kaigo_report_documents (meeting-minutes / サービス担当者会議録) INSERT — 1 件のみ ──
  console.log("\n💬 kaigo_report_documents (meeting-minutes) INSERT (1 件のみ)...");
  // 代表として 坂本 祐香 担当 A001 を使う
  const repClientId = clientIdByUserNo.get("A001");
  const repPlanId = planIdByUserNo.get("A001") ?? null;
  if (repClientId) {
    const payload = {
      user_id: repClientId,
      report_type: "meeting-minutes",
      title: `${FAKE_MARKER} サービス担当者会議の要点 2026-05-15`,
      report_month: "2026-05",
      care_plan_id: repPlanId,
      content: {
        _fake: true,
        meeting_date: "2026-05-15",
        attendees: [
          { name: "坂本 祐香", role: "ケアマネジャー", office: "Ｈａｎａ居宅支援センターおゆみ野" },
        ],
        topic: "サービス利用状況の確認",
        summary: `${FAKE_MARKER} fake テスト用のサービス担当者会議録`,
      },
      status: "draft",
      tenant_id: TENANT_ID,
    };
    const { error } = await sb.from("kaigo_report_documents").insert(payload);
    if (error) console.warn(`   ⚠️  meeting-minutes: ${error.message}`);
    else console.log(`   kaigo_report_documents (meeting-minutes) inserted=1`);
  } else {
    console.warn("   ⚠️  代表 client A001 が clientIdByUserNo に見つからず meeting-minutes skip");
  }

  console.log("\n✅ seed 完了\n");
  console.log("削除する場合 (テスト後):");
  console.log(`  SELECT id FROM clients WHERE tenant_id='${TENANT_ID}' AND user_number IN ('A001',...,'X001') AND office_id='${office.id}';`);
  console.log("  → cascade で kaigo_* も消える想定 (FK 設定済の場合)。FK が無ければ kaigo_* を user_id で先に削除すること。");
  console.log("  または: SELECT client_id FROM client_memos WHERE body LIKE '%[fake テスト用]%';");
}

main().catch((e) => { console.error(e); process.exit(1); });
