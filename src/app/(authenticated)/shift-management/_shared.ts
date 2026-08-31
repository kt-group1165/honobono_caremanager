// shift-management 共通の types / constants / helpers
// page.tsx (server) と各 client component から import する。

import type { SupabaseClient } from "@supabase/supabase-js";
import { getUnambiguousServiceSystemMap } from "@/lib/service-system-lookup";
import { toHankakuDigits } from "@/lib/service-name-normalize";

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
  /**
   * 追加職員 (主担当 staff_id を除く) の配列。index0=職員2, index1=職員3, index2=職員4…
   * start_time/end_time が null は「本体 (start_time/end_time) と同じ時間」。
   * 先頭2件は従来列 staff_id_2/staff_id_3 + staff2/3_*_time にミラーされる。
   * migration kaigo_visit_schedule_additional_staff.sql 未適用環境では undefined。
   */
  additional_staff?: Array<{ staff_id: string; start_time: string | null; end_time: string | null }> | null;
  /** キャンセル操作日時。migration visit_cancel_fee.sql 未適用環境では undefined */
  cancelled_at?: string | null;
  /** キャンセル理由 (同 migration 未適用環境では undefined) */
  cancel_reason?: string | null;
  /** キャンセル料 (円)。0 = 記録のみ。>0 は riyou_jippi_entries に連動 */
  cancel_fee?: number | null;
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

/** kaigo_visit_schedule.additional_staff (jsonb, 追加職員 最大9名) が存在するか */
export function supportsAdditionalStaff(supabase: SupabaseClient): Promise<boolean> {
  return supportsScheduleColumn(supabase, "additional_staff");
}

/**
 * kaigo_visit_schedule.cancel_fee 等 (キャンセル管理列) が存在するか。
 * migration visit_cancel_fee.sql 未適用環境ではキャンセル UI を出さない
 * (status='cancelled' 自体は 012 由来の CHECK で常時許可されている)。
 */
export function supportsCancelColumns(supabase: SupabaseClient): Promise<boolean> {
  return supportsScheduleColumn(supabase, "cancel_fee");
}

// ─── 追加職員 (additional_staff) の共有ヘルパー ──────────────────────────────

/** 主担当を除く追加職員の 1 要素 (フォーム/DB 共通形) */
export interface AdditionalStaffEntry {
  staff_id: string;
  /** null = 本体 (start_time/end_time) と同じ時間 */
  start_time: string | null;
  end_time: string | null;
}

/**
 * schedule 行から「主 + 追加」の職員を 1 つの配列で返す (read 画面 / 表示用)。
 * additional_staff があればそれを、無ければ従来列 staff_id_2/3 + 個別時間から復元する。
 * 時刻の null は本体時間と同じ扱い (呼出側で本体時刻を補完してよい)。
 */
export function normalizeScheduleStaff(
  sched: Pick<
    VisitSchedule,
    | "staff_id"
    | "start_time"
    | "end_time"
    | "staff_id_2"
    | "staff_id_3"
    | "staff2_start_time"
    | "staff2_end_time"
    | "staff3_start_time"
    | "staff3_end_time"
    | "additional_staff"
  >,
): Array<{ staff_id: string; start_time: string | null; end_time: string | null; role: "主" | "追加" }> {
  const out: Array<{ staff_id: string; start_time: string | null; end_time: string | null; role: "主" | "追加" }> = [];
  if (sched.staff_id) {
    out.push({ staff_id: sched.staff_id, start_time: sched.start_time ?? null, end_time: sched.end_time ?? null, role: "主" });
  }
  // additional_staff (jsonb) を優先。無ければ従来列から復元。
  if (Array.isArray(sched.additional_staff) && sched.additional_staff.length > 0) {
    for (const a of sched.additional_staff) {
      if (a && a.staff_id) {
        out.push({ staff_id: a.staff_id, start_time: a.start_time ?? null, end_time: a.end_time ?? null, role: "追加" });
      }
    }
  } else {
    if (sched.staff_id_2) {
      out.push({ staff_id: sched.staff_id_2, start_time: sched.staff2_start_time ?? null, end_time: sched.staff2_end_time ?? null, role: "追加" });
    }
    if (sched.staff_id_3) {
      out.push({ staff_id: sched.staff_id_3, start_time: sched.staff3_start_time ?? null, end_time: sched.staff3_end_time ?? null, role: "追加" });
    }
  }
  return out;
}

/**
 * 追加職員のフォーム値から INSERT/UPDATE 用の payload 断片を生成する。
 *
 * - additional_staff: 全追加職員 (最大9名) を jsonb で書く (列適用時のみ)。
 * - 後方互換ミラー: 先頭2件を従来列 staff_id_2/staff_id_3 + staff2/3_*_time にも書く。
 *   これにより請求集計・2人加算・警告・各 read 画面 (従来列を読む既存コード) が無変更で動く。
 *
 * time は "HH:MM" (フォーム) を受け取り ":00" を補って "HH:MM:SS" にする。空 ("") は
 * 「本体と同じ = null」とみなす。列未適用 (42703/PGRST204) は insertVisitSchedules /
 * update 側で当該列が strip される想定なので、常に全列を含めて返す。
 *
 * @param entries 追加職員 (index0=職員2, index1=職員3, …)。staff_id が空の行は除外する。
 */
