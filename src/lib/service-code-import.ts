/**
 * サービスコードマスタ CSV 取込 (世代管理) — 純ロジック
 *
 * /master/service-codes の「CSV取込 (世代管理)」ダイアログから使う。
 * React / supabase に依存しない純関数のみ (= 机上検証スクリプトで直接テスト可能)。
 *
 * 対応形式:
 *   ① 総合事業 単位数表標準マスタ (国保中央会「市町村版 介護予防・日常生活支援
 *      総合事業単位数表マスタインタフェース」準拠の 19 項目 CSV / ヘッダー無し)
 *        項1 証記載保険者番号 (数字6)
 *        項2 サービス種類コード (英数2 例 A2)
 *        項3 サービス項目コード (英数4)
 *        項4 適用開始年月 (YYYYMM)
 *        項5 適用終了年月 (YYYYMM / 999999=未定=現行)
 *        項6 サービス名称 (漢字64 全角空白 padding)
 *        項7 単位数 (数字5 zero-padded ※割引/減算/処遇改善系は率値の場合あり)
 *        項8 算定単位 (01=1回につき / 02=1日につき / 03=1月につき / 05=1週間につき)
 *        項9〜19 (支給限度回数/算定回数制限期間/支給限度額対象区分/予備/給付率/
 *                 利用者負担額/事業対象者・要支援1・要支援2実施区分/国保連合会委託区分/
 *                 作成年月日) は kaigo_service_codes に対応列が無いため「未対応列」
 *                 として無視 (UI に明示)。
 *      既存取込実績: migrations/import_kisarazu_sougou_service_codes.mjs /
 *      import_chiba_6ku_sougou_service_codes.mjs と同じ列解釈。
 *   ② 汎用 (列マッピング手動): コード/名称/単位数 必須、種類/算定単位/区分/備考 任意
 *
 * 世代管理:
 *   kaigo_service_codes は UNIQUE (system, service_code, valid_from) の世代管理。
 *   取込時は「適用開始月 (valid_from)」を必須指定し、既存の現行世代
 *   (valid_from < 指定日 かつ valid_until が NULL or 指定日以降) がある場合は
 *   「旧世代クローズ (valid_until = 適用前月末) + 世代追加」or「スキップ」を選択。
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type ImportServiceSystem = "介護" | "障害" | "総合事業" | "独自" | "地域生活支援";
export type ImportCalcType = "基本" | "加算" | "減算";

/** CSV から抽出した取込候補 1 行 */
export interface ImportCandidate {
  service_category: string;
  service_category_name: string;
  service_code: string;
  service_name: string;
  units: number;
  unit_type: string;
  calculation_type: ImportCalcType;
  notes: string | null;
  /** 元 CSV の行番号 (1-indexed) */
  rowIndex: number;
}

/** パース結果 (形式共通) */
export interface ParseOutcome {
  candidates: ImportCandidate[];
  /** 集約済みの警告メッセージ */
  warnings: string[];
  /** 率値の可能性があるコード (割引/減算/処遇改善系) */
  rateSuspects: string[];
  /** 保険者番号 → 行数 (総合事業標準マスタのみ。汎用は {}) */
  insurerCounts: Record<string, number>;
  /** 未対応列 (無視した列) の一覧 */
  ignoredColumns: { index: number; label: string }[];
  /** データとして認識した行数 (フィルタ前) */
  totalDataRows: number;
  /** フィルタ (保険者/適用終了) で除外した行数 */
  filteredOutCount: number;
  /** 形式不正で無視した行数 */
  invalidCount: number;
}

/** DB 既存世代 (照合に必要な最小限の列) */
export interface ExistingGeneration {
  id: string;
  service_code: string;
  valid_from: string | null;
  valid_until: string | null;
}

export type ExistingMode = "revise" | "skip";

export interface PlanClose {
  id: string;
  service_code: string;
  /** 復元用: クローズ前の valid_until */
  prev_valid_until: string | null;
}

export interface PlanSkip {
  service_code: string;
  service_name: string;
  rowIndex: number;
  reason: string;
}

