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
  // ─── 月次情報 (請求前チェック) 用 ───
  /** 受給者証 認定有効期間 (開始 / 終了)。null = 未設定 (開放期間) */
  certStart: string | null;
  certEnd: string | null;
  /** 支給量を超過したサービス種別のラベル (空 = 超過なし)。金額には影響しない目視警告用 */
  shikyuryoOver: string[];
}

export interface ShogaiSeikyuResult {
  rows: ShogaiSeikyuRow[];
  month: string; // YYYY-MM
  recordCount: number;
  /** 集計時の注意事項 (月途中の市町村変更 等)。集計値には影響しない */
  warnings: string[];
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
    /** 提供時間 (分)。支給量超過警告の実績時間集計に使用。null は 0 扱い */
    duration_minutes?: number | null;
  }
  const records: Rec[] = [];
  let offset = 0;
  while (true) {
    let q = supabase
      .from("shogai_service_records")
      .select("client_id, service_type, service_category, service_code, unit_count, service_date, duration_minutes")
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
    interface SchedRow {
      user_id: string;
      service_type: string | null;
      visit_date: string;
      start_time: string | null;
      end_time: string | null;
    }
    const schedRows: SchedRow[] = [];
    let soff = 0;
    let schedOk = true;
    while (true) {
      let sq = supabase
        .from("kaigo_visit_schedule")
        .select("user_id, service_type, visit_date, start_time, end_time")
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
      // "HH:MM(:SS)" → 分。終了 < 開始 は日跨ぎとして +1440 分
      const toMinOfDay = (t: string | null): number | null => {
        if (!t) return null;
        const [h, mi] = t.split(":");
        const n = Number(h) * 60 + Number(mi);
        return Number.isFinite(n) ? n : null;
      };
      const schedRecs: Rec[] = [];
      for (const s of schedRows) {
        const name = (s.service_type ?? "").trim();
        const m = nameMap.get(name);
        if (!m) continue; // 障害コードに解決できない = 介護/総合 → スキップ
        const st = toMinOfDay(s.start_time);
        const en = toMinOfDay(s.end_time);
        const dur =
          st != null && en != null ? (en >= st ? en - st : en + 1440 - st) : null;
        schedRecs.push({
          client_id: s.user_id,
          service_type: name,
          service_category: m.category,
          service_code: m.code,
          unit_count: m.units,
          service_date: s.visit_date,
          duration_minutes: dur,
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
    return { rows: [], month: monthStr, recordCount: 0, warnings: [] };
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
    certification_start_date: string | null;
    certification_end_date: string | null;
    /** 居宅介護等サービスの契約 (提供開始) 日。初回加算の初回月判定に使う。
     *  受給者証有効期間 (certification_start_date) は更新のたびに動くため初回判定には使わない。 */
    contract_start_date: string | null;
    /** 特別地域加算 対象 (中山間地域等の居住者)。列未適用(42703)/未設定は undefined→false */
    flag_special_area?: boolean | null;
    /** 支給決定量の内訳 (時間/回/単位)。列未適用(42703)/未設定は undefined→null */
    shikyuryo_details?: Record<
      string,
      { hours?: number; minutes?: number; count?: number; units?: number }
    > | null;
  }
  // 拡張列 (flag_special_area / shikyuryo_details) が未適用(42703)の環境では
  // 列を落として再取得する (フォールバック必須 — 従来動作 = 加算・警告なし)。
  const CERT_BASE_COLS =
    "client_id, beneficiary_number, insurer_municipality, support_level, self_payment_limit, seiho_flag, jogen_kanri_kubun, jogen_kanri_office_number, jogen_kanri_office_name, certification_start_date, certification_end_date, contract_start_date";
  const CERT_EXT_COLS = `${CERT_BASE_COLS}, flag_special_area, shikyuryo_details`;
  let certCols = CERT_EXT_COLS;
  const certByClient = new Map<string, Cert>();
  // 月途中の市町村変更検出用に全件も保持 (解決自体は従来どおり最新 1 件)
  const certsAllByClient = new Map<string, Cert[]>();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    let resp = await supabase
      .from("shougai_certifications")
      .select(certCols)
      .in("client_id", chunk)
      .order("certification_start_date", { ascending: false });
    if (resp.error?.code === "42703" && certCols === CERT_EXT_COLS) {
      // 拡張列未適用 → 基本列のみで再取得 (以降のチャンクも基本列)
      certCols = CERT_BASE_COLS;
      resp = await supabase
        .from("shougai_certifications")
        .select(certCols)
        .in("client_id", chunk)
        .order("certification_start_date", { ascending: false });
    }
    const { data, error } = resp;
    if (error) throw new Error(`受給者証取得失敗: ${error.message}`);
    for (const r of (data ?? []) as unknown as Cert[]) {
      if (!certByClient.has(r.client_id)) certByClient.set(r.client_id, r);
      const list = certsAllByClient.get(r.client_id);
      if (list) list.push(r);
      else certsAllByClient.set(r.client_id, [r]);
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

  // 3.8) 特別地域加算 (障害福祉サービス) — 受給者証 flag_special_area=true の利用者に算定。
  //   根拠: 障害者総合支援法「厚生労働大臣が定める一単位の単価及び…特別地域加算等」
  //         (H18 厚労告示第539号 等) — 中山間地域等の「利用者の居住地」が厚労大臣が定める
  //         特別地域に該当する訪問系サービス提供に、所定単位数の 100分の15 を加算する。
  //   対象サービス: 居宅介護(11) / 重度訪問介護(12) / 行動援護(13) / 同行援護(14)。
  //   加算単位数 = round(サービス種類ごとの所定単位数合計 × 15/100)。母数は所定単位のみ
  //   (処遇改善等の加算は含めない)。逆に処遇改善加算の母数(総単位数)には本加算を算入する。
  //   マスタ(system='障害')の特別地域加算コードを対象月で解決 (validInMonth)。
  //   コードは 居宅=116015「居介特地加算」(0単位%加算) / 重訪=121921 / 行動=131921 / 同行=141921。
  //   flag 未設定 / 列未適用(42703) の利用者は加算なし = 従来動作。
  const SPECIAL_AREA_RATE_NUM = 15;
  const SPECIAL_AREA_RATE_DEN = 100;
  const SPECIAL_AREA_CANDIDATE_CODES: Record<string, string> = {
    "11": "116015", // 居宅介護
    "12": "121921", // 重度訪問介護
    "13": "131921", // 行動援護
    "14": "141921", // 同行援護
  };
  const specialAreaByTypeCode = new Map<string, { code: string; label: string }>();
  const anySpecialArea = Array.from(certByClient.values()).some(
    (c) => c.flag_special_area === true,
  );
  if (anySpecialArea) {
    const { data, error } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_code, service_name")
        .eq("system", "障害")
        .in("service_code", Object.values(SPECIAL_AREA_CANDIDATE_CODES)),
      opts.year,
      opts.month,
    );
    if (error) throw new Error(`特別地域加算コード取得失敗: ${error.message}`);
    const nameByCode = new Map<string, string>();
    for (const c of (data ?? []) as { service_code: string; service_name: string }[]) {
      if (!nameByCode.has(c.service_code)) nameByCode.set(c.service_code, c.service_name);
    }
    for (const [tc, code] of Object.entries(SPECIAL_AREA_CANDIDATE_CODES)) {
      const label = nameByCode.get(code);
      if (label) specialAreaByTypeCode.set(tc, { code, label });
    }
  }

  // 3.85) 初回加算 (居介初回 116020 等) — 制度ルール: 当該訪問系サービスの提供開始月
  //   (= 受給者証 contract_start_date の月) に 200単位/月 を算定する。
  //   ここで initial 月を判定する signal に certification_start_date (受給者証更新日) や
  //   「過去月の実績有無」を使わないのは、前者は更新月に、後者は本システム稼働初月
  //   (履歴が無い) に false-positive するため。契約 (提供開始) 日を持つ contract_start_date が
  //   制度上の初回月と一致する唯一の列。
  //   加算コードは master (system='障害') を service_category (=種類コード) で解決する。
  //   対象種類は master の service_category と初回加算コードが 1:1 で一致する
  //   居宅介護(11=116020)/重度訪問介護(12=126020)/行動援護(13=136020) に限定する。
  //   同行援護 は master の category 割当 (14=重包/15=同援) が本ファイルの SERVICE_TYPE_CODES
  //   (14=同行援護) と食い違うため自動算定せず、必要時は加算エディタから入力する。
  //   計画相談・自立生活援助等の初回加算は算定条件・単位が異なるため対象外。
  //   contract_start_date が未入力/列未適用 の利用者は算定なし = 従来動作。
  const SHOKAI_TYPE_CODES = ["11", "12", "13"];
  const shokaiByTypeCode = new Map<
    string,
    { code: string; units: number; label: string }
  >();
  const anyShokaiMonth = Array.from(certByClient.values()).some(
    (c) => (c.contract_start_date ?? "").slice(0, 7) === monthStr,
  );
  if (anyShokaiMonth) {
    const { data, error } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_code, service_name, units, service_category")
        .eq("system", "障害")
        .in("service_category", SHOKAI_TYPE_CODES)
        .like("service_name", "%初回%"),
      opts.year,
      opts.month,
    );
    if (error) throw new Error(`初回加算コード取得失敗: ${error.message}`);
    for (const c of (data ?? []) as {
      service_code: string;
      service_name: string;
      units: number;
      service_category: string | null;
    }[]) {
      const tc = c.service_category ?? c.service_code.slice(0, 2);
      // 種類ごと 1 コード (validInMonth 済のため先勝ち)。率もの(units<=0)は対象外
      if (tc && c.units > 0 && !shokaiByTypeCode.has(tc)) {
        shokaiByTypeCode.set(tc, {
          code: c.service_code,
          units: c.units,
          label: c.service_name,
        });
      }
    }
  }

  // 3.9) 提供表の加算エディタ (障害モード) 由来の回/月単位加算 — kaigo_visit_addon_lines
  //   (system='障害') を対象月マスタ (system='障害') で解決し「単位×回数」の明細行として
  //   利用者の details に足す。居介初回 116020 / 緊急時対応 116025 / 福祉専門職員等連携
  //   116105 / 上限額管理 115010 / 喀痰吸引 116100、重訪 12 系 (126020 等) を想定。
  //   - テーブル未作成 (42P01) / system 列未適用 (42703) は加算なし = 従来動作
  //   - %加算 (formula) / 加算以外 / units<=0 / マスタ世代なし は集計に載せず警告
  //   - 処遇改善の母数には算入する (基本+加算が算定基礎)。特別地域 (所定単位×15%) の
  //     母数には入れない。行が空 (通常) はこの節は完全 no-op = 従来と同値。
  interface ShogaiGenericLine {
    code: string;
    name: string;
    unitPer: number;
    count: number;
    units: number;
  }
  const genericByClient = new Map<string, ShogaiGenericLine[]>();
  const genericWarnings: string[] = [];
  if (opts.officeId) {
    interface GenericRow {
      client_id: string;
      addon_code: string;
      count: number | null;
    }
    const lineRows: GenericRow[] = [];
    let gOffset = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("kaigo_visit_addon_lines")
        .select("client_id, addon_code, count")
        .eq("office_id", opts.officeId)
        .eq("target_month", monthStr)
        .eq("system", "障害")
        .order("id", { ascending: true })
        .range(gOffset, gOffset + 999);
      if (error) {
        const featureOff =
          error.code === "42P01" ||
          error.code === "PGRST205" ||
          error.code === "42703" ||
          error.code === "PGRST204" ||
          /column .* does not exist/i.test(error.message);
        if (featureOff) break; // migration 未適用 = 障害の加算行なし (従来動作)
        throw new Error(`障害 加算行の取得に失敗: ${error.message}`);
      }
      const page = (data ?? []) as unknown as GenericRow[];
      lineRows.push(...page);
      if (page.length < 1000) break;
      gOffset += 1000;
    }
    if (lineRows.length > 0) {
      type GenericMaster =
        | { ok: true; name: string; units: number }
        | { ok: false; name: string | null; reason: string };
      const master = new Map<string, GenericMaster>();
      const codes = Array.from(new Set(lineRows.map((r) => r.addon_code)));
      for (let i = 0; i < codes.length; i += 50) {
        const chunk = codes.slice(i, i + 50);
        const { data, error } = await validInMonth(
          supabase
            .from("kaigo_service_codes")
            .select("service_code, service_name, units, calculation_type, formula")
            .eq("system", "障害")
            .in("service_code", chunk),
          opts.year,
          opts.month,
        );
        if (error) throw new Error(`障害 加算行コード解決失敗: ${error.message}`);
        for (const r of (data ?? []) as {
          service_code: string;
          service_name: string;
          units: number;
          calculation_type: string | null;
          formula: unknown;
        }[]) {
          if (master.has(r.service_code)) continue; // 先勝ち (validInMonth 済)
          if (r.formula != null) {
            master.set(r.service_code, {
              ok: false,
              name: r.service_name,
              reason:
                "%加算 (処遇改善等) は事業所の適用加算側で自動計算するため、加算エディタからは集計しません",
            });
          } else if (r.calculation_type !== "加算") {
            master.set(r.service_code, {
              ok: false,
              name: r.service_name,
              reason: `加算コードではありません (${r.calculation_type ?? "区分不明"})`,
            });
          } else if (!(r.units > 0)) {
            master.set(r.service_code, {
              ok: false,
              name: r.service_name,
              reason: "率加算 (マスタ単位数 0) の自動計算は未対応のため集計しません",
            });
          } else {
            master.set(r.service_code, {
              ok: true,
              name: r.service_name,
              units: r.units,
            });
          }
        }
      }
      for (const r of lineRows) {
        const count = r.count ?? 0;
        if (count <= 0) continue;
        const m = master.get(r.addon_code);
        if (!m) {
          genericWarnings.push(
            `加算行 ${r.addon_code}: 対象月に有効な障害マスタ世代が無いため集計しません — サービスコードマスタを確認してください`,
          );
          continue;
        }
        if (!m.ok) {
          genericWarnings.push(`${m.name ?? r.addon_code}: ${m.reason}`);
          continue;
        }
        if (!genericByClient.has(r.client_id)) genericByClient.set(r.client_id, []);
        genericByClient.get(r.client_id)!.push({
          code: r.addon_code,
          name: m.name,
          unitPer: m.units,
          count,
          units: m.units * count,
        });
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

    // 特別地域加算 (中山間地域等の居住者)。所定単位数 × 15% を加算行として追加。
    // 処遇改善の母数 (総単位数) にも算入するため専用 map を持つ。
    const isSpecialArea = cert?.flag_special_area === true;
    const chuguzenUnitsByType = new Map<string, number>(unitsByType);
    if (isSpecialArea) {
      for (const [tc, units] of unitsByType) {
        const sa = specialAreaByTypeCode.get(tc);
        if (!sa || units <= 0) continue; // 訪問系以外 / マスタ未解決は対象外
        const su = Math.round((units * SPECIAL_AREA_RATE_NUM) / SPECIAL_AREA_RATE_DEN);
        if (su <= 0) continue;
        addons.push({ service_code: sa.code, service_name: sa.label, units: su });
        chuguzenUnitsByType.set(tc, (chuguzenUnitsByType.get(tc) ?? 0) + su);
      }
    }

    // 提供表 (障害モード) の回/月単位加算 — 明細行に足し、処遇改善の母数にも算入する
    // (特別地域の母数 unitsByType には入れない = 所定単位のみが正)
    const generic = genericByClient.get(userId) ?? [];
    let genericUnits = 0;
    for (const g of generic) {
      details.push({
        service_type: g.name,
        service_category: null,
        service_code: g.code,
        unit_per: g.unitPer,
        count: g.count,
        units: g.units,
      });
      genericUnits += g.units;
      const tc = g.code.slice(0, 2);
      chuguzenUnitsByType.set(tc, (chuguzenUnitsByType.get(tc) ?? 0) + g.units);
    }

    // 初回加算 (提供開始月) — contract_start_date の月が提供月と一致する利用者に、
    // 所定単位のある訪問系サービス種類ごと 200単位/月 を明細行として 1 行追加。
    // 処遇改善の母数 (chuguzenUnitsByType) にも算入する (ほのぼの KJ と同様、初回加算は
    // 処遇改善の算定基礎に含まれる)。手入力の加算行 (generic) に同コードが既にある場合は
    // 二重計上を避けてスキップ。
    if (
      shokaiByTypeCode.size > 0 &&
      (cert?.contract_start_date ?? "").slice(0, 7) === monthStr
    ) {
      const alreadyGeneric = new Set(generic.map((g) => g.code));
      for (const [tc, units] of unitsByType) {
        if (units <= 0) continue; // 当月に当該種類の提供実績がある場合のみ
        const sk = shokaiByTypeCode.get(tc);
        if (!sk || alreadyGeneric.has(sk.code)) continue;
        details.push({
          service_type: sk.label,
          service_category: null,
          service_code: sk.code,
          unit_per: sk.units,
          count: 1,
          units: sk.units,
        });
        genericUnits += sk.units;
        chuguzenUnitsByType.set(tc, (chuguzenUnitsByType.get(tc) ?? 0) + sk.units);
      }
    }

    // 処遇改善加算等 (母数 = 所定単位 + 特別地域加算 + 回/月単位加算 + 初回加算)
    for (const [tc, units] of chuguzenUnitsByType) {
      const rate = addonByTypeCode.get(tc);
      if (!rate || units <= 0) continue;
      const au = Math.round((units * rate.num) / rate.den);
      if (au > 0) {
        addons.push({ service_code: rate.code, service_name: rate.label, units: au });
      }
    }
    addons.sort((a, b) => a.service_code.localeCompare(b.service_code));
    const addonUnits = addons.reduce((s, a) => s + a.units, 0);

    const totalUnits = baseUnits + genericUnits + addonUnits;
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
      certStart: cert?.certification_start_date ?? null,
      certEnd: cert?.certification_end_date ?? null,
      shikyuryoOver: [],
    });
  }

  rows.sort((a, b) =>
    (a.user_name_kana ?? a.user_name).localeCompare(
      b.user_name_kana ?? b.user_name,
      "ja",
    ),
  );

  // 5) 月途中の市町村変更 (転居) の検出 — 検出のみで集計値は変えない。
  //    障害の国保連請求 (J11 等) は市町村単位のため、対象月に有効な受給者証が
  //    複数あり市町村番号が異なる場合はレセプトの提出先が月内で変わる。
  //    現行の集計は最新 1 件の市町村に全実績を載せるので warning で知らせる。
  const warnings: string[] = [];
  // 3.9) の加算行の解決警告 + 実績が無い利用者の加算行 (集計対象外) を知らせる
  warnings.push(...genericWarnings);
  for (const [cid, lines] of genericByClient) {
    if (!byUser.has(cid)) {
      warnings.push(
        `当月の実績が無い利用者に障害の加算行が ${lines.length} 件あります (集計対象外) — 提供表 (障害モード) を確認してください`,
      );
    }
  }
  for (const r of rows) {
    const certs = certsAllByClient.get(r.user_id);
    if (!certs || certs.length < 2) continue;
    // 対象月と期間が重なる受給者証 (start <= 月末 かつ end >= 月初。null は開放期間)
    const inMonth = certs.filter(
      (c) =>
        (c.certification_start_date == null || c.certification_start_date <= to) &&
        (c.certification_end_date == null || c.certification_end_date >= from),
    );
    if (inMonth.length < 2) continue;
    // 開始日 昇順 (旧→新) で市町村番号を並べ、連続重複を除去
    inMonth.sort((a, b) =>
      (a.certification_start_date ?? "").localeCompare(b.certification_start_date ?? ""),
    );
    const munis: string[] = [];
    for (const c of inMonth) {
      const m = (c.insurer_municipality ?? "").trim();
      if (!m) continue; // 未入力は変更判定に含めない
      if (munis[munis.length - 1] !== m) munis.push(m);
    }
    if (new Set(munis).size < 2) continue;
    warnings.push(
      `${r.user_name}さん: 月内に市町村変更があります (${munis.join("→")})。障害のレセプト分割は未対応 — 提出先を確認して手動対応してください`,
    );
  }

  // 5.5) 特別地域加算: flag は立っているが対象月マスタに加算コードが解決できなかった場合。
  //   訪問系の所定単位がある利用者で加算が 0 行なら加算漏れの可能性を知らせる。
  if (anySpecialArea && specialAreaByTypeCode.size === 0) {
    warnings.push(
      "特別地域加算の対象利用者がいますが、対象月のマスタに特別地域加算コード (116015/121921/131921/141921) が見つからないため加算していません — サービスコードマスタ (system=障害) を確認してください",
    );
  }

  // 6) 支給量超過の警告 — 受給者証 shikyuryo_details (支給決定量=上限) に対し、
  //    当月実績 (時間/回/単位) がサービス種別ごとに超過していれば知らせる。金額は変えない。
  //    実績のサービス種別を支給量内訳キーへ粗く突合する (重訪の区分別等、厳密に紐付けられ
  //    ないものは合算判定 or 対象外)。列未設定/未適用(42703) の利用者は shikyuryo_details が
  //    無いため警告なし。
  {
    // 実績レコード → 支給量内訳バケットキーへのマッピング (居宅は category から細分)
    const bucketOf = (r: Rec): string | null => {
      const tc = r.service_code?.slice(0, 2) ?? SERVICE_TYPE_CODES[r.service_type] ?? null;
      const name = `${r.service_type} ${r.service_category ?? ""}`;
      if (tc === "11") {
        if (/乗降/.test(name)) return "jouko";
        if (/通院/.test(name)) return /身体/.test(name) ? "tsuuin_shintai" : "tsuuin";
        if (/家事|生活/.test(name)) return "kaji";
        return "shintai"; // 身体介護中心 (既定)
      }
      if (tc === "12") return "juudo_houmon"; // 重訪は区分別に突合不可 → 合算バケット
      if (tc === "13") return "koudou";
      if (tc === "14") return /身体/.test(name) ? "doukou_shintai" : "doukou";
      return null; // 短期入所・生活介護等は訪問系でないため対象外
    };
    interface ActualAgg {
      minutes: number;
      count: number;
      units: number;
    }
    const actualsByUser = new Map<string, Map<string, ActualAgg>>();
    for (const r of records) {
      const bucket = bucketOf(r);
      if (!bucket) continue;
      let m = actualsByUser.get(r.client_id);
      if (!m) {
        m = new Map();
        actualsByUser.set(r.client_id, m);
      }
      const a = m.get(bucket) ?? { minutes: 0, count: 0, units: 0 };
      a.minutes += r.duration_minutes ?? 0;
      a.count += 1;
      a.units += r.unit_count ?? 0;
      m.set(bucket, a);
    }
    // 支給量内訳キー → {表示名, 単位種別}
    const SHIKYURYO_DEFS: Record<string, { label: string; kind: "time" | "count" | "units" }> = {
      shintai: { label: "身体介護", kind: "time" },
      jouko: { label: "乗降介助", kind: "count" },
      kaji: { label: "家事援助", kind: "time" },
      tsuuin: { label: "通院介助", kind: "time" },
      tsuuin_shintai: { label: "通院介助 (身体あり)", kind: "time" },
      doukou: { label: "同行援護", kind: "time" },
      doukou_shintai: { label: "同行援護 (身体あり)", kind: "time" },
      koudou: { label: "行動援護", kind: "time" },
      juudo_houkatsu: { label: "重度障害者等包括支援", kind: "units" },
    };
    type ShikyuVal = { hours?: number; minutes?: number; count?: number; units?: number };
    const toMin = (v: ShikyuVal) => (v.hours ?? 0) * 60 + (v.minutes ?? 0);
    const fmtMin = (min: number) => {
      const h = Math.floor(min / 60);
      const m = Math.round(min % 60);
      return m ? `${h}時間${m}分` : `${h}時間`;
    };
    for (const r of rows) {
      const sd = certByClient.get(r.user_id)?.shikyuryo_details;
      if (!sd || Object.keys(sd).length === 0) continue;
      const actuals = actualsByUser.get(r.user_id) ?? new Map<string, ActualAgg>();
      for (const [key, def] of Object.entries(SHIKYURYO_DEFS)) {
        const v = sd[key] as ShikyuVal | undefined;
        if (!v) continue;
        const act = actuals.get(key) ?? { minutes: 0, count: 0, units: 0 };
        if (def.kind === "time") {
          const lim = toMin(v);
          if (lim > 0 && act.minutes > lim) {
            warnings.push(
              `${r.user_name}さん: ${def.label}が支給量${fmtMin(lim)}を超えています (実績${fmtMin(act.minutes)})`,
            );
            r.shikyuryoOver.push(def.label);
          }
        } else if (def.kind === "count") {
          const lim = v.count ?? 0;
          if (lim > 0 && act.count > lim) {
            warnings.push(
              `${r.user_name}さん: ${def.label}が支給量${lim}回を超えています (実績${act.count}回)`,
            );
            r.shikyuryoOver.push(def.label);
          }
        } else {
          const lim = v.units ?? 0;
          if (lim > 0 && act.units > lim) {
            warnings.push(
              `${r.user_name}さん: ${def.label}が支給量${lim}単位を超えています (実績${act.units}単位)`,
            );
            r.shikyuryoOver.push(def.label);
          }
        }
      }
      // 重度訪問介護: 支給量は区分別 (包括支援/区分6該当/その他) だが実績は区分判別不可のため
      // 合算して判定する (紐付けられないため注記付き)。
      const juhoKeys = [
        "juudo_houmon_houkatsu",
        "juudo_houmon_kubun6",
        "juudo_houmon_sonota",
      ];
      const juhoLimit = juhoKeys.reduce(
        (s, k) => s + (sd[k] ? toMin(sd[k] as ShikyuVal) : 0),
        0,
      );
      if (juhoLimit > 0) {
        const act = actuals.get("juudo_houmon") ?? { minutes: 0, count: 0, units: 0 };
        if (act.minutes > juhoLimit) {
          const note =
            juhoKeys.filter((k) => sd[k]).length > 1
              ? " ※重訪は区分別に突合できないため支給量を合算して判定"
              : "";
          warnings.push(
            `${r.user_name}さん: 重度訪問介護が支給量${fmtMin(juhoLimit)}を超えています (実績${fmtMin(act.minutes)})${note}`,
          );
          r.shikyuryoOver.push("重度訪問介護");
        }
      }
    }
  }

  return { rows, month: monthStr, recordCount: records.length, warnings };
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
