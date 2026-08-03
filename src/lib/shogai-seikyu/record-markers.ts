/**
 * 障害実績 (kaigo_visit_schedule) の行種マーカー。
 *
 * MEISAI (稼働データ) 取込は 1 訪問を「請求上の行」と「記録上の行」に分けて持つ必要がある。
 * どちらの用途の行かを notes に文字列で埋め込み、集計側 (請求) と実績記録票側 (伝送 J611)
 * でそれぞれ取捨する。
 *
 *   ┌──────────────┬──────────┬──────────────┐
 *   │ 行種          │ 請求 集計 │ 実績記録票 J611│
 *   ├──────────────┼──────────┼──────────────┤
 *   │ 通常           │    ○     │      ○       │
 *   │ ADDON (増)     │    ○     │      ×       │  増は請求単位であって訪問ではない
 *   │ SESSION_SUB    │    ×     │      ○       │  請求は代表行に合算済。記録には提供時刻を残す
 *   └──────────────┴──────────┴──────────────┘
 *
 * ⚠ migrations/import_meisai_shougai_records.mjs にも同じ文字列が定義されている
 *   (TS 側から .mjs を import できないため)。変更時は両方直すこと。
 */

/** 増(加算)コードの行 — 請求には計上するが実績記録票には出さない */
export const MARK_ADDON = "加算行";

/** 合算セッションの2件目以降 — 請求は代表行に集約済。実績記録票にのみ提供時刻の行として出す */
export const MARK_SESSION_SUB = "合算従属";

/** 請求集計に含める行か (合算セッションの従属行を除く) */
export const isBillableRecord = (notes: string | null | undefined): boolean =>
  !(notes ?? "").includes(MARK_SESSION_SUB);

/** 増(加算)行か — 実績記録票では明細行にせず算定時間だけ基本行に足し込む */
export const isAddonRecord = (notes: string | null | undefined): boolean =>
  (notes ?? "").includes(MARK_ADDON);

/** 合算セッションの従属行か — 明細行には出すが算定時間は代表行が持つ */
export const isSessionSubRecord = (notes: string | null | undefined): boolean =>
  (notes ?? "").includes(MARK_SESSION_SUB);
