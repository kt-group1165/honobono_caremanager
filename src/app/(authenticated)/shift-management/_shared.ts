// shift-management 共通の types / constants / helpers
// page.tsx (server) と各 client component から import する。

import type { SupabaseClient } from "@supabase/supabase-js";

export interface KaigoUser {
  id: string;
  name: string;
  name_kana: string;
  status: string;
}

export interface KaigoStaff {
  id: string;
  name: string;
  name_kana: string;
  status: string;
}

export interface VisitSchedule {
  id: string;
  user_id: string;
  staff_id: string | null;
  /** 職員2 (2人対応・同行)。migration visit_schedule_staff_2_3.sql */
  staff_id_2?: string | null;
  /** 職員3 (2人対応・同行) */
  staff_id_3?: string | null;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  service_type: string;
  status?: string; // scheduled=予定, completed=実績, cancelled, changed
  /** 緊急時訪問介護加算フラグ。migration kaigo_visit_schedule_kinkyu_office.sql 未適用環境では undefined */
  kinkyu_houmon?: boolean | null;
  /** 発生元事業所。同 migration 未適用環境では undefined */
  office_id?: string | null;
  /** 職員2 の個別時間 (NULL = 本体と同じ)。同 migration 未適用環境では undefined */
  staff2_start_time?: string | null;
  staff2_end_time?: string | null;
  /** 職員3 の個別時間 (NULL = 本体と同じ) */
  staff3_start_time?: string | null;
  staff3_end_time?: string | null;
  staff_name?: string | null;
  user_name?: string | null;
  _isCopy?: boolean; // ローカル複写行（未保存）
}

export interface StaffAvailabilitySlot {
  staff_id: string;
  available_date: string;
  start_time: string;
  end_time: string;
  is_available: boolean;
}

export interface VisitPattern {
  id: string;
  user_id: string;
  pattern_name: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  service_type: string;
  staff_id: string | null;
  staff_name?: string | null;
  user_name?: string | null;
}

export interface StaffToken {
  id: string;
  staff_id: string;
  token: string;
  staff_name?: string;
}

export type SidebarTab = "user" | "staff";
export type ViewMode = "calendar" | "timeline" | "monthly-individual";

export const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

export const SERVICE_TYPE_COLORS: Record<string, string> = {
  身体介護: "bg-blue-100 text-blue-700",
  生活援助: "bg-green-100 text-green-700",
  "身体・生活": "bg-purple-100 text-purple-700",
  通院等乗降介助: "bg-orange-100 text-orange-700",
};

// ─── 2人体制 (「◯◯・２人」コード) の整合チェック ─────────────────────────────
// kaigo_service_codes には「身体介護３・２人」等の全角「２人」variant がある。
// staff_id_2 の割当とサービス名の「２人」有無が食い違ったら警告する (ブロックはしない)。

export function isTwoPersonService(serviceName: string | null | undefined): boolean {
  if (!serviceName) return false;
  // マスタは全角「２人」だが、半角混在データも念のため許容
  return serviceName.includes("２人") || serviceName.includes("2人");
}

/** 不整合なら警告文を返す (整合なら null) */
export function twoPersonMismatchWarning(
  serviceName: string | null | undefined,
  staffId2: string | null | undefined,
): string | null {
  const twoPersonCode = isTwoPersonService(serviceName);
  const hasSecond = !!staffId2;
  if (hasSecond && !twoPersonCode) {
    return "2人体制ですが1人用のサービスコードです。「◯◯・２人」コードの選択を推奨します";
  }
  if (!hasSecond && twoPersonCode) {
    return "2人用コードですが職員が1人です";
  }
  return null;
}

/**
 * 職員1 の時間 [s1,e1] と 職員2 の個別時間 [s2,e2] の関係で警告を返す (介護保険のみ)。
 * 保存はブロックしない (呼出側で toast / モーダル内注意表示)。
 *   - 離れている  → 別々の訪問として分けるべき
 *   - 連続 (隣接) → 交代なら 1 人用コードの可能性 (「２人」コードのときのみ)
 *   - 一部重なり  → 算定可否は保険者確認
 *   - 完全一致    → 「２人」コードでなければ 2 人コード推奨
 * 障害福祉 (isShogai=true) は各従業者を別々に算定する制度のため警告なし。
 * 時刻は "HH:MM" (または "HH:MM:SS")。不正・逆転時間は判定しない (null)。
 */
export function staffTimeRelationWarning(
  mainStart: string | null | undefined,
  mainEnd: string | null | undefined,
  subStart: string | null | undefined,
  subEnd: string | null | undefined,
  serviceName: string | null | undefined,
  isShogai: boolean,
): string | null {
  if (isShogai) return null;
  if (!mainStart || !mainEnd || !subStart || !subEnd) return null;
  const s1 = timeToMinutes(mainStart.slice(0, 5));
  const e1 = timeToMinutes(mainEnd.slice(0, 5));
  const s2 = timeToMinutes(subStart.slice(0, 5));
  const e2 = timeToMinutes(subEnd.slice(0, 5));
  if ([s1, e1, s2, e2].some((n) => !Number.isFinite(n)) || e1 <= s1 || e2 <= s2) return null;
  const twoPersonCode = isTwoPersonService(serviceName);
  // 完全に重なる
  if (s1 === s2 && e1 === e2) {
    return twoPersonCode
      ? null
      : "2人が同時提供の場合は「◯◯・２人」コードの選択を推奨します";
  }
  // 離れている (間に空きがある)
  if (e1 < s2 || e2 < s1) {
    return "職員1と職員2の時間が離れています。別々の訪問として予定を分けて作成してください";
  }
  // 連続 (隣接、重なりゼロ)
  if (e1 === s2 || e2 === s1) {
    return twoPersonCode
      ? "交代 (連続) の場合は1人用のサービスコードの可能性があります (連続した1件の身体介護は所定時間×1人単価)"
      : null;
  }
  // 一部重なり (完全一致でない)
  return "職員1と職員2の時間が一部重なっています。2人体制の算定可否は保険者にご確認ください";
}

