"use client";

import useSWR from "swr";
import { createClient } from "@/lib/supabase/client";
import type { KaigoStaff } from "@/app/(authenticated)/shift-management/_shared";

/**
 * 自事業所 (officeId) に紐づく active member 一覧を取得する hook (SWR ベース)。
 *
 * Phase 9 close 以降: members.office_id DROP 済 → member_offices junction 経由で絞り込み。
 *
 * 撤去の容易さ:
 *   - SWR は本 lib/swr/ ディレクトリの hook 内のみで使用。
 *
 * Cache key: `kaigo-office-staff:{officeId}` (officeId 未指定時は fetch しない)
 */

const SWR_OPTIONS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  keepPreviousData: true,
} as const;

async function fetchOfficeStaff(officeId: string): Promise<KaigoStaff[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("members")
    .select("id, name, name_kana:furigana, status, member_offices!inner(office_id)")
    .eq("status", "active")
    .eq("member_offices.office_id", officeId)
    .order("furigana", { nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as KaigoStaff[];
}

export function useKaigoOfficeStaff(
  officeId: string | null,
  fallbackData?: KaigoStaff[],
) {
  const key = officeId ? `kaigo-office-staff:${officeId}` : null;
  const { data, error, isLoading, mutate } = useSWR<KaigoStaff[]>(
    key,
    () => fetchOfficeStaff(officeId as string),
    { ...SWR_OPTIONS, fallbackData },
  );
  return {
    staff: data ?? [],
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
