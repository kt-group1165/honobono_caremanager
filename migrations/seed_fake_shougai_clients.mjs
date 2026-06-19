/**
 * Ｈａｮｱヘルパーステーションおゆみ野 (= 障害福祉サービスも提供する想定) に
 * 動作確認用 fake 障害福祉 利用者 10 名 + 全関連書類を seed する。
 *
 * 前提 schema (= phase_shougai_support.sql 適用済):
 *   - clients.service_category: 'kaigo' / 'shougai' / 'both'
 *   - events / kaigo_visit_* / kaigo_service_records.service_category
 *   - shougai_certifications (= 障害支援区分マスタ)
 *
 * 対象 office:
 *   helper office_id = 4f14d50c-76b5-4f44-ac41-ed6d01f53a30
 *   (= Ｈａｮｱヘルパーステーションおゆみ野、障害福祉も提供している想定)
 *
 * 生成データ (1 利用者あたり):
 *   ① clients                    1 行 (service_category='shougai')
 *   ② client_office_assignments  1 行 (= 自事業所 filter 用)
 *   ③ shougai_certifications     1 行 (= 障害支援区分 受給者証)
 *   ④ kaigo_emergency_sheets     1 行 (= 緊急時情報)
 *   ⑤ kaigo_family_contacts      3 行 (= 家族連絡先)
 *   ⑥ kaigo_visit_patterns       3 行 (service_category='shougai')
 *   ⑦ kaigo_visit_records        8 行 (service_category='shougai'、過去 30 日)
 *   ⑧ kaigo_visit_schedule       6 行 (service_category='shougai'、来週分)
 *   ⑨ kaigo_service_records      6 行 (service_category='shougai'、過去 30 日)
 *   ⑩ kaigo_support_records      5 行 (支援経過)
 *
 * マーカー (= 後で削除しやすく):
 *   - notes / content 末尾に '[fake テスト用-shougai]'
 *   - special_notes / jsonb の _sample_marker = 'fake-shougai-2026-06'
 *
 * 削除 SQL (= 後始末用):
 *   DELETE FROM clients WHERE user_number LIKE 'SH%' AND tenant_id='kt-group';
 *   -- (子 table は ON DELETE CASCADE or user_id 直消し)
 *
 * Usage:
 *   node migrations/seed_fake_shougai_clients.mjs              # DRY RUN
 *   node migrations/seed_fake_shougai_clients.mjs --execute    # 本番実行
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

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
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL =
  envKaigo.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY =
  envKaigo.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}

const TENANT_ID = "kt-group";
const HELPER_OFFICE_ID = "4f14d50c-76b5-4f44-ac41-ed6d01f53a30"; // Ｈａｮｱヘルパーステーションおゆみ野
const FAKE_MARKER = "[fake テスト用-shougai]";
const SAMPLE_MARKER = "fake-shougai-2026-06";

const EXECUTE = process.argv.includes("--execute");

// ── 10 名 利用者マスタ (= 障害支援区分・障害種別・利用サービス を多様に) ──
//   user_number: SH001-SH010 (= Shougai 略)
const CLIENTS = [
  {
    user_no: "SH001", name: "山口 健太郎", furi: "ヤマグチ ケンタロウ",
    gender: "男", birth: "1995-03-15",
    postal: "266-0006", address: "千葉県千葉市緑区おゆみ野中央1-1-1", phone: "043-200-1001", blood: "A",
    support_level: "区分3", primary_disability: "知的障害",
    services: ["居宅介護"],
    beneficiary_no: "0700000001",
    ailment: "知的障害 (中度)",
  },
  {
    user_no: "SH002", name: "佐藤 みどり", furi: "サトウ ミドリ",
    gender: "女", birth: "1980-07-22",
    postal: "266-0006", address: "千葉県千葉市緑区おゆみ野中央2-2-2", phone: "043-200-1002", blood: "O",
    support_level: "区分5", primary_disability: "身体障害",
    services: ["重度訪問介護"],
    beneficiary_no: "0700000002",
    ailment: "頸髄損傷後遺症 (四肢麻痺)",
  },
  {
    user_no: "SH003", name: "田中 翔太", furi: "タナカ ショウタ",
    gender: "男", birth: "2002-12-08",
    postal: "266-0006", address: "千葉県千葉市緑区おゆみ野中央3-3-3", phone: "043-200-1003", blood: "B",
    support_level: "区分4", primary_disability: "発達障害",
    services: ["行動援護"],
    beneficiary_no: "0700000003",
    ailment: "自閉スペクトラム症 (強度行動障害あり)",
  },
  {
    user_no: "SH004", name: "鈴木 さおり", furi: "スズキ サオリ",
    gender: "女", birth: "1988-05-30",
    postal: "266-0006", address: "千葉県千葉市緑区おゆみ野中央4-4-4", phone: "043-200-1004", blood: "AB",
    support_level: "区分2", primary_disability: "精神障害",
    services: ["居宅介護"],
    beneficiary_no: "0700000004",
    ailment: "統合失調症 (症状安定期)",
  },
  {
    user_no: "SH005", name: "高橋 一馬", furi: "タカハシ カズマ",
    gender: "男", birth: "1975-09-14",
    postal: "266-0007", address: "千葉県千葉市緑区おゆみ野南5-5-5", phone: "043-200-1005", blood: "A",
    support_level: "区分6", primary_disability: "重複障害",
    services: ["重度訪問介護"],
    beneficiary_no: "0700000005",
    ailment: "脳性麻痺 + 知的障害 (重度重複)",
  },
  {
    user_no: "SH006", name: "中村 美咲", furi: "ナカムラ ミサキ",
    gender: "女", birth: "1990-11-25",
    postal: "266-0007", address: "千葉県千葉市緑区おゆみ野南6-6-6", phone: "043-200-1006", blood: "O",
    support_level: "区分1", primary_disability: "身体障害",
    services: ["同行援護"],
    beneficiary_no: "0700000006",
    ailment: "視覚障害 (全盲)",
  },
  {
    user_no: "SH007", name: "渡辺 健二", furi: "ワタナベ ケンジ",
    gender: "男", birth: "1985-04-03",
    postal: "266-0007", address: "千葉県千葉市緑区おゆみ野南7-7-7", phone: "043-200-1007", blood: "B",
    support_level: "区分3", primary_disability: "知的障害",
    services: ["居宅介護"],
    beneficiary_no: "0700000007",
    ailment: "知的障害 (中度) + てんかん",
  },
  {
    user_no: "SH008", name: "小林 京子", furi: "コバヤシ キョウコ",
    gender: "女", birth: "1972-08-17",
    postal: "266-0007", address: "千葉県千葉市緑区おゆみ野南8-8-8", phone: "043-200-1008", blood: "A",
    support_level: "区分4", primary_disability: "精神障害",
    services: ["居宅介護"],
    beneficiary_no: "0700000008",
    ailment: "双極性障害 (服薬管理が必要)",
  },
  {
    user_no: "SH009", name: "加藤 大樹", furi: "カトウ ダイキ",
    gender: "男", birth: "1970-02-26",
    postal: "264-0029", address: "千葉県千葉市若葉区桜木9-9-9", phone: "043-200-1009", blood: "AB",
    support_level: "区分5", primary_disability: "身体障害",
    services: ["重度訪問介護"],
    beneficiary_no: "0700000009",
    ailment: "ALS (筋萎縮性側索硬化症)",
  },
  {
    user_no: "SH010", name: "山田 恵子", furi: "ヤマダ ケイコ",
    gender: "女", birth: "1968-06-11",
    postal: "264-0029", address: "千葉県千葉市若葉区桜木10-10", phone: "043-200-1010", blood: "O",
    support_level: "区分2", primary_disability: "難病",
    services: ["居宅介護"],
    beneficiary_no: "0700000010",
    ailment: "パーキンソン病 (難病指定)",
  },
];

const TODAY = new Date();
function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }
function ymd(d) { return d.toISOString().slice(0, 10); }
function rnd(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

// 障害福祉サービス種別ごとの「kaigo_visit_records.service_type」値
//   (= 既存 freetext 列なのでサービス名そのまま入れる)
const VISIT_TIME_SLOTS = [
  { s: "09:00", e: "10:00" }, { s: "10:00", e: "11:30" }, { s: "13:00", e: "14:00" },
  { s: "14:30", e: "15:30" }, { s: "15:30", e: "16:30" }, { s: "16:00", e: "17:00" },
];

// 支援経過カテゴリ (CHECK 制約: 電話/訪問/来所/メール/FAX/カンファレンス/サービス担当者会議/モニタリング/その他)
const SUPPORT_CATEGORIES = [
  { cat: "モニタリング", content: (n) => `${n}様 ご自宅へモニタリング訪問。サービス利用状況・本人の意向を確認。障害支援区分の有効期間内で計画継続を確認。` },
  { cat: "サービス担当者会議", content: (n) => `${n}様 サービス担当者会議を相談支援事業所主催で開催。本人・家族・ヘルパー・相談員が参加。サービス等利用計画 (案) を共有し、各サービス内容を確認。` },
  { cat: "訪問", content: (n) => `${n}様 ご自宅訪問。家族と面談、最近の様子について情報共有。日中活動の充実について意見交換。` },
  { cat: "電話", content: (n) => `相談支援専門員と電話連絡。${n}様の支給決定内容の更新時期について確認。受給者証の有効期間切れ前にモニタリングを完了する旨を共有。` },
  { cat: "訪問", content: (n) => `${n}様 ご自宅にて再アセスメントを実施。生活状況・支援ニーズに大きな変化なし。サービス内容の継続を確認。` },
];

async function main() {
  console.log(`\n📂 fake 障害福祉 利用者 seed (SH001-SH010)`);
  console.log(`🏢 office = Ｈａｮｱヘルパーステーションおゆみ野 (= 障害福祉も提供想定)`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (実書込)" : "🔍 DRY RUN");
  console.log("");

  const sb = createClient(SB_URL, SB_KEY);

  // ── ヘルパー member_offices からスタッフ取得 (= staff_id 用) ──
  const { data: moRows, error: moErr } = await sb
    .from("member_offices")
    .select("member_id")
    .eq("office_id", HELPER_OFFICE_ID);
  if (moErr) { console.error(`❌ member_offices 取得失敗: ${moErr.message}`); process.exit(1); }
  const memberIds = [...new Set((moRows ?? []).map((r) => r.member_id))];
  let helperStaff = [];
  if (memberIds.length > 0) {
    const { data: members, error: mErr } = await sb
      .from("members")
      .select("id, name")
      .in("id", memberIds)
      .eq("status", "active");
    if (mErr) { console.error(`❌ members 取得失敗: ${mErr.message}`); process.exit(1); }
    helperStaff = members ?? [];
  }
  console.log(`👥 ヘルパースタッフ candidate = ${helperStaff.length} 名`);

  const pickStaff = (seed) => helperStaff.length > 0 ? helperStaff[seed % helperStaff.length] : { id: null, name: "担当ヘルパー" };

  // ── 既存 fake clients が居るかチェック ──
  const userNos = CLIENTS.map((c) => c.user_no);
  const { data: existing, error: exErr } = await sb
    .from("clients")
    .select("user_number")
    .eq("tenant_id", TENANT_ID)
    .in("user_number", userNos);
  if (exErr) { console.error(`❌ 既存チェック失敗: ${exErr.message}`); process.exit(1); }
  const existingNos = new Set((existing ?? []).map((r) => r.user_number));
  const toInsert = CLIENTS.filter((c) => !existingNos.has(c.user_no));
  console.log(`📋 既存 fake clients = ${existingNos.size}、新規 INSERT 対象 = ${toInsert.length}`);

  if (toInsert.length === 0) {
    console.log("✅ 既に全件 seed 済みです");
    return;
  }

  // ─────────────────────────────────────────
  // 集計 plan (dry-run 表示用)
  // ─────────────────────────────────────────
  const plan = {
    clients: toInsert.length,
    client_office_assignments: toInsert.length,
    shougai_certifications: toInsert.length,
    kaigo_emergency_sheets: toInsert.length,
    kaigo_family_contacts: toInsert.length * 3,
    kaigo_visit_patterns: toInsert.length * 3,
    kaigo_visit_records: toInsert.length * 8,
    kaigo_visit_schedule: toInsert.length * 6,
    kaigo_service_records: toInsert.length * 6,
    kaigo_support_records: toInsert.length * 5,
  };
  console.log(`\n📊 生成 plan (1 件 = 1 行):`);
  for (const [k, v] of Object.entries(plan)) console.log(`   ${k.padEnd(30, " ")} ${v}`);
  console.log(`   ${"合計".padEnd(30, " ")} ${Object.values(plan).reduce((a, b) => a + b, 0)}\n`);

  if (!EXECUTE) {
    console.log("🔍 DRY RUN 終了。--execute で本番実行。");
    return;
  }

  // ─────────────────────────────────────────
  // 本番 INSERT
  // ─────────────────────────────────────────
  console.log("🚀 INSERT 開始...");

  for (let idx = 0; idx < toInsert.length; idx++) {
    const c = toInsert[idx];
    const id = randomUUID();
    const primarySvc = c.services[0]; // 主たる支給サービス (= service_type に流用)

    // ① clients (service_category='shougai')
    {
      const { error } = await sb.from("clients").insert({
        id, tenant_id: TENANT_ID,
        user_number: c.user_no, name: c.name, furigana: c.furi,
        birth_date: c.birth, gender: c.gender,
        postal_code: c.postal, address: c.address, phone: c.phone,
        blood_type: c.blood,
        // 介護保険の認定情報は持たないので未設定 (= 障害福祉のみ)
        office_id: HELPER_OFFICE_ID,
        status: "active", is_facility: false, is_provisional: false,
        service_category: "shougai",
      });
      if (error) { console.error(`  ✗ ${c.name} clients: ${error.message}`); continue; }
    }

    // ② client_office_assignments (= 自事業所 filter 必須)
    {
      const { error } = await sb.from("client_office_assignments").insert({
        tenant_id: TENANT_ID,
        client_id: id, office_id: HELPER_OFFICE_ID,
        start_date: ymd(TODAY),
      });
      if (error) console.error(`  ✗ ${c.name} client_office_assignments: ${error.message}`);
    }

    // ③ shougai_certifications (= 障害支援区分 受給者証)
    {
      const { error } = await sb.from("shougai_certifications").insert({
        tenant_id: TENANT_ID, client_id: id,
        support_level: c.support_level,
        primary_disability: c.primary_disability,
        certification_start_date: "2025-04-01",
        certification_end_date: "2028-03-31",
        beneficiary_number: c.beneficiary_no,
        insurer_municipality: "千葉市",
        service_types: c.services,
        copay_rate: 0.1,
        notes: `${c.ailment} ${FAKE_MARKER}`,
      });
      if (error) console.error(`  ✗ ${c.name} shougai_certifications: ${error.message}`);
    }

    // ④ kaigo_emergency_sheets
    {
      const familyFirst = c.name.split(" ")[0];
      const { error } = await sb.from("kaigo_emergency_sheets").insert({
        user_id: id, tenant_id: TENANT_ID,
        blood_type: c.blood, allergies: "なし",
        doctor_name: "山田 医師", doctor_hospital: "千葉市民病院", doctor_phone: "043-261-5111",
        emergency_contact1_name: `${familyFirst} 太郎`, emergency_contact1_relation: "父", emergency_contact1_phone: "090-1000-0001",
        emergency_contact2_name: `${familyFirst} 花子`, emergency_contact2_relation: "母", emergency_contact2_phone: "090-1000-0002",
        medical_history: c.ailment, current_illness: c.ailment,
        care_manager_name: "担当相談支援専門員 (fake)", care_manager_office: "千葉市 相談支援センター (fake)", care_manager_phone: "043-292-9999",
        notes: `${FAKE_MARKER} 緊急時情報`,
      });
      if (error) console.error(`  ✗ ${c.name} kaigo_emergency_sheets: ${error.message}`);
    }

    // ⑤ kaigo_family_contacts × 3
    {
      const familyFirst = c.name.split(" ")[0];
      const familyData = [
        { name: `${familyFirst} 太郎`, rel: "父",   phone: "090-1000-0001", key: true,  notes: "キーパーソン、決定権あり" },
        { name: `${familyFirst} 花子`, rel: "母",   phone: "090-1000-0002", key: false, notes: "日中の連絡先" },
        { name: `${familyFirst} 次郎`, rel: "兄弟", phone: "090-1000-0003", key: false, notes: "緊急時のバックアップ" },
      ];
      for (const f of familyData) {
        const { error } = await sb.from("kaigo_family_contacts").insert({
          user_id: id, tenant_id: TENANT_ID,
          name: f.name, relationship: f.rel, phone: f.phone, is_key_person: f.key,
          notes: `${FAKE_MARKER} ${f.notes}`,
        });
        if (error) console.error(`  ✗ ${c.name} kaigo_family_contacts: ${error.message}`);
      }
    }

    // ⑥ kaigo_visit_patterns × 3 (週次パターン、service_category='shougai')
    {
      const patternDays = [1, 3, 5]; // 月,水,金
      for (let p = 0; p < patternDays.length; p++) {
        const slot = VISIT_TIME_SLOTS[(idx + p) % VISIT_TIME_SLOTS.length];
        const { error } = await sb.from("kaigo_visit_patterns").insert({
          user_id: id, tenant_id: TENANT_ID,
          pattern_name: `${["月","火","水","木","金","土","日"][patternDays[p]]}曜 ${primarySvc}`,
          day_of_week: patternDays[p],
          start_time: slot.s + ":00", end_time: slot.e + ":00",
          staff_id: pickStaff(idx + p).id,
          service_type: primarySvc,
          service_category: "shougai",
          notes: `${FAKE_MARKER}`,
        });
        if (error) console.error(`  ✗ ${c.name} kaigo_visit_patterns: ${error.message}`);
      }
    }

    // ⑦ kaigo_visit_records × 8 (過去 30 日 実績、service_category='shougai')
    for (let v = 0; v < 8; v++) {
      const visDate = addDays(TODAY, -(2 + v * 3));
      const slot = VISIT_TIME_SLOTS[v % VISIT_TIME_SLOTS.length];
      const { error } = await sb.from("kaigo_visit_records").insert({
        user_id: id, tenant_id: TENANT_ID,
        visit_date: ymd(visDate),
        staff_id: pickStaff(idx * 7 + v).id,
        service_type: primarySvc,
        service_category: "shougai",
        start_time: slot.s + ":00", end_time: slot.e + ":00",
        body_care: { 排泄: true, 整容: true, 食事: v % 2 === 0 },
        living_support: { 掃除: v % 2 === 0, 洗濯: v % 3 === 0 },
        user_condition: "落ち着いている",
        vital_temperature: 36.0 + Math.random() * 0.8,
        vital_bp_sys: rnd(110, 140), vital_bp_dia: rnd(65, 85), vital_pulse: rnd(60, 85), vital_spo2: rnd(96, 99),
        notes: `${FAKE_MARKER} 障害福祉 訪問記録`,
        status: "completed",
      });
      if (error) console.error(`  ✗ ${c.name} kaigo_visit_records [${v}]: ${error.message}`);
    }

    // ⑧ kaigo_visit_schedule × 6 (来週分 予定、service_category='shougai')
    for (let s = 0; s < 6; s++) {
      const schDate = addDays(TODAY, 1 + s);
      const slot = VISIT_TIME_SLOTS[s % VISIT_TIME_SLOTS.length];
      const { error } = await sb.from("kaigo_visit_schedule").insert({
        user_id: id, tenant_id: TENANT_ID,
        staff_id: pickStaff(idx * 11 + s).id,
        visit_date: ymd(schDate),
        start_time: slot.s + ":00", end_time: slot.e + ":00",
        service_type: primarySvc,
        service_category: "shougai",
        status: "scheduled",
        notes: `${FAKE_MARKER} 障害福祉 予定`,
      });
      if (error) console.error(`  ✗ ${c.name} kaigo_visit_schedule [${s}]: ${error.message}`);
    }

    // ⑨ kaigo_service_records × 6 (サービス実施記録、service_category='shougai')
    for (let r = 0; r < 6; r++) {
      const recDate = addDays(TODAY, -(3 + r * 4));
      const startH = 9 + (r % 6);
      const startTime = `${String(startH).padStart(2,"0")}:00:00`;
      const endTime = `${String(startH + 1).padStart(2,"0")}:00:00`;
      const st = pickStaff(idx * 7 + r);
      const { error } = await sb.from("kaigo_service_records").insert({
        user_id: id, tenant_id: TENANT_ID,
        service_date: ymd(recDate),
        service_type: primarySvc,
        start_time: startTime, end_time: endTime,
        staff_id: st.id,
        service_category: "shougai",
        content: `${primarySvc} を実施。${c.ailment} に配慮しながら、本人のペースに合わせて支援。${FAKE_MARKER}`,
        notes: `担当: ${st.name} / sample-marker:${SAMPLE_MARKER}`,
      });
      if (error) console.error(`  ✗ ${c.name} kaigo_service_records [${r}]: ${error.message}`);
    }

    // ⑩ kaigo_support_records × 5 (支援経過)
    for (let i = 0; i < SUPPORT_CATEGORIES.length; i++) {
      const recDate = addDays(TODAY, -(i * 14 + 5));
      const recTime = `${10 + (i % 6)}:${i % 2 === 0 ? "00" : "30"}:00`;
      const tpl = SUPPORT_CATEGORIES[i];
      const { error } = await sb.from("kaigo_support_records").insert({
        user_id: id, tenant_id: TENANT_ID,
        record_date: ymd(recDate),
        record_time: recTime,
        category: tpl.cat,
        content: `${tpl.content(c.name)} ${FAKE_MARKER}`,
        staff_name: "担当相談支援専門員 (fake)",
      });
      if (error) console.error(`  ✗ ${c.name} kaigo_support_records [${i}]: ${error.message}`);
    }

    console.log(`  ✓ [${idx + 1}/${toInsert.length}] ${c.name} (${c.user_no}) ${c.support_level} / ${c.primary_disability} / ${primarySvc}`);
  }

  console.log(`\n✅ 全 ${toInsert.length} 名分の seed 完了`);
}

main().catch((e) => { console.error("💥 例外:", e); process.exit(1); });
