/**
 * 訪問入浴介護 請求集計 (v2: visit-seikyu と同等の制度対応)
 *
 * データフロー:
 *   kaigo_bath_visit_records (actual=true, confirmed/submitted。opts.includeScheduled 時は
 *     予定行 (planned=true) + kaigo_bath_schedule の未記録予定も含む = 売上見込)
 *     × kaigo_service_codes (service_code → units, 対象月世代)
 *     × client_insurance_records (認定=保険者/被保険者番号/要介護度/負担割合/限度額/居宅事業所, 月次解決)
 *     × client_kohi_records (公費)
 *     × bath_monthly_plan_units (計画単位数)
 *     × offices (地域単価 / 処遇改善加算)
 *   → 利用者ごとに UserSeikyuRow (visit-seikyu と同型 = build.ts に直結可)
 *
 * 制度対応(v2で追加):
 *   - copay_rate 正規化(≥1は/10)・認定の月次解決(月遅れ再請求に追従)
 *   - 居宅サービス計画作成事業所番号(careOfficeNumber)を認定から解決 → 様式第二 項20
 *   - 区分支給限度基準の超過→全額自費(selfPayAmount)分離
 *   - 公費(生保/公費単独=全額振替、部分公費=保険+本人負担で振替しない)
 *   - 回単位加算: 初回(124113 200/月 対象外)・認知症専門ケアⅠ/Ⅱ(126133/126134 /回)・中山間(128110 所定×5%)
 *   - 処遇改善(月次%)
 *   - 虐防/業未 (高齢者虐待防止措置未実施減算 / BCP未策定減算 各1%):
 *     訪問入浴 (種類12) も独立減算コードが無い合成コード方式 (121131/121141/121145 等)。
 *     事業所フラグ (kaigo_office_gensan_periods) が対象月に適用中なら、基本サービス
 *     コード (1211xx) をマスタ駆動で減算織込み済の合成コードへ差し替える
 *     (visit-seikyu/gyakutai-bcp.ts の resolver を種類12で流用)。
 *     テーブル未適用は空 = 従来動作 (減算なし)。解決不能時は元コード + warning。
 *     記録側で直接 虐防/業未 コードを選んでいた場合も名称から再構成するため二重適用しない。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ID_IN_CHUNK } from "@/lib/chunk-parallel";
import { validInMonth, monthRange } from "@/lib/service-code-valid";
import {
  getGensanPeriodsForMonth,
  gensanFlagsFromPeriods,
  gensanFlagsLabel,
  resolveGensanVariant,
} from "@/lib/visit-seikyu/gyakutai-bcp";
import {
  resolveCertForMonth,
  resolveCertsInMonth,
  detectMidMonthChange,
} from "@/lib/cert-for-month";
import { resolveKohiForMonth, kohiHobetsuLabel } from "@/lib/kohi";
import type { MonthlySeikyuResult, UserSeikyuRow, SeikyuDetailLine } from "@/lib/visit-seikyu/aggregate";

type BathRec = {
  client_id: string;
  visit_date: string;
  service_code: string | null;
  addon_shokai: boolean | null;
  addon_ninchi: "I" | "II" | null;
  addon_chuusankan: boolean | null;
};
type Cl = { id: string; name: string | null; furigana: string | null; user_number: string | null; gender: string | null; birth_date: string | null };

// 'YYYY-MM-DD' → 'M/D' (資格変更警告の表示用。visit-seikyu/aggregate.ts と同じ)
const fmtMD = (iso: string) => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[1])}/${Number(m[2])}` : iso;
};

// 回単位加算コード (種類12)
const CODE_SHOKAI = "124113"; // 訪問入浴初回加算 200単位/月 (限度額管理**対象**)
const CODE_NINCHI = { I: "126133", II: "126134" } as const; // 認知症専門ケア加算Ⅰ3/Ⅱ4 (/回)
const CODE_CHUUSANKAN = "128110"; // 中山間地域等提供加算 = 所定単位 × 5%

export async function aggregateBathVisitSeikyu(
  supabase: SupabaseClient,
  opts: {
    officeId: string | null;
    tenantId: string;
    year: number;
    month: number;
    unitPrice?: number;
    appliedFormulaCodes?: string[];
    /**
     * 売上 (見込) 集計モード。true = 予定行 (actual=false) と未確定 (draft/scheduled/completed)
     * も集計対象に含める。未指定/false = 確定実績のみ = 従来どおりの請求集計 (完全後方互換)。
     */
    includeScheduled?: boolean;
  },
): Promise<MonthlySeikyuResult> {
  const { year, month } = opts;
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const { monthStart, monthEnd } = monthRange(year, month);
  // 0 / 負値は「未設定」扱いで 10.00 円に倒す (visit-seikyu:1142 と同じ規律)。
  //   `?? 10` だけだと 0 がそのまま単価になり、全利用者の請求額が 0 円になる。
  const unitPrice = opts.unitPrice && opts.unitPrice > 0 ? opts.unitPrice : 10.0;
  const unitPrice100 = Math.round(unitPrice * 100);
  const warnings: string[] = [];

  // 1) 入浴実績 (実績=actual, 確定/請求済) — order 付き page-loop (PostgREST 1000 行キャップ対策)
  //    売上モード (includeScheduled) では 提供表の予定行 (planned=true, actual=false) と
  //    未確定 (status='draft') も含める。
  const PAGE = 1000;
  const records: BathRec[] = [];
  {
    let offset = 0;
    while (true) {
      // scheme: 予定側 (:129) は「地域生活支援は介護保険請求の対象外」として除外しているのに
      //   実績側は select にも条件にも入っていなかった (2026-08-31 監査)。
      //   = 千葉市移動支援の入浴が国保連請求に混入して二重請求になる。
      let q = supabase
        .from("kaigo_bath_visit_records")
        .select("client_id, visit_date, service_code, addon_shokai, addon_ninchi, addon_chuusankan, scheme")
        .eq("scheme", "介護保険")
        .gte("visit_date", monthStart)
        .lte("visit_date", monthEnd);
      q = opts.includeScheduled
        ? q.or("planned.eq.true,actual.eq.true")
        : q.eq("actual", true).in("status", ["confirmed", "submitted"]);
      if (opts.officeId) q = q.eq("office_id", opts.officeId);
      const { data: recData, error: recErr } = await q
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (recErr) throw recErr;
      const page = (recData ?? []) as BathRec[];
      records.push(...page);
      if (page.length < PAGE) break;
      offset += PAGE;
    }
  }

  // 1.5) 売上モード: まだ実績記録に落ちていないシフト予定 (kaigo_bath_schedule status='scheduled')
  //      も 1 件 = 1 訪問として積む。record_id が付いた行は 1) で拾っているので除外
  //      (二重計上防止)。算定コードは 入浴種別 × 通常体制 (職員のみでない) で仮置きする
  //      — 職員のみ (staff_only) は実績記録時に確定する情報なので予定段階では解決できない。
  if (opts.includeScheduled) {
    const SCHED_CODE = { 全身浴: "121111", 部分浴: "121112" } as const;
    let offset = 0;
    while (true) {
      let sq = supabase
        .from("kaigo_bath_schedule")
        .select("client_id, visit_date, bath_type, scheme")
        .eq("status", "scheduled")
        .is("record_id", null)
        .gte("visit_date", monthStart)
        .lte("visit_date", monthEnd);
      if (opts.officeId) sq = sq.eq("office_id", opts.officeId);
      const { data, error } = await sq.order("id", { ascending: true }).range(offset, offset + PAGE - 1);
      if (error) {
        // table 未作成 (シフト機能未適用) は予定 0 件として続行 (握らず warning)
        warnings.push(`入浴シフト予定の取得に失敗したため予定分は売上に含まれていません: ${error.message}`);
        break;
      }
      const page = (data ?? []) as { client_id: string; visit_date: string; bath_type: "全身浴" | "部分浴"; scheme: string | null }[];
      for (const s of page) {
        // 地域生活支援 (千葉市移動支援等) は介護保険請求の対象外
        if (s.scheme && s.scheme !== "介護保険") continue;
        records.push({
          client_id: s.client_id,
          visit_date: s.visit_date,
          service_code: SCHED_CODE[s.bath_type] ?? SCHED_CODE.全身浴,
          addon_shokai: false,
          addon_ninchi: null,
          addon_chuusankan: false,
        });
      }
      if (page.length < PAGE) break;
      offset += PAGE;
    }
  }
  if (records.length === 0)
    return { rows: [], month: monthKey, recordCount: 0, warnings, warningsByClient: {} };

  const clientIds = Array.from(new Set(records.map((r) => r.client_id)));

  // 2) サービスコード → 単位数 (基本 + 回単位加算コード, 対象月世代)
  const baseCodes = Array.from(new Set(records.map((r) => r.service_code).filter(Boolean))) as string[];
  const codeSet = Array.from(new Set([...baseCodes, CODE_SHOKAI, CODE_NINCHI.I, CODE_NINCHI.II]));
  const codeMap = new Map<string, { units: number; name: string; short: string | null }>();
  {
    const { data, error } = await validInMonth(
      supabase.from("kaigo_service_codes").select("service_code, service_name, short_name, units").in("service_code", codeSet).eq("system", "介護"),
      year,
      month,
    );
    if (error) throw error;
    for (const c of (data ?? []) as { service_code: string; service_name: string; short_name: string | null; units: number }[]) {
      if (!codeMap.has(c.service_code)) codeMap.set(c.service_code, { units: c.units, name: c.service_name, short: c.short_name });
    }
  }

  // 2.5) 虐防/業未 減算 (kaigo_office_gensan_periods)。対象月に適用中なら
  //      基本サービスコード (1211xx) → 減算織込み済合成コードの差し替え表を作る。
  //      既に変種コードの記録も名称から再構成して解決する (二重適用しない。
  //      解決先が同一コードなら差し替え不要なので登録しない)。
  const gensanSwap = new Map<
    string,
    { code: string; name: string; units: number; short: string | null }
  >();
  if (opts.officeId) {
    const gensanFlags = gensanFlagsFromPeriods(
      await getGensanPeriodsForMonth(supabase, opts.officeId, monthKey),
    );
    if (gensanFlags.gyakutai || gensanFlags.bcp) {
      const label = gensanFlagsLabel(gensanFlags);
      const targets = baseCodes.filter(
        (c) => c.startsWith("121") && codeMap.has(c),
      );
      const resolved = await Promise.all(
        targets.map((c) =>
          resolveGensanVariant(supabase, codeMap.get(c)!.name, gensanFlags, year, month, "12"),
        ),
      );
      targets.forEach((c, i) => {
        const v = resolved[i];
        const base = codeMap.get(c)!;
        if (v) {
          if (v.code !== c) {
            gensanSwap.set(c, {
              code: v.code,
              name: v.name,
              units: v.units,
              short: v.short ?? base.short,
            });
          }
        } else {
          console.warn(`[bath-seikyu] 減算バリエーション未解決: 「${base.name}」 (${label})`);
          warnings.push(
            `「${base.name}」の減算適用コード (${label}) が対象月 (${monthKey}) のマスタから引けません — 元のコードのまま (減算なしで) 集計します`,
          );
        }
      });
    }
  }

  // 3) 認定(月次解決) / 公費 / 計画単位数 / 利用者
  const certByClient = await resolveCertForMonth(supabase, clientIds, year, month);
  // 月途中の資格変更 (区分変更/保険者変更) 検出 + 限度額決定用 (Phase 1。visit-seikyu と同型)
  const certsInMonthByClient = await resolveCertsInMonth(supabase, clientIds, year, month);
  const kohiRes = await resolveKohiForMonth(supabase, clientIds, year, month);
  const planByClient = new Map<string, number>();
  {
    // 2026-08-31 監査での是正:
    //   office_id / client_id で絞らず page-loop も無かった。
    //   = 他事業所の計画単位数が限度額として当たり、かつ 1000 行キャップで
    //     静かに欠落していた。対象利用者 + 自事業所に限定してページングする。
    let q = supabase
      .from("bath_monthly_plan_units")
      .select("client_id, planned_units")
      .eq("target_month", `${monthKey}-01`);
    if (opts.officeId) q = q.eq("office_id", opts.officeId);
    if (clientIds.length > 0) q = q.in("client_id", clientIds);
    const { data, error } = await q;
    if (error) {
      // テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) は
      // 計画なし = 認定限度額フォールバックで続行。それ以外は握りつぶさず warning
      if (error.code !== "42P01" && error.code !== "PGRST205") {
        console.error("[bath-seikyu] 計画単位数取得失敗:", error.message);
        warnings.push(
          `計画単位数 (bath_monthly_plan_units) の取得に失敗しました (${error.message}) — 認定の限度額のみで超過判定しています`,
        );
      }
    } else {
      for (const p of (data ?? []) as { client_id: string; planned_units: number | null }[]) {
        // 0 は「未設定」扱い (認定限度額フォールバックへ)。visit-seikyu:1120 と同じ規律。
        //   2026-08-31 監査まで `!= null` だけを見ており、UI から 0 が入ると
        //   「限度額 0」= 全額が超過 → 自費 と解釈していた
        //   (全身浴8回で 保険請求 2,000円 → 180円 / 自費 101,280円)。
        if (p.planned_units == null || p.planned_units <= 0) continue;
        planByClient.set(p.client_id, p.planned_units);
      }
    }
  }
  const clientMap = new Map<string, Cl>();
  {
    const { data, error } = await supabase.from("clients").select("id, name, furigana, user_number, gender, birth_date").in("id", clientIds);
    if (error) throw error;
    for (const c of (data ?? []) as Cl[]) clientMap.set(c.id, c);
  }

  // 3.5) 担当居宅介護支援事業所のマスタ解決 (visit-seikyu 4.5 と同流儀)。
  // 介護認定タブは 2way (マスタ選択 care_office_id ⇔ 直接入力 care_office_number) で、
  // マスタ選択時は number が空になる。number 直列だけ見ると「担当居宅未設定」に
  // 誤判定され様式第二 項20 も空になるため、care_office_id → care_offices を解決する。
  // (care_offices = ケアマネ事業所マスタ。自社 offices ではないので注意)
  const careNumberById = new Map<string, string | null>();
  const careNameById = new Map<string, string | null>();
  {
    const careOfficeIds = Array.from(
      new Set(
        Array.from(certByClient.values())
          .map((v) => v?.care_office_id)
          .filter(Boolean) as string[],
      ),
    );
    for (let i = 0; i < careOfficeIds.length; i += ID_IN_CHUNK) {
      const chunk = careOfficeIds.slice(i, i + ID_IN_CHUNK);
      const { data, error } = await supabase
        .from("care_offices")
        .select("id, office_number, name")
        .in("id", chunk)
        .order("id", { ascending: true });
      if (error) throw new Error(`居宅事業所取得失敗: ${error.message}`);
      for (const o of (data ?? []) as { id: string; office_number: string | null; name: string | null }[]) {
        careNumberById.set(o.id, o.office_number);
        careNameById.set(o.id, o.name);
      }
    }
  }

  // 4) 処遇改善加算 formula (月次%)
  let addonNum = 0;
  let addonDen = 1;
  let addonCode: string | null = null;
  let addonLabel: string | null = null;
  //    解決順序 (visit-seikyu:968-1002 と同じ):
  //      a. kaigo_office_addon_periods (期間指定) が対象月に有効ならそれを優先
  //      b. 該当 0 件なら offices.applied_formula_codes にフォールバック
  //
  //    2026-08-31 監査まで b しか見ていなかった。加算設定 UI は periods にしか
  //    書かないので、**設定しても入浴側は 0% のまま = 処遇改善が丸ごと請求漏れ**。
  let formulaCodes = opts.appliedFormulaCodes ?? [];
  if (opts.officeId) {
    const { data: periodRows, error: periodError } = await supabase
      .from("kaigo_office_addon_periods")
      .select("formula_code, start_month, end_month")
      .eq("office_id", opts.officeId);
    if (periodError) {
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
          (r.start_month == null || r.start_month <= monthKey) &&
          (r.end_month == null || r.end_month >= monthKey),
      );
      if (inMonth.length > 0) formulaCodes = inMonth.map((r) => r.formula_code);
    }
  }
  if (formulaCodes.length) {
    // error を捨てていた (visit 側は throw)。取得失敗を「加算なし」と誤認しないようにする。
    const { data, error: formulaError } = await validInMonth(
      supabase.from("kaigo_service_codes").select("service_code, service_name, formula").in("service_code", formulaCodes).eq("system", "介護").not("formula", "is", null),
      year,
      month,
    );
    if (formulaError) {
      throw new Error(`処遇改善加算マスタの取得に失敗: ${formulaError.message}`);
    }
    for (const r of (data ?? []) as { service_code: string; service_name: string; formula: { type?: string; numerator?: number; denominator?: number } | null }[]) {
      const f = r.formula;
      if (f?.type === "monthly_aggregate" && f.numerator && f.denominator) {
        addonNum = f.numerator; addonDen = f.denominator; addonCode = r.service_code; addonLabel = r.service_name; break;
      }
    }
  }

  // 5) 利用者ごと集計
  const byClient = new Map<string, BathRec[]>();
  for (const r of records) {
    if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
    byClient.get(r.client_id)!.push(r);
  }

  const rows: UserSeikyuRow[] = [];
  for (const [clientId, recs] of byClient) {
    const cl = clientMap.get(clientId);
    const cert = certByClient.get(clientId) ?? null;
    const name = cl?.name ?? "(利用者不明)";
    if (cert?.isFallback) warnings.push(`${name}: 対象月(${monthKey})に有効な認定が無く最新の認定で集計しています — 認定有効期間を確認してください`);

    // 負担割合の正規化 (1/2/3 → 0.1/0.2/0.3)
    const copayRaw = cert?.copay_rate != null ? Number(cert.copay_rate) : null;
    const copay = copayRaw == null || !Number.isFinite(copayRaw) || copayRaw <= 0 ? 0.1 : copayRaw >= 1 ? Math.min(copayRaw / 10, 1) : copayRaw;
    // ── 月途中の資格変更 (Phase 1: 検出 + 限度額のみ。visit-seikyu/aggregate.ts と同型) ──
    // ケース3: 月内に複数の認定があるときは service_limit_amount の最大値
    // (= 重い方の区分支給限度基準額) を月全体に適用する。
    // ※「重い方を月全体適用」= 介護保険法施行規則 第68条第1項で確認済 (2026-07-11。
    //   詳細は visit-seikyu/aggregate.ts の同コメント参照)。
    const certsInMonth = certsInMonthByClient.get(clientId) ?? [];
    const midChange = detectMidMonthChange(certsInMonth);
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
        warnings.push(
          `${name}さん: 月内に要支援↔要介護の区分変更 (${c.from}→${c.to}${when}) があります — 制度を跨ぐためレセプトの自動対応外です。手動対応してください`,
        );
      } else {
        warnings.push(
          `${name}さん: 月内に区分変更 (${c.from}→${c.to}${when})。限度額は重い方 (${(limitAmount ?? 0).toLocaleString()}単位) を適用。レセプトの要介護度は月末時点で出力`,
        );
      }
    }
    if (midChange?.insurerChange) {
      // ケース2: Phase 1 は検出のみ (レセプト分割は未対応)
      const ic = midChange.insurerChange;
      const insurerDiff =
        (ic.fromInsurer ?? "").trim() !== (ic.toInsurer ?? "").trim() &&
        !!ic.fromInsurer &&
        !!ic.toInsurer;
      const label = insurerDiff ? "保険者" : "被保険者番号";
      const desc = insurerDiff
        ? `${ic.fromInsurer}→${ic.toInsurer}`
        : `${ic.fromInsured ?? "?"}→${ic.toInsured ?? "?"}`;
      warnings.push(
        `${name}さん: ${label}が月内で変わっています (${desc})。レセプト分割は未対応 — 月遅れ保留か手動対応を検討してください`,
      );
    }

    // 明細: 記録の service_code ごと。加算コード (124/126/128系) は
    // 提供表の「サービス追加」経由で記録行として入ることがある。
    const detailMap = new Map<string, SeikyuDetailLine>();
    for (const r of recs) {
      const rawCode = r.service_code;
      if (!rawCode) { warnings.push(`${name}: サービスコード未設定の記録があります`); continue; }
      // 虐防/業未 適用中は基本コードを減算織込み済の合成コードへ差し替え
      const swap = gensanSwap.get(rawCode);
      const info = swap ?? codeMap.get(rawCode);
      if (!info) { warnings.push(`${name}: コード${rawCode}が対象月マスタに未一致`); continue; }
      const code = swap ? swap.code : rawCode;
      const ex = detailMap.get(code);
      if (ex) { ex.count += 1; ex.units += info.units; }
      else detailMap.set(code, { service_type: info.name, short_name: info.short, service_code: code, unit_per: info.units, count: 1, units: info.units });
    }
    // 所定単位 (基本 121xxx のみ) = %加算 (中山間等) の母数
    const serviceBaseUnits = Array.from(detailMap.values())
      .filter((d) => (d.service_code ?? "").startsWith("121"))
      .reduce((s, d) => s + d.units, 0);

    // %加算 (マスタ units=0 の率加算)。提供表のサービス追加で行として入った場合は
    // 所定単位×率で単位数を計算し直す (0単位のまま出さない)
    const RATE_ADDONS: Record<string, { rate: number; label: string }> = {
      "128000": { rate: 0.15, label: "特別地域訪問入浴介護加算" },
      "128100": { rate: 0.10, label: "訪問入浴小規模事業所加算" },
      "128110": { rate: 0.05, label: "訪問入浴中山間地域等提供加算" },
    };
    for (const [code, { rate }] of Object.entries(RATE_ADDONS)) {
      const row = detailMap.get(code);
      if (row && serviceBaseUnits > 0) {
        const cu = Math.round(serviceBaseUnits * rate);
        row.unit_per = cu;
        row.count = 1;
        row.units = cu;
      }
    }

    const details = Array.from(detailMap.values());
    let grossBaseUnits = details.reduce((s, d) => s + d.units, 0);
    // 限度額管理**対象外**の単位数。
    //
    // ★ 2026-09-01 監査是正: visit-seikyu と分類が逆だった。
    //   visit 側は 2026-07-17 の ほのぼの KK 突合で確定している
    //   (大網5名の初回加算200単位を ほのぼのは限度額管理対象=項9 に計上):
    //     管理対象   … 基本サービス + 初回加算 + 緊急時 + 認知症専門ケア 等の実単位加算
    //     管理対象外 … 処遇改善等の %加算 + 特別地域 + 小規模 + 中山間 (率加算のみ)
    //   bath はこれが逆で、初回加算を対象外に、率加算 (中山間) を管理対象にしていた。
    //   → 伝送 様式第二 の 項10 (限度額管理対象) ↔ 項11 (対象外) が誤配置になり、
    //     超過判定の母数も間違う。visit と同じ分類に揃える。
    let taishougaiUnits = Array.from(detailMap.values())
      .filter((d) => d.service_code != null && d.service_code in RATE_ADDONS)
      .reduce((sum, d) => sum + d.units, 0);

    // 記録フラグ由来の加算。同コードが既に行として存在する場合はスキップ (二重計上防止 —
    // 記録のチェックと提供表サービス追加のどちらで入れても 1 回だけ算定される)
    const pushAddon = (code: string, count: number, kanriTaishougai: boolean) => {
      if (count <= 0 || detailMap.has(code)) return;
      const info = codeMap.get(code);
      if (!info) { warnings.push(`${name}: 加算コード${code}が対象月マスタに未一致`); return; }
      const units = info.units * count;
      grossBaseUnits += units;
      if (kanriTaishougai) taishougaiUnits += units;
      details.push({ service_type: info.name, short_name: info.short, service_code: code, unit_per: info.units, count, units });
    };
    // 初回加算: 月1回(いずれかの記録でON)。**限度額管理の対象** (visit と同じ / ほのぼの突合で確定)
    if (recs.some((r) => r.addon_shokai)) pushAddon(CODE_SHOKAI, 1, false);
    // 認知症専門ケア: 記録(回)ごと。Ⅰ/Ⅱ別に集計
    const ninchiI = recs.filter((r) => r.addon_ninchi === "I").length;
    const ninchiII = recs.filter((r) => r.addon_ninchi === "II").length;
    if (ninchiI > 0) pushAddon(CODE_NINCHI.I, ninchiI, false);
    if (ninchiII > 0) pushAddon(CODE_NINCHI.II, ninchiII, false);
    // 中山間地域等提供加算 = 所定単位 × 5% (いずれかの記録でON、行が無い場合のみ)
    if (recs.some((r) => r.addon_chuusankan) && serviceBaseUnits > 0 && !detailMap.has(CODE_CHUUSANKAN)) {
      const cu = Math.round(serviceBaseUnits * 0.05);
      const info = codeMap.get(CODE_CHUUSANKAN);
      grossBaseUnits += cu;
      // 中山間は率加算 = 限度額管理**対象外** (2026-09-01 是正。従来は管理対象に入れていた)
      taishougaiUnits += cu;
      details.push({ service_type: info?.name ?? "訪問入浴中山間地域等提供加算", short_name: info?.short ?? null, service_code: CODE_CHUUSANKAN, unit_per: cu, count: 1, units: cu });
    }

    details.sort((a, b) => b.units - a.units);

    // 区分支給限度基準の超過→全額自費
    const planUnits = planByClient.get(clientId) ?? null;
    const limitUnits = planUnits ?? limitAmount;
    const managedUnits = grossBaseUnits - taishougaiUnits;
    const autoOver = limitUnits != null ? Math.max(0, managedUnits - limitUnits) : 0;
    const overUnits = Math.min(autoOver, managedUnits);
    const baseUnits = grossBaseUnits - overUnits;
    const addonUnits = addonNum > 0 ? Math.round((baseUnits * addonNum) / addonDen) : 0;
    // 様式第二 集計「⑥限度額管理対象外単位数」= 処遇改善等の%加算 + 率加算 (特別地域/小規模/中山間)
    const kanriTaishougaiUnits = addonUnits + taishougaiUnits;
    const totalUnits = baseUnits + addonUnits;
    const totalAmount = Math.floor((totalUnits * unitPrice100) / 100);
    const overAmount = Math.floor((overUnits * unitPrice100) / 100);

    // 公費: 生保(法別12)/公費単独=全額振替。部分公費(他法別)=振替しない(保険+本人負担)
    const kohiTandoku = /^[Hh]/.test((cert?.insured_number ?? "").trim());
    const kohi = kohiRes.byClient.get(clientId) ?? null;
    const isSeiho = kohiTandoku || kohi?.hobetsu === "12";
    const copayX10 = Math.min(10, Math.max(0, Math.round(copay * 10)));
    const insuranceAmount = kohiTandoku ? 0 : Math.floor((totalAmount * (10 - copayX10)) / 10);
    // 部分公費 (生保以外) は振替しないので、公費欄そのものを出さない。
    //   ラベルだけ載せると伝送ビルダーが「法別番号あり」と見て 0 円の公費レコードを作る。
    const publicExpense = isSeiho
      ? (kohi ? kohiHobetsuLabel(kohi.hobetsu) : "公費単独 (生活保護 10割)")
      : null;
    if (kohi && !isSeiho) {
      warnings.push(
        `${name}: 公費(${kohiHobetsuLabel(kohi.hobetsu)})は部分公費のため、本人負担を残し公費振替しません。` +
          `**この利用者は公費分の請求が出ません** — 手当てが要るか確認してください`,
      );
    }
    //
    // ★ 2026-09-01 監査是正 (2 件)
    //
    // ① 生保の本人負担上限月額 (honnin_futan) を一度も読んでいなかった。
    //    介護券に本人支払額が設定されている利用者は、その額まで本人が負担し、
    //    公費が負担するのは残りだけ。読まないと**その額のぶん公費請求が過大**になる。
    //    visit-seikyu:1779 と同じく負値・小数は防御的に整数化する。
    // ② 部分公費 (生保以外) は振替しない設計なのに publicExpense に法別ラベルを
    //    載せていたため、伝送ビルダーが「法別番号あり = 公費欄あり」と判断して
    //    **公費請求額 0 円の公費レコード**を出していた (内部矛盾したまま送信)。
    //    振替しないなら公費欄そのものを出さない (ラベルを載せない) のが正しい。
    const honninLimit = kohi ? Math.max(0, Math.floor(kohi.honninFutan ?? 0)) : 0;
    const seihoUserAmount = isSeiho ? Math.min(honninLimit, totalAmount - insuranceAmount) : 0;
    if (isSeiho && honninLimit > 0) {
      warnings.push(
        `${name}: 生保の本人負担上限月額 ${honninLimit.toLocaleString()} 円を適用しました (公費請求はその分減ります)`,
      );
    }
    const kohiAmount = kohiTandoku
      ? Math.max(0, totalAmount - seihoUserAmount)
      : isSeiho
        ? Math.max(0, totalAmount - insuranceAmount - seihoUserAmount)
        : null;
    const userAmount = isSeiho ? seihoUserAmount : totalAmount - insuranceAmount;

    rows.push({
      user_id: clientId,
      user_name: name,
      user_name_kana: cl?.furigana ?? null,
      user_number: cl?.user_number ?? null,
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
      overSource: "auto",
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
      kohiHobetsu: kohi?.hobetsu ?? (kohiTandoku ? "12" : null),
      kohiFutanshaNumber: kohi?.futansha ?? null,
      kohiJukyushaNumber: kohi?.jukyusha ?? null,
      kohiUnits: isSeiho ? totalUnits : null,
      kohiAmount,
      addonCode,
      birthDate: cl?.birth_date ?? null,
      gender: cl?.gender ?? null,
      certStart: cert?.certification_start_date ?? null,
      certEnd: cert?.certification_end_date ?? null,
      // 直接入力 (care_office_number) 優先。無ければ care_office_id → care_offices 解決
      careOfficeNumber:
        cert?.care_office_number?.trim() ||
        (cert?.care_office_id ? careNumberById.get(cert.care_office_id) ?? null : null),
      careOfficeName:
        cert?.care_office_name?.trim() ||
        (cert?.care_office_id ? careNameById.get(cert.care_office_id) ?? null : null),
      serviceDays: new Set(recs.map((r) => r.visit_date)).size,
      // 居宅サービス計画作成区分の取込 (一覧CSV) は訪問介護のみ。訪問入浴は従来どおり
      // careOfficeNumber の有無から builder が既定値を決める。
      planCreatorKubun: null,
      // 提供開始年月日は訪問介護の明細書だけが持つ項目 (総合事業・訪問入浴は対象外)
      serviceStartDate: null,
    });
  }
  rows.sort((a, b) => (a.user_name_kana ?? a.user_name).localeCompare(b.user_name_kana ?? b.user_name, "ja"));

  return {
    rows,
    month: monthKey,
    recordCount: records.length,
    warnings: Array.from(new Set(warnings)),
    warningsByClient: {},
  };
}
