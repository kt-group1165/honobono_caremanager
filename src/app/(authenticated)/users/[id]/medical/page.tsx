"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { Plus, Pencil, Trash2, X, Save, ShieldCheck } from "lucide-react";
import type { MedicalInsurance } from "@/types/database";

type FormData = {
  insurance_type: string;
  insurer_number: string;
  insured_number: string;
  start_date: string;
  end_date: string;
  copay_rate: string;
};

const EMPTY_FORM: FormData = {
  insurance_type: "",
  insurer_number: "",
  insured_number: "",
  start_date: "",
  end_date: "",
  copay_rate: "30",
};

const INSURANCE_TYPES = [
  "国民健康保険",
  "協会けんぽ",
  "組合健康保険",
  "共済組合",
  "後期高齢者医療",
  "生活保護",
  "その他",
];

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

export default function MedicalInsurancePage() {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const supabase = createClient();

  const [records, setRecords] = useState<MedicalInsurance[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_medical_insurance")
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

  const openEdit = (rec: MedicalInsurance) => {
    setEditId(rec.id);
    setForm({
      insurance_type: rec.insurance_type ?? "",
      insurer_number: rec.insurer_number ?? "",
      insured_number: rec.insured_number ?? "",
      start_date: rec.start_date ?? "",
      end_date: rec.end_date ?? "",
      copay_rate: rec.copay_rate?.toString() ?? "30",
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.insurance_type.trim()) {
      toast.error("保険の種類は必須です");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        user_id: userId,
        insurance_type: form.insurance_type.trim(),
        insurer_number: form.insurer_number || null,
        insured_number: form.insured_number || null,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        copay_rate: form.copay_rate ? Number(form.copay_rate) : 30,
      };

      if (editId) {
        const { error } = await supabase
          .from("kaigo_medical_insurance")
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq("id", editId);
        if (error) throw error;
        toast.success("更新しました");
      } else {
        const { error } = await supabase
          .from("kaigo_medical_insurance")
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
    if (!confirm("この医療保険情報を削除しますか？")) return;
    try {
      const { error } = await supabase
        .from("kaigo_medical_insurance")
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
        <h2 className="text-base font-semibold text-gray-800">医療保険</h2>
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
            {editId ? "医療保険情報を編集" : "新規医療保険情報"}
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                保険の種類 <span className="text-red-500">*</span>
              </label>
              <select
                value={form.insurance_type}
                onChange={(e) =>
                  setForm((p) => ({ ...p, insurance_type: e.target.value }))
                }
                className={inputClass}
              >
                <option value="">選択してください</option>
                {INSURANCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                自己負担割合（%）
              </label>
              <select
                value={form.copay_rate}
                onChange={(e) =>
                  setForm((p) => ({ ...p, copay_rate: e.target.value }))
                }
                className={inputClass}
              >
                <option value="10">1割（10%）</option>
                <option value="20">2割（20%）</option>
                <option value="30">3割（30%）</option>
              </select>
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
                有効開始日
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
                有効終了日
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
          <ShieldCheck size={36} className="mb-2 opacity-30" />
          <p className="text-sm">医療保険情報がありません</p>
        </div>
      ) : (
        <div className="space-y-3">
          {records.map((rec) => (
            <div
              key={rec.id}
              className="rounded-lg border bg-gray-50 p-4 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="font-medium text-gray-900 text-sm">
                    {rec.insurance_type}
                  </span>
                  <span className="ml-2 inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                    自己負担 {rec.copay_rate}%
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
                {(rec.start_date || rec.end_date) && (
                  <div>
                    <span className="text-gray-500">有効期間：</span>
                    <span className="text-gray-800">
                      {formatDate(rec.start_date)} 〜 {formatDate(rec.end_date)}
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
