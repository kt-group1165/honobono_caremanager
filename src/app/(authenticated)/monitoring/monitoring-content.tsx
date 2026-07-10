"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  FileText,
  Loader2,
  Save,
  Printer,
  Plus,
  ArrowLeft,
  ClipboardList,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KaigoUser {
  id: string;
  name: string;
  name_kana: string | null;
}

interface CarePlanService {
  id: string;
  care_plan_id: string;
  service_type: string;
  service_content: string;
  frequency: string | null;
  provider: string | null;
}

interface CarePlan {
  id: string;
  user_id: string;
  status: string;
  short_term_goals: string | null;
  start_date: string | null;
  end_date: string | null;
  kaigo_care_plan_services: CarePlanService[];
}

type MonitoringStatus = "draft" | "completed";

export interface MonitoringSheet {
  id: string;
  user_id: string;
  monitoring_date: string;
  assessor_name: string;
  status: MonitoringStatus;
  care_plan_id: string | null;
  created_at: string;
  form_type?: "要介護" | "予防" | null;
}

// ─── 予防版（介護予防支援モニタリング）──────────────────────────────────────
// 要支援1/2・事業対象者 向け。頻度=少なくとも3月に1回＋サービス評価期間終了月。
// 様式が要介護と全く異なるため kaigo_monitoring_sheets.preventive_content(jsonb) に格納。

type PreventiveMonitoringType = "通常" | "サービス評価期間終了" | "状態変化時";
type ContinuationDecision = "継続" | "変更" | "終了" | "";
type PreventiveAchievement = "達成" | "一部達成" | "未達成" | "";

interface PreventiveGoal {
  goal: string; // 目標（本人等のセルフケア・支援内容）
  period: string; // 期間（テキスト）
  service: string; // 本人・家族・地域の取組／サービス
  achievement: PreventiveAchievement; // 達成状況
  evaluation: string; // 評価・今後の方針
}

interface PreventiveContent {
  office_name: string;
  evaluation_period_start: string;
  evaluation_period_end: string;
  monitoring_type: PreventiveMonitoringType;
  next_monitoring_date: string;
  overall_evaluation: string; // 総合的な評価・支援経過
  user_family_intention: string; // 本人・家族の意向
  continuation_decision: ContinuationDecision; // サービス継続の要否
  continuation_reason: string;
  goals: PreventiveGoal[];
}

const PREVENTIVE_ROWS = 5;

function emptyPreventiveGoal(): PreventiveGoal {
  return { goal: "", period: "", service: "", achievement: "", evaluation: "" };
}

function emptyPreventiveContent(): PreventiveContent {
  return {
    office_name: "",
    evaluation_period_start: "",
    evaluation_period_end: "",
    monitoring_type: "通常",
    next_monitoring_date: "",
    overall_evaluation: "",
    user_family_intention: "",
    continuation_decision: "",
    continuation_reason: "",
    goals: Array.from({ length: PREVENTIVE_ROWS }, emptyPreventiveGoal),
  };
}

/** 保存済 jsonb を安全に PreventiveContent へ正規化（欠損キー・型崩れを吸収） */
function normalizePreventiveContent(raw: unknown): PreventiveContent {
  const base = emptyPreventiveContent();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const goalsRaw = Array.isArray(r.goals) ? r.goals : [];
  const goals: PreventiveGoal[] = goalsRaw.map((g) => {
    const gg = (g && typeof g === "object" ? g : {}) as Record<string, unknown>;
    return {
      goal: typeof gg.goal === "string" ? gg.goal : "",
      period: typeof gg.period === "string" ? gg.period : "",
      service: typeof gg.service === "string" ? gg.service : "",
      achievement: (["達成", "一部達成", "未達成"].includes(gg.achievement as string)
        ? (gg.achievement as PreventiveAchievement)
        : "") as PreventiveAchievement,
      evaluation: typeof gg.evaluation === "string" ? gg.evaluation : "",
    };
  });
  while (goals.length < PREVENTIVE_ROWS) goals.push(emptyPreventiveGoal());
  return {
    office_name: typeof r.office_name === "string" ? r.office_name : "",
    evaluation_period_start:
      typeof r.evaluation_period_start === "string" ? r.evaluation_period_start : "",
    evaluation_period_end:
      typeof r.evaluation_period_end === "string" ? r.evaluation_period_end : "",
    monitoring_type: (["通常", "サービス評価期間終了", "状態変化時"].includes(
      r.monitoring_type as string
    )
      ? (r.monitoring_type as PreventiveMonitoringType)
      : "通常") as PreventiveMonitoringType,
    next_monitoring_date:
      typeof r.next_monitoring_date === "string" ? r.next_monitoring_date : "",
    overall_evaluation:
      typeof r.overall_evaluation === "string" ? r.overall_evaluation : "",
    user_family_intention:
      typeof r.user_family_intention === "string" ? r.user_family_intention : "",
    continuation_decision: (["継続", "変更", "終了"].includes(
      r.continuation_decision as string
    )
      ? (r.continuation_decision as ContinuationDecision)
      : "") as ContinuationDecision,
    continuation_reason:
      typeof r.continuation_reason === "string" ? r.continuation_reason : "",
    goals,
  };
}

/** ケアプラン選択タブ表示用の軽量型 */
export interface CarePlanSummary {
  id: string;
  plan_number: string | null;
  plan_type: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  short_term_goals: string | null;
}

// Exactly mirrors kaigo_monitoring_items columns
interface MonitoringItem {
  id?: string;
  monitoring_sheet_id?: string;
  item_number: number; // 1-6
  // Left half
  short_term_goal: string;
  goal_period_start: string;
  goal_period_end: string;
  service_type: string;
  provider_name: string;
  implementation_status: string;
  // Right half
  user_satisfaction: "満足" | "不満" | "";
  family_satisfaction: "満足" | "不満" | "";
  satisfaction_comment: string;
  achievement: "達成した" | "ほぼ達成" | "未達成" | "";
  adl_change: "良い変化" | "不変" | "悪化" | "";
  plan_revision_needed: "あり" | "なし" | "";
  revision_reason: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FIXED_ROWS = 6;

const STATUS_CONFIG: Record<MonitoringStatus, { label: string; cls: string }> =
  {
    draft: { label: "下書き", cls: "bg-yellow-100 text-yellow-700" },
    completed: { label: "完了", cls: "bg-green-100 text-green-700" },
  };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toWareki(dateStr: string): string {
  if (!dateStr) return "";
  const d = parseISO(dateStr);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if (y > 2019 || (y === 2019 && m >= 5)) {
    return `令和${y - 2018}年${m}月${day}日`;
  }
  if (y >= 1989) {
    return `平成${y - 1988}年${m}月${day}日`;
  }
  return `${y}年${m}月${day}日`;
}

function formatPeriod(start: string, end: string): string {
  const s = start
    ? format(parseISO(start), "yyyy/MM/dd", { locale: ja })
    : "";
  const e = end ? format(parseISO(end), "yyyy/MM/dd", { locale: ja }) : "";
  if (!s && !e) return "";
  if (s && e) return `${s}〜\n${e}`;
  return s || e;
}

function emptyItem(num: number): MonitoringItem {
  return {
    item_number: num,
    short_term_goal: "",
    goal_period_start: "",
    goal_period_end: "",
    service_type: "",
    provider_name: "",
    implementation_status: "",
    user_satisfaction: "",
    family_satisfaction: "",
    satisfaction_comment: "",
    achievement: "",
    adl_change: "",
    plan_revision_needed: "",
    revision_reason: "",
  };
}

function buildFixedRows(source: MonitoringItem[]): MonitoringItem[] {
  const rows: MonitoringItem[] = [];
  for (let i = 1; i <= FIXED_ROWS; i++) {
    const found = source.find((it) => it.item_number === i);
    rows.push(found ?? emptyItem(i));
  }
  return rows;
}

// ─── Small UI helpers ─────────────────────────────────────────────────────────

function RadioGroup<T extends string>({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options: { label: string; value: T }[];
  value: T | "";
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {options.map((opt) => (
        <label
          key={opt.value}
          className="flex items-center gap-1 cursor-pointer text-xs"
        >
          <input
            type="radio"
            name={name}
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            className="accent-blue-600"
          />
          {opt.label}
        </label>
      ))}
    </div>
  );
}

function CheckboxPair({
  label,
  value,
  onChange,
}: {
  label: string;
  value: "満足" | "不満" | "";
  onChange: (v: "満足" | "不満" | "") => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs whitespace-nowrap mb-0.5">
      {/* ラベルを固定幅にしてチェックボックス列を全行で縦に揃える */}
      <span className="w-12 shrink-0 text-gray-500">{label}：</span>
      <label className="inline-flex items-center gap-0.5 cursor-pointer">
        <input type="checkbox" checked={value === "満足"} onChange={() => onChange(value === "満足" ? "" : "満足")} className="accent-blue-600 h-3 w-3" />
        <span>満足</span>
      </label>
      <label className="inline-flex items-center gap-0.5 cursor-pointer">
        <input type="checkbox" checked={value === "不満"} onChange={() => onChange(value === "不満" ? "" : "不満")} className="accent-blue-600 h-3 w-3" />
        <span>不満</span>
      </label>
    </div>
  );
}

// ─── Print mark helpers ───────────────────────────────────────────────────────

function PrintCheck({ checked }: { checked: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: "9pt",
        height: "9pt",
        border: "0.8pt solid #333",
        textAlign: "center",
        lineHeight: "9pt",
        fontSize: "7pt",
        marginRight: "1pt",
      }}
    >
      {checked ? "✓" : ""}
    </span>
  );
}

