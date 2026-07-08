import { createClient } from "@/lib/supabase/server";
import { KohiContent, type KohiRecord } from "./kohi-content";

/**
 * 公費 (生活保護等) タブ — client_kohi_records の独立管理
 * (旧: 介護認定タブ内の kohi_* 1 組。ほのぼのNEXT互換の別管理化)
 */
export default async function KohiPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = await params;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("client_kohi_records")
    .select("*")
    .eq("client_id", userId)
    .order("priority", { ascending: true })
    .order("start_date", { ascending: false, nullsFirst: false });

  // テーブル未作成 (migration 未適用) は空一覧 + バナー案内で続行
  const tableMissing =
    !!error && (error.code === "42P01" || error.code === "PGRST205");
  if (error && !tableMissing) {
    console.error("client_kohi_records fetch failed:", error.message);
  }

  const initialRecords: KohiRecord[] = (data ?? []) as KohiRecord[];

  return (
    <KohiContent
      userId={userId}
      initialRecords={initialRecords}
      tableMissing={tableMissing}
      loadError={error && !tableMissing ? error.message : null}
    />
  );
}
