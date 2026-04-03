"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { Plus, Pencil, Trash2, X, Save, Activity } from "lucide-react";
import type { AdlRecord } from "@/types/database";

// Barthel Index items with options
const ADL_ITEMS: {
  key: keyof AdlScores;
  label: string;
  options: { value: number; label: string }[];
}[] = [
  {
    key: "eating",
    label: "食事",
    options: [
      { value: 0, label: "0: 全介助" },
      { value: 5, label: "5: 一部介助" },
      { value: 10, label: "10: 自立" },
    ],
  },
  {
    key: "transfer",
    label: "移乗",
    options: [
      { value: 0, label: "0: 全介助" },
      { value: 5, label: "5: 大介助" },
      { value: 10, label: "10: 小介助" },
      { value: 15, label: "15: 自立" },
    ],
  },
  {
    key: "grooming",
    label: "整容",
    options: [
      { value: 0, label: "0: 介助" },
      { value: 5, label: "5: 自立" },
    ],
  },
  {
    key: "toilet",
    label: "トイレ",
    options: [
      { value: 0, label: "0: 全介助" },
      { value: 5, label: "5: 一部介助" },
      { value: 10, label: "10: 自立" },
    ],
  },
  {
    key: "bathing",
    label: "入浴",
    options: [
      { value: 0, label: "0: 介助" },
      { value: 5, label: "5: 自立" },
    ],
  },
  {
    key: "mobility",
    label: "移動",
    options: [
      { value: 0, label: "0: 不能" },
      { value: 5, label: "5: 車椅子自立" },
      { value: 10, label: "10: 介助歩行" },
      { value: 15, label: "15: 自立歩行" },
    ],
  },
  {
    key: "stairs",
    label: "階段",
    options: [
      { value: 0, label: "0: 不能" },
      { value: 5, label: "5: 介助" },
      { value: 10, label: "10: 自立" },
    ],
  },
  {
    key: "dressing",
    label: "着替え",
    options: [
      { value: 0, label: "0: 全介助" },
      { value: 5, label: "5: 一部介助" },
      { value: 10, label: "10: 自立" },
    ],
  },
  {
    key: "bowel",
    label: "排便コントロール",
    options: [
      { value: 0, label: "0: 失禁" },
      { value: 5, label: "5: 時々失禁" },
      { value: 10, label: "10: コントロール可" },
    ],
  },
  {
    key: "bladder",
    label: "排尿コントロール",
    options: [
      { value: 0, label: "0: 失禁" },
      { value: 5, label: "5: 時々失禁" },
      { value: 10, label: "10: コントロール可" },
    ],
  },
];

type AdlScores = {
  eating: number;
  transfer: number;
  grooming: number;
  toilet: number;
  bathing: number;
  mobility: number;
  stairs: number;
  dressing: number;
  bowel: number;
  bladder: number;
};

type FormData = AdlScores & {
  assessment_date: string;
  assessor_name: string;
  notes: string;
};

const EMPTY_FORM: FormData = {
  assessment_date: "",
  eating: 10,
  transfer: 15,
  grooming: 5,
  toilet: 10,
  bathing: 5,
  mobility: 15,
  stairs: 10,
  dressing: 10,
  bowel: 10,
  bladder: 10,
  assessor_name: "",
  notes: "",
};

const inputClass =
  "w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

function calcTotal(f: AdlScores): number {
  return (
    f.eating +
    f.transfer +
    f.grooming +
    f.toilet +
    f.bathing +
    f.mobility +
    f.stairs +
    f.dressing +
    f.bowel +
    f.bladder
  );
}

function scoreColor(total: number): string {
  if (total >= 85) return "text-green-700 bg-green-100";
  if (total >= 60) return "text-yellow-700 bg-yellow-100";
  if (total >= 40) return "text-orange-700 bg-orange-100";
  return "text-red-700 bg-red-100";
}

