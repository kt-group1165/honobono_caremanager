"use client";

import useSWR from "swr";
import { createClient } from "@/lib/supabase/client";
import type { StaffAvailabilitySlot } from "@/app/(authenticated)/shift-management/_shared";

// SWR 返り値の参照安定化 (data??[] を毎回新配列にすると無限再レンダの温床)
const EMPTY_AVAIL: never[] = [];

/**
 * kaigo_staff_availability_monthly 取得 hook (SWR ベース)。
 *
 * staffId が指定された場合は単一 staff の slot、null なら全 staff (timeline / user_calendar 用)。
 *
 * 撤去の容易さ:
 *   - SWR は本 lib/swr/ ディレクトリの hook 内のみで使用。
 *
 * Cache key: `kaigo-availability:{staffId|"all"}:{monthFrom}:{monthTo}`
 */

const SWR_OPTIONS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  keepPreviousData: true,
} as const;

async function fetchAvailability(
  staffId: string | null,
  monthFrom: string,
  monthTo: string,
): Promise<StaffAvailabilitySlot[]> {
  const supabase = createClient();
  let q = supabase
    .from("kaigo_staff_availability_monthly")
    .select("staff_id, available_date, start_time, end_time, is_available")
    .gte("available_date", monthFrom)
    .lte("available_date", monthTo);
  if (staffId) q = q.eq("staff_id", staffId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as StaffAvailabilitySlot[];
}

export function useKaigoAvailability(
  staffId: string | null,
  monthFrom: string,
  monthTo: string,
  fallbackData?: StaffAvailabilitySlot[],
) {
  const key = `kaigo-availability:${staffId ?? "all"}:${monthFrom}:${monthTo}`;
  const { data, error, isLoading, mutate } = useSWR<StaffAvailabilitySlot[]>(
    key,
    () => fetchAvailability(staffId, monthFrom, monthTo),
    { ...SWR_OPTIONS, fallbackData },
  );
  return {
    availability: data ?? EMPTY_AVAIL,
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
