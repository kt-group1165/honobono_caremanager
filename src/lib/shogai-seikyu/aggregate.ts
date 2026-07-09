/**
 * 障害福祉サービス 請求集計 (障害請求画面 + 国保連 CSV 用)
 *
 * データフロー:
 *   shogai_service_records (status='confirmed' = 実績確定)
 *     × clients (氏名)
 *     × shougai_certifications (受給者証番号 / 市町村番号 / 障害支援区分 / 上限月額 / 生保)
 *   → 利用者ごとに 1 行の請求サマリ + サービスコード別明細
 *
 * 金額計算 (障害者総合支援法の標準):
 *   加算単位数 = round(サービス種類ごとの所定単位数合計 × 加算率)   ※処遇改善加算等 (monthly_aggregate)
 *   総単位数 = 所定単位数 + 加算単位数
 *   総費用額 = floor(総単位数 × 地域単価)
 *   利用者負担 = min(floor(総費用額 × 負担率 10%), 負担上限月額)   ※生保は 0
 *   介護給付費請求額 = 総費用額 - 利用者負担
 *
 * 処遇改善加算等の区分は kaigo_office_addon_periods (office_id × formula_code ×
 * 期間) から対象月で引き、kaigo_service_codes (system='障害') の formula
 * ({type:'monthly_aggregate', numerator, denominator, rounding:'round'}) を突合する
 * (介護の visit-seikyu/aggregate.ts と同じ仕組み)。加算率はサービス種類
 * (居宅介護=11 / 重度訪問介護=12 — コード先頭 2 桁) ごとに別区分。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { validInMonth } from "@/lib/service-code-valid";

export interface ShogaiSeikyuDetail {
  /** サービス種別 (居宅介護 等) */
  service_type: string;
  /** サービス内容 (身体介護 等 category) */
  service_category: string | null;
  /** サービスコード (6 桁) */
  service_code: string | null;
  /** 1 回あたり単位数 */
  unit_per: number;
  /** 回数 */
  count: number;
  /** 小計単位数 */
  units: number;
}

/** 処遇改善加算等の 1 行 (サービス種類ごとに 1 行、月 1 回算定) */
export interface ShogaiAddonLine {
  /** 加算サービスコード (115121 等 6 桁。先頭 2 桁 = サービス種類コード) */
  service_code: string;
  /** 加算名称 (居宅介護処遇改善加算Ⅱイ 等) */
  service_name: string;
  /** 加算単位数 = round(所定単位数合計 × 加算率) */
  units: number;
}

export interface ShogaiSeikyuRow {
  user_id: string;
  user_name: string;
  user_name_kana: string | null;
  /** 受給者証番号 */
  beneficiary_number: string | null;
  /** 市町村番号 (支給決定自治体) */
  municipality: string | null;
  /** 障害支援区分 */
  support_level: string | null;
  /** 負担上限月額 (null = 未設定 / 0 = 負担0円。生保は 0 に正規化) */
  self_payment_limit: number | null;
  /** 生保フラグ */
  seiho: boolean;
  details: ShogaiSeikyuDetail[];
  /** 処遇改善加算等の加算行 (サービス種類ごと。加算なしは空配列) */
  addons: ShogaiAddonLine[];
  /** 加算単位数 合計 */
  addonUnits: number;
  /** 加算の名称 (先頭行。表示用) */
  addonLabel: string | null;
  /** 加算のサービスコード (先頭行) */
  addonCode: string | null;
  /** 総単位数 (所定 + 加算) */
  totalUnits: number;
  unitPrice: number;
  /** 総費用額 (円) */
  totalAmount: number;
  /** 利用者負担額 (上限適用 + 上限管理結果反映後) */
  userAmount: number;
  /** 介護給付費請求額 */
  benefitAmount: number;
  // ─── 利用者負担上限額管理 ───
  /** 上限管理: なし / 自事業所 / 他事業所 */
  jogenKanriKubun: string;
  /** 上限額管理事業所番号 */
  jogenKanriOfficeNumber: string | null;
  /** 上限額管理事業所名 */
  jogenKanriOfficeName: string | null;
  /** 管理結果区分 (1/2/3)。未入力は null */
  kanriResult: number | null;
  /** 管理結果後の当事業所分 利用者負担額 (区分 1/3 のとき userAmount に反映済) */
  kanriResultAmount: number | null;
}

