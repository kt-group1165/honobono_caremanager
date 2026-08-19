import { createClient } from "@/lib/supabase/server";
import type { ShougaiCertification } from "@/types/database";
import { ContractsSection } from "./contracts-section";
import { ShougaiCertContent } from "./shougai-cert-content";

/**
 * 障害支援区分 (shougai_certifications) サブタブ
 *
 * 介護保険の「介護認定 (client_insurance_records)」に相当する障害版。
 * 1 利用者に複数の認定履歴を時系列で保持する。
 *
 * migration 未適用環境では shougai_certifications table が存在しないため、
 * select エラーを優しく空配列として扱う (= UI は「履歴なし」表示)。
 */
export default async function ShougaiCertPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = await params;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("shougai_certifications")
    .select("*")
    .eq("client_id", userId)
    .order("certification_start_date", { ascending: false, nullsFirst: false });

  // migration 未適用環境を想定: テーブル未存在 (= 42P01) の場合は黙って空配列にフォールバック
  if (error && error.code !== "42P01") {
    // 他のエラー (RLS など) はログに残す
    console.error("shougai_certifications fetch failed:", error.message);
  }

  const initialRecords: ShougaiCertification[] = (data ?? []) as ShougaiCertification[];

  return (
    <div className="space-y-4">
      <ShougaiCertContent userId={userId} initialRecords={initialRecords} />
      {/* 契約支給量 (shogai_contracts) — 受給者証の事業者記入欄に転記する自事業所の契約分。
          受給者証本体 (shougai_certifications) とは別テーブルなので独立して読み書きする */}
      <ContractsSection userId={userId} />
    </div>
  );
}
