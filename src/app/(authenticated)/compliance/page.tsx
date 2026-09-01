import { createClient } from "@/lib/supabase/server";
import { ComplianceContent, isMissingTable, type Row } from "./compliance-content";

// 体制整備の記録 (委員会・指針・研修・訓練・担当者選任)
//   2026-09-01 監査是正で新設。虐待防止 / BCP の 1% + 1% 減算の立証に直結する。
//   分野 (虐待防止 / 身体拘束 / 感染症 / BCP / ハラスメント) を 1 画面に統合した。
//   保存先: migrations/compliance_records_v1.sql (kaigo_compliance_records)
//
// 事業所単位の台帳なので利用者サイドバーは出さない。
export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const { office: officeId } = await searchParams;
  const year = String(new Date().getFullYear());

  let initialRows: Row[] = [];
  let initialTableMissing = false;
  if (officeId) {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("kaigo_compliance_records")
      .select("*")
      .eq("office_id", officeId)
      .gte("held_on", `${year}-01-01`)
      .lte("held_on", `${year}-12-31`)
      .order("held_on", { ascending: false });
    if (error) {
      if (isMissingTable(error.code)) initialTableMissing = true;
    } else {
      initialRows = (data ?? []) as Row[];
    }
  }

  return (
    <div className="flex h-full -m-6">
      <ComplianceContent
        initialOfficeId={officeId ?? null}
        initialYear={year}
        initialRows={initialRows}
        initialTableMissing={initialTableMissing}
      />
    </div>
  );
}
