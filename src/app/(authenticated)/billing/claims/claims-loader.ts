import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type CertMapEntry,
  type ClaimRow,
  type ClaimsOfficeInfo,
} from "./claims-shared";

export interface ClaimsLoadResult {
  initialClaims: ClaimRow[];
  initialCertEntries: [string, CertMapEntry][];
  initialOfficeInfo: ClaimsOfficeInfo;
}

/**
 * レセプト画面 (/billing/claims) の server-side データ読込。
 * 給付管理 (/billing/benefits) との統合タブでも再利用する。
 */
export async function loadClaimsData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase server client の型は呼出側で確定済
  supabase: SupabaseClient<any, any, any>,
  billingMonth: string,
): Promise<ClaimsLoadResult> {
  const [officeRes, claimsRes] = await Promise.all([
    supabase
      .from("offices")
      .select("tokutei_kassan_type, medical_cooperation_kassan, area_category, unit_price, provider_number:business_number")
      .eq("app_type", "kaigo-app")
      .limit(1)
      .maybeSingle(),
    supabase
      .from("kaigo_care_support_claims")
      .select("*, clients(name, name_kana:furigana, gender, phone, mobile_phone:mobile)")
      .eq("billing_month", billingMonth)
      .order("created_at", { ascending: true }),
  ]);

  const initialOfficeInfo = (officeRes.data ?? null) as ClaimsOfficeInfo;
  const initialClaims = ((claimsRes.data ?? []) as ClaimRow[]);

  const userIds = [...new Set(initialClaims.map((r) => r.user_id))];
  let initialCertEntries: [string, CertMapEntry][] = [];
  if (userIds.length > 0) {
    // PostgREST default 1000 行制限対策で page-loop で全件取得
    type CertRow = { client_id: string; care_level: string; insurer_number: string | null; insured_number: string | null; certification_start_date: string | null; certification_end_date: string | null };
    const PAGE = 1000;
    const certs: CertRow[] = [];
    let fromC = 0;
    while (true) {
      const { data } = await supabase
        .from("client_insurance_records")
        .select("client_id, care_level, insurer_number, insured_number, certification_start_date, certification_end_date")
        .in("client_id", userIds)
        .order("certification_start_date", { ascending: false, nullsFirst: false })
        .range(fromC, fromC + PAGE - 1);
      if (!data || data.length === 0) break;
      certs.push(...(data as CertRow[]));
      if (data.length < PAGE) break;
      fromC += PAGE;
    }
    // ── 対象月に有効な認定を選ぶ ────────────────────────────────────────
    // これは **初期表示用**。確定値は client 側の resolveCertForMonth
    // (lib/cert-for-month) が出すので、そちらと同じ選び方に寄せておく。
    //
    // ⚠ 以前は certification_date (認定年月日) の降順で先頭 1 件を採っていた。
    //   認定年月日は「いつ認定が下りたか」であって、どの認定が対象月に効くかとは
    //   別物。しかも 2026-08-31 まで 認定年月日は 94% が NULL で、順序が事実上
    //   不定だった (= 利用者によって別世代の要介護度・保険者番号が初期表示されうる)。
    const monthStart = `${billingMonth}-01`;
    const [my, mm] = billingMonth.split("-").map(Number);
    const monthEnd = `${billingMonth}-${String(new Date(my, mm, 0).getDate()).padStart(2, "0")}`;
    const coversMonth = (c: CertRow): boolean => {
      const s = c.certification_start_date;
      const e = c.certification_end_date;
      if (s && s > monthEnd) return false;      // 対象月より後に始まる認定
      if (e && e < monthStart) return false;    // 対象月より前に終わった認定
      return true;
    };
    const toEntry = (c: CertRow): CertMapEntry => ({
      care_level: c.care_level,
      insurer_number: c.insurer_number ?? null,
      insured_number: c.insured_number ?? null,
      start_date: c.certification_start_date ?? null,
      end_date: c.certification_end_date ?? null,
    });

    const map = new Map<string, CertMapEntry>();
    // certs は 認定開始日の降順。対象月に効くものを優先し、無ければ直近を使う
    for (const cert of certs) {
      if (!map.has(cert.client_id) && coversMonth(cert)) map.set(cert.client_id, toEntry(cert));
    }
    for (const cert of certs) {
      if (!map.has(cert.client_id)) map.set(cert.client_id, toEntry(cert));
    }
    initialCertEntries = [...map.entries()];
  }

  return { initialClaims, initialCertEntries, initialOfficeInfo };
}