/** プレビュー用の取込計画 */
export interface ImportPlan {
  /** 新規 (既存世代なし / 既存世代は全て指定日より前にクローズ済) */
  newInserts: ImportCandidate[];
  /** 世代追加 (旧世代クローズを伴う) */
  revisionInserts: ImportCandidate[];
  /** クローズ対象の旧世代行 (復元情報付き) */
  closes: PlanClose[];
  skips: PlanSkip[];
  /** 旧世代の新しい valid_until (= 適用開始月の前日 = 適用前月末) */
  closeDate: string;
}

// ─── 日付 helper ─────────────────────────────────────────────────────────────

/** "YYYY-MM" (月選択 input) → "YYYY-MM-01" */
export function monthToValidFrom(month: string): string | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  return `${month}-01`;
}

/** dateStr の前日 (UTC 演算で TZ ずれ無し)。"2026-06-01" → "2026-05-31" */
export function prevDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

// ─── CSV decode / parse ──────────────────────────────────────────────────────

/** UTF-8 (fatal) → Shift_JIS フォールバックで decode。BOM 除去込み */
export function decodeCsvBuffer(buf: ArrayBuffer): string {
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      text = new TextDecoder("shift-jis").decode(buf);
    } catch {
      text = new TextDecoder("utf-8").decode(buf);
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/** RFC 4180 風 CSV parser (引用符内の改行・カンマ・"" 対応)。空行は除外 */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cur += ch;
    }
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

// ─── 共通 heuristic ──────────────────────────────────────────────────────────

export function heuristicCalcType(name: string, units: number): ImportCalcType {
  if (units < 0) return "減算";
  if (name.includes("減算")) return "減算";
  if (name.includes("加算")) return "加算";
  return "基本";
}

/** 率値 (100分の◯◯ / 1000分の◯◯◯) が単位数欄に入る可能性のあるコードか */
export function isRateSuspect(name: string): boolean {
  return /減算|割引|処遇改善|100分|１００分|1000分|１０００分/.test(name);
}

// ─── ① 総合事業 単位数表標準マスタ ───────────────────────────────────────────

/** 標準マスタの列名 (項1〜19)。項9 以降は kaigo_service_codes に対応列が無く未対応 */
export const SOUGOU_STANDARD_COLUMNS: string[] = [
  "証記載保険者番号",
  "サービス種類コード",
  "サービス項目コード",
  "適用開始年月",
  "適用終了年月",
  "サービス名称",
  "単位数",
  "算定単位",
  "支給限度回数",
  "算定回数制限期間",
  "支給限度額対象区分",
  "予備",
  "給付率",
  "利用者負担額",
  "事業対象者実施区分",
  "要支援1受給者実施区分",
  "要支援2受給者実施区分",
  "国保連合会委託区分",
  "作成年月日",
];

/** 算定単位コード → 表記 (インタフェース仕様書 共通編 コード一覧) */
export const SOUGOU_UNIT_TYPE_MAP: Record<string, string> = {
  "01": "1回につき",
  "02": "1日につき",
  "03": "1月につき",
  "05": "1週間につき",
};

/** 総合事業 サービス種類コード → 名称 (既知分。未知は種類コードを表示) */
export const SOUGOU_CATEGORY_NAMES: Record<string, string> = {
  A1: "訪問型サービス (みなし)",
  A2: "訪問型サービス (独自)",
  A3: "訪問型サービス (独自/定率)",
  A4: "訪問型サービス (独自/定額)",
  A5: "通所型サービス (みなし)",
  A6: "通所型サービス (独自)",
  A7: "通所型サービス (独自/定率)",
  A8: "通所型サービス (独自/定額)",
  A9: "その他生活支援サービス (配食/独自/定率)",
  AA: "その他生活支援サービス (配食/独自/定額)",
  AB: "その他生活支援サービス (見守り/独自/定率)",
  AC: "その他生活支援サービス (見守り/独自/定額)",
  AD: "その他生活支援サービス (その他/独自/定率)",
  AE: "その他生活支援サービス (その他/独自/定額)",
  AF: "介護予防ケアマネジメント",
};

