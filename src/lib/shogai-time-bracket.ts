/**
 * 障害 (居宅介護等) の時間区分判定モード
 *
 * 論点: 60分ちょうどのサービスがどの時間区分コードになるか。
 *   - 告示原文 (令和6年度 報酬算定構造): 「30分以上1時間未満」=身体1.0 /
 *     「1時間以上1時間30分未満」=身体1.5 → 60分は 1.5
 *   - ほのぼのMORE の自動割当: 60分 → 身体1.0 (上限含み実装。マニュアルに明文なし)
 *
 * 移行時の請求額連続性を優先し、デフォルトは 'honobono' (= ほのぼの互換)。
 * 告示準拠に切り替えると同じ 60 分予定で 1 区分上のコードが候補になる (増収方向)。
 * 設定は app_settings (key-value) にテナント共通で保存する。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type ShogaiTimeBracketMode = "honobono" | "kokuji";

export const SHOGAI_TIME_BRACKET_KEY = "shogai_time_bracket_mode";
export const SHOGAI_TIME_BRACKET_DEFAULT: ShogaiTimeBracketMode = "honobono";

export const SHOGAI_TIME_BRACKET_LABELS: Record<ShogaiTimeBracketMode, string> = {
  honobono: "ほのぼの互換 (60分ちょうど → 1.0)",
  kokuji: "告示準拠 (60分ちょうど → 1.5)",
};

function isMode(v: unknown): v is ShogaiTimeBracketMode {
  return v === "honobono" || v === "kokuji";
}

/**
 * 判定モードを取得。行なし・型不正・取得失敗は default ('honobono') で続行。
 */
export async function getShogaiTimeBracketMode(
  supabase: SupabaseClient,
): Promise<ShogaiTimeBracketMode> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", SHOGAI_TIME_BRACKET_KEY)
    .maybeSingle();
  if (error) {
    console.warn("getShogaiTimeBracketMode fetch failed:", error.message);
    return SHOGAI_TIME_BRACKET_DEFAULT;
  }
  const v = (data as { value?: unknown } | null)?.value;
  return isMode(v) ? v : SHOGAI_TIME_BRACKET_DEFAULT;
}

/**
 * 判定モードを保存 (upsert)。
 */
export async function setShogaiTimeBracketMode(
  supabase: SupabaseClient,
  mode: ShogaiTimeBracketMode,
): Promise<void> {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: SHOGAI_TIME_BRACKET_KEY, value: mode }, { onConflict: "key" });
  if (error) throw error;
}
