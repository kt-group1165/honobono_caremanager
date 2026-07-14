/**
 * 特定事業所集中減算 (居宅介護支援) — データ層
 *
 * billing/stats の「集中減算」タブから使う fetch / 集計の pure な部分。
 *
 * 制度概要:
 *   判定期間 (前期 3/1〜8/31 → 10月から適用 / 後期 9/1〜翌2月末 → 4月から適用) に
 *   ケアプランへ位置付けた対象サービス (訪問介護 / 通所介護 / 地域密着型通所介護 /
 *   福祉用具貸与) の事業所を「法人単位」で集計し、最大法人の紹介率が 80% を
 *   超えると減算 (居宅介護支援費 ▲200単位/月)。正当な理由の届出で適用除外可。
 *
 * 集計方式 (v1 = 近似):
 *   判定期間内の月次利用票 (kaigo_report_documents / report_type='service-usage') の
 *   content.services[] から (利用者, サービス種別, 事業所名) を抽出し、
 *   (利用者 × 事業所) をユニーク化した件数を「位置付け件数」とみなす。
 *   利用票が期間内 0 件のときは第2表 (care-plan-2 / created_at が期間内) を fallback。
 *
 * 方針 (keiei-bunseki.ts と同じ):
 *   - error は握りつぶさず返す。table/列 未作成 (42P01/42703/PGRST205 等) は
 *     「機能未適用」として空扱いで続行 (partner_companies 未適用でも動く)
 *   - kaigo_report_documents は content が大きいので必要 JSON パスのみ select し、
 *     order("id") + range の page-loop で 1000 行制限に対応
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/keiei-bunseki";

// ─── 判定期間 ────────────────────────────────────────────────────────────────

/** 判定期間: year + 前期 (3/1〜8/31) / 後期 (9/1〜翌2月末) */
export type ShuchuPeriod = { year: number; half: "zenki" | "kouki" };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 今日時点で進行中の判定期間 (1〜2月は前年の後期) */
export function currentShuchuPeriod(now: Date = new Date()): ShuchuPeriod {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  if (m >= 3 && m <= 8) return { year: y, half: "zenki" };
  if (m >= 9) return { year: y, half: "kouki" };
  return { year: y - 1, half: "kouki" };
}

/** 判定期間内の全月 (YYYY-MM 6 ヶ月) */
export function shuchuPeriodMonths(p: ShuchuPeriod): string[] {
  if (p.half === "zenki") {
    return [3, 4, 5, 6, 7, 8].map((m) => `${p.year}-${pad2(m)}`);
  }
  return [
    ...[9, 10, 11, 12].map((m) => `${p.year}-${pad2(m)}`),
    ...[1, 2].map((m) => `${p.year + 1}-${pad2(m)}`),
  ];
}

/** 判定期間の日付範囲 (created_at フィルタ用) とラベル */
export function shuchuPeriodInfo(p: ShuchuPeriod): {
  start: string; // 期間初日 (YYYY-MM-DD)
  endExclusive: string; // 期間翌日 (排他)
  label: string; // 例: 2026/3/1〜2026/8/31
  applyLabel: string; // 減算の適用期間 例: 2026年10月〜2027年3月
} {
  if (p.half === "zenki") {
    return {
      start: `${p.year}-03-01`,
      endExclusive: `${p.year}-09-01`,
      label: `${p.year}/3/1〜${p.year}/8/31`,
      applyLabel: `${p.year}年10月〜${p.year + 1}年3月`,
    };
  }
  return {
    start: `${p.year}-09-01`,
    endExclusive: `${p.year + 1}-03-01`,
    label: `${p.year}/9/1〜${p.year + 1}/2月末`,
    applyLabel: `${p.year + 1}年4月〜9月`,
  };
}

// ─── 対象サービスの判定 ──────────────────────────────────────────────────────

export const SHUCHU_TARGET_SERVICES = [
  "訪問介護",
  "通所介護",
  "地域密着型通所介護",
  "福祉用具貸与",
] as const;

export type ShuchuTargetService = (typeof SHUCHU_TARGET_SERVICES)[number];

/** サービス種類コード → 対象サービス (利用票行の category があれば優先) */
const CATEGORY_TO_SERVICE: Record<string, ShuchuTargetService> = {
  "11": "訪問介護",
  "15": "通所介護",
  "78": "地域密着型通所介護",
  "17": "福祉用具貸与",
};

