import { createClient } from "@/lib/supabase/server";
import { WageSettingsContent, loadWageSettingsData, type WageSettingsData } from "./settings-content";

/**
 * /staff-payroll/settings — パート給与 サービス類型・時給・割当の設定 (事業所別)
 */
export default async function WageSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const { office: officeId } = await searchParams;

  let initialData: WageSettingsData | null = null;
  if (officeId) {
    const supabase = await createClient();
    try {
      initialData = await loadWageSettingsData(supabase, officeId);
    } catch {
      initialData = null;
    }
  }

  return <WageSettingsContent initialOfficeId={officeId ?? null} initialData={initialData} />;
}
