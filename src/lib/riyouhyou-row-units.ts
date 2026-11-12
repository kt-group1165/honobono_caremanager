/**
 * 利用票 (第6表) の 1 行の「月計単位」 — 画面・印刷・検査 (check:riyouhyou-units) が同じ式を使うための純関数。
 *
 * もともと reports-content.tsx の中に `(svc.units ?? 0) × 印の数` が 6 か所 (編集画面 4 / 印刷 2)
 * 書かれていた。client component の中なので検査から呼べず (SESSION_START ⑪)、式を 1 か所に寄せた。
 *
 * ── 月 1 回の加算・月額サービス (2026-11-12) ─────────────────────────────
 * ほのぼのの利用票は「提供した日」に印を付けるので、科学的介護推進体制加算・定期巡回など
 * 単位が「1月につき」のコードにも複数の日に印が付く (元 PDF で確認済み: 定期巡回は 30 日すべて)。
 * しかし単位は月 1 回分で、ほのぼのの別表は回数 1・伝送 KY も 1 回で数えている。
 * → unit_type が MONTHLY_UNIT_TYPES のときは 回数を min(1, 印の数) にする。
 *   印 (データ) は ほのぼのと一致していて正しいので直さない。直すのは式だけ。
 * ★ 検証: 伝送 KY 8222 と突合する check:riyouhyou-units で、予測どおりの件数が一致に移ることを確認する。
 *
 * ⚠ 福祉用具貸与 (manual_units × 1月/半月) は別経路 (rentalMonthlyUnits)。ここでは扱わない。
 */

/** 月 1 回分の単位として数える unit_type (kaigo_service_codes.unit_type の実値。2026-11-12 に全件の分布を確認) */
export const MONTHLY_UNIT_TYPES: ReadonlySet<string> = new Set(["1月につき", "月1回限度"]);

export function isMonthlyUnitType(unitType: string | null | undefined): boolean {
  return unitType != null && MONTHLY_UNIT_TYPES.has(unitType.trim());
}

/**
 * 貸与以外の 1 行の月計単位。
 * @param units    1 回あたりの単位 (マスタ値。未設定は 0 扱い)
 * @param count    回数 (画面・印刷は印の数。検査は planned_counts の合計)
 * @param unitType kaigo_service_codes.unit_type。不明 (undefined/null) なら従来どおり units × count
 */
export function rowMonthlyUnitsOf(units: number | null | undefined, count: number, unitType?: string | null): number {
  const n = isMonthlyUnitType(unitType) ? Math.min(1, count) : count;
  return (units ?? 0) * n;
}
