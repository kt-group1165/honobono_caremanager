import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UserDetailLayoutShell } from "./user-detail-layout-shell";
import { getClientById } from "./fetchers";

/**
 * 利用者詳細画面の共有レイアウト (RSC)
 *
 * server で user 本体 + 障害サービス利用フラグを 1 リクエストで取得し、
 * client shell に initial props として渡す。これにより:
 * - layout の mount 時 client fetch (clients / client_office_assignments) を排除
 * - サブタブ切替で発生していた hasDisabilityService 再フェッチを排除
 *   (RSC layout は params が変わらない限り再評価されないため)
 * - CSV import 後の更新は shell 側で router.refresh() を呼ぶことで反映される
 */

const DISABILITY_TRIGGER = ["居宅介護", "重度訪問介護", "同行援護"];

type AssignmentRow = { office_id: string; home_care_categories: unknown };

function computeHasDisabilityService(rows: AssignmentRow[]): boolean {
  return rows.some((row) => {
    const cats = Array.isArray(row.home_care_categories)
      ? row.home_care_categories
      : [];
    return cats.some(
      (c: { category?: string; active?: boolean }) =>
        !!c?.active && DISABILITY_TRIGGER.includes(c?.category ?? "")
    );
  });
}

export default async function UserDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // getClientById は React.cache 経由なので、page.tsx 側で再度呼ばれても同一 Promise が返り DB クエリは 1 回
  const [initialUser, assignsRes] = await Promise.all([
    getClientById(id),
    supabase
      .from("client_office_assignments")
      .select("office_id, home_care_categories")
      .eq("client_id", id)
      .is("end_date", null),
  ]);

  // [id] が無効 (削除済 / 別テナント / typo 等で DB に存在しない) なら
  // /users (= 自事業所一覧の 1 番上へ redirect する index) に飛ばす。
  // page.tsx 側でも null check しているが、layout で先に弾いた方が下位 fetch を回さずに済む。
  if (!initialUser) {
    redirect("/users");
  }

  const rows = (assignsRes.data ?? []) as AssignmentRow[];
  const initialHasDisabilityService = computeHasDisabilityService(rows);
  // 自事業所判定 (client-side で currentOffice と突合し、外れていたら shell が /users へ戻す)
  const initialAssignedOfficeIds = rows
    .map((r) => r.office_id)
    .filter((v): v is string => typeof v === "string");

  return (
    <UserDetailLayoutShell
      id={id}
      initialUser={initialUser}
      initialHasDisabilityService={initialHasDisabilityService}
      initialAssignedOfficeIds={initialAssignedOfficeIds}
    >
      {children}
    </UserDetailLayoutShell>
  );
}
