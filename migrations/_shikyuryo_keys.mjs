// ============================================================================
// 支給量内訳 (shougai_certifications.shikyuryo_details) のキー正規化。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   受給者証 PDF から起こした JSON は **受給者証の表記そのまま**の日本語キー
//   (「身体介護」「重度訪問介護区分６該当」) で quantities を持っている。
//   一方、画面 (shougai-cert-content.tsx SHIKYURYO_ITEMS) と集計
//   (shogai-seikyu/aggregate.ts SHIKYURYO_DEFS) は **ローマ字キー**で読む。
//   そのまま入れると画面の「支給量」欄が空になり、支給量超過の警告も一切出ない
//   (2026-08-19 に 574 件が該当していたのを発見)。
//
//   ⚠ 日本語キーは全角/半角 (「区分６」)・NFKC 正規化・表記ゆれの影響を受けるので
//     **DB に入れるのはローマ字キー**に統一する。日本語は表示用ラベルだけに使う。
//
//   正は src/app/(authenticated)/users/[id]/shougai-cert/shougai-cert-content.tsx
//   の SHIKYURYO_ITEMS。増やすときは両方直すこと (.mjs から .ts は import できない)。
// ============================================================================

/**
 * 受給者証の日本語表記 → 正規キー。
 * ⚠ キーは必ずクォートする。非 ASCII の未クォートキーは tsc をすり抜けて
 *   Turbopack build で落ちた前例がある (「・」中黒キー / feedback_tsc_vs_turbopack_middledot)。
 *   ここは全角「６」も含むので特に。
 */
export const SHIKYURYO_KEY_MAP = {
  "身体介護": "shintai",
  "乗降介助": "jouko",
  "家事援助": "kaji",
  "通院介助": "tsuuin",
  "通院身体": "tsuuin_shintai",
  "同行援護": "doukou",
  "同行身体": "doukou_shintai",
  "行動援護": "koudou",
  "移動介護": "idou",
  "重度訪問介護包括支援": "juudo_houmon_houkatsu",
  "重度訪問介護区分６該当": "juudo_houmon_kubun6",
  "重度訪問介護その他": "juudo_houmon_sonota",
};

/** 正規キーの一覧 (これ以外が来たら知らせる) */
export const SHIKYURYO_KEYS = new Set(Object.values(SHIKYURYO_KEY_MAP));

/**
 * quantities を正規キーに揃える。
 * 既にローマ字のものはそのまま通す (再実行しても壊れない = 冪等)。
 * @returns { details, unknown } unknown = 対応表に無かったキー (握りつぶさず返す)
 */
export function normalizeShikyuryo(q) {
  if (!q || typeof q !== "object") return { details: null, unknown: [] };
  const details = {};
  const unknown = [];
  for (const [k, v] of Object.entries(q)) {
    const key = SHIKYURYO_KEY_MAP[k] ?? (SHIKYURYO_KEYS.has(k) ? k : null);
    if (!key) {
      unknown.push(k);
      continue;
    }
    // 同じ正規キーに 2 つ来たら (表記ゆれ) 値が大きいほうを残す
    const cur = details[key];
    if (!cur) details[key] = v;
    else {
      const score = (x) => (x?.hours ?? 0) * 60 + (x?.minutes ?? 0) + (x?.count ?? 0) + (x?.units ?? 0);
      if (score(v) > score(cur)) details[key] = v;
    }
  }
  return { details: Object.keys(details).length ? details : null, unknown };
}
