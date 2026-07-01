import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { NewRecordForm } from "./_form";

export default async function NewShogaiRecordPage() {
  const supabase = await createClient();
  const [{ data: clients }, { data: codes }] = await Promise.all([
    supabase
      .from("clients")
      .select("id, name, furigana, tenant_id")
      .order("name")
      .limit(1000),
    supabase
      .from("shogai_service_codes")
      .select("id, service_type, service_category, code, name, unit_count, min_minutes, max_minutes, is_addon")
      .eq("fiscal_year", 2024)
      .eq("is_active", true)
      .order("service_type")
      .order("code"),
  ]);

  return (
    <div className="space-y-4 p-4">
      <Link
        href="/shogai/records"
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft size={16} /> 実績一覧へ戻る
      </Link>
      <h1 className="text-2xl font-bold">障害福祉 サービス提供記録 新規</h1>
      <NewRecordForm
        clients={(clients ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          furigana: c.furigana,
          tenant_id: c.tenant_id,
        }))}
        codes={codes ?? []}
      />
    </div>
  );
}
