import { format, startOfMonth, endOfMonth } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import {
  ShiftManagementContent,
  type ShiftManagementContentProps,
} from "./shift-management-content";
import type {
  KaigoStaff,
  KaigoUser,
  SidebarTab,
  StaffAvailabilitySlot,
  ViewMode,
  VisitSchedule,
} from "./_shared";
import type { UserCalendarInitialData } from "./user-calendar-content";
import type { StaffCalendarInitialData } from "./staff-calendar-content";
import type { TimelineInitialData } from "./timeline-view-content";
import type { MonthlyIndividualInitialData } from "./monthly-individual-content";

// Next.js 16: searchParams は Promise<...> で渡される (await 必須)。
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md 参照。

type SearchParams = Promise<{
  tab?: string;
  view?: string;
  user?: string;
  staff?: string;
  month?: string; // YYYY-MM
  date?: string; // YYYY-MM-DD
  office?: string;
}>;

function parseTab(v: string | undefined): SidebarTab {
  return v === "staff" ? "staff" : "user";
}

function parseView(v: string | undefined): ViewMode {
  if (v === "timeline" || v === "monthly-individual") return v;
  return "calendar";
}

function parseMonth(v: string | undefined): Date {
  if (v && /^\d{4}-\d{2}$/.test(v)) {
    const [y, m] = v.split("-").map(Number);
    return new Date(y, m - 1, 1);
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function parseDate(v: string | undefined): Date {
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date();
}

// PostgREST default 1000 行制限対策の page-loop。error は throw して
// 呼出側 try-catch (= initial null → client SWR 再フェッチ) に委ねる。
async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export default async function ShiftManagementPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const officeId = sp.office;
  const supabase = await createClient();

  const tab = parseTab(sp.tab);
  const view = parseView(sp.view);
  const month = parseMonth(sp.month);
  const date = parseDate(sp.date);

  // 自事業所 (URL ?office=) のスタッフだけに絞り込む。officeId 未指定時は
  // BusinessTypeContext が初期化中なので空配列を返し、Client 側で再フェッチさせる。
  // Phase 9 close: members.office_id DROP 済 → member_offices junction 経由で絞り込み
  let staffQuery = supabase
    .from("members")
    .select("id, name, name_kana:furigana, status, member_offices!inner(office_id)")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("furigana", { nullsFirst: false });
  if (officeId) staffQuery = staffQuery.eq("member_offices.office_id", officeId);

  // 自事業所 (URL ?office=) の利用者だけに絞る:
  //   1) client_office_assignments で officeId に紐づく client_id を全件取得 (page-loop)
  //   2) その client_id 集合に対して clients を fetch
  // user-sidebar.tsx と同じ pattern。PostgREST default 1000 行制限を超える前提で page-loop。
  // officeId 未指定時は旧挙動 (全件) を維持 → Client 側で再フェッチさせる。
  const PAGE = 1000;
  const users: KaigoUser[] = [];
  if (officeId) {
    const clientIdsAll: string[] = [];
    let fromA = 0;
    while (true) {
      const { data: assigns, error: assignsErr } = await supabase
        .from("client_office_assignments")
        .select("client_id")
        .eq("office_id", officeId)
        .is("end_date", null)
        .order("id").range(fromA, fromA + PAGE - 1);
      // SSR 失敗は client 側 SWR (useKaigoOfficeUsers) が自力再フェッチする。
      // silent にはしない (= log は残す)。
      if (assignsErr) {
        console.error("[shift-management] client_office_assignments fetch failed:", assignsErr.message);
        break;
      }
      if (!assigns || assigns.length === 0) break;
      clientIdsAll.push(
        ...(assigns as { client_id: string }[]).map((a) => a.client_id),
      );
      if (assigns.length < PAGE) break;
      fromA += PAGE;
    }
    const uniqueClientIds = Array.from(new Set(clientIdsAll));

    if (uniqueClientIds.length > 0) {
      let fromU = 0;
      while (true) {
        // .in() は内部 URL length 制限があるため、安全側で 500 件ずつ chunk
        const chunk = uniqueClientIds.slice(fromU, fromU + 500);
        if (chunk.length === 0) break;
        const { data, error: clientsErr } = await supabase
          .from("clients")
          .select("id, name, name_kana:furigana, status")
          .in("id", chunk)
          .eq("status", "active")
          .eq("is_facility", false)
          .is("deleted_at", null)
          .order("furigana", { nullsFirst: false });
        if (clientsErr) {
          console.error("[shift-management] clients fetch failed:", clientsErr.message);
          break;
        }
        if (data && data.length > 0) {
          users.push(...(data as KaigoUser[]));
        }
        fromU += 500;
      }
    }
  } else {
    // officeId 未指定 (= context 初期化中): 全件 fallback (= 旧挙動)
    let from = 0;
    while (true) {
      const { data, error: clientsErr } = await supabase
        .from("clients")
        .select("id, name, name_kana:furigana, status")
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("furigana", { nullsFirst: false })
        .range(from, from + PAGE - 1);
      if (clientsErr) {
        console.error("[shift-management] clients fetch failed:", clientsErr.message);
        break;
      }
      if (!data || data.length === 0) break;
      users.push(...(data as KaigoUser[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  const staffRes = await staffQuery;
  if (staffRes.error) {
    // client 側 SWR (useKaigoOfficeStaff) が自力再フェッチするため空で継続 (log は残す)
    console.error("[shift-management] members fetch failed:", staffRes.error.message);
  }
  const staff: KaigoStaff[] = (officeId ? (staffRes.data ?? []) : []) as KaigoStaff[];

  const selectedUserId =
    sp.user ?? (users.length > 0 ? users[0].id : null);
  const selectedStaffId =
    sp.staff ?? (staff.length > 0 ? staff[0].id : null);

  const monthFrom = format(startOfMonth(month), "yyyy-MM-dd");
  const monthTo = format(endOfMonth(month), "yyyy-MM-dd");
  const dateStr = format(date, "yyyy-MM-dd");

  // Fetch only the data needed for the initial visible view.
  let initialUserCalendarData: UserCalendarInitialData | null = null;
  let initialStaffCalendarData: StaffCalendarInitialData | null = null;
  let initialTimelineData: TimelineInitialData | null = null;
  let initialMonthlyIndividualData: MonthlyIndividualInitialData | null = null;

  // SSR で query が throw しても error boundary を出さず、
  // client 側で再フェッチさせる (initial* は null のまま = client は SWR で自力取得)
  try {
  if (view === "calendar" && tab === "user" && selectedUserId) {
    // availability / allSchedules (全利用者×月内) は 1000 行を超えうるため page-loop。
    // error は fetchAllRows / 個別チェックで throw → catch で initial null → client 再フェッチ。
    const [schedRes, availRows, allStaffRes, allSchedRows, provRes] = await Promise.all([
      supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, staff_id, staff_id_2, staff_id_3, visit_date, start_time, end_time, service_type, system, status, members!kaigo_visit_schedule_staff_id_fkey(name)")
        .eq("user_id", selectedUserId)
        .gte("visit_date", monthFrom)
        .lte("visit_date", monthTo)
        .order("start_time"),
      fetchAllRows<StaffAvailabilitySlot>((from, to) =>
        supabase
          .from("kaigo_staff_availability_monthly")
          .select("staff_id, available_date, start_time, end_time, is_available")
          .gte("available_date", monthFrom)
          .lte("available_date", monthTo)
          .order("staff_id", { ascending: true })
          .order("available_date", { ascending: true })
          .order("start_time", { ascending: true })
          .order("id").range(from, to),
      ),
      // 自事業所 (URL ?office=) のスタッフのみ。未指定時は空 → Client 側で再フェッチ。
      officeId
        ? supabase
            .from("members")
            .select("id, name, name_kana:furigana, status, member_offices!inner(office_id)")
            .eq("status", "active")
            .is("deleted_at", null)
            .eq("member_offices.office_id", officeId)
        : Promise.resolve({ data: [] as KaigoStaff[], error: null }),
      fetchAllRows<VisitSchedule>((from, to) =>
        supabase
          .from("kaigo_visit_schedule")
          .select("id, user_id, staff_id, staff_id_2, staff_id_3, visit_date, start_time, end_time, service_type")
          .gte("visit_date", monthFrom)
          .lte("visit_date", monthTo)
          .order("id", { ascending: true })
          .range(from, to),
      ),
      supabase.from("kaigo_service_providers").select("id, provider_name").eq("status", "active").order("provider_name"),
    ]);
    if (schedRes.error) throw new Error(schedRes.error.message);
    if (allStaffRes.error) throw new Error(allStaffRes.error.message);
    if (provRes.error) throw new Error(provRes.error.message);
    type SchedRow = {
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
    const mapped: VisitSchedule[] = ((schedRes.data ?? []) as unknown as SchedRow[]).map((r) => ({
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
    initialUserCalendarData = {
      schedules: mapped,
      availability: availRows,
      allStaff: ((allStaffRes.data ?? []) as KaigoStaff[]),
      allProviders: (provRes.data ?? []) as { id: string; provider_name: string }[],
      allSchedules: allSchedRows,
    };
  } else if (view === "calendar" && tab === "staff" && selectedStaffId) {
    const [schedRes, availRes] = await Promise.all([
      supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, staff_id, staff_id_2, staff_id_3, visit_date, start_time, end_time, service_type, status, clients(name)")
        .eq("staff_id", selectedStaffId)
        .gte("visit_date", monthFrom)
        .lte("visit_date", monthTo)
        .order("start_time"),
      supabase
        .from("kaigo_staff_availability_monthly")
        .select("staff_id, available_date, start_time, end_time, is_available")
        .eq("staff_id", selectedStaffId)
        .gte("available_date", monthFrom)
        .lte("available_date", monthTo),
    ]);
    if (schedRes.error) throw new Error(schedRes.error.message);
    if (availRes.error) throw new Error(availRes.error.message);
    type SchedRow = {
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
    const mapped: VisitSchedule[] = ((schedRes.data ?? []) as unknown as SchedRow[]).map((r) => ({
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
    initialStaffCalendarData = {
      schedules: mapped,
      availability: ((availRes.data ?? []) as StaffAvailabilitySlot[]),
    };
  } else if (view === "timeline") {
    const [schedRes, availRows] = await Promise.all([
      supabase
        .from("kaigo_visit_schedule")
        .select(
          "id, user_id, staff_id, staff_id_2, staff_id_3, visit_date, start_time, end_time, service_type, members!kaigo_visit_schedule_staff_id_fkey(name), clients(name)"
        )
        .eq("visit_date", dateStr)
        .order("start_time"),
      fetchAllRows<StaffAvailabilitySlot>((from, to) =>
        supabase
          .from("kaigo_staff_availability_monthly")
          .select("staff_id, available_date, start_time, end_time, is_available")
          .gte("available_date", format(startOfMonth(date), "yyyy-MM-dd"))
          .lte("available_date", format(endOfMonth(date), "yyyy-MM-dd"))
          .order("staff_id", { ascending: true })
          .order("available_date", { ascending: true })
          .order("start_time", { ascending: true })
          .range(from, to),
      ),
    ]);
    if (schedRes.error) throw new Error(schedRes.error.message);
    type SchedRow = {
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
    const mapped: VisitSchedule[] = ((schedRes.data ?? []) as unknown as SchedRow[]).map((r) => ({
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
    initialTimelineData = {
      schedules: mapped,
      availability: availRows,
    };
  } else if (view === "monthly-individual") {
    const entityId = tab === "user" ? selectedUserId : selectedStaffId;
    if (entityId) {
      const col = tab === "user" ? "user_id" : "staff_id";
      const { data, error } = await supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, staff_id, staff_id_2, staff_id_3, visit_date, start_time, end_time, service_type, status, clients(name), members!kaigo_visit_schedule_staff_id_fkey(name)")
        .eq(col, entityId)
        .gte("visit_date", monthFrom)
        .lte("visit_date", monthTo)
        .order("visit_date")
        .order("start_time");
      if (error) throw new Error(error.message);
      type SchedRow = {
        id: string;
        user_id: string;
        staff_id: string | null;
        visit_date: string;
        start_time: string | null;
        end_time: string | null;
        service_type: string;
        status: string | null;
        clients: { name: string } | null;
        members: { name: string } | null;
      };
      const mapped: VisitSchedule[] = ((data ?? []) as unknown as SchedRow[]).map((r) => ({
        id: r.id,
        user_id: r.user_id,
        staff_id: r.staff_id,
        visit_date: r.visit_date,
        start_time: r.start_time,
        end_time: r.end_time,
        service_type: r.service_type,
        status: r.status ?? "scheduled",
        user_name: r.clients?.name ?? null,
        staff_name: r.members?.name ?? null,
      }));
      initialMonthlyIndividualData = { schedules: mapped };
    }
  }
  } catch (e) {
    // SSR fetch 失敗を SWR 側の再フェッチに委ねる。ここで throw させると error boundary が出て
    // ユーザーは Reload しか選べなくなるため、log して null で継続。
    console.error("[shift-management] SSR fetch failed:", e);
  }

  const props: ShiftManagementContentProps = {
    initialUsers: users,
    initialStaff: staff,
    initialTab: tab,
    initialView: view,
    initialSelectedUserId: selectedUserId,
    initialSelectedStaffId: selectedStaffId,
    initialMonthIso: month.toISOString(),
    initialDateIso: date.toISOString(),
    initialUserCalendarData,
    initialStaffCalendarData,
    initialTimelineData,
    initialMonthlyIndividualData,
  };

  return <ShiftManagementContent {...props} />;
}
