import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 区分支給限度基準額 超過の割振り (kaigo_gendo_allocation) の共有ヘルパー。
 *
 * ほのぼの居宅「利用票別表」の超過欄と同方式:
 *   - 機械が超過分を初期割振り (source='auto') して各サービス行の over_units に入れる
 *   - ケアマネが別表画面で各行の over_units を手入力し直す (source='manual')
 *   - 「割り振りの残り単位数」= 総超過 − Σ割振済 を 0 にする
 * 訪問介護の請求集計 (aggregate) は自 office の manual 行があればそれを自費単位とし、
 * 無ければ従来の機械判定 (総単位 − 限度額) にフォールバックする。
 */

export interface GendoAllocationLine {
  line_key: string;
  office_id: string | null;
  provider_name: string | null;
  service_category: string | null;
  service_label: string | null;
  total_units: number;
  over_units: number;
  source: "auto" | "manual";
}

interface DbRow extends GendoAllocationLine {
  client_id: string;
  target_month: string;
}

const SELECT_COLS =
  "client_id, target_month, line_key, office_id, provider_name, service_category, " +
  "service_label, total_units, over_units, source";

const IN_CHUNK = 50;
const PAGE = 1000;

const isMissingTable = (code: string | null | undefined) =>
  code === "42P01" || code === "PGRST205";

/**
 * clientIds × 対象月 (YYYY-MM) の割振り行を client_id → 行配列で返す。
 * テーブル未作成は空 Map (呼出側は「割振りなし=機械判定」で続行)。
 */
export async function getGendoAllocationMap(
  supabase: SupabaseClient,
  clientIds: string[],
  targetMonth: string,
): Promise<Map<string, GendoAllocationLine[]>> {
  const out = new Map<string, GendoAllocationLine[]>();
  const ids = Array.from(new Set(clientIds));
  if (ids.length === 0) return out;

  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("kaigo_gendo_allocation")
        .select(SELECT_COLS)
        .in("client_id", chunk)
        .eq("target_month", targetMonth)
        .order("client_id", { ascending: true })
        .order("line_key", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) {
        if (isMissingTable(error.code)) return out;
        throw new Error(`限度額割振りの取得に失敗: ${error.message}`);
      }
      const rows = (data ?? []) as unknown as DbRow[];
      for (const r of rows) {
        if (!out.has(r.client_id)) out.set(r.client_id, []);
        out.get(r.client_id)!.push({
          line_key: r.line_key,
          office_id: r.office_id,
          provider_name: r.provider_name,
          service_category: r.service_category,
          service_label: r.service_label,
          total_units: r.total_units,
          over_units: r.over_units,
          source: r.source,
        });
      }
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
  }
  return out;
}

/**
 * 単一利用者の当月・自 office の「確定済み (manual) 超過単位」を返す。
 * - manual 行があれば over_units (割振りの真値)
 * - manual 行が無ければ null (= 機械判定にフォールバックさせる)
 * auto のみの行は「未確定」なので null 扱い (ケアマネが確定するまでは機械判定)。
 */
export function resolveManualOverUnits(
  lines: GendoAllocationLine[] | undefined,
  officeId: string,
): number | null {
  if (!lines) return null;
  const mine = lines.filter((l) => l.office_id === officeId && l.source === "manual");
  if (mine.length === 0) return null;
  return mine.reduce((s, l) => s + Math.max(0, l.over_units), 0);
}

/**
 * 別表の機械初期割振り。限度額を超えた分を、単位数の大きい行から順に
 * over_units へ寄せる (ほのぼの「機械的にどこかの行に寄せる」相当)。
 * ケアマネが手入力で上書きする前提の「たたき台」。
 *
 * @returns 各行に auto の over_units を入れた新配列
 */
export function computeAutoAllocation(
  lines: Pick<GendoAllocationLine, "line_key" | "total_units">[],
  limitUnits: number,
): Map<string, number> {
  const total = lines.reduce((s, l) => s + Math.max(0, l.total_units), 0);
  const over = Math.max(0, total - limitUnits);
  const result = new Map<string, number>();
  for (const l of lines) result.set(l.line_key, 0);
  if (over <= 0) return result;
  // 単位数の大きい行から超過を消化 (寄せ先の初期規則)
  let remaining = over;
  const sorted = [...lines].sort((a, b) => b.total_units - a.total_units);
  for (const l of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Math.max(0, l.total_units));
    result.set(l.line_key, take);
    remaining -= take;
  }
  return result;
}

/** 総超過に対する「割り振りの残り単位数」= 総超過 − Σ割振済 */
export function remainingToAllocate(
  lines: Pick<GendoAllocationLine, "total_units" | "over_units">[],
  limitUnits: number,
): number {
  const total = lines.reduce((s, l) => s + Math.max(0, l.total_units), 0);
  const over = Math.max(0, total - limitUnits);
  const allocated = lines.reduce((s, l) => s + Math.max(0, l.over_units), 0);
  return over - allocated;
}
