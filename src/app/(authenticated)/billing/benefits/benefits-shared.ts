// "use client" 越境 import 回避用 (= memory feedback_use_client_const_export)
// page.tsx (Server Component) から import する type / helper を独立 module に分離。
// benefits-content.tsx は "use client" file なので、ここから type / 関数を re-export する。
import { format } from "date-fns";

// 共通マスタ client_insurance_records の subset
export interface CareCertification {
  id: string;
  client_id: string;
  insured_number: string;
  care_level: string;
  service_limit_amount: number;
  insurer_number?: string;
}

export interface BenefitManagementRow {
  id: string;
  user_id: string;
  billing_month: string;
  service_type: string;
  provider_name: string | null;
  planned_units: number;
  actual_units: number;
  over_limit_units: number;
  status: "draft" | "confirmed" | "submitted";
  created_at: string;
  updated_at: string;
}

export interface UserWithCert {
  id: string;
  name: string;
  certification: CareCertification | null;
}

export function getCurrentMonth(): string {
  return format(new Date(), "yyyy-MM");
}
