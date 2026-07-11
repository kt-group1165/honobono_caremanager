/**
 * 訪問キャンセル (欠課) のキャンセル料 ⇄ 利用実費 (riyou_jippi_entries) 連動
 *
 * 仕組み (migration: migrations/visit_cancel_fee.sql):
 *   - kaigo_visit_schedule に status='cancelled' + cancel_fee (円) を記録
 *   - cancel_fee > 0 のとき riyou_jippi_entries に schedule_id 付きで 1 行同期
 *     → 利用請求タブ (billing-visit/riyou-seikyu) の既存実費合算にそのまま乗る
 *   - riyou_jippi_entries.schedule_id は UNIQUE index。upsert(onConflict) で
 *     同一予定からの二重計上を構造的に防止する
 *   - キャンセル解除 / 料金 0 化 / 予定削除時は schedule_id で連動行を削除
 *
 * フォールバック:
 *   migration 未適用 (42703/PGRST204 = 列なし, 42P01/PGRST205 = 表なし) は
 *   warning として返し、呼出側で toast.warning に落とす (silent failure にしない)。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** 連動に必要な予定の最小形 (user_id は clients.id = riyou_jippi_entries.client_id) */
export interface CancelFeeSchedule {
  id: string;
  user_id: string;
  /** YYYY-MM-DD */
  visit_date: string;
  service_type: string;
}

export interface CancelFeeSyncResult {
  /** 連動失敗 (呼出側で toast.error 必須) */
  error: string | null;
  /** migration 未適用等の注意 (toast.warning 推奨) */
  warning: string | null;
}

const MIGRATION_WARNING =
  "キャンセル料の実費連動は migration (visit_cancel_fee.sql) 適用後に有効になります";

/** schema 未適用系のエラーコードか (列なし / 表なし / schema cache) */
function isMissingSchemaError(code: string | null | undefined): boolean {
  return (
    code === "42703" || code === "PGRST204" || code === "42P01" || code === "PGRST205"
  );
}

/** 実費行の名目: 「キャンセル料 7/15 身体介護2」 */
export function cancelFeeItemName(visitDate: string, serviceType: string): string {
  const m = parseInt(visitDate.slice(5, 7), 10);
  const d = parseInt(visitDate.slice(8, 10), 10);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return `キャンセル料 ${serviceType}`;
  return `キャンセル料 ${m}/${d} ${serviceType}`;
}

/**
 * キャンセル料を利用実費に同期する。
 *   fee > 0 : schedule_id で upsert (既存行は金額・名目を上書き = 二重計上なし)
 *   fee <= 0: 連動行を削除 (記録のみのキャンセル)
 * 対象月は visit_date の属する月 (利用請求の月次合算に自動で乗る)。
 */
export async function syncCancelFeeJippi(
  supabase: SupabaseClient,
  sched: CancelFeeSchedule,
  fee: number,
  reason: string | null,
): Promise<CancelFeeSyncResult> {
  if (fee <= 0) {
    return removeCancelFeeJippi(supabase, sched.id);
  }
  const { error } = await supabase.from("riyou_jippi_entries").upsert(
    {
      client_id: sched.user_id,
      target_month: sched.visit_date.slice(0, 7),
      item_name: cancelFeeItemName(sched.visit_date, sched.service_type),
      unit_price: fee,
      quantity: 1,
      amount: fee,
      provide_date: sched.visit_date,
      notes: reason ? `キャンセル理由: ${reason}` : null,
      schedule_id: sched.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "schedule_id" },
  );
  if (error) {
    if (isMissingSchemaError(error.code)) return { error: null, warning: MIGRATION_WARNING };
    return { error: error.message, warning: null };
  }
  return { error: null, warning: null };
}

/** 予定に紐づく連動実費行を削除 (キャンセル解除・料金 0 化・予定削除時) */
export async function removeCancelFeeJippi(
  supabase: SupabaseClient,
  scheduleId: string,
): Promise<CancelFeeSyncResult> {
  const { error } = await supabase
    .from("riyou_jippi_entries")
    .delete()
    .eq("schedule_id", scheduleId);
  if (error) {
    // 列/表なし = そもそも連動行が存在しえないので黙って成功扱い
    if (isMissingSchemaError(error.code)) return { error: null, warning: null };
    return { error: error.message, warning: null };
  }
  return { error: null, warning: null };
}
