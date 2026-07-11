/**
 * 訪問介護 (介護 system / サービス種類 11) の
 *   - 高齢者虐待防止措置未実施減算 (= 虐防)  所定単位数の 1% 減算
 *   - 業務継続計画未策定減算 (= 業未, BCP)   所定単位数の 1% 減算
 * のサービスコード解決 helper。
 *
 * 制度 (実マスタで確認済):
 *   訪問介護のこの 2 減算は、通所介護 (15C222 等) や総合事業 (K_A2C211 等) と違い
 *   独立減算コードが存在しない。基本コードの「合成バリエーション」方式で、
 *   kaigo_service_codes に減算織込み済の別名コードが登録されている:
 *     基本                "身体介護２"                    111211  units=387
 *     ・虐防              "身体介護２・虐防"               11A037  units=383 (= 387 − 1%)
 *     ・業未              "身体介護２・業未"               11B473  units=383
 *     ・虐防・業未         "身体介護２・虐防・業未"          11B479  units=379 (= 387 − 2%)
 *   名称トークンの並び順 (実マスタ確認済):
 *     [基本]・虐防・業未・(生N)・２人・夜|深・[特定事業所 suffix Ⅰ〜Ⅳ]
 *     - 虐防 が 業未 より先、どちらも装飾 (２人/夜/深) より前
 *     - 特定事業所 suffix (Ⅰ/Ⅱ/Ⅲ/Ⅳ) は最後
 *     - 合成 core「身体７生活１」は変種では「身体７・虐防・業未・生１」と
 *       core が 身体N + ・生M に分解される (11B743 等で確認)
 *
 * 事業所フラグは kaigo_office_gensan_periods (適用期間付き。減算は改善までの期間性)
 * に持ち、対象月が期間内なら aggregate の読込層で基本サービス行の名称を
 * 差し替えてマスタ解決する (重度訪問介護の熟練同行 resolveDoukouVariant と同じパターン)。
 * 解決不能時は null (呼出側で元コードのまま + warning)。
 * error は握らず {error} を check する (silent failure を作らない)。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceNameVariants, toHankakuDigits } from "@/lib/service-name-normalize";
import { validInMonth } from "@/lib/service-code-valid";

// ─── 型・定数 ─────────────────────────────────────────────────────────────────

export type GensanType = "gyakutai" | "bcp";

export const GENSAN_LABELS: Record<GensanType, string> = {
  gyakutai: "高齢者虐待防止措置未実施減算",
  bcp: "業務継続計画未策定減算",
};

/** マスタ名称に挿入するトークン */
const GENSAN_TOKENS: Record<GensanType, string> = {
  gyakutai: "虐防",
  bcp: "業未",
};

export interface GensanFlags {
  gyakutai: boolean;
  bcp: boolean;
}

export interface GensanPeriod {
  gensan_type: GensanType;
  start_month: string | null; // 'YYYY-MM' (null = 最初から)
  end_month: string | null; // 'YYYY-MM' (null = 無期限)
}

export interface GensanVariant {
  code: string;
  name: string;
  units: number;
  short: string | null;
}

// テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) 判定
const isTableMissing = (code: string | null | undefined) =>
  code === "42P01" || code === "PGRST205";

// ─── 事業所フラグ (適用期間) ──────────────────────────────────────────────────

/**
 * 対象月 (monthStr='YYYY-MM') に適用中の減算期間を kaigo_office_gensan_periods から引く。
 * テーブル未作成 (migration 未適用) は空配列 = 従来動作 (減算なし) にフォールバック。
 * それ以外の error は throw (silent failure を作らない)。
 */
export async function getGensanPeriodsForMonth(
  supabase: SupabaseClient,
  officeId: string,
  monthStr: string,
): Promise<GensanPeriod[]> {
  const { data, error } = await supabase
    .from("kaigo_office_gensan_periods")
    .select("gensan_type, start_month, end_month")
    .eq("office_id", officeId);
  if (error) {
    if (isTableMissing(error.code)) return [];
    throw new Error(`減算適用期間の取得に失敗: ${error.message}`);
  }
  return ((data ?? []) as GensanPeriod[]).filter(
    (r) =>
      (r.gensan_type === "gyakutai" || r.gensan_type === "bcp") &&
      (r.start_month == null || r.start_month <= monthStr) &&
      (r.end_month == null || r.end_month >= monthStr),
  );
}

/** 期間行 → フラグ (虐防/業未 それぞれ 1 行でも適用中なら true) */
export function gensanFlagsFromPeriods(periods: GensanPeriod[]): GensanFlags {
  return {
    gyakutai: periods.some((p) => p.gensan_type === "gyakutai"),
    bcp: periods.some((p) => p.gensan_type === "bcp"),
  };
}

