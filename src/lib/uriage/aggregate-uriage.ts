/**
 * 売上 (見込) 集計 — 請求のタイミングに関係なく「当月に提供する/した サービス」で立てる売上。
 *
 * 請求額との違いはデータの絞り方だけで、単位数・加算・限度額・公費・処遇改善の計算は
 * 請求集計エンジン (visit-seikyu / bath-seikyu / shogai-seikyu) をそのまま使う。
 *   請求額 = 実績 (completed / confirmed) のみ
 *   売上額 = 予定 (scheduled / draft) + 実績   ← includeScheduled: true
 * キャンセル (cancelled) はどちらにも入らない。
 *
 * 訪問介護事業所の売上は「介護保険 + 総合事業 + 障害福祉 + 自費」を 1 つの数字に合算し、
 * 内訳を制度別に持つ (user 確定 2026-07-31)。
 *
 * 金額の定義:
 *   制度別内訳 = 費用額 (10割) = 保険/給付費請求 + 公費 + 利用者負担
 *   自費        = 区分支給限度基準の超過分 (全額自費) + 利用実費 (交通費・キャンセル料等)
 *   売上合計    = 制度別内訳の総和 (= 事業所に入ってくる総額)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ID_IN_CHUNK, mapChunksParallel } from "@/lib/chunk-parallel";
import { aggregateMonthlyVisitSeikyu, type UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import { aggregateBathVisitSeikyu } from "@/lib/bath-seikyu/aggregate";
import { aggregateMonthlyShogaiSeikyu } from "@/lib/shogai-seikyu/aggregate";

/** table/列 未作成 (機能未適用) 系のエラーコードか */
const isMissingSchema = (code: string | null | undefined) =>
  code === "42P01" || code === "PGRST205" || code === "42703" || code === "PGRST204";

/** 地域生活支援事業の単価 (1 単位 = 10 円。千葉市の移動支援コード表に準拠) */
const CHIIKI_UNIT_YEN = 10;

export interface UriageBreakdown {
  /** 対象月 (YYYY-MM) */
  month: string;
  /** 売上合計 (円) = kaigo + sougou + shogai + chiiki + kyotaku + jihi */
  total: number;
  // ── 制度別内訳 (いずれも費用額 = 10割) ──
  /** 介護保険 (訪問介護 / 訪問入浴) */
  kaigo: number;
  /** 総合事業 (訪問型サービス A2/A3) */
  sougou: number;
  /** 障害福祉サービス */
  shogai: number;
  /**
   * 地域生活支援事業 (移動支援・養育支援等)。国保連を通さず市町村へ直接請求する。
   * ⚠ 単価表が市町村ごとに違い、現状 千葉市分しか無い (`src/lib/idou-shien-code.ts`)。
   *   実績が `kaigo_idou_shien_records` に入っていない事業所では 0 のままになるので、
   *   「対象実績があるのに 0」を warning で通知する。
   */
  chiiki: number;
  /** 居宅介護支援費 (居宅事業所のみ。全額保険給付) */
  kyotaku: number;
  /** 自費 = 限度額超過の全額自費 + 利用実費 (交通費・キャンセル料等) */
  jihi: number;
  // ── 参考: 財源別 (制度別内訳の再分解。total の再集計には使わない) ──
  /** 保険・給付費 請求額 */
  insurance: number;
  /** 公費 請求額 */
  kohi: number;
  /** 利用者負担 (法定分。自費は含まない) */
  userBurden: number;
  /** 集計上の注意 (一部制度の取得に失敗した等)。金額には影響しない */
  warnings: string[];
}

export const EMPTY_URIAGE: UriageBreakdown = {
  month: "",
  total: 0,
  kaigo: 0,
  sougou: 0,
  shogai: 0,
  chiiki: 0,
  kyotaku: 0,
  jihi: 0,
  insurance: 0,
  kohi: 0,
  userBurden: 0,
  warnings: [],
};

