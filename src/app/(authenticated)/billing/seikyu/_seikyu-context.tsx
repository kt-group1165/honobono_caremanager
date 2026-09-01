"use client";

/**
 * 居宅介護支援 請求画面 (月次情報 / 介護請求 / 国保請求 / 入金管理) の共通 Context。
 *
 * 訪問介護版 billing-visit/_shared/seikyu-context.tsx と同じ構成:
 *   - Provider で月 state + 月次レセプト集計 (kaigo_care_support_claims) を 1 回だけ fetch し
 *     全タブで共有する
 *   - order-app 流の「あかさたな索引」カナフィルタも Context で持つ
 *   - SeikyuKanaSidebar / SeikyuMonthNav も同一クラスで提供
 *
 * 居宅は実績集計 (visit-seikyu/aggregate) ではなく、/billing/claims で生成済みの
 * レセプト (kaigo_care_support_claims) が請求の元データになる。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { resolveKohiForMonth } from "@/lib/kohi";
import {
  resolveCertsForMonthBoth,
  detectMidMonthChange,
  type MidMonthCertChange,
} from "@/lib/cert-for-month";
import { mapChunksParallel, ID_IN_CHUNK } from "@/lib/chunk-parallel";
import {
  getUnitPriceByArea,
  parseYoboShienKubun,
  reductionUnitsOf,
  type ClaimStatus,
  type YoboShienKubun,
} from "../claims/claims-shared";

// ─────────────────────────────────────────────────────────────────────────────
// 型
// ─────────────────────────────────────────────────────────────────────────────

/** 明細 1 行 (基本サービス + 加算 + 減算) */
export interface KyotakuMeisaiLine {
  name: string;
  code: string;
  units: number;
  count: number;
}

/** 一覧の 1 行 = 利用者 × 月のレセプト */
export interface KyotakuSeikyuRow {
  user_id: string;
  user_name: string;
  user_name_kana: string | null;
  gender: string | null;
  birth_date: string | null;
  phone: string | null;
  insurer_number: string | null;
  insurer_name: string | null;
  insured_number: string | null;
  care_level: string | null;
  certStart: string | null;
  certEnd: string | null;
  /**
   * 限度額適用期間 (給付管理票 8222 項13/14)。区分変更等で認定有効期間と異なる
   * ことがある。null なら認定有効期間で代用 (両者一致のケース)。
   */
  limitPeriodStart: string | null;
  limitPeriodEnd: string | null;
  /** 居宅サービス計画作成依頼(変更)届出年月日 (kaigo_care_plans)。無ければ null (認定開始日で代用) */
  requestDate: string | null;
  /** 介護支援専門員番号 (ケアマネ番号。kaigo_care_plans)。8124/8222 用。無ければ null */
  careManagerNumber: string | null;
  /** 区分支給限度基準額 (単位) — 給付管理票 (8221) 用 */
  limitUnits: number;
  claimId: string;
  claimStatus: ClaimStatus;
  serviceCode: string;
  serviceName: string;
  /** 基本単位数 (加算前) */
  baseUnits: number;
  /** 明細行 (基本 + 加算 + 減算) */
  lines: KyotakuMeisaiLine[];
  /** 総単位数 (基本 + 加算 − 減算) */
  totalUnits: number;
  unitPrice: number;
  totalAmount: number;
  insuranceAmount: number;
  // ── 公費 (生活保護等) ──
  /** 公費単独 (被保険者番号 H 始まり = みなし2号。保険給付なし・10割公費) */
  kohiTandoku: boolean;
  kohiHobetsu: string | null;
  kohiFutansha: string | null;
  kohiJukyusha: string | null;
  /** 介護予防支援の区分 (notes マーカー)。"itaku" は請求対象外 (包括が請求) */
  yoboShienKubun: YoboShienKubun | null;
  /**
   * 月途中の保険者変更 (転居)。null = 変更なし。
   * 検出時も出力 (明細書/給付管理票/伝送) は月末時点の保険者番号・被保険者番号で
   * 行い、警告表示のみ (詳細は build-kyotaku.ts MidMonthInsurerChange の暫定ルール)。
   */
  midMonthInsurerChange: MidMonthCertChange["insurerChange"];
}

/** 保険者変更の表示用文言 ("保険者 1234→5678" / "被保険者番号 …→…") */
export function describeInsurerChange(
  mc: NonNullable<MidMonthCertChange["insurerChange"]>,
): string {
  const insurerDiff =
    !!mc.fromInsurer && !!mc.toInsurer && mc.fromInsurer.trim() !== mc.toInsurer.trim();
  return insurerDiff
    ? `保険者 ${mc.fromInsurer}→${mc.toInsurer}`
    : `被保険者番号 ${mc.fromInsured ?? "?"}→${mc.toInsured ?? "?"}`;
}