export interface ShogaiSeikyuResult {
  rows: ShogaiSeikyuRow[];
  month: string; // YYYY-MM
  recordCount: number;
}

export async function aggregateMonthlyShogaiSeikyu(
  supabase: SupabaseClient,
  opts: {
    year: number;
    month: number;
    unitPrice?: number;
    /** 自事業所 office_id — 実績のスコープ (office_id = 自 or NULL) と
     *  処遇改善加算の区分 (kaigo_office_addon_periods) 解決に使用 */
    officeId?: string | null;
  },
): Promise<ShogaiSeikyuResult> {
  const monthStr = `${opts.year}-${String(opts.month).padStart(2, "0")}`;
  const daysInMonth = new Date(opts.year, opts.month, 0).getDate();
  const from = `${monthStr}-01`;
  const to = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;
  const unitPrice = opts.unitPrice && opts.unitPrice > 0 ? opts.unitPrice : 10.0;
  // 単価は整数 (×100) で持ち回り float 誤差を避ける (訪問介護側と同じパターン)
  const unitPrice100 = Math.round(unitPrice * 100);

  // 1) 実績 (confirmed) を月範囲で取得 (page-loop)
  const PAGE = 1000;
  interface Rec {
    client_id: string;
    service_type: string;
    service_category: string | null;
    service_code: string | null;
    unit_count: number | null;
    /** 重複排除用 (下流未使用)。shogai=service_date / schedule=visit_date */
    service_date?: string | null;
  }
  const records: Rec[] = [];
  let offset = 0;
  while (true) {
    let q = supabase
      .from("shogai_service_records")
      .select("client_id, service_type, service_category, service_code, unit_count, service_date")
      .eq("status", "confirmed")
      .gte("service_date", from)
      .lte("service_date", to);
    // 自事業所スコープ (office_id 未設定の旧データは含める)
    if (opts.officeId) {
      q = q.or(`office_id.eq.${opts.officeId},office_id.is.null`);
    }
    const { data, error } = await q
      .order("id") // page-loop の安定順序 (1000 行超で行落ち/重複しないように)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`実績取得失敗: ${error.message}`);
    const rows = (data ?? []) as Rec[];
    records.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  // 1.5) シフト/提供表 (kaigo_visit_schedule の completed) の障害実績も集計元に統合する。
  //   障害請求を予定/実績と連動させるため (2026-07-09)。介護請求が kaigo_visit_schedule
  //   を集計元にするのと対称に、障害も同テーブルの completed 行を集計元にする。
  //   service_type (サービス名) が障害マスタ (system='障害', validInMonth) に解決できる行のみ
  //   障害実績とみなし、shogai_service_records と同じ Rec 形 (1件=1オカレンス,
  //   unit_count=1件あたり単位数) にして追加する。介護/総合の行は名前解決に失敗するので自然に除外。
  //   同一 (client × code × date) が shogai_service_records と両方にある場合は
  //   スケジュール優先で重複排除 (二重計上防止)。
  {
    const keyOf = (r: Rec) => `${r.client_id}__${r.service_code ?? ""}__${r.service_date ?? ""}`;
    interface SchedRow { user_id: string; service_type: string | null; visit_date: string }
    const schedRows: SchedRow[] = [];
    let soff = 0;
    let schedOk = true;
    while (true) {
      let sq = supabase
        .from("kaigo_visit_schedule")
        .select("user_id, service_type, visit_date")
        .eq("status", "completed")
        .gte("visit_date", from)
        .lte("visit_date", to);
      if (opts.officeId) sq = sq.or(`office_id.eq.${opts.officeId},office_id.is.null`);
      const { data, error } = await sq.order("id").range(soff, soff + PAGE - 1);
      if (error) {
        // office_id 列未適用(42703) 等は schedule 連携をスキップ (握らず warn)
        console.warn("[shogai] シフト実績の取得に失敗 (schedule 連携スキップ):", error.message);
        schedOk = false;
        break;
      }
      const rows = (data ?? []) as SchedRow[];
      schedRows.push(...rows);
      if (rows.length < PAGE) break;
      soff += PAGE;
    }
    if (schedOk && schedRows.length > 0) {
      const names = Array.from(new Set(schedRows.map((s) => (s.service_type ?? "").trim()).filter(Boolean)));
      const nameMap = new Map<string, { code: string; units: number; category: string | null }>();
      for (let i = 0; i < names.length; i += 50) {
        const chunk = names.slice(i, i + 50);
        const { data, error } = await validInMonth(
          supabase
            .from("kaigo_service_codes")
            .select("service_code, service_name, units, service_category")
            .eq("system", "障害")
            .in("service_name", chunk),
          opts.year,
          opts.month,
        );
        if (error) { console.warn("[shogai] 障害コード解決に失敗 (一部スキップ):", error.message); continue; }
        for (const c of (data ?? []) as { service_code: string; service_name: string; units: number; service_category: string | null }[]) {
          const k = c.service_name.trim();
          if (!nameMap.has(k)) nameMap.set(k, { code: c.service_code, units: c.units, category: c.service_category });
        }
      }
      const schedRecs: Rec[] = [];
      for (const s of schedRows) {
        const name = (s.service_type ?? "").trim();
        const m = nameMap.get(name);
        if (!m) continue; // 障害コードに解決できない = 介護/総合 → スキップ
        schedRecs.push({
          client_id: s.user_id,
          service_type: name,
          service_category: m.category,
          service_code: m.code,
          unit_count: m.units,
          service_date: s.visit_date,
        });
      }
      if (schedRecs.length > 0) {
        // スケジュール優先: 同一 client×code×date の shogai_service_records 行を除外
        const schedKeys = new Set(schedRecs.map(keyOf));
        for (let i = records.length - 1; i >= 0; i--) {
          if (schedKeys.has(keyOf(records[i]))) records.splice(i, 1);
        }
        records.push(...schedRecs);
      }
    }
  }

  if (records.length === 0) {
    return { rows: [], month: monthStr, recordCount: 0 };
  }

  // 2) 利用者情報
  const userIds = Array.from(new Set(records.map((r) => r.client_id)));
  const clientById = new Map<string, { name: string; furigana: string | null }>();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, furigana")
      .in("id", chunk);
    if (error) throw new Error(`利用者取得失敗: ${error.message}`);
    for (const c of (data ?? []) as { id: string; name: string; furigana: string | null }[]) {
      clientById.set(c.id, { name: c.name, furigana: c.furigana });
    }
  }

  // 3) 受給者証 (最新 = certification_start_date DESC の 1 件)
  interface Cert {
    client_id: string;
    beneficiary_number: string | null;
    insurer_municipality: string | null;
    support_level: string | null;
    self_payment_limit: number | null;
    seiho_flag: boolean | null;
    jogen_kanri_kubun: string | null;
    jogen_kanri_office_number: string | null;
    jogen_kanri_office_name: string | null;
  }
  const certByClient = new Map<string, Cert>();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("shougai_certifications")
      .select(
        "client_id, beneficiary_number, insurer_municipality, support_level, self_payment_limit, seiho_flag, jogen_kanri_kubun, jogen_kanri_office_number, jogen_kanri_office_name, certification_start_date",
      )
      .in("client_id", chunk)
      .order("certification_start_date", { ascending: false });
    if (error) throw new Error(`受給者証取得失敗: ${error.message}`);
    for (const r of (data ?? []) as Cert[]) {
      if (!certByClient.has(r.client_id)) certByClient.set(r.client_id, r);
    }
  }

  // 3.5) 月次 上限額管理結果 (管理結果区分 1/3 は利用者負担を調整後額に置換)
  interface KanriResult {
    client_id: string;
    kanri_result: number | null;
    kanri_result_amount: number | null;
  }
  const kanriByClient = new Map<string, KanriResult>();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("shogai_jogen_kanri_results")
      .select("client_id, kanri_result, kanri_result_amount")
      .eq("target_month", monthStr)
      .in("client_id", chunk);
    if (error) throw new Error(`上限管理結果取得失敗: ${error.message}`);
    for (const r of (data ?? []) as KanriResult[]) {
      kanriByClient.set(r.client_id, r);
    }
  }

  // 3.7) 処遇改善加算等の加算率 — kaigo_office_addon_periods (対象月で有効な区分)
  //      → kaigo_service_codes (system='障害') の formula (monthly_aggregate) を突合。
  //      サービス種類コード (コード先頭 2 桁: 11=居宅介護 / 12=重度訪問介護) ごとに 1 区分。
  //      テーブル未作成 (42P01 / PGRST205) や該当なしは加算なし (従来どおり)。
  interface AddonRate {
    num: number;
    den: number;
    label: string;
    code: string;
  }
  const addonByTypeCode = new Map<string, AddonRate>();
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
      const codes = ((periodRows ?? []) as {
        formula_code: string;
        start_month: string | null;
        end_month: string | null;
      }[])
        .filter(
          (r) =>
            (r.start_month == null || r.start_month <= monthStr) &&
            (r.end_month == null || r.end_month >= monthStr),
        )
        .map((r) => r.formula_code);
      if (codes.length > 0) {
        // 同一 service_code の世代が複数あるため対象月の世代の formula を採用
        const { data, error } = await validInMonth(
          supabase
            .from("kaigo_service_codes")
            .select("service_code, service_name, formula")
            .in("service_code", codes)
            .eq("system", "障害")
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
            const typeCode = r.service_code.slice(0, 2);
            // 処遇改善Ⅰ〜Ⅳ等は種類内で排他のため先勝ち
            if (!addonByTypeCode.has(typeCode)) {
              addonByTypeCode.set(typeCode, {
                num: f.numerator,
                den: f.denominator,
                label: r.service_name,
                code: r.service_code,
              });
            }
          }
        }
      }
    }
  }

  // 4) 利用者 × (service_type + code) 集計
  const byUser = new Map<string, Map<string, ShogaiSeikyuDetail>>();
  for (const r of records) {
    if (!byUser.has(r.client_id)) byUser.set(r.client_id, new Map());
    const m = byUser.get(r.client_id)!;
    const key = `${r.service_type}__${r.service_code ?? ""}__${r.service_category ?? ""}`;
    const cur = m.get(key);
    const unitPer = r.unit_count ?? 0;
    if (cur) {
      cur.count += 1;
      cur.units += unitPer;
    } else {
      m.set(key, {
        service_type: r.service_type,
        service_category: r.service_category,
        service_code: r.service_code,
        unit_per: unitPer,
        count: 1,
        units: unitPer,
      });
    }
  }

  const rows: ShogaiSeikyuRow[] = [];
  for (const [userId, detailMap] of byUser) {
    const client = clientById.get(userId);
    const cert = certByClient.get(userId);
    const details = Array.from(detailMap.values()).sort((a, b) => b.units - a.units);
    const baseUnits = details.reduce((s, d) => s + d.units, 0);

    // 処遇改善加算等: サービス種類 (コード先頭 2 桁 / 種類名) ごとに所定単位を集計し
    // 加算単位 = round(所定単位数合計 × 加算率) を 1 月 1 行で算定
    const unitsByType = new Map<string, number>();
    for (const d of details) {
      const tc =
        d.service_code?.slice(0, 2) ?? SERVICE_TYPE_CODES[d.service_type] ?? null;
      if (!tc) continue;
      unitsByType.set(tc, (unitsByType.get(tc) ?? 0) + d.units);
    }
    const addons: ShogaiAddonLine[] = [];
    for (const [tc, units] of unitsByType) {
      const rate = addonByTypeCode.get(tc);
      if (!rate || units <= 0) continue;
      const au = Math.round((units * rate.num) / rate.den);
      if (au > 0) {
        addons.push({ service_code: rate.code, service_name: rate.label, units: au });
      }
    }
    addons.sort((a, b) => a.service_code.localeCompare(b.service_code));
    const addonUnits = addons.reduce((s, a) => s + a.units, 0);

    const totalUnits = baseUnits + addonUnits;
    // 整数演算: 総費用額 = floor(総単位数 × (単価×100) / 100) — float 誤差回避
    const totalAmount = Math.floor((totalUnits * unitPrice100) / 100);
    const seiho = !!cert?.seiho_flag;
    // 負担上限月額: null = 未設定 / 0 = 負担0円 (低所得区分等)。生保は 0 円に正規化
    const limit: number | null = seiho ? 0 : (cert?.self_payment_limit ?? null);
    // 1割相当額 (totalAmount は整数なので /10 の floor で正確)
    let userAmount = Math.floor(totalAmount / 10);
    if (limit !== null) userAmount = Math.min(userAmount, limit);
    // 上限額管理結果の反映:
    //   区分 1 (管理事業所で充当済) / 3 (管理結果票のとおり調整) → 調整後額に置換
    //   区分 2 (合算が上限以下で調整なし) → そのまま
    const kanri = kanriByClient.get(userId) ?? null;
    if (
      kanri?.kanri_result != null &&
      kanri.kanri_result !== 2 &&
      kanri.kanri_result_amount != null
    ) {
      userAmount = Math.min(kanri.kanri_result_amount, totalAmount);
    }
    const benefitAmount = totalAmount - userAmount;

    rows.push({
      user_id: userId,
      user_name: client?.name ?? "(利用者不明)",
      user_name_kana: client?.furigana ?? null,
      beneficiary_number: cert?.beneficiary_number ?? null,
      municipality: cert?.insurer_municipality ?? null,
      support_level: cert?.support_level ?? null,
      self_payment_limit: limit,
      seiho,
      details,
      addons,
      addonUnits,
      addonLabel: addons[0]?.service_name ?? null,
      addonCode: addons[0]?.service_code ?? null,
      totalUnits,
      unitPrice,
      totalAmount,
      userAmount,
      benefitAmount,
      jogenKanriKubun: cert?.jogen_kanri_kubun ?? "なし",
      jogenKanriOfficeNumber: cert?.jogen_kanri_office_number ?? null,
      jogenKanriOfficeName: cert?.jogen_kanri_office_name ?? null,
      kanriResult: kanri?.kanri_result ?? null,
      kanriResultAmount: kanri?.kanri_result_amount ?? null,
    });
  }

  rows.sort((a, b) =>
    (a.user_name_kana ?? a.user_name).localeCompare(
      b.user_name_kana ?? b.user_name,
      "ja",
    ),
  );

  return { rows, month: monthStr, recordCount: records.length };
}

