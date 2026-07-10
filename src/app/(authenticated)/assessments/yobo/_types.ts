// ─── 介護予防のためのアセスメント (予防版) Form Types ───────────────────────
// 運営基準の 4 領域 (①運動・移動 ②日常生活(家庭生活) ③社会参加・対人関係・
// コミュニケーション ④健康管理) + 基本チェックリスト (25項目) + 総合的な課題。
//
// 要介護版アセスメント (../_types.ts) とは別体系。保存は kaigo_assessments を
// assessment_type='yobo' で共用する (form_data JSONB に本 YoboFormData を格納)。

// ─── 基本情報 ────────────────────────────────────────────────────────────────

export interface YoboBasicInfo {
  /** 相談 / 委託の経路等 */
  referral_route: string;
  /** 本人の希望・意向 */
  user_intention: string;
  /** 家族の希望・意向 */
  family_intention: string;
  /** 現在利用しているサービス（介護保険内） */
  current_services_insurance: string;
  /** 現在利用しているサービス（介護保険外・地域資源等） */
  current_services_other: string;
  /** 住居環境・住まいの状況 */
  housing_situation: string;
  /** 経済状況（生活保護・年金等の特記） */
  economic_situation: string;
}

// ─── 4 領域の共通行構造 ──────────────────────────────────────────────────────
// 各領域は「現状」「課題（できていること／できていないこと）」「本人の意欲・意向」
// を持つ。予防プランでは "自立支援" が主眼なので、意欲・意向を必須項目化する。

export interface YoboDomain {
  /** 現状 (できている／困っている状況の記述) */
  current_state: string;
  /** 課題の分析 (背景・要因を含む) */
  issue_analysis: string;
  /** 本人の意欲・意向 (「〜したい」) */
  motivation: string;
}

// ─── 基本チェックリスト (25項目) ────────────────────────────────────────────
// 各設問は「はい / いいえ」の 2 択。集計欄 (該当項目数) は preview 側で算出。
// key は number 文字列 ("1".."25") で保持し、値は "はい" | "いいえ" | ""。

export type BasicChecklistAnswer = "はい" | "いいえ" | "";
export type BasicChecklist = Record<string, BasicChecklistAnswer>;

export interface BasicChecklistQuestion {
  no: number;
  text: string;
  /** リスク該当となる回答 ("はい" または "いいえ") */
  riskAnswer: BasicChecklistAnswer;
  /** 領域区分ラベル */
  category: string;
}

/** 基本チェックリスト 25 設問 (厚労省様式) */
export const BASIC_CHECKLIST_QUESTIONS: readonly BasicChecklistQuestion[] = [
  { no: 1, text: "バスや電車で1人で外出していますか", riskAnswer: "いいえ", category: "日常生活" },
  { no: 2, text: "日用品の買物をしていますか", riskAnswer: "いいえ", category: "日常生活" },
  { no: 3, text: "預貯金の出し入れをしていますか", riskAnswer: "いいえ", category: "日常生活" },
  { no: 4, text: "友人の家を訪ねていますか", riskAnswer: "いいえ", category: "日常生活" },
  { no: 5, text: "家族や友人の相談にのっていますか", riskAnswer: "いいえ", category: "日常生活" },
  { no: 6, text: "階段を手すりや壁をつたわらずに昇っていますか", riskAnswer: "いいえ", category: "運動器" },
  { no: 7, text: "椅子に座った状態から何もつかまらずに立ち上がっていますか", riskAnswer: "いいえ", category: "運動器" },
  { no: 8, text: "15分位続けて歩いていますか", riskAnswer: "いいえ", category: "運動器" },
  { no: 9, text: "この1年間に転んだことがありますか", riskAnswer: "はい", category: "運動器" },
  { no: 10, text: "転倒に対する不安は大きいですか", riskAnswer: "はい", category: "運動器" },
  { no: 11, text: "6ヶ月間で2〜3kg以上の体重減少がありましたか", riskAnswer: "はい", category: "栄養" },
  { no: 12, text: "身長・体重から算出したBMIが18.5未満ですか", riskAnswer: "はい", category: "栄養" },
  { no: 13, text: "半年前に比べて固いものが食べにくくなりましたか", riskAnswer: "はい", category: "口腔" },
  { no: 14, text: "お茶や汁物等でむせることがありますか", riskAnswer: "はい", category: "口腔" },
  { no: 15, text: "口の渇きが気になりますか", riskAnswer: "はい", category: "口腔" },
  { no: 16, text: "週に1回以上は外出していますか", riskAnswer: "いいえ", category: "閉じこもり" },
  { no: 17, text: "昨年と比べて外出の回数が減っていますか", riskAnswer: "はい", category: "閉じこもり" },
  { no: 18, text: "周りの人から「いつも同じ事を聞く」などの物忘れがあると言われますか", riskAnswer: "はい", category: "認知機能" },
  { no: 19, text: "自分で電話番号を調べて、電話をかけることをしていますか", riskAnswer: "いいえ", category: "認知機能" },
  { no: 20, text: "今日が何月何日かわからない時がありますか", riskAnswer: "はい", category: "認知機能" },
  { no: 21, text: "（ここ2週間）毎日の生活に充実感がない", riskAnswer: "はい", category: "うつ" },
  { no: 22, text: "（ここ2週間）これまで楽しんでやれていたことが楽しめなくなった", riskAnswer: "はい", category: "うつ" },
  { no: 23, text: "（ここ2週間）以前は楽にできていたことが今ではおっくうに感じられる", riskAnswer: "はい", category: "うつ" },
  { no: 24, text: "（ここ2週間）自分が役に立つ人間だと思えない", riskAnswer: "はい", category: "うつ" },
  { no: 25, text: "（ここ2週間）わけもなく疲れたような感じがする", riskAnswer: "はい", category: "うつ" },
] as const;