/** UserSeikyuRow[] の費用額 (10割) 合計。限度額超過の全額自費は jihi 側で数えるので除く */
const sumCost = (rows: UserSeikyuRow[]) => rows.reduce((s, r) => s + (r.totalAmount ?? 0), 0);
const sumSelfPay = (rows: UserSeikyuRow[]) => rows.reduce((s, r) => s + (r.selfPayAmount ?? 0), 0);

export interface UriageOpts {
  officeId: string;
  tenantId: string;
  /** offices.service_type 由来の事業種別 (business-type-context の BusinessType) */
  businessType: string;
  year: number;
  month: number; // 1-12
  /**
   * false = 実績のみで集計する (= 請求額と同じ絞り込み)。
   * 省略時 true = 予定 + 実績 (= 売上見込)。
   */
  includeScheduled?: boolean;
}

/**
 * 1 事業所 1 ヶ月の売上を制度別内訳付きで集計する。
 *
 * 事業種別で集計元を切り替える:
 *   訪問介護 → visit-seikyu (介護 + 総合事業) + shogai-seikyu (障害)
 *   訪問入浴 → bath-seikyu (介護) ※障害・総合事業は取り扱いなし
 *   居宅介護支援 → kaigo_care_support_claims (居宅介護支援費は月次の請求行が実体)
 * いずれも 利用実費 (riyou_jippi_entries) を自費に合算する。
 */
export async function aggregateMonthlyUriage(
  supabase: SupabaseClient,
  opts: UriageOpts,
): Promise<UriageBreakdown> {
  const includeScheduled = opts.includeScheduled !== false;
  const monthStr = `${opts.year}-${String(opts.month).padStart(2, "0")}`;
  const warnings: string[] = [];

  // 地域単価・処遇改善は請求と同じ事業所設定を使う。
  // 取得失敗時は単価 10.0 で誤集計しないよう中断する (use-seikyu-data.ts と同方針)。
  const { data: officeRow, error: officeError } = await supabase
    .from("offices")
    .select("unit_price, applied_formula_codes")
    .eq("id", opts.officeId)
    .maybeSingle();
  if (officeError) {
    throw new Error(`事業所情報 (地域単価) の取得に失敗したため売上集計を中断しました: ${officeError.message}`);
  }
  const or = officeRow as { unit_price?: number | null; applied_formula_codes?: string[] | null } | null;
  const unitPrice = or?.unit_price ?? undefined;
  const appliedFormulaCodes = or?.applied_formula_codes ?? [];

  const isBath = opts.businessType === "訪問入浴";
  const isKyotaku = opts.businessType === "居宅介護支援";

  let kaigo = 0;
  let sougou = 0;
  let shogai = 0;
  let chiiki = 0;
  let kyotaku = 0;
  let jihi = 0;
  let insurance = 0;
  let kohi = 0;
  let userBurden = 0;
  /** 実費のスコープ用: 当月に当事業所でサービスがあった利用者 */
  const clientIds = new Set<string>();

  if (isKyotaku) {
    const r = await aggregateKyotakuClaims(supabase, opts.officeId, monthStr);
    kyotaku = r.total;
    insurance += r.total; // 居宅介護支援費は 10割保険給付 (利用者負担なし)
    for (const id of r.clientIds) clientIds.add(id);
    warnings.push(...r.warnings);
  } else {
    // 介護 (+ 総合事業) と 障害 を並行集計。障害側の失敗は介護側を壊さない
    const [visitResult, shogaiResult] = await Promise.all([
      isBath
        ? aggregateBathVisitSeikyu(supabase, {
            officeId: opts.officeId,
            tenantId: opts.tenantId,
            year: opts.year,
            month: opts.month,
            unitPrice,
            appliedFormulaCodes,
            includeScheduled,
          })
        : aggregateMonthlyVisitSeikyu(supabase, {
            officeId: opts.officeId,
            tenantId: opts.tenantId,
            year: opts.year,
            month: opts.month,
            unitPrice,
            appliedFormulaCodes,
            includeScheduled,
          }),
      isBath
        ? Promise.resolve(null)
        : aggregateMonthlyShogaiSeikyu(supabase, {
            officeId: opts.officeId,
            year: opts.year,
            month: opts.month,
            unitPrice,
            includeScheduled,
          }).catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            warnings.push(`障害福祉分の集計に失敗したため売上に含まれていません: ${msg}`);
            return null;
          }),
    ]);

    const rows = visitResult.rows;
    const sRows = visitResult.sougouRows ?? [];
    kaigo = sumCost(rows);
    sougou = sumCost(sRows);
    jihi += sumSelfPay(rows) + sumSelfPay(sRows);
    for (const r of [...rows, ...sRows]) {
      insurance += r.insuranceAmount ?? 0;
      kohi += r.kohiAmount ?? 0;
      kohi += r.kohi2Amount ?? 0;
      userBurden += r.userAmount ?? 0;
      clientIds.add(r.user_id);
    }

    if (shogaiResult) {
      for (const r of shogaiResult.rows) {
        shogai += r.totalAmount ?? 0;
        insurance += r.benefitAmount ?? 0;
        userBurden += r.userAmount ?? 0;
        clientIds.add(r.user_id);
      }
    }
  }

  // 地域生活支援事業 (移動支援・養育支援) — 国保連を通さず市町村へ直接請求する分。
  //   ⚠ 2026-08 時点で `kaigo_idou_shien_records` は全社 0 件 = **実績が取り込まれていない**。
  //     茂原だけで 6 月に 117 行 (移動支援 109 / 養育支援 8) あり、売上に乗っていなかった
  //     (実測差額 121,479 円)。ここで 0 のまま黙らせず必ず通知する。
  if (!isKyotaku) {
    const chi = await sumChiiki(supabase, opts.officeId, monthStr);
    chiiki = chi.total;
    userBurden += chi.userBurden;
    for (const id of chi.clientIds) clientIds.add(id);
    warnings.push(...chi.warnings);
  }

  // 利用実費 (交通費・キャンセル料等の保険外費用) — 当月に当事業所でサービスがあった利用者分
  const jippi = await sumJippi(supabase, [...clientIds], monthStr);
  jihi += jippi.total;
  warnings.push(...jippi.warnings);

  return {
    month: monthStr,
    total: kaigo + sougou + shogai + chiiki + kyotaku + jihi,
    kaigo,
    sougou,
    shogai,
    chiiki,
    kyotaku,
    jihi,
    insurance,
    kohi,
    userBurden,
    warnings,
  };
}

