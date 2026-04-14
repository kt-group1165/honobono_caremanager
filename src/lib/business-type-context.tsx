"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";

type BusinessType = "居宅介護支援" | "訪問介護" | "通所介護";

const COOKIE_NAME = "kaigo_mode_lock";

interface BusinessTypeContextValue {
  businessType: BusinessType;
  setBusinessType: (type: BusinessType) => void;
  loading: boolean;
  isLocked: boolean;
}

const BusinessTypeContext = createContext<BusinessTypeContextValue>({
  businessType: "居宅介護支援",
  setBusinessType: () => {},
  loading: true,
  isLocked: false,
});

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[2]) : null;
}

function setCookie(name: string, value: string, days = 365) {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires};path=/`;
}

export function BusinessTypeProvider({ children }: { children: ReactNode }) {
  const [businessType, setBusinessTypeState] = useState<BusinessType>("居宅介護支援");
  const [loading, setLoading] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    if (typeof window === "undefined") return;

    // 1. URLパラメータ ?mode= をチェック → あれば Cookie に保存
    const params = new URLSearchParams(window.location.search);
    const modeParam = params.get("mode");
    if (modeParam === "訪問介護" || modeParam === "居宅介護支援" || modeParam === "通所介護") {
      setCookie(COOKIE_NAME, modeParam);
      setBusinessTypeState(modeParam as BusinessType);
      setIsLocked(true);
      setLoading(false);
      // URLから ?mode= を消す（見た目をきれいに）
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, "", cleanUrl);
      return;
    }

    // 2. Cookie をチェック → あれば固定モード
    const cookieMode = getCookie(COOKIE_NAME);
    if (cookieMode === "訪問介護" || cookieMode === "居宅介護支援" || cookieMode === "通所介護") {
      setBusinessTypeState(cookieMode as BusinessType);
      setIsLocked(true);
      setLoading(false);
      return;
    }

    // 3. どちらもなければ DB から読む（従来通り）
    const fetch = async () => {
      const { data } = await supabase
        .from("kaigo_office_settings")
        .select("business_type")
        .limit(1)
        .single();
      if (data?.business_type) {
        setBusinessTypeState(data.business_type as BusinessType);
      }
      setLoading(false);
    };
    fetch();
  }, [supabase]);

  const setBusinessType = async (type: BusinessType) => {
    if (isLocked) return;
    setBusinessTypeState(type);
    await supabase
      .from("kaigo_office_settings")
      .update({ business_type: type })
      .not("id", "is", null);
  };

  return (
    <BusinessTypeContext.Provider value={{ businessType, setBusinessType, loading, isLocked }}>
      {children}
    </BusinessTypeContext.Provider>
  );
}

export function useBusinessType() {
  return useContext(BusinessTypeContext);
}
