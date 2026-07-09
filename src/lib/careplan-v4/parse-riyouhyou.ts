/**
 * ケアプランデータ連携標準仕様 V4 — 利用票取込パーサ (第6表【計画】/ 第7表【別表】)
 *
 * 用途: 居宅介護支援事業所 (ケアマネ) → 居宅サービス事業所 (訪問介護等) へ
 *       送られてくる「サービス利用票 (第6表【計画=予定】)」および
 *       「サービス利用票別表 (第7表)」の CSV を取り込み、
 *         - 第6表 → kaigo_visit_schedule の予定 (status='scheduled')
 *         - 第7表 → kaigo_monthly_plan_units の計画単位数
 *       に反映する材料へ変換する。
 *
 * 仕様書 (リポジトリ内に保存):
 *   - migrations/_if_careplan_v4_layout.txt … 第6表 (335行〜) / 第7表 (542行〜) レイアウト
 *   - migrations/_if_careplan_v4_spec.txt   … 本文 (命名規約/文字コード)
 *
 * 項目順の「正」は Phase1 で作成した build-jisseki.ts (第6表 No.1〜25)。
 *   実績 (UPJSK) と計画 (UPPLAN) は同一フォーマットのため、
 *   本パーサの列 index は build-jisseki の No 対応と厳密に一致させている。
 *
 * 重要な仕様:
 *   - 文字コード: Shift-JIS (MS932)。File(ArrayBuffer) を encoding-japanese で
 *     SJIS→UNICODE デコードするのは呼出側 (UI)。本モジュールは decode 済み文字列を受ける。
 *   - CSV: カンマ区切り / フリーテキストは "" 囲い / 内部 " は "" エスケープ / CRLF。
 *   - ファイル種別: ファイル名 (UPPLAN=計画第6表 / UPSIKYU=別表第7表) + 内容で判定。
 */

// ─── CSV 低レベルパース ──────────────────────────────────────────────────────

/**
 * CSV 1 レコード (論理行) を配列に分解する。
 * フリーテキスト内の CRLF も "" 内なら 1 フィールドとして跨ぐため、
 * 文字列全体をステートマシンで走査してレコード境界を判定する。
 */
export function parseCsv(text: string): string[][] {
  // 先頭 BOM 除去
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false; // 空行スキップ判定用

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      sawAny = true;
    } else if (ch === "\r") {
      // CRLF / CR の行末。次が \n ならまとめて処理
      if (text[i + 1] === "\n") i++;
      row.push(field);
      if (sawAny || row.length > 1 || field !== "") rows.push(row);
      row = [];
      field = "";
      sawAny = false;
    } else if (ch === "\n") {
      row.push(field);
      if (sawAny || row.length > 1 || field !== "") rows.push(row);
      row = [];
      field = "";
      sawAny = false;
    } else {
      field += ch;
      sawAny = true;
    }
  }
  // 末尾 (改行で終わらないファイル)
  if (sawAny || field !== "" || row.length > 0) {
    row.push(field);
    // 完全な空行 ([""]) は捨てる
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
  }
  return rows;
}

// ─── ファイル種別判定 ────────────────────────────────────────────────────────

export type RiyouhyouFileKind = "table-6-plan" | "table-7-betsu" | "unknown";

/**
 * ファイル名 + 内容で第6表(計画)/第7表(別表)を判定する。
 *   - 第6表(計画): ファイル名 UPPLAN_ / 実績側 UPJSK_ は取込対象外だが同フォーマット
 *   - 第7表(別表): ファイル名 UPSIKYU_
 * ファイル名でわからない場合は列数・内容から推定 (第7表は 30 列超 & 区分支給列を持つ)。
 */
export function detectRiyouhyouKind(
  fileName: string,
  rows: string[][],
): RiyouhyouFileKind {
  const fn = fileName.toUpperCase();
  if (fn.includes("UPPLAN")) return "table-6-plan";
  if (fn.includes("UPSIKYU")) return "table-7-betsu";
  // 内容推定: 第7表は列数が多い (37 項目) / 第6表は 25 項目
  if (rows.length > 0) {
    const maxCols = Math.max(...rows.map((r) => r.length));
    if (maxCols >= 30) return "table-7-betsu";
    if (maxCols >= 20 && maxCols <= 27) return "table-6-plan";
  }
  return "unknown";
}

// ─── 第6表【計画】パース ─────────────────────────────────────────────────────

