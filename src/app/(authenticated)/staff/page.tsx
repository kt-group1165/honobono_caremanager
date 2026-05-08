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
  // Phase 9-6: 既定では status='active' のみ取得 (退職者を非表示)。
  // 退職者は client 側で「退職者を含める」toggle ON 時に再フェッチ。
  // Phase 9 close: members.office_id DROP 済 → member_offices junction 経由で絞り込み
  let q = supabase
    .from("members")
    .select("id, tenant_id, name, furigana, role, qualifications, email, phone, employment_type, hire_date, status, created_at, member_offices!inner(office_id)")
    .eq("status", "active")
    .order("furigana", { nullsFirst: false });
  if (officeId) q = q.eq("member_offices.office_id", officeId);
  const { data } = await q;
  const initialStaff: Staff[] = (officeId ? (data ?? []) : []) as Staff[];
  return <StaffContent initialStaff={initialStaff} />;
}
