import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 入退院 (client_hospitalizations) の共有ヘルパー。
 * 入院期間と 予定/実績/請求対象月 の重なり検出に使う (2026-07-08 入退院連動)。
 *
 * テーブル列: client_id, hospital_name, admission_date (YYYY-MM-DD),
 *             discharge_date (YYYY-MM-DD | null = 入院中), status(admitted/discharged)
 * 日付は文字列比較のみ (TZ 安全)。
 */

export interface HospitalizationPeriod {
  admission_date: string;
  discharge_date: string | null; // null = 入院中 (退院日未定)
  hospital_name: string | null;
}

const PAGE = 1000;
const IN_CHUNK = 50;

/**
 * clientIds の入退院期間を全件取得して client_id → 期間リストで返す。
 * テーブル未作成 (42P01/PGRST205) は空 Map (呼出側は「入院情報なし」として続行)。
 */
export async function getHospitalizationMap(
  supabase: SupabaseClient,
  clientIds: string[],
): Promise<Map<string, HospitalizationPeriod[]>> {
  const out = new Map<string, HospitalizationPeriod[]>();
  const ids = Array.from(new Set(clientIds));
  if (ids.length === 0) return out;

  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("client_hospitalizations")
        .select("client_id, hospital_name, admission_date, discharge_date")
        .in("client_id", chunk)
        .order("client_id", { ascending: true })
        .order("admission_date", { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (error) {
        if (error.code === "42P01" || error.code === "PGRST205") return out;
        throw new Error(`入退院情報の取得に失敗: ${error.message}`);
      }
      const rows = (data ?? []) as Array<{
        client_id: string;
        hospital_name: string | null;
        admission_date: string;
        discharge_date: string | null;
      }>;
      for (const r of rows) {
        if (!out.has(r.client_id)) out.set(r.client_id, []);
        out.get(r.client_id)!.push({
          admission_date: r.admission_date,
          discharge_date: r.discharge_date,
          hospital_name: r.hospital_name,
        });
      }
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
  }
  return out;
}

/** 日付 (YYYY-MM-DD) が入院期間内か。退院日当日は「退院済み」扱いで false */
export function isHospitalizedOn(
  periods: HospitalizationPeriod[] | undefined,
  date: string,
): HospitalizationPeriod | null {
  if (!periods) return null;
  for (const p of periods) {
    if (date >= p.admission_date && (p.discharge_date === null || date < p.discharge_date)) {
      return p;
    }
  }
  return null;
}

/** 期間 [from, to] (YYYY-MM-DD) と重なる入院期間を返す (対象月チェック用) */
export function hospitalizationsInRange(
  periods: HospitalizationPeriod[] | undefined,
  from: string,
  to: string,
): HospitalizationPeriod[] {
  if (!periods) return [];
  return periods.filter(
    (p) => p.admission_date <= to && (p.discharge_date === null || p.discharge_date >= from),
  );
}

/** 今日時点で入院中か (利用者一覧バッジ用)。today は 'YYYY-MM-DD' */
export function isCurrentlyHospitalized(
  periods: HospitalizationPeriod[] | undefined,
  today: string,
): boolean {
  return isHospitalizedOn(periods, today) !== null;
}