// ─── kinkyu_houmon / office_id 列の適用状況 (migration 未適用環境の許容) ──────
// migrations/kaigo_visit_schedule_kinkyu_office.sql 未適用の DB では
// SELECT で 42703、INSERT/UPDATE で PGRST204 が返る。
// - チェックボックス表示は supportsKinkyuHoumon() で probe (session 内 1 回)
// - INSERT は insertVisitSchedules() が欠損列を strip して自動 retry

const __columnProbes = new Map<string, Promise<boolean> | null>();

/** kaigo_visit_schedule の指定列が存在するか (module cache 付き probe) */
function supportsScheduleColumn(supabase: SupabaseClient, column: string): Promise<boolean> {
  let cached = __columnProbes.get(column);
  if (!cached) {
    cached = (async () => {
      const { error } = await supabase
        .from("kaigo_visit_schedule")
        .select(column)
        .limit(1);
      if (!error) return true;
      if (error.code === "42703" || error.code === "PGRST204" || error.code === "PGRST200") {
        return false;
      }
      // 列以外のエラー (ネットワーク等) は判定保留 → 次回再 probe
      __columnProbes.set(column, null);
      return false;
    })();
    __columnProbes.set(column, cached);
  }
  return cached;
}

/** kaigo_visit_schedule.kinkyu_houmon 列が存在するか */
export function supportsKinkyuHoumon(supabase: SupabaseClient): Promise<boolean> {
  return supportsScheduleColumn(supabase, "kinkyu_houmon");
}

/** kaigo_visit_schedule.staff2_start_time 等 (2人体制の個別時間) が存在するか */
export function supportsStaff2Times(supabase: SupabaseClient): Promise<boolean> {
  return supportsScheduleColumn(supabase, "staff2_start_time");
}

/** PostgREST の「列が存在しない」エラーから列名を抽出 (42703 / PGRST204) */
function extractMissingScheduleColumn(message: string): string | null {
  const m =
    message.match(/Could not find the '([^']+)' column/) ??
    message.match(/column\s+(?:[\w"]+\.)?"?(\w+)"?\s+does not exist/);
  return m ? m[1] : null;
}

/**
 * kaigo_visit_schedule への INSERT (単数/複数行)。
 * kinkyu_houmon / office_id 等が migration 未適用 (42703 / PGRST204) の場合、
 * 当該列を全行から strip して自動 retry する (最大 3 列まで)。
 * error は握りつぶさず返す (呼出側で toast 必須)。
 */
export async function insertVisitSchedules(
  supabase: SupabaseClient,
  rows: Record<string, unknown>[],
  select?: string,
): Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null; strippedColumns: string[] }> {
  let payload = rows;
  const stripped: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const base = supabase.from("kaigo_visit_schedule").insert(payload);
    const { data, error } = select ? await base.select(select) : await base;
    if (!error) {
      return { data: (data ?? null) as Record<string, unknown>[] | null, error: null, strippedColumns: stripped };
    }
    const missing =
      error.code === "PGRST204" || error.code === "42703"
        ? extractMissingScheduleColumn(error.message)
        : null;
    if (missing && payload.some((r) => missing in r)) {
      stripped.push(missing);
      payload = payload.map((r) => {
        const next = { ...r };
        delete next[missing];
        return next;
      });
      continue;
    }
    return { data: null, error, strippedColumns: stripped };
  }
  return { data: null, error: { message: "列除去 retry 上限に達しました" }, strippedColumns: stripped };
}

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function isStaffUnavailableAtTime(
  staffId: string,
  dateStr: string,
  startTime: string | null,
  endTime: string | null,
  availability: StaffAvailabilitySlot[]
): boolean {
  if (!startTime) return false;
  const staffSlots = availability.filter((a) => a.staff_id === staffId);
  if (staffSlots.length === 0) return false; // No monthly data at all
  const slots = staffSlots.filter((a) => a.available_date === dateStr);
  if (slots.length === 0) return true; // Has monthly data but no record for this day = unavailable
  const sMin = timeToMinutes(startTime);
  const eMin = endTime ? timeToMinutes(endTime) : sMin + 60;
  // Check if any slot is unavailable that overlaps with schedule time
  for (const slot of slots) {
    if (!slot.is_available) {
      const slotStart = timeToMinutes(slot.start_time);
      const slotEnd = timeToMinutes(slot.end_time);
      if (sMin < slotEnd && eMin > slotStart) return true;
    }
  }
  // If staff has availability records for this date but no slot covers the schedule time, treat as unavailable
  const availableSlots = slots.filter((s) => s.is_available);
  if (slots.length > 0 && availableSlots.length > 0) {
    const covered = availableSlots.some((slot) => {
      const slotStart = timeToMinutes(slot.start_time);
      const slotEnd = timeToMinutes(slot.end_time);
      return slotStart <= sMin && eMin <= slotEnd;
    });
    return !covered;
  }
  return false;
}
