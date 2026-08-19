/**
 * 訪問介護計画書 sample seed
 *
 * 対象: Ｈａｮｱヘルパーステーションおゆみ野 (= 訪問介護 office) の OY001-OY010 利用者
 *
 * 各利用者に 1 件の plan (= draft) を INSERT。
 *   - サービス内容は ailment (= 主病) から適切に生成
 *   - 長期目標 / 短期目標 (goals[]) も主病に合わせる
 *   - schema は v2 (goals[] / weekly_services[])。migrations/applied_archive/houmon_care_plans_v2.sql 適用済が前提
 *   - 識別マーカー: weekly_services[*]._sample_marker = "fake-houmon-plan-2026-06"
 *                  special_notes 末尾に "[fake テスト用-houmon-plan]"
 *
 * Usage:
 *   node migrations/seed_fake_houmon_care_plans.mjs              # DRY RUN
 *   node migrations/seed_fake_houmon_care_plans.mjs --execute    # 本番
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
const HELPER_OFFICE_ID = "4f14d50c-76b5-4f44-ac41-ed6d01f53a30"; // Ｈａｮｱヘルパーステーションおゆみ野
const SAMPLE_MARKER = "fake-houmon-plan-2026-06";
const NOTES_SUFFIX = "[fake テスト用-houmon-plan]";

const EXECUTE = process.argv.includes("--execute");

// テンプレートの旧形式 { kind, frequency, time_range, content } を
// v2 の weekly_services 行 { days[], start_time, end_time, service_kind, content, notes } へ変換
const DAY_MAP = { 月: "mon", 火: "tue", 水: "wed", 木: "thu", 金: "fri", 土: "sat", 日: "sun" };
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function toWeeklyService(s) {
  const freq = s.frequency ?? "";
  let days = [];
  if (/平日/.test(freq)) {
    days = ["mon", "tue", "wed", "thu", "fri"];
  } else if (/毎日|週7/.test(freq)) {
    days = [...DAY_ORDER];
  } else {
    // "(月・水・金)" のような括弧内の曜日を拾う
    const inParen = /[（(]([^）)]*)[）)]/.exec(freq);
    const src = inParen ? inParen[1] : freq;
    const picked = new Set();
    for (const ch of src) if (DAY_MAP[ch]) picked.add(DAY_MAP[ch]);
    days = DAY_ORDER.filter((d) => picked.has(d));
  }
  // "10:00-10:45" → 開始/終了 (0 埋めして HH:MM に揃える)
  const pad = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    return m ? `${String(m[1]).padStart(2, "0")}:${m[2]}` : "";
  };
  const [rawStart = "", rawEnd = ""] = (s.time_range ?? "").split("-");
  return {
    days,
    start_time: pad(rawStart),
    end_time: pad(rawEnd),
    service_kind: s.kind ?? "",
    content: s.content ?? "",
    notes: days.length === 0 && freq ? freq : "",
  };
}

// ── ailment → サービス内容 + 目標 テンプレート ──
const PLAN_TEMPLATES = {
  "高血圧": {
    long_term_goal: "自宅での生活を継続し、血圧管理を安定させ、社会的孤立を防ぐ。",
    short_term_goal: "週3回の身体介護で清潔保持と健康観察を行い、家族の介護負担を軽減する。",
    user_situation: "高血圧の管理が課題。ADL は概ね自立しているが、入浴は一部介助が必要。",
    family_situation: "長男夫婦と同居。日中は独居状態。家族は安全と健康管理を重視している。",
    services: [
      { kind: "身体2", frequency: "週3回 (月・水・金)", time_range: "10:00-10:45", content: "入浴介助、洗髪、更衣介助、バイタル測定" },
      { kind: "生活2", frequency: "週2回 (火・木)", time_range: "13:00-13:45", content: "居室掃除、洗濯物干し・取込、ゴミ出し" },
    ],
    special_notes: "血圧 150 を超えた場合は訪問看護師と家族へ連絡。塩分制限の食事に配慮。",
  },
  "糖尿病": {
    long_term_goal: "妻と二人暮らしを継続できるよう、糖尿病の自己管理を支援する。",
    short_term_goal: "服薬・インスリン注射の確認と食事準備の援助を通じて HbA1c 7% 台を維持する。",
    user_situation: "HbA1c 7.2%。インスリン自己注射中。神経障害により足のしびれあり。",
    family_situation: "妻と二人暮らし。妻も高齢で軽度の介護を要する。長男は遠方。",
    services: [
      { kind: "身体1生活2", frequency: "週4回 (月・水・金・土)", time_range: "11:30-12:30", content: "服薬確認、インスリン注射見守り、昼食準備、食事介助" },
      { kind: "生活2", frequency: "週2回 (火・木)", time_range: "10:00-10:45", content: "居室掃除、買い物代行 (糖質制限品目)" },
    ],
    special_notes: "低血糖症状 (冷汗・震え) を確認時は速やかにブドウ糖を摂取させる。妻の体調にも目配り。",
  },
  "脳梗塞後遺症": {
    long_term_goal: "リハビリを継続し、現状の ADL を維持して在宅生活を継続する。",
    short_term_goal: "週5回の身体介護で清潔・排泄を確保し、家族介護者の負担を軽減する。",
    user_situation: "右片麻痺、軽度言語障害あり。車椅子使用。トイレ移乗に介助必要。",
    family_situation: "長女夫婦と同居。長女は介護のため離職した経緯あり。",
    services: [
      { kind: "身体3", frequency: "週5回 (平日)", time_range: "9:00-10:15", content: "排泄介助、清拭、更衣、移乗介助、口腔ケア" },
      { kind: "身体1生活1", frequency: "週2回 (火・金)", time_range: "14:00-14:45", content: "入浴介助、洗濯" },
    ],
    special_notes: "再発予防のため血圧管理を徹底。意識レベル変化時は救急要請。",
  },
  "膝関節症": {
    long_term_goal: "膝の負担を軽減しつつ、自宅内 ADL を維持する。",
    short_term_goal: "入浴と居室掃除の支援で生活環境を整え、転倒を予防する。",
    user_situation: "両膝変形性関節症。歩行時に痛みあり。階段昇降は介助必要。",
    family_situation: "妻と二人暮らし。長男は近県在住で週末訪問。",
    services: [
      { kind: "身体2", frequency: "週2回 (火・金)", time_range: "14:00-14:45", content: "入浴介助、足浴、更衣介助" },
      { kind: "生活2", frequency: "週2回 (月・木)", time_range: "10:00-10:45", content: "居室掃除、シーツ交換" },
    ],
    special_notes: "浴室の段差に注意。手すり使用を励行。",
  },
  "認知症": {
    long_term_goal: "本人の安全を確保しつつ、住み慣れた自宅での生活を可能な限り継続する。",
    short_term_goal: "定時訪問で安否確認と服薬管理を行い、家族介護者のレスパイトを確保する。",
    user_situation: "アルツハイマー型認知症 中等度。HDS-R 12点。短期記憶障害顕著。徘徊リスクあり。",
    family_situation: "長男が同居。日中は長男が出勤するため独居になる時間が長い。",
    services: [
      { kind: "身体2", frequency: "週5回 (平日)", time_range: "9:00-9:45", content: "起床介助、整容、服薬確認、朝食準備" },
      { kind: "生活2", frequency: "週3回 (月・水・金)", time_range: "15:00-15:45", content: "居室掃除、洗濯、夕食準備の下ごしらえ" },
    ],
    special_notes: "BPSD 増悪時は無理に止めず、安全確保のうえ家族へ連絡。GPS 携帯の確認を励行。",
  },
  "心房細動": {
    long_term_goal: "心房細動の継続管理と転倒予防により、自宅生活を継続する。",
    short_term_goal: "週3回の身体介護で清潔保持と服薬管理を確実に行う。",
    user_situation: "心房細動で抗凝固療法中。出血傾向に注意。動悸時に活動制限あり。",
    family_situation: "独居。長女が週1回訪問。",
    services: [
      { kind: "身体2", frequency: "週3回 (月・水・金)", time_range: "10:00-10:45", content: "入浴介助、更衣、服薬確認、バイタル測定" },
      { kind: "生活2", frequency: "週2回 (火・金)", time_range: "13:00-13:45", content: "居室掃除、買い物代行" },
    ],
    special_notes: "あざ・出血を発見した場合は主治医へ報告。動悸出現時は安静を促す。",
  },
  "パーキンソン病": {
    long_term_goal: "嚥下機能と歩行機能を維持し、家族との在宅生活を継続する。",
    short_term_goal: "服薬管理と食事援助を通じて栄養状態を維持し、誤嚥を防ぐ。",
    user_situation: "Yahr 3。固縮・無動あり。歩行はすり足。嚥下機能低下傾向。",
    family_situation: "次女夫婦と同居。次女が主介護者。",
    services: [
      { kind: "身体1生活1", frequency: "週5回 (平日)", time_range: "12:00-12:45", content: "服薬確認、昼食準備、食事介助、口腔ケア" },
      { kind: "身体2", frequency: "週2回 (火・金)", time_range: "14:00-14:45", content: "入浴介助、整容、更衣" },
    ],
    special_notes: "On-Off 現象に留意。食事中はとろみ剤を使用。",
  },
  "COPD": {
    long_term_goal: "在宅酸素療法を継続しながら、自宅生活を維持する。",
    short_term_goal: "呼吸状態を観察しつつ、清潔保持と環境整備を行う。",
    user_situation: "COPD 重度。在宅酸素 1L/分 24時間。労作時息切れ著明。",
    family_situation: "長男と二人暮らし。長男は日中勤務。",
    services: [
      { kind: "身体2", frequency: "週3回 (月・水・金)", time_range: "10:30-11:15", content: "清拭、洗髪、更衣、バイタル測定、SpO2 確認" },
      { kind: "生活2", frequency: "週2回 (火・木)", time_range: "13:00-13:45", content: "居室掃除、加湿器の管理" },
    ],
    special_notes: "SpO2 90% 未満の場合は安静を促し、家族へ連絡。酸素チューブの取り回しに注意。",
  },
  "リウマチ": {
    long_term_goal: "関節保護を意識した生活で痛みをコントロールし、在宅生活を継続する。",
    short_term_goal: "週3回の入浴介助で清潔を保ち、関節を温めて疼痛を軽減する。",
    user_situation: "関節リウマチ罹病歴 20 年。手指の変形・拘縮あり。朝のこわばり強い。",
    family_situation: "夫と二人暮らし。夫も高齢。",
    services: [
      { kind: "身体2", frequency: "週3回 (月・水・金)", time_range: "11:00-11:45", content: "入浴介助、更衣、温罨法、関節可動域訓練の声かけ" },
      { kind: "生活2", frequency: "週2回 (火・木)", time_range: "14:00-14:45", content: "居室掃除、洗濯、買い物代行" },
    ],
    special_notes: "関節保護のため重い物を持たせない。痛みの増悪時は主治医へ報告。",
  },
  "腰椎症": {
    long_term_goal: "腰椎症の悪化を予防しつつ、自宅 ADL を維持する。",
    short_term_goal: "入浴と家事援助で生活負担を軽減し、転倒を予防する。",
    user_situation: "腰椎管狭窄症。歩行時に下肢のしびれあり。長距離歩行困難。",
    family_situation: "妻と二人暮らし。子どもは独立。",
    services: [
      { kind: "身体2", frequency: "週2回 (火・金)", time_range: "14:00-14:45", content: "入浴介助、更衣、洗髪" },
      { kind: "生活2", frequency: "週2回 (月・木)", time_range: "10:00-10:45", content: "居室掃除、買い物代行、ゴミ出し" },
    ],
    special_notes: "前屈動作を避ける。コルセット着用を励行。",
  },
};

const DEFAULT_TEMPLATE = PLAN_TEMPLATES["高血圧"];

async function main() {
  console.log(`\n📂 訪問介護計画書 fake seed`);
  console.log(`🏢 office = Ｈａｮｱヘルパーステーションおゆみ野`);
  console.log(`🏷️  marker = ${SAMPLE_MARKER}`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (実書込)" : "🔍 DRY RUN");
  console.log("");

  const sb = createClient(SB_URL, SB_KEY);

  // 対象 利用者 (OY001-010) を取得
  const userNos = Array.from({ length: 10 }, (_, i) => `OY${String(i + 1).padStart(3, "0")}`);
  const { data: clientRows, error: cErr } = await sb
    .from("clients")
    .select("id, user_number, name, status")
    .eq("tenant_id", TENANT_ID)
    .in("user_number", userNos);
  if (cErr) {
    console.error("❌ clients 取得失敗:", cErr.message);
    process.exit(1);
  }
  const clients = clientRows ?? [];
  console.log(`👥 対象 利用者 = ${clients.length} / ${userNos.length}`);
  if (clients.length === 0) {
    console.log("⚠️  OY001-010 が clients に存在しません。先に seed_fake_houmonkaigo_clients.mjs を実行してください。");
    return;
  }

  // 既に計画書がある利用者を skip (= 同 marker 検出)
  const userIds = clients.map((c) => c.id);
  const { data: existing, error: eErr } = await sb
    .from("kaigo_houmon_care_plans")
    .select("user_id, weekly_services")
    .in("user_id", userIds);
  if (eErr) {
    console.error("❌ 既存 plan 取得失敗:", eErr.message);
    if (/weekly_services/.test(eErr.message)) {
      console.error("   → migrations/applied_archive/houmon_care_plans_v2.sql が未適用の可能性があります");
    }
    process.exit(1);
  }
  const existingMarkedUsers = new Set(
    (existing ?? [])
      .filter(
        (p) =>
          Array.isArray(p.weekly_services) &&
          p.weekly_services.some((s) => s && s._sample_marker === SAMPLE_MARKER),
      )
      .map((p) => p.user_id),
  );
  const toInsert = clients.filter((c) => !existingMarkedUsers.has(c.id));
  console.log(`📋 既存 fake plan あり = ${existingMarkedUsers.size}、新規 INSERT 対象 = ${toInsert.length}`);

  if (toInsert.length === 0) {
    console.log("✅ 既に全件 seed 済みです");
    return;
  }

  // ── ailment 紐付け (clients.primary_disease が無ければ名前 hash で割振) ──
  const ailmentList = Object.keys(PLAN_TEMPLATES);
  function pickAilment(c, idx) {
    const v = (c.primary_disease ?? "").toString();
    for (const a of ailmentList) if (v.includes(a)) return a;
    return ailmentList[idx % ailmentList.length];
  }

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const planDate = `${yyyy}-${mm}-${dd}`;
  const validFrom = planDate;
  // valid_until = +6 months
  const until = new Date(today);
  until.setMonth(until.getMonth() + 6);
  const validUntil = `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, "0")}-${String(until.getDate()).padStart(2, "0")}`;

  // dry-run summary
  console.log(`\n📊 生成 plan: 1 利用者 = 1 plan, 合計 ${toInsert.length} 件`);
  console.log(`   plan_date    = ${planDate}`);
  console.log(`   valid_from   = ${validFrom}`);
  console.log(`   valid_until  = ${validUntil}\n`);
  if (!EXECUTE) {
    console.log("🔍 DRY RUN 終了。--execute で本番実行。");
    return;
  }

  console.log("🚀 INSERT 開始...");
  let success = 0;
  let failure = 0;
  for (let idx = 0; idx < toInsert.length; idx++) {
    const c = toInsert[idx];
    const ailment = pickAilment(c, idx);
    const tmpl = PLAN_TEMPLATES[ailment] ?? DEFAULT_TEMPLATE;
    const weeklyServices = tmpl.services.map((s) => ({
      ...toWeeklyService(s),
      _sample_marker: SAMPLE_MARKER,
    }));
    const payload = {
      tenant_id: TENANT_ID,
      user_id: c.id,
      office_id: HELPER_OFFICE_ID,
      plan_kind: "初回",
      plan_date: planDate,
      initial_plan_date: planDate,
      valid_from: validFrom,
      valid_until: validUntil,
      goals: [
        {
          needs: "",
          long_term_goal: tmpl.long_term_goal,
          long_term_period: `${validFrom}〜${validUntil}`,
          short_term_goal: tmpl.short_term_goal,
          short_term_period: `${validFrom}〜${validUntil}`,
        },
      ],
      user_situation: tmpl.user_situation,
      family_situation: tmpl.family_situation,
      weekly_services: weeklyServices,
      special_notes: `${tmpl.special_notes} ${NOTES_SUFFIX}`,
      author_name: "サービス提供責任者 (fake)",
      explained_on: planDate,
      user_consent_date: planDate,
      user_consent_name: c.name,
      status: "draft",
    };
    const { error } = await sb.from("kaigo_houmon_care_plans").insert(payload);
    if (error) {
      failure++;
      console.error(`   ❌ ${c.user_number} ${c.name}: ${error.message}`);
    } else {
      success++;
      console.log(`   ✅ ${c.user_number} ${c.name} (${ailment})`);
    }
  }
  console.log(`\n🎉 完了: 成功 ${success} / 失敗 ${failure}`);

  // 件数確認
  const { count, error: countErr } = await sb
    .from("kaigo_houmon_care_plans")
    .select("id", { count: "exact", head: true })
    .in("user_id", userIds);
  if (!countErr) {
    console.log(`📊 verify: kaigo_houmon_care_plans (対象利用者) = ${count} 件`);
  }
}

main().catch((err) => {
  console.error("❌ unhandled:", err);
  process.exit(1);
});
