"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  FileText,
  Loader2,
  Save,
  Printer,
  ChevronLeft,
  ChevronRight,
  Plus,
  X,
  Edit3,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  Clock as ClockIcon,
  Download,
  Upload,
  Send,
} from "lucide-react";
import { SendDocumentModal } from "@/components/shared/SendDocumentModal";
import {
  format,
  getDaysInMonth,
  addMonths,
  subMonths,
} from "date-fns";
import { ja } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { ServiceSelector } from "@/components/services/service-selector";
import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";
import { getServiceSystemMap, isShogaiService } from "@/lib/service-system-lookup";
import { validInMonth } from "@/lib/service-code-valid";
import { useBusinessType } from "@/lib/business-type-context";
import {
  buildAdditionalStaffPayload,
  insertVisitSchedules,
  supportsAdditionalStaff,
  supportsStaff2Times,
  twoPersonMismatchWarning,
} from "@/app/(authenticated)/shift-management/_shared";
import {
  AdditionalStaffSection,
  type AdditionalStaffRow,
} from "@/app/(authenticated)/shift-management/additional-staff-section";
import { resolveVisitAddonLines } from "@/lib/visit-addons";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KaigoUser {
  id: string;
  name: string;
  name_kana: string | null;
  care_level?: string | null;
  insurer_no?: string | null;
  insured_no?: string | null;
}

export interface KaigoStaff {
  id: string;
  name: string;
}

export interface OfficeInfo {
  provider_number?: string;
  office_name?: string;
}


interface VisitSchedule {
  id: string;
  user_id: string;
  staff_id: string | null;
  visit_date: string;
  start_time: string;
  end_time: string;
  service_type: string;
  status: string;
  staff_name?: string | null;
  // 2人体制 (kaigo_visit_schedule の既存列。未適用 DB では undefined)
  staff_id_2?: string | null;
  staff_id_3?: string | null;
  staff2_start_time?: string | null;
  staff2_end_time?: string | null;
  staff3_start_time?: string | null;
  staff3_end_time?: string | null;
  // 追加職員 (jsonb, 最大9名)。未適用 DB では undefined
  additional_staff?: Array<{ staff_id: string; start_time: string | null; end_time: string | null }> | null;
}

// A "row" in the provision ticket grid = unique combination of service + time.
// ※ 提供表は kaigo_visit_schedule 行を編集する (content.services jsonb ではない)。
//    2人体制は kaigo_visit_schedule の staff_id_2 / staff2_start_time / staff2_end_time
//    列に持つ (列未適用 DB では insertVisitSchedules が strip)。
export interface ServiceRow {
  key: string; // e.g. "身体介護1__09:00__10:00"
  service_type: string;
  start_time: string;
  end_time: string;
  staff_id?: string;
  staff_name?: string;
  // 追加職員 (主担当を除く、最大9名)。index0=職員2, index1=職員3, …
  // start/end は "HH:MM:SS" (個別時間) or null (本体と同じ)
  additional?: Array<{ staff_id: string; start_time: string | null; end_time: string | null }>;
}

// Grid: rowKey -> day -> { planned: bool, actual: bool }
export interface CellData {
  planned: boolean; // has a scheduled record
  actual: boolean;  // has a completed record
  scheduleId?: string;
}
export type GridState = Record<string, Record<number, CellData>>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDayOfWeek(year: number, month: number, day: number): string {
  const d = new Date(year, month - 1, day);
  return ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
}

function isDowColor(year: number, month: number, day: number): string {
  const dow = new Date(year, month - 1, day).getDay();
  if (dow === 0) return "text-red-500";
  if (dow === 6) return "text-blue-500";
  return "text-gray-700";
}

/** 土曜=薄い青、日曜=薄い赤 の背景色 (=カレンダー慣習) */
function isDowBg(year: number, month: number, day: number): string {
  const dow = new Date(year, month - 1, day).getDay();
  if (dow === 0) return "bg-red-50";
  if (dow === 6) return "bg-blue-50";
  return "";
}

function makeRowKey(serviceType: string, startTime: string, endTime: string): string {
  return `${serviceType}__${startTime}__${endTime}`;
}

/** AdditionalStaffRow[] (HH:MM フォーム) → ServiceRow.additional (HH:MM:SS or null) */
function additionalStaffRowsToEntries(
  rows: AdditionalStaffRow[],
): Array<{ staff_id: string; start_time: string | null; end_time: string | null }> {
  const toTime = (v: string): string | null => (v ? (v.length === 5 ? v + ":00" : v) : null);
  return rows
    .filter((r) => r.staff_id)
    .map((r) => {
      const useCustom = !!(r.custom && r.start && r.end);
      return {
        staff_id: r.staff_id,
        start_time: useCustom ? toTime(r.start) : null,
        end_time: useCustom ? toTime(r.end) : null,
      };
    });
}

/** ServiceRow.additional (HH:MM:SS) → AdditionalStaffRow[] (HH:MM フォーム) */
function additionalEntriesToRows(
  entries: Array<{ staff_id: string; start_time: string | null; end_time: string | null }> | undefined,
): AdditionalStaffRow[] {
  return (entries ?? []).map((e) => ({
    staff_id: e.staff_id,
    custom: !!e.start_time,
    start: e.start_time?.slice(0, 5) ?? "",
    end: e.end_time?.slice(0, 5) ?? "",
  }));
}

function toWareki(date: Date): string {
  const y = date.getFullYear();
  if (y >= 2019) return `令和${y - 2018}年${date.getMonth() + 1}月${date.getDate()}日`;
  return format(date, "yyyy年M月d日");
}

// ── 加算マスタ (kaigo_visit_addon_lines 駆動) ────────────────────────────────
// 旧 3固定 (初回/緊急時/生活機能向上) を廃止し、その事業所のサービス種別で使える
// 「加算」を kaigo_service_codes から一覧表示 → 適用チェック + 回数で選択する
// (ほのぼの「加算サービス項目」相当)。真実は kaigo_visit_addon_lines テーブル。
//
// 一覧の絞り込み条件:
//   system='介護' AND service_category='11' (訪問介護)
//   AND calculation_type='加算' AND validInMonth(対象月)
//   AND 名称に「・」を含まない (複合コード=基本×加算の合成は除外、基本の加算のみ)
// これで 初回(114001)/緊急時(114000)/生活機能向上Ⅰ(114003)/Ⅱ(114002)/中山間 等が出る。
//
// ※ 減算 (calculation_type='減算') は今回は一覧に出さない (次段階)。resolveVisitAddonLines
//    は減算コード (負値) も解決できるが、書く側 (この画面) では加算のみ選択可能にする。
const SHOKAI_ADDON_CODE = "114001"; // 訪問介護初回加算 (過去2ヶ月実績なし→候補ヒント)

// 加算コード1件の一覧行 (対象月 validInMonth で解決)
interface AddonCodeOption {
  code: string;
  name: string;
  units: number;
}

/** 加算系 formula コード (処遇改善加算等の monthly_aggregate type) */
export interface FormulaCode {
  service_code: string;
  service_category: string;
  service_name: string;
  units: number;
  calculation_type: "基本" | "加算" | "減算";
  formula: import("@/lib/service-code-calc").ServiceCodeFormula | null;
}

export interface ProvisionTicketsContentProps {
  userId: string;
  initialUser: KaigoUser | null;
  initialStaff: KaigoStaff[];
  initialServiceUnits: Record<string, number>;
  initialOffice: OfficeInfo | null;
  initialServiceRows: ServiceRow[];
  initialGrid: GridState;
  initialFormulaCodes?: FormulaCode[];
  /**
   * server が initial data を preload 済みか。
   * false = client 側の利用者切替で mount された (= initial* は空) ので
   * mount 直後に grid を client fetch する。
   */
  serverPreloaded?: boolean;
}

