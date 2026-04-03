"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { Plus, Pencil, Trash2, X, Save, FileCheck } from "lucide-react";
import type { CareCertification, CareLevel } from "@/types/database";

const CARE_LEVELS: CareLevel[] = [
  "申請中",
  "非該当",
  "要支援1",
  "要支援2",
  "要介護1",
  "要介護2",
  "要介護3",
  "要介護4",
  "要介護5",
];

const CERT_STATUS_LABELS: Record<string, string> = {
  active: "有効",
  expired: "期限切れ",
  pending: "申請中",
};
const CERT_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  expired: "bg-gray-100 text-gray-600",
  pending: "bg-yellow-100 text-yellow-800",
};

type FormData = {
  certification_number: string;
  care_level: CareLevel;
  start_date: string;
  end_date: string;
  certification_date: string;
  insurer_number: string;
  insured_number: string;
  support_limit_amount: string;
  status: string;
};

const EMPTY_FORM: FormData = {
  certification_number: "",
  care_level: "申請中",
  start_date: "",
  end_date: "",
  certification_date: "",
  insurer_number: "",
  insured_number: "",
  support_limit_amount: "",
  status: "active",
};

const inputClass =
  "w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  try {
    return format(parseISO(d), "yyyy年M月d日");
  } catch {
    return d;
  }
}

export default function CareCertPage() {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const supabase = createClient();

  const [records, setRecords] = useState<CareCertification[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_care_certifications")
        .select("*")
        .eq("user_id", userId)
        .order("start_date", { ascending: false });
      if (error) throw error;
      setRecords(data ?? []);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [supabase, userId]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const openNew = () => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (rec: CareCertification) => {
    setEditId(rec.id);
    setForm({
      certification_number: rec.certification_number ?? "",
      care_level: rec.care_level,
      start_date: rec.start_date ?? "",
      end_date: rec.end_date ?? "",
      certification_date: rec.certification_date ?? "",
      insurer_number: rec.insurer_number ?? "",
      insured_number: rec.insured_number ?? "",
      support_limit_amount: rec.support_limit_amount?.toString() ?? "",
      status: rec.status ?? "active",
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.start_date) {
      toast.error("認定開始日は必須です");
      return;
    }
    if (!form.end_date) {
      toast.error("認定終了日は必須です");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        user_id: userId,
        certification_number: form.certification_number || null,
        care_level: form.care_level,
        start_date: form.start_date,
        end_date: form.end_date,
        certification_date: form.certification_date || null,
        insurer_number: form.insurer_number || null,
        insured_number: form.insured_number || null,
        support_limit_amount: form.support_limit_amount
          ? Number(form.support_limit_amount)
          : null,
        status: form.status,
      };

      if (editId) {
        const { error } = await supabase
          .from("kaigo_care_certifications")
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq("id", editId);
        if (error) throw error;
        toast.success("更新しました");
      } else {
        const { error } = await supabase
          .from("kaigo_care_certifications")
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
    if (!confirm("この認定情報を削除しますか？")) return;
    try {
      const { error } = await supabase
        .from("kaigo_care_certifications")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success("削除しました");
      fetchRecords();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "削除に失敗しました");
    }
  };

  return (
    <div className="rounded-b-lg border border-t-0 bg-white p-6 shadow-sm space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-800">介護認定</h2>
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
            {editId ? "認定情報を編集" : "新規認定情報"}
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                介護度 <span className="text-red-500">*</span>
              </label>
              <select
                value={form.care_level}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    care_level: e.target.value as CareLevel,
                  }))
                }
                className={inputClass}
              >
                {CARE_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                ステータス
              </label>
              <select
                value={form.status}
                onChange={(e) =>
                  setForm((p) => ({ ...p, status: e.target.value }))
                }
                className={inputClass}
              >
                <option value="active">有効</option>
                <option value="expired">期限切れ</option>
                <option value="pending">申請中</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                認定開始日 <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={form.start_date}
                onChange={(e) =>
                  setForm((p) => ({ ...p, start_date: e.target.value }))
                }
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                認定終了日 <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={form.end_date}
                onChange={(e) =>
                  setForm((p) => ({ ...p, end_date: e.target.value }))
                }
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                認定日
              </label>
              <input
                type="date"
                value={form.certification_date}
                onChange={(e) =>
                  setForm((p) => ({ ...p, certification_date: e.target.value }))
                }
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                認定番号
              </label>
              <input
                type="text"
                value={form.certification_number}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    certification_number: e.target.value,
                  }))
                }
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                保険者番号
              </label>
              <input
                type="text"
                value={form.insurer_number}
                onChange={(e) =>
                  setForm((p) => ({ ...p, insurer_number: e.target.value }))
                }
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                被保険者番号
              </label>
              <input
                type="text"
                value={form.insured_number}
                onChange={(e) =>
                  setForm((p) => ({ ...p, insured_number: e.target.value }))
                }
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                支給限度額（円）
              </label>
              <input
                type="number"
                value={form.support_limit_amount}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    support_limit_amount: e.target.value,
                  }))
                }
                min="0"
                className={inputClass}
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
          <FileCheck size={36} className="mb-2 opacity-30" />
          <p className="text-sm">介護認定情報がありません</p>
        </div>
      ) : (
        <div className="space-y-3">
          {records.map((rec) => (
            <div
              key={rec.id}
              className="rounded-lg border bg-gray-50 p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-sm font-semibold text-blue-800">
                    {rec.care_level}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CERT_STATUS_COLORS[rec.status] ?? "bg-gray-100 text-gray-600"}`}
                  >
                    {CERT_STATUS_LABELS[rec.status] ?? rec.status}
                  </span>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => openEdit(rec)}
                    className="rounded p-1.5 text-gray-500 hover:bg-gray-200 transition-colors"
                    title="編集"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(rec.id)}
                    className="rounded p-1.5 text-red-400 hover:bg-red-50 transition-colors"
                    title="削除"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                <div>
                  <span className="text-gray-500">認定期間：</span>
                  <span className="text-gray-800">
                    {formatDate(rec.start_date)} 〜 {formatDate(rec.end_date)}
                  </span>
                </div>
                {rec.certification_date && (
                  <div>
                    <span className="text-gray-500">認定日：</span>
                    <span className="text-gray-800">
                      {formatDate(rec.certification_date)}
                    </span>
                  </div>
                )}
                {rec.certification_number && (
                  <div>
                    <span className="text-gray-500">認定番号：</span>
                    <span className="text-gray-800">
                      {rec.certification_number}
                    </span>
                  </div>
                )}
                {rec.insurer_number && (
                  <div>
                    <span className="text-gray-500">保険者番号：</span>
                    <span className="text-gray-800">{rec.insurer_number}</span>
                  </div>
                )}
                {rec.insured_number && (
                  <div>
                    <span className="text-gray-500">被保険者番号：</span>
                    <span className="text-gray-800">{rec.insured_number}</span>
                  </div>
                )}
                {rec.support_limit_amount != null && (
                  <div>
                    <span className="text-gray-500">支給限度額：</span>
                    <span className="text-gray-800">
                      {rec.support_limit_amount.toLocaleString()}円
                    </span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
