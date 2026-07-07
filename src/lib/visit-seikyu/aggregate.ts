/**
 * 訪問介護 請求集計 (介護請求 / 利用請求 / 国保請求 の共通ロジック)
 *
 * データフロー:
 *   kaigo_visit_schedule (status='completed' = 実績)
 *     × kaigo_service_codes (service_name → units)
 *     × clients + client_insurance_records (氏名 / 保険者番号 / 被保険者番号 / 要介護度 / 負担割合)
 *     × offices (地域区分単価 / 処遇改善加算)
 *   → 利用者ごとに 1 行の請求サマリ
 *
 * 金額計算 (介護保険の標準):
 *   総単位数 = Σ(サービス単位 × 回数) + 加算単位 (処遇改善等 = %加算)
 *   総額     = floor(総単位数 × 地域単価)
 *   利用者負担 = floor(総額 × 負担割合)   ※ copay_rate 未設定は 1 割
 *   保険請求額 = 総額 - 利用者負担
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";
import { validInMonth } from "@/lib/service-code-valid";

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
  /** 明細行 (サービス種類ごと) */
  details: SeikyuDetailLine[];
  /** 本体単位数 (加算前) */
  baseUnits: number;
  /** 処遇改善等 加算単位数 */
  addonUnits: number;
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
  /** 利用者負担額 (円) */
  userAmount: number;
  /** 公費 (生活保護等)。法別番号 or public_expense テキスト。null = 公費なし */
  publicExpense: string | null;
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
}

