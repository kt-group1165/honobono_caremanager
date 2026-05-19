"use client";

import useSWR from "swr";
import { createClient } from "@/lib/supabase/client";
import type { VisitSchedule } from "@/app/(authenticated)/shift-management/_shared";

/**
 * kaigo_visit_schedule 取得 hook (SWR ベース、shift-management 専用)。
 *
 * 4 つの filter pattern を 1 つの hook で扱う:
 *   - `byUser` (userId 指定)        : 月内かつ user_id 一致 + members(name) JOIN
 *   - `byStaff` (staffId 指定)      : 月内かつ staff_id 一致 + clients(name) JOIN
 *   - `byDate` (date 指定、cross-staff): 日付完全一致 + members,clients JOIN (timeline 用)
 *   - `byMonthAll` (month 範囲全件) : user_calendar の allSchedules conflict 検知用
 *
 * 撤去の容易さ:
 *   - SWR は本 lib/swr/ ディレクトリの hook 内のみで使用。
 *   - component 側は `useKaigoVisitSchedules*` を呼び出すだけで、SWR の存在は隠蔽される。
 *
 * Cache key 形式:
 *   - kaigo-schedules:byUser:{userId}:{monthFrom}:{monthTo}
 *   - kaigo-schedules:byStaff:{staffId}:{monthFrom}:{monthTo}
 *   - kaigo-schedules:byDate:{dateStr}
 *   - kaigo-schedules:byMonthAll:{monthFrom}:{monthTo}
 *
 * fallbackData は SSR で fetch 済の初期データを SWR cache に流し込むために使用。
 */

// 共通 SWR options
const SWR_OPTIONS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  keepPreviousData: true,
} as const;

// ---------- byUser ----------

async function fetchByUser(
  userId: string,
  monthFrom: string,
  monthTo: string,
): Promise<VisitSchedule[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("kaigo_visit_schedule")
    .select(
      "id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, members(name)",
    )
    .eq("user_id", userId)
    .gte("visit_date", monthFrom)
    .lte("visit_date", monthTo)
    .order("start_time");
  if (error) throw error;
  type Row = {
    id: string;
    user_id: string;
    staff_id: string | null;
    visit_date: string;
    start_time: string | null;
    end_time: string | null;
    service_type: string;
    status: string | null;
    members: { name: string } | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    user_id: r.user_id,
    staff_id: r.staff_id,
    visit_date: r.visit_date,
    start_time: r.start_time,
    end_time: r.end_time,
    service_type: r.service_type,
    status: r.status ?? "scheduled",
    staff_name: r.members?.name ?? null,
  }));
}

export function useKaigoVisitSchedulesByUser(
  userId: string | null,
  monthFrom: string,
  monthTo: string,
  fallbackData?: VisitSchedule[],
) {
  const key = userId ? `kaigo-schedules:byUser:${userId}:${monthFrom}:${monthTo}` : null;
  const { data, error, isLoading, mutate } = useSWR<VisitSchedule[]>(
    key,
    () => fetchByUser(userId as string, monthFrom, monthTo),
    { ...SWR_OPTIONS, fallbackData },
  );
  return {
    schedules: data ?? [],
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}

// ---------- byStaff ----------

async function fetchByStaff(
  staffId: string,
  monthFrom: string,
  monthTo: string,
): Promise<VisitSchedule[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("kaigo_visit_schedule")
    .select(
      "id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, clients(name)",
    )
    .eq("staff_id", staffId)
    .gte("visit_date", monthFrom)
    .lte("visit_date", monthTo)
    .order("start_time");
  if (error) throw error;
  type Row = {
    id: string;
    user_id: string;
    staff_id: string | null;
    visit_date: string;
    start_time: string | null;
    end_time: string | null;
    service_type: string;
    status: string | null;
    clients: { name: string } | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    user_id: r.user_id,
    staff_id: r.staff_id,
    visit_date: r.visit_date,
    start_time: r.start_time,
    end_time: r.end_time,
    service_type: r.service_type,
    status: r.status ?? "scheduled",
    user_name: r.clients?.name ?? null,
  }));
}

export function useKaigoVisitSchedulesByStaff(
  staffId: string | null,
  monthFrom: string,
  monthTo: string,
  fallbackData?: VisitSchedule[],
) {
  const key = staffId ? `kaigo-schedules:byStaff:${staffId}:${monthFrom}:${monthTo}` : null;
  const { data, error, isLoading, mutate } = useSWR<VisitSchedule[]>(
    key,
    () => fetchByStaff(staffId as string, monthFrom, monthTo),
    { ...SWR_OPTIONS, fallbackData },
  );
  return {
    schedules: data ?? [],
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}

// ---------- byDate (timeline) ----------

async function fetchByDate(dateStr: string): Promise<VisitSchedule[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("kaigo_visit_schedule")
    .select(
      "id, user_id, staff_id, visit_date, start_time, end_time, service_type, members(name), clients(name)",
    )
    .eq("visit_date", dateStr)
    .order("start_time");
  if (error) throw error;
  type Row = {
    id: string;
    user_id: string;
    staff_id: string | null;
    visit_date: string;
    start_time: string | null;
    end_time: string | null;
    service_type: string;
    members: { name: string } | null;
    clients: { name: string } | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    user_id: r.user_id,
    staff_id: r.staff_id,
    visit_date: r.visit_date,
    start_time: r.start_time,
    end_time: r.end_time,
    service_type: r.service_type,
    staff_name: r.members?.name ?? null,
    user_name: r.clients?.name ?? null,
  }));
}

export function useKaigoVisitSchedulesByDate(
  dateStr: string | null,
  fallbackData?: VisitSchedule[],
) {
  const key = dateStr ? `kaigo-schedules:byDate:${dateStr}` : null;
  const { data, error, isLoading, mutate } = useSWR<VisitSchedule[]>(
    key,
    () => fetchByDate(dateStr as string),
    { ...SWR_OPTIONS, fallbackData },
  );
  return {
    schedules: data ?? [],
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}

// ---------- byMonthAll (user_calendar の allSchedules: conflict 検知用) ----------

async function fetchByMonthAll(
  monthFrom: string,
  monthTo: string,
): Promise<VisitSchedule[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("kaigo_visit_schedule")
    .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type")
    .gte("visit_date", monthFrom)
    .lte("visit_date", monthTo);
  if (error) throw error;
  return (data ?? []) as VisitSchedule[];
}

export function useKaigoVisitSchedulesByMonthAll(
  monthFrom: string,
  monthTo: string,
  fallbackData?: VisitSchedule[],
) {
  const key = `kaigo-schedules:byMonthAll:${monthFrom}:${monthTo}`;
  const { data, error, isLoading, mutate } = useSWR<VisitSchedule[]>(
    key,
    () => fetchByMonthAll(monthFrom, monthTo),
    { ...SWR_OPTIONS, fallbackData },
  );
  return {
    schedules: data ?? [],
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
