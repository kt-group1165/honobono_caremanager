import { createClient } from "@/lib/supabase/server";
import { ChiikiCertSection } from "./chiiki-cert-section";

/**
 * 地域生活支援 (市町村事業) 受給者証 — 障害福祉タブのサブタブ。
 * 旧: 受給者証(詳細)ページの最下部カード → 独立サブタブに分離 (2026-07-15)。
 * データ (chiiki_recipient_certs) は ChiikiCertSection が自前 fetch。ここでは
 * コピー補助用に障害福祉サービス受給者証の番号 (最新) だけ渡す。
 *
 * ⚠ 番号は shougai_certifications から引く。以前は client_disability_certifications
 *   という別テーブルを見ていたが、そちらは 0 件のまま使われておらず (取込も請求も
 *   shougai_certifications 側)、番号が常に null になっていた (2026-08-19 に統合)。
 */
export default async function ChiikiCertPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("shougai_certifications")
    .select("beneficiary_number")
    .eq("client_id", userId)
    .order("certification_start_date", { ascending: false, nullsFirst: false })
    .limit(1);

  const disabilityRecipientNumber =
    (data?.[0] as { beneficiary_number: string | null } | undefined)?.beneficiary_number ?? null;

  return (
    <div className="space-y-4">
      <ChiikiCertSection
        userId={userId}
        disabilityRecipientNumber={disabilityRecipientNumber}
      />
    </div>
  );
}