export function ProvisionTicketsContent({
  userId,
  initialUser,
  initialStaff,
  initialServiceUnits,
  initialOffice,
  initialServiceRows,
  initialGrid,
  initialFormulaCodes = [],
  serverPreloaded = true,
}: ProvisionTicketsContentProps) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOfficeId, currentOffice } = useBusinessType();

  const [selectedMonth, setSelectedMonth] = useState(() => new Date());
  const [userData, setUserData] = useState<KaigoUser | null>(initialUser);

  // ヘッダの保険者番号/被保険者番号/要介護度は clients から取得する。
  // initialUser (SSR) は id/name のみのため、保険情報が未取得なら client-side で補完する。
  // ※ clients の実列名は insurer_number / insured_number / furigana (alias で受ける)
  useEffect(() => {
    if (!userId || userData?.insurer_no) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("id, name, name_kana:furigana, care_level, insurer_no:insurer_number, insured_no:insured_number")
        .eq("id", userId)
        .maybeSingle();
      if (error) {
        console.error("利用者情報取得失敗:", error.message);
        return;
      }
      if (!cancelled && data) setUserData(data as KaigoUser);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, userData, supabase]);
  const [allStaff, setAllStaff] = useState<KaigoStaff[]>(initialStaff);
  const [serviceUnits, setServiceUnits] = useState<Record<string, number>>(initialServiceUnits);
  const [officeInfo] = useState<OfficeInfo | null>(initialOffice);
  // 加算系 formula コード (cat=11 訪問介護 のみ抽出してデフォルト)。
  // 初期値は SSR の validToday (= 今月世代)。月切替時は validInMonth で引き直す
  // (処遇改善加算等は改定で率が変わるため、表示月に追従させる)。
  const [formulaCodes, setFormulaCodes] = useState<FormulaCode[]>(initialFormulaCodes);
  // 自事業所が取得している処遇改善等の加算 (表示月に有効なもの)。
  // 解決順 (請求集計 aggregate.ts と同一):
  //   1. kaigo_office_addon_periods の「対象月が期間内」の formula_code 群 (期中の区分変更に追従)
  //   2. 0件 or テーブル未作成 (42P01/PGRST205) は offices.applied_formula_codes にフォールバック
  // 設定変更は マスタ管理 → 自事業所管理 (/master/office) の「適用加算」セクションで行う (read-only here)。
  const [appliedFormulaCodes, setAppliedFormulaCodes] = useState<Set<string>>(
    () => new Set(currentOffice?.applied_formula_codes ?? []),
  );

  const [serviceRows, setServiceRows] = useState<ServiceRow[]>(initialServiceRows);
  const [grid, setGrid] = useState<GridState>(initialGrid);

  // ── サービス加算 (kaigo_visit_addon_lines が真実、加算行はその投影) ──────────
  // 利用者 × 対象月 × 事業所 × 加算コード の可変明細。提供表に「加算行」として表示し、
  // 単位数計算 (実績/予定) に含める。モーダルのチェックリストから upsert / delete する。
  //
  // addonLines: 現在保存済みの { addon_code -> count }
  const [addonLines, setAddonLines] = useState<Record<string, number>>({});
  // 訪問介護の加算コード一覧 (対象月 validInMonth で解決。calculation_type='加算' のみ)
  const [addonOptions, setAddonOptions] = useState<AddonCodeOption[]>([]);
  // 初回加算候補サジェスト: 過去2ヶ月に completed 実績なし = 新規利用の可能性
  const [shokaiSuggest, setShokaiSuggest] = useState<boolean | null>(null);
  // kaigo_visit_addon_lines テーブル未作成 (42P01/PGRST205)
  const [addonTableMissing, setAddonTableMissing] = useState(false);
  // モーダル内の加算入力 (追加時に upsert する一時状態): { addon_code -> count }
  const [addRowAddons, setAddRowAddons] = useState<Record<string, number>>({});
  // 2人体制の個別時間列 (staff2_start_time 等) が適用済みか
  const [staff2TimesSupported, setStaff2TimesSupported] = useState(false);
  // additional_staff (jsonb, 追加職員 最大9名) 列が適用済みか
  const [additionalStaffSupported, setAdditionalStaffSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void supportsStaff2Times(supabase).then((ok) => {
      if (!cancelled) setStaff2TimesSupported(ok);
    });
    void supportsAdditionalStaff(supabase).then((ok) => {
      if (!cancelled) setAdditionalStaffSupported(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // 改定 (世代) を跨ぐと同名サービスでも単位数が変わるため、月切替時はキャッシュを破棄して引き直す
  const unitsMonthRef = useRef(format(selectedMonth, "yyyy-MM"));
  useEffect(() => {
    const key = format(selectedMonth, "yyyy-MM");
    if (unitsMonthRef.current === key) return;
    unitsMonthRef.current = key;
    setServiceUnits({});
  }, [selectedMonth]);

  // 加算系 formula コードも月切替時に「表示月に有効な世代」で引き直す
  // (SSR 初期値は validToday 固定のため、過去月・未来月では世代がずれる)
  const formulaMonthRef = useRef(format(new Date(), "yyyy-MM"));
  useEffect(() => {
    const key = format(selectedMonth, "yyyy-MM");
    if (formulaMonthRef.current === key) return;
    formulaMonthRef.current = key;
    let cancelled = false;
    (async () => {
      const { data, error } = await validInMonth(
        supabase
          .from("kaigo_service_codes")
          .select("service_code, service_category, service_name, units, calculation_type, formula")
          .eq("system", "介護")
          .not("formula", "is", null),
        selectedMonth.getFullYear(),
        selectedMonth.getMonth() + 1,
      )
        .order("service_category")
        .order("service_code");
      if (cancelled) return;
      if (error) {
        console.error("formula codes fetch failed:", error.message);
        toast.error("加算コードの取得に失敗しました: " + error.message);
        return;
      }
      setFormulaCodes((data ?? []) as FormulaCode[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedMonth, supabase]);

  // ── 訪問介護の「加算」コード一覧を対象月世代で解決 (マスタ駆動チェックリスト) ──
  // 絞り込み: system=介護 / service_category=11 / calculation_type=加算 / validInMonth。
  // 名称に「・」を含む複合コード (基本×加算の合成) は除外し、基本の加算のみを候補にする。
  // ※ 減算 (calculation_type=減算) は今回は一覧に出さない (次段階)。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await validInMonth(
        supabase
          .from("kaigo_service_codes")
          .select("service_code, service_name, units, calculation_type")
          .eq("system", "介護")
          .eq("service_category", "11")
          .eq("calculation_type", "加算"),
        selectedMonth.getFullYear(),
        selectedMonth.getMonth() + 1,
      )
        .order("service_code");
      if (cancelled) return;
      if (error) {
        console.error("addon options fetch failed:", error.message);
        toast.error("加算コードの取得に失敗しました: " + error.message);
        return;
      }
      const seen = new Set<string>();
      const opts: AddonCodeOption[] = [];
      for (const r of (data ?? []) as {
        service_code: string;
        service_name: string;
        units: number;
        calculation_type: string;
      }[]) {
        // 複合コード (「基本・加算」の合成) は除外 = 基本の加算のみ
        if (r.service_name.includes("・")) continue;
        if (seen.has(r.service_code)) continue;
        seen.add(r.service_code);
        opts.push({ code: r.service_code, name: r.service_name, units: r.units });
      }
      setAddonOptions(opts);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, selectedMonth]);

  // serviceRows に serviceUnits 未登録の service_type が現れたら on-demand で単位数を補完
  // (月変更・行追加のたび。「基本」全件 fetch は 1000 行制限で欠けるため .in() で絞る。
  //  マスタは全角数字 (身体介護３) / schedule は半角混在のため variants 検索 + 正規化 lookup)
  useEffect(() => {
    const missing = Array.from(
      new Set(serviceRows.map((r) => r.service_type)),
    ).filter((t) => t && serviceUnits[t] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      // 有効期間: 対象月に有効な世代のみ (改定跨ぎの複数世代ヒット防止)
      const { data, error } = await validInMonth(
        supabase
          .from("kaigo_service_codes")
          .select("service_name, units")
          .in("service_name", serviceNameVariantsAll(missing))
          .eq("calculation_type", "基本"),
        selectedMonth.getFullYear(),
        selectedMonth.getMonth() + 1,
      );
      if (cancelled || error) return;
      const byNorm = new Map<string, number>();
      for (const sc of (data ?? []) as { service_name: string; units: number }[]) {
        const key = toHankakuDigits(sc.service_name);
        if (!byNorm.has(key)) byNorm.set(key, sc.units);
      }
      const found: Record<string, number> = {};
      for (const t of missing) {
        // マスタに無い service_type は 0 を入れて再フェッチループを防ぐ
        found[t] = byNorm.get(toHankakuDigits(t)) ?? 0;
      }
       
      setServiceUnits((prev) => ({ ...prev, ...found }));
    })();
    return () => {
      cancelled = true;
    };
  }, [serviceRows, serviceUnits, supabase, selectedMonth]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  const [scheduleIds, setScheduleIds] = useState<Record<string, string>>({});

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"draft" | "confirmed">("draft");
  const [isDirty, setIsDirty] = useState(false);

  const [showAddRow, setShowAddRow] = useState(false);
  const [showSendModal, setShowSendModal] = useState(false);
  const [addRowForm, setAddRowForm] = useState({
    start_time: "09:00", end_time: "10:00", service_type: "", service_code: "", service_name: "", staff_id: "",
  });
  const [addRowAdditional, setAddRowAdditional] = useState<AdditionalStaffRow[]>([]);
  const [showAddServiceSelector, setShowAddServiceSelector] = useState(false);
  const [editRowKey, setEditRowKey] = useState<string | null>(null);
  const [editRowForm, setEditRowForm] = useState({
    start_time: "", end_time: "", service_name: "", service_code: "", staff_id: "",
  });
  const [editRowAdditional, setEditRowAdditional] = useState<AdditionalStaffRow[]>([]);
  const [showEditServiceSelector, setShowEditServiceSelector] = useState(false);

  const year = selectedMonth.getFullYear();
  const month = selectedMonth.getMonth() + 1;
  const daysCount = getDaysInMonth(selectedMonth);
  const days = useMemo(() => Array.from({ length: daysCount }, (_, i) => i + 1), [daysCount]);
  const monthStr = `${year}-${String(month).padStart(2, "0")}`;

  // ── 処遇改善等の適用加算コードを「表示月に有効な期間設定」で解決 ──
  // aggregate.ts:466-496 と同じロジック。selectedMonth 変更時に再解決する。
  useEffect(() => {
    const fallback = new Set(currentOffice?.applied_formula_codes ?? []);
    let cancelled = false;
    (async () => {
      if (!currentOfficeId) {
        if (!cancelled) setAppliedFormulaCodes(fallback);
        return;
      }
      const { data, error } = await supabase
        .from("kaigo_office_addon_periods")
        .select("formula_code, start_month, end_month")
        .eq("office_id", currentOfficeId);
      if (cancelled) return;
      if (error) {
        // テーブル未作成 (42P01/PGRST205) は握りつぶさずフォールバック。それ以外は log
        if (error.code !== "42P01" && error.code !== "PGRST205") {
          console.error("加算期間取得失敗:", error.message);
        }
        setAppliedFormulaCodes(fallback);
        return;
      }
      const inMonth = ((data ?? []) as {
        formula_code: string;
        start_month: string | null;
        end_month: string | null;
      }[]).filter(
        (r) =>
          (r.start_month == null || r.start_month <= monthStr) &&
          (r.end_month == null || r.end_month >= monthStr),
      );
      setAppliedFormulaCodes(
        inMonth.length > 0 ? new Set(inMonth.map((r) => r.formula_code)) : fallback,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, currentOfficeId, currentOffice, monthStr]);

  // ── kaigo_visit_addon_lines の当月明細 + 初回加算候補サジェスト を読込 ──
  useEffect(() => {
    if (!currentOfficeId) return;
    let cancelled = false;
    (async () => {
      // ① 既存の加算明細行 (addon_code -> count)
      const { data, error } = await supabase
        .from("kaigo_visit_addon_lines")
        .select("addon_code, count")
        .eq("client_id", userId)
        .eq("target_month", monthStr)
        .eq("office_id", currentOfficeId);
      if (cancelled) return;
      if (error) {
        if (error.code === "42P01" || error.code === "PGRST205") {
          setAddonTableMissing(true);
          setAddonLines({});
          return;
        }
        console.error("addon lines fetch failed:", error.message);
        toast.error("加算の取得に失敗しました: " + error.message);
        return;
      }
      setAddonTableMissing(false);
      const next: Record<string, number> = {};
      for (const r of (data ?? []) as { addon_code: string; count: number }[]) {
        next[r.addon_code] = r.count;
      }
      setAddonLines(next);

      // ② 初回加算候補: 過去2ヶ月間に completed 実績が無い利用者をサジェスト
      const [y, m] = monthStr.split("-").map(Number);
      if (y && m) {
        const prevFrom = format(new Date(y, m - 3, 1), "yyyy-MM-dd");
        const prevTo = format(new Date(y, m - 1, 0), "yyyy-MM-dd");
        const { data: past, error: pastErr } = await supabase
          .from("kaigo_visit_schedule")
          .select("id")
          .eq("user_id", userId)
          .eq("status", "completed")
          .gte("visit_date", prevFrom)
          .lte("visit_date", prevTo)
          .limit(1);
        if (!cancelled) {
          if (pastErr) {
            console.error("shokai suggest check failed:", pastErr.message);
            setShokaiSuggest(null);
          } else {
            setShokaiSuggest((past ?? []).length === 0);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, userId, monthStr, currentOfficeId]);

  const fetchGridData = useCallback(async () => {
    setLoading(true);

    const from = `${monthStr}-01`;
    const to = `${monthStr}-${String(daysCount).padStart(2, "0")}`;

    // staff2 列 (staff_id_2/staff2_start_time/staff2_end_time) + additional_staff は
    // 適用済み環境のみ select。未適用 (42703) の場合は無しで再取得する。
    const baseCols =
      "id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, members!kaigo_visit_schedule_staff_id_fkey(name)";
    const staff2Cols = ", staff_id_2, staff_id_3, staff2_start_time, staff2_end_time, staff3_start_time, staff3_end_time";
    const addlCols = ", additional_staff";
    const fullCols =
      baseCols +
      (staff2TimesSupported ? staff2Cols : "") +
      (additionalStaffSupported ? addlCols : "");
    let { data, error } = await supabase
      .from("kaigo_visit_schedule")
      .select(fullCols)
      .eq("user_id", userId)
      .gte("visit_date", from)
      .lte("visit_date", to)
      .order("start_time");
    if (error && (error.code === "42703" || error.code === "PGRST200")) {
      // 列未適用: 基本列のみで再取得
      ({ data, error } = await supabase
        .from("kaigo_visit_schedule")
        .select(baseCols)
        .eq("user_id", userId)
        .gte("visit_date", from)
        .lte("visit_date", to)
        .order("start_time"));
    }

    if (error) {
      toast.error("データの取得に失敗しました");
      setLoading(false);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
    const allSchedules: VisitSchedule[] = (data || []).map((r: any) => ({
      id: r.id,
      user_id: r.user_id,
      staff_id: r.staff_id,
      visit_date: r.visit_date,
      start_time: r.start_time,
      end_time: r.end_time,
      service_type: r.service_type,
      status: r.status,
      staff_name: r.members?.name ?? null,
      staff_id_2: r.staff_id_2 ?? null,
      staff_id_3: r.staff_id_3 ?? null,
      staff2_start_time: r.staff2_start_time ?? null,
      staff2_end_time: r.staff2_end_time ?? null,
      staff3_start_time: r.staff3_start_time ?? null,
      staff3_end_time: r.staff3_end_time ?? null,
      additional_staff: r.additional_staff ?? null,
    }));

    // 障害福祉サービスは介護保険の提供表に載せない (障害側の画面で扱う)
    const systemMap = await getServiceSystemMap(
      supabase,
      allSchedules.map((s) => s.service_type),
      { year, month },
    );
    const schedules = allSchedules.filter(
      (s) => !isShogaiService(systemMap, s.service_type),
    );

    const rowMap = new Map<string, ServiceRow>();
    for (const s of schedules) {
      const key = makeRowKey(s.service_type, s.start_time, s.end_time);
      if (!rowMap.has(key)) {
        // 追加職員: additional_staff (jsonb) 優先、無ければ従来列 staff_id_2/3 から復元
        let additional: Array<{ staff_id: string; start_time: string | null; end_time: string | null }> = [];
        if (Array.isArray(s.additional_staff) && s.additional_staff.length > 0) {
          additional = s.additional_staff.filter((a) => a && a.staff_id);
        } else {
          if (s.staff_id_2) additional.push({ staff_id: s.staff_id_2, start_time: s.staff2_start_time ?? null, end_time: s.staff2_end_time ?? null });
          if (s.staff_id_3) additional.push({ staff_id: s.staff_id_3, start_time: s.staff3_start_time ?? null, end_time: s.staff3_end_time ?? null });
        }
        rowMap.set(key, {
          key,
          service_type: s.service_type,
          start_time: s.start_time,
          end_time: s.end_time,
          staff_id: s.staff_id ?? undefined,
          staff_name: s.staff_name ?? undefined,
          additional,
        });
      }
    }

    const newGrid: GridState = {};
    const newSchedIds: Record<string, string> = {};
    for (const [key] of rowMap) {
      newGrid[key] = {};
    }

    for (const s of schedules) {
      const key = makeRowKey(s.service_type, s.start_time, s.end_time);
      const day = parseInt(s.visit_date.split("-")[2], 10);
      if (!newGrid[key]) newGrid[key] = {};
      if (!newGrid[key][day]) newGrid[key][day] = { planned: false, actual: false };

      if (s.status === "scheduled" || s.status === "changed") {
        newGrid[key][day].planned = true;
      }
      // 実績は「予定どおり実施」として予定にも計上する (ほのぼの 準拠)
      if (s.status === "completed") {
        newGrid[key][day].planned = true;
        newGrid[key][day].actual = true;
      }
      newSchedIds[`${key}__${day}__${s.status}`] = s.id;
    }

    const rows = Array.from(rowMap.values()).sort((a, b) => a.start_time.localeCompare(b.start_time));
    setServiceRows(rows);
    setGrid(newGrid);
    setScheduleIds(newSchedIds);
    setLoading(false);
  }, [userId, monthStr, daysCount, supabase, year, month, staff2TimesSupported, additionalStaffSupported]);

  // initial render は server からの initialServiceRows/initialGrid を使用、月切替時のみ refetch。
  // ただし client-side の利用者切替 (serverPreloaded=false) で mount された場合は
  // initial data が無いので即 fetch する。
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      if (serverPreloaded) return;
    }
    fetchGridData();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- serverPreloaded は mount 時のみ参照
  }, [fetchGridData]);

  // 自事業所 (currentOfficeId) が変わったら staff (members) を再フェッチ
  const fetchStaff = useCallback(async () => {
    if (!currentOfficeId) {
      setAllStaff([]);
      return;
    }
    // Phase 9 close: members.office_id DROP 済 → member_offices junction 経由で絞り込み
    const { data, error } = await supabase
      .from("members")
      .select("id, name, member_offices!inner(office_id)")
      .eq("status", "active")
      .eq("member_offices.office_id", currentOfficeId)
      .order("name");
    if (error) {
      toast.error("職員データの取得に失敗しました");
      return;
    }
    setAllStaff((data ?? []) as KaigoStaff[]);
  }, [supabase, currentOfficeId]);

  const isInitialStaffMount = useRef(true);
  useEffect(() => {
    if (isInitialStaffMount.current) {
      isInitialStaffMount.current = false;
      return;
    }
    if (currentOfficeId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time async fetch (HANDOVER §2)
      fetchStaff();
    }
  }, [currentOfficeId, fetchStaff]);

  // ── Dirty tracking & beforeunload ──────────────────────────────────────────
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // Mark dirty on any grid/row change (wrap setters)
  const markDirty = () => setIsDirty(true);

  // ── Cell toggle handlers ──────────────────────────────────────────────────
  const togglePlanned = (rowKey: string, day: number) => {
    markDirty();
    setGrid((prev) => {
      const cell = prev[rowKey]?.[day] ?? { planned: false, actual: false };
      return {
        ...prev,
        [rowKey]: {
          ...prev[rowKey],
          [day]: { ...cell, planned: !cell.planned },
        },
      };
    });
  };

  const toggleActual = (rowKey: string, day: number) => {
    markDirty();
    setGrid((prev) => {
      const cell = prev[rowKey]?.[day] ?? { planned: false, actual: false };
      return {
        ...prev,
        [rowKey]: {
          ...prev[rowKey],
          [day]: { ...cell, actual: !cell.actual },
        },
      };
    });
  };

  // Bulk: set all days planned/actual for a row
  const setAllPlanned = (rowKey: string) => {
    markDirty();
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        rowData[day] = { ...(rowData[day] ?? { planned: false, actual: false }), planned: true };
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const setWeekdaysPlanned = (rowKey: string) => {
    markDirty();
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        const dow = new Date(year, month - 1, day).getDay();
        if (dow !== 0 && dow !== 6) {
          rowData[day] = { ...(rowData[day] ?? { planned: false, actual: false }), planned: true };
        }
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const clearPlanned = (rowKey: string) => {
    markDirty();
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        if (rowData[day]) rowData[day] = { ...rowData[day], planned: false };
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const setAllActual = (rowKey: string) => {
    markDirty();
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        rowData[day] = { ...(rowData[day] ?? { planned: false, actual: false }), actual: true };
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const setWeekdaysActual = (rowKey: string) => {
    markDirty();
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        const dow = new Date(year, month - 1, day).getDay();
        if (dow !== 0 && dow !== 6) {
          rowData[day] = { ...(rowData[day] ?? { planned: false, actual: false }), actual: true };
        }
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const clearActual = (rowKey: string) => {
    markDirty();
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        if (rowData[day]) rowData[day] = { ...rowData[day], actual: false };
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  // ── サービス加算 upsert (kaigo_visit_addon_lines が真実) ─────────────────────
  // 加算行はこのテーブルの投影。onConflict は client_id,target_month,office_id,addon_code。
  // テーブル未作成 (42P01/PGRST205) は加算保存をスキップして amber toast。
  const upsertAddonLine = useCallback(
    async (addonCode: string, count: number): Promise<boolean> => {
      if (!currentOfficeId) {
        toast.error("加算の保存には事業所の選択 (?office=) が必要です");
        return false;
      }
      const c = Math.max(0, Math.round(count) || 0);
      // count=0 は削除扱い
      if (c === 0) {
        const { error } = await supabase
          .from("kaigo_visit_addon_lines")
          .delete()
          .eq("client_id", userId)
          .eq("target_month", monthStr)
          .eq("office_id", currentOfficeId)
          .eq("addon_code", addonCode);
        if (error) {
          if (error.code === "42P01" || error.code === "PGRST205") {
            setAddonTableMissing(true);
            toast.warning("加算テーブル (kaigo_visit_addon_lines) が未作成のため加算は保存されませんでした");
            return false;
          }
          console.error("addon line delete failed:", error.message);
          toast.error("加算の削除に失敗しました: " + error.message);
          return false;
        }
        setAddonLines((prev) => {
          const next = { ...prev };
          delete next[addonCode];
          return next;
        });
        return true;
      }
      const { error } = await supabase
        .from("kaigo_visit_addon_lines")
        .upsert(
          {
            client_id: userId,
            target_month: monthStr,
            office_id: currentOfficeId,
            addon_code: addonCode,
            count: c,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "client_id,target_month,office_id,addon_code" },
        );
      if (error) {
        if (error.code === "42P01" || error.code === "PGRST205") {
          setAddonTableMissing(true);
          toast.warning("加算テーブル (kaigo_visit_addon_lines) が未作成のため加算は保存されませんでした");
          return false;
        }
        console.error("addon line upsert failed:", error.message);
        toast.error("加算の保存に失敗しました: " + error.message);
        return false;
      }
      setAddonLines((prev) => ({ ...prev, [addonCode]: c }));
      return true;
    },
    [supabase, userId, monthStr, currentOfficeId],
  );

  // ── Add service row ───────────────────────────────────────────────────────
  const handleAddRow = async () => {
    if (!addRowForm.service_name) {
      toast.error("サービスを選択してください");
      return;
    }
    const key = makeRowKey(addRowForm.service_name, addRowForm.start_time + ":00", addRowForm.end_time + ":00");
    if (serviceRows.some((r) => r.key === key)) {
      toast.error("同じサービス行が既に存在します");
      return;
    }
    const staffObj = allStaff.find((s) => s.id === addRowForm.staff_id);
    // additional 行を jsonb 形 (individual time は "HH:MM:SS" or null) に変換
    const additional = additionalStaffRowsToEntries(addRowAdditional);
    setServiceRows((prev) => [...prev, {
      key,
      service_type: addRowForm.service_name,
      start_time: addRowForm.start_time + ":00",
      end_time: addRowForm.end_time + ":00",
      staff_id: addRowForm.staff_id || undefined,
      staff_name: staffObj?.name ?? undefined,
      additional,
    }]);
    setGrid((prev) => ({ ...prev, [key]: {} }));
    markDirty();
    // 職員2 (先頭の追加職員) のコード整合警告
    const first = addRowAdditional.find((r) => r.staff_id);
    const warn = twoPersonMismatchWarning(addRowForm.service_name, first?.staff_id || null);
    if (warn) toast.warning(warn);

    // モーダルで指定した「この訪問につく加算」を kaigo_visit_addon_lines に反映。
    // addRowAddons = { addon_code -> count }。既存 addonLines と加算合成 (回数加算) して upsert。
    // (処遇改善は行を作らず集計のみ = ここでは扱わない)
    for (const [code, cnt] of Object.entries(addRowAddons)) {
      if (cnt <= 0) continue;
      const merged = (addonLines[code] ?? 0) + cnt;
      await upsertAddonLine(code, merged);
    }

    setShowAddRow(false);
  };

  const removeRow = (rowKey: string) => {
    markDirty();
    setServiceRows((prev) => prev.filter((r) => r.key !== rowKey));
    setGrid((prev) => {
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
  };

  // ── Edit row ───────────────────────────────────────────────────────────────
  const openEditRow = (row: ServiceRow) => {
    setEditRowKey(row.key);
    setEditRowForm({
      start_time: row.start_time.slice(0, 5),
      end_time: row.end_time.slice(0, 5),
      service_name: row.service_type,
      service_code: "",
      staff_id: row.staff_id ?? "",
    });
    setEditRowAdditional(additionalEntriesToRows(row.additional));
  };

  const handleEditRowSave = () => {
    if (!editRowKey || !editRowForm.service_name) return;
    const oldRow = serviceRows.find((r) => r.key === editRowKey);
    if (!oldRow) return;

    markDirty();
    const newKey = makeRowKey(editRowForm.service_name, editRowForm.start_time + ":00", editRowForm.end_time + ":00");
    const existingRow = serviceRows.find((r) => r.key === newKey && r.key !== editRowKey);

    if (existingRow) {
      // Merge: combine grid data from old row into existing row
      setGrid((prev) => {
        const next = { ...prev };
        const oldData = next[editRowKey] || {};
        const existingData = { ...(next[newKey] || {}) };
        // Merge: OR the planned/actual flags
        for (const [dayStr, cell] of Object.entries(oldData)) {
          const d = parseInt(dayStr, 10);
          if (!existingData[d]) {
            existingData[d] = { ...cell };
          } else {
            existingData[d] = {
              planned: existingData[d].planned || cell.planned,
              actual: existingData[d].actual || cell.actual,
            };
          }
        }
        next[newKey] = existingData;
        delete next[editRowKey];
        return next;
      });
      // Remove old row
      setServiceRows((prev) => prev.filter((r) => r.key !== editRowKey));
    } else {
      // Simple rename (+ staff / 追加職員 の反映)
      const staffObj = allStaff.find((s) => s.id === editRowForm.staff_id);
      const additional = additionalStaffRowsToEntries(editRowAdditional);
      setServiceRows((prev) => prev.map((r) =>
        r.key === editRowKey
          ? {
              ...r,
              key: newKey,
              service_type: editRowForm.service_name,
              start_time: editRowForm.start_time + ":00",
              end_time: editRowForm.end_time + ":00",
              staff_id: editRowForm.staff_id || undefined,
              staff_name: staffObj?.name ?? undefined,
              additional,
            }
          : r
      ));
      // 職員2 (先頭の追加職員) のコード整合警告
      const first = editRowAdditional.find((row) => row.staff_id);
      const warn = twoPersonMismatchWarning(editRowForm.service_name, first?.staff_id || null);
      if (warn) toast.warning(warn);

      if (newKey !== editRowKey) {
        setGrid((prev) => {
          const next = { ...prev };
          next[newKey] = next[editRowKey] || {};
          delete next[editRowKey];
          return next;
        });
      }
    }

    setEditRowKey(null);
  };

  // ── Save handler ──────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    try {
      const from = `${monthStr}-01`;
      const to = `${monthStr}-${String(daysCount).padStart(2, "0")}`;

      // 既存月分を一旦 delete → 再 insert。delete 失敗を silent にしない
      // (silent fail だと重複が積み上がる)
      const { error: delError } = await supabase
        .from("kaigo_visit_schedule")
        .delete()
        .eq("user_id", userId)
        .gte("visit_date", from)
        .lte("visit_date", to);
      if (delError) throw delError;

      const toInsert: Record<string, unknown>[] = [];
      for (const row of serviceRows) {
        const rowGrid = grid[row.key] || {};
        // 追加職員: additional_staff (jsonb) + 従来列 staff_id_2/3 + staff2/3_*_time にミラー。
        // 列未適用 (42703/PGRST204) は insertVisitSchedules が該当列を strip して retry する。
        // row.additional は既に "HH:MM:SS" or null 形なので custom フラグに畳んで helper に渡す。
        const staff2Fields = buildAdditionalStaffPayload(
          (row.additional ?? []).map((a) => ({
            staff_id: a.staff_id,
            custom: !!a.start_time,
            start: a.start_time?.slice(0, 5) ?? "",
            end: a.end_time?.slice(0, 5) ?? "",
          })),
        );
        for (const day of days) {
          const cell = rowGrid[day];
          if (!cell) continue;
          const dateStr = `${monthStr}-${String(day).padStart(2, "0")}`;

          if (cell.planned) {
            toInsert.push({
              user_id: userId,
              staff_id: row.staff_id || null,
              visit_date: dateStr,
              start_time: row.start_time,
              end_time: row.end_time,
              service_type: row.service_type,
              status: "scheduled",
              // C5: 発生元 office (列未適用 42703/PGRST204 は insertVisitSchedules が strip)
              ...(currentOfficeId ? { office_id: currentOfficeId } : {}),
              ...staff2Fields,
            });
          }
          if (cell.actual) {
            toInsert.push({
              user_id: userId,
              staff_id: row.staff_id || null,
              visit_date: dateStr,
              start_time: row.start_time,
              end_time: row.end_time,
              service_type: row.service_type,
              status: "completed",
              ...(currentOfficeId ? { office_id: currentOfficeId } : {}),
              ...staff2Fields,
            });
          }
        }
      }

      if (toInsert.length > 0) {
        // .select() で実 INSERT 件数を取得し、想定件数と照合 (= 部分 fail の検知)
        // office_id 列未適用 (42703/PGRST204) は insertVisitSchedules が strip して retry
        const { data: inserted, error } = await insertVisitSchedules(supabase, toInsert, "id");
        if (error) throw error;
        const actual = inserted?.length ?? 0;
        if (actual !== toInsert.length) {
          toast.warning(`${toInsert.length} 件中 ${actual} 件のみ保存されました (${toInsert.length - actual} 件失敗)`);
        } else {
          toast.success(`提供票を保存しました (${actual} 件)`);
        }
      } else {
        toast.success("提供票を保存しました");
      }

      setIsDirty(false);
      fetchGridData();
    } catch (err: unknown) {
      toast.error("保存に失敗しました: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  // ── Summaries ──────────────────────────────────────────────────────────────
  const daySummary = useMemo(() => {
    const planned: Record<number, number> = {};
    const actual: Record<number, number> = {};
    for (const day of days) { planned[day] = 0; actual[day] = 0; }
    for (const rowData of Object.values(grid)) {
      for (const [dayStr, cell] of Object.entries(rowData)) {
        const d = parseInt(dayStr, 10);
        if (cell.planned) planned[d] = (planned[d] ?? 0) + 1;
        if (cell.actual) actual[d] = (actual[d] ?? 0) + 1;
      }
    }
    return { planned, actual };
  }, [grid, days]);

  const totalPlanned = useMemo(() => Object.values(daySummary.planned).reduce((a, b) => a + b, 0), [daySummary]);
  const totalActual = useMemo(() => Object.values(daySummary.actual).reduce((a, b) => a + b, 0), [daySummary]);

  // ── Unit calculation ───────────────────────────────────────────────────────
  const unitSummary = useMemo(() => {
    const rows: { service_type: string; plannedCount: number; actualCount: number; units: number; plannedUnits: number; actualUnits: number }[] = [];
    for (const row of serviceRows) {
      const rowGrid = grid[row.key] || {};
      const pCount = days.reduce((s, d) => s + (rowGrid[d]?.planned ? 1 : 0), 0);
      const aCount = days.reduce((s, d) => s + (rowGrid[d]?.actual ? 1 : 0), 0);
      const units = serviceUnits[row.service_type] ?? 0;
      rows.push({
        service_type: row.service_type,
        plannedCount: pCount,
        actualCount: aCount,
        units,
        plannedUnits: pCount * units,
        actualUnits: aCount * units,
      });
    }
    // Group by service_type
    const grouped = new Map<string, { service_type: string; plannedCount: number; actualCount: number; units: number; plannedUnits: number; actualUnits: number }>();
    for (const r of rows) {
      const existing = grouped.get(r.service_type);
      if (existing) {
        existing.plannedCount += r.plannedCount;
        existing.actualCount += r.actualCount;
        existing.plannedUnits += r.plannedUnits;
        existing.actualUnits += r.actualUnits;
      } else {
        grouped.set(r.service_type, { ...r });
      }
    }
    return Array.from(grouped.values());
  }, [serviceRows, grid, days, serviceUnits]);

  const totalPlannedUnits = useMemo(() => unitSummary.reduce((s, r) => s + r.plannedUnits, 0), [unitSummary]);
  const totalActualUnits = useMemo(() => unitSummary.reduce((s, r) => s + r.actualUnits, 0), [unitSummary]);

  // ── formula 加算系コード (処遇改善加算等) を「自事業所の category」で絞る ──
  // currentOffice.service_type → category prefix (簡易 mapping)
  const officeCategory = useMemo(() => {
    const t = currentOffice?.service_type ?? "";
    if (t === "訪問介護") return "11";
    if (t === "訪問入浴介護") return "12";
    if (t === "訪問看護") return "13";
    if (t === "訪問リハビリテーション") return "14";
    if (t === "通所介護") return "15";
    if (t === "通所リハビリテーション") return "16";
    if (t === "短期入所生活介護") return "21";
    if (t === "居宅介護支援") return "43";
    return null;
  }, [currentOffice]);

  const availableFormulaCodes = useMemo(
    () => formulaCodes.filter((f) => !officeCategory || f.service_category === officeCategory),
    [formulaCodes, officeCategory],
  );

  // 選択された formula コードに月計を適用して計算した単位
  const formulaAdjustments = useMemo(() => {
    const out: { code: string; name: string; plannedUnits: number; actualUnits: number; pct: string }[] = [];
    for (const f of availableFormulaCodes) {
      if (!appliedFormulaCodes.has(f.service_code) || !f.formula) continue;
      let plannedUnits = 0;
      let actualUnits = 0;
      let pctLabel = "";
      if (f.formula.type === "monthly_aggregate") {
        const num = f.formula.numerator;
        const den = f.formula.denominator;
        plannedUnits = Math.round((totalPlannedUnits * num) / den);
        actualUnits = Math.round((totalActualUnits * num) / den);
        pctLabel = `${((num / den) * 100).toFixed(1).replace(/\.0$/, "")}%`;
      }
      out.push({
        code: f.service_code,
        name: f.service_name,
        plannedUnits,
        actualUnits,
        pct: pctLabel,
      });
    }
    return out;
  }, [availableFormulaCodes, appliedFormulaCodes, totalPlannedUnits, totalActualUnits]);

  // ── サービス加算行 (kaigo_visit_addon_lines の投影) ─────────────────────────
  // 単位解決は共有リゾルバ resolveVisitAddonLines (集計 aggregate.ts と同一経路) を使う。
  // addonLines (保存済み addon_code -> count) が変わるたびに対象月マスタで解決し直す。
  // これらは kaigo_visit_schedule 行には入れない (真実は kaigo_visit_addon_lines)。
  const [resolvedAddonLines, setResolvedAddonLines] = useState<import("@/lib/visit-addons").VisitAddonLine[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 保存済み加算が無い / 事業所未選択なら空。resolveVisitAddonLines は
      // office 未指定・0件時に空 Map を返すのでそのまま流す。
      if (!currentOfficeId || Object.keys(addonLines).length === 0) {
        if (!cancelled) setResolvedAddonLines([]);
        return;
      }
      try {
        const map = await resolveVisitAddonLines(
          supabase,
          [userId],
          selectedMonth.getFullYear(),
          selectedMonth.getMonth() + 1,
          currentOfficeId,
        );
        if (!cancelled) setResolvedAddonLines(map.get(userId) ?? []);
      } catch (err) {
        console.error("resolveVisitAddonLines failed:", err instanceof Error ? err.message : String(err));
        if (!cancelled) setResolvedAddonLines([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, userId, currentOfficeId, selectedMonth, addonLines]);

  const addonRows = useMemo(() => {
    const out = resolvedAddonLines
      // 書く側 (この画面) は加算のみ扱う。減算 (isReduction) は次段階なので表示しない
      .filter((l) => !l.isReduction)
      .map((l) => ({
        code: l.code,
        label: l.count > 1 ? `${l.name} ×${l.count}回` : l.name,
        count: l.count,
        unit: l.unitUnits,
        units: l.totalUnits,
      }));
    out.sort((a, b) => a.code.localeCompare(b.code));
    return out;
  }, [resolvedAddonLines]);

  // 加算行の合計単位数 (月次で予定=実績とも同額)。単位数計算エリアに含める。
  const addonTotalUnits = useMemo(
    () => addonRows.reduce((s, r) => s + r.units, 0),
    [addonRows],
  );

  // 加算込みの最終合計 (処遇改善% + サービス加算 マスタ駆動一覧)
  const grandPlannedUnits = useMemo(
    () => totalPlannedUnits + formulaAdjustments.reduce((s, a) => s + a.plannedUnits, 0) + addonTotalUnits,
    [totalPlannedUnits, formulaAdjustments, addonTotalUnits],
  );
  const grandActualUnits = useMemo(
    () => totalActualUnits + formulaAdjustments.reduce((s, a) => s + a.actualUnits, 0) + addonTotalUnits,
    [totalActualUnits, formulaAdjustments, addonTotalUnits],
  );

  // 加算行の × ボタン: 該当加算コードを 1回分減らす (0 で削除)
  const removeAddonRow = useCallback(
    (code: string) => {
      const cur = addonLines[code] ?? 0;
      void upsertAddonLine(code, Math.max(0, cur - 1));
    },
    [addonLines, upsertAddonLine],
  );

  // appliedFormulaCodes は currentOffice 由来 (read-only)。
  // 設定変更は マスタ管理 → 自事業所管理 (/master/office) の「適用加算」セクションで行う。

  // ── 月次実績 payload (居宅介護支援への送付用) ─────────────────────────────
  // grid 上の actual=true セルを 1 record とし、(date, start_time) で重複判定可能な
  // shape で出力。受信側 (notifications/document/[id]) は date+start_time で diff key 化する。
  const monthlyPayload = useMemo(() => {
    const items: {
      date: string;
      start_time: string | null;
      end_time: string | null;
      service_category: string;
      service_content: string;
      provider_name: string;
      duration_minutes: number | null;
    }[] = [];
    for (const row of serviceRows) {
      const rowGrid = grid[row.key] || {};
      for (const day of days) {
        const cell = rowGrid[day];
        if (!cell?.actual) continue;
        const dateStr = `${monthStr}-${String(day).padStart(2, "0")}`;
        const [sh, sm] = (row.start_time || "").split(":").map(Number);
        const [eh, em] = (row.end_time || "").split(":").map(Number);
        const dur =
          [sh, sm, eh, em].some((n) => Number.isNaN(n))
            ? null
            : Math.max(0, (eh * 60 + em) - (sh * 60 + sm)) || null;
        items.push({
          date: dateStr,
          start_time: row.start_time || null,
          end_time: row.end_time || null,
          service_category: row.service_type,
          service_content: row.service_type,
          provider_name: row.staff_name ?? "",
          duration_minutes: dur,
        });
      }
    }
    // 日付 + 開始時刻 昇順
    items.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const at = a.start_time ?? "";
      const bt = b.start_time ?? "";
      return at < bt ? -1 : at > bt ? 1 : 0;
    });
    return {
      service_type: "サービス提供表（実績）" as const,
      year_month: monthStr,
      client_id: userId,
      client_name: userData?.name ?? "",
      records: items,
    };
  }, [serviceRows, grid, days, monthStr, userId, userData]);

  const monthlyActualCount = monthlyPayload.records.length;

  // ── Print ──────────────────────────────────────────────────────────────────
  const handlePrint = () => window.print();

  // ── CSV Export (ケアプランデータ連携システム標準仕様 第6表 実績) ────────
  const handleCsvExport = () => {
    if (serviceRows.length === 0) {
      toast.error("サービス行がありません。サービスを追加するか、シフト管理からデータを作成してください。");
      return;
    }
    // 予定or実績が1つもなければ警告
    const hasAnyData = serviceRows.some((row) => {
      const rowGrid = grid[row.key] || {};
      return days.some((d) => rowGrid[d]?.planned || rowGrid[d]?.actual);
    });
    if (!hasAnyData) {
      toast.error("予定・実績が入力されていません");
      return;
    }

    const csvVersion = "202407"; // Version 4.1 (令和6年10月改定)
    const insurerNo = userData?.insurer_no ?? "";
    const insuredNo = userData?.insured_no ?? "";
    const periodYm = `${year}${String(month).padStart(2, "0")}`;
    const providerCode = officeInfo?.provider_number ?? "";
    const now = new Date();
    const timestamp = format(now, "yyyyMMddHHmmss");

    // サービス種類コードのマッピング
    const getServiceCategoryCode = (serviceType: string): string => {
      if (serviceType.includes("訪問介護") || serviceType.includes("身体") || serviceType.includes("生活")) return "11";
      if (serviceType.includes("訪問看護")) return "13";
      if (serviceType.includes("訪問リハ")) return "14";
      if (serviceType.includes("通所介護")) return "15";
      if (serviceType.includes("通所リハ")) return "16";
      if (serviceType.includes("福祉用具")) return "17";
      if (serviceType.includes("短期入所")) return "21";
      return "11"; // デフォルト: 訪問介護
    };

    // ヘッダー行
    const headers = [
      "CSVバージョン",
      "保険者番号",
      "被保険者番号",
      "利用対象年月",
      "サービス事業者コード",
      "サービス種類コード",
      "サービス内容/名称",
      "開始時刻",
      "終了時刻",
      ...days.map((d) => `${d}日予定`),
      ...days.map((d) => `${d}日実績`),
      "予定回数合計",
      "実績回数合計",
      "単位数",
      "予定単位合計",
      "実績単位合計",
    ];

    // データ行
    const dataRows: string[][] = [];
    for (const row of serviceRows) {
      const rowGrid = grid[row.key] || {};
      const categoryCode = getServiceCategoryCode(row.service_type);
      const plannedDays = days.map((d) => (rowGrid[d]?.planned ? "1" : ""));
      const actualDays = days.map((d) => (rowGrid[d]?.actual ? "1" : ""));
      const plannedCount = days.reduce((s, d) => s + (rowGrid[d]?.planned ? 1 : 0), 0);
      const actualCount = days.reduce((s, d) => s + (rowGrid[d]?.actual ? 1 : 0), 0);
      const units = serviceUnits[row.service_type] ?? 0;

      dataRows.push([
        csvVersion,
        insurerNo,
        insuredNo,
        periodYm,
        providerCode,
        categoryCode,
        row.service_type,
        row.start_time.slice(0, 5).replace(":", ""),
        row.end_time.slice(0, 5).replace(":", ""),
        ...plannedDays,
        ...actualDays,
        String(plannedCount),
        String(actualCount),
        String(units),
        String(plannedCount * units),
        String(actualCount * units),
      ]);
    }

    // CSV文字列を作成 (Shift-JIS互換のためBOMなしUTF-8で出力、必要に応じてShift-JISに変換)
    const escapeField = (v: string) => {
      if (v.includes(",") || v.includes('"') || v.includes("\n")) {
        return '"' + v.replace(/"/g, '""') + '"';
      }
      return v;
    };

    const csvLines = [
      headers.map(escapeField).join(","),
      ...dataRows.map((row) => row.map(escapeField).join(",")),
    ];
    const csvContent = csvLines.join("\r\n") + "\r\n";

    // Shift-JIS対応: TextEncoderではShift-JISにできないため、UTF-8 BOM付きで出力
    // (Excelで開くため)
    const bom = "\uFEFF";
    const blob = new Blob([bom + csvContent], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const serviceCategoryCode = serviceRows.length > 0 ? getServiceCategoryCode(serviceRows[0].service_type) : "11";
    a.href = url;
    a.download = `DLTJSK_${periodYm}_${providerCode || "0000000000"}_${serviceCategoryCode}_${timestamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("CSVファイルをダウンロードしました");
  };

  // ── CSV Import (ケアプランデータ連携 第6表 予定CSV取込) ──────────────────
  const csvImportRef = useRef<HTMLInputElement>(null);

  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (csvImportRef.current) csvImportRef.current.value = "";

    try {
      const buf = await file.arrayBuffer();
      let text = "";
      try { text = new TextDecoder("shift-jis").decode(buf); } catch { text = new TextDecoder("utf-8").decode(buf); }
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length === 0) { toast.error("CSVファイルが空です"); return; }

      // ヘッダー行判定
      const firstLine = lines[0];
      const isHeader = !firstLine.match(/^\d/) && !firstLine.startsWith('"2');
      const dataLines = isHeader ? lines.slice(1) : lines;

      const parseCSVLine = (line: string): string[] => {
        const result: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
            else if (ch === '"') { inQuotes = false; }
            else { current += ch; }
          } else {
            if (ch === '"') { inQuotes = true; }
            else if (ch === ",") { result.push(current); current = ""; }
            else { current += ch; }
          }
        }
        result.push(current);
        return result;
      };

      let importedRows = 0;
      const newServiceRows = [...serviceRows];
      const newGrid = { ...grid };

      for (const line of dataLines) {
        const cols = parseCSVLine(line);
        if (cols.length < 10) continue;

        // 第6表CSV: cols[9]=サービス内容, cols[10]=開始時刻(HHMM), cols[11]=終了時刻(HHMM), cols[15-45]=日別フラグ
        const serviceName = cols[9]?.trim() || cols[6]?.trim() || "";
        const startHHMM = cols[10]?.trim() || cols[7]?.trim() || "";
        const endHHMM = cols[11]?.trim() || cols[8]?.trim() || "";

        if (!serviceName || !startHHMM) continue;

        // 時刻をHH:MM:00形式に変換
        const startTime = startHHMM.length === 4
          ? `${startHHMM.slice(0, 2)}:${startHHMM.slice(2)}:00`
          : startHHMM.includes(":") ? (startHHMM.length === 5 ? startHHMM + ":00" : startHHMM) : startHHMM;
        const endTime = endHHMM.length === 4
          ? `${endHHMM.slice(0, 2)}:${endHHMM.slice(2)}:00`
          : endHHMM.includes(":") ? (endHHMM.length === 5 ? endHHMM + ":00" : endHHMM) : endHHMM;

        const key = makeRowKey(serviceName, startTime, endTime);

        // サービス行がなければ追加
        if (!newServiceRows.some((r) => r.key === key)) {
          newServiceRows.push({
            key,
            service_type: serviceName,
            start_time: startTime,
            end_time: endTime,
          });
        }
        if (!newGrid[key]) newGrid[key] = {};

        // 日別予定フラグを取り込み (cols[15]〜cols[45] or cols[9+offset])
        // フレキシブルに: 数字列の後ろの方にある1/空白の連続31個を探す
        const dayOffset = cols.length > 46 ? 15 : 9;
        for (let d = 1; d <= daysCount; d++) {
          const idx = dayOffset + (d - 1);
          if (idx < cols.length) {
            const val = cols[idx]?.trim();
            if (val === "1") {
              if (!newGrid[key][d]) newGrid[key][d] = { planned: false, actual: false };
              newGrid[key][d].planned = true;
              importedRows++;
            }
          }
        }
      }

      setServiceRows(newServiceRows);
      setGrid(newGrid);
      markDirty();

      if (importedRows > 0) {
        toast.success(`CSV取込完了: ${importedRows}件の予定を反映しました`);
      } else {
        toast.info("取り込み可能なデータがありませんでした");
      }
    } catch (err) {
      console.error(err);
      toast.error("CSVの読み込みに失敗しました");
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #provision-ticket-print, #provision-ticket-print * { visibility: visible !important; }
          #provision-ticket-print { position: fixed; inset: 0; padding: 6mm; background: white; overflow: visible; }
          .no-print { display: none !important; }
          @page { size: A4 landscape; margin: 6mm; }
          table { border-collapse: collapse; font-size: 7pt; }
          th, td { border: 1px solid #333 !important; padding: 0.5mm 1mm !important; }
        }
      `}</style>

      <div className="flex-1 overflow-y-auto">
          {/* Header */}
          <div className="sticky top-0 z-10 bg-white border-b px-6 py-3 no-print">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <FileText size={22} className="text-blue-600" />
                <h1 className="text-lg font-bold text-gray-900">
                  サービス提供表（実績）（{format(selectedMonth, "yyyy年M月", { locale: ja })}）
                </h1>
                <span className={cn(
                  "text-xs font-medium px-2 py-0.5 rounded-full",
                  status === "draft" ? "bg-yellow-100 text-yellow-700" : "bg-green-100 text-green-700"
                )}>
                  {status === "draft" ? "下書き" : "完成"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {status === "draft" && (
                  <button
                    onClick={() => setStatus("confirmed")}
                    className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <Edit3 size={14} />
                    完成にする
                  </button>
                )}
                {status === "confirmed" && (
                  <button
                    onClick={() => setStatus("draft")}
                    className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <Edit3 size={14} />
                    下書きに戻す
                  </button>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  保存
                </button>
                <input ref={csvImportRef} type="file" accept=".csv" className="hidden" onChange={handleCsvImport} />
                <button
                  onClick={() => csvImportRef.current?.click()}
                  className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <Upload size={14} />
                  CSV取込
                </button>
                <button
                  onClick={handleCsvExport}
                  disabled={serviceRows.length === 0}
                  className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <Download size={14} />
                  CSV出力
                </button>
                <button
                  onClick={() => setShowSendModal(true)}
                  disabled={!currentOffice || monthlyActualCount === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title={
                    monthlyActualCount === 0
                      ? "実績が入力されていません"
                      : !currentOffice
                        ? "事業所が選択されていません"
                        : "居宅介護支援事業所へ月次実績を送付"
                  }
                >
                  <Send size={14} />
                  居宅事業所に実績送信
                  <span className="ml-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                    {monthlyActualCount}件
                  </span>
                </button>
                <button
                  onClick={handlePrint}
                  className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Printer size={14} />
                  印刷
                </button>
              </div>
            </div>
          </div>

          {(
            <div className="p-6" id="provision-ticket-print">
              {/* ── User info header (利用票風・コンパクト 1 行帯) ── */}
              <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border bg-gray-50 px-3 py-2">
                <HeaderPair label="保険者番号" value={userData?.insurer_no} mono />
                <HeaderPair label="被保険者番号" value={userData?.insured_no} mono />
                <HeaderPair label="利用者氏名" value={userData?.name} strong />
                <HeaderPair label="要介護度" value={userData?.care_level} />
                <span className="hidden h-5 w-px bg-gray-300 sm:block" />
                <div className="flex items-center gap-1.5">
                  <span className="whitespace-nowrap text-[10px] text-gray-500">提供月</span>
                  <button onClick={() => {
                    if (isDirty && !window.confirm("未保存の変更があります。破棄しますか？")) return;
                    setIsDirty(false);
                    setSelectedMonth(subMonths(selectedMonth, 1));
                  }} className="rounded border bg-white p-0.5 hover:bg-gray-50"><ChevronLeft size={14} /></button>
                  <span className="text-sm font-semibold">{format(selectedMonth, "yyyy年M月", { locale: ja })}</span>
                  <button onClick={() => {
                    if (isDirty && !window.confirm("未保存の変更があります。破棄しますか？")) return;
                    setIsDirty(false);
                    setSelectedMonth(addMonths(selectedMonth, 1));
                  }} className="rounded border bg-white p-0.5 hover:bg-gray-50"><ChevronRight size={14} /></button>
                </div>
                <HeaderPair label="作成年月日" value={toWareki(new Date())} />
              </div>

              {/* ── Service grid header ── */}
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-gray-800">
                  サービス一覧（最大9件）
                </h2>
                <button
                  onClick={() => {
                    setAddRowForm({
                      start_time: "09:00", end_time: "10:00", service_type: "", service_code: "", service_name: "", staff_id: "",
                    });
                    setAddRowAdditional([]);
                    setAddRowAddons({});
                    setShowAddRow(true);
                  }}
                  className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 no-print"
                >
                  <Plus size={14} />
                  サービス追加
                </button>
              </div>

              {/* ── Grid table ── */}
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="animate-spin text-blue-500" />
                </div>
              ) : (
                <div className="w-full min-w-0 overflow-x-auto border rounded-lg">
                  {/* 幅は viewport 100% に自動 fit (最低 900px)。日セルは残り幅を等分 */}
                  <table className="text-xs border-collapse w-full" style={{ tableLayout: "fixed", minWidth: "900px" }}>
                    <colgroup>
                      <col style={{ width: "52px" }} />
                      <col style={{ width: "96px" }} />
                      <col style={{ width: "72px" }} />
                      {days.map((d) => <col key={d} />)}
                      <col style={{ width: "30px" }} />
                      <col style={{ width: "56px" }} />
                      <col style={{ width: "68px" }} />
                      <col className="no-print" style={{ width: "20px" }} />
                    </colgroup>
                    <thead>
                      {/* Day numbers */}
                      <tr className="bg-gray-50">
                        <th className="border border-gray-400 px-1 py-1 text-left text-[11px] sticky left-0 bg-gray-50 z-10">時間帯</th>
                        <th className="border border-gray-400 px-1 py-1 text-left text-[11px]">サービス内容</th>
                        <th className="border border-gray-400 px-0 py-1 text-[9px]"></th>
                        {days.map((d) => (
                          <th key={d} className={cn(
                            "border border-gray-400 px-0 py-1 text-center font-semibold text-[11px]",
                            isDowColor(year, month, d),
                            isDowBg(year, month, d)
                          )}>
                            {d}
                          </th>
                        ))}
                        <th className="border border-gray-400 px-0 py-1 text-center font-bold text-blue-700 text-[11px]">計</th>
                        <th className="border border-gray-400 px-0 py-1 text-center text-[10px] text-gray-600">概算<br />単位</th>
                        <th className="border border-gray-400 px-0 py-1 text-center text-[10px] text-gray-600">請求<br />区分</th>
                        <th className="border border-gray-400 no-print"></th>
                      </tr>
                      {/* Day of week */}
                      <tr className="bg-gray-50">
                        <th className="border border-gray-400 sticky left-0 bg-gray-50 z-10" colSpan={3}></th>
                        {days.map((d) => {
                          const dow = getDayOfWeek(year, month, d);
                          return (
                            <th key={`dow-${d}`} className={cn(
                              "border border-gray-400 px-0 py-0.5 text-center text-[10px] font-normal",
                              isDowColor(year, month, d),
                              isDowBg(year, month, d)
                            )}>
                              {dow}
                            </th>
                          );
                        })}
                        <th className="border border-gray-400" colSpan={3}></th>
                        <th className="border border-gray-400 no-print"></th>
                      </tr>
                    </thead>
                      {serviceRows.map((row) => {
                        const rowGrid = grid[row.key] || {};
                        const plannedCount = days.reduce((s, d) => s + (rowGrid[d]?.planned ? 1 : 0), 0);
                        const actualCount = days.reduce((s, d) => s + (rowGrid[d]?.actual ? 1 : 0), 0);
                        const rowUnits = serviceUnits[row.service_type] ?? 0;
                        const rowEstUnits = (actualCount > 0 ? actualCount : plannedCount) * rowUnits;

                        return (
                          <tbody key={row.key}>
                            {/* Planned row */}
                            <tr>
                              <td
                                className="border border-gray-400 px-1 py-1 text-[11px] text-gray-700 sticky left-0 bg-white z-10 cursor-pointer hover:bg-blue-50"
                                rowSpan={2}
                                onClick={() => openEditRow(row)}
                                title="クリックして編集"
                              >
                                {row.start_time.slice(0, 5)}
                                <br />〜{row.end_time.slice(0, 5)}
                              </td>
                              <td
                                className="border border-gray-400 px-1 py-1 text-[11px] cursor-pointer hover:bg-blue-50"
                                rowSpan={2}
                                onClick={() => openEditRow(row)}
                                title="クリックして編集"
                              >
                                <div className="break-words">{row.service_type}</div>
                              </td>
                              <td className="border border-gray-400 pl-1 pr-1.5 py-0.5 text-center text-[10px]">
                                <div className="flex items-center gap-1">
                                  <span className="text-gray-500 shrink-0">予定</span>
                                  <div className="flex gap-1 no-print">
                                    <button onClick={() => setAllPlanned(row.key)} className="text-blue-500 hover:underline" title="全日">全</button>
                                    <button onClick={() => setWeekdaysPlanned(row.key)} className="text-green-600 hover:underline" title="平日">平</button>
                                    <button onClick={() => clearPlanned(row.key)} className="text-red-500 hover:underline" title="消去">消</button>
                                  </div>
                                </div>
                              </td>
                              {days.map((d) => {
                                const cell = rowGrid[d];
                                const isOn = cell?.planned ?? false;
                                return (
                                  <td
                                    key={`p-${d}`}
                                    className={cn(
                                      "border border-gray-400 px-0 py-0 text-center cursor-pointer transition-colors",
                                      isOn ? "bg-blue-100" : cn(isDowBg(year, month, d), "hover:bg-blue-50/50")
                                    )}
                                    onClick={() => togglePlanned(row.key, d)}
                                  >
                                    {isOn && <span className="text-blue-700 font-bold">1</span>}
                                  </td>
                                );
                              })}
                              <td className="border border-gray-400 px-0 py-0 text-center font-bold text-blue-700">
                                {plannedCount > 0 ? plannedCount : ""}
                              </td>
                              <td className="border border-gray-400 px-1 py-0 text-right text-[10px] text-gray-700 tabular-nums" rowSpan={2}>
                                {rowEstUnits > 0 ? rowEstUnits.toLocaleString() : ""}
                              </td>
                              <td className="border border-gray-400 px-1 py-0 text-center text-[10px] text-gray-600" rowSpan={2}>
                                介護保険
                              </td>
                              <td className="border border-gray-400 px-0 py-0 text-center no-print" rowSpan={2}>
                                <button
                                  onClick={() => removeRow(row.key)}
                                  className="text-gray-300 hover:text-red-500 transition-colors"
                                  title="行削除"
                                >
                                  <X size={10} />
                                </button>
                              </td>
                            </tr>
                            {/* Actual row */}
                            <tr>
                              <td className="border border-gray-400 pl-1 pr-1.5 py-0.5 text-center text-[10px]">
                                <div className="flex items-center gap-1">
                                  <span className="text-gray-500 shrink-0">実績</span>
                                  <div className="flex gap-1 no-print">
                                    <button onClick={() => setAllActual(row.key)} className="text-blue-500 hover:underline" title="全日">全</button>
                                    <button onClick={() => setWeekdaysActual(row.key)} className="text-green-600 hover:underline" title="平日">平</button>
                                    <button onClick={() => clearActual(row.key)} className="text-red-500 hover:underline" title="消去">消</button>
                                  </div>
                                </div>
                              </td>
                              {days.map((d) => {
                                const cell = rowGrid[d];
                                const isOn = cell?.actual ?? false;
                                return (
                                  <td
                                    key={`a-${d}`}
                                    className={cn(
                                      "border border-gray-400 px-0 py-0 text-center cursor-pointer transition-colors",
                                      isOn ? "bg-green-100" : cn(isDowBg(year, month, d), "hover:bg-green-50/50")
                                    )}
                                    onClick={() => toggleActual(row.key, d)}
                                  >
                                    {isOn && <span className="text-green-700 font-bold">1</span>}
                                  </td>
                                );
                              })}
                              <td className="border border-gray-400 px-0 py-0 text-center font-bold text-green-700">
                                {actualCount > 0 ? actualCount : ""}
                              </td>
                            </tr>
                          </tbody>
                        );
                      })}

                      {/* ── 加算行 (kaigo_visit_addon_lines の投影。schedule 行には無い) ── */}
                      {addonRows.length > 0 && (
                        <tbody>
                          {addonRows.map((a) => (
                            <tr key={`addon-${a.code}`} className="bg-purple-50/60">
                              <td className="border border-gray-400 px-1 py-1 text-center text-[10px] text-purple-700 sticky left-0 bg-purple-50/60 z-10">
                                <span className="inline-block rounded bg-purple-200 px-1 py-0.5 font-medium text-purple-800">加算</span>
                              </td>
                              <td className="border border-gray-400 px-1 py-1 text-[11px] text-purple-800">
                                <div className="break-words">{a.label}</div>
                              </td>
                              <td className="border border-gray-400 px-1 py-1 text-center text-[10px] text-purple-600">
                                月{a.count > 1 ? `${a.count}回` : "1回"}
                              </td>
                              <td colSpan={days.length} className="border border-gray-400 px-2 py-1 text-left text-[10px] text-purple-500">
                                {a.unit > 0
                                  ? `月次加算 (${a.unit.toLocaleString()}単位${a.count > 1 ? ` × ${a.count}` : ""})`
                                  : "単位数マスタ未解決 (対象月世代を確認)"}
                              </td>
                              <td className="border border-gray-400 px-0 py-0 text-center font-bold text-purple-700">
                                {a.count}
                              </td>
                              <td className="border border-gray-400 px-1 py-0 text-right text-[10px] text-purple-700 tabular-nums">
                                {a.units > 0 ? a.units.toLocaleString() : ""}
                              </td>
                              <td className="border border-gray-400 px-1 py-0 text-center text-[10px] text-purple-600">
                                介護保険
                              </td>
                              <td className="border border-gray-400 px-0 py-0 text-center no-print">
                                <button
                                  onClick={() => removeAddonRow(a.code)}
                                  className="text-gray-300 hover:text-red-500 transition-colors"
                                  title={a.count > 1 ? "1回分を解除" : "加算を解除"}
                                >
                                  <X size={10} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      )}

                      {serviceRows.length === 0 && addonRows.length === 0 && (
                        <tbody>
                          <tr>
                            <td colSpan={3 + days.length + 4} className="border border-gray-400 px-4 py-8 text-center text-gray-400">
                              サービスの予定がありません。「＋サービス追加」で追加するか、シフト管理から予定を作成してください。
                            </td>
                          </tr>
                        </tbody>
                      )}

                      {/* Summary rows */}
                      {serviceRows.length > 0 && (
                        <tbody>
                          <tr className="bg-blue-50/50">
                            <td colSpan={3} className="border border-gray-400 px-2 py-1 text-right font-bold text-blue-700 text-xs">
                              予定合計
                            </td>
                            {days.map((d) => (
                              <td key={`sp-${d}`} className="border border-gray-400 px-0 py-0 text-center font-bold text-blue-700">
                                {(daySummary.planned[d] ?? 0) > 0 ? daySummary.planned[d] : ""}
                              </td>
                            ))}
                            <td className="border border-gray-400 px-0 py-0 text-center font-bold text-blue-700">{totalPlanned > 0 ? totalPlanned : ""}</td>
                            <td className="border border-gray-400 px-1 py-0 text-right font-bold text-blue-700 text-[10px] tabular-nums">
                              {totalPlannedUnits > 0 ? totalPlannedUnits.toLocaleString() : ""}
                            </td>
                            <td className="border border-gray-400"></td>
                            <td className="border border-gray-400 no-print"></td>
                          </tr>
                          <tr className="bg-green-50/50">
                            <td colSpan={3} className="border border-gray-400 px-2 py-1 text-right font-bold text-green-700 text-xs">
                              実績合計
                            </td>
                            {days.map((d) => (
                              <td key={`sa-${d}`} className="border border-gray-400 px-0 py-0 text-center font-bold text-green-700">
                                {(daySummary.actual[d] ?? 0) > 0 ? daySummary.actual[d] : ""}
                              </td>
                            ))}
                            <td className="border border-gray-400 px-0 py-0 text-center font-bold text-green-700">{totalActual > 0 ? totalActual : ""}</td>
                            <td className="border border-gray-400 px-1 py-0 text-right font-bold text-green-700 text-[10px] tabular-nums">
                              {totalActualUnits > 0 ? totalActualUnits.toLocaleString() : ""}
                            </td>
                            <td className="border border-gray-400"></td>
                            <td className="border border-gray-400 no-print"></td>
                          </tr>
                        </tbody>
                      )}
                  </table>
                </div>
              )}

              {/* ── Unit calculation summary (compact) ── */}
              {serviceRows.length > 0 && (
                <div className="mt-4 max-w-2xl">
                  <h3 className="text-xs font-semibold text-gray-600 mb-1">単位数計算</h3>
                  <table className="w-full text-xs border-collapse border rounded">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className="border border-gray-200 px-2 py-1 text-left text-[10px] text-gray-500">サービス</th>
                        <th className="border border-gray-200 px-2 py-1 text-right text-[10px] text-gray-500 w-14">単位</th>
                        <th className="border border-gray-200 px-2 py-1 text-right text-[10px] text-blue-600 w-12">予定</th>
                        <th className="border border-gray-200 px-2 py-1 text-right text-[10px] text-blue-600 w-16">予定単位</th>
                        <th className="border border-gray-200 px-2 py-1 text-right text-[10px] text-green-600 w-12">実績</th>
                        <th className="border border-gray-200 px-2 py-1 text-right text-[10px] text-green-600 w-16">実績単位</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unitSummary.map((row) => (
                        <tr key={row.service_type}>
                          <td className="border border-gray-200 px-2 py-0.5">{row.service_type}</td>
                          <td className="border border-gray-200 px-2 py-0.5 text-right tabular-nums">
                            {row.units > 0 ? row.units.toLocaleString() : "—"}
                          </td>
                          <td className="border border-gray-200 px-2 py-0.5 text-right text-blue-700 tabular-nums">
                            {row.plannedCount || ""}
                          </td>
                          <td className="border border-gray-200 px-2 py-0.5 text-right text-blue-700 tabular-nums font-semibold">
                            {row.plannedUnits > 0 ? row.plannedUnits.toLocaleString() : ""}
                          </td>
                          <td className="border border-gray-200 px-2 py-0.5 text-right text-green-700 tabular-nums">
                            {row.actualCount || ""}
                          </td>
                          <td className="border border-gray-200 px-2 py-0.5 text-right text-green-700 tabular-nums font-semibold">
                            {row.actualUnits > 0 ? row.actualUnits.toLocaleString() : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-50 font-bold text-xs">
                        <td className="border border-gray-200 px-2 py-1 text-right" colSpan={2}>所定単位 合計</td>
                        <td className="border border-gray-200 px-2 py-1 text-right text-blue-700 tabular-nums">{totalPlanned || ""}</td>
                        <td className="border border-gray-200 px-2 py-1 text-right text-blue-700 tabular-nums">{totalPlannedUnits > 0 ? totalPlannedUnits.toLocaleString() : ""}</td>
                        <td className="border border-gray-200 px-2 py-1 text-right text-green-700 tabular-nums">{totalActual || ""}</td>
                        <td className="border border-gray-200 px-2 py-1 text-right text-green-700 tabular-nums">{totalActualUnits > 0 ? totalActualUnits.toLocaleString() : ""}</td>
                      </tr>
                      {formulaAdjustments.map((a) => (
                        <tr key={a.code} className="bg-purple-50/40 text-xs">
                          <td className="border border-gray-200 px-2 py-1 text-purple-700">
                            {a.name}
                            <span className="ml-1 text-[10px] text-purple-500">({a.pct})</span>
                          </td>
                          <td className="border border-gray-200 px-2 py-1 text-right text-[10px] text-gray-400">月計×{a.pct}</td>
                          <td className="border border-gray-200 px-2 py-1" colSpan={1}></td>
                          <td className="border border-gray-200 px-2 py-1 text-right text-purple-700 tabular-nums">+{a.plannedUnits.toLocaleString()}</td>
                          <td className="border border-gray-200 px-2 py-1" colSpan={1}></td>
                          <td className="border border-gray-200 px-2 py-1 text-right text-purple-700 tabular-nums">+{a.actualUnits.toLocaleString()}</td>
                        </tr>
                      ))}
                      {/* サービス加算行 (初回/緊急時/生活機能向上。予定=実績とも同額) */}
                      {addonRows.map((a) => (
                        <tr key={`fa-${a.code}`} className="bg-purple-50/40 text-xs">
                          <td className="border border-gray-200 px-2 py-1 text-purple-700">{a.label}</td>
                          <td className="border border-gray-200 px-2 py-1 text-right text-[10px] text-gray-400">
                            {a.unit > 0 ? `${a.unit.toLocaleString()}単位${a.count > 1 ? `×${a.count}` : ""}` : "—"}
                          </td>
                          <td className="border border-gray-200 px-2 py-1"></td>
                          <td className="border border-gray-200 px-2 py-1 text-right text-purple-700 tabular-nums">+{a.units.toLocaleString()}</td>
                          <td className="border border-gray-200 px-2 py-1"></td>
                          <td className="border border-gray-200 px-2 py-1 text-right text-purple-700 tabular-nums">+{a.units.toLocaleString()}</td>
                        </tr>
                      ))}
                      {(formulaAdjustments.length > 0 || addonRows.length > 0) && (
                        <tr className="bg-gray-100 font-bold text-xs">
                          <td className="border border-gray-200 px-2 py-1 text-right" colSpan={3}>加算込み 総合計</td>
                          <td className="border border-gray-200 px-2 py-1 text-right text-blue-700 tabular-nums">{grandPlannedUnits.toLocaleString()}</td>
                          <td className="border border-gray-200 px-2 py-1" colSpan={1}></td>
                          <td className="border border-gray-200 px-2 py-1 text-right text-green-700 tabular-nums">{grandActualUnits.toLocaleString()}</td>
                        </tr>
                      )}
                    </tfoot>
                  </table>

                  {/* 適用加算 (read-only — 設定変更は /master/office) */}
                  {availableFormulaCodes.length > 0 && (
                    <div className="mt-2 rounded border border-purple-200 bg-purple-50/30 px-3 py-2">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-[11px] font-semibold text-purple-700">
                          適用中の加算 ({appliedFormulaCodes.size} / {availableFormulaCodes.length})
                        </div>
                        <a
                          href="/master/office"
                          className="text-[10px] text-blue-600 hover:underline"
                        >
                          自事業所管理で変更 →
                        </a>
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-[10px]">
                        {availableFormulaCodes
                          .filter((f) => appliedFormulaCodes.has(f.service_code))
                          .map((f) => (
                            <span
                              key={f.service_code}
                              className="rounded bg-purple-100 text-purple-800 px-1.5 py-0.5 font-medium"
                            >
                              {f.service_name}
                              {f.formula?.type === "monthly_aggregate" && (
                                <span className="ml-0.5 opacity-60">
                                  ({((f.formula.numerator / f.formula.denominator) * 100).toFixed(1).replace(/\.0$/, "")}%)
                                </span>
                              )}
                            </span>
                          ))}
                        {appliedFormulaCodes.size === 0 && (
                          <span className="text-gray-400">適用加算未設定 (マスタ管理 → 自事業所管理で選択)</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* サービス加算 (マスタ駆動の一覧) の編集は「サービス追加」モーダル +
                  加算行の × ボタンで行う。処遇改善加算は行を作らず集計のみ (上の「適用中の加算」参照)。 */}
              {!currentOfficeId && (
                <div className="no-print mt-4 max-w-2xl rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-400">
                  サービス加算の編集には事業所の選択 (?office=) が必要です
                </div>
              )}
              {addonTableMissing && currentOfficeId && (
                <div className="no-print mt-4 max-w-2xl rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  加算テーブル (kaigo_visit_addon_lines) が未作成のため、加算の保存・表示ができません。
                  migrations/kaigo_visit_addon_lines.sql を適用してください。
                </div>
              )}
            </div>
          )}
      </div>

      {/* Add service row modal */}
      {showAddRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-semibold text-gray-900">サービス行を追加</h2>
              <button onClick={() => setShowAddRow(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">開始時間</label>
                  <input type="time" value={addRowForm.start_time} onChange={(e) => {
                    const v = e.target.value;
                    setAddRowForm((f) => ({ ...f, start_time: v, end_time: f.end_time <= v ? v : f.end_time }));
                  }} className="w-full rounded-lg border border-gray-400 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">終了時間</label>
                  <input type="time" value={addRowForm.end_time} min={addRowForm.start_time} onChange={(e) => {
                    const v = e.target.value;
                    setAddRowForm((f) => ({ ...f, end_time: v < f.start_time ? f.start_time : v }));
                  }} className="w-full rounded-lg border border-gray-400 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">サービス</label>
                <button
                  type="button"
                  onClick={() => setShowAddServiceSelector(true)}
                  className="w-full flex items-center justify-between rounded-lg border border-gray-400 px-3 py-2 text-sm text-left hover:bg-gray-50"
                >
                  <span className={addRowForm.service_name ? "text-gray-900" : "text-gray-400"}>
                    {addRowForm.service_name || "サービスを選択..."}
                  </span>
                </button>
                <ServiceSelector
                  open={showAddServiceSelector}
                  onClose={() => setShowAddServiceSelector(false)}
                  startTime={addRowForm.start_time}
                  endTime={addRowForm.end_time}
                  onSelect={(service) => {
                    setAddRowForm((f) => ({ ...f, service_type: service.categoryName, service_code: service.code, service_name: service.name }));
                    setShowAddServiceSelector(false);
                  }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">担当職員</label>
                <select value={addRowForm.staff_id} onChange={(e) => setAddRowForm((f) => ({ ...f, staff_id: e.target.value }))} className="w-full rounded-lg border border-gray-400 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                  <option value="">-- 選択 --</option>
                  {allStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              {/* ── 追加職員 (2人体制・同行、主 + 最大9名) ── */}
              <AdditionalStaffSection
                rows={addRowAdditional}
                onChange={setAddRowAdditional}
                staffOptions={allStaff.map((s) => ({ id: s.id, name: s.name }))}
                mainStaffId={addRowForm.staff_id}
                mainStart={addRowForm.start_time}
                mainEnd={addRowForm.end_time}
                serviceName={addRowForm.service_name || addRowForm.service_type}
                isShogai={false}
                showCustomTime={staff2TimesSupported}
              />

              {/* ── この訪問につく加算 (kaigo_visit_addon_lines のマスタ駆動一覧) ── */}
              <ProvisionAddonChecklist
                addonTableMissing={addonTableMissing}
                currentOfficeId={currentOfficeId}
                addonOptions={addonOptions}
                selected={addRowAddons}
                onChange={setAddRowAddons}
                existingLines={addonLines}
                shokaiSuggest={shokaiSuggest}
              />
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-4">
              <button onClick={() => setShowAddRow(false)} className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">キャンセル</button>
              <button onClick={handleAddRow} className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
                <Plus size={14} /> 追加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit row modal */}
      {editRowKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-semibold text-gray-900">サービス行を編集</h2>
              <button onClick={() => setEditRowKey(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">開始時間</label>
                  <input type="time" value={editRowForm.start_time} onChange={(e) => {
                    const v = e.target.value;
                    setEditRowForm((f) => ({ ...f, start_time: v, end_time: f.end_time <= v ? v : f.end_time }));
                  }} className="w-full rounded-lg border border-gray-400 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">終了時間</label>
                  <input type="time" value={editRowForm.end_time} min={editRowForm.start_time} onChange={(e) => {
                    const v = e.target.value;
                    setEditRowForm((f) => ({ ...f, end_time: v < f.start_time ? f.start_time : v }));
                  }} className="w-full rounded-lg border border-gray-400 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">サービス</label>
                <button
                  type="button"
                  onClick={() => setShowEditServiceSelector(true)}
                  className="w-full flex items-center justify-between rounded-lg border border-gray-400 px-3 py-2 text-sm text-left hover:bg-gray-50"
                >
                  <span className={editRowForm.service_name ? "text-gray-900" : "text-gray-400"}>
                    {editRowForm.service_name || "サービスを選択..."}
                  </span>
                </button>
                <ServiceSelector
                  open={showEditServiceSelector}
                  onClose={() => setShowEditServiceSelector(false)}
                  startTime={editRowForm.start_time}
                  endTime={editRowForm.end_time}
                  onSelect={(service) => {
                    setEditRowForm((f) => ({ ...f, service_name: service.name, service_code: service.code }));
                    setShowEditServiceSelector(false);
                  }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">担当職員</label>
                <select value={editRowForm.staff_id} onChange={(e) => setEditRowForm((f) => ({ ...f, staff_id: e.target.value }))} className="w-full rounded-lg border border-gray-400 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                  <option value="">-- 選択 --</option>
                  {allStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              {/* ── 追加職員 (2人体制・同行、主 + 最大9名) ── */}
              <AdditionalStaffSection
                rows={editRowAdditional}
                onChange={setEditRowAdditional}
                staffOptions={allStaff.map((s) => ({ id: s.id, name: s.name }))}
                mainStaffId={editRowForm.staff_id}
                mainStart={editRowForm.start_time}
                mainEnd={editRowForm.end_time}
                serviceName={editRowForm.service_name}
                isShogai={false}
                showCustomTime={staff2TimesSupported}
              />
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-4">
              <button onClick={() => setEditRowKey(null)} className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">キャンセル</button>
              <button onClick={handleEditRowSave} className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
                <Save size={14} /> 変更
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 居宅介護支援事業所への月次実績送信モーダル */}
      {showSendModal && currentOffice && (
        <SendDocumentModal
          tenantId={currentOffice.tenant_id}
          client={{ id: userId, name: userData?.name ?? "利用者" }}
          sourceOfficeId={currentOffice.id}
          documentType="service_record_monthly"
          targetServiceTypes={["居宅介護支援"]}
          title={`${format(selectedMonth, "yyyy年M月", { locale: ja })} サービス提供表（実績） - ${userData?.name ?? "利用者"} 様`}
          getHtmlSnapshot={() =>
            document.getElementById("provision-ticket-print")?.outerHTML ?? ""
          }
          payload={monthlyPayload as unknown as Record<string, unknown>}
          onClose={() => setShowSendModal(false)}
          onSuccess={() => {
            setShowSendModal(false);
            toast.success("月次実績を送付しました");
          }}
          onError={(msg) => toast.error("送付失敗: " + msg)}
        />
      )}
    </>
  );
}

// ヘッダ帯の「ラベル + 値」ペア (コンパクト表示用)
function HeaderPair({
  label,
  value,
  mono,
  strong,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="whitespace-nowrap text-[10px] text-gray-500">{label}</span>
      <span className={cn("text-sm", mono && "font-mono tabular-nums", strong && "font-semibold")}>
        {value || "—"}
      </span>
    </div>
  );
}

// ─── この訪問につく加算 (kaigo_visit_addon_lines のマスタ駆動チェックリスト) ────
// その事業所のサービス種別 (訪問介護) で使える「加算」を kaigo_service_codes から
// 一覧表示し、適用チェック + 回数で選択する (ほのぼの「加算サービス項目」相当)。
// selected = { addon_code -> count } (0 or 未設定 = 非適用)。
// 減算 (calculation_type='減算') は今回は一覧に出さない (次段階)。
function ProvisionAddonChecklist({
  addonTableMissing,
  currentOfficeId,
  addonOptions,
  selected,
  onChange,
  existingLines,
  shokaiSuggest,
}: {
  addonTableMissing: boolean;
  currentOfficeId: string | null | undefined;
  addonOptions: AddonCodeOption[];
  selected: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
  existingLines: Record<string, number>;
  shokaiSuggest: boolean | null;
}) {
  const setCode = (code: string, count: number) => {
    const next = { ...selected };
    if (count <= 0) delete next[code];
    else next[code] = count;
    onChange(next);
  };
  return (
    <div className="rounded-lg border border-purple-200 bg-purple-50/40 p-3">
      <div className="mb-2 text-xs font-semibold text-purple-800">この訪問につく加算</div>
      {addonTableMissing ? (
        <p className="text-[11px] text-amber-700">
          加算テーブル (kaigo_visit_addon_lines) が未作成のため加算は保存できません。
          migrations/kaigo_visit_addon_lines.sql を適用してください。
        </p>
      ) : !currentOfficeId ? (
        <p className="text-[11px] text-gray-400">加算の保存には事業所の選択 (?office=) が必要です</p>
      ) : addonOptions.length === 0 ? (
        <p className="text-[11px] text-gray-400">対象月に有効な訪問介護の加算コードがありません</p>
      ) : (
        <div className="max-h-56 space-y-2 overflow-y-auto text-xs">
          {addonOptions.map((opt) => {
            const count = selected[opt.code] ?? 0;
            const checked = count > 0;
            const alreadyN = existingLines[opt.code] ?? 0;
            const isShokai = opt.code === SHOKAI_ADDON_CODE;
            return (
              <div key={opt.code}>
                <div className="flex items-center gap-2">
                  <label className="flex flex-1 cursor-pointer items-center gap-1.5 text-gray-700">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setCode(opt.code, e.target.checked ? Math.max(1, count) : 0)}
                      className="h-4 w-4 accent-purple-600"
                    />
                    <span className="break-words">{opt.name}</span>
                    <span className="whitespace-nowrap text-[10px] text-gray-400">
                      ({opt.units.toLocaleString()}単位)
                    </span>
                  </label>
                  {checked && (
                    <input
                      type="number"
                      min={1}
                      value={count}
                      onChange={(e) => setCode(opt.code, Math.max(1, parseInt(e.target.value, 10) || 1))}
                      className="w-14 rounded border border-gray-300 px-1.5 py-0.5 text-right text-xs"
                      title="回数"
                    />
                  )}
                  <span className="w-6 text-right text-[10px] text-gray-400">回</span>
                </div>
                {alreadyN > 0 && (
                  <p className="ml-6 mt-0.5 text-[10px] text-purple-600">
                    当月 既に {alreadyN} 回 (チェックで加算)
                  </p>
                )}
                {isShokai && shokaiSuggest === true && alreadyN === 0 && !checked && (
                  <p className="ml-6 mt-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                    候補: 過去2ヶ月に実績がありません (新規利用の可能性)
                  </p>
                )}
              </div>
            );
          })}
          <p className="text-[10px] text-gray-400">
            加算は提供表に「加算行」として表示され、請求集計に反映されます (処遇改善加算は集計のみで行は作りません。減算は次段階)。
          </p>
        </div>
      )}
    </div>
  );
}
