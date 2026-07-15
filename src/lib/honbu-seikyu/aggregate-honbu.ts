/**
 * 本部請求 (本部集計) — 自社全事業所を横断した月次請求サマリ。
 *
 * ★ money-safety (超重要):
 *   本モジュールは use-seikyu-data.ts / use-cross-office-seikyu.ts と "同じ" 集計関数
 *   (aggregateMonthlyVisitSeikyu / aggregateBathVisitSeikyu / aggregateMonthlyShogaiSeikyu)
 *   を officeId だけ差し替えて呼ぶ。金額計算式には一切手を入れない。したがって、ある
 *   事業所の請求額をここで得た値は、その事業所を単独で開いた請求タブの集計値と 1 円も違わない。
 *   合算 (法人横断/全社) は「各事業所・各制度の額を整数加算」するだけ (端数処理を挟まない)。
 *
 * スコープ:
 *   - app_type='kaigo-app' かつ is_active、利用者請求が発生する service_type
 *     (訪問介護 / 訪問看護 / 訪問入浴) を対象。居宅介護支援・福祉用具・通所は対象外。
 *   - 制度は実績・サービスコードの system で分かれる:
 *       介護給付 (訪問介護/看護) + 入浴給付 → kaigo バケット
 *       総合事業 (訪問型サービス)          → sougou バケット
 *       障害福祉サービス                    → shogai バケット
 *   - 事業所を company_id (自社法人) でグループ化し、法人小計・全社総計を出す。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateMonthlyVisitSeikyu,
  type UserSeikyuRow,
} from "@/lib/visit-seikyu/aggregate";
import { aggregateBathVisitSeikyu } from "@/lib/bath-seikyu/aggregate";
import {
  aggregateMonthlyShogaiSeikyu,
  type ShogaiSeikyuRow,
} from "@/lib/shogai-seikyu/aggregate";

const BILLABLE_SERVICE_TYPES = ["訪問介護", "訪問看護", "訪問入浴"] as const;

/** 1 制度分の金額サマリ (すべて集計関数そのままの値の整数加算) */
export interface HonbuSummary {
  count: number; // 利用者(行)数
  totalUnits: number; // 総単位数
  totalAmount: number; // 総額 (総費用額)
  insuranceAmount: number; // 保険/給付費 請求額
  kohiAmount: number; // 公費 請求額
  userAmount: number; // 利用者負担額
}

export function emptySummary(): HonbuSummary {
  return {
    count: 0,
    totalUnits: 0,
    totalAmount: 0,
    insuranceAmount: 0,
    kohiAmount: 0,
    userAmount: 0,
  };
}

/** billed = 国保連/市へ請求する額 (保険+公費+給付費)。表示用の派生値 */
export function billedAmount(s: HonbuSummary): number {
  return s.insuranceAmount + s.kohiAmount;
}

function addInto(dst: HonbuSummary, src: HonbuSummary): void {
  dst.count += src.count;
  dst.totalUnits += src.totalUnits;
  dst.totalAmount += src.totalAmount;
  dst.insuranceAmount += src.insuranceAmount;
  dst.kohiAmount += src.kohiAmount;
  dst.userAmount += src.userAmount;
}

/** 介護給付 / 総合事業 / 入浴給付 の UserSeikyuRow[] を summary に畳む */
function sumKaigo(rows: UserSeikyuRow[]): HonbuSummary {
  const s = emptySummary();
  for (const r of rows) {
    s.count += 1;
    s.totalUnits += r.totalUnits ?? 0;
    s.totalAmount += r.totalAmount ?? 0;
    s.insuranceAmount += r.insuranceAmount ?? 0;
    s.kohiAmount += (r.kohiAmount ?? 0) + (r.kohi2Amount ?? 0);
    s.userAmount += r.userAmount ?? 0;
  }
  return s;
}

/** 障害福祉 の ShogaiSeikyuRow[] を summary に畳む (給付費を insuranceAmount 扱い) */
function sumShogai(rows: ShogaiSeikyuRow[]): HonbuSummary {
  const s = emptySummary();
  for (const r of rows) {
    s.count += 1;
    s.totalUnits += r.totalUnits ?? 0;
    s.totalAmount += r.totalAmount ?? 0;
    s.insuranceAmount += r.benefitAmount ?? 0; // 介護給付費請求額
    // 障害は公費(生保等)を別額で持たないため kohi は 0
    s.userAmount += r.userAmount ?? 0;
  }
  return s;
}

/** 1 事業所分の集計結果 (制度別サマリ) */
export interface HonbuOfficeRow {
  officeId: string;
  officeName: string;
  serviceType: string;
  companyId: string | null;
  kaigo: HonbuSummary; // 介護給付 + 入浴給付
  sougou: HonbuSummary; // 総合事業
  shogai: HonbuSummary; // 障害福祉
}

/** 制度セットの合計 (kaigo+sougou+shogai) を 1 つに畳む */
export function combineAll(row: {
  kaigo: HonbuSummary;
  sougou: HonbuSummary;
  shogai: HonbuSummary;
}): HonbuSummary {
  const s = emptySummary();
  addInto(s, row.kaigo);
  addInto(s, row.sougou);
  addInto(s, row.shogai);
  return s;
}

export interface HonbuSeidoTotals {
  kaigo: HonbuSummary;
  sougou: HonbuSummary;
  shogai: HonbuSummary;
  all: HonbuSummary;
}

function emptyTotals(): HonbuSeidoTotals {
  return {
    kaigo: emptySummary(),
    sougou: emptySummary(),
    shogai: emptySummary(),
    all: emptySummary(),
  };
}

function addRowIntoTotals(t: HonbuSeidoTotals, row: HonbuOfficeRow): void {
  addInto(t.kaigo, row.kaigo);
  addInto(t.sougou, row.sougou);
  addInto(t.shogai, row.shogai);
  addInto(t.all, combineAll(row));
}

