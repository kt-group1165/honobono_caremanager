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
 *   利用者負担 (法定) = 総額 − 保険請求額 (公費振替時は 0)
 *   超過自費 = floor(超過単位 × round(単価×100) / 100)   → selfPayAmount
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";
import { validInMonth } from "@/lib/service-code-valid";
import { resolveKohiForMonth, kohiHobetsuLabel } from "@/lib/kohi";
import { resolveCertForMonth } from "@/lib/cert-for-month";
import {
  getHospitalizationMap,
  hospitalizationsInRange,
} from "@/lib/hospitalization";
import {
  getGendoAllocationMap,
  resolveManualOverUnits,
  type GendoAllocationLine,
} from "@/lib/gendo-allocation";

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
}

export interface UserSeikyuRow {
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
  /** 公費対象単位数 (公費ありのとき全単位を対象とする簡易版) */
  kohiUnits: number | null;
  /** 公費請求額 (円) = 本人負担分を公費へ振替 (生保想定・本人負担 0) */
  kohiAmount: number | null;
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
}

export interface MonthlySeikyuResult {
  rows: UserSeikyuRow[];
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
    return { rows: [], month: monthStr, recordCount: 0, warnings: [] };
  }

  const warnings: string[] = [];

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
  for (let i = 0; i < variants.length; i += 50) {
    const chunk = variants.slice(i, i + 50);
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

  // 2.5) 実績単位の月次加算 (kaigo_visit_month_addons: 初回 / 緊急時 / 生活機能向上連携)
  //     利用者×月×事業所のフラグを読み、該当利用者の明細に加算行として追加する。
  //     単位数はハードコードせず kaigo_service_codes から対象月の有効世代で引く。
  interface MonthAddonFlags {
    shokai: boolean;
    seikatsuKino: string; // 'なし' | 'Ⅰ' | 'Ⅱ'
    kinkyuCount: number;
  }
  const monthAddonByClient = new Map<string, MonthAddonFlags>();
  if (opts.officeId) {
    const { data, error } = await supabase
      .from("kaigo_visit_month_addons")
      .select("client_id, shokai, seikatsu_kino, kinkyu_count")
      .eq("office_id", opts.officeId)
      .eq("target_month", monthStr);
    if (error) {
      // テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) は
      // 加算なしで続行 (UI 側で「SQL未適用」バナー案内)。それ以外は握りつぶさない
      if (error.code !== "42P01" && error.code !== "PGRST205") {
        throw new Error(`月次加算取得失敗: ${error.message}`);
      }
    } else {
      for (const r of (data ?? []) as {
        client_id: string;
        shokai: boolean | null;
        seikatsu_kino: string | null;
        kinkyu_count: number | null;
      }[]) {
        monthAddonByClient.set(r.client_id, {
          shokai: !!r.shokai,
          seikatsuKino: r.seikatsu_kino ?? "なし",
          kinkyuCount: r.kinkyu_count ?? 0,
        });
      }
    }
  }

  // C3: 緊急時訪問介護加算の回数。kinkyu_houmon 列があれば
  // 「completed かつ kinkyu_houmon=true」のシフト行数を利用者×月で数える。
  // 列未適用 (42703) は従来どおり kaigo_visit_month_addons.kinkyu_count にフォールバック。
  const kinkyuCountByUser = new Map<string, number>();
  if (hasKinkyuCol) {
    for (const s of schedules) {
      if (s.kinkyu_houmon) {
        kinkyuCountByUser.set(s.user_id, (kinkyuCountByUser.get(s.user_id) ?? 0) + 1);
      }
    }
  }
  const kinkyuOf = (userId: string): number =>
    hasKinkyuCol
      ? kinkyuCountByUser.get(userId) ?? 0
      : monthAddonByClient.get(userId)?.kinkyuCount ?? 0;

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
    ) || kinkyuCountByUser.size > 0;
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
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
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

  // 認定情報は「対象月に有効な認定」で解決する (共有リゾルバ)。
  // 月遅れ再請求は元提供月で aggregate されるため自然に当時の認定になる。
  const certByClient = await resolveCertForMonth(supabase, userIds, opts.year, opts.month);

  // 旧 public_expense テキスト (認定タブの自由記入)。resolveCertForMonth は
  // この列を持たないため別途取得する。用途は
  //   - client_kohi_records あり環境: 「テキストあり・公費レコード未登録」warning のみ
  //   - client_kohi_records 未作成環境: 従来どおり公費扱いのフォールバック
  const publicExpenseTextByClient = new Map<string, string>();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
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

  // 3.5) 公費 (生活保護等) — client_kohi_records から対象月に有効な公費を解決
  //     (優先 1 件のみ。複数公費の併用按分は非対応。テーブル未作成時は
  //      旧 client_insurance_records.kohi_* にフォールバック → lib/kohi.ts 参照)
  //     honninFutan (本人支払額/月) は現状の金額計算には入れない
  //     (0 のみ想定。TODO: 本人支払額の公費請求からの控除対応)
  const kohiRes = await resolveKohiForMonth(supabase, userIds, opts.year, opts.month);

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
    const { data, error } = await supabase
      .from("care_offices")
      .select("id, office_number, name")
      .in("id", careOfficeIds);
    if (error) throw new Error(`居宅事業所取得失敗: ${error.message}`);
    for (const o of (data ?? []) as { id: string; office_number: string | null; name: string | null }[]) {
      officeNumberById.set(o.id, o.office_number);
      officeNameById.set(o.id, o.name);
    }
  }

  // 4.7) 区分支給限度基準の基準値: 計画単位数 (kaigo_monthly_plan_units)
  //     月次情報タブで設定する「自事業所分の区分支給限度基準内単位数」。
  //     あればこれが基準値、無ければ認定の限度額 (service_limit_amount) にフォールバック。
  //     テーブル未作成 (42P01/PGRST205) は計画なしとして続行。
  const planUnitsByClient = new Map<string, number>();
  {
    let planTableMissing = false;
    for (let i = 0; i < userIds.length && !planTableMissing; i += 50) {
      const chunk = userIds.slice(i, i + 50);
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
  // 総合事業 (A2 等) も本バージョンでは介護保険請求から分離する (warning で通知)。
  const byUser = new Map<string, Map<string, number>>(); // user_id → (service_type → count)
  const daysByUser = new Map<string, Set<string>>(); // user_id → 訪問日 set (実日数)
  const visitDatesByUser = new Map<string, string[]>(); // user_id → 訪問日 list (入院重なり件数用)
  const sogoCountByUser = new Map<string, number>(); // 総合事業の除外件数 (warning 用)
  for (const s of schedules) {
    const system = unitByNorm.get(toHankakuDigits(s.service_type))?.system;
    if (system === "障害") continue;
    if (system === "総合事業") {
      // 総合事業の実績は介護保険の集計行から除外 (月額包括コードの回数乗算も回避)。
      sogoCountByUser.set(s.user_id, (sogoCountByUser.get(s.user_id) ?? 0) + 1);
      continue;
    }
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, new Map());
    const m = byUser.get(s.user_id)!;
    m.set(s.service_type, (m.get(s.service_type) ?? 0) + 1);
    if (!daysByUser.has(s.user_id)) daysByUser.set(s.user_id, new Set());
    daysByUser.get(s.user_id)!.add(s.visit_date);
    if (!visitDatesByUser.has(s.user_id)) visitDatesByUser.set(s.user_id, []);
    visitDatesByUser.get(s.user_id)!.push(s.visit_date);
  }
  for (const [userId, count] of sogoCountByUser) {
    warnings.push(
      `総合事業実績${count}件 (${nameOf(userId)}) は本バージョンでは介護保険請求に含めません (総合事業請求は今後対応)`,
    );
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
          warnings.push(
            `${nameOf(userId)}さん: 入院期間中 (${fmtMD(p.admission_date)}〜${p.discharge_date ? fmtMD(p.discharge_date) : "入院中"}) の実績が${n}件あります — 実績を確認してください`,
          );
        }
      }
    }
  }

  const rows: UserSeikyuRow[] = [];
  for (const [userId, typeCounts] of byUser) {
    const client = clientById.get(userId);
    const cert = certByClient.get(userId) ?? null;
    const userLabel = client?.name ?? userId;
    if (cert?.isFallback) {
      warnings.push(
        `${userLabel}: 対象月 (${monthStr}) に有効な認定が見つからないため最新の認定情報で集計しています — 認定有効期間を確認してください`,
      );
    }
    // copay_rate は「割」単位 (1=1割, 2=2割, 3=3割) で格納されることが
    // あるため、1 以上は /10 して負担率に正規化する (0.1〜0.3 表記も許容)
    const copayRaw = cert?.copay_rate != null ? Number(cert.copay_rate) : null;
    const copay =
      copayRaw == null || !Number.isFinite(copayRaw) || copayRaw <= 0 ? 0.1
      : copayRaw >= 1 ? Math.min(copayRaw / 10, 1)
      : copayRaw;
    const limitAmount =
      cert?.service_limit_amount != null && Number(cert.service_limit_amount) > 0
        ? Number(cert.service_limit_amount)
        : null;

    const details: SeikyuDetailLine[] = [];
    let grossBaseUnits = 0;
    for (const [svcType, count] of typeCounts) {
      const master = unitByName.get(svcType);
      const unitPer = master?.units ?? 0;
      // 身体介護9系 (units=0 の増分コード) は単独では請求単位にならない。
      // 実績に紛れていたら合成後の正しいサービスへ修正が必要なので warning。
      if (master && unitPer === 0) {
        warnings.push(
          `${userLabel}: 「${svcType}」は単位数 0 の増分コード (身体介護9系等) です — 実績のサービス内容を確認してください`,
        );
      }
      const units = unitPer * count;
      grossBaseUnits += units;
      details.push({
        service_type: svcType,
        short_name: master?.short ?? null,
        service_code: master?.code ?? null,
        unit_per: unitPer,
        count,
        units,
      });
    }
    // 実績単位の月次加算行 (初回 / 緊急時×回数 / 生活機能向上連携Ⅰ・Ⅱ)。
    // grossBaseUnits (明細合計) には全て含めるが、区分支給限度基準の超過判定では
    // 初回加算・緊急時訪問介護加算 = 限度額管理対象外 (告示) を除外する。
    // 処遇改善等の%加算が対象外なのは従来どおり。
    // 限度額管理対象外の加算単位数 (初回・緊急時)。超過判定から除外し、常に保険給付側に付く
    let shokaiKinkyuUnits = 0;
    const flags = monthAddonByClient.get(userId);
    const shokaiOn = flags?.shokai ?? false;
    const seikatsuKino = flags?.seikatsuKino ?? "なし";
    const kinkyuCount = kinkyuOf(userId); // C3: 列があればシフト実績、無ければ月次加算テーブル
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
      ) => {
        if (count <= 0) return;
        const m = monthAddonMaster.get(name);
        if (!m) {
          warnings.push(
            `${userLabel}: 加算「${name}」の単位数がマスタから引けません (対象月に有効な世代なし)`,
          );
          return;
        }
        const units = m.units * count;
        grossBaseUnits += units;
        if (kanriTaishougai) shokaiKinkyuUnits += units;
        details.push({
          service_type: name,
          short_name: fixedLabel,
          service_code: m.code,
          unit_per: m.units,
          count,
          units,
        });
      };
      // 初回・緊急時 = 限度額管理対象外 (告示)。生活機能向上連携は管理対象
      if (shokaiOn) pushMonthAddon(MONTH_ADDON_NAMES.shokai, 1, "初回加算", true);
      pushMonthAddon(MONTH_ADDON_NAMES.kinkyu, kinkyuCount, "緊急時訪問介護加算", true);
      if (seikatsuKino === "Ⅰ")
        pushMonthAddon(MONTH_ADDON_NAMES.seikatsuI, 1, "生活機能向上連携加算Ⅰ", false);
      if (seikatsuKino === "Ⅱ")
        pushMonthAddon(MONTH_ADDON_NAMES.seikatsuII, 1, "生活機能向上連携加算Ⅱ", false);
    }
    details.sort((a, b) => b.units - a.units);

    // ── 区分支給限度基準の超過自費 (ほのぼの準拠) ──
    // 基準値 = 計画単位数 (あれば) > 認定限度額 (service_limit_amount)。どちらも無ければ管理なし。
    // ※ 処遇改善加算等の%加算は区分支給限度基準の「対象外」なので、
    //    超過判定は %加算前の単位数で行う (加算単位は超過に数えない)。
    // ※ 初回加算・緊急時訪問介護加算も限度額管理対象外 (告示) のため超過判定から除外する
    //    (shokaiKinkyuUnits)。除外分は常に保険給付側 (baseUnits) に残る。
    const planUnits = planUnitsByClient.get(userId) ?? null;
    const limitUnits = planUnits ?? limitAmount;
    const managedUnits = grossBaseUnits - shokaiKinkyuUnits;
    // 超過単位の決定 (優先順):
    //   1. ケアマネの手割振り (利用票別表で確定した自 office の自費単位 = 真値)
    //   2. 機械判定 (管理対象単位 − 基準値)。別表未確定・テーブル未作成・officeId 無しはこちら
    const manualOver = opts.officeId
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
    // 公費単独 (10割公費): 被保険者番号が 'H' 始まり = 介護保険未加入の生保受給者。
    // 保険給付なし → 総費用の全額を公費 (法別12 生活保護) で請求する。
    const kohiTandoku = /^[Hh]/.test((cert?.insured_number ?? "").trim());
    // 公費 (生活保護等) — 公費タブ (client_kohi_records) から対象月に有効な 1 件
    const kohi = kohiRes.byClient.get(userId) ?? null;
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
    let publicExpense: string | null;
    if (kohiRes.fallback) {
      publicExpense =
        (kohi ? kohiHobetsuLabel(kohi.hobetsu) : null) ??
        peText ??
        (kohiTandoku ? "公費単独 (生活保護 10割)" : null);
    } else {
      publicExpense =
        (kohi ? kohiHobetsuLabel(kohi.hobetsu) : null) ??
        (kohiTandoku ? "公費単独 (生活保護 10割)" : null);
      if (!kohi && !kohiTandoku && peText) {
        warnings.push(
          `${userLabel}: 保険情報に公費テキスト「${peText}」がありますが、公費レコード (利用者詳細の公費タブ) が未登録のため公費請求には含めません — 公費タブで登録してください`,
        );
      }
    }
    const kohiUnits = publicExpense ? totalUnits : null;
    const kohiAmount = kohiTandoku
      ? totalAmount
      : publicExpense
      ? totalAmount - insuranceAmount
      : null;
    // 利用者負担 (法定) = 保険/公費で賄われない本人負担のみ。
    // 限度額超過の全額自費は selfPayAmount に分離する (伝送・様式第一・確認CSVは法定のみ)。
    // 公費 (生活保護等) は本人負担分を公費へ振替するが、限度額超過分は
    // 保険給付の枠外 = 公費対象外なので公費単独者でも自費 (selfPayAmount) が発生する。
    const userAmount = publicExpense ? 0 : totalAmount - insuranceAmount;

    rows.push({
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
      serviceDays: daysByUser.get(userId)?.size ?? 0,
    });
  }

  // ふりがな順
  rows.sort((a, b) =>
    (a.user_name_kana ?? a.user_name).localeCompare(
      b.user_name_kana ?? b.user_name,
      "ja",
    ),
  );

  return { rows, month: monthStr, recordCount: schedules.length, warnings };
}