// ─── 国保連 CSV (介護給付費・訓練等給付費等明細書 J121 相当の簡易形式) ─────────

const SERVICE_TYPE_CODES: Record<string, string> = {
  居宅介護: "11",
  重度訪問介護: "12",
  行動援護: "13",
  同行援護: "14",
};

/** サービス種類コード → 種類名 (加算行の表示用 逆引き) */
export const SERVICE_TYPE_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(SERVICE_TYPE_CODES).map(([name, code]) => [code, name]),
);

/** CSV セル: `"` `,` 改行 を含む値は quote + `""` エスケープ */
function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * 国保連請求 CSV 文字列を生成。
 * 完全な interface 仕様 (交換情報識別番号付き固定長 multi-record) は
 * 伝送ソフトの取込仕様確定後に対応する。ここでは明細書 (J121) 相当の
 * 項目を網羅した明細 CSV を出す。
 */
export function buildShogaiSeikyuCsv(
  rows: ShogaiSeikyuRow[],
  year: number,
  month: number,
): string {
  const ym = `${year}${String(month).padStart(2, "0")}`;
  const header = [
    "提供年月",
    "市町村番号",
    "受給者証番号",
    "支給決定障害者等氏名",
    "障害支援区分",
    "サービス種類コード",
    "サービス種類",
    "サービスコード",
    "サービス内容",
    "単位数",
    "回数",
    "サービス単位数",
    "合計単位数",
    "総費用額",
    "利用者負担上限月額",
    "利用者負担額",
    "介護給付費請求額",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    for (const d of r.details) {
      lines.push(
        [
          ym,
          r.municipality ?? "",
          r.beneficiary_number ?? "",
          r.user_name,
          r.support_level ?? "",
          SERVICE_TYPE_CODES[d.service_type] ?? "",
          d.service_type,
          d.service_code ?? "",
          d.service_category ?? "",
          d.unit_per,
          d.count,
          d.units,
          r.totalUnits,
          r.totalAmount,
          r.self_payment_limit ?? "",
          r.userAmount,
          r.benefitAmount,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    // 処遇改善加算等 (月次加算、回数 1)
    for (const a of r.addons) {
      const tc = a.service_code.slice(0, 2);
      lines.push(
        [
          ym,
          r.municipality ?? "",
          r.beneficiary_number ?? "",
          r.user_name,
          r.support_level ?? "",
          tc,
          SERVICE_TYPE_NAMES[tc] ?? "",
          a.service_code,
          a.service_name,
          a.units,
          1,
          a.units,
          r.totalUnits,
          r.totalAmount,
          r.self_payment_limit ?? "",
          r.userAmount,
          r.benefitAmount,
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }
  return lines.join("\r\n");
}