export interface SougouParseOptions {
  /** 保険者番号フィルタ ("" = 全て) */
  insurerFilter: string;
  /** true = 適用終了年月 999999 (現行) の行のみ取込 */
  currentOnly: boolean;
  /** currentOnly=false 時: この年月 (YYYYMM) に有効な行のみ取込 ("" = 全行) */
  targetMonth: string;
  /** サービスコード接頭辞 (市町村区別用。例 "K_") */
  codePrefix: string;
  /** 自治体名 (任意。種類名・備考に付記) */
  municipalityLabel: string;
}

export function parseSougouStandard(
  rows: string[][],
  opts: SougouParseOptions,
): ParseOutcome {
  const candidates: ImportCandidate[] = [];
  const warnings: string[] = [];
  const rateSuspects: string[] = [];
  const insurerCounts: Record<string, number> = {};
  const unknownUnitTypes: Record<string, number> = {};
  let totalDataRows = 0;
  let filteredOutCount = 0;
  let invalidCount = 0;
  let unitsInvalidCount = 0;
  let maxCols = 0;

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    maxCols = Math.max(maxCols, row.length);
    if (row.length < 8) {
      invalidCount++;
      continue;
    }
    const insurer = (row[0] ?? "").trim();
    const cat = (row[1] ?? "").trim();
    const item = (row[2] ?? "").trim();
    const applyStart = (row[3] ?? "").trim();
    const applyEnd = (row[4] ?? "").trim();
    // データ行の判定: 種類コード=英数2桁 / 項目コード=数字4桁 / 適用開始=YYYYMM
    if (
      !/^[0-9A-Z]{2}$/.test(cat) ||
      !/^\d{4}$/.test(item) ||
      !/^\d{6}$/.test(applyStart)
    ) {
      invalidCount++;
      continue;
    }
    totalDataRows++;
    insurerCounts[insurer] = (insurerCounts[insurer] ?? 0) + 1;

    if (opts.insurerFilter && insurer !== opts.insurerFilter) {
      filteredOutCount++;
      continue;
    }
    if (opts.currentOnly) {
      if (applyEnd !== "999999") {
        filteredOutCount++;
        continue;
      }
    } else if (opts.targetMonth) {
      const inRange =
        applyStart <= opts.targetMonth &&
        (applyEnd === "999999" || applyEnd >= opts.targetMonth);
      if (!inRange) {
        filteredOutCount++;
        continue;
      }
    }

    // 項6 サービス名称: 固定長の全角空白 padding を除去
    const name = (row[5] ?? "").replace(/[\s　]+$/g, "").trim();
    if (!name) {
      unitsInvalidCount++;
      continue;
    }
    // 項7 単位数: zero-padded 数字
    const unitsRaw = (row[6] ?? "").trim();
    const units = Number.parseInt(unitsRaw.replace(/[△▲]/g, "-"), 10);
    if (!Number.isFinite(units)) {
      unitsInvalidCount++;
      continue;
    }
    // 項8 算定単位
    const unitTypeCode = (row[7] ?? "").trim();
    let unit_type = SOUGOU_UNIT_TYPE_MAP[unitTypeCode];
    if (!unit_type) {
      unknownUnitTypes[unitTypeCode] = (unknownUnitTypes[unitTypeCode] ?? 0) + 1;
      unit_type = "1回につき";
    }

    const service_code = `${opts.codePrefix}${cat}${item}`;
    const baseCatName = SOUGOU_CATEGORY_NAMES[cat] ?? cat;
    const service_category_name = opts.municipalityLabel
      ? `${baseCatName} (${opts.municipalityLabel})`
      : baseCatName;
    if (isRateSuspect(name)) rateSuspects.push(service_code);

    candidates.push({
      service_category: cat,
      service_category_name,
      service_code,
      service_name: name,
      units,
      unit_type,
      calculation_type: heuristicCalcType(name, units),
      notes:
        `${opts.municipalityLabel ? `${opts.municipalityLabel} ` : ""}総合事業 単位数表標準マスタ取込 保険者番号=${insurer}`,
      rowIndex: ri + 1,
    });
  }

  if (invalidCount > 0) {
    warnings.push(
      `形式不正 (列数不足 / 種類・項目・適用開始のパターン不一致) で ${invalidCount} 行を無視しました`,
    );
  }
  if (unitsInvalidCount > 0) {
    warnings.push(`単位数が数値でない / 名称が空の行を ${unitsInvalidCount} 行スキップしました`);
  }
  for (const [code, n] of Object.entries(unknownUnitTypes)) {
    warnings.push(
      `未知の算定単位コード "${code}" が ${n} 行 (既定値「1回につき」で取込)`,
    );
  }
  if (rateSuspects.length > 0) {
    warnings.push(
      `割引/減算/処遇改善系 ${rateSuspects.length} 件は単位数欄が率値 (100分の◯◯ 等) の可能性があります。取込後にマスタ画面で formula 設定を確認してください (例: ${rateSuspects.slice(0, 5).join(", ")})`,
    );
  }
  const insurers = Object.keys(insurerCounts);
  if (!opts.insurerFilter && insurers.length > 1) {
    warnings.push(
      `複数の保険者番号 (${insurers.join(", ")}) が含まれています。同一コードが衝突するため保険者を絞るか接頭辞で区別してください`,
    );
  }

  // 未対応列 (項9〜19 のうち実際にデータに存在した範囲)
  const ignoredColumns: { index: number; label: string }[] = [];
  for (let c = 8; c < maxCols; c++) {
    ignoredColumns.push({
      index: c,
      label: SOUGOU_STANDARD_COLUMNS[c] ?? `列${c + 1} (仕様外)`,
    });
  }

  return {
    candidates,
    warnings,
    rateSuspects,
    insurerCounts,
    ignoredColumns,
    totalDataRows,
    filteredOutCount,
    invalidCount,
  };
}

