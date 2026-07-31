/**
 * 訪問介護 請求集計 (介護請求 / 利用請求 / 国保請求 の共通ロジック)
 *
 * データフロー:
 *   kaigo_visit_schedule (status='completed' = 実績)
 *     × kaigo_service_codes (service_name → units)
 *     × clients + client_insurance_records (氏名 / 保険者番号 / 被保険者番号 / 要介護度 / 負担割合)
 *       ※ 認定は resolveCertForMonth で「対象月に有効な認定」を解決する (月遅れ再請求対応)
 *     × offices (地域区分単価 / 処遇改善加算)
 *   → 利用者ごとに 1 行の請求サマリ
 *
 * 金額計算 (介護保険の標準。float 誤差を避けるため整数演算):
 *   明細単位数 = Σ(サービス単位 × 回数) + 実績単位の加算 (初回/緊急時/生活機能向上連携)
 *   区分支給限度基準 (ほのぼの準拠):
 *     基準値 = 計画単位数 (kaigo_monthly_plan_units) があればそれ、
 *              無ければ認定の限度額 (client_insurance_records.service_limit_amount)。
 *     明細単位数のうち基準値を超える分 (overUnits) は保険給付対象外
 *     → 超過単位 × 単価 × 10割 を「超過自費 (selfPayAmount)」として分離する。
 *       ※ userAmount (法定の利用者負担) には含めない。利用請求側で
 *         請求額 = userAmount + selfPayAmount として合算する。
 *     ※ 処遇改善加算等 (%加算)・初回加算・緊急時訪問介護加算は区分支給限度基準の
 *        「対象外」なので超過判定の単位数には含めない (kanriTaishougaiUnits)。
 *   総単位数 = 基準内単位数 + 加算単位 (処遇改善等 = %加算)
 *   総額     = floor(総単位数 × round(単価×100) / 100)   ※ 整数演算 (1円ズレ防止)
 *   保険請求額 = floor(総額 × (10 − 負担割合×10) / 10)   ※ copay 0.1/0.2/0.3 → 1/2/3 の整数化
 *   利用者負担 (法定) = 総額 − 保険請求額 − 公費請求額
 *     公費あり: 本人負担 = min(公費対象の保険給付後負担, 本人負担上限月額 honnin_futan)、
 *               公費請求 = 保険給付後負担 − 本人負担 (フル月の生保/公費単独は全量、
 *               公費適用期間が月の一部 (月途中開始の生保含む・公費単独除く) は
 *               期間内の実績分のみ公費対象 = 期間按分。Phase 1 2026-07)
 *   超過自費 = floor(超過単位 × round(単価×100) / 100)   → selfPayAmount
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ID_IN_CHUNK, NAME_IN_CHUNK } from "@/lib/chunk-parallel";
import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";
import { validInMonth } from "@/lib/service-code-valid";
import { resolveKohisForMonth, kohiHobetsuLabel, type ResolvedKohi } from "@/lib/kohi";
import {
  resolveCertForMonth,
  resolveCertsInMonth,
  resolveCertSegmentsForMonth,
  detectMidMonthChange,
  type CertForMonth,
} from "@/lib/cert-for-month";
import {
  getHospitalizationMap,
  hospitalizationsInRange,
} from "@/lib/hospitalization";
import {
  getGendoAllocationMap,
  resolveManualOverUnits,
  type GendoAllocationLine,
} from "@/lib/gendo-allocation";
import { aggregateSougouSeikyu } from "@/lib/visit-seikyu/aggregate-sougou";
import {
  SAME_BUILDING_REDUCTION,
  type SameBuildingTier,
} from "@/lib/visit-seikyu/same-building";
import {
  getGensanPeriodsForMonth,
  gensanFlagsFromPeriods,
  gensanFlagsLabel,
  resolveGensanVariant,
} from "@/lib/visit-seikyu/gyakutai-bcp";
import {
  isSeikatsuEnjoChushin,
  seikatsuEnjoKijunForCareLevel,
} from "@/lib/visit-seikyu/seikatsu-enjo-limit";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SeikyuDetailLine {
  /** サービス名 (身体介護3 等) */
  service_type: string;
  /** 略称 (身3 等)。無ければ service_type */
  short_name: string | null;
  /** サービスコード 6 桁 (国保連伝送用)。マスタ未一致時 null */
  service_code: string | null;
  /** 1 回あたり単位数 */
  unit_per: number;
  /** 実績回数 */
  count: number;
  /** 小計単位数 */
  units: number;
  /**
   * 月額包括 (unit_type='1月につき') か。総合事業のみ設定。
   * 総合事業伝送 (71R1 明細02 項9 単位数) は 定率(回/日)=単位数、月額=0 で出すため。
   */
  is_monthly?: boolean;
  /**
   * 公費対象回数。公費レコードあり時のみ設定。
   * 保険優先の部分公費 (法別12以外) で公費適用期間が月の一部の場合は
   * 期間内の実績回数のみ (それ以外は count と同値)。
   */
  kohi_count?: number;
  /** 公費対象単位数 = unit_per × kohi_count (減算行は期間内按分) */
  kohi_units?: number;
  /** 公費2対象回数 (複数公費併用時のみ設定。考え方は kohi_count と同じ) */
  kohi2_count?: number;
  /** 公費2対象単位数 = unit_per × kohi2_count (複数公費併用時のみ設定) */
  kohi2_units?: number;
}

export interface UserSeikyuRow {
  /**
   * 制度区分。'介護' = 介護給付費 (7131/様式第二)、
   * '総合事業' = 介護予防・日常生活支援総合事業費 (7112/様式(予))。
   * 未指定 (省略) は '介護' とみなす (後方互換)。
   */
  system?: "介護" | "総合事業";
  user_id: string;
  user_name: string;
  user_name_kana: string | null;
  /** 利用者番号 (clients.user_number) */
  user_number: string | null;
  insurer_number: string | null;
  /** 保険者名 (client_insurance_records.insurer_name) */
  insurer_name: string | null;
  insured_number: string | null;
  care_level: string | null;
  /** 負担割合 (0.1 / 0.2 / 0.3)。レコード無し時は 0.1 */
  copay_rate: number;
  /** 明細行 (サービス種類ごと + 実績単位の加算行) */
  details: SeikyuDetailLine[];
  /** 明細合計単位数 (details の合計 = 限度額超過分を含む実績全量。処遇改善は含まない) */
  grossBaseUnits: number;
  /**
   * 区分支給限度基準の基準値 (単位)。
   * 計画単位数 (kaigo_monthly_plan_units) 優先、無ければ認定の限度額
   * (client_insurance_records.service_limit_amount)。どちらも無ければ null (= 限度額管理なし)。
   */
  limitUnits: number | null;
  /**
   * 計画単位数 (kaigo_monthly_plan_units の生値)。未設定は null。
   * 様式第二 ④計画単位数は「あればこれ、無ければ基準内 (管理対象) 単位数」(契約 C1)。
   */
  planUnits: number | null;
  /**
   * 基準超過単位数。優先順:
   *   1. ケアマネの手割振り (kaigo_gendo_allocation の自 office manual 行 = 利用票別表の確定値)
   *   2. 機械判定 = 限度額管理対象の単位数
   *      (= grossBaseUnits − 初回加算・緊急時訪問介護加算 (限度額管理対象外/告示)) − 基準値
   */
  overUnits: number;
  /** overUnits の由来: manual = ケアマネ割振り (利用票別表確定) / auto = 機械判定 */
  overSource: "manual" | "auto";
  /** 超過分の全額自費額 (円) = floor(overUnits × 単価)。selfPayAmount と同値 (表示互換用) */
  overAmount: number;
  /**
   * 限度額超過の全額自費 (円)。userAmount (法定負担) には含めない。
   * 利用請求の請求額 = userAmount + selfPayAmount (従来額と同じ)。
   */
  selfPayAmount: number;
  /** 本体単位数 (処遇改善等の%加算を除く、区分支給限度基準内 = 保険給付対象) */
  baseUnits: number;
  /** 処遇改善等 加算単位数 */
  addonUnits: number;
  /**
   * 限度額管理対象外単位数 = 処遇改善等%加算 + 初回加算 + 緊急時訪問介護加算 (契約 C1)。
   * 様式第二 集計欄「⑥限度額管理対象外単位数」に対応する。
   */
  kanriTaishougaiUnits: number;
  /** 加算の名称 (表示用) */
  addonLabel: string | null;
  /** 総単位数 */
  totalUnits: number;
  /** 地域区分単価 (10.0 等) */
  unitPrice: number;
  /** 総額 (円) */
  totalAmount: number;
  /** 保険請求額 (円) */
  insuranceAmount: number;
  /**
   * 利用者負担額 (円) = 法定負担のみ (総額 − 保険請求額。公費振替時は 0)。
   * 限度額超過の全額自費は selfPayAmount に分離 (費用 = 保険 + 公費 + 負担 の恒等式)。
   */
  userAmount: number;
  /** 公費 (生活保護等)。法別番号ラベル (テーブル未作成環境のみ旧テキスト)。null = 公費なし */
  publicExpense: string | null;
  /**
   * 公費単独請求 (10割公費)。被保険者番号が 'H' で始まる利用者
   * (= 介護保険の被保険者でない生保受給者 = 2号未加入のみなし要介護者)。
   * 保険給付なし: insuranceAmount=0 / userAmount=0 / kohiAmount=totalAmount (10割)。
   * 様式第一では保険請求欄に記載せず、公費請求欄の生保行に合算する。
   */
  kohiTandoku: boolean;
  /** 公費 法別番号 (12=生活保護 等) */
  kohiHobetsu: string | null;
  /** 公費負担者番号 (8桁) */
  kohiFutanshaNumber: string | null;
  /** 公費受給者番号 (7桁) */
  kohiJukyushaNumber: string | null;
  /**
   * 公費対象単位数。生保 (法別12)・公費単独は全単位。
   * 保険優先の部分公費 (法別21/54 等) は公費適用期間内の実績分
   * (基準内 + %加算の公費対象分。限度額超過の10割自費は対象外)。
   */
  kohiUnits: number | null;
  /**
   * 公費請求額 (円)。
   * 生保・公費単独 = 保険給付後負担 − 本人負担上限 (上限 0 なら全額振替 = 従来どおり)。
   * 部分公費 = 公費対象部分の保険給付後負担 − 本人負担 (上限適用)。
   */
  kohiAmount: number | null;
  /** 公費対象費用額 (円) = floor(公費対象単位数 × 単価)。公費なしは null */
  kohiTargetCost?: number | null;
  /** 公費対象部分の保険請求額 (円) = floor(公費対象費用 × 給付率)。公費なしは null */
  kohiTargetInsurance?: number | null;
  /**
   * 公費分本人負担額 (円) = min(公費対象の保険給付後負担, 本人負担上限月額)。
   * 様式第二 ⑬公費分本人負担 / 伝送 基本(41)・集計(20) に対応。公費なしは null
   */
  kohiHonninFutan?: number | null;
  // ─── 公費2 (複数公費の併用。2026-07) ───
  // 対象月に有効な公費が 2 件以上あるときのみ設定 (すべて optional = 後方互換。
  // 公費 1 件の行は従来と完全同値の出力になる)。
  // カスケード: 保険優先 → 公費1 (適用優先順の上位) → 公費2 → 本人。
  /** 公費2 法別番号 (12=生活保護 等。生保は制度優先順位が最劣後のため通常こちら側) */
  kohi2Hobetsu?: string | null;
  /** 公費2 負担者番号 (8桁) */
  kohi2FutanshaNumber?: string | null;
  /** 公費2 受給者番号 (7桁) */
  kohi2JukyushaNumber?: string | null;
  /** 公費2対象単位数 (伝送 基本(45)・集計(21) に対応) */
  kohi2Units?: number | null;
  /** 公費2請求額 (円) = 公費2対象の保険給付後負担 − 公費1充当分 − 公費2本人負担 */
  kohi2Amount?: number | null;
  /** 公費2対象費用額 (円) = floor(公費2対象単位数 × 単価) */
  kohi2TargetCost?: number | null;
  /** 公費2対象部分の保険請求額 (円) */
  kohi2TargetInsurance?: number | null;
  /** 公費2分本人負担額 (円) = min(公費2適用後の残負担, 公費2の本人負担上限月額) */
  kohi2HonninFutan?: number | null;
  // ─── 国保連伝送用の追加情報 ───
  /** 加算のサービスコード (116274 等) */
  addonCode: string | null;
  /** 生年月日 (YYYY-MM-DD) */
  birthDate: string | null;
  /** 性別 (男/女 表記そのまま) */
  gender: string | null;
  /** 認定有効期間 開始 (YYYY-MM-DD) */
  certStart: string | null;
  /** 認定有効期間 終了 (YYYY-MM-DD) */
  certEnd: string | null;
  /** 担当居宅介護支援事業所の事業所番号 (10 桁)。未解決は null */
  careOfficeNumber: string | null;
  /** 担当居宅介護支援事業所名 (client_insurance_records.care_office_name) */
  careOfficeName: string | null;
  /** サービス実日数 (訪問した日の数) */
  serviceDays: number;
  // ─── 月途中の保険者変更 (転居) による分割レセプト (Phase 2) ───
  // 分割なし (通常) は 4 つとも undefined = 既存下流コードとの完全後方互換。
  /** 分割レセプトのセグメント番号 (0 始まり)。分割なしは undefined */
  segmentIndex?: number;
  /** 分割レセプトの総セグメント数 (>= 2)。分割なしは undefined */
  segmentCount?: number;
  /** セグメント期間 開始 (YYYY-MM-DD)。分割なしは undefined */
  periodFrom?: string;
  /** セグメント期間 終了 (YYYY-MM-DD)。分割なしは undefined */
  periodTo?: string;
}

export interface MonthlySeikyuResult {
  rows: UserSeikyuRow[];
  /**
   * 総合事業 (介護予防・日常生活支援総合事業) 訪問型サービス (A2) の請求行。
   * 介護給付 (rows) とは別様式 (7112/様式(予)) なので混ぜない。
   * 各行の system は '総合事業'。実績が無ければ空配列。
   * 総合事業を扱わない集計 (訪問入浴等) は省略可 (未指定 = 総合事業なし)。
   */
  sougouRows?: UserSeikyuRow[];
  /** 集計対象月 (YYYY-MM) */
  month: string;
  /** 対象実績 (completed) 総件数 */
  recordCount: number;
  /**
   * 集計時の注意事項 (UI で amber 表示 / toast 用)。
   * 例: 身体介護9系 (units=0 の増分コード) が実績にある、総合事業実績の除外、
   * 入院期間と重なる実績、対象月に有効な認定が無い 等。
   */
  warnings: string[];
  /**
   * warnings のうち利用者に紐付くものを client_id で引けるようにした索引 (同一メッセージが
   * warnings にも重複して入る)。表示側 (行内⚠バッジ) は氏名の文字列パースではなく
   * これで引き当てる。利用者に紐付かない warning (制度・事業所単位の案内) はここに入らない。
   */
  warningsByClient: Record<string, string[]>;
}

