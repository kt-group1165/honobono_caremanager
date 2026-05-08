import { format, startOfMonth, endOfMonth } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { ShiftsContent, type Staff, type ShiftMap } from "./shifts-content";

export default async function ShiftsPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const params = await searchParams;
  const officeId = params.office;
  const supabase = await createClient();
  const now = new Date();
  const monthStart = format(startOfMonth(now), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(now), "yyyy-MM-dd");

  // 自事業所 (URL ?office=) のスタッフだけに絞り込む。officeId 未指定時は
  // BusinessTypeContext が初期化中なので空配列を返し、Client 側で再フェッチさせる。
  let staffQ = supabase
    .from("members")
    .select("id, name, furigana")
    .eq("status", "active")
    .order("furigana", { nullsFirst: false });
  if (officeId) staffQ = staffQ.eq("office_id", officeId);

  const [staffRes, shiftsRes] = await Promise.all([
    staffQ,
    supabase
      .from("kaigo_shifts")
      .select("*")
      .gte("shift_date", monthStart)
      .lte("shift_date", monthEnd),
  ]);

  const map: ShiftMap = {};
  for (const shift of (shiftsRes.data ?? []) as { staff_id: string; shift_date: string; shift_type: string }[]) {
    if (!map[shift.staff_id]) map[shift.staff_id] = {};
    map[shift.staff_id][shift.shift_date] = shift.shift_type as ShiftMap[string][string];
  }

  const initialStaff: Staff[] = (officeId ? (staffRes.data ?? []) : []) as Staff[];

  return (
    <ShiftsContent
      initialStaff={initialStaff}
      initialShiftMap={map}
      initialMonthIso={now.toISOString()}
    />
  );
}
