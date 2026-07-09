/**
 * ケアプランデータ連携標準仕様 V4 — 計画書取込パーサ
 *   - 第1表 (居宅サービス計画書(1))         … UP1KYO
 *   - 第2表 (居宅サービス計画書(2)=課題/目標/サービス) … UP2KYO
 *   - 第3表 (週間サービス計画表)            … UP3KYO
 *   - 利用者補足情報                       … UPHOSOKU
 *
 * 用途: 居宅介護支援事業所 (ケアマネ) → 居宅サービス事業所 へ届く計画書 CSV を
 *       取り込み、以下に反映する材料へ変換する。
 *         - 第1〜3表 → kaigo_report_documents (report_type=care-plan-1/2/3) の content jsonb
 *                     ※ 既存の帳票 CSV エクスポータ (careplan-csv-export.ts) が読む
 *                        jsonb シェイプに厳密に一致させる
 *         - 利用者補足 → clients (氏名/フリガナ/生年月日/性別/住所/電話) の更新材料
 *
 * 仕様書 (リポジトリ内に保存):
 *   - migrations/_if_careplan_v4_layout.txt … 各表レイアウト
 *       第1表 144-215行 / 第2表 258-290行 / 第3表 303-333行 / 利用者補足 21-127行
 *       項目対応表 (最も信頼できる項目順) 1296-1527行
 *   - migrations/_if_careplan_v4_spec.txt   … 本文 (命名規約/文字コード/連番)
 *
 * 重要な仕様:
 *   - 文字コード: Shift-JIS (MS932)。File(ArrayBuffer)→UNICODE デコードは呼出側 (UI)。
 *     本モジュールは decode 済み文字列 (parseCsv 済み rows) を受ける。
 *   - CSV: カンマ区切り / フリーテキストは "" 囲い / 内部 " は "" エスケープ / CRLF。
 *   - ヘッダ行判定: 先頭列 (No.1 CSVバージョン) が YYYYMM (6桁数字) でない行はヘッダ/空。
 *   - 突合: 被保険者番号 (No.3) → clients.insured_number (突合不可はスキップ+警告)。
 *
 * ※ 項目長は OCR 抽出により layout.txt では崩れているが、項目「順序」は
 *    項目対応表 (1296-1527行) と各レイアウトの No 昇順で確定できるため、
 *    idx = No - 1 のカラム位置で読む。
 */

// ─── 書式ヘルパ ─────────────────────────────────────────────────────────────

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

export type KeikakushoFileKind =
  | "care-plan-1"
  | "care-plan-2"
  | "care-plan-3"
  | "user-supplement"
  | "unknown";

/**
 * ファイル名で第1表/第2表/第3表/利用者補足を判定する。
 * ファイル名規約 (spec 428-433行):
 *   UP1KYO_ / UP2KYO_ / UP3KYO_ / UPHOSOKU_
 * 旧命名 (第1表/計画書1 等) や UPKHON (利用者基本=別物) も救済する。
 */
export function detectKeikakushoKind(fileName: string): KeikakushoFileKind {
  const fn = fileName.toUpperCase();
  if (fn.includes("UP1KYO") || fn.includes("計画書1") || fn.includes("第1表"))
    return "care-plan-1";
  if (fn.includes("UP2KYO") || fn.includes("計画書2") || fn.includes("第2表"))
    return "care-plan-2";
  if (fn.includes("UP3KYO") || fn.includes("計画書3") || fn.includes("第3表"))
    return "care-plan-3";
  if (fn.includes("UPHOSOKU") || fn.includes("利用者補足"))
    return "user-supplement";
  return "unknown";
}

// ─── 第1表 (UP1KYO) ─────────────────────────────────────────────────────────

/**
 * 第1表レコード (idx = No-1)。layout.txt 144-212行 / 対応表 1300-1333行。
 *   1  CSVバージョン           idx0
 *   2  保険者番号              idx1
 *   3  被保険者番号            idx2
 *   4  作成年月日 (YYYYMMDD)   idx3
 *   5  利用者郵便番号          idx4
 *   6  利用者住所1             idx5
 *   7  利用者住所2             idx6
 *   8  居宅サービス計画作成者氏名  idx7
 *   9  介護支援事業者名         idx8
 *  10  介護支援事業者郵便番号     idx9
 *  11  介護支援事業者住所1       idx10
 *  12  介護支援事業者住所2       idx11
 *  13  介護支援事業者コード       idx12
 *  14  居宅サービス計画作成(変更)日 idx13 (YYYYMMDD)
 *  15  初回居宅サービス計画作成日   idx14 (YYYYMMDD)
 *  16  計画書区分 (11初回/12紹介/21継続/…) idx15
 *  17  認定状況区分            idx16
 *  18  認定日                 idx17
 *  19  認定有効期間開始日        idx18
 *  20  認定有効期間終了日        idx19
 *  21  要介護状態区分           idx20
 *  22  課題分析の結果 (意向)      idx21
 *  23  介護認定審査会の意見       idx22
 *  24  総合的な援助の方針        idx23
 *  25  生活援助中心型の算定理由    idx24 (1/2/3)
 *  26  その他理由              idx25
 *  27  更新業者コード           idx26
 *  28  識別子                 idx27
 */
