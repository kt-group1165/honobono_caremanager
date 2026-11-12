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
 * ★ unit_type は「1月につき」までしか表現できない (2026-11-13)。
 *   口腔栄養スクリーニング加算 (166201/166202 等) のように ★ 6 か月に 1 回 のものは拾えない
 *   (マスタの unit_type は「1回につき」)。実測 2 件: 小橋 祐子 予1 実11 / 髙橋 弘子 予1 実2 で、
 *   ★ 実績の印が回数ぶん付いている。KY はどちらも 1 回で数えている (check:riyouhyou-units の _readme)。
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

/**
 * 帳票 1 枚の集計用: 月 1 回のコードが同じ (事業所, サービス) で複数行に分かれているとき、
 * 2 行目以降の回数を 0 にした回数の配列を返す (行の並びはそのまま)。
 *
 * ほのぼのの利用票は同じコードを時間帯ごとに別の行で書く (2026-11-12 に元 PDF で 7 組すべて確認。
 * 例: 小菅 トミ子 定期巡回随時Ⅰ１３ を 02:10 / 03:50 / 15:50 / 20:50 / 21:50 の 5 行)。
 * 行ごとに rowMonthlyUnitsOf で 1 回にしても行数ぶん数えてしまうので、帳票の合計ではここで畳む。
 * KY 8222 も (事業所, コード) ごとに 1 回で数えている。
 *
 * - 月 1 回でない行・unit_type 不明の行は、回数をそのまま返す (行ごとの計算と同じ)
 * - 月 1 回の行は、同じキーで最初に回数が 1 以上になる行だけ回数を残し、以降の行は 0
 * - 行ごとの表示 (各行の月計欄) には使わない。データ (印) も触らない
 * 戻り値を rowMonthlyUnitsOf(units, counts[i], unitType) に渡せば帳票の合計になる。
 */
export function dedupeMonthlyCounts<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  countOf: (row: T) => number,
  unitTypeOf: (row: T) => string | null | undefined,
): number[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    const n = countOf(r);
    if (!isMonthlyUnitType(unitTypeOf(r)) || n <= 0) return n;
    const k = keyOf(r);
    if (seen.has(k)) return 0;
    seen.add(k);
    return n;
  });
}

/** 利用票の行を畳むときのキー: 提供事業所名 + サービス内容 (行にサービスコードを持たないため名前で引く) */
export function riyouhyouRowKey(row: { provider?: string | null; content?: string | null }): string {
  return `${(row.provider ?? "").trim()}|${(row.content ?? "").trim()}`;
}
