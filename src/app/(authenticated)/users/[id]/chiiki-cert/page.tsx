import { createClient } from "@/lib/supabase/server";
import { ChiikiCertSection } from "../disability/chiiki-cert-section";

/**
 * 地域生活支援 (市町村事業) 受給者証 — 障害福祉タブのサブタブ。
 * 旧: 受給者証(詳細)ページの最下部カード → 独立サブタブに分離 (2026-07-15)。
 * データ (chiiki_recipient_certs) は ChiikiCertSection が自前 fetch。ここでは
 * コピー補助用に障害福祉サービス受給者証の番号 (最新) だけ渡す。
 */
export default async function ChiikiCertPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("client_disability_certifications")
    .select("recipient_number")
    .eq("user_id", userId)
    .order("period_start", { ascending: false, nullsFirst: false })
    .limit(1);

  const disabilityRecipientNumber =
    (data?.[0] as { recipient_number: string | null } | undefined)?.recipient_number ?? null;

  return (
    <div className="space-y-4">
      <ChiikiCertSection
        userId={userId}
        disabilityRecipientNumber={disabilityRecipientNumber}
      />
    </div>
  );
}
