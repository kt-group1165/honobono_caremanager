"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { resolvePreferredTenantId } from "@/lib/tenant-resolver";
import { toast } from "sonner";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  Plus,
  Pencil,
  Trash2,
  X,
  Save,
  Printer,
  Download,
  Loader2,
  FileText,
  Clock,
  Phone,
  House,
  MapPin,
  Mail,
  Printer as FaxIcon,
  Users,
  ClipboardList,
  Activity,
  MoreHorizontal,
  Link2,
  Copy,
} from "lucide-react";
import {
  format,
  parseISO,
  startOfDay,
  endOfDay,
} from "date-fns";
import { ja } from "date-fns/locale";
import { TemplatePicker } from "@/components/templates/template-picker";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KaigoUser {
  id: string;
  name: string;
  name_kana: string | null;
}

type RecordCategory =
  | "電話"
  | "訪問"
  | "来所"
  | "メール"
  | "FAX"
  | "カンファレンス"
  | "サービス担当者会議"
  | "モニタリング"
  | "その他";

interface SupportRecord {
  id: string;
  user_id: string;
  care_plan_id: string | null;
  record_date: string;
  record_time: string | null;
  category: RecordCategory;
  content: string;
  staff_name: string | null;
  created_at: string;
  updated_at: string | null;
}

interface CarePlanSummary {
  id: string;
  plan_number: string | null;
  plan_type: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
}

