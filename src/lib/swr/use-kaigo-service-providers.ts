"use client";

import useSWR from "swr";
import { createClient } from "@/lib/supabase/client";

/**
 * kaigo_service_providers (active のみ) 一覧取得 hook (SWR ベース)。
 *
 * 撤去の容易さ:
 *   - SWR は本 lib/swr/ ディレクトリの hook 内のみで使用。
 *
 * Cache key: `kaigo-service-providers` (引数なし、global 固定)
 */

const SWR_OPTIONS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  keepPreviousData: true,
} as const;

export type KaigoServiceProvider = {
  id: string;
  provider_name: string;
};

async function fetchServiceProviders(): Promise<KaigoServiceProvider[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("kaigo_service_providers")
    .select("id, provider_name")
    .eq("status", "active")
    .order("provider_name");
  if (error) throw error;
  return (data ?? []) as KaigoServiceProvider[];
}

export function useKaigoServiceProviders(fallbackData?: KaigoServiceProvider[]) {
  const { data, error, isLoading, mutate } = useSWR<KaigoServiceProvider[]>(
    "kaigo-service-providers",
    fetchServiceProviders,
    { ...SWR_OPTIONS, fallbackData },
  );
  return {
    providers: data ?? [],
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
