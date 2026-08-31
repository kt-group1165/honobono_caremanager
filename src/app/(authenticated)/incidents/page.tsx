import { createClient } from "@/lib/supabase/server";
import { IncidentsContent, type ClientLite } from "./incidents-content";

// 事故報告書 / 苦情受付簿 (事業所単位の台帳)
//   2026-09-01 監査是正で新設。運営基準で作成・保存が義務なのに DB にもアプリにも
//   置き場が無く、実地指導で必ず求められる帳票が出せない状態だった。
//   保存先: migrations/incident_and_complaint_v1.sql
//
// 利用者の選択は任意 (職員の負傷・物損の事故、申出人が利用者でない苦情があるため)。
// 一覧・登録は client 側で行うので、ここでは選択肢用の利用者名だけ渡す。
export default async function IncidentsPage() {
  const supabase = await createClient();

  // 利用者名 (プルダウン用)。PostgREST の 1000 行キャップに当たるので page-loop する。
  const PAGE = 1000;
  const clients: ClientLite[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name")
      .order("furigana", { nullsFirst: false })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("incidents: clients fetch failed:", error.message);
      break;
    }
    const page = (data ?? []) as ClientLite[];
    clients.push(...page);
    if (page.length < PAGE) break;
  }

  return (
    <div className="flex h-full -m-6">
      <IncidentsContent clients={clients} />
    </div>
  );
}
