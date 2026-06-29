/**
 * 加算管理機能の型定義 (2026-06-29 確定)
 *
 * 介護保険における各種加算 (= 特定事業所加算、緊急時訪問加算、初回加算、
 * 医療連携加算、入院時連携加算 etc.) を office ごとに登録 / 管理 / 算定根拠記録。
 *
 * 法令: 介護報酬告示の加算規程。
 *
 * 仕様:
 *  - office ごとに登録 (= office_id)
 *  - business_type ('居宅介護支援' or '訪問介護') ごとに加算コード dropdown を切り替え
 *  - 加算コードは enum (= ハードコード)。後で追加可
 *  - status: active / expired / pending
 *  - applied_from: 算定開始日 (NOT NULL)
 *  - expires_at: 算定終了日 (= 届出更新前、任意)
 *  - notification_filed_at: 届出受理日
 *  - basis_documents: 算定根拠 (= テキスト or PDF link、textarea)
 *  - UNIQUE (office_id, addon_code, applied_from)
 *  - hard delete
 */

/** kaigo-app 上の業種 (= 加算 dropdown 切替軸) */
export type AddonBusinessType = "居宅介護支援" | "訪問介護";

/** 加算ステータス */
export const ADDON_STATUSES = ["active", "expired", "pending"] as const;
export type AddonStatus = (typeof ADDON_STATUSES)[number];

export const ADDON_STATUS_LABELS: Record<AddonStatus, string> = {
  active: "算定中",
  expired: "終了",
  pending: "届出準備中",
};

/**
 * 居宅介護支援の加算コード一覧
 * (= 介護報酬告示 - 居宅介護支援費)
 */
export const KYOTAKU_ADDON_CODES = [
  "特定事業所加算Ⅰ",
  "特定事業所加算Ⅱ",
  "特定事業所加算Ⅲ",
  "特定事業所加算A",
  "入院時情報連携加算Ⅰ",
  "入院時情報連携加算Ⅱ",
  "退院・退所加算Ⅰイ",
  "退院・退所加算Ⅰロ",
  "退院・退所加算Ⅱイ",
  "退院・退所加算Ⅱロ",
  "退院・退所加算Ⅲ",
  "医療連携加算",
  "ターミナルケアマネジメント加算",
  "緊急時等居宅カンファレンス加算",
] as const;

/**
 * 訪問介護の加算コード一覧
 * (= 介護報酬告示 - 訪問介護費)
 */
export const HOUMON_ADDON_CODES = [
  "特定事業所加算Ⅰ",
  "特定事業所加算Ⅱ",
  "特定事業所加算Ⅲ",
  "特定事業所加算Ⅳ",
  "特定事業所加算Ⅴ",
  "緊急時訪問介護加算",
  "初回加算",
  "生活機能向上連携加算Ⅰ",
  "生活機能向上連携加算Ⅱ",
  "介護職員等処遇改善加算Ⅰ",
  "介護職員等処遇改善加算Ⅱ",
  "介護職員等処遇改善加算Ⅲ",
  "介護職員等処遇改善加算Ⅳ",
  "中山間地域等提供加算",
  "同一建物減算",
] as const;

export type KyotakuAddonCode = (typeof KYOTAKU_ADDON_CODES)[number];
export type HoumonAddonCode = (typeof HOUMON_ADDON_CODES)[number];
/** 加算コード (= 居宅 + 訪問 を合算した union) */
export type AddonCode = KyotakuAddonCode | HoumonAddonCode;

/**
 * business_type → 加算コード配列 の lookup。
 * UI 側で dropdown を切り替えるための master。
 *
 * 注: union 型として共通要素 (= 特定事業所加算Ⅰ など) がある点に注意。
 * UI 側でこの table を参照すれば自然と分岐できる。
 */
export const ADDON_CODES_BY_BUSINESS_TYPE: Record<AddonBusinessType, readonly string[]> = {
  "居宅介護支援": KYOTAKU_ADDON_CODES,
  "訪問介護": HOUMON_ADDON_CODES,
};

/**
 * 加算 row (DB と 1:1)
 *
 * UNIQUE (office_id, addon_code, applied_from)
 */
export interface BillingAddon {
  id: string;
  tenant_id: string;
  office_id: string;
  business_type: AddonBusinessType;
  addon_code: string;
  addon_unit: number | null;
  status: AddonStatus;
  applied_from: string;             // YYYY-MM-DD
  expires_at: string | null;        // YYYY-MM-DD
  notification_filed_at: string | null; // YYYY-MM-DD
  basis_documents: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/** 新規 INSERT 用 payload (= id / created_at / updated_at 等は DB が埋める) */
export interface BillingAddonInsert {
  tenant_id: string;
  office_id: string;
  business_type: AddonBusinessType;
  addon_code: string;
  addon_unit: number | null;
  status: AddonStatus;
  applied_from: string;
  expires_at: string | null;
  notification_filed_at: string | null;
  basis_documents: string | null;
  notes: string | null;
  created_by?: string | null;
}

/** 部分更新 payload */
export type BillingAddonUpdate = Partial<
  Pick<
    BillingAddon,
    | "addon_code"
    | "addon_unit"
    | "status"
    | "applied_from"
    | "expires_at"
    | "notification_filed_at"
    | "basis_documents"
    | "notes"
  >
>;
