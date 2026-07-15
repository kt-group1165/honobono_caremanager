import type { SupabaseClient } from "@supabase/supabase-js";
import { validInMonth } from "@/lib/service-code-valid";

/**
 * 訪問介護の可変加算明細 (kaigo_visit_addon_lines) を、対象月のマスタ単位で解決する
 * 共有リゾルバ。ほのぼの「加算サービス項目」相当。
 *
 * - kaigo_visit_addon_lines から 利用者×月×事業所 の加算コード+回数を読み
 * - kaigo_service_codes を validInMonth(対象月) で引いて単位数・名称を解決し
 * - 利用者ごとの加算行リストにして返す。
 *
 * 集計 (visit-seikyu/aggregate.ts) はこれを呼んで明細行に足す。旧 3固定
 * (kaigo_visit_month_addons) の読取を置き換える。テーブル未作成 (42P01/PGRST205) は
 * 空 Map (加算なしで続行)。
 */

export interface VisitAddonLine {
  code: string;
  name: string;
  /** マスタ解決の1回あたり単位数 (validInMonth) */
  unitUnits: number;
  count: number;
  /** 合計単位数 = unitUnits × count (減算コードは負値) */
  totalUnits: number;
  isReduction: boolean;
}

interface LineRow {
  client_id: string;
  addon_code: string;
  count: number;
}

const IN_CHUNK = 50;
const PAGE = 1000;
const isMissingTable = (code: string | null | undefined) =>
  code === "42P01" || code === "PGRST205";

export async function resolveVisitAddonLines(
  supabase: SupabaseClient,
  clientIds: string[],
  year: number,
  month: number,
  officeId: string | null,
  /**
   * 加算行の制度区分。既定 '介護' (従来動作)。system 列未適用 (42703) のときは
   * 介護 = 全行 (従来どおり) / 障害 = 空 (障害行はまだ存在し得ないため安全) に倒す。
   */
  system: "介護" | "障害" = "介護",
): Promise<Map<string, VisitAddonLine[]>> {
  const out = new Map<string, VisitAddonLine[]>();
  const ids = Array.from(new Set(clientIds));
  if (ids.length === 0 || !officeId) return out;
  const monthStr = `${year}-${String(month).padStart(2, "0")}`;

  // 1) 加算行を取得 (system 列でフィルタ。列未適用は上記 fallback)
  const rows: LineRow[] = [];
  let sysFilter = true;
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    let offset = 0;
    while (true) {
      let q = supabase
        .from("kaigo_visit_addon_lines")
        .select("client_id, addon_code, count")
        .eq("office_id", officeId)
        .eq("target_month", monthStr)
        .in("client_id", chunk);
      if (sysFilter) q = q.eq("system", system);
      const { data, error } = await q
        .order("client_id", { ascending: true })
        .order("addon_code", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) {
        if (isMissingTable(error.code)) return out;
        if (sysFilter && (error.code === "42703" || error.code === "PGRST204")) {
          // system 列未適用: 障害は空 (行が存在し得ない)、介護は無フィルタで従来動作
          if (system === "障害") return out;
          sysFilter = false;
          continue;
        }
        throw new Error(`加算明細の取得に失敗: ${error.message}`);
      }
      const got = (data ?? []) as unknown as LineRow[];
      rows.push(...got);
      if (got.length < PAGE) break;
      offset += PAGE;
    }
  }
  if (rows.length === 0) return out;

  // 2) 使われている加算コードの単位数・名称を対象月世代で解決
  const codes = Array.from(new Set(rows.map((r) => r.addon_code)));
  const master = new Map<string, { units: number; name: string }>();
  for (let i = 0; i < codes.length; i += IN_CHUNK) {
    const chunk = codes.slice(i, i + IN_CHUNK);
    const { data, error } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_code, service_name, units")
        // 同じ 6 桁コードが介護/障害の両 system に存在しうるため、行の制度区分で
        // マスタを絞る (集計 aggregate.ts と同規則)
        .eq("system", system)
        .in("service_code", chunk),
      year,
      month,
    );
    if (error) throw new Error(`加算コードの解決に失敗: ${error.message}`);
    for (const c of (data ?? []) as { service_code: string; service_name: string; units: number }[]) {
      // 同一コードが複数世代でヒットしても validInMonth で対象月分に絞られている想定。
      // 念のため既存を上書きしない (先勝ち)。
      if (!master.has(c.service_code)) master.set(c.service_code, { units: c.units, name: c.service_name });
    }
  }

  // 3) 利用者ごとに加算行を組み立て (マスタ未解決コードはスキップ)
  for (const r of rows) {
    const m = master.get(r.addon_code);
    if (!m) continue;
    const unitUnits = m.units;
    const totalUnits = unitUnits * r.count;
    const line: VisitAddonLine = {
      code: r.addon_code,
      name: m.name,
      unitUnits,
      count: r.count,
      totalUnits,
      isReduction: unitUnits < 0,
    };
    if (!out.has(r.client_id)) out.set(r.client_id, []);
    out.get(r.client_id)!.push(line);
  }
  return out;
}
