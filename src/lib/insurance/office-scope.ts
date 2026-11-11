import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 保険・認定・公費・負担割合の「事業所ごと」切替 (DESIGN_INSURANCE_PER_OFFICE.md §3.2) の 規則 3。
 *
 *   offices.insurance_scope = 'per_office' の事業所 (切替済み) の行は、その事業所の専用。
 *   まだ 'shared' の事業所 (= kaigo-app の全事業所。2026-11-11 時点) が請求・画面で認定を選ぶときは、
 *   per_office の事業所の行を候補から外す。これで 福祉用具 (ケアサポ) の値が介護の請求に漏れない。
 *   office_id が NULL (事業所未定) の行・shared の事業所の行は今までどおり候補に入る。
 *
 * ★ per_office の事業所が 0 のときは何も絞らない (= 今の動きと 1 行も変わらない)。
 * ★ 読めない (列が未適用・通信エラー) ときも絞らない。console.error だけ出す (請求を止めない)。
 */

const TTL_MS = 60_000;
let cache: { at: number; ids: string[] } | null = null;

/** テスト用: per_office の事業所 id を固定する (null で解除)。本番コードからは呼ばない */
let override: string[] | null = null;
export function __setPerOfficeOfficeIdsForTest(ids: string[] | null): void {
  override = ids;
  cache = null;
}

/** insurance_scope = 'per_office' の事業所 id (60 秒キャッシュ) */
export async function getPerOfficeOfficeIds(supabase: SupabaseClient): Promise<string[]> {
  if (override) return override;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.ids;
  const { data, error } = await supabase.from("offices").select("id").eq("insurance_scope", "per_office");
  if (error) {
    console.error("offices.insurance_scope を読めない (事業所別の保険の切替を見ずに続ける):", error.message);
    return [];
  }
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id).sort();
  cache = { at: Date.now(), ids };
  return ids;
}

/**
 * PostgREST の .or() に渡す条件。per_office の事業所が無ければ null (= 絞らない)。
 *   office_id IS NULL OR office_id NOT IN (per_office の事業所)
 * ★ `.not("office_id","in",…)` だけだと NULL の行が落ちる (SQL の NOT IN は NULL を偽にする) ので必ず is.null と OR にする。
 */
export function sharedScopeOrFilter(perOfficeIds: string[]): string | null {
  return perOfficeIds.length ? `office_id.is.null,office_id.not.in.(${perOfficeIds.join(",")})` : null;
}

/** 取得済みの行を同じ規則で絞る (メモリ上。select に office_id を含めること) */
export function excludePerOfficeRows<T extends { office_id?: string | null }>(rows: T[], perOfficeIds: string[]): T[] {
  if (!perOfficeIds.length) return rows;
  const s = new Set(perOfficeIds);
  return rows.filter((r) => !r.office_id || !s.has(r.office_id));
}
