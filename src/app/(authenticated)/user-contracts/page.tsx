import { FileSignature } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import type { UserContract } from "@/lib/user-contract/types";
import {
  UserContractsContent,
  type KaigoClient,
} from "./user-contracts-content";

export default async function UserContractsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;

  let initialUser: KaigoClient | null = null;
  let initialContracts: UserContract[] = [];

  if (userId) {
    const supabase = await createClient();
    const [userRes, contractRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, furigana")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("kaigo_user_contracts")
        .select("*")
        .eq("user_id", userId)
        .order("issued_date", { ascending: false })
        .order("created_at", { ascending: false }),
    ]);
    initialUser = (userRes.data ?? null) as KaigoClient | null;
    initialContracts = (contractRes.data ?? []) as UserContract[];
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <UserContractsContent
          key={userId}
          userId={userId}
          initialUser={initialUser}
          initialContracts={initialContracts}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="rounded-lg border bg-white py-16 text-center shadow-sm">
            <FileSignature size={40} className="mx-auto mb-3 text-gray-300" />
            <p className="text-sm text-gray-500">利用者を選択してください</p>
            <p className="mt-2 text-xs text-gray-400">
              重要事項説明書 / 契約書 / 個人情報同意書 を利用者ごとに管理します
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
