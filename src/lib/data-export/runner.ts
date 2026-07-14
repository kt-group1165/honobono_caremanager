// ─── エクスポート実行: 件数カウント + 1000 行 page-loop fetch ────────────────
// 読み取り専用。select 以外の Supabase 呼び出しは一切行わない。

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExportRow } from "./csv";
import type { ExportTable } from "./tables";

/** 期間指定 (月範囲)。null = 全件 */
export interface MonthRange {
  /** 'YYYY-MM' */
  from: string;
  /** 'YYYY-MM' */
  to: string;
}

const PAGE_SIZE = 1000;

/** 'YYYY-MM' の翌月 1 日 ('YYYY-MM-DD') を返す */
function firstDayOfNextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

// PostgrestFilterBuilder のメソッドチェーンを表す最小限の型。
// 型無し SupabaseClient の from().select() 戻り値をこの形で扱う。
interface SelectChain {
  gte(column: string, value: string): SelectChain;
  lt(column: string, value: string): SelectChain;
  lte(column: string, value: string): SelectChain;
  order(column: string, opts: { ascending: boolean }): SelectChain;
  range(from: number, to: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

function applyRangeFilter(query: SelectChain, table: ExportTable, range: MonthRange | null): SelectChain {
  if (!range || !table.filter) return query;
  const { column, kind } = table.filter;
  if (kind === "date") {
    return query.gte(column, `${range.from}-01`).lt(column, firstDayOfNextMonth(range.to));
  }
  // month: 'YYYY-MM' 文字列同士の比較
  return query.gte(column, range.from).lte(column, range.to);
}

/** head リクエストで件数のみ取得する (行データは転送しない) */
export async function countTable(
  sb: SupabaseClient,
  table: ExportTable,
  range: MonthRange | null,
): Promise<{ count: number; error: null } | { count: null; error: string }> {
  let query = sb.from(table.name).select("*", { count: "exact", head: true });
  if (range && table.filter) {
    const { column, kind } = table.filter;
    if (kind === "date") {
      query = query.gte(column, `${range.from}-01`).lt(column, firstDayOfNextMonth(range.to));
    } else {
      query = query.gte(column, range.from).lte(column, range.to);
    }
  }
  const { count, error } = await query;
  if (error) return { count: null, error: error.message };
  return { count: count ?? 0, error: null };
}

/**
 * 1000 行ずつの page-loop で全行取得する (PostgREST の 1000 行上限対応)。
 * orderBy で安定ソートしてページ境界のズレを防ぐ。
 */
export async function fetchAllRows(
  sb: SupabaseClient,
  table: ExportTable,
  range: MonthRange | null,
  onProgress?: (fetched: number) => void,
): Promise<{ rows: ExportRow[]; error: null } | { rows: null; error: string }> {
  const rows: ExportRow[] = [];
  let offset = 0;
  for (;;) {
    let query = sb.from(table.name).select("*") as unknown as SelectChain;
    query = applyRangeFilter(query, table, range);
    for (const col of table.orderBy ?? ["id"]) {
      query = query.order(col, { ascending: true });
    }
    const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
    if (error) return { rows: null, error: error.message };
    const page = (data ?? []) as ExportRow[];
    rows.push(...page);
    onProgress?.(rows.length);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return { rows, error: null };
}
