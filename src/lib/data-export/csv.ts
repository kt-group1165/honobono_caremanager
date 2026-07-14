// ─── 行データ → CSV 文字列 (UTF-8 BOM, Excel 互換) ──────────────────────────

export type ExportRow = Record<string, unknown>;

/** UTF-8 BOM。Excel が UTF-8 CSV を正しく開くために先頭へ付与する。 */
const BOM = String.fromCharCode(0xfeff);

/** RFC4180 準拠のフィールドエスケープ。jsonb / 配列は JSON 文字列化する。 */
function toField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "object") {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  if (/[",\r\n]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * 全行のキーの和集合をヘッダーとして CSV を生成する (BOM 付き)。
 * PostgREST の select("*") は行ごとに同じキーを返すが、念のため和集合を取る。
 */
export function rowsToCsv(rows: ExportRow[]): string {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const lines: string[] = [columns.map(toField).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => toField(row[c])).join(","));
  }
  return BOM + lines.join("\r\n") + "\r\n";
}

/** 1 行 1 レコードの読みやすい JSON 配列文字列を生成する。 */
export function rowsToJson(rows: ExportRow[]): string {
  if (rows.length === 0) return "[]\n";
  return "[\n" + rows.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n";
}
