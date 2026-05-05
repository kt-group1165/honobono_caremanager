"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { Plus, Pencil, Trash2, X, Save, HeartPulse } from "lucide-react";
import type { HealthRecord } from "@/types/database";

type FormData = {
  record_date: string;
  temperature: string;
  blood_pressure_sys: string;
  blood_pressure_dia: string;
  pulse: string;
  weight: string;
  height: string;
  spo2: string;
  recorder_name: string;
  notes: string;
};

const EMPTY_FORM: FormData = {
  record_date: "",
  temperature: "",
  blood_pressure_sys: "",
  blood_pressure_dia: "",
  pulse: "",
  weight: "",
  height: "",
  spo2: "",
  recorder_name: "",
  notes: "",
};

const inputClass =
  "w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

function numOrNull(v: string): number | null {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

export default function HealthPage() {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const supabase = createClient();

  const [records, setRecords] = useState<HealthRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_health_records")
        .select("*")
        .eq("user_id", userId)
        .order("record_date", { ascending: false });
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
    setForm({
      ...EMPTY_FORM,
      record_date: format(new Date(), "yyyy-MM-dd"),
    });
    setShowForm(true);
  };

  const openEdit = (rec: HealthRecord) => {
    setEditId(rec.id);
    setForm({
      record_date: rec.record_date ?? "",
      temperature: rec.temperature?.toString() ?? "",
      blood_pressure_sys: rec.blood_pressure_sys?.toString() ?? "",
      blood_pressure_dia: rec.blood_pressure_dia?.toString() ?? "",
      pulse: rec.pulse?.toString() ?? "",
      weight: rec.weight?.toString() ?? "",
      height: rec.height?.toString() ?? "",
      spo2: rec.spo2?.toString() ?? "",
      recorder_name: rec.recorder_name ?? "",
      notes: rec.notes ?? "",
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.record_date) {
      toast.error("記録日は必須です");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        user_id: userId,
        record_date: form.record_date,
        temperature: numOrNull(form.temperature),
        blood_pressure_sys: numOrNull(form.blood_pressure_sys),
        blood_pressure_dia: numOrNull(form.blood_pressure_dia),
        pulse: numOrNull(form.pulse),
        weight: numOrNull(form.weight),
        height: numOrNull(form.height),
        spo2: numOrNull(form.spo2),
        recorder_name: form.recorder_name || null,
        notes: form.notes || null,
      };

      if (editId) {
        const { error } = await supabase
          .from("kaigo_health_records")
          .update(payload)
          .eq("id", editId);
        if (error) throw error;
        toast.success("更新しました");
      } else {
        const { error } = await supabase
          .from("kaigo_health_records")
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
    if (!confirm("この健康記録を削除しますか？")) return;
    try {
      const { error } = await supabase
        .from("kaigo_health_records")
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
        <h2 className="text-base font-semibold text-gray-800">健康管理</h2>
        {!showForm && (
          <button
            onClick={openNew}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Plus size={14} />
            新規記録
          </button>
        )}
      </div>

      {/* Form */}
      {showForm && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-blue-800">
            {editId ? "健康記録を編集" : "新規健康記録"}
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                記録日 <span className="text-red-500">*</span>
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
                体温（℃）
              </label>
              <input
                type="number"
                step="0.1"
                min="30"
                max="45"
                value={form.temperature}
                onChange={(e) =>
                  setForm((p) => ({ ...p, temperature: e.target.value }))
                }
                placeholder="36.5"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                血圧 収縮期（mmHg）
              </label>
              <input
                type="number"
                min="50"
                max="300"
                value={form.blood_pressure_sys}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    blood_pressure_sys: e.target.value,
                  }))
                }
                placeholder="120"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                血圧 拡張期（mmHg）
              </label>
              <input
                type="number"
                min="30"
                max="200"
                value={form.blood_pressure_dia}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    blood_pressure_dia: e.target.value,
                  }))
                }
                placeholder="80"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                脈拍（回/分）
              </label>
              <input
                type="number"
                min="20"
                max="300"
                value={form.pulse}
                onChange={(e) =>
                  setForm((p) => ({ ...p, pulse: e.target.value }))
                }
                placeholder="72"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                SpO2（%）
              </label>
              <input
                type="number"
                step="0.1"
                min="50"
                max="100"
                value={form.spo2}
                onChange={(e) =>
                  setForm((p) => ({ ...p, spo2: e.target.value }))
                }
                placeholder="98"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                体重（kg）
              </label>
              <input
                type="number"
                step="0.1"
                min="10"
                max="300"
                value={form.weight}
                onChange={(e) =>
                  setForm((p) => ({ ...p, weight: e.target.value }))
                }
                placeholder="60.0"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                身長（cm）
              </label>
              <input
                type="number"
                step="0.1"
                min="50"
                max="250"
                value={form.height}
                onChange={(e) =>
                  setForm((p) => ({ ...p, height: e.target.value }))
                }
                placeholder="160.0"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                記録者
              </label>
              <input
                type="text"
                value={form.recorder_name}
                onChange={(e) =>
                  setForm((p) => ({ ...p, recorder_name: e.target.value }))
                }
                className={inputClass}
                placeholder="記録者名"
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
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

      {/* Table */}
      {loading ? (
        <div className="py-10 text-center text-sm text-gray-400">
          読み込み中...
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-gray-400">
          <HeartPulse size={36} className="mb-2 opacity-30" />
          <p className="text-sm">健康記録がありません</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b">
                <th className="px-3 py-2 text-left font-medium text-gray-600">
                  記録日
                </th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">
                  体温
                </th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">
                  血圧
                </th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">
                  脈拍
                </th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">
                  SpO2
                </th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">
                  体重
                </th>
                <th className="px-3 py-2 text-left font-medium text-gray-600">
                  記録者
                </th>
                <th className="px-3 py-2 text-left font-medium text-gray-600">
                  備考
                </th>
                <th className="px-3 py-2 text-center font-medium text-gray-600">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {records.map((rec) => (
                <tr key={rec.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium text-gray-800">
                    {rec.record_date
                      ? format(parseISO(rec.record_date), "yyyy/MM/dd")
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-700">
                    {rec.temperature != null ? `${rec.temperature}℃` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-700">
                    {rec.blood_pressure_sys != null &&
                    rec.blood_pressure_dia != null
                      ? `${rec.blood_pressure_sys}/${rec.blood_pressure_dia}`
                      : rec.blood_pressure_sys != null
                        ? `${rec.blood_pressure_sys}/—`
                        : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-700">
                    {rec.pulse != null ? `${rec.pulse}回` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-700">
                    {rec.spo2 != null ? `${rec.spo2}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-700">
                    {rec.weight != null ? `${rec.weight}kg` : "—"}
                  </td>
                  <td className="px-3 py-2 text-gray-600 max-w-[100px] truncate">
                    {rec.recorder_name ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-gray-600 max-w-[150px] truncate">
                    {rec.notes ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="flex justify-center gap-1">
                      <button
                        onClick={() => openEdit(rec)}
                        className="rounded p-1.5 text-gray-500 hover:bg-gray-200 transition-colors"
                        title="編集"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => handleDelete(rec.id)}
                        className="rounded p-1.5 text-red-400 hover:bg-red-50 transition-colors"
                        title="削除"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