type FormData = {
  record_date: string;
  record_time: string;
  category: RecordCategory;
  content: string;
  staff_name: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES: RecordCategory[] = [
  "電話",
  "訪問",
  "来所",
  "メール",
  "FAX",
  "カンファレンス",
  "サービス担当者会議",
  "モニタリング",
  "その他",
];

const CATEGORY_COLORS: Record<RecordCategory, { bg: string; text: string; border: string }> = {
  電話: { bg: "bg-blue-100", text: "text-blue-700", border: "border-blue-200" },
  訪問: { bg: "bg-green-100", text: "text-green-700", border: "border-green-200" },
  来所: { bg: "bg-purple-100", text: "text-purple-700", border: "border-purple-200" },
  メール: { bg: "bg-yellow-100", text: "text-yellow-700", border: "border-yellow-200" },
  FAX: { bg: "bg-gray-100", text: "text-gray-600", border: "border-gray-200" },
  カンファレンス: { bg: "bg-orange-100", text: "text-orange-700", border: "border-orange-200" },
  サービス担当者会議: { bg: "bg-red-100", text: "text-red-700", border: "border-red-200" },
  モニタリング: { bg: "bg-teal-100", text: "text-teal-700", border: "border-teal-200" },
  その他: { bg: "bg-gray-100", text: "text-gray-500", border: "border-gray-200" },
};

const CATEGORY_TIMELINE_COLORS: Record<RecordCategory, string> = {
  電話: "bg-blue-500",
  訪問: "bg-green-500",
  来所: "bg-purple-500",
  メール: "bg-yellow-500",
  FAX: "bg-gray-400",
  カンファレンス: "bg-orange-500",
  サービス担当者会議: "bg-red-500",
  モニタリング: "bg-teal-500",
  その他: "bg-gray-400",
};

function CategoryIcon({ category, size = 14 }: { category: RecordCategory; size?: number }) {
  const props = { size, className: "shrink-0" };
  switch (category) {
    case "電話": return <Phone {...props} />;
    case "訪問": return <House{...props} />;
    case "来所": return <MapPin {...props} />;
    case "メール": return <Mail {...props} />;
    case "FAX": return <FaxIcon{...props} />;
    case "カンファレンス": return <Users {...props} />;
    case "サービス担当者会議": return <ClipboardList {...props} />;
    case "モニタリング": return <Activity {...props} />;
    default: return <MoreHorizontal {...props} />;
  }
}

const EMPTY_FORM: FormData = {
  record_date: format(new Date(), "yyyy-MM-dd"),
  record_time: format(new Date(), "HH:mm"),
  category: "電話",
  content: "",
  staff_name: "",
};

const inputClass =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(date: string, time: string | null): string {
  try {
    const d = parseISO(date);
    const dateStr = format(d, "yyyy年M月d日(E)", { locale: ja });
    if (time) {
      return `${dateStr} ${time}`;
    }
    return dateStr;
  } catch {
    return date;
  }
}

function formatDateShort(date: string): string {
  try {
    return format(parseISO(date), "M/d(E)", { locale: ja });
  } catch {
    return date;
  }
}

function escapeCSV(val: string | null | undefined): string {
  const s = val ?? "";
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SupportRecordsPage() {
  const supabase = useMemo(() => createClient(), []);

  // ── スマホURL管理 ──
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [urls, setUrls] = useState<{ id: string; token: string; name: string }[]>([]);
  const [newUrlName, setNewUrlName] = useState("訪問記録用");
  const [urlLoading, setUrlLoading] = useState(false);

  const fetchUrls = useCallback(async () => {
    const { data } = await supabase.from("kaigo_support_tokens").select("id, token, name").order("created_at", { ascending: false });
    setUrls(data || []);
  }, [supabase]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
  useEffect(() => { if (showUrlModal) fetchUrls(); }, [showUrlModal, fetchUrls]);

  const createUrl = async () => {
    if (!newUrlName.trim()) { toast.error("名前を入力してください"); return; }
    setUrlLoading(true);
    const resolved = await resolvePreferredTenantId(supabase);
    if (!resolved.ok) {
      toast.error("発行に失敗: " + resolved.error);
      setUrlLoading(false);
      return;
    }
    const { error } = await supabase
      .from("kaigo_support_tokens")
      .insert({ name: newUrlName.trim(), tenant_id: resolved.tenantId });
    if (error) toast.error("発行に失敗: " + error.message);
    else { toast.success("URLを発行しました"); setNewUrlName("訪問記録用"); fetchUrls(); }
    setUrlLoading(false);
  };

  const copyUrl = (token: string) => {
    const url = `${window.location.origin}/support/${token}`;
    navigator.clipboard.writeText(url);
    toast.success("URLをコピーしました");
  };

  const deleteUrl = async (id: string) => {
    if (!confirm("このURLを削除しますか？")) return;
    await supabase.from("kaigo_support_tokens").delete().eq("id", id);
    fetchUrls();
    toast.success("削除しました");
  };

  // ── State ──
  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [filterCategory, setFilterCategory] = useState<string>("");

  const [records, setRecords] = useState<SupportRecord[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingRecords, setLoadingRecords] = useState(false);

  // 計画期間タブ
  const [carePlans, setCarePlans] = useState<CarePlanSummary[]>([]);
  const [selectedCarePlanId, setSelectedCarePlanId] = useState<string | null>(null);
  const [loadingCarePlans, setLoadingCarePlans] = useState(false);

  // 第5表プレビュー表示
  const [showPreview, setShowPreview] = useState(false);

  // Dialog state
  const [showDialog, setShowDialog] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Delete confirm
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Derived ──
  const selectedUser = useMemo(
    () => users.find((u) => u.id === selectedUserId) ?? null,
    [users, selectedUserId]
  );

  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      if (filterCategory && r.category !== filterCategory) return false;
      if (startDate) {
        try {
          const rd = parseISO(r.record_date);
          if (rd < startOfDay(parseISO(startDate))) return false;
        } catch { /* ignore */ }
      }
      if (endDate) {
        try {
          const rd = parseISO(r.record_date);
          if (rd > endOfDay(parseISO(endDate))) return false;
        } catch { /* ignore */ }
      }
      return true;
    });
  }, [records, filterCategory, startDate, endDate]);

  // ── Load users ──
  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, name_kana:furigana")
      .eq("status", "active")
      .eq("is_facility", false)
      .order("furigana", { ascending: true });
    if (error) {
      toast.error("利用者の取得に失敗しました: " + error.message);
    } else {
      setUsers(data ?? []);
    }
    setLoadingUsers(false);
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchUsers();
  }, [fetchUsers]);

  // ── Load care plans ──
  const fetchCarePlans = useCallback(async () => {
    if (!selectedUserId) {
      setCarePlans([]);
      setSelectedCarePlanId(null);
      return;
    }
    setLoadingCarePlans(true);
    try {
      const { data } = await supabase
        .from("kaigo_care_plans")
        .select("id, plan_number, plan_type, start_date, end_date, status")
        .eq("user_id", selectedUserId)
        .order("start_date", { ascending: false });
      const plans = (data as CarePlanSummary[]) ?? [];
      setCarePlans(plans);
      // 切替先利用者の計画一覧に現在のプランIDが含まれていなければ最新を選択
      if (plans.length === 0) {
        setSelectedCarePlanId(null);
      } else {
        setSelectedCarePlanId((prev) => {
          if (prev && plans.some((p) => p.id === prev)) return prev;
          const active = plans.find((p) => p.status === "active");
          return active?.id ?? plans[0].id;
        });
      }
    } finally {
      setLoadingCarePlans(false);
    }
  }, [supabase, selectedUserId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchCarePlans();
  }, [fetchCarePlans]);

  // ── Load records ──
  const fetchRecords = useCallback(async () => {
    if (!selectedUserId) {
      setRecords([]);
      return;
    }
    setLoadingRecords(true);
    try {
      let query = supabase
        .from("kaigo_support_records")
        .select("*")
        .eq("user_id", selectedUserId);
      if (selectedCarePlanId) {
        query = query.eq("care_plan_id", selectedCarePlanId);
      }
      const { data, error } = await query
        .order("record_date", { ascending: false })
        .order("record_time", { ascending: false });
      if (error) throw error;
      setRecords(data ?? []);
    } catch (err: unknown) {
      toast.error(
        "記録の取得に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoadingRecords(false);
    }
  }, [supabase, selectedUserId, selectedCarePlanId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchRecords();
  }, [fetchRecords]);

  // ── Dialog open/close ──
  const openNew = () => {
    setEditId(null);
    setForm({ ...EMPTY_FORM });
    setShowDialog(true);
  };

  const openEdit = (rec: SupportRecord) => {
    setEditId(rec.id);
    setForm({
      record_date: rec.record_date,
      record_time: rec.record_time ?? "",
      category: rec.category,
      content: rec.content,
      staff_name: rec.staff_name ?? "",
    });
    setShowDialog(true);
  };

  const closeDialog = () => {
    setShowDialog(false);
    setEditId(null);
  };

  // ── Save ──
  const handleSave = async () => {
    if (!form.record_date) {
      toast.error("日付は必須です");
      return;
    }
    if (!form.content.trim()) {
      toast.error("内容は必須です");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        user_id: selectedUserId,
        care_plan_id: selectedCarePlanId,
        record_date: form.record_date,
        record_time: form.record_time || null,
        category: form.category,
        content: form.content.trim(),
        staff_name: form.staff_name.trim() || null,
      };

      if (editId) {
        const { error } = await supabase
          .from("kaigo_support_records")
          .update(payload)
          .eq("id", editId);
        if (error) throw error;
        toast.success("記録を更新しました");
      } else {
        const { error } = await supabase
          .from("kaigo_support_records")
          .insert(payload);
        if (error) throw error;
        toast.success("記録を登録しました");
      }
      closeDialog();
      fetchRecords();
    } catch (err: unknown) {
      toast.error(
        "保存に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  // ── Delete ──
  const handleDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("kaigo_support_records")
        .delete()
        .eq("id", deleteId);
      if (error) throw error;
      toast.success("記録を削除しました");
      setDeleteId(null);
      fetchRecords();
    } catch (err: unknown) {
      toast.error(
        "削除に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setDeleting(false);
    }
  };

  // ── Print ──
  const handlePrint = () => {
    window.print();
  };

  // ── CSV Export ──
  const handleExportCSV = () => {
    const header = ["日付", "時刻", "区分", "内容", "記録者"];
    const rows = filteredRecords.map((r) => [
      escapeCSV(r.record_date),
      escapeCSV(r.record_time),
      escapeCSV(r.category),
      escapeCSV(r.content),
      escapeCSV(r.staff_name),
    ]);
    const csv =
      "\uFEFF" + // BOM for Excel
      [header.map(escapeCSV).join(","), ...rows.map((r) => r.join(","))].join(
        "\r\n"
      );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const fileName = `支援経過記録_${selectedUser?.name ?? ""}${startDate ? "_" + startDate : ""}${endDate ? "_" + endDate : ""}.csv`;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSVをエクスポートしました");
  };

  // ── Period label for print ──
  const periodLabel = useMemo(() => {
    if (startDate && endDate)
      return `${format(parseISO(startDate), "yyyy年M月d日")} ～ ${format(parseISO(endDate), "yyyy年M月d日")}`;
    if (startDate) return `${format(parseISO(startDate), "yyyy年M月d日")} ～`;
    if (endDate) return `～ ${format(parseISO(endDate), "yyyy年M月d日")}`;
    return "全期間";
  }, [startDate, endDate]);

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Print styles ── */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #support-records-print, #support-records-print * { visibility: visible !important; }
          #support-records-print {
            position: fixed; inset: 0;
            padding: 8mm;
            background: white;
            font-family: "MS Mincho","游明朝","Hiragino Mincho ProN",serif;
            color: #000;
          }
          #support-records-screen { display: none !important; }
          @page { size: A4 landscape; margin: 0; }
        }
      `}</style>

      {/* ── Screen view ── */}
      <div id="support-records-screen" className="flex h-full -m-6">
        <UserSidebar selectedUserId={selectedUserId} onSelectUser={setSelectedUserId} />
        <div className="flex-1 overflow-y-auto p-6">
      <div className="space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <ClipboardList className="text-blue-600" size={24} />
            <h1 className="text-xl font-bold text-gray-900">支援経過記録（第5表）</h1>
            {selectedUser && (
              <span className="text-gray-500 text-sm">— {selectedUser.name} 様</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selectedUserId && (
              <>
                <button
                  onClick={handleExportCSV}
                  disabled={filteredRecords.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-40"
                >
                  <Download size={14} />
                  CSV
                </button>
                <button
                  onClick={() => setShowPreview((v) => !v)}
                  disabled={filteredRecords.length === 0}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors disabled:opacity-40 ${
                    showPreview
                      ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                      : "text-gray-600 hover:bg-gray-50"
                  }`}
                  title="第5表プレビューを画面上で確認"
                >
                  <FileText size={14} />
                  {showPreview ? "プレビュー閉じる" : "プレビュー"}
                </button>
                <button
                  onClick={handlePrint}
                  disabled={filteredRecords.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-40"
                >
                  <Printer size={14} />
                  印刷
                </button>
                <button
                  onClick={() => setShowUrlModal(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 hover:bg-blue-100 transition-colors"
                >
                  <Link2 size={14} />
                  スマホURL発行
                </button>
                <button
                  onClick={openNew}
                  disabled={!selectedCarePlanId}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  title={!selectedCarePlanId ? "ケアプラン期間を選択してください" : ""}
                >
                  <Plus size={14} />
                  新規記録
                </button>
              </>
            )}
          </div>
        </div>

        {/* 計画期間タブ */}
        {selectedUserId && (loadingCarePlans ? (
          <div className="rounded-lg border bg-white p-4 text-center text-xs text-gray-400">
            ケアプランを読み込み中...
          </div>
        ) : carePlans.length === 0 ? (
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
        ))}

        {/* Filters */}
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex flex-wrap gap-4 items-end">
            {/* Date range */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                開始日
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                終了日
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {/* Category filter */}
            <div className="min-w-[160px]">
              <label className="block text-xs font-medium text-gray-600 mb-1">
                区分
              </label>
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 w-full"
              >
                <option value="">すべて</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            {/* Clear filters */}
            {(startDate || endDate || filterCategory) && (
              <button
                onClick={() => {
                  setStartDate("");
                  setEndDate("");
                  setFilterCategory("");
                }}
                className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
              >
                <X size={12} />
                絞り込み解除
              </button>
            )}
          </div>
        </div>

        {/* Empty state: no user selected */}
        {!selectedUserId && (
          <div className="rounded-lg border bg-white py-16 text-center shadow-sm">
            <FileText size={40} className="mx-auto mb-3 text-gray-300" />
            <p className="text-sm text-gray-500">
              利用者を選択してください
            </p>
          </div>
        )}

        {/* Loading */}
        {selectedUserId && loadingRecords && (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-blue-500" />
          </div>
        )}

        {/* 第5表 プレビュー（画面表示） */}
        {selectedUserId && !loadingRecords && showPreview && filteredRecords.length > 0 && selectedUser && (
          <div className="rounded-lg border-2 border-indigo-200 bg-white shadow-md">
            <div className="flex items-center justify-between border-b border-indigo-100 bg-indigo-50 px-4 py-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-indigo-700">
                <FileText size={16} />
                第5表 居宅介護支援経過 プレビュー
              </div>
              <button
                onClick={() => setShowPreview(false)}
                className="text-xs text-indigo-600 hover:underline"
              >
                閉じる
              </button>
            </div>
            <div className="p-6 overflow-x-auto" style={{ fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif' }}>
              {(() => {
                const B = "1px solid #000";
                const cellBase: React.CSSProperties = {
                  border: B,
                  padding: "1mm 2mm",
                  fontSize: "9pt",
                  verticalAlign: "top",
                  lineHeight: 1.3,
                };
                const thStyle: React.CSSProperties = {
                  ...cellBase,
                  textAlign: "center",
                  fontWeight: "bold",
                  background: "#fff",
                };
                const fmtYmd = (d: string | null | undefined) => {
                  if (!d) return "";
                  try {
                    const dt = parseISO(d);
                    return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
                  } catch {
                    return d;
                  }
                };
                const half = Math.ceil(filteredRecords.length / 2);
                const leftRecords = filteredRecords.slice(0, half);
                const rightRecords = filteredRecords.slice(half);
                const rowCount = Math.max(leftRecords.length, rightRecords.length, 22);

                return (
                  <div style={{ minWidth: "260mm", color: "#000" }}>
                    {/* ヘッダー */}
                    <div style={{ position: "relative", marginBottom: "3mm" }}>
                      <div style={{ border: B, display: "inline-block", padding: "1px 8px", fontSize: "9pt" }}>
                        第５表
                      </div>
                      <div
                        style={{
                          position: "absolute", left: 0, right: 0, top: 0,
                          textAlign: "center", fontSize: "14pt", fontWeight: "bold",
                          letterSpacing: "0.2em",
                        }}
                      >
                        居宅介護支援経過
                      </div>
                      <div style={{ position: "absolute", right: 0, top: "2px", fontSize: "9pt" }}>
                        作成年月日　　年　　月　　日
                      </div>
                    </div>

                    {/* 利用者名・計画作成者 */}
                    <div style={{ display: "flex", gap: "16px", fontSize: "10pt", marginBottom: "4mm" }}>
                      <div style={{ flex: 1, borderBottom: B, paddingBottom: "1mm" }}>
                        利用者名　{selectedUser.name}　殿
                      </div>
                      <div style={{ flex: 1, borderBottom: B, paddingBottom: "1mm" }}>
                        居宅サービス計画作成者氏名
                      </div>
                    </div>

                    {/* 2カラムグループのテーブル */}
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <colgroup>
                        <col style={{ width: "7%" }} />
                        <col style={{ width: "11%" }} />
                        <col style={{ width: "32%" }} />
                        <col style={{ width: "7%" }} />
                        <col style={{ width: "11%" }} />
                        <col style={{ width: "32%" }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th style={thStyle}>年月日</th>
                          <th style={{ ...thStyle, color: "#c00" }}>項　目</th>
                          <th style={thStyle}>内　容</th>
                          <th style={thStyle}>年月日</th>
                          <th style={{ ...thStyle, color: "#c00" }}>項　目</th>
                          <th style={thStyle}>内　容</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: rowCount }).map((_, i) => {
                          const left = leftRecords[i];
                          const right = rightRecords[i];
                          const isEmpty = !left && !right;
                          return (
                            <tr key={i} style={{ height: isEmpty ? "18mm" : "6mm" }}>
                              <td style={cellBase}>{fmtYmd(left?.record_date)}</td>
                              <td style={cellBase}>{left?.category ?? ""}</td>
                              <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{left?.content ?? ""}</td>
                              <td style={cellBase}>{fmtYmd(right?.record_date)}</td>
                              <td style={cellBase}>{right?.category ?? ""}</td>
                              <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{right?.content ?? ""}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* No records */}
        {selectedUserId && !loadingRecords && filteredRecords.length === 0 && (
          <div className="rounded-lg border bg-white py-16 text-center shadow-sm">
            <ClipboardList size={40} className="mx-auto mb-3 text-gray-300" />
            <p className="text-sm text-gray-500">
              {records.length === 0
                ? "記録がありません"
                : "条件に一致する記録がありません"}
            </p>
            {records.length === 0 && (
              <button
                onClick={openNew}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
              >
                <Plus size={14} />
                最初の記録を追加
              </button>
            )}
          </div>
        )}

        {/* Timeline */}
        {selectedUserId && !loadingRecords && filteredRecords.length > 0 && (
          <div className="rounded-lg border bg-white shadow-sm">
            {/* Summary bar */}
            <div className="flex items-center justify-between px-5 py-3 border-b bg-gray-50 rounded-t-lg">
              <span className="text-sm text-gray-600">
                <span className="font-semibold text-gray-900">
                  {filteredRecords.length}
                </span>{" "}
                件の記録
                {(startDate || endDate || filterCategory) && (
                  <span className="ml-2 text-xs text-gray-400">（絞り込み中）</span>
                )}
              </span>
            </div>

            {/* Timeline list */}
            <div className="px-5 py-4">
              <div className="relative">
                {/* Vertical line */}
                <div className="absolute left-[88px] top-0 bottom-0 w-px bg-gray-200" />

                <div className="space-y-0">
                  {filteredRecords.map((rec, idx) => {
                    const colors = CATEGORY_COLORS[rec.category] ?? CATEGORY_COLORS["その他"];
                    const dotColor = CATEGORY_TIMELINE_COLORS[rec.category] ?? "bg-gray-400";
                    const isLast = idx === filteredRecords.length - 1;

                    return (
                      <div
                        key={rec.id}
                        className={`relative flex gap-0 ${isLast ? "" : "pb-4"}`}
                      >
                        {/* Left: date/time column */}
                        <div className="w-[88px] shrink-0 pt-2 pr-4 text-right">
                          <div className="text-xs font-semibold text-gray-700 leading-tight">
                            {formatDateShort(rec.record_date)}
                          </div>
                          {rec.record_time && (
                            <div className="text-xs text-gray-400 mt-0.5 flex items-center justify-end gap-0.5">
                              <Clock size={10} />
                              {rec.record_time.slice(0, 5)}
                            </div>
                          )}
                        </div>

                        {/* Timeline dot */}
                        <div className="relative flex flex-col items-center shrink-0" style={{ width: 0 }}>
                          <div
                            className={`absolute top-2.5 -translate-x-1/2 w-3 h-3 rounded-full border-2 border-white shadow ${dotColor}`}
                            style={{ left: 0 }}
                          />
                        </div>

                        {/* Right: content card */}
                        <div className="flex-1 ml-5 rounded-lg border bg-gray-50 p-3 hover:bg-white transition-colors group">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              {/* Category badge */}
                              <span
                                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border ${colors.bg} ${colors.text} ${colors.border}`}
                              >
                                <CategoryIcon category={rec.category} size={11} />
                                {rec.category}
                              </span>
                              {rec.staff_name && (
                                <span className="text-xs text-gray-400">
                                  記録者：{rec.staff_name}
                                </span>
                              )}
                            </div>
                            {/* Edit / Delete buttons（常時表示） */}
                            <div className="flex gap-1 shrink-0">
                              <button
                                onClick={() => openEdit(rec)}
                                className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 hover:border-gray-400 hover:bg-gray-50 transition-colors"
                                title="編集"
                              >
                                <Pencil size={12} />
                                編集
                              </button>
                              <button
                                onClick={() => setDeleteId(rec.id)}
                                className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-600 hover:border-red-500 hover:bg-red-50 transition-colors"
                                title="この記録を削除（誤入力時用）"
                              >
                                <Trash2 size={12} />
                                削除
                              </button>
                            </div>
                          </div>
                          {/* Content */}
                          <p className="mt-2 text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                            {rec.content}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
        </div>
      </div>

      {/* ── Record Form Dialog ── */}
      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={closeDialog}
          />
          {/* Modal */}
          <div className="relative w-full max-w-lg rounded-xl bg-white shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-base font-semibold text-gray-900">
                {editId ? "支援経過記録を編集" : "新規支援経過記録"}
              </h2>
              <button
                onClick={closeDialog}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Modal body */}
            <div className="px-6 py-5 space-y-4">
              {/* Date / Time */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    日付 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={form.record_date}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, record_date: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    時刻
                  </label>
                  <input
                    type="time"
                    value={form.record_time}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, record_time: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
              </div>

              {/* Category */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  区分 <span className="text-red-500">*</span>
                </label>
                <select
                  value={form.category}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      category: e.target.value as RecordCategory,
                    }))
                  }
                  className={inputClass}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              {/* Content */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-gray-700">
                    内容 <span className="text-red-500">*</span>
                  </label>
                  <TemplatePicker category="support_record" currentText={form.content} onInsert={(v) => setForm((p) => ({ ...p, content: v }))} />
                </div>
                <textarea
                  value={form.content}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, content: e.target.value }))
                  }
                  rows={6}
                  placeholder="支援内容を記入してください..."
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
                />
              </div>

              {/* Staff name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  記録者
                </label>
                <input
                  type="text"
                  value={form.staff_name}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, staff_name: e.target.value }))
                  }
                  placeholder="担当者名"
                  className={inputClass}
                />
              </div>
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t bg-gray-50 rounded-b-xl">
              <button
                onClick={closeDialog}
                className="inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <X size={14} />
                キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {saving ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Save size={14} />
                )}
                {saving ? "保存中..." : editId ? "更新" : "登録"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Dialog ── */}
      {deleteId && (() => {
        const target = records.find((r) => r.id === deleteId);
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDeleteId(null)}
          />
          <div className="relative w-full max-w-md rounded-xl bg-white shadow-2xl p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100">
                <Trash2 size={18} className="text-red-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900">本当にこの支援経過を削除しますか？</h3>
                <p className="mt-1 text-sm text-gray-500">
                  誤って入力した記録を取り消す場合に使用します。<br />
                  <span className="text-red-600 font-medium">この操作は取り消せません。</span>
                </p>
              </div>
            </div>

            {/* 削除対象プレビュー */}
            {target && (
              <div className="mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2.5">
                <div className="flex items-center gap-2 text-xs text-gray-600 mb-1">
                  <Clock size={11} />
                  <span className="font-semibold">{formatDateTime(target.record_date, target.record_time)}</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-gray-700 border">
                    {target.category}
                  </span>
                  {target.staff_name && (
                    <span className="text-[10px] text-gray-400">記録者：{target.staff_name}</span>
                  )}
                </div>
                <p className="text-xs text-gray-700 whitespace-pre-wrap line-clamp-3 leading-relaxed">
                  {target.content}
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteId(null)}
                className="rounded-lg border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Trash2 size={14} />
                )}
                {deleting ? "削除中..." : "削除する"}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* ── Print view (第5表 居宅介護支援経過) ── */}
      <div id="support-records-print" className="hidden">
        {selectedUser && (() => {
          const B = "1px solid #000";
          const cellBase: React.CSSProperties = {
            border: B,
            padding: "1mm 2mm",
            fontSize: "8pt",
            verticalAlign: "top",
            lineHeight: 1.3,
          };
          const thStyle: React.CSSProperties = {
            ...cellBase,
            textAlign: "center",
            fontWeight: "bold",
            background: "#fff",
          };
          const fmtYmd = (d: string | null | undefined) => {
            if (!d) return "";
            try {
              const dt = parseISO(d);
              return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
            } catch {
              return d;
            }
          };
          // レコードを2列に半分ずつ分割（左→右の順で上から埋めていく）
          const half = Math.ceil(filteredRecords.length / 2);
          const leftRecords = filteredRecords.slice(0, half);
          const rightRecords = filteredRecords.slice(half);
          // 最低行数を揃える
          const rowCount = Math.max(leftRecords.length, rightRecords.length, 22);

          return (
            <>
              {/* ヘッダー: 第5表ラベル / タイトル / 作成年月日 */}
              <div style={{ position: "relative", marginBottom: "3mm" }}>
                <div style={{ border: B, display: "inline-block", padding: "1px 8px", fontSize: "8pt" }}>
                  第５表
                </div>
                <div
                  style={{
                    position: "absolute", left: 0, right: 0, top: 0,
                    textAlign: "center", fontSize: "13pt", fontWeight: "bold",
                    letterSpacing: "0.2em",
                  }}
                >
                  居宅介護支援経過
                </div>
                <div style={{ position: "absolute", right: 0, top: "2px", fontSize: "8pt" }}>
                  作成年月日　　年　　月　　日
                </div>
              </div>

              {/* 利用者名・計画作成者 */}
              <div style={{ display: "flex", gap: "16px", fontSize: "9pt", marginBottom: "4mm" }}>
                <div style={{ flex: 1, borderBottom: B, paddingBottom: "1mm" }}>
                  利用者名　{selectedUser.name}　殿
                </div>
                <div style={{ flex: 1, borderBottom: B, paddingBottom: "1mm" }}>
                  居宅サービス計画作成者氏名
                </div>
              </div>

              {/* 2カラムグループのテーブル */}
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <colgroup>
                  <col style={{ width: "7%" }} />
                  <col style={{ width: "11%" }} />
                  <col style={{ width: "32%" }} />
                  <col style={{ width: "7%" }} />
                  <col style={{ width: "11%" }} />
                  <col style={{ width: "32%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={thStyle}>年月日</th>
                    <th style={{ ...thStyle, color: "#c00" }}>項　目</th>
                    <th style={thStyle}>内　容</th>
                    <th style={thStyle}>年月日</th>
                    <th style={{ ...thStyle, color: "#c00" }}>項　目</th>
                    <th style={thStyle}>内　容</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: rowCount }).map((_, i) => {
                    const left = leftRecords[i];
                    const right = rightRecords[i];
                    const isEmpty = !left && !right;
                    return (
                      <tr key={i} style={{ height: isEmpty ? "18mm" : "6mm" }}>
                        <td style={cellBase}>{fmtYmd(left?.record_date)}</td>
                        <td style={cellBase}>{left?.category ?? ""}</td>
                        <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{left?.content ?? ""}</td>
                        <td style={cellBase}>{fmtYmd(right?.record_date)}</td>
                        <td style={cellBase}>{right?.category ?? ""}</td>
                        <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{right?.content ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          );
        })()}
      </div>

      {/* スマホURL発行モーダル */}
      {showUrlModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowUrlModal(false)}>
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-bold text-gray-900">支援経過スマホURL管理</h2>
              <button onClick={() => setShowUrlModal(false)} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="flex gap-2">
                <input
                  value={newUrlName}
                  onChange={(e) => setNewUrlName(e.target.value)}
                  placeholder="URL名（例: 訪問記録用）"
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
                <button onClick={createUrl} disabled={urlLoading} className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                  {urlLoading ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                  発行
                </button>
              </div>
              <div className="space-y-3">
                {urls.map((u) => {
                  const url = `${typeof window !== "undefined" ? window.location.origin : ""}/support/${u.token}`;
                  return (
                    <div key={u.id} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-bold text-gray-900">{u.name}</span>
                        <button onClick={() => deleteUrl(u.id)} className="text-xs text-red-500 hover:underline">削除</button>
                      </div>
                      <div className="flex items-center gap-2">
                        <input readOnly value={url} className="flex-1 text-xs bg-gray-50 border rounded px-2 py-1.5 text-gray-600" />
                        <button onClick={() => copyUrl(u.token)} className="shrink-0 p-1.5 rounded hover:bg-gray-100"><Copy size={14} className="text-gray-500" /></button>
                      </div>
                    </div>
                  );
                })}
                {urls.length === 0 && <p className="text-sm text-gray-400 text-center py-4">URLがまだ発行されていません</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