/** 適用中減算の表示ラベル (「高齢者虐待防止措置未実施減算・業務継続計画未策定減算」等) */
export function gensanFlagsLabel(flags: GensanFlags): string {
  return [
    flags.gyakutai ? GENSAN_LABELS.gyakutai : null,
    flags.bcp ? GENSAN_LABELS.bcp : null,
  ]
    .filter(Boolean)
    .join("・");
}

// ─── 名称トークン組み立て ─────────────────────────────────────────────────────

/** 虐防/業未 トークンか */
const isGensanToken = (t: string) => t === "虐防" || t === "業未";

/**
 * base 名を分解して canonical な変種名トークン列を返す。
 *   [core, 虐防?, 業未?, (生M)?, ...装飾 (２人/夜/深/…), suffix (Ⅰ〜Ⅳ) は装飾末尾のまま]
 * 既に 虐防/業未 が付いた名前は一旦取り除いて再構成する (二重付与防止)。
 * 合成 core「身体７生活１」は「身体７」+「生１」に分解する (実マスタの命名規則)。
 */
export function buildGensanCandidateName(
  baseServiceName: string,
  flags: GensanFlags,
): string {
  const tokens = baseServiceName.split("・").filter((t) => !isGensanToken(t));
  let core = tokens[0];
  const decos = tokens.slice(1);
  const inserted: string[] = [];
  if (flags.gyakutai) inserted.push(GENSAN_TOKENS.gyakutai);
  if (flags.bcp) inserted.push(GENSAN_TOKENS.bcp);
  // 合成 core「身体N生活M」→ core=身体N + 減算トークンの直後に「生M」
  const composite = /^(身体[０-９0-9]+)生活([０-９0-9]+)$/.exec(core);
  if (composite) {
    core = composite[1];
    inserted.push(`生${composite[2]}`);
  }
  return [core, ...inserted, ...decos].join("・");
}

// ─── マスタ解決 ───────────────────────────────────────────────────────────────

interface MasterRow {
  service_code: string;
  service_name: string;
  units: number;
  short_name: string | null;
}

/**
 * base サービス名から 虐防/業未 合成バリエーションをマスタ駆動で解決する。
 *
 * 手順:
 *   1. canonical 候補名 (buildGensanCandidateName) を組み立てて
 *      service_name 完全一致 (全角/半角数字ゆれ両対応) を validInMonth で引く。
 *   2. 完全一致が無ければ core prefix の LIKE で候補を集め、
 *      トークン multiset が期待どおり一致する行を選ぶ (並び順に依存しない安全網)。
 *
 * 対象: system='介護' かつ service_category='11' (訪問介護) のみ。
 * ※ calculation_type では絞らない — 合成変種は マスタ上 加算/減算 type の行がある。
 * 見つからなければ null (呼出側で base のまま集計 + warning)。
 */
export async function resolveGensanVariant(
  supabase: SupabaseClient,
  baseServiceName: string,
  flags: GensanFlags,
  year: number,
  month: number,
): Promise<GensanVariant | null> {
  if (!baseServiceName || (!flags.gyakutai && !flags.bcp)) return null;
  const candidate = buildGensanCandidateName(baseServiceName, flags);

  // ── 1. canonical 完全一致 ──
  {
    const q = supabase
      .from("kaigo_service_codes")
      .select("service_code, service_name, units, short_name")
      .eq("system", "介護")
      .eq("service_category", "11")
      .in("service_name", serviceNameVariants(candidate));
    const { data, error } = await validInMonth(q, year, month);
    if (error) {
      console.error("resolveGensanVariant exact lookup failed:", error.message);
      return null;
    }
    const rows = (data ?? []) as MasterRow[];
    if (rows.length > 0) {
      const pick = rows[0];
      return {
        code: pick.service_code,
        name: pick.service_name,
        units: pick.units,
        short: pick.short_name,
      };
    }
  }

  // ── 2. LIKE fallback: core prefix で候補を集め、トークン multiset 一致で選ぶ ──
  const expected = toHankakuDigits(candidate).split("・").sort().join("・");
  const core = candidate.split("・")[0];
  const seen = new Set<string>();
  for (const cv of serviceNameVariants(core)) {
    let q = supabase
      .from("kaigo_service_codes")
      .select("service_code, service_name, units, short_name")
      .eq("system", "介護")
      .eq("service_category", "11")
      .like("service_name", `${cv}・%`);
    if (flags.gyakutai) q = q.like("service_name", "%虐防%");
    if (flags.bcp) q = q.like("service_name", "%業未%");
    const { data, error } = await validInMonth(q.limit(200), year, month);
    if (error) {
      console.error("resolveGensanVariant like lookup failed:", error.message);
      return null;
    }
    for (const r of (data ?? []) as MasterRow[]) {
      if (seen.has(r.service_code)) continue;
      seen.add(r.service_code);
      const got = toHankakuDigits(r.service_name).split("・").sort().join("・");
      if (got === expected) {
        return {
          code: r.service_code,
          name: r.service_name,
          units: r.units,
          short: r.short_name,
        };
      }
    }
  }
  return null;
}