/**
 * 第6表【計画】の 1 レコード。build-jisseki.ts の No 対応に厳密に一致させる。
 *   No.1  CSVバージョン        → csvVersion   (idx 0)
 *   No.3  被保険者番号          → insuredNumber(idx 2)
 *   No.5  対象年月 (YYYYMM)     → targetYm     (idx 4)
 *   No.8  単位数                → units        (idx 7)
 *   No.10 サービス利用日(YYYYMMDD)→ serviceDate (idx 9)
 *   No.12 サービス開始時刻(HHMM) → startTime    (idx 11)
 *   No.13 サービス終了時刻(HHMM) → endTime      (idx 12)
 *   No.14 サービス回数          → count        (idx 13)
 *   No.15 サービスコード(6桁)    → serviceCode  (idx 14)
 */
export interface Table6PlanRecord {
  csvVersion: string;
  insuredNumber: string;
  targetYm: string;
  units: number | null;
  /** YYYY-MM-DD (ISO) に正規化済み */
  serviceDate: string;
  /** HH:MM (時間表示なし=9999 は null) */
  startTime: string | null;
  /** HH:MM (時間表示なし=9999 は null) */
  endTime: string | null;
  count: number;
  serviceCode: string;
}

/** 'YYYYMMDD' → 'YYYY-MM-DD'。不正は空文字 */
function ymdToIso(s: string): string {
  const t = (s ?? "").trim();
  if (!/^\d{8}$/.test(t)) return "";
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

/** 'HHMM' → 'HH:MM'。9999 / 空 / 不正は null (時間表示なし) */
function hhmmToTime(s: string): string | null {
  const t = (s ?? "").trim();
  if (!/^\d{4}$/.test(t)) return null;
  if (t === "9999") return null;
  const hh = t.slice(0, 2);
  const mm = t.slice(2, 4);
  const h = Number(hh);
  const m = Number(mm);
  if (h > 23 || m > 59) return null;
  return `${hh}:${mm}`;
}

function toIntOrNull(s: string): number | null {
  const t = (s ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export interface Table6ParseResult {
  records: Table6PlanRecord[];
  /** 対象年月 (YYYYMM) の集合。単月ファイルのはずだが混在検出用 */
  targetMonths: string[];
  warnings: string[];
}

/** 第6表【計画】CSV rows をパースする */
export function parseTable6Plan(rows: string[][]): Table6ParseResult {
  const records: Table6PlanRecord[] = [];
  const warnings: string[] = [];
  const months = new Set<string>();

  for (let r = 0; r < rows.length; r++) {
    const c = rows[r];
    // ヘッダ行 (No.1 CSVバージョンが YYYYMM 数字でない) はスキップ
    const csvVersion = (c[0] ?? "").trim();
    if (!/^\d{6}$/.test(csvVersion)) continue;
    if (c.length < 15) {
      warnings.push(`第6表: ${r + 1} 行目の列数が不足しています (${c.length} 列) — スキップ`);
      continue;
    }
    const insuredNumber = (c[2] ?? "").trim();
    const targetYm = (c[4] ?? "").trim();
    const serviceDate = ymdToIso(c[9] ?? "");
    const serviceCode = (c[14] ?? "").trim();
    if (!insuredNumber || !serviceDate || !serviceCode) {
      warnings.push(
        `第6表: ${r + 1} 行目に必須項目 (被保険者番号/利用日/サービスコード) が欠けています — スキップ`,
      );
      continue;
    }
    if (targetYm) months.add(targetYm);
    records.push({
      csvVersion,
      insuredNumber,
      targetYm,
      units: toIntOrNull(c[7] ?? ""),
      serviceDate,
      startTime: hhmmToTime(c[11] ?? ""),
      endTime: hhmmToTime(c[12] ?? ""),
      count: toIntOrNull(c[13] ?? "") ?? 1,
      serviceCode,
    });
  }
  return { records, targetMonths: Array.from(months), warnings };
}

// ─── 第7表【別表】パース ─────────────────────────────────────────────────────

/**
 * 第7表【別表】の項目 (layout.txt 542行〜 / No.1〜37)。
 * 本取込で使うのは「利用者×月の計画単位数」= No.22 区分支給限度基準内単位数。
 *   No.1  CSVバージョン           (idx 0)
 *   No.3  被保険者番号             (idx 2)
 *   No.5  対象年月 (YYYYMM)        (idx 4)
 *   No.7  サービス事業所コード(10桁)(idx 6)
 *   No.9  サービスコード           (idx 8)  種類別小計/全合計は特殊値 (AAAA/EEEE/ZZZZ/ALL9)
 *   No.16 回数／日数              (idx 15)
 *   No.22 区分支給限度基準内単位数  (idx 21) ← 計画単位数
 * ※ layout.txt は PDF 抽出で崩れているが、項目順は No 昇順で固定 (idx = No-1)。
 */
export interface Table7Record {
  csvVersion: string;
  insuredNumber: string;
  targetYm: string;
  serviceOfficeCode: string;
  serviceCode: string;
  /** No.22 区分支給限度基準内単位数 */
  kubunGendoNaiUnits: number | null;
}

/** 種類別小計・全合計行 (No.9 が CD+AAAA/EEEE/ZZZZ or ALL9/999999) か */
function isSubtotalOrTotalCode(code: string): boolean {
  const t = (code ?? "").trim().toUpperCase();
  if (t === "") return true;
  if (t === "999999" || t.startsWith("ALL9")) return true;
  // CD(サービス種別2桁)+AAAA/EEEE/ZZZZ
  if (/[A-Z]{4}$/.test(t) && /(AAAA|EEEE|ZZZZ)$/.test(t)) return true;
  return false;
}

export interface Table7ParseResult {
  records: Table7Record[];
  /** 利用者(被保険者番号)×対象月 の計画単位数集計 (自事業所コードで絞る前の全事業所分) */
  targetMonths: string[];
  warnings: string[];
}

/** 第7表【別表】CSV rows をパースする */
export function parseTable7Betsu(rows: string[][]): Table7ParseResult {
  const records: Table7Record[] = [];
  const warnings: string[] = [];
  const months = new Set<string>();

  for (let r = 0; r < rows.length; r++) {
    const c = rows[r];
    const csvVersion = (c[0] ?? "").trim();
    if (!/^\d{6}$/.test(csvVersion)) continue;
    if (c.length < 22) {
      // 区分支給限度基準内単位数 (idx 21) まで無ければ計画単位が取れない
      warnings.push(`第7表: ${r + 1} 行目の列数が不足しています (${c.length} 列) — スキップ`);
      continue;
    }
    const insuredNumber = (c[2] ?? "").trim();
    const targetYm = (c[4] ?? "").trim();
    const serviceCode = (c[8] ?? "").trim();
    if (!insuredNumber) continue;
    if (targetYm) months.add(targetYm);
    records.push({
      csvVersion,
      insuredNumber,
      targetYm,
      serviceOfficeCode: (c[6] ?? "").trim(),
      serviceCode,
      kubunGendoNaiUnits: toIntOrNull(c[21] ?? ""),
    });
  }
  return { records, targetMonths: Array.from(months), warnings };
}

/**
 * 第7表レコードから「利用者(被保険者番号)×対象月 の自事業所計画単位数」を集計する。
 *
 * 計画単位数 = 自事業所 (senderOfficeCode) の明細行 (種類別小計/全合計を除く) の
 *   区分支給限度基準内単位数 (No.22) の合計。
 * ※ 区分支給限度基準内単位 = 給付管理対象 (自事業所分) の計画単位。
 *   kaigo_monthly_plan_units.planned_units (自事業所分の区分支給限度基準内単位数) に一致。
 *
 * senderOfficeCode が渡されない (空) 場合は「事業所コードで絞らず全明細合算」する
 *   フォールバック (単一事業所ファイル想定)。
 */
export interface PlanUnitAgg {
  insuredNumber: string;
  targetYm: string;
  plannedUnits: number;
}

export function aggregatePlanUnits(
  records: Table7Record[],
  senderOfficeCode?: string | null,
): PlanUnitAgg[] {
  const office = (senderOfficeCode ?? "").trim();
  const map = new Map<string, PlanUnitAgg>();
  for (const rec of records) {
    if (isSubtotalOrTotalCode(rec.serviceCode)) continue; // 小計/全合計は加算しない
    if (office && rec.serviceOfficeCode && rec.serviceOfficeCode !== office) continue;
    if (rec.kubunGendoNaiUnits == null) continue;
    const key = `${rec.insuredNumber}|${rec.targetYm}`;
    const cur = map.get(key);
    if (cur) {
      cur.plannedUnits += rec.kubunGendoNaiUnits;
    } else {
      map.set(key, {
        insuredNumber: rec.insuredNumber,
        targetYm: rec.targetYm,
        plannedUnits: rec.kubunGendoNaiUnits,
      });
    }
  }
  return Array.from(map.values());
}
