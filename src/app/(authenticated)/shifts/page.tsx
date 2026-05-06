import { format, startOfMonth, endOfMonth } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { ShiftsContent, type Staff, type ShiftMap } from "./shifts-content";

export default async function ShiftsPage() {
  const supabase = await createClient();
  const now = new Date();
  const monthStart = format(startOfMonth(now), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(now), "yyyy-MM-dd");

  const [staffRes, shiftsRes] = await Promise.all([
    supabase
      .from("members")
      .select("id, name, furigana")
      .eq("status", "active")
      .order("furigana", { nullsFirst: false }),
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

  return (
    <ShiftsContent
      initialStaff={(staffRes.data ?? []) as Staff[]}
      initialShiftMap={map}
      initialMonthIso={now.toISOString()}
    />
  );
}
