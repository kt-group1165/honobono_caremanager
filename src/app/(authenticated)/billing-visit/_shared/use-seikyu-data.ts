"use client";

/**
 * 介護請求 / 利用請求 / 国保請求 共通の月次集計 hook
 */

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import type { ShogaiSeikyuRow } from "@/lib/shogai-seikyu/aggregate";
import { loadSeikyuData, type SeikyuInitialData } from "./load-seikyu-data";

/**
 * @param initialData page.tsx (server) が ?office= 付きで先読みした集計結果。
 *   現在の事業所・対象月と一致する場合だけ初期 state として使い、初回 fetch を省く。
 */
export function useSeikyuData(initialData?: SeikyuInitialData) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, businessType, loading: btLoading } = useBusinessType();

  const now = new Date();
  const [year, setYear] = useState(initialData?.year ?? now.getFullYear());
  const [month, setMonth] = useState(initialData?.month ?? now.getMonth() + 1);
  const [rows, setRows] = useState<UserSeikyuRow[]>(initialData?.rows ?? []);
  // 総合事業 (7112/様式(予)) の請求行。介護給付 (rows) とは別様式なので分離して保持
  const [sougouRows, setSougouRows] = useState<UserSeikyuRow[]>(initialData?.sougouRows ?? []);
  // 障害福祉サービスの請求行 (利用請求タブの 3 制度統合用。介護/総合とは別集計)。
  // 障害集計が officeId 非該当・実績0・例外時は空配列で続行する (握り潰さず warning)。
  const [shogaiRows, setShogaiRows] = useState<ShogaiSeikyuRow[]>(initialData?.shogaiRows ?? []);
  const [recordCount, setRecordCount] = useState(initialData?.recordCount ?? 0);
  // 集計時の注意事項 (身体介護9系=単位数0の増分コード混入 等)
  const [warnings, setWarnings] = useState<string[]>(initialData?.warnings ?? []);
  // warnings のうち利用者に紐付くものを client_id で引ける索引 (行内⚠バッジ用)
  const [warningsByClient, setWarningsByClient] = useState<Record<string, string[]>>(
    initialData?.warningsByClient ?? {},
  );
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);
  const [officeNumber, setOfficeNumber] = useState<string | null>(initialData?.officeNumber ?? null);
  /**
   * 総合事業の事業所番号 (保険者番号 → 事業所番号)。
   * 総合事業は**市町村ごとの指定**なので、同じ事業所でも市町村によって番号が違う
   * (いすみ: 122184/124412 は介護と同じ 1278600398 / 122382 だけ 12A8600011)。
   * ここに無い保険者は介護の business_number にフォールバックする。
   */
  const [sougouNumberByInsurer, setSougouNumberByInsurer] = useState<Record<string, string>>(
    initialData?.sougouNumberByInsurer ?? {},
  );
  const [officeAddress, setOfficeAddress] = useState<string | null>(initialData?.officeAddress ?? null);
  const [officePhone, setOfficePhone] = useState<string | null>(initialData?.officePhone ?? null);
  const [officePostal, setOfficePostal] = useState<string | null>(initialData?.officePostal ?? null);
  const [unitPrice, setUnitPrice] = useState<number>(initialData?.unitPrice ?? 10);
  const [appliedFormulaCodes, setAppliedFormulaCodes] = useState<string[]>(
    initialData?.appliedFormulaCodes ?? [],
  );

  // 月切替の競合対策: 世代カウンタ。古い fetch の結果は破棄する
  // (前月の遅い応答が当月の結果を上書きするのを防ぐ)
  const genRef = useRef(0);

  const load = useCallback(async () => {
    if (!currentOffice) return;
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    try {
      const d = await loadSeikyuData(supabase, {
        officeId: currentOffice.id,
        tenantId: currentOffice.tenant_id,
        year,
        month,
        isBath: businessType === "訪問入浴",
      });
      if (gen !== genRef.current) return; // 月切替済み → 古い結果は破棄
      setOfficeNumber(d.officeNumber);
      setSougouNumberByInsurer(d.sougouNumberByInsurer);
      setOfficeAddress(d.officeAddress);
      setOfficePhone(d.officePhone);
      setOfficePostal(d.officePostal);
      setUnitPrice(d.unitPrice);
      setAppliedFormulaCodes(d.appliedFormulaCodes);
      setRows(d.rows);
      setSougouRows(d.sougouRows);
      setShogaiRows(d.shogaiRows);
      setRecordCount(d.recordCount);
      setWarnings(d.warnings);
      setWarningsByClient(d.warningsByClient);
    } catch (e) {
      if (gen !== genRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [supabase, currentOffice, businessType, year, month]);

  // SSR (initialData) が現在の事業所・対象月と一致するなら初回 fetch をスキップする。
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (btLoading) return;
    if (isInitialMount.current) {
      isInitialMount.current = false;
      if (
        initialData &&
        initialData.officeId === currentOffice?.id &&
        initialData.year === year &&
        initialData.month === month
      ) {
        return;
      }
    }
    load();
  }, [btLoading, load, initialData, currentOffice, year, month]);

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
    warningsByClient,
    loading: loading || btLoading,
    error,
    officeName: currentOffice?.name ?? null,
    officeNumber,
    sougouNumberByInsurer,
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