export interface CarePlan1Parsed {
  insuredNumber: string;
  /** kaigo_report_documents.content (care-plan-1) — careplan-csv-export.ts が読むキー名で保存 */
  content: {
    creation_date: string; // YYYY-MM-DD (No.14 計画作成(変更)日を優先、無ければ No.4 作成年月日)
    initial_creation_date: string; // YYYY-MM-DD (No.15)
    plan_type: string; // 初回/紹介/継続 (No.16 計画書区分)
    care_level: string; // 要介護状態区分 (No.21)
    creator_name: string; // No.8
    issue_analysis: string; // No.22 課題分析の結果
    review_opinion: string; // No.23 介護認定審査会の意見
    overall_policy: string; // No.24 総合的な援助の方針
    living_support_reason: string; // No.25 生活援助中心型の算定理由
  };
}

/** 計画書区分コード → 帳票 plan_type 文字列 (careplan-csv-export の逆写像) */
function planTypeLabel(code: string): string {
  const t = (code ?? "").trim();
  // 11:初回, 12:紹介, 21:継続, 51:初回&紹介, 52:初回&継続, 53:紹介&継続, 54:初回&紹介&継続
  if (t.startsWith("1") && t !== "12") return "初回";
  if (t === "12") return "紹介";
  if (t.startsWith("5")) return "初回"; // 複合はエクスポータが "初回"=1 に落ちるため初回扱い
  return "継続";
}

export interface CarePlan1Result {
  record: CarePlan1Parsed | null;
  warnings: string[];
}

export function parseCarePlan1(rows: string[][]): CarePlan1Result {
  const warnings: string[] = [];
  const data = rows.find(isDataRow);
  if (!data) {
    warnings.push("第1表: データ行が見つかりませんでした");
    return { record: null, warnings };
  }
  const insuredNumber = cell(data, 2);
  if (!insuredNumber) {
    warnings.push("第1表: 被保険者番号が空です — スキップ");
    return { record: null, warnings };
  }
  const creation = ymd8ToIso(cell(data, 13)) || ymd8ToIso(cell(data, 3));
  return {
    record: {
      insuredNumber,
      content: {
        creation_date: creation,
        initial_creation_date: ymd8ToIso(cell(data, 14)),
        plan_type: planTypeLabel(cell(data, 15)),
        care_level: cell(data, 20),
        creator_name: cell(data, 7),
        issue_analysis: cell(data, 21),
        review_opinion: cell(data, 22),
        overall_policy: cell(data, 23),
        living_support_reason: cell(data, 24),
      },
    },
    warnings,
  };
}

// ─── 第2表 (UP2KYO) ─────────────────────────────────────────────────────────

/**
 * 第2表レコード (idx = No-1)。layout.txt 258-288行 / 対応表 1343-1389行。
 *   1  CSVバージョン        idx0
 *   2  保険者番号           idx1
 *   3  被保険者番号         idx2
 *   4  居宅計画書作成年月日   idx3 (YYYYMMDD)
 *   5  居宅サービス計画作成(変更)日 idx4
 *   6  課題NO              idx5
 *   7  課題                idx6  (= 生活全般の解決すべき課題 / needs)
 *   8  援助目標NO           idx7
 *   9  長期目標             idx8
 *  10  短期目標             idx9
 *  11  長期期間             idx10
 *  12  短期期間             idx11
 *  13  援助内容NO           idx12
 *  14  サービス内容          idx13
 *  15  保険対象区分 (Y/N)    idx14
 *  16  サービス種別          idx15
 *  17  サービス事業者コード    idx16
 *  18  サービス事業所名       idx17
 *  19  頻度                idx18
 *  20  実施期間             idx19
 *  21  更新業者コード        idx20
 *  22  識別子              idx21
 *
 * 出力 jsonb は careplan-csv-export.ts / emergency-sheets が読む 2 系統を両方満たす:
 *   - blocks[].goals[].services[] のネスト (generateCarePlan2CSV が読む)
 *   - services[] のフラット (emergency-sheets が content.services を読む)
 */
