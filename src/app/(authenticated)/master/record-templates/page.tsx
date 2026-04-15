"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Plus, Save, Trash2, X, Edit3, FileText, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { clearTemplateCache } from "@/components/templates/template-picker";

type Template = {
  id: string;
  category: string;
  label: string;
  content: string;
  sort_order: number;
};

const CATEGORIES = [
  { value: "common", label: "共通", color: "bg-gray-100 text-gray-700" },
  { value: "visit_record", label: "訪問記録", color: "bg-blue-100 text-blue-700" },
  { value: "support_record", label: "支援経過", color: "bg-green-100 text-green-700" },
];

const emptyForm = () => ({
  id: "",
  category: "common",
  label: "",
  content: "",
  sort_order: 0,
});

export default function RecordTemplatesPage() {
  const supabase = useMemo(() => createClient(), []);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<string>("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("kaigo_record_templates").select("*").order("sort_order");
    setTemplates((data || []) as Template[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSave = async () => {
    if (!form.label.trim() || !form.content.trim()) { toast.error("ラベルと本文を入力してください"); return; }
    setSaving(true);
    const payload = {
      category: form.category,
      label: form.label.trim(),
      content: form.content.trim(),
      sort_order: form.sort_order,
    };
    if (form.id) {
      const { error } = await supabase.from("kaigo_record_templates").update(payload).eq("id", form.id);
      if (error) toast.error("更新に失敗: " + error.message);
      else { toast.success("更新しました"); setShowForm(false); clearTemplateCache(); fetchData(); }
    } else {
      const { error } = await supabase.from("kaigo_record_templates").insert(payload);
      if (error) toast.error("追加に失敗: " + error.message);
      else { toast.success("追加しました"); setShowForm(false); clearTemplateCache(); fetchData(); }
    }
    setSaving(false);
  };

  const handleEdit = (t: Template) => {
    setForm({ id: t.id, category: t.category, label: t.label, content: t.content, sort_order: t.sort_order });
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この定型文を削除しますか？")) return;
    const { error } = await supabase.from("kaigo_record_templates").delete().eq("id", id);
    if (error) toast.error("削除に失敗: " + error.message);
    else { toast.success("削除しました"); clearTemplateCache(); fetchData(); }
  };

  const filtered = filter ? templates.filter((t) => t.category === filter) : templates;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText size={22} className="text-purple-600" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">定型文マスタ</h1>
            <p className="text-xs text-gray-500">訪問記録・支援経過で使う定型文を管理</p>
          </div>
        </div>
        <button
          onClick={() => { setForm(emptyForm()); setShowForm(true); }}
          className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus size={15} />
          新規追加
        </button>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        <button
          onClick={() => setFilter("")}
          className={cn(
            "px-3 py-1.5 rounded-full text-xs font-medium border",
            filter === "" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"
          )}
        >
          すべて（{templates.length}）
        </button>
        {CATEGORIES.map((c) => {
          const count = templates.filter((t) => t.category === c.value).length;
          return (
            <button
              key={c.value}
              onClick={() => setFilter(c.value)}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-medium border",
                filter === c.value ? "bg-blue-600 text-white border-blue-600" : `${c.color} border-transparent`
              )}
            >
              {c.label}（{count}）
            </button>
          );
        })}
      </div>

      {/* Templates list */}
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-blue-500" /></div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border bg-white p-12 text-center text-sm text-gray-400">定型文がありません</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((t) => {
            const cat = CATEGORIES.find((c) => c.value === t.category);
            return (
              <div key={t.id} className="rounded-xl border bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", cat?.color)}>{cat?.label}</span>
                    <span className="text-sm font-bold text-gray-900">{t.label}</span>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => handleEdit(t)} className="p-1.5 rounded hover:bg-gray-100 text-gray-500"><Edit3 size={14} /></button>
                    <button onClick={() => handleDelete(t.id)} className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                  </div>
                </div>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{t.content}</p>
              </div>
            );
          })}
        </div>
      )}

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowForm(false)}>
          <div className="w-full max-w-lg rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-bold text-gray-900">{form.id ? "定型文を編集" : "定型文を追加"}</h2>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">カテゴリ</label>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <p className="text-[10px] text-gray-400 mt-0.5">共通 = 両方に表示、訪問記録 = 訪問記録のみ、支援経過 = 支援経過のみ</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">ラベル（選択時の表示名）<span className="text-red-500">*</span></label>
                <input
                  type="text"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="例: 体調安定"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">本文 <span className="text-red-500">*</span></label>
                <textarea
                  rows={5}
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  placeholder="テンプレートの本文を入力してください..."
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none resize-y"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">並び順（数値が小さいほど上）</label>
                <input
                  type="number"
                  value={form.sort_order}
                  onChange={(e) => setForm({ ...form, sort_order: parseInt(e.target.value) || 0 })}
                  className="w-32 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t bg-gray-50 px-5 py-4">
              <button onClick={() => setShowForm(false)} className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">キャンセル</button>
              <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                {saving ? <><Loader2 size={14} className="animate-spin" /> 保存中...</> : <><Save size={14} /> 保存</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
