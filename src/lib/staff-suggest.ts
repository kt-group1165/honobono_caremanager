// ヘルパー割当サジェスト (ほのぼの自動割当の第一歩、自動確定はせず候補提示のみ)。
//
// スコアリング仕様:
//   [ハード除外]
//     ① その日時に他の予定と時間帯が重なる職員 (主担当 staff_id / staff_id_2 / staff_id_3
//        / additional_staff を全て割当扱い。編集中の予定 excludeScheduleId は除く。
//        status === "cancelled" は除外対象にしない)
//     ② 出勤可否 NG (kaigo_staff_availability_monthly のデータがある職員のみ判定 =
//        既存の isStaffUnavailableAtTime と同じ規則。データが無い職員は判定しない)
//   [加点]
//     ③ 優先ヘルパー (client_office_assignments.preferred_staff): 1位 +60、以降 -10/位 (下限 +10)
//     ④ 担当実績: 渡された schedules 範囲 (通常 = 表示月) でその利用者を担当した回数 × 2 (上限 +30)
//   スコア降順 → 実績回数降順 → 名前順で上位 limit 件 (default 5) を返す。
//   ③④ とも 0 点の職員も「空き」候補として返す (件数が埋まらない場合)。
//
// 性能: 計算は完全にクライアント側 (呼出元が持つ月データを渡す)。
//   月データを持たない呼出元用の fetchDaySchedules / fetchDayAvailability は
//   対象日 1 日分のみの読み取り (1000 行 page-loop 付き)。

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isStaffUnavailableAtTime,
  timeToMinutes,
  type StaffAvailabilitySlot,
} from "@/app/(authenticated)/shift-management/_shared";

/** 優先ヘルパーの最大登録数 (UI 側で制限) */
export const PREFERRED_STAFF_MAX = 10;

/** サジェスト計算に必要な最小の schedule 形 (VisitSchedule は構造的に互換) */
export interface SuggestScheduleRow {
  id: string;
  user_id: string;
  staff_id: string | null;
  staff_id_2?: string | null;
  staff_id_3?: string | null;
  additional_staff?: Array<{ staff_id: string; start_time: string | null; end_time: string | null }> | null;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  status?: string;
}

export interface StaffSuggestion {
  staffId: string;
  name: string;
  score: number;
  /** 優先ヘルパー順位 (1-based)。優先リスト外は null */
  preferredRank: number | null;
  /** 渡された schedules 範囲でこの利用者を担当した回数 */
  historyCount: number;
  /** 表示用の理由 (例: ["優先1位", "担当実績4回"]) */
  reasons: string[];
}

/** 予定 1 行に割当済みの職員 id を全て返す (主 + 従来列 2/3 + additional_staff) */
function assignedStaffIds(row: SuggestScheduleRow): string[] {
  const ids: string[] = [];
  if (row.staff_id) ids.push(row.staff_id);
  if (row.staff_id_2) ids.push(row.staff_id_2);
  if (row.staff_id_3) ids.push(row.staff_id_3);
  if (Array.isArray(row.additional_staff)) {
    for (const a of row.additional_staff) {
      if (a && a.staff_id) ids.push(a.staff_id);
    }
  }
  return ids;
}

/** "HH:MM" / "HH:MM:SS" → 分。不正は null */
function toMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = timeToMinutes(t.slice(0, 5));
  return Number.isFinite(m) ? m : null;
}