// 処遇改善加算等 (= 月次総単位数に % を掛ける加算) は
// offices.applied_formula_codes と kaigo_service_codes.formula
// (monthly_aggregate: 所定単位 × numerator/denominator) を突合して計算する。

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
    /** 自事業所の applied_formula_codes (処遇改善等) */
    appliedFormulaCodes?: string[];
  },
): Promise<MonthlySeikyuResult> {
  const monthStr = `${opts.year}-${String(opts.month).padStart(2, "0")}`;
  const daysInMonth = new Date(opts.year, opts.month, 0).getDate();
  const from = `${monthStr}-01`;
  const to = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;

  // 1) 実績 (completed) を月範囲で取得 (page-loop)
  const PAGE = 1000;
  const schedules: { user_id: string; service_type: string; visit_date: string }[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("kaigo_visit_schedule")
      .select("user_id, service_type, visit_date")
      .eq("status", "completed")
      .gte("visit_date", from)
      .lte("visit_date", to)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`実績取得失敗: ${error.message}`);
    const rows = (data ?? []) as { user_id: string; service_type: string; visit_date: string }[];
    schedules.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  if (schedules.length === 0) {
    return { rows: [], month: monthStr, recordCount: 0 };
  }

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

  // 3) 利用者情報 (clients + 最新 insurance record)
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

  const insByClient = new Map<
    string,
    {
      insurer: string | null; insured: string | null; level: string | null; copay: number;
      /** 保険者名 */
      insurerName: string | null;
      publicExpense: string | null; certStart: string | null; certEnd: string | null;
      careOfficeId: string | null;
      /** 直接入力された担当居宅事業所番号 (10桁)。あれば officeId 解決より優先 */
      careOfficeNumberDirect: string | null;
      /** 担当居宅介護支援事業所名 (直接入力) */
      careOfficeName: string | null;
      kohiHobetsu: string | null; kohiFutansha: string | null; kohiJukyusha: string | null;
    }
  >();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("client_insurance_records")
      .select("client_id, insurer_number, insurer_name, insured_number, care_level, copay_rate, public_expense, kohi_hobetsu, kohi_futansha_number, kohi_jukyusha_number, certification_start_date, certification_end_date, care_office_id, care_office_number, care_office_name, effective_date")
      .in("client_id", chunk)
      .order("effective_date", { ascending: false });
    if (error) throw new Error(`保険情報取得失敗: ${error.message}`);
    for (const r of (data ?? []) as {
      client_id: string;
      insurer_number: string | null;
      insurer_name: string | null;
      insured_number: string | null;
      care_level: string | null;
      copay_rate: number | null;
      public_expense: string | null;
      kohi_hobetsu: string | null;
      kohi_futansha_number: string | null;
      kohi_jukyusha_number: string | null;
      certification_start_date: string | null;
      certification_end_date: string | null;
      care_office_id: string | null;
      care_office_number: string | null;
      care_office_name: string | null;
    }[]) {
      // 最新 (effective_date DESC) の 1 件のみ採用
      if (!insByClient.has(r.client_id)) {
        // copay_rate は「割」単位 (1=1割, 2=2割, 3=3割) で格納されることが
        // あるため、1 以上は /10 して負担率に正規化する (0.1〜0.3 表記も許容)
        const raw = r.copay_rate;
        const copay =
          raw == null || raw <= 0 ? 0.1
          : raw >= 1 ? Math.min(raw / 10, 1)
          : raw;
        insByClient.set(r.client_id, {
          insurer: r.insurer_number,
          insurerName: r.insurer_name?.trim() || null,
          insured: r.insured_number,
          level: r.care_level,
          copay,
          publicExpense:
            r.kohi_hobetsu?.trim()
              ? `法別${r.kohi_hobetsu.trim()}${r.kohi_hobetsu.trim() === "12" ? " (生活保護)" : ""}`
              : r.public_expense?.trim()
              ? r.public_expense.trim()
              : null,
          certStart: r.certification_start_date,
          certEnd: r.certification_end_date,
          careOfficeId: r.care_office_id,
          careOfficeNumberDirect: r.care_office_number?.trim() || null,
          careOfficeName: r.care_office_name?.trim() || null,
          kohiHobetsu: r.kohi_hobetsu?.trim() || null,
          kohiFutansha: r.kohi_futansha_number?.trim() || null,
          kohiJukyusha: r.kohi_jukyusha_number?.trim() || null,
        });
      }
    }
  }

  // 4) 処遇改善加算の rate — 適用加算コードの formula をマスタから取得
  //    (monthly_aggregate: 所定単位 × numerator/denominator)
  let addonNum = 0;
  let addonDen = 1;
  let addonLabel: string | null = null;
  let addonCode: string | null = null;
  if ((opts.appliedFormulaCodes ?? []).length > 0) {
    // 有効期間: 同一 service_code の世代が複数あるため対象月の世代の formula を採用
    const { data, error } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_code, service_name, formula")
        .in("service_code", opts.appliedFormulaCodes as string[])
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
      Array.from(insByClient.values())
        .map((v) => v.careOfficeId)
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

  const unitPrice = opts.unitPrice && opts.unitPrice > 0 ? opts.unitPrice : 10.0;

  // 5) 利用者ごとに集計
  // 障害福祉サービスは介護保険請求の対象外 (障害請求側で扱う) のため除外
  const byUser = new Map<string, Map<string, number>>(); // user_id → (service_type → count)
  const daysByUser = new Map<string, Set<string>>(); // user_id → 訪問日 set (実日数)
  for (const s of schedules) {
    if (unitByNorm.get(toHankakuDigits(s.service_type))?.system === "障害") continue;
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, new Map());
    const m = byUser.get(s.user_id)!;
    m.set(s.service_type, (m.get(s.service_type) ?? 0) + 1);
    if (!daysByUser.has(s.user_id)) daysByUser.set(s.user_id, new Set());
    daysByUser.get(s.user_id)!.add(s.visit_date);
  }

  const rows: UserSeikyuRow[] = [];
  for (const [userId, typeCounts] of byUser) {
    const client = clientById.get(userId);
    const ins = insByClient.get(userId);
    const details: SeikyuDetailLine[] = [];
    let baseUnits = 0;
    for (const [svcType, count] of typeCounts) {
      const master = unitByName.get(svcType);
      const unitPer = master?.units ?? 0;
      const units = unitPer * count;
      baseUnits += units;
      details.push({
        service_type: svcType,
        short_name: master?.short ?? null,
        service_code: master?.code ?? null,
        unit_per: unitPer,
        count,
        units,
      });
    }
    details.sort((a, b) => b.units - a.units);

    const addonUnits = addonNum > 0 ? Math.round((baseUnits * addonNum) / addonDen) : 0;
    const totalUnits = baseUnits + addonUnits;
    const totalAmount = Math.floor(totalUnits * unitPrice);
    const copay = ins?.copay ?? 0.1;
    // 国保連方式: 保険請求額 = 費用総額 × 給付率 (1円未満切捨)、利用者負担 = 差引
    // (端数は利用者負担側に乗る。先に負担額を切捨てると 1 円ずれる)
    const insuranceAmount = Math.floor(totalAmount * (1 - copay));
    // 公費 (生活保護等): 本人負担分を公費請求へ振替 (本人負担 0 の簡易版)
    const publicExpense = ins?.publicExpense ?? null;
    const kohiUnits = publicExpense ? totalUnits : null;
    const kohiAmount = publicExpense ? totalAmount - insuranceAmount : null;
    const userAmount = publicExpense ? 0 : totalAmount - insuranceAmount;

    rows.push({
      user_id: userId,
      user_name: client?.name ?? "(利用者不明)",
      user_name_kana: client?.furigana ?? null,
      user_number: client?.userNumber ?? null,
      insurer_number: ins?.insurer ?? null,
      insurer_name: ins?.insurerName ?? null,
      insured_number: ins?.insured ?? null,
      care_level: ins?.level ?? null,
      copay_rate: copay,
      details,
      baseUnits,
      addonUnits,
      addonLabel,
      totalUnits,
      unitPrice,
      totalAmount,
      insuranceAmount,
      userAmount,
      publicExpense,
      kohiUnits,
      kohiAmount,
      kohiHobetsu: ins?.kohiHobetsu ?? null,
      kohiFutanshaNumber: ins?.kohiFutansha ?? null,
      kohiJukyushaNumber: ins?.kohiJukyusha ?? null,
      addonCode,
      birthDate: client?.birth ?? null,
      gender: client?.gender ?? null,
      certStart: ins?.certStart ?? null,
      certEnd: ins?.certEnd ?? null,
      // 直接入力の care_office_number があれば優先。無ければ care_office_id → care_offices.office_number 解決
      careOfficeNumber:
        ins?.careOfficeNumberDirect ??
        (ins?.careOfficeId ? officeNumberById.get(ins.careOfficeId) ?? null : null),
      careOfficeName:
        ins?.careOfficeName ??
        (ins?.careOfficeId ? officeNameById.get(ins.careOfficeId) ?? null : null),
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

  return { rows, month: monthStr, recordCount: schedules.length };
}
