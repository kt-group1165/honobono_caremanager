/**
 * 重度訪問介護「熟練従業者による同行支援」(= 同行) のサービスコード解決 helper。
 *
 * 制度: 熟練従業者が新任 (採用6ヶ月以内) に同行して重訪を 2 人で提供する場合、
 *   2 人分を各所定 90% 相当で算定する。マスタ (kaigo_service_codes, system='障害')
 *   には「重訪◯◯・２人・同行N」という専用コードが存在する
 *   (例: 124542「重訪Ⅰ日中１．０・２人・同行２」units=193)。
 *
 * 本 helper は「職員区分 (熟練/新任) を DB に持たない」前提で、運用者が
 * モーダルで「熟練同行」チェックを入れたときに、選択中の base サービス名を
 * マスタ駆動で同行バリアント名へ差し替えるためのもの。
 * 集計元 (障害請求) は kaigo_visit_schedule.service_type を障害マスタで名前解決して
 * 集計するため、service_type を同行名に差し替えるだけで請求金額に反映される。
 *
 * マスタの命名規則 (実データで確認):
 *   base            "重訪Ⅰ日中１．０"                     units=214
 *   ・２人           "重訪Ⅰ日中１．０・２人"                units=214
 *   ・２人・同行２    "重訪Ⅰ日中１．０・２人・同行２"        units=193  ← 同行 (2人 90%)
 *   ・２人・同行１    "重訪Ⅰ日中１．０・２人・同行１"        units=193
 *   90日減 interleave "重訪Ⅲ入院等夜間１．０・２人・９０日減・同行１"       ← 装飾は同行の前に入る
 * 一部の base では 同行２ が存在せず 同行１ のみ (例: 重訪Ⅱ深夜２．０)。→ 同行２→同行１ で fall back。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceNameVariants } from "@/lib/service-name-normalize";
import { validInMonth } from "@/lib/service-code-valid";

/** 重度訪問介護のサービス名か (同行チェックの表示条件)。名前が「重訪」始まり or「重度訪問」を含む */
export function isJudoHoumonService(serviceName: string | null | undefined): boolean {
  if (!serviceName) return false;
  const n = serviceName.trim();
  return n.startsWith("重訪") || n.includes("重度訪問");
}

/** 同行バリアント名か (「・同行」を含む) */
export function isDoukouService(serviceName: string | null | undefined): boolean {
  if (!serviceName) return false;
  return /・同行[０-９0-9]?/.test(serviceName) || serviceName.includes("同行");
}

/**
 * 同行名 → base 名へ逆変換 (編集時の初期表示 / チェック外し用)。
 * "・２人・同行２" のような同行専用の装飾を取り除いて base に戻す。
 * "・２人" 自体は 2 人体制の指定として残す (base が元々 ・２人 なら維持)。
 * 90日減 等の他装飾は保持する。
 */
export function stripDoukou(serviceName: string): string {
  const tokens = serviceName.split("・");
  const kept = tokens.filter((t) => !/^同行[０-９0-9]?$/.test(t));
  return kept.join("・");
}

/** base 名を token 分解して core と装飾 (２人/同行を除く) を返す */
function decompose(baseName: string): { core: string; decos: string[] } {
  const tokens = baseName.split("・");
  const core = tokens[0];
  const decos = tokens
    .slice(1)
    .filter((t) => t !== "２人" && t !== "2人" && !/^同行[０-９0-9]?$/.test(t));
  return { core, decos };
}

/** 同行 (２人) の候補名を canonical 順で組み立てる: core・２人・(装飾…)・同行N */
function buildCandidateName(core: string, decos: string[], koNum: string): string {
  return [core, "２人", ...decos, `同行${koNum}`].join("・");
}

export interface DoukouVariant {
  code: string;
  name: string;
  units: number;
}

