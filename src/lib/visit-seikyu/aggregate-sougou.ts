/**
 * 総合事業 (介護予防・日常生活支援総合事業) 訪問型サービス (A2) の請求集計
 *
 * 介護給付 (aggregate.ts) とは別様式 (国保連 7112 / 様式(予)) で請求するため、
 * 介護保険分と混ぜず 独立ストリームとして集計する。呼出は aggregate.ts から。
 *
 * 集計仕様 (ほのぼの相当):
 *   - 基本コード (system='総合事業', service_category='A2') の units を対象月世代 (validInMonth) で解決
 *   - unit_type='1月につき' (月額包括) は「実績が 1 件でもあれば月 1 回」= 回数を掛けない
 *     unit_type='1回につき'                = 実績回数 × units
 *   - 単価 = opts.unitPrice (事業所の地域区分単価。介護と同じ値。総合事業専用単価ではない)
 *   - 処遇改善 = 総合事業の処遇改善コード (CB_A26184 等) の formula (monthly_aggregate) で率計算。
 *     事業所の適用処遇改善 (kaigo_office_addon_periods / offices.applied_formula_codes) が
 *     介護コード (116274 等) の場合、同率の総合事業 A2 処遇改善コードにマッピングして採用する。
 *   - 給付率 = 9割/1割 (要支援・事業対象者の総合事業も原則 1 割。負担割合は認定に従う)
 *   - 限度額 = 要支援枠 (深追いしない。当面は超過管理なし = 全量給付対象。TODO コメント参照)
 *
 * 戻り値は UserSeikyuRow (system='総合事業')。伝送 (build-sougou.ts) / 表示で共用する。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";
import { validInMonth } from "@/lib/service-code-valid";
import { resolveKohiForMonth, kohiHobetsuLabel } from "@/lib/kohi";
import { resolveCertForMonth } from "@/lib/cert-for-month";
import type { UserSeikyuRow, SeikyuDetailLine } from "@/lib/visit-seikyu/aggregate";

interface SougouScheduleRow {
  user_id: string;
  service_type: string;
  visit_date: string;
}

/**
 * 総合事業ストリームの集計。既に aggregate.ts で取得済みの
 * 「総合事業に該当する実績シフト」を渡してもらい、それを集計する。
 *
 * @param sougouSchedules system='総合事業' に該当する completed シフト行
 */
