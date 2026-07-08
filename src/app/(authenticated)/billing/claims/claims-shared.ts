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

// ─────────────────────────────────────────────────────────────────────────
// 地域区分 → 単位数単価 (= 法令の地域区分別単価表 / 居宅介護支援は全国一律 table)
// 出典: 介護報酬告示・地域区分別の単位数単価。
// offices.area_category は "1級地"〜"7級地" / "その他" の文字列で保持される。
// (master/office で UI 上の選択肢として表示済み)
// ─────────────────────────────────────────────────────────────────────────
export const AREA_UNIT_PRICE_TABLE: Record<string, number> = {
  "1級地": 11.40,
  "2級地": 11.12,
  "3級地": 11.05,
  "4級地": 10.84,
  "5級地": 10.70,
  "6級地": 10.42,
  "7級地": 10.21,
  "その他": 10.00,
};

/**
 * area_category 文字列 → 単位数単価。
 * 未知 / null は "その他" (= 10.00 円) にフォールバック。
 */
export function getUnitPriceByArea(area: string | null | undefined): number {
  if (!area) return AREA_UNIT_PRICE_TABLE["その他"];
  return AREA_UNIT_PRICE_TABLE[area] ?? AREA_UNIT_PRICE_TABLE["その他"];
}

// ─────────────────────────────────────────────────────────────────────────
// 加算コード → 法令単位数 (= /addons table に addon_unit が NULL のときの fallback)
// 居宅介護支援費の加算単位は介護報酬告示で決まっている。
// 特定事業所加算は kaigo_tokutei_kassan_rates (= fy 別) を優先するため
// ここでは含めない。
// TODO: 改定 (= 約 2 年ごと) で単位数が変わる可能性あり。
//   kaigo_billing_addons.addon_unit に明示入力するか、
//   将来は法令単位もテーブル化することを推奨。
// ─────────────────────────────────────────────────────────────────────────
export const KYOTAKU_ADDON_LAW_UNITS: Record<string, number> = {
  // 入院時情報連携加算
  "入院時情報連携加算Ⅰ": 250,
  "入院時情報連携加算Ⅱ": 200,
  // 退院・退所加算
  "退院・退所加算Ⅰイ": 450,
  "退院・退所加算Ⅰロ": 600,
  "退院・退所加算Ⅱイ": 600,
  "退院・退所加算Ⅱロ": 750,
  "退院・退所加算Ⅲ": 900,
  // 医療連携加算 (= 通院時情報連携加算)
  "医療連携加算": 50,
  // ターミナルケアマネジメント加算
  "ターミナルケアマネジメント加算": 400,
  // 緊急時等居宅カンファレンス加算
  "緊急時等居宅カンファレンス加算": 200,
  // 特定事業所医療介護連携加算 (= 加算コード自体は別だが、念のため)
  "特定事業所医療介護連携加算": 125,
  // 初回加算
  "初回加算": 300,
};

/**
 * 加算コード → 退院・退所加算の discharge_type 値 (= kaigo_care_support_claims の列値)
 */
export const ADDON_CODE_TO_DISCHARGE_TYPE: Record<string, DischargeType> = {
  "退院・退所加算Ⅰイ": "i_i",
  "退院・退所加算Ⅰロ": "i_ro",
  "退院・退所加算Ⅱイ": "ii_i",
  "退院・退所加算Ⅱロ": "ii_ro",
  "退院・退所加算Ⅲ": "iii",
};

/**
 * 加算コード → 入院時情報連携加算の hospital_coordination_units (= 列値)
 */
export const ADDON_CODE_TO_HOSPITAL_TYPE: Record<string, HospitalCoordType> = {
  "入院時情報連携加算Ⅰ": "i",
  "入院時情報連携加算Ⅱ": "ii",
};

/**
 * 加算コード → kaigo_care_support_claims の特定事業所加算 type (= 列値)
 */
export const ADDON_CODE_TO_TOKUTEI: Record<string, TokuteiKassanType> = {
  "特定事業所加算Ⅰ": "Ⅰ",
  "特定事業所加算Ⅱ": "Ⅱ",
  "特定事業所加算Ⅲ": "Ⅲ",
  "特定事業所加算A": "A",
};

/**
 * その月に有効な addon かどうか判定する pure helper。
 *   - status='active'
 *   - applied_from <= 月末日
 *   - expires_at IS NULL OR expires_at >= 月初日
 */
export function isAddonActiveInMonth(
  addon: { status: string; applied_from: string; expires_at: string | null },
  billingMonth: string, // YYYY-MM
): boolean {
  if (addon.status !== "active") return false;
  const [y, m] = billingMonth.split("-").map(Number);
  // 月末は翌月 0 日で計算
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0);
  const appliedFrom = new Date(addon.applied_from + "T00:00:00");
  if (appliedFrom > monthEnd) return false;
  if (addon.expires_at) {
    const expiresAt = new Date(addon.expires_at + "T00:00:00");
    if (expiresAt < monthStart) return false;
  }
  return true;
}

// 自動算定 marker (= 後で手動修正できるよう notes に印を付ける)
export const AUTO_ADDON_NOTES_MARKER = "[自動算定]";

// ─────────────────────────────────────────────────────────────────────────
// 介護予防支援 (要支援1/2) の請求区分
//   I     = 介護予防支援費(Ⅰ) — 地域包括支援センターとして請求
//   II    = 介護予防支援費(Ⅱ) — 居宅介護支援事業者の直接指定 (既定)
//   itaku = 包括からの委託 — 地域包括支援センター側が請求するため請求対象外
// 選択は kaigo_care_support_claims.notes のマーカーで永続化する
// (専用列は増やさない。一括生成時は当月以前の最新マーカーを引き継ぐ)。
// ─────────────────────────────────────────────────────────────────────────
export type YoboShienKubun = "I" | "II" | "itaku";

export const YOBO_SHIEN_MARKER: Record<YoboShienKubun, string> = {
  I: "[予防支援:Ⅰ]",
  II: "[予防支援:Ⅱ]",
  itaku: "[予防支援:委託]",
};

/** notes からマーカーを読んで区分を返す (無ければ null) */
export function parseYoboShienKubun(
  notes: string | null | undefined,
): YoboShienKubun | null {
  if (!notes) return null;
  if (notes.includes(YOBO_SHIEN_MARKER.itaku)) return "itaku";
  if (notes.includes(YOBO_SHIEN_MARKER.I)) return "I";
  if (notes.includes(YOBO_SHIEN_MARKER.II)) return "II";
  return null;
}

/** notes の既存マーカーを除去して新しい区分マーカーを付け直す */
export function setYoboShienMarker(
  notes: string | null | undefined,
  kubun: YoboShienKubun,
): string {
  const stripped = (notes ?? "")
    .replace(/\[予防支援:[^\]]*\]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const marker = YOBO_SHIEN_MARKER[kubun];
  return stripped ? `${stripped}\n${marker}` : marker;
}

/** 要支援1/2 (= 介護予防支援の対象) か */
export function isYoboShienLevel(level: string | null | undefined): boolean {
  return level === "要支援1" || level === "要支援2";
}

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
