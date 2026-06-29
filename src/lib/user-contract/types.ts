/**
 * 重要事項説明書 / 契約書 管理 (= 居宅・訪問介護 両版共通) — 型定義
 *
 * 設計方針:
 *  - 利用者は共有マスタ clients を参照 (user_id)
 *  - content (JSONB) は section ごとの自由構造 (= 重要事項説明書 / 契約書 で内容違うため schema-less)
 *  - status は 'draft' / 'issued' / 'archived'
 *  - "use client" boundary を跨いで安全に import するため、ここは純粋な型 + 定数のみ
 *    (= memory: feedback_use_client_const_export.md)
 */

export const CONTRACT_TYPES = [
  "重要事項説明書",
  "契約書",
  "個人情報同意書",
  "その他",
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_STATUSES = ["draft", "issued", "archived"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: "下書き",
  issued: "交付済",
  archived: "保管 (旧版)",
};

export const CONTRACT_STATUS_COLORS: Record<
  ContractStatus,
  { bg: string; text: string; border: string }
> = {
  draft: { bg: "bg-gray-100", text: "text-gray-700", border: "border-gray-200" },
  issued: { bg: "bg-blue-100", text: "text-blue-700", border: "border-blue-200" },
  archived: { bg: "bg-amber-100", text: "text-amber-700", border: "border-amber-200" },
};

export const CONTRACT_TYPE_COLORS: Record<
  ContractType,
  { bg: string; text: string; border: string }
> = {
  重要事項説明書: { bg: "bg-indigo-100", text: "text-indigo-700", border: "border-indigo-200" },
  契約書: { bg: "bg-emerald-100", text: "text-emerald-700", border: "border-emerald-200" },
  個人情報同意書: { bg: "bg-purple-100", text: "text-purple-700", border: "border-purple-200" },
  その他: { bg: "bg-gray-100", text: "text-gray-600", border: "border-gray-200" },
};

/**
 * 業務種別 (= business_type の選択肢)
 * NULL 許容で free text にもなり得るが、UI では select で出す。
 */
export const BUSINESS_TYPES = [
  "居宅介護支援",
  "訪問介護",
  "通所介護",
  "福祉用具",
  "その他",
] as const;
export type BusinessTypeLabel = (typeof BUSINESS_TYPES)[number];

/**
 * 契約書 content (JSONB) の取り扱える section keys (= UI form の整形用)
 *
 * 重要事項説明書 sections:
 *   company_name / company_address / company_phone / company_fax / representative
 *   service_types / operating_days / operating_hours
 *   fee_structure / payment_method / cancel_policy
 *   complaint_contact / complaint_phone / external_complaint_contact
 *   emergency_response
 *   privacy_handling
 *
 * 契約書 sections:
 *   contract_period_text / service_scope
 *   fee_text / payment_terms
 *   termination_conditions / damages_clause
 *   complaint_handling / confidentiality
 *
 * いずれも optional + 文字列フィールド。content は最終的に Record<string, string> 想定だが、
 * 将来拡張のため JSONB として保存する。
 */
export type UserContractContent = Record<string, string | undefined> & {
  _sample_marker?: string;
};

export interface UserContract {
  id: string;
  tenant_id: string;
  user_id: string;
  office_id: string | null;
  contract_type: ContractType;
  business_type: string | null;
  issued_date: string; // YYYY-MM-DD
  effective_from: string | null;
  effective_until: string | null;
  signed_at: string | null;
  signed_by_name: string | null;
  signed_by_relation: string | null;
  content: UserContractContent;
  attachment_url: string | null;
  status: ContractStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/** INSERT / UPDATE 共用 (= id は UPDATE 時のみ必須、その他は省略可) */
export type UserContractInput = Omit<
  UserContract,
  "id" | "created_at" | "updated_at" | "created_by"
> & {
  id?: string;
};

/**
 * 重要事項説明書 / 契約書 の section 定義 (= UI form の section 順)
 *
 * key は content (JSONB) の field name と一致。
 * 入力欄の type: 'text' (1 行) / 'textarea' (複数行)
 */
export interface ContractSection {
  key: string;
  label: string;
  type: "text" | "textarea";
  placeholder?: string;
}

export const JUUYOU_JIKOU_SECTIONS: ContractSection[] = [
  { key: "company_name", label: "事業者の名称", type: "text", placeholder: "例: 株式会社KTグループ" },
  { key: "company_address", label: "所在地", type: "text", placeholder: "例: 千葉県千葉市..." },
  { key: "company_phone", label: "電話番号", type: "text", placeholder: "例: 043-000-0000" },
  { key: "company_fax", label: "FAX 番号", type: "text" },
  { key: "representative", label: "代表者", type: "text", placeholder: "代表取締役 ..." },
  { key: "service_types", label: "提供サービスの種類と内容", type: "textarea", placeholder: "例: 居宅介護支援、訪問介護" },
  { key: "operating_days", label: "営業日", type: "text", placeholder: "例: 月〜金 (祝日除く)" },
  { key: "operating_hours", label: "営業時間", type: "text", placeholder: "例: 9:00 - 18:00" },
  { key: "fee_structure", label: "利用料", type: "textarea", placeholder: "介護保険適用 / 自費料金 など" },
  { key: "payment_method", label: "支払方法", type: "textarea", placeholder: "口座振替 / 振込 等" },
  { key: "cancel_policy", label: "キャンセル料", type: "textarea" },
  { key: "complaint_contact", label: "苦情対応窓口 (担当者)", type: "text" },
  { key: "complaint_phone", label: "苦情受付 電話番号", type: "text" },
  { key: "external_complaint_contact", label: "外部苦情窓口 (市町村 / 国保連 等)", type: "textarea" },
  { key: "emergency_response", label: "緊急時の対応", type: "textarea" },
  { key: "privacy_handling", label: "個人情報の取扱", type: "textarea" },
];

export const KEIYAKUSHO_SECTIONS: ContractSection[] = [
  { key: "contract_period_text", label: "契約期間", type: "textarea", placeholder: "例: 契約日から1年間、以後自動更新" },
  { key: "service_scope", label: "サービス内容", type: "textarea" },
  { key: "fee_text", label: "利用料", type: "textarea" },
  { key: "payment_terms", label: "支払方法・時期", type: "textarea" },
  { key: "termination_conditions", label: "契約解除条件", type: "textarea" },
  { key: "damages_clause", label: "損害賠償", type: "textarea" },
  { key: "complaint_handling", label: "苦情処理", type: "textarea" },
  { key: "confidentiality", label: "秘密保持", type: "textarea" },
];

export const KOJIN_JOUHOU_SECTIONS: ContractSection[] = [
  { key: "purpose", label: "利用目的", type: "textarea", placeholder: "サービス提供・関係機関連携 など" },
  { key: "shared_with", label: "提供先", type: "textarea", placeholder: "主治医・サービス担当者会議 メンバー 等" },
  { key: "shared_items", label: "提供する情報の項目", type: "textarea" },
  { key: "consent_period", label: "同意の有効期間", type: "text" },
];

export const OTHER_SECTIONS: ContractSection[] = [
  { key: "summary", label: "概要", type: "textarea" },
  { key: "body", label: "本文", type: "textarea" },
];

/**
 * contract_type → section 定義配列を返す helper
 */
export function getSectionsForType(type: ContractType): ContractSection[] {
  switch (type) {
    case "重要事項説明書":
      return JUUYOU_JIKOU_SECTIONS;
    case "契約書":
      return KEIYAKUSHO_SECTIONS;
    case "個人情報同意書":
      return KOJIN_JOUHOU_SECTIONS;
    case "その他":
      return OTHER_SECTIONS;
    default:
      return [];
  }
}

/**
 * 空の contract input を返す (= 新規作成 form 初期値)
 */
export function emptyContractInput(params: {
  tenantId: string;
  userId: string;
  officeId: string | null;
  contractType?: ContractType;
  businessType?: string | null;
}): UserContractInput {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  return {
    tenant_id: params.tenantId,
    user_id: params.userId,
    office_id: params.officeId,
    contract_type: params.contractType ?? "重要事項説明書",
    business_type: params.businessType ?? null,
    issued_date: `${yyyy}-${mm}-${dd}`,
    effective_from: `${yyyy}-${mm}-${dd}`,
    effective_until: null,
    signed_at: null,
    signed_by_name: null,
    signed_by_relation: "本人",
    content: {},
    attachment_url: null,
    status: "draft",
    notes: null,
  };
}
