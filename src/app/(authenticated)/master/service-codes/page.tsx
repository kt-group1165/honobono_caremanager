import { createClient } from "@/lib/supabase/server";
import { ServiceCodesContent, type ServiceCode } from "./service-codes-content";

type SystemValue = "介護" | "障害" | "総合事業";

const VALID_SYSTEMS: SystemValue[] = ["介護", "障害", "総合事業"];

/**
 * /master/service-codes
 *
 * 初期 fetch は ?system=介護|障害|総合事業 で server-side フィルタ。
 * default = '介護' (= 高速)。?system=all で全制度。
 *
 * 性能最適化: page-loop を廃止し、limit 2000 で 1 クエリのみ。
 * 「適用日 = 本日」「指定 system」で絞ると大半は 2000 件以下に収まる。
 * 超過時は client 側で「全件取得 (重い)」ボタンを表示する設計。
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

  // 初期表示: 適用日=今日 で絞り、limit 2000 まで取得 (= 大半は 2000 件以内)
  const today = new Date().toISOString().split("T")[0];
  let query = supabase
    .from("kaigo_service_codes")
    .select("*", { count: "exact" })
    .lte("valid_from", today)
    .or(`valid_until.is.null,valid_until.gte.${today}`)
    .order("system", { ascending: true })
    .order("service_category", { ascending: true })
    .order("service_code", { ascending: true })
    .limit(2000);
  if (initialSystem !== "all") {
    query = query.eq("system", initialSystem);
  }
  const { data, count } = await query;
  const initialRecords: ServiceCode[] = (data ?? []) as ServiceCode[];

  return (
    <ServiceCodesContent
      initialRecords={initialRecords}
      initialSystem={initialSystem === "all" ? "" : initialSystem}
      initialTotalCount={count ?? initialRecords.length}
    />
  );
}
