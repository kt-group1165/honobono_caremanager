"use client";

import { createContext, useContext, useState, useEffect, ReactNode, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";

type BusinessType = "居宅介護支援" | "訪問介護" | "通所介護";

export interface OfficeRow {
  id: string;
  office_name: string;
  business_type: string;
  provider_number: string;
  is_active: boolean;
}

interface BusinessTypeContextValue {
  businessType: BusinessType;
  /** @deprecated 事業種別は自事業所のbusiness_typeから自動取得。直接変更不可。 */
  setBusinessType: (type: BusinessType) => void;
  loading: boolean;
  isLocked: boolean;
  // 複数事業所対応 — こちらが公式の切替手段
  offices: OfficeRow[];          // 全自事業所一覧
  currentOfficeId: string | null; // 現在選択されている自事業所ID
  setCurrentOfficeId: (id: string) => void;
  currentOffice: OfficeRow | null;
}

const BusinessTypeContext = createContext<BusinessTypeContextValue>({
  businessType: "居宅介護支援",
  setBusinessType: () => {},
  loading: true,
  isLocked: false,
  offices: [],
  currentOfficeId: null,
  setCurrentOfficeId: () => {},
  currentOffice: null,
});

// business_type値（DB） → 表示名のマッピング
function mapBusinessType(dbValue: string): BusinessType {
  if (dbValue === "home_care" || dbValue === "訪問介護") return "訪問介護";
  if (dbValue === "day_service" || dbValue === "通所介護") return "通所介護";
  return "居宅介護支援";
}

const STORAGE_KEY = "kaigo.current_office_id";

export function BusinessTypeProvider({ children }: { children: ReactNode }) {
  const [businessType, setBusinessTypeState] = useState<BusinessType>("居宅介護支援");
  const [loading, setLoading] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const [offices, setOffices] = useState<OfficeRow[]>([]);
  const [currentOfficeId, setCurrentOfficeIdState] = useState<string | null>(null);
  const supabase = useMemo(() => createClient(), []);

  const currentOffice = offices.find((o) => o.id === currentOfficeId) ?? null;

  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const modeParam = params.get("mode");
    const officeParam = params.get("office");

    const loadOffices = async () => {
      const { data } = await supabase
        .from("kaigo_office_settings")
        .select("id, office_name, business_type, provider_number, is_active")
        .order("office_name");
      const list = (data || []) as OfficeRow[];
      setOffices(list);
      return list;
    };

    const init = async () => {
      const list = await loadOffices();

      // 1. URL ?office= が最優先
      let officeId: string | null = officeParam && list.some((o) => o.id === officeParam) ? officeParam : null;
      // 2. localStorage
      if (!officeId) {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && list.some((o) => o.id === stored)) officeId = stored;
      }
      // 3. 最初の有効な事業所
      if (!officeId && list.length > 0) {
        officeId = (list.find((o) => o.is_active) ?? list[0]).id;
      }
      setCurrentOfficeIdState(officeId);
      if (officeId) {
        localStorage.setItem(STORAGE_KEY, officeId);
        // URLに ?office=<ID> を強制的に反映（未指定 or 古い場合）
        if (officeParam !== officeId) {
          const url = new URL(window.location.href);
          url.searchParams.set("office", officeId);
          url.searchParams.delete("mode");
          window.history.replaceState(null, "", url.toString());
        }
      }

      // 事業種別は「現在選択中の自事業所」から自動取得（優先）
      // URL ?mode= は事業所が未選択の場合のみフォールバックとして使用
      const selected = list.find((o) => o.id === officeId);
      if (selected?.business_type) {
        setBusinessTypeState(mapBusinessType(selected.business_type));
        setIsLocked(false);
      } else if (modeParam === "訪問介護" || modeParam === "居宅介護支援" || modeParam === "通所介護") {
        // 事業所未登録時のフォールバック（開発・テスト用）
        setBusinessTypeState(modeParam as BusinessType);
        setIsLocked(true);
      }
      setLoading(false);
    };

    init();
  }, [supabase]);

  // ページ遷移や外部遷移でURLから ?office= が消えた場合に補填する
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!currentOfficeId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("office") !== currentOfficeId) {
      url.searchParams.set("office", currentOfficeId);
      window.history.replaceState(null, "", url.toString());
    }
  });

  const setBusinessType = async (type: BusinessType) => {
    if (isLocked) return;
    setBusinessTypeState(type);
    if (currentOfficeId) {
      await supabase
        .from("kaigo_office_settings")
        .update({ business_type: type })
        .eq("id", currentOfficeId);
    }
  };

  const setCurrentOfficeId = (id: string) => {
    setCurrentOfficeIdState(id);
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, id);
      // URLに ?office=<ID> を反映（リロードやブックマークにも追従）
      const url = new URL(window.location.href);
      url.searchParams.set("office", id);
      // mode= の残骸があれば削除
      url.searchParams.delete("mode");
      window.history.replaceState(null, "", url.toString());
    }
    // 選択した事業所の種別に追従
    const selected = offices.find((o) => o.id === id);
    if (selected?.business_type) {
      setBusinessTypeState(mapBusinessType(selected.business_type));
      setIsLocked(false);
    }
  };

  return (
    <BusinessTypeContext.Provider value={{
      businessType, setBusinessType, loading, isLocked,
      offices, currentOfficeId, setCurrentOfficeId, currentOffice,
    }}>
      {children}
    </BusinessTypeContext.Provider>
  );
}

export function useBusinessType() {
  return useContext(BusinessTypeContext);
}
