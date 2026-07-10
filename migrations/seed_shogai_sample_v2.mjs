// 障害福祉サンプルデータ v2 (2026-07-03)
// ---------------------------------------------------------------
// 現行スキーマ準拠: shougai_certifications (統合版) + kaigo_visit_schedule
// (障害コードの正式名称) + shogai_service_records。
// 実績月間管理 / 実績記録票 / 障害請求 / 上限管理 のテストに使う。
//
// usage:
//   node migrations/seed_shogai_sample_v2.mjs            # DRY RUN
//   node migrations/seed_shogai_sample_v2.mjs --execute
import { createClient } from "@supabase/supabase-js";

const EXECUTE = process.argv.includes("--execute");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TENANT = "kt-group";
const OFFICE_ID = "4f14d50c-76b5-4f44-ac41-ed6d01f53a30"; // Ｈａｎａヘルパーステーションおゆみ野
const MARKER = "[fake テスト用-shogai-v2]";

// 3 名: 上限管理 自事業所 / 他事業所 / なし(生保)
const CLIENTS = [
  {
    name: "青木 太一", furigana: "アオキ タイチ", gender: "男", birth: "1975-06-15",
    beneficiary: "1000000011", level: "区分3", disability: "知的障害",
    limit: 9300, seiho: false, kanri: "自事業所",
    kanriNo: null, kanriName: null,
    contract: "身体介護 12時間/月", weekly: [1, 4], // 月・木
  },
  {
    name: "石田 花子", furigana: "イシダ ハナコ", gender: "女", birth: "1982-11-03",
    beneficiary: "1000000022", level: "区分4", disability: "身体障害",
    limit: 4600, seiho: false, kanri: "他事業所",
    kanriNo: "1310000099", kanriName: "ちば障害サポートセンター",
    contract: "家事援助 8時間/月", weekly: [2, 5], // 火・金
  },
  {
    name: "上野 純", furigana: "ウエノ ジュン", gender: "男", birth: "1990-02-20",
    beneficiary: "1000000033", level: "区分2", disability: "精神障害",
    limit: 0, seiho: true, kanri: "なし",
    kanriNo: null, kanriName: null,
    contract: "身体介護 6時間/月", weekly: [3], // 水
  },
];

// 障害マスタから正式名称のコードを引く (身体日1.0 / 家事日1.0 相当)
async function pickCodes() {
  const get = async (name) => {
    const { data, error } = await sb
      .from("kaigo_service_codes")
      .select("service_code, service_name, units")
      .eq("system", "障害")
      .eq("service_category", "11")
      .eq("calculation_type", "基本")
      .eq("service_name", name)
      .limit(1);
    if (error) throw new Error("障害コード取得失敗: " + error.message);
    if (!data?.[0]) throw new Error(`コードが見つかりません: ${name}`);
    return data[0];
  };
  return { body: await get("身体日１．０"), kaji: await get("家事日１．０") };
}

// 7月の該当曜日の日付一覧
function datesOf(weekdays) {
  const out = [];
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(2026, 6, d);
    if (weekdays.includes(dt.getDay())) out.push(`2026-07-${String(d).padStart(2, "0")}`);
  }
  return out;
}

const { body, kaji } = await pickCodes();
console.log("使用コード:", body.service_code, body.service_name, body.units + "単位", "/", kaji.service_code, kaji.service_name, kaji.units + "単位");

// スタッフ 1 名 (実績の担当用)
const { data: staffRows } = await sb
  .from("members").select("id, name, member_offices!inner(office_id)")
  .eq("status", "active").eq("member_offices.office_id", OFFICE_ID).limit(1);
const staff = staffRows?.[0] ?? null;

let plan = { clients: 0, certs: 0, assigns: 0, schedules: 0, records: 0 };
const ops = [];

