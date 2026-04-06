"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { UserSidebar } from "@/components/users/user-sidebar";
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

interface KaigoUser {
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

interface MonitoringSheet {
  id: string;
  user_id: string;
  monitoring_date: string;
  assessor_name: string;
  status: MonitoringStatus;
  created_at: string;
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
      <span className="shrink-0 text-gray-500">{label}：</span>
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

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function MonitoringPage() {
  const supabase = createClient();

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<KaigoUser | null>(null);

  // List
  const [sheets, setSheets] = useState<MonitoringSheet[]>([]);
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
  const [saving, setSaving] = useState(false);
  const [loadingCarePlan, setLoadingCarePlan] = useState(false);

  // ── User ─────────────────────────────────────────────────────────────────────

  const fetchUser = useCallback(
    async (userId: string) => {
      const { data } = await supabase
        .from("kaigo_users")
        .select("id, name, name_kana")
        .eq("id", userId)
        .single();
      setSelectedUser(data ?? null);
    },
    [supabase]
  );

  useEffect(() => {
    if (selectedUserId) {
      fetchUser(selectedUserId);
      setMode("list");
    } else {
      setSelectedUser(null);
      setMode("list");
    }
  }, [selectedUserId, fetchUser]);

  // ── Sheet list ───────────────────────────────────────────────────────────────

  const fetchSheets = useCallback(async () => {
    if (!selectedUserId) {
      setSheets([]);
      return;
    }
    setLoadingSheets(true);
    const { data, error } = await supabase
      .from("kaigo_monitoring_sheets")
      .select(
        "id, user_id, monitoring_date, assessor_name, status, created_at"
      )
      .eq("user_id", selectedUserId)
      .order("monitoring_date", { ascending: false });

    if (error) {
      toast.error("モニタリングシートの取得に失敗しました: " + error.message);
    } else {
      setSheets((data as MonitoringSheet[]) ?? []);
    }
    setLoadingSheets(false);
  }, [supabase, selectedUserId]);

  useEffect(() => {
    if (mode === "list") fetchSheets();
  }, [fetchSheets, mode]);

  // ── Care plan auto-fill ──────────────────────────────────────────────────────

  const loadCarePlanItems = useCallback(async () => {
    if (!selectedUserId) return;
    setLoadingCarePlan(true);
    try {
      const { data: plans, error } = await supabase
        .from("kaigo_care_plans")
        .select(
          "id, user_id, status, short_term_goals, start_date, end_date, kaigo_care_plan_services(*)"
        )
        .eq("user_id", selectedUserId)
        .eq("status", "active");

      if (error) throw error;

      const activePlans = (plans ?? []) as CarePlan[];
      if (activePlans.length === 0) {
        toast.info("有効なケアプランが見つかりません");
        return;
      }

      const sourced: MonitoringItem[] = [];
      let num = 1;

      for (const plan of activePlans) {
        const services = plan.kaigo_care_plan_services ?? [];
        if (services.length === 0) {
          if (num <= FIXED_ROWS) {
            sourced.push({
              ...emptyItem(num),
              short_term_goal: plan.short_term_goals ?? "",
              goal_period_start: plan.start_date ?? "",
              goal_period_end: plan.end_date ?? "",
            });
            num++;
          }
        } else {
          for (const svc of services) {
            if (num > FIXED_ROWS) break;
            sourced.push({
              ...emptyItem(num),
              short_term_goal: plan.short_term_goals ?? "",
              goal_period_start: plan.start_date ?? "",
              goal_period_end: plan.end_date ?? "",
              service_type: svc.service_type ?? "",
              provider_name: svc.provider ?? "",
            });
            num++;
          }
        }
        if (num > FIXED_ROWS) break;
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
  }, [supabase, selectedUserId]);

  // ── Open new ─────────────────────────────────────────────────────────────────

  const openNew = async () => {
    setEditingSheetId(null);
    setMonitoringDate(format(new Date(), "yyyy-MM-dd"));
    setOfficeName("");
    setAssessorName("");
    setSheetStatus("draft");
    setItems(Array.from({ length: FIXED_ROWS }, (_, i) => emptyItem(i + 1)));
    setMode("edit");

    // Auto-load care plan
    setLoadingCarePlan(true);
    try {
      const { data: plans, error } = await supabase
        .from("kaigo_care_plans")
        .select(
          "id, user_id, status, short_term_goals, start_date, end_date, kaigo_care_plan_services(*)"
        )
        .eq("user_id", selectedUserId!)
        .eq("status", "active");

      if (!error && plans && plans.length > 0) {
        const activePlans = plans as CarePlan[];
        const sourced: MonitoringItem[] = [];
        let num = 1;
        for (const plan of activePlans) {
          const services = plan.kaigo_care_plan_services ?? [];
          if (services.length === 0) {
            if (num <= FIXED_ROWS) {
              sourced.push({
                ...emptyItem(num),
                short_term_goal: plan.short_term_goals ?? "",
                goal_period_start: plan.start_date ?? "",
                goal_period_end: plan.end_date ?? "",
              });
              num++;
            }
          } else {
            for (const svc of services) {
              if (num > FIXED_ROWS) break;
              sourced.push({
                ...emptyItem(num),
                short_term_goal: plan.short_term_goals ?? "",
                goal_period_start: plan.start_date ?? "",
                goal_period_end: plan.end_date ?? "",
                service_type: svc.service_type ?? "",
                provider_name: svc.provider ?? "",
              });
              num++;
            }
          }
          if (num > FIXED_ROWS) break;
        }
        if (sourced.length > 0) setItems(buildFixedRows(sourced));
      }
    } catch {
      // ignore
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

    const { data: dbItems, error } = await supabase
      .from("kaigo_monitoring_items")
      .select("*")
      .eq("monitoring_sheet_id", sheet.id)
      .order("item_number");

    if (error) {
      toast.error("項目の読み込みに失敗しました: " + error.message);
      return;
    }

    const mapped: MonitoringItem[] = (dbItems ?? []).map((r) => ({
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
    if (!selectedUserId) return;
    setSaving(true);
    try {
      let sheetId = editingSheetId;

      if (sheetId) {
        const { error } = await supabase
          .from("kaigo_monitoring_sheets")
          .update({
            monitoring_date: monitoringDate,
            assessor_name: assessorName,
            status: sheetStatus,
          })
          .eq("id", sheetId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("kaigo_monitoring_sheets")
          .insert({
            user_id: selectedUserId,
            monitoring_date: monitoringDate,
            assessor_name: assessorName,
            status: sheetStatus,
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
          @page { size: A4 landscape; margin: 6mm; }
          .no-print { display: none !important; }
        }
        @media screen {
          #monitoring-print-root { display: none; }
        }
      `}</style>

      <div className="flex h-full -m-6">
        <UserSidebar
          selectedUserId={selectedUserId}
          onSelectUser={(id) => {
            setSelectedUserId(id);
            setMode("list");
          }}
        />

        <div className="flex-1 overflow-y-auto p-6 no-print">
          {/* ── No user ── */}
          {!selectedUserId && (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <ClipboardList size={48} className="mb-4 text-gray-300" />
              <p className="text-gray-500 text-sm">利用者を選択してください</p>
            </div>
          )}

          {/* ── LIST MODE ── */}
          {selectedUserId && mode === "list" && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ClipboardList className="text-blue-600" size={24} />
                  <h1 className="text-xl font-bold text-gray-900">
                    モニタリングシート
                  </h1>
                  {selectedUser && (
                    <span className="text-gray-500 text-sm">
                      — {selectedUser.name} 様
                    </span>
                  )}
                </div>
                <button
                  onClick={openNew}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
                >
                  <Plus size={16} />
                  新規作成
                </button>
              </div>

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

          {/* ── EDIT MODE ── */}
          {selectedUserId && mode === "edit" && (
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
        </div>
      </div>

      {/* ── PRINT VERSION ── */}
      <div id="monitoring-print-root">
        {selectedUser && mode === "edit" && (
          <div
            style={{
              padding: "6mm",
              fontFamily:
                '"MS Mincho", "ＭＳ 明朝", "Noto Serif JP", serif',
              fontSize: "7pt",
              color: "#000",
              background: "#fff",
            }}
          >
            {/* Title */}
            <div style={{ textAlign: "center", marginBottom: "3mm" }}>
              <div
                style={{
                  fontSize: "11pt",
                  fontWeight: "bold",
                  letterSpacing: "0.2em",
                  marginBottom: "2mm",
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
                marginBottom: "3mm",
                fontSize: "8pt",
              }}
            >
              <tbody>
                <tr>
                  <td
                    style={{
                      border: "1pt solid #333",
                      padding: "1.5mm 2mm",
                      width: "25%",
                    }}
                  >
                    <span style={{ fontWeight: "bold" }}>利用者名：</span>
                    {selectedUser.name} 殿
                  </td>
                  <td
                    style={{
                      border: "1pt solid #333",
                      padding: "1.5mm 2mm",
                      width: "25%",
                    }}
                  >
                    <span style={{ fontWeight: "bold" }}>
                      モニタリング実施日：
                    </span>
                    {monitoringDate ? toWareki(monitoringDate) : "　　年　月　日"}
                  </td>
                  <td
                    style={{
                      border: "1pt solid #333",
                      padding: "1.5mm 2mm",
                      width: "25%",
                    }}
                  >
                    <span style={{ fontWeight: "bold" }}>
                      居宅介護支援事業所名：
                    </span>
                    {officeName || "　　　　　　　"}
                  </td>
                  <td
                    style={{
                      border: "1pt solid #333",
                      padding: "1.5mm 2mm",
                      width: "25%",
                    }}
                  >
                    <span style={{ fontWeight: "bold" }}>
                      居宅サービス計画書作成者：
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
                  <tr key={item.item_number} style={{ minHeight: "18mm" }}>
                    {/* No */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "1mm",
                        textAlign: "center",
                        verticalAlign: "top",
                        fontWeight: "bold",
                        fontSize: "8pt",
                      }}
                    >
                      {item.item_number}
                    </td>
                    {/* 短期目標 */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "1mm",
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
                        padding: "1mm",
                        verticalAlign: "top",
                        fontSize: "5.5pt",
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
                        padding: "1mm",
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
                        padding: "1mm",
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
                        padding: "1mm",
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
                        padding: "1mm",
                        verticalAlign: "top",
                      }}
                    >
                      <div style={{ marginBottom: "1mm" }}>
                        <span style={{ fontSize: "5.5pt" }}>利用者：</span>
                        <PrintCheck
                          checked={item.user_satisfaction === "満足"}
                        />
                        <span style={{ marginRight: "2pt" }}>満足</span>
                        <PrintCheck
                          checked={item.user_satisfaction === "不満"}
                        />
                        不満
                      </div>
                      <div style={{ marginBottom: "1.5mm" }}>
                        <span style={{ fontSize: "5.5pt" }}>家族：</span>
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
                          paddingTop: "1mm",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                          fontSize: "5.5pt",
                        }}
                      >
                        {item.satisfaction_comment}
                      </div>
                    </td>
                    {/* 達成度評価 */}
                    <td
                      style={{
                        border: "1pt solid #333",
                        padding: "1mm",
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
                        padding: "1mm",
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
                        padding: "1mm",
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
                        padding: "1mm",
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
                marginTop: "4mm",
                fontSize: "7pt",
              }}
            >
              <tbody>
                <tr>
                  <td
                    style={{
                      border: "1pt solid #666",
                      padding: "1.5mm",
                      width: "33.3%",
                      height: "14mm",
                      verticalAlign: "top",
                    }}
                  >
                    <div style={{ fontWeight: "bold", marginBottom: "1mm" }}>
                      居宅介護支援事業所（担当ケアマネジャー印）
                    </div>
                  </td>
                  <td
                    style={{
                      border: "1pt solid #666",
                      padding: "1.5mm",
                      width: "33.3%",
                      height: "14mm",
                      verticalAlign: "top",
                    }}
                  >
                    <div style={{ fontWeight: "bold", marginBottom: "1mm" }}>
                      利用者確認（署名・押印）
                    </div>
                  </td>
                  <td
                    style={{
                      border: "1pt solid #666",
                      padding: "1.5mm",
                      width: "33.3%",
                      height: "14mm",
                      verticalAlign: "top",
                    }}
                  >
                    <div style={{ fontWeight: "bold", marginBottom: "1mm" }}>
                      家族確認（署名・押印）
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