export function suggestStaff(params: {
  /** 候補プール (通常 = 自事業所の active 職員) */
  staff: Array<{ id: string; name: string }>;
  /** 対象利用者 (担当実績の集計軸) */
  userId: string;
  /** 対象日 "yyyy-MM-dd" */
  visitDate: string;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  /** 重複判定 + 担当実績集計に使う予定リスト (通常 = 表示月の全利用者分) */
  schedules: SuggestScheduleRow[];
  /** 出勤可否 (kaigo_staff_availability_monthly)。空配列 = 判定なし */
  availability: StaffAvailabilitySlot[];
  /** 優先ヘルパー (members.id、優先順) */
  preferredIds: string[];
  /** 編集中の予定 id (自分自身を重複扱いしない) */
  excludeScheduleId?: string | null;
  /** 候補から外す職員 (例: 追加職員に割当済み) */
  excludeStaffIds?: string[];
  limit?: number;
}): StaffSuggestion[] {
  const {
    staff, userId, visitDate, startTime, endTime,
    schedules, availability, preferredIds,
    excludeScheduleId, excludeStaffIds, limit = 5,
  } = params;

  const sMin = toMin(startTime);
  if (sMin === null || !visitDate) return [];
  const eMinRaw = toMin(endTime);
  // 終了未入力/逆転は既存 isStaffUnavailableAtTime と同じく開始+60分とみなす
  const eMin = eMinRaw !== null && eMinRaw > sMin ? eMinRaw : sMin + 60;

  // ① 対象日の割当済み時間帯を職員ごとに集める (cancelled は除外)
  const busy = new Map<string, Array<{ s: number; e: number }>>();
  // ④ 担当実績 (この利用者 × 職員) の回数
  const history = new Map<string, number>();
  for (const row of schedules) {
    if (row.status === "cancelled") continue;
    const ids = assignedStaffIds(row);
    if (ids.length === 0) continue;
    if (row.user_id === userId && !(excludeScheduleId && row.id === excludeScheduleId)) {
      for (const id of new Set(ids)) history.set(id, (history.get(id) ?? 0) + 1);
    }
    if (row.visit_date !== visitDate) continue;
    if (excludeScheduleId && row.id === excludeScheduleId) continue;
    const rs = toMin(row.start_time);
    if (rs === null) continue;
    const reRaw = toMin(row.end_time);
    const re = reRaw !== null && reRaw > rs ? reRaw : rs + 60;
    for (const id of new Set(ids)) {
      const list = busy.get(id) ?? [];
      list.push({ s: rs, e: re });
      busy.set(id, list);
    }
  }

  const excluded = new Set(excludeStaffIds ?? []);
  const out: StaffSuggestion[] = [];
  for (const s of staff) {
    if (excluded.has(s.id)) continue;
    // ① 時間帯重複 → 除外
    const slots = busy.get(s.id);
    if (slots && slots.some((b) => sMin < b.e && eMin > b.s)) continue;
    // ② 出勤可否 NG → 除外 (availability にデータがある職員のみ判定)
    if (isStaffUnavailableAtTime(s.id, visitDate, startTime + ":00", endTime ? endTime + ":00" : null, availability)) {
      continue;
    }
    // ③ 優先ヘルパー加点
    const idx = preferredIds.indexOf(s.id);
    const preferredRank = idx >= 0 ? idx + 1 : null;
    const preferredScore = idx >= 0 ? Math.max(60 - idx * 10, 10) : 0;
    // ④ 担当実績加点
    const historyCount = history.get(s.id) ?? 0;
    const historyScore = Math.min(historyCount, 15) * 2;
    const reasons: string[] = [];
    if (preferredRank) reasons.push(`優先${preferredRank}位`);
    if (historyCount > 0) reasons.push(`担当実績${historyCount}回`);
    if (reasons.length === 0) reasons.push("空き");
    out.push({
      staffId: s.id,
      name: s.name,
      score: preferredScore + historyScore,
      preferredRank,
      historyCount,
      reasons,
    });
  }

  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.historyCount !== a.historyCount) return b.historyCount - a.historyCount;
    return a.name.localeCompare(b.name, "ja");
  });
  return out.slice(0, limit);
}

// ─── preferred_staff 列の読み書き (migrations/preferred_staff.sql 未適用フォールバック付き) ──

/** PostgREST の「列が存在しない」系エラーか (migration 未適用) */
function isMissingColumnError(err: { code?: string } | null): boolean {
  return !!err && (err.code === "42703" || err.code === "PGRST204" || err.code === "PGRST200");
}

/**
 * 利用者×自事業所の優先ヘルパーを取得。
 * - 列未適用 → { supported: false, ids: [] } (エラー扱いにしない)
 * - その他エラー → error にメッセージ (呼出側で表示、握りつぶさない)
 */
export async function fetchPreferredStaffIds(
  supabase: SupabaseClient,
  clientId: string,
  officeId: string,
): Promise<{ ids: string[]; supported: boolean; error: string | null }> {
  const { data, error } = await supabase
    .from("client_office_assignments")
    .select("preferred_staff")
    .eq("client_id", clientId)
    .eq("office_id", officeId)
    .is("end_date", null)
    .limit(1);
  if (error) {
    if (isMissingColumnError(error)) return { ids: [], supported: false, error: null };
    return { ids: [], supported: true, error: error.message };
  }
  const raw = (data?.[0] as { preferred_staff?: unknown } | undefined)?.preferred_staff;
  const ids = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  return { ids, supported: true, error: null };
}

/**
 * 優先ヘルパーを保存 (active な assignment 行の UPDATE のみ、INSERT はしない)。
 * assignment 行が無い利用者 (= 自事業所に未割当) は updated=0 で返す。
 */
export async function savePreferredStaffIds(
  supabase: SupabaseClient,
  clientId: string,
  officeId: string,
  ids: string[],
): Promise<{ error: string | null; updated: number }> {
  const { data, error } = await supabase
    .from("client_office_assignments")
    .update({ preferred_staff: ids.length > 0 ? ids : null })
    .eq("client_id", clientId)
    .eq("office_id", officeId)
    .is("end_date", null)
    .select("client_id");
  if (error) {
    if (isMissingColumnError(error)) {
      return { error: "優先ヘルパー列が未適用です (migrations/preferred_staff.sql を適用してください)", updated: 0 };
    }
    return { error: error.message, updated: 0 };
  }
  return { error: null, updated: (data ?? []).length };
}

// ─── 月データを持たない呼出元用: 対象日 1 日分だけの軽量 fetch (page-loop 付き) ──