/**
 * base サービス名から「・２人・同行」バリアントをマスタ駆動で解決する。
 *
 * 手順:
 *   1. base を分解し canonical 候補名 (・２人・同行２ / ・同行１) を組み立てて
 *      service_name 完全一致 (全角/半角数字ゆれ両対応) を validInMonth で引く。同行２優先。
 *   2. 完全一致が無ければ core prefix + '%同行%' の LIKE で候補を集め、
 *      「・２人」かつ「同行」かつ base の全装飾 token を含む行を最尤選択 (同行２優先)。
 *
 * 見つからなければ null (呼出側で base のまま登録 + warning)。
 * error は握らず {error} を check して null を返す (silent failure を作らない)。
 */
export async function resolveDoukouVariant(
  supabase: SupabaseClient,
  baseServiceName: string,
  year: number,
  month: number,
): Promise<DoukouVariant | null> {
  if (!baseServiceName || !isJudoHoumonService(baseServiceName)) return null;
  // 既に同行名なら base に戻してから解決 (二重付与防止)
  const base = isDoukouService(baseServiceName) ? stripDoukou(baseServiceName) : baseServiceName;
  const { core, decos } = decompose(base);

  // ── 1. canonical 完全一致 (同行２ → 同行１ の優先順) ──
  const candFirst = buildCandidateName(core, decos, "２"); // 同行２ (2人 90%)
  const candSecond = buildCandidateName(core, decos, "１"); // 同行１
  const exactNames = Array.from(
    new Set([
      ...serviceNameVariants(candFirst),
      ...serviceNameVariants(candSecond),
    ]),
  );
  {
    const q = supabase
      .from("kaigo_service_codes")
      .select("service_code, service_name, units")
      .eq("system", "障害")
      .eq("calculation_type", "基本")
      .in("service_name", exactNames);
    const { data, error } = await validInMonth(q, year, month);
    if (error) {
      console.error("resolveDoukouVariant exact lookup failed:", error.message);
      return null;
    }
    const rows = (data ?? []) as Array<{ service_code: string; service_name: string; units: number }>;
    if (rows.length > 0) {
      // 同行２ を最優先、無ければ 同行１
      const pick =
        rows.find((r) => r.service_name.includes("同行２")) ??
        rows.find((r) => r.service_name.includes("同行１")) ??
        rows[0];
      return { code: pick.service_code, name: pick.service_name, units: pick.units };
    }
  }

  // ── 2. LIKE fallback: core prefix + %同行% を集めて最尤選択 ──
  const coreVariants = serviceNameVariants(core);
  const seen = new Set<string>();
  const cands: Array<{ service_code: string; service_name: string; units: number }> = [];
  for (const cv of coreVariants) {
    const q = supabase
      .from("kaigo_service_codes")
      .select("service_code, service_name, units")
      .eq("system", "障害")
      .eq("calculation_type", "基本")
      .like("service_name", `${cv}%同行%`);
    const { data, error } = await validInMonth(q, year, month);
    if (error) {
      console.error("resolveDoukouVariant like lookup failed:", error.message);
      return null;
    }
    for (const r of (data ?? []) as Array<{ service_code: string; service_name: string; units: number }>) {
      if (seen.has(r.service_code)) continue;
      seen.add(r.service_code);
      cands.push(r);
    }
  }
  if (cands.length === 0) return null;

  // base の装飾 token をすべて含む「・２人」かつ「同行」の候補に絞る
  const requiredDecos = decos; // 90日減 等 (数字ゆれは考慮不要: 装飾語は漢字)
  const filtered = cands.filter((r) => {
    const n = r.service_name;
    if (!(n.includes("２人") || n.includes("2人"))) return false;
    if (!n.includes("同行")) return false;
    return requiredDecos.every((d) => n.includes(d));
  });
  const pool = filtered.length > 0 ? filtered : cands;
  // 同行２ 優先 → 同行１ → その他。同点なら service_name 昇順で安定選択。
  const score = (n: string): number => (n.includes("同行２") ? 0 : n.includes("同行１") ? 1 : 2);
  pool.sort((a, b) => {
    const d = score(a.service_name) - score(b.service_name);
    if (d !== 0) return d;
    return a.service_name.localeCompare(b.service_name);
  });
  const best = pool[0];
  return { code: best.service_code, name: best.service_name, units: best.units };
}
