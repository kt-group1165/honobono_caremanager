"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";

type BusinessType = "居宅介護支援" | "訪問介護" | "通所介護";

interface BusinessTypeContextValue {
  businessType: BusinessType;
  setBusinessType: (type: BusinessType) => void;
  loading: boolean;
}

const BusinessTypeContext = createContext<BusinessTypeContextValue>({
  businessType: "居宅介護支援",
  setBusinessType: () => {},
  loading: true,
});

export function BusinessTypeProvider({ children }: { children: ReactNode }) {
  const [businessType, setBusinessTypeState] = useState<BusinessType>("居宅介護支援");
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
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
    setBusinessTypeState(type);
    await supabase
      .from("kaigo_office_settings")
      .update({ business_type: type })
      .not("id", "is", null); // update all rows (should be 1)
  };

  return (
    <BusinessTypeContext.Provider value={{ businessType, setBusinessType, loading }}>
      {children}
    </BusinessTypeContext.Provider>
  );
}

export function useBusinessType() {
  return useContext(BusinessTypeContext);
}
