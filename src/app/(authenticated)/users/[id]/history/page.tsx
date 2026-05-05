"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { Plus, Pencil, Trash2, X, Save, ClipboardList } from "lucide-react";
import type { MedicalHistory } from "@/types/database";

type MedicalHistoryStatus = "治療中" | "経過観察" | "完治" | "その他";

type FormData = {
  disease_name: string;
  onset_date: string;
  status: MedicalHistoryStatus;
  hospital: string;
  doctor: string;
  notes: string;
};

const EMPTY_FORM: FormData = {
  disease_name: "",
  onset_date: "",
  status: "治療中",
  hospital: "",
  doctor: "",
  notes: "",
};

const STATUS_OPTIONS: MedicalHistoryStatus[] = [
  "治療中",
  "経過観察",
  "完治",
  "その他",
];

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
const STATUS_COLORS: Record<MedicalHistoryStatus, string> = {
  治療中: "bg-red-100 text-red-700",
  経過観察: "bg-yellow-100 text-yellow-700",
  完治: "bg-green-100 text-green-700",
  その他: "bg-gray-100 text-gray-600",
};

const inputClass =
  "w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  try {
    return format(parseISO(d), "yyyy年M月d日");
  } catch {
    return d;
  }
}

export default function MedicalHistoryPage() {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const supabase = createClient();

  const [records, setRecords] = useState<MedicalHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_medical_history")
        .select("*")
        .eq("user_id", userId)
        .order("onset_date", { ascending: false });
      if (error) throw error;
      setRecords(data ?? []);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [supabase, userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchRecords();
  }, [fetchRecords]);

  const openNew = () => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (rec: MedicalHistory) => {
    setEditId(rec.id);
    setForm({
      disease_name: rec.disease_name ?? "",
      onset_date: rec.onset_date ?? "",
      status: rec.status ?? "治療中",
      hospital: rec.hospital ?? "",
      doctor: rec.doctor ?? "",
      notes: rec.notes ?? "",
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.disease_name.trim()) {
      toast.error("病名は必須です");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        user_id: userId,
        disease_name: form.disease_name.trim(),
        onset_date: form.onset_date || null,
        status: form.status,
        hospital: form.hospital || null,
        doctor: form.doctor || null,
        notes: form.notes || null,
      };

      if (editId) {
        const { error } = await supabase
          .from("kaigo_medical_history")
          .update(payload)
          .eq("id", editId);
        if (error) throw error;
        toast.success("更新しました");
      } else {
        const { error } = await supabase
          .from("kaigo_medical_history")
          .insert(payload);
        if (error) throw error;
        toast.success("登録しました");
      }
      setShowForm(false);
      fetchRecords();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この既往歴を削除しますか？")) return;
    try {
      const { error } = await supabase
        .from("kaigo_medical_history")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success("削除しました");
      fetchRecords();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "削除に失敗しました");
    }
  };

  // Group by status
  const activeRecords = records.filter((r) => r.status === "治療中");
  const otherRecords = records.filter((r) => r.status !== "治療中");

  return (
    <div className="rounded-b-lg border border-t-0 bg-white p-6 shadow-sm space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-800">既往歴</h2>
        {!showForm && (
          <button
            onClick={openNew}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Plus size={14} />
            新規追加
          </button>
        )}
      </div>

      {/* Form */}
      {showForm && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-blue-800">
            {editId ? "既往歴を編集" : "新規既往歴"}
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                病名 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.disease_name}
                onChange={(e) =>
                  setForm((p) => ({ ...p, disease_name: e.target.value }))
                }
                placeholder="高血圧症"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                状態
              </label>
              <select
                value={form.status}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    status: e.target.value as MedicalHistoryStatus,
                  }))
                }
                className={inputClass}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                発症日
              </label>
              <input
                type="date"
                value={form.onset_date}
                onChange={(e) =>
                  setForm((p) => ({ ...p, onset_date: e.target.value }))
                }
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                医療機関
              </label>
              <input
                type="text"
                value={form.hospital}
                onChange={(e) =>
                  setForm((p) => ({ ...p, hospital: e.target.value }))
                }
                placeholder="○○病院"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                担当医
              </label>
              <input
                type="text"
                value={form.doctor}
                onChange={(e) =>
                  setForm((p) => ({ ...p, doctor: e.target.value }))
                }
                placeholder="山田 医師"
                className={inputClass}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                備考
              </label>
              <textarea
                value={form.notes}
                onChange={(e) =>
                  setForm((p) => ({ ...p, notes: e.target.value }))
                }
                rows={2}
                className="w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <button
              onClick={() => setShowForm(false)}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <X size={14} />
              キャンセル
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <Save size={14} />
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="py-10 text-center text-sm text-gray-400">
          読み込み中...
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-gray-400">
          <ClipboardList size={36} className="mb-2 opacity-30" />
          <p className="text-sm">既往歴がありません</p>
        </div>
      ) : (
        <div className="space-y-6">
          {activeRecords.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-600 mb-3">
                治療中
              </h3>
              <div className="space-y-2">
                {activeRecords.map((rec) => (
                  <RecordCard
                    key={rec.id}
                    rec={rec}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            </div>
          )}
          {otherRecords.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-600 mb-3">
                その他
              </h3>
              <div className="space-y-2">
                {otherRecords.map((rec) => (
                  <RecordCard
                    key={rec.id}
                    rec={rec}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RecordCard({
  rec,
  onEdit,
  onDelete,
}: {
  rec: MedicalHistory;
  onEdit: (rec: MedicalHistory) => void;
  onDelete: (id: string) => void;
}) {
  const STATUS_COLORS: Record<string, string> = {
    治療中: "bg-red-100 text-red-700",
    経過観察: "bg-yellow-100 text-yellow-700",
    完治: "bg-green-100 text-green-700",
    その他: "bg-gray-100 text-gray-600",
  };

  return (
    <div className="rounded-lg border bg-gray-50 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-gray-900 text-sm">
            {rec.disease_name}
          </span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[rec.status] ?? "bg-gray-100 text-gray-600"}`}
          >
            {rec.status}
          </span>
        </div>
        <div className="flex gap-1 shrink-0">
          <button
            onClick={() => onEdit(rec)}
            className="rounded p-1.5 text-gray-500 hover:bg-gray-200 transition-colors"
            title="編集"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={() => onDelete(rec.id)}
            className="rounded p-1.5 text-red-400 hover:bg-red-50 transition-colors"
            title="削除"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        {rec.onset_date && (
          <div>
            <span className="text-gray-500 text-xs">発症日：</span>
            <span className="text-gray-800">
              {(() => {
                try {
                  return format(parseISO(rec.onset_date!), "yyyy年M月d日");
                } catch {
                  return rec.onset_date;
                }
              })()}
            </span>
          </div>
        )}
        {rec.hospital && (
          <div>
            <span className="text-gray-500 text-xs">医療機関：</span>
            <span className="text-gray-800">{rec.hospital}</span>
          </div>
        )}
        {rec.doctor && (
          <div>
            <span className="text-gray-500 text-xs">担当医：</span>
            <span className="text-gray-800">{rec.doctor}</span>
          </div>
        )}
      </div>
      {rec.notes && (
        <p className="mt-2 text-xs text-gray-500 whitespace-pre-wrap">
          {rec.notes}
        </p>
      )}
    </div>
  );
}
