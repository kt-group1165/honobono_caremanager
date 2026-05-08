import { createClient } from "@/lib/supabase/server";
import { StaffContent, type Staff } from "./staff-content";

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const params = await searchParams;
  const officeId = params.office;
  const supabase = await createClient();
  // 自事業所 (URL ?office=) のスタッフだけに絞り込む。officeId 未指定時は
  // BusinessTypeContext が初期化中なので空配列を返し、Client 側で再フェッチさせる。
  let q = supabase
    .from("members")
    .select("id, tenant_id, name, furigana, role, qualifications, email, phone, employment_type, hire_date, status, created_at")
    .order("furigana", { nullsFirst: false });
  if (officeId) q = q.eq("office_id", officeId);
  const { data } = await q;
  const initialStaff: Staff[] = (officeId ? (data ?? []) : []) as Staff[];
  return <StaffContent initialStaff={initialStaff} />;
}