// ─── 全事業所 (法人横断) の売上 ────────────────────────────────────────────

/** 1 事業所分の売上 */
export interface OfficeUriage {
  officeId: string;
  officeName: string;
  /** offices.service_type (訪問介護 / 訪問看護 / 訪問入浴 / 居宅介護支援) */
  serviceType: string;
  uriage: UriageBreakdown;
}

export interface AllOfficesUriage {
  month: string;
  /** 事業所別 (売上の降順) */
  offices: OfficeUriage[];
  /** 全事業所の合算 */
  total: UriageBreakdown;
  /** 事業所単位の集計失敗 (金額を握り潰さず可視化する)。失敗した事業所は total に入らない */
  errors: string[];
}

/** UriageBreakdown の単純加算 (制度別・財源別ともに整数加算) */
export function sumUriage(month: string, list: UriageBreakdown[]): UriageBreakdown {
  const out: UriageBreakdown = { ...EMPTY_URIAGE, month, warnings: [] };
  for (const u of list) {
    out.total += u.total;
    out.kaigo += u.kaigo;
    out.sougou += u.sougou;
    out.shogai += u.shogai;
    out.kyotaku += u.kyotaku;
    out.jihi += u.jihi;
    out.insurance += u.insurance;
    out.kohi += u.kohi;
    out.userBurden += u.userBurden;
    out.warnings.push(...u.warnings);
  }
  return out;
}

/** offices.service_type → BusinessType (business-type-context の mapBusinessType と同じ寄せ方) */
function businessTypeOf(serviceType: string): string {
  if (serviceType === "訪問入浴") return "訪問入浴";
  if (serviceType === "訪問介護" || serviceType === "訪問看護") return "訪問介護";
  return "居宅介護支援";
}

