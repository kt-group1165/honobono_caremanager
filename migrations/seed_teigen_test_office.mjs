/**
 * 逓減制 (居宅介護支援費ⅱ/ⅲ) 自動判定ロジックの検証用に、
 * 完全に隔離されたテスト事業所 + テスト利用者 69 名を seed する。
 *
 * 対象 table:
 *   - offices                    ... 新規 1 件 (caremane_jokin_kansan=1.0)
 *   - clients                    ... 新規 69 名 (user_number 900001〜900069)
 *   - client_memos               ... 各利用者に marker 入り 1 件
 *   - client_office_assignments  ... 各利用者 → テスト事業所
 *   - kaigo_care_plans           ... 各利用者に status='active' 1 件
 *   - client_insurance_records   ... 各利用者に認定 1 件 (care_level を精密に割付け)
 *   - client_kohi_records        ... 一部利用者 (10名) に公費情報を付与 (周辺データの厚み)
 *
 * 利用者の内訳 (fte=1.0 / kanwa=false / second=45 / third=60 前提の期待値):
 *   要支援 (委託でない) 4 名 → 取扱件数オフセット = 4/3 = 1.3333...
 *   要介護 65 名 (900005〜900069, user_number 昇順 = tier 判定順)
 *     cumCount(idx 0-based) = 1.3333 + idx + 1
 *     idx  0〜42 (43名, #1〜#43) → (ⅰ)
 *     idx 43〜57 (15名, #44〜#58) → (ⅱ)
 *     idx 58〜64 ( 7名, #59〜#65) → (ⅲ)
 *   要介護度は 要介護1・2・3・4・5 を round-robin で割付け (light/heavy 両方をテスト)
 *
 * 全レコードに marker "[fake テスト用-teigen-20260903]" を notes 等に必ず入れる。
 *
 * Usage:
 *   node migrations/seed_teigen_test_office.mjs              # DRY RUN
 *   node migrations/seed_teigen_test_office.mjs --execute    # 本番実行
 *
 * 削除は migrations/delete_teigen_test_office.mjs を使う。
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
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
const SB_URL = envKaigo.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envKaigo.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}

export const TENANT_ID = "kt-group";
export const MARKER = "[fake テスト用-teigen-20260903]";
export const TEST_OFFICE_BUSINESS_NUMBER = "9999999901";
export const TEST_OFFICE_NAME = `【TEST】逓減制検証事業所 (削除予定 teigen-20260903)`;
export const TEMPLATE_COMPANY_ID_FALLBACK_BUSINESS_NUMBER = "1270501172"; // company_id 借用元 (実データは変更しない)
export const BILLING_MONTH = "2026-06";
export const INSURER_NUMBER = "122192"; // 千葉県内の実在パターンを模した fake 値

const EXECUTE = process.argv.includes("--execute");
const sb = createClient(SB_URL, SB_KEY);

// ── 69 名の利用者定義 ──
//   900001〜900004 = 要支援 (委託でない) 4名
//   900005〜900069 = 要介護 65名 (要介護1〜5 round-robin)
const YOBO_LEVELS = ["要支援1", "要支援1", "要支援2", "要支援2"];
const YOKAIGO_LEVELS = ["要介護1", "要介護2", "要介護3", "要介護4", "要介護5"];

function buildClients() {
  const rows = [];
  let n = 900001;
  for (let i = 0; i < YOBO_LEVELS.length; i++, n++) {
    rows.push({
      user_number: String(n),
      name: `逓減検証太郎${String(i + 1).padStart(2, "0")}`,
      care_level: YOBO_LEVELS[i],
      kind: "yobo",
    });
  }
  for (let i = 0; i < 65; i++, n++) {
    rows.push({
      user_number: String(n),
      name: `逓減検証花子${String(i + 1).padStart(3, "0")}`,
      care_level: YOKAIGO_LEVELS[i % YOKAIGO_LEVELS.length],
      kind: "yokaigo",
      ordinal: i + 1, // 1-based の想定 tier 判定順
    });
  }
  return rows;
}
export const TEST_CLIENTS = buildClients();

// 期待 tier (yoboCount=4 (委託でない), fte=1.0, kanwa=false → offset=4/3)
export function expectedTierForOrdinal(ordinal, fte = 1.0, kanwa = false) {
  const yoboOffset = YOBO_LEVELS.length / 3;
  const cumCount = yoboOffset + ordinal; // ordinal は 1-based idx+1 と同義
  const per = cumCount / fte;
  const second = kanwa ? 50 : 45;
  if (per < second) return "ⅰ";
  if (per < 60) return "ⅱ";
  return "ⅲ";
}

async function fetchAll(table, select, filters = {}) {
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

async function main() {
  console.log(`\n📂 逓減制検証 テストデータ seed`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (実書込)" : "🔍 DRY RUN (件数のみ)");
  console.log(`marker = ${MARKER}`);
  console.log(`billing_month (想定) = ${BILLING_MONTH}\n`);

  // company_id 借用元 office を確認 (実データは一切変更しない。FK 参照のみ)
  const tmplOffices = await fetchAll("offices", "id, company_id, business_number", {
    business_number: TEMPLATE_COMPANY_ID_FALLBACK_BUSINESS_NUMBER,
  });
  const tmpl = tmplOffices[0];
  if (!tmpl) {
    console.error(`❌ company_id 借用元 office (business_number=${TEMPLATE_COMPANY_ID_FALLBACK_BUSINESS_NUMBER}) が見つかりません`);
    process.exit(1);
  }
  console.log(`   company_id 借用元: office ${tmpl.id} → company_id=${tmpl.company_id}`);

  // 既存テスト office の有無確認 (再実行の冪等性)
  const existingOffices = await fetchAll("offices", "id, business_number", {
    business_number: TEST_OFFICE_BUSINESS_NUMBER,
  });
  let officeId = existingOffices[0]?.id ?? null;
  console.log(`   テスト office: ${officeId ? `既存 ${officeId}` : "(要新規作成)"}`);

  // 既存テスト clients の有無確認
  const allUserNumbers = TEST_CLIENTS.map((c) => c.user_number);
  const existingClients = await fetchAll("clients", "id, user_number", { tenant_id: TENANT_ID });
  const existingByUserNo = new Map(
    existingClients.filter((c) => allUserNumbers.includes(c.user_number)).map((c) => [c.user_number, c.id]),
  );
  console.log(`   テスト clients: 既存 ${existingByUserNo.size} / 新規予定 ${allUserNumbers.length - existingByUserNo.size}`);

  console.log(`\n   内訳: 要支援 ${YOBO_LEVELS.length}名 (委託でない) / 要介護 65名`);
  console.log(`   期待 tier (fte=1.0, kanwa=false): `);
  const tierCounts = { "ⅰ": 0, "ⅱ": 0, "ⅲ": 0 };
  const boundary = [];
  for (const c of TEST_CLIENTS.filter((c) => c.kind === "yokaigo")) {
    const t = expectedTierForOrdinal(c.ordinal);
    tierCounts[t]++;
    if ([42, 43, 44, 57, 58, 59].includes(c.ordinal)) {
      boundary.push(`     #${c.ordinal} (user_number=${c.user_number}, ${c.care_level}) → (${t})`);
    }
  }
  console.log(`     ⅰ=${tierCounts["ⅰ"]} / ⅱ=${tierCounts["ⅱ"]} / ⅲ=${tierCounts["ⅲ"]}`);
  console.log(`   境界値 (#42〜44, #57〜59):`);
  boundary.forEach((l) => console.log(l));

  if (!EXECUTE) {
    console.log("\n✅ DRY RUN 完了。--execute を付けて再実行で本番反映。");
    return;
  }

  // ── 1. offices INSERT ──
  if (!officeId) {
    console.log("\n🏢 offices INSERT...");
    const { data, error } = await sb
      .from("offices")
      .insert({
        tenant_id: TENANT_ID,
        name: TEST_OFFICE_NAME,
        business_number: TEST_OFFICE_BUSINESS_NUMBER,
        service_type: "居宅介護支援",
        company_id: tmpl.company_id,
        designation_type: "介護保険",
        app_type: "kaigo-app",
        area_category: null,
        unit_price: 10.0,
        caremane_jokin_kansan: 1.0,
        teigen_kanwa: false,
        is_active: true,
        sort_order: 9999,
        notes: `${MARKER} 逓減制自動判定の検証用テスト事業所。検証完了後 delete_teigen_test_office.mjs で削除すること。`,
      })
      .select("id")
      .single();
    if (error) {
      console.error("❌ offices insert 失敗:", error.message);
      process.exit(1);
    }
    officeId = data.id;
    console.log(`   office 作成: ${officeId}`);
  }

  // ── 2. clients + client_memos + client_office_assignments + kaigo_care_plans + client_insurance_records ──
  console.log("\n👤 clients 一式 INSERT...");
  let cIns = 0;
  let planNumber = 900001;
  for (const c of TEST_CLIENTS) {
    let clientId = existingByUserNo.get(c.user_number);
    if (!clientId) {
      const idx = Number(c.user_number) - 900001;
      const payload = {
        tenant_id: TENANT_ID,
        user_number: c.user_number,
        name: c.name,
        furigana: c.name,
        birth_date: `19${35 + (idx % 20)}-0${(idx % 9) + 1}-1${idx % 9}`,
        gender: idx % 2 === 0 ? "男" : "女",
        address: `千葉県テスト市テスト町${idx + 1}丁目${(idx % 9) + 1}番地`,
        postal_code: `260-00${String(idx % 90).padStart(2, "0")}`,
        phone: `043-000-${String(1000 + idx).padStart(4, "0")}`,
        is_facility: false,
        is_provisional: false,
        status: "active",
        deleted_at: null,
        admission_date: "2025-04-01",
      };
      const { data, error } = await sb.from("clients").insert(payload).select("id").single();
      if (error) {
        console.warn(`   ⚠️  clients ${c.user_number}: ${error.message}`);
        continue;
      }
      clientId = data.id;
      cIns++;

      const { error: memoErr } = await sb.from("client_memos").insert({
        client_id: clientId,
        scope: "tenant",
        tenant_id: TENANT_ID,
        body: `${MARKER} 逓減制検証用 fake 利用者 (${c.kind === "yobo" ? "要支援" : `要介護 ordinal=${c.ordinal}`})`,
        pinned: false,
      });
      if (memoErr) console.warn(`   ⚠️  client_memos ${c.user_number}: ${memoErr.message}`);
    }

    const { data: hasAssign } = await sb
      .from("client_office_assignments")
      .select("id")
      .eq("client_id", clientId)
      .eq("office_id", officeId);
    if (!(hasAssign ?? []).length) {
      const { error } = await sb
        .from("client_office_assignments")
        .insert({ tenant_id: TENANT_ID, client_id: clientId, office_id: officeId });
      if (error) console.warn(`   ⚠️  client_office_assignments ${c.user_number}: ${error.message}`);
    }

    const { data: hasPlan } = await sb
      .from("kaigo_care_plans")
      .select("id")
      .eq("user_id", clientId)
      .eq("status", "active");
    if (!(hasPlan ?? []).length) {
      const { error } = await sb.from("kaigo_care_plans").insert({
        user_id: clientId,
        plan_number: planNumber++,
        plan_type: "居宅サービス計画",
        start_date: "2025-04-01",
        end_date: "2027-03-31",
        long_term_goals: `${MARKER} 自宅で安全に生活を継続できる`,
        short_term_goals: `${MARKER} 逓減制検証用`,
        status: "active",
        tenant_id: TENANT_ID,
      });
      if (error) console.warn(`   ⚠️  kaigo_care_plans ${c.user_number}: ${error.message}`);
    }

    const { data: hasCert } = await sb
      .from("client_insurance_records")
      .select("id")
      .eq("client_id", clientId)
      .eq("notes", `${MARKER} 逓減制検証用認定`);
    if (!(hasCert ?? []).length) {
      const { error } = await sb.from("client_insurance_records").insert({
        tenant_id: TENANT_ID,
        client_id: clientId,
        care_level: c.care_level,
        insurer_number: INSURER_NUMBER,
        insured_number: `999${c.user_number}`,
        certification_start_date: "2025-04-01",
        certification_end_date: "2027-03-31",
        certification_status: "認定済み",
        record_status: "認定済み",
        copay_rate: "1",
        effective_date: "2025-04-01",
        notes: `${MARKER} 逓減制検証用認定`,
      });
      if (error) console.warn(`   ⚠️  client_insurance_records ${c.user_number}: ${error.message}`);
    }

    // 周辺データの厚み: 10名に1名の割合で公費情報を付与 (逓減計算そのものには影響しない)
    const idxAll = Number(c.user_number) - 900001;
    if (idxAll % 7 === 0) {
      const { data: hasKohi } = await sb
        .from("client_kohi_records")
        .select("id")
        .eq("client_id", clientId)
        .eq("notes", `${MARKER} 逓減制検証用公費`);
      if (!(hasKohi ?? []).length) {
        const { error } = await sb.from("client_kohi_records").insert({
          tenant_id: TENANT_ID,
          client_id: clientId,
          kohi_hobetsu: "12",
          futansha_number: `12${String(idxAll).padStart(6, "0")}`,
          jukyusha_number: `${String(idxAll).padStart(8, "0")}`,
          start_date: "2025-04-01",
          end_date: "2027-03-31",
          priority: 1,
          honnin_futan: 0,
          notes: `${MARKER} 逓減制検証用公費`,
        });
        if (error) console.warn(`   ⚠️  client_kohi_records ${c.user_number}: ${error.message}`);
      }
    }
  }
  console.log(`   clients 新規作成=${cIns} (既存流用含め計 ${TEST_CLIENTS.length} 名を割当)`);

  console.log(`\n✅ seed 完了。office_id=${officeId}`);
  console.log(`   検証スクリプト: OFFICE_ID=${officeId} BILLING_MONTH=${BILLING_MONTH} npx tsx migrations/verify_teigen_logic.mts`);
  console.log(`   削除: node migrations/delete_teigen_test_office.mjs --execute`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