function PrintRadio({ checked }: { checked: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: "9pt",
        height: "9pt",
        borderRadius: "50%",
        border: "0.8pt solid #333",
        textAlign: "center",
        lineHeight: "9pt",
        fontSize: "6pt",
        marginRight: "1pt",
      }}
    >
      {checked ? "●" : ""}
    </span>
  );
}

export interface MonitoringContentProps {
  userId: string;
  initialUser: KaigoUser | null;
  initialCarePlans: CarePlanSummary[];
  initialSheets: MonitoringSheet[];
  /** 要支援1/2・事業対象者 = 介護予防支援モニタリング様式に分岐 */
  isPreventive?: boolean;
  careLevel?: string | null;
}

export function MonitoringContent({
  userId,
  initialUser,
  initialCarePlans,
  initialSheets,
  isPreventive = false,
  careLevel = null,
}: MonitoringContentProps) {
  const supabase = useMemo(() => createClient(), []);

  const [selectedUser] = useState<KaigoUser | null>(initialUser);

  // Care plan selection
  const [carePlans] = useState<CarePlanSummary[]>(initialCarePlans);
  const [selectedCarePlanId, setSelectedCarePlanId] = useState<string | null>(() => {
    if (initialCarePlans.length === 0) return null;
    const active = initialCarePlans.find((p) => p.status === "active");
    return active?.id ?? initialCarePlans[0].id;
  });

  // List
  const [sheets, setSheets] = useState<MonitoringSheet[]>(initialSheets);
  const [loadingSheets, setLoadingSheets] = useState(false);

  // Edit
  const [mode, setMode] = useState<"list" | "edit">("list");
  const [editingSheetId, setEditingSheetId] = useState<string | null>(null);
  const [monitoringDate, setMonitoringDate] = useState(
    format(new Date(), "yyyy-MM-dd")
  );
  const [officeName, setOfficeName] = useState("");
  const [assessorName, setAssessorName] = useState("");
  const [sheetStatus, setSheetStatus] = useState<MonitoringStatus>("draft");
  const [items, setItems] = useState<MonitoringItem[]>(
    Array.from({ length: FIXED_ROWS }, (_, i) => emptyItem(i + 1))
  );
  // 予防様式の入力値（isPreventive のときのみ使用）
  const [prev, setPrev] = useState<PreventiveContent>(() => emptyPreventiveContent());
  const [saving, setSaving] = useState(false);
  const [loadingCarePlan, setLoadingCarePlan] = useState(false);

  const updatePrev = useCallback((patch: Partial<PreventiveContent>) => {
    setPrev((p) => ({ ...p, ...patch }));
  }, []);
  const updatePrevGoal = useCallback(
    (idx: number, patch: Partial<PreventiveGoal>) => {
      setPrev((p) => ({
        ...p,
        goals: p.goals.map((g, i) => (i === idx ? { ...g, ...patch } : g)),
      }));
    },
    []
  );

  // 自動移行 (kaigo_care_plans が空でも帳票画面の計画書から復元) は server で実施済み

  // ── Sheet list ───────────────────────────────────────────────────────────────

  const fetchSheets = useCallback(async () => {
    setLoadingSheets(true);
    let query = supabase
      .from("kaigo_monitoring_sheets")
      .select(
        "id, user_id, monitoring_date, assessor_name, status, care_plan_id, created_at, form_type"
      )
      .eq("user_id", userId)
      .order("monitoring_date", { ascending: false });

    if (selectedCarePlanId) {
      query = query.eq("care_plan_id", selectedCarePlanId);
    }

    const { data, error } = await query;
    if (error) {
      toast.error("モニタリングシートの取得に失敗しました: " + error.message);
    } else {
      setSheets((data as MonitoringSheet[]) ?? []);
    }
    setLoadingSheets(false);
  }, [supabase, userId, selectedCarePlanId]);

  // initial render は server からの initialSheets を使用、carePlan 切替時のみ refetch
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    fetchSheets();
  }, [fetchSheets]);

  // ── Care plan auto-fill ──────────────────────────────────────────────────────

  const loadCarePlanItems = useCallback(async () => {
    if (!selectedCarePlanId) {
      toast.info("対応する計画期間を先に選択してください");
      return;
    }
    setLoadingCarePlan(true);
    try {
      const { data: plan, error } = await supabase
        .from("kaigo_care_plans")
        .select(
          "id, user_id, status, short_term_goals, start_date, end_date, kaigo_care_plan_services(*)"
        )
        .eq("id", selectedCarePlanId)
        .single();

      if (error) throw error;
      if (!plan) {
        toast.info("ケアプランが見つかりません");
        return;
      }

      const p = plan as CarePlan;
      const services = p.kaigo_care_plan_services ?? [];
      const sourced: MonitoringItem[] = [];
      let num = 1;

      if (services.length === 0) {
        sourced.push({
          ...emptyItem(num),
          short_term_goal: p.short_term_goals ?? "",
          goal_period_start: p.start_date ?? "",
          goal_period_end: p.end_date ?? "",
        });
      } else {
        for (const svc of services) {
          if (num > FIXED_ROWS) break;
          sourced.push({
            ...emptyItem(num),
            short_term_goal: p.short_term_goals ?? "",
            goal_period_start: p.start_date ?? "",
            goal_period_end: p.end_date ?? "",
            service_type: svc.service_type ?? "",
            provider_name: svc.provider ?? "",
          });
          num++;
        }
      }

      setItems(buildFixedRows(sourced));
      toast.success("ケアプランからサービス情報を読み込みました");
    } catch (err: unknown) {
      toast.error(
        "ケアプランの読み込みに失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoadingCarePlan(false);
    }
  }, [supabase, selectedCarePlanId]);

  // ── Open new ─────────────────────────────────────────────────────────────────

  const openNew = async () => {
    if (!selectedCarePlanId) {
      toast.error("先に対応するケアプラン期間を選択してください");
      return;
    }
    setEditingSheetId(null);
    setMonitoringDate(format(new Date(), "yyyy-MM-dd"));
    setOfficeName("");
    setAssessorName("");
    setSheetStatus("draft");
    setItems(Array.from({ length: FIXED_ROWS }, (_, i) => emptyItem(i + 1)));
    setPrev(emptyPreventiveContent());
    setMode("edit");

    // 選択されたケアプランから短期目標・サービス情報を自動セット
    setLoadingCarePlan(true);
    try {
      const { data: plan, error } = await supabase
        .from("kaigo_care_plans")
        .select(
          "id, user_id, status, short_term_goals, start_date, end_date, kaigo_care_plan_services(*)"
        )
        .eq("id", selectedCarePlanId)
        .single();

      if (!error && plan) {
        const p = plan as CarePlan;
        const services = p.kaigo_care_plan_services ?? [];
        const sourced: MonitoringItem[] = [];
        let num = 1;
        if (services.length === 0) {
          sourced.push({
            ...emptyItem(num),
            short_term_goal: p.short_term_goals ?? "",
            goal_period_start: p.start_date ?? "",
            goal_period_end: p.end_date ?? "",
          });
        } else {
          for (const svc of services) {
            if (num > FIXED_ROWS) break;
            sourced.push({
              ...emptyItem(num),
              short_term_goal: p.short_term_goals ?? "",
              goal_period_start: p.start_date ?? "",
              goal_period_end: p.end_date ?? "",
              service_type: svc.service_type ?? "",
              provider_name: svc.provider ?? "",
            });
            num++;
          }
        }
        if (sourced.length > 0) setItems(buildFixedRows(sourced));

        // 予防様式: 目標・サービスを予防 goals に流し込む（期間はプランの評価期間）
        if (isPreventive) {
          const pStart = p.start_date ?? "";
          const pEnd = p.end_date ?? "";
          const periodText =
            pStart || pEnd ? `${pStart || ""}〜${pEnd || ""}` : "";
          const pGoals: PreventiveGoal[] = services.slice(0, PREVENTIVE_ROWS).map((svc) => ({
            ...emptyPreventiveGoal(),
            goal: p.short_term_goals ?? "",
            period: periodText,
            service: svc.service_type ?? "",
          }));
          while (pGoals.length < PREVENTIVE_ROWS) pGoals.push(emptyPreventiveGoal());
          setPrev((prevState) => ({
            ...prevState,
            evaluation_period_start: pStart,
            evaluation_period_end: pEnd,
            goals: services.length > 0 ? pGoals : prevState.goals,
          }));
        }
      }
    } catch (err) {
      // 自動セットの失敗は致命的ではないので warn のみ (= UI は空のままで openNew は継続)
      console.warn("openNew care-plan auto-fill failed:", err instanceof Error ? err.message : err);
    } finally {
      setLoadingCarePlan(false);
    }
  };

  // ── Open existing ────────────────────────────────────────────────────────────

  const openEdit = async (sheet: MonitoringSheet) => {
    setEditingSheetId(sheet.id);
    setMonitoringDate(sheet.monitoring_date);
    setAssessorName(sheet.assessor_name);
    setSheetStatus(sheet.status);
    if (sheet.care_plan_id) setSelectedCarePlanId(sheet.care_plan_id);

    // 予防様式: preventive_content(jsonb) を読み込む（items テーブルは使わない）
    if (sheet.form_type === "予防") {
      const { data: row, error: pErr } = await supabase
        .from("kaigo_monitoring_sheets")
        .select("preventive_content")
        .eq("id", sheet.id)
        .maybeSingle();
      if (pErr) {
        toast.error("予防様式の読み込みに失敗しました: " + pErr.message);
        return;
      }
      const content = normalizePreventiveContent(
        (row as { preventive_content: unknown } | null)?.preventive_content
      );
      setPrev(content);
      setOfficeName(content.office_name);
      setMode("edit");
      return;
    }

    const { data: dbItems, error } = await supabase
      .from("kaigo_monitoring_items")
      .select("*")
      .eq("monitoring_sheet_id", sheet.id)
      .order("item_number");

    if (error) {
      toast.error("項目の読み込みに失敗しました: " + error.message);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
    const mapped: MonitoringItem[] = (dbItems ?? []).map((r: any) => ({
      id: r.id,
      monitoring_sheet_id: r.monitoring_sheet_id,
      item_number: r.item_number,
      short_term_goal: r.short_term_goal ?? "",
      goal_period_start: r.goal_period_start ?? "",
      goal_period_end: r.goal_period_end ?? "",
      service_type: r.service_type ?? "",
      provider_name: r.provider_name ?? "",
      implementation_status: r.implementation_status ?? "",
      user_satisfaction: r.user_satisfaction ?? "",
      family_satisfaction: r.family_satisfaction ?? "",
      satisfaction_comment: r.satisfaction_comment ?? "",
      achievement: r.achievement ?? "",
      adl_change: r.adl_change ?? "",
      plan_revision_needed: r.plan_revision_needed ?? "",
      revision_reason: r.revision_reason ?? "",
    }));

    setItems(buildFixedRows(mapped));
    setMode("edit");
  };

  // ── Item update ──────────────────────────────────────────────────────────────

  const updateItem = (num: number, patch: Partial<MonitoringItem>) => {
    setItems((prev) =>
      prev.map((item) =>
        item.item_number === num ? { ...item, ...patch } : item
      )
    );
  };

  // ── Save ─────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    try {
      // ── 予防様式 (要支援1/2・事業対象者) ──────────────────────────────
      if (isPreventive) {
        const content: PreventiveContent = { ...prev, office_name: officeName };
        if (editingSheetId) {
          const { error } = await supabase
            .from("kaigo_monitoring_sheets")
            .update({
              monitoring_date: monitoringDate,
              assessor_name: assessorName,
              status: sheetStatus,
              care_plan_id: selectedCarePlanId,
              form_type: "予防",
              preventive_content: content,
            })
            .eq("id", editingSheetId);
          if (error) throw error;
        } else {
          const { data, error } = await supabase
            .from("kaigo_monitoring_sheets")
            .insert({
              user_id: userId,
              monitoring_date: monitoringDate,
              assessor_name: assessorName,
              status: sheetStatus,
              care_plan_id: selectedCarePlanId,
              form_type: "予防",
              preventive_content: content,
            })
            .select("id")
            .single();
          if (error) throw error;
          setEditingSheetId(data.id);
        }
        toast.success("介護予防支援モニタリングを保存しました");
        setSaving(false);
        return;
      }

      let sheetId = editingSheetId;

      if (sheetId) {
        const { error } = await supabase
          .from("kaigo_monitoring_sheets")
          .update({
            monitoring_date: monitoringDate,
            assessor_name: assessorName,
            status: sheetStatus,
            care_plan_id: selectedCarePlanId,
          })
          .eq("id", sheetId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("kaigo_monitoring_sheets")
          .insert({
            user_id: userId,
            monitoring_date: monitoringDate,
            assessor_name: assessorName,
            status: sheetStatus,
            care_plan_id: selectedCarePlanId,
            form_type: "要介護",
          })
          .select("id")
          .single();
        if (error) throw error;
        sheetId = data.id;
        setEditingSheetId(sheetId);
      }

      const { error: delError } = await supabase
        .from("kaigo_monitoring_items")
        .delete()
        .eq("monitoring_sheet_id", sheetId);
      if (delError) throw delError;

      // Save all 6 rows
      const rows = items.map((item) => ({
        monitoring_sheet_id: sheetId,
        item_number: item.item_number,
        short_term_goal: item.short_term_goal || null,
        goal_period_start: item.goal_period_start || null,
        goal_period_end: item.goal_period_end || null,
        service_type: item.service_type || null,
        provider_name: item.provider_name || null,
        implementation_status: item.implementation_status || null,
        user_satisfaction: item.user_satisfaction || null,
        family_satisfaction: item.family_satisfaction || null,
        satisfaction_comment: item.satisfaction_comment || null,
        achievement: item.achievement || null,
        adl_change: item.adl_change || null,
        plan_revision_needed: item.plan_revision_needed || null,
        revision_reason: item.revision_reason || null,
      }));

      const { error: insError } = await supabase
        .from("kaigo_monitoring_items")
        .insert(rows);
      if (insError) throw insError;

      toast.success("モニタリングシートを保存しました");
    } catch (err: unknown) {
      toast.error(
        "保存に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Print styles ── */}
      <style>{`
        @media print {
          body > * { display: none !important; }
          #monitoring-print-root { display: block !important; }
          #monitoring-print-root { position: fixed; inset: 0; background: white; font-family: "MS Mincho", "ＭＳ 明朝", "Noto Serif JP", serif; }
          @page { size: A4 portrait; margin: 8mm; }
          .no-print { display: none !important; }
        }
        @media screen {
          #monitoring-print-root { display: none; }
        }
      `}</style>

      <div className="flex-1 overflow-y-auto p-6 no-print">
          {/* ── LIST MODE ── */}
          {mode === "list" && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ClipboardList className="text-blue-600" size={24} />
                  <h1 className="text-xl font-bold text-gray-900">
                    {isPreventive
                      ? "介護予防支援モニタリング"
                      : "モニタリングシート"}
                  </h1>
                  {selectedUser && (
                    <span className="text-gray-500 text-sm">
                      — {selectedUser.name} 様
                      {isPreventive && careLevel ? `（${careLevel}）` : ""}
                    </span>
                  )}
                </div>
                <button
                  onClick={openNew}
                  disabled={!selectedCarePlanId}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  title={!selectedCarePlanId ? "ケアプラン期間を選択してください" : ""}
                >
                  <Plus size={16} />
                  新規作成
                </button>
              </div>

              {/* 要介護版: 当月未実施の警告 (運営基準: 月1回の利用者宅訪問+モニタリング記録。
                  未実施は運営基準減算リスク — 監査M-7) */}
              {!isPreventive && (() => {
                const thisMonth = format(new Date(), "yyyy-MM");
                const hasThisMonth = sheets.some((s) => (s.monitoring_date ?? "").startsWith(thisMonth));
                if (hasThisMonth) return null;
                return (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    <span className="font-semibold">今月（{thisMonth}）のモニタリングが未登録です。</span>
                    要介護者は<span className="font-bold">月1回以上の利用者宅訪問とモニタリング記録</span>が運営基準です（未実施は運営基準減算の対象）。
                  </div>
                );
              })()}

              {/* 予防版: 頻度ガイド */}
              {isPreventive && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                  <span className="font-semibold">介護予防支援モニタリングの頻度</span>
                  ：少なくとも
                  <span className="font-bold">3月に1回</span>
                  、及び<span className="font-bold">サービス評価期間が終了する月</span>
                  に実施します（利用者の状態に著しい変化があったときは、その都度）。
                </div>
              )}

              {/* ケアプラン期間タブ */}
              {carePlans.length === 0 ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  有効なケアプランがありません。先にケアプランを作成してください。
                </div>
              ) : (
                <div>
                  <div className="text-xs text-gray-500 mb-1">対応する計画期間を選択</div>
                  <div className="border-b border-gray-200 overflow-x-auto">
                    <div className="flex gap-1 min-w-max">
                      {carePlans.map((plan) => {
                        const isActive = selectedCarePlanId === plan.id;
                        const fmt = (d: string | null) =>
                          d ? format(parseISO(d), "yyyy/M/d") : "—";
                        return (
                          <button
                            key={plan.id}
                            onClick={() => setSelectedCarePlanId(plan.id)}
                            className={`flex flex-col items-start px-4 py-2 text-xs border-b-2 whitespace-nowrap transition-colors ${
                              isActive
                                ? "border-blue-600 text-blue-700 bg-blue-50 font-semibold"
                                : "border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                            }`}
                          >
                            <span className="font-bold">
                              {plan.plan_type ?? "ケアプラン"}
                              {plan.plan_number && (
                                <span className="ml-1 font-normal text-gray-500">
                                  #{plan.plan_number}
                                </span>
                              )}
                              {plan.status === "active" && (
                                <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                                  有効
                                </span>
                              )}
                            </span>
                            <span className="text-[10px] text-gray-500 mt-0.5">
                              {fmt(plan.start_date)} 〜 {fmt(plan.end_date)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {loadingSheets ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 size={24} className="animate-spin text-blue-500" />
                </div>
              ) : sheets.length === 0 ? (
                <div className="rounded-lg border bg-white py-16 text-center shadow-sm">
                  <FileText size={40} className="mx-auto mb-3 text-gray-300" />
                  <p className="text-sm text-gray-500">
                    まだモニタリングシートがありません
                  </p>
                  <button
                    onClick={openNew}
                    className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
                  >
                    <Plus size={14} />
                    新規作成
                  </button>
                </div>
              ) : (
                <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold text-gray-600">
                          モニタリング日
                        </th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-600">
                          作成者
                        </th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-600">
                          ステータス
                        </th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-600">
                          作成日時
                        </th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {sheets.map((sheet) => {
                        const sc = STATUS_CONFIG[sheet.status];
                        return (
                          <tr
                            key={sheet.id}
                            className="hover:bg-gray-50 transition-colors"
                          >
                            <td className="px-4 py-3 font-medium">
                              {sheet.monitoring_date
                                ? format(
                                    parseISO(sheet.monitoring_date),
                                    "yyyy年M月d日",
                                    { locale: ja }
                                  )
                                : "—"}
                            </td>
                            <td className="px-4 py-3 text-gray-700">
                              {sheet.assessor_name || "—"}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${sc.cls}`}
                              >
                                {sc.label}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-500 text-xs">
                              {format(
                                parseISO(sheet.created_at),
                                "yyyy/MM/dd HH:mm",
                                { locale: ja }
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button
                                onClick={() => openEdit(sheet)}
                                className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 transition-colors"
                              >
                                開く
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── EDIT MODE (要介護様式) ── */}
          {mode === "edit" && !isPreventive && (
            <div className="space-y-5">
              {/* Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setMode("list")}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    <ArrowLeft size={14} />
                    一覧に戻る
                  </button>
                  <ClipboardList className="text-blue-600" size={22} />
                  <h1 className="text-lg font-bold text-gray-900">
                    モニタリングシート
                    {selectedUser && (
                      <span className="ml-2 text-gray-500 text-sm font-normal">
                        {selectedUser.name} 様
                      </span>
                    )}
                  </h1>
                  {(() => {
                    const plan = carePlans.find((p) => p.id === selectedCarePlanId);
                    if (!plan) return null;
                    const fmt = (d: string | null) => (d ? format(parseISO(d), "yyyy/M/d") : "—");
                    return (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs text-blue-700">
                        <FileText size={10} />
                        対象計画期間: {fmt(plan.start_date)} 〜 {fmt(plan.end_date)}
                      </span>
                    );
                  })()}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={loadCarePlanItems}
                    disabled={loadingCarePlan}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
                    title="有効なケアプランから項目を再読み込み"
                  >
                    {loadingCarePlan ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <FileText size={14} />
                    )}
                    ケアプラン再読込
                  </button>
                  <button
                    onClick={handlePrint}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    <Printer size={14} />
                    印刷
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {saving ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Save size={14} />
                    )}
                    保存
                  </button>
                </div>
              </div>

              {/* Header fields */}
              <div className="rounded-lg border bg-white shadow-sm p-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      利用者名
                    </label>
                    <div className="rounded-lg border bg-gray-50 px-3 py-2 text-sm text-gray-700">
                      {selectedUser?.name ?? "—"} 殿
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      モニタリング実施日
                    </label>
                    <input
                      type="date"
                      value={monitoringDate}
                      onChange={(e) => setMonitoringDate(e.target.value)}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      居宅介護支援事業所名
                    </label>
                    <input
                      type="text"
                      value={officeName}
                      onChange={(e) => setOfficeName(e.target.value)}
                      placeholder="事業所名"
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      居宅サービス計画書作成者
                    </label>
                    <input
                      type="text"
                      value={assessorName}
                      onChange={(e) => setAssessorName(e.target.value)}
                      placeholder="担当ケアマネ名"
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <div className="mt-3">
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    ステータス
                  </label>
                  <select
                    value={sheetStatus}
                    onChange={(e) =>
                      setSheetStatus(e.target.value as MonitoringStatus)
                    }
                    className="rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="draft">下書き</option>
                    <option value="completed">完了</option>
                  </select>
                </div>
              </div>

              {/* Items table — screen version */}
              <div className="rounded-lg border bg-white shadow-sm overflow-x-auto">
                <table className="w-full border-collapse text-xs" style={{ minWidth: 1200 }}>
                  <thead>
                    {/* Group row */}
                    <tr>
                      <th
                        className="border border-gray-300 px-2 py-1.5 text-center bg-gray-100 text-gray-700"
                        rowSpan={2}
                        style={{ width: 30 }}
                      >
                        No
                      </th>
                      <th
                        className="border border-gray-300 px-2 py-1.5 text-center bg-blue-50 text-blue-800 font-semibold"
                        colSpan={5}
                      >
                        居宅サービス計画の実施状況
                      </th>
                      <th
                        className="border border-gray-300 px-2 py-1.5 text-center bg-green-50 text-green-800 font-semibold"
                        colSpan={5}
                      >
                        居宅サービス計画の達成度と評価
                      </th>
                    </tr>
                    {/* Column label row */}
                    <tr className="text-[11px] bg-gray-50">
                      <th className="border border-gray-300 px-1 py-1 text-gray-600 bg-blue-50/40" style={{ width: 140 }}>
                        短期目標
                      </th>
                      <th className="border border-gray-300 px-1 py-1 text-gray-600 bg-blue-50/40" style={{ width: 140 }}>
                        期間
                      </th>
                      <th className="border border-gray-300 px-1 py-1 text-gray-600 bg-blue-50/40" style={{ width: 110 }}>
                        サービス種別
                      </th>
                      <th className="border border-gray-300 px-1 py-1 text-gray-600 bg-blue-50/40" style={{ width: 110 }}>
                        事業所名
                      </th>
                      <th className="border border-gray-300 px-1 py-1 text-gray-600 bg-blue-50/40" style={{ width: 150 }}>
                        実施状況・トラブル状況
                      </th>
                      <th className="border border-gray-300 px-1 py-1 text-gray-600 bg-green-50/40" style={{ width: 140 }}>
                        利用者・家族の満足と意見
                      </th>
                      <th className="border border-gray-300 px-1 py-1 text-gray-600 bg-green-50/40" style={{ width: 110 }}>
                        達成度評価
                      </th>
                      <th className="border border-gray-300 px-1 py-1 text-gray-600 bg-green-50/40" style={{ width: 110 }}>
                        ADL・IADL変化
                      </th>
                      <th className="border border-gray-300 px-1 py-1 text-gray-600 bg-green-50/40" style={{ width: 80 }}>
                        プラン修正
                        <br />の必要性
                      </th>
                      <th className="border border-gray-300 px-1 py-1 text-gray-600 bg-green-50/40" style={{ width: 160 }}>
                        その理由/今後の方針・新たな目標
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr
                        key={item.item_number}
                        className={
                          item.item_number % 2 === 0
                            ? "bg-gray-50/40"
                            : "bg-white"
                        }
                      >
                        <td className="border border-gray-200 px-1 py-1.5 text-center font-bold text-gray-600 align-top text-sm">
                          {item.item_number}
                        </td>
                        {/* 短期目標 */}
                        <td className="border border-gray-200 px-1 py-1.5 align-top">
                          <textarea
                            value={item.short_term_goal}
                            onChange={(e) =>
                              updateItem(item.item_number, {
                                short_term_goal: e.target.value,
                              })
                            }
                            rows={3}
                            className="w-full resize-none bg-transparent text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 focus:rounded px-0.5"
                            placeholder="短期目標"
                          />
                        </td>
                        {/* 期間 */}
                        <td className="border border-gray-200 px-1 py-1.5 align-top">
                          <div className="flex flex-col gap-1">
                            <input
                              type="date"
                              value={item.goal_period_start}
                              onChange={(e) =>
                                updateItem(item.item_number, {
                                  goal_period_start: e.target.value,
                                })
                              }
                              className="w-full rounded border px-1 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
                            />
                            <span className="text-center text-gray-400 text-[10px]">
                              〜
                            </span>
                            <input
                              type="date"
                              value={item.goal_period_end}
                              onChange={(e) =>
                                updateItem(item.item_number, {
                                  goal_period_end: e.target.value,
                                })
                              }
                              className="w-full rounded border px-1 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
                            />
                          </div>
                        </td>
                        {/* サービス種別 */}
                        <td className="border border-gray-200 px-1 py-1.5 align-top">
                          <input
                            type="text"
                            value={item.service_type}
                            onChange={(e) =>
                              updateItem(item.item_number, {
                                service_type: e.target.value,
                              })
                            }
                            className="w-full rounded border px-1 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
                            placeholder="サービス種別"
                          />
                        </td>
                        {/* 事業所名 */}
                        <td className="border border-gray-200 px-1 py-1.5 align-top">
                          <input
                            type="text"
                            value={item.provider_name}
                            onChange={(e) =>
                              updateItem(item.item_number, {
                                provider_name: e.target.value,
                              })
                            }
                            className="w-full rounded border px-1 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
                            placeholder="事業所名"
                          />
                        </td>
                        {/* 実施状況 */}
                        <td className="border border-gray-200 px-1 py-1.5 align-top">
                          <textarea
                            value={item.implementation_status}
                            onChange={(e) =>
                              updateItem(item.item_number, {
                                implementation_status: e.target.value,
                              })
                            }
                            rows={3}
                            className="w-full resize-none bg-transparent text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 focus:rounded px-0.5"
                            placeholder="実施状況・トラブル状況"
                          />
                        </td>
                        {/* 利用者・家族の満足 */}
                        <td className="border border-gray-200 px-2 py-1.5 align-top">
                          <CheckboxPair
                            label="利用者"
                            value={item.user_satisfaction}
                            onChange={(v) =>
                              updateItem(item.item_number, {
                                user_satisfaction: v,
                              })
                            }
                          />
                          <CheckboxPair
                            label="家族"
                            value={item.family_satisfaction}
                            onChange={(v) =>
                              updateItem(item.item_number, {
                                family_satisfaction: v,
                              })
                            }
                          />
                          <textarea
                            value={item.satisfaction_comment}
                            onChange={(e) =>
                              updateItem(item.item_number, {
                                satisfaction_comment: e.target.value,
                              })
                            }
                            rows={2}
                            className="mt-1 w-full resize-none rounded border px-1 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
                            placeholder="意見・コメント"
                          />
                        </td>
                        {/* 達成度評価 */}
                        <td className="border border-gray-200 px-2 py-1.5 align-top">
                          <RadioGroup
                            name={`ach_${item.item_number}`}
                            options={[
                              { label: "達成した", value: "達成した" },
                              { label: "ほぼ達成", value: "ほぼ達成" },
                              { label: "未達成", value: "未達成" },
                            ]}
                            value={item.achievement}
                            onChange={(v) =>
                              updateItem(item.item_number, { achievement: v })
                            }
                          />
                        </td>
                        {/* ADL・IADL変化 */}
                        <td className="border border-gray-200 px-2 py-1.5 align-top">
                          <RadioGroup
                            name={`adl_${item.item_number}`}
                            options={[
                              { label: "良い変化", value: "良い変化" },
                              { label: "不変", value: "不変" },
                              { label: "悪化", value: "悪化" },
                            ]}
                            value={item.adl_change}
                            onChange={(v) =>
                              updateItem(item.item_number, { adl_change: v })
                            }
                          />
                        </td>
                        {/* プラン修正 */}
                        <td className="border border-gray-200 px-2 py-1.5 align-top">
                          <RadioGroup
                            name={`rev_${item.item_number}`}
                            options={[
                              { label: "あり", value: "あり" },
                              { label: "なし", value: "なし" },
                            ]}
                            value={item.plan_revision_needed}
                            onChange={(v) =>
                              updateItem(item.item_number, {
                                plan_revision_needed: v,
                              })
                            }
                          />
                        </td>
                        {/* 理由・今後の方針 */}
                        <td className="border border-gray-200 px-1 py-1.5 align-top">
                          <textarea
                            value={item.revision_reason}
                            onChange={(e) =>
                              updateItem(item.item_number, {
                                revision_reason: e.target.value,
                              })
                            }
                            rows={3}
                            className="w-full resize-none bg-transparent text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 focus:rounded px-0.5"
                            placeholder="その理由・今後の方針・新たな目標"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Bottom bar */}
              <div className="flex justify-end gap-3 pb-6">
                <button
                  onClick={() => setMode("list")}
                  className="rounded-lg border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Save size={14} />
                  )}
                  保存
                </button>
              </div>
            </div>
          )}

          {/* ── EDIT MODE (予防様式: 介護予防支援モニタリング) ── */}
          {mode === "edit" && isPreventive && (
            <div className="space-y-5">
              {/* Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setMode("list")}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    <ArrowLeft size={14} />
                    一覧に戻る
                  </button>
                  <ClipboardList className="text-emerald-600" size={22} />
                  <h1 className="text-lg font-bold text-gray-900">
                    介護予防支援モニタリング
                    {selectedUser && (
                      <span className="ml-2 text-gray-500 text-sm font-normal">
                        {selectedUser.name} 様
                        {careLevel ? `（${careLevel}）` : ""}
                      </span>
                    )}
                  </h1>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handlePrint}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    <Printer size={14} />
                    印刷
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                  >
                    {saving ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Save size={14} />
                    )}
                    保存
                  </button>
                </div>
              </div>

              {/* 頻度ガイド */}
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-800">
                実施頻度：少なくとも<span className="font-bold">3月に1回</span>、及び
                <span className="font-bold">サービス評価期間終了月</span>
                （状態に著しい変化があったときは都度）。
              </div>

              {/* Header fields */}
              <div className="rounded-lg border bg-white shadow-sm p-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      利用者名
                    </label>
                    <div className="rounded-lg border bg-gray-50 px-3 py-2 text-sm text-gray-700">
                      {selectedUser?.name ?? "—"} 殿
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      モニタリング実施日
                    </label>
                    <input
                      type="date"
                      value={monitoringDate}
                      onChange={(e) => setMonitoringDate(e.target.value)}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      介護予防支援事業所名
                    </label>
                    <input
                      type="text"
                      value={officeName}
                      onChange={(e) => setOfficeName(e.target.value)}
                      placeholder="事業所名（地域包括支援センター等）"
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      担当者（計画作成者）
                    </label>
                    <input
                      type="text"
                      value={assessorName}
                      onChange={(e) => setAssessorName(e.target.value)}
                      placeholder="担当者名"
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      サービス評価期間（開始）
                    </label>
                    <input
                      type="date"
                      value={prev.evaluation_period_start}
                      onChange={(e) => updatePrev({ evaluation_period_start: e.target.value })}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      サービス評価期間（終了）
                    </label>
                    <input
                      type="date"
                      value={prev.evaluation_period_end}
                      onChange={(e) => updatePrev({ evaluation_period_end: e.target.value })}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      モニタリング区分
                    </label>
                    <select
                      value={prev.monitoring_type}
                      onChange={(e) =>
                        updatePrev({
                          monitoring_type: e.target.value as PreventiveMonitoringType,
                        })
                      }
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    >
                      <option value="通常">通常（3月に1回）</option>
                      <option value="サービス評価期間終了">サービス評価期間終了月</option>
                      <option value="状態変化時">状態変化時</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      次回モニタリング予定
                    </label>
                    <input
                      type="date"
                      value={prev.next_monitoring_date}
                      onChange={(e) => updatePrev({ next_monitoring_date: e.target.value })}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                </div>
                <div className="mt-3">
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    ステータス
                  </label>
                  <select
                    value={sheetStatus}
                    onChange={(e) => setSheetStatus(e.target.value as MonitoringStatus)}
                    className="rounded-lg border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="draft">下書き</option>
                    <option value="completed">完了</option>
                  </select>
                </div>
              </div>

              {/* 目標達成状況の評価 */}
              <div className="rounded-lg border bg-white shadow-sm overflow-x-auto">
                <div className="border-b bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800">
                  目標の達成状況・サービスの評価
                </div>
                <table className="w-full border-collapse text-xs" style={{ minWidth: 1000 }}>
                  <thead>
                    <tr className="text-[11px] bg-gray-50">
                      <th className="border border-gray-300 px-2 py-1.5 text-gray-600" style={{ width: 30 }}>
                        No
                      </th>
                      <th className="border border-gray-300 px-2 py-1.5 text-gray-600" style={{ width: 220 }}>
                        目標（本人等のセルフケア・支援内容）
                      </th>
                      <th className="border border-gray-300 px-2 py-1.5 text-gray-600" style={{ width: 130 }}>
                        期間
                      </th>
                      <th className="border border-gray-300 px-2 py-1.5 text-gray-600" style={{ width: 200 }}>
                        本人・家族・地域の取組／サービス
                      </th>
                      <th className="border border-gray-300 px-2 py-1.5 text-gray-600" style={{ width: 110 }}>
                        達成状況
                      </th>
                      <th className="border border-gray-300 px-2 py-1.5 text-gray-600" style={{ width: 220 }}>
                        評価・今後の方針
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {prev.goals.map((g, idx) => (
                      <tr key={idx} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/40"}>
                        <td className="border border-gray-200 px-1 py-1.5 text-center font-bold text-gray-600 align-top text-sm">
                          {idx + 1}
                        </td>
                        <td className="border border-gray-200 px-1 py-1.5 align-top">
                          <textarea
                            value={g.goal}
                            onChange={(e) => updatePrevGoal(idx, { goal: e.target.value })}
                            rows={3}
                            className="w-full resize-none bg-transparent text-xs focus:outline-none focus:ring-1 focus:ring-emerald-400 focus:rounded px-0.5"
                            placeholder="目標"
                          />
                        </td>
                        <td className="border border-gray-200 px-1 py-1.5 align-top">
                          <textarea
                            value={g.period}
                            onChange={(e) => updatePrevGoal(idx, { period: e.target.value })}
                            rows={3}
                            className="w-full resize-none bg-transparent text-xs focus:outline-none focus:ring-1 focus:ring-emerald-400 focus:rounded px-0.5"
                            placeholder="期間"
                          />
                        </td>
                        <td className="border border-gray-200 px-1 py-1.5 align-top">
                          <textarea
                            value={g.service}
                            onChange={(e) => updatePrevGoal(idx, { service: e.target.value })}
                            rows={3}
                            className="w-full resize-none bg-transparent text-xs focus:outline-none focus:ring-1 focus:ring-emerald-400 focus:rounded px-0.5"
                            placeholder="取組・サービス"
                          />
                        </td>
                        <td className="border border-gray-200 px-2 py-1.5 align-top">
                          <RadioGroup
                            name={`pach_${idx}`}
                            options={[
                              { label: "達成", value: "達成" },
                              { label: "一部達成", value: "一部達成" },
                              { label: "未達成", value: "未達成" },
                            ]}
                            value={g.achievement}
                            onChange={(v) => updatePrevGoal(idx, { achievement: v })}
                          />
                        </td>
                        <td className="border border-gray-200 px-1 py-1.5 align-top">
                          <textarea
                            value={g.evaluation}
                            onChange={(e) => updatePrevGoal(idx, { evaluation: e.target.value })}
                            rows={3}
                            className="w-full resize-none bg-transparent text-xs focus:outline-none focus:ring-1 focus:ring-emerald-400 focus:rounded px-0.5"
                            placeholder="評価・今後の方針"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 総合評価・継続要否 */}
              <div className="rounded-lg border bg-white shadow-sm p-4 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    総合的な評価・支援経過
                  </label>
                  <textarea
                    value={prev.overall_evaluation}
                    onChange={(e) => updatePrev({ overall_evaluation: e.target.value })}
                    rows={4}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="心身の状況・生活の変化・支援経過など"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    本人・家族の意向
                  </label>
                  <textarea
                    value={prev.user_family_intention}
                    onChange={(e) => updatePrev({ user_family_intention: e.target.value })}
                    rows={3}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="本人・家族の意向"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      介護予防サービス計画の継続の要否
                    </label>
                    <RadioGroup
                      name="continuation"
                      options={[
                        { label: "継続", value: "継続" },
                        { label: "変更（見直し）", value: "変更" },
                        { label: "終了", value: "終了" },
                      ]}
                      value={prev.continuation_decision}
                      onChange={(v) => updatePrev({ continuation_decision: v })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      その理由
                    </label>
                    <textarea
                      value={prev.continuation_reason}
                      onChange={(e) => updatePrev({ continuation_reason: e.target.value })}
                      rows={3}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      placeholder="継続・変更・終了の理由"
                    />
                  </div>
                </div>
              </div>

              {/* Bottom bar */}
              <div className="flex justify-end gap-3 pb-6">
                <button
                  onClick={() => setMode("list")}
                  className="rounded-lg border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Save size={14} />
                  )}
                  保存
                </button>
              </div>
            </div>
          )}

          {/* ── SCREEN PREVIEW (A4縦フィット・要介護様式) ── */}
          {mode === "edit" && !isPreventive && selectedUser && (
            <div className="mt-6 space-y-3 no-print">
              <div className="flex items-center gap-2">
                <Printer size={18} className="text-gray-500" />
                <h2 className="text-base font-semibold text-gray-700">印刷プレビュー（A4縦）</h2>
              </div>
              <div className="rounded-lg border bg-white shadow-sm overflow-auto">
                <div
                  style={{
                    /* A4縦 = 210mm x 297mm, margin 8mm each → content 194mm x 281mm */
                    width: "194mm",
                    minHeight: "281mm",
                    padding: "8mm",
                    fontFamily: '"MS Mincho", "ＭＳ 明朝", "Noto Serif JP", serif',
                    fontSize: "8pt",
                    color: "#000",
                    background: "#fff",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  {/* Title */}
                  <div style={{ textAlign: "center", marginBottom: "3mm" }}>
                    <div style={{ fontSize: "11pt", fontWeight: "bold", letterSpacing: "0.2em", marginBottom: "2.5mm" }}>
                      居宅サービス計画実施状況報告書（モニタリングシート）
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "8pt", paddingLeft: "1mm", paddingRight: "1mm" }}>
                      <span>利用者名: <b>{selectedUser.name}</b> 様</span>
                      <span>居宅介護支援事業者: {officeName}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "8pt", paddingLeft: "1mm", paddingRight: "1mm", marginTop: "1mm" }}>
                      <span>モニタリング実施日: {monitoringDate ? toWareki(monitoringDate) : ""}</span>
                      <span>担当者: {assessorName}</span>
                    </div>
                  </div>

                  {/* Table - flex:1 to fill remaining height */}
                  <table style={{ width: "100%", borderCollapse: "collapse", border: "1pt solid #333", flex: 1, tableLayout: "fixed" }}>
                    <thead>
                      <tr style={{ background: "#f5f5f5" }}>
                        <th style={{ border: "1pt solid #333", padding: "1mm", width: "4%", textAlign: "center", fontSize: "6.5pt" }}>No</th>
                        <th style={{ border: "1pt solid #333", padding: "1mm", width: "14%", fontSize: "6.5pt" }}>短期目標</th>
                        <th style={{ border: "1pt solid #333", padding: "1mm", width: "9%", textAlign: "center", fontSize: "6.5pt" }}>目標期間</th>
                        <th style={{ border: "1pt solid #333", padding: "1mm", width: "9%", fontSize: "6.5pt" }}>サービス種別</th>
                        <th style={{ border: "1pt solid #333", padding: "1mm", width: "9%", fontSize: "6.5pt" }}>事業所</th>
                        <th style={{ border: "1pt solid #333", padding: "1mm", width: "14%", fontSize: "6.5pt" }}>サービス実施状況</th>
                        <th style={{ border: "1pt solid #333", padding: "1mm", width: "9%", textAlign: "center", fontSize: "6.5pt" }}>満足度</th>
                        <th style={{ border: "1pt solid #333", padding: "1mm", width: "7%", textAlign: "center", fontSize: "6.5pt" }}>達成度</th>
                        <th style={{ border: "1pt solid #333", padding: "1mm", width: "6%", textAlign: "center", fontSize: "6.5pt" }}>ADL変化</th>
                        <th style={{ border: "1pt solid #333", padding: "1mm", width: "5%", textAlign: "center", fontSize: "6.5pt" }}>見直し</th>
                        <th style={{ border: "1pt solid #333", padding: "1mm", width: "14%", fontSize: "6.5pt" }}>見直し理由</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.item_number} style={{ verticalAlign: "top", height: `${Math.floor(228 / FIXED_ROWS)}mm` }}>
                          <td style={{ border: "1pt solid #333", padding: "1mm", textAlign: "center", fontSize: "7.5pt", fontWeight: "bold" }}>{item.item_number}</td>
                          <td style={{ border: "1pt solid #333", padding: "1mm", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "6.5pt" }}>{item.short_term_goal || "\u00A0"}</td>
                          <td style={{ border: "1pt solid #333", padding: "1mm", fontSize: "5.5pt", textAlign: "center", whiteSpace: "pre-wrap" }}>
                            {formatPeriod(item.goal_period_start, item.goal_period_end) || "\u00A0"}
                          </td>
                          <td style={{ border: "1pt solid #333", padding: "1mm", fontSize: "6.5pt", wordBreak: "break-all" }}>{item.service_type || "\u00A0"}</td>
                          <td style={{ border: "1pt solid #333", padding: "1mm", fontSize: "6.5pt", wordBreak: "break-all" }}>{item.provider_name || "\u00A0"}</td>
                          <td style={{ border: "1pt solid #333", padding: "1mm", fontSize: "6.5pt", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{item.implementation_status || "\u00A0"}</td>
                          <td style={{ border: "1pt solid #333", padding: "1mm", fontSize: "6pt", textAlign: "center" }}>
                            {item.user_satisfaction ? <div>本人: {item.user_satisfaction}</div> : ""}
                            {item.family_satisfaction ? <div>家族: {item.family_satisfaction}</div> : ""}
                            {item.satisfaction_comment ? <div style={{ fontSize: "5.5pt", marginTop: "0.5mm", wordBreak: "break-all" }}>{item.satisfaction_comment}</div> : ""}
                            {!item.user_satisfaction && !item.family_satisfaction && "\u00A0"}
                          </td>
                          <td style={{ border: "1pt solid #333", padding: "1mm", fontSize: "6.5pt", textAlign: "center" }}>{item.achievement || "\u00A0"}</td>
                          <td style={{ border: "1pt solid #333", padding: "1mm", fontSize: "6.5pt", textAlign: "center" }}>{item.adl_change || "\u00A0"}</td>
                          <td style={{ border: "1pt solid #333", padding: "1mm", fontSize: "6.5pt", textAlign: "center" }}>{item.plan_revision_needed || "\u00A0"}</td>
                          <td style={{ border: "1pt solid #333", padding: "1mm", fontSize: "6.5pt", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{item.revision_reason || "\u00A0"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
      </div>

      {/* ── PRINT VERSION (要介護様式) ── */}
      <div id="monitoring-print-root">
        {selectedUser && mode === "edit" && !isPreventive && (
          <div
            style={{
              padding: "8mm",
              fontFamily:
                '"MS Mincho", "ＭＳ 明朝", "Noto Serif JP", serif',
              fontSize: "6.5pt",
              color: "#000",
              background: "#fff",
              width: "194mm",
              minHeight: "281mm",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* Title */}
            <div style={{ textAlign: "center", marginBottom: "2.5mm" }}>
              <div
                style={{
                  fontSize: "10pt",
                  fontWeight: "bold",
                  letterSpacing: "0.15em",
                  marginBottom: "1.5mm",
                }}
              >
                モニタリングシート
              </div>
            </div>

            {/* Header info — 2 rows × 2 cols */}
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                marginBottom: "2.5mm",
                fontSize: "7pt",
              }}
            >
              <tbody>
                <tr>
                  <td
                    style={{
                      border: "1pt solid #333",
                      padding: "1mm 1.5mm",
                      width: "25%",
                    }}
                  >
                    <span style={{ fontWeight: "bold" }}>利用者名：</span>
                    {selectedUser.name} 殿
                  </td>
                  <td
                    style={{
                      border: "1pt solid #333",
                      padding: "1mm 1.5mm",
                      width: "25%",
                    }}
                  >
                    <span style={{ fontWeight: "bold" }}>
                      実施日：
                    </span>
                    {monitoringDate ? toWareki(monitoringDate) : "　　年　月　日"}
                  </td>
                  <td
                    style={{
                      border: "1pt solid #333",
                      padding: "1mm 1.5mm",
                      width: "25%",
                    }}
                  >
                    <span style={{ fontWeight: "bold" }}>
                      事業所：
                    </span>
                    {officeName || "　　　　　　　"}
                  </td>
                  <td
                    style={{
                      border: "1pt solid #333",
                      padding: "1mm 1.5mm",
                      width: "25%",
                    }}
                  >
                    <span style={{ fontWeight: "bold" }}>
                      計画作成者：
                    </span>
                    {assessorName || "　　　　　"}
                  </td>
                </tr>
              </tbody>
            </table>

            {/* Main table */}
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "6.5pt",
                tableLayout: "fixed",
                flex: 1,
              }}
            >
              <colgroup>
                {/* No */}
                <col style={{ width: "3%" }} />
                {/* 短期目標 */}
                <col style={{ width: "11%" }} />
                {/* 期間 */}
                <col style={{ width: "9%" }} />
                {/* サービス種別 */}
                <col style={{ width: "8%" }} />
                {/* 事業所名 */}
                <col style={{ width: "8%" }} />
                {/* 実施状況 */}
                <col style={{ width: "13%" }} />
                {/* 満足と意見 */}
                <col style={{ width: "13%" }} />
                {/* 達成度 */}
                <col style={{ width: "9%" }} />
                {/* ADL変化 */}
                <col style={{ width: "9%" }} />
                {/* プラン修正 */}
                <col style={{ width: "7%" }} />
                {/* 理由・方針 */}
                <col style={{ width: "10%" }} />
              </colgroup>
              <thead>
                {/* Section group row */}
                <tr>
                  <th
                    rowSpan={2}
                    style={{
                      border: "1pt solid #333",
                      padding: "1mm",
                      textAlign: "center",
                      verticalAlign: "middle",
                      background: "#e8e8e8",
                      fontWeight: "bold",
                    }}
                  >
                    No
                  </th>
                  <th
                    colSpan={5}
                    style={{
                      border: "1pt solid #333",
                      padding: "1mm",
                      textAlign: "center",
                      background: "#dbeafe",
                      fontWeight: "bold",
                    }}
                  >
                    居宅サービス計画の実施状況
                  </th>
                  <th
                    colSpan={5}
                    style={{
                      border: "1pt solid #333",
                      padding: "1mm",
                      textAlign: "center",
                      background: "#dcfce7",
                      fontWeight: "bold",
                    }}
                  >
                    居宅サービス計画の達成度と評価
                  </th>
                </tr>
                {/* Column labels */}
                <tr style={{ fontSize: "6pt" }}>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "0.8mm 1mm",
                      textAlign: "center",
                      background: "#eff6ff",
                    }}
                  >
                    短期目標
                  </th>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "0.8mm 1mm",
                      textAlign: "center",
                      background: "#eff6ff",
                    }}
                  >
                    期間
                  </th>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "0.8mm 1mm",
                      textAlign: "center",
                      background: "#eff6ff",
                    }}
                  >
                    サービス種別
                  </th>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "0.8mm 1mm",
                      textAlign: "center",
                      background: "#eff6ff",
                    }}
                  >
                    事業所名
                  </th>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "0.8mm 1mm",
                      textAlign: "center",
                      background: "#eff6ff",
                    }}
                  >
                    居宅サービス計画の実施状況・トラブル状況
                  </th>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "0.8mm 1mm",
                      textAlign: "center",
                      background: "#f0fdf4",
                    }}
                  >
                    利用者・家族の満足と意見
                    <br />
                    <span style={{ fontWeight: "normal", fontSize: "5.5pt" }}>
                      （満足／不満）
                    </span>
                  </th>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "0.8mm 1mm",
                      textAlign: "center",
                      background: "#f0fdf4",
                    }}
                  >
                    達成度評価
                    <br />
                    <span style={{ fontWeight: "normal", fontSize: "5.5pt" }}>
                      （達成した／ほぼ達成／未達成）
                    </span>
                  </th>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "0.8mm 1mm",
                      textAlign: "center",
                      background: "#f0fdf4",
                    }}
                  >
                    ADL・IADL変化
                    <br />
                    <span style={{ fontWeight: "normal", fontSize: "5.5pt" }}>
                      （良い変化／不変／悪化）
                    </span>
                  </th>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "0.8mm 1mm",
                      textAlign: "center",
                      background: "#f0fdf4",
                    }}
                  >
                    プラン修正
                    <br />の必要性
                    <br />
                    <span style={{ fontWeight: "normal", fontSize: "5.5pt" }}>
                      （あり／なし）
                    </span>
                  </th>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "0.8mm 1mm",
                      textAlign: "center",
                      background: "#f0fdf4",
                    }}
                  >
                    その理由/今後の方針・新たな目標
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.item_number} style={{ height: `${Math.floor(220 / FIXED_ROWS)}mm` }}>
                    {/* No */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "0.8mm",
                        textAlign: "center",
                        verticalAlign: "top",
                        fontWeight: "bold",
                        fontSize: "7pt",
                      }}
                    >
                      {item.item_number}
                    </td>
                    {/* 短期目標 */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "0.8mm",
                        verticalAlign: "top",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                      }}
                    >
                      {item.short_term_goal}
                    </td>
                    {/* 期間 */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "0.8mm",
                        verticalAlign: "top",
                        fontSize: "5pt",
                      }}
                    >
                      {item.goal_period_start || item.goal_period_end
                        ? formatPeriod(
                            item.goal_period_start,
                            item.goal_period_end
                          )
                            .split("\n")
                            .map((line, i) => (
                              <span key={i}>
                                {line}
                                {i === 0 && <br />}
                              </span>
                            ))
                        : ""}
                    </td>
                    {/* サービス種別 */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "0.8mm",
                        verticalAlign: "top",
                        wordBreak: "break-all",
                      }}
                    >
                      {item.service_type}
                    </td>
                    {/* 事業所名 */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "0.8mm",
                        verticalAlign: "top",
                        wordBreak: "break-all",
                      }}
                    >
                      {item.provider_name}
                    </td>
                    {/* 実施状況 */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "0.8mm",
                        verticalAlign: "top",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                      }}
                    >
                      {item.implementation_status}
                    </td>
                    {/* 利用者・家族の満足と意見 */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "0.8mm",
                        verticalAlign: "top",
                      }}
                    >
                      <div style={{ marginBottom: "0.8mm" }}>
                        <span style={{ fontSize: "5pt", display: "inline-block", width: "9mm" }}>利用者：</span>
                        <PrintCheck
                          checked={item.user_satisfaction === "満足"}
                        />
                        <span style={{ marginRight: "2pt" }}>満足</span>
                        <PrintCheck
                          checked={item.user_satisfaction === "不満"}
                        />
                        不満
                      </div>
                      <div style={{ marginBottom: "1mm" }}>
                        <span style={{ fontSize: "5pt", display: "inline-block", width: "9mm" }}>家族：</span>
                        <PrintCheck
                          checked={item.family_satisfaction === "満足"}
                        />
                        <span style={{ marginRight: "2pt" }}>満足</span>
                        <PrintCheck
                          checked={item.family_satisfaction === "不満"}
                        />
                        不満
                      </div>
                      <div
                        style={{
                          borderTop: "0.5pt solid #aaa",
                          paddingTop: "0.8mm",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                          fontSize: "5pt",
                        }}
                      >
                        {item.satisfaction_comment}
                      </div>
                    </td>
                    {/* 達成度評価 */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "0.8mm",
                        verticalAlign: "top",
                      }}
                    >
                      <div>
                        <PrintRadio
                          checked={item.achievement === "達成した"}
                        />
                        達成した
                      </div>
                      <div>
                        <PrintRadio
                          checked={item.achievement === "ほぼ達成"}
                        />
                        ほぼ達成
                      </div>
                      <div>
                        <PrintRadio checked={item.achievement === "未達成"} />
                        未達成
                      </div>
                    </td>
                    {/* ADL・IADL変化 */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "0.8mm",
                        verticalAlign: "top",
                      }}
                    >
                      <div>
                        <PrintRadio
                          checked={item.adl_change === "良い変化"}
                        />
                        良い変化
                      </div>
                      <div>
                        <PrintRadio checked={item.adl_change === "不変"} />
                        不変
                      </div>
                      <div>
                        <PrintRadio checked={item.adl_change === "悪化"} />
                        悪化
                      </div>
                    </td>
                    {/* プラン修正の必要性 */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "0.8mm",
                        verticalAlign: "top",
                      }}
                    >
                      <div>
                        <PrintCheck
                          checked={item.plan_revision_needed === "あり"}
                        />
                        あり
                      </div>
                      <div>
                        <PrintCheck
                          checked={item.plan_revision_needed === "なし"}
                        />
                        なし
                      </div>
                    </td>
                    {/* 理由・今後の方針 */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "0.8mm",
                        verticalAlign: "top",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                      }}
                    >
                      {item.revision_reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Signature area */}
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                marginTop: "3mm",
                fontSize: "6.5pt",
              }}
            >
              <tbody>
                <tr>
                  <td
                    style={{
                      border: "1pt solid #666",
                      padding: "1mm",
                      width: "33.3%",
                      height: "12mm",
                      verticalAlign: "top",
                    }}
                  >
                    <div style={{ fontWeight: "bold", marginBottom: "0.8mm" }}>
                      居宅介護支援事業所（担当ケアマネジャー印）
                    </div>
                  </td>
                  <td
                    style={{
                      border: "1pt solid #666",
                      padding: "1mm",
                      width: "33.3%",
                      height: "12mm",
                      verticalAlign: "top",
                    }}
                  >
                    <div style={{ fontWeight: "bold", marginBottom: "0.8mm" }}>
                      利用者確認（署名・押印）
                    </div>
                  </td>
                  <td
                    style={{
                      border: "1pt solid #666",
                      padding: "1mm",
                      width: "33.3%",
                      height: "12mm",
                      verticalAlign: "top",
                    }}
                  >
                    <div style={{ fontWeight: "bold", marginBottom: "0.8mm" }}>
                      家族確認（署名・押印）
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* ── PRINT VERSION (予防様式: 介護予防支援モニタリング) ── */}
        {selectedUser && mode === "edit" && isPreventive && (
          <div
            style={{
              padding: "8mm",
              fontFamily: '"MS Mincho", "ＭＳ 明朝", "Noto Serif JP", serif',
              fontSize: "7pt",
              color: "#000",
              background: "#fff",
              width: "194mm",
              minHeight: "281mm",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* Title */}
            <div style={{ textAlign: "center", marginBottom: "2.5mm" }}>
              <div
                style={{
                  fontSize: "11pt",
                  fontWeight: "bold",
                  letterSpacing: "0.15em",
                  marginBottom: "1mm",
                }}
              >
                介護予防支援・サービス評価表（モニタリング）
              </div>
              <div style={{ fontSize: "6.5pt" }}>
                実施頻度：少なくとも3月に1回、及びサービス評価期間終了月（状態変化時は都度）
              </div>
            </div>

            {/* Header info */}
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                marginBottom: "2.5mm",
                fontSize: "7pt",
              }}
            >
              <tbody>
                <tr>
                  <td style={{ border: "1pt solid #333", padding: "1mm 1.5mm", width: "25%" }}>
                    <span style={{ fontWeight: "bold" }}>利用者名：</span>
                    {selectedUser.name} 殿
                  </td>
                  <td style={{ border: "1pt solid #333", padding: "1mm 1.5mm", width: "25%" }}>
                    <span style={{ fontWeight: "bold" }}>要介護度：</span>
                    {careLevel || "　　　　"}
                  </td>
                  <td style={{ border: "1pt solid #333", padding: "1mm 1.5mm", width: "25%" }}>
                    <span style={{ fontWeight: "bold" }}>実施日：</span>
                    {monitoringDate ? toWareki(monitoringDate) : "　　年　月　日"}
                  </td>
                  <td style={{ border: "1pt solid #333", padding: "1mm 1.5mm", width: "25%" }}>
                    <span style={{ fontWeight: "bold" }}>区分：</span>
                    {prev.monitoring_type}
                  </td>
                </tr>
                <tr>
                  <td style={{ border: "1pt solid #333", padding: "1mm 1.5mm" }}>
                    <span style={{ fontWeight: "bold" }}>事業所：</span>
                    {officeName || "　　　　　　"}
                  </td>
                  <td style={{ border: "1pt solid #333", padding: "1mm 1.5mm" }}>
                    <span style={{ fontWeight: "bold" }}>担当者：</span>
                    {assessorName || "　　　　"}
                  </td>
                  <td style={{ border: "1pt solid #333", padding: "1mm 1.5mm" }}>
                    <span style={{ fontWeight: "bold" }}>評価期間：</span>
                    {prev.evaluation_period_start || prev.evaluation_period_end
                      ? `${
                          prev.evaluation_period_start
                            ? format(parseISO(prev.evaluation_period_start), "yyyy/M/d")
                            : ""
                        }〜${
                          prev.evaluation_period_end
                            ? format(parseISO(prev.evaluation_period_end), "yyyy/M/d")
                            : ""
                        }`
                      : "　"}
                  </td>
                  <td style={{ border: "1pt solid #333", padding: "1mm 1.5mm" }}>
                    <span style={{ fontWeight: "bold" }}>次回予定：</span>
                    {prev.next_monitoring_date
                      ? toWareki(prev.next_monitoring_date)
                      : "　"}
                  </td>
                </tr>
              </tbody>
            </table>

            {/* 目標達成状況の評価テーブル */}
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "6.5pt",
                tableLayout: "fixed",
              }}
            >
              <colgroup>
                <col style={{ width: "4%" }} />
                <col style={{ width: "26%" }} />
                <col style={{ width: "13%" }} />
                <col style={{ width: "23%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "24%" }} />
              </colgroup>
              <thead>
                <tr style={{ background: "#dcfce7" }}>
                  <th style={{ border: "1pt solid #333", padding: "1mm", textAlign: "center" }}>No</th>
                  <th style={{ border: "1pt solid #333", padding: "1mm" }}>目標（本人等のセルフケア・支援内容）</th>
                  <th style={{ border: "1pt solid #333", padding: "1mm" }}>期間</th>
                  <th style={{ border: "1pt solid #333", padding: "1mm" }}>本人・家族・地域の取組／サービス</th>
                  <th style={{ border: "1pt solid #333", padding: "1mm", textAlign: "center" }}>達成状況</th>
                  <th style={{ border: "1pt solid #333", padding: "1mm" }}>評価・今後の方針</th>
                </tr>
              </thead>
              <tbody>
                {prev.goals.map((g, idx) => (
                  <tr key={idx} style={{ height: "18mm", verticalAlign: "top" }}>
                    <td style={{ border: "1pt solid #333", padding: "0.8mm", textAlign: "center", fontWeight: "bold" }}>
                      {idx + 1}
                    </td>
                    <td style={{ border: "1pt solid #333", padding: "0.8mm", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {g.goal}
                    </td>
                    <td style={{ border: "1pt solid #333", padding: "0.8mm", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "5.5pt" }}>
                      {g.period}
                    </td>
                    <td style={{ border: "1pt solid #333", padding: "0.8mm", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {g.service}
                    </td>
                    <td style={{ border: "1pt solid #333", padding: "0.8mm", verticalAlign: "top" }}>
                      <div>
                        <PrintRadio checked={g.achievement === "達成"} />
                        達成
                      </div>
                      <div>
                        <PrintRadio checked={g.achievement === "一部達成"} />
                        一部達成
                      </div>
                      <div>
                        <PrintRadio checked={g.achievement === "未達成"} />
                        未達成
                      </div>
                    </td>
                    <td style={{ border: "1pt solid #333", padding: "0.8mm", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {g.evaluation}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* 総合評価・継続要否 */}
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                marginTop: "2.5mm",
                fontSize: "6.5pt",
              }}
            >
              <tbody>
                <tr>
                  <td style={{ border: "1pt solid #333", padding: "1mm", width: "20%", fontWeight: "bold", background: "#f5f5f5", verticalAlign: "top" }}>
                    総合的な評価・支援経過
                  </td>
                  <td style={{ border: "1pt solid #333", padding: "1mm", whiteSpace: "pre-wrap", wordBreak: "break-all", height: "22mm", verticalAlign: "top" }}>
                    {prev.overall_evaluation}
                  </td>
                </tr>
                <tr>
                  <td style={{ border: "1pt solid #333", padding: "1mm", fontWeight: "bold", background: "#f5f5f5", verticalAlign: "top" }}>
                    本人・家族の意向
                  </td>
                  <td style={{ border: "1pt solid #333", padding: "1mm", whiteSpace: "pre-wrap", wordBreak: "break-all", height: "15mm", verticalAlign: "top" }}>
                    {prev.user_family_intention}
                  </td>
                </tr>
                <tr>
                  <td style={{ border: "1pt solid #333", padding: "1mm", fontWeight: "bold", background: "#f5f5f5", verticalAlign: "top" }}>
                    介護予防サービス計画の
                    <br />
                    継続の要否
                  </td>
                  <td style={{ border: "1pt solid #333", padding: "1mm", verticalAlign: "top" }}>
                    <div style={{ marginBottom: "1mm" }}>
                      <PrintRadio checked={prev.continuation_decision === "継続"} />
                      <span style={{ marginRight: "3pt" }}>継続</span>
                      <PrintRadio checked={prev.continuation_decision === "変更"} />
                      <span style={{ marginRight: "3pt" }}>変更（見直し）</span>
                      <PrintRadio checked={prev.continuation_decision === "終了"} />
                      終了
                    </div>
                    <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", borderTop: "0.5pt solid #aaa", paddingTop: "0.8mm" }}>
                      理由：{prev.continuation_reason}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>

            {/* Signature area */}
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "3mm", fontSize: "6.5pt" }}>
              <tbody>
                <tr>
                  <td style={{ border: "1pt solid #666", padding: "1mm", width: "50%", height: "12mm", verticalAlign: "top" }}>
                    <div style={{ fontWeight: "bold" }}>
                      介護予防支援事業所（担当者印）
                    </div>
                  </td>
                  <td style={{ border: "1pt solid #666", padding: "1mm", width: "50%", height: "12mm", verticalAlign: "top" }}>
                    <div style={{ fontWeight: "bold" }}>
                      利用者確認（署名・押印）
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