// 処遇改善加算等 (= 月次総単位数に % を掛ける加算) は
// offices.applied_formula_codes と kaigo_service_codes.formula
// (monthly_aggregate: 所定単位 × numerator/denominator) を突合して計算する。

// 列未適用 (migration 前) 判定: undefined_column
const isColumnMissing = (e: { code?: string | null; message?: string | null }) =>
  e.code === "42703" || /does not exist/i.test(e.message ?? "");

// 'YYYY-MM-DD' → 'M/D' (入院警告の表示用)
const fmtMD = (iso: string) => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[1])}/${Number(m[2])}` : iso;
};

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function aggregateMonthlyVisitSeikyu(
  supabase: SupabaseClient,
  opts: {
    officeId: string | null;
    tenantId: string;
    year: number;
    month: number; // 1-12
    /** 自事業所の 地域単価 (offices.unit_price)。未指定 10.0 */
    unitPrice?: number;
    /**
     * 自事業所の applied_formula_codes (処遇改善等)。
     * kaigo_office_addon_periods に対象月が期間内の行がある場合はそちらを優先。
     */
    appliedFormulaCodes?: string[];
  },
): Promise<MonthlySeikyuResult> {
  const monthStr = `${opts.year}-${String(opts.month).padStart(2, "0")}`;
  const daysInMonth = new Date(opts.year, opts.month, 0).getDate();
  const from = `${monthStr}-01`;
  const to = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;

  // 0) kaigo_visit_schedule の新列の有無を probe (契約 C3/C5。migration は別途)
  //    - office_id (C5): あれば「自事業所 + 未設定 (移行期)」に絞る
  //    - kinkyu_houmon (C3): あれば緊急時訪問介護加算の回数をシフト実績から数える
  //    列未適用 (42703) は従来動作にフォールバック。
  const probeColumn = async (col: string): Promise<boolean> => {
    const { error } = await supabase
      .from("kaigo_visit_schedule")
      .select(col)
      .limit(1);
    if (!error) return true;
    if (isColumnMissing(error)) return false;
    throw new Error(`実績列の確認に失敗 (${col}): ${error.message}`);
  };
  const [hasOfficeCol, hasKinkyuCol] = await Promise.all([
    opts.officeId ? probeColumn("office_id") : Promise.resolve(false),
    probeColumn("kinkyu_houmon"),
  ]);
  if (opts.officeId && !hasOfficeCol) {
    console.warn(
      "[visit-seikyu] kaigo_visit_schedule.office_id 未適用 — 従来どおり全事業所の実績で集計します (migration 適用後は自事業所 + office_id 未設定分に絞られます)",
    );
  }

  // 1) 実績 (completed) を月範囲で取得 (order 付き page-loop)
  interface ScheduleRow {
    user_id: string;
    service_type: string;
    visit_date: string;
    kinkyu_houmon?: boolean | null;
  }
  const PAGE = 1000;
  const schedules: ScheduleRow[] = [];
  const selectCols =
    "user_id, service_type, visit_date" + (hasKinkyuCol ? ", kinkyu_houmon" : "");
  let offset = 0;
  while (true) {
    let q = supabase
      .from("kaigo_visit_schedule")
      .select(selectCols)
      .eq("status", "completed")
      .gte("visit_date", from)
      .lte("visit_date", to);
    if (opts.officeId && hasOfficeCol) {
      // C5: 自事業所 + office_id 未設定 (移行期データ) のみ
      q = q.or(`office_id.eq.${opts.officeId},office_id.is.null`);
    }
    const { data, error } = await q
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`実績取得失敗: ${error.message}`);
    const rows = (data ?? []) as unknown as ScheduleRow[];
    schedules.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  if (schedules.length === 0) {
    return { rows: [], sougouRows: [], month: monthStr, recordCount: 0, warnings: [], warningsByClient: {} };
  }

  const warnings: string[] = [];
  const warningsByClient = new Map<string, string[]>();
  /** 利用者に紐付く warning を積む (行内⚠バッジ用の索引も同時に作る) */
  const pushClientWarning = (clientId: string, msg: string) => {
    warnings.push(msg);
    if (!warningsByClient.has(clientId)) warningsByClient.set(clientId, []);
    warningsByClient.get(clientId)!.push(msg);
  };

  // 2) service_name → units / short_name のマスタ
  // マスタは全角数字 (身体介護３) / schedule は半角混在のため
  // variants で検索し、正規化キー (半角) で引く
  const serviceTypes = Array.from(new Set(schedules.map((s) => s.service_type)));
  const unitByNorm = new Map<string, { units: number; short: string | null; code: string | null; system: string }>();
  const variants = serviceNameVariantsAll(serviceTypes);
  // 同名が複数制度にある場合は 介護 > 総合事業 > 独自 > 障害 の優先で採用
  const SYSTEM_PRIORITY: Record<string, number> = { 介護: 0, 総合事業: 1, 独自: 2, 障害: 3 };
  // .in() の URL 長対策で 50 件ずつ chunk
  // 有効期間: 改定跨ぎで同名の世代が複数あるため、対象月に有効な世代のみ採用する
  for (let i = 0; i < variants.length; i += NAME_IN_CHUNK) {
    const chunk = variants.slice(i, i + NAME_IN_CHUNK);
    const { data, error } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_name, short_name, units, service_code, system")
        .in("service_name", chunk)
        .eq("calculation_type", "基本"),
      opts.year,
      opts.month,
    );
    if (error) throw new Error(`サービスコード取得失敗: ${error.message}`);
    for (const r of (data ?? []) as { service_name: string; short_name: string | null; units: number; service_code: string | null; system: string }[]) {
      const key = toHankakuDigits(r.service_name);
      const prev = unitByNorm.get(key);
      if (!prev || (SYSTEM_PRIORITY[r.system] ?? 9) < (SYSTEM_PRIORITY[prev.system] ?? 9)) {
        unitByNorm.set(key, { units: r.units, short: r.short_name, code: r.service_code, system: r.system });
      }
    }
  }
  const unitByName = {
    get: (name: string) => unitByNorm.get(toHankakuDigits(name)),
  };

  // 2.2) 高齢者虐待防止措置未実施減算 / 業務継続計画(BCP)未策定減算 (各1%)。
  //     訪問介護 (介護 system) には独立減算コードが無く、基本コードの合成
  //     バリエーション (「身体介護２・虐防・業未」等) で算定するため、
  //     事業所フラグ (kaigo_office_gensan_periods) が対象月に適用中なら
  //     基本サービス行のマスタ解決を変種名へ差し替える (障害・総合事業は対象外)。
  //     テーブル未適用は空 = 従来動作 (減算なし)。解決不能時は元コード + warning。
  const gensanOverride = new Map<
    string,
    { units: number; short: string | null; code: string | null; name: string }
  >();
  if (opts.officeId) {
    const gensanFlags = gensanFlagsFromPeriods(
      await getGensanPeriodsForMonth(supabase, opts.officeId, monthStr),
    );
    if (gensanFlags.gyakutai || gensanFlags.bcp) {
      const label = gensanFlagsLabel(gensanFlags);
      const targetTypes = serviceTypes.filter(
        (t) => unitByNorm.get(toHankakuDigits(t))?.system === "介護",
      );
      const resolved = await Promise.all(
        targetTypes.map((t) =>
          resolveGensanVariant(supabase, t, gensanFlags, opts.year, opts.month),
        ),
      );
      targetTypes.forEach((svcType, i) => {
        const v = resolved[i];
        if (v) {
          gensanOverride.set(svcType, {
            units: v.units,
            short: v.short ?? unitByName.get(svcType)?.short ?? null,
            code: v.code,
            name: v.name,
          });
        } else {
          console.warn(
            `[visit-seikyu] 減算バリエーション未解決: 「${svcType}」 (${label})`,
          );
          warnings.push(
            `「${svcType}」の減算適用コード (${label}) が対象月 (${monthStr}) のマスタから引けません — 元のコードのまま (減算なしで) 集計します`,
          );
        }
      });
    }
  }

  // 2.5) 実績単位の月次加算 (初回 / 緊急時 / 生活機能向上連携)
  //     利用者×月×事業所のフラグを読み、該当利用者の明細に加算行として追加する。
  //     単位数はハードコードせず kaigo_service_codes から対象月の有効世代で引く。
  //     入力経路は 2 系統あり、両方を読んでフラグに正規化してマージする:
  //       a. kaigo_visit_month_addons (旧 3固定フラグ。書込 UI は撤去済みの移行期データ)
  //       b. kaigo_visit_addon_lines (現行の月次加算エディタ = 提供表 provision-tickets)
  //     santei_date (算定日。migrations/month_addon_santei_date.sql) 列があれば読み、
  //     保険者変更のレセプト分割 / 公費期間按分の判定に使う (列未適用・NULL = 従来動作)。
  interface MonthAddonFlags {
    shokai: boolean;
    seikatsuKino: string; // 'なし' | 'Ⅰ' | 'Ⅱ'
    kinkyuCount: number;
    /** 初回加算の算定日 (YYYY-MM-DD)。null = 未指定 (従来動作: 月末側計上 + warning) */
    shokaiDate: string | null;
    /** 生活機能向上連携加算の算定日。null = 未指定 (従来動作) */
    seikatsuDate: string | null;
  }
  const monthAddonByClient = new Map<string, MonthAddonFlags>();
  // 月次4コード以外の加算行 (提供表の加算エディタ = kaigo_visit_addon_lines 由来。
  // 認知症専門ケア加算・口腔連携強化加算 等)。「単位×回数」の加算行として明細に足す (2.6)。
  interface GenericAddonLine {
    code: string;
    count: number;
    /** 算定日。レセ分割のセグメント判定・公費期間按分に使う (null = 月末側 + 全量公費対象) */
    santeiDate: string | null;
  }
  const genericAddonsByClient = new Map<string, GenericAddonLine[]>();
  if (opts.officeId) {
    const getMonthAddonFlags = (clientId: string): MonthAddonFlags => {
      let f = monthAddonByClient.get(clientId);
      if (!f) {
        f = { shokai: false, seikatsuKino: "なし", kinkyuCount: 0, shokaiDate: null, seikatsuDate: null };
        monthAddonByClient.set(clientId, f);
      }
      return f;
    };
    // a) 旧 3固定テーブル。santei_date 列未適用 (42703) は従来列のみで再取得 (算定日 null)。
    //    order 付き page-loop (PostgREST 1000 行キャップ対策)
    {
      const baseSel = "client_id, shokai, seikatsu_kino, kinkyu_count";
      const fullSel = `${baseSel}, shokai_santei_date, seikatsu_santei_date`;
      interface MonthAddonDbRow {
        client_id: string;
        shokai: boolean | null;
        seikatsu_kino: string | null;
        kinkyu_count: number | null;
        shokai_santei_date?: string | null;
        seikatsu_santei_date?: string | null;
      }
      let sel = fullSel;
      let addonOffset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("kaigo_visit_month_addons")
          .select(sel)
          .eq("office_id", opts.officeId)
          .eq("target_month", monthStr)
          .order("id", { ascending: true })
          .range(addonOffset, addonOffset + PAGE - 1);
        if (error) {
          // santei_date 列未適用 → 従来列のみで同ページを再取得 (算定日 null)
          if (
            sel === fullSel &&
            error.code !== "42P01" &&
            error.code !== "PGRST205" &&
            isColumnMissing(error)
          ) {
            sel = baseSel;
            continue;
          }
          // テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) は
          // 加算なしで続行 (UI 側で「SQL未適用」バナー案内)。それ以外は握りつぶさない
          if (error.code === "42P01" || error.code === "PGRST205") break;
          throw new Error(`月次加算取得失敗: ${error.message}`);
        }
        const pageRows = (data ?? []) as unknown as MonthAddonDbRow[];
        for (const r of pageRows) {
          const f = getMonthAddonFlags(r.client_id);
          f.shokai = !!r.shokai;
          f.seikatsuKino = r.seikatsu_kino ?? "なし";
          f.kinkyuCount = r.kinkyu_count ?? 0;
          f.shokaiDate = r.shokai_santei_date ?? null;
          f.seikatsuDate = r.seikatsu_santei_date ?? null;
        }
        if (pageRows.length < PAGE) break;
        addonOffset += PAGE;
      }
    }
    // b) 現行の可変明細 (提供表の加算エディタが書く)。全加算コードを読み、
    //    月次4コード 初回(114001)/緊急時(114000)/生活機能向上Ⅰ(114003)/Ⅱ(114002) は
    //    旧フラグ形に正規化してマージ、それ以外は genericAddonsByClient に積んで
    //    2.6) で「単位×回数」の加算行として明細に足す。
    //    移行 SQL で両テーブルに同じ加算が入っている場合に二重計上しないよう
    //    boolean は OR、回数は max で合成する。
    {
      const MONTHLY_LINE_CODES = new Set(["114001", "114000", "114003", "114002"]);
      const baseSel = "client_id, addon_code, count";
      const fullSel = `${baseSel}, santei_date`;
      interface AddonLineDbRow {
        client_id: string;
        addon_code: string;
        count: number | null;
        santei_date?: string | null;
      }
      // santei_date / system 列未適用 (42703) は従来形で再取得。order 付き page-loop。
      // system='介護' フィルタ: 障害モードの加算行 (居介初回 116020 等) を介護請求に
      // 混入させない (同一 6 桁コードが両制度に存在するため必須)。列未適用時は
      // 障害行が存在し得ないので無フィルタ = 従来動作で安全。
      const lineRows: AddonLineDbRow[] = [];
      let sel = fullSel;
      let sysFilter = true;
      let lineOffset = 0;
      while (true) {
        let q = supabase
          .from("kaigo_visit_addon_lines")
          .select(sel)
          .eq("office_id", opts.officeId)
          .eq("target_month", monthStr);
        if (sysFilter) q = q.eq("system", "介護");
        const { data, error } = await q
          .order("id", { ascending: true })
          .range(lineOffset, lineOffset + PAGE - 1);
        if (error) {
          const colMissing =
            error.code !== "42P01" &&
            error.code !== "PGRST205" &&
            isColumnMissing(error);
          // どの列が無いかで落とすフィルタを選ぶ (両方無い場合も 2 回のリトライで収束)
          if (colMissing && sysFilter && String(error.message).includes("system")) {
            sysFilter = false;
            continue;
          }
          if (colMissing && sel === fullSel) {
            sel = baseSel;
            continue;
          }
          if (colMissing && sysFilter) {
            // 列名がメッセージから特定できない場合の最終手段: system フィルタを外す
            sysFilter = false;
            continue;
          }
          if (error.code === "42P01" || error.code === "PGRST205") break;
          throw new Error(`月次加算 (加算行) 取得失敗: ${error.message}`);
        }
        const pageRows = (data ?? []) as unknown as AddonLineDbRow[];
        lineRows.push(...pageRows);
        if (pageRows.length < PAGE) break;
        lineOffset += PAGE;
      }
      {
        for (const r of lineRows) {
          const count = r.count ?? 0;
          if (count <= 0) continue;
          const date = r.santei_date ?? null;
          if (!MONTHLY_LINE_CODES.has(r.addon_code)) {
            // 月次4コード以外 → 2.6) の汎用加算行へ
            if (!genericAddonsByClient.has(r.client_id)) {
              genericAddonsByClient.set(r.client_id, []);
            }
            genericAddonsByClient.get(r.client_id)!.push({
              code: r.addon_code,
              count,
              santeiDate: date,
            });
            continue;
          }
          const f = getMonthAddonFlags(r.client_id);
          if (r.addon_code === "114001") {
            f.shokai = true;
            if (date) f.shokaiDate = date;
          } else if (r.addon_code === "114000") {
            f.kinkyuCount = Math.max(f.kinkyuCount, count);
          } else {
            // 114002 (Ⅱ) / 114003 (Ⅰ)。両方の行がある異常データは上位 (Ⅱ) を採用
            const grade = r.addon_code === "114002" ? "Ⅱ" : "Ⅰ";
            if (f.seikatsuKino !== "Ⅱ") f.seikatsuKino = grade;
            if (date) f.seikatsuDate = date;
          }
        }
      }
    }
  }

  // 2.6) 提供表の加算エディタ由来の非月次加算コードを対象月世代のマスタで解決する。
  //     「単位×回数」で計算できる固定単位の加算のみ採用し、以下は二重計上・誤計算を
  //     防ぐため集計に載せない (利用者ループで warning を出す):
  //       - formula 持ち (処遇改善等の %加算) → 事業所単位の既存経路 (applied_formula_codes /
  //         kaigo_office_addon_periods) で自動計算するため、加算エディタ分は無視
  //       - calculation_type ≠ '加算' (同一建物減算・虐防/業未の合成コード等) →
  //         自動算定側 (same_building_tier / kaigo_office_gensan_periods) に倒す
  //       - units <= 0 (特別地域 118000 / 小規模 118100 / 中山間等提供 118110 /
  //         特定事業所Ⅴ 116410 等の率加算 = マスタ単位数 0) → 率の自動計算は未対応
  //       - 対象月に有効なマスタ世代なし
  //     addon_lines が空 (通常) はこの節は完全 no-op = 従来と同値。
  type GenericAddonMaster =
    | { ok: true; name: string; units: number; code: string }
    | { ok: false; name: string | null; reason: string };
  const genericAddonMaster = new Map<string, GenericAddonMaster>();
  {
    const codes = Array.from(
      new Set(
        Array.from(genericAddonsByClient.values()).flatMap((lines) =>
          lines.map((l) => l.code),
        ),
      ),
    );
    for (let i = 0; i < codes.length; i += ID_IN_CHUNK) {
      const chunk = codes.slice(i, i + ID_IN_CHUNK);
      const { data, error } = await validInMonth(
        supabase
          .from("kaigo_service_codes")
          .select("service_code, service_name, units, calculation_type, formula")
          .eq("system", "介護")
          .in("service_code", chunk),
        opts.year,
        opts.month,
      );
      if (error) throw new Error(`加算行コード解決失敗: ${error.message}`);
      for (const r of (data ?? []) as {
        service_code: string;
        service_name: string;
        units: number;
        calculation_type: string | null;
        formula: unknown;
      }[]) {
        if (genericAddonMaster.has(r.service_code)) continue; // 先勝ち (validInMonth 済)
        if (r.formula != null) {
          genericAddonMaster.set(r.service_code, {
            ok: false,
            name: r.service_name,
            reason:
              "%加算 (処遇改善等) は事業所の適用加算 (マスタ管理 → 自事業所管理) 側で自動計算するため、加算エディタからは集計しません",
          });
        } else if (r.calculation_type !== "加算") {
          genericAddonMaster.set(r.service_code, {
            ok: false,
            name: r.service_name,
            reason: `加算コードではありません (${r.calculation_type ?? "区分不明"}) — 減算等は自動算定側で計上するため、加算エディタからは集計しません`,
          });
        } else if (!(r.units > 0)) {
          genericAddonMaster.set(r.service_code, {
            ok: false,
            name: r.service_name,
            reason:
              "マスタ単位数が 0 の率加算 (特別地域/中山間等) のため自動計算できません — 手動対応してください",
          });
        } else {
          genericAddonMaster.set(r.service_code, {
            ok: true,
            name: r.service_name,
            units: r.units,
            code: r.service_code,
          });
        }
      }
    }
    for (const c of codes) {
      if (!genericAddonMaster.has(c)) {
        genericAddonMaster.set(c, {
          ok: false,
          name: null,
          reason: `対象月 (${monthStr}) に有効なマスタ世代 (system=介護) から引けません`,
        });
      }
    }
  }

  // C3: 緊急時訪問介護加算の回数。kinkyu_houmon 列があれば
  // 「completed かつ kinkyu_houmon=true」のシフト行の訪問日を利用者×月で集める
  // (回数 = 配列長。保険者変更の分割時は訪問日でセグメント判定する — Phase 2)。
  // 列未適用 (42703) は従来どおり kaigo_visit_month_addons.kinkyu_count にフォールバック。
  const kinkyuDatesByUser = new Map<string, string[]>();
  if (hasKinkyuCol) {
    for (const s of schedules) {
      if (s.kinkyu_houmon) {
        if (!kinkyuDatesByUser.has(s.user_id)) kinkyuDatesByUser.set(s.user_id, []);
        kinkyuDatesByUser.get(s.user_id)!.push(s.visit_date);
      }
    }
  }

  // 加算マスタ (単位数・コード)。service_name は実 DB で確認済みの正式名称
  // (訪問介護 service_category=11 / system=介護。単位数は世代管理 validInMonth で解決)
  const MONTH_ADDON_NAMES = {
    shokai: "訪問介護初回加算", // 114001
    kinkyu: "緊急時訪問介護加算", // 114000
    seikatsuI: "訪問介護生活機能向上連携加算Ⅰ", // 114003
    seikatsuII: "訪問介護生活機能向上連携加算Ⅱ", // 114002
  } as const;
  // 単位数・service_code のみ使用。short_name は system 跨ぎの backfill で汚染されている
  // (介護 114001 が障害の通院系に上書き) ため取得しない → 表示は固定ラベル (pushMonthAddon)
  const monthAddonMaster = new Map<string, { units: number; code: string | null }>();
  const hasAnyMonthAddon =
    Array.from(monthAddonByClient.values()).some(
      (f) => f.shokai || f.kinkyuCount > 0 || f.seikatsuKino === "Ⅰ" || f.seikatsuKino === "Ⅱ",
    ) || kinkyuDatesByUser.size > 0;
  if (hasAnyMonthAddon) {
    const { data, error } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_name, units, service_code")
        .eq("system", "介護")
        .eq("service_category", "11")
        .in("service_name", Object.values(MONTH_ADDON_NAMES)),
      opts.year,
      opts.month,
    );
    if (error) throw new Error(`月次加算コード取得失敗: ${error.message}`);
    for (const r of (data ?? []) as {
      service_name: string;
      units: number;
      service_code: string | null;
    }[]) {
      monthAddonMaster.set(r.service_name, {
        units: r.units,
        code: r.service_code,
      });
    }
  }

  // 3) 利用者情報 (clients + 対象月に有効な認定)
  const userIds = Array.from(new Set(schedules.map((s) => s.user_id)));
  const clientById = new Map<
    string,
    { name: string; furigana: string | null; birth: string | null; gender: string | null; userNumber: string | null }
  >();
  for (let i = 0; i < userIds.length; i += ID_IN_CHUNK) {
    const chunk = userIds.slice(i, i + ID_IN_CHUNK);
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, furigana, birth_date, gender, user_number")
      .in("id", chunk);
    if (error) throw new Error(`利用者取得失敗: ${error.message}`);
    for (const c of (data ?? []) as { id: string; name: string; furigana: string | null; birth_date: string | null; gender: string | null; user_number: string | null }[]) {
      clientById.set(c.id, { name: c.name, furigana: c.furigana, birth: c.birth_date, gender: c.gender, userNumber: c.user_number });
    }
  }
  const nameOf = (userId: string) => clientById.get(userId)?.name ?? userId;

  // 3.2) 同一建物減算区分 (client_office_assignments.same_building_tier)
  //     利用者×自事業所の属性 (月非依存)。null = 減算なし。
  //     列未適用 (42703 / PGRST204) は空 Map = 減算なしでフォールバック。
  const sameBuildingTierByClient = new Map<string, SameBuildingTier>();
  if (opts.officeId) {
    // .in() の URL 長対策で他の fetch と同じく 50 件ずつ chunk
    for (let i = 0; i < userIds.length; i += ID_IN_CHUNK) {
      const chunk = userIds.slice(i, i + ID_IN_CHUNK);
      const { data, error } = await supabase
        .from("client_office_assignments")
        .select("client_id, same_building_tier")
        .eq("office_id", opts.officeId)
        .in("client_id", chunk)
        .not("same_building_tier", "is", null);
      if (error) {
        // 列未適用 (直 SQL=42703 / PostgREST schema cache=PGRST204) は減算なしで続行。
        // それ以外は握りつぶさない。
        if (error.code !== "42703" && error.code !== "PGRST204" && !isColumnMissing(error)) {
          throw new Error(`同一建物減算区分取得失敗: ${error.message}`);
        }
        break; // 列未適用は以降の chunk も同じ結果 = 全体を減算なしにフォールバック
      }
      for (const r of (data ?? []) as {
        client_id: string;
        same_building_tier: string | null;
      }[]) {
        const t = r.same_building_tier;
        if (t === "1" || t === "2" || t === "3") {
          sameBuildingTierByClient.set(r.client_id, t);
        }
      }
    }
  }

  // 同一建物減算コード (114114/5/6) を対象月世代で解決 (units はマスタ 0 のため率は制度定数を使う)。
  // 該当利用者がいる場合のみ引く。引けないコードは減算行生成時に warning + コード定数で出す。
  const sameBuildingCodeMaster = new Map<string, string>(); // code -> service_name
  if (sameBuildingTierByClient.size > 0) {
    const codes = Object.values(SAME_BUILDING_REDUCTION).map((r) => r.code);
    const { data, error } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_code, service_name")
        .eq("system", "介護")
        .eq("service_category", "11")
        .in("service_code", codes),
      opts.year,
      opts.month,
    );
    if (error) throw new Error(`同一建物減算コード取得失敗: ${error.message}`);
    for (const r of (data ?? []) as { service_code: string; service_name: string }[]) {
      if (!sameBuildingCodeMaster.has(r.service_code)) {
        sameBuildingCodeMaster.set(r.service_code, r.service_name);
      }
    }
  }

  // 認定情報は「対象月に有効な認定」で解決する (共有リゾルバ)。
  // 月遅れ再請求は元提供月で aggregate されるため自然に当時の認定になる。
  const certByClient = await resolveCertForMonth(supabase, userIds, opts.year, opts.month);
  // 月途中の資格変更 (区分変更 / 保険者変更) の検出と限度額決定用に、
  // 対象月に有効な「全」認定行 (start 昇順) も引く (Phase 1)。
  const certsInMonthByClient = await resolveCertsInMonth(
    supabase,
    userIds,
    opts.year,
    opts.month,
  );

  // 旧 public_expense テキスト (認定タブの自由記入)。resolveCertForMonth は
  // この列を持たないため別途取得する。用途は
  //   - client_kohi_records あり環境: 「テキストあり・公費レコード未登録」warning のみ
  //   - client_kohi_records 未作成環境: 従来どおり公費扱いのフォールバック
  const publicExpenseTextByClient = new Map<string, string>();
  for (let i = 0; i < userIds.length; i += ID_IN_CHUNK) {
    const chunk = userIds.slice(i, i + ID_IN_CHUNK);
    const { data, error } = await supabase
      .from("client_insurance_records")
      .select("client_id, public_expense, effective_date")
      .in("client_id", chunk)
      .order("effective_date", { ascending: false });
    if (error) throw new Error(`保険情報 (公費テキスト) 取得失敗: ${error.message}`);
    for (const r of (data ?? []) as { client_id: string; public_expense: string | null }[]) {
      if (publicExpenseTextByClient.has(r.client_id)) continue; // 最新のみ
      const t = r.public_expense?.trim();
      if (t) publicExpenseTextByClient.set(r.client_id, t);
    }
  }

  // 3.5) 公費 (生活保護等) — client_kohi_records から対象月に有効な公費を
  //     「全件・適用優先順」で解決する (複数公費の併用対応。2026-07。
  //      優先順: priority → 制度優先順位表 → start_date。テーブル未作成時は
  //      旧 client_insurance_records.kohi_* (1 件) にフォールバック → lib/kohi.ts 参照)。
  //     上位 2 件までカスケード (保険 → 公費1 → 公費2 → 本人)。3 件以上は warning。
  //     honninFutan (本人負担上限月額) は 5) の金額計算で
  //     本人負担 = min(保険給付後負担, 上限) / 公費請求 = 残り として反映する。
  const kohiRes = await resolveKohisForMonth(supabase, userIds, opts.year, opts.month);

  // 4) 処遇改善加算の rate — 適用加算コードの formula をマスタから取得
  //    (monthly_aggregate: 所定単位 × numerator/denominator)
  //    解決順序:
  //      a. kaigo_office_addon_periods (期間指定) — 対象月が期間内の行があればその formula_code を優先
  //         (期中の区分変更「5月まで処遇改善Ⅱ・6月からⅡ2」等に対応)
  //      b. 該当 0 件 (テーブル未作成 42P01 含む) なら offices.applied_formula_codes にフォールバック
  let addonNum = 0;
  let addonDen = 1;
  let addonLabel: string | null = null;
  let addonCode: string | null = null;
  let effectiveFormulaCodes: string[] = opts.appliedFormulaCodes ?? [];
  if (opts.officeId) {
    const { data: periodRows, error: periodError } = await supabase
      .from("kaigo_office_addon_periods")
      .select("formula_code, start_month, end_month")
      .eq("office_id", opts.officeId);
    if (periodError) {
      // テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) は
      // 従来どおりフォールバック (それ以外は握りつぶさない)
      if (periodError.code !== "42P01" && periodError.code !== "PGRST205") {
        throw new Error(`加算期間取得失敗: ${periodError.message}`);
      }
    } else {
      const inMonth = ((periodRows ?? []) as {
        formula_code: string;
        start_month: string | null;
        end_month: string | null;
      }[]).filter(
        (r) =>
          (r.start_month == null || r.start_month <= monthStr) &&
          (r.end_month == null || r.end_month >= monthStr),
      );
      if (inMonth.length > 0) {
        effectiveFormulaCodes = inMonth.map((r) => r.formula_code);
      }
    }
  }
  if (effectiveFormulaCodes.length > 0) {
    // 有効期間: 同一 service_code の世代が複数あるため対象月の世代の formula を採用
    const { data, error } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_code, service_name, formula")
        .in("service_code", effectiveFormulaCodes)
        .eq("system", "介護")
        .not("formula", "is", null),
      opts.year,
      opts.month,
    );
    if (error) throw new Error(`加算コード取得失敗: ${error.message}`);
    for (const r of (data ?? []) as {
      service_code: string;
      service_name: string;
      formula: { type?: string; numerator?: number; denominator?: number } | null;
    }[]) {
      const f = r.formula;
      if (f?.type === "monthly_aggregate" && f.numerator && f.denominator) {
        // 処遇改善Ⅰ〜Ⅳ は排他のため最初の 1 件を採用
        addonNum = f.numerator;
        addonDen = f.denominator;
        addonLabel = r.service_name;
        addonCode = r.service_code;
        break;
      }
    }
  }

  // 4.5) 担当居宅介護支援事業所番号 (国保連伝送の基本情報レコード用)
  const careOfficeIds = Array.from(
    new Set(
      Array.from(certByClient.values())
        .map((v) => v.care_office_id)
        .filter(Boolean) as string[],
    ),
  );
  // care_office_id は「care_offices」(ケアマネ事業所マスタ、office-app と共有) への FK。
  // 自社 offices ではないので注意 (誤って offices を引くと全員未設定になる)
  const officeNumberById = new Map<string, string | null>();
  const officeNameById = new Map<string, string | null>();
  if (careOfficeIds.length > 0) {
    // .in() の URL 長・PostgREST 1000 行キャップ対策で 50 件ずつ chunk
    // (id は PK のため 1 chunk の結果は最大 50 行 = page-loop 不要)
    for (let i = 0; i < careOfficeIds.length; i += ID_IN_CHUNK) {
      const chunk = careOfficeIds.slice(i, i + ID_IN_CHUNK);
      const { data, error } = await supabase
        .from("care_offices")
        .select("id, office_number, name")
        .in("id", chunk)
        .order("id", { ascending: true });
      if (error) throw new Error(`居宅事業所取得失敗: ${error.message}`);
      for (const o of (data ?? []) as { id: string; office_number: string | null; name: string | null }[]) {
        officeNumberById.set(o.id, o.office_number);
        officeNameById.set(o.id, o.name);
      }
    }
  }

  // 4.7) 区分支給限度基準の基準値: 計画単位数 (kaigo_monthly_plan_units)
  //     月次情報タブで設定する「自事業所分の区分支給限度基準内単位数」。
  //     あればこれが基準値、無ければ認定の限度額 (service_limit_amount) にフォールバック。
  //     テーブル未作成 (42P01/PGRST205) は計画なしとして続行。
  const planUnitsByClient = new Map<string, number>();
  {
    let planTableMissing = false;
    for (let i = 0; i < userIds.length && !planTableMissing; i += ID_IN_CHUNK) {
      const chunk = userIds.slice(i, i + ID_IN_CHUNK);
      const { data, error } = await supabase
        .from("kaigo_monthly_plan_units")
        .select("client_id, planned_units")
        .eq("target_month", `${monthStr}-01`)
        .in("client_id", chunk);
      if (error) {
        if (error.code === "42P01" || error.code === "PGRST205") {
          planTableMissing = true;
          break;
        }
        throw new Error(`計画単位数取得失敗: ${error.message}`);
      }
      for (const r of (data ?? []) as { client_id: string; planned_units: number | null }[]) {
        // 0 は「未設定」扱い (認定限度額フォールバックへ)
        if (r.planned_units != null && r.planned_units > 0) {
          planUnitsByClient.set(r.client_id, r.planned_units);
        }
      }
    }
  }

  // 4.8) 限度額超過の割振り (kaigo_gendo_allocation = 利用票別表の超過欄)。
  //     ケアマネが手割振り (source='manual') した自 office の over_units があれば
  //     それを超過自費単位の真値として優先する。テーブル未作成 (42P01/PGRST205) は
  //     空 Map が返るので自動的に機械判定へフォールバック。
  const gendoMap: Map<string, GendoAllocationLine[]> = opts.officeId
    ? await getGendoAllocationMap(supabase, userIds, monthStr)
    : new Map();

  const unitPrice = opts.unitPrice && opts.unitPrice > 0 ? opts.unitPrice : 10.0;
  // 整数演算用: 単価 ×100 (10.00円 → 1000)。float 直乗算の 1円ズレ防止 (build-kyotaku.ts と同方式)
  const unitPrice100 = Math.round(unitPrice * 100);

  // 5) 利用者ごとに集計
  // 障害福祉サービスは介護保険請求の対象外 (障害請求側で扱う) のため除外。
  // 総合事業 (A2 等) は別様式 (7112/様式(予)) なので介護給付と分離し、
  // aggregateSougouSeikyu で独立集計する (混ぜない)。
  // service_type ごとに訪問日 list を保持する (回数 = 配列長。
  // 公費適用期間が月の一部の場合の「公費対象回数」判定に日付を使う)
  const byUser = new Map<string, Map<string, string[]>>(); // user_id → (service_type → 訪問日[])
  const visitDatesByUser = new Map<string, string[]>(); // user_id → 訪問日 list (入院重なり件数用)
  // 総合事業に該当する実績シフト (別ストリームで集計する)
  const sougouSchedules: { user_id: string; service_type: string; visit_date: string }[] = [];
  for (const s of schedules) {
    const system = unitByNorm.get(toHankakuDigits(s.service_type))?.system;
    if (system === "障害") continue;
    if (system === "総合事業") {
      sougouSchedules.push({
        user_id: s.user_id,
        service_type: s.service_type,
        visit_date: s.visit_date,
      });
      continue;
    }
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, new Map());
    const m = byUser.get(s.user_id)!;
    if (!m.has(s.service_type)) m.set(s.service_type, []);
    m.get(s.service_type)!.push(s.visit_date);
    if (!visitDatesByUser.has(s.user_id)) visitDatesByUser.set(s.user_id, []);
    visitDatesByUser.get(s.user_id)!.push(s.visit_date);
  }

  // 総合事業ストリームの集計 (別様式 7112)。処遇改善率は事業所の適用加算コードから解決する
  // (effectiveFormulaCodes は上の 4) で kaigo_office_addon_periods / applied_formula_codes を反映済)。
  let sougouRows: UserSeikyuRow[] = [];
  {
    const { rows: sr, warnings: sw, warningsByClient: swByClient } = await aggregateSougouSeikyu(
      supabase,
      sougouSchedules,
      {
        officeId: opts.officeId,
        year: opts.year,
        month: opts.month,
        unitPrice,
        effectiveFormulaCodes,
      },
    );
    sougouRows = sr;
    warnings.push(...sw);
    for (const [cid, msgs] of Object.entries(swByClient)) {
      if (!warningsByClient.has(cid)) warningsByClient.set(cid, []);
      warningsByClient.get(cid)!.push(...msgs);
    }
  }

  // 5.2) 入退院との重なり検出 (client_hospitalizations。テーブル未作成は空 Map)
  //     入院期間中の completed 実績は返戻リスク → warning (介護請求タブのバナーに出す)
  {
    const hospMap = await getHospitalizationMap(supabase, userIds);
    for (const [userId, dates] of visitDatesByUser) {
      const periods = hospitalizationsInRange(hospMap.get(userId), from, to);
      for (const p of periods) {
        // 退院日当日は退院済み扱い (isHospitalizedOn と同じ半開区間)
        const n = dates.filter(
          (d) => d >= p.admission_date && (p.discharge_date === null || d < p.discharge_date),
        ).length;
        if (n > 0) {
          pushClientWarning(
            userId,
            `${nameOf(userId)}さん: 入院期間中 (${fmtMD(p.admission_date)}〜${p.discharge_date ? fmtMD(p.discharge_date) : "入院中"}) の実績が${n}件あります — 実績を確認してください`,
          );
        }
      }
    }
  }

  const rows: UserSeikyuRow[] = [];

  // 利用者単位で 1 回だけ出す warning (レセ分割時に buildRowForSegment が
  // セグメントごとに呼ばれても同じ注意を重複出力しないためのガード)
  const warnedOnceKeys = new Set<string>();
  const warnOncePerUser = (key: string, clientId: string, msg: string) => {
    if (warnedOnceKeys.has(key)) return;
    warnedOnceKeys.add(key);
    pushClientWarning(clientId, msg);
  };

  // ── 1 セグメント (通常 = 月全体で 1 利用者 1 行) 分の請求行を組み立てる ──
  // Phase 2 (保険者変更のレセプト分割) で per-user 集計本体を関数抽出した。
  // seg.segCount === 1 のとき従来 (Phase 1) のコードパスと同値になるよう、
  // 分割固有の分岐はすべて seg.segCount > 1 (または !seg.isLast) でガードしている。
  interface SegmentInput {
    /** セグメント番号 (0 始まり) */
    segIndex: number;
    /** 総セグメント数。1 = 分割なし (従来コードパス) */
    segCount: number;
    /** セグメント期間 開始 'YYYY-MM-DD' (分割なしは月初) */
    segFrom: string;
    /** セグメント期間 終了 'YYYY-MM-DD' (分割なしは月末) */
    segTo: string;
    /** 月末側セグメントか (算定日を特定できない月次加算の計上先) */
    isLast: boolean;
    /** このセグメントに適用する認定 */
    cert: CertForMonth | null;
    /** 分割なし時の従来 limitAmount (区分変更月の max 適用済)。分割時は未使用 */
    monthLimitAmount: number | null;
    /**
     * 分割時 (segCount > 1) の区分支給限度基準額 = セグメント期間に重なる「全」認定の
     * service_limit_amount の max (CertSegment.limitAmount 由来)。同一保険者内の
     * 区分変更 (降格含む) がセグメント内にあっても「重い方」(施行規則68条1項) を適用する。
     * 分割なしは未使用 (monthLimitAmount を使う)。
     */
    segLimitAmount?: number | null;
    /**
     * 月次加算 (初回 / 生活機能向上連携) をこのセグメントに計上するか。
     * 分割時に算定日 (santei_date) からセグメントを特定できた場合に呼出側が設定する。
     * undefined = 従来判定 (月末側 isLast に計上 + warning)。分割なしは常に undefined。
     */
    monthAddonHere?: { shokai: boolean; seikatsu: boolean };
    /**
     * 非月次の加算行 (genericAddonsByClient) の計上先セグメント
     * (genericAddonsByClient 配列の行 index → segIndex。同一 addon_code が複数行
     * あっても行単位で帰属を保つ)。分割時に呼出側が算定日 (santei_date) で解決して
     * 設定する (算定日なし・期間外は月末側 = segCount-1 に解決済)。
     * undefined (分割なし) は全行を計上。
     */
    genericAddonSegIdx?: Map<number, number>;
  }
  const buildRowForSegment = (
    userId: string,
    typeCounts: Map<string, string[]>, // service_type → セグメント期間内の訪問日[]
    seg: SegmentInput,
  ): UserSeikyuRow => {
    const client = clientById.get(userId);
    const cert = seg.cert;
    const userLabel = client?.name ?? userId;
    // copay_rate は「割」単位 (1=1割, 2=2割, 3=3割) で格納されることが
    // あるため、1 以上は /10 して負担率に正規化する (0.1〜0.3 表記も許容)
    const copayRaw = cert?.copay_rate != null ? Number(cert.copay_rate) : null;
    const copay =
      copayRaw == null || !Number.isFinite(copayRaw) || copayRaw <= 0 ? 0.1
      : copayRaw >= 1 ? Math.min(copayRaw / 10, 1)
      : copayRaw;
    // 区分支給限度基準の基準値 (認定側):
    //   分割なし = 従来どおり月内認定の max (区分変更月対応。呼出側で計算済み)
    //   分割あり = 各セグメントの認定の限度額をそれぞれ満額適用
    //   ※「転居月は保険者ごとに支給限度基準額を満額適用」— 2026-07-11 一次資料で確認済:
    //     日割り/按分規定は存在しない。転居で被保険者資格が変わり暦月単位 (施行規則67条) の
    //     別管理になる。厚労省QA (平成13年8月29日事務連絡 vol.116)「月の途中で保険者が
    //     変わった場合、介護給付費明細書は2件提出」+ 国保連QA「支給限度額もそれぞれに管理」。
    //   分割時はセグメント期間に重なる全認定の max (segLimitAmount = 同一保険者内の
    //   区分変更がセグメント内にある場合も「重い方」施行規則68条1項) を使う。
    const limitAmount =
      seg.segCount > 1
        ? seg.segLimitAmount ??
          (cert?.service_limit_amount != null && Number(cert.service_limit_amount) > 0
            ? Number(cert.service_limit_amount)
            : null)
        : seg.monthLimitAmount;

    // ── 公費の解決 (明細行の公費対象回数を決めるため details 構築より前に行う) ──
    // 公費単独 (10割公費): 被保険者番号が 'H' 始まり = 介護保険未加入の生保受給者。
    const kohiTandoku = /^[Hh]/.test((cert?.insured_number ?? "").trim());
    // 公費 (生活保護等) — 公費タブ (client_kohi_records) から対象月に有効な公費を
    // 適用優先順で全件 (lib/kohi.ts resolveKohisForMonth)。
    // 分割時 (Phase 2) はセグメント期間と交差しない公費を落とす (期間の引き直し)
    const kohisMonth = kohiRes.byClient.get(userId) ?? [];
    const kohisInSeg =
      seg.segCount > 1
        ? kohisMonth.filter(
            (k) =>
              !(
                (k.start != null && k.start > seg.segTo) ||
                (k.end != null && k.end < seg.segFrom)
              ),
          )
        : kohisMonth;
    // 併用は 2 件まで (伝送様式は公費3まであるが、実務上 2 併用超は極めて稀。
    // 3 件以上は適用優先順の上位 2 件で計算し warning で確認を促す)
    if (kohisInSeg.length > 2) {
      // レセ分割時はセグメントごとに評価されるため利用者単位で 1 回だけ出す
      warnOncePerUser(
        `kohi3plus:${userId}`,
        userId,
        `${userLabel}: 対象月に有効な公費が ${kohisInSeg.length} 件あります — 適用優先順の上位 2 件 (${kohisInSeg
          .slice(0, 2)
          .map((k) => kohiHobetsuLabel(k.hobetsu))
          .join(" + ")}) のみで計算します。3 件目以降 (${kohisInSeg
          .slice(2)
          .map((k) => kohiHobetsuLabel(k.hobetsu))
          .join(", ")}) は手動対応してください`,
      );
    }
    const kohi = kohisInSeg[0] ?? null;
    let kohi2: ResolvedKohi | null = kohisInSeg[1] ?? null;
    if (kohi2 && kohiTandoku) {
      // 公費単独 (H番号 = 保険給付なし 10割公費) と複数公費の組合せは自動対応外。
      // 従来どおり第1公費のみ (全量振替) で計算する。
      pushClientWarning(
        userId,
        `${userLabel}: 公費単独 (被保険者番号 H) で公費が複数登録されています — 第1公費 (${kohiHobetsuLabel(kohi!.hobetsu)}) のみで計算します (公費単独の複数公費併用は自動対応外)。${kohiHobetsuLabel(kohi2.hobetsu)} は手動対応してください`,
      );
      kohi2 = null;
    }
    if (kohi2 && kohi!.hobetsu === "12") {
      // 生保 (法別12) は他法優先の原則 (生活保護法4条) で常に最劣後のはず。
      // priority 手入力で生保が先に来ている場合は計算順が制度と逆になる。
      pushClientWarning(
        userId,
        `${userLabel}: 生活保護 (法別12) が第1公費になっています (公費タブの優先順位を確認してください) — 生保は他法優先の原則により通常は最後に適用します`,
      );
    }
    // 公費適用期間が対象期間 (分割なしは対象月全体) の一部のみか
    // (月途中で開始/終了する介護券・受給者証)
    const kohiPartialMonth =
      !!kohi &&
      ((kohi.start != null && kohi.start > seg.segFrom) ||
        (kohi.end != null && kohi.end < seg.segTo));
    const inKohiPeriod = (d: string) =>
      !!kohi &&
      (kohi.start == null || d >= kohi.start) &&
      (kohi.end == null || d <= kohi.end);
    // 期間按分は「公費適用期間が月の一部のみ」の公費すべて
    // (Phase 1 で生保 法別12 の月途中開始/終了も按分に開放。2026-07)。
    // 公費単独 (H番号 10割) のみ従来どおり全量を公費対象とする (挙動保存)。
    const kohiProrate = !!kohi && !kohiTandoku && kohiPartialMonth;
    // 公費2 の期間按分 (考え方は公費1と同じ。公費2は kohiTandoku 時 null 済)
    const kohi2PartialMonth =
      !!kohi2 &&
      ((kohi2.start != null && kohi2.start > seg.segFrom) ||
        (kohi2.end != null && kohi2.end < seg.segTo));
    const inKohi2Period = (d: string) =>
      !!kohi2 &&
      (kohi2.start == null || d >= kohi2.start) &&
      (kohi2.end == null || d <= kohi2.end);
    const kohi2Prorate = !!kohi2 && kohi2PartialMonth;

    const details: SeikyuDetailLine[] = [];
    let grossBaseUnits = 0;
    // 基本サービス行の公費対象単位数 (同一建物減算の按分母数用)
    let kohiServiceBaseUnits = 0;
    let kohi2ServiceBaseUnits = 0;
    for (const [svcType, dates] of typeCounts) {
      const count = dates.length;
      // 虐防/業未 減算適用中は合成バリエーション (減算織込み済単位数) へ差し替える。
      // 加算行 (初回加算等の独立行 = 後段 pushMonthAddon) は差し替え対象外。
      const gensan = gensanOverride.get(svcType);
      const master = gensan ?? unitByName.get(svcType);
      const unitPer = master?.units ?? 0;
      // 身体介護9系 (units=0 の増分コード) は単独では請求単位にならない。
      // 実績に紛れていたら合成後の正しいサービスへ修正が必要なので warning。
      if (master && unitPer === 0) {
        pushClientWarning(
          userId,
          `${userLabel}: 「${svcType}」は単位数 0 の増分コード (身体介護9系等) です — 実績のサービス内容を確認してください`,
        );
      }
      const units = unitPer * count;
      grossBaseUnits += units;
      const line: SeikyuDetailLine = {
        service_type: gensan ? gensan.name : svcType,
        short_name: master?.short ?? null,
        service_code: master?.code ?? null,
        unit_per: unitPer,
        count,
        units,
      };
      if (kohi) {
        // 公費対象回数 = 公費適用期間内の実績のみ (全期間有効なら count と同値)
        const kc = kohiProrate ? dates.filter(inKohiPeriod).length : count;
        line.kohi_count = kc;
        line.kohi_units = unitPer * kc;
        kohiServiceBaseUnits += line.kohi_units;
      }
      if (kohi2) {
        const kc2 = kohi2Prorate ? dates.filter(inKohi2Period).length : count;
        line.kohi2_count = kc2;
        line.kohi2_units = unitPer * kc2;
        kohi2ServiceBaseUnits += line.kohi2_units;
      }
      details.push(line);
    }
    // この時点の grossBaseUnits = 所定単位数 (基本サービスのみ)。
    // 同一建物減算の母数は所定単位数のみ (加算には掛けない) なので、月加算より前に確定する。
    const serviceBaseUnits = grossBaseUnits;
    // 実績単位の月次加算行 (初回 / 緊急時×回数 / 生活機能向上連携Ⅰ・Ⅱ)。
    // grossBaseUnits (明細合計) には全て含めるが、区分支給限度基準の超過判定では
    // 初回加算・緊急時訪問介護加算 = 限度額管理対象外 (告示) を除外する。
    // 処遇改善等の%加算が対象外なのは従来どおり。
    // 限度額管理対象外の加算単位数 (初回・緊急時)。超過判定から除外し、常に保険給付側に付く
    let shokaiKinkyuUnits = 0;
    // 分割時 (Phase 2): 初回・生活機能向上連携は、算定日 (santei_date) があれば
    // 呼出側がセグメントを特定して seg.monthAddonHere で指定する。算定日なしは
    // 従来どおり月末側セグメント (isLast) に計上する。緊急時は kinkyu_houmon 列があれば
    // 訪問日でセグメント判定、無ければ (月次加算テーブルの回数のみ = 日付なし)
    // 月末側に全量。分割なし (segCount=1, isLast=true, monthAddonHere=undefined) は
    // 従来コードパスと同値。
    const flags = monthAddonByClient.get(userId);
    const shokaiOn = (seg.monthAddonHere?.shokai ?? seg.isLast) && (flags?.shokai ?? false);
    const seikatsuKino = (seg.monthAddonHere?.seikatsu ?? seg.isLast)
      ? flags?.seikatsuKino ?? "なし"
      : "なし";
    // C3: kinkyu_houmon 列があり該当利用者にシフト実績 (kinkyu_houmon=true) が
    // 1 件でもあればそれを真値とし、セグメント期間内の訪問日で数える。
    // シフト実績が 0 件の利用者は加算エディタ (114000) / 旧月次加算テーブルの
    // 回数 (flags.kinkyuCount) にフォールバック (isLast 計上・日付なし) —
    // 列が存在するだけでエディタ入力の回数が無視される過少請求を防ぐ。
    // 列未適用も同じフォールバック。
    const kinkyuShiftDatesAll = kinkyuDatesByUser.get(userId) ?? [];
    const kinkyuSegDates =
      hasKinkyuCol && kinkyuShiftDatesAll.length > 0
        ? kinkyuShiftDatesAll.filter((d) => d >= seg.segFrom && d <= seg.segTo)
        : null;
    const kinkyuCount =
      kinkyuSegDates != null
        ? kinkyuSegDates.length
        : seg.isLast
          ? flags?.kinkyuCount ?? 0
          : 0;
    // 公費期間按分時の月次加算の扱い (warning 文言用):
    //   pushed = 月次加算行を 1 件以上出した / fallback = 算定日なしで全量公費対象にした
    let monthAddonPushed = false;
    let monthAddonKohiFallback = false;
    if (shokaiOn || kinkyuCount > 0 || seikatsuKino === "Ⅰ" || seikatsuKino === "Ⅱ") {
      // ※ 表示名はマスタの short_name を使わず固定ラベルにする。
      //   kaigo_service_codes.short_name は system (介護/障害) を無視して backfill されており、
      //   介護 114001「訪問介護初回加算」の short_name が障害の通院系で汚染されているため
      //   (実 DB 確認済み)。単位数・service_code は従来どおりマスタから引く。
      const pushMonthAddon = (
        name: string,
        count: number,
        fixedLabel: string,
        kanriTaishougai: boolean, // true = 支給限度基準額管理の対象外 (初回・緊急時)
        // 算定日 (複数回算定の加算 = 緊急時は日ごとの配列)。公費期間按分の内外判定に
        // 使う (null / 空 = 従来: 全量公費対象)
        santeiDates: string[] | null,
      ) => {
        if (count <= 0) return;
        const m = monthAddonMaster.get(name);
        if (!m) {
          pushClientWarning(
            userId,
            `${userLabel}: 加算「${name}」の単位数がマスタから引けません (対象月に有効な世代なし)`,
          );
          return;
        }
        const units = m.units * count;
        grossBaseUnits += units;
        if (kanriTaishougai) shokaiKinkyuUnits += units;
        const line: SeikyuDetailLine = {
          service_type: name,
          short_name: fixedLabel,
          service_code: m.code,
          unit_per: m.units,
          count,
          units,
        };
        if (kohi) {
          if (kohiProrate && santeiDates && santeiDates.length > 0) {
            // 算定日あり: 公費適用期間内の算定日のみ公費対象 (複数回は日ごとに数える)
            const kc = santeiDates.filter(inKohiPeriod).length;
            line.kohi_count = kc;
            line.kohi_units = m.units * kc;
          } else {
            // 算定日なし (従来): 月次加算は月単位の算定のため、公費期間が月の一部でも
            // 全量を公費対象とする (期間按分時は kohiPartialMonth の warning で要確認を出す)
            line.kohi_count = count;
            line.kohi_units = units;
            if (kohiProrate) monthAddonKohiFallback = true;
          }
        }
        if (kohi2) {
          if (kohi2Prorate && santeiDates && santeiDates.length > 0) {
            const kc2 = santeiDates.filter(inKohi2Period).length;
            line.kohi2_count = kc2;
            line.kohi2_units = m.units * kc2;
          } else {
            line.kohi2_count = count;
            line.kohi2_units = units;
            if (kohi2Prorate) monthAddonKohiFallback = true;
          }
        }
        details.push(line);
        monthAddonPushed = true;
      };
      // ★ 初回加算・緊急時訪問介護加算 = 区分支給限度基準額の【管理対象】(2026-07-17 ほのぼのKK
      //   突合で確定: 大網5名の初回加算200単位を ほのぼのは限度額管理対象=項9 に計上)。
      //   従来 対象外(告示)としていたのは誤り。対象外は処遇改善等%加算・特別地域・中山間のみ。
      //   → kanriTaishougai=false にして超過判定にも算入し、様式第二 集計「⑥対象外」から外す。
      //   生活機能向上連携も従来どおり管理対象。
      // 緊急時: シフト実績 (kinkyu_houmon) 由来は訪問日を算定日として公費期間の
      // 内外を日ごとに判定する (kinkyuSegDates はセグメント期間で絞り込み済み =
      // セグメント帰属も訪問日基準)。エディタ回数フォールバック分は日付なし → null = 従来。
      if (shokaiOn)
        pushMonthAddon(
          MONTH_ADDON_NAMES.shokai, 1, "初回加算", false,
          flags?.shokaiDate ? [flags.shokaiDate] : null,
        );
      pushMonthAddon(MONTH_ADDON_NAMES.kinkyu, kinkyuCount, "緊急時訪問介護加算", false, kinkyuSegDates);
      if (seikatsuKino === "Ⅰ")
        pushMonthAddon(
          MONTH_ADDON_NAMES.seikatsuI, 1, "生活機能向上連携加算Ⅰ", false,
          flags?.seikatsuDate ? [flags.seikatsuDate] : null,
        );
      if (seikatsuKino === "Ⅱ")
        pushMonthAddon(
          MONTH_ADDON_NAMES.seikatsuII, 1, "生活機能向上連携加算Ⅱ", false,
          flags?.seikatsuDate ? [flags.seikatsuDate] : null,
        );
    }
    // ── 提供表の加算エディタ由来の加算行 (月次4コード以外。2.6 で解決済) ──
    // 単位×回数 の固定単位加算 (認知症専門ケア・口腔連携強化 等)。
    // 限度額管理: 原則「管理対象」(告示の対象外 = 初回・緊急時・%加算系は
    // この経路に来ない) なので shokaiKinkyuUnits には足さない = 超過判定に含める。
    // レセ分割時は算定日でセグメント判定 (呼出側で解決済。算定日なしは月末側 + warning)。
    // 公費按分は月次加算と同じ: 算定日あり = 公費期間の内外で全量/0、なし = 全量 + 注記。
    // addon_lines が空なら no-op = 従来と完全同値。
    const genericLines = genericAddonsByClient.get(userId) ?? [];
    for (let gi = 0; gi < genericLines.length; gi++) {
      const g = genericLines[gi];
      const m = genericAddonMaster.get(g.code);
      if (!m || !m.ok) continue; // 未解決・対象外コードの warning は利用者ループ側で 1 回出す
      if (seg.segCount > 1) {
        // 帰属は行 index キー (同一 addon_code の複数行でも行単位で正しく振り分ける)
        const target = seg.genericAddonSegIdx?.get(gi) ?? seg.segCount - 1;
        if (target !== seg.segIndex) continue;
      }
      const units = m.units * g.count;
      grossBaseUnits += units;
      const line: SeikyuDetailLine = {
        service_type: m.name,
        // short_name はマスタの system 跨ぎ backfill 汚染 (pushMonthAddon の注記参照) を
        // 避けるため使わない → 表示は service_name そのまま
        short_name: null,
        service_code: m.code,
        unit_per: m.units,
        count: g.count,
        units,
      };
      if (kohi) {
        if (kohiProrate && g.santeiDate) {
          const kc = inKohiPeriod(g.santeiDate) ? g.count : 0;
          line.kohi_count = kc;
          line.kohi_units = m.units * kc;
        } else {
          line.kohi_count = g.count;
          line.kohi_units = units;
          if (kohiProrate) monthAddonKohiFallback = true;
        }
      }
      if (kohi2) {
        if (kohi2Prorate && g.santeiDate) {
          const kc2 = inKohi2Period(g.santeiDate) ? g.count : 0;
          line.kohi2_count = kc2;
          line.kohi2_units = m.units * kc2;
        } else {
          line.kohi2_count = g.count;
          line.kohi2_units = units;
          if (kohi2Prorate) monthAddonKohiFallback = true;
        }
      }
      details.push(line);
      monthAddonPushed = true;
    }
    // 期間按分 warning の月次加算 注記 (下の kohiPartialMonth warning 2 箇所で使う)。
    // 月次加算なし = 従来文言のまま / 全件算定日あり = 期間判定済みの旨に差し替え。
    const monthAddonKohiNote = !monthAddonPushed
      ? "月次加算は全量を公費対象にしています"
      : monthAddonKohiFallback
        ? "算定日未指定の月次加算は全量を公費対象にしています (提供表の月次加算で算定日を設定すると期間内外で判定します)"
        : "月次加算は算定日で公費期間の内外を判定しました";

    // ── 同一建物減算 (令和6年度〜) ──
    // 母数 = 所定単位数のみ (serviceBaseUnits = 基本サービス合計)。加算には掛けない。
    // 減算 = -round(所定単位数 × 率)。減算行を grossBaseUnits に反映 (月加算後・超過判定前) →
    // 区分支給限度基準・処遇改善% の母数へ自然に波及する。
    const sbTier = sameBuildingTierByClient.get(userId);
    if (sbTier && serviceBaseUnits > 0) {
      const { code, rate, label } = SAME_BUILDING_REDUCTION[sbTier];
      const reduction = -Math.round(serviceBaseUnits * rate);
      if (reduction < 0) {
        const resolvedName = sameBuildingCodeMaster.get(code);
        if (!resolvedName) {
          pushClientWarning(
            userId,
            `${userLabel}: 同一建物減算コード (${code}) が対象月 (${monthStr}) のマスタから引けません — コードのみで出力します`,
          );
        }
        const line: SeikyuDetailLine = {
          service_type: resolvedName ?? label,
          short_name: label,
          service_code: code,
          unit_per: reduction,
          count: 1,
          units: reduction,
        };
        if (kohi) {
          // 減算の公費対象分は公費対象の所定単位数を母数に按分 (全量公費なら reduction と同値)
          line.kohi_count = 1;
          line.kohi_units = kohiProrate
            ? -Math.round(Math.min(kohiServiceBaseUnits, serviceBaseUnits) * rate)
            : reduction;
        }
        if (kohi2) {
          line.kohi2_count = 1;
          line.kohi2_units = kohi2Prorate
            ? -Math.round(Math.min(kohi2ServiceBaseUnits, serviceBaseUnits) * rate)
            : reduction;
        }
        details.push(line);
        grossBaseUnits += reduction;
      }
    }

    details.sort((a, b) => b.units - a.units);

    // ── 区分支給限度基準の超過自費 (ほのぼの準拠) ──
    // 基準値 = 計画単位数 (あれば) > 認定限度額 (service_limit_amount)。どちらも無ければ管理なし。
    // ※ 処遇改善加算等の%加算は区分支給限度基準の「対象外」なので、
    //    超過判定は %加算前の単位数で行う (加算単位は超過に数えない)。
    // ※ 初回加算・緊急時訪問介護加算も限度額管理対象外 (告示) のため超過判定から除外する
    //    (shokaiKinkyuUnits)。除外分は常に保険給付側 (baseUnits) に残る。
    // 分割時 (Phase 2): 計画単位数・ケアマネ手割振りは利用者×月の 1 値で
    // セグメントに配分できないため使わず、各セグメントの認定限度額で機械判定する
    // (該当データがある利用者は呼出側で warning)。分割なしは従来どおり。
    const planUnits =
      seg.segCount > 1 ? null : planUnitsByClient.get(userId) ?? null;
    const limitUnits = planUnits ?? limitAmount;
    const managedUnits = grossBaseUnits - shokaiKinkyuUnits;
    // 超過単位の決定 (優先順):
    //   1. ケアマネの手割振り (利用票別表で確定した自 office の自費単位 = 真値)
    //   2. 機械判定 (管理対象単位 − 基準値)。別表未確定・テーブル未作成・officeId 無しはこちら
    const manualOver =
      opts.officeId && seg.segCount === 1
        ? resolveManualOverUnits(gendoMap.get(userId), opts.officeId)
        : null;
    const autoOver = limitUnits != null ? Math.max(0, managedUnits - limitUnits) : 0;
    // manual 値も自事業所の管理対象単位を超えては充当できない (baseUnits 負数防止)
    const overUnits = Math.min(manualOver ?? autoOver, managedUnits);
    const overSource: "manual" | "auto" = manualOver != null ? "manual" : "auto";
    // 基準内単位数 = 保険給付対象。超過分は保険請求から外し 10割自費 (selfPayAmount) へ振替
    const baseUnits = grossBaseUnits - overUnits;
    // 処遇改善等 (%加算) は保険請求対象の基準内単位数に対して計算する
    // (超過自費分には掛けない = 自費請求は素の単位×単価×10割)
    const addonUnits = addonNum > 0 ? Math.round((baseUnits * addonNum) / addonDen) : 0;
    // 限度額管理対象外単位数 (契約 C1) = 処遇改善等%加算 + 初回・緊急時
    const kanriTaishougaiUnits = addonUnits + shokaiKinkyuUnits;
    const totalUnits = baseUnits + addonUnits;
    // 金額は整数演算 (単価×100 を先に整数化) — float 直乗算の 1円ズレ防止
    const totalAmount = Math.floor((totalUnits * unitPrice100) / 100);
    // 超過分の全額自費額 (円) = floor(超過単位 × 単価 × 10割)
    const overAmount = Math.floor((overUnits * unitPrice100) / 100);
    // 国保連方式: 保険請求額 = 費用総額 × 給付率 (1円未満切捨)、利用者負担 = 差引
    // (端数は利用者負担側に乗る。先に負担額を切捨てると 1 円ずれる)。
    // 給付率も整数化: copay 0.1/0.2/0.3 → 1/2/3 で floor(総額 × (10−負担) / 10)
    const copayX10 = Math.min(10, Math.max(0, Math.round(copay * 10)));
    const insuranceAmount = kohiTandoku ? 0 : Math.floor((totalAmount * (10 - copayX10)) / 10);
    // 公費の扱い:
    //   - client_kohi_records あり環境: 公費レコード (kohi) と公費単独 (H番号) のみ公費扱い。
    //     旧 public_expense テキストだけの利用者は公費にしない (誤請求防止) — warning で案内。
    //   - テーブル未作成環境 (kohiRes.fallback): 従来どおりテキストもフォールバックとして採用。
    const peText = publicExpenseTextByClient.get(userId) ?? null;
    // 表示ラベル: 併用時は「法別54 (難病) + 法別12 (生活保護)」のように連結
    const kohiLabel = kohi
      ? kohiHobetsuLabel(kohi.hobetsu) +
        (kohi2 ? ` + ${kohiHobetsuLabel(kohi2.hobetsu)}` : "")
      : null;
    let publicExpense: string | null;
    if (kohiRes.fallback) {
      publicExpense =
        kohiLabel ??
        peText ??
        (kohiTandoku ? "公費単独 (生活保護 10割)" : null);
    } else {
      publicExpense =
        kohiLabel ??
        (kohiTandoku ? "公費単独 (生活保護 10割)" : null);
      if (!kohi && !kohiTandoku && peText) {
        pushClientWarning(
          userId,
          `${userLabel}: 保険情報に公費テキスト「${peText}」がありますが、公費レコード (利用者詳細の公費タブ) が未登録のため公費請求には含めません — 公費タブで登録してください`,
        );
      }
    }
    // ── 公費の金額計算 ──
    // 全量公費対象 (全額振替系) は 生保(法別12)・公費単独 のみ。
    // 保険優先の部分公費 (法別21/54/19 等) は「公費対象部分の保険給付後負担のうち、
    // 本人負担上限月額 (client_kohi_records.honnin_futan = 介護券・受給者証の本人支払額) までを
    // 本人負担、残りを公費請求」とする (2026-07 対応。従来は公費適用なし = 通常負担のままだった)。
    // 旧テキストのみ(fallback)は移行期の安全網として従来どおり全額振替。
    const kohiIsSeiho = kohiTandoku || kohi?.hobetsu === "12";
    // 全量振替 = フル月の生保 (法別12)・公費単独・旧テキストのみ (fallback)。
    // 月途中開始/終了の生保 (kohiProrate=true) は期間按分ブランチ
    // (honnin_futan 適用済) へ流す (Phase 1。2026-07)。
    const transferToKohi = (kohiIsSeiho && !kohiProrate) || (!!publicExpense && !kohi);
    // 本人負担上限月額 (負値・小数は防御的に整数化。レコード無しは 0 = 従来挙動)
    const honninLimit = kohi ? Math.max(0, Math.floor(kohi.honninFutan)) : 0;
    const honninLimit2 = kohi2 ? Math.max(0, Math.floor(kohi2.honninFutan)) : 0;

    let kohiUnits: number | null = null;
    let kohiTargetCost: number | null = null;
    let kohiTargetInsurance: number | null = null;
    let kohiHonninFutan: number | null = null;
    let kohiAmount: number | null = null;
    let kohi2Units: number | null = null;
    let kohi2TargetCost: number | null = null;
    let kohi2TargetInsurance: number | null = null;
    let kohi2HonninFutan: number | null = null;
    let kohi2Amount: number | null = null;
    let userAmount: number;
    if (kohi && kohi2) {
      // ── 複数公費の併用カスケード (2026-07): 保険 → 公費1 → 公費2 → 本人 ──
      // 公費負担医療は保険優先、複数公費は制度優先順位表 (lib/kohi.ts KOHI_HOBETSU_RANK)
      // の順に適用し、生保 (法別12) は他法優先の原則 (生活保護法4条) で最後 =
      // 他公費適用後の残りを負担する (典型例: 難病54 + 生保12)。
      //
      // 公費1: 単独時の「部分公費」ブランチと同一の式。
      //   フル月公費 (kohi_units = 全量) なら kohiUnits = totalUnits /
      //   kohiTargetCost = totalAmount / kohiTargetInsurance = insuranceAmount と
      //   なり単独時の全量振替ブランチとも一致する (= 式の一般化であって挙動変更ではない)。
      const k1DetailUnits = details.reduce((s, d) => s + (d.kohi_units ?? 0), 0);
      const k1Base = Math.min(k1DetailUnits, baseUnits);
      const k1Addon =
        addonNum > 0
          ? Math.min(addonUnits, Math.round((k1Base * addonNum) / addonDen))
          : 0;
      kohiUnits = k1Base + k1Addon;
      kohiTargetCost = Math.min(
        Math.floor((kohiUnits * unitPrice100) / 100),
        totalAmount,
      );
      kohiTargetInsurance = Math.floor((kohiTargetCost * (10 - copayX10)) / 10);
      const afterIns1 = kohiTargetCost - kohiTargetInsurance;
      kohiHonninFutan = Math.min(afterIns1, honninLimit);
      kohiAmount = afterIns1 - kohiHonninFutan;

      // 公費2: 自身の対象範囲 (適用期間) の保険給付後負担から「公費1が既に
      // 賄った分」を控除した残りを、本人負担上限月額 (honninLimit2) を除いて負担する。
      // 通常の併用 (公費2 = 生保 フル月) は 公費1範囲 ⊆ 公費2範囲 なので控除は正確。
      const k2DetailUnits = details.reduce((s, d) => s + (d.kohi2_units ?? 0), 0);
      const k2Base = Math.min(k2DetailUnits, baseUnits);
      const k2Addon =
        addonNum > 0
          ? Math.min(addonUnits, Math.round((k2Base * addonNum) / addonDen))
          : 0;
      kohi2Units = k2Base + k2Addon;
      kohi2TargetCost = Math.min(
        Math.floor((kohi2Units * unitPrice100) / 100),
        totalAmount,
      );
      kohi2TargetInsurance = Math.floor((kohi2TargetCost * (10 - copayX10)) / 10);
      const afterIns2 = kohi2TargetCost - kohi2TargetInsurance;
      // 保険 + 公費1 適用後の残負担 (公費2はこれを超えて請求できない = 恒等式の担保)
      const remaining = totalAmount - insuranceAmount - kohiAmount;
      const base2 = Math.min(Math.max(afterIns2 - kohiAmount, 0), remaining);
      kohi2HonninFutan = Math.min(base2, honninLimit2);
      kohi2Amount = base2 - kohi2HonninFutan;
      // 恒等式: 総額 = 保険 + 公費1 + 公費2 + 本人 (userAmount は残余で定義)
      userAmount = totalAmount - insuranceAmount - kohiAmount - kohi2Amount;

      // ── 併用時の確認 warning ──
      if (kohi2PartialMonth) {
        // 公費2 が月の一部のみ: 公費1充当分の控除が範囲の重なりを個別に見ない
        // 近似 (控除過大 = 公費2請求が過少側) のためレセプト確認を促す
        pushClientWarning(
          userId,
          `${userLabel}: 公費2 (${kohiHobetsuLabel(kohi2.hobetsu)}) の適用期間 (${kohi2.start ?? "制限なし"}〜${kohi2.end ?? "制限なし"}) が月の一部です — 公費1との適用範囲の重なりは概算 (公費1請求額を一律控除) のため、併用レセプトを確認してください`,
        );
      }
      if (kohiPartialMonth) {
        pushClientWarning(
          userId,
          `${userLabel}: 公費 (${kohiHobetsuLabel(kohi.hobetsu)}) の適用期間 (${kohi.start ?? "制限なし"}〜${kohi.end ?? "制限なし"}) が月の一部のため、公費対象単位数を期間内の実績 (${kohiUnits}/${totalUnits} 単位) に按分しました — ${monthAddonKohiNote}。レセプトを確認してください`,
        );
      }
      if (honninLimit === 0 && kohi.hobetsu !== "12") {
        // レセ分割時はセグメントごとに評価されるため利用者単位で 1 回だけ出す
        warnOncePerUser(
          `honnin0:${userId}:${kohi.hobetsu}`,
          userId,
          `${userLabel}: 公費 (${kohiHobetsuLabel(kohi.hobetsu)}) の本人負担上限月額が 0 円のため保険給付後の負担分を全額公費請求します — 介護券・受給者証の本人支払額を公費タブで確認してください`,
        );
      }
      if (kohiAmount === 0 && kohi2Amount > 0) {
        // 公費1の請求が 0 円 (本人負担上限が高く全額本人負担側に落ちた等) の場合、
        // 伝送・様式では公費1欄が空になり公費2欄のみ埋まる形は不正になり得る
        pushClientWarning(
          userId,
          `${userLabel}: 公費1 (${kohiHobetsuLabel(kohi.hobetsu)}) の請求額が 0 円で公費2 (${kohiHobetsuLabel(kohi2.hobetsu)}) のみ請求が発生しています — 公費欄の繰上げは自動対応外のため、伝送前にレセプトを確認してください`,
        );
      }
    } else if (transferToKohi) {
      // 生保 (法別12)・公費単独 (10割)・旧テキストのみ: 全量公費対象。
      // 本人負担 = min(保険給付後負担, 本人負担上限月額)。上限 0 (既定) なら
      // 従来どおり全額振替 (userAmount=0) = 挙動不変。
      // 公費単独は insuranceAmount=0 のため保険給付後負担 = 総額 (10割)。
      const afterIns = totalAmount - insuranceAmount;
      kohiUnits = totalUnits;
      kohiTargetCost = totalAmount;
      kohiTargetInsurance = insuranceAmount;
      kohiHonninFutan = Math.min(afterIns, honninLimit);
      kohiAmount = afterIns - kohiHonninFutan;
      userAmount = kohiHonninFutan;
    } else if (kohi) {
      // 保険優先の部分公費 (法別21 精神通院 / 54 難病 / 19 被爆者 等)
      // および 月途中開始/終了の生保 (法別12, kohiProrate=true。Phase 1):
      //   公費対象単位数 = 公費適用期間内の実績分 (明細行の kohi_units) を
      //                    基準内単位数でキャップ (限度額超過の10割自費は公費対象外)
      //                    + 処遇改善等%加算の公費対象分 (全期間有効なら addonUnits に一致)
      //   公費対象費用   = floor(公費対象単位数 × 単価)
      //   保険給付後負担 = 公費対象費用 − floor(公費対象費用 × 給付率)
      //   本人負担       = min(保険給付後負担, 本人負担上限月額)
      //   公費請求       = 保険給付後負担 − 本人負担
      // 丸めは保険・公費側を floor し、端数は本人負担側に乗せる (国保連方式と同方針)。
      const kohiDetailUnits = details.reduce((s, d) => s + (d.kohi_units ?? 0), 0);
      const kohiBase = Math.min(kohiDetailUnits, baseUnits);
      const kohiAddon =
        addonNum > 0
          ? Math.min(addonUnits, Math.round((kohiBase * addonNum) / addonDen))
          : 0;
      kohiUnits = kohiBase + kohiAddon;
      kohiTargetCost = Math.min(
        Math.floor((kohiUnits * unitPrice100) / 100),
        totalAmount,
      );
      kohiTargetInsurance = Math.floor((kohiTargetCost * (10 - copayX10)) / 10);
      const afterIns = kohiTargetCost - kohiTargetInsurance;
      kohiHonninFutan = Math.min(afterIns, honninLimit);
      kohiAmount = afterIns - kohiHonninFutan;
      userAmount = totalAmount - insuranceAmount - kohiAmount;
      // 生保 (法別12) は本人支払額 0 円が通常のため、この確認 warning は出さない
      if (honninLimit === 0 && kohi.hobetsu !== "12") {
        // レセ分割時はセグメントごとに評価されるため利用者単位で 1 回だけ出す
        warnOncePerUser(
          `honnin0:${userId}:${kohi.hobetsu}`,
          userId,
          `${userLabel}: 公費 (${kohiHobetsuLabel(kohi.hobetsu)}) の本人負担上限月額が 0 円のため保険給付後の負担分を全額公費請求します — 介護券・受給者証の本人支払額を公費タブで確認してください`,
        );
      }
      if (kohiPartialMonth) {
        pushClientWarning(
          userId,
          `${userLabel}: 公費 (${kohiHobetsuLabel(kohi.hobetsu)}) の適用期間 (${kohi.start ?? "制限なし"}〜${kohi.end ?? "制限なし"}) が月の一部のため、公費対象単位数を期間内の実績 (${kohiUnits}/${totalUnits} 単位) に按分しました — ${monthAddonKohiNote}。レセプトを確認してください`,
        );
      }
    } else {
      // 公費なし: 利用者負担 (法定) = 総額 − 保険請求額。
      // 限度額超過の全額自費は selfPayAmount に分離する (伝送・様式第一・確認CSVは法定のみ)。
      userAmount = totalAmount - insuranceAmount;
    }

    // サービス実日数 = セグメント期間内の訪問日の distinct 数
    // (分割なしは従来の「利用者×月の訪問日 set」と同じ母集合 = 同値)
    const segDays = new Set<string>();
    for (const dates of typeCounts.values()) for (const d of dates) segDays.add(d);

    const row: UserSeikyuRow = {
      user_id: userId,
      user_name: client?.name ?? "(利用者不明)",
      user_name_kana: client?.furigana ?? null,
      user_number: client?.userNumber ?? null,
      insurer_number: cert?.insurer_number ?? null,
      insurer_name: cert?.insurer_name?.trim() || null,
      insured_number: cert?.insured_number ?? null,
      care_level: cert?.care_level ?? null,
      copay_rate: copay,
      details,
      grossBaseUnits,
      limitUnits,
      planUnits,
      overUnits,
      overSource,
      overAmount,
      selfPayAmount: overAmount,
      baseUnits,
      addonUnits,
      kanriTaishougaiUnits,
      addonLabel,
      totalUnits,
      unitPrice,
      totalAmount,
      insuranceAmount,
      userAmount,
      publicExpense,
      kohiTandoku,
      kohiUnits,
      kohiAmount,
      kohiTargetCost,
      kohiTargetInsurance,
      kohiHonninFutan,
      kohiHobetsu: kohi?.hobetsu ?? null,
      kohiFutanshaNumber: kohi?.futansha ?? null,
      kohiJukyushaNumber: kohi?.jukyusha ?? null,
      addonCode,
      birthDate: client?.birth ?? null,
      gender: client?.gender ?? null,
      certStart: cert?.certification_start_date ?? null,
      certEnd: cert?.certification_end_date ?? null,
      // 直接入力の care_office_number があれば優先。無ければ care_office_id → care_offices.office_number 解決
      careOfficeNumber:
        cert?.care_office_number?.trim() ||
        (cert?.care_office_id ? officeNumberById.get(cert.care_office_id) ?? null : null),
      careOfficeName:
        cert?.care_office_name?.trim() ||
        (cert?.care_office_id ? officeNameById.get(cert.care_office_id) ?? null : null),
      serviceDays: segDays.size,
    };
    if (kohi2) {
      // 公費2 (複数公費の併用) — 併用時のみ設定 (公費1件の行は undefined = 従来と同一形状)
      row.kohi2Hobetsu = kohi2.hobetsu;
      row.kohi2FutanshaNumber = kohi2.futansha;
      row.kohi2JukyushaNumber = kohi2.jukyusha;
      row.kohi2Units = kohi2Units;
      row.kohi2Amount = kohi2Amount;
      row.kohi2TargetCost = kohi2TargetCost;
      row.kohi2TargetInsurance = kohi2TargetInsurance;
      row.kohi2HonninFutan = kohi2HonninFutan;
    }
    if (seg.segCount > 1) {
      row.segmentIndex = seg.segIndex;
      row.segmentCount = seg.segCount;
      row.periodFrom = seg.segFrom;
      row.periodTo = seg.segTo;
    }
    return row;
  };

  for (const [userId, typeCounts] of byUser) {
    const client = clientById.get(userId);
    const cert = certByClient.get(userId) ?? null;
    const userLabel = client?.name ?? userId;
    // 認定申請中の利用者は当月の国保連請求を保留する (ほのぼの準拠)。
    // 認定が確定してから、その月の実績を月遅れ請求する運用。当月伝送には載せない。
    if (cert?.certification_status === "申請中") {
      pushClientWarning(
        userId,
        `${userLabel}: 認定申請中のため当月の国保連請求を保留しました (認定確定後に月遅れ請求してください)`,
      );
      continue;
    }
    if (cert?.isFallback) {
      pushClientWarning(
        userId,
        `${userLabel}: 対象月 (${monthStr}) に有効な認定が見つからないため最新の認定情報で集計しています — 認定有効期間を確認してください`,
      );
    }
    // ── 提供表の加算エディタ由来で集計に載せない加算コードの warning (利用者×コードで 1 回) ──
    for (const g of genericAddonsByClient.get(userId) ?? []) {
      const m = genericAddonMaster.get(g.code);
      if (m && !m.ok) {
        pushClientWarning(
          userId,
          `${userLabel}: 提供表の加算${m.name ? `「${m.name}」` : ""} (${g.code}) は集計に含めません — ${m.reason}`,
        );
      }
    }
    // ── 生活援助中心型の回数上限 (届出基準) チェック ──
    // 厚生労働大臣が定める回数 (平成30年厚労省告示第218号: 要介護1=27/2=34/3=43/4=38/5=31 回/月)
    // 「以上」の生活援助中心型を位置付けたケアプランは市町村届出が必要
    // (居宅介護支援運営基準 13条18号の3。詳細は lib/visit-seikyu/seikatsu-enjo-limit.ts)。
    // 回数 (units ではない) で判定。身体＋生活の複合 (身体N生活M) は対象外。
    // 認定が申請中等で要介護度が引けない場合はスキップ (kijun = null)。
    // 月途中の保険者変更で明細書が分割される利用者も、届出基準は暦月・利用者単位のため
    // 分割前の月全体 (typeCounts) で数える。
    {
      const seKijun = seikatsuEnjoKijunForCareLevel(cert?.care_level);
      if (seKijun) {
        let seCount = 0;
        for (const [svcType, dates] of typeCounts) {
          if (isSeikatsuEnjoChushin(svcType)) seCount += dates.length;
        }
        if (seCount >= seKijun.limit) {
          pushClientWarning(
            userId,
            `${userLabel}さん: 生活援助中心型が月${seCount}回で基準回数 (${seKijun.limit}回/要介護${seKijun.level}) 以上です — ケアプランの市町村届出が必要です (平成30年厚生労働省告示第218号)`,
          );
        }
      }
    }
    // ── 月途中の資格変更 (Phase 1: 検出 / Phase 2: 保険者変更はレセプト分割) ──
    const certsInMonth = certsInMonthByClient.get(userId) ?? [];
    const midChange = detectMidMonthChange(certsInMonth);
    // ケース3 (区分変更月の限度額): 月内に複数の認定があるときは
    // service_limit_amount の最大値 (= 重い方の区分支給限度基準額) を月全体に適用する。
    // ※「月途中の区分変更は重い方の要介護度の支給限度基準額を月全体に適用」—
    //   2026-07-11 一次資料で確認済: 介護保険法施行規則 第68条第1項
    //   「当該月において最も介護の必要の程度が高い要介護状態区分に応じた」限度額。
    //   要支援→要介護跨ぎの月は同条2項 (要介護の限度額に予防サービス費を合算)。
    //   厚労省QA 平成15年6月30日 vol.2 問22 も同旨。なお「月末時点」の区分を使うのは
    //   明細書の被保険者欄・居宅介護支援費コードの話で、限度額は「重い方」。
    const monthLimitCandidates = certsInMonth
      .map((c) => (c.service_limit_amount != null ? Number(c.service_limit_amount) : NaN))
      .filter((v) => Number.isFinite(v) && v > 0);
    const limitAmount =
      monthLimitCandidates.length > 0
        ? Math.max(...monthLimitCandidates)
        : cert?.service_limit_amount != null && Number(cert.service_limit_amount) > 0
          ? Number(cert.service_limit_amount)
          : null;
    if (midChange?.careLevelChange) {
      const c = midChange.careLevelChange;
      const when = c.boundaryDate ? `, ${fmtMD(c.boundaryDate)}` : "";
      if (c.crossesSystem) {
        // 要支援↔要介護の制度跨ぎは請求様式自体が変わるため自動対応外 (Phase 1)
        pushClientWarning(
          userId,
          `${userLabel}さん: 月内に要支援↔要介護の区分変更 (${c.from}→${c.to}${when}) があります — 制度を跨ぐためレセプトの自動対応外です。手動対応してください`,
        );
      } else {
        pushClientWarning(
          userId,
          `${userLabel}さん: 月内に区分変更 (${c.from}→${c.to}${when})。限度額は重い方 (${(limitAmount ?? 0).toLocaleString()}単位) を適用。レセプトの要介護度は月末時点で出力`,
        );
      }
    }

    // ── ケース2 (保険者変更 = 転居): 境界日でセグメント分割し、セグメントごとに
    //    1 行 (= 1 明細書) を生成する (Phase 2: 行複製方式)。境界日が判定できない
    //    場合は分割せず従来コードパス + warning。
    let split: { seg: SegmentInput; typeCounts: Map<string, string[]> }[] | null = null;
    // 分割時に算定日からセグメントを特定できなかった月次加算のラベル
    // (= 従来どおり月末側に計上 + warning を出す対象。分割なし/特定済みは空)
    const monthAddonFallbackLabels: string[] = [];
    if (midChange?.insurerChange) {
      const ic = midChange.insurerChange;
      const insurerDiff =
        (ic.fromInsurer ?? "").trim() !== (ic.toInsurer ?? "").trim() &&
        !!ic.fromInsurer &&
        !!ic.toInsurer;
      const label = insurerDiff ? "保険者" : "被保険者番号";
      const desc = insurerDiff
        ? `${ic.fromInsurer}→${ic.toInsurer}`
        : `${ic.fromInsured ?? "?"}→${ic.toInsured ?? "?"}`;
      const segRes = resolveCertSegmentsForMonth(certsInMonth, opts.year, opts.month);
      if (segRes.segments.length >= 2) {
        // セグメントごとに訪問日をフィルタ。実績の無いセグメントは行 (明細書) を出さない
        const perSeg = segRes.segments
          .map((s) => {
            const filtered = new Map<string, string[]>();
            for (const [svcType, dates] of typeCounts) {
              const inSeg = dates.filter((d) => d >= s.from && d <= s.to);
              if (inSeg.length > 0) filtered.set(svcType, inSeg);
            }
            return { s, filtered };
          })
          .filter((p) => p.filtered.size > 0);
        if (perSeg.length >= 2) {
          // 月次加算 (初回 / 生活機能向上連携) の計上先セグメントを算定日で特定する。
          // 算定日がどのセグメント期間にも入らない (実績なしで落ちた期間・月外の入力ミス等)
          // 場合は null = 従来判定 (月末側 + warning) にフォールバック。
          const mFlags = monthAddonByClient.get(userId);
          const segIdxOfDate = (d: string | null): number | null => {
            if (!d) return null;
            const i = perSeg.findIndex((p) => d >= p.s.from && d <= p.s.to);
            return i >= 0 ? i : null;
          };
          const shokaiSegIdx = mFlags?.shokai ? segIdxOfDate(mFlags.shokaiDate) : null;
          const seikatsuSegIdx =
            mFlags && (mFlags.seikatsuKino === "Ⅰ" || mFlags.seikatsuKino === "Ⅱ")
              ? segIdxOfDate(mFlags.seikatsuDate)
              : null;
          if (mFlags?.shokai && shokaiSegIdx == null) monthAddonFallbackLabels.push("初回");
          if (
            mFlags &&
            (mFlags.seikatsuKino === "Ⅰ" || mFlags.seikatsuKino === "Ⅱ") &&
            seikatsuSegIdx == null
          ) {
            monthAddonFallbackLabels.push("生活機能向上連携");
          }
          // 緊急時: シフト実績 (kinkyu_houmon) があれば訪問日でセグメント帰属済み。
          // 列未適用 または シフト実績 0 件でエディタ回数にフォールバックする場合のみ
          // 月末側計上 (= 帰属を特定できない) の warning 対象
          if (
            (mFlags?.kinkyuCount ?? 0) > 0 &&
            (!hasKinkyuCol || (kinkyuDatesByUser.get(userId)?.length ?? 0) === 0)
          ) {
            monthAddonFallbackLabels.push("緊急時");
          }
          // 非月次の加算行 (加算エディタ由来) も算定日で計上先セグメントを解決する。
          // キーは行 index (同一 addon_code の複数行を後勝ちで潰さない)。
          // 算定日なし・どのセグメントにも入らない → 月末側 (perSeg.length-1) + warning
          const genericAddonSegIdx = new Map<number, number>();
          (genericAddonsByClient.get(userId) ?? []).forEach((g, gi) => {
            const gm = genericAddonMaster.get(g.code);
            if (!gm?.ok) return; // 集計対象外コードは帰属不要 (warning は上で出済)
            const idx = segIdxOfDate(g.santeiDate);
            if (idx == null) {
              genericAddonSegIdx.set(gi, perSeg.length - 1);
              monthAddonFallbackLabels.push(gm.name);
            } else {
              genericAddonSegIdx.set(gi, idx);
            }
          });
          split = perSeg.map((p, i) => ({
            typeCounts: p.filtered,
            seg: {
              segIndex: i,
              segCount: perSeg.length,
              segFrom: p.s.from,
              segTo: p.s.to,
              isLast: i === perSeg.length - 1,
              cert: p.s.cert,
              monthLimitAmount: null, // 分割時は segLimitAmount で機械判定
              // セグメント期間に重なる全認定の max (セグメント内の区分変更も「重い方」)
              segLimitAmount: p.s.limitAmount,
              genericAddonSegIdx,
              monthAddonHere: {
                shokai: shokaiSegIdx != null ? i === shokaiSegIdx : i === perSeg.length - 1,
                seikatsu:
                  seikatsuSegIdx != null ? i === seikatsuSegIdx : i === perSeg.length - 1,
              },
            },
          }));
          const segDesc = perSeg
            .map((p, i) => {
              const part =
                perSeg.length === 2 ? (i === 0 ? "前半" : "後半") : `第${i + 1}区分`;
              const num =
                (insurerDiff ? p.s.cert.insurer_number : p.s.cert.insured_number) ?? "?";
              return `${part}: ${num}`;
            })
            .join(" / ");
          pushClientWarning(
            userId,
            `${userLabel}さん: ${label}が月内で変わっています (${desc})。境界日 (${fmtMD(perSeg[1].s.from)}) で明細書を分割して出力しました (${segDesc})`,
          );
        } else if (perSeg.length === 1) {
          // 実績が転居前後の片側期間のみ → 分割は不要。その期間の認定 (旧/新保険者) で 1 行出す
          const p = perSeg[0];
          split = [
            {
              typeCounts: p.filtered,
              seg: {
                segIndex: 0,
                segCount: 1,
                segFrom: p.s.from,
                segTo: p.s.to,
                isLast: true,
                cert: p.s.cert,
                // 実績のある期間の認定限度額を満額適用 (期間に重なる複数認定は max =
                // 施行規則68条1項「重い方」。CertSegment.limitAmount 由来)
                monthLimitAmount: p.s.limitAmount,
              },
            },
          ];
          pushClientWarning(
            userId,
            `${userLabel}さん: ${label}が月内で変わっています (${desc}) が、実績が ${fmtMD(p.s.from)}〜${fmtMD(p.s.to)} のみのため分割せず、その期間の資格情報 (${(insurerDiff ? p.s.cert.insurer_number : p.s.cert.insured_number) ?? "?"}) で出力します`,
          );
        }
      } else {
        // 境界日が判定できない (変更後認定の開始日が月内に無い等) → 分割せず従来行
        pushClientWarning(
          userId,
          `${userLabel}さん: ${label}が月内で変わっています (${desc}) が、変更後認定の開始日から境界日を判定できないため分割できません — 認定有効期間 (開始日) を確認するか手動対応してください`,
        );
      }
    }

    if (!split) {
      // 従来コードパス (分割なし = 全利用者の通常ケース)
      rows.push(
        buildRowForSegment(userId, typeCounts, {
          segIndex: 0,
          segCount: 1,
          segFrom: from,
          segTo: to,
          isLast: true,
          cert,
          monthLimitAmount: limitAmount,
        }),
      );
      continue;
    }

    for (const part of split) {
      rows.push(buildRowForSegment(userId, part.typeCounts, part.seg));
    }

    // 分割時の追加警告: 月単位の値 (月次加算・計画単位数・手割振り) は配分できない。
    // 月次加算は算定日 (santei_date) でセグメントを特定できたものは正しい保険者側に
    // 計上済みのため warning を出さない (算定日なしのみ従来どおり月末側 + warning)。
    if (split.length > 1) {
      if (monthAddonFallbackLabels.length > 0) {
        pushClientWarning(
          userId,
          `${userLabel}さん: 算定日を特定できない加算 (${monthAddonFallbackLabels.join("・")}) は月末側の明細書に計上しました — 算定先の保険者が正しいか確認してください (提供表の加算で算定日を設定すると自動判定されます)`,
        );
      }
      const hasPlan = planUnitsByClient.has(userId);
      const hasManual =
        !!opts.officeId &&
        resolveManualOverUnits(gendoMap.get(userId), opts.officeId) != null;
      if (hasPlan || hasManual) {
        pushClientWarning(
          userId,
          `${userLabel}さん: ${[hasPlan ? "計画単位数" : null, hasManual ? "限度額の手割振り" : null].filter(Boolean).join("・")}は分割明細書に配分できないため適用せず、各期間の認定限度額で超過を機械判定しています — 転居月の限度額適用を保険者に確認してください`,
        );
      }
    }
  }

  // ふりがな順 (同一利用者の分割行はセグメント順)
  rows.sort((a, b) => {
    const c = (a.user_name_kana ?? a.user_name).localeCompare(
      b.user_name_kana ?? b.user_name,
      "ja",
    );
    if (c !== 0) return c;
    return (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0);
  });

  return {
    rows,
    sougouRows,
    month: monthStr,
    recordCount: schedules.length,
    warnings,
    warningsByClient: Object.fromEntries(warningsByClient),
  };
}

// ─── 分割セグメント行の利用者単位合算 (Phase 2) ──────────────────────────────

/** null 許容の加算: 両方 null なら null、どちらかあれば 0 扱いで合算 */
const sumNullable = (
  a: number | null | undefined,
  b: number | null | undefined,
): number | null => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

/**
 * 保険者変更 (転居) で分割されたセグメント行を利用者単位に合算する。
 * 利用者請求 (利用請求タブ)・月次情報など「利用者 = 1 行」前提の画面用
 * (利用者請求書・軽減・実費・入金・FB 全銀は保険者をまたいでも利用者単位)。
 *
 * - 分割行が 1 件も無ければ入力配列をそのまま返す (参照安定 = memo 互換)。
 * - 金額・単位数は合算 (セグメント期間は重ならないため単純加算で正)。
 * - 明細行は同一サービス (code + 名称 + 単価) を回数・単位で合算。
 * - 識別情報 (保険者・被保険者番号・要介護度・負担割合・認定期間) は
 *   月末側セグメントの値を採用。公費識別は非 null 優先。
 * - 合算後の行は segmentIndex 等を持たない (利用者 = 1 行に戻る)。
 */
export function mergeSegmentRows(rows: UserSeikyuRow[]): UserSeikyuRow[] {
  if (!rows.some((r) => (r.segmentCount ?? 1) > 1)) return rows;
  const out: UserSeikyuRow[] = [];
  // key = user_id|system。制度をまたいで合算しない (介護 と 総合事業 は別明細・別行)
  const idxByUser = new Map<string, number>();
  for (const r of rows) {
    if ((r.segmentCount ?? 1) <= 1) {
      out.push(r);
      continue;
    }
    const mergeKey = `${r.user_id}|${r.system}`;
    const idx = idxByUser.get(mergeKey);
    if (idx == null) {
      // 元の行 (details 含む) を破壊しないよう copy して積む
      const copy: UserSeikyuRow = { ...r, details: r.details.map((d) => ({ ...d })) };
      out.push(copy);
      idxByUser.set(mergeKey, out.length - 1);
      continue;
    }
    const base = out[idx];
    // 明細: 同一サービス (code + 名称 + 単価) は合算、無ければ行追加
    for (const d of r.details) {
      const hit = base.details.find(
        (b) =>
          b.service_code === d.service_code &&
          b.service_type === d.service_type &&
          b.unit_per === d.unit_per,
      );
      if (hit) {
        hit.count += d.count;
        hit.units += d.units;
        if (hit.kohi_count != null || d.kohi_count != null) {
          hit.kohi_count = (hit.kohi_count ?? 0) + (d.kohi_count ?? 0);
        }
        if (hit.kohi_units != null || d.kohi_units != null) {
          hit.kohi_units = (hit.kohi_units ?? 0) + (d.kohi_units ?? 0);
        }
        if (hit.kohi2_count != null || d.kohi2_count != null) {
          hit.kohi2_count = (hit.kohi2_count ?? 0) + (d.kohi2_count ?? 0);
        }
        if (hit.kohi2_units != null || d.kohi2_units != null) {
          hit.kohi2_units = (hit.kohi2_units ?? 0) + (d.kohi2_units ?? 0);
        }
      } else {
        base.details.push({ ...d });
      }
    }
    base.grossBaseUnits += r.grossBaseUnits;
    // 限度額・計画単位数は保険者ごとに独立管理 (転居月は各保険者で満額適用) のため
    // 合算値に意味がない — 2 保険者分を足すと過大表示になるので合算行では null にする
    // (消費側は null 耐性あり: limitUnits ?? 0 / planUnits ?? フォールバック)
    base.limitUnits = null;
    base.planUnits = null;
    base.overUnits += r.overUnits;
    base.overAmount += r.overAmount;
    base.selfPayAmount += r.selfPayAmount;
    base.baseUnits += r.baseUnits;
    base.addonUnits += r.addonUnits;
    base.kanriTaishougaiUnits += r.kanriTaishougaiUnits;
    base.totalUnits += r.totalUnits;
    base.totalAmount += r.totalAmount;
    base.insuranceAmount += r.insuranceAmount;
    base.userAmount += r.userAmount;
    base.serviceDays += r.serviceDays; // 期間が重ならないため単純加算 = 実日数
    base.kohiUnits = sumNullable(base.kohiUnits, r.kohiUnits);
    base.kohiAmount = sumNullable(base.kohiAmount, r.kohiAmount);
    base.kohiTargetCost = sumNullable(base.kohiTargetCost, r.kohiTargetCost);
    base.kohiTargetInsurance = sumNullable(base.kohiTargetInsurance, r.kohiTargetInsurance);
    base.kohiHonninFutan = sumNullable(base.kohiHonninFutan, r.kohiHonninFutan);
    base.kohi2Units = sumNullable(base.kohi2Units, r.kohi2Units);
    base.kohi2Amount = sumNullable(base.kohi2Amount, r.kohi2Amount);
    base.kohi2TargetCost = sumNullable(base.kohi2TargetCost, r.kohi2TargetCost);
    base.kohi2TargetInsurance = sumNullable(base.kohi2TargetInsurance, r.kohi2TargetInsurance);
    base.kohi2HonninFutan = sumNullable(base.kohi2HonninFutan, r.kohi2HonninFutan);
    // 公費・担当居宅の識別情報は非 null 優先 (片側セグメントのみ公費のケース)
    base.publicExpense = base.publicExpense ?? r.publicExpense;
    base.kohiTandoku = base.kohiTandoku || r.kohiTandoku;
    base.kohiHobetsu = base.kohiHobetsu ?? r.kohiHobetsu;
    base.kohiFutanshaNumber = base.kohiFutanshaNumber ?? r.kohiFutanshaNumber;
    base.kohiJukyushaNumber = base.kohiJukyushaNumber ?? r.kohiJukyushaNumber;
    base.kohi2Hobetsu = base.kohi2Hobetsu ?? r.kohi2Hobetsu;
    base.kohi2FutanshaNumber = base.kohi2FutanshaNumber ?? r.kohi2FutanshaNumber;
    base.kohi2JukyushaNumber = base.kohi2JukyushaNumber ?? r.kohi2JukyushaNumber;
    base.careOfficeNumber = base.careOfficeNumber ?? r.careOfficeNumber;
    base.careOfficeName = base.careOfficeName ?? r.careOfficeName;
    // 手割振りは分割時未適用のため常に auto
    base.overSource = "auto";
    // 識別情報 (保険者・被保険者番号・要介護度等) は月末側セグメントを採用
    if ((r.segmentIndex ?? 0) > (base.segmentIndex ?? 0)) {
      base.segmentIndex = r.segmentIndex;
      base.insurer_number = r.insurer_number;
      base.insurer_name = r.insurer_name;
      base.insured_number = r.insured_number;
      base.care_level = r.care_level;
      base.copay_rate = r.copay_rate;
      base.certStart = r.certStart;
      base.certEnd = r.certEnd;
    }
  }
  // 合算行はセグメント情報を落とす (利用者 = 1 行)
  for (const r of out) {
    if ((r.segmentCount ?? 1) > 1) {
      delete r.segmentIndex;
      delete r.segmentCount;
      delete r.periodFrom;
      delete r.periodTo;
    }
  }
  return out;
}
