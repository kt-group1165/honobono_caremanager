import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { RecipientForm } from "./_form";

export default async function NewRecipientPage() {
  const supabase = await createClient();
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name, furigana, user_number, tenant_id")
    .order("name")
    .limit(1000);

  return (
    <div className="space-y-4 p-4">
      <div>
        <Link
          href="/shogai/recipients"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft size={16} /> 一覧へ戻る
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold">障害福祉 受給者証 新規登録</h1>
      </div>
      <RecipientForm
        clients={
          (clients ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            furigana: c.furigana,
            tenant_id: c.tenant_id,
          }))
        }
      />
    </div>
  );
}
