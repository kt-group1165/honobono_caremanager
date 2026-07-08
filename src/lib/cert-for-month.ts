import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 認定情報 (client_insurance_records) を「対象月に有効な認定」で解決する共有リゾルバ。
 *
 * 背景 (2026-07-08 総点検): 各画面が「effective_date / certification_start_date の
 * 最新 1 件」を使っていたため、月遅れ再請求で認定更新・区分変更を跨ぐと
 * 古い提供月のレセプトに新しい要介護度・負担割合・被保険者番号が載っていた。
 *
 * 選択規則:
 *   1. certification_start_date <= 対象月末 かつ (certification_end_date IS NULL
 *      または >= 対象月初) の行のうち、certification_start_date が最新のもの
 *   2. 該当なしなら従来どおり最新 1 件 (isFallback=true) — 認定期間未入力の
 *      既存データを壊さないための安全網
 *
 * 日付は 'YYYY-MM-DD' の文字列比較 (Date パースなし = タイムゾーン安全)。
 */

export interface CertForMonth {
  insurer_number: string | null;
  insurer_name: string | null;
  insured_number: string | null;
  care_level: string | null;
  copay_rate: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  certification_status: string | null;
  service_limit_amount: number | null;
  care_office_id: string | null;
  care_office_number: string | null;
  care_office_name: string | null;
  effective_date: string | null;
  /** 対象月に有効な認定が無く「最新 1 件」へフォールバックした */
  isFallback: boolean;
}

interface DbRow {
  client_id: string;
  insurer_number: string | null;
  insurer_name: string | null;
  insured_number: string | null;
  care_level: string | null;
  copay_rate: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  certification_status: string | null;
  service_limit_amount: number | null;
  care_office_id: string | null;
  care_office_number: string | null;
  care_office_name: string | null;
  effective_date: string | null;
}

const SELECT_COLS =
  "client_id, insurer_number, insurer_name, insured_number, care_level, copay_rate, " +
  "certification_start_date, certification_end_date, certification_status, service_limit_amount, " +
  "care_office_id, care_office_number, care_office_name, effective_date";

const PAGE = 1000;
const IN_CHUNK = 50;

/** 対象月の月初/月末 ('YYYY-MM-DD')。ローカル演算のみで TZ 安全 */
export function monthRange(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate(); // ローカル。toISOString は使わない
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * clientIds ごとに対象月 (year, month) に有効な認定を解決する。
 * 戻り値の Map に無い client は認定レコード自体が 0 件。
 */
export async function resolveCertForMonth(
  supabase: SupabaseClient,
  clientIds: string[],
  year: number,
  month: number,
): Promise<Map<string, CertForMonth>> {
  const out = new Map<string, CertForMonth>();
  const ids = Array.from(new Set(clientIds));
  if (ids.length === 0) return out;
  const { from: monthStart, to: monthEnd } = monthRange(year, month);

  // client ごとの全認定行を集める (chunk + order 付き page-loop)
  const byClient = new Map<string, DbRow[]>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("client_insurance_records")
        .select(SELECT_COLS)
        .in("client_id", chunk)
        .order("client_id", { ascending: true })
        .order("certification_start_date", { ascending: false, nullsFirst: false })
        .order("effective_date", { ascending: false, nullsFirst: false })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`認定情報の取得に失敗: ${error.message}`);
      const rows = (data ?? []) as unknown as DbRow[];
      for (const r of rows) {
        if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
        byClient.get(r.client_id)!.push(r);
      }
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
  }

  for (const [clientId, rows] of byClient) {
    // 1) 対象月に有効な認定 (start <= 月末 AND (end IS NULL OR end >= 月初))
    const inMonth = rows.filter((r) => {
      if (!r.certification_start_date) return false;
      if (r.certification_start_date > monthEnd) return false;
      if (r.certification_end_date && r.certification_end_date < monthStart) return false;
      return true;
    });
    // rows は start_date DESC 順なので先頭が「対象月に有効な最新の認定」
    const picked = inMonth[0] ?? rows[0];
    if (!picked) continue;
    out.set(clientId, {
      insurer_number: picked.insurer_number,
      insurer_name: picked.insurer_name,
      insured_number: picked.insured_number,
      care_level: picked.care_level,
      copay_rate: picked.copay_rate,
      certification_start_date: picked.certification_start_date,
      certification_end_date: picked.certification_end_date,
      certification_status: picked.certification_status,
      service_limit_amount: picked.service_limit_amount,
      care_office_id: picked.care_office_id,
      care_office_number: picked.care_office_number,
      care_office_name: picked.care_office_name,
      effective_date: picked.effective_date,
      isFallback: inMonth.length === 0,
    });
  }
  return out;
}
