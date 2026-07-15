"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { resolveChiikiBathCode } from "@/lib/idou-shien-code";
import { fetchDaySchedules, type SuggestScheduleRow } from "@/lib/staff-suggest";
import {
  ChevronLeft, ChevronRight, Plus, Loader2, X, Pencil, Trash2, Truck,
  Users, ArrowUp, ArrowDown, Check, Undo2, Copy, Wand2,
  AlertTriangle, Ban, RotateCcw,
} from "lucide-react";

// ── 型 ─────────────────────────────────────────────────────────────────────

type Client = { id: string; name: string; furigana: string | null };
type StaffMember = { id: string; name: string; role: string | null; qualifications: string | null };

type Team = {
  id: string;
  tenant_id: string;
  office_id: string;
  name: string;
  vehicle_note: string | null;
  sort_order: number;
  is_active: boolean;
};

/** 職員ごとの乗車時間帯 (キー無し = 終日)。訪問介護との日内兼務用 */
type StaffTimes = Record<string, { start?: string | null; end?: string | null }>;

type TeamDay = {
  id: string;
  team_id: string;
  work_date: string;
  staff_ids: string[];
  staff_times: StaffTimes | null;
  notes: string | null;
};

type Pattern = {
  id: string;
  office_id: string | null;
  client_id: string;
  day_of_week: number;
  start_time: string | null;
  end_time: string | null;
  team_id: string | null;
  bath_type: "全身浴" | "部分浴";
  scheme: "介護保険" | "地域生活支援";
  is_active: boolean;
  notes: string | null;
};

type ScheduleRow = {
  id: string;
  office_id: string | null;
  client_id: string;
  team_id: string | null;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  visit_order: number;
  bath_type: "全身浴" | "部分浴";
  scheme: "介護保険" | "地域生活支援";
  pattern_id: string | null;
  status: "scheduled" | "completed" | "cancelled";
  record_id: string | null;
  cancel_reason: string | null;
  notes: string | null;
  /** 予定単位のスタッフ指名。空/未定義 = 号車の当日編成から自動 (v2 列、未適用環境では undefined) */
  staff_ids?: string[] | null;
};

type Tab = "route" | "calendar" | "monthly" | "month" | "patterns" | "teams";

// ── ヘルパー ────────────────────────────────────────────────────────────────

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

// 入浴種別 × 職員のみ → 介護保険の算定コード (bath-records と同じ規則)
function resolveBathCode(bathType: "全身浴" | "部分浴", staffOnly: boolean): string {
  if (bathType === "全身浴") return staffOnly ? "121121" : "121111";
  return staffOnly ? "121122" : "121112"; // 部分浴・清拭
}

function isNurse(s: StaffMember): boolean {
  return (s.role ?? "").includes("看護") || (s.qualifications ?? "").includes("看護");
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayStr = () => ymd(new Date());
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : "");

function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return ymd(dt);
}

