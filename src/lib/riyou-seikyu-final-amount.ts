/**
 * 利用者請求書 (介護・総合事業) の ★ 最終額の計算 — 純関数
 *
 * ── なぜ切り出すか ────────────────────────────────────────────────────────
 *   `billing-visit/riyou-seikyu/riyou-seikyu-content.tsx` (client component) の
 *   useCallback の中に直接書かれていた。★ ハーネスから呼べないので、
 *   同じ式が印刷用の別コンポーネント (RiyouSeikyuPrintSheet /
 *   RiyouSeikyuHouseholdPrintSheet) に inline で再実装されていた
 *   (親の useCallback を呼べない独立したトップレベル関数のため)。
 *
 *   統合の前に 3 実装を境界値 12 ケースで突き合わせ、一致することを確認済み
 *   (scripts/riyou-seikyu-final-amount-diff.mts / 2026-09-04)。★ そのうえでの統合。
 *
 * ⚠ 挙動は変えていない。★ 呼べる場所に移しただけ。
 *
 * ⚠ 障害 (shogai.userAmount) はここに含まれない。billedForRow の障害分岐は
 *   このモジュールの対象外 — 個人票/世帯合算票の入力型 (UserSeikyuRow) が
 *   介護/総合専用に固定されており、障害行は呼び出し元 (kaigoTargets) で
 *   事前に除外されるため、型レベルで障害の値がここに届く経路が無い。
 */

/** 請求個人設定 (軽減) — 金額計算に効く 2 項目だけ */
export type KeigenSetting = {
  /** 軽減率 (% 表記。NULL = 軽減なし) */
  keigen_rate: number | null;
  keigen_start_date: string | null;
  keigen_end_date: string | null;
};

/**
 * 軽減が対象月に有効か: 開始 <= 月末 かつ (終了 null or 終了 >= 月初)。
 * (日付は YYYY-MM-DD の文字列比較で判定。"-31" は月末番兵として安全)
 */
export function keigenActiveInMonth(
  s: KeigenSetting | undefined,
  monthKey: string,
): boolean {
  if (!s || s.keigen_rate == null || s.keigen_rate <= 0) return false;
  const monthStart = `${monthKey}-01`;
  const monthEnd = `${monthKey}-31`;
  if (s.keigen_start_date && s.keigen_start_date > monthEnd) return false;
  if (s.keigen_end_date && s.keigen_end_date < monthStart) return false;
  return true;
}

/** 軽減額 = round(負担額 × 軽減率 / 100)。対象月に有効でなければ 0 */
export function computeKeigenAmount(
  userAmount: number,
  keigenRate: number | null,
  active: boolean,
): number {
  if (!active) return 0;
  return Math.round((userAmount * (keigenRate ?? 0)) / 100);
}

/**
 * 行の請求額 (当月請求額) = (法定負担 + 超過自費) − 軽減額 + 実費。
 * userPlusSelf / jippiSum は呼び出し側で合算済みの値を渡す。
 */
export function computeMonthTotal(
  userPlusSelf: number,
  keigen: number,
  jippiSum: number,
): number {
  return userPlusSelf - keigen + jippiSum;
}

/** 繰越額 = 前月請求 − 前月入金 (正 = 未収繰越 / 負 = 過入金充当)。前月レコード無しは 0 */
export function computeCarry(
  prevBilled: number | null | undefined,
  prevPaid: number | null | undefined,
): number {
  return prevBilled != null && prevPaid != null ? prevBilled - prevPaid : 0;
}

/** 今回御請求額 = 当月請求額 + 繰越額 */
export function computeGrandTotal(monthTotal: number, carry: number): number {
  return monthTotal + carry;
}

/**
 * 医療費控除対象額 = round(軽減後負担額 × 対象単位比率)。
 * 対象単位比率 = 「生活援助」を含まないサービスの単位数 ÷ 総単位数
 * (生活援助中心型は控除対象外。加算は比率に按分される)
 *
 * ⚠ 2026-09-05 検証: kaigo_riyou_settings が実データ0件のため未使用の機能だが、
 *   金額計算なので境界値をここで固定する (scripts/riyou-seikyu-final-amount-verify.mts)。
 *   「身体１生活１」のような身体+生活の複合コードは .includes("生活援助") に
 *   マッチしないため対象単位に含まれる (= 医療費控除の対象になる)。これは
 *   「生活援助中心型」(単独コード) だけを対象外とする設計として意図どおりで、
 *   複合コードを対象外にする実装ではない — 実データ (kaigo_service_codes) で
 *   「生活援助」を含む名前は「生活援助２」等の単独コード11種のみで、
 *   身体+生活の複合コード (「身体１生活１」等) 106種とは重ならないことを確認済み。
 *
 * ⚠ eligibleUnits/totalUnits は呼び出し側で計算済みの値を渡す (このモジュールは
 *   service_type の文字列判定を持たない — 判定は呼び出し側の責務のまま)。
 */
export function computeIryohiAmount(
  iryohiTaisho: boolean,
  totalUnits: number,
  eligibleUnits: number,
  afterKeigen: number,
): number {
  if (!iryohiTaisho || totalUnits <= 0) return 0;
  // 整数演算 (比率を先に float 化しない) — (afterKeigen * eligibleUnits) を先に計算してから割る
  return Math.round((afterKeigen * eligibleUnits) / totalUnits);
}
