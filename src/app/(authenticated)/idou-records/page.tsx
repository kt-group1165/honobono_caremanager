import { createClient } from "@/lib/supabase/server";
import { IdouRecordsContent, loadIdouRecordsData, type IdouRecordsData } from "./idou-records-content";

export const metadata = { title: "移動支援記録 | 介護管理システム" };

export default async function IdouRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const { office: officeId } = await searchParams;
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  let initialData: IdouRecordsData | null = null;
  if (officeId) {
    const supabase = await createClient();
    try {
      initialData = await loadIdouRecordsData(supabase, officeId, month);
    } catch {
      initialData = null;
    }
  }

  return (
    <IdouRecordsContent
      initialOfficeId={officeId ?? null}
      initialMonth={month}
      initialData={initialData}
    />
  );
}
