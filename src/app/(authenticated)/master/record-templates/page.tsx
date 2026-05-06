import { createClient } from "@/lib/supabase/server";
import { RecordTemplatesContent, type Template } from "./record-templates-content";

/**
 * /master/record-templates
 * Server Component: kaigo_record_templates を取得し、
 * RecordTemplatesContent (client) に initial props で渡す。
 */
export default async function RecordTemplatesPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("kaigo_record_templates")
    .select("*")
    .order("sort_order");
  const initialTemplates: Template[] = (data ?? []) as Template[];
  return <RecordTemplatesContent initialTemplates={initialTemplates} />;
}
