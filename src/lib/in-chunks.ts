import { ID_IN_CHUNK, mapChunksParallel } from "./chunk-parallel";

/**
 * `.in(列, ids)` を ids の数に関係なく安全に使うための分割読み込み (order-app/lib/inChunks.ts と同じ形)。
 *
 * 2026-10-19 実測: uuid を 1 回の `.in()` に渡すと 約 300 件 (URL 約 11,000 文字) までは通るが、
 * 400 件で失敗し、1,057 件 (約 39,000 文字) は PostgREST が 400 Bad Request を返す。
 * また 350 件前後を超えると Postgres が index を使わず全件走査に落ちる (memory feedback_postgrest_in_query_plan_cliff)。
 * → ID_IN_CHUNK (150) 件ずつに分けて並列で読み、chunk 順につなぐ。
 *
 * - chunk をまたいだ並び順は保たれない。全体の順序が要る呼出側は受け取ってから並べ直すこと。
 * - 1 chunk の結果が 1000 行を超えうる場合は run の中で order + range して回しきること。
 * - error は包み直さずそのまま投げる (呼出側が error.code で「表/列が無い」等を見分けられるように)。
 */
export async function selectInChunks<T>(
  ids: readonly (string | null | undefined)[],
  run: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
  chunkSize = ID_IN_CHUNK,
): Promise<T[]> {
  // 空/null の id が混ざると .in() に "null" が渡って uuid の型エラー (22P02) で全体が落ちるので除く
  const unique = [...new Set(ids)].filter((id): id is string => typeof id === "string" && id !== "");
  const parts = await mapChunksParallel(unique, chunkSize, async (chunk) => {
    const { data, error } = await run(chunk);
    if (error) throw error;
    return (data ?? []) as T[];
  });
  return parts.flat();
}
