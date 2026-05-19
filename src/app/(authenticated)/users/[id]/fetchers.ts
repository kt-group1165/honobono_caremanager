import { cache } from "react";
import type { Client } from "@/types/database";
import { createClient } from "@/lib/supabase/server";

/**
 * React.cache でラップした server-side fetcher。
 * 同一 request 内で同じ引数で呼ばれると Promise が共有されるので、
 * layout.tsx と page.tsx の両方から呼んでも DB クエリは 1 回しか走らない。
 *
 * 撤去容易性: cache() を外して直接 supabase call にすれば従来挙動に戻る。
 */

export const getClientById = cache(async (id: string): Promise<Client | null> => {
  const supabase = await createClient();
  const { data } = await supabase.from("clients").select("*").eq("id", id).maybeSingle();
  return (data ?? null) as Client | null;
});
