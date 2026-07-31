/**
 * `.in()` の URI Too Long 回避で id を chunk 分割して問い合わせる時の
 * 「同時実行数を絞った並列実行」ヘルパー。
 *
 * 背景 (2026-07-30): chunk ループを直列 await で回していたため、母集団が大きい画面
 * (居宅 請求個人設定 = 全法人 4500 名) で chunk 数 × 往復時間 が数十秒になり、
 * スピナーが回り続けて事実上フリーズしていた。
 *
 * 戻り値は **chunk 順** に並べて返すので、「chunk 内の DB order を保ったまま連結する」
 * 呼出側の前提 (per-client の並び順など) を壊さない。
 */
/**
 * UUID 列を `.in()` で渡す時の chunk サイズ。
 *
 * 従来 50 だったが、UUID 1 件 ≒ 38 byte (36 + カンマ + URL encode) なので
 * 150 件でも URL は 6KB 弱 = PostgREST/Kong のヘッダ上限 (8KB) に収まる
 * (実測: 本番 Supabase に 250 件の `.in()` を投げて 126ms で成功)。
 * 事業所規模 (250 名) なら 2 chunk = 1 往復波で終わる。
 */
export const ID_IN_CHUNK = 150;

/**
 * サービス名など**日本語文字列**を `.in()` に渡す時の chunk サイズ。
 *
 * 日本語 1 文字は URL encode で 9 byte (%XX × 3) に膨らむため UUID と同じ感覚で
 * 増やすと URL 上限に当たる。従来どおり 50 に据え置く。
 */
export const NAME_IN_CHUNK = 50;

export async function mapChunksParallel<T, R>(
  items: T[],
  chunkSize: number,
  worker: (chunk: T[]) => Promise<R>,
  concurrency = 6,
): Promise<R[]> {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
  const results = new Array<R>(chunks.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, chunks.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= chunks.length) return;
        results[i] = await worker(chunks[i]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}
