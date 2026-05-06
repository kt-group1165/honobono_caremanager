import { createClient } from "@/lib/supabase/server";
import type { FamilyContact } from "@/types/database";
import { FamilyContent } from "./family-content";

/**
 * /users/[id]/family
 * Server Component: userId に紐付く kaigo_family_contacts を取得し
 * FamilyContent (client) に initial props で渡す。
 */
export default async function FamilyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("kaigo_family_contacts")
    .select("*")
    .eq("user_id", userId)
    .order("is_key_person", { ascending: false });

  const initialRecords: FamilyContact[] = (data ?? []) as FamilyContact[];

  return <FamilyContent userId={userId} initialRecords={initialRecords} />;
}