export function buildAdditionalStaffPayload(
  entries: Array<{ staff_id: string; custom: boolean; start: string; end: string }>,
): Record<string, unknown> {
  // 有効な行 (staff_id あり) のみ
  const valid = entries.filter((e) => e.staff_id);
  const toTime = (v: string): string | null => (v ? (v.length === 5 ? v + ":00" : v) : null);
  // additional_staff jsonb: custom ON かつ start/end 両方ありなら個別時間、それ以外は null (本体と同じ)
  const jsonb = valid.map((e) => {
    const useCustom = !!(e.custom && e.start && e.end);
    return {
      staff_id: e.staff_id,
      start_time: useCustom ? toTime(e.start) : null,
      end_time: useCustom ? toTime(e.end) : null,
    };
  });
  const payload: Record<string, unknown> = {
    additional_staff: jsonb.length > 0 ? jsonb : null,
  };
  // 後方互換ミラー: 先頭2件を従来列へ
  const mirrorCols: Array<[string, string, string]> = [
    ["staff_id_2", "staff2_start_time", "staff2_end_time"],
    ["staff_id_3", "staff3_start_time", "staff3_end_time"],
  ];
  for (let i = 0; i < 2; i++) {
    const [idCol, startCol, endCol] = mirrorCols[i];
    const e = jsonb[i];
    payload[idCol] = e ? e.staff_id : null;
    payload[startCol] = e ? e.start_time : null;
    payload[endCol] = e ? e.end_time : null;
  }
  return payload;
}

/** PostgREST の「列が存在しない」エラーから列名を抽出 (42703 / PGRST204) */
function extractMissingScheduleColumn(message: string): string | null {
  const m =
    message.match(/Could not find the '([^']+)' column/) ??
    message.match(/column\s+(?:[\w"]+\.)?"?(\w+)"?\s+does not exist/);
  return m ? m[1] : null;
}

/**
 * 制度区分 (system) が入っていない行に、サービス名から決まる制度を補う。
 *
 * ── なぜ INSERT の中でやるか ────────────────────────────────────────────
 *   呼出側は 7 箇所ある。個別に足すと必ずどこかが漏れるので、**入口 1 箇所**で補う。
 *
 * ── なぜ推測しないか ────────────────────────────────────────────────────
 *   `getUnambiguousServiceSystemMap` は **1 制度にしか無い名前だけ**を返す。
 *   決まらない名前 (マスタに無い / 複数制度にある) は **未設定のまま残す**。
 *   外れた側まで書くと、障害を「介護」と記録して請求漏れになる
 *   (2026-08 に 238 件を是正した前例がある)。
 *
 * ⚠ 呼出側が明示的に system を渡していれば、それを優先してそのまま使う。
 * ⚠ マスタ取得に失敗しても INSERT 自体は止めない (制度は後から backfill できる)。
 *   ただし黙って捨てず console.error に残す。
 */
async function fillMissingSystem(
  supabase: SupabaseClient,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const need = rows.filter(
    (r) => r.system == null && typeof r.service_type === "string" && r.service_type,
  );
  if (need.length === 0) return rows;

  // サービスコードは世代管理なので、対象月に有効な世代で引く。
  // 行が複数月にまたがることがあるので月ごとにまとめる。
  const byMonth = new Map<string, string[]>();
  for (const r of need) {
    const d = typeof r.visit_date === "string" ? r.visit_date : "";
    const key = /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : "";
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key)!.push(r.service_type as string);
  }
  const maps = new Map<string, Map<string, string>>();
  for (const [key, names] of byMonth) {
    try {
      const [y, m] = key ? key.split("-").map(Number) : [];
      maps.set(key, await getUnambiguousServiceSystemMap(
        supabase, names, key ? { year: y, month: m } : undefined));
    } catch (e) {
      // 握りつぶさない。制度が付かないだけで INSERT は続ける。
      console.error("制度区分の取得に失敗 (system は未設定のまま INSERT します):",
        (e as Error).message);
      maps.set(key, new Map());
    }
  }
  return rows.map((r) => {
    if (r.system != null || typeof r.service_type !== "string") return r;
    const d = typeof r.visit_date === "string" ? r.visit_date : "";
    const key = /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : "";
    const sys = maps.get(key)?.get(toHankakuDigits(r.service_type));
    return sys ? { ...r, system: sys } : r;   // 決まらなければ触らない
  });
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
  let payload = await fillMissingSystem(supabase, rows);
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
