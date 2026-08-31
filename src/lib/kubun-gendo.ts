// src/lib/kubun-gendo.ts
//
// 区分支給限度基準額（告示値）の唯一の定義。
//
// 2026-08-31 の監査で、認定レコードの service_limit_amount が告示値と食い違って
// いる利用者が実データで 12 名、NULL が 6 名見つかった。
//
//   山中 英子     要介護4  登録=16765  告示=30938   (超過判定が早まる = 過少請求)
//   杉谷 久       要介護1  登録=27048  告示=16765   (超過を検出できない = 過大請求)
//   蛭田 康子     要介護3  登録=36217  告示=27048
//   ...
//
// 現状は kaigo_monthly_plan_units.planned_units が入っているため実害が出ていないが、
// 計画単位数が無い月に落ちた瞬間に誤判定する。
// 「認定の登録値をそのまま信じる」のをやめ、告示値と突き合わせて警告を出すために
// この表を切り出した。
//
// ⚠ 同じ表が benefits-content.tsx:64 と reports-content.tsx:257 にもコピーされている。
//   それらは別セッションが触っている最中なので、今回は寄せずに残している。
//   触れるタイミングでこのモジュールに寄せること。

/** 要介護度 → 区分支給限度基準額 (単位/月)。厚労省告示。 */
export const CARE_LEVEL_LIMIT_UNITS: Readonly<Record<string, number>> = {
  要支援1: 5032,
  要支援2: 10531,
  要介護1: 16765,
  要介護2: 19705,
  要介護3: 27048,
  要介護4: 30938,
  要介護5: 36217,
};

/** 全角・半角や空白のゆれを吸収して告示値を引く。引けなければ null。 */
export function standardLimitUnits(careLevel: string | null | undefined): number | null {
  if (!careLevel) return null;
  // ほのぼの由来のデータは全角数字のことがある (要介護３)。NFKC で寄せる。
  const key = careLevel.normalize("NFKC").replace(/\s/g, "");
  return CARE_LEVEL_LIMIT_UNITS[key] ?? null;
}

/**
 * 認定に登録された限度額が告示値と食い違っていないかを判定する。
 *
 * @returns null = 問題なし / 文字列 = 警告文 (そのまま利用者向け警告に出せる)
 */
export function limitAmountMismatchReason(
  careLevel: string | null | undefined,
  registered: number | null | undefined,
): string | null {
  const std = standardLimitUnits(careLevel);
  if (std == null) return null; // 要介護度が引けない場合はここでは判定しない
  if (registered == null) {
    return `区分支給限度基準額が未登録です (${careLevel} の告示値は ${std.toLocaleString()} 単位)`;
  }
  if (registered !== std) {
    return `区分支給限度基準額の登録値 ${registered.toLocaleString()} 単位が ${careLevel} の告示値 ${std.toLocaleString()} 単位と一致しません`;
  }
  return null;
}
