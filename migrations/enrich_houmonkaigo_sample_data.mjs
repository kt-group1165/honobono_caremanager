/**
 * Ｈａｮｱヘルパーステーションおゆみ野 / Ｈａｮｱ居宅支援センターおゆみ野
 * の OY001-010 利用者にサンプルの「アセスメント / 計画書 / 支援経過」を
 * 充実させる script。
 *
 * 既存の薄いデータを UPDATE してリアルな内容に。
 * 新規 support_records も INSERT。
 *
 * 目印 (= 後で識別/削除しやすく):
 *   form_data._sample_marker = 'fake-houmon-2026-06'
 *   notes 末尾に '[fake テスト用-houmon]'
 *
 * Usage:
 *   node migrations/enrich_houmonkaigo_sample_data.mjs            # DRY RUN
 *   node migrations/enrich_houmonkaigo_sample_data.mjs --execute  # 本番
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
if (!SB_URL || !SB_KEY) { console.error("❌ env"); process.exit(1); }

const TENANT_ID = "kt-group";
const SAMPLE_MARKER = "fake-houmon-2026-06";
const NOTES_SUFFIX = "[fake テスト用-houmon]";
const EXECUTE = process.argv.includes("--execute");

// ── 利用者別のリアルなアセスメント文言 (主病に応じて変える) ──
const ASSESSMENT_TEMPLATES = {
  "高血圧": {
    family_situation: "長男夫婦と同居。本人は1階の和室を居室として使用、長男夫婦は2階で生活。日中は主に独居状態。週末に長女が来訪する。",
    informal_support: "近隣の民生委員が月1回訪問、自治会の高齢者見守り活動の対象。",
    health_condition: "血圧管理が課題。収縮期 150 前後で推移。降圧薬を朝1錠服用。塩分制限の食事指導を受けている。",
    medical_visits: "近所の内科クリニック 月2回受診 (循環器内科)。",
    medications: "アムロジピン5mg 朝1錠、テルミサルタン40mg 朝1錠。",
    mobility_notes: "歩行器使用で短距離は可能。長時間は疲労感あり。階段昇降に介助必要。",
    cognition_status: "軽度低下", cognition_status_value: "見守り",
    user_request: "自宅で長く暮らしたい。家族に迷惑をかけたくない。",
    family_request: "本人の意向を尊重しつつ、安全と健康管理を優先したい。緊急時の連絡体制を確保したい。",
    overall_summary: "高血圧の管理が主たる課題。ADL は概ね自立しているが、入浴・移動は一部介助が必要。家族の介護負担軽減のためヘルパー導入を希望。",
    issues: "①血圧コントロール ②転倒予防 ③社会的孤立の防止",
  },
  "糖尿病": {
    family_situation: "妻と二人暮らし。妻も高齢で軽度の介護を要する状態。長男は遠方在住で月1回訪問。",
    informal_support: "近所の友人が週1-2回 訪問。",
    health_condition: "HbA1c 7.2%。インスリン自己注射中。低血糖症状に注意が必要。食事療法と運動療法を併用。",
    medical_visits: "糖尿病内科 月1回受診。眼科 3ヶ月に1回。",
    medications: "インスリンライゾデグ 朝12単位、メトホルミン500mg 朝夕。",
    mobility_notes: "杖歩行。30分の散歩を日課にしている。神経障害により足のしびれあり。",
    cognition_status: "正常範囲", cognition_status_value: "自立",
    user_request: "妻の世話をしながら自宅で生活を続けたい。糖尿病の管理を確実に行いたい。",
    family_request: "夫婦ともに安心して暮らせるよう、ヘルパーのサポートが必要。",
    overall_summary: "糖尿病管理が中心課題。本人は管理意欲が高い。妻の状態も含め、夫婦のサポート体制構築が重要。",
    issues: "①血糖管理 ②妻のレスパイト ③低血糖時の緊急対応",
  },
  "脳梗塞後遺症": {
    family_situation: "長女夫婦と同居。長女は介護のため離職した経緯あり。孫 (高校生) も同居。",
    informal_support: "教会の信徒が訪問してくれる (本人がクリスチャン)。",
    health_condition: "右片麻痺、軽度の言語障害あり。リハビリ継続中。再発予防の抗血小板療法。",
    medical_visits: "神経内科 月1回。回復期リハビリは通所リハに移行。",
    medications: "クロピドグレル75mg 朝1錠、レバミピド100mg 朝夕、便秘薬。",
    mobility_notes: "車椅子使用。家屋内は伝い歩き可能。屋外は車椅子。トイレ移乗に介助必要。",
    cognition_status: "軽度低下 (注意力低下、易疲労)", cognition_status_value: "見守り",
    user_request: "リハビリを継続し、少しでも歩けるようになりたい。",
    family_request: "リハビリ意欲を維持できるよう支援してほしい。家族の負担を軽減してほしい。",
    overall_summary: "脳梗塞後遺症で右片麻痺。リハビリ意欲は高い。家族介護者 (長女) の負担軽減と本人のリハビリ継続支援が両輪。",
    issues: "①麻痺の進行予防 ②家族の介護負担 ③再発予防",
  },
  "認知症": {
    family_situation: "長男が同居。日中は長男が出勤するため独居になる時間が長い。妻は2年前に他界。",
    informal_support: "近所の方が時々様子を見にきてくれる。徘徊時の連絡網あり。",
    health_condition: "アルツハイマー型認知症 中等度。HDS-R 12点。短期記憶障害顕著。時に夕方の不穏あり。",
    medical_visits: "認知症外来 月1回 (大学病院)。",
    medications: "ドネペジル5mg 朝1錠、メマンチン10mg 夕1錠、抑肝散。",
    mobility_notes: "歩行は問題なし。徘徊リスクあり、GPS 携帯。",
    cognition_status: "中等度低下 (見当識障害、エピソード記憶障害顕著)", cognition_status_value: "一部介助",
    user_request: "家にいたい。",
    family_request: "本人の安全を確保しつつ、長男の負担を軽減したい。今後の入所も視野に。",
    overall_summary: "アルツハイマー型認知症 中等度。徘徊リスクあり安全確保が最優先。長男の介護疲労が顕著で、レスパイトケア検討中。",
    issues: "①徘徊予防と安全確保 ②BPSD への対応 ③家族介護者支援",
  },
  "心房細動": {
    family_situation: "妻と二人暮らし。長女が車で30分の距離に在住し週1回訪問。",
    informal_support: "町内会の活動に参加 (体調により)。",
    health_condition: "発作性心房細動。抗凝固療法中。INR モニタリング必要。労作時の動悸あり。",
    medical_visits: "循環器内科 月2回受診。",
    medications: "ワーファリン2mg 朝、ビソプロロール2.5mg 朝、アムロジピン2.5mg 夕。",
    mobility_notes: "杖歩行。長距離は息切れあり。階段昇降は手すり使用。",
    cognition_status: "正常範囲", cognition_status_value: "自立",
    user_request: "趣味の囲碁を続けたい。",
    family_request: "発作時の対応を確実にしたい。出血リスクの管理を支援してほしい。",
    overall_summary: "心房細動の管理が中心。本人は理解力高く、自己管理意欲も十分。発作時の緊急対応体制の整備が課題。",
    issues: "①発作時対応 ②転倒・出血予防 ③社会参加の維持",
  },
};

function getTemplate(ailment) {
  return ASSESSMENT_TEMPLATES[ailment] || ASSESSMENT_TEMPLATES["高血圧"];
}

// ── 支援経過 カテゴリと内容テンプレート ──
// CHECK 制約あり: '電話', '訪問', '来所', 'メール', 'FAX', 'カンファレンス',
//                 'サービス担当者会議', 'モニタリング', 'その他'
const SUPPORT_CATEGORIES = [
  { cat: "モニタリング", content: (n) => `${n}様 ご自宅へモニタリング訪問。ケアプランの実施状況を確認。本人より「ヘルパーさんがいて安心」との発言あり。サービス継続の意向を確認した。次回ケアプラン更新は3ヶ月後を予定。` },
  { cat: "サービス担当者会議", content: (n) => `${n}様 サービス担当者会議をご自宅にて開催。家族 (長男)、ヘルパー (Hana おゆみ野)、訪問看護師、本人参加。ケアプラン (案) を共有し、各サービス事業者から実施状況の報告。週3回の訪問介護を継続することで合意。次回は3ヶ月後に開催予定。` },
  { cat: "訪問", content: (n) => `${n}様 ご家族 (長男) と面談。最近の様子について情報共有。本人の意欲低下が見られる場面があるとの情報あり。デイサービス導入の可能性について検討。次回訪問時に本人の意向を確認することとする。` },
  { cat: "電話", content: (n) => `主治医 (千葉市民病院 山田医師) と電話連絡。${n}様の最近の体調変化について情報共有。新たに処方された薬の管理方法を確認。ヘルパー訪問時に服薬確認を強化する旨を伝達。` },
  { cat: "訪問", content: (n) => `${n}様 ケアプラン (居宅サービス計画書 第1表〜第3表) を交付。本人・家族 (長男) より同意署名を取得。ヘルパーステーション、訪問看護ステーションへ計画書を送付済み。` },
  { cat: "電話", content: (n) => `${n}様 ご長女から電話あり。週末に訪問予定との連絡。本人の最近の様子をお伝えした。家族の不安や疑問にも対応。引き続き連携を密にしていく。` },
  { cat: "訪問", content: (n) => `${n}様 ご自宅にて再アセスメントを実施。ADL に大きな変化なし。意欲・認知機能についても前回と概ね同様。家族介護負担の評価も実施。今後のケアプラン更新に反映する。` },
];

async function main() {
  console.log(`\n📂 OY001-010 のアセスメント / 計画書 / 支援経過 を充実化`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE" : "🔍 DRY RUN");
  const sb = createClient(SB_URL, SB_KEY);

  // 対象 client 取得
  const { data: clients } = await sb
    .from("clients")
    .select("id, user_number, name")
    .eq("tenant_id", TENANT_ID)
    .like("user_number", "OY%");
  if (!clients || clients.length === 0) { console.error("❌ OY% clients が見つかりません"); return; }
  console.log(`👤 対象 ${clients.length} 名`);

  // 既存 assessment / care_plan を取得 (id を引きたい)
  const clientIds = clients.map((c) => c.id);
  const { data: assessments } = await sb
    .from("kaigo_assessments")
    .select("id, user_id")
    .in("user_id", clientIds);
  const { data: carePlans } = await sb
    .from("kaigo_care_plans")
    .select("id, user_id")
    .in("user_id", clientIds);
  const assById = new Map((assessments ?? []).map((a) => [a.user_id, a.id]));
  const cpById = new Map((carePlans ?? []).map((c) => [c.user_id, c.id]));

  // メイン loop
  let assUpdated = 0, cpUpdated = 0, supportInserted = 0;
  const today = new Date();
  for (const client of clients) {
    // 主病名取得 (元 seed と同じ順序、ailment は OY{idx} の順)
    const idx = parseInt(client.user_number.slice(2), 10) - 1;
    const ailments = ["高血圧","糖尿病","脳梗塞後遺症","膝関節症","認知症","心房細動","パーキンソン病","COPD","リウマチ","腰椎症"];
    const ailment = ailments[idx % ailments.length];
    const tpl = getTemplate(ailment);

    // ─── アセスメント UPSERT (= 無ければ INSERT、あれば UPDATE) ─────
    const assId = assById.get(client.id);
    const formData = { _sample_marker: SAMPLE_MARKER, ailment, source: "enrich-script" };
    // *_status は CHECK 制約あり: '自立', '見守り', '一部介助', '全介助' のみ
    // 詳細は notes 系に書く
    const assPayload = {
      family_situation: tpl.family_situation,
      informal_support: tpl.informal_support,
      current_services: "訪問介護 (Hana おゆみ野) 週3回、訪問看護 週1回",
      housing_type: "戸建て", housing_situation: "持ち家、1階に居室・トイレあり",
      housing_issues: "玄関に段差あり、浴室に手すり設置済み",
      health_condition: tpl.health_condition,
      medical_visits: tpl.medical_visits,
      medications: tpl.medications,
      mobility_status: "一部介助", mobility_notes: tpl.mobility_notes,
      eating_status: "自立", eating_notes: "やや偏食傾向、塩分・糖質に注意",
      toileting_status: "一部介助", toileting_notes: "ポータブルトイレ夜間使用",
      bathing_status: "一部介助", bathing_notes: "週2回 ヘルパーの一部介助で実施",
      dressing_status: "一部介助", dressing_notes: "上衣は自立、下衣は介助",
      grooming_status: "見守り", grooming_notes: "整容は概ね自立、洗面は声かけ必要",
      communication_status: "自立", communication_notes: "会話は良好",
      cognition_status: tpl.cognition_status_value,  // 自立/見守り/一部介助/全介助
      cognition_notes: tpl.cognition_status,         // 軽度低下/中等度低下 等の詳細を notes へ
      cooking_status: "全介助",
      cleaning_status: "全介助",
      laundry_status: "全介助",
      shopping_status: "全介助",        // CHECK 制約: 自立/見守り/一部介助/全介助
      money_management_status: "全介助", // CHECK 制約: 同上
      user_request: tpl.user_request,
      family_request: tpl.family_request,
      overall_summary: `${tpl.overall_summary} ${NOTES_SUFFIX}`,
      issues: tpl.issues,
      daily_schedule: "6:30 起床 / 7:00 朝食・服薬 / 9:00 デイ準備 or 自宅で過ごす / 12:00 昼食 / 14:00 訪問介護 / 18:00 夕食・服薬 / 21:00 就寝",
      form_data: formData,
    };
    if (assId) {
      // UPDATE
      if (EXECUTE) {
        const { error } = await sb.from("kaigo_assessments").update(assPayload).eq("id", assId);
        if (error) console.error(`  ✗ ${client.name} assessment update: ${error.message}`);
        else assUpdated++;
      } else assUpdated++;
    } else {
      // INSERT
      const insertPayload = {
        ...assPayload,
        user_id: client.id, tenant_id: TENANT_ID,
        assessment_date: new Date(today.getTime() - 30 * 86400000).toISOString().slice(0,10),
        assessor_name: "担当ケアマネ (fake)",
        status: "completed",
      };
      if (EXECUTE) {
        const { error } = await sb.from("kaigo_assessments").insert(insertPayload);
        if (error) console.error(`  ✗ ${client.name} assessment insert: ${error.message}`);
        else assUpdated++;
      } else assUpdated++;
    }

    // ─── ケアプラン UPDATE ───────────────────────────
    const cpId = cpById.get(client.id);
    if (cpId) {
      const longGoals = `(1) ${ailment} の症状を悪化させず、現状を維持する。\n(2) ADL を維持し、自宅での生活を継続できる。\n(3) 家族の介護負担を軽減する。\n${NOTES_SUFFIX}`;
      const shortGoals = `(1) 服薬管理 (毎日)\n(2) 入浴介助 (週2回)\n(3) 食事の調理・配膳 (週3回)\n(4) 体調観察と健康管理\n(5) 家族とのコミュニケーション支援`;
      if (EXECUTE) {
        const { error } = await sb.from("kaigo_care_plans").update({
          long_term_goals: longGoals,
          short_term_goals: shortGoals,
        }).eq("id", cpId);
        if (error) console.error(`  ✗ ${client.name} care_plan: ${error.message}`);
        else cpUpdated++;
      } else cpUpdated++;
    }

    // ─── 支援経過 INSERT (7 件、過去 90 日内) ──────────
    for (let i = 0; i < 7; i++) {
      const recDate = new Date(today); recDate.setDate(recDate.getDate() - (i * 12 + 5));
      const recTime = `${10 + (i % 6)}:${i % 2 === 0 ? "00" : "30"}:00`;
      const tpl = SUPPORT_CATEGORIES[i % SUPPORT_CATEGORIES.length];
      const row = {
        user_id: client.id, tenant_id: TENANT_ID,
        record_date: recDate.toISOString().slice(0, 10),
        record_time: recTime,
        category: tpl.cat,
        content: `${tpl.content(client.name)} ${NOTES_SUFFIX}`,
        staff_name: "担当ケアマネ (fake)",
        care_plan_id: cpId,
      };
      if (EXECUTE) {
        const { error } = await sb.from("kaigo_support_records").insert(row);
        if (error) console.error(`  ✗ ${client.name} support_record [${i}]: ${error.message}`);
        else supportInserted++;
      } else supportInserted++;
    }
    console.log(`  ✓ ${client.name} (${client.user_number}) 完了`);
  }

  console.log(`\n📊 結果:`);
  console.log(`   assessments UPDATE: ${assUpdated}`);
  console.log(`   care_plans UPDATE: ${cpUpdated}`);
  console.log(`   support_records INSERT: ${supportInserted}`);
  console.log(`   合計: ${assUpdated + cpUpdated + supportInserted}`);
  if (!EXECUTE) console.log(`\n🔍 DRY RUN 終了。--execute で本番。`);
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