export async function aggregateSougouSeikyu(
  supabase: SupabaseClient,
  sougouSchedules: SougouScheduleRow[],
  opts: {
    officeId: string | null;
    year: number;
    month: number;
    unitPrice: number;
    /** 事業所の適用処遇改善コード (介護 116274 等 or 総合事業 CB_A26184 等) — 対象月世代解決済でなくてよい */
    effectiveFormulaCodes: string[];
  },
): Promise<{ rows: UserSeikyuRow[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (sougouSchedules.length === 0) return { rows: [], warnings };

  const monthStr = `${opts.year}-${String(opts.month).padStart(2, "0")}`;

  // 1) 基本コード (A2) の units / unit_type / short_name / service_code をマスタ解決
  //    service_type (= service_name) → 総合事業マスタ (対象月世代)。
  //    ※ 同名が介護と総合事業の双方にある場合でも、ここでは system='総合事業' に限定して引く
  //      (総合事業ストリームなので総合事業コードを使う)。
  const serviceTypes = Array.from(new Set(sougouSchedules.map((s) => s.service_type)));
  const variants = serviceNameVariantsAll(serviceTypes);
  const masterByNorm = new Map<
    string,
    { units: number; unitType: string; short: string | null; code: string | null }
  >();
  for (let i = 0; i < variants.length; i += 50) {
    const chunk = variants.slice(i, i + 50);
    const { data, error } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_name, short_name, units, unit_type, service_code")
        .eq("system", "総合事業")
        .eq("service_category", "A2")
        .eq("calculation_type", "基本")
        .in("service_name", chunk),
      opts.year,
      opts.month,
    );
    if (error) throw new Error(`総合事業サービスコード取得失敗: ${error.message}`);
    for (const r of (data ?? []) as {
      service_name: string;
      short_name: string | null;
      units: number;
      unit_type: string | null;
      service_code: string | null;
    }[]) {
      const key = toHankakuDigits(r.service_name);
      // 同名の複数世代/保険者版が validInMonth 後もヒットしうる。先勝ち (先頭 = 若い service_code)。
      if (!masterByNorm.has(key)) {
        masterByNorm.set(key, {
          units: r.units,
          unitType: r.unit_type ?? "1回につき",
          short: r.short_name,
          code: r.service_code,
        });
      }
    }
  }
  const masterOf = (name: string) => masterByNorm.get(toHankakuDigits(name));

  // 2) 利用者情報 (clients + 対象月に有効な認定)
  const userIds = Array.from(new Set(sougouSchedules.map((s) => s.user_id)));
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
    if (error) throw new Error(`利用者取得失敗 (総合事業): ${error.message}`);
    for (const c of (data ?? []) as {
      id: string;
      name: string;
      furigana: string | null;
      birth_date: string | null;
      gender: string | null;
      user_number: string | null;
    }[]) {
      clientById.set(c.id, {
        name: c.name,
        furigana: c.furigana,
        birth: c.birth_date,
        gender: c.gender,
        userNumber: c.user_number,
      });
    }
  }

  const certByClient = await resolveCertForMonth(supabase, userIds, opts.year, opts.month);
  const kohiRes = await resolveKohiForMonth(supabase, userIds, opts.year, opts.month);

  // 3) 担当居宅介護支援事業所番号 (伝送の基本情報レコード用)
  const careOfficeIds = Array.from(
    new Set(
      Array.from(certByClient.values())
        .map((v) => v.care_office_id)
        .filter(Boolean) as string[],
    ),
  );
  const officeNumberById = new Map<string, string | null>();
  const officeNameById = new Map<string, string | null>();
  if (careOfficeIds.length > 0) {
    const { data, error } = await supabase
      .from("care_offices")
      .select("id, office_number, name")
      .in("id", careOfficeIds);
    if (error) throw new Error(`居宅事業所取得失敗 (総合事業): ${error.message}`);
    for (const o of (data ?? []) as { id: string; office_number: string | null; name: string | null }[]) {
      officeNumberById.set(o.id, o.office_number);
      officeNameById.set(o.id, o.name);
    }
  }

  // 4) 処遇改善: 事業所の適用処遇改善 (率) を総合事業 A2 の処遇改善コードにマッピングして採用。
  //    a. 事業所の applied formula codes (介護 116274 等 or 総合事業 CB_A26184 等) を対象月世代で解決し、
  //       monthly_aggregate の率 (numerator/denominator) を得る。
  //    b. その率 (numerator, 分母1000 前提) と一致する総合事業 A2 処遇改善コードを引き当てる。
  //       ※ 総合事業処遇改善コードは units に ‰ (numerator) を持ち、SQL 適用後は formula も付く。
  //         formula が未適用 (null) の場合は units を numerator とみなして突合する。
  //    c. 一致コードが無ければ処遇改善 0 (warning)。
  let addonNum = 0;
  let addonDen = 1;
  let addonLabel: string | null = null;
  let addonCode: string | null = null;

  if (opts.effectiveFormulaCodes.length > 0) {
    // a. 事業所適用コードの率を解決 (介護/総合事業どちらでも formula から率を取る)
    let appliedNum = 0;
    let appliedDen = 1000;
    {
      const { data, error } = await validInMonth(
        supabase
          .from("kaigo_service_codes")
          .select("service_code, formula, units, system")
          .in("service_code", opts.effectiveFormulaCodes)
          .not("formula", "is", null),
        opts.year,
        opts.month,
      );
      if (error) throw new Error(`総合事業 処遇改善率の解決に失敗: ${error.message}`);
      for (const r of (data ?? []) as {
        service_code: string;
        formula: { type?: string; numerator?: number; denominator?: number } | null;
        units: number;
        system: string;
      }[]) {
        const f = r.formula;
        if (f?.type === "monthly_aggregate" && f.numerator && f.denominator) {
          appliedNum = f.numerator;
          appliedDen = f.denominator;
          break; // 処遇改善Ⅰ〜Ⅳ は排他 (最初の 1 件)
        }
      }
    }

    // b. 一致する総合事業 A2 処遇改善コードを探す。
    //    保険者に合わせて CB_ (千葉市) / K_ (木更津) を選ぶべきだが、当面は率一致で採用し、
    //    複数保険者版が同率でヒットしたら CB_ (千葉市=現行相当) を優先する。
    if (appliedNum > 0) {
      const { data, error } = await validInMonth(
        supabase
          .from("kaigo_service_codes")
          .select("service_code, service_name, units, formula")
          .eq("system", "総合事業")
          .eq("service_category", "A2")
          .ilike("service_name", "%処遇改善%"),
        opts.year,
        opts.month,
      );
      if (error) throw new Error(`総合事業 処遇改善コード取得失敗: ${error.message}`);
      const cands = (data ?? []) as {
        service_code: string;
        service_name: string;
        units: number;
        formula: { type?: string; numerator?: number; denominator?: number } | null;
      }[];
      // 率 = formula.numerator (あれば) or units。分母は 1000 前提。
      const rateOf = (c: (typeof cands)[number]) =>
        c.formula?.numerator && c.formula?.denominator
          ? { num: c.formula.numerator, den: c.formula.denominator }
          : { num: c.units, den: 1000 };
      // 適用率 (appliedNum/appliedDen) と同率のコードを抽出
      const matched = cands.filter((c) => {
        const { num, den } = rateOf(c);
        // num/den === appliedNum/appliedDen を整数比較 (交差積)
        return num * appliedDen === appliedNum * den;
      });
      // CB_ 優先 (千葉市)。無ければ先頭。
      const pick =
        matched.find((c) => c.service_code.startsWith("CB_")) ?? matched[0] ?? null;
      if (pick) {
        const { num, den } = rateOf(pick);
        addonNum = num;
        addonDen = den;
        addonLabel = pick.service_name;
        addonCode = pick.service_code;
      } else {
        warnings.push(
          `総合事業: 事業所の処遇改善率 (${appliedNum}/${appliedDen}) に一致する総合事業の処遇改善コードが見つかりません — 処遇改善なしで集計しています (サービスコードマスタを確認してください)`,
        );
      }
    }
  }

  // 5) 利用者ごとに集計
  //    user_id → (service_type → count)
  const byUser = new Map<string, Map<string, number>>();
  const daysByUser = new Map<string, Set<string>>();
  for (const s of sougouSchedules) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, new Map());
    const m = byUser.get(s.user_id)!;
    m.set(s.service_type, (m.get(s.service_type) ?? 0) + 1);
    if (!daysByUser.has(s.user_id)) daysByUser.set(s.user_id, new Set());
    daysByUser.get(s.user_id)!.add(s.visit_date);
  }

  const unitPrice = opts.unitPrice > 0 ? opts.unitPrice : 10.0;
  const unitPrice100 = Math.round(unitPrice * 100);

  const rows: UserSeikyuRow[] = [];
  for (const [userId, typeCounts] of byUser) {
    const client = clientById.get(userId);
    const cert = certByClient.get(userId) ?? null;
    const userLabel = client?.name ?? userId;
    if (cert?.isFallback) {
      warnings.push(
        `${userLabel}: 対象月 (${monthStr}) に有効な認定が見つからないため最新の認定情報で総合事業を集計しています`,
      );
    }
    // 負担率正規化 (aggregate.ts と同じ。1 以上は /10)
    const copayRaw = cert?.copay_rate != null ? Number(cert.copay_rate) : null;
    const copay =
      copayRaw == null || !Number.isFinite(copayRaw) || copayRaw <= 0 ? 0.1
      : copayRaw >= 1 ? Math.min(copayRaw / 10, 1)
      : copayRaw;

    // 基本コードの単位を積む。月額包括 (1月につき) は回数を掛けない (月1)。
    const details: SeikyuDetailLine[] = [];
    let baseUnits = 0;
    for (const [svcType, count] of typeCounts) {
      const master = masterOf(svcType);
      if (!master) {
        warnings.push(
          `${userLabel}: 総合事業「${svcType}」がマスタ (system=総合事業/A2/対象月世代) から引けません — サービス名/有効期間を確認してください`,
        );
        continue;
      }
      const isMonthly = master.unitType.includes("月"); // '1月につき' = 月額包括
      const billCount = isMonthly ? 1 : count;
      const units = master.units * billCount;
      baseUnits += units;
      details.push({
        service_type: svcType,
        short_name: master.short ?? null,
        service_code: master.code,
        unit_per: master.units,
        count: billCount,
        units,
      });
    }
    details.sort((a, b) => b.units - a.units);

    // 処遇改善 (%加算) は本体単位に対して計算 (介護と同方式)。総合事業に限度額超過管理は当面なし。
    const addonUnits = addonNum > 0 ? Math.round((baseUnits * addonNum) / addonDen) : 0;
    const totalUnits = baseUnits + addonUnits;
    const totalAmount = Math.floor((totalUnits * unitPrice100) / 100);

    // 公費単独 (H番号) — 介護と同じ扱い
    const kohiTandoku = /^[Hh]/.test((cert?.insured_number ?? "").trim());
    const kohi = kohiRes.byClient.get(userId) ?? null;
    const copayX10 = Math.min(10, Math.max(0, Math.round(copay * 10)));
    const insuranceAmount = kohiTandoku ? 0 : Math.floor((totalAmount * (10 - copayX10)) / 10);
    const publicExpense =
      (kohi ? kohiHobetsuLabel(kohi.hobetsu) : null) ??
      (kohiTandoku ? "公費単独 (生活保護 10割)" : null);
    const kohiUnits = publicExpense ? totalUnits : null;
    const kohiAmount = kohiTandoku
      ? totalAmount
      : publicExpense
      ? totalAmount - insuranceAmount
      : null;
    const userAmount = publicExpense ? 0 : totalAmount - insuranceAmount;

    rows.push({
      system: "総合事業",
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
      // 総合事業は当面 限度額超過管理なし (全量給付対象)。
      // TODO: 要支援枠の区分支給限度基準を導入する場合は aggregate.ts と同じ超過振替を実装する。
      grossBaseUnits: baseUnits,
      limitUnits: null,
      planUnits: null,
      overUnits: 0,
      overSource: "auto",
      overAmount: 0,
      selfPayAmount: 0,
      baseUnits,
      addonUnits,
      // 限度額管理対象外 = 処遇改善%加算のみ (超過管理をしないので実質 addonUnits と同義)
      kanriTaishougaiUnits: addonUnits,
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
      careOfficeNumber:
        cert?.care_office_number?.trim() ||
        (cert?.care_office_id ? officeNumberById.get(cert.care_office_id) ?? null : null),
      careOfficeName:
        cert?.care_office_name?.trim() ||
        (cert?.care_office_id ? officeNameById.get(cert.care_office_id) ?? null : null),
      serviceDays: daysByUser.get(userId)?.size ?? 0,
    });
  }

  rows.sort((a, b) =>
    (a.user_name_kana ?? a.user_name).localeCompare(
      b.user_name_kana ?? b.user_name,
      "ja",
    ),
  );

  return { rows, warnings };
}
