/**
 * 読み取り専用マスタ (kaigo_service_codes) の GET を session 内でメモ化する fetch ラッパ。
 *
 * 背景 (2026-08-06): ダッシュボードの売上集計は 1 事業所あたり 20〜40 往復かかり、
 *   全事業所 (48 事業所) では数百往復になって 1 分ほどスピナーが回っていた。
 *   その往復のうち **kaigo_service_codes (118k 行の世代管理マスタ) の引き直しが最多**で、
 *   事業所が違っても対象月が同じなら結果は同一 = まるごと重複していた。
 *
 * ここでやること:
 *   1. 同一 URL の GET はレスポンス本文をメモしてそのまま返す (TTL 10 分)
 *   2. 同時に飛んだ同一 GET は 1 本にまとめる (in-flight dedupe)。
 *      → 並列 N 事業所で同じコード表を引いても実際の往復は 1 回
 *   3. 同じテーブルへの書込 (master/service-codes 画面) が走ったらキャッシュを全部捨てる
 *
 * ⚠ 金額に影響するマスタなので、キャッシュ対象は **世代管理されていて画面から個別更新
 *   されないマスタだけ**に限る。実績・利用者・事業所設定は絶対に入れない。
 */

/** メモ化してよいテーブル (= 読み取り専用のマスタ) */
const CACHEABLE_TABLES = new Set(["kaigo_service_codes"]);

/** メモの有効期間 */
const TTL_MS = 10 * 60 * 1000;

/** 復元するヘッダ (PostgREST の件数取得は content-range を見る) */
const KEEP_HEADERS = ["content-type", "content-range", "content-profile", "content-location"];

interface Snapshot {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
}

/**
 * メモ本体。**module 単位で共有**する (Supabase client は singleton なので実質 1 個)。
 * createMasterCachingFetch を複数回呼んでも同じキャッシュを見る。
 */
const cache = new Map<string, { at: number; p: Promise<Snapshot> }>();

function tableOf(url: string): string | null {
  const m = /\/rest\/v1\/([A-Za-z0-9_]+)/.exec(url);
  return m ? m[1] : null;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const m = init?.method ?? (input instanceof Request ? input.method : "GET");
  return m.toUpperCase();
}

function headerOf(input: RequestInfo | URL, init: RequestInit | undefined, name: string): string {
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  return h.get(name) ?? "";
}

function toResponse(s: Snapshot): Response {
  const body = s.status === 204 || s.status === 205 ? null : s.body;
  return new Response(body, {
    status: s.status,
    statusText: s.statusText,
    headers: s.headers,
  });
}

/** マスタキャッシュを捨てる (マスタ更新画面から呼ぶ / 書込検知で自動でも呼ばれる) */
export function clearMasterCache(): void {
  cache.clear();
}

export function createMasterCachingFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const table = tableOf(url);
    if (!table || !CACHEABLE_TABLES.has(table)) return base(input, init);

    const method = methodOf(input, init);
    if (method !== "GET") {
      // マスタが書き換わった → 以後の GET は引き直す
      cache.clear();
      return base(input, init);
    }
    // 中断可能なリクエストは共有すると他の呼出まで巻き込むので素通しする
    if (init?.signal || (input instanceof Request && input.signal)) return base(input, init);

    // .range() / count は Range・Prefer ヘッダで結果が変わるのでキーに含める
    const key = [
      url,
      headerOf(input, init, "range"),
      headerOf(input, init, "prefer"),
      headerOf(input, init, "accept"),
      headerOf(input, init, "accept-profile"),
    ].join("|");

    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < TTL_MS) {
      try {
        return toResponse(await hit.p);
      } catch {
        cache.delete(key); // 失敗したメモは残さず素通しで取り直す
        return base(input, init);
      }
    }

    const p = (async (): Promise<Snapshot> => {
      const res = await base(input, init);
      const headers = KEEP_HEADERS.flatMap((h) => {
        const v = res.headers.get(h);
        return v ? ([[h, v]] as [string, string][]) : [];
      });
      const snap: Snapshot = {
        status: res.status,
        statusText: res.statusText,
        headers,
        body: await res.text(),
      };
      // エラー応答は握らない (呼出側に そのまま返すが、メモには残さない)
      if (!res.ok) cache.delete(key);
      return snap;
    })();

    cache.set(key, { at: now, p });
    try {
      return toResponse(await p);
    } catch (e) {
      cache.delete(key);
      throw e;
    }
  };
}
