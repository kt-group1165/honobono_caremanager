// Server Component (page.tsx) と Client Component (claims-content.tsx) の両方から
// 安全に import できるよう、"use client" 指定の無い独立 module に切り出し。
// (Next.js 15 で "use client" file から関数/定数を Server Component に import すると
//  bundling 上 undefined になる場合があり、page.tsx で `getCurrentMonth()` を呼んだ
//  瞬間に `TypeError: getCurrentMonth is not a function` で 500 になるため。
//  memory: feedback_use_client_const_export.md / reports/[type]/report-config.ts と同じ pattern。)

import { format } from "date-fns";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validInMonth } from "@/lib/service-code-valid";

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
// 加算単位の法令定数 (両世代 R6.4/R8.6 とも同値。kaigo_service_codes 確認済 2026-07-08)
//   入院時情報連携: 436125 Ⅰ=250 / 436129 Ⅱ=200
//   退院・退所:     436132 Ⅰ１=450 / 436143 Ⅰ２=600 / 436144 Ⅱ１=600 /
//                   436145 Ⅱ２=750 / 436146 Ⅲ=900
// ─────────────────────────────────────────────────────────────────────────
export const HOSPITAL_COORD_UNITS: Record<HospitalCoordType, number> = {
  none: 0,
  i: 250,
  ii: 200,
};

export const DISCHARGE_UNITS: Record<DischargeType, number> = {
  none: 0,
  i_i: 450,
  i_ro: 600,
  ii_i: 600,
  ii_ro: 750,
  iii: 900,
};

// ─────────────────────────────────────────────────────────────────────────
// 居宅介護支援の基本サービスコード・特定事業所加算を kaigo_service_codes の
// 「対象月に有効な世代」(validInMonth) で解決する (kaigo_care_support_rates 全廃)。
//
// 実DB確認値 (2026-07-08 REST 確認):
//   R6 世代 (valid_from=2024-06-01, valid_until=2026-05-31) と
//   R8.6 世代 (valid_from=2026-06-01, valid_until=NULL) で同一コード・同一単位:
//     432111 居宅介護支援Ⅰⅰ１ 1086 単位 (要介護1・2)
//     432211 居宅介護支援Ⅰⅰ２ 1411 単位 (要介護3〜5)
//     434002 居宅支援特定事業所加算Ⅰ 519 / 434003 Ⅱ 421 / 434004 Ⅲ 323 /
//     434006 居宅支援特定事業所加算Ａ 114 / 434005 医療介護連携 125
//   ※ 旧 claims の 432301 は R8.6 マスタでは「居宅介護支援Ⅰⅰ１・虐防」(減算合成)、
//     432271 はマスタに存在しない。名称に「・」を含む行は地域区分/減算の合成コード。
// ─────────────────────────────────────────────────────────────────────────

export type CareLevelInfo = { units: number; code: string; name: string };

/** マスタ未登録月の最終フォールバック (上記 実DB確認値の静的コピー) */
export const KYOTAKU_BASE_FALLBACK: Record<string, CareLevelInfo> = {
  // 要支援は fetchYoboShienCodes (46 系) が本線。ここは最終安全網
  要支援1: { units: 472, code: "461112", name: "介護予防支援費Ⅱ (居宅介護支援事業所)" },
  要支援2: { units: 472, code: "461112", name: "介護予防支援費Ⅱ (居宅介護支援事業所)" },
  要介護1: { units: 1086, code: "432111", name: "居宅介護支援Ⅰⅰ１" },
  要介護2: { units: 1086, code: "432111", name: "居宅介護支援Ⅰⅰ１" },
  要介護3: { units: 1411, code: "432211", name: "居宅介護支援Ⅰⅰ２" },
  要介護4: { units: 1411, code: "432211", name: "居宅介護支援Ⅰⅰ２" },
  要介護5: { units: 1411, code: "432211", name: "居宅介護支援Ⅰⅰ２" },
};

export const TOKUTEI_KASSAN_FALLBACK: Record<string, number> = {
  none: 0,
  "Ⅰ": 519,
  "Ⅱ": 421,
  "Ⅲ": 323,
  A: 114,
  // 旧区分 (既存データ対応)
  B: 421,
  C: 323,
};