function dowOf(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

// 予定コマの表示順: 訪問順 → 時刻
function sortVisits(a: ScheduleRow, b: ScheduleRow): number {
  if (a.visit_order !== b.visit_order) return a.visit_order - b.visit_order;
  return (a.start_time ?? "99:99").localeCompare(b.start_time ?? "99:99");
}

function timeToMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const [h, m] = t.slice(0, 5).split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/** 職員の乗車時間帯が有効な範囲指定か */
function limitedRange(times: StaffTimes | null | undefined, staffId: string): { s: number; e: number } | null {
  const r = times?.[staffId];
  const s = timeToMin(r?.start ?? null);
  const e = timeToMin(r?.end ?? null);
  return s !== null && e !== null && e > s ? { s, e } : null;
}

/** 予定の従事職員: スタッフ指名があればそれ、無ければ当日編成のコマ時刻カバー分 */
function visitStaff(td: TeamDay | null, v: ScheduleRow): string[] {
  if (Array.isArray(v.staff_ids) && v.staff_ids.length > 0) return v.staff_ids;
  return effectiveStaffForVisit(td, v);
}

/**
 * コマ時刻をカバーする (乗車時間帯と重なる) 職員のみ返す。
 * 兼務対応: 「午前は号車・午後は訪問介護」の職員は午後のコマの従事職員に含めない。
 * コマ時刻未設定は全員。
 */
function effectiveStaffForVisit(
  td: TeamDay | null,
  v: { start_time: string | null; end_time: string | null },
): string[] {
  if (!td) return [];
  const vs = timeToMin(v.start_time);
  if (vs === null) return td.staff_ids;
  const veRaw = timeToMin(v.end_time);
  const ve = veRaw !== null && veRaw > vs ? veRaw : vs + 50;
  return td.staff_ids.filter((id) => {
    const r = limitedRange(td.staff_times, id);
    return !r || (r.s < ve && r.e > vs);
  });
}

// ── メイン ─────────────────────────────────────────────────────────────────

export function BathShiftContent() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, currentOfficeId } = useBusinessType();
  const tenantId = currentOffice?.tenant_id ?? "kt-group";

  const [tab, setTab] = useState<Tab>("route");
  const [date, setDate] = useState(todayStr);
  const [month, setMonth] = useState(() => todayStr().slice(0, 7));

  const [teams, setTeams] = useState<Team[]>([]);
  const [teamDays, setTeamDays] = useState<TeamDay[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // カレンダー/月間個別の選択状態
  const [calendarAxis, setCalendarAxis] = useState<"user" | "staff">("user");
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);

  // モーダル
  const [editingVisit, setEditingVisit] = useState<{
    visit: ScheduleRow | null;
    presetTeamId: string | null;
    presetDate?: string;
    presetClientId?: string | null;
  } | null>(null);
  const [editingPattern, setEditingPattern] = useState<Pattern | "new" | null>(null);
  const [editingTeam, setEditingTeam] = useState<Team | "new" | null>(null);
  const [editingTeamDay, setEditingTeamDay] = useState<Team | null>(null);

  const clientName = useCallback(
    (id: string) => clients.find((c) => c.id === id)?.name ?? "(不明)",
    [clients]
  );
  const staffName = useCallback(
    (id: string) => staffList.find((s) => s.id === id)?.name ?? "(不明)",
    [staffList]
  );
  const nurseIds = useMemo(() => new Set(staffList.filter(isNurse).map((s) => s.id)), [staffList]);

  const setDateSynced = useCallback((d: string) => {
    setDate(d);
    const mm = d.slice(0, 7);
    setMonth((prev) => (prev === mm ? prev : mm));
  }, []);

  const load = useCallback(async () => {
    if (!currentOfficeId) return;
    setLoading(true);
    try {
      const monthStart = `${month}-01`;
      const monthEnd = `${month}-31`;
      const [teamsRes, assignsRes, staffRes, patternsRes, schedRes] = await Promise.all([
        supabase.from("kaigo_bath_teams").select("*").eq("office_id", currentOfficeId).order("sort_order").order("name"),
        supabase.from("client_office_assignments").select("client_id").eq("office_id", currentOfficeId),
        supabase.from("members").select("id, name, role, qualifications").eq("status", "active").order("name"),
        supabase.from("kaigo_bath_patterns").select("*").eq("office_id", currentOfficeId).order("day_of_week").order("start_time"),
        supabase.from("kaigo_bath_schedule").select("*").eq("office_id", currentOfficeId).gte("visit_date", monthStart).lte("visit_date", monthEnd).order("visit_date"),
      ]);
      for (const r of [teamsRes, assignsRes, staffRes, patternsRes, schedRes]) {
        if (r.error) throw r.error;
      }
      const teamRows = (teamsRes.data ?? []) as Team[];
      const clientIds = Array.from(new Set((assignsRes.data ?? []).map((a: { client_id: string }) => a.client_id)));
      const [clientsRes, teamDaysRes] = await Promise.all([
        clientIds.length
          ? supabase.from("clients").select("id, name, furigana").in("id", clientIds).is("deleted_at", null).order("furigana")
          : Promise.resolve({ data: [], error: null }),
        teamRows.length
          ? supabase.from("kaigo_bath_team_days").select("*").in("team_id", teamRows.map((t) => t.id)).gte("work_date", monthStart).lte("work_date", monthEnd)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (clientsRes.error) throw clientsRes.error;
      if (teamDaysRes.error) throw teamDaysRes.error;
      setTeams(teamRows);
      setClients((clientsRes.data ?? []) as Client[]);
      setStaffList((staffRes.data ?? []) as StaffMember[]);
      setPatterns((patternsRes.data ?? []) as Pattern[]);
      setSchedules((schedRes.data ?? []) as ScheduleRow[]);
      setTeamDays((teamDaysRes.data ?? []) as TeamDay[]);
    } catch (e) {
      console.error("シフトデータの読込に失敗:", e);
      alert("読込に失敗しました: " + (e instanceof Error ? e.message : String(e)) + "\n(bath_shift_v1.sql が未適用の可能性があります)");
    } finally {
      setLoading(false);
    }
  }, [supabase, currentOfficeId, month]);

  useEffect(() => {
    load();
  }, [load]);

  const activeTeams = useMemo(() => teams.filter((t) => t.is_active), [teams]);
  // 職員カレンダー用: 当月どこかの号車に乗る or 予定に指名されている職員だけをリスト (members 全件は多すぎる)
  const rideStaff = useMemo(() => {
    const ids = new Set<string>();
    for (const td of teamDays) for (const id of td.staff_ids) ids.add(id);
    for (const s of schedules) if (Array.isArray(s.staff_ids)) for (const id of s.staff_ids) ids.add(id);
    return staffList.filter((s) => ids.has(s.id));
  }, [teamDays, schedules, staffList]);
  const teamDayFor = useCallback(
    (teamId: string | null, d: string) => (teamId ? teamDays.find((td) => td.team_id === teamId && td.work_date === d) ?? null : null),
    [teamDays]
  );

  // ── 予定コマ操作 ──────────────────────────────────────────────────────────

  const daySchedules = useMemo(() => schedules.filter((s) => s.visit_date === date), [schedules, date]);

  const visitsOf = useCallback(
    (teamId: string | null) =>
      daySchedules
        .filter((s) => (teamId ? s.team_id === teamId : !s.team_id || !activeTeams.some((t) => t.id === s.team_id)))
        .sort(sortVisits),
    [daySchedules, activeTeams]
  );

  // 任意日の号車内 末尾の訪問順 (カレンダーからの追加は対象日で計算)
  const nextOrderOf = useCallback(
    (teamId: string | null, dateStr: string) => {
      const list = schedules.filter((s) => s.visit_date === dateStr && (teamId ? s.team_id === teamId : !s.team_id));
      return list.length ? Math.max(...list.map((x) => x.visit_order)) + 1 : 1;
    },
    [schedules]
  );

  // 号車内の並び替え (訪問順を index で正規化して隣と入替)
  const moveVisit = async (v: ScheduleRow, dir: -1 | 1) => {
    const list = visitsOf(v.team_id);
    const idx = list.findIndex((x) => x.id === v.id);
    const to = idx + dir;
    if (to < 0 || to >= list.length) return;
    const reordered = [...list];
    [reordered[idx], reordered[to]] = [reordered[to], reordered[idx]];
    const updates = reordered
      .map((x, i) => ({ id: x.id, visit_order: i + 1 }))
      .filter((u) => list.find((x) => x.id === u.id)!.visit_order !== u.visit_order);
    const results = await Promise.all(
      updates.map((u) => supabase.from("kaigo_bath_schedule").update({ visit_order: u.visit_order }).eq("id", u.id))
    );
    const err = results.find((r) => r.error);
    if (err?.error) {
      alert("並び替えに失敗しました: " + err.error.message);
      return;
    }
    setSchedules((prev) => prev.map((s) => {
      const u = updates.find((x) => x.id === s.id);
      return u ? { ...s, visit_order: u.visit_order } : s;
    }));
  };

  const reassignTeam = async (v: ScheduleRow, teamId: string | null) => {
    const target = visitsOf(teamId);
    const nextOrder = target.length ? Math.max(...target.map((x) => x.visit_order)) + 1 : 1;
    const { error } = await supabase.from("kaigo_bath_schedule").update({ team_id: teamId, visit_order: nextOrder }).eq("id", v.id);
    if (error) { alert("号車変更に失敗しました: " + error.message); return; }
    setSchedules((prev) => prev.map((s) => (s.id === v.id ? { ...s, team_id: teamId, visit_order: nextOrder } : s)));
  };

  const toggleCancel = async (v: ScheduleRow) => {
    if (v.status === "completed") { alert("実績反映済の予定は中止にできません。先に実績を戻してください。"); return; }
    const next = v.status === "cancelled" ? "scheduled" : "cancelled";
    let cancelReason: string | null = null;
    if (next === "cancelled") {
      const input = window.prompt(`${clientName(v.client_id)} 様 ${v.visit_date} を中止にします。理由 (任意):`, "");
      if (input === null) return;
      cancelReason = input || null;
    }
    const { error } = await supabase.from("kaigo_bath_schedule").update({ status: next, cancel_reason: cancelReason }).eq("id", v.id);
    if (error) { alert("更新に失敗しました: " + error.message); return; }
    setSchedules((prev) => prev.map((s) => (s.id === v.id ? { ...s, status: next, cancel_reason: cancelReason } : s)));
  };

  const deleteVisit = async (v: ScheduleRow) => {
    if (v.status === "completed") { alert("実績反映済の予定は削除できません。先に実績を戻してください。"); return; }
    if (!window.confirm(`${clientName(v.client_id)} 様 ${v.visit_date} の予定を削除します。よろしいですか？`)) return;
    const { error } = await supabase.from("kaigo_bath_schedule").delete().eq("id", v.id);
    if (error) { alert("削除に失敗しました: " + error.message); return; }
    setSchedules((prev) => prev.filter((s) => s.id !== v.id));
  };

  // ── 実績反映 ─────────────────────────────────────────────────────────────

  const applyActual = async (v: ScheduleRow, opts?: { silent?: boolean }): Promise<boolean> => {
    if (v.record_id || v.status === "completed") return true;
    const td = teamDayFor(v.team_id, v.visit_date);
    // スタッフ指名があればそれ、無ければ当日編成のコマ時刻カバー分 (兼務対応)
    const staffIds = visitStaff(td, v);
    if (staffIds.length === 0 && !opts?.silent) {
      const reason = td && td.staff_ids.length > 0 ? "この時間帯に乗車している職員がいません" : "号車の当日編成が未設定です";
      if (!window.confirm(`${clientName(v.client_id)} 様: ${reason}。従事職員なし (職員のみ減算扱い) で実績反映しますか？`)) return false;
    }
    const staffOnly = !staffIds.some((id) => nurseIds.has(id));
    const serviceCode = v.scheme === "地域生活支援" ? resolveChiikiBathCode(staffOnly, false) : resolveBathCode(v.bath_type, staffOnly);
    const { data: rec, error } = await supabase
      .from("kaigo_bath_visit_records")
      .insert({
        client_id: v.client_id,
        office_id: v.office_id,
        tenant_id: tenantId,
        visit_date: v.visit_date,
        start_time: v.start_time,
        end_time: v.end_time,
        bath_type: v.bath_type,
        staff_only: staffOnly,
        scheme: v.scheme,
        service_code: serviceCode,
        staff_ids: staffIds,
        status: "draft",
      })
      .select("id")
      .single();
    if (error || !rec) {
      alert("実績記録の作成に失敗しました: " + (error?.message ?? "不明なエラー"));
      return false;
    }
    const { error: e2 } = await supabase.from("kaigo_bath_schedule").update({ status: "completed", record_id: rec.id }).eq("id", v.id);
    if (e2) { alert("予定の更新に失敗しました: " + e2.message); return false; }
    setSchedules((prev) => prev.map((s) => (s.id === v.id ? { ...s, status: "completed", record_id: rec.id } : s)));
    return true;
  };

  const revertActual = async (v: ScheduleRow, opts?: { silent?: boolean }): Promise<boolean> => {
    if (v.status !== "completed") return true;
    if (!opts?.silent) {
      if (!window.confirm(`${clientName(v.client_id)} 様 ${v.visit_date} の実績記録を取り消して予定に戻します。よろしいですか？`)) return false;
    }
    if (v.record_id) {
      const { error } = await supabase.from("kaigo_bath_visit_records").delete().eq("id", v.record_id);
      if (error) { alert("実績記録の削除に失敗しました: " + error.message); return false; }
    }
    const { error: e2 } = await supabase.from("kaigo_bath_schedule").update({ status: "scheduled", record_id: null }).eq("id", v.id);
    if (e2) { alert("予定の更新に失敗しました: " + e2.message); return false; }
    setSchedules((prev) => prev.map((s) => (s.id === v.id ? { ...s, status: "scheduled", record_id: null } : s)));
    return true;
  };

  // 月間個別のレバー (予⇔実) 一括保存。訪問介護の monthly-individual と同じ「保存で確定」方式
  const commitMonthlyChanges = async (changes: Array<{ v: ScheduleRow; toCompleted: boolean }>): Promise<boolean> => {
    if (changes.length === 0) return true;
    const toC = changes.filter((c) => c.toCompleted).length;
    const toS = changes.length - toC;
    const parts = [toC > 0 && `実績化 ${toC} 件`, toS > 0 && `予定へ戻す ${toS} 件`].filter(Boolean).join(" / ");
    if (!window.confirm(`実績反映の変更を保存します (${parts})。よろしいですか？`)) return false;
    setBusy(true);
    let ok = 0;
    for (const c of changes) {
      const done = c.toCompleted ? await applyActual(c.v, { silent: true }) : await revertActual(c.v, { silent: true });
      if (done) ok++;
    }
    setBusy(false);
    alert(`${ok}/${changes.length} 件を保存しました (実績記録・提供表にも反映)`);
    return true;
  };

  const applyDayActuals = async () => {
    const targets = daySchedules.filter((s) => s.status === "scheduled");
    if (targets.length === 0) { alert("この日に実績反映できる予定がありません。"); return; }
    const noStaffing = targets.filter((s) => visitStaff(teamDayFor(s.team_id, s.visit_date), s).length === 0);
    const msg =
      `${date} の予定 ${targets.length} 件を実績反映します。` +
      (noStaffing.length ? `\n⚠ うち ${noStaffing.length} 件は当日編成が未設定 (従事職員なしで記録されます)。` : "") +
      `\nよろしいですか？`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    let ok = 0;
    for (const v of targets) {
      if (await applyActual(v, { silent: true })) ok++;
    }
    setBusy(false);
    alert(`${ok}/${targets.length} 件を実績反映しました。`);
  };

  // ── 当日編成 ─────────────────────────────────────────────────────────────

  const saveTeamDay = async (teamId: string, staffIds: string[], staffTimes: StaffTimes, notes: string) => {
    const payload = {
      tenant_id: tenantId, team_id: teamId, work_date: date,
      staff_ids: staffIds, staff_times: staffTimes, notes: notes || null,
    };
    let { data, error } = await supabase
      .from("kaigo_bath_team_days")
      .upsert(payload, { onConflict: "team_id,work_date" })
      .select("*")
      .single();
    if (error && (error.code === "PGRST204" || error.code === "42703")) {
      // staff_times 列未適用 → 終日扱いで保存 (bath_shift_v2_staff_times.sql の適用を案内)
      alert("乗車時間帯の保存には bath_shift_v2_staff_times.sql の適用が必要です。今回は終日扱いで保存します。");
      const { staff_times: _st, ...withoutTimes } = payload;
      void _st;
      ({ data, error } = await supabase
        .from("kaigo_bath_team_days")
        .upsert(withoutTimes, { onConflict: "team_id,work_date" })
        .select("*")
        .single());
    }
    if (error || !data) { alert("編成の保存に失敗しました: " + (error?.message ?? "不明なエラー")); return; }
    setTeamDays((prev) => {
      const rest = prev.filter((td) => !(td.team_id === teamId && td.work_date === date));
      return [...rest, data as TeamDay];
    });
    setEditingTeamDay(null);
  };

  const copyPrevStaffing = async () => {
    if (activeTeams.length === 0) return;
    const { data, error } = await supabase
      .from("kaigo_bath_team_days")
      .select("*")
      .in("team_id", activeTeams.map((t) => t.id))
      .lt("work_date", date)
      .gte("work_date", addDays(date, -14))
      .order("work_date", { ascending: false });
    if (error) { alert("直近編成の取得に失敗しました: " + error.message); return; }
    const latest = new Map<string, TeamDay>();
    for (const td of (data ?? []) as TeamDay[]) {
      if (!latest.has(td.team_id) && td.staff_ids.length > 0) latest.set(td.team_id, td);
    }
    if (latest.size === 0) { alert("直近 14 日以内に編成データがありません。"); return; }
    const hasExisting = activeTeams.some((t) => (teamDayFor(t.id, date)?.staff_ids ?? []).length > 0);
    if (hasExisting && !window.confirm("この日に既に編成があります。直近の編成で上書きしますか？")) return;
    // 乗車時間帯 (staff_times) は日ごとの事情なのでコピーしない (終日扱いで複製)
    const payloads = Array.from(latest.values()).map((td) => ({
      tenant_id: tenantId, team_id: td.team_id, work_date: date, staff_ids: td.staff_ids, notes: td.notes,
    }));
    const { data: saved, error: e2 } = await supabase
      .from("kaigo_bath_team_days")
      .upsert(payloads, { onConflict: "team_id,work_date" })
      .select("*");
    if (e2) { alert("編成のコピーに失敗しました: " + e2.message); return; }
    setTeamDays((prev) => {
      const savedRows = (saved ?? []) as TeamDay[];
      const rest = prev.filter((td) => !(td.work_date === date && savedRows.some((s) => s.team_id === td.team_id)));
      return [...rest, ...savedRows];
    });
  };

  // ── パターン → 月間一括生成 ───────────────────────────────────────────────

  const generateMonth = async () => {
    const active = patterns.filter((p) => p.is_active);
    if (active.length === 0) { alert("有効な週間パターンがありません。「週間パターン」タブで登録してください。"); return; }
    if (!window.confirm(`${month} の予定を週間パターンから一括生成します (同一利用者・同日の既存予定はスキップ)。よろしいですか？`)) return;
    setBusy(true);
    try {
      const existing = new Set(schedules.map((s) => `${s.client_id}|${s.visit_date}`));
      const days = daysInMonth(month);
      const payloads: Omit<ScheduleRow, "id" | "record_id" | "cancel_reason" | "status" | "notes">[] = [];
      for (let d = 1; d <= days; d++) {
        const dateStr = `${month}-${pad2(d)}`;
        const dow = dowOf(dateStr);
        for (const p of active) {
          if (p.day_of_week !== dow) continue;
          const key = `${p.client_id}|${dateStr}`;
          if (existing.has(key)) continue;
          existing.add(key);
          payloads.push({
            office_id: currentOfficeId,
            client_id: p.client_id,
            team_id: p.team_id,
            visit_date: dateStr,
            start_time: p.start_time,
            end_time: p.end_time,
            visit_order: 0,
            bath_type: p.bath_type,
            scheme: p.scheme,
            pattern_id: p.id,
          });
        }
      }
      if (payloads.length === 0) { alert("生成対象がありません (すべて既存予定と重複)。"); return; }
      // 号車×日ごとに時刻順で訪問順を振る
      const groups = new Map<string, typeof payloads>();
      for (const p of payloads) {
        const k = `${p.team_id ?? "-"}|${p.visit_date}`;
        const g = groups.get(k) ?? [];
        g.push(p);
        groups.set(k, g);
      }
      for (const g of groups.values()) {
        g.sort((a, b) => (a.start_time ?? "99:99").localeCompare(b.start_time ?? "99:99"));
        const base = schedules.filter((s) => s.visit_date === g[0].visit_date && s.team_id === g[0].team_id);
        const offset = base.length ? Math.max(...base.map((s) => s.visit_order)) : 0;
        g.forEach((p, i) => { p.visit_order = offset + i + 1; });
      }
      const rows = payloads.map((p) => ({ ...p, tenant_id: tenantId }));
      const { error } = await supabase.from("kaigo_bath_schedule").insert(rows);
      if (error) { alert("一括生成に失敗しました: " + error.message); return; }
      alert(`${rows.length} 件の予定を生成しました。`);
      load();
    } finally {
      setBusy(false);
    }
  };

  // ── レンダリング ──────────────────────────────────────────────────────────

  if (!currentOfficeId) {
    return <div className="p-8 text-sm text-gray-400">訪問入浴事業所を選択してください。</div>;
  }

  const [my, mm] = month.split("-").map(Number);
  const tabBtn = (t: Tab, label: string) => (
    <button
      key={t}
      onClick={() => setTab(t)}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium ${tab === t ? "bg-cyan-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col bg-white">
      {/* ツールバー */}
      <div className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2 shrink-0">
        <Truck size={18} className="text-cyan-600" />
        <h1 className="text-sm font-semibold text-gray-800">シフト・ルート表</h1>
        <div className="flex items-center gap-1 rounded-lg bg-white p-0.5 ring-1 ring-gray-200">
          {tabBtn("route", "日次ルート表")}
          {tabBtn("calendar", "カレンダー")}
          {tabBtn("monthly", "月間個別")}
          {tabBtn("month", "月間 (号車)")}
          {tabBtn("patterns", "週間パターン")}
          {tabBtn("teams", "号車マスタ")}
        </div>
        {tab === "route" ? (
          <div className="flex items-center gap-0.5 rounded border border-gray-300 bg-white px-2 py-1">
            <button onClick={() => setDateSynced(addDays(date, -1))} className="text-gray-500 hover:text-gray-800"><ChevronLeft size={14} /></button>
            <input
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDateSynced(e.target.value)}
              className="w-[130px] text-sm font-semibold text-gray-800 outline-none"
            />
            <span className="pr-1 text-xs text-gray-500">({DOW_LABELS[dowOf(date)]})</span>
            <button onClick={() => setDateSynced(addDays(date, 1))} className="text-gray-500 hover:text-gray-800"><ChevronRight size={14} /></button>
          </div>
        ) : (
          <div className="flex items-center gap-0.5 rounded border border-gray-300 bg-white px-2 py-1">
            <button onClick={() => { const d = new Date(my, mm - 2, 1); setMonth(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`); }} className="text-gray-500 hover:text-gray-800"><ChevronLeft size={14} /></button>
            <span className="px-1.5 text-sm font-semibold text-gray-800">{my}年{mm}月</span>
            <button onClick={() => { const d = new Date(my, mm, 1); setMonth(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`); }} className="text-gray-500 hover:text-gray-800"><ChevronRight size={14} /></button>
          </div>
        )}
        {tab === "route" && (
          <>
            <button onClick={() => setDateSynced(todayStr())} className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-100">今日</button>
            <button onClick={copyPrevStaffing} className="flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-100">
              <Copy size={12} />直近の編成をコピー
            </button>
            <button onClick={applyDayActuals} disabled={busy} className="ml-auto flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}この日を一括実績反映
            </button>
          </>
        )}
        {tab === "month" && (
          <button onClick={generateMonth} disabled={busy} className="ml-auto flex items-center gap-1 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}パターンから当月分を生成
          </button>
        )}
        {tab === "patterns" && (
          <button onClick={() => setEditingPattern("new")} className="ml-auto flex items-center gap-1 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700">
            <Plus size={14} />パターン追加
          </button>
        )}
        {tab === "teams" && (
          <button onClick={() => setEditingTeam("new")} className="ml-auto flex items-center gap-1 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700">
            <Plus size={14} />号車追加
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-cyan-400" /></div>
        ) : teams.length === 0 && tab !== "teams" ? (
          <div className="py-16 text-center text-sm text-gray-400">
            号車が未登録です。まず
            <button onClick={() => setTab("teams")} className="mx-1 font-medium text-cyan-600 underline">号車マスタ</button>
            で入浴車 (チーム) を登録してください。
          </div>
        ) : tab === "route" ? (
          <RouteView
            date={date}
            activeTeams={activeTeams}
            visitsOf={visitsOf}
            teamDayFor={teamDayFor}
            clientName={clientName}
            staffName={staffName}
            nurseIds={nurseIds}
            onEditTeamDay={(t) => setEditingTeamDay(t)}
            onAddVisit={(teamId) => setEditingVisit({ visit: null, presetTeamId: teamId })}
            onEditVisit={(v) => setEditingVisit({ visit: v, presetTeamId: null })}
            onMove={moveVisit}
            onReassign={reassignTeam}
            onCancel={toggleCancel}
            onDelete={deleteVisit}
            onApply={(v) => applyActual(v)}
            onRevert={revertActual}
          />
        ) : tab === "calendar" ? (
          <BathCalendarView
            month={month}
            axis={calendarAxis}
            setAxis={setCalendarAxis}
            clients={clients}
            selectedClientId={selectedClientId ?? clients[0]?.id ?? null}
            onSelectClient={setSelectedClientId}
            rideStaff={rideStaff}
            selectedStaffId={selectedStaffId ?? rideStaff[0]?.id ?? null}
            onSelectStaff={setSelectedStaffId}
            schedules={schedules}
            teamDays={teamDays}
            teams={teams}
            nurseIds={nurseIds}
            onAddVisit={(d, clientId) => setEditingVisit({ visit: null, presetTeamId: null, presetDate: d, presetClientId: clientId })}
            onEditVisit={(v) => setEditingVisit({ visit: v, presetTeamId: null })}
            onOpenDay={(d) => { setDateSynced(d); setTab("route"); }}
          />
        ) : tab === "monthly" ? (
          <BathMonthlyView
            clients={clients}
            selectedClientId={selectedClientId ?? clients[0]?.id ?? null}
            onSelectClient={setSelectedClientId}
            schedules={schedules}
            teams={teams}
            busy={busy}
            onAdd={(clientId) => setEditingVisit({ visit: null, presetTeamId: null, presetClientId: clientId })}
            onEdit={(v) => setEditingVisit({ visit: v, presetTeamId: null })}
            onCommit={commitMonthlyChanges}
            onCancel={toggleCancel}
            onDelete={deleteVisit}
          />
        ) : tab === "month" ? (
          <MonthView
            month={month}
            activeTeams={activeTeams}
            schedules={schedules}
            teamDays={teamDays}
            onOpenDay={(d) => { setDateSynced(d); setTab("route"); }}
          />
        ) : tab === "patterns" ? (
          <PatternsView
            patterns={patterns}
            clientName={clientName}
            teams={teams}
            onEdit={(p) => setEditingPattern(p)}
            onToggleActive={async (p) => {
              const { error } = await supabase.from("kaigo_bath_patterns").update({ is_active: !p.is_active }).eq("id", p.id);
              if (error) { alert("更新に失敗しました: " + error.message); return; }
              setPatterns((prev) => prev.map((x) => (x.id === p.id ? { ...x, is_active: !p.is_active } : x)));
            }}
            onDelete={async (p) => {
              if (!window.confirm(`${clientName(p.client_id)} 様 ${DOW_LABELS[p.day_of_week]}曜のパターンを削除します。よろしいですか？`)) return;
              const { error } = await supabase.from("kaigo_bath_patterns").delete().eq("id", p.id);
              if (error) { alert("削除に失敗しました: " + error.message); return; }
              setPatterns((prev) => prev.filter((x) => x.id !== p.id));
            }}
          />
        ) : (
          <TeamsView teams={teams} onEdit={(t) => setEditingTeam(t)} />
        )}
      </div>

      {/* モーダル群 */}
      {editingVisit && (
        <VisitModal
          supabase={supabase}
          visit={editingVisit.visit}
          presetTeamId={editingVisit.presetTeamId}
          presetClientId={editingVisit.presetClientId ?? null}
          date={editingVisit.presetDate ?? date}
          clients={clients}
          teams={activeTeams}
          staffList={staffList}
          nurseIds={nurseIds}
          officeId={currentOfficeId}
          tenantId={tenantId}
          nextOrderOf={nextOrderOf}
          onClose={() => setEditingVisit(null)}
          onSaved={(row, isNew) => {
            setEditingVisit(null);
            setSchedules((prev) => (isNew ? [...prev, row] : prev.map((s) => (s.id === row.id ? row : s))));
          }}
        />
      )}
      {editingPattern && (
        <PatternModal
          supabase={supabase}
          pattern={editingPattern === "new" ? null : editingPattern}
          clients={clients}
          teams={activeTeams}
          officeId={currentOfficeId}
          tenantId={tenantId}
          onClose={() => setEditingPattern(null)}
          onSaved={(row, isNew) => {
            setEditingPattern(null);
            setPatterns((prev) => (isNew ? [...prev, row] : prev.map((p) => (p.id === row.id ? row : p))));
          }}
        />
      )}
      {editingTeam && (
        <TeamModal
          supabase={supabase}
          team={editingTeam === "new" ? null : editingTeam}
          officeId={currentOfficeId}
          tenantId={tenantId}
          onClose={() => setEditingTeam(null)}
          onSaved={(row, isNew) => {
            setEditingTeam(null);
            setTeams((prev) => (isNew ? [...prev, row] : prev.map((t) => (t.id === row.id ? row : t))));
          }}
        />
      )}
      {editingTeamDay && (
        <TeamDayModal
          supabase={supabase}
          team={editingTeamDay}
          date={date}
          initial={teamDayFor(editingTeamDay.id, date)}
          teamVisits={visitsOf(editingTeamDay.id)}
          staffList={staffList}
          onClose={() => setEditingTeamDay(null)}
          onSave={(staffIds, staffTimes, notes) => saveTeamDay(editingTeamDay.id, staffIds, staffTimes, notes)}
        />
      )}
    </div>
  );
}

// ── 日次ルート表 ─────────────────────────────────────────────────────────────

function RouteView({
  date, activeTeams, visitsOf, teamDayFor, clientName, staffName, nurseIds,
  onEditTeamDay, onAddVisit, onEditVisit, onMove, onReassign, onCancel, onDelete, onApply, onRevert,
}: {
  date: string;
  activeTeams: Team[];
  visitsOf: (teamId: string | null) => ScheduleRow[];
  teamDayFor: (teamId: string | null, d: string) => TeamDay | null;
  clientName: (id: string) => string;
  staffName: (id: string) => string;
  nurseIds: Set<string>;
  onEditTeamDay: (t: Team) => void;
  onAddVisit: (teamId: string | null) => void;
  onEditVisit: (v: ScheduleRow) => void;
  onMove: (v: ScheduleRow, dir: -1 | 1) => void;
  onReassign: (v: ScheduleRow, teamId: string | null) => void;
  onCancel: (v: ScheduleRow) => void;
  onDelete: (v: ScheduleRow) => void;
  onApply: (v: ScheduleRow) => void;
  onRevert: (v: ScheduleRow) => void;
}) {
  const unassigned = visitsOf(null);

  const visitCard = (v: ScheduleRow, idx: number, list: ScheduleRow[]) => {
    // 予定単位のスタッフ指名 (空 = 当日編成から自動)
    const override = Array.isArray(v.staff_ids) && v.staff_ids.length > 0 ? v.staff_ids : null;
    // 兼務対応: 乗車時間帯によってこのコマをカバーする職員が減る場合のみバッジ表示
    const cardTd = teamDayFor(v.team_id, date);
    let coverage: { eff: string[]; nurseOk: boolean } | null = null;
    if (!override && cardTd && cardTd.staff_ids.length > 0 && v.status !== "cancelled") {
      const eff = effectiveStaffForVisit(cardTd, v);
      if (eff.length !== cardTd.staff_ids.length) {
        coverage = { eff, nurseOk: eff.some((id) => nurseIds.has(id)) };
      }
    }
    return (
    <div
      key={v.id}
      className={`rounded-lg border p-2 text-xs ${
        v.status === "cancelled" ? "border-gray-200 bg-gray-50 opacity-60" :
        v.status === "completed" ? "border-emerald-200 bg-emerald-50" : "border-gray-200 bg-white"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-600 text-[10px] font-bold text-white">{idx + 1}</span>
        <span className="font-semibold text-gray-800 truncate">{clientName(v.client_id)}</span>
        <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-gray-500">
          {hhmm(v.start_time)}{v.end_time ? `-${hhmm(v.end_time)}` : ""}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-gray-500">
        {v.scheme === "地域生活支援" && <span className="rounded bg-violet-50 px-1 py-0.5 text-violet-600">障害</span>}
        <span>{v.bath_type === "部分浴" ? "部分浴・清拭" : v.bath_type}</span>
        {v.status === "cancelled" && <span className="text-red-500">中止{v.cancel_reason ? `: ${v.cancel_reason}` : ""}</span>}
        {v.status === "completed" && <span className="font-medium text-emerald-600">実績済</span>}
        {override && (
          <span className="rounded bg-indigo-50 px-1 py-0.5 text-indigo-600" title={override.map(staffName).join("、")}>
            指名{override.length}名
          </span>
        )}
        {override && v.status !== "cancelled" && !override.some((id) => nurseIds.has(id)) && (
          <span className="font-medium text-amber-600">看護なし(減算)</span>
        )}
        {coverage && (
          coverage.eff.length === 0 ? (
            <span className="font-medium text-red-500">この時間帯 乗車職員なし</span>
          ) : (
            <>
              <span className="text-amber-600">乗車{coverage.eff.length}名</span>
              {!coverage.nurseOk && <span className="font-medium text-amber-600">看護なし(減算)</span>}
            </>
          )
        )}
        {v.notes && <span className="truncate text-gray-400" title={v.notes}>{v.notes}</span>}
      </div>
      <div className="mt-1.5 flex items-center gap-0.5">
        <button onClick={() => onMove(v, -1)} disabled={idx === 0} className="p-0.5 text-gray-400 hover:text-cyan-600 disabled:opacity-30"><ArrowUp size={12} /></button>
        <button onClick={() => onMove(v, 1)} disabled={idx === list.length - 1} className="p-0.5 text-gray-400 hover:text-cyan-600 disabled:opacity-30"><ArrowDown size={12} /></button>
        <button onClick={() => onEditVisit(v)} className="p-0.5 text-gray-400 hover:text-cyan-600"><Pencil size={12} /></button>
        {v.status !== "completed" && (
          <button onClick={() => onCancel(v)} title={v.status === "cancelled" ? "中止を解除" : "中止"} className="p-0.5 text-gray-400 hover:text-amber-600">
            {v.status === "cancelled" ? <RotateCcw size={12} /> : <Ban size={12} />}
          </button>
        )}
        <button onClick={() => onDelete(v)} className="p-0.5 text-gray-400 hover:text-red-500"><Trash2 size={12} /></button>
        <select
          value=""
          onChange={(e) => { if (e.target.value) onReassign(v, e.target.value === "__none__" ? null : e.target.value); }}
          className="ml-1 max-w-[72px] rounded border border-gray-200 px-0.5 py-0.5 text-[10px] text-gray-500"
          title="号車を変更"
        >
          <option value="">移動...</option>
          {activeTeams.filter((t) => t.id !== v.team_id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          {v.team_id && <option value="__none__">未割当へ</option>}
        </select>
        {v.status === "scheduled" ? (
          <button onClick={() => onApply(v)} className="ml-auto flex items-center gap-0.5 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-700">
            <Check size={10} />実績
          </button>
        ) : v.status === "completed" ? (
          <button onClick={() => onRevert(v)} className="ml-auto flex items-center gap-0.5 rounded border border-emerald-300 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-100">
            <Undo2 size={10} />戻す
          </button>
        ) : null}
      </div>
    </div>
    );
  };

  const teamColumn = (team: Team) => {
    const td = teamDayFor(team.id, date);
    const staffIds = td?.staff_ids ?? [];
    const hasNurse = staffIds.some((id) => nurseIds.has(id));
    const visits = visitsOf(team.id);
    return (
      <div key={team.id} className="flex w-64 shrink-0 flex-col rounded-xl border border-gray-200 bg-gray-50">
        {/* 号車ヘッダー + 当日編成 */}
        <div className="rounded-t-xl border-b border-gray-200 bg-white p-2.5">
          <div className="flex items-center gap-1.5">
            <Truck size={14} className="text-cyan-600" />
            <span className="text-sm font-semibold text-gray-800">{team.name}</span>
            <span className="text-[10px] text-gray-400">{visits.filter((v) => v.status !== "cancelled").length}件</span>
            <button onClick={() => onEditTeamDay(team)} className="ml-auto flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-50">
              <Users size={10} />編成
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {staffIds.length === 0 ? (
              <span className="text-[10px] text-gray-400">編成未設定</span>
            ) : (
              staffIds.map((id) => {
                const r = limitedRange(td?.staff_times ?? null, id);
                return (
                  <span key={id} className={`rounded-full px-1.5 py-0.5 text-[10px] ${nurseIds.has(id) ? "bg-rose-50 font-medium text-rose-600" : "bg-gray-100 text-gray-600"}`}>
                    {nurseIds.has(id) && "看 "}{staffName(id)}
                    {r && (
                      <span className="ml-0.5 font-mono text-[9px] opacity-70">
                        {hhmm(td?.staff_times?.[id]?.start ?? null)}-{hhmm(td?.staff_times?.[id]?.end ?? null)}
                      </span>
                    )}
                  </span>
                );
              })
            )}
          </div>
          {staffIds.length > 0 && !hasNurse && (
            <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-amber-600">
              <AlertTriangle size={10} />看護職員なし → 職員のみ (減算) で算定
            </p>
          )}
          {staffIds.length > 0 && staffIds.length < 3 && (
            <p className="mt-0.5 text-[10px] text-amber-600">⚠ 3名未満 ({staffIds.length}名)</p>
          )}
        </div>
        {/* 訪問リスト */}
        <div className="flex flex-1 flex-col gap-1.5 p-2">
          {visits.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-gray-300">予定なし</p>
          ) : (
            visits.map((v, i) => visitCard(v, i, visits))
          )}
          <button onClick={() => onAddVisit(team.id)} className="mt-1 flex items-center justify-center gap-1 rounded-lg border border-dashed border-gray-300 py-1.5 text-[11px] text-gray-400 hover:border-cyan-300 hover:text-cyan-600">
            <Plus size={12} />予定追加
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex min-h-full items-start gap-3 p-4">
      {activeTeams.map(teamColumn)}
      {/* 未割当列 */}
      <div className="flex w-64 shrink-0 flex-col rounded-xl border border-dashed border-gray-300">
        <div className="border-b border-dashed border-gray-300 p-2.5">
          <span className="text-sm font-semibold text-gray-500">未割当</span>
          <span className="ml-1.5 text-[10px] text-gray-400">{unassigned.length}件</span>
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-2">
          {unassigned.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-gray-300">なし</p>
          ) : (
            unassigned.map((v, i) => visitCard(v, i, unassigned))
          )}
          <button onClick={() => onAddVisit(null)} className="mt-1 flex items-center justify-center gap-1 rounded-lg border border-dashed border-gray-300 py-1.5 text-[11px] text-gray-400 hover:border-cyan-300 hover:text-cyan-600">
            <Plus size={12} />予定追加
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 月間ビュー ───────────────────────────────────────────────────────────────

function MonthView({
  month, activeTeams, schedules, teamDays, onOpenDay,
}: {
  month: string;
  activeTeams: Team[];
  schedules: ScheduleRow[];
  teamDays: TeamDay[];
  onOpenDay: (d: string) => void;
}) {
  const days = daysInMonth(month);
  const cellsFor = (dateStr: string, teamId: string | null) =>
    schedules.filter((s) =>
      s.visit_date === dateStr &&
      (teamId ? s.team_id === teamId : !s.team_id || !activeTeams.some((t) => t.id === s.team_id))
    );

  return (
    <div className="p-4">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-gray-100">
          <tr>
            <th className="border border-gray-200 px-2 py-1.5 text-left font-semibold text-gray-600">日付</th>
            {activeTeams.map((t) => (
              <th key={t.id} className="border border-gray-200 px-2 py-1.5 text-left font-semibold text-gray-600">{t.name}</th>
            ))}
            <th className="border border-gray-200 px-2 py-1.5 text-left font-semibold text-gray-400">未割当</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: days }, (_, i) => {
            const dateStr = `${month}-${pad2(i + 1)}`;
            const dow = dowOf(dateStr);
            return (
              <tr key={dateStr} className={dow === 0 ? "bg-red-50/40" : dow === 6 ? "bg-blue-50/40" : ""}>
                <td
                  onClick={() => onOpenDay(dateStr)}
                  className={`w-24 cursor-pointer border border-gray-200 px-2 py-1 font-medium hover:bg-cyan-50 ${dow === 0 ? "text-red-500" : dow === 6 ? "text-blue-500" : "text-gray-700"}`}
                >
                  {i + 1}日 ({DOW_LABELS[dow]})
                </td>
                {activeTeams.map((t) => {
                  const cells = cellsFor(dateStr, t.id);
                  const active = cells.filter((c) => c.status !== "cancelled");
                  const done = cells.filter((c) => c.status === "completed");
                  const td = teamDays.find((x) => x.team_id === t.id && x.work_date === dateStr);
                  const noStaffing = active.length > 0 && (td?.staff_ids ?? []).length === 0;
                  return (
                    <td key={t.id} onClick={() => onOpenDay(dateStr)} className="cursor-pointer border border-gray-200 px-2 py-1 hover:bg-cyan-50">
                      {active.length > 0 && (
                        <span className="text-gray-700">
                          {active.length}件
                          {done.length > 0 && <span className="ml-1 text-emerald-600">(実績{done.length})</span>}
                          {noStaffing && <AlertTriangle size={10} className="ml-1 inline text-amber-500" />}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td onClick={() => onOpenDay(dateStr)} className="cursor-pointer border border-gray-200 px-2 py-1 text-gray-400 hover:bg-cyan-50">
                  {cellsFor(dateStr, null).length > 0 ? `${cellsFor(dateStr, null).length}件` : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-gray-400">
        セルをクリックで日次ルート表へ。<AlertTriangle size={10} className="inline text-amber-500" /> = 予定があるのに当日編成が未設定の号車。
      </p>
    </div>
  );
}

// ── 週間パターン一覧 ─────────────────────────────────────────────────────────

function PatternsView({
  patterns, clientName, teams, onEdit, onToggleActive, onDelete,
}: {
  patterns: Pattern[];
  clientName: (id: string) => string;
  teams: Team[];
  onEdit: (p: Pattern) => void;
  onToggleActive: (p: Pattern) => void;
  onDelete: (p: Pattern) => void;
}) {
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? "未割当";
  if (patterns.length === 0) {
    return <p className="py-16 text-center text-sm text-gray-400">週間パターンがありません。「パターン追加」から登録してください。</p>;
  }
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 z-10 bg-gray-100 text-gray-600">
        <tr>
          <th className="px-3 py-2 text-left font-semibold">利用者</th>
          <th className="px-3 py-2 text-left font-semibold">曜日</th>
          <th className="px-3 py-2 text-left font-semibold">時間</th>
          <th className="px-3 py-2 text-left font-semibold">号車</th>
          <th className="px-3 py-2 text-left font-semibold">種別</th>
          <th className="px-3 py-2 text-left font-semibold">状態</th>
          <th className="px-3 py-2 text-right font-semibold"></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {patterns.map((p) => (
          <tr key={p.id} className={`hover:bg-gray-50 ${!p.is_active ? "opacity-50" : ""}`}>
            <td className="px-3 py-1.5 font-medium text-gray-800 whitespace-nowrap">{clientName(p.client_id)}</td>
            <td className="px-3 py-1.5 text-gray-700">{DOW_LABELS[p.day_of_week]}</td>
            <td className="px-3 py-1.5 font-mono text-gray-600">{hhmm(p.start_time)}{p.end_time ? `-${hhmm(p.end_time)}` : ""}</td>
            <td className="px-3 py-1.5 text-gray-600">{teamName(p.team_id)}</td>
            <td className="px-3 py-1.5 text-gray-600">
              {p.scheme === "地域生活支援" && <span className="mr-1 rounded bg-violet-50 px-1 py-0.5 text-[10px] text-violet-600">障害</span>}
              {p.bath_type === "部分浴" ? "部分浴・清拭" : p.bath_type}
            </td>
            <td className="px-3 py-1.5">
              <button
                onClick={() => onToggleActive(p)}
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${p.is_active ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}
              >
                {p.is_active ? "有効" : "無効"}
              </button>
            </td>
            <td className="px-3 py-1.5 text-right whitespace-nowrap">
              <button onClick={() => onEdit(p)} className="mr-1 p-1 text-gray-400 hover:text-cyan-600"><Pencil size={14} /></button>
              <button onClick={() => onDelete(p)} className="p-1 text-gray-400 hover:text-red-500"><Trash2 size={14} /></button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── 号車マスタ ───────────────────────────────────────────────────────────────

function TeamsView({ teams, onEdit }: { teams: Team[]; onEdit: (t: Team) => void }) {
  if (teams.length === 0) {
    return <p className="py-16 text-center text-sm text-gray-400">号車が未登録です。「号車追加」から入浴車 (チーム) を登録してください。</p>;
  }
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 z-10 bg-gray-100 text-gray-600">
        <tr>
          <th className="px-3 py-2 text-left font-semibold">号車名</th>
          <th className="px-3 py-2 text-left font-semibold">車両メモ</th>
          <th className="px-3 py-2 text-left font-semibold">表示順</th>
          <th className="px-3 py-2 text-left font-semibold">状態</th>
          <th className="px-3 py-2 text-right font-semibold"></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {teams.map((t) => (
          <tr key={t.id} className={`hover:bg-gray-50 ${!t.is_active ? "opacity-50" : ""}`}>
            <td className="px-3 py-1.5 font-medium text-gray-800"><Truck size={12} className="mr-1.5 inline text-cyan-600" />{t.name}</td>
            <td className="px-3 py-1.5 text-gray-500">{t.vehicle_note || "—"}</td>
            <td className="px-3 py-1.5 text-gray-500">{t.sort_order}</td>
            <td className="px-3 py-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${t.is_active ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
                {t.is_active ? "稼働中" : "休止"}
              </span>
            </td>
            <td className="px-3 py-1.5 text-right">
              <button onClick={() => onEdit(t)} className="p-1 text-gray-400 hover:text-cyan-600"><Pencil size={14} /></button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── サイドリスト (カレンダー/月間個別の左ペイン共通) ─────────────────────────

function SideList({
  items, selectedId, onSelect, unitLabel,
}: {
  items: Array<{ id: string; label: string; sub?: string | null }>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  unitLabel: string;
}) {
  const [q, setQ] = useState("");
  const filtered = q ? items.filter((i) => i.label.includes(q) || (i.sub ?? "").includes(q)) : items;
  return (
    <>
      <div className="p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="検索"
          className="w-full rounded-lg border border-gray-200 px-2 py-1 text-xs outline-none focus:border-cyan-400"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.map((i) => (
          <button
            key={i.id}
            onClick={() => onSelect(i.id)}
            className={`block w-full border-b border-gray-50 px-3 py-1.5 text-left text-xs ${
              selectedId === i.id ? "bg-cyan-50 font-semibold text-cyan-700" : "text-gray-700 hover:bg-gray-50"
            }`}
          >
            <span className="block truncate">{i.label}</span>
            {i.sub && <span className="block truncate text-[10px] font-normal text-gray-400">{i.sub}</span>}
          </button>
        ))}
        {filtered.length === 0 && <p className="p-3 text-center text-[11px] text-gray-300">該当なし</p>}
      </div>
      <div className="border-t border-gray-100 px-3 py-1.5 text-[10px] text-gray-400">{items.length}{unitLabel}</div>
    </>
  );
}

// ── カレンダー (利用者軸/職員軸 の月間グリッド) ──────────────────────────────

function BathCalendarView({
  month, axis, setAxis, clients, selectedClientId, onSelectClient,
  rideStaff, selectedStaffId, onSelectStaff,
  schedules, teamDays, teams, nurseIds,
  onAddVisit, onEditVisit, onOpenDay,
}: {
  month: string;
  axis: "user" | "staff";
  setAxis: (a: "user" | "staff") => void;
  clients: Client[];
  selectedClientId: string | null;
  onSelectClient: (id: string) => void;
  rideStaff: StaffMember[];
  selectedStaffId: string | null;
  onSelectStaff: (id: string) => void;
  schedules: ScheduleRow[];
  teamDays: TeamDay[];
  teams: Team[];
  nurseIds: Set<string>;
  onAddVisit: (dateStr: string, clientId: string | null) => void;
  onEditVisit: (v: ScheduleRow) => void;
  onOpenDay: (dateStr: string) => void;
}) {
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? "未割当";
  const clientNameOf = (id: string) => clients.find((c) => c.id === id)?.name ?? "(不明)";
  const days = daysInMonth(month);
  const firstDow = dowOf(`${month}-01`);
  const cells: (string | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: days }, (_, i) => `${month}-${pad2(i + 1)}`),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const chipCls = (s: ScheduleRow["status"]) =>
    s === "completed" ? "bg-emerald-50 text-emerald-700" :
    s === "cancelled" ? "bg-gray-100 text-gray-400 line-through" : "bg-cyan-50 text-cyan-700";

  const axisBtn = (a: "user" | "staff", label: string) => (
    <button
      onClick={() => setAxis(a)}
      className={`flex-1 border-b-2 py-1.5 text-xs font-medium ${axis === a ? "border-cyan-600 text-cyan-700" : "border-transparent text-gray-400 hover:text-gray-600"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full">
      {/* 左ペイン */}
      <div className="flex w-56 shrink-0 flex-col border-r border-gray-200">
        <div className="flex border-b border-gray-100">
          {axisBtn("user", "利用者")}
          {axisBtn("staff", "職員")}
        </div>
        {axis === "user" ? (
          <SideList
            items={clients.map((c) => ({ id: c.id, label: c.name, sub: c.furigana }))}
            selectedId={selectedClientId}
            onSelect={onSelectClient}
            unitLabel="名"
          />
        ) : (
          <SideList
            items={rideStaff.map((s) => ({ id: s.id, label: `${nurseIds.has(s.id) ? "看 " : ""}${s.name}`, sub: s.role }))}
            selectedId={selectedStaffId}
            onSelect={onSelectStaff}
            unitLabel="名 (当月乗車)"
          />
        )}
      </div>

      {/* 月間グリッド */}
      <div className="flex-1 overflow-auto p-3">
        {(axis === "user" ? !selectedClientId : !selectedStaffId) ? (
          <p className="py-16 text-center text-sm text-gray-400">{axis === "user" ? "利用者" : "職員"}を選択してください</p>
        ) : (
          <table className="w-full table-fixed border-collapse">
            <thead>
              <tr>
                {DOW_LABELS.map((l, i) => (
                  <th key={l} className={`border border-gray-200 bg-gray-50 py-1 text-xs font-semibold ${i === 0 ? "text-red-500" : i === 6 ? "text-blue-500" : "text-gray-600"}`}>
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week, wi) => (
                <tr key={wi}>
                  {week.map((d, di) => (
                    <td key={di} className="h-24 border border-gray-200 align-top">
                      {d && (
                        <>
                          <div className="flex items-center justify-between px-1 pt-0.5">
                            <button
                              onClick={() => onOpenDay(d)}
                              title="日次ルート表へ"
                              className={`text-xs font-medium hover:underline ${di === 0 ? "text-red-500" : di === 6 ? "text-blue-500" : "text-gray-700"}`}
                            >
                              {Number(d.slice(8))}
                            </button>
                            {axis === "user" && (
                              <button onClick={() => onAddVisit(d, selectedClientId)} className="text-gray-300 hover:text-cyan-600">
                                <Plus size={12} />
                              </button>
                            )}
                          </div>
                          <div className="space-y-0.5 px-0.5 pb-0.5">
                            {axis === "user"
                              ? schedules
                                  .filter((s) => s.client_id === selectedClientId && s.visit_date === d)
                                  .sort(sortVisits)
                                  .map((v) => (
                                    <button
                                      key={v.id}
                                      onClick={() => onEditVisit(v)}
                                      className={`block w-full truncate rounded px-1 py-0.5 text-left text-[10px] ${chipCls(v.status)}`}
                                      title={`${hhmm(v.start_time)}-${hhmm(v.end_time)} ${teamName(v.team_id)} ${v.bath_type}`}
                                    >
                                      {hhmm(v.start_time) || "--:--"} {teamName(v.team_id)} {v.bath_type === "部分浴" ? "部分" : "全身"}
                                    </button>
                                  ))
                              : (() => {
                                  if (!selectedStaffId) return null;
                                  const tds = teamDays.filter((td) => td.work_date === d && td.staff_ids.includes(selectedStaffId));
                                  // 乗車時間帯指定がある日は号車名+時間帯の小見出し
                                  const labels = tds
                                    .filter((td) => limitedRange(td.staff_times, selectedStaffId))
                                    .map((td) => (
                                      <div key={`${td.id}-h`} className="px-1 text-[9px] font-semibold text-gray-400">
                                        {teamName(td.team_id)} {hhmm(td.staff_times?.[selectedStaffId]?.start ?? null)}-{hhmm(td.staff_times?.[selectedStaffId]?.end ?? null)}
                                      </div>
                                    ));
                                  // その職員が従事するコマ: 号車乗車分 (時間帯カバー + 指名で外れたコマは除く) + 指名分
                                  const seen = new Map<string, ScheduleRow>();
                                  for (const td of tds) {
                                    const r = limitedRange(td.staff_times, selectedStaffId);
                                    for (const s of schedules) {
                                      if (s.visit_date !== d || s.team_id !== td.team_id) continue;
                                      if (Array.isArray(s.staff_ids) && s.staff_ids.length > 0 && !s.staff_ids.includes(selectedStaffId)) continue;
                                      if (r) {
                                        const s0 = timeToMin(s.start_time);
                                        if (s0 !== null) {
                                          const e0Raw = timeToMin(s.end_time);
                                          const e0 = e0Raw !== null && e0Raw > s0 ? e0Raw : s0 + 50;
                                          if (!(r.s < e0 && r.e > s0)) continue;
                                        }
                                      }
                                      seen.set(s.id, s);
                                    }
                                  }
                                  for (const s of schedules) {
                                    if (s.visit_date === d && Array.isArray(s.staff_ids) && s.staff_ids.includes(selectedStaffId)) seen.set(s.id, s);
                                  }
                                  const visits = Array.from(seen.values()).sort(sortVisits);
                                  return [
                                    ...labels,
                                    ...visits.map((v) => (
                                      <button
                                        key={v.id}
                                        onClick={() => onEditVisit(v)}
                                        className={`block w-full truncate rounded px-1 py-0.5 text-left text-[10px] ${chipCls(v.status)}`}
                                        title={`${teamName(v.team_id)} ${hhmm(v.start_time)}-${hhmm(v.end_time)} ${clientNameOf(v.client_id)} ${v.bath_type}${Array.isArray(v.staff_ids) && v.staff_ids.length > 0 ? " (指名)" : ""}`}
                                      >
                                        {hhmm(v.start_time) || "--:--"} {clientNameOf(v.client_id)} {v.bath_type === "部分浴" ? "部分" : "全身"}
                                      </button>
                                    )),
                                  ];
                                })()}
                          </div>
                        </>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {axis === "staff" && (
          <p className="mt-2 text-[11px] text-gray-400">チップ = その職員が乗るコマ (乗車時間帯指定がある日は号車名と時間を表示)。チップで編集、日付クリックで日次ルート表へ。</p>
        )}
      </div>
    </div>
  );
}

// ── 月間個別 (利用者ごとの月間一覧 + 実績反映) ──────────────────────────────

function BathMonthlyView({
  clients, selectedClientId, onSelectClient, schedules, teams, busy,
  onAdd, onEdit, onCommit, onCancel, onDelete,
}: {
  clients: Client[];
  selectedClientId: string | null;
  onSelectClient: (id: string) => void;
  schedules: ScheduleRow[];
  teams: Team[];
  busy: boolean;
  onAdd: (clientId: string | null) => void;
  onEdit: (v: ScheduleRow) => void;
  onCommit: (changes: Array<{ v: ScheduleRow; toCompleted: boolean }>) => Promise<boolean>;
  onCancel: (v: ScheduleRow) => void;
  onDelete: (v: ScheduleRow) => void;
}) {
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? "未割当";
  // レバーの未保存変更 (visit id → 希望 status が completed か)。保存ボタンで一括コミット
  const [pending, setPending] = useState<Map<string, boolean>>(new Map());
  const rows = schedules
    .filter((s) => s.client_id === selectedClientId)
    .sort((a, b) => a.visit_date.localeCompare(b.visit_date) || sortVisits(a, b));
  const counts = {
    scheduled: rows.filter((r) => r.status === "scheduled").length,
    completed: rows.filter((r) => r.status === "completed").length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
  };

  const toggleLever = (v: ScheduleRow) => {
    if (v.status === "cancelled" || busy) return;
    setPending((prev) => {
      const next = new Map(prev);
      const current = next.get(v.id) ?? v.status === "completed";
      const desired = !current;
      if (desired === (v.status === "completed")) next.delete(v.id);
      else next.set(v.id, desired);
      return next;
    });
  };

  const handleSelectClient = (id: string) => {
    if (pending.size > 0 && !window.confirm("未保存の実績反映があります。破棄して利用者を切り替えますか？")) return;
    setPending(new Map());
    onSelectClient(id);
  };

  const handleSave = async () => {
    const changes = Array.from(pending.entries())
      .map(([id, toCompleted]) => ({ v: rows.find((r) => r.id === id), toCompleted }))
      .filter((c): c is { v: ScheduleRow; toCompleted: boolean } => !!c.v);
    const ok = await onCommit(changes);
    if (ok) setPending(new Map());
  };

  return (
    <div className="flex h-full">
      <div className="flex w-56 shrink-0 flex-col border-r border-gray-200">
        <div className="border-b border-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-600">利用者</div>
        <SideList
          items={clients.map((c) => ({ id: c.id, label: c.name, sub: c.furigana }))}
          selectedId={selectedClientId}
          onSelect={handleSelectClient}
          unitLabel="名"
        />
      </div>
      <div className="flex-1 overflow-auto">
        {!selectedClientId ? (
          <p className="py-16 text-center text-sm text-gray-400">利用者を選択してください</p>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-gray-100 bg-gray-50/60 px-4 py-2 text-xs text-gray-600">
              <span>予定 <b className="text-cyan-700">{counts.scheduled}</b>件</span>
              <span>実績 <b className="text-emerald-700">{counts.completed}</b>件</span>
              <span>中止 <b className="text-gray-500">{counts.cancelled}</b>件</span>
              {pending.size > 0 && (
                <span className="flex items-center gap-2 rounded-lg bg-amber-50 px-2 py-1 font-medium text-amber-700 ring-1 ring-amber-200">
                  {pending.size}件の未保存の実績反映
                  <button
                    onClick={handleSave}
                    disabled={busy}
                    className="flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}保存
                  </button>
                  <button
                    onClick={() => setPending(new Map())}
                    disabled={busy}
                    className="text-[11px] text-amber-600 underline hover:text-amber-800"
                  >
                    破棄
                  </button>
                </span>
              )}
              <button
                onClick={() => onAdd(selectedClientId)}
                className="ml-auto flex items-center gap-1 rounded-lg bg-cyan-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-cyan-700"
              >
                <Plus size={12} />予定追加
              </button>
            </div>
            {rows.length === 0 ? (
              <p className="py-16 text-center text-sm text-gray-400">この月の予定はありません</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-gray-100 text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">日付</th>
                    <th className="px-3 py-2 text-left font-semibold">時間</th>
                    <th className="px-3 py-2 text-left font-semibold">号車</th>
                    <th className="px-3 py-2 text-left font-semibold">種別</th>
                    <th className="px-3 py-2 text-left font-semibold">状態</th>
                    <th className="px-3 py-2 text-left font-semibold">メモ</th>
                    <th className="px-3 py-2 text-right font-semibold"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((v) => {
                    const isPending = pending.has(v.id);
                    const leverOn = pending.get(v.id) ?? v.status === "completed";
                    return (
                    <tr key={v.id} className={`hover:bg-gray-50 ${v.status === "cancelled" ? "opacity-60" : ""} ${isPending ? "bg-amber-50/60" : ""}`}>
                      <td className="whitespace-nowrap px-3 py-1.5 font-medium text-gray-800">
                        {Number(v.visit_date.slice(5, 7))}/{Number(v.visit_date.slice(8))} ({DOW_LABELS[dowOf(v.visit_date)]})
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-gray-600">
                        {hhmm(v.start_time)}{v.end_time ? `-${hhmm(v.end_time)}` : ""}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-gray-600">{teamName(v.team_id)}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-gray-600">
                        {v.scheme === "地域生活支援" && <span className="mr-1 rounded bg-violet-50 px-1 py-0.5 text-[10px] text-violet-600">障害</span>}
                        {v.bath_type === "部分浴" ? "部分浴・清拭" : v.bath_type}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        {v.status === "cancelled" ? (
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold bg-gray-100 text-gray-500">中止</span>
                        ) : (
                          <button
                            onClick={() => toggleLever(v)}
                            disabled={busy}
                            title={(leverOn ? "実績 → 予定に戻す" : "予定 → 実績に変更") + (isPending ? " (未保存 — 保存ボタンで確定)" : "")}
                          >
                            <span className={`relative inline-block h-[18px] w-10 shrink-0 rounded-full align-middle transition-colors ${
                              leverOn ? "bg-emerald-500" : "bg-gray-300"
                            } ${isPending ? "ring-2 ring-amber-400 ring-offset-1" : ""} ${busy ? "opacity-50" : ""}`}>
                              <span className={`absolute top-1/2 -translate-y-1/2 text-[10px] font-bold leading-none ${
                                leverOn ? "left-1.5 text-white" : "right-1.5 text-gray-600"
                              }`}>
                                {leverOn ? "実" : "予"}
                              </span>
                              <span className={`absolute top-0.5 h-[14px] w-[14px] rounded-full bg-white shadow transition-all ${
                                leverOn ? "left-[calc(100%_-_16px)]" : "left-0.5"
                              }`} />
                            </span>
                          </button>
                        )}
                      </td>
                      <td className="max-w-[160px] truncate px-3 py-1.5 text-gray-400" title={v.notes ?? undefined}>
                        {v.status === "cancelled" && v.cancel_reason ? `中止: ${v.cancel_reason}` : v.notes || ""}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right">
                        <button onClick={() => onEdit(v)} className="p-1 text-gray-400 hover:text-cyan-600"><Pencil size={13} /></button>
                        {v.status !== "completed" && (
                          <button onClick={() => onCancel(v)} title={v.status === "cancelled" ? "中止を解除" : "中止"} className="p-1 text-gray-400 hover:text-amber-600">
                            {v.status === "cancelled" ? <RotateCcw size={13} /> : <Ban size={13} />}
                          </button>
                        )}
                        <button onClick={() => onDelete(v)} className="p-1 text-gray-400 hover:text-red-500"><Trash2 size={13} /></button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── モーダル共通スタイル ─────────────────────────────────────────────────────

const inputCls = "w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm outline-none focus:border-cyan-400";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

function ModalShell({ title, onClose, children, footer }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3 shrink-0">
          <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3 shrink-0">{footer}</div>
      </div>
    </div>
  );
}

// ── 予定コマ モーダル ────────────────────────────────────────────────────────

function VisitModal({
  supabase, visit, presetTeamId, presetClientId, date, clients, teams, staffList, nurseIds, officeId, tenantId, nextOrderOf, onClose, onSaved,
}: {
  supabase: ReturnType<typeof createClient>;
  visit: ScheduleRow | null;
  presetTeamId: string | null;
  presetClientId: string | null;
  date: string;
  clients: Client[];
  teams: Team[];
  staffList: StaffMember[];
  nurseIds: Set<string>;
  officeId: string;
  tenantId: string;
  nextOrderOf: (teamId: string | null, dateStr: string) => number;
  onClose: () => void;
  onSaved: (row: ScheduleRow, isNew: boolean) => void;
}) {
  const [f, setF] = useState(() => ({
    client_id: visit?.client_id ?? presetClientId ?? "",
    team_id: visit?.team_id ?? presetTeamId,
    visit_date: visit?.visit_date ?? date,
    start_time: visit?.start_time ? hhmm(visit.start_time) : "",
    end_time: visit?.end_time ? hhmm(visit.end_time) : "",
    bath_type: visit?.bath_type ?? ("全身浴" as const),
    scheme: visit?.scheme ?? ("介護保険" as const),
    staff_ids: (visit?.staff_ids ?? []) as string[],
    notes: visit?.notes ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const toggleStaff = (id: string) =>
    setF((p) => ({ ...p, staff_ids: p.staff_ids.includes(id) ? p.staff_ids.filter((x) => x !== id) : [...p.staff_ids, id] }));

  const handleSave = async () => {
    if (!f.client_id) { setError("利用者を選択してください"); return; }
    if (!f.visit_date) { setError("日付を入力してください"); return; }
    setSaving(true);
    setError("");
    const base: Record<string, unknown> = {
      client_id: f.client_id,
      team_id: f.team_id || null,
      visit_date: f.visit_date,
      start_time: f.start_time || null,
      end_time: f.end_time || null,
      bath_type: f.bath_type,
      scheme: f.scheme,
      staff_ids: f.staff_ids,
      notes: f.notes || null,
    };
    const save = (b: Record<string, unknown>) =>
      visit
        ? supabase.from("kaigo_bath_schedule").update(b).eq("id", visit.id).select("*").single()
        : supabase
            .from("kaigo_bath_schedule")
            .insert({ ...b, tenant_id: tenantId, office_id: officeId, visit_order: nextOrderOf(f.team_id ?? null, f.visit_date) })
            .select("*")
            .single();
    let res = await save(base);
    if (res.error && (res.error.code === "PGRST204" || res.error.code === "42703")) {
      // staff_ids 列未適用 → 指名なしで保存 (bath_shift_v2_staff_times.sql の適用を案内)
      if (f.staff_ids.length > 0) {
        alert("スタッフ指名の保存には bath_shift_v2_staff_times.sql の適用が必要です。今回は指名なしで保存します。");
      }
      const { staff_ids: _si, ...withoutStaff } = base;
      void _si;
      res = await save(withoutStaff);
    }
    setSaving(false);
    if (res.error || !res.data) { setError("保存に失敗しました: " + (res.error?.message ?? "不明なエラー")); return; }
    onSaved(res.data as ScheduleRow, !visit);
  };

  return (
    <ModalShell
      title={visit ? "予定の編集" : "予定の追加"}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
            {saving && <Loader2 size={14} className="animate-spin" />}保存
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>利用者 *</label>
          <select value={f.client_id} onChange={(e) => set("client_id", e.target.value)} className={inputCls}>
            <option value="">選択してください</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>号車</label>
          <select value={f.team_id ?? ""} onChange={(e) => set("team_id", e.target.value || null)} className={inputCls}>
            <option value="">未割当</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>日付 *</label>
          <input type="date" value={f.visit_date} onChange={(e) => set("visit_date", e.target.value)} className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>開始</label>
            <input type="time" value={f.start_time} onChange={(e) => set("start_time", e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>終了</label>
            <input type="time" value={f.end_time} onChange={(e) => set("end_time", e.target.value)} className={inputCls} />
          </div>
        </div>
      </div>
      <div className="rounded-xl bg-cyan-50 p-3">
        <div className="mb-2 flex items-center gap-3">
          <span className="text-xs font-medium text-gray-600">制度</span>
          {(["介護保険", "地域生活支援"] as const).map((sc) => (
            <label key={sc} className="flex items-center gap-1 text-sm">
              <input type="radio" checked={f.scheme === sc} onChange={() => set("scheme", sc)} className="accent-cyan-600" />
              {sc === "地域生活支援" ? "地域生活支援給付 (障害)" : "介護保険"}
            </label>
          ))}
        </div>
        {f.scheme === "介護保険" && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-600">入浴種別</span>
            {(["全身浴", "部分浴"] as const).map((bt) => (
              <label key={bt} className="flex items-center gap-1 text-sm">
                <input type="radio" checked={f.bath_type === bt} onChange={() => set("bath_type", bt)} className="accent-cyan-600" />
                {bt === "部分浴" ? "部分浴・清拭" : bt}
              </label>
            ))}
          </div>
        )}
        <p className="mt-1.5 text-[11px] text-gray-500">職員のみ (看護職員なし) 減算は実績反映時に従事職員から自動判定されます。</p>
      </div>
      {/* スタッフ指名 (未選択 = 号車の当日編成から自動) */}
      <div>
        <label className={labelCls}>
          スタッフ指名 — {f.staff_ids.length === 0 ? "未選択 (号車の当日編成から自動)" : `${f.staff_ids.length}名 (この予定だけ指名メンバーで実績反映)`}
        </label>
        <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-gray-200 p-2">
          {staffList.length === 0 ? <span className="text-xs text-gray-400">職員データがありません</span> : staffList.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => toggleStaff(s.id)}
              className={`rounded-full px-2.5 py-1 text-xs ${
                f.staff_ids.includes(s.id)
                  ? nurseIds.has(s.id) ? "bg-rose-500 text-white" : "bg-cyan-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {nurseIds.has(s.id) && "看 "}{s.name}
            </button>
          ))}
        </div>
        {f.staff_ids.length > 0 && !f.staff_ids.some((id) => nurseIds.has(id)) && (
          <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-amber-600">
            <AlertTriangle size={11} />看護職員が含まれていません。この予定は「職員のみ (減算)」で算定されます。
          </p>
        )}
      </div>
      <div>
        <label className={labelCls}>メモ</label>
        <textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} rows={2} className={`${inputCls} resize-none`} />
      </div>
      {error && <p className="rounded-lg bg-red-50 p-2.5 text-sm text-red-500">{error}</p>}
    </ModalShell>
  );
}

// ── パターン モーダル ────────────────────────────────────────────────────────

function PatternModal({
  supabase, pattern, clients, teams, officeId, tenantId, onClose, onSaved,
}: {
  supabase: ReturnType<typeof createClient>;
  pattern: Pattern | null;
  clients: Client[];
  teams: Team[];
  officeId: string;
  tenantId: string;
  onClose: () => void;
  onSaved: (row: Pattern, isNew: boolean) => void;
}) {
  const [f, setF] = useState(() => ({
    client_id: pattern?.client_id ?? "",
    day_of_week: pattern?.day_of_week ?? 1,
    start_time: pattern?.start_time ? hhmm(pattern.start_time) : "",
    end_time: pattern?.end_time ? hhmm(pattern.end_time) : "",
    team_id: pattern?.team_id ?? null,
    bath_type: pattern?.bath_type ?? ("全身浴" as const),
    scheme: pattern?.scheme ?? ("介護保険" as const),
    notes: pattern?.notes ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  const handleSave = async () => {
    if (!f.client_id) { setError("利用者を選択してください"); return; }
    setSaving(true);
    setError("");
    const base = {
      client_id: f.client_id,
      day_of_week: f.day_of_week,
      start_time: f.start_time || null,
      end_time: f.end_time || null,
      team_id: f.team_id || null,
      bath_type: f.bath_type,
      scheme: f.scheme,
      notes: f.notes || null,
    };
    const res = pattern
      ? await supabase.from("kaigo_bath_patterns").update(base).eq("id", pattern.id).select("*").single()
      : await supabase.from("kaigo_bath_patterns").insert({ ...base, tenant_id: tenantId, office_id: officeId, is_active: true }).select("*").single();
    setSaving(false);
    if (res.error || !res.data) { setError("保存に失敗しました: " + (res.error?.message ?? "不明なエラー")); return; }
    onSaved(res.data as Pattern, !pattern);
  };

  return (
    <ModalShell
      title={pattern ? "週間パターンの編集" : "週間パターンの追加"}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
            {saving && <Loader2 size={14} className="animate-spin" />}保存
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>利用者 *</label>
          <select value={f.client_id} onChange={(e) => set("client_id", e.target.value)} className={inputCls}>
            <option value="">選択してください</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>曜日 *</label>
          <select value={f.day_of_week} onChange={(e) => set("day_of_week", Number(e.target.value))} className={inputCls}>
            {DOW_LABELS.map((l, i) => <option key={i} value={i}>{l}曜日</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>開始</label>
            <input type="time" value={f.start_time} onChange={(e) => set("start_time", e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>終了</label>
            <input type="time" value={f.end_time} onChange={(e) => set("end_time", e.target.value)} className={inputCls} />
          </div>
        </div>
        <div>
          <label className={labelCls}>号車</label>
          <select value={f.team_id ?? ""} onChange={(e) => set("team_id", e.target.value || null)} className={inputCls}>
            <option value="">未割当</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      </div>
      <div className="rounded-xl bg-cyan-50 p-3">
        <div className="mb-2 flex items-center gap-3">
          <span className="text-xs font-medium text-gray-600">制度</span>
          {(["介護保険", "地域生活支援"] as const).map((sc) => (
            <label key={sc} className="flex items-center gap-1 text-sm">
              <input type="radio" checked={f.scheme === sc} onChange={() => set("scheme", sc)} className="accent-cyan-600" />
              {sc === "地域生活支援" ? "地域生活支援給付 (障害)" : "介護保険"}
            </label>
          ))}
        </div>
        {f.scheme === "介護保険" && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-600">入浴種別</span>
            {(["全身浴", "部分浴"] as const).map((bt) => (
              <label key={bt} className="flex items-center gap-1 text-sm">
                <input type="radio" checked={f.bath_type === bt} onChange={() => set("bath_type", bt)} className="accent-cyan-600" />
                {bt === "部分浴" ? "部分浴・清拭" : bt}
              </label>
            ))}
          </div>
        )}
      </div>
      <div>
        <label className={labelCls}>メモ</label>
        <textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} rows={2} className={`${inputCls} resize-none`} />
      </div>
      {error && <p className="rounded-lg bg-red-50 p-2.5 text-sm text-red-500">{error}</p>}
    </ModalShell>
  );
}

// ── 号車 モーダル ────────────────────────────────────────────────────────────

function TeamModal({
  supabase, team, officeId, tenantId, onClose, onSaved,
}: {
  supabase: ReturnType<typeof createClient>;
  team: Team | null;
  officeId: string;
  tenantId: string;
  onClose: () => void;
  onSaved: (row: Team, isNew: boolean) => void;
}) {
  const [f, setF] = useState(() => ({
    name: team?.name ?? "",
    vehicle_note: team?.vehicle_note ?? "",
    sort_order: team?.sort_order ?? 0,
    is_active: team?.is_active ?? true,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!f.name.trim()) { setError("号車名を入力してください"); return; }
    setSaving(true);
    setError("");
    const base = { name: f.name.trim(), vehicle_note: f.vehicle_note || null, sort_order: f.sort_order, is_active: f.is_active };
    const res = team
      ? await supabase.from("kaigo_bath_teams").update(base).eq("id", team.id).select("*").single()
      : await supabase.from("kaigo_bath_teams").insert({ ...base, tenant_id: tenantId, office_id: officeId }).select("*").single();
    setSaving(false);
    if (res.error || !res.data) { setError("保存に失敗しました: " + (res.error?.message ?? "不明なエラー")); return; }
    onSaved(res.data as Team, !team);
  };

  return (
    <ModalShell
      title={team ? "号車の編集" : "号車の追加"}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
            {saving && <Loader2 size={14} className="animate-spin" />}保存
          </button>
        </>
      }
    >
      <div>
        <label className={labelCls}>号車名 * (例: 1号車)</label>
        <input value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>車両メモ (ナンバー・ボイラー等)</label>
        <input value={f.vehicle_note} onChange={(e) => setF((p) => ({ ...p, vehicle_note: e.target.value }))} className={inputCls} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>表示順</label>
          <input type="number" value={f.sort_order} onChange={(e) => setF((p) => ({ ...p, sort_order: Number(e.target.value) || 0 }))} className={inputCls} />
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={f.is_active} onChange={(e) => setF((p) => ({ ...p, is_active: e.target.checked }))} className="accent-cyan-600" />
          稼働中
        </label>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-2.5 text-sm text-red-500">{error}</p>}
    </ModalShell>
  );
}

// ── 当日編成 モーダル ────────────────────────────────────────────────────────
// 兼務対応: 職員ごとに乗車時間帯 (終日 or 時間指定) を持ち、
// 当日の訪問介護予定 (kaigo_visit_schedule) を並記して重複を警告する。

function TeamDayModal({
  supabase, team, date, initial, teamVisits, staffList, onClose, onSave,
}: {
  supabase: ReturnType<typeof createClient>;
  team: Team;
  date: string;
  initial: TeamDay | null;
  teamVisits: ScheduleRow[];
  staffList: StaffMember[];
  onClose: () => void;
  onSave: (staffIds: string[], staffTimes: StaffTimes, notes: string) => void;
}) {
  const [staffIds, setStaffIds] = useState<string[]>(initial?.staff_ids ?? []);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [staffTimes, setStaffTimes] = useState<Record<string, { start: string; end: string }>>(() => {
    const out: Record<string, { start: string; end: string }> = {};
    for (const [k, v] of Object.entries(initial?.staff_times ?? {})) {
      if (v?.start && v?.end) out[k] = { start: v.start.slice(0, 5), end: v.end.slice(0, 5) };
    }
    return out;
  });
  // 当日の訪問介護予定 (全事業所分)。null = fetch 中
  const [kaigoRows, setKaigoRows] = useState<SuggestScheduleRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchDaySchedules(supabase, date);
      if (cancelled) return;
      if (res.error) console.error("訪問介護予定の取得に失敗:", res.error);
      setKaigoRows(res.rows);
    })();
    return () => { cancelled = true; };
  }, [supabase, date]);

  const toggle = (id: string) =>
    setStaffIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const hasNurse = staffIds.some((id) => { const s = staffList.find((x) => x.id === id); return s ? isNurse(s) : false; });

  // この号車の当日ルート帯 (最初のコマ開始〜最後のコマ終了)。終日職員の重複判定に使う
  const routeSpan = useMemo(() => {
    let s: number | null = null;
    let e: number | null = null;
    for (const v of teamVisits) {
      if (v.status === "cancelled") continue;
      const vs = timeToMin(v.start_time);
      if (vs === null) continue;
      const veRaw = timeToMin(v.end_time);
      const ve = veRaw !== null && veRaw > vs ? veRaw : vs + 50;
      s = s === null ? vs : Math.min(s, vs);
      e = e === null ? ve : Math.max(e, ve);
    }
    return s !== null && e !== null ? { s, e } : null;
  }, [teamVisits]);

  // 職員ごとの当日の訪問介護予定 (staff_id / staff_id_2 / staff_id_3)
  const kaigoBusyOf = useCallback((id: string): Array<{ s: number; e: number; label: string }> => {
    if (!kaigoRows) return [];
    const out: Array<{ s: number; e: number; label: string }> = [];
    for (const r of kaigoRows) {
      if (r.status === "cancelled") continue;
      if (r.staff_id !== id && r.staff_id_2 !== id && r.staff_id_3 !== id) continue;
      const s = timeToMin(r.start_time);
      if (s === null) continue;
      const eRaw = timeToMin(r.end_time);
      const e = eRaw !== null && eRaw > s ? eRaw : s + 60;
      out.push({ s, e, label: `${hhmm(r.start_time)}-${hhmm(r.end_time) || "?"}` });
    }
    return out.sort((a, b) => a.s - b.s);
  }, [kaigoRows]);

  const setTime = (id: string, k: "start" | "end", v: string) =>
    setStaffTimes((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { start: "09:00", end: "17:00" }), [k]: v } }));
  const toggleAllDay = (id: string, allDay: boolean) =>
    setStaffTimes((prev) => {
      const next = { ...prev };
      if (allDay) delete next[id];
      else next[id] = next[id] ?? { start: "09:00", end: "13:00" };
      return next;
    });

  const handleSave = () => {
    const times: StaffTimes = {};
    for (const id of staffIds) {
      const t = staffTimes[id];
      if (t?.start && t?.end) times[id] = { start: t.start, end: t.end };
    }
    onSave(staffIds, times, notes);
  };

  return (
    <ModalShell
      title={`${team.name} ${date} の編成`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          <button onClick={handleSave} className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700">保存</button>
        </>
      }
    >
      <div>
        <label className={labelCls}>当日メンバー (看護職員 1 名 + 介護職員 2 名が基本) — {staffIds.length}名選択中</label>
        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-gray-200 p-2">
          {staffList.length === 0 ? <span className="text-xs text-gray-400">職員データがありません</span> : staffList.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => toggle(s.id)}
              className={`rounded-full px-2.5 py-1 text-xs ${
                staffIds.includes(s.id)
                  ? isNurse(s) ? "bg-rose-500 text-white" : "bg-cyan-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {isNurse(s) && "看 "}{s.name}
            </button>
          ))}
        </div>
        {staffIds.length > 0 && !hasNurse && (
          <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-amber-600">
            <AlertTriangle size={11} />看護職員が含まれていません。この日の実績は「職員のみ (減算)」で算定されます。
          </p>
        )}
        {staffIds.length > 0 && staffIds.length !== 3 && (
          <p className="mt-1 text-[11px] text-amber-600">⚠ 標準は 3 名編成です (現在 {staffIds.length} 名)</p>
        )}
      </div>

      {/* 乗車時間帯 + 訪問介護との重複 (兼務対応) */}
      {staffIds.length > 0 && (
        <div>
          <label className={labelCls}>乗車時間帯 (訪問介護と日内兼務する職員は時間指定に)</label>
          <div className="space-y-1.5">
            {staffIds.map((id) => {
              const s = staffList.find((x) => x.id === id);
              if (!s) return null;
              const lim = staffTimes[id];
              const busy = kaigoBusyOf(id);
              const win = lim
                ? { s: timeToMin(lim.start) ?? 0, e: timeToMin(lim.end) ?? 0 }
                : routeSpan;
              const conflict = !!win && busy.some((b) => b.s < win.e && b.e > win.s);
              return (
                <div key={id} className={`rounded-lg border px-2.5 py-1.5 ${conflict ? "border-amber-300 bg-amber-50" : "border-gray-100"}`}>
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`font-medium ${isNurse(s) ? "text-rose-600" : "text-gray-700"}`}>{isNurse(s) && "看 "}{s.name}</span>
                    <label className="ml-auto flex items-center gap-1 text-[11px] text-gray-500">
                      <input type="checkbox" checked={!lim} onChange={(e) => toggleAllDay(id, e.target.checked)} className="accent-cyan-600" />
                      終日
                    </label>
                    {lim && (
                      <span className="flex items-center gap-1">
                        <input type="time" value={lim.start} onChange={(e) => setTime(id, "start", e.target.value)} className="rounded border border-gray-200 px-1 py-0.5 text-[11px]" />
                        <span className="text-gray-400">〜</span>
                        <input type="time" value={lim.end} onChange={(e) => setTime(id, "end", e.target.value)} className="rounded border border-gray-200 px-1 py-0.5 text-[11px]" />
                      </span>
                    )}
                  </div>
                  {kaigoRows === null ? null : busy.length > 0 && (
                    <p className={`mt-1 text-[10px] ${conflict ? "font-medium text-amber-700" : "text-gray-400"}`}>
                      訪問介護の予定: {busy.map((b) => b.label).join(" / ")}
                      {conflict && " ⚠ 乗車時間と重複しています"}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-1 text-[10px] text-gray-400">
            時間指定した職員は、その範囲外のコマの従事職員に含まれません (看護職員が抜ける時間帯は自動で減算判定)。
          </p>
        </div>
      )}

      <div>
        <label className={labelCls}>メモ</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${inputCls} resize-none`} />
      </div>
    </ModalShell>
  );
}
