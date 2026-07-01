import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { RecipientEditForm } from "./_edit-form";

export default async function RecipientEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: cert, error } = await supabase
    .from("shogai_recipient_certs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return <div className="p-6 text-sm text-red-600">読取失敗: {error.message}</div>;
  }
  if (!cert) notFound();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name, furigana, user_number")
    .eq("id", cert.client_id)
    .maybeSingle();

  const { data: allocations } = await supabase
    .from("shogai_benefit_allocations")
    .select("*")
    .eq("cert_id", id);

  return (
    <div className="space-y-4 p-4">
      <Link
        href="/shogai/recipients"
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft size={16} /> 一覧へ戻る
      </Link>

      <div className="rounded border bg-white p-4 shadow-sm">
        <h1 className="text-xl font-bold">
          {client?.name ?? "(利用者不明)"}
          {client?.furigana && (
            <span className="ml-2 text-sm font-normal text-gray-500">
              {client.furigana}
            </span>
          )}
        </h1>
        <p className="mt-1 text-xs text-gray-500">
          利用者番号: {client?.user_number ?? "—"}
        </p>
      </div>

      <RecipientEditForm
        cert={cert}
        allocations={allocations ?? []}
      />
    </div>
  );
}