/** 月遅れ/返戻の再請求行 (元提供月で読み直したレセプト) */
export type KyotakuReSeikyuRow = KyotakuSeikyuRow & {
  /** 元の提供月 (YYYY-MM) */
  __origMonthKey: string;
  /** 再請求の理由 */
  __reasons: { tsukiokure: boolean; henrei: boolean };
  /** kaigo_billing_status.notes (給付管理票 作成区分マーカー等) */
  __statusNotes: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// 給付管理票 作成区分 (8221 項5: 1=新規 / 2=修正 / 3=取消)
// kaigo_billing_status.notes のマーカーで永続化する (専用列は増やさない)。
// ─────────────────────────────────────────────────────────────────────────────

export type KyufuKanriKubun = "1" | "2" | "3";

export const KYUFU_KANRI_KUBUN_LABELS: Record<KyufuKanriKubun, string> = {
  "1": "新規",
  "2": "修正",
  "3": "取消",
};

const KYUFU_KUBUN_MARKER: Record<KyufuKanriKubun, string> = {
  "1": "[給管:新規]",
  "2": "[給管:修正]",
  "3": "[給管:取消]",
};

/** notes からマーカーを読んで作成区分を返す (無ければ null) */
export function parseKyufuKanriKubun(notes: string | null | undefined): KyufuKanriKubun | null {
  if (!notes) return null;
  if (notes.includes(KYUFU_KUBUN_MARKER["3"])) return "3";
  if (notes.includes(KYUFU_KUBUN_MARKER["2"])) return "2";
  if (notes.includes(KYUFU_KUBUN_MARKER["1"])) return "1";
  return null;
}

/** notes の既存マーカーを除去して作成区分マーカーを付け直す */
export function setKyufuKanriKubunMarker(
  notes: string | null | undefined,
  kubun: KyufuKanriKubun,
): string {
  const stripped = (notes ?? "")
    .replace(/\[給管:[^\]]*\]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const marker = KYUFU_KUBUN_MARKER[kubun];
  return stripped ? `${stripped}\n${marker}` : marker;
}

// kaigo_care_support_claims の DB 行 (必要列のみ)
interface ClaimDbRow {
  id: string;
  user_id: string;
  care_support_code: string | null;
  care_support_name: string | null;
  units: number;
  unit_price: number;
  total_amount: number;
  insurance_amount: number;
  initial_addition: boolean;
  initial_addition_units: number;
  hospital_coordination: boolean;
  hospital_coordination_units: number;
  discharge_addition: boolean;
  discharge_addition_units: number;
  medical_coordination: boolean;
  medical_coordination_units: number | null;
  discharge_type: string | null;
  tokutei_kassan_type: string | null;
  tokutei_kassan_units: number | null;
  medical_coop_kassan: boolean | null;
  medical_coop_kassan_units: number | null;
  shoguu_kaizen_units: number | null;
  shoguu_kaizen_code: string | null;
  terminal_care: boolean | null;
  terminal_care_units: number | null;
  emergency_conference: boolean | null;
  emergency_conference_units: number | null;
  bcp_not_prepared: boolean | null;
  bcp_reduction_pct: number | null;
  abuse_prevention_not_implemented: boolean | null;
  abuse_reduction_pct: number | null;
  /** 運営基準減算 (migration kyotaku_billing_kojin_settei.sql 適用前は undefined) */
  unei_kijun_gensan?: boolean | null;
  unei_kijun_gensan_units?: number | null;
  status: ClaimStatus;
  notes: string | null;
  /** レセプト自身の保険者/被保険者番号 (care_support_claims_insurer.sql)。
   *  転居月は 1 人が保険者ごとに 2 レセプトになるので、月末の認定では決まらない */
  insurer_number?: string | null;
  insured_number?: string | null;
  clients: {
    name: string | null;
    furigana: string | null;
    gender: string | null;
    birth_date: string | null;
    phone: string | null;
  } | null;
}

interface CertDbRow {
  client_id: string;
  insurer_number: string | null;
  insurer_name: string | null;
  insured_number: string | null;
  care_level: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  service_limit_amount: number | null;
  limit_period_start: string | null;
  limit_period_end: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// レセプト行 → 明細行/総単位数 (billing-forms-content の meisaiDetail と同じ算式)
// ─────────────────────────────────────────────────────────────────────────────

// 加算のサービスコード (kaigo_service_codes 実DB確認値 2026-07-08。R6/R8.6 両世代同一)
const TOKUTEI_KASSAN_CODES: Record<string, string> = {
  "Ⅰ": "434002",
  "Ⅱ": "434003",
  "Ⅲ": "434004",
  A: "434006",
  // 旧区分 (既存データ対応)
  B: "434003",
  C: "434004",
};
const DISCHARGE_TYPE_CODES: Record<string, string> = {
  i_i: "436132", // 退院退所加算Ⅰ１ 450
  i_ro: "436143", // Ⅰ２ 600
  ii_i: "436144", // Ⅱ１ 600
  ii_ro: "436145", // Ⅱ２ 750
  iii: "436146", // Ⅲ 900
};
// discharge_type 未保存の旧データは単位数からコードを推定
const DISCHARGE_UNITS_TO_CODE: Record<number, string> = {
  450: "436132",
  750: "436145",
  900: "436146",
};

function buildClaimLines(c: ClaimDbRow): {
  lines: KyotakuMeisaiLine[];
  totalUnits: number;
} {
  // 給付管理をしない月 (死亡等) は居宅介護支援費が立たず加算だけを請求する。
  // そのときは基本行を出さない。
  const lines: KyotakuMeisaiLine[] = c.care_support_code
    ? [{ name: c.care_support_name ?? "", code: c.care_support_code, units: c.units, count: 1 }]
    : [];
  if (c.initial_addition && c.initial_addition_units > 0)
    lines.push({ name: "初回加算", code: "434001", units: c.initial_addition_units, count: 1 });
  if ((c.tokutei_kassan_units ?? 0) > 0)
    lines.push({
      name: `特定事業所加算(${c.tokutei_kassan_type ?? ""})`,
      code: TOKUTEI_KASSAN_CODES[c.tokutei_kassan_type ?? ""] ?? "",
      units: c.tokutei_kassan_units ?? 0,
      count: 1,
    });
  if (c.medical_coop_kassan)
    lines.push({ name: "特定事業所医療介護連携加算", code: "434005", units: c.medical_coop_kassan_units ?? 125, count: 1 });
  if (c.hospital_coordination && c.hospital_coordination_units > 0)
    lines.push({
      name: `入院時情報連携加算${c.hospital_coordination_units >= 250 ? "Ⅰ" : "Ⅱ"}`,
      code: c.hospital_coordination_units >= 250 ? "436125" : "436129",
      units: c.hospital_coordination_units,
      count: 1,
    });
  if (c.discharge_addition && c.discharge_addition_units > 0)
    lines.push({
      name: "退院・退所加算",
      code:
        (c.discharge_type ? DISCHARGE_TYPE_CODES[c.discharge_type] : null) ??
        DISCHARGE_UNITS_TO_CODE[c.discharge_addition_units] ??
        "",
      units: c.discharge_addition_units,
      count: 1,
    });
  if (c.medical_coordination)
    lines.push({ name: "通院時情報連携加算", code: "436135", units: c.medical_coordination_units ?? 50, count: 1 });
  if (c.terminal_care)
    lines.push({ name: "ターミナルケアマネジメント加算", code: "436100", units: c.terminal_care_units ?? 400, count: 1 });
  if (c.emergency_conference)
    lines.push({ name: "緊急時等居宅カンファレンス加算", code: "436133", units: c.emergency_conference_units ?? 200, count: 1 });
  // 減算 (公式合成コードと一致する round 方式: 減算量 = 所定 − round(所定×(100−pct)/100))
  if (c.bcp_not_prepared)
    lines.push({
      name: "業務継続計画未策定減算",
      code: "",
      units: -reductionUnitsOf(c.units, c.bcp_reduction_pct || 1),
      count: 1,
    });
  if (c.abuse_prevention_not_implemented)
    lines.push({
      name: "高齢者虐待防止措置未実施減算",
      code: "",
      units: -reductionUnitsOf(c.units, c.abuse_reduction_pct || 1),
      count: 1,
    });
  if (c.unei_kijun_gensan)
    lines.push({
      name: "運営基準減算",
      code: "",
      units: -(c.unei_kijun_gensan_units ?? reductionUnitsOf(c.units, 50)),
      count: 1,
    });
  // 処遇改善加算 (居宅介護支援・令和6〜)。base+各加算−減算 の総単位 × 率 で算定済 (claims 生成時)。
  //   最後の行として算入 (国保連伝送・請求の総単位に反映)。
  if ((c.shoguu_kaizen_units ?? 0) > 0)
    lines.push({
      name: "処遇改善加算",
      code: c.shoguu_kaizen_code ?? "436191",
      units: c.shoguu_kaizen_units ?? 0,
      count: 1,
    });
  const totalUnits = lines.reduce((s, l) => s + l.units * l.count, 0);
  return { lines, totalUnits };
}

// ─────────────────────────────────────────────────────────────────────────────
// 月次レセプト行の取得 (当月表示・再請求 (過去月) の両方から使う)
// ─────────────────────────────────────────────────────────────────────────────

const PAGE = 1000;
// .in() の URI Too Long 回避用チャンク (lib/chunk-parallel の URL 予算に合わせる)
const IN_CHUNK_SIZE = ID_IN_CHUNK;
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 指定月のレセプト (kaigo_care_support_claims) を利用者・認定情報付きで取得する。
 * ふりがな順にソート済み。
 */
/**
 * 各段階の所要時間を Console に出す (prefix `[居宅請求]`)。
 * 画面が読み込み中のまま止まった時に、どの問い合わせで待っているかを
 * DevTools の Console だけで特定できるようにするための計測。
 */
function stageLogger(label: string) {
  const t0 = Date.now();
  let prev = t0;
  return (stage: string, extra = "") => {
    const now = Date.now();
    console.info(`[居宅請求] ${label} ${stage} ${now - prev}ms (累計 ${now - t0}ms) ${extra}`);
    prev = now;
  };
}

export async function fetchKyotakuClaimRows(
  supabase: SupabaseClient,
  monthKey: string, // 'YYYY-MM'
  officeId?: string | null, // 指定時は当事業所に割り当てられた利用者のみ (多事業所で他事業所が混ざるのを防ぐ)
  opts?: {
    /**
     * kaigo_billing_status.kokuho_target=false の利用者を除く。
     *
     * ⚠ **売上と伝送で必要な集合が違う**。
     *   売上   = その月に提供した全員 (月遅れも含む)         → false (既定)
     *   伝送   = その月に国保連へ出す分だけ (月遅れは除く)   → true
     *   既定を false にしているのは、ダッシュボードの売上から
     *   月遅れが落ちると「提供したのに売上に出ない」ことになるため。
     */
    excludeNonKokuho?: boolean;
  },
): Promise<KyotakuSeikyuRow[]> {
  const log = stageLogger(monthKey);
  log("開始");
  // 0) 当事業所の利用者 (client_office_assignments)。officeId 未指定時は全件 (後方互換)。
  //    これが無いと請求・伝送に他事業所の居宅レセプトが混ざる (claims 画面と同種の事故)。
  let officeClientIds: string[] | null = null;
  if (officeId) {
    officeClientIds = [];
    let fromA = 0;
    while (true) {
      const { data, error } = await supabase
        .from("client_office_assignments")
        .select("client_id")
        .eq("office_id", officeId)
        .order("client_id", { ascending: true })
        .range(fromA, fromA + PAGE - 1);
      if (error) throw new Error(`事業所割当の取得に失敗: ${error.message}`);
      if (!data || data.length === 0) break;
      officeClientIds.push(...data.map((a: { client_id: string }) => a.client_id));
      if (data.length < PAGE) break;
      fromA += PAGE;
    }
    if (officeClientIds.length === 0) return [];
  }

  log("事業所割当", `${officeClientIds ? officeClientIds.length + "名" : "全件"}`);

  // 1) 当月レセプト (page-loop で 1000 行制限回避。chunk は並列)。
  //    select は "*" (unei_kijun_gensan 列は migration 適用前でも壊れないよう明示列挙しない)
  const idChunks: (string[] | null)[] = officeClientIds
    ? chunkArray(officeClientIds, IN_CHUNK_SIZE)
    : [null];
  const claimChunks = await Promise.all(
    idChunks.map(async (idChunk) => {
      const acc: ClaimDbRow[] = [];
      let from = 0;
      while (true) {
        let q = supabase
          .from("kaigo_care_support_claims")
          .select("*, clients(name, furigana, gender, birth_date, phone)")
          .eq("billing_month", monthKey);
        if (idChunk) q = q.in("user_id", idChunk);
        const { data, error } = await q
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`レセプトの取得に失敗: ${error.message}`);
        if (!data || data.length === 0) break;
        acc.push(...(data as unknown as ClaimDbRow[]));
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return acc;
    }),
  );
  let claims: ClaimDbRow[] = claimChunks.flat();
  log("レセプト取得", `${claims.length}件`);
  if (claims.length === 0) return [];

  // 伝送のときだけ「今月は国保連に出さない」利用者を落とす (月遅れ・返戻・過誤)
  if (opts?.excludeNonKokuho && officeId) {
    const { data: st, error: stErr } = await supabase
      .from("kaigo_billing_status")
      .select("client_id")
      .eq("office_id", officeId)
      .eq("target_month", monthKey)
      .eq("kokuho_target", false);
    // table 未作成 (42P01 / PGRST205) は除外なしで続行 (従来動作)
    if (stErr && stErr.code !== "42P01" && stErr.code !== "PGRST205") {
      throw new Error(`請求対象外の取得に失敗: ${stErr.message}`);
    }
    const skip = new Set((st ?? []).map((x: { client_id: string }) => x.client_id));
    if (skip.size) {
      const before = claims.length;
      claims = claims.filter((c) => !skip.has((c as { user_id: string }).user_id));
      log("国保連対象外を除外", `${before - claims.length}件`);
    }
  }

  // 介護予防支援「委託」(包括が請求) は請求対象外 (0 単位の区分永続化行のため除外)
  const billable = claims.filter((c) => parseYoboShienKubun(c.notes) !== "itaku");
  if (billable.length === 0) return [];

  // 2) 認定 / 公費 / 月内認定 / ケアプラン — 互いに独立なので 1 波で並列取得。
  //    認定情報は「対象月に有効な認定」で解決 (resolveCertForMonth)。月遅れ再請求で
  //    認定更新を跨いでも元提供月時点の要介護度・被保険者番号が載る。
  //    月内認定 (保険者変更の検出) は同じ行を使うので resolveCertsForMonthBoth で 1 往復に束ねる。
  const userIds = [...new Set(billable.map((c) => c.user_id))];
  const [cy, cm] = monthKey.split("-").map(Number);
  const [certBoth, kohiRes, planRows] = await Promise.all([
    resolveCertsForMonthBoth(supabase, userIds, cy, cm),
    // 公費 (生活保護等) — client_kohi_records から対象月に有効な 1 件を解決
    // (テーブル未作成時は旧 kohi_* 列にフォールバック → lib/kohi.ts)
    resolveKohiForMonth(supabase, userIds, cy, cm),
    // 計画作成依頼届出年月日 (plan_request_date) と 介護支援専門員番号 (care_manager_number)
    // — kaigo_care_plans から。居宅明細書 8124 項15 / 給付管理票 8222 終端 項25 用。
    (async () => {
      const chunks = await mapChunksParallel(userIds, ID_IN_CHUNK, async (chunk) => {
        const { data, error } = await supabase
          .from("kaigo_care_plans")
          .select("user_id, plan_request_date, care_manager_number")
          .in("user_id", chunk)
          .eq("status", "active");
        if (error) throw new Error(`ケアプランの取得に失敗: ${error.message}`);
        return (data ?? []) as {
          user_id: string;
          plan_request_date: string | null;
          care_manager_number: string | null;
        }[];
      });
      return chunks.flat();
    })(),
  ]);
  log("認定/公費/ケアプラン解決", `${userIds.length}名`);
  const certRes = certBoth.forMonth;
  const certsInMonthRes = certBoth.inMonth;
  const certMap = new Map<string, CertDbRow>();
  for (const [clientId, cert] of certRes) {
    certMap.set(clientId, {
      client_id: clientId,
      insurer_number: cert.insurer_number,
      insurer_name: cert.insurer_name,
      insured_number: cert.insured_number,
      care_level: cert.care_level,
      certification_start_date: cert.certification_start_date,
      certification_end_date: cert.certification_end_date,
      service_limit_amount: cert.service_limit_amount,
      limit_period_start: cert.limit_period_start,
      limit_period_end: cert.limit_period_end,
    });
  }

  // 2.5) 月途中の保険者変更 (転居) の検出 — 給付管理票・明細書の提出先確認の警告用。
  //      検出しても出力自体は 2) の月末時点の認定 (resolveCertForMonth の採用行) で行う。
  const insurerChangeByUser = new Map<
    string,
    NonNullable<MidMonthCertChange["insurerChange"]>
  >();
  for (const [clientId, certs] of certsInMonthRes) {
    const mc = detectMidMonthChange(certs);
    if (mc?.insurerChange) insurerChangeByUser.set(clientId, mc.insurerChange);
  }

  // 2.6) ケアプラン (2 で取得済み) を user_id → 値 に畳む
  const planReqByUser = new Map<string, string | null>();
  const careMgrByUser = new Map<string, string | null>();
  for (const p of planRows) {
    if (!planReqByUser.has(p.user_id)) planReqByUser.set(p.user_id, p.plan_request_date);
    if (!careMgrByUser.has(p.user_id)) careMgrByUser.set(p.user_id, p.care_manager_number ?? null);
  }

  // 保険者番号 → 保険者名。転居月の 2 枚目は「月末の認定」と保険者が違うので、
  // その行の保険者名を認定 1 件から引けない。全認定から番号で引けるようにしておく。
  const insurerNameByNumber = new Map<string, string>();
  for (const [, certs] of certsInMonthRes) {
    for (const r of certs) {
      const n = (r.insurer_number ?? "").trim();
      if (n && r.insurer_name && !insurerNameByNumber.has(n)) insurerNameByNumber.set(n, r.insurer_name);
    }
  }
  for (const [, r] of certRes) {
    const n = (r.insurer_number ?? "").trim();
    if (n && r.insurer_name && !insurerNameByNumber.has(n)) insurerNameByNumber.set(n, r.insurer_name);
  }

  // 3) 行の組み立て (ふりがな順)
  const rows: KyotakuSeikyuRow[] = billable.map((c) => {
    const cert = certMap.get(c.user_id);
    // ⚠ **月末の認定で保険者を決めない。**転居月は 1 人が保険者ごとに 2 レセプトに
    //   なるため、両方が新保険者名義で出て旧保険者への請求が消え、国保連で重複返戻になる。
    //   2026-09-01 時点で現存 5 名 (天野昭代・佐藤喜美子・細田孝子・加藤綾子・秋元とし子)。
    //   レセプト自身が番号を持っていればそれを使い、無い (旧 DB / 空) ときだけ認定に落とす。
    const claimInsurer = (c.insurer_number ?? "").trim();
    const certInsurer = (cert?.insurer_number ?? "").trim();
    const useClaimInsurer = claimInsurer !== "" && claimInsurer !== certInsurer;
    const kohi = kohiRes.byClient.get(c.user_id) ?? null;
    const { lines, totalUnits } = buildClaimLines(c);
    // 公費単独 (みなし2号) = 被保険者番号が H 始まり
    const kohiTandoku = /^h/i.test((cert?.insured_number ?? "").trim());
    return {
      user_id: c.user_id,
      user_name: c.clients?.name ?? "(名前未取得)",
      user_name_kana: c.clients?.furigana ?? null,
      gender: c.clients?.gender ?? null,
      birth_date: c.clients?.birth_date ?? null,
      phone: c.clients?.phone ?? null,
      insurer_number: claimInsurer || cert?.insurer_number || null,
      insurer_name: useClaimInsurer
        ? (insurerNameByNumber.get(claimInsurer) ?? null)   // 名前が引けなければ空。誤った名前は出さない
        : (cert?.insurer_name ?? null),
      insured_number: (c.insured_number ?? "").trim() || cert?.insured_number || null,
      care_level: cert?.care_level ?? null,
      certStart: cert?.certification_start_date ?? null,
      certEnd: cert?.certification_end_date ?? null,
      limitPeriodStart: cert?.limit_period_start ?? null,
      limitPeriodEnd: cert?.limit_period_end ?? null,
      requestDate: planReqByUser.get(c.user_id) ?? null,
      careManagerNumber: careMgrByUser.get(c.user_id) ?? null,
      limitUnits: cert?.service_limit_amount ?? 0,
      claimId: c.id,
      claimStatus: c.status,
      // 給付管理をしない月 (死亡等) は基本コードが無い。空文字で表す (lines も空になる)
      serviceCode: c.care_support_code ?? "",
      serviceName: c.care_support_name ?? "",
      baseUnits: c.units,
      lines,
      totalUnits,
      unitPrice: c.unit_price,
      totalAmount: c.total_amount,
      // 公費単独は保険給付なし (表示・集計は 10 割公費として扱う)
      insuranceAmount: kohiTandoku ? 0 : c.insurance_amount,
      kohiTandoku,
      kohiHobetsu: kohi?.hobetsu ?? null,
      kohiFutansha: kohi?.futansha ?? null,
      kohiJukyusha: kohi?.jukyusha ?? null,
      yoboShienKubun: parseYoboShienKubun(c.notes),
      midMonthInsurerChange: insurerChangeByUser.get(c.user_id) ?? null,
    };
  });
  rows.sort((a, b) =>
    (a.user_name_kana ?? a.user_name).localeCompare(
      b.user_name_kana ?? b.user_name,
      "ja",
    ),
  );
  return rows;
}

/**
 * 月遅れ/返戻の再請求行を読み込む (lib/visit-seikyu/re-seikyu.ts の居宅版)。
 * 当月より前の月で 月遅れ or 返戻 かつ 未・国保対象 の利用者を、
 * 元提供月のレセプトで読み直して返す。
 */
export async function loadKyotakuReSeikyuRows(
  supabase: SupabaseClient,
  currentMonthKey: string, // 'YYYY-MM'
  officeId: string, // 状態行は事業所単位 (訪問介護のフラグを拾わない)
): Promise<KyotakuReSeikyuRow[]> {
  const { data, error } = await supabase
    .from("kaigo_billing_status")
    .select("client_id, target_month, tsukiokure, henrei, notes")
    .eq("office_id", officeId)
    .eq("kokuho_target", false)
    .or("tsukiokure.eq.true,henrei.eq.true")
    .lt("target_month", currentMonthKey);
  if (error) {
    // table 未作成 (migration 未適用: 42P01 / PostgREST schema cache: PGRST205) は再請求なしで続行
    if (error.code === "42P01" || error.code === "PGRST205") return [];
    throw new Error(`再請求対象の取得に失敗: ${error.message}`);
  }
  const flagged = (data ?? []) as {
    client_id: string;
    target_month: string;
    tsukiokure: boolean;
    henrei: boolean;
    notes: string | null;
  }[];
  if (flagged.length === 0) return [];

  // 月ごとにまとめる
  const byMonth = new Map<
    string,
    Map<string, { tsukiokure: boolean; henrei: boolean; notes: string | null }>
  >();
  for (const f of flagged) {
    if (!byMonth.has(f.target_month)) byMonth.set(f.target_month, new Map());
    byMonth.get(f.target_month)!.set(f.client_id, {
      tsukiokure: !!f.tsukiokure,
      henrei: !!f.henrei,
      notes: f.notes ?? null,
    });
  }

  const out: KyotakuReSeikyuRow[] = [];
  for (const [monthKey, clientReasons] of byMonth) {
    // 元提供月のレセプトを読み、フラグの立っている利用者のみ合流
    // (居宅レセプトが無い client = 訪問介護側のフラグ等 は自然に除外される)
    const rows = await fetchKyotakuClaimRows(supabase, monthKey, officeId);
    for (const r of rows) {
      const reasons = clientReasons.get(r.user_id);
      if (!reasons) continue;
      out.push({
        ...r,
        __origMonthKey: monthKey,
        __reasons: { tsukiokure: reasons.tsukiokure, henrei: reasons.henrei },
        __statusNotes: reasons.notes,
      });
    }
  }

  // 古い提供月 → ふりがな の順
  out.sort((a, b) => {
    if (a.__origMonthKey !== b.__origMonthKey) {
      return a.__origMonthKey < b.__origMonthKey ? -1 : 1;
    }
    return (a.user_name_kana ?? a.user_name).localeCompare(
      b.user_name_kana ?? b.user_name,
      "ja",
    );
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// かな行フィルター (billing-visit/_shared/seikyu-context.tsx と同じ判定 map)
// ─────────────────────────────────────────────────────────────────────────────

export const SEIKYU_KANA_ROWS = ["あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ", "他"];
const SEIKYU_KANA_MAP: Record<string, string[]> = {
  "あ": ["ア", "イ", "ウ", "エ", "オ"],
  "か": ["カ", "キ", "ク", "ケ", "コ", "ガ", "ギ", "グ", "ゲ", "ゴ"],
  "さ": ["サ", "シ", "ス", "セ", "ソ", "ザ", "ジ", "ズ", "ゼ", "ゾ"],
  "た": ["タ", "チ", "ツ", "テ", "ト", "ダ", "ヂ", "ヅ", "デ", "ド"],
  "な": ["ナ", "ニ", "ヌ", "ネ", "ノ"],
  "は": ["ハ", "ヒ", "フ", "ヘ", "ホ", "バ", "ビ", "ブ", "ベ", "ボ", "パ", "ピ", "プ", "ペ", "ポ"],
  "ま": ["マ", "ミ", "ム", "メ", "モ"],
  "や": ["ヤ", "ユ", "ヨ"],
  "ら": ["ラ", "リ", "ル", "レ", "ロ"],
  "わ": ["ワ", "ヲ", "ン"],
};
const SEIKYU_ALL_KANA = Object.values(SEIKYU_KANA_MAP).flat();
// ひらがな→カタカナ正規化
const seikyuToKana = (s: string) =>
  s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

interface KyotakuSeikyuContextValue {
  year: number;
  month: number;
  monthKey: string; // 'YYYY-MM'
  onMonthChange: (y: number, m: number) => void;
  rows: KyotakuSeikyuRow[];
  loading: boolean;
  error: string | null;
  officeId: string | null;
  tenantId: string | null;
  officeName: string | null;
  officeNumber: string | null;
  officeAddress: string | null;
  officePhone: string | null;
  officePostal: string | null;
  unitPrice: number;
  reload: () => void;
  /** 選択中のかな行 (null = 全) */
  kanaFilter: string | null;
  setKanaFilter: (k: string | null) => void;
  /** 行がカナフィルタに合致するか (再請求行など rows 外の行にも使う) */
  kanaMatches: (r: { user_name_kana: string | null; user_name: string }) => boolean;
  /** カナ絞込済みの rows (各タブはこちらを表示に使う) */
  filteredRows: KyotakuSeikyuRow[];
}

const KyotakuSeikyuContext = createContext<KyotakuSeikyuContextValue | null>(null);

export function KyotakuSeikyuProvider({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, loading: btLoading } = useBusinessType();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [rows, setRows] = useState<KyotakuSeikyuRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [officeNumber, setOfficeNumber] = useState<string | null>(null);
  const [officeAddress, setOfficeAddress] = useState<string | null>(null);
  const [officePhone, setOfficePhone] = useState<string | null>(null);
  const [officePostal, setOfficePostal] = useState<string | null>(null);
  const [unitPrice, setUnitPrice] = useState<number>(10);
  const [kanaFilter, setKanaFilter] = useState<string | null>(null);

  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  const load = useCallback(async () => {
    // 事業所が解決できない場合に return するだけだと loading=true のまま
    // スピナーが永久に回る (原因が画面に出ない)。明示的に終了させる。
    if (!currentOffice) {
      setRows([]);
      setError("事業所を特定できませんでした (URL の ?office= を確認してください)");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // 事業所情報 (事業所番号 / 住所 / 単価)。単価は地域区分を優先 (claims-content と同じ)
      // レセプト取得とは独立なので並列 (直列にすると 1 往復ぶん待たされる)
      const [
        { data: officeRow, error: officeErr },
        list,
      ] = await Promise.all([
        supabase
          .from("offices")
          .select("business_number, address, phone, postal_code, unit_price, area_category")
          .eq("id", currentOffice.id)
          .maybeSingle(),
        fetchKyotakuClaimRows(supabase, monthKey, currentOffice.id),
      ]);
      if (officeErr) throw new Error(`事業所情報の取得に失敗: ${officeErr.message}`);
      const or = officeRow as {
        business_number?: string | null;
        address?: string | null;
        phone?: string | null;
        postal_code?: string | null;
        unit_price?: number | null;
        area_category?: string | null;
      } | null;
      setOfficeNumber(or?.business_number ?? null);
      setOfficeAddress(or?.address ?? null);
      setOfficePhone(or?.phone ?? null);
      setOfficePostal(or?.postal_code ?? null);
      setUnitPrice(
        or?.area_category
          ? getUnitPriceByArea(or.area_category)
          : Number(or?.unit_price ?? 10),
      );

      setRows(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, currentOffice, monthKey]);

  useEffect(() => {
    if (btLoading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/月変更時の fetch
    load();
  }, [btLoading, load]);

  const onMonthChange = (y: number, m: number) => {
    setYear(y);
    setMonth(m);
  };

  const kanaMatches = useCallback(
    (r: { user_name_kana: string | null; user_name: string }) => {
      if (!kanaFilter) return true;
      const first = seikyuToKana((r.user_name_kana ?? r.user_name).charAt(0));
      return kanaFilter === "他"
        ? !SEIKYU_ALL_KANA.includes(first)
        : (SEIKYU_KANA_MAP[kanaFilter] ?? []).includes(first);
    },
    [kanaFilter],
  );

  const filteredRows = useMemo(
    () => rows.filter(kanaMatches),
    [rows, kanaMatches],
  );

  const value: KyotakuSeikyuContextValue = {
    year,
    month,
    monthKey,
    onMonthChange,
    rows,
    loading: loading || btLoading,
    error,
    officeId: currentOffice?.id ?? null,
    tenantId: currentOffice?.tenant_id ?? null,
    officeName: currentOffice?.name ?? null,
    officeNumber,
    officeAddress,
    officePhone,
    officePostal,
    unitPrice,
    reload: load,
    kanaFilter,
    setKanaFilter,
    kanaMatches,
    filteredRows,
  };

  return (
    <KyotakuSeikyuContext.Provider value={value}>
      {children}
    </KyotakuSeikyuContext.Provider>
  );
}

export function useKyotakuSeikyuContext(): KyotakuSeikyuContextValue {
  const ctx = useContext(KyotakuSeikyuContext);
  if (ctx === null) {
    throw new Error(
      "useKyotakuSeikyuContext は <KyotakuSeikyuProvider> の内側で呼び出してください",
    );
  }
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// 左端「あかさたな索引」縦バー (billing-visit 版と同一クラス)
// ─────────────────────────────────────────────────────────────────────────────

export function SeikyuKanaSidebar() {
  const { kanaFilter, setKanaFilter } = useKyotakuSeikyuContext();
  return (
    <div className="w-10 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col items-center py-1 gap-0.5 overflow-y-auto">
      <button
        type="button"
        onClick={() => setKanaFilter(null)}
        className={`w-8 py-1 rounded text-sm font-bold transition-colors ${kanaFilter === null ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
      >
        全
      </button>
      {SEIKYU_KANA_ROWS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => setKanaFilter(kanaFilter === k ? null : k)}
          className={`w-8 py-1 rounded text-sm font-medium transition-colors ${kanaFilter === k ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
        >
          {k}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 月ナビ (billing-visit 版と同一クラス)
//   square: 月次情報タブの「◀ 2026年 7月 ▶」四角ボタン型
//   box:    介護請求タブの「(◀ R8/6 ▶)」枠ボックス型
// ─────────────────────────────────────────────────────────────────────────────

export function SeikyuMonthNav({ variant = "box" }: { variant?: "box" | "square" }) {
  const { year, month, onMonthChange } = useKyotakuSeikyuContext();
  const prev = () =>
    month === 1 ? onMonthChange(year - 1, 12) : onMonthChange(year, month - 1);
  const next = () =>
    month === 12 ? onMonthChange(year + 1, 1) : onMonthChange(year, month + 1);

  if (variant === "square") {
    return (
      <>
        <button
          type="button"
          onClick={prev}
          className="px-2 py-1 rounded bg-white border border-gray-300 hover:bg-gray-50 text-xs"
        >
          ◀
        </button>
        <span className="text-sm font-semibold text-gray-700">
          {year}年 {month}月
        </span>
        <button
          type="button"
          onClick={next}
          className="px-2 py-1 rounded bg-white border border-gray-300 hover:bg-gray-50 text-xs"
        >
          ▶
        </button>
      </>
    );
  }
  return (
    <div className="flex items-center gap-0.5 border border-gray-300 rounded bg-white px-2 py-1">
      <button type="button" onClick={prev} className="text-gray-500 hover:text-gray-800">
        <ChevronLeft size={14} />
      </button>
      <span className="font-semibold text-gray-800 px-1.5">
        R{year - 2018}/{month}
      </span>
      <button type="button" onClick={next} className="text-gray-500 hover:text-gray-800">
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
