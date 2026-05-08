import { format, getDaysInMonth } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  ProvisionTicketsContent,
  type GridState,
  type KaigoStaff,
  type KaigoUser,
  type OfficeInfo,
  type ServiceRow,
} from "./provision-tickets-content";

function makeRowKey(serviceType: string, startTime: string, endTime: string): string {
  return `${serviceType}__${startTime}__${endTime}`;
}

export default async function ProvisionTicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; office?: string }>;
}) {
  const { user: userId, office: officeId } = await searchParams;
  const supabase = await createClient();

  // 自事業所 (URL ?office=) のスタッフだけに絞り込む。officeId 未指定時は
  // BusinessTypeContext が初期化中なので空配列を返し、Client 側で再フェッチさせる想定。
  const staffQuery = officeId
    ? supabase.from("members").select("id, name").eq("status", "active").eq("office_id", officeId).order("name")
    : null;

  const [staffRes, serviceCodeRes, officeRes] = await Promise.all([
    staffQuery ?? Promise.resolve({ data: [] as { id: string; name: string }[] }),
    supabase.from("kaigo_service_codes").select("service_name, units").eq("calculation_type", "基本"),
    supabase.from("offices").select("provider_number:business_number, office_name:name").eq("app_type", "kaigo-app").limit(1).maybeSingle(),
  ]);
  const initialStaff = (staffRes.data ?? []) as KaigoStaff[];
  const initialOffice = (officeRes.data ?? null) as OfficeInfo | null;
  const initialServiceUnits: Record<string, number> = {};
  for (const sc of (serviceCodeRes.data ?? []) as { service_name: string; units: number }[]) {
    initialServiceUnits[sc.service_name] = sc.units;
  }

  let initialUser: KaigoUser | null = null;
  let initialServiceRows: ServiceRow[] = [];
  let initialGrid: GridState = {};

  if (userId) {
    const now = new Date();
    const monthStr = format(now, "yyyy-MM");
    const daysCount = getDaysInMonth(now);
    const from = `${monthStr}-01`;
    const to = `${monthStr}-${String(daysCount).padStart(2, "0")}`;

    const [userRes, scheduleRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, name_kana")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, members(name)")
        .eq("user_id", userId)
        .gte("visit_date", from)
        .lte("visit_date", to)
        .order("start_time"),
    ]);
    initialUser = (userRes.data ?? null) as KaigoUser | null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schedules = (scheduleRes.data ?? []).map((r: any) => ({
      id: r.id as string,
      user_id: r.user_id as string,
      staff_id: r.staff_id as string | null,
      visit_date: r.visit_date as string,
      start_time: r.start_time as string,
      end_time: r.end_time as string,
      service_type: r.service_type as string,
      status: r.status as string,
      staff_name: (r.members?.name ?? null) as string | null,
    }));

    const rowMap = new Map<string, ServiceRow>();
    for (const s of schedules) {
      const key = makeRowKey(s.service_type, s.start_time, s.end_time);
      if (!rowMap.has(key)) {
        rowMap.set(key, {
          key,
          service_type: s.service_type,
          start_time: s.start_time,
          end_time: s.end_time,
          staff_id: s.staff_id ?? undefined,
          staff_name: s.staff_name ?? undefined,
        });
      }
    }
    const newGrid: GridState = {};
    for (const [key] of rowMap) newGrid[key] = {};
    for (const s of schedules) {
      const key = makeRowKey(s.service_type, s.start_time, s.end_time);
      const day = parseInt(s.visit_date.split("-")[2], 10);
      if (!newGrid[key][day]) newGrid[key][day] = { planned: false, actual: false };
      if (s.status === "scheduled" || s.status === "changed") newGrid[key][day].planned = true;
      if (s.status === "completed") newGrid[key][day].actual = true;
    }
    initialServiceRows = Array.from(rowMap.values()).sort((a, b) => a.start_time.localeCompare(b.start_time));
    initialGrid = newGrid;
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <ProvisionTicketsContent
          key={userId}
          userId={userId}
          initialUser={initialUser}
          initialStaff={initialStaff}
          initialServiceUnits={initialServiceUnits}
          initialOffice={initialOffice}
          initialServiceRows={initialServiceRows}
          initialGrid={initialGrid}
        />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
            左の利用者一覧から利用者を選択してください
          </div>
        </div>
      )}
    </div>
  );
}
