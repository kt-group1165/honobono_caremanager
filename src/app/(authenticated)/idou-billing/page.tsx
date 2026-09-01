import { createClient } from "@/lib/supabase/server";
import { IdouBillingContent, loadIdouBillingData, type IdouBillingData } from "./idou-billing-content";

export const metadata = { title: "地域生活支援 請求 | 介護管理システム" };

export default async function IdouBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const { office: officeId } = await searchParams;
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  let initialData: IdouBillingData | null = null;
  if (officeId) {
    const supabase = await createClient();
    try {
      initialData = await loadIdouBillingData(supabase, officeId, month);
    } catch {
      initialData = null;
    }
  }

  return (
    <IdouBillingContent
      initialOfficeId={officeId ?? null}
      initialMonth={month}
      initialData={initialData}
    />
  );
}