export interface CarePlan2Service {
  content: string;
  insurance_flag: string; // "○" | "×"
  type: string;
  provider: string;
  frequency: string;
  period: string;
}
export interface CarePlan2Goal {
  short_term_goal: string;
  short_term_period: string;
  services: CarePlan2Service[];
}
export interface CarePlan2Block {
  needs: string;
  long_term_goal: string;
  long_term_period: string;
  goals: CarePlan2Goal[];
}
export interface CarePlan2Parsed {
  insuredNumber: string;
  content: {
    creation_date: string;
    blocks: CarePlan2Block[];
    services: CarePlan2Service[]; // フラット (emergency-sheets 用)
  };
}
export interface CarePlan2Result {
  record: CarePlan2Parsed | null;
  warnings: string[];
}

export function parseCarePlan2(rows: string[][]): CarePlan2Result {
  const warnings: string[] = [];
  const dataRows = rows.filter(isDataRow);
  if (dataRows.length === 0) {
    warnings.push("第2表: データ行が見つかりませんでした");
    return { record: null, warnings };
  }
  const insuredNumber = cell(dataRows[0], 2);
  if (!insuredNumber) {
    warnings.push("第2表: 被保険者番号が空です — スキップ");
    return { record: null, warnings };
  }
  const creation =
    ymd8ToIso(cell(dataRows[0], 4)) || ymd8ToIso(cell(dataRows[0], 3));

  // 課題NO / 援助目標NO をキーに block → goal → service を組み立てる。
  // 帳票は「同一課題は課題行のみ出力し以降空欄」だが、ここでは全行に課題が
  // 埋まっている前提で group。空欄行は直前の値を引き継ぐ (帳票集約の逆処理)。
  const blocks: CarePlan2Block[] = [];
  const flat: CarePlan2Service[] = [];
  const blockByKey = new Map<string, CarePlan2Block>();
  const goalByKey = new Map<string, CarePlan2Goal>();
  let lastKadaiNo = "";
  let lastNeeds = "";
  let lastLongGoal = "";
  let lastLongPeriod = "";
  let lastGoalNo = "";
  let lastShortGoal = "";
  let lastShortPeriod = "";

  for (const c of dataRows) {
    const kadaiNo = cell(c, 5) || lastKadaiNo;
    const needs = cell(c, 6) || lastNeeds;
    const longGoal = cell(c, 8) || lastLongGoal;
    const longPeriod = cell(c, 10) || lastLongPeriod;
    const goalNo = cell(c, 7) || lastGoalNo;
    const shortGoal = cell(c, 9) || lastShortGoal;
    const shortPeriod = cell(c, 11) || lastShortPeriod;
    lastKadaiNo = kadaiNo;
    lastNeeds = needs;
    lastLongGoal = longGoal;
    lastLongPeriod = longPeriod;
    lastGoalNo = goalNo;
    lastShortGoal = shortGoal;
    lastShortPeriod = shortPeriod;

    const svc: CarePlan2Service = {
      content: cell(c, 13),
      insurance_flag: /^y/i.test(cell(c, 14)) || cell(c, 14) === "1" ? "○" : "×",
      type: cell(c, 15),
      provider: cell(c, 17),
      frequency: cell(c, 18),
      period: cell(c, 19),
    };
    if (svc.content) flat.push(svc);

    const bKey = kadaiNo || needs || "_";
    let block = blockByKey.get(bKey);
    if (!block) {
      block = { needs, long_term_goal: longGoal, long_term_period: longPeriod, goals: [] };
      blockByKey.set(bKey, block);
      blocks.push(block);
    }
    const gKey = `${bKey}|${goalNo || shortGoal || "_"}`;
    let goal = goalByKey.get(gKey);
    if (!goal) {
      goal = { short_term_goal: shortGoal, short_term_period: shortPeriod, services: [] };
      goalByKey.set(gKey, goal);
      block.goals.push(goal);
    }
    if (svc.content) goal.services.push(svc);
  }

  return {
    record: { insuredNumber, content: { creation_date: creation, blocks, services: flat } },
    warnings,
  };
}

// ─── 第3表 (UP3KYO) ─────────────────────────────────────────────────────────

