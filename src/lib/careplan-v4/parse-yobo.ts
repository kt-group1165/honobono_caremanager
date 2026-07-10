/**
 * ケアプランデータ連携標準仕様 V4 — 介護予防 取込パーサ
 *   - 介護予防サービス・支援計画書              … UPYOBO
 *   - 介護予防サービス・支援計画書（別表）支援計画 … UPYOBO_SUB
 *   - 介護予防支援 利用者基本情報                … UPKIHON
 *   - 介護予防サービス・支援計画書 削除          … DLTYOBO
 *
 * 用途: 令和6年7月改定で連携対象に追加された「介護予防」系 CSV を取り込み、
 *       以下に反映する材料へ変換する。
 *         - UPYOBO(+SUB) → kaigo_report_documents (report_type='yobo-care-plan') の content jsonb
 *                          ※ B チームが実装済の PrintYoboCarePlan / EditFormYoboCarePlan が
 *                             読む jsonb シェイプに厳密に一致させる
 *                             (reports/[type]/reports-content.tsx buildContent('yobo-care-plan'))
 *         - UPKIHON      → clients (氏名/フリガナ/生年月日/性別/住所/電話) の補完材料
 *                          (居宅の UPHOSOKU と同様。空欄のみ補完で既存値は壊さない)
 *
 * 仕様書 (リポジトリ内に保存):
 *   - migrations/_if_careplan_v4_layout.txt
 *       介護予防支援 利用者基本情報 (UPKIHON)             … 705-847行  (No.1〜71)
 *       介護予防サービス・支援計画書 (UPYOBO)             … 976-1162行 (No.1〜57)
 *       介護予防サービス・支援計画書（別表）支援計画(UPYOBO_SUB) … 1201-1276行 (No.1〜17)
 *       介護予防サービス・支援計画書 削除 (DLTYOBO)       … 1165-1198行 (No.1〜4)
 *       (補足) 別表の構成について / 記載例                 … 1782-1839行
 *   - migrations/_if_careplan_v4_spec.txt … 本文 (命名規約/文字コード/連番)
 *
 * ★ 重要 — OCR 由来の項目長崩れについて:
 *   layout.txt は PDF 抽出のため「項目長」「書式・選択肢」列が行ズレしており信頼できない。
 *   ただし各レイアウトの「No. + 日本語名称」列は連番で読めるため、
 *   Phase1-3 (parse-riyouhyou / parse-keikakusho) と同じ流儀で
 *     idx = No - 1
 *   のカラム位置で読む。項目長ではなく「項目順」を正とする。
 *   要検証点はファイル末尾コメント参照。
 *
 * 重要な仕様:
 *   - 文字コード: Shift-JIS (MS932)。File(ArrayBuffer)→UNICODE デコードは呼出側 (UI)。
 *     本モジュールは decode 済み文字列 (parseCsv 済み rows) を受ける。
 *   - CSV: カンマ区切り / フリーテキストは "" 囲い / 内部 " は "" エスケープ / CRLF。
 *   - ヘッダ行判定: 先頭列 (No.1 CSVバージョン) が YYYYMM (6桁数字) でない行はヘッダ/空。
 *   - 突合: 被保険者番号 (No.3) → clients.insured_number (突合不可はスキップ+警告)。
 */

// parseCsv / 削除日付レンジ等の共通ユーティリティは既存モジュールを再利用する
// (別紙レイアウトの CSV 仕様は全ファイル共通のため)。
export { parseCsv } from "./parse-riyouhyou";

// ─── 書式ヘルパ (parse-keikakusho と同一挙動) ────────────────────────────────