/**
 * サービス種別/内容の文字列から対象 4 サービスへマッチ。
 * 「地域密着型通所介護」を先に判定して「通所介護」と区別する。
 * 「認知症対応型通所介護」は対象外なので除外。
 */
export function matchTargetService(
  text: string,
  category?: string | null,
): ShuchuTargetService | null {
  if (category && CATEGORY_TO_SERVICE[category]) return CATEGORY_TO_SERVICE[category];
  if (!text) return null;
  if (text.includes("地域密着型通所介護")) return "地域密着型通所介護";
  if (text.includes("認知症対応型通所介護")) return null; // 集中減算の対象外
  if (text.includes("通所介護")) return "通所介護";
  if (text.includes("訪問介護")) return "訪問介護";
  if (text.includes("福祉用具貸与")) return "福祉用具貸与";
  return null;
}

// ─── 帳票からの抽出 ──────────────────────────────────────────────────────────

/** (利用者, サービス種別, 事業所名) の 1 組 */
export type PlacementPair = {
  userId: string;
  service: ShuchuTargetService;
  provider: string;
};

/** 利用票 (service-usage) の fetch 行 (content->services のみ select) */
export type UsageDocRow = { user_id: string; services: unknown };

/** 第2表 (care-plan-2) の fetch 行 (content->blocks / needs_blocks のみ select) */
export type Plan2DocRow = { user_id: string; blocks: unknown; needs_blocks: unknown };

const PAGE = 1000;

/**
 * 判定期間内の月次利用票を page-loop で全件取得。
 * content は大きいので services 配列のみ JSON パス select する。
 */
export async function fetchServiceUsageDocs(
  supabase: SupabaseClient,
  months: string[],
): Promise<{ rows: UsageDocRow[]; error: string | null }> {
  const rows: UsageDocRow[] = [];
  if (months.length === 0) return { rows, error: null };
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("kaigo_report_documents")
      .select("user_id, services:content->services")
      .eq("report_type", "service-usage")
      .gte("report_month", months[0])
      .lte("report_month", months[months.length - 1])
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingSchemaError(error.code)) return { rows: [], error: null };
      return { rows, error: `利用票の取得に失敗: ${error.message}` };
    }
    const page = (data ?? []) as unknown as UsageDocRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { rows, error: null };
}

/**
 * 判定期間内 (created_at) に作成した第2表を page-loop で全件取得 (fallback 用)。
 */
export async function fetchCarePlan2Docs(
  supabase: SupabaseClient,
  start: string,
  endExclusive: string,
): Promise<{ rows: Plan2DocRow[]; error: string | null }> {
  const rows: Plan2DocRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("kaigo_report_documents")
      .select("user_id, blocks:content->blocks, needs_blocks:content->needs_blocks")
      .eq("report_type", "care-plan-2")
      .gte("created_at", start)
      .lt("created_at", endExclusive)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingSchemaError(error.code)) return { rows: [], error: null };
      return { rows, error: `第2表の取得に失敗: ${error.message}` };
    }
    const page = (data ?? []) as unknown as Plan2DocRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { rows, error: null };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * 利用票の services 行から抽出。
 * 行構造: { time, content, provider, category?, ... } (reports-content.tsx の SvcRow)。
 * provider 空行・対象外サービス行はスキップ。
 * @returns pairs と「サービス行が 1 行以上ある文書数」
 */
export function extractFromServiceUsage(rows: UsageDocRow[]): {
  pairs: PlacementPair[];
  docsWithRows: number;
} {
  const pairs: PlacementPair[] = [];
  let docsWithRows = 0;
  for (const row of rows) {
    if (!Array.isArray(row.services)) continue;
    let hasRow = false;
    for (const raw of row.services) {
      const sv = asRecord(raw);
      if (!sv) continue;
      hasRow = true;
      const provider = String(sv.provider ?? "").trim();
      if (!provider) continue;
      const service = matchTargetService(
        String(sv.content ?? ""),
        typeof sv.category === "string" ? sv.category : null,
      );
      if (!service) continue;
      pairs.push({ userId: row.user_id, service, provider });
    }
    if (hasRow) docsWithRows += 1;
  }
  return { pairs, docsWithRows };
}

/**
 * 第2表の blocks[].goals[].services[] ({ type, content, provider, ... }) から抽出。
 * 旧形式は needs_blocks キーの場合があるので両対応。
 */