/**
 * 第3表レコード (idx = No-1)。layout.txt 303-332行 / 対応表 1448-1474行。
 *   1  CSVバージョン           idx0
 *   2  保険者番号              idx1
 *   3  被保険者番号            idx2
 *   4  週間サービス計画表作成年月日 idx3 (YYYYMMDD)
 *   5  居宅サービス計画作成(変更)日 idx4
 *   6  介護サービス内容 (サービス名) idx5
 *   7  曜日 (月1〜日7)          idx6
 *   8  開始時間 (HHMM)          idx7
 *   9  終了時間 (HHMM)          idx8
 *  10  主な日常生活上の活動       idx9
 *  11  (活動)開始時間           idx10
 *  12  (活動)終了時間           idx11
 *  13  週単位以外のサービス       idx12
 *
 * 出力 jsonb は generateCarePlan3CSV が読む schedule[slot][day] 形へ再構成する。
 *   slot = 開始時刻の時間帯で分類 (early_morning<6 / morning<12 / afternoon<18 /
 *          evening<21 / night)。day = mon..sun。
 *   daily_activities / other_services はフラット (代表値) で持つ。
 */
export interface CarePlan3Parsed {
  insuredNumber: string;
  content: {
    creation_date: string;
    schedule: Record<string, Record<string, string>>;
    daily_activities: string;
    other_services: string;
  };
}
export interface CarePlan3Result {
  record: CarePlan3Parsed | null;
  warnings: string[];
}

const DAY_KEYS = ["", "mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function slotForTime(hhmm: string): string {
  const t = (hhmm ?? "").trim();
  if (!/^\d{4}$/.test(t)) return "morning";
  const h = Number(t.slice(0, 2));
  if (h < 6) return "early_morning";
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  if (h < 21) return "evening";
  return "night";
}

export function parseCarePlan3(rows: string[][]): CarePlan3Result {
  const warnings: string[] = [];
  const dataRows = rows.filter(isDataRow);
  if (dataRows.length === 0) {
    warnings.push("第3表: データ行が見つかりませんでした");
    return { record: null, warnings };
  }
  const insuredNumber = cell(dataRows[0], 2);
  if (!insuredNumber) {
    warnings.push("第3表: 被保険者番号が空です — スキップ");
    return { record: null, warnings };
  }
  const creation =
    ymd8ToIso(cell(dataRows[0], 4)) || ymd8ToIso(cell(dataRows[0], 3));

  const schedule: Record<string, Record<string, string>> = {};
  const dailyActs: string[] = [];
  const others: string[] = [];

  for (const c of dataRows) {
    const service = cell(c, 5);
    const dayNum = Number(cell(c, 6));
    const start = cell(c, 7);
    const daily = cell(c, 9);
    const other = cell(c, 12);
    if (daily) dailyActs.push(daily);
    if (other) others.push(other);
    if (!service || !(dayNum >= 1 && dayNum <= 7)) continue;
    const slot = slotForTime(start);
    const day = DAY_KEYS[dayNum];
    if (!schedule[slot]) schedule[slot] = {};
    // 同 slot×day に複数サービスがある場合は改行連結
    schedule[slot][day] = schedule[slot][day]
      ? `${schedule[slot][day]}\n${service}`
      : service;
  }

  return {
    record: {
      insuredNumber,
      content: {
        creation_date: creation,
        schedule,
        daily_activities: Array.from(new Set(dailyActs)).join(" / "),
        other_services: Array.from(new Set(others)).join(" / "),
      },
    },
    warnings,
  };
}

// ─── 利用者補足 (UPHOSOKU) ──────────────────────────────────────────────────

/**
 * 利用者補足情報レコード (idx = No-1)。layout.txt 21-127行 / 対応表 1300-1341行。
 * 本取込で使うのは clients を補完できる基本属性のみ。
 *   1  CSVバージョン           idx0
 *   2  保険者番号              idx1
 *   3  被保険者番号            idx2
 *   4  居宅サービス計画作成(変更)日 idx3
 *   5  利用者氏名フリガナ        idx4
 *   6  利用者氏名              idx5
 *   7  利用者性別 (1男/2女)     idx6
 *   8  利用者生年月日 (YYYYMMDD) idx7
 *   9  利用者郵便番号           idx8
 *  10  利用者住所1             idx9
 *  11  利用者住所2             idx10
 *  12  利用者電話番号           idx11
 *  13  認定日                 idx12
 *   … (以降 限度額/区分支給限度 等は取込対象外)
 */
export interface UserSupplementParsed {
  insuredNumber: string;
  insurerNumber: string;
  name: string;
  furigana: string;
  gender: string; // "男" | "女" | ""
  birthDate: string; // YYYY-MM-DD | ""
  postalCode: string;
  address: string;
  phone: string;
}
export interface UserSupplementResult {
  record: UserSupplementParsed | null;
  warnings: string[];
}

