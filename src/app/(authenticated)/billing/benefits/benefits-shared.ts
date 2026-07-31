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
  /** サービス種類コード (2桁)。給付管理票 8222 項19。無い旧データは null */
  service_kind_code?: string | null;
  provider_name: string | null;
  provider_number?: string | null;
  /** 給付管理する単位数 (= 保険給付の対象。限度額超過分を削った後の値) */
  planned_units: number;
  /** 実績の単位数 (削る前) */
  actual_units: number;
  /** 全額自己負担にした単位数 (= actual - planned) */
  over_limit_units: number;
  status: "draft" | "confirmed" | "submitted";
  created_at: string;
  updated_at: string;
}

/**
 * 限度額超過分を自己負担へ回すときの既定の優先順 (サービス種類コード)。
 * 実データ 36 件の削られ方を集計した傾向 (福祉用具 12件 / 短期入所 6件 /
 * 通所系 10件 …) に基づく **提案値**。最終的にどのサービスを自己負担にするかは
 * 利用者との相談事項なので、画面上で自由に変更できるようにしてある。
 */
export const OVER_LIMIT_CUT_PRIORITY: string[] = [
  "17", // 福祉用具貸与
  "78", // 地域密着型通所介護
  "15", // 通所介護
  "16", // 通所リハビリテーション
  "21", // 短期入所生活介護
  "22", // 短期入所療養介護
  "14", // 居宅療養管理指導
  "13", // 訪問看護
  "12", // 訪問入浴介護
  "11", // 訪問介護
];

/**
 * 超過分を優先順に沿って各行へ割り当てる。
 * 返り値 = 行 id → 削る単位数 (= 自己負担にする分)。
 * 優先順の後ろにある行から順に満額まで削り、超過分を消化しきったら終了。
 */
export function suggestOverLimitCuts(
  rows: { id: string; service_kind_code?: string | null; actual_units: number }[],
  overUnits: number,
): Record<string, number> {
  const cuts: Record<string, number> = {};
  if (overUnits <= 0) return cuts;
  const rank = (r: { service_kind_code?: string | null }) => {
    const i = OVER_LIMIT_CUT_PRIORITY.indexOf((r.service_kind_code ?? "").trim());
    return i < 0 ? OVER_LIMIT_CUT_PRIORITY.length : i;
  };
  // 優先順が先のものから削る。同順位は単位数の小さい行から (端数を吸収しやすい)
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b) || a.actual_units - b.actual_units);
  let rest = overUnits;
  for (const r of sorted) {
    if (rest <= 0) break;
    const cut = Math.min(rest, Math.max(0, r.actual_units));
    if (cut > 0) { cuts[r.id] = cut; rest -= cut; }
  }
  return cuts;
}

export interface UserWithCert {
  id: string;
  name: string;
  certification: CareCertification | null;
}

export function getCurrentMonth(): string {
  return format(new Date(), "yyyy-MM");
}
