import { redirect } from "next/navigation";
import type { Client } from "@/types/database";
import { createClient } from "@/lib/supabase/server";
import { UserDetailContent } from "./user-detail-content";
import { getClientById } from "./fetchers";
import {
  normalizeCategories,
  type ClientMemoRow,
  type OfficeRow,
  type OfficeServiceRow,
} from "./user-detail-shared";

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // getClientById は React.cache 経由なので layout.tsx 側で既に取得済の場合は DB クエリ走らない
  const [user, officeRes, serviceRes, memoRes] = await Promise.all([
    getClientById(id),
    supabase
      .from("offices")
      .select("id, name, service_type")
      .eq("app_type", "kaigo-app")
      .order("name"),
    supabase
      .from("client_office_assignments")
      .select("*")
      .eq("client_id", id),
    supabase
      .from("client_memos")
      .select("id, client_id, scope, tenant_id, body")
      .eq("client_id", id)
      .eq("scope", "tenant"),
  ]);

  if (!user) {
    redirect("/users");
  }

  const initialUser = user as Client;
  const initialOffices = (officeRes.data ?? []) as OfficeRow[];
  const initialServices = ((serviceRes.data ?? []) as Record<string, unknown>[]).map((s) => ({
    ...s,
    home_care_categories: normalizeCategories(s.home_care_categories),
  })) as OfficeServiceRow[];
  const initialMemos = (memoRes.data ?? []) as ClientMemoRow[];

  return (
    <UserDetailContent
      id={id}
      initialUser={initialUser}
      initialOffices={initialOffices}
      initialServices={initialServices}
      initialMemos={initialMemos}
    />
  );
}