export function parseUserSupplement(rows: string[][]): UserSupplementResult {
  const warnings: string[] = [];
  const data = rows.find(isDataRow);
  if (!data) {
    warnings.push("利用者補足: データ行が見つかりませんでした");
    return { record: null, warnings };
  }
  const insuredNumber = cell(data, 2);
  if (!insuredNumber) {
    warnings.push("利用者補足: 被保険者番号が空です — スキップ");
    return { record: null, warnings };
  }
  const genderCode = cell(data, 6);
  const addr = [cell(data, 9), cell(data, 10)].filter(Boolean).join("");
  return {
    record: {
      insuredNumber,
      insurerNumber: cell(data, 1),
      name: cell(data, 5),
      furigana: cell(data, 4),
      gender: genderCode === "1" ? "男" : genderCode === "2" ? "女" : "",
      birthDate: ymd8ToIso(cell(data, 7)),
      postalCode: cell(data, 8),
      address: addr,
      phone: cell(data, 11),
    },
    warnings,
  };
}

// ─── 削除レコード ────────────────────────────────────────────────────────────

/**
 * 削除ファイル種別。layout.txt 488-541行 / 216-246行。
 *   - DLTPLAN : 第6表【計画】削除 (計画=予定の取消)  → 4 項目
 *   - DLTJSK  : 第6表【実績】削除 (実績の取消)       → 6 項目
 *   - DLT1KYO : 居宅サービス計画1表 削除 (第2表も連動削除) → 4 項目
 */
export type DeleteFileKind =
  | "delete-plan" // DLTPLAN (第6表/計画=予定)
  | "delete-jisseki" // DLTJSK (第6表/実績)
  | "delete-care-plan" // DLT1KYO (計画書第1表・第2表)
  | "unknown";

export function detectDeleteKind(fileName: string): DeleteFileKind {
  const fn = fileName.toUpperCase();
  if (fn.includes("DLTPLAN")) return "delete-plan";
  if (fn.includes("DLTJSK")) return "delete-jisseki";
  if (fn.includes("DLT1KYO")) return "delete-care-plan";
  return "unknown";
}

/**
 * 削除レコード。全種で先頭 4 項目は共通:
 *   1 CSVバージョン(idx0) / 2 保険者番号(idx1) / 3 被保険者番号(idx2) /
 *   4 削除対象年月(idx3, DLTPLAN/DLTJSK は YYYYMM=サービス提供年月 /
 *                        DLT1KYO は YYYYMMDD=計画作成(変更)日)
 * DLTJSK は追加で 5 サービス事業者コード(idx4) / 6 サービス種類コード(idx5)。
 */
export interface DeleteRecord {
  insuredNumber: string;
  /** DLTPLAN/DLTJSK: YYYYMM / DLT1KYO: YYYYMMDD (削除対象キー) */
  targetKey: string;
  /** DLTJSK のみ: サービス事業者コード(10桁) */
  serviceOfficeCode?: string;
  /** DLTJSK のみ: サービス種類コード(2桁) */
  serviceKind?: string;
}
export interface DeleteParseResult {
  kind: DeleteFileKind;
  records: DeleteRecord[];
  warnings: string[];
}

export function parseDeleteFile(
  fileName: string,
  rows: string[][],
): DeleteParseResult {
  const kind = detectDeleteKind(fileName);
  const warnings: string[] = [];
  const records: DeleteRecord[] = [];
  if (kind === "unknown") {
    return { kind, records, warnings };
  }
  for (const c of rows) {
    if (!isDataRow(c)) continue;
    const insuredNumber = cell(c, 2);
    const targetKey = cell(c, 3);
    if (!insuredNumber || !targetKey) {
      warnings.push("削除: 被保険者番号または削除対象年月が空の行 — スキップ");
      continue;
    }
    if (kind === "delete-jisseki") {
      records.push({
        insuredNumber,
        targetKey,
        serviceOfficeCode: cell(c, 4),
        serviceKind: cell(c, 5),
      });
    } else {
      records.push({ insuredNumber, targetKey });
    }
  }
  return { kind, records, warnings };
}

/** 削除対象年月 (YYYYMM) → { from, to } ISO 日付範囲。不正は null */
export function ymToDateRange(ym: string): { from: string; to: string } | null {
  const t = (ym ?? "").trim();
  if (!/^\d{6}$/.test(t)) return null;
  const y = Number(t.slice(0, 4));
  const m = Number(t.slice(4, 6));
  if (m < 1 || m > 12) return null;
  const last = new Date(y, m, 0).getDate();
  const mm = t.slice(4, 6);
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}
