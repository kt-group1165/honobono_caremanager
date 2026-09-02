import { User } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import { resolvePreferredTenantId } from "@/lib/tenant-resolver";
import { getLatestDocumentForClient } from "@/lib/visit-procedure/queries";
import type { VisitProcedureDocument } from "@/lib/visit-procedure/types";
import {
  VisitRecordsContent,
  loadSchedules,
  loadMonthAddons,
  type VisitSchedule,
  type LoadMonthAddonsResult,
} from "./visit-records-content";

interface KaigoStaff {
  id: string;
  name: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = any;

const currentMonthStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export default async function VisitRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; office?: string }>;
}) {
  const { user: userId, office: officeId } = await searchParams;
  const supabase = await createClient();
  const month = currentMonthStr();

  const { data: staffData } = await supabase
    .from("members")
    .select("id, name")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("name");
  const initialStaff = (staffData ?? []) as KaigoStaff[];

  let initialRecords: AnyRecord[] = [];
  let initialUserName: string | null = null;
  // Phase Shougai-1: client の service_category を取得 (= form の radio デフォルト値に使う)
  // migration 未適用環境では undefined / null → form は 'kaigo' に固定
  let initialUserCategory: "kaigo" | "shougai" | "both" | null = null;
  if (userId) {
    const [recordsRes, clientRes] = await Promise.all([
      supabase
        .from("kaigo_visit_records")
        .select("*, members(name)")
        .eq("user_id", userId)
        .order("visit_date", { ascending: false })
        .order("start_time", { ascending: false }),
      supabase.from("clients").select("*").eq("id", userId).maybeSingle(),
    ]);
    // silent failure 防止: 取得失敗は「記録なし」に見えるため必ずログに残す
    if (recordsRes.error) console.error("[visit-records] records fetch failed:", recordsRes.error.message);
    if (clientRes.error) console.error("[visit-records] client fetch failed:", clientRes.error.message);
    initialRecords = (recordsRes.data ?? []).map((r: AnyRecord) => ({
      ...r,
      staff_name: r.members?.name ?? null,
    }));
    const clientData = clientRes.data as { name?: string; service_category?: "kaigo" | "shougai" | "both" | null } | null;
    initialUserName = clientData?.name ?? null;
    initialUserCategory = clientData?.service_category ?? null;
  }

  // 当月の訪問予定 + 手順書 (= officeId 不要) は user が居れば常に先読みする。
  // 月次加算は officeId が要るので ?office= 付きアクセス時のみ。
  let initialSchedules: VisitSchedule[] | null = null;
  let initialProcedureDoc: VisitProcedureDocument | null = null;
  let initialTenantId: string | null = null;
  let initialMonthAddons: LoadMonthAddonsResult | null = null;
  if (userId) {
    try {
      initialSchedules = await loadSchedules(supabase, userId, month);
    } catch (e) {
      console.error("[visit-records] schedules fetch failed:", e instanceof Error ? e.message : e);
    }

    const tenantResult = await resolvePreferredTenantId(supabase);
    if (tenantResult.ok) {
      initialTenantId = tenantResult.tenantId;
      try {
        initialProcedureDoc = await getLatestDocumentForClient(supabase, {
          tenantId: tenantResult.tenantId,
          clientId: userId,
          clientName: initialUserName,
        });
      } catch (e) {
        console.warn("[visit-records] procedure doc fetch failed:", e instanceof Error ? e.message : e);
      }
    }

    if (officeId) {
      try {
        initialMonthAddons = await loadMonthAddons(supabase, userId, officeId, month);
      } catch (e) {
        console.error("[visit-records] month addons fetch failed:", e instanceof Error ? e.message : e);
      }
    }
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      <UserSidebar />
      {userId ? (
        <VisitRecordsContent
          key={userId}
          userId={userId}
          userName={initialUserName}
          userCategory={initialUserCategory}
          initialRecords={initialRecords as never}
          initialStaff={initialStaff}
          initialMonth={month}
          initialSchedules={initialSchedules}
          initialProcedureDoc={initialProcedureDoc}
          initialTenantId={initialTenantId}
          initialOfficeId={officeId ?? null}
          initialMonthAddons={initialMonthAddons}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
          <div className="text-center">
            <User size={32} className="mx-auto mb-2 text-gray-300" />
            <p>左の利用者一覧から対象者を選択してください</p>
          </div>
        </div>
      )}
    </div>
  );
}