// ─── ② 汎用 (手動列マッピング) ───────────────────────────────────────────────

/** 汎用マッピング: 値は CSV 列 index (null = 未使用) */
export interface GenericMapping {
  code: number;
  name: number;
  units: number;
  category: number | null;
  categoryName: number | null;
  unitType: number | null;
  calcType: number | null;
  notes: number | null;
}

/** 汎用マッピングのターゲット項目定義 (ダイアログのプルダウン生成用) */
export const GENERIC_TARGET_FIELDS: {
  key: keyof GenericMapping;
  label: string;
  required: boolean;
}[] = [
  { key: "code", label: "サービスコード", required: true },
  { key: "name", label: "サービス名称", required: true },
  { key: "units", label: "単位数", required: true },
  { key: "category", label: "サービス種類 (2桁)", required: false },
  { key: "categoryName", label: "サービス種類名", required: false },
  { key: "unitType", label: "算定単位", required: false },
  { key: "calcType", label: "区分 (基本/加算/減算)", required: false },
  { key: "notes", label: "備考", required: false },
];

/** system 別 サービス種類 → 名称 (汎用取込の種類名補完用) */
export const CATEGORY_NAME_FALLBACK: Record<
  ImportServiceSystem,
  Record<string, string>
> = {
  介護: {
    "11": "訪問介護",
    "12": "訪問入浴介護",
    "13": "訪問看護",
    "14": "訪問リハビリテーション",
    "15": "通所介護",
    "16": "通所リハビリテーション",
    "17": "福祉用具貸与",
    "18": "特定福祉用具販売",
    "21": "短期入所生活介護",
    "22": "短期入所療養介護(老健)",
    "23": "短期入所療養介護(病院療養型)",
    "27": "特定施設入居者生活介護(短期利用)",
    "31": "居宅療養管理指導",
    "32": "認知症対応型共同生活介護",
    "33": "特定施設入居者生活介護",
    "36": "地域密着型特定施設入居者生活介護",
    "38": "認知症対応型共同生活介護(短期利用)",
    "43": "居宅介護支援",
    "46": "介護予防支援",
    "62": "介護予防訪問入浴介護",
    "63": "介護予防訪問看護",
    "71": "夜間対応型訪問介護",
    "72": "認知症対応型通所介護",
    "73": "小規模多機能型居宅介護",
    "76": "定期巡回・随時対応型訪問介護看護",
    "77": "看護小規模多機能型居宅介護",
    "78": "地域密着型通所介護",
  },
  障害: {
    "11": "居宅介護",
    "12": "重度訪問介護",
    "13": "同行援護",
    "14": "行動援護",
    "15": "療養介護",
    "16": "生活介護",
    "21": "短期入所",
    "22": "重度障害者等包括支援",
    "31": "共同生活援助",
    "41": "自立生活援助",
    "42": "自立訓練(機能訓練)",
    "43": "自立訓練(生活訓練)",
    "44": "就労移行支援",
    "45": "就労継続支援A型",
    "46": "就労継続支援B型",
    "47": "就労定着支援",
  },
  総合事業: SOUGOU_CATEGORY_NAMES,
  独自: {
    "90": "独自サービス",
  },
  地域生活支援: {
    "02": "移動支援",
    "04": "訪問入浴サービス",
    "05": "日中一時支援",
  },
};

