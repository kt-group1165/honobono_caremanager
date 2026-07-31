/**
 * 経営分析 (ほのぼの「経営分析」相当) — 共有データ層
 *
 * billing-visit/stats (訪問介護) と billing/stats (居宅介護支援) の
 * 「経営分析」タブから使う fetch / 集計の pure な部分をまとめる。
 *
 * 方針:
 *   - 12ヶ月分を 1 クエリで一括 fetch しない。月単位の fetch 関数を用意し、
 *     呼出側が mapWithConcurrency で並列実行する (各月は page-loop で 1000 行対策)
 *   - error は握りつぶさず { data, error } で返す (table 未作成 42P01/PGRST205 は
 *     「機能未適用」として空 + error なしで続行)
 *   - サービス種類の分類は kaigo_service_codes (system) を優先し、
 *     解決できない名前は接頭辞ヒューリスティクスで分類する
 */

import type { CSSProperties } from "react";
import { ID_IN_CHUNK, NAME_IN_CHUNK } from "@/lib/chunk-parallel";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceNameVariantsAll, toHankakuDigits } from "@/lib/service-name-normalize";
import { isValidInMonth } from "@/lib/service-code-valid";

// ─── 月ユーティリティ ────────────────────────────────────────────────────────

/** 期間内の全月 (YYYY-MM)。上限 cap で「直近側」を優先して打ち切る */
export function monthsInRangeCapped(from: string, to: string, cap = 24): string[] {
  const re = /^(\d{4})-(\d{2})$/;
  const f = re.exec(from);
  const t = re.exec(to);
  if (!f || !t || from > to) return [];
  let y = parseInt(f[1], 10);
  let mo = parseInt(f[2], 10);
  const ty = parseInt(t[1], 10);
  const tmo = parseInt(t[2], 10);
  const out: string[] = [];
  while ((y < ty || (y === ty && mo <= tmo)) && out.length < 120) {
    out.push(`${y}-${String(mo).padStart(2, "0")}`);
    mo += 1;
    if (mo > 12) {
      mo = 1;
      y += 1;
    }
  }
  // 上限超過時は直近 cap ヶ月に切り詰める
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** 前月 (YYYY-MM) */
export function prevMonthKey(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  let y = parseInt(m[1], 10);
  let mo = parseInt(m[2], 10) - 1;
  if (mo < 1) {
    mo = 12;
    y -= 1;
  }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

/** YYYY-MM → 「R8/5」表記 (既存 stats と同じ和暦月) */
export function reiwaMonthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `R${parseInt(m[1], 10) - 2018}/${parseInt(m[2], 10)}`;
}

/** YYYY-MM → その月の初日/末日 (YYYY-MM-DD) */
export function monthStartEnd(ym: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return { start: `${ym}-01`, end: `${ym}-31` };
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const last = new Date(y, mo, 0).getDate();
  return { start: `${ym}-01`, end: `${ym}-${String(last).padStart(2, "0")}` };
}

/** "HH:MM(:SS)" ペア → 分 (不正・逆転は 0) */
export function durationMinutes(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  const p = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
  };
  const s = p(start.slice(0, 5));
  const e = p(end.slice(0, 5));
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  return e - s;
}

/** 並列数を絞った Promise.all (月別 fetch の同時実行制御用) */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** table/列 未作成系のエラーコードか (= 機能未適用として空扱いにする) */
export function isMissingSchemaError(code: string | null | undefined): boolean {
  return (
    code === "42P01" || code === "PGRST205" || code === "42703" || code === "PGRST204"
  );
}

// ─── CSV 出力 (Excel 互換 BOM 付き UTF-8。既存 stats と同形式) ──────────────

