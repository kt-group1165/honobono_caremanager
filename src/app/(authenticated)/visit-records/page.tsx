"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  Plus,
  X,
  Save,
  Loader2,
  ClipboardList,
  Clock,
  User,
  Thermometer,
  Heart,
  ChevronDown,
  ChevronUp,
  CalendarDays,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KaigoStaff {
  id: string;
  name: string;
}

type ServiceType = "身体介護" | "生活援助" | "身体・生活" | "通院等乗降介助";

interface VisitRecord {
  id: string;
  user_id: string;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  service_type: ServiceType;
  staff_id: string | null;
  staff_name?: string | null;
  // body care
  care_excretion: boolean;
  care_meal: boolean;
  care_bath: boolean;
  care_wipe: boolean;
  care_positioning: boolean;
  care_transfer: boolean;
  care_dressing: boolean;
  care_oral: boolean;
  care_medication: boolean;
  // living support
  support_cooking: boolean;
  support_laundry: boolean;
  support_cleaning: boolean;
  support_shopping: boolean;
  support_trash: boolean;
  support_clothing: boolean;
  // vitals
  temperature: number | null;
  bp_sys: number | null;
  bp_dia: number | null;
  pulse: number | null;
  // notes
  user_condition: string | null;
  notes: string | null;
  created_at: string;
}

type FormData = {
  visit_date: string;
  staff_id: string;
  service_type: ServiceType;
  start_time: string;
  end_time: string;
  // body care
  care_excretion: boolean;
  care_meal: boolean;
  care_bath: boolean;
  care_wipe: boolean;
  care_positioning: boolean;
  care_transfer: boolean;
  care_dressing: boolean;
  care_oral: boolean;
  care_medication: boolean;
  // living support
  support_cooking: boolean;
  support_laundry: boolean;
  support_cleaning: boolean;
  support_shopping: boolean;
  support_trash: boolean;
  support_clothing: boolean;
  // vitals
  temperature: string;
  bp_sys: string;
  bp_dia: string;
  pulse: string;
  // notes
  user_condition: string;
  notes: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVICE_TYPES: ServiceType[] = [
  "身体介護",
  "生活援助",
  "身体・生活",
  "通院等乗降介助",
];

const SERVICE_TYPE_COLORS: Record<ServiceType, { bg: string; text: string; border: string }> = {
  身体介護: { bg: "bg-blue-100", text: "text-blue-700", border: "border-blue-200" },
  生活援助: { bg: "bg-green-100", text: "text-green-700", border: "border-green-200" },
  "身体・生活": { bg: "bg-purple-100", text: "text-purple-700", border: "border-purple-200" },
  通院等乗降介助: { bg: "bg-orange-100", text: "text-orange-700", border: "border-orange-200" },
};

const BODY_CARE_ITEMS: { key: keyof FormData; label: string }[] = [
  { key: "care_excretion", label: "排泄介助" },
  { key: "care_meal", label: "食事介助" },
  { key: "care_bath", label: "入浴介助" },
  { key: "care_wipe", label: "清拭" },
  { key: "care_positioning", label: "体位変換" },
  { key: "care_transfer", label: "移動介助" },
  { key: "care_dressing", label: "更衣介助" },
  { key: "care_oral", label: "口腔ケア" },
  { key: "care_medication", label: "服薬介助" },
];

const LIVING_SUPPORT_ITEMS: { key: keyof FormData; label: string }[] = [
  { key: "support_cooking", label: "調理" },
  { key: "support_laundry", label: "洗濯" },
  { key: "support_cleaning", label: "掃除" },
  { key: "support_shopping", label: "買物" },
  { key: "support_trash", label: "ゴミ出し" },
  { key: "support_clothing", label: "衣類の整理" },
];

const EMPTY_FORM: FormData = {
  visit_date: format(new Date(), "yyyy-MM-dd"),
  staff_id: "",
  service_type: "身体介護",
  start_time: "",
  end_time: "",
  care_excretion: false,
  care_meal: false,
  care_bath: false,
  care_wipe: false,
  care_positioning: false,
  care_transfer: false,
  care_dressing: false,
  care_oral: false,
  care_medication: false,
  support_cooking: false,
  support_laundry: false,
  support_cleaning: false,
  support_shopping: false,
  support_trash: false,
  support_clothing: false,
  temperature: "",
  bp_sys: "",
  bp_dia: "",
  pulse: "",
  user_condition: "",
  notes: "",
};

const inputClass =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatVisitDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "yyyy年M月d日(E)", { locale: ja });
  } catch {
    return dateStr;
  }
}

