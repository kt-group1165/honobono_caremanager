"use client";

/**
 * 介護請求 / 利用請求 / 国保請求 共通の月次集計 hook
 */

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import {
  aggregateMonthlyVisitSeikyu,
  type UserSeikyuRow,
} from "@/lib/visit-seikyu/aggregate";
import {
  aggregateMonthlyShogaiSeikyu,
  type ShogaiSeikyuRow,
} from "@/lib/shogai-seikyu/aggregate";

export function useSeikyuData() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, loading: btLoading } = useBusinessType();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [rows, setRows] = useState<UserSeikyuRow[]>([]);
  // 総合事業 (7112/様式(予)) の請求行。介護給付 (rows) とは別様式なので分離して保持
  const [sougouRows, setSougouRows] = useState<UserSeikyuRow[]>([]);
  // 障害福祉サービスの請求行 (利用請求タブの 3 制度統合用。介護/総合とは別集計)。
  // 障害集計が officeId 非該当・実績0・例外時は空配列で続行する (握り潰さず warning)。
  const [shogaiRows, setShogaiRows] = useState<ShogaiSeikyuRow[]>([]);
  const [recordCount, setRecordCount] = useState(0);
  // 集計時の注意事項 (身体介護9系=単位数0の増分コード混入 等)
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [officeNumber, setOfficeNumber] = useState<string | null>(null);
  const [officeAddress, setOfficeAddress] = useState<string | null>(null);
  const [officePhone, setOfficePhone] = useState<string | null>(null);
  const [officePostal, setOfficePostal] = useState<string | null>(null);
  const [unitPrice, setUnitPrice] = useState<number>(10);
  const [appliedFormulaCodes, setAppliedFormulaCodes] = useState<string[]>([]);

  // 月切替の競合対策: 世代カウンタ。古い fetch の結果は破棄する
  // (前月の遅い応答が当月の結果を上書きするのを防ぐ)
  const genRef = useRef(0);

  const load = useCallback(async () => {
    if (!currentOffice) return;
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    try {
      // 地域単価: offices.unit_price / 事業所番号: business_number (伝送用)
      // 取得失敗時は単価 10.0 で誤集計しないよう、ここで集計を中断する
      const { data: officeRow, error: officeError } = await supabase
        .from("offices")
        .select("unit_price, applied_formula_codes, business_number, address, phone, postal_code")
        .eq("id", currentOffice.id)
        .maybeSingle();
      if (officeError) {
        throw new Error(
          `事業所情報 (地域単価・事業所番号) の取得に失敗したため集計を中断しました: ${officeError.message}`,
        );
      }
      if (gen !== genRef.current) return; // 古い fetch は破棄
      const or = officeRow as {
        business_number?: string | null;
        address?: string | null;
        phone?: string | null;
        postal_code?: string | null;
      } | null;
      setOfficeNumber(or?.business_number ?? null);
      setOfficeAddress(or?.address ?? null);
      setOfficePhone(or?.phone ?? null);
      setOfficePostal(or?.postal_code ?? null);
      setUnitPrice(
        (officeRow as { unit_price?: number } | null)?.unit_price ?? 10,
      );
      setAppliedFormulaCodes(
        (officeRow as { applied_formula_codes?: string[] } | null)
          ?.applied_formula_codes ?? [],
      );
      // 介護/総合 (visit) と 障害 (shogai) を並行集計。
      // 障害側の失敗は介護/総合の集計を絶対に壊さないよう握って空配列で続行する
      // (障害の実績0・officeId 非該当・例外時)。介護/総合は従来どおり throw で中断。
      const [result, shogaiResult] = await Promise.all([
        aggregateMonthlyVisitSeikyu(supabase, {
          officeId: currentOffice.id,
          tenantId: currentOffice.tenant_id,
          year,
          month,
          unitPrice: (officeRow as { unit_price?: number } | null)?.unit_price,
          appliedFormulaCodes:
            (officeRow as { applied_formula_codes?: string[] } | null)
              ?.applied_formula_codes ?? [],
        }),
        aggregateMonthlyShogaiSeikyu(supabase, {
          officeId: currentOffice.id,
          year,
          month,
          unitPrice: (officeRow as { unit_price?: number } | null)?.unit_price,
        }).catch((e) => {
          console.warn("障害請求集計に失敗 (利用請求は介護/総合のみで続行):", e);
          return { rows: [], month: "", recordCount: 0 };
        }),
      ]);
      if (gen !== genRef.current) return; // 月切替済み → 古い結果は破棄
      setRows(result.rows);
      setSougouRows(result.sougouRows ?? []);
      setShogaiRows(shogaiResult.rows);
      setRecordCount(result.recordCount);
      setWarnings(result.warnings);
    } catch (e) {
      if (gen !== genRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [supabase, currentOffice, year, month]);

  useEffect(() => {
    if (btLoading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/月変更時の fetch
    load();
  }, [btLoading, load]);

  const onMonthChange = (y: number, m: number) => {
    setYear(y);
    setMonth(m);
  };

  return {
    year,
    month,
    onMonthChange,
    rows,
    sougouRows,
    shogaiRows,
    recordCount,
    warnings,
    loading: loading || btLoading,
    error,
    officeName: currentOffice?.name ?? null,
    officeNumber,
    officeAddress,
    officePhone,
    officePostal,
    unitPrice,
    appliedFormulaCodes,
    officeId: currentOffice?.id ?? null,
    tenantId: currentOffice?.tenant_id ?? null,
    reload: load,
  };
}