export function downloadCsv(
  filename: string,
  header: string[],
  rows: (string | number)[][],
): void {
  const esc = (v: string | number) =>
    typeof v === "number" ? String(v) : `"${v.replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))];
  const blob = new Blob(["﻿" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── サービスマスタ (kaigo_service_codes) 解決 ──────────────────────────────

export interface ServiceCodeGen {
  service_name: string;
  units: number | null;
  system: string | null; // 介護 / 総合事業 / 独自 / 障害
  valid_from: string | null;
  valid_until: string | null;
}

/** 正規化キー (全半角数字ゆれ吸収) → 全世代行 */
export type ServiceMaster = Map<string, ServiceCodeGen[]>;

const normKey = (name: string) => toHankakuDigits(name.trim());

// 同名が複数制度にある場合の採用優先 (visit-seikyu/aggregate.ts と同じ)
const SYSTEM_PRIORITY: Record<string, number> = { 介護: 0, 総合事業: 1, 独自: 2, 障害: 3 };
const systemRank = (s: string | null) => (s && s in SYSTEM_PRIORITY ? SYSTEM_PRIORITY[s] : 9);

/**
 * 使用中サービス名の全世代を kaigo_service_codes から引く。
 * 名前は 50 件ずつ chunk (variants 込みで .in() が長くなりすぎないように)。
 */
export async function fetchServiceMaster(
  supabase: SupabaseClient,
  names: string[],
): Promise<{ master: ServiceMaster; error: string | null }> {
  const master: ServiceMaster = new Map();
  const uniq = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean)));
  let firstError: string | null = null;
  for (let i = 0; i < uniq.length; i += NAME_IN_CHUNK) {
    const chunk = uniq.slice(i, i + NAME_IN_CHUNK);
    const { data, error } = await supabase
      .from("kaigo_service_codes")
      .select("service_name, units, system, valid_from, valid_until")
      .in("service_name", serviceNameVariantsAll(chunk));
    if (error) {
      if (!firstError) firstError = error.message;
      continue;
    }
    for (const row of (data ?? []) as ServiceCodeGen[]) {
      const k = normKey(row.service_name);
      const arr = master.get(k);
      if (arr) arr.push(row);
      else master.set(k, [row]);
    }
  }
  return { master, error: firstError };
}

/** 名前の制度 (system)。複数制度ヒット時は 介護 > 総合事業 > 独自 > 障害 */
export function systemOfService(master: ServiceMaster, name: string): string | null {
  const gens = master.get(normKey(name));
  if (!gens || gens.length === 0) return null;
  let best: ServiceCodeGen | null = null;
  for (const g of gens) {
    if (!best || systemRank(g.system) < systemRank(best.system)) best = g;
  }
  return best?.system ?? null;
}

/** 対象月に有効な世代の単位数 (解決不能は null)。制度優先 → valid_from 降順 */
export function unitsForMonth(
  master: ServiceMaster,
  name: string,
  ym: string,
): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const gens = master.get(normKey(name));
  if (!gens) return null;
  const valid = gens.filter((g) => isValidInMonth(g, year, month) && g.units != null);
  if (valid.length === 0) return null;
  valid.sort(
    (a, b) =>
      systemRank(a.system) - systemRank(b.system) ||
      (b.valid_from ?? "").localeCompare(a.valid_from ?? ""),
  );
  return valid[0].units;
}

// ─── サービス種類の分類 (身体/生活/身生/乗降/障害/総合/入浴/その他) ────────

export const CATEGORY_KEYS = [
  "身体",
  "生活",
  "身生",
  "乗降",
  "障害",
  "総合",
  "入浴",
  "その他",
] as const;
export type ServiceCategory = (typeof CATEGORY_KEYS)[number];

export function classifyServiceType(
  name: string | null | undefined,
  master: ServiceMaster,
): ServiceCategory {
  const raw = (name ?? "").trim();
  if (!raw) return "その他";
  // 1) マスタの制度 (system) が引ければそれを優先 (障害の「身体日0.5」等を正しく分類)
  const system = systemOfService(master, raw);
  if (system === "障害") return "障害";
  if (system === "総合事業" || system === "独自") return "総合";
  // 2) 名前の接頭辞 (介護保険 訪問介護系)
  const n = toHankakuDigits(raw);
  if (/^訪問入浴/.test(n)) return "入浴";
  if (/^身体介護\d+・生活|^身体・生活|^身体\+生活/.test(n)) return "身生";
  if (/^身体介護/.test(n)) return "身体";
  if (/^生活援助/.test(n)) return "生活";
  if (/^通院等乗降介助/.test(n)) return "乗降";
  // 3) マスタ未解決時のフォールバック (総合事業 / 障害の代表的な名前)
  if (/^(訪問型独自サービス|訪問型サービス|訪問介護相当サービス|生活援助型訪問サービス|ミニデイ型)/.test(n)) {
    return "総合";
  }
  if (/^(重度訪問介護|同行援護|行動援護|家事援助|通院等介助|重度障害者等包括)/.test(n)) {
    return "障害";
  }
  return "その他";
}

// ─── 訪問系: 月次データ fetch (kaigo_visit_schedule + kaigo_bath_visit_records) ─

export interface KeieiSchedRow {
  user_id: string;
  staff_id: string | null;
  staff_id_2: string | null;
  staff_id_3: string | null;
  start_time: string | null;
  end_time: string | null;
  service_type: string | null;
  status: string | null;
}

export interface MonthVisitData {
  month: string;
  /** kaigo_visit_schedule の月内全行 (cancelled 含む) */
  schedules: KeieiSchedRow[];
  /** 訪問入浴の実施記録 (actual=true) の client_id (1 要素 = 1 件) */
  bathClientIds: string[];
}

/**
 * 1 ヶ月分の訪問データを取得する (page-loop 付き)。
 * officeId 指定時は kaigo_visit_schedule を自事業所 + office_id 未設定 (移行期データ)
 * に限定する (visit-seikyu/aggregate.ts と同条件)。
 * kaigo_bath_visit_records は table 未作成なら 0 件として続行。
 */
export async function fetchVisitMonthData(
  supabase: SupabaseClient,
  ym: string,
  officeId?: string | null,
): Promise<{ data: MonthVisitData; error: string | null }> {
  const { start, end } = monthStartEnd(ym);
  const PAGE = 1000;
  const schedules: KeieiSchedRow[] = [];
  let error: string | null = null;
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("kaigo_visit_schedule")
      .select(
        "user_id, staff_id, staff_id_2, staff_id_3, start_time, end_time, service_type, status",
      )
      .gte("visit_date", start)
      .lte("visit_date", end);
    if (officeId) {
      // 自事業所スコープ (office_id 未設定の旧データは含める)
      q = q.or(`office_id.eq.${officeId},office_id.is.null`);
    }
    const { data, error: qErr } = await q
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (qErr) {
      if (!isMissingSchemaError(qErr.code)) error = `予定/実績の取得に失敗: ${qErr.message}`;
      break;
    }
    const rows = (data ?? []) as KeieiSchedRow[];
    schedules.push(...rows);
    if (rows.length < PAGE) break;
  }

  const bathClientIds: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error: qErr } = await supabase
      .from("kaigo_bath_visit_records")
      .select("client_id")
      .eq("actual", true)
      .gte("visit_date", start)
      .lte("visit_date", end)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (qErr) {
      // 訪問入浴の table/列 未適用環境は 0 件として続行 (他エラーのみ報告)
      if (!isMissingSchemaError(qErr.code) && !error) {
        error = `入浴実績の取得に失敗: ${qErr.message}`;
      }
      break;
    }
    const rows = (data ?? []) as { client_id: string }[];
    bathClientIds.push(...rows.map((r) => r.client_id));
    if (rows.length < PAGE) break;
  }

  return { data: { month: ym, schedules, bathClientIds }, error };
}

// ─── 訪問系: 集計 ────────────────────────────────────────────────────────────

export interface VisitMonthlyMetrics {
  month: string;
  /** 実利用者数 (訪問系 非キャンセル + 入浴実績 のユニーク利用者) */
  users: number;
  /** 前月に居なかった利用者数 (前月比の新規) */
  newUsers: number;
  /** 前月に居て当月居ない利用者数 (前月比の終了) */
  endedUsers: number;
  /** 訪問回数 (kaigo_visit_schedule の非キャンセル行数) */
  visits: number;
  /** 入浴件数 (kaigo_bath_visit_records actual=true) */
  bathVisits: number;
  /** 提供時間合計 (分。非キャンセル行の start-end) */
  minutes: number;
  cancelled: number;
  /** キャンセル率 (%. 分母 = 非キャンセル + キャンセル。0 件月は null) */
  cancelRate: number | null;
  /** 種類別件数 (入浴は bath 由来) */
  byCategory: Record<ServiceCategory, number>;
  /** 単位数が解決できた訪問の 単位数合計 / 件数 (平均単位数用) */
  unitsSum: number;
  unitsVisits: number;
}

export interface StaffStatRow {
  staffId: string;
  visitsByMonth: Record<string, number>;
  minutesByMonth: Record<string, number>;
  totalVisits: number;
  totalMinutes: number;
}

const emptyCategoryCounts = (): Record<ServiceCategory, number> => ({
  身体: 0,
  生活: 0,
  身生: 0,
  乗降: 0,
  障害: 0,
  総合: 0,
  入浴: 0,
  その他: 0,
});

/**
 * 月別 fetch 済データから 経営分析の月次指標 + 職員別稼働 を計算する。
 * baseMonth (= months[0] の前月) は 新規/終了 の比較基準にのみ使い、結果には含めない。
 */
export function computeVisitAnalysis(
  months: string[],
  baseMonth: string,
  byMonth: Map<string, MonthVisitData>,
  master: ServiceMaster,
): { monthly: VisitMonthlyMetrics[]; staff: StaffStatRow[] } {
  // 月ごとのユニーク利用者集合 (新規/終了の前月比較用。baseMonth 含む)
  const userSets = new Map<string, Set<string>>();
  for (const ym of [baseMonth, ...months]) {
    const d = byMonth.get(ym);
    const set = new Set<string>();
    if (d) {
      for (const s of d.schedules) {
        if (s.status !== "cancelled") set.add(s.user_id);
      }
      for (const c of d.bathClientIds) set.add(c);
    }
    userSets.set(ym, set);
  }

  const staffMap = new Map<string, StaffStatRow>();
  const creditStaff = (staffId: string, ym: string, minutes: number) => {
    let row = staffMap.get(staffId);
    if (!row) {
      row = {
        staffId,
        visitsByMonth: {},
        minutesByMonth: {},
        totalVisits: 0,
        totalMinutes: 0,
      };
      staffMap.set(staffId, row);
    }
    row.visitsByMonth[ym] = (row.visitsByMonth[ym] ?? 0) + 1;
    row.minutesByMonth[ym] = (row.minutesByMonth[ym] ?? 0) + minutes;
    row.totalVisits += 1;
    row.totalMinutes += minutes;
  };

  const monthly: VisitMonthlyMetrics[] = months.map((ym, idx) => {
    const d = byMonth.get(ym) ?? { month: ym, schedules: [], bathClientIds: [] };
    const prevSet = userSets.get(idx === 0 ? baseMonth : months[idx - 1]) ?? new Set();
    const curSet = userSets.get(ym) ?? new Set();

    let visits = 0;
    let cancelled = 0;
    let minutes = 0;
    let unitsSum = 0;
    let unitsVisits = 0;
    const byCategory = emptyCategoryCounts();

    for (const s of d.schedules) {
      if (s.status === "cancelled") {
        cancelled += 1;
        continue;
      }
      visits += 1;
      const dur = durationMinutes(s.start_time, s.end_time);
      minutes += dur;
      byCategory[classifyServiceType(s.service_type, master)] += 1;
      const units = s.service_type ? unitsForMonth(master, s.service_type, ym) : null;
      if (units != null) {
        unitsSum += units;
        unitsVisits += 1;
      }
      // 職員稼働: 主担当 + 職員2/3 (追加職員の個別時間は本体時間で近似)
      for (const sid of [s.staff_id, s.staff_id_2, s.staff_id_3]) {
        if (sid) creditStaff(sid, ym, dur);
      }
    }
    byCategory["入浴"] += d.bathClientIds.length;

    let newUsers = 0;
    let endedUsers = 0;
    for (const u of curSet) if (!prevSet.has(u)) newUsers += 1;
    for (const u of prevSet) if (!curSet.has(u)) endedUsers += 1;

    const denom = visits + cancelled;
    return {
      month: ym,
      users: curSet.size,
      newUsers,
      endedUsers,
      visits,
      bathVisits: d.bathClientIds.length,
      minutes,
      cancelled,
      cancelRate: denom > 0 ? (cancelled / denom) * 100 : null,
      byCategory,
      unitsSum,
      unitsVisits,
    };
  });

  const staff = [...staffMap.values()].sort(
    (a, b) => b.totalVisits - a.totalVisits || b.totalMinutes - a.totalMinutes,
  );
  return { monthly, staff };
}

// ─── 職員名の解決 (members) ─────────────────────────────────────────────────

export async function fetchMemberNames(
  supabase: SupabaseClient,
  ids: string[],
): Promise<{ names: Map<string, string>; error: string | null }> {
  const names = new Map<string, string>();
  const uniq = Array.from(new Set(ids));
  let firstError: string | null = null;
  for (let i = 0; i < uniq.length; i += ID_IN_CHUNK) {
    const chunk = uniq.slice(i, i + ID_IN_CHUNK);
    const { data, error } = await supabase.from("members").select("id, name").in("id", chunk);
    if (error) {
      if (!firstError) firstError = error.message;
      continue;
    }
    for (const m of (data ?? []) as { id: string; name: string }[]) {
      names.set(m.id, m.name);
    }
  }
  return { names, error: firstError };
}

// ─── 居宅介護支援: 月次データ fetch (給付管理 + 居宅介護支援費請求) ──────────

export interface KyotakuMonthData {
  month: string;
  /** kaigo_benefit_management の user_id (1 要素 = 1 行。利用者×サービスで複数行あり) */
  benefitUserIds: string[];
  /** kaigo_care_support_claims の行 (1 行 = 1 利用者の月次請求) */
  claims: { user_id: string | null; units: number; insurance_amount: number }[];
}

export async function fetchKyotakuMonthData(
  supabase: SupabaseClient,
  ym: string,
): Promise<{ data: KyotakuMonthData; error: string | null }> {
  const PAGE = 1000;
  let error: string | null = null;

  const benefitUserIds: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error: qErr } = await supabase
      .from("kaigo_benefit_management")
      .select("user_id")
      .eq("billing_month", ym)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (qErr) {
      if (!isMissingSchemaError(qErr.code)) error = `給付管理データの取得に失敗: ${qErr.message}`;
      break;
    }
    const rows = (data ?? []) as { user_id: string }[];
    benefitUserIds.push(...rows.map((r) => r.user_id));
    if (rows.length < PAGE) break;
  }

  const claims: KyotakuMonthData["claims"] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error: qErr } = await supabase
      .from("kaigo_care_support_claims")
      .select("user_id, units, insurance_amount")
      .eq("billing_month", ym)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (qErr) {
      if (!isMissingSchemaError(qErr.code) && !error) {
        error = `請求データの取得に失敗: ${qErr.message}`;
      }
      break;
    }
    const rows = (data ?? []) as KyotakuMonthData["claims"];
    claims.push(...rows);
    if (rows.length < PAGE) break;
  }

  return { data: { month: ym, benefitUserIds, claims }, error };
}

// ─── 居宅介護支援: 集計 ─────────────────────────────────────────────────────

export interface KyotakuMonthlyMetrics {
  month: string;
  /** 給付管理ベースの担当利用者数 (kaigo_benefit_management のユニーク利用者) */
  kanriUsers: number;
  newUsers: number;
  endedUsers: number;
  /** 居宅介護支援費の請求件数 / 単位数 / 保険請求額 */
  claimCount: number;
  unitsSum: number;
  amountSum: number;
}

/**
 * 居宅の月次指標。clientFilter (= 自事業所の client_office_assignments) が
 * 渡された場合はその利用者に限定する (取得失敗時 null = 全件)。
 */
export function computeKyotakuAnalysis(
  months: string[],
  baseMonth: string,
  byMonth: Map<string, KyotakuMonthData>,
  clientFilter: Set<string> | null,
): KyotakuMonthlyMetrics[] {
  const inScope = (id: string | null | undefined) =>
    !id || !clientFilter || clientFilter.has(id);

  const userSets = new Map<string, Set<string>>();
  for (const ym of [baseMonth, ...months]) {
    const d = byMonth.get(ym);
    const set = new Set<string>();
    if (d) {
      for (const u of d.benefitUserIds) {
        if (inScope(u)) set.add(u);
      }
    }
    userSets.set(ym, set);
  }

  return months.map((ym, idx) => {
    const d = byMonth.get(ym) ?? { month: ym, benefitUserIds: [], claims: [] };
    const prevSet = userSets.get(idx === 0 ? baseMonth : months[idx - 1]) ?? new Set();
    const curSet = userSets.get(ym) ?? new Set();

    let claimCount = 0;
    let unitsSum = 0;
    let amountSum = 0;
    for (const c of d.claims) {
      if (!inScope(c.user_id)) continue;
      claimCount += 1;
      unitsSum += c.units;
      amountSum += c.insurance_amount;
    }

    let newUsers = 0;
    let endedUsers = 0;
    for (const u of curSet) if (!prevSet.has(u)) newUsers += 1;
    for (const u of prevSet) if (!curSet.has(u)) endedUsers += 1;

    return {
      month: ym,
      kanriUsers: curSet.size,
      newUsers,
      endedUsers,
      claimCount,
      unitsSum,
      amountSum,
    };
  });
}

// ─── ヒートマップ配色 (テーブルセルの inline style) ──────────────────────────

/** indigo 系の濃淡 (v/max)。0 は無色 */
export function heatStyle(v: number, max: number): CSSProperties | undefined {
  if (!v || max <= 0) return undefined;
  const a = Math.min(0.8, 0.1 + (v / max) * 0.55);
  return {
    backgroundColor: `rgba(99, 102, 241, ${a.toFixed(3)})`,
    color: a > 0.42 ? "#fff" : undefined,
  };
}

/** red 系の濃淡 (キャンセル率など「高いほど悪い」指標用) */
export function heatStyleRed(v: number, max: number): CSSProperties | undefined {
  if (!v || max <= 0) return undefined;
  const a = Math.min(0.8, 0.1 + (v / max) * 0.55);
  return {
    backgroundColor: `rgba(239, 68, 68, ${a.toFixed(3)})`,
    color: a > 0.42 ? "#fff" : undefined,
  };
}
