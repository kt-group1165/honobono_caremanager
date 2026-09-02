import { createClient } from "@/lib/supabase/server";
import { SeikyuContent } from "./seikyu-content";
import { loadSeikyuData, type SeikyuInitialData } from "../_shared/load-seikyu-data";

/**
 * /billing-visit/seikyu — 請求 (1 画面タブ切替)
 * 月次情報 / 介護請求 / 利用請求 / 国保請求 をタブで切替える統合画面。
 *
 * Server Component: URL に ?office= がある時だけ当月の集計を先読みして
 * SeikyuProvider の初期 state にする (タブは client 側の state のままなので
 * 4 タブとも同じ先読み結果を共有できる)。?office= が無い時 (= BusinessTypeContext が
 * localStorage から解決する場合) は従来どおり client 側で集計する。
 */
export default async function SeikyuPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const { office: officeId } = await searchParams;

  let initialData: SeikyuInitialData | undefined;
  if (officeId) {
    const supabase = await createClient();
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    try {
      // 訪問入浴かどうかは offices.service_type で判定する
      // (client 側は BusinessTypeContext の businessType から同じ判定をしている)
      const { data: office, error } = await supabase
        .from("offices")
        .select("id, tenant_id, service_type")
        .eq("id", officeId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (office) {
        const o = office as { id: string; tenant_id: string; service_type: string | null };
        const d = await loadSeikyuData(supabase, {
          officeId: o.id,
          tenantId: o.tenant_id,
          year,
          month,
          isBath: o.service_type === "訪問入浴",
        });
        initialData = { officeId: o.id, year, month, ...d };
      }
    } catch (e) {
      // SSR 先読みの失敗は client 側の集計に委ねる (error boundary は出さない)
      console.error("[billing-visit/seikyu] SSR prefetch failed:", e);
      initialData = undefined;
    }
  }

  return <SeikyuContent initialData={initialData} />;
}
