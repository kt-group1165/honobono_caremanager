/**
 * OY001-010 利用者に サービス実施記録 + 訪問手順書 (v2) を追加 seed。
 *
 * v2 構造 (2026-06-22 確定):
 *   - kaigo_visit_procedure_services に time_range 列なし (= 週次表に移動)
 *   - weekly_schedule: { mon: [ { "1": { start: "09:00" }, "2": null, ... } ], ... }
 *     曜日 → 行配列 → サービス番号 → { start: "HH:MM" } | null
 *   - end は計算で出すので保存しない
 *   - service_kind は v2 enum (= "身体1", "身体2", "身体3", "生活2", "生活3",
 *     "身体1生活1", "身体1生活2", "身体1生活3", "身体2生活1", "身体2生活2", "身体2生活3")
 *   - 1 doc = 5 サービス枠だが、kind を設定しない service は INSERT しない
 *     (= queries.saveDocument が kind 空 service を filter する仕様)
 *   - step.minutes は 5 分刻み (5〜60 分)
 *
 * 追加するデータ:
 *   ① kaigo_service_records             8 件 / 利用者 (= 過去 30 日内のサービス記録、v1 と同じ)
 *   ② kaigo_visit_procedure_documents   1 件 / 利用者 (= 手順書 main、v2 weekly_schedule)
 *   ③ kaigo_visit_procedure_services    1-2 件 / 手順書 (= kind 設定済のみ)
 *   ④ kaigo_visit_procedure_steps       各 service 3-5 件 (= 訪問・手洗、トイレ介助 等)
 *
 * 目印:
 *   notes / content / special_notes 末尾に '[fake テスト用-houmon]'
 *   document.special_notes に sample marker (= 冪等性判定にも使用)
 *
 * Usage:
 *   node migrations/seed_houmon_service_and_procedures.mjs            # DRY RUN
 *   node migrations/seed_houmon_service_and_procedures.mjs --execute  # 本番
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
const HELPER_OFFICE_ID = "4f14d50c-76b5-4f44-ac41-ed6d01f53a30"; // 訪問介護
const NOTES_SUFFIX = "[fake テスト用-houmon]";
const SAMPLE_MARKER = "fake-houmon-v2-2026-06";
const EXECUTE = process.argv.includes("--execute");

// ─── ① kaigo_service_records 用 (v1 から踏襲) ────────────────────
const SERVICE_RECORDS_TPL = [
  { type: "身体介護1", duration: 30, content: "起床介助・更衣介助。本人の意向を確認しながら洗顔・整容介助。バイタル測定 (BP 138/82, P 72, SpO2 97)。状態安定。" },
  { type: "身体介護2", duration: 60, content: "入浴介助。脱衣→洗体 (背中・足介助)→洗髪→着衣の順で実施。湯温 41度。発赤・かゆみなし。爪切り実施。" },
  { type: "生活援助2", duration: 60, content: "調理・配膳 (昼食)。栄養バランスを考慮した献立。塩分制限を意識。食事中は見守り。完食、食欲良好。" },
  { type: "生活援助3", duration: 90, content: "掃除 (居室・トイレ・浴室)、洗濯 (取込・畳・収納)、ゴミ捨て。本人と一緒に行うことで日常動作の維持を図る。" },
  { type: "身体介護1+生活援助1", duration: 60, content: "服薬介助 (朝の薬を確認・飲水サポート)、夕食調理・配膳。残薬の確認も実施、不足なし。" },
  { type: "身体介護2", duration: 75, content: "排泄介助・清拭・更衣。失禁あり、皮膚状態を確認 (発赤なし)。陰部清拭、リハパン交換。気分爽快の様子。" },
  { type: "生活援助1", duration: 30, content: "買い物代行 (近隣スーパー)。買い物リスト確認、レシートと一緒に金銭管理ノートへ記入。" },
  { type: "通院介助", duration: 120, content: "通院介助 (千葉市民病院・循環器内科)。タクシー利用、付き添い、待ち時間中の見守り。診察結果を家族にも報告。次回予約: 4週後。" },
];

// ─── ② 手順書 v2 テンプレ (kind + steps のみ。週次表は下で個別生成) ─
// kind は v2 enum (types.ts の VISIT_SERVICE_KINDS)
const PROCEDURE_TEMPLATES = {
  "高血圧": [
    {
      kind: "身体1",
      special: "血圧測定の習慣化を支援。降圧薬の服薬確認は必須。",
      steps: [
        { content: "玄関で挨拶・声かけ、手洗い", min: 5 },
        { content: "本人の様子・体調確認", min: 5 },
        { content: "バイタル測定 (BP・P・SpO2)", min: 5 },
        { content: "服薬介助 (降圧薬の確認と飲水サポート)", min: 10 },
        { content: "記録記入・退室準備", min: 5 },
      ],
    },
    {
      kind: "身体2",
      special: "入浴前後の血圧変動に注意。脱衣場の温度差にも配慮。",
      steps: [
        { content: "入浴前バイタル確認・湯温確認", min: 10 },
        { content: "脱衣介助 (本人ペース)", min: 10 },
        { content: "洗体 (背中・足は介助)、洗髪", min: 20 },
        { content: "湯船浴 (5分)、上がり湯", min: 10 },
        { content: "着衣介助、水分補給", min: 10 },
      ],
    },
  ],
  "糖尿病": [
    {
      kind: "身体1",
      special: "食事・服薬時間を必ず守る。低血糖症状にも注意。",
      steps: [
        { content: "玄関で挨拶・手洗い", min: 5 },
        { content: "血糖測定値の確認 (本人記録)", min: 10 },
        { content: "服薬介助 (経口血糖降下薬)", min: 5 },
        { content: "食事準備の声かけ", min: 10 },
      ],
    },
  ],
  "脳梗塞後遺症": [
    {
      kind: "身体2",
      special: "右麻痺あり、患側に気を付ける。リハビリ意欲を引き出す声かけ。",
      steps: [
        { content: "声かけ・挨拶・本人の希望確認", min: 5 },
        { content: "起床介助 (左側介助、右側保護)", min: 10 },
        { content: "車椅子移乗", min: 10 },
        { content: "更衣介助 (脱健着患の原則)", min: 15 },
        { content: "整容・洗面、記録", min: 15 },
      ],
    },
    {
      kind: "生活2",
      special: "本人の食事姿勢に注意。誤嚥予防のためトロミ剤を活用。",
      steps: [
        { content: "食事準備 (トロミ剤の利用)", min: 10 },
        { content: "食事姿勢の調整 (車椅子・テーブル高)", min: 5 },
        { content: "食事介助 (患側に注意、一口量に注意)", min: 30 },
        { content: "口腔ケア・食後の体位調整", min: 15 },
      ],
    },
  ],
  "膝関節症": [
    {
      kind: "身体1生活1",
      special: "起立時のサポート必須。痛みの訴えに留意。",
      steps: [
        { content: "玄関で挨拶・手洗い", min: 5 },
        { content: "起立・歩行介助 (杖使用)", min: 10 },
        { content: "簡単な掃除 (居室)", min: 15 },
        { content: "片付け・記録", min: 10 },
      ],
    },
  ],
  "認知症": [
    {
      kind: "身体1",
      special: "本人のペースに合わせ、急かさない。BPSD の予防のため穏やかに対応。",
      steps: [
        { content: "声かけ・挨拶 (本人を認識するまで丁寧に)", min: 5 },
        { content: "起床介助、体位変換", min: 10 },
        { content: "口腔ケア (本人と一緒に動作確認)", min: 10 },
        { content: "更衣・整容介助", min: 15 },
      ],
    },
    {
      kind: "身体2生活1",
      special: "入浴を嫌がる時は無理せず、別日に再調整も検討。",
      steps: [
        { content: "入浴前の声かけ", min: 5 },
        { content: "更衣・脱衣 (羞恥心への配慮)", min: 10 },
        { content: "洗体・洗髪", min: 25 },
        { content: "着衣・整容", min: 15 },
        { content: "おやつの提供・回想法を取り入れた会話", min: 15 },
      ],
    },
  ],
  "心房細動": [
    {
      kind: "身体1",
      special: "脈拍リズム確認。抗凝固薬の服薬確認必須。",
      steps: [
        { content: "玄関で挨拶・手洗い", min: 5 },
        { content: "バイタル測定 (BP・P・脈の不整)", min: 10 },
        { content: "服薬介助 (抗凝固薬)", min: 5 },
        { content: "記録記入", min: 5 },
      ],
    },
  ],
  "パーキンソン病": [
    {
      kind: "身体2",
      special: "オン・オフ時間帯を意識。すくみ足に注意。",
      steps: [
        { content: "声かけ・挨拶", min: 5 },
        { content: "起床介助 (体位変換ゆっくり)", min: 15 },
        { content: "歩行介助 (杖・歩行器)", min: 15 },
        { content: "整容・記録", min: 10 },
      ],
    },
    {
      kind: "生活2",
      special: "嚥下機能低下に配慮。トロミ剤併用。",
      steps: [
        { content: "食事準備 (一口大、トロミ調整)", min: 15 },
        { content: "食事姿勢の調整", min: 5 },
        { content: "食事介助 (ゆっくりペース)", min: 30 },
        { content: "口腔ケア・片付け", min: 10 },
      ],
    },
  ],
  "COPD": [
    {
      kind: "身体1",
      special: "呼吸状態の観察。SpO2 低下時は無理させない。",
      steps: [
        { content: "玄関で挨拶・手洗い", min: 5 },
        { content: "バイタル測定 (SpO2 重点)", min: 10 },
        { content: "口すぼめ呼吸の声かけ", min: 5 },
        { content: "記録", min: 5 },
      ],
    },
  ],
  "リウマチ": [
    {
      kind: "身体1生活1",
      special: "関節痛強い時は動作援助を多めに。冷えに注意。",
      steps: [
        { content: "玄関で挨拶・手洗い", min: 5 },
        { content: "関節状態確認 (痛み・腫れ)", min: 10 },
        { content: "更衣・整容介助 (ボタン等)", min: 15 },
        { content: "簡単な家事 (洗濯物畳み)", min: 15 },
      ],
    },
  ],
  "腰椎症": [
    {
      kind: "身体1",
      special: "起立・座位の介助、姿勢に注意。重い物は持たせない。",
      steps: [
        { content: "玄関で挨拶・手洗い", min: 5 },
        { content: "起立・歩行介助", min: 10 },
        { content: "体位変換、ストレッチの声かけ", min: 10 },
        { content: "記録・退室", min: 5 },
      ],
    },
  ],
};

function getTemplate(ailment) {
  return PROCEDURE_TEMPLATES[ailment] || PROCEDURE_TEMPLATES["高血圧"];
}

// 週次表 v2 生成: 月水金 09:00 / 火木 17:00 / 土日空
//   - サービス枠は 1〜5 (全 5 列分の row を必ず作る、未使用は null)
//   - INSERT する service の service_no と一致させる (= サービス 1 番目, 2 番目)
function buildWeeklySchedule(svcCount) {
  // 1 行: { "1": { start } or null, "2": { start } or null, "3": null, "4": null, "5": null }
  function row(slot1, slot2) {
    const r = { "1": null, "2": null, "3": null, "4": null, "5": null };
    if (slot1 && svcCount >= 1) r["1"] = { start: slot1 };
    if (slot2 && svcCount >= 2) r["2"] = { start: slot2 };
    return r;
  }
  // 月水金 朝 09:00 = サービス 1 番目
  // 火木 夕方 17:00 = サービス 2 番目 (存在すれば)
  return {
    mon: [row("09:00", null)],
    tue: [row(null, svcCount >= 2 ? "17:00" : null)],
    wed: [row("09:00", null)],
    thu: [row(null, svcCount >= 2 ? "17:00" : null)],
    fri: [row("09:00", null)],
    sat: [row(null, null)],
    sun: [row(null, null)],
  };
}

async function main() {
  console.log(`\n📂 OY001-010 にサービス実施記録 + 訪問手順書 v2 を追加 seed`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE" : "🔍 DRY RUN");
  const sb = createClient(SB_URL, SB_KEY);

  // 対象 client
  const { data: clients, error: cErr } = await sb
    .from("clients")
    .select("id, user_number, name")
    .eq("tenant_id", TENANT_ID)
    .like("user_number", "OY%")
    .order("user_number");
  if (cErr) {
    console.error(`❌ clients 取得失敗: ${cErr.message}`);
    process.exit(1);
  }
  if (!clients || clients.length === 0) {
    console.error("❌ OY% 利用者が存在しません。先に seed_fake_houmonkaigo_clients.mjs を実行してください");
    process.exit(1);
  }
  console.log(`👤 対象 ${clients.length} 名`);

  // staff candidate (= 訪問介護 office 所属の active staff)
  const { data: moRows, error: moErr } = await sb
    .from("member_offices")
    .select("member_id")
    .eq("office_id", HELPER_OFFICE_ID);
  if (moErr) {
    console.error(`❌ member_offices 取得失敗: ${moErr.message}`);
    process.exit(1);
  }
  const memberIds = [...new Set((moRows ?? []).map((r) => r.member_id))];
  let staff = [];
  if (memberIds.length > 0) {
    const { data, error } = await sb
      .from("members")
      .select("id, name")
      .in("id", memberIds)
      .eq("status", "active");
    if (error) {
      console.error(`❌ members 取得失敗: ${error.message}`);
      process.exit(1);
    }
    staff = data ?? [];
  }
  const pickStaff = (i) =>
    staff.length > 0 ? staff[i % staff.length] : { id: null, name: "担当ヘルパー" };

  // 冪等性: 既存の sample marker を持つ document を取得 → 該当 client は skip
  const { data: existingDocs, error: edErr } = await sb
    .from("kaigo_visit_procedure_documents")
    .select("id, client_name, special_notes")
    .eq("tenant_id", TENANT_ID)
    .like("special_notes", `%${SAMPLE_MARKER}%`);
  if (edErr) {
    console.error(`❌ 既存 document 確認失敗: ${edErr.message}`);
    process.exit(1);
  }
  const docExistsByName = new Set((existingDocs ?? []).map((d) => d.client_name));
  if (docExistsByName.size > 0) {
    console.log(`ℹ️  既存 marker 付き手順書: ${docExistsByName.size} 件 → 該当 client は手順書作成を skip`);
  }

  const today = new Date();
  let srInserted = 0;
  let docInserted = 0;
  let svcInserted = 0;
  let stepInserted = 0;
  let docSkipped = 0;

  const ailments = [
    "高血圧", "糖尿病", "脳梗塞後遺症", "膝関節症", "認知症",
    "心房細動", "パーキンソン病", "COPD", "リウマチ", "腰椎症",
  ];

  for (let idx = 0; idx < clients.length; idx++) {
    const client = clients[idx];
    const ailment = ailments[idx % ailments.length];
    const services = getTemplate(ailment); // 1〜2 サービス

    // ─── ① kaigo_service_records ────────────────────
    for (let i = 0; i < SERVICE_RECORDS_TPL.length; i++) {
      const tplItem = SERVICE_RECORDS_TPL[i];
      const recDate = new Date(today);
      recDate.setDate(recDate.getDate() - (3 + i * 4));
      const startH = 9 + (i % 6);
      const startTime = `${String(startH).padStart(2, "0")}:00:00`;
      const endTime = tplItem.duration < 60
        ? `${String(startH).padStart(2, "0")}:${tplItem.duration}:00`
        : `${String(startH + 1).padStart(2, "0")}:00:00`;
      const st = pickStaff(idx * 7 + i);
      const row = {
        user_id: client.id,
        tenant_id: TENANT_ID,
        service_date: recDate.toISOString().slice(0, 10),
        service_type: tplItem.type,
        start_time: startTime,
        end_time: endTime,
        staff_id: st.id,
        content: `${tplItem.content} ${NOTES_SUFFIX}`,
        notes: `担当: ${st.name} ${NOTES_SUFFIX}`,
      };
      if (EXECUTE) {
        const { error } = await sb.from("kaigo_service_records").insert(row);
        if (error) {
          console.error(`  ✗ ${client.name} service_record [${i}]: ${error.message}`);
        } else {
          srInserted++;
        }
      } else {
        srInserted++;
      }
    }

    // ─── ② 手順書 v2 (既存あれば skip) ──────────────────
    if (docExistsByName.has(client.name)) {
      docSkipped++;
      console.log(`  ⏭  ${client.name} (${client.user_number}) 手順書既存 → skip`);
      continue;
    }

    const svcCount = services.length;
    const docRow = {
      tenant_id: TENANT_ID,
      office_id: HELPER_OFFICE_ID,
      client_name: client.name,
      plan_start_date: new Date(today.getFullYear(), today.getMonth(), 1)
        .toISOString()
        .slice(0, 10),
      plan_end_date: new Date(today.getFullYear(), today.getMonth() + 3, 0)
        .toISOString()
        .slice(0, 10),
      author_name: pickStaff(idx).name,
      creation_reason: "新規作成",
      special_notes: `${ailment} あり。${NOTES_SUFFIX} sample-marker:${SAMPLE_MARKER}`,
      weekly_schedule: buildWeeklySchedule(svcCount),
    };
    let docId = null;
    if (EXECUTE) {
      const { data, error } = await sb
        .from("kaigo_visit_procedure_documents")
        .insert(docRow)
        .select("id")
        .single();
      if (error) {
        console.error(`  ✗ ${client.name} document: ${error.message}`);
        continue;
      }
      docId = data.id;
      docInserted++;
    } else {
      docInserted++;
    }

    // ─── ③ kaigo_visit_procedure_services × 1-2 ──────
    for (let si = 0; si < services.length; si++) {
      const svc = services[si];
      const svcRow = {
        document_id: docId,
        service_no: si + 1,
        service_kind: svc.kind, // v2: time_range 列なし
        special_notes: `${svc.special} ${NOTES_SUFFIX}`,
      };
      let svcId = null;
      if (EXECUTE) {
        const { data, error } = await sb
          .from("kaigo_visit_procedure_services")
          .insert(svcRow)
          .select("id")
          .single();
        if (error) {
          console.error(`  ✗ ${client.name} service[${si + 1}]: ${error.message}`);
          continue;
        }
        svcId = data.id;
        svcInserted++;
      } else {
        svcInserted++;
      }

      // ─── ④ steps ────────────────────────────────
      for (let stp = 0; stp < svc.steps.length; stp++) {
        const step = svc.steps[stp];
        // 5 分刻みバリデーション (= 念のため)
        if (step.min % 5 !== 0 || step.min < 5 || step.min > 60) {
          console.error(`  ✗ ${client.name} svc[${si + 1}] step[${stp + 1}] minutes=${step.min} は 5〜60 の 5 分刻みでない`);
          process.exit(1);
        }
        const stepRow = {
          service_id: svcId,
          step_no: stp + 1,
          content: step.content,
          minutes: step.min,
          detail: stp === 0 ? NOTES_SUFFIX : null,
        };
        if (EXECUTE) {
          const { error } = await sb.from("kaigo_visit_procedure_steps").insert(stepRow);
          if (error) {
            console.error(`  ✗ ${client.name} step[${stp + 1}]: ${error.message}`);
          } else {
            stepInserted++;
          }
        } else {
          stepInserted++;
        }
      }
    }
    console.log(`  ✓ ${client.name} (${client.user_number}) ${ailment} 手順書 (${svcCount} svc) 完了`);
  }

  console.log(`\n📊 結果:`);
  console.log(`   service_records INSERT: ${srInserted}`);
  console.log(`   procedure_documents INSERT: ${docInserted} (skip ${docSkipped})`);
  console.log(`   procedure_services INSERT: ${svcInserted}`);
  console.log(`   procedure_steps    INSERT: ${stepInserted}`);
  console.log(`   合計 INSERT: ${srInserted + docInserted + svcInserted + stepInserted}`);
  if (!EXECUTE) console.log(`\n🔍 DRY RUN 終了。--execute で本番。`);
  else console.log(`\n✅ EXECUTE 完了`);
}

main().catch((e) => {
  console.error("💥 unexpected:", e);
  process.exit(1);
});
