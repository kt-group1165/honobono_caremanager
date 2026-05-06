import { ClipboardCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  AssessmentsContent,
  type Assessment,
  type Certification,
  type KaigoUser,
} from "./assessments-content";

export default async function AssessmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;

  let initialUser: KaigoUser | null = null;
  let initialCertifications: Certification[] = [];
  let initialAssessments: Assessment[] = [];

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

    const initialCertId = initialCertifications[0]?.id ?? null;
    let q = supabase.from("kaigo_assessments").select("*").eq("user_id", userId);
    if (initialCertId) q = q.eq("certification_id", initialCertId);
    const { data: assessRes } = await q.order("assessment_date", { ascending: false });
    initialAssessments = (assessRes ?? []) as Assessment[];
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <AssessmentsContent
          key={userId}
          userId={userId}
          initialUser={initialUser}
          initialCertifications={initialCertifications}
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