// ─────────────────────────────────────────────────────────────────────────
// 逓減制 (令和6年度〜): ケアマネ 1 人 (常勤換算) あたりの取扱件数で基本コードが段階変化
//   体制(Ⅰ) = 通常:            (ⅰ) 〜44件 / (ⅱ) 45〜59件 / (ⅲ) 60件〜
//   体制(Ⅱ) = ICT活用・事務職員配置等 (緩和要件):
//                               (ⅰ) 〜49件 / (ⅱ) 50〜59件 / (ⅲ) 60件〜
//   取扱件数 = (要介護の給付管理利用者数 + 要支援利用者数 × 1/3) ÷ 常勤換算数
//   (要支援 1/3 換算は R6.4 改定の取扱い。要支援自体は介護予防支援費で請求する
//    ため ⅱ/ⅲ コードの充当対象は要介護のみ)
//
// 実DB確認値 (2026-07-11 REST 確認。R6 世代 2024-06-01〜2026-05-31 と
// R8.6 世代 2026-06-01〜 で 12 コードとも同一コード・同一単位):
//   432111 Ⅰⅰ１ 1086 / 432211 Ⅰⅰ２ 1411
//   433111 Ⅰⅱ１  544 / 433211 Ⅰⅱ２  704
//   434111 Ⅰⅲ１  326 / 434211 Ⅰⅲ２  422
//   435011 Ⅱⅰ１ 1086 / 435211 Ⅱⅰ２ 1411
//   435311 Ⅱⅱ１  527 / 435411 Ⅱⅱ２  683
//   435511 Ⅱⅲ１  316 / 435611 Ⅱⅲ２  410
//   (１ = 要介護1・2 / ２ = 要介護3〜5)
// ─────────────────────────────────────────────────────────────────────────
export type TeigenTaisei = "Ⅰ" | "Ⅱ";
export type TeigenTier = "ⅰ" | "ⅱ" | "ⅲ";

export const TEIGEN_TAISEI_LIST: TeigenTaisei[] = ["Ⅰ", "Ⅱ"];
export const TEIGEN_TIER_LIST: TeigenTier[] = ["ⅰ", "ⅱ", "ⅲ"];

/** 要介護1・2 (=１) / 要介護3〜5 (=２) の基本コードペア */
export type TeigenPair = { light: CareLevelInfo; heavy: CareLevelInfo };

/** マスタ未登録月の最終フォールバック (上記 実DB確認値の静的コピー) */
export const KYOTAKU_TEIGEN_FALLBACK: Record<TeigenTaisei, Record<TeigenTier, TeigenPair>> = {
  "Ⅰ": {
    "ⅰ": {
      light: { units: 1086, code: "432111", name: "居宅介護支援Ⅰⅰ１" },
      heavy: { units: 1411, code: "432211", name: "居宅介護支援Ⅰⅰ２" },
    },
    "ⅱ": {
      light: { units: 544, code: "433111", name: "居宅介護支援Ⅰⅱ１" },
      heavy: { units: 704, code: "433211", name: "居宅介護支援Ⅰⅱ２" },
    },
    "ⅲ": {
      light: { units: 326, code: "434111", name: "居宅介護支援Ⅰⅲ１" },
      heavy: { units: 422, code: "434211", name: "居宅介護支援Ⅰⅲ２" },
    },
  },
  "Ⅱ": {
    "ⅰ": {
      light: { units: 1086, code: "435011", name: "居宅介護支援Ⅱⅰ１" },
      heavy: { units: 1411, code: "435211", name: "居宅介護支援Ⅱⅰ２" },
    },
    "ⅱ": {
      light: { units: 527, code: "435311", name: "居宅介護支援Ⅱⅱ１" },
      heavy: { units: 683, code: "435411", name: "居宅介護支援Ⅱⅱ２" },
    },
    "ⅲ": {
      light: { units: 316, code: "435511", name: "居宅介護支援Ⅱⅲ１" },
      heavy: { units: 410, code: "435611", name: "居宅介護支援Ⅱⅲ２" },
    },
  },
};

