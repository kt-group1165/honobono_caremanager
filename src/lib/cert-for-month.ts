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
 * client ごとの全認定行を集める (chunk + order 付き page-loop)。
 * per-client の並びは certification_start_date DESC, effective_date DESC
 * (resolveCertForMonth 従来の取得順そのまま)。
 */
async function fetchCertRowsByClient(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, DbRow[]>> {
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
  return byClient;
}

function toCertForMonth(r: DbRow, isFallback: boolean): CertForMonth {
  return {
    insurer_number: r.insurer_number,
    insurer_name: r.insurer_name,
    insured_number: r.insured_number,
    care_level: r.care_level,
    copay_rate: r.copay_rate,
    certification_start_date: r.certification_start_date,
    certification_end_date: r.certification_end_date,
    certification_status: r.certification_status,
    service_limit_amount: r.service_limit_amount,
    care_office_id: r.care_office_id,
    care_office_number: r.care_office_number,
    care_office_name: r.care_office_name,
    effective_date: r.effective_date,
    isFallback,
  };
}

/** 対象月に有効な認定か (start <= 月末 AND (end IS NULL OR end >= 月初)) */
const isValidInMonth = (r: DbRow, monthStart: string, monthEnd: string): boolean => {
  if (!r.certification_start_date) return false;
  if (r.certification_start_date > monthEnd) return false;
  if (r.certification_end_date && r.certification_end_date < monthStart) return false;
  return true;
};

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

  const byClient = await fetchCertRowsByClient(supabase, ids);

  for (const [clientId, rows] of byClient) {
    // 1) 対象月に有効な認定 (start <= 月末 AND (end IS NULL OR end >= 月初))
    const inMonth = rows.filter((r) => isValidInMonth(r, monthStart, monthEnd));
    // rows は start_date DESC 順なので先頭が「対象月に有効な最新の認定」
    const picked = inMonth[0] ?? rows[0];
    if (!picked) continue;
    out.set(clientId, toCertForMonth(picked, inMonth.length === 0));
  }
  return out;
}

/**
 * clientIds ごとに「対象月に有効な全認定行」を certification_start_date 昇順で返す
 * (月途中の資格変更 = 区分変更/保険者変更 の検出用。Phase 1)。
 *
 * resolveCertForMonth と違いフォールバックしない — 対象月に有効な認定が 1 件も無い
 * client は Map に入らない。同一 certification_start_date の重複行 (編集履歴・二重登録)
 * は effective_date が最新の 1 件に dedupe する (誤検出防止)。
 */
export async function resolveCertsInMonth(
  supabase: SupabaseClient,
  clientIds: string[],
  year: number,
  month: number,
): Promise<Map<string, CertForMonth[]>> {
  const out = new Map<string, CertForMonth[]>();
  const ids = Array.from(new Set(clientIds));
  if (ids.length === 0) return out;
  const { from: monthStart, to: monthEnd } = monthRange(year, month);

  const byClient = await fetchCertRowsByClient(supabase, ids);

  for (const [clientId, rows] of byClient) {
    // rows は start DESC, effective DESC — 同一 start は先頭 (= 最新 effective) を採用
    const seenStart = new Set<string>();
    const inMonth: DbRow[] = [];
    for (const r of rows) {
      if (!isValidInMonth(r, monthStart, monthEnd)) continue;
      const start = r.certification_start_date!;
      if (seenStart.has(start)) continue;
      seenStart.add(start);
      inMonth.push(r);
    }
    if (inMonth.length === 0) continue;
    inMonth.reverse(); // start DESC → ASC (時系列順)
    out.set(
      clientId,
      inMonth.map((r) => toCertForMonth(r, false)),
    );
  }
  return out;
}

// ─── 月途中の資格変更 検出 (Phase 1: 検出のみ。レセプト行の分割は Phase 2) ──────

export interface MidMonthCertChange {
  /**
   * ケース2: 保険者番号 / 被保険者番号 の月内変更 (転居等)。
   * boundaryDate = 変更後認定の certification_start_date。
   */
  insurerChange: {
    fromInsurer: string | null;
    toInsurer: string | null;
    fromInsured: string | null;
    toInsured: string | null;
    boundaryDate: string | null;
  } | null;
  /**
   * ケース3: care_level の月内変更 (区分変更)。
   * crossesSystem = 要支援 (事業対象者含む) ↔ 要介護 の制度跨ぎ。
   */
  careLevelChange: {
    from: string;
    to: string;
    boundaryDate: string | null;
    crossesSystem: boolean;
  } | null;
}

const isYoboKubun = (level: string) => /要支援|事業対象者/.test(level);
const trimOrEmpty = (v: string | null | undefined) => (v ?? "").trim();

/**
 * resolveCertsInMonth の結果 (start 昇順) から月内の資格変更を検出する。
 * 片方が未入力 (null/空) の項目は変更とみなさない (データ入力途中の誤検出防止)。
 * 変更なし (または認定が 1 件以下) は null。
 */
export function detectMidMonthChange(certs: CertForMonth[]): MidMonthCertChange | null {
  if (certs.length < 2) return null;
  let insurerChange: MidMonthCertChange["insurerChange"] = null;
  let careLevelChange: MidMonthCertChange["careLevelChange"] = null;
  for (let i = 1; i < certs.length; i++) {
    const prev = certs[i - 1];
    const cur = certs[i];
    const boundary = cur.certification_start_date;
    if (!insurerChange) {
      const pIns = trimOrEmpty(prev.insurer_number);
      const cIns = trimOrEmpty(cur.insurer_number);
      const pNo = trimOrEmpty(prev.insured_number);
      const cNo = trimOrEmpty(cur.insured_number);
      const insurerDiff = pIns !== "" && cIns !== "" && pIns !== cIns;
      const insuredDiff = pNo !== "" && cNo !== "" && pNo !== cNo;
      if (insurerDiff || insuredDiff) {
        insurerChange = {
          fromInsurer: prev.insurer_number,
          toInsurer: cur.insurer_number,
          fromInsured: prev.insured_number,
          toInsured: cur.insured_number,
          boundaryDate: boundary,
        };
      }
    }
    if (!careLevelChange) {
      const pLv = trimOrEmpty(prev.care_level);
      const cLv = trimOrEmpty(cur.care_level);
      if (pLv !== "" && cLv !== "" && pLv !== cLv) {
        careLevelChange = {
          from: pLv,
          to: cLv,
          boundaryDate: boundary,
          crossesSystem: isYoboKubun(pLv) !== isYoboKubun(cLv),
        };
      }
    }
    if (insurerChange && careLevelChange) break;
  }
  if (!insurerChange && !careLevelChange) return null;
  return { insurerChange, careLevelChange };
}
