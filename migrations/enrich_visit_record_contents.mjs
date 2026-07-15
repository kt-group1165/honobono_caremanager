/**
 * kaigo_visit_records の「記録済みだが中身が空」の行にサンプル内容を充実させる script。
 *
 * 対象: care_record_data に実施内容が無く、バイタル列も notes も空の行 (全 status)。
 * 内容: サービス種別で出し分け
 *   - 身体系 (身体日/身体夜/身体介護): 事前チェック + バイタル + 排泄/水分/食事/整容 等 + 退室確認
 *   - 家事/生活援助系: 生活援助 (調理/掃除/洗濯/買物) + 退室確認
 * UI (visit-records-content.tsx handleSave) と同じ列構成で UPDATE する:
 *   care_record_data (JSONB 全量) + vital_* 列 + user_condition / notes /
 *   progress_notes / handover_notes。status は変更しない。
 *
 * 目印 (= 後で識別/削除しやすく):
 *   care_record_data._sample_marker = 'fake-visit-records-2026-07'
 *   notes 末尾に '[fake テスト用-visit]'
 *
 * Usage:
 *   node migrations/enrich_visit_record_contents.mjs            # DRY RUN
 *   node migrations/enrich_visit_record_contents.mjs --execute  # 本番
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
const env = loadEnvFile(join(__dirname, "..", ".env.local"));
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("❌ env missing"); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY);

const EXECUTE = process.argv.includes("--execute");
const SAMPLE_MARKER = "fake-visit-records-2026-07";
const NOTES_SUFFIX = "[fake テスト用-visit]";

// ── UI の emptyCareData と同形 (visit-records-content.tsx CareData) ──────────
const emptyCareData = () => ({
  pre_check: { complexion: "", condition: "", room_temp: "", humidity: "", notes: "" },
  vitals: { temperature: "", bp_sys: "", bp_dia: "", pulse: "", spo2: "", respiration: "", blood_sugar: "", weight: "", notes: "" },
  excretion: { done: false, urine: false, stool: false, urine_amount: "", stool_amount: "", stool_type: "", independence: "", device: "", notes: "" },
  hydration: { done: false, drink_type: "", amount: "", thickener: "", notes: "" },
  meal: { done: false, staple_amount: "", side_amount: "", meal_form: "", independence: "", notes: "" },
  oral_care: { done: false, denture: "", brushing: false, gargling: false, denture_cleaning: false, mouth_wipe: false, notes: "" },
  bathing: { done: false, bath_type: "", independence: "", skin_condition: "", notes: "" },
  grooming: { done: false, face_wash: false, hair: false, nail: false, ear: false, shaving: false, notes: "" },
  dressing: { done: false, upper: false, lower: false, independence: "", notes: "" },
  positioning: { done: false, position_type: "", mobility_device: "", notes: "" },
  medication: { done: false, med_type: "", confirmed: false, notes: "" },
  outing: { done: false, outing_type: "", transport: "", notes: "" },
  wake_sleep: { done: false, wake_up: false, go_to_bed: false, bed_making: false, notes: "" },
  medical_care: { done: false, suction: false, tube_feeding: false, stoma: false, catheter: false, wound_care: false, oxygen: false, notes: "" },
  independence_support: { done: false, exercise: false, cognitive: false, communication: false, social: false, notes: "" },
  living_support: { cooking: false, cooking_notes: "", cleaning: false, cleaning_notes: "", laundry: false, laundry_notes: "", shopping: false, shopping_notes: "", trash: false, clothing: false, medication_mgmt: false, health_mgmt: false, other_notes: "" },
  exit_check: { fire_check: false, lock_check: false, appliance_check: false, user_condition: "", notes: "" },
  progress_notes: "",
  handover: { priority: "通常", notes: "" },
  detailed_report: "",
  user_condition: "",
  notes: "",
});

// 決定的な擬似乱数 (record id 先頭8桁を seed に。再実行しても同じ値)
function seededRand(seedStr) {
  let h = 0;
  for (const ch of seedStr) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (min, max, step = 1) => {
    h = (h * 1103515245 + 12345) >>> 0;
    const n = Math.floor((h / 2 ** 32) * ((max - min) / step + 1));
    return min + n * step;
  };
}

const CONDITIONS = [
  "落ち着いて過ごされている。表情も穏やか。",
  "体調の訴えなし。会話もはっきりされている。",
  "やや疲れた様子だが食欲はあり。水分摂取を促した。",
  "笑顔が多く体調良好の様子。",
];
const BODY_PROGRESS = [
  "訪問時、居間で過ごされていた。声かけに笑顔で応じられる。排泄介助後、水分補給を促し、居室の環境を整えた。退室時は落ち着いて過ごされていた。",
  "本日は体調の訴えなく経過。トイレ誘導し排泄介助を実施。皮膚トラブルなし。次回訪問時も皮膚状態の観察を継続する。",
  "起床時からしっかり覚醒されており、会話も明瞭。着替えの一部介助と整容を行った。バイタル値は安定している。",
  "居室で臥床されていたが声かけで覚醒。体位変換と褥瘡好発部位の観察を実施、発赤なし。水分摂取を促した。",
];
const NIGHT_PROGRESS = [
  "就寝前の準備を実施。更衣を一部介助し、ベッドへの移乗を見守り。戸締り・消灯を確認して退室。",
  "夕食後の服薬を確認し、就寝準備を介助。特に体調の訴えなし。安眠されるようベッド周りを整えた。",
];
const KAJI_PROGRESS = [
  "居室とトイレの掃除、洗濯物の取り込みと収納を実施。冷蔵庫内の食材を確認し、賞味期限切れの食品を本人と相談のうえ処分した。",
  "昼食の調理 (主菜・副菜) と配膳を実施。合わせて台所の片付けと床の掃き掃除を行った。食欲あり、完食されていた。",
  "買い物代行 (近隣スーパー) と夕食の下ごしらえを実施。日用品の在庫も確認し、不足分をメモにまとめて家族へ申し送り。",
];
const HANDOVERS = [
  "",
  "水分摂取量がやや少なめ。次回訪問時も声かけをお願いします。",
  "",
  "皮膚の乾燥が見られるため保湿クリームを塗布。継続観察をお願いします。",
];

function buildCareData(rec, idx) {
  const rand = seededRand(String(rec.id).slice(0, 8));
  const crd = emptyCareData();
  const st = rec.service_type ?? "";
  const isKaji = /家事|生活/.test(st);
  const isNight = /夜/.test(st);

  crd.pre_check = {
    complexion: "良好",
    condition: "安定",
    room_temp: String(rand(22, 27)),
    humidity: String(rand(45, 60, 5)),
    notes: "",
  };
  crd.user_condition = CONDITIONS[idx % CONDITIONS.length];
  crd.handover = { priority: "通常", notes: HANDOVERS[idx % HANDOVERS.length] };
  crd.exit_check = {
    fire_check: true,
    lock_check: true,
    appliance_check: true,
    user_condition: "落ち着いている",
    notes: "",
  };
  crd.notes = NOTES_SUFFIX;

  if (isKaji) {
    // 生活援助/家事: 調理・掃除・洗濯・買物のローテーション
    const pattern = idx % 3;
    crd.living_support = {
      ...crd.living_support,
      cooking: pattern === 1,
      cooking_notes: pattern === 1 ? "昼食の調理と配膳。減塩を意識した献立。" : "",
      cleaning: true,
      cleaning_notes: "居室・トイレの掃除",
      laundry: pattern === 0,
      laundry_notes: pattern === 0 ? "洗濯・取り込み・収納" : "",
      shopping: pattern === 2,
      shopping_notes: pattern === 2 ? "近隣スーパーで食材・日用品を購入" : "",
      trash: rand(0, 1) === 1,
      health_mgmt: true,
    };
    crd.progress_notes = KAJI_PROGRESS[idx % KAJI_PROGRESS.length];
  } else {
    // 身体介護系: バイタル + 排泄/水分 + (日中=食事・整容 / 夜間=就寝準備)
    crd.vitals = {
      temperature: (36 + rand(2, 8) / 10).toFixed(1),
      bp_sys: String(rand(112, 144, 2)),
      bp_dia: String(rand(64, 86, 2)),
      pulse: String(rand(60, 88, 2)),
      spo2: String(rand(95, 99)),
      respiration: "",
      blood_sugar: "",
      weight: "",
      notes: "",
    };
    crd.excretion = {
      ...crd.excretion,
      done: true,
      urine: true,
      stool: rand(0, 2) === 0,
      urine_amount: "中等量",
      independence: "一部介助",
      device: rand(0, 1) === 1 ? "パッド" : "",
      notes: "",
    };
    crd.hydration = {
      done: true,
      drink_type: rand(0, 1) === 1 ? "お茶" : "水",
      amount: `${rand(100, 200, 50)}ml`,
      thickener: "",
      notes: "",
    };
    if (isNight) {
      crd.wake_sleep = { done: true, wake_up: false, go_to_bed: true, bed_making: true, notes: "就寝準備を介助" };
      crd.dressing = { done: true, upper: true, lower: true, independence: "一部介助", notes: "寝衣へ更衣" };
      crd.progress_notes = NIGHT_PROGRESS[idx % NIGHT_PROGRESS.length];
    } else {
      crd.grooming = { done: true, face_wash: rand(0, 1) === 1, hair: true, nail: false, ear: false, shaving: false, notes: "" };
      if (rand(0, 1) === 1) {
        crd.meal = { done: true, staple_amount: "全量", side_amount: "8割", meal_form: "常食", independence: "見守り", notes: "" };
        crd.oral_care = { ...crd.oral_care, done: true, brushing: true, gargling: true, notes: "" };
      } else {
        crd.positioning = { done: true, position_type: "体位変換", mobility_device: "", notes: "褥瘡好発部位の発赤なし" };
      }
      crd.progress_notes = BODY_PROGRESS[idx % BODY_PROGRESS.length];
    }
  }
  crd._sample_marker = SAMPLE_MARKER;
  return crd;
}

// ── 空判定 (点検 script と同一ロジック) ──────────────────────────────────────
function crdHasContent(crd) {
  if (!crd || typeof crd !== "object") return false;
  for (const v of Object.values(crd)) {
    if (typeof v === "string" && v.trim()) return true;
    if (v && typeof v === "object") {
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 === true) return true;
        if (typeof v2 === "string" && v2.trim() && k2 !== "priority") return true;
      }
    }
  }
  return false;
}

// 1) 全記録を読み、空の行を対象化
const { data: rows, error } = await sb
  .from("kaigo_visit_records")
  .select("id, user_id, visit_date, service_type, status, vital_temperature, vital_bp_sys, vital_pulse, user_condition, notes, care_record_data")
  .order("visit_date")
  .limit(1000);
if (error) { console.error("❌ 取得失敗:", error.message); process.exit(1); }

const targets = rows.filter((r) => {
  const hasVital = r.vital_temperature != null || r.vital_bp_sys != null || r.vital_pulse != null;
  const hasText = !!(r.user_condition || r.notes);
  return !crdHasContent(r.care_record_data) && !hasVital && !hasText;
});

const { data: clients } = await sb
  .from("clients")
  .select("id, name")
  .in("id", [...new Set(targets.map((r) => r.user_id))]);
const nameOf = new Map((clients ?? []).map((c) => [c.id, c.name]));

console.log(`${EXECUTE ? "🔴 EXECUTE" : "🔍 DRY RUN"} — 空の記録 ${targets.length} 件が対象\n`);

let updated = 0;
for (const [idx, rec] of targets.entries()) {
  const crd = buildCareData(rec, idx);
  const label = `${rec.visit_date} ${nameOf.get(rec.user_id) ?? rec.user_id} ${rec.service_type ?? ""}`;
  const summary = /家事|生活/.test(rec.service_type ?? "")
    ? `生活援助 (掃除${crd.living_support.cooking ? "+調理" : ""}${crd.living_support.laundry ? "+洗濯" : ""}${crd.living_support.shopping ? "+買物" : ""})`
    : `バイタル ${crd.vitals.temperature}℃ ${crd.vitals.bp_sys}/${crd.vitals.bp_dia} P${crd.vitals.pulse}` +
      (crd.wake_sleep.done ? " + 就寝準備" : crd.meal.done ? " + 食事/口腔" : " + 体位変換");
  console.log(`  ${label} → ${summary}`);
  if (!EXECUTE) continue;

  const payload = {
    care_record_data: crd,
    vital_temperature: crd.vitals.temperature ? parseFloat(crd.vitals.temperature) : null,
    vital_bp_sys: crd.vitals.bp_sys ? parseInt(crd.vitals.bp_sys) : null,
    vital_bp_dia: crd.vitals.bp_dia ? parseInt(crd.vitals.bp_dia) : null,
    vital_pulse: crd.vitals.pulse ? parseInt(crd.vitals.pulse) : null,
    vital_spo2: crd.vitals.spo2 ? parseInt(crd.vitals.spo2) : null,
    user_condition: crd.user_condition || null,
    handover_notes: crd.handover.notes || null,
    notes: crd.notes || null,
    progress_notes: crd.progress_notes || null,
    updated_at: new Date().toISOString(),
  };
  const { error: upErr } = await sb.from("kaigo_visit_records").update(payload).eq("id", rec.id);
  if (upErr) {
    console.error(`  ❌ UPDATE 失敗 (${label}):`, upErr.message);
    process.exit(1);
  }
  updated++;
}

if (EXECUTE) {
  // 件数確認 (実際に marker が入ったか)
  const { count, error: cntErr } = await sb
    .from("kaigo_visit_records")
    .select("id", { count: "exact", head: true })
    .eq("care_record_data->>_sample_marker", SAMPLE_MARKER);
  if (cntErr) {
    console.error("❌ 検証クエリ失敗:", cntErr.message);
    process.exit(1);
  }
  console.log(`\n✅ ${updated} 件 UPDATE / marker 検証 ${count} 件 (${SAMPLE_MARKER})`);
  if (count !== updated) {
    console.error("⚠️ UPDATE 件数と marker 件数が不一致 — 要確認");
    process.exit(2);
  }
} else {
  console.log(`\nDRY RUN 終了 (書込なし)。--execute で実行`);
}
