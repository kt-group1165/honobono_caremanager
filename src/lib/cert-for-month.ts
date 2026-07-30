import type { SupabaseClient } from "@supabase/supabase-js";
import { mapChunksParallel } from "./chunk-parallel";

/**
 * 認定情報 (client_insurance_records) を「対象月に有効な認定」で解決する共有リゾルバ。
 *
 * 背景 (2026-07-08 総点検): 各画面が「effective_date / certification_start_date の
 * 最新 1 件」を使っていたため、月遅れ再請求で認定更新・区分変更を跨ぐと
 * 古い提供月のレセプトに新しい要介護度・負担割合・被保険者番号が載っていた。
 *
 * 選択規則:
 *   1. certification_start_date <= 対象月末 かつ (certification_end_date IS NULL
 *      または >= 対象月初) の行のうち、certification_start_date が最新のもの
 *   2. 該当なしなら従来どおり最新 1 件 (isFallback=true) — 認定期間未入力の
 *      既存データを壊さないための安全網
 *
 * 日付は 'YYYY-MM-DD' の文字列比較 (Date パースなし = タイムゾーン安全)。
 */

export interface CertForMonth {
  insurer_number: string | null;
  insurer_name: string | null;
  insured_number: string | null;
  care_level: string | null;
  copay_rate: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  certification_status: string | null;
  service_limit_amount: number | null;
  /**
   * 限度額適用期間 (開始/終了)。区分変更等で認定有効期間と異なることがある
   * (ほのぼの「適用期間（居宅ｻｰﾋﾞｽ区分）」由来。給付管理票 8222 項13/14 はこちらが正)。
   * 列未適用 (kyotaku_limit_period.sql) の環境では null。
   */
  limit_period_start: string | null;
  limit_period_end: string | null;
  care_office_id: string | null;
  care_office_number: string | null;
  care_office_name: string | null;
  effective_date: string | null;
  /** 対象月に有効な認定が無く「最新 1 件」へフォールバックした */
  isFallback: boolean;
}

interface DbRow {
  client_id: string;
  insurer_number: string | null;
  insurer_name: string | null;
  insured_number: string | null;
  care_level: string | null;
  copay_rate: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  certification_status: string | null;
  service_limit_amount: number | null;
  limit_period_start?: string | null;
  limit_period_end?: string | null;
  care_office_id: string | null;
  care_office_number: string | null;
  care_office_name: string | null;
  effective_date: string | null;
}

const SELECT_COLS_BASE =
  "client_id, insurer_number, insurer_name, insured_number, care_level, copay_rate, " +
  "certification_start_date, certification_end_date, certification_status, service_limit_amount, " +
  "care_office_id, care_office_number, care_office_name, effective_date";
// 限度額適用期間 (kyotaku_limit_period.sql)。列未適用の環境は 42703 → BASE で再試行
const SELECT_COLS = SELECT_COLS_BASE + ", limit_period_start, limit_period_end";

const PAGE = 1000;
const IN_CHUNK = 50;

