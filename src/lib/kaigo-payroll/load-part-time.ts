"use client";

/**
 * パート給与 (時給×実働) のデータ取得。集計の金額計算は純関数 calcPartTimePayroll に委譲。
 *
 * 実績源 = kaigo_visit_schedule status='completed' (請求集計と同じ)。office_id で自事業所に
 * 絞り、staff_id / staff_id_2 / staff_id_3 (2〜3人体制) それぞれの実働時間を、その職員が
 * パート (members.employment_type='パート') の場合のみ計上する。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ID_IN_CHUNK } from "@/lib/chunk-parallel";
import {
  calcPartTimePayroll,
  minutesBetween,
  type PartTimeVisit,
  type PartTimePayrollResult,
  type WageCategory,
} from "./part-time";

export type PartCategory = "社保" | "通常" | "扶養";

/** 扶養パートの年収上限 既定値 (円/年)。members.fuyou_annual_limit で人別上書き可 */
export const DEFAULT_FUYOU_ANNUAL_LIMIT = 1_300_000;

/** 扶養パート 1 名の年収着地予測 (この事業所の時給支給分のみの参考値) */
export interface FuyouProjection {
  staffId: string;
  staffName: string;
  /** 1月〜選択月の時給支給累計 (手当除く) */
  ytdPay: number;
  /** 年収上限 (人別上書き or 既定 130 万) */
  limit: number;
  /** 単純按分の年間着地予測 = ytd / 経過月 × 12 */
  projection: number;
  monthsElapsed: number;
}

export interface LoadPartTimeResult {
  result: PartTimePayrollResult;
  categories: WageCategory[];
  /** 実績に出現した service_type の生値 (設定画面の割当候補) */
  serviceTypesInData: string[];
  /** 設定テーブル未作成 (migration 未適用) */
  settingsMissing: boolean;
  /** 対象パート職員数 */
  partStaffCount: number;
  /** パート区分 (members.part_category)。列未適用なら undefined (= 区分 UI 非表示) */
  partCategoryByStaff?: Map<string, PartCategory | null>;
  /** 扶養パートの年収着地予測 (区分=扶養 の職員のみ) */
  fuyou?: FuyouProjection[];
  /** kaigo_payroll_staff_settings (社保加入) が読めた = 区分との不一致警告が可能 */
  socialInsuranceEnabled: boolean;
}

interface ScheduleRow {
  visit_date: string;
  service_type: string | null;
  staff_id: string | null;
  staff_id_2: string | null;
  staff_id_3: string | null;
  start_time: string | null;
  end_time: string | null;
  staff2_start_time: string | null;
  staff2_end_time: string | null;
  staff3_start_time: string | null;
  staff3_end_time: string | null;
}

const isMissing = (code?: string) =>
  code === "42P01" || code === "PGRST205" || code === "42703";