export interface GenericParseOptions {
  system: ImportServiceSystem;
  /** 1 行目をヘッダーとして読み飛ばす */
  hasHeader: boolean;
  /** サービスコード接頭辞 (任意) */
  codePrefix: string;
}

export function parseGeneric(
  rows: string[][],
  mapping: GenericMapping,
  opts: GenericParseOptions,
): ParseOutcome {
  const candidates: ImportCandidate[] = [];
  const warnings: string[] = [];
  const rateSuspects: string[] = [];
  let totalDataRows = 0;
  let invalidCount = 0;
  let oddCodeCount = 0;
  let maxCols = 0;

  const at = (row: string[], idx: number | null): string =>
    idx == null || idx < 0 ? "" : (row[idx] ?? "").trim();

  const start = opts.hasHeader ? 1 : 0;
  for (let ri = start; ri < rows.length; ri++) {
    const row = rows[ri];
    maxCols = Math.max(maxCols, row.length);
    totalDataRows++;

    const rawCode = at(row, mapping.code);
    const name = at(row, mapping.name);
    const unitsRaw = at(row, mapping.units);
    const units = Number.parseInt(
      unitsRaw.replace(/,/g, "").replace(/[△▲]/g, "-"),
      10,
    );
    if (!rawCode || !name || !Number.isFinite(units)) {
      invalidCount++;
      continue;
    }
    if (/[\s,、]/.test(rawCode) || rawCode.length > 20) {
      invalidCount++;
      continue;
    }
    if (!/^[0-9A-Za-z_\-]{2,12}$/.test(rawCode)) oddCodeCount++;

    const service_code = `${opts.codePrefix}${rawCode}`;
    const category = at(row, mapping.category) || rawCode.slice(0, 2).toUpperCase();
    const categoryName =
      at(row, mapping.categoryName) ||
      CATEGORY_NAME_FALLBACK[opts.system]?.[category] ||
      category;
    const unitTypeRaw = at(row, mapping.unitType);
    const unit_type =
      SOUGOU_UNIT_TYPE_MAP[unitTypeRaw] ?? (unitTypeRaw || "1回につき");
    const calcRaw = at(row, mapping.calcType);
    const calculation_type: ImportCalcType =
      calcRaw === "基本" || calcRaw === "加算" || calcRaw === "減算"
        ? calcRaw
        : heuristicCalcType(name, units);
    const notes = at(row, mapping.notes) || null;
    if (isRateSuspect(name)) rateSuspects.push(service_code);

    candidates.push({
      service_category: category,
      service_category_name: categoryName,
      service_code,
      service_name: name,
      units,
      unit_type,
      calculation_type,
      notes,
      rowIndex: ri + 1,
    });
  }

  if (invalidCount > 0) {
    warnings.push(
      `必須項目 (コード/名称/単位数) が空・数値不正・コード形式不正の行を ${invalidCount} 行スキップしました`,
    );
  }
  if (oddCodeCount > 0) {
    warnings.push(
      `一般的なコード形式 (英数字 2〜12 桁) に一致しないコードが ${oddCodeCount} 行あります (取込は可能)`,
    );
  }
  if (rateSuspects.length > 0) {
    warnings.push(
      `割引/減算/処遇改善系 ${rateSuspects.length} 件は単位数欄が率値の可能性があります (例: ${rateSuspects.slice(0, 5).join(", ")})`,
    );
  }

  // 未対応列 = マッピングで参照していない列
  const used = new Set(
    [
      mapping.code,
      mapping.name,
      mapping.units,
      mapping.category,
      mapping.categoryName,
      mapping.unitType,
      mapping.calcType,
      mapping.notes,
    ].filter((v): v is number => v != null && v >= 0),
  );
  const header = opts.hasHeader ? rows[0] : null;
  const ignoredColumns: { index: number; label: string }[] = [];
  for (let c = 0; c < maxCols; c++) {
    if (used.has(c)) continue;
    const h = header?.[c]?.trim();
    ignoredColumns.push({ index: c, label: h || `列${c + 1}` });
  }

  return {
    candidates,
    warnings,
    rateSuspects,
    insurerCounts: {},
    ignoredColumns,
    totalDataRows,
    filteredOutCount: 0,
    invalidCount,
  };
}

