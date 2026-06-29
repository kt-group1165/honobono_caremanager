// Server Component (page.tsx) と Client Component (claims-content.tsx) の両方から
// 安全に import できるよう、"use client" 指定の無い独立 module に切り出し。
// (Next.js 15 で "use client" file から関数/定数を Server Component に import すると
//  bundling 上 undefined になる場合があり、page.tsx で `getCurrentMonth()` を呼んだ
//  瞬間に `TypeError: getCurrentMonth is not a function` で 500 になるため。
//  memory: feedback_use_client_const_export.md / reports/[type]/report-config.ts と同じ pattern。)

import { format } from "date-fns";

export type TokuteiKassanType = "none" | "Ⅰ" | "Ⅱ" | "Ⅲ" | "A";
export type HospitalCoordType = "none" | "i" | "ii";
export type DischargeType = "none" | "i_i" | "i_ro" | "ii_i" | "ii_ro" | "iii";
export type ClaimStatus = "draft" | "confirmed" | "submitted";

export interface ClaimRow {
  id: string;
  user_id: string;
  billing_month: string;
  care_support_code: string;
  care_support_name: string;
  units: number;
  unit_price: number;
  total_amount: number;
  insurance_amount: number;
  // existing addition columns
  initial_addition: boolean;
  initial_addition_units: number;
  hospital_coordination: boolean;
  hospital_coordination_units: number;
  discharge_addition: boolean;
  discharge_addition_units: number;
  medical_coordination: boolean;
  medical_coordination_units: number;
  // new columns (migration 008)
  tokutei_kassan_type: TokuteiKassanType | null;
  tokutei_kassan_units: number;
  medical_coop_kassan: boolean;
  medical_coop_kassan_units: number;
  discharge_type: DischargeType | null;
  terminal_care: boolean;
  terminal_care_units: number;
  emergency_conference: boolean;
  emergency_conference_units: number;
  bcp_not_prepared: boolean;
  bcp_reduction_pct: number;
  abuse_prevention_not_implemented: boolean;
  abuse_reduction_pct: number;
  status: ClaimStatus;
  notes: string | null;
  // Phase 2-3-8 で kaigo_users から clients に張替え。
  clients?: {
    name: string;
    name_kana?: string | null;
    gender?: string | null;
    phone?: string | null;
    mobile_phone?: string | null;
  };
}

export type CertMapEntry = {
  care_level: string;
  insurer_number: string | null;
  insured_number: string | null;
  start_date: string | null;
  end_date: string | null;
};

export type ClaimsOfficeInfo = {
  tokutei_kassan_type: string | null;
  medical_cooperation_kassan: boolean;
  area_category: string | null;
  unit_price: number;
  provider_number: string | null;
} | null;

export function getCurrentMonth(): string {
  return format(new Date(), "yyyy-MM");
}