export default function AdlPage() {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const supabase = createClient();

  const [records, setRecords] = useState<AdlRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_adl_records")
        .select("*")
        .eq("user_id", userId)
        .order("assessment_date", { ascending: false });
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

  const currentTotal = calcTotal(form);

  const openNew = () => {
    setEditId(null);
    setForm({
      ...EMPTY_FORM,
      assessment_date: format(new Date(), "yyyy-MM-dd"),
    });
    setShowForm(true);
  };

  const openEdit = (rec: AdlRecord) => {
    setEditId(rec.id);
    setForm({
      assessment_date: rec.assessment_date ?? "",
      eating: rec.eating,
      transfer: rec.transfer,
      grooming: rec.grooming,
      toilet: rec.toilet,
      bathing: rec.bathing,
      mobility: rec.mobility,
      stairs: rec.stairs,
      dressing: rec.dressing,
      bowel: rec.bowel,
      bladder: rec.bladder,
      assessor_name: rec.assessor_name ?? "",
      notes: rec.notes ?? "",
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.assessment_date) {
      toast.error("評価日は必須です");
      return;
    }
    setSaving(true);
    try {
      const total = calcTotal(form);
      const payload = {
        user_id: userId,
        assessment_date: form.assessment_date,
        eating: form.eating,
        transfer: form.transfer,
        grooming: form.grooming,
        toilet: form.toilet,
        bathing: form.bathing,
        mobility: form.mobility,
        stairs: form.stairs,
        dressing: form.dressing,
        bowel: form.bowel,
        bladder: form.bladder,
        total_score: total,
        assessor_name: form.assessor_name || null,
        notes: form.notes || null,
      };

      if (editId) {
        const { error } = await supabase
          .from("kaigo_adl_records")
          .update(payload)
          .eq("id", editId);
        if (error) throw error;
        toast.success("更新しました");
      } else {
        const { error } = await supabase
          .from("kaigo_adl_records")
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
    if (!confirm("このADL記録を削除しますか？")) return;
    try {
      const { error } = await supabase
        .from("kaigo_adl_records")
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
        <h2 className="text-base font-semibold text-gray-800">
          ADL記録（バーセルインデックス）
        </h2>
        {!showForm && (
          <button
            onClick={openNew}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Plus size={14} />
            新規評価
          </button>
        )}
      </div>

      {/* Form */}
      {showForm && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-blue-800">
              {editId ? "ADL評価を編集" : "新規ADL評価"}
            </h3>
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-bold ${scoreColor(currentTotal)}`}
            >
              合計: {currentTotal} / 100点
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                評価日 <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={form.assessment_date}
                onChange={(e) =>
                  setForm((p) => ({ ...p, assessment_date: e.target.value }))
                }
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                評価者
              </label>
              <input
                type="text"
                value={form.assessor_name}
                onChange={(e) =>
                  setForm((p) => ({ ...p, assessor_name: e.target.value }))
                }
                className={inputClass}
                placeholder="評価者名"
              />
            </div>
          </div>

          <div className="rounded-md border bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-3 py-2 text-left font-medium text-gray-600 w-32">
                    項目
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">
                    評価
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-gray-600 w-16">
                    点数
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {ADL_ITEMS.map((item) => (
                  <tr key={item.key}>
                    <td className="px-3 py-2 font-medium text-gray-700">
                      {item.label}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={form[item.key]}
                        onChange={(e) =>
                          setForm((p) => ({
                            ...p,
                            [item.key]: Number(e.target.value),
                          }))
                        }
                        className="rounded border px-2 py-1 text-sm focus:border-blue-500 focus:outline-none w-full max-w-xs"
                      >
                        {item.options.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-blue-700">
                      {form[item.key]}
                    </td>
                  </tr>
                ))}
                <tr className="bg-blue-50 font-semibold">
                  <td className="px-3 py-2 text-gray-800" colSpan={2}>
                    合計
                  </td>
                  <td className="px-3 py-2 text-right text-blue-700">
                    {currentTotal}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
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
          <Activity size={36} className="mb-2 opacity-30" />
          <p className="text-sm">ADL記録がありません</p>
        </div>
      ) : (
        <div className="space-y-3">
          {records.map((rec) => (
            <div
              key={rec.id}
              className="rounded-lg border bg-gray-50 p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-gray-700">
                    {rec.assessment_date
                      ? format(parseISO(rec.assessment_date), "yyyy年M月d日")
                      : "—"}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-3 py-0.5 text-sm font-bold ${scoreColor(rec.total_score)}`}
                  >
                    {rec.total_score} / 100点
                  </span>
                  {rec.assessor_name && (
                    <span className="text-xs text-gray-500">
                      評価者: {rec.assessor_name}
                    </span>
                  )}
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
              <div className="grid grid-cols-5 gap-1 text-xs sm:grid-cols-10">
                {ADL_ITEMS.map((item) => (
                  <div
                    key={item.key}
                    className="flex flex-col items-center rounded bg-white border p-1.5 text-center"
                  >
                    <span className="text-gray-500 leading-tight">
                      {item.label}
                    </span>
                    <span className="font-semibold text-blue-700 mt-0.5">
                      {rec[item.key]}
                    </span>
                  </div>
                ))}
              </div>
              {rec.notes && (
                <p className="text-xs text-gray-500 whitespace-pre-wrap">
                  {rec.notes}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