// ─── 総合的な課題・方針 ──────────────────────────────────────────────────────

export interface YoboSummary {
  /** 総合的な課題（背景・要因を含む生活課題） */
  overall_issues: string;
  /** 目標とする生活（1年後・6ヶ月後の姿） */
  target_life: string;
  /** 具体的な支援の方針 */
  support_policy: string;
  /** 特記事項 */
  special_notes: string;
}

// ─── ルート型 ────────────────────────────────────────────────────────────────

export interface YoboFormData {
  basic_info: YoboBasicInfo;
  /** ① 運動・移動 */
  mobility: YoboDomain;
  /** ② 日常生活（家庭生活） */
  daily_life: YoboDomain;
  /** ③ 社会参加・対人関係・コミュニケーション */
  social: YoboDomain;
  /** ④ 健康管理 */
  health: YoboDomain;
  /** 基本チェックリスト実施フラグ */
  checklist_done: boolean;
  basic_checklist: BasicChecklist;
  summary: YoboSummary;
}

const emptyDomain = (): YoboDomain => ({
  current_state: "",
  issue_analysis: "",
  motivation: "",
});

export function emptyYoboAssessment(): YoboFormData {
  const checklist: BasicChecklist = {};
  for (const q of BASIC_CHECKLIST_QUESTIONS) checklist[String(q.no)] = "";
  return {
    basic_info: {
      referral_route: "",
      user_intention: "",
      family_intention: "",
      current_services_insurance: "",
      current_services_other: "",
      housing_situation: "",
      economic_situation: "",
    },
    mobility: emptyDomain(),
    daily_life: emptyDomain(),
    social: emptyDomain(),
    health: emptyDomain(),
    checklist_done: false,
    basic_checklist: checklist,
    summary: {
      overall_issues: "",
      target_life: "",
      support_policy: "",
      special_notes: "",
    },
  };
}

// ─── 領域メタ (UI / preview 共用) ────────────────────────────────────────────

export const YOBO_DOMAINS: readonly {
  key: "mobility" | "daily_life" | "social" | "health";
  number: string;
  title: string;
  hint: string;
}[] = [
  { key: "mobility", number: "1", title: "運動・移動", hint: "自ら行きたい場所へ移動できるか（起居・屋内外の移動・階段・外出手段等）" },
  { key: "daily_life", number: "2", title: "日常生活（家庭生活）", hint: "家事・食事・排泄・入浴・更衣・買い物・服薬・金銭管理等" },
  { key: "social", number: "3", title: "社会参加・対人関係・コミュニケーション", hint: "地域活動・役割・交流・意思疎通・情報入手等" },
  { key: "health", number: "4", title: "健康管理", hint: "服薬・受診・栄養・口腔・睡眠・運動習慣・生活リズム等" },
] as const;