/**
 * 逓減制の tier 判定 (pure)。
 * @param cumCount その利用者までの累積取扱件数 (要支援 1/3 換算込み。1 始まり)
 * @param fte 介護支援専門員の常勤換算数
 * @param kanwa 緩和要件 (ICT活用・事務職員配置 = 体制(Ⅱ)) 該当か
 *
 * 「45件以上60件未満の部分」= 常勤換算 1 人あたり換算で 45件目〜59件目。
 * cumCount ÷ fte が 45 (緩和時 50) 以上で (ⅱ)、60 以上で (ⅲ)。
 */
export function teigenTierForIndex(
  cumCount: number,
  fte: number,
  kanwa: boolean,
): TeigenTier {
  if (fte <= 0) return "ⅰ";
  const per = cumCount / fte;
  const second = kanwa ? 50 : 45;
  if (per < second) return "ⅰ";
  if (per < 60) return "ⅱ";
  return "ⅲ";
}

/**
 * 逓減制 tier ごとの基本コードを要介護度から解決する。
 * 要介護 1〜5 以外 (要支援/申請中 等) は null。
 */
export function resolveTeigenBase(
  teigenBase: Record<TeigenTaisei, Record<TeigenTier, TeigenPair>>,
  taisei: TeigenTaisei,
  tier: TeigenTier,
  careLevel: string,
): CareLevelInfo | null {
  const pair = teigenBase[taisei]?.[tier];
  if (!pair) return null;
  if (careLevel === "要介護1" || careLevel === "要介護2") return pair.light;
  if (careLevel === "要介護3" || careLevel === "要介護4" || careLevel === "要介護5")
    return pair.heavy;
  return null;
}

/**
 * サービス名から逓減制 tier を判定する (請求画面の表示用)。
 * 「居宅介護支援Ⅰⅱ１」等の基本コード名にのみマッチ。それ以外は null。
 */
export function parseTeigenFromName(
  name: string | null | undefined,
): { taisei: TeigenTaisei; tier: TeigenTier } | null {
  const m = (name ?? "").match(/^居宅介護支援([ⅠⅡ])([ⅰⅱⅲ])/);
  if (!m) return null;
  return { taisei: m[1] as TeigenTaisei, tier: m[2] as TeigenTier };
}

/**
 * 事業所の逓減制設定。fte (常勤換算数) 未設定 or 列未適用 (migration
 * teigen_settings.sql) の場合は null → 従来動作 (警告のみ) にフォールバック。
 */
export type TeigenSettings = { fte: number; kanwa: boolean };

export async function fetchTeigenSettings(
  supabase: SupabaseClient,
  officeId: string,
): Promise<TeigenSettings | null> {
  const { data, error } = await supabase
    .from("offices")
    .select("caremane_jokin_kansan, teigen_kanwa")
    .eq("id", officeId)
    .maybeSingle();
  if (error) {
    // 列未適用 (42703 / PGRST204 等) は従来動作へフォールバック (握りつぶさず log)
    console.warn(
      "逓減制設定の取得に失敗 (migrations/teigen_settings.sql 未適用?)。従来どおり警告のみ:",
      error.message,
    );
    return null;
  }
  const row = data as { caremane_jokin_kansan?: number | string | null; teigen_kanwa?: boolean | null } | null;
  const fte = Number(row?.caremane_jokin_kansan ?? 0);
  if (!Number.isFinite(fte) || fte <= 0) return null;
  return { fte, kanwa: !!row?.teigen_kanwa };
}

export interface KyotakuMonthMaster {
  /** 要介護度 → 基本コード・単位 (対象月有効世代。逓減 (ⅰ) = 通常時) */
  byCareLevel: Record<string, CareLevelInfo>;
  /** 逓減制: 体制(Ⅰ)/(Ⅱ) × tier (ⅰ/ⅱ/ⅲ) → 基本コードペア (対象月有効世代) */
  teigenBase: Record<TeigenTaisei, Record<TeigenTier, TeigenPair>>;
  /** 特定事業所加算 区分 → 単位 (434002〜434006) */
  tokuteiUnits: Record<string, number>;
  /** 特定事業所医療介護連携加算 (434005) の単位 */
  medicalCoopUnits: number;
  /** マスタから解決できた (false = 全て静的フォールバック) */
  fromMaster: boolean;
}

