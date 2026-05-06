import { CalendarDays } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  PatternsContent,
  rowsToPatterns,
  type KaigoStaff,
  type VisitPattern,
  type VisitPatternRow,
} from "./patterns-content";

export default async function PatternsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;
  const supabase = await createClient();

  const staffRes = await supabase
    .from("members")
    .select("id, name, furigana")
    .eq("status", "active")
    .order("furigana", { nullsFirst: false });
  const initialStaff = (staffRes.data ?? []) as KaigoStaff[];

  let initialPatterns: VisitPattern[] = [];
  if (userId) {
    const { data } = await supabase
      .from("kaigo_visit_patterns")
      .select("id, user_id, pattern_name, day_of_week, start_time, end_time, service_type, staff_id")
      .eq("user_id", userId)
      .order("pattern_name");
    initialPatterns = rowsToPatterns((data ?? []) as VisitPatternRow[]);
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      <UserSidebar />
      {userId ? (
        <PatternsContent
          key={userId}
          userId={userId}
          initialPatterns={initialPatterns}
          initialStaff={initialStaff}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
          <div className="text-center">
            <CalendarDays size={32} className="mx-auto mb-2 text-gray-300" />
            <p>左のサイドバーから利用者を選択してください</p>
          </div>
        </div>
      )}
    </div>
  );
}
