/**
 * 課題整理総括表 / 評価表 のサンプルデータ投入 (fake 居宅利用者のみ)
 *
 * 対象: client_memos.body LIKE '%[fake テスト用%' でマークされた fake 利用者のうち
 *       居宅系 (user_number が OY 以外) の先頭 12 名。
 * 生成: 1 名につき 課題整理総括表 (kadai-seiri) ×1 + 評価表 (hyouka, 2026-06) ×1。
 * マーカー: content._sample_marker = "fake-care-reports-2026-07" (後で一括削除可能)
 *   DELETE FROM kaigo_report_documents WHERE content->>'_sample_marker' = 'fake-care-reports-2026-07';
 * 冪等: 同 user × report_type × マーカーの既存行がある利用者は skip。
 *
 * 実行:
 *   node migrations/seed_fake_care_reports.mjs            # DRY RUN
 *   node migrations/seed_fake_care_reports.mjs --execute  # 本番
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, "..", ".env.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const MARKER = "fake-care-reports-2026-07";
const EXECUTE = process.argv.includes("--execute");
const TARGET_COUNT = 12;

// ── 課題整理総括表: 要介護度帯ごとのアーキタイプ ──────────────────────────────
// possibility: 改善 / 維持 / 悪化
const KADAI_BY_BAND = {
  light: {
    overall_factors: "変形性膝関節症による膝痛と下肢筋力の低下により、長距離の歩行や階段昇降に不安がある。独居のため家事全般の負担が大きく、活動量が低下しつつある。",
    intention: "本人: 膝の痛みと上手に付き合いながら、自分のことは自分でして今の家で暮らし続けたい。\n家族(長女): 転倒が心配。無理をせず、必要なところは手伝ってもらいながら安全に過ごしてほしい。",
    rows: [
      ["移動", "膝痛により長距離歩行・階段昇降が不安定", "変形性膝関節症、下肢筋力低下", "改善", "運動機会の確保により筋力維持・歩行の安定が見込める", "膝の痛みがあっても転倒せず安全に外出できるようになりたい"],
      ["食事", "自立。硬いものを避ける傾向", "咀嚼力のやや低下", "維持", "現状維持が見込める", ""],
      ["排泄", "自立。夜間頻尿あり", "加齢による膀胱機能低下", "維持", "夜間の動線の安全確保で自立継続が見込める", ""],
      ["入浴・清潔保持", "浴槽の跨ぎに不安があり入浴回数が減少", "膝痛、浴室環境 (手すりなし)", "改善", "福祉用具の活用で安全に入浴できる見込み", "安心して入浴し清潔を保ちたい"],
      ["着脱・整容", "自立。前屈み動作に時間がかかる", "膝痛", "維持", "現状維持が見込める", ""],
      ["服薬", "自己管理できているが飲み忘れが時々ある", "薬の種類の増加", "改善", "服薬カレンダーの活用で確実な服薬が見込める", "薬を飲み忘れず健康を管理したい"],
      ["コミュニケーション", "問題なし", "", "維持", "", ""],
      ["認知", "年相応。物忘れの自覚あり", "", "維持", "社会参加の継続で維持が見込める", ""],
      ["行動・心理症状", "特になし", "", "維持", "", ""],
      ["健康管理", "高血圧で内服中。受診は自力で可能", "高血圧症", "維持", "定期受診の継続で安定が見込める", ""],
      ["家事", "掃除・買い物の負担が大きく一部できていない", "膝痛による活動制限、独居", "改善", "一部支援があれば在宅生活の継続が見込める", "負担の大きい家事を手伝ってもらい生活を整えたい"],
      ["社会参加・対人関係", "外出機会が減少。近所付き合いはある", "移動への不安", "改善", "外出手段の確保で交流の再開が見込める", "趣味の集まりにまた参加したい"],
      ["住環境", "持ち家。浴室・階段に手すりなし", "住宅改修未実施", "改善", "手すり設置で転倒リスクの軽減が見込める", ""],
      ["介護力・家族", "独居。長女が週1回訪問", "家族は就労中で日中不在", "維持", "現在の支援体制で継続可能", ""],
    ],
    remarks: "本人は自立意欲が高い。できることを奪わない支援を基本とし、膝痛の悪化時は主治医と連携する。",
  },
  middle: {
    overall_factors: "脳梗塞後遺症による右片麻痺があり、屋内は伝い歩き、屋外は車いすを使用。高次脳機能障害による意欲低下がみられ、活動量の減少から廃用が進行するおそれがある。",
    intention: "本人: リハビリを続けて、少しでも自分の足で歩けるようになりたい。\n家族(妻): 私も高齢なので、介護の負担を減らしながら夫を支えたい。",
    rows: [
      ["移動", "屋内伝い歩き、屋外車いす。移乗は見守り〜一部介助", "右片麻痺、下肢筋力低下", "改善", "リハビリ継続により屋内歩行の安定が見込める", "転倒なく屋内を安全に移動できるようになりたい"],
      ["食事", "セッティングすれば自力摂取可能", "右手の麻痺 (利き手交換中)", "維持", "自助具の活用で自立継続が見込める", ""],
      ["排泄", "日中はトイレで自立、夜間はポータブルトイレ使用", "夜間の移動リスク", "維持", "動線整備により現状維持が見込める", "夜間も安全に排泄したい"],
      ["入浴・清潔保持", "一部介助 (洗身・移乗)", "片麻痺によるバランス不良", "維持", "デイサービスでの入浴継続で清潔保持が見込める", "安全に入浴を続けたい"],
      ["着脱・整容", "一部介助 (ボタン・袖通し)", "右手指の巧緻性低下", "改善", "着脱しやすい衣類の工夫で自立度向上が見込める", ""],
      ["服薬", "妻が管理", "本人での管理は困難", "維持", "家族管理の継続で確実な服薬が見込める", ""],
      ["コミュニケーション", "軽度の構音障害はあるが意思疎通可能", "脳梗塞後遺症", "維持", "", ""],
      ["認知", "記憶は保たれているが注意力の低下あり", "高次脳機能障害", "維持", "生活リズムの安定で混乱なく過ごせる見込み", ""],
      ["行動・心理症状", "意欲低下がみられる", "できない体験の積み重ね", "改善", "成功体験を重ねることで意欲の回復が見込める", "できることを増やして自信を取り戻したい"],
      ["健康管理", "血圧・血糖の管理を妻と訪問看護で実施", "脳梗塞再発リスク、糖尿病", "維持", "服薬・食事管理の継続で再発予防が見込める", "脳梗塞を再発させず在宅生活を続けたい"],
      ["家事", "行っていない (妻が担っている)", "片麻痺", "維持", "", ""],
      ["社会参加・対人関係", "外出はデイサービスのみ", "移動手段の制限、意欲低下", "改善", "外出機会の拡大で活動性の向上が見込める", ""],
      ["住環境", "手すり設置済み。浴室に段差あり", "段差の未解消", "改善", "住宅改修で入浴動作の安全性向上が見込める", ""],
      ["介護力・家族", "妻 (78歳) と二人暮らし。妻に腰痛あり", "老老介護、介護負担の蓄積", "悪化", "レスパイトの確保がなければ共倒れのおそれ", "妻の介護負担を軽減し在宅生活を継続したい"],
    ],
    remarks: "妻の介護負担軽減が在宅継続の鍵。ショートステイの定期利用を検討する。リハビリの意欲を支える声かけを各事業所で統一する。",
  },
  heavy: {
    overall_factors: "アルツハイマー型認知症の進行と大腿骨頸部骨折後の歩行能力低下により、生活全般に介助を要する。嚥下機能の低下がみられ、誤嚥性肺炎のリスクが高い。",
    intention: "本人: (発語は少ないが) 家で過ごしたい様子がうかがえる。\n家族(長男): 母を最期まで家で看たい。介護サービスを組み合わせて何とか続けたい。",
    rows: [
      ["移動", "車いす全介助。ベッド上での体位変換も一部介助", "認知症の進行、骨折後の廃用", "維持", "定期的な離床で座位保持能力の維持が見込める", "褥瘡をつくらず安楽に過ごしたい"],
      ["食事", "全介助。ムセ込みが増えている", "嚥下機能低下", "悪化", "食形態の調整と姿勢の工夫で誤嚥リスクの軽減を図る", "誤嚥性肺炎を起こさず口から食べ続けたい"],
      ["排泄", "オムツ使用、全介助", "認知症、移動能力の低下", "維持", "定時交換とスキンケアで皮膚トラブル予防が見込める", "皮膚トラブルなく清潔に過ごしたい"],
      ["入浴・清潔保持", "訪問入浴を利用 (全介助)", "全身状態、移動困難", "維持", "訪問入浴の継続で清潔保持が見込める", "安全に入浴し清潔を保ちたい"],
      ["着脱・整容", "全介助", "認知症、拘縮傾向", "維持", "関節可動域訓練で拘縮予防が見込める", ""],
      ["服薬", "全介助 (長男が管理、ヘルパーが服薬確認)", "認知症", "維持", "多職種での確認体制で確実な服薬が見込める", ""],
      ["コミュニケーション", "発語は少ないが表情での意思表示あり", "認知症の進行", "維持", "非言語的なサインを汲み取る関わりで安心が保てる", ""],
      ["認知", "重度の記憶障害・見当識障害", "アルツハイマー型認知症", "悪化", "なじみの環境の維持で混乱の軽減が見込める", "落ち着いて穏やかに過ごしたい"],
      ["行動・心理症状", "夕方に落ち着かなくなることがある", "見当識障害、不安", "維持", "生活リズムの安定と声かけで軽減が見込める", ""],
      ["健康管理", "誤嚥性肺炎の既往2回。訪問診療・訪問看護利用", "嚥下機能低下、体力低下", "悪化", "口腔ケアと栄養管理の徹底で重症化予防を図る", "肺炎で入院せず在宅で過ごしたい"],
      ["家事", "行っていない", "", "維持", "", ""],
      ["社会参加・対人関係", "訪問時の交流のみ", "外出困難", "維持", "サービス利用時の関わりが交流機会となっている", ""],
      ["住環境", "介護ベッド・エアマット導入済み", "", "維持", "現状の環境で介護継続が可能", ""],
      ["介護力・家族", "長男と二人暮らし。長男は日中就労", "日中独居の時間帯がある", "悪化", "日中のサービスを厚くしなければ在宅継続が困難", "長男が働きながら介護を続けられる体制を整えたい"],
    ],
    remarks: "誤嚥性肺炎の予防が最重要課題。訪問診療・訪問看護・訪問介護で状態変化の共有を密に行う。看取り期の意向は長男と継続的に確認する。",
  },
};

// ── 評価表アーキタイプ ────────────────────────────────────────────────────────
const HYOUKA_BY_BAND = {
  light: {
    rows: [
      ["訪問介護 (生活援助)", "Ｈａｎａヘルパーステーションおゆみ野", "負担の大きい掃除・買い物の支援を受け、生活環境を整える", "R8.1〜R8.6", "達成", "週2回の支援により室内は清潔に保たれている。買い物は本人と一緒に行くことで外出機会にもなっている", "継続"],
      ["福祉用具貸与", "Ｈａｎａムツミ福祉用具", "歩行器の使用により屋外を安全に移動できる", "R8.1〜R8.6", "達成", "歩行器使用で転倒なく近所への外出ができている", "継続"],
      ["通所介護", "デイサービスセンターおゆみ野", "週1回の機能訓練により下肢筋力を維持する", "R8.1〜R8.6", "一部達成", "参加は継続できているが、膝痛の強い日は訓練を休むことがある", "継続"],
    ],
    overall: "サービス利用により在宅生活は安定している。膝痛の変動に応じて訓練内容を調整しながら、現行プランを継続する。",
  },
  middle: {
    rows: [
      ["訪問介護 (身体介護)", "Ｈａｎａヘルパーステーションおゆみ野", "入浴・更衣の介助を受けながら、できる動作は自分で行う", "R8.1〜R8.6", "一部達成", "洗身の一部は自分で行えるようになった。移乗は引き続き介助が必要", "継続"],
      ["通所リハビリテーション", "介護老人保健施設ちば", "歩行訓練により屋内を伝い歩きで安全に移動できる", "R8.1〜R8.6", "一部達成", "平行棒内歩行は安定してきたが、屋内独歩は見守りが必要な状態", "継続"],
      ["訪問看護", "訪問看護ステーションみどり", "血圧・血糖の管理により脳梗塞の再発を予防する", "R8.1〜R8.6", "達成", "バイタルは安定して推移。服薬管理も妻と協力してできている", "継続"],
      ["短期入所生活介護", "特別養護老人ホームさくら苑", "月1回の利用により妻の介護負担を軽減する", "R8.3〜R8.6", "達成", "定期利用が定着し、妻の腰痛も落ち着いてきている", "継続"],
    ],
    overall: "リハビリへの意欲が戻りつつあり、身体機能は緩やかに改善している。妻の負担軽減策が機能しており、在宅生活の継続が見込める。短期目標を一段引き上げてプランを更新する。",
  },
  heavy: {
    rows: [
      ["訪問介護 (身体介護)", "Ｈａｎａヘルパーステーションおゆみ野", "食事・排泄介助を受け、日中独居の時間帯も安全に過ごせる", "R8.1〜R8.6", "達成", "1日3回の訪問で日中の安全は確保できている。ムセ込み時の対応も統一できた", "継続"],
      ["訪問入浴介護", "Ｈａｎａ訪問入浴ちば", "週1回の入浴により清潔を保ち、皮膚トラブルを予防する", "R8.1〜R8.6", "達成", "皮膚トラブルなく経過。入浴後の表情が穏やかで本人の楽しみになっている", "継続"],
      ["訪問看護", "訪問看護ステーションみどり", "口腔ケアと健康観察により誤嚥性肺炎を予防する", "R8.1〜R8.6", "一部達成", "肺炎による入院はなかったが、微熱での臨時対応が2回あった。食形態を一段階調整した", "変更"],
      ["福祉用具貸与", "Ｈａｎａムツミ福祉用具", "エアマット使用により褥瘡を予防する", "R8.1〜R8.6", "達成", "褥瘡の発生なく経過している", "継続"],
    ],
    overall: "誤嚥リスクは高い状態が続いているが、多職種の連携により入院なく在宅生活を継続できている。訪問看護の頻度を週2回へ増やし、栄養状態の評価を追加する方向でプランを見直す。",
  },
};

function bandOf(careLevel) {
  if (!careLevel) return "light";
  if (/要介護[45]/.test(careLevel)) return "heavy";
  if (/要介護3/.test(careLevel)) return "middle";
  return "light"; // 要支援・要介護1-2
}

function kadaiContent(band) {
  const a = KADAI_BY_BAND[band];
  return {
    _sample_marker: MARKER,
    created_date: "2026年6月18日",
    overall_factors: a.overall_factors,
    intention: a.intention,
    rows: a.rows.map(([item, factor, cause, possibility, outlook, need]) => ({ item, factor, cause, possibility, outlook, need })),
    remarks: a.remarks,
  };
}

function hyoukaContent(band) {
  const a = HYOUKA_BY_BAND[band];
  return {
    _sample_marker: MARKER,
    created_date: "2026年6月25日",
    meeting_date: "2026年6月24日",
    overall_evaluation: a.overall,
    rows: a.rows.map(([service_type, provider, goal, period, achievement, evaluation, policy]) => ({ service_type, provider, goal, period, achievement, evaluation, policy })),
    remarks: "",
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function pageAll(query) {
  const out = [];
  let offset = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await query.range(offset, offset + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

// 1) fake 利用者 (memos マーカー) → 居宅系のみ
const memoRows = await pageAll(
  sb.from("client_memos").select("client_id").like("body", "%[fake テスト用%").order("id"),
);
const fakeIds = [...new Set(memoRows.map((r) => r.client_id))];
console.log(`fake マーカー付き利用者: ${fakeIds.length} 名`);

const clients = [];
for (let i = 0; i < fakeIds.length; i += 50) {
  const { data, error } = await sb
    .from("clients")
    .select("id, user_number, name, care_level")
    .in("id", fakeIds.slice(i, i + 50));
  if (error) throw error;
  clients.push(...(data ?? []));
}
const kyotaku = clients
  .filter((c) => c.user_number && !c.user_number.startsWith("OY"))
  .sort((a, b) => String(a.user_number).localeCompare(String(b.user_number)))
  .slice(0, TARGET_COUNT);
console.log(`対象 (居宅系 fake 先頭${TARGET_COUNT}名): ${kyotaku.map((c) => c.user_number).join(", ")}`);

// 2) 既存サンプルの検出 (冪等)
const { data: existing, error: exErr } = await sb
  .from("kaigo_report_documents")
  .select("user_id, report_type")
  .in("report_type", ["kadai-seiri", "hyouka"])
  .eq("content->>_sample_marker", MARKER);
if (exErr) throw exErr;
const existKey = new Set((existing ?? []).map((r) => `${r.user_id}:${r.report_type}`));

// 3) INSERT 計画
const inserts = [];
for (const c of kyotaku) {
  const band = bandOf(c.care_level);
  if (!existKey.has(`${c.id}:kadai-seiri`)) {
    inserts.push({
      user_id: c.id,
      report_type: "kadai-seiri",
      title: "課題整理総括表",
      report_month: null,
      care_plan_id: null,
      content: kadaiContent(band),
      status: "draft",
      _label: `${c.user_number} ${c.name} 課題整理 (${band}/${c.care_level ?? "不明"})`,
    });
  }
  if (!existKey.has(`${c.id}:hyouka`)) {
    inserts.push({
      user_id: c.id,
      report_type: "hyouka",
      title: "評価表（サービス担当者会議の評価）（2026年6月）",
      report_month: "2026-06",
      care_plan_id: null,
      content: hyoukaContent(band),
      status: "draft",
      _label: `${c.user_number} ${c.name} 評価表 (${band})`,
    });
  }
}

for (const i of inserts) console.log(`  INSERT ${i._label}`);
console.log(`\n合計: INSERT ${inserts.length} 件 / skip ${kyotaku.length * 2 - inserts.length} 件`);

if (!EXECUTE) {
  console.log("\nDRY RUN のため書き込みなし。--execute で本番実行。");
  process.exit(0);
}

let done = 0;
for (const { _label, ...payload } of inserts) {
  const { error } = await sb.from("kaigo_report_documents").insert(payload);
  if (error) {
    console.error(`❌ INSERT 失敗 (${_label}): ${error.message}`);
    process.exit(1);
  }
  done++;
}
console.log(`INSERT 完了: ${done} 件`);

// 件数確認
const { count, error: cntErr } = await sb
  .from("kaigo_report_documents")
  .select("id", { count: "exact", head: true })
  .eq("content->>_sample_marker", MARKER);
if (cntErr) throw cntErr;
console.log(`✅ 確認: マーカー付き行 = ${count} 件 (期待 ${(existing?.length ?? 0) + done} 件)`);