export function extractFromCarePlan2(rows: Plan2DocRow[]): {
  pairs: PlacementPair[];
  docsWithRows: number;
} {
  const pairs: PlacementPair[] = [];
  let docsWithRows = 0;
  for (const row of rows) {
    const blocks = Array.isArray(row.needs_blocks)
      ? row.needs_blocks
      : Array.isArray(row.blocks)
        ? row.blocks
        : null;
    if (!blocks) continue;
    let hasRow = false;
    for (const rawBlock of blocks) {
      const block = asRecord(rawBlock);
      if (!block || !Array.isArray(block.goals)) continue;
      for (const rawGoal of block.goals) {
        const goal = asRecord(rawGoal);
        if (!goal || !Array.isArray(goal.services)) continue;
        for (const rawSv of goal.services) {
          const sv = asRecord(rawSv);
          if (!sv) continue;
          hasRow = true;
          const provider = String(sv.provider ?? "").trim();
          if (!provider) continue;
          const service = matchTargetService(
            `${String(sv.type ?? "")} ${String(sv.content ?? "")}`,
          );
          if (!service) continue;
          pairs.push({ userId: row.user_id, service, provider });
        }
      }
    }
    if (hasRow) docsWithRows += 1;
  }
  return { pairs, docsWithRows };
}

// ─── 法人名寄せ ──────────────────────────────────────────────────────────────

/** 事業所名の照合キー (空白除去のみ。全角空白も \s に含まれる) */
export function normalizeProviderName(name: string): string {
  return name.replace(/\s+/g, "");
}

export type CorpResolution = {
  corp: string; // 法人名 (未設定/未登録はラベル付き)
  unregistered: boolean; // どのマスタにも無い事業所名か
};

export type CorpResolver = (provider: string) => CorpResolution;

/**
 * 名寄せ用マスタを fetch して resolver を作る。
 * 優先順位:
 *   1. offices.name 一致 → companies.name (company_id null なら office 名を法人扱い)
 *   2. kaigo_service_providers.provider_name 一致 → partner_companies.name
 *      (partner_company_id null なら「(法人未設定) <事業所名>」)
 *   3. どちらにも無い →「(マスタ未登録) <事業所名>」
 * partner_companies / company_id / partner_company_id 未適用の環境では
 * missing-schema を空扱いして法人未設定側に倒す (クラッシュしない)。
 */
