/**
 * kaigo_monitoring_items.plan_revision_needed の DB(boolean) ⇔ 画面(文字列) 変換。
 *
 * ── 背景 (2026-09-14 発見) ──────────────────────────────────────────────────
 *   DB列は boolean だが、monitoring-content.tsx の画面 state は
 *   "あり" / "なし" / "" (未入力) という文字列で持っている。境界で変換せず
 *   そのまま送受信していたため、"あり"/"なし" を boolean 列に書き込もうとして
 *   Postgres の型エラーになるはずだった (両テーブルとも実運用0行のため未発火)。
 *
 * ⚠ 印字・チェックマーク表示 (画面内の state 比較) は文字列のまま扱う設計を
 *   変えない。変換はこの2関数の境界だけで行う。
 *
 * ⚠ 列の DEFAULT は FALSE。「未入力」を false で保存すると「なし」に化けて
 *   見分けが付かなくなるため、未入力は必ず null を明示送信すること
 *   (dbToRevisionNeeded(null) => "" / revisionNeededToDb("") => null)。
 */

export type RevisionNeeded = "あり" | "なし" | "";

/** DB (boolean|null|undefined) → 画面の文字列。想定外の値は "" (未入力) に倒す */
export function dbToRevisionNeeded(value: boolean | null | undefined): RevisionNeeded {
  if (value === true) return "あり";
  if (value === false) return "なし";
  return "";
}

/** 画面の文字列 → DB (boolean|null)。想定外の文字列は null (未入力) に倒す */
export function revisionNeededToDb(value: string): boolean | null {
  if (value === "あり") return true;
  if (value === "なし") return false;
  return null;
}
