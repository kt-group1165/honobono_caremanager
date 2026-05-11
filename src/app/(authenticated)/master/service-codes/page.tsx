import { createClient } from "@/lib/supabase/server";
import { ServiceCodesContent, type ServiceCode } from "./service-codes-content";

type SystemValue = "介護" | "障害" | "総合事業";

const VALID_SYSTEMS: SystemValue[] = ["介護", "障害", "総合事業"];

/**
 * /master/service-codes
 *
 * 初期 fetch は ?system=介護|障害|総合事業 で server-side フィルタ。
 * default = '介護' (= 15K 件で初期表示を高速化)。
 * `?system=all` で全制度 (= 117K+ 件、遅い) を明示的に要求可能。
 */
export default async function ServiceCodesPage({
  searchParams,
}: {
  searchParams: Promise<{ system?: string }>;
}) {
  const sp = await searchParams;
  const rawSystem = sp.system ?? "介護";
  const initialSystem: SystemValue | "all" =
    rawSystem === "all"
      ? "all"
      : VALID_SYSTEMS.includes(rawSystem as SystemValue)
        ? (rawSystem as SystemValue)
        : "介護";

  const supabase = await createClient();

  // PostgREST default 1000 行制限を避けるため page-loop で全件取得
  const PAGE = 1000;
  const all: ServiceCode[] = [];
  let from = 0;
  while (true) {
    let query = supabase
      .from("kaigo_service_codes")
      .select("*")
      .order("service_category", { ascending: true })
      .order("service_code", { ascending: true })
      .range(from, from + PAGE - 1);
    // system が 'all' でなければ server-side フィルタで絞る
    if (initialSystem !== "all") {
      query = query.eq("system", initialSystem);
    }
    const { data, error } = await query;
    if (error) break;
    const rows = (data ?? []) as ServiceCode[];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return (
    <ServiceCodesContent
      initialRecords={all}
      initialSystem={initialSystem === "all" ? "" : initialSystem}
    />
  );
}
