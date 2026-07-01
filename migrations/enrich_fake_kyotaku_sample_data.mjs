/**
 * 居宅介護支援 fake 利用者 51 名 (A001〜E010 + X001) の欠けているデータを補強する。
 *
 * 前提: seed_fake_kyotaku_clients.mjs で clients と kaigo_care_plans / assessments /
 *       monitoring_sheets / report_documents は入っている。
 *       ただし以下は全員空:
 *   ①  clients.address / phone / postal_code   ... UPDATE で追加
 *   ②  client_office_assignments (junction、tenant_id NOT NULL) ... INSERT
 *   ③  client_insurance_records (認定情報)           ... INSERT (既存無ければ)
 *   ④  kaigo_medical_history (病歴 × 2)               ... INSERT (既存無ければ)
 *   ⑤  kaigo_medical_insurance (医療保険)             ... INSERT (既存無ければ)
 *   ⑥  kaigo_family_contacts (家族連絡先 × 3)         ... INSERT (既存無ければ)
 *   ⑦  kaigo_emergency_sheets (緊急時シート)          ... INSERT (既存無ければ)
 *   ⑧  kaigo_adl_records (ADL 評価)                    ... INSERT (既存無ければ)
 *   ⑨  kaigo_health_records (バイタル × 6)             ... INSERT (既存無ければ)
 *   ⑩  kaigo_support_records (支援経過 × 7)            ... INSERT (既存無ければ)
 *
 * 対象 office:
 *   Ｈａｮｱ居宅支援センターおゆみ野 (id = 1b22d425-2ec4-4c2f-a002-c1c994e94507)
 *   → clients.office_id は既に set 済 (seed 時)。junction は新規追加。
 *
 * 目印:
 *   notes 末尾に '[fake テスト用-kyotaku-enrich]'
 *   form_data._sample_marker = 'fake-kyotaku-enrich-2026-07'
 *
 * Usage:
 *   node migrations/enrich_fake_kyotaku_sample_data.mjs              # DRY RUN
 *   node migrations/enrich_fake_kyotaku_sample_data.mjs --execute    # 本番
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
  } catch { return {}; }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL = envKaigo.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envKaigo.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("❌ env 読めず"); process.exit(1); }

const TENANT_ID = "kt-group";
const KYOTAKU_OFFICE_ID = "1b22d425-2ec4-4c2f-a002-c1c994e94507";
const SAMPLE_MARKER = "fake-kyotaku-enrich-2026-07";
const NOTES_SUFFIX = "[fake テスト用-kyotaku-enrich]";
const INSURER_NUMBER = "122192";
const EXECUTE = process.argv.includes("--execute");

// ── ダミー住所 pool (千葉市内、居宅おゆみ野の担当エリア想定) ──
// 51 件分、被らないように町丁を分散
const ADDRESS_POOL = [
  { postal: "266-0031", town: "千葉県千葉市緑区おゆみ野" },
  { postal: "266-0032", town: "千葉県千葉市緑区おゆみ野中央" },
  { postal: "266-0033", town: "千葉県千葉市緑区おゆみ野南" },
  { postal: "266-0034", town: "千葉県千葉市緑区おゆみ野有吉" },
  { postal: "266-0035", town: "千葉県千葉市緑区おゆみ野の郷" },
  { postal: "266-0006", town: "千葉県千葉市緑区おゆみ野" },
  { postal: "266-0007", town: "千葉県千葉市緑区おゆみ野南" },
  { postal: "266-0011", town: "千葉県千葉市緑区鎌取町" },
  { postal: "266-0014", town: "千葉県千葉市緑区誉田町" },
  { postal: "266-0015", town: "千葉県千葉市緑区誉田町" },
  { postal: "260-0813", town: "千葉県千葉市中央区生実町" },
  { postal: "260-0824", town: "千葉県千葉市中央区浜野町" },
];

// 電話: 043-XXX-YYYY の千葉市局番風
function makePhone(seed) {
  const mid = 200 + (seed * 7) % 800;
  const last = 1000 + (seed * 13) % 8999;
  return `043-${mid}-${last}`;
}

function makeAddress(seed) {
  const p = ADDRESS_POOL[seed % ADDRESS_POOL.length];
  const banchi = (seed % 30) + 1;
  const goh = ((seed * 3) % 20) + 1;
  return { postal: p.postal, address: `${p.town}${banchi}-${goh}` };
}

// 病歴 テンプレ (care_level に応じて厚みを変える)
function pickMedicalHistory(careLevel, ailment) {
  const base = [
    { disease: ailment, status: "治療中", onset: "2023-04-01", hospital: "千葉市民病院" },
    { disease: "高血圧", status: "治療中", onset: "2020-01-01", hospital: "千葉市民病院" },
  ];
  return base;
}

// care_level から主病を推定 (index に応じてバラつく)
const AILMENTS = ["高血圧", "糖尿病", "脳梗塞後遺症", "膝関節症", "認知症", "心房細動", "パーキンソン病", "COPD", "リウマチ", "腰椎症"];
function pickAilment(idx) { return AILMENTS[idx % AILMENTS.length]; }

// 支援経過 テンプレ (居宅ケアマネ視点)
// CHECK 制約: '電話', '訪問', '来所', 'メール', 'FAX', 'カンファレンス', 'サービス担当者会議', 'モニタリング', 'その他'
const SUPPORT_TEMPLATES = [
  { cat: "モニタリング", content: (n) => `${n}様 ご自宅へモニタリング訪問。ケアプランの実施状況を確認。本人より現サービスへの満足の声あり。継続の意向を確認。` },
  { cat: "訪問", content: (n) => `${n}様 ご自宅を訪問。ご家族と面談し、最近の様子を情報共有。次月のサービス調整について検討。` },
  { cat: "電話", content: (n) => `主治医と電話連絡。${n}様の最近の体調について情報共有。処方変更なしを確認。` },
  { cat: "サービス担当者会議", content: (n) => `${n}様 サービス担当者会議をご自宅にて開催。家族、ヘルパー、訪問看護師、本人参加。ケアプラン (案) を共有し合意形成。` },
  { cat: "来所", content: (n) => `${n}様 ご家族が来所。今後のサービス利用について相談を受ける。ショートステイの利用可能性について情報提供。` },
  { cat: "電話", content: (n) => `${n}様 ご家族から電話あり。週末訪問予定の連絡と本人の最近の様子について情報交換。` },
  { cat: "訪問", content: (n) => `${n}様 ご自宅にて再アセスメントを実施。ADL に大きな変化なし。ケアプランの更新に反映予定。` },
];

// ── ページング fetch ──
async function fetchAll(sb, table, select, filters = {}) {
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + 999);
    for (const [k, v] of Object.entries(filters)) {
      if (Array.isArray(v)) q = q.in(k, v); else q = q.eq(k, v);
    }
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

const TODAY = new Date();
function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }
function ymd(d) { return d.toISOString().slice(0, 10); }
function rnd(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

async function main() {
  console.log(`\n📂 fake 居宅利用者 enrich (A001-E010 + X001)`);
  console.log(`🏪 office = Ｈａｮｱ居宅支援センターおゆみ野 (${KYOTAKU_OFFICE_ID})`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (実書込)" : "🔍 DRY RUN");
  console.log("");

  const sb = createClient(SB_URL, SB_KEY);

  // ── 対象 clients 取得 (business_type='居宅介護支援' + user_number pattern) ──
  // 居宅 seed は clients.office_id=KYOTAKU_OFFICE_ID で入っているはず。
  // 保険的に office_id と user_number 両方でも絞れるよう pattern check する。
  const { data: allClients, error: cliErr } = await sb
    .from("clients")
    .select("id, user_number, name, care_level, office_id, address, phone, postal_code")
    .eq("tenant_id", TENANT_ID)
    .eq("office_id", KYOTAKU_OFFICE_ID);
  if (cliErr) { console.error("❌ clients 取得:", cliErr.message); process.exit(1); }

  // A/B/C/D/E/X で始まるものだけ
  const targets = (allClients ?? []).filter((c) => /^[ABCDEX]\d{3}$/.test(c.user_number ?? ""));
  console.log(`👤 対象 clients = ${targets.length} 名`);
  if (targets.length === 0) {
    console.warn("⚠️  対象 clients 0 件。seed_fake_kyotaku_clients.mjs 実行済かを確認。");
    return;
  }

  const clientIds = targets.map((c) => c.id);

  // ── 既存 child row check (idempotent 化) ──
  const [
    caoExisting,
    insExisting,
    medHisExisting,
    medInsExisting,
    famExisting,
    emgExisting,
    adlExisting,
    healthExisting,
    supExisting,
  ] = await Promise.all([
    fetchAll(sb, "client_office_assignments", "client_id, office_id", { client_id: clientIds, office_id: KYOTAKU_OFFICE_ID }),
    fetchAll(sb, "client_insurance_records", "client_id", { client_id: clientIds }),
    fetchAll(sb, "kaigo_medical_history", "user_id", { user_id: clientIds }),
    fetchAll(sb, "kaigo_medical_insurance", "user_id", { user_id: clientIds }),
    fetchAll(sb, "kaigo_family_contacts", "user_id", { user_id: clientIds }),
    fetchAll(sb, "kaigo_emergency_sheets", "user_id", { user_id: clientIds }),
    fetchAll(sb, "kaigo_adl_records", "user_id", { user_id: clientIds }),
    fetchAll(sb, "kaigo_health_records", "user_id", { user_id: clientIds }),
    fetchAll(sb, "kaigo_support_records", "user_id", { user_id: clientIds }),
  ]);

  const setCao = new Set(caoExisting.map((r) => `${r.client_id}:${r.office_id}`));
  const setIns = new Set(insExisting.map((r) => r.client_id));
  const setMedHis = new Set(medHisExisting.map((r) => r.user_id));
  const setMedIns = new Set(medInsExisting.map((r) => r.user_id));
  const setFam = new Set(famExisting.map((r) => r.user_id));
  const setEmg = new Set(emgExisting.map((r) => r.user_id));
  const setAdl = new Set(adlExisting.map((r) => r.user_id));
  const setHealth = new Set(healthExisting.map((r) => r.user_id));
  const setSup = new Set(supExisting.map((r) => r.user_id));

  // 住所 UPDATE 対象 (empty のもののみ)
  const needAddrUpdate = targets.filter((c) => !c.address || !c.phone || !c.postal_code);

  const plan = {
    "clients UPDATE (address/phone/postal)": needAddrUpdate.length,
    "client_office_assignments INSERT":       targets.filter((c) => !setCao.has(`${c.id}:${KYOTAKU_OFFICE_ID}`)).length,
    "client_insurance_records INSERT":        targets.filter((c) => !setIns.has(c.id)).length,
    "kaigo_medical_history INSERT (×2)":       targets.filter((c) => !setMedHis.has(c.id)).length * 2,
    "kaigo_medical_insurance INSERT":         targets.filter((c) => !setMedIns.has(c.id)).length,
    "kaigo_family_contacts INSERT (×3)":       targets.filter((c) => !setFam.has(c.id)).length * 3,
    "kaigo_emergency_sheets INSERT":          targets.filter((c) => !setEmg.has(c.id)).length,
    "kaigo_adl_records INSERT":                targets.filter((c) => !setAdl.has(c.id)).length,
    "kaigo_health_records INSERT (×6)":        targets.filter((c) => !setHealth.has(c.id)).length * 6,
    "kaigo_support_records INSERT (×7)":       targets.filter((c) => !setSup.has(c.id)).length * 7,
  };
  console.log(`\n📊 生成 plan:`);
  for (const [k, v] of Object.entries(plan)) console.log(`   ${k.padEnd(45, " ")} ${v}`);
  console.log(`   ${"合計".padEnd(45, " ")} ${Object.values(plan).reduce((a, b) => a + b, 0)}\n`);

  if (!EXECUTE) {
    console.log("🔍 DRY RUN 終了。--execute で本番実行。");
    return;
  }

  // ─────────────────────────────────────────
  // 実書込
  // ─────────────────────────────────────────
  console.log("🚀 INSERT/UPDATE 開始...\n");

  let addrUp = 0, caoIn = 0, insIn = 0, mhIn = 0, miIn = 0, famIn = 0, emgIn = 0, adlIn = 0, hIn = 0, sIn = 0;
  let addrFail = 0, caoFail = 0, insFail = 0, mhFail = 0, miFail = 0, famFail = 0, emgFail = 0, adlFail = 0, hFail = 0, sFail = 0;

  for (let idx = 0; idx < targets.length; idx++) {
    const c = targets[idx];
    const ailment = pickAilment(idx);

    // 生年月日を取得したいので追加 fetch (対象少ないので個別 fetch でよい)
    const { data: cliFull } = await sb
      .from("clients")
      .select("birth_date, insured_number, care_level")
      .eq("id", c.id)
      .maybeSingle();
    const birth = cliFull?.birth_date ?? "1940-01-01";
    const insured = cliFull?.insured_number ?? "0000000000";
    const careLevel = cliFull?.care_level ?? "要介護1";
    const seed = idx + 1;

    // ─── ① clients UPDATE (住所系) ────────────
    if (!c.address || !c.phone || !c.postal_code) {
      const addr = makeAddress(seed);
      const phone = makePhone(seed);
      const { error } = await sb.from("clients").update({
        address: addr.address,
        postal_code: addr.postal,
        phone: phone,
      }).eq("id", c.id).select("id");
      if (error) { addrFail++; console.warn(`  ✗ ${c.user_number} address update: ${error.message}`); }
      else addrUp++;
    }

    // ─── ② client_office_assignments INSERT ────
    if (!setCao.has(`${c.id}:${KYOTAKU_OFFICE_ID}`)) {
      const { error } = await sb.from("client_office_assignments").insert({
        tenant_id: TENANT_ID,
        client_id: c.id,
        office_id: KYOTAKU_OFFICE_ID,
        start_date: "2025-04-01",
      }).select("client_id");
      if (error) { caoFail++; console.warn(`  ✗ ${c.user_number} cao: ${error.message}`); }
      else caoIn++;
    }

    // ─── ③ client_insurance_records INSERT ────
    if (!setIns.has(c.id)) {
      const { error } = await sb.from("client_insurance_records").insert({
        tenant_id: TENANT_ID,
        client_id: c.id,
        effective_date: "2025-04-01",
        insured_number: insured,
        insurer_number: INSURER_NUMBER,
        birth_date: birth,
        care_level: careLevel,
        certification_start_date: "2025-04-01",
        certification_end_date: "2027-03-31",
        copay_rate: "1",
        benefit_rate: "9",
        insurer_name: "千葉市",
        care_manager_org: "Ｈａｮｱ居宅支援センターおゆみ野",
        notes: `${NOTES_SUFFIX} 認定情報`,
      }).select("client_id");
      if (error) { insFail++; console.warn(`  ✗ ${c.user_number} insurance: ${error.message}`); }
      else insIn++;
    }

    // ─── ④ kaigo_medical_history INSERT × 2 ────
    if (!setMedHis.has(c.id)) {
      const rows = pickMedicalHistory(careLevel, ailment).map((m) => ({
        user_id: c.id, tenant_id: TENANT_ID,
        disease_name: m.disease, status: m.status,
        onset_date: m.onset, hospital: m.hospital, doctor: "山田 医師",
        notes: NOTES_SUFFIX,
      }));
      const { error } = await sb.from("kaigo_medical_history").insert(rows).select("user_id");
      if (error) { mhFail++; console.warn(`  ✗ ${c.user_number} medical_history: ${error.message}`); }
      else mhIn += rows.length;
    }

    // ─── ⑤ kaigo_medical_insurance INSERT ────
    if (!setMedIns.has(c.id)) {
      const { error } = await sb.from("kaigo_medical_insurance").insert({
        user_id: c.id, tenant_id: TENANT_ID,
        insurance_type: "後期高齢者医療",
        insurer_number: "39" + INSURER_NUMBER,
        insured_number: insured.slice(-8),
        start_date: "2024-04-01",
        end_date: "2027-03-31",
        copay_rate: 1.0,
      }).select("user_id");
      if (error) { miFail++; console.warn(`  ✗ ${c.user_number} medical_insurance: ${error.message}`); }
      else miIn++;
    }

    // ─── ⑥ kaigo_family_contacts INSERT × 3 ────
    if (!setFam.has(c.id)) {
      const surname = (c.name ?? "").split(" ")[0] || "家族";
      const familyRows = [
        { name: `${surname} 太郎`, rel: "長男", phone: `090-${1000 + seed}-${2000 + seed}`, key: true,  notes: "キーパーソン、決定権あり" },
        { name: `${surname} 花子`, rel: "長女", phone: `090-${1100 + seed}-${2100 + seed}`, key: false, notes: "週末に訪問" },
        { name: `${surname} 次郎`, rel: "次男", phone: `090-${1200 + seed}-${2200 + seed}`, key: false, notes: "遠方在住" },
      ].map((f) => ({
        user_id: c.id, tenant_id: TENANT_ID,
        name: f.name, relationship: f.rel, phone: f.phone, is_key_person: f.key,
        notes: `${NOTES_SUFFIX} ${f.notes}`,
      }));
      const { error } = await sb.from("kaigo_family_contacts").insert(familyRows).select("user_id");
      if (error) { famFail++; console.warn(`  ✗ ${c.user_number} family: ${error.message}`); }
      else famIn += familyRows.length;
    }

    // ─── ⑦ kaigo_emergency_sheets INSERT ────
    if (!setEmg.has(c.id)) {
      const surname = (c.name ?? "").split(" ")[0] || "家族";
      const bloodTypes = ["A", "O", "B", "AB"];
      const { error } = await sb.from("kaigo_emergency_sheets").insert({
        user_id: c.id, tenant_id: TENANT_ID,
        blood_type: bloodTypes[idx % 4],
        allergies: "なし",
        doctor_name: "山田 医師",
        doctor_hospital: "千葉市民病院",
        doctor_phone: "043-261-5111",
        emergency_contact1_name: `${surname} 太郎`,
        emergency_contact1_relation: "長男",
        emergency_contact1_phone: `090-${1000 + seed}-${2000 + seed}`,
        emergency_contact2_name: `${surname} 花子`,
        emergency_contact2_relation: "長女",
        emergency_contact2_phone: `090-${1100 + seed}-${2100 + seed}`,
        medical_history: ailment,
        current_illness: ailment,
        care_manager_name: "担当ケアマネ (fake)",
        care_manager_office: "Ｈａｮｱ居宅支援センターおゆみ野",
        care_manager_phone: "043-292-9999",
        notes: `${NOTES_SUFFIX} 緊急時情報`,
      }).select("user_id");
      if (error) { emgFail++; console.warn(`  ✗ ${c.user_number} emergency: ${error.message}`); }
      else emgIn++;
    }

    // ─── ⑧ kaigo_adl_records INSERT ────
    if (!setAdl.has(c.id)) {
      const baseAdl =
        careLevel.includes("要介護5") ? 1 :
        careLevel.includes("要介護4") ? 2 :
        careLevel.includes("要介護3") ? 3 :
        careLevel.includes("要介護2") ? 4 : 5;
      const { error } = await sb.from("kaigo_adl_records").insert({
        user_id: c.id, tenant_id: TENANT_ID,
        assessment_date: ymd(addDays(TODAY, -30)),
        eating: baseAdl, transfer: baseAdl, grooming: baseAdl,
        toilet: baseAdl, bathing: Math.max(1, baseAdl - 1),
        mobility: baseAdl, stairs: Math.max(1, baseAdl - 2),
        dressing: baseAdl, bowel: baseAdl, bladder: baseAdl,
        total_score: baseAdl * 9 + Math.max(1, baseAdl - 1) + Math.max(1, baseAdl - 2),
        assessor_name: "担当ケアマネ (fake)",
        notes: NOTES_SUFFIX,
      }).select("user_id");
      if (error) { adlFail++; console.warn(`  ✗ ${c.user_number} adl: ${error.message}`); }
      else adlIn++;
    }

    // ─── ⑨ kaigo_health_records INSERT × 6 (バイタル、過去 30 日) ────
    if (!setHealth.has(c.id)) {
      const rows = [];
      for (let h = 0; h < 6; h++) {
        const recDate = addDays(TODAY, -(5 + h * 5));
        rows.push({
          user_id: c.id, tenant_id: TENANT_ID,
          record_date: ymd(recDate),
          temperature: Number((36.0 + Math.random() * 1.2).toFixed(1)),
          blood_pressure_sys: rnd(120, 160),
          blood_pressure_dia: rnd(70, 90),
          pulse: rnd(60, 90),
          spo2: rnd(94, 99),
          notes: `${NOTES_SUFFIX} バイタル測定`,
          recorder_name: "担当ケアマネ (fake)",
        });
      }
      const { error } = await sb.from("kaigo_health_records").insert(rows).select("user_id");
      if (error) { hFail++; console.warn(`  ✗ ${c.user_number} health: ${error.message}`); }
      else hIn += rows.length;
    }

    // ─── ⑩ kaigo_support_records INSERT × 7 ────
    if (!setSup.has(c.id)) {
      const rows = [];
      for (let i = 0; i < SUPPORT_TEMPLATES.length; i++) {
        const recDate = addDays(TODAY, -(i * 12 + 5));
        const recTime = `${10 + (i % 6)}:${i % 2 === 0 ? "00" : "30"}:00`;
        const tpl = SUPPORT_TEMPLATES[i];
        rows.push({
          user_id: c.id, tenant_id: TENANT_ID,
          record_date: ymd(recDate),
          record_time: recTime,
          category: tpl.cat,
          content: `${tpl.content(c.name)} ${NOTES_SUFFIX}`,
          staff_name: "担当ケアマネ (fake)",
        });
      }
      const { error } = await sb.from("kaigo_support_records").insert(rows).select("user_id");
      if (error) { sFail++; console.warn(`  ✗ ${c.user_number} support: ${error.message}`); }
      else sIn += rows.length;
    }

    if ((idx + 1) % 10 === 0 || idx === targets.length - 1) {
      console.log(`  ✓ [${idx + 1}/${targets.length}] ${c.name} (${c.user_number}) まで完了`);
    }
  }

  console.log(`\n📊 実行結果:`);
  console.log(`   clients UPDATE (address/phone/postal): ${addrUp} 成功 / ${addrFail} 失敗`);
  console.log(`   client_office_assignments INSERT:      ${caoIn} / ${caoFail}`);
  console.log(`   client_insurance_records INSERT:       ${insIn} / ${insFail}`);
  console.log(`   kaigo_medical_history INSERT:          ${mhIn} / ${mhFail}`);
  console.log(`   kaigo_medical_insurance INSERT:        ${miIn} / ${miFail}`);
  console.log(`   kaigo_family_contacts INSERT:          ${famIn} / ${famFail}`);
  console.log(`   kaigo_emergency_sheets INSERT:         ${emgIn} / ${emgFail}`);
  console.log(`   kaigo_adl_records INSERT:              ${adlIn} / ${adlFail}`);
  console.log(`   kaigo_health_records INSERT:           ${hIn} / ${hFail}`);
  console.log(`   kaigo_support_records INSERT:          ${sIn} / ${sFail}`);
  console.log(`\n✅ 完了`);
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
