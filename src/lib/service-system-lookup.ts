/**
 * サービス名 → 制度区分 (介護 / 総合事業 / 独自 / 障害) の lookup。
 *
 * 介護保険のサービス提供表・介護請求には障害福祉サービスを混入させない
 * (障害は サービス提供実績 / 障害請求 側で扱う) ためのフィルタに使う。
 * 同名が複数制度に存在する場合は 介護 > 総合事業 > 独自 > 障害 の優先で解決。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";
import { validInMonth, validToday } from "@/lib/service-code-valid";

const PRIORITY: Record<string, number> = {
  介護: 0,
  総合事業: 1,
  独自: 2,
  障害: 3,
};

/**
 * 正規化名 (半角数字) → system のマップを返す。マスタに無い名前は含まれない。
 * 有効期間: targetMonth 指定時は対象月に有効な世代、省略時は今日時点で有効な世代に絞る
 * (改定跨ぎで同名の世代が複数あっても重複ヒットさせない)
 */
export async function getServiceSystemMap(
  supabase: SupabaseClient,
  serviceTypes: string[],
  targetMonth?: { year: number; month: number },
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const types = Array.from(new Set(serviceTypes.filter(Boolean)));
  if (types.length === 0) return map;
  const variants = serviceNameVariantsAll(types);
  for (let i = 0; i < variants.length; i += 50) {
    const base = supabase
      .from("kaigo_service_codes")
      .select("service_name, system")
      .in("service_name", variants.slice(i, i + 50))
      .eq("calculation_type", "基本");
    const { data, error } = await (targetMonth
      ? validInMonth(base, targetMonth.year, targetMonth.month)
      : validToday(base));
    if (error) throw new Error(`制度区分取得失敗: ${error.message}`);
    for (const r of (data ?? []) as { service_name: string; system: string }[]) {
      const key = toHankakuDigits(r.service_name);
      const prev = map.get(key);
      if (prev == null || (PRIORITY[r.system] ?? 9) < (PRIORITY[prev] ?? 9)) {
        map.set(key, r.system);
      }
    }
  }
  return map;
}

/** 障害福祉サービスか (介護保険の提供表・請求から除外する対象か) */
export function isShogaiService(
  systemMap: Map<string, string>,
  serviceName: string,
): boolean {
  return systemMap.get(toHankakuDigits(serviceName)) === "障害";
}