function formatTimeRange(start: string | null, end: string | null): string {
  if (!start && !end) return "時間未記録";
  if (start && end) return `${start} 〜 ${end}`;
  if (start) return `${start} 〜`;
  return `〜 ${end}`;
}

function calcDuration(start: string | null, end: string | null): string {
  if (!start || !end) return "";
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}時間${m > 0 ? m + "分" : ""}` : `${m}分`;
}

function getActiveCareItems(record: VisitRecord): string[] {
  const items: string[] = [];
  if (record.care_excretion) items.push("排泄介助");
  if (record.care_meal) items.push("食事介助");
  if (record.care_bath) items.push("入浴介助");
  if (record.care_wipe) items.push("清拭");
  if (record.care_positioning) items.push("体位変換");
  if (record.care_transfer) items.push("移動介助");
  if (record.care_dressing) items.push("更衣介助");
  if (record.care_oral) items.push("口腔ケア");
  if (record.care_medication) items.push("服薬介助");
  if (record.support_cooking) items.push("調理");
  if (record.support_laundry) items.push("洗濯");
  if (record.support_cleaning) items.push("掃除");
  if (record.support_shopping) items.push("買物");
  if (record.support_trash) items.push("ゴミ出し");
  if (record.support_clothing) items.push("衣類の整理");
  return items;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function VisitRecordsPage() {
  const supabase = createClient();

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [records, setRecords] = useState<VisitRecord[]>([]);
  const [staffList, setStaffList] = useState<KaigoStaff[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Fetch staff list once
  useEffect(() => {
    const fetchStaff = async () => {
      const { data } = await supabase
        .from("kaigo_staff")
        .select("id, name")
        .order("name");
      setStaffList(data || []);
    };
    fetchStaff();
  }, []);

  // Fetch records when user changes
  const fetchRecords = useCallback(async (userId: string) => {
    setLoading(true);
    setRecords([]);
    const { data, error } = await supabase
      .from("kaigo_visit_records")
      .select("*, kaigo_staff(name)")
      .eq("user_id", userId)
      .order("visit_date", { ascending: false })
      .order("start_time", { ascending: false });
    if (error) {
      toast.error("記録の取得に失敗しました");
    } else {
      const mapped = (data || []).map((r: any) => ({
        ...r,
        staff_name: r.kaigo_staff?.name ?? null,
      }));
      setRecords(mapped);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (selectedUserId) {
      fetchRecords(selectedUserId);
      setShowForm(false);
      setExpandedId(null);
    }
  }, [selectedUserId, fetchRecords]);

  // Form helpers
  const setField = <K extends keyof FormData>(key: K, value: FormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleBool = (key: keyof FormData) => {
    setForm((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleOpenForm = () => {
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!selectedUserId) return;
    if (!form.visit_date) { toast.error("訪問日を入力してください"); return; }

    setSaving(true);
    const payload = {
      user_id: selectedUserId,
      visit_date: form.visit_date,
      staff_id: form.staff_id || null,
      service_type: form.service_type,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      care_excretion: form.care_excretion,
      care_meal: form.care_meal,
      care_bath: form.care_bath,
      care_wipe: form.care_wipe,
      care_positioning: form.care_positioning,
      care_transfer: form.care_transfer,
      care_dressing: form.care_dressing,
      care_oral: form.care_oral,
      care_medication: form.care_medication,
      support_cooking: form.support_cooking,
      support_laundry: form.support_laundry,
      support_cleaning: form.support_cleaning,
      support_shopping: form.support_shopping,
      support_trash: form.support_trash,
      support_clothing: form.support_clothing,
      temperature: form.temperature ? parseFloat(form.temperature) : null,
      bp_sys: form.bp_sys ? parseInt(form.bp_sys) : null,
      bp_dia: form.bp_dia ? parseInt(form.bp_dia) : null,
      pulse: form.pulse ? parseInt(form.pulse) : null,
      user_condition: form.user_condition || null,
      notes: form.notes || null,
    };

    const { error } = await supabase.from("kaigo_visit_records").insert(payload);
    setSaving(false);

    if (error) {
      toast.error("保存に失敗しました: " + error.message);
    } else {
      toast.success("サービス実施記録を保存しました");
      setShowForm(false);
      fetchRecords(selectedUserId);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* Sidebar */}
      <UserSidebar
        selectedUserId={selectedUserId}
        onSelectUser={setSelectedUserId}
      />

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b bg-white px-6 py-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">サービス実施記録</h1>
            <p className="mt-0.5 text-xs text-gray-500">訪問介護サービスの実施内容を記録します</p>
          </div>
          {selectedUserId && (
            <button
              onClick={handleOpenForm}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
            >
              <Plus size={16} />
              新規記録
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto bg-gray-50 p-6">
          {!selectedUserId ? (
            <div className="flex h-48 items-center justify-center text-sm text-gray-400">
              <div className="text-center">
                <User size={32} className="mx-auto mb-2 text-gray-300" />
                <p>左の利用者一覧から対象者を選択してください</p>
              </div>
            </div>
          ) : loading ? (
            <div className="flex h-48 items-center justify-center text-sm text-gray-400">
              <Loader2 size={20} className="animate-spin mr-2" />
              読込中...
            </div>
          ) : records.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-gray-400">
              <div className="text-center">
                <ClipboardList size={32} className="mx-auto mb-2 text-gray-300" />
                <p>記録がありません</p>
                <button
                  onClick={handleOpenForm}
                  className="mt-3 text-blue-600 hover:underline text-xs"
                >
                  新規記録を作成する
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {records.map((rec) => {
                const colors = SERVICE_TYPE_COLORS[rec.service_type] ?? SERVICE_TYPE_COLORS["身体介護"];
                const isExpanded = expandedId === rec.id;
                const careItems = getActiveCareItems(rec);
                const duration = calcDuration(rec.start_time, rec.end_time);
                return (
                  <div
                    key={rec.id}
                    className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden"
                  >
                    {/* Card header */}
                    <button
                      className="flex w-full items-start gap-4 p-4 text-left hover:bg-gray-50 transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : rec.id)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="flex items-center gap-1 text-sm font-semibold text-gray-900">
                            <CalendarDays size={14} className="text-gray-400" />
                            {formatVisitDate(rec.visit_date)}
                          </span>
                          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${colors.bg} ${colors.text} ${colors.border}`}>
                            {rec.service_type}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
                          <span className="flex items-center gap-1">
                            <Clock size={12} />
                            {formatTimeRange(rec.start_time, rec.end_time)}
                            {duration && <span className="ml-1 text-gray-400">({duration})</span>}
                          </span>
                          {rec.staff_name && (
                            <span className="flex items-center gap-1">
                              <User size={12} />
                              {rec.staff_name}
                            </span>
                          )}
                        </div>
                        {careItems.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {careItems.map((item) => (
                              <span
                                key={item}
                                className="rounded-md bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600"
                              >
                                {item}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-gray-400 mt-1">
                        {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </div>
                    </button>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="border-t bg-gray-50 px-4 py-4 space-y-3">
                        {/* Vitals */}
                        {(rec.temperature || rec.bp_sys || rec.pulse) && (
                          <div>
                            <p className="mb-1.5 text-xs font-semibold text-gray-600 flex items-center gap-1">
                              <Thermometer size={12} />
                              バイタル
                            </p>
                            <div className="flex flex-wrap gap-4 text-sm text-gray-700">
                              {rec.temperature && (
                                <span>体温: <strong>{rec.temperature}℃</strong></span>
                              )}
                              {rec.bp_sys && rec.bp_dia && (
                                <span>血圧: <strong>{rec.bp_sys}/{rec.bp_dia} mmHg</strong></span>
                              )}
                              {rec.pulse && (
                                <span className="flex items-center gap-1">
                                  <Heart size={12} className="text-red-400" />
                                  脈拍: <strong>{rec.pulse} bpm</strong>
                                </span>
                              )}
                            </div>
                          </div>
                        )}

                        {/* User condition */}
                        {rec.user_condition && (
                          <div>
                            <p className="mb-1 text-xs font-semibold text-gray-600">利用者の状態</p>
                            <p className="text-sm text-gray-700 whitespace-pre-wrap">{rec.user_condition}</p>
                          </div>
                        )}

                        {/* Notes */}
                        {rec.notes && (
                          <div>
                            <p className="mb-1 text-xs font-semibold text-gray-600">特記事項</p>
                            <p className="text-sm text-gray-700 whitespace-pre-wrap">{rec.notes}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-start justify-end overflow-auto bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl flex flex-col max-h-[calc(100vh-2rem)]">
            {/* Modal header */}
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="text-base font-bold text-gray-900">サービス実施記録 — 新規</h2>
              <button
                onClick={() => setShowForm(false)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {/* 基本情報 */}
              <section>
                <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-gray-500">基本情報</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="mb-1 block text-xs font-medium text-gray-700">訪問日 <span className="text-red-500">*</span></label>
                    <input
                      type="date"
                      value={form.visit_date}
                      onChange={(e) => setField("visit_date", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">開始時刻</label>
                    <input
                      type="time"
                      value={form.start_time}
                      onChange={(e) => setField("start_time", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">終了時刻</label>
                    <input
                      type="time"
                      value={form.end_time}
                      onChange={(e) => setField("end_time", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="mb-1 block text-xs font-medium text-gray-700">サービス種別</label>
                    <select
                      value={form.service_type}
                      onChange={(e) => setField("service_type", e.target.value as ServiceType)}
                      className={inputClass}
                    >
                      {SERVICE_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="mb-1 block text-xs font-medium text-gray-700">担当職員</label>
                    <select
                      value={form.staff_id}
                      onChange={(e) => setField("staff_id", e.target.value)}
                      className={inputClass}
                    >
                      <option value="">— 選択してください —</option>
                      {staffList.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </section>

              {/* 身体介護 */}
              <section>
                <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-gray-500">身体介護</h3>
                <div className="grid grid-cols-3 gap-2">
                  {BODY_CARE_ITEMS.map(({ key, label }) => (
                    <label
                      key={key}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        form[key]
                          ? "border-blue-400 bg-blue-50 text-blue-700"
                          : "border-gray-200 text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={form[key] as boolean}
                        onChange={() => toggleBool(key)}
                        className="accent-blue-600"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </section>

              {/* 生活援助 */}
              <section>
                <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-gray-500">生活援助</h3>
                <div className="grid grid-cols-3 gap-2">
                  {LIVING_SUPPORT_ITEMS.map(({ key, label }) => (
                    <label
                      key={key}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        form[key]
                          ? "border-green-400 bg-green-50 text-green-700"
                          : "border-gray-200 text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={form[key] as boolean}
                        onChange={() => toggleBool(key)}
                        className="accent-green-600"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </section>

              {/* バイタル */}
              <section>
                <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-gray-500">バイタルサイン</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">体温 (℃)</label>
                    <input
                      type="number"
                      step="0.1"
                      min="33"
                      max="42"
                      placeholder="36.5"
                      value={form.temperature}
                      onChange={(e) => setField("temperature", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">脈拍 (bpm)</label>
                    <input
                      type="number"
                      min="0"
                      max="250"
                      placeholder="72"
                      value={form.pulse}
                      onChange={(e) => setField("pulse", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">収縮期血圧 (mmHg)</label>
                    <input
                      type="number"
                      min="0"
                      max="300"
                      placeholder="120"
                      value={form.bp_sys}
                      onChange={(e) => setField("bp_sys", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">拡張期血圧 (mmHg)</label>
                    <input
                      type="number"
                      min="0"
                      max="200"
                      placeholder="80"
                      value={form.bp_dia}
                      onChange={(e) => setField("bp_dia", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
              </section>

              {/* 状態・特記 */}
              <section>
                <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-gray-500">状態・特記事項</h3>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">利用者の状態</label>
                    <textarea
                      rows={3}
                      placeholder="訪問時の利用者の状態・様子を記入してください"
                      value={form.user_condition}
                      onChange={(e) => setField("user_condition", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">特記事項</label>
                    <textarea
                      rows={3}
                      placeholder="申し送り事項・連絡事項など"
                      value={form.notes}
                      onChange={(e) => setField("notes", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
              </section>
            </div>

            {/* Modal footer */}
            <div className="flex justify-end gap-3 border-t bg-gray-50 px-5 py-4">
              <button
                onClick={() => setShowForm(false)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
              >
                {saving ? (
                  <><Loader2 size={15} className="animate-spin" /> 保存中...</>
                ) : (
                  <><Save size={15} /> 保存</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
