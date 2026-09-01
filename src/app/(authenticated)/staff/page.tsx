import { createClient } from "@/lib/supabase/server";
import { StaffContent, loadStaffData, type Staff } from "./staff-content";

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const params = await searchParams;
  const officeId = params.office;
  // officeId 未指定時は BusinessTypeContext が初期化中なので空配列を返し、
  // Client 側で再フェッチさせる。Phase 9-6: 既定では status='active' のみ
  // (退職者は client 側で「退職者を含める」toggle ON 時に再フェッチ)。
  let initialStaff: Staff[] = [];
  let initialPartColumnMissing = false;
  // SSR fetch が実際に成功した場合だけ officeId を渡す。失敗時は null のままにして
  // content 側の isInitialMount skip が働かないようにし、client 側で必ず再取得させる。
  let loadedOfficeId: string | null = null;
  if (officeId) {
    const supabase = await createClient();
    try {
      const result = await loadStaffData(supabase, officeId, false);
      initialStaff = result.staff;
      initialPartColumnMissing = result.partColumnMissing;
      loadedOfficeId = officeId;
    } catch (e) {
      // SSR で失敗しても client 側の fetchStaff が再取得するので致命的ではない
      console.error("[staff/page] 職員データの取得に失敗:", e instanceof Error ? e.message : e);
    }
  }
  return (
    <StaffContent
      initialOfficeId={loadedOfficeId}
      initialStaff={initialStaff}
      initialPartColumnMissing={initialPartColumnMissing}
    />
  );
}
