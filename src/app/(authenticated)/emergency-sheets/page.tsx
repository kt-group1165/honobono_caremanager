import { User } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import { EmergencySheetsContent } from "./emergency-sheets-content";
import {
  autoFillFromBaseData,
  emptySheet,
  type EmergencySheet,
  type EmergencyUserInfo,
} from "./_emergency-helpers";

export default async function EmergencySheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;

  if (!userId) {
    return (
      <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
        <UserSidebar />
        <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
          <div className="text-center">
            <User size={32} className="mx-auto mb-2 text-gray-300" />
            <p>利用者を選択してください</p>
          </div>
        </div>
      </div>
    );
  }

  const supabase = await createClient();
  const [{ data: userData }, { data: sheetData }] = await Promise.all([
    supabase.from("clients").select("name, name_kana:furigana, birth_date, gender, address, phone").eq("id", userId).maybeSingle(),
    supabase.from("kaigo_emergency_sheets").select("*").eq("user_id", userId).maybeSingle(),
  ]);

  const initialUserInfo = (userData ?? null) as EmergencyUserInfo | null;
  const base = sheetData ? (sheetData as EmergencySheet) : emptySheet(userId);
  const initialSheet = await autoFillFromBaseData(supabase, userId, base);

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      <UserSidebar />
      <EmergencySheetsContent
        key={userId}
        userId={userId}
        initialUserInfo={initialUserInfo}
        initialSheet={initialSheet}
      />
    </div>
  );
}