export async function loadPartTimePayroll(
  supabase: SupabaseClient,
  opts: { officeId: string; year: number; month: number },
): Promise<LoadPartTimeResult> {
  const { officeId, year, month } = opts;
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const end = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

  // 1) 当月の確定実績 (自事業所)
  //
  // ⚠ PostgREST は 1000 行がハードキャップ (.limit(10000) を付けても 1000 行しか
  //   返らない)。2026-08-31 監査の実測で、2026-06 は 19 事業所中 18 が 1000 行超
  //   (おゆみ野 4,659 / 茂原 3,375 / いすみ 2,865 …) = 合計 18,221 行が
  //   給与計算から黙って落ちていた。必ず range でページングする。
  //   (下の「扶養累計」ブロックは元から正しくページングしていた)
  const PAGE = 1000;
  const schedules: ScheduleRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: se } = await supabase
      .from("kaigo_visit_schedule")
      .select(
        "visit_date, service_type, staff_id, staff_id_2, staff_id_3, start_time, end_time, staff2_start_time, staff2_end_time, staff3_start_time, staff3_end_time",
      )
      .eq("office_id", officeId)
      .eq("status", "completed")
      .gte("visit_date", start)
      .lt("visit_date", end)
      .order("visit_date")
      .range(from, from + PAGE - 1);
    if (se) throw new Error("実績の取得に失敗: " + se.message);
    const rows = (page ?? []) as ScheduleRow[];
    schedules.push(...rows);
    if (rows.length < PAGE) break;
  }

  // 1b) 当月のキャンセル (キャンセル手当用)。担当職員ごとに件数を数える
  //     こちらも 1000 行 cap の対象 (キャンセルが多い月に件数が頭打ちになる)
  type CancelRow = {
    staff_id: string | null;
    staff_id_2: string | null;
    staff_id_3: string | null;
  };
  const cancelled: CancelRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: ce } = await supabase
      .from("kaigo_visit_schedule")
      .select("id, staff_id, staff_id_2, staff_id_3")
      .eq("office_id", officeId)
      .eq("status", "cancelled")
      .gte("visit_date", start)
      .lt("visit_date", end)
      .order("id")
      .range(from, from + PAGE - 1);
    if (ce) throw new Error("キャンセル実績の取得に失敗: " + ce.message);
    const rows = (page ?? []) as CancelRow[];
    cancelled.push(...rows);
    if (rows.length < PAGE) break;
  }

  // 2) 関与職員 (実績 + キャンセル) → members でパート判定
  const staffIds = new Set<string>();
  for (const r of schedules) {
    if (r.staff_id) staffIds.add(r.staff_id);
    if (r.staff_id_2) staffIds.add(r.staff_id_2);
    if (r.staff_id_3) staffIds.add(r.staff_id_3);
  }
  for (const r of cancelled) {
    if (r.staff_id) staffIds.add(r.staff_id);
    if (r.staff_id_2) staffIds.add(r.staff_id_2);
    if (r.staff_id_3) staffIds.add(r.staff_id_3);
  }
  const memberById = new Map<
    string,
    { name: string; furigana: string | null; employment_type: string | null }
  >();
  if (staffIds.size > 0) {
    const ids = [...staffIds];
    for (let i = 0; i < ids.length; i += ID_IN_CHUNK) {
      const chunk = ids.slice(i, i + ID_IN_CHUNK);
      const { data, error } = await supabase
        .from("members")
        .select("id, name, furigana, employment_type")
        .in("id", chunk);
      if (error) throw new Error("職員情報の取得に失敗: " + error.message);
      for (const m of (data ?? []) as {
        id: string;
        name: string;
        furigana: string | null;
        employment_type: string | null;
      }[]) {
        memberById.set(m.id, {
          name: m.name,
          furigana: m.furigana,
          employment_type: m.employment_type,
        });
      }
    }
  }
  const isPart = (id: string | null): boolean =>
    !!id && memberById.get(id)?.employment_type === "パート";

  // 3) パート職員ぶんの訪問を PartTimeVisit[] に展開 (主 + 2人目 + 3人目)
  const visits: PartTimeVisit[] = [];
  const partSet = new Set<string>();
  const pushVisit = (
    staffId: string | null,
    st: string | null,
    et: string | null,
    r: ScheduleRow,
  ) => {
    if (!isPart(staffId) || !staffId) return;
    partSet.add(staffId);
    const m = memberById.get(staffId)!;
    visits.push({
      staffId,
      staffName: m.name,
      staffNameKana: m.furigana ?? undefined,
      serviceType: r.service_type ?? "(未設定)",
      minutes: minutesBetween(st, et),
      date: r.visit_date,
    });
  };
  for (const r of schedules) {
    pushVisit(r.staff_id, r.start_time, r.end_time, r);
    pushVisit(
      r.staff_id_2,
      r.staff2_start_time ?? r.start_time,
      r.staff2_end_time ?? r.end_time,
      r,
    );
    pushVisit(
      r.staff_id_3,
      r.staff3_start_time ?? r.start_time,
      r.staff3_end_time ?? r.end_time,
      r,
    );
  }

  // 4) 類型・マッピング (未適用でも空で続行)
  let settingsMissing = false;
  const { data: catData, error: ce } = await supabase
    .from("kaigo_wage_categories")
    .select("id, name, hourly_rate, sort_order, is_active")
    .eq("office_id", officeId)
    .eq("is_active", true);
  if (ce && isMissing(ce.code)) settingsMissing = true;
  else if (ce) throw new Error("サービス類型の取得に失敗: " + ce.message);
  const categories: WageCategory[] = ((catData ?? []) as {
    id: string;
    name: string;
    hourly_rate: number;
  }[]).map((c) => ({ id: c.id, name: c.name, hourlyRate: c.hourly_rate }));

  const mappings: { serviceType: string; categoryId: string | null }[] = [];
  if (!settingsMissing) {
    const { data: mapData, error: me } = await supabase
      .from("kaigo_service_wage_mappings")
      .select("service_type, category_id")
      .eq("office_id", officeId);
    if (me && isMissing(me.code)) settingsMissing = true;
    else if (me) throw new Error("サービス割当の取得に失敗: " + me.message);
    for (const m of (mapData ?? []) as {
      service_type: string;
      category_id: string | null;
    }[]) {
      mappings.push({ serviceType: m.service_type, categoryId: m.category_id });
    }
  }

  // 5) キャンセル件数 (パート職員のみ、主+2/3人目)
  const cancelCountByStaff = new Map<string, number>();
  const staffRoster = new Map<string, { name: string; kana?: string }>();
  const addCancel = (id: string | null) => {
    if (!isPart(id) || !id) return;
    cancelCountByStaff.set(id, (cancelCountByStaff.get(id) ?? 0) + 1);
    const m = memberById.get(id)!;
    if (!staffRoster.has(id))
      staffRoster.set(id, { name: m.name, kana: m.furigana ?? undefined });
  };
  for (const r of cancelled) {
    addCancel(r.staff_id);
    addCancel(r.staff_id_2);
    addCancel(r.staff_id_3);
  }

  // 6) 事業所のキャンセル単価 + 職員の社会保険 (v2 未適用でも第1弾どおり動く)
  let cancelUnitPrice = 0;
  const { data: os } = await supabase
    .from("kaigo_payroll_office_settings")
    .select("cancel_unit_price")
    .eq("office_id", officeId)
    .maybeSingle();
  if (os) cancelUnitPrice = (os as { cancel_unit_price: number }).cancel_unit_price ?? 0;

  let socialInsuranceByStaff: Map<string, boolean> | undefined;
  const partIds = [...new Set([...partSet, ...cancelCountByStaff.keys()])];
  if (partIds.length > 0) {
    const { data: ss, error: sse } = await supabase
      .from("kaigo_payroll_staff_settings")
      .select("member_id, social_insurance")
      .in("member_id", partIds);
    if (!sse || !isMissing(sse.code)) {
      // テーブルが在る (未適用でなければ) → 通信手当を有効化 (行が無い職員は既定=未加入)
      socialInsuranceByStaff = new Map();
      for (const s of (ss ?? []) as {
        member_id: string;
        social_insurance: boolean;
      }[]) {
        socialInsuranceByStaff.set(s.member_id, s.social_insurance);
      }
    }
  }

  // 7) パート区分 (members.part_category)。列未適用 (42703) なら区分機能ごと OFF
  let partCategoryByStaff: Map<string, PartCategory | null> | undefined;
  const fuyouLimitByStaff = new Map<string, number | null>();
  if (partIds.length > 0) {
    const { data: pc, error: pce } = await supabase
      .from("members")
      .select("id, part_category, fuyou_annual_limit")
      .in("id", partIds);
    if (pce && isMissing(pce.code)) {
      partCategoryByStaff = undefined;
    } else if (pce) {
      throw new Error("パート区分の取得に失敗: " + pce.message);
    } else {
      partCategoryByStaff = new Map();
      for (const m of (pc ?? []) as {
        id: string;
        part_category: PartCategory | null;
        fuyou_annual_limit: number | null;
      }[]) {
        partCategoryByStaff.set(m.id, m.part_category);
        fuyouLimitByStaff.set(m.id, m.fuyou_annual_limit);
      }
    }
  }

  // 8) 扶養パートの年収着地予測 — 1月〜選択月の確定実績を同じ計算式で累計。
  //    自事業所の時給支給分のみ (兼務先・手当は含まない) の参考値。
  let fuyou: FuyouProjection[] | undefined;
  const fuyouIds = partCategoryByStaff
    ? [...partCategoryByStaff.entries()]
        .filter(([, c]) => c === "扶養")
        .map(([id]) => id)
    : [];
  if (fuyouIds.length > 0) {
    const fuyouSet = new Set(fuyouIds);
    const ytdStart = `${year}-01-01`;
    // PostgREST は 1000 行 cap なので range でページング
    const ytdRows: ScheduleRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data: page, error: pe } = await supabase
        .from("kaigo_visit_schedule")
        .select(
          "visit_date, service_type, staff_id, staff_id_2, staff_id_3, start_time, end_time, staff2_start_time, staff2_end_time, staff3_start_time, staff3_end_time",
        )
        .eq("office_id", officeId)
        .eq("status", "completed")
        .gte("visit_date", ytdStart)
        .lt("visit_date", end)
        .order("visit_date")
        .range(from, from + PAGE - 1);
      if (pe) throw new Error("扶養累計の実績取得に失敗: " + pe.message);
      const rows = (page ?? []) as ScheduleRow[];
      ytdRows.push(...rows);
      if (rows.length < PAGE) break;
    }
    const ytdVisits: PartTimeVisit[] = [];
    const pushYtd = (
      staffId: string | null,
      st: string | null,
      et: string | null,
      r: ScheduleRow,
    ) => {
      if (!staffId || !fuyouSet.has(staffId)) return;
      ytdVisits.push({
        staffId,
        serviceType: r.service_type ?? "(未設定)",
        minutes: minutesBetween(st, et),
        date: r.visit_date,
      });
    };
    for (const r of ytdRows) {
      pushYtd(r.staff_id, r.start_time, r.end_time, r);
      pushYtd(r.staff_id_2, r.staff2_start_time ?? r.start_time, r.staff2_end_time ?? r.end_time, r);
      pushYtd(r.staff_id_3, r.staff3_start_time ?? r.start_time, r.staff3_end_time ?? r.end_time, r);
    }
    const ytdResult = calcPartTimePayroll(ytdVisits, mappings, categories);
    const ytdPayByStaff = new Map(
      ytdResult.byStaff.map((s) => [s.staffId, s.totalPay]),
    );
    fuyou = fuyouIds.map((id) => {
      const ytdPay = ytdPayByStaff.get(id) ?? 0;
      const limit = fuyouLimitByStaff.get(id) ?? DEFAULT_FUYOU_ANNUAL_LIMIT;
      return {
        staffId: id,
        staffName: memberById.get(id)?.name ?? "",
        ytdPay,
        limit,
        projection: Math.round((ytdPay / month) * 12),
        monthsElapsed: month,
      };
    });
    fuyou.sort((a, b) => b.projection / b.limit - a.projection / a.limit);
  }

  const serviceTypesInData = [
    ...new Set(schedules.map((r) => r.service_type ?? "(未設定)")),
  ].sort((a, b) => a.localeCompare(b, "ja"));

  return {
    result: calcPartTimePayroll(visits, mappings, categories, {
      cancelCountByStaff,
      cancelUnitPrice,
      socialInsuranceByStaff,
      staffRoster,
    }),
    categories,
    serviceTypesInData,
    settingsMissing,
    partStaffCount: partSet.size,
    partCategoryByStaff,
    fuyou,
    socialInsuranceEnabled: socialInsuranceByStaff !== undefined,
  };
}