/** 対象月の月初/月末 ('YYYY-MM-DD')。ローカル演算のみで TZ 安全 */
export function monthRange(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate(); // ローカル。toISOString は使わない
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * client ごとの全認定行を集める (chunk + order 付き page-loop)。
 * per-client の並びは certification_start_date DESC, effective_date DESC
 * (resolveCertForMonth 従来の取得順そのまま)。
 */
async function fetchCertRowsByClient(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, DbRow[]>> {
  // limit_period_* 列未適用の環境は 42703 → 列なしで再試行 (モジュール内で1度だけ落とす)
  let selectCols = SELECT_COLS;
  // chunk は並列 (直列だと 1000 名規模で chunk 数 × 往復時間 = 数十秒待ちになる)
  const perChunk = await mapChunksParallel(ids, IN_CHUNK, async (chunk) => {
    const acc: DbRow[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("client_insurance_records")
        .select(selectCols)
        .in("client_id", chunk)
        .order("client_id", { ascending: true })
        .order("certification_start_date", { ascending: false, nullsFirst: false })
        .order("effective_date", { ascending: false, nullsFirst: false })
        .range(offset, offset + PAGE - 1);
      if (error) {
        if (selectCols !== SELECT_COLS_BASE && (error.code === "42703" || /does not exist/i.test(error.message ?? ""))) {
          selectCols = SELECT_COLS_BASE;
          continue;
        }
        throw new Error(`認定情報の取得に失敗: ${error.message}`);
      }
      const rows = (data ?? []) as unknown as DbRow[];
      acc.push(...rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    return acc;
  });
  // chunk 順・chunk 内の DB order のまま連結 (per-client の並びは start_date DESC を保つ)
  const byClient = new Map<string, DbRow[]>();
  for (const rows of perChunk) {
    for (const r of rows) {
      if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
      byClient.get(r.client_id)!.push(r);
    }
  }
  return byClient;
}

function toCertForMonth(r: DbRow, isFallback: boolean): CertForMonth {
  return {
    insurer_number: r.insurer_number,
    insurer_name: r.insurer_name,
    insured_number: r.insured_number,
    care_level: r.care_level,
    copay_rate: r.copay_rate,
    certification_start_date: r.certification_start_date,
    certification_end_date: r.certification_end_date,
    certification_status: r.certification_status,
    service_limit_amount: r.service_limit_amount,
    limit_period_start: r.limit_period_start ?? null,
    limit_period_end: r.limit_period_end ?? null,
    care_office_id: r.care_office_id,
    care_office_number: r.care_office_number,
    care_office_name: r.care_office_name,
    effective_date: r.effective_date,
    isFallback,
  };
}

/** 対象月に有効な認定か (start <= 月末 AND (end IS NULL OR end >= 月初)) */
const isValidInMonth = (r: DbRow, monthStart: string, monthEnd: string): boolean => {
  if (!r.certification_start_date) return false;
  if (r.certification_start_date > monthEnd) return false;
  if (r.certification_end_date && r.certification_end_date < monthStart) return false;
  return true;
};

/**
 * clientIds ごとに対象月 (year, month) に有効な認定を解決する。
 * 戻り値の Map に無い client は認定レコード自体が 0 件。
 */
export async function resolveCertForMonth(
  supabase: SupabaseClient,
  clientIds: string[],
  year: number,
  month: number,
): Promise<Map<string, CertForMonth>> {
  const out = new Map<string, CertForMonth>();
  const ids = Array.from(new Set(clientIds));
  if (ids.length === 0) return out;
  const { from: monthStart, to: monthEnd } = monthRange(year, month);

  const byClient = await fetchCertRowsByClient(supabase, ids);

  for (const [clientId, rows] of byClient) {
    // 1) 対象月に有効な認定 (start <= 月末 AND (end IS NULL OR end >= 月初))
    const inMonth = rows.filter((r) => isValidInMonth(r, monthStart, monthEnd));
    // rows は start_date DESC 順なので先頭が「対象月に有効な最新の認定」
    const picked = inMonth[0] ?? rows[0];
    if (!picked) continue;
    out.set(clientId, toCertForMonth(picked, inMonth.length === 0));
  }
  return out;
}

/**
 * clientIds ごとに「対象月に有効な全認定行」を certification_start_date 昇順で返す
 * (月途中の資格変更 = 区分変更/保険者変更 の検出用。Phase 1)。
 *
 * resolveCertForMonth と違いフォールバックしない — 対象月に有効な認定が 1 件も無い
 * client は Map に入らない。同一 certification_start_date の重複行 (編集履歴・二重登録)
 * は effective_date が最新の 1 件に dedupe する (誤検出防止)。
 */
export async function resolveCertsInMonth(
  supabase: SupabaseClient,
  clientIds: string[],
  year: number,
  month: number,
): Promise<Map<string, CertForMonth[]>> {
  const out = new Map<string, CertForMonth[]>();
  const ids = Array.from(new Set(clientIds));
  if (ids.length === 0) return out;
  const { from: monthStart, to: monthEnd } = monthRange(year, month);

  const byClient = await fetchCertRowsByClient(supabase, ids);

  for (const [clientId, rows] of byClient) {
    // rows は start DESC, effective DESC — 同一 start は先頭 (= 最新 effective) を採用
    const seenStart = new Set<string>();
    const inMonth: DbRow[] = [];
    for (const r of rows) {
      if (!isValidInMonth(r, monthStart, monthEnd)) continue;
      const start = r.certification_start_date!;
      if (seenStart.has(start)) continue;
      seenStart.add(start);
      inMonth.push(r);
    }
    if (inMonth.length === 0) continue;
    inMonth.reverse(); // start DESC → ASC (時系列順)
    out.set(
      clientId,
      inMonth.map((r) => toCertForMonth(r, false)),
    );
  }
  return out;
}

// ─── 月途中の資格変更 検出 (Phase 1: 検出のみ。レセプト行の分割は Phase 2) ──────

export interface MidMonthCertChange {
  /**
   * ケース2: 保険者番号 / 被保険者番号 の月内変更 (転居等)。
   * boundaryDate = 変更後認定の certification_start_date。
   */
  insurerChange: {
    fromInsurer: string | null;
    toInsurer: string | null;
    fromInsured: string | null;
    toInsured: string | null;
    boundaryDate: string | null;
  } | null;
  /**
   * ケース3: care_level の月内変更 (区分変更)。
   * crossesSystem = 要支援 (事業対象者含む) ↔ 要介護 の制度跨ぎ。
   */
  careLevelChange: {
    from: string;
    to: string;
    boundaryDate: string | null;
    crossesSystem: boolean;
  } | null;
}

const isYoboKubun = (level: string) => /要支援|事業対象者/.test(level);
const trimOrEmpty = (v: string | null | undefined) => (v ?? "").trim();

// ─── 保険者変更 (転居) のセグメント分割 (Phase 2: レセプト行の複製・分割) ─────

/** 月内の 1 セグメント (from/to は両端含む 'YYYY-MM-DD') */
export interface CertSegment {
  from: string;
  to: string;
  /** このセグメント期間に適用する認定 (期間内で複数あれば最新 start の行) */
  cert: CertForMonth;
  /**
   * セグメント期間に有効期間が重なる「全」認定の service_limit_amount の最大値。
   * 同一保険者内の区分変更 (降格含む) がセグメント内にある場合も「最も介護の必要の
   * 程度が高い区分」の限度額 (施行規則68条1項) を適用するため、cert (最新 start の
   * 1 行) の値ではなくこちらを区分支給限度基準に使う。正の値が 1 件も無ければ null。
   */
  limitAmount: number | null;
}

export interface CertSegmentsResult {
  /** start 昇順のセグメント。分割なし (変化点なし・判定不能) は 1 件 */
  segments: CertSegment[];
  /** 保険者/被保険者番号の変化点はあるが境界日が判定できず分割しなかった */
  undetermined: boolean;
}

/** 'YYYY-MM-DD' の前日 (ローカル演算のみで TZ 安全) */
const prevDay = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * 期間 [from, to] に認定有効期間が重なる certs の service_limit_amount の最大値
 * (= 施行規則68条1項「重い方」)。正の値が 1 件も無ければ null。
 */
const maxLimitInRange = (
  certs: CertForMonth[],
  from: string,
  to: string,
): number | null => {
  let max: number | null = null;
  for (const c of certs) {
    if (!c.certification_start_date || c.certification_start_date > to) continue;
    if (c.certification_end_date && c.certification_end_date < from) continue;
    const v = c.service_limit_amount != null ? Number(c.service_limit_amount) : NaN;
    if (Number.isFinite(v) && v > 0 && (max == null || v > max)) max = v;
  }
  return max;
};

/**
 * resolveCertsInMonth の結果 (start 昇順) を、保険者番号 (または被保険者番号) の
 * 変化点で区切ったセグメント列にする (Phase 2: 転居月のレセプト分割用)。
 *
 * - 変化点なし (更新・区分変更のみ) は 1 セグメント。セグメントの cert は
 *   期間内で最新 start の行 (= resolveCertForMonth の採用行と同じ向き)。
 * - 境界日 = 変化後認定の certification_start_date (resolveCertsInMonth の行は
 *   start 必須なので原則これ。無ければ effective_date フォールバック)。
 *   ※ qualification_date (資格取得日) は client_insurance_records に UI 項目は
 *     あるが共有リゾルバの取得列に含めていないため未使用 (要検討 Phase 3)。
 * - 境界日が null または月初以前・月末より後なら判定不能 → 分割せず
 *   undetermined=true (呼出側で warning)。
 */
export function resolveCertSegmentsForMonth(
  certs: CertForMonth[],
  year: number,
  month: number,
): CertSegmentsResult {
  const { from: monthStart, to: monthEnd } = monthRange(year, month);
  if (certs.length === 0) return { segments: [], undetermined: false };
  let undetermined = false;
  const segments: CertSegment[] = [
    { from: monthStart, to: monthEnd, cert: certs[0], limitAmount: null },
  ];
  for (let i = 1; i < certs.length; i++) {
    const prev = certs[i - 1];
    const cur = certs[i];
    // detectMidMonthChange と同じ規則: 片方未入力の項目は変更とみなさない
    const pIns = trimOrEmpty(prev.insurer_number);
    const cIns = trimOrEmpty(cur.insurer_number);
    const pNo = trimOrEmpty(prev.insured_number);
    const cNo = trimOrEmpty(cur.insured_number);
    const changed =
      (pIns !== "" && cIns !== "" && pIns !== cIns) ||
      (pNo !== "" && cNo !== "" && pNo !== cNo);
    if (!changed) {
      // 変化なし (認定更新・区分変更のみ) → 同一セグメント内で最新の認定を採用
      segments[segments.length - 1].cert = cur;
      continue;
    }
    const boundary = cur.certification_start_date ?? cur.effective_date;
    if (!boundary || boundary <= monthStart || boundary > monthEnd) {
      // 境界日が判定できない (月初以前 = 月内変更ではない、月末より後 = 期間矛盾)
      undetermined = true;
      segments[segments.length - 1].cert = cur;
      continue;
    }
    const last = segments[segments.length - 1];
    last.to = prevDay(boundary);
    segments.push({ from: boundary, to: monthEnd, cert: cur, limitAmount: null });
  }
  if (undetermined) {
    // 判定不能の変化点が 1 つでもあれば分割しない (月末時点の認定 1 セグメント)
    return {
      segments: [
        {
          from: monthStart,
          to: monthEnd,
          cert: segments[segments.length - 1].cert,
          limitAmount: maxLimitInRange(certs, monthStart, monthEnd),
        },
      ],
      undetermined: true,
    };
  }
  // 各セグメントの限度額 = 期間に重なる全認定の max (セグメント内の区分変更も「重い方」)
  for (const s of segments) s.limitAmount = maxLimitInRange(certs, s.from, s.to);
  return { segments, undetermined: false };
}

/**
 * resolveCertsInMonth の結果 (start 昇順) から月内の資格変更を検出する。
 * 片方が未入力 (null/空) の項目は変更とみなさない (データ入力途中の誤検出防止)。
 * 変更なし (または認定が 1 件以下) は null。
 */
export function detectMidMonthChange(certs: CertForMonth[]): MidMonthCertChange | null {
  if (certs.length < 2) return null;
  let insurerChange: MidMonthCertChange["insurerChange"] = null;
  let careLevelChange: MidMonthCertChange["careLevelChange"] = null;
  for (let i = 1; i < certs.length; i++) {
    const prev = certs[i - 1];
    const cur = certs[i];
    const boundary = cur.certification_start_date;
    if (!insurerChange) {
      const pIns = trimOrEmpty(prev.insurer_number);
      const cIns = trimOrEmpty(cur.insurer_number);
      const pNo = trimOrEmpty(prev.insured_number);
      const cNo = trimOrEmpty(cur.insured_number);
      const insurerDiff = pIns !== "" && cIns !== "" && pIns !== cIns;
      const insuredDiff = pNo !== "" && cNo !== "" && pNo !== cNo;
      if (insurerDiff || insuredDiff) {
        insurerChange = {
          fromInsurer: prev.insurer_number,
          toInsurer: cur.insurer_number,
          fromInsured: prev.insured_number,
          toInsured: cur.insured_number,
          boundaryDate: boundary,
        };
      }
    }
    if (!careLevelChange) {
      const pLv = trimOrEmpty(prev.care_level);
      const cLv = trimOrEmpty(cur.care_level);
      if (pLv !== "" && cLv !== "" && pLv !== cLv) {
        careLevelChange = {
          from: pLv,
          to: cLv,
          boundaryDate: boundary,
          crossesSystem: isYoboKubun(pLv) !== isYoboKubun(cLv),
        };
      }
    }
    if (insurerChange && careLevelChange) break;
  }
  if (!insurerChange && !careLevelChange) return null;
  return { insurerChange, careLevelChange };
}
