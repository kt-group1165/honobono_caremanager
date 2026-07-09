import Link from "next/link";
import { AlertTriangle, FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import { CARE_REPORT_CONFIG } from "./care-report-config";
import { CareReportsContent, type CareReportDoc } from "./care-reports-content";

export default async function CareReportTypePage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<{ user?: string }>;
}) {
  const [{ type: reportType }, { user: userId }] = await Promise.all([params, searchParams]);
  const config = CARE_REPORT_CONFIG[reportType];

  if (!config) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-500">
        <AlertTriangle size={40} className="mb-3 text-amber-400" />
        <p className="text-lg font-semibold text-gray-700">不明な帳票種別です</p>
        <Link href="/reports" className="mt-4 text-sm text-blue-600 hover:underline">
          帳票一覧に戻る
        </Link>
      </div>
    );
  }

  let initialDocs: CareReportDoc[] = [];

  if (userId) {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("kaigo_report_documents")
      .select("*")
      .eq("user_id", userId)
      .eq("report_type", reportType)
      .order("updated_at", { ascending: false });
    if (error) {
      console.error("care-reports initial fetch failed:", error.message);
    }
    initialDocs = (data as CareReportDoc[]) ?? [];
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <CareReportsContent userId={userId} reportType={reportType} initialDocs={initialDocs} />
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="no-print flex flex-col items-center justify-center py-24 text-gray-400">
            <FileText size={48} className="mb-4 text-gray-300" />
            <p className="text-base font-medium">左側のリストから利用者を選択してください</p>
          </div>
        </div>
      )}
    </div>
  );
}
