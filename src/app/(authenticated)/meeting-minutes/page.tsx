import { MessagesSquare } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  getUserLite,
  getCarePlans,
  getLatestCertification,
  getMeetingDocs,
} from "@/lib/meeting-minutes/queries";
import type {
  CarePlanSummary,
  CertificationLite,
  KaigoUserLite,
  MeetingDoc,
} from "@/lib/meeting-minutes/types";
import { MeetingMinutesContent } from "./meeting-minutes-content";

export default async function MeetingMinutesPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;

  let initialUser: KaigoUserLite | null = null;
  let initialCarePlans: CarePlanSummary[] = [];
  let initialDocs: MeetingDoc[] = [];
  let initialCertification: CertificationLite | null = null;

  if (userId) {
    const supabase = await createClient();
    const [userRes, planRes, certRes] = await Promise.all([
      getUserLite(supabase, userId),
      getCarePlans(supabase, userId),
      getLatestCertification(supabase, userId),
    ]);
    initialUser = userRes;
    initialCarePlans = planRes;
    initialCertification = certRes;

    const initialPlanId =
      initialCarePlans.find((p) => p.status === "active")?.id
      ?? initialCarePlans[0]?.id
      ?? null;
    initialDocs = await getMeetingDocs(supabase, userId, initialPlanId);
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <MeetingMinutesContent
          key={userId}
          userId={userId}
          initialUser={initialUser}
          initialCarePlans={initialCarePlans}
          initialDocs={initialDocs}
          initialCertification={initialCertification}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <MessagesSquare size={48} className="mb-4 text-gray-300" />
            <p className="text-sm">利用者を選択してください</p>
          </div>
        </div>
      )}
    </div>
  );
}
