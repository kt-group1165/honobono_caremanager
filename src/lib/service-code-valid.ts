/**
 * kaigo_service_codes の有効期間 (valid_from / valid_until) フィルタ helper
 *
 * 背景:
 *   kaigo_service_codes は介護報酬改定ごとに同一 service_code / service_name の
 *   行を世代追加して管理する (例: R6 版 valid_from='2024-06-01' /
 *   R8 版 valid_from='2026-06-01')。期間フィルタ無しで service_name /
 *   service_code だけで引くと複数世代がヒットし、採用される単位数が
 *   不定になるため、参照側は必ずこの helper で世代を絞る。
 *
 * 規約:
 *   - valid_from IS NULL は「開始制限なし」= 常に有効側に倒す
 *   - valid_until IS NULL は「終了未定 (= 現行世代)」
 *   - 請求・実績・提供表など月が確定している画面 → validInMonth (対象月と期間が重なる世代)
 *   - サービス選択 UI 等の「現時点」系 → validToday
 *   - マスタ管理画面 (/master/service-codes) は全世代を表示・編集するためフィルタしない
 */

/**
 * supabase-js PostgrestFilterBuilder が満たす最小 interface
 * (.or は既存チェーンと AND 結合で追記される)。
 * ※ generic 制約に PostgrestFilterBuilder を直接使うと TS2589
 *   (型インスタンス化が深すぎる) になるため、内部 cast で受ける。
 */
interface OrFilterable {
  or(filters: string): OrFilterable;
}

/** 対象月の月初・月末 (YYYY-MM-DD) */
export function monthRange(
  year: number,
  month: number,
): { monthStart: string; monthEnd: string } {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  return {
    monthStart: `${year}-${mm}-01`,
    monthEnd: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

/** ローカル日付 (YYYY-MM-DD)。toISOString() は UTC 日付にずれるため使わない */
function localDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 対象月 (year/month) に有効な世代へ絞る PostgREST フィルタ。
 * 条件: (valid_from IS NULL OR valid_from <= 月末)
 *   AND (valid_until IS NULL OR valid_until >= 月初)
 */
export function validInMonth<Q>(query: Q, year: number, month: number): Q {
  const { monthStart, monthEnd } = monthRange(year, month);
  return (query as unknown as OrFilterable)
    .or(`valid_from.is.null,valid_from.lte.${monthEnd}`)
    .or(`valid_until.is.null,valid_until.gte.${monthStart}`) as unknown as Q;
}

/** 今日時点で有効な世代へ絞る PostgREST フィルタ (サービス選択 UI 等の「現時点」用) */
export function validToday<Q>(query: Q): Q {
  const today = localDateString();
  return (query as unknown as OrFilterable)
    .or(`valid_from.is.null,valid_from.lte.${today}`)
    .or(`valid_until.is.null,valid_until.gte.${today}`) as unknown as Q;
}

/** クライアント側で取得済み rows を絞る用: 対象月に有効な行か */
export function isValidInMonth(
  row: { valid_from: string | null; valid_until: string | null },
  year: number,
  month: number,
): boolean {
  const { monthStart, monthEnd } = monthRange(year, month);
  if (row.valid_from && row.valid_from > monthEnd) return false;
  if (row.valid_until && row.valid_until < monthStart) return false;
  return true;
}
