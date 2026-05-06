// shift-management 共通の types / constants / helpers
// page.tsx (server) と各 client component から import する。

export interface KaigoUser {
  id: string;
  name: string;
  name_kana: string;
  status: string;
}

export interface KaigoStaff {
  id: string;
  name: string;
  name_kana: string;
  status: string;
}

export interface VisitSchedule {
  id: string;
  user_id: string;
  staff_id: string | null;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  service_type: string;
  status?: string; // scheduled=予定, completed=実績, cancelled, changed
  staff_name?: string | null;
  user_name?: string | null;
  _isCopy?: boolean; // ローカル複写行（未保存）
}

export interface StaffAvailabilitySlot {
  staff_id: string;
  available_date: string;
  start_time: string;
  end_time: string;
  is_available: boolean;
}

export interface VisitPattern {
  id: string;
  user_id: string;
  pattern_name: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  service_type: string;
  staff_id: string | null;
  staff_name?: string | null;
  user_name?: string | null;
}

export interface StaffToken {
  id: string;
  staff_id: string;
  token: string;
  staff_name?: string;
}

export type SidebarTab = "user" | "staff";
export type ViewMode = "calendar" | "timeline" | "monthly-individual";

export const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

export const SERVICE_TYPE_COLORS: Record<string, string> = {
  身体介護: "bg-blue-100 text-blue-700",
  生活援助: "bg-green-100 text-green-700",
  "身体・生活": "bg-purple-100 text-purple-700",
  通院等乗降介助: "bg-orange-100 text-orange-700",
};

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function isStaffUnavailableAtTime(
  staffId: string,
  dateStr: string,
  startTime: string | null,
  endTime: string | null,
  availability: StaffAvailabilitySlot[]
): boolean {
  if (!startTime) return false;
  const staffSlots = availability.filter((a) => a.staff_id === staffId);
  if (staffSlots.length === 0) return false; // No monthly data at all
  const slots = staffSlots.filter((a) => a.available_date === dateStr);
  if (slots.length === 0) return true; // Has monthly data but no record for this day = unavailable
  const sMin = timeToMinutes(startTime);
  const eMin = endTime ? timeToMinutes(endTime) : sMin + 60;
  // Check if any slot is unavailable that overlaps with schedule time
  for (const slot of slots) {
    if (!slot.is_available) {
      const slotStart = timeToMinutes(slot.start_time);
      const slotEnd = timeToMinutes(slot.end_time);
      if (sMin < slotEnd && eMin > slotStart) return true;
    }
  }
  // If staff has availability records for this date but no slot covers the schedule time, treat as unavailable
  const availableSlots = slots.filter((s) => s.is_available);
  if (slots.length > 0 && availableSlots.length > 0) {
    const covered = availableSlots.some((slot) => {
      const slotStart = timeToMinutes(slot.start_time);
      const slotEnd = timeToMinutes(slot.end_time);
      return slotStart <= sMin && eMin <= slotEnd;
    });
    return !covered;
  }
  return false;
}
