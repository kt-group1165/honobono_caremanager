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
  searchParams: Promise<{ user?: string; office?: string }>;
}) {
  const { user: userId, office: officeId } = await searchParams;
  const supabase = await createClient();

  // 自事業所 (URL ?office=) のスタッフだけに絞り込む。
  // 全ての await を try/catch で包み SSR を落とさない (=空配列 fallback、
  //  client 側で再フェッチしてもらう)。
  let initialStaff: KaigoStaff[] = [];
  if (officeId) {
    try {
      const { data, error } = await supabase
        .from("members")
        .select("id, name, furigana, member_offices!inner(office_id)")
        .eq("status", "active")
        .eq("member_offices.office_id", officeId)
        .order("furigana", { nullsFirst: false });
      if (error) console.error("[patterns] staff fetch failed:", error.message);
      else initialStaff = (data ?? []) as KaigoStaff[];
    } catch (e) {
      console.error("[patterns] staff fetch threw:", e);
    }
  }

  let initialPatterns: VisitPattern[] = [];
  if (userId) {
    try {
      const { data, error } = await supabase
        .from("kaigo_visit_patterns")
        .select("id, user_id, pattern_name, day_of_week, start_time, end_time, service_type, staff_id")
        .eq("user_id", userId)
        .order("pattern_name");
      if (error) console.error("[patterns] patterns fetch failed:", error.message);
      else initialPatterns = rowsToPatterns((data ?? []) as VisitPatternRow[]);
    } catch (e) {
      console.error("[patterns] patterns fetch threw:", e);
    }
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
