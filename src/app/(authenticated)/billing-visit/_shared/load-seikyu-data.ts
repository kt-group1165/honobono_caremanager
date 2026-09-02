/**
 * 請求画面 (介護請求 / 利用請求 / 国保請求 / 月次情報) の月次集計ロジック。
 *
 * ⚠ このファイルは **"use client" を付けない**。
 *   page.tsx (Server Component) と use-seikyu-data.ts (client hook) の両方から
 *   import するため。"use client" ファイルから Server Component へ関数を import すると
 *   server bundle 側で undefined になる事故がある
 *   (memory: feedback_use_client_const_export.md)。
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

/** SSR で先読みできる月次集計の結果一式 (client hook の初期 state になる) */
export interface SeikyuInitialData {
  /** この集計を取得した office / 対象月 (client 側で一致判定に使う) */
  officeId: string;
  year: number;
  month: number;
  rows: UserSeikyuRow[];
  sougouRows: UserSeikyuRow[];
  shogaiRows: ShogaiSeikyuRow[];
  recordCount: number;
  warnings: string[];
  warningsByClient: Record<string, string[]>;
  officeNumber: string | null;
  sougouNumberByInsurer: Record<string, string>;
  officeAddress: string | null;
  officePhone: string | null;
  officePostal: string | null;
  unitPrice: number;
  appliedFormulaCodes: string[];
}

/**
 * 事業所情報 + 介護/総合/障害の月次集計をまとめて取得する。
 *
 * `isBath` (訪問入浴) は client では BusinessTypeContext の businessType から
 * 判定しているが、server では offices.service_type から同じ判定ができる。
 * 呼出側で解決済みの値を渡す。
 */
export async function loadSeikyuData(
  supabase: SupabaseClient,
  params: {
    officeId: string;
    tenantId: string;
    year: number;
    month: number;
    isBath: boolean;
  },
): Promise<Omit<SeikyuInitialData, "officeId" | "year" | "month">> {
  const { officeId, tenantId, year, month, isBath } = params;

  // 地域単価: offices.unit_price / 事業所番号: business_number (伝送用)
  // 取得失敗時は単価 10.0 で誤集計しないよう throw する。
  // 総合事業の事業所番号 (office_sougou_numbers) は独立クエリなので並列で取る。
  const [officeRes, sougouRes] = await Promise.all([
    supabase
      .from("offices")
      .select(
        "unit_price, applied_formula_codes, business_number, sougou_business_number, address, phone, postal_code",
      )
      .eq("id", officeId)
      .maybeSingle(),
    supabase
      .from("office_sougou_numbers")
      .select("insurer_number, business_number")
      .eq("office_id", officeId),
  ]);
  if (officeRes.error) {
    throw new Error(
      `事業所情報 (地域単価・事業所番号) の取得に失敗したため集計を中断しました: ${officeRes.error.message}`,
    );
  }
  const or = officeRes.data as {
    unit_price?: number;
    applied_formula_codes?: string[];
    business_number?: string | null;
    address?: string | null;
    phone?: string | null;
    postal_code?: string | null;
  } | null;

  // 総合事業の事業所番号 (保険者ごと)。テーブル未適用でも集計は止めない
  const sougouNumberByInsurer: Record<string, string> = {};
  if (!sougouRes.error) {
    for (const r of (sougouRes.data ?? []) as { insurer_number: string; business_number: string }[]) {
      sougouNumberByInsurer[r.insurer_number] = r.business_number;
    }
  }

  const unitPrice = or?.unit_price ?? 10;
  const appliedFormulaCodes = or?.applied_formula_codes ?? [];

  // 介護/総合 (visit) と 障害 (shogai) を並行集計。
  // 障害側の失敗は介護/総合の集計を絶対に壊さないよう握って空配列で続行する。
  // 訪問入浴事業所は入浴実績(kaigo_bath_visit_records)から集計。障害/総合は無し。
  const [result, shogaiResult] = await Promise.all([
    isBath
      ? aggregateBathVisitSeikyu(supabase, {
          officeId,
          tenantId,
          year,
          month,
          unitPrice: or?.unit_price,
          appliedFormulaCodes,
        })
      : aggregateMonthlyVisitSeikyu(supabase, {
          officeId,
          tenantId,
          year,
          month,
          unitPrice: or?.unit_price,
          appliedFormulaCodes,
        }),
    isBath
      ? Promise.resolve({ rows: [] as ShogaiSeikyuRow[], month: "", recordCount: 0 })
      : aggregateMonthlyShogaiSeikyu(supabase, {
          officeId,
          year,
          month,
          unitPrice: or?.unit_price,
        }).catch((e) => {
          console.warn("障害請求集計に失敗 (利用請求は介護/総合のみで続行):", e);
          return { rows: [] as ShogaiSeikyuRow[], month: "", recordCount: 0 };
        }),
  ]);

  return {
    rows: result.rows,
    sougouRows: result.sougouRows ?? [],
    shogaiRows: shogaiResult.rows,
    recordCount: result.recordCount,
    warnings: result.warnings,
    warningsByClient: result.warningsByClient ?? {},
    officeNumber: or?.business_number ?? null,
    sougouNumberByInsurer,
    officeAddress: or?.address ?? null,
    officePhone: or?.phone ?? null,
    officePostal: or?.postal_code ?? null,
    unitPrice,
    appliedFormulaCodes,
  };
}