for (const [i, c] of CLIENTS.entries()) {
  const svc = i === 1 ? kaji : body; // 石田さんは家事、他は身体
  const dates = datesOf(c.weekly);
  plan.clients++; plan.certs++; plan.assigns++;
  plan.schedules += dates.length;
  plan.records += dates.filter((d) => d <= "2026-07-15").length; // 15 日までは実績化
  ops.push({ c, svc, dates });
}
console.log("生成 plan:", plan, EXECUTE ? "(EXECUTE)" : "(DRY RUN)");
if (!EXECUTE) process.exit(0);

// user_number は NOT NULL → 既存最大値から連番 (テスト用は 99 万台)
const { data: maxRow } = await sb
  .from("clients").select("user_number").order("user_number", { ascending: false }).limit(1);
let nextNo = Math.max(990000, (parseInt(maxRow?.[0]?.user_number ?? "0", 10) || 0) + 1);

for (const { c, svc, dates } of ops) {
  // clients
  const { data: cl, error: e1 } = await sb.from("clients").insert({
    tenant_id: TENANT, name: c.name, furigana: c.furigana, gender: c.gender,
    birth_date: c.birth, status: "active", is_facility: false,
    user_number: String(nextNo++),
    address: `千葉市緑区おゆみ野テスト ${MARKER}`,
  }).select("id").single();
  if (e1) { console.error("✗ clients", c.name, e1.message); continue; }
  const id = cl.id;

  const { error: e2 } = await sb.from("client_office_assignments").insert({
    tenant_id: TENANT, client_id: id, office_id: OFFICE_ID,
  });
  if (e2) console.error("✗ assign", c.name, e2.message);

  const { error: e3 } = await sb.from("shougai_certifications").insert({
    tenant_id: TENANT, client_id: id,
    support_level: c.level, primary_disability: c.disability,
    certification_start_date: "2026-04-01", certification_end_date: "2029-03-31",
    beneficiary_number: c.beneficiary, insurer_municipality: "122192",
    service_types: ["居宅介護"], copay_rate: 0.1,
    self_payment_limit: c.limit, seiho_flag: c.seiho,
    jogen_kanri_kubun: c.kanri,
    jogen_kanri_office_number: c.kanriNo, jogen_kanri_office_name: c.kanriName,
    contract_amount_text: c.contract, contract_start_date: "2026-04-01",
    contract_entry_number: "1",
    notes: MARKER,
  });
  if (e3) console.error("✗ cert", c.name, e3.message);

  for (const d of dates) {
    // 予定 (障害コードの正式名称)
    const { error: e4 } = await sb.from("kaigo_visit_schedule").insert({
      tenant_id: TENANT, user_id: id, staff_id: staff?.id ?? null,
      visit_date: d, start_time: "10:00:00", end_time: "11:00:00",
      service_type: svc.service_name,
      status: d <= "2026-07-15" ? "completed" : "scheduled",
    });
    if (e4) console.error("✗ schedule", c.name, d, e4.message);

    // 15 日までは 障害実績 (confirmed)
    if (d <= "2026-07-15") {
      const { error: e5 } = await sb.from("shogai_service_records").insert({
        tenant_id: TENANT, client_id: id, office_id: OFFICE_ID,
        service_date: d, start_time: "10:00:00", end_time: "11:00:00",
        duration_minutes: 60,
        service_type: "居宅介護",
        service_category: svc.service_name.includes("家事") ? "家事援助" : "身体介護",
        service_code: svc.service_code, unit_count: svc.units,
        staff_id: staff?.id ?? null, staff_name_cached: staff?.name ?? null,
        status: "confirmed",
        notes: MARKER,
      });
      if (e5) console.error("✗ record", c.name, d, e5.message);
    }
  }
  console.log("✓", c.name, `(予定 ${dates.length} / 実績 ${dates.filter((x) => x <= "2026-07-15").length})`);
}

// verify
for (const t of ["shougai_certifications", "shogai_service_records"]) {
  const { count } = await sb.from(t).select("id", { count: "exact", head: true });
  console.log("verify", t, "=", count, "件");
}
