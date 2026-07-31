import { createClient } from "@/lib/supabase/server";
import { resolveCertForMonth, type CertForMonth } from "@/lib/cert-for-month";
import { BenefitClaimsTabs } from "./_tabs";
import { loadClaimsData } from "../claims/claims-loader";
import {
  getCurrentMonth,
  type BenefitManagementRow,
  type CareCertification,
  type UserWithCert,
} from "./benefits-shared";

export default async function BenefitsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; office?: string }>;
}) {
  const sp = await searchParams;
  const initialTab = sp.tab === "claims" ? "claims" : "benefits";
  const supabase = await createClient();
  const month = getCurrentMonth();
  // 自事業所 (?office=)。給付管理は事業所ごとに独立なので必ず絞る。
  // 絞らないと全事業所分 (4事業所で 2000 行超) を読んで初期表示が重くなり、
  // 他事業所の利用者まで一覧に出てしまう。
  const officeId = typeof sp.office === "string" ? sp.office : null;

  // 給付管理は「当月の給付管理行がある利用者」しか表示しない (benefits-content の
  // aggregateUserGroups が rows を持つ利用者に filter)。全利用者を取得して全員分の
  // 認定を解決するのは遅い (全クライアント数に比例) ので、まず当月行を取り、
  // そこに出てくる利用者だけ 名前 + 認定 を解決する。
  const PAGE = 1000;

  // 自事業所の利用者
  const officeClientIds: string[] = [];
  if (officeId) {
    let fromA = 0;
    while (true) {
      const { data, error } = await supabase
        .from("client_office_assignments")
        .select("client_id")
        .eq("office_id", officeId)
        .order("client_id", { ascending: true })
        .range(fromA, fromA + PAGE - 1);
      if (error) break;
      if (!data || data.length === 0) break;
      officeClientIds.push(...data.map((a: { client_id: string }) => a.client_id));
      if (data.length < PAGE) break;
      fromA += PAGE;
    }
  }

  const rowsAll: BenefitManagementRow[] = [];
  if (!officeId || officeClientIds.length > 0) {
    // .in() の URI Too Long 回避のため chunk 化
    const CHUNK = 50;
    const idChunks: (string[] | null)[] = [];
    if (officeId) {
      for (let i = 0; i < officeClientIds.length; i += CHUNK) idChunks.push(officeClientIds.slice(i, i + CHUNK));
    } else {
      idChunks.push(null);
    }
    for (const idChunk of idChunks) {
      let from = 0;
      while (true) {
        let q = supabase
          .from("kaigo_benefit_management")
          .select("*")
          .eq("billing_month", month);
        if (idChunk) q = q.in("user_id", idChunk);
        const { data, error } = await q
          .order("user_id")
          .order("service_type")
          .range(from, from + PAGE - 1);
        if (error) break;
        if (!data || data.length === 0) break;
        rowsAll.push(...(data as BenefitManagementRow[]));
        if (data.length < PAGE) break;
        from += PAGE;
      }
    }
  }

  const userIds = Array.from(new Set(rowsAll.map((r) => r.user_id)));

  // 当月行の利用者の 名前 だけ取得 (active/非施設/未削除は従来どおり)
  type UsersRow = { id: string; name: string };
  const usersAll: UsersRow[] = [];
  for (let i = 0; i < userIds.length; i += 500) {
    const chunk = userIds.slice(i, i + 500);
    const { data, error } = await supabase
      .from("clients")
      .select("id, name")
      .in("id", chunk)
      .eq("status", "active")
      .eq("is_facility", false)
      .is("deleted_at", null)
      .order("name");
    if (error) break;
    usersAll.push(...((data ?? []) as UsersRow[]));
  }

  // 認定は「対象月に有効な 1 件」で解決 (対象は当月行の利用者のみ)
  const [cy, cm] = month.split("-").map(Number);
  let certRes = new Map<string, CertForMonth>();
  try {
    certRes = await resolveCertForMonth(supabase, userIds, cy, cm);
  } catch (e) {
    console.error("認定情報の取得に失敗:", e instanceof Error ? e.message : String(e));
  }

  const initialUsers: UserWithCert[] = usersAll.map((u) => {
    const cert = certRes.get(u.id);
    const certification: CareCertification | null = cert
      ? {
          id: "",
          client_id: u.id,
          insured_number: cert.insured_number ?? "",
          care_level: cert.care_level ?? "",
          service_limit_amount: cert.service_limit_amount ?? 0,
          insurer_number: cert.insurer_number ?? undefined,
        }
      : null;
    return { id: u.id, name: u.name, certification };
  });

  // レセプトタブ用データ (同じ月・同じ居宅介護支援 対象者)
  const claimsData = await loadClaimsData(supabase, month);

  return (
    <BenefitClaimsTabs
      initialTab={initialTab}
      benefitsProps={{
        initialMonth: month,
        initialUsers,
        initialRows: rowsAll,
      }}
      claimsProps={{
        initialBillingMonth: month,
        initialClaims: claimsData.initialClaims,
        initialCertEntries: claimsData.initialCertEntries,
        initialOfficeInfo: claimsData.initialOfficeInfo,
      }}
    />
  );
}
