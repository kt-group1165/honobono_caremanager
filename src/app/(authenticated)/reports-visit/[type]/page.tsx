import Link from "next/link";
import { ChevronLeft, FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  emptyContent,
  REPORT_CONFIG,
  ReportsVisitContent,
  type VisitCarePlanContent,
} from "./reports-visit-content";

export default async function ReportsVisitPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<{ user?: string }>;
}) {
  const [{ type: reportType }, { user: userId }] = await Promise.all([params, searchParams]);
  const config = REPORT_CONFIG[reportType];

  if (!config) {
    return (
      <div className="p-6">
        <p>不明な帳票タイプです: {reportType}</p>
        <Link href="/reports-visit" className="text-blue-600 hover:underline">戻る</Link>
      </div>
    );
  }

  let initialContent: VisitCarePlanContent = emptyContent();
  let initialDocId: string | null = null;

  if (userId) {
    const supabase = await createClient();
    const [userRes, certRes, docRes, officeRes] = await Promise.all([
      supabase
        .from("clients")
        .select("name, name_kana:furigana, gender, birth_date, address, phone")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("client_insurance_records")
        .select("care_level, start_date:certification_start_date, end_date:certification_end_date")
        .eq("client_id", userId)
        .eq("certification_status", "認定済み")
        .order("certification_start_date", { ascending: false, nullsFirst: false })
        .limit(1),
      supabase
        .from("kaigo_report_documents")
        .select("id, content")
        .eq("user_id", userId)
        .eq("report_type", reportType)
        .order("updated_at", { ascending: false })
        .limit(1),
      supabase
        .from("offices")
        .select("office_name:name, manager_name")
        .eq("app_type", "kaigo-app")
        .eq("service_type", "訪問介護")
        .eq("is_active", true)
        .limit(1),
    ]);

    let c: VisitCarePlanContent = emptyContent();
    if (docRes.data && docRes.data.length > 0) {
      c = { ...emptyContent(), ...(docRes.data[0].content as Partial<VisitCarePlanContent>) };
      initialDocId = docRes.data[0].id;
    }

    const userData = userRes.data;
    if (userData) {
      c.user_name = c.user_name || userData.name || "";
      c.user_kana = c.user_kana || userData.name_kana || "";
      c.user_gender = c.user_gender || userData.gender || "";
      c.user_birth_date = c.user_birth_date || userData.birth_date || "";
      c.user_address = c.user_address || userData.address || "";
      c.user_phone = c.user_phone || userData.phone || "";
      if (!c.user_age && userData.birth_date) {
        const age = new Date().getFullYear() - new Date(userData.birth_date).getFullYear();
        c.user_age = String(age);
      }
    }
    const cert = certRes.data?.[0];
    if (cert) {
      c.care_level = c.care_level || cert.care_level || "";
      c.cert_period = c.cert_period || (cert.start_date && cert.end_date
        ? `${cert.start_date} 〜 ${cert.end_date}` : "");
    }
    const office = officeRes.data?.[0];
    if (office) {
      c.office_name = c.office_name || office.office_name || "";
      c.manager_name = c.manager_name || office.manager_name || "";
    }
    initialContent = c;
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      <div className="print:hidden">
        <UserSidebar />
      </div>
      {userId ? (
        <ReportsVisitContent
          key={userId}
          userId={userId}
          reportType={reportType}
          initialContent={initialContent}
          initialDocId={initialDocId}
        />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="sticky top-0 z-10 border-b bg-white px-6 py-4 flex items-center justify-between print:hidden">
            <div className="flex items-center gap-3">
              <Link href="/reports-visit" className="text-gray-400 hover:text-gray-600"><ChevronLeft size={20} /></Link>
              <div>
                <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  <FileText size={22} className="text-emerald-600" />
                  {config.titleJa}
                </h1>
                <p className="text-xs text-gray-500">{config.titleEn}</p>
              </div>
            </div>
          </div>
          <div className="flex h-48 items-center justify-center text-sm text-gray-400">
            利用者を選択してください
          </div>
        </div>
      )}
    </div>
  );
}
