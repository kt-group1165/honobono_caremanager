/**
 * kaigo_monitoring_items の行数決定・保存payload組み立てを純関数として切り出し
 * (2026-09-14・B-6g相当)
 *
 * ── 背景 (実データで発覚) ────────────────────────────────────────────────
 *   monitoring-content.tsx は FIXED_ROWS=6 固定で、
 *     - 読み込み (buildFixedRows): item_number 1〜6 の範囲でしか行を探さない
 *       → 7件目以降が★画面から消える (見えないだけ)
 *     - 保存 (handleSave): そのシートのitem全件をdeleteしてから、画面の
 *       items (常に6件) をinsertし直す
 *       → 7件目以降を持つシートを一度でも保存すると★その場で消える (データ消失)
 *   ほのぼののモニタリング記録表は課題の数だけ行があり、6を超えることが
 *   実データで確認されている (浅野修司=7件・秋葉法昌=8件、2026-09-14実測)。
 *
 * ── 方針 ──────────────────────────────────────────────────────────────
 *   行数は「最低 FIXED_ROWS 件・item_numberの最大値がそれを超えればそこまで」
 *   に拡張する。保存は画面の全行を対象にするが、★全項目が空の行は保存しない
 *   (空行を無限に積み上げないため。有効な行に空行は混ざらない前提)。
 */

/** 保存判定に使う既存の主要フィールド (現行スキーマの列のみ。新設列は表示実装時に追加する) */
export interface MonitoringItemFields {
  item_number: number;
  short_term_goal: string;
  goal_period_start: string;
  goal_period_end: string;
  service_type: string;
  provider_name: string;
  implementation_status: string;
  user_satisfaction: string;
  family_satisfaction: string;
  satisfaction_comment: string;
  achievement: string;
  adl_change: string;
  plan_revision_needed: string;
  revision_reason: string;
}

const CONTENT_FIELDS = [
  "short_term_goal", "goal_period_start", "goal_period_end", "service_type", "provider_name",
  "implementation_status", "user_satisfaction", "family_satisfaction", "satisfaction_comment",
  "achievement", "adl_change", "plan_revision_needed", "revision_reason",
] as const;

/** 全項目が空 (空文字) の行かどうか */
export function isEmptyMonitoringItem(item: MonitoringItemFields): boolean {
  return CONTENT_FIELDS.every((f) => !item[f]);
}

/**
 * 画面に表示する行数を決める。
 * ⚠ 呼出側は 1..戻り値 の連番で行を作ること (欠番は空行で埋める)。
 */
export function rowCountFor(items: { item_number: number }[], minRows: number): number {
  const maxNum = items.reduce((m, it) => Math.max(m, it.item_number), 0);
  return Math.max(minRows, maxNum);
}

/**
 * 保存用payloadを作る: 全項目が空の行を除いた配列を返す (順序は維持)。
 * ⚠ 「6行に切り詰める」旧実装のバグを踏まないよう、item_number の上限は
 *   一切見ない (呼出側の items 配列をそのまま反映する)。
 */
export function buildSavePayload<T extends MonitoringItemFields>(items: T[]): T[] {
  return items.filter((it) => !isEmptyMonitoringItem(it));
}
