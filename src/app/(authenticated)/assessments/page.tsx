import { ClipboardCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import { formKindForCareLevel } from "@/lib/yobo-kubun";
import { AssessmentsShell } from "./_shell";
import type { Assessment, Certification, KaigoUser } from "./assessments-content";

// アセスメントは介護版 / 予防版で入口を分けない。
// 認定期間 (care_level) から様式を導出するので、server 側でも最新認定の区分で
// prefetch する assessment_type を決める。切替は _shell.tsx が担当。
export default async function AssessmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;

  let initialUser: KaigoUser | null = null;
  let initialCertifications: Certification[] = [];
  let initialAssessments: Assessment[] = [];
  let serverKind = formKindForCareLevel(null);
  let serverCertId: string | null = null;

  if (userId) {
    const supabase = await createClient();
    const [userRes, certRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, name_kana:furigana, gender")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("client_insurance_records")
        .select("id, care_level, start_date:certification_start_date, end_date:certification_end_date")
        .eq("client_id", userId)
        .order("certification_start_date", { ascending: false, nullsFirst: false }),
    ]);
    initialUser = (userRes.data ?? null) as KaigoUser | null;
    initialCertifications = (certRes.data ?? []) as Certification[];

    serverCertId = initialCertifications[0]?.id ?? null;
    serverKind = formKindForCareLevel(initialCertifications[0]?.care_level);

    let q = supabase
      .from("kaigo_assessments")
      .select("*")
      .eq("user_id", userId)
      .eq("assessment_type", serverKind);
    if (serverCertId) q = q.eq("certification_id", serverCertId);
    const { data: assessRes, error: assessError } = await q.order("assessment_date", { ascending: false });
    if (assessError) console.error("kaigo_assessments initial fetch failed:", assessError.message);
    initialAssessments = (assessRes ?? []) as Assessment[];
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <AssessmentsShell
          key={userId}
          userId={userId}
          initialUser={initialUser}
          initialCertifications={initialCertifications}
          serverKind={serverKind}
          serverCertId={serverCertId}
          initialAssessments={initialAssessments}
        />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <ClipboardCheck size={48} className="mb-4 text-gray-300" />
            <p className="text-gray-500 text-sm">利用者を選択してください</p>
          </div>
        </div>
      )}
    </div>
  );
}