// 逓減制の基本コード 12 名称 (体制Ⅰ/Ⅱ × tier ⅰ/ⅱ/ⅲ × 要介護度グループ１/２)
const KYOTAKU_TEIGEN_NAMES: string[] = TEIGEN_TAISEI_LIST.flatMap((t) =>
  TEIGEN_TIER_LIST.flatMap((tier) => [
    `居宅介護支援${t}${tier}１`,
    `居宅介護支援${t}${tier}２`,
  ]),
);

const KYOTAKU_MASTER_NAMES = [
  ...KYOTAKU_TEIGEN_NAMES,
  "居宅支援特定事業所加算Ⅰ",
  "居宅支援特定事業所加算Ⅱ",
  "居宅支援特定事業所加算Ⅲ",
  "居宅支援特定事業所加算Ａ",
  "居宅支援特定事業所医療介護連携加算",
];

/**
 * 対象月 (billingMonth = 'YYYY-MM') に有効な 居宅介護支援の基本コード +
 * 特定事業所加算単位を kaigo_service_codes から解決する。
 * error は throw (呼出側で toast)。
 */
export async function fetchKyotakuMasterForMonth(
  supabase: SupabaseClient,
  billingMonth: string,
): Promise<KyotakuMonthMaster> {
  const [y, m] = billingMonth.split("-").map(Number);
  const { data, error } = await validInMonth(
    supabase
      .from("kaigo_service_codes")
      .select("service_code, service_name, units, valid_from")
      .eq("system", "介護")
      .eq("service_category", "43")
      .in("service_name", KYOTAKU_MASTER_NAMES),
    y,
    m,
  );
  if (error) throw new Error(`居宅介護支援コードの取得に失敗: ${error.message}`);
  type Row = { service_code: string; service_name: string; units: number; valid_from: string | null };
  // 同名複数世代がヒットした場合は valid_from 最新を採用
  const byName = new Map<string, Row>();
  for (const r of (data ?? []) as Row[]) {
    const prev = byName.get(r.service_name);
    if (!prev || (r.valid_from ?? "") > (prev.valid_from ?? "")) byName.set(r.service_name, r);
  }
  const pick = (name: string): CareLevelInfo | null => {
    const r = byName.get(name);
    return r ? { units: r.units, code: r.service_code, name: r.service_name } : null;
  };

  const i1 = pick("居宅介護支援Ⅰⅰ１");
  const i2 = pick("居宅介護支援Ⅰⅰ２");
  const byCareLevel: Record<string, CareLevelInfo> = { ...KYOTAKU_BASE_FALLBACK };
  if (i1) {
    byCareLevel["要介護1"] = i1;
    byCareLevel["要介護2"] = i1;
  }
  if (i2) {
    byCareLevel["要介護3"] = i2;
    byCareLevel["要介護4"] = i2;
    byCareLevel["要介護5"] = i2;
  }

  // 逓減制 12 コード (体制Ⅰ/Ⅱ × ⅰ/ⅱ/ⅲ × １/２)。マスタ優先・静的フォールバック
  const teigenBase: Record<TeigenTaisei, Record<TeigenTier, TeigenPair>> = {
    "Ⅰ": { "ⅰ": { ...KYOTAKU_TEIGEN_FALLBACK["Ⅰ"]["ⅰ"] }, "ⅱ": { ...KYOTAKU_TEIGEN_FALLBACK["Ⅰ"]["ⅱ"] }, "ⅲ": { ...KYOTAKU_TEIGEN_FALLBACK["Ⅰ"]["ⅲ"] } },
    "Ⅱ": { "ⅰ": { ...KYOTAKU_TEIGEN_FALLBACK["Ⅱ"]["ⅰ"] }, "ⅱ": { ...KYOTAKU_TEIGEN_FALLBACK["Ⅱ"]["ⅱ"] }, "ⅲ": { ...KYOTAKU_TEIGEN_FALLBACK["Ⅱ"]["ⅲ"] } },
  };
  for (const taisei of TEIGEN_TAISEI_LIST) {
    for (const tier of TEIGEN_TIER_LIST) {
      const light = pick(`居宅介護支援${taisei}${tier}１`);
      const heavy = pick(`居宅介護支援${taisei}${tier}２`);
      if (light) teigenBase[taisei][tier] = { ...teigenBase[taisei][tier], light };
      if (heavy) teigenBase[taisei][tier] = { ...teigenBase[taisei][tier], heavy };
    }
  }

  const tokuteiUnits: Record<string, number> = { ...TOKUTEI_KASSAN_FALLBACK };
  const tkMap: [string, string][] = [
    ["Ⅰ", "居宅支援特定事業所加算Ⅰ"],
    ["Ⅱ", "居宅支援特定事業所加算Ⅱ"],
    ["Ⅲ", "居宅支援特定事業所加算Ⅲ"],
    ["A", "居宅支援特定事業所加算Ａ"],
  ];
  for (const [kt, name] of tkMap) {
    const r = byName.get(name);
    if (r) tokuteiUnits[kt] = r.units;
  }
  const mc = byName.get("居宅支援特定事業所医療介護連携加算");

  return {
    byCareLevel,
    teigenBase,
    tokuteiUnits,
    medicalCoopUnits: mc?.units ?? 125,
    fromMaster: byName.size > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 減算の端数処理 (公式合成コードと一致する round 方式)
//   減算後単位 = round(所定 × (100 − pct) / 100) / 減算量 = 所定 − 減算後単位
//   実DB確認: 432325 Ⅰⅰ２・虐防 = 1397 = round(1411×0.99) (floor だと 1396) /
//             432473 Ⅰⅰ２・虐防・業未 = 1383 = 1411 − 14 − 14 (減算は各々独立に計算し加算)
//   運営基準減算 (50%): 432229 Ⅰⅰ２・運 = 706 = round(1411×0.5)
// ─────────────────────────────────────────────────────────────────────────
/**
 * 居宅介護支援の 総単位数 / 金額 を組み立てる唯一の関数。
 *
 * 処遇改善加算 = (居宅介護支援費 + 各種加算 − 減算) の総単位数 × 率 (round)。
 *   ほのぼの実伝送(436191)で round(subtotal × 0.021) と一致確認済。
 *
 * ⚠ 2026-08-31 監査:
 *   請求個人設定タブ (_kojin-settei.tsx) がこの関数を通さず
 *   `c.units + addUnits - reductionUnits` で total を組んでいたため、
 *   加算を 1 つ ON にすると処遇改善が再計算されず DB / 正解 / 伝送 の
 *   3 者が食い違っていた。**金額を作る箇所は必ずここを通すこと。**
 */
export function calcTotals(
  baseUnits: number,
  addUnits: number,
  reductionUnits: number,
  unitPrice: number,
  shoguuPermil = 0, // 居宅介護支援 処遇改善加算 率 (‰。21 = 2.1%)。0 = 無し
): { total_units: number; total_amount: number; insurance_amount: number; shoguu_units: number } {
  const subtotal = baseUnits + addUnits - reductionUnits;
  const shoguu_units = shoguuPermil > 0 ? Math.round((subtotal * shoguuPermil) / 1000) : 0;
  const total_units = subtotal + shoguu_units;
  const total_amount = Math.floor(total_units * unitPrice);
  return { total_units, total_amount, insurance_amount: total_amount, shoguu_units };
}

export function reductionUnitsOf(baseUnits: number, pct: number): number {
  if (pct <= 0) return 0;
  return baseUnits - Math.round((baseUnits * (100 - pct)) / 100);
}

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
  care_support_code: string | null;
  care_support_name: string | null;
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
  shoguu_kaizen_units?: number;
  shoguu_kaizen_code?: string | null;
  discharge_type: DischargeType | null;
  terminal_care: boolean;
  terminal_care_units: number;
  emergency_conference: boolean;
  emergency_conference_units: number;
  bcp_not_prepared: boolean;
  bcp_reduction_pct: number;
  abuse_prevention_not_implemented: boolean;
  abuse_reduction_pct: number;
  /** 運営基準減算 (50%)。migration kyotaku_billing_kojin_settei.sql 適用前は undefined */
  unei_kijun_gensan?: boolean | null;
  unei_kijun_gensan_units?: number | null;
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
  care_support_shoguu_code?: string | null;
  care_support_shoguu_permil?: number | null;
} | null;

export function getCurrentMonth(): string {
  return format(new Date(), "yyyy-MM");
}