/** 'YYYYMMDD' → 'YYYY-MM-DD'。不正/空/'00000000' は空文字 */
function ymd8ToIso(s: string): string {
  const t = (s ?? "").trim();
  if (!/^\d{8}$/.test(t) || t === "00000000") return "";
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

/** 先頭列が CSVバージョン (YYYYMM=6桁数字) のデータ行か */
function isDataRow(c: string[]): boolean {
  return /^\d{6}$/.test((c[0] ?? "").trim());
}

const cell = (c: string[], i: number): string => (c[i] ?? "").trim();

// ─── ファイル種別判定 ────────────────────────────────────────────────────────

export type YoboFileKind =
  | "yobo-plan" // UPYOBO         : 介護予防サービス・支援計画書 (本体)
  | "yobo-plan-sub" // UPYOBO_SUB : 同 (別表) 支援計画
  | "yobo-kihon" // UPKIHON       : 介護予防支援 利用者基本情報
  | "yobo-delete" // DLTYOBO      : 介護予防計画書 削除
  | "unknown";

/**
 * ファイル名で介護予防系 4 種を判定する。
 * ファイル名規約 (layout.txt):
 *   UPYOBO_ / UPYOBO_SUB_ / UPKIHON_ / DLTYOBO_
 * ※ UPYOBO_SUB は UPYOBO を含むため SUB を先に判定する。
 * ※ UPKIHON_SUB1/SUB2 (別表1 タイムスケジュール / 別表2 現病歴) は本取込では
 *    利用者マスタ補完に不要なため yobo-kihon 扱いにはせず unknown (スキップ) とする。
 */
export function detectYoboKind(fileName: string): YoboFileKind {
  const fn = fileName.toUpperCase();
  if (fn.includes("DLTYOBO")) return "yobo-delete";
  if (fn.includes("UPYOBO_SUB") || fn.includes("UPYOBO̲SUB")) return "yobo-plan-sub";
  if (fn.includes("UPYOBO")) return "yobo-plan";
  // UPKIHON 本体のみ (SUB1/SUB2 は除外)
  if (fn.includes("UPKIHON")) {
    if (fn.includes("UPKIHON_SUB") || fn.includes("UPKIHON̲SUB") || fn.includes("UPKIHON_IMAGE"))
      return "unknown";
    return "yobo-kihon";
  }
  return "unknown";
}

// ─── content jsonb の型 (B チームの yobo-care-plan と一致) ───────────────────
// reports/[type]/reports-content.tsx の YoboArea / YoboGoal / buildContent と同一キー。

export interface YoboArea {
  area: string;
  current_status: string;
  intention: string;
  area_issue: string;
}
export interface YoboGoal {
  comprehensive_issue: string;
  proposal: string;
  proposal_intention: string;
  goal: string;
  support_point: string;
  self_care: string;
  insurance_service: string;
  service_type: string;
  provider: string;
  period: string;
}
export interface YoboCarePlanContent {
  user_name: string;
  birth_date: string;
  cert_date: string;
  cert_period: string;
  care_level: string;
  plan_stage: string; // 初回 / 紹介 / 継続
  cert_status: string; // 認定済 / 申請中
  target_life_day: string;
  target_life_year: string;
  creator_name: string;
  office_name: string;
  entrusted_office_name: string;
  entrusted_creator_name: string;
  creation_date: string;
  initial_creation_date: string;
  areas: YoboArea[];
  goals: YoboGoal[];
  health_status: string;
  needed_programs: string;
  overall_policy: string;
}

// アセスメント領域は標準様式の 4 区分固定 (B チーム YOBO_ASSESSMENT_AREAS と一致)
const YOBO_ASSESSMENT_AREAS = [
  "運動・移動について",
  "日常生活（家庭生活）について",
  "社会参加・対人関係・コミュニケーションについて",
  "健康管理について",
] as const;

// 事業プログラム (基本チェックリスト該当) の要否コード → ラベル
// (B チーム YOBO_PROGRAM_OPTIONS と一致)。UPYOBO No.49〜54 の「要否」6 項目に対応。
const YOBO_PROGRAM_LABELS = [
  "運動器の機能向上", // 49 運動不足
  "栄養改善", // 50 栄養改善
  "口腔機能の向上", // 51 口腔内ケア
  "閉じこもり予防・支援", // 52 閉じこもり予防
  "認知症予防・支援", // 53 物忘れ予防
  "うつ予防・支援", // 54 うつ予防
] as const;

// ─── 認定状況区分 / 要支援状態区分 コード表 (layout.txt コード表) ─────────────

/** 認定状況区分コード → ラベル (UPYOBO No.13)。1:申請中 / 2:認定済 */
function certStatusLabel(code: string): string {
  const t = (code ?? "").trim();
  if (t === "2") return "認定済";
  if (t === "1") return "申請中";
  return "";
}

/**
 * 要支援状態区分コード → ラベル (UPYOBO No.14 = 「1:要支援１, 2:要支援２, 3:地域支援事業」)。
 * ※ UPYOBO 本体は No.14 が要支援状態区分 (1/2/3)。要介護状態区分コード表 (06/12/13...) とは別。
 */
function shienStatusLabel(code: string): string {
  const t = (code ?? "").trim();
  if (t === "1") return "要支援１";
  if (t === "2") return "要支援２";
  if (t === "3") return "地域支援事業";
  return "";
}

/**
 * 計画書区分コード → 計画区分ラベル (UPYOBO No.12)。
 * 11:初回, 12:紹介, 21:継続, 51:初回＆紹介, 52:初回＆継続, 53:紹介＆継続, 54:初回＆紹介＆継続。
 * EditForm の select は 初回/紹介/継続 の 3 値なので複合は代表値へ落とす。
 */
function planStageLabel(code: string): string {
  const t = (code ?? "").trim();
  if (t === "12") return "紹介";
  if (t.startsWith("1") || t.startsWith("5")) return "初回"; // 11 / 51 / 52 / 54
  if (t === "53") return "紹介";
  return "継続"; // 21 その他
}

// ─── UPYOBO 本体 (介護予防サービス・支援計画書) ──────────────────────────────

/**
 * UPYOBO 本体レコード (idx = No-1)。layout.txt 991-1160行。
 *   1  CSVバージョン           idx0
 *   2  保険者番号              idx1
 *   3  被保険者番号            idx2
 *   4  計画作成(変更)日 (YYYYMMDD) idx3
 *   5  計画種類 (1:予防支援/2:ケアマネジメント) idx4
 *   6  委託の有無 (1:自前/2:委託) idx5
 *   7  整理番号                idx6
 *   8  利用者名                idx7
 *   9  認定年月日 (YYYYMMDD)   idx8
 *  10  認定有効期間開始日 (YYYYMMDD) idx9
 *  11  認定有効期間終了日 (YYYYMMDD) idx10
 *  12  計画書区分 (11/12/21/51..) idx11
 *  13  認定状況区分 (1申請中/2認定済) idx12
 *  14  要支援状態区分 (1/2/3)    idx13
 *  15  計画作成者氏名(地域包括担当) idx14
 *  16  計画作成者氏名(担当ケアマネ) idx15
 *  17  計画作成者事業者・事業所名  idx16
 *  18  計画作成者事業者・事業所住所 idx17
 *  19  計画作成者事業者・事業所電話 idx18
 *  20  初回作成日 (YYYYMMDD)    idx19
 *  21  担当地域包括支援センター   idx20
 *  22  目標とする生活(1日)       idx21
 *  23  目標とする生活(1年)       idx22
 *  24  【運動・移動】現在の状況    idx23
 *  25  【運動・移動】本人・家族の意欲・意向 idx24
 *  26  【運動・移動】課題の有無    idx25
 *  27  【運動・移動】課題(背景・原因) idx26
 *  28  【日常生活(家庭生活)】現在の状況 idx27
 *  29  【日常生活(家庭生活)】意欲・意向 idx28
 *  30  【日常生活(家庭生活)】課題の有無 idx29
 *  31  【日常生活(家庭生活)】課題(背景・原因) idx30
 *  32  【社会参加…】現在の状況    idx31
 *  33  【社会参加…】意欲・意向    idx32
 *  34  【社会参加…】課題の有無    idx33
 *  35  【社会参加…】課題(背景・原因) idx34
 *  36  【健康管理】現在の状況     idx35
 *  37  【健康管理】意欲・意向     idx36
 *  38  【健康管理】課題の有無     idx37
 *  39  【健康管理】課題(背景・原因) idx38
 *  40  健康状態の留意点         idx39
 *  41  妥当な支援の実施に向けた方針 idx40
 *  42  総合的な方針            idx41
 *  43〜48 基本チェックリスト該当数(運動/栄養/口腔/閉じこもり/物忘れ/うつ) idx42〜47
 *  49〜54 事業プログラムの要否(運動/栄養/口腔/閉じこもり/物忘れ/うつ) idx48〜53
 *  55  地域包括支援センター意見   idx54
 *  56  同意日 (YYYYMMDD)       idx55
 *  57  同意者氏名             idx56
 */
export interface YoboPlanParsed {
  insuredNumber: string;
  insurerNumber: string;
  /** kaigo_report_documents.content (yobo-care-plan) — 本体由来のフィールドのみ埋める */
  content: Omit<YoboCarePlanContent, "goals" | "birth_date"> & { goals: YoboGoal[]; birth_date: string };
}
export interface YoboPlanResult {
  record: YoboPlanParsed | null;
  warnings: string[];
}

/** 課題有無コード (1:有 / 2:無) を area_issue の接頭に付与しつつ背景・原因を連結 */
function areaIssueText(umuCode: string, reason: string): string {
  const u = (umuCode ?? "").trim();
  const r = (reason ?? "").trim();
  const prefix = u === "1" ? "有" : u === "2" ? "無" : "";
  if (prefix && r) return `${prefix}：${r}`;
  return prefix || r;
}

export function parseYoboPlan(rows: string[][]): YoboPlanResult {
  const warnings: string[] = [];
  const data = rows.find(isDataRow);
  if (!data) {
    warnings.push("介護予防計画書(UPYOBO): データ行が見つかりませんでした");
    return { record: null, warnings };
  }
  const insuredNumber = cell(data, 2);
  if (!insuredNumber) {
    warnings.push("介護予防計画書(UPYOBO): 被保険者番号が空です — スキップ");
    return { record: null, warnings };
  }

  // アセスメント 4 領域: 現在の状況(24/28/32/36) / 意欲・意向(25/29/33/37) /
  //   課題の有無(26/30/34/38) + 課題背景(27/31/35/39)
  const areaBaseIdx = [23, 27, 31, 35]; // 各領域の「現在の状況」の idx
  const areas: YoboArea[] = YOBO_ASSESSMENT_AREAS.map((label, k) => {
    const base = areaBaseIdx[k];
    return {
      area: label,
      current_status: cell(data, base),
      intention: cell(data, base + 1),
      area_issue: areaIssueText(cell(data, base + 2), cell(data, base + 3)),
    };
  });

  // 事業プログラムの要否 (No.49〜54 = idx48〜53)。「1:要」のものをラベル化して ／ 連結。
  const programs: string[] = [];
  for (let i = 0; i < YOBO_PROGRAM_LABELS.length; i++) {
    const code = cell(data, 48 + i);
    if (code === "1") programs.push(YOBO_PROGRAM_LABELS[i]);
  }

  const certStart = ymd8ToIso(cell(data, 9));
  const certEnd = ymd8ToIso(cell(data, 10));
  const certPeriod =
    certStart && certEnd ? `${certStart}　〜　${certEnd}` : certStart || certEnd || "";

  return {
    record: {
      insuredNumber,
      insurerNumber: cell(data, 1),
      content: {
        user_name: cell(data, 7),
        birth_date: "",
        cert_date: ymd8ToIso(cell(data, 8)),
        cert_period: certPeriod,
        care_level: shienStatusLabel(cell(data, 13)),
        plan_stage: planStageLabel(cell(data, 11)) || "継続",
        cert_status: certStatusLabel(cell(data, 12)) || "認定済",
        target_life_day: cell(data, 21),
        target_life_year: cell(data, 22),
        // 計画作成者: 担当ケアマネ名(No.16) を優先、無ければ地域包括担当(No.15)
        creator_name: cell(data, 15) || cell(data, 14),
        office_name: cell(data, 16),
        entrusted_office_name: cell(data, 5) === "2" ? cell(data, 16) : "",
        entrusted_creator_name: cell(data, 5) === "2" ? cell(data, 15) : "",
        creation_date: ymd8ToIso(cell(data, 3)),
        initial_creation_date: ymd8ToIso(cell(data, 19)),
        areas,
        goals: [], // SUB (別表) から後で結合
        // 健康状態: No.40 健康状態の留意点。無ければ No.41 妥当な支援の方針。
        health_status: cell(data, 39) || cell(data, 40),
        needed_programs: programs.join("／"),
        overall_policy: cell(data, 41),
      },
    },
    warnings,
  };
}

// ─── UPYOBO_SUB (別表) 支援計画 → goals[] ────────────────────────────────────

/**
 * UPYOBO_SUB レコード (idx = No-1)。layout.txt 1218-1274行。
 *   1  CSVバージョン           idx0
 *   2  保険者番号              idx1
 *   3  被保険者番号            idx2
 *   4  計画作成(変更)日         idx3
 *   5  課題ＮＯ                idx4
 *   6  総合的課題              idx5
 *   7  課題に対する目標と具体策の提案 idx6
 *   8  具体策についての意向 本人・家族 idx7
 *   9  目標                   idx8
 *  10  支援計画ＮＯ            idx9
 *  11  【支援計画】目標についての支援のポイント idx10
 *  12  【支援計画】本人等のセルフケア/家族/インフォーマル idx11
 *  13  【支援計画】介護保険サービス又は地域支援事業 idx12
 *  14  利用サービスＮＯ         idx13
 *  15  【利用サービス】サービス種別 idx14
 *  16  【利用サービス】事業所(利用先) idx15
 *  17  【利用サービス】期間      idx16
 *
 * 記載例の連番規則 (layout.txt 1836-1839行):
 *   - 同一課題NOに複数の支援計画を含める場合、課題NOを同一・支援計画NOを連番にし、
 *     課題行の NO 以外の項目は最初の行のみ記載 (2行目以降は空欄)。
 *   - 同一支援計画NOに複数の利用サービスを含める場合も同様に空欄継続。
 *   本パーサはその「空欄=直前値の継続」を逆処理し、1 (課題×支援計画×利用サービス) 行
 *   = 1 goal (帳票の 1 行) として展開する。
 */
export interface YoboSubResult {
  insuredNumber: string;
  goals: YoboGoal[];
  warnings: string[];
}

export function parseYoboPlanSub(rows: string[][]): YoboSubResult {
  const warnings: string[] = [];
  const dataRows = rows.filter(isDataRow);
  if (dataRows.length === 0) {
    warnings.push("介護予防計画書別表(UPYOBO_SUB): データ行が見つかりませんでした");
    return { insuredNumber: "", goals: [], warnings };
  }
  const insuredNumber = cell(dataRows[0], 2);
  if (!insuredNumber) {
    warnings.push("介護予防計画書別表(UPYOBO_SUB): 被保険者番号が空です — スキップ");
    return { insuredNumber: "", goals: [], warnings };
  }

  const goals: YoboGoal[] = [];
  // 空欄継続 (連番規則の逆処理) 用の直前値
  let lastComprehensive = "";
  let lastProposal = "";
  let lastProposalIntention = "";
  let lastGoal = "";
  let lastSupportPoint = "";
  let lastSelfCare = "";
  let lastInsuranceService = "";

  for (const c of dataRows) {
    const comprehensive = cell(c, 5) || lastComprehensive;
    const proposal = cell(c, 6) || lastProposal;
    const proposalIntention = cell(c, 7) || lastProposalIntention;
    const goal = cell(c, 8) || lastGoal;
    const supportPoint = cell(c, 10) || lastSupportPoint;
    const selfCare = cell(c, 11) || lastSelfCare;
    const insuranceService = cell(c, 12) || lastInsuranceService;
    lastComprehensive = comprehensive;
    lastProposal = proposal;
    lastProposalIntention = proposalIntention;
    lastGoal = goal;
    lastSupportPoint = supportPoint;
    lastSelfCare = selfCare;
    lastInsuranceService = insuranceService;

    goals.push({
      comprehensive_issue: comprehensive,
      proposal,
      proposal_intention: proposalIntention,
      goal,
      support_point: supportPoint,
      self_care: selfCare,
      insurance_service: insuranceService,
      service_type: cell(c, 14),
      provider: cell(c, 15),
      period: cell(c, 16),
    });
  }

  return { insuredNumber, goals, warnings };
}

// ─── UPKIHON (介護予防支援 利用者基本情報) → clients 補完材料 ─────────────────

/**
 * UPKIHON レコード (idx = No-1)。layout.txt 708-844行。
 * 本取込では clients を補完できる基本属性のみ使う (居宅の UPHOSOKU 相当)。
 *   1  CSVバージョン           idx0
 *   2  保険者番号              idx1
 *   3  被保険者番号            idx2
 *   4  相談日 (YYYYMMDD)       idx3
 *   …
 *  14  利用者氏名ﾌﾘｶﾞﾅ         idx13
 *  15  利用者氏名              idx14
 *  16  利用者性別 (1:男/2:女)   idx15
 *  17  利用者生年月日 (YYYYMMDD) idx16
 *  18  利用者住所              idx17
 *  19  利用者電話番号          idx18
 *  20  利用者Fax番号           idx19
 *   … (以降 自立度/障害認定/経済状況/緊急連絡先 等は clients 補完対象外)
 *
 * ★ 要検証: 利用者氏名/フリガナ/性別/生年月日/住所/電話 の idx は OCR で列位置が
 *    崩れており No.11〜20 付近の並びが本文と食い違う (末尾コメント参照)。
 *    突合キー (No.3 被保険者番号) は確実だが、属性補完は空欄補完のみに留め、
 *    誤取込リスクを避けるため既存値は決して上書きしない (呼出側で patch 制御)。
 */
export interface YoboKihonParsed {
  insuredNumber: string;
  insurerNumber: string;
  name: string;
  furigana: string;
  gender: string; // "男" | "女" | ""
  birthDate: string; // YYYY-MM-DD | ""
  address: string;
  phone: string;
}
export interface YoboKihonResult {
  record: YoboKihonParsed | null;
  warnings: string[];
}

export function parseYoboKihon(rows: string[][]): YoboKihonResult {
  const warnings: string[] = [];
  const data = rows.find(isDataRow);
  if (!data) {
    warnings.push("介護予防利用者基本情報(UPKIHON): データ行が見つかりませんでした");
    return { record: null, warnings };
  }
  const insuredNumber = cell(data, 2);
  if (!insuredNumber) {
    warnings.push("介護予防利用者基本情報(UPKIHON): 被保険者番号が空です — スキップ");
    return { record: null, warnings };
  }
  const genderCode = cell(data, 15);
  return {
    record: {
      insuredNumber,
      insurerNumber: cell(data, 1),
      furigana: cell(data, 13),
      name: cell(data, 14),
      gender: genderCode === "1" ? "男" : genderCode === "2" ? "女" : "",
      birthDate: ymd8ToIso(cell(data, 16)),
      address: cell(data, 17),
      phone: cell(data, 18),
    },
    warnings,
  };
}

// ─── DLTYOBO (介護予防計画書 削除) ───────────────────────────────────────────

/**
 * DLTYOBO レコード (idx = No-1)。layout.txt 1180-1195行。
 *   1 CSVバージョン(idx0) / 2 保険者番号(idx1) / 3 被保険者番号(idx2) /
 *   4 計画作成(変更)日 (YYYYMMDD, idx3) = 削除対象キー
 */
export interface YoboDeleteRecord {
  insuredNumber: string;
  /** 計画作成(変更)日 (YYYYMMDD) */
  targetKey: string;
}
export interface YoboDeleteResult {
  records: YoboDeleteRecord[];
  warnings: string[];
}

export function parseYoboDelete(rows: string[][]): YoboDeleteResult {
  const warnings: string[] = [];
  const records: YoboDeleteRecord[] = [];
  for (const c of rows) {
    if (!isDataRow(c)) continue;
    const insuredNumber = cell(c, 2);
    const targetKey = cell(c, 3);
    if (!insuredNumber) {
      warnings.push("介護予防計画書削除(DLTYOBO): 被保険者番号が空の行 — スキップ");
      continue;
    }
    records.push({ insuredNumber, targetKey });
  }
  return { records, warnings };
}
