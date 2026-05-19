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
      const { data: assigns } = await supabase
        .from("client_office_assignments")
        .select("client_id")
        .eq("office_id", officeId)
        .is("end_date", null)
        .range(fromA, fromA + PAGE - 1);
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
        const { data } = await supabase
          .from("clients")
          .select("id, name, name_kana:furigana, status")
          .in("id", chunk)
          .eq("status", "active")
          .eq("is_facility", false)
          .order("furigana", { nullsFirst: false });
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
      const { data } = await supabase
        .from("clients")
        .select("id, name, name_kana:furigana, status")
        .eq("status", "active")
        .eq("is_facility", false)
        .order("furigana", { nullsFirst: false })
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      users.push(...(data as KaigoUser[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  const staffRes = await staffQuery;
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

  if (view === "calendar" && tab === "user" && selectedUserId) {
    const [schedRes, availRes, allStaffRes, allSchedRes, provRes] = await Promise.all([
      supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, members(name)")
        .eq("user_id", selectedUserId)
        .gte("visit_date", monthFrom)
        .lte("visit_date", monthTo)
        .order("start_time"),
      supabase
        .from("kaigo_staff_availability_monthly")
        .select("staff_id, available_date, start_time, end_time, is_available")
        .gte("available_date", monthFrom)
        .lte("available_date", monthTo),
      // 自事業所 (URL ?office=) のスタッフのみ。未指定時は空 → Client 側で再フェッチ。
      officeId
        ? supabase
            .from("members")
            .select("id, name, name_kana:furigana, status, member_offices!inner(office_id)")
            .eq("status", "active")
            .eq("member_offices.office_id", officeId)
        : Promise.resolve({ data: [] as KaigoStaff[] }),
      supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type")
        .gte("visit_date", monthFrom)
        .lte("visit_date", monthTo),
      supabase.from("kaigo_service_providers").select("id, provider_name").eq("status", "active").order("provider_name"),
    ]);
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
      availability: ((availRes.data ?? []) as StaffAvailabilitySlot[]),
      allStaff: ((allStaffRes.data ?? []) as KaigoStaff[]),
      allProviders: (provRes.data ?? []) as { id: string; provider_name: string }[],
      allSchedules: ((allSchedRes.data ?? []) as VisitSchedule[]),
    };
  } else if (view === "calendar" && tab === "staff" && selectedStaffId) {
    const [schedRes, availRes] = await Promise.all([
      supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, clients(name)")
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
    const [schedRes, availRes] = await Promise.all([
      supabase
        .from("kaigo_visit_schedule")
        .select(
          "id, user_id, staff_id, visit_date, start_time, end_time, service_type, members(name), clients(name)"
        )
        .eq("visit_date", dateStr)
        .order("start_time"),
      supabase
        .from("kaigo_staff_availability_monthly")
        .select("staff_id, available_date, start_time, end_time, is_available")
        .gte("available_date", format(startOfMonth(date), "yyyy-MM-dd"))
        .lte("available_date", format(endOfMonth(date), "yyyy-MM-dd")),
    ]);
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
      availability: ((availRes.data ?? []) as StaffAvailabilitySlot[]),
    };
  } else if (view === "monthly-individual") {
    const entityId = tab === "user" ? selectedUserId : selectedStaffId;
    if (entityId) {
      const col = tab === "user" ? "user_id" : "staff_id";
      const { data } = await supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, clients(name), members(name)")
        .eq(col, entityId)
        .gte("visit_date", monthFrom)
        .lte("visit_date", monthTo)
        .order("visit_date")
        .order("start_time");
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