// ─── 取込計画 (既存世代との照合) ─────────────────────────────────────────────

/**
 * 取込候補を既存世代と照合して計画を立てる。
 *
 * 分類ルール (service_code 単位。system は呼出側で絞り済み):
 *   - ファイル内で同一コードが重複 → 2 件目以降はスキップ
 *   - 同一 valid_from の世代が既存 → スキップ (UNIQUE 制約違反になるため)
 *   - 指定 valid_from より新しい世代が既存 → スキップ (逆順取込は事故の元)
 *   - 現行世代 (valid_from < 指定日 かつ valid_until が NULL or 指定日以降) が既存:
 *       mode=revise → 旧世代を valid_until=適用前月末 でクローズ + 世代追加
 *       mode=skip   → スキップ
 *   - それ以外 (既存なし / 既存は全て指定日より前にクローズ済) → 新規
 */
export function planImport(
  candidates: ImportCandidate[],
  existing: ExistingGeneration[],
  validFrom: string,
  mode: ExistingMode,
): ImportPlan {
  const closeDate = prevDay(validFrom);
  const byCode = new Map<string, ExistingGeneration[]>();
  for (const g of existing) {
    const list = byCode.get(g.service_code);
    if (list) list.push(g);
    else byCode.set(g.service_code, [g]);
  }

  const newInserts: ImportCandidate[] = [];
  const revisionInserts: ImportCandidate[] = [];
  const closes: PlanClose[] = [];
  const skips: PlanSkip[] = [];
  const seen = new Set<string>();
  const closedIds = new Set<string>();

  for (const c of candidates) {
    if (seen.has(c.service_code)) {
      skips.push({
        service_code: c.service_code,
        service_name: c.service_name,
        rowIndex: c.rowIndex,
        reason: "ファイル内で同一コードが重複 (先の行を採用)",
      });
      continue;
    }
    seen.add(c.service_code);

    const gens = byCode.get(c.service_code) ?? [];
    const sameFrom = gens.find((g) => g.valid_from === validFrom);
    if (sameFrom) {
      skips.push({
        service_code: c.service_code,
        service_name: c.service_name,
        rowIndex: c.rowIndex,
        reason: `同一適用開始日 (${validFrom}) の世代が既存`,
      });
      continue;
    }
    const newer = gens.find((g) => g.valid_from != null && g.valid_from > validFrom);
    if (newer) {
      skips.push({
        service_code: c.service_code,
        service_name: c.service_name,
        rowIndex: c.rowIndex,
        reason: `より新しい世代 (valid_from=${newer.valid_from}) が既存`,
      });
      continue;
    }
    // 現行世代 = 指定日より前に始まり、指定日時点でまだ有効な世代
    const currentGens = gens.filter(
      (g) =>
        (g.valid_from == null || g.valid_from < validFrom) &&
        (g.valid_until == null || g.valid_until >= validFrom),
    );
    if (currentGens.length === 0) {
      newInserts.push(c);
      continue;
    }
    if (mode === "skip") {
      skips.push({
        service_code: c.service_code,
        service_name: c.service_name,
        rowIndex: c.rowIndex,
        reason: `現行世代 (valid_from=${currentGens[0].valid_from ?? "未設定"}) が既存 — スキップ指定`,
      });
      continue;
    }
    revisionInserts.push(c);
    for (const g of currentGens) {
      if (closedIds.has(g.id)) continue;
      closedIds.add(g.id);
      closes.push({
        id: g.id,
        service_code: g.service_code,
        prev_valid_until: g.valid_until,
      });
    }
  }

  return { newInserts, revisionInserts, closes, skips, closeDate };
}
