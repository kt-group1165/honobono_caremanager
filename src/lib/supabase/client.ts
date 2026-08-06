import { createBrowserClient } from "@supabase/ssr";
import { createMasterCachingFetch } from "./master-cache-fetch";

let client: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  if (!client) {
    client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        // 世代管理マスタ (kaigo_service_codes) の GET だけ session 内でメモ化する。
        // 請求/売上エンジンが事業所ごとに同じコード表を引き直すのを 1 回にまとめる。
        global: { fetch: createMasterCachingFetch((...a) => fetch(...a)) },
      }
    );
  }
  return client;
}