export interface HonbuCompanyGroup {
  companyId: string | null;
  companyName: string;
  offices: HonbuOfficeRow[];
  subtotal: HonbuSeidoTotals;
}

export interface HonbuResult {
  year: number;
  month: number;
  groups: HonbuCompanyGroup[];
  grand: HonbuSeidoTotals;
  /** 事業所単位の集計失敗 (money を握り潰さず可視化) */
  errors: string[];
}

interface OfficeMaster {
  id: string;
  name: string;
  service_type: string;
  tenant_id: string;
  unit_price: number | null;
  applied_formula_codes: string[] | null;
  company_id: string | null;
}

async function aggregateOffice(
  supabase: SupabaseClient,
  o: OfficeMaster,
  year: number,
  month: number,
): Promise<HonbuOfficeRow> {
  const unitPrice = o.unit_price ?? undefined;
  const appliedFormulaCodes = o.applied_formula_codes ?? [];
  const base = {
    officeId: o.id,
    officeName: o.name,
    serviceType: o.service_type,
    companyId: o.company_id,
  };

  if (o.service_type === "訪問入浴") {
    const res = await aggregateBathVisitSeikyu(supabase, {
      officeId: o.id,
      tenantId: o.tenant_id,
      year,
      month,
      unitPrice,
      appliedFormulaCodes,
    });
    return {
      ...base,
      kaigo: sumKaigo(res.rows),
      sougou: emptySummary(),
      shogai: emptySummary(),
    };
  }

  // 訪問介護 / 訪問看護: 介護給付 + 総合事業 + 障害 を並列集計。
  // 障害の失敗は介護/総合を壊さないよう空で続行 (use-seikyu-data と同規則)。
  const [visit, shogai] = await Promise.all([
    aggregateMonthlyVisitSeikyu(supabase, {
      officeId: o.id,
      tenantId: o.tenant_id,
      year,
      month,
      unitPrice,
      appliedFormulaCodes,
    }),
    aggregateMonthlyShogaiSeikyu(supabase, {
      officeId: o.id,
      year,
      month,
      unitPrice,
    }).catch((e) => {
      console.warn(
        `[honbu] 障害集計に失敗 (${o.name} は介護/総合のみで続行):`,
        e,
      );
      return { rows: [] as ShogaiSeikyuRow[], month: "", recordCount: 0, warnings: [] };
    }),
  ]);
  return {
    ...base,
    kaigo: sumKaigo(visit.rows),
    sougou: sumKaigo(visit.sougouRows ?? []),
    shogai: sumShogai(shogai.rows),
  };
}

/**
 * 自社全事業所 (app_type='kaigo-app') の月次請求を横断集計し、法人ごとにグループ化して返す。
 */
export async function aggregateHonbu(
  supabase: SupabaseClient,
  opts: { year: number; month: number },
): Promise<HonbuResult> {
  const { year, month } = opts;
  const errors: string[] = [];

  // 1) 対象事業所
  const { data: offRows, error: oe } = await supabase
    .from("offices")
    .select(
      "id, name, service_type, tenant_id, unit_price, applied_formula_codes, company_id",
    )
    .eq("app_type", "kaigo-app")
    .eq("is_active", true)
    .in("service_type", BILLABLE_SERVICE_TYPES as unknown as string[])
    .order("name");
  if (oe) throw new Error("事業所一覧の取得に失敗: " + oe.message);
  const offices = (offRows ?? []) as OfficeMaster[];

  // 2) 法人名 map
  const companyIds = Array.from(
    new Set(offices.map((o) => o.company_id).filter((v): v is string => !!v)),
  );
  const companyNames = new Map<string, string>();
  if (companyIds.length > 0) {
    const { data: comps, error: ce } = await supabase
      .from("companies")
      .select("id, name")
      .in("id", companyIds);
    if (ce) errors.push("法人名の取得に失敗: " + ce.message);
    for (const c of (comps ?? []) as { id: string; name: string }[]) {
      companyNames.set(c.id, c.name);
    }
  }

  // 3) 事業所別に並列集計 (失敗は errors に集約し他事業所は続行)
  const settled = await Promise.allSettled(
    offices.map((o) => aggregateOffice(supabase, o, year, month)),
  );
  const officeRows: HonbuOfficeRow[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") officeRows.push(r.value);
    else
      errors.push(
        `${offices[i].name} の集計に失敗: ${
          r.reason instanceof Error ? r.reason.message : String(r.reason)
        }`,
      );
  });

  // 4) 法人でグループ化 (company_id=null は「(法人未設定)」)
  const NO_COMPANY = "__none__";
  const byCompany = new Map<string, HonbuOfficeRow[]>();
  for (const row of officeRows) {
    const key = row.companyId ?? NO_COMPANY;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key)!.push(row);
  }

  const grand = emptyTotals();
  const groups: HonbuCompanyGroup[] = [];
  for (const [key, rows] of byCompany) {
    const subtotal = emptyTotals();
    for (const row of rows) {
      addRowIntoTotals(subtotal, row);
      addRowIntoTotals(grand, row);
    }
    groups.push({
      companyId: key === NO_COMPANY ? null : key,
      companyName:
        key === NO_COMPANY ? "(法人未設定)" : companyNames.get(key) ?? "(法人名不明)",
      offices: rows,
      subtotal,
    });
  }
  // 法人名の五十音で安定ソート ((法人未設定) は末尾)
  groups.sort((a, b) => {
    if (a.companyId === null) return 1;
    if (b.companyId === null) return -1;
    return a.companyName.localeCompare(b.companyName, "ja");
  });

  return { year, month, groups, grand, errors };
}