/**
 * kaigo-app の全 (有効) 事業所の売上を集計する。
 *
 * ★ money-safety: 各事業所の値は aggregateMonthlyUriage を officeId だけ差し替えて
 *   得たものなので、その事業所を単独で開いた時の売上と 1 円も違わない。
 *   合算は整数加算のみ (use-cross-office-seikyu.ts と同じ方針)。
 *
 * 事業所数 × 請求エンジンなので重い。呼出側は明示操作 (ボタン) で起動し、
 * onProgress で進捗を出すこと。1 事業所の失敗は errors に集約して他を続行する。
 */
export async function aggregateAllOfficesUriage(
  supabase: SupabaseClient,
  opts: {
    year: number;
    month: number;
    includeScheduled?: boolean;
    /** 同時実行数 (既定 4)。上げすぎると PostgREST 側が詰まる */
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<AllOfficesUriage> {
  const monthStr = `${opts.year}-${String(opts.month).padStart(2, "0")}`;
  const { data, error } = await supabase
    .from("offices")
    .select("id, name, service_type, tenant_id")
    .eq("app_type", "kaigo-app")
    .eq("is_active", true)
    .order("service_type")
    .order("name");
  if (error) throw new Error(`事業所一覧の取得に失敗しました: ${error.message}`);
  const offices = (data ?? []) as {
    id: string;
    name: string;
    service_type: string;
    tenant_id: string;
  }[];

  const errors: string[] = [];
  const results: OfficeUriage[] = [];
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  let next = 0;
  let done = 0;
  opts.onProgress?.(0, offices.length);

  const runners = Array.from({ length: Math.min(concurrency, offices.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= offices.length) return;
      const o = offices[i];
      try {
        const uriage = await aggregateMonthlyUriage(supabase, {
          officeId: o.id,
          tenantId: o.tenant_id,
          businessType: businessTypeOf(o.service_type),
          year: opts.year,
          month: opts.month,
          includeScheduled: opts.includeScheduled,
        });
        results.push({
          officeId: o.id,
          officeName: o.name,
          serviceType: o.service_type,
          uriage,
        });
      } catch (e: unknown) {
        errors.push(`${o.name} の集計に失敗: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        opts.onProgress?.(++done, offices.length);
      }
    }
  });
  await Promise.all(runners);

  results.sort((a, b) => b.uriage.total - a.uriage.total || a.officeName.localeCompare(b.officeName, "ja"));
  return {
    month: monthStr,
    offices: results,
    total: sumUriage(monthStr, results.map((r) => r.uriage)),
    errors,
  };
}

/**
 * 居宅介護支援費の月次売上 = kaigo_care_support_claims の費用合計。
 * claims に office_id が無いため 自事業所の担当利用者 (client_office_assignments) で絞る。
 */
async function aggregateKyotakuClaims(
  supabase: SupabaseClient,
  officeId: string,
  monthStr: string,
): Promise<{ total: number; clientIds: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  // 自事業所の担当利用者 (page-loop で全件)
  const PAGE = 1000;
  const assigned: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("client_office_assignments")
      .select("client_id")
      .eq("office_id", officeId)
      .order("client_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      warnings.push(`担当利用者の取得に失敗したため居宅介護支援費の売上を集計できませんでした: ${error.message}`);
      return { total: 0, clientIds: [], warnings };
    }
    const rows = (data ?? []) as { client_id: string }[];
    assigned.push(...rows.map((r) => r.client_id));
    if (rows.length < PAGE) break;
  }
  if (assigned.length === 0) return { total: 0, clientIds: [], warnings };

  const chunks = await mapChunksParallel(assigned, ID_IN_CHUNK, async (chunk) => {
    const { data, error } = await supabase
      .from("kaigo_care_support_claims")
      .select("user_id, total_amount")
      .eq("billing_month", monthStr)
      .in("user_id", chunk);
    if (error) {
      warnings.push(`居宅介護支援費の取得に失敗しました: ${error.message}`);
      return [] as { user_id: string; total_amount: number | null }[];
    }
    return (data ?? []) as { user_id: string; total_amount: number | null }[];
  });

  let total = 0;
  const clientIds: string[] = [];
  for (const rows of chunks) {
    for (const r of rows) {
      total += r.total_amount ?? 0;
      clientIds.push(r.user_id);
    }
  }
  return { total, clientIds, warnings };
}

/** 利用実費 (riyou_jippi_entries) の月次合計。table 未適用 (機能未使用) は 0 円で続行 */
async function sumJippi(
  supabase: SupabaseClient,
  clientIds: string[],
  monthStr: string,
): Promise<{ total: number; warnings: string[] }> {
  const warnings: string[] = [];
  if (clientIds.length === 0) return { total: 0, warnings };
  const chunks = await mapChunksParallel(clientIds, ID_IN_CHUNK, async (chunk) => {
    const { data, error } = await supabase
      .from("riyou_jippi_entries")
      .select("amount")
      .eq("target_month", monthStr)
      .in("client_id", chunk);
    if (error) {
      if (!isMissingSchema(error.code)) {
        warnings.push(`利用実費の取得に失敗したため売上に含まれていません: ${error.message}`);
      }
      return [] as { amount: number | null }[];
    }
    return (data ?? []) as { amount: number | null }[];
  });
  let total = 0;
  for (const rows of chunks) for (const r of rows) total += r.amount ?? 0;
  return { total, warnings };
}

/**
 * 地域生活支援事業 (移動支援・養育支援) の月次合計。
 *
 * 国保連を通さず市町村へ直接請求する制度で、`kaigo_idou_shien_records` に実績を持つ。
 * 1 単位 = 10 円 (千葉市)。利用者負担は 生保/非課税=0円・課税世帯=10% だが、
 * 既定は 0 円 (非課税前提) — idou-billing 画面と同じ扱い。
 *
 * ⚠ **売上に乗らない事故が実際に起きた**ので黙って 0 を返さない。
 *   茂原 2026-06 は稼働データに移動支援 109 行 + 養育支援 8 行あるのに
 *   `kaigo_idou_shien_records` が 0 件で、売上が 121,479 円少なかった。
 *   実績が 1 件も無いのにシフト側 (kaigo_visit_schedule) に移動支援の予定がある場合は
 *   「取り込まれていない」ことを warning で通知する。
 */
async function sumChiiki(
  supabase: SupabaseClient,
  officeId: string,
  monthStr: string,
): Promise<{ total: number; userBurden: number; clientIds: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const clientIds: string[] = [];
  const from = `${monthStr}-01`;
  const to = `${monthStr}-31`;

  const { data, error } = await supabase
    .from("kaigo_idou_shien_records")
    .select("client_id, units, user_burden")
    .eq("office_id", officeId)
    .gte("service_date", from)
    .lte("service_date", to);
  if (error) {
    if (!isMissingSchema(error.code)) {
      warnings.push(`地域生活支援事業 (移動支援等) の取得に失敗したため売上に含まれていません: ${error.message}`);
    }
    return { total: 0, userBurden: 0, clientIds, warnings };
  }

  const rows = (data ?? []) as { client_id: string; units: number | null; user_burden: number | null }[];
  let total = 0;
  let userBurden = 0;
  for (const r of rows) {
    total += (r.units ?? 0) * CHIIKI_UNIT_YEN;
    userBurden += r.user_burden ?? 0;
    clientIds.push(r.client_id);
  }

  // 実績ゼロなのにシフトに移動支援の予定がある = 取り込み漏れ。売上が黙って欠ける
  if (rows.length === 0) {
    const { data: sched } = await supabase
      .from("kaigo_visit_schedule")
      .select("id", { count: "exact", head: false })
      .eq("office_id", officeId)
      .gte("visit_date", from)
      .lte("visit_date", to)
      .ilike("service_type", "%移動支援%")
      .limit(1);
    if ((sched ?? []).length > 0) {
      warnings.push(
        "移動支援の予定はあるのに実績 (kaigo_idou_shien_records) が 0 件です — 地域生活支援事業分が売上に計上されていません",
      );
    }
  }
  return { total, userBurden, clientIds, warnings };
}
