"use client";

/**
 * 介護請求 / 利用請求 / 国保請求 共通の月次集計 hook
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import {
  aggregateMonthlyVisitSeikyu,
  type UserSeikyuRow,
} from "@/lib/visit-seikyu/aggregate";

export function useSeikyuData() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, loading: btLoading } = useBusinessType();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [rows, setRows] = useState<UserSeikyuRow[]>([]);
  const [recordCount, setRecordCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [officeNumber, setOfficeNumber] = useState<string | null>(null);
  const [officeAddress, setOfficeAddress] = useState<string | null>(null);
  const [officePhone, setOfficePhone] = useState<string | null>(null);
  const [officePostal, setOfficePostal] = useState<string | null>(null);
  const [unitPrice, setUnitPrice] = useState<number>(10);

  const load = useCallback(async () => {
    if (!currentOffice) return;
    setLoading(true);
    setError(null);
    try {
      // 地域単価: offices.unit_price / 事業所番号: business_number (伝送用)
      const { data: officeRow } = await supabase
        .from("offices")
        .select("unit_price, applied_formula_codes, business_number, address, phone, postal_code")
        .eq("id", currentOffice.id)
        .maybeSingle();
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
      const result = await aggregateMonthlyVisitSeikyu(supabase, {
        officeId: currentOffice.id,
        tenantId: currentOffice.tenant_id,
        year,
        month,
        unitPrice: (officeRow as { unit_price?: number } | null)?.unit_price,
        appliedFormulaCodes:
          (officeRow as { applied_formula_codes?: string[] } | null)
            ?.applied_formula_codes ?? [],
      });
      setRows(result.rows);
      setRecordCount(result.recordCount);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
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
    recordCount,
    loading: loading || btLoading,
    error,
    officeName: currentOffice?.name ?? null,
    officeNumber,
    officeAddress,
    officePhone,
    officePostal,
    unitPrice,
    reload: load,
  };
}
