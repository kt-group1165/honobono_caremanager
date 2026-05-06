import { createClient } from "@/lib/supabase/server";
import { StaffContent, type Staff } from "./staff-content";

export default async function StaffPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("members")
    .select("id, tenant_id, name, furigana, role, qualifications, email, phone, employment_type, hire_date, status, created_at")
    .order("furigana", { nullsFirst: false });
  const initialStaff: Staff[] = (data ?? []) as Staff[];
  return <StaffContent initialStaff={initialStaff} />;
}