/** 対象日の予定 (全利用者) を取得。重複判定 + 当日分の実績集計に使う */
export async function fetchDaySchedules(
  supabase: SupabaseClient,
  dateStr: string,
): Promise<{ rows: SuggestScheduleRow[]; error: string | null }> {
  const PAGE = 1000;
  const out: SuggestScheduleRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("kaigo_visit_schedule")
      .select("id, user_id, staff_id, staff_id_2, staff_id_3, visit_date, start_time, end_time, status")
      .eq("visit_date", dateStr)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { rows: out, error: error.message };
    const rows = (data ?? []) as SuggestScheduleRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { rows: out, error: null };
}

/**
 * 対象日の訪問入浴「号車拘束」を合成 busy 行 (SuggestScheduleRow 形) で返す。
 *
 * 兼務前提: 同一職員が同日内で訪問介護と訪問入浴 (号車) を掛け持ちするため、
 * サジェストの重複判定に号車の拘束時間帯を混ぜる。行の形:
 *   - staff_id = 乗車職員、start/end = その職員が拘束される時間帯
 *   - 拘束 = その号車のその日のコマ (cancelled 除く) のうち、職員の乗車時間帯
 *     (team_days.staff_times、無指定=終日) と重なるものの [最初の開始, 最後の終了]。
 *     乗車時間帯が指定されていればその範囲にクリップ (移動中も拘束扱い)
 *   - user_id = "" (担当実績の集計には影響しない)
 * 入浴シフト未運用 (テーブル/列なし) は空配列で成功扱い。
 */
export async function fetchDayBathBusy(
  supabase: SupabaseClient,
  dateStr: string,
): Promise<{ rows: SuggestScheduleRow[]; error: string | null }> {
  const [tdRes, svRes] = await Promise.all([
    supabase.from("kaigo_bath_team_days").select("*").eq("work_date", dateStr),
    supabase
      .from("kaigo_bath_schedule")
      .select("team_id, start_time, end_time, status")
      .eq("visit_date", dateStr)
      .neq("status", "cancelled"),
  ]);
  const err = tdRes.error ?? svRes.error;
  if (err) {
    // migration 未適用 (テーブル/列なし) は「入浴シフトなし」として成功扱い
    if (err.code === "42P01" || err.code === "PGRST205" || isMissingColumnError(err)) {
      return { rows: [], error: null };
    }
    return { rows: [], error: err.message };
  }
  type TeamDayRow = {
    team_id: string;
    staff_ids: string[] | null;
    staff_times?: Record<string, { start?: string | null; end?: string | null }> | null;
  };
  const visitsByTeam = new Map<string, Array<{ s: number; e: number }>>();
  for (const v of (svRes.data ?? []) as Array<{ team_id: string | null; start_time: string | null; end_time: string | null }>) {
    if (!v.team_id) continue;
    const s = toMin(v.start_time);
    if (s === null) continue;
    const eRaw = toMin(v.end_time);
    const e = eRaw !== null && eRaw > s ? eRaw : s + 50;
    const list = visitsByTeam.get(v.team_id) ?? [];
    list.push({ s, e });
    visitsByTeam.set(v.team_id, list);
  }
  const mmToTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const rows: SuggestScheduleRow[] = [];
  for (const td of (tdRes.data ?? []) as TeamDayRow[]) {
    const visits = visitsByTeam.get(td.team_id);
    if (!visits || visits.length === 0) continue;
    for (const staffId of td.staff_ids ?? []) {
      const range = td.staff_times?.[staffId];
      const rs = toMin(range?.start ?? null);
      const re = toMin(range?.end ?? null);
      const limited = rs !== null && re !== null && re > rs;
      // 乗車時間帯と重なるコマのみ拘束対象
      const covered = limited ? visits.filter((v) => v.s < re && v.e > rs) : visits;
      if (covered.length === 0) continue;
      let busyS = Math.min(...covered.map((v) => v.s));
      let busyE = Math.max(...covered.map((v) => v.e));
      if (limited) {
        busyS = Math.max(busyS, rs);
        busyE = Math.min(busyE, re);
      }
      if (busyE <= busyS) continue;
      rows.push({
        id: `bath-${td.team_id}-${staffId}`,
        user_id: "",
        staff_id: staffId,
        visit_date: dateStr,
        start_time: mmToTime(busyS),
        end_time: mmToTime(busyE),
      });
    }
  }
  return { rows, error: null };
}

/**
 * 対象日の出勤可否を取得。
 * 注: 1 日分のみのため「当月データはあるが当日行なし = 休み」の判定は効かない
 * (isStaffUnavailableAtTime は staff の全 slot が空だと判定しない)。
 * 月データを持つ呼出元 (user-calendar) はそちらを渡すこと。
 */
export async function fetchDayAvailability(
  supabase: SupabaseClient,
  dateStr: string,
): Promise<{ rows: StaffAvailabilitySlot[]; error: string | null }> {
  const PAGE = 1000;
  const out: StaffAvailabilitySlot[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("kaigo_staff_availability_monthly")
      .select("staff_id, available_date, start_time, end_time, is_available")
      .eq("available_date", dateStr)
      .order("staff_id", { ascending: true })
      .order("start_time", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { rows: out, error: error.message };
    const rows = (data ?? []) as StaffAvailabilitySlot[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { rows: out, error: null };
}