export async function buildCorpResolver(
  supabase: SupabaseClient,
): Promise<{ resolve: CorpResolver; errors: string[] }> {
  const errors: string[] = [];

  // 1) 自社 offices (+ companies)。company_id 列が無い環境は name のみで再試行
  let officeRows: { name: string; company_id: string | null }[] = [];
  {
    const { data, error } = await supabase.from("offices").select("name, company_id");
    if (error) {
      if (isMissingSchemaError(error.code)) {
        const { data: d2, error: e2 } = await supabase.from("offices").select("name");
        if (e2) {
          if (!isMissingSchemaError(e2.code)) errors.push(`事業所マスタの取得に失敗: ${e2.message}`);
        } else {
          officeRows = ((d2 ?? []) as { name: string }[]).map((r) => ({
            name: r.name,
            company_id: null,
          }));
        }
      } else {
        errors.push(`事業所マスタの取得に失敗: ${error.message}`);
      }
    } else {
      officeRows = (data ?? []) as { name: string; company_id: string | null }[];
    }
  }

  const companyNameById = new Map<string, string>();
  {
    const { data, error } = await supabase.from("companies").select("id, name");
    if (error) {
      if (!isMissingSchemaError(error.code)) errors.push(`法人マスタの取得に失敗: ${error.message}`);
    } else {
      for (const c of (data ?? []) as { id: string; name: string }[]) {
        companyNameById.set(c.id, c.name);
      }
    }
  }

  // 2) 他社 kaigo_service_providers (+ partner_companies)。
  //    partner_company_id 列が無い環境は provider_name のみで再試行
  let providerRows: { provider_name: string; partner_company_id: string | null }[] = [];
  {
    let missingColumn = false;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("kaigo_service_providers")
        .select("provider_name, partner_company_id")
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        if (isMissingSchemaError(error.code)) {
          missingColumn = true;
        } else {
          errors.push(`サービス事業所マスタの取得に失敗: ${error.message}`);
        }
        break;
      }
      const page = (data ?? []) as { provider_name: string; partner_company_id: string | null }[];
      providerRows.push(...page);
      if (page.length < PAGE) break;
    }
    if (missingColumn) {
      providerRows = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("kaigo_service_providers")
          .select("provider_name")
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) {
          if (!isMissingSchemaError(error.code)) {
            errors.push(`サービス事業所マスタの取得に失敗: ${error.message}`);
          }
          break;
        }
        const page = (data ?? []) as { provider_name: string }[];
        providerRows.push(...page.map((r) => ({ provider_name: r.provider_name, partner_company_id: null })));
        if (page.length < PAGE) break;
      }
    }
  }

  const partnerNameById = new Map<string, string>();
  {
    const { data, error } = await supabase.from("partner_companies").select("id, name");
    if (error) {
      // 未適用 (42P01/PGRST205) は空扱い = 全 provider が「(法人未設定)」側に倒れる
      if (!isMissingSchemaError(error.code)) {
        errors.push(`他社法人マスタの取得に失敗: ${error.message}`);
      }
    } else {
      for (const c of (data ?? []) as { id: string; name: string }[]) {
        partnerNameById.set(c.id, c.name);
      }
    }
  }

  const officeCorpByName = new Map<string, string>();
  for (const o of officeRows) {
    const corp = (o.company_id ? companyNameById.get(o.company_id) : null) ?? o.name;
    officeCorpByName.set(normalizeProviderName(o.name), corp);
  }
  const providerCorpByName = new Map<string, string>();
  for (const p of providerRows) {
    const corp =
      (p.partner_company_id ? partnerNameById.get(p.partner_company_id) : null) ??
      `(法人未設定) ${p.provider_name}`;
    providerCorpByName.set(normalizeProviderName(p.provider_name), corp);
  }

  const resolve: CorpResolver = (provider: string) => {
    const key = normalizeProviderName(provider);
    const office = officeCorpByName.get(key);
    if (office) return { corp: office, unregistered: false };
    const partner = providerCorpByName.get(key);
    if (partner) return { corp: partner, unregistered: false };
    return { corp: `(マスタ未登録) ${provider}`, unregistered: true };
  };
  return { resolve, errors };
}

// ─── 集計 ────────────────────────────────────────────────────────────────────

export type CorpShareRow = {
  corp: string;
  count: number; // 位置付け件数 (ユニーク 利用者×事業所)
  share: number; // 構成比 %
};

export type ServiceConcentration = {
  service: ShuchuTargetService;
  total: number;
  corps: CorpShareRow[]; // count 降順
  topCorp: string | null;
  topShare: number; // 最大法人の紹介率 %
};

/**
 * (利用者 × 事業所) をサービス種別ごとにユニーク化 → 法人へ名寄せして
 * 法人別件数と最大法人の紹介率を出す。
 */
export function aggregateConcentration(
  pairs: PlacementPair[],
  resolve: CorpResolver,
): { services: ServiceConcentration[]; hasUnregistered: boolean } {
  let hasUnregistered = false;
  // service → ユニークな "userId::provider"
  const uniqueByService = new Map<ShuchuTargetService, Set<string>>();
  for (const p of pairs) {
    if (!uniqueByService.has(p.service)) uniqueByService.set(p.service, new Set());
    uniqueByService.get(p.service)!.add(`${p.userId}::${p.provider}`);
  }
  const services = SHUCHU_TARGET_SERVICES.map((service): ServiceConcentration => {
    const uniq = uniqueByService.get(service);
    const corpCount = new Map<string, number>();
    if (uniq) {
      for (const key of uniq) {
        const provider = key.slice(key.indexOf("::") + 2);
        const { corp, unregistered } = resolve(provider);
        if (unregistered) hasUnregistered = true;
        corpCount.set(corp, (corpCount.get(corp) ?? 0) + 1);
      }
    }
    const total = [...corpCount.values()].reduce((s, v) => s + v, 0);
    const corps = [...corpCount.entries()]
      .map(([corp, count]) => ({
        corp,
        count,
        share: total > 0 ? (count / total) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count || a.corp.localeCompare(b.corp, "ja"));
    return {
      service,
      total,
      corps,
      topCorp: corps[0]?.corp ?? null,
      topShare: corps[0]?.share ?? 0,
    };
  });
  return { services, hasUnregistered };
}
