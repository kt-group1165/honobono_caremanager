"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, X, Save, Users, Star } from "lucide-react";
import type { FamilyContact } from "@/types/database";

type FormData = {
  name: string;
  relationship: string;
  phone: string;
  address: string;
  is_key_person: boolean;
  notes: string;
};

const EMPTY_FORM: FormData = {
  name: "",
  relationship: "",
  phone: "",
  address: "",
  is_key_person: false,
  notes: "",
};

const RELATIONSHIPS = [
  "配偶者",
  "長男",
  "長女",
  "次男",
  "次女",
  "兄",
  "姉",
  "弟",
  "妹",
  "父",
  "母",
  "祖父",
  "祖母",
  "孫",
  "おい",
  "めい",
  "ケアマネジャー",
  "成年後見人",
  "その他",
];

const inputClass =
  "w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

export default function FamilyPage() {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const supabase = createClient();

  const [records, setRecords] = useState<FamilyContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_family_contacts")
        .select("*")
        .eq("user_id", userId)
        .order("is_key_person", { ascending: false });
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

  const openEdit = (rec: FamilyContact) => {
    setEditId(rec.id);
    setForm({
      name: rec.name ?? "",
      relationship: rec.relationship ?? "",
      phone: rec.phone ?? "",
      address: rec.address ?? "",
      is_key_person: rec.is_key_person ?? false,
      notes: rec.notes ?? "",
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error("氏名は必須です");
      return;
    }
    if (!form.relationship.trim()) {
      toast.error("続柄は必須です");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        user_id: userId,
        name: form.name.trim(),
        relationship: form.relationship.trim(),
        phone: form.phone || null,
        address: form.address || null,
        is_key_person: form.is_key_person,
        notes: form.notes || null,
      };

      if (editId) {
        const { error } = await supabase
          .from("kaigo_family_contacts")
          .update(payload)
          .eq("id", editId);
        if (error) throw error;
        toast.success("更新しました");
      } else {
        const { error } = await supabase
          .from("kaigo_family_contacts")
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
    if (!confirm("この関係者情報を削除しますか？")) return;
    try {
      const { error } = await supabase
        .from("kaigo_family_contacts")
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
        <h2 className="text-base font-semibold text-gray-800">親族・関係者</h2>
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
            {editId ? "関係者情報を編集" : "新規関係者情報"}
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                氏名 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) =>
                  setForm((p) => ({ ...p, name: e.target.value }))
                }
                placeholder="山田 太郎"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                続柄 <span className="text-red-500">*</span>
              </label>
              <select
                value={form.relationship}
                onChange={(e) =>
                  setForm((p) => ({ ...p, relationship: e.target.value }))
                }
                className={inputClass}
              >
                <option value="">選択してください</option>
                {RELATIONSHIPS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                電話番号
              </label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) =>
                  setForm((p) => ({ ...p, phone: e.target.value }))
                }
                placeholder="090-1234-5678"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                住所
              </label>
              <input
                type="text"
                value={form.address}
                onChange={(e) =>
                  setForm((p) => ({ ...p, address: e.target.value }))
                }
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
            <div className="sm:col-span-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_key_person}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, is_key_person: e.target.checked }))
                  }
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"
                />
                <span className="text-sm font-medium text-gray-700">
                  キーパーソンに設定する
                </span>
              </label>
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
          <Users size={36} className="mb-2 opacity-30" />
          <p className="text-sm">関係者情報がありません</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {records.map((rec) => (
            <div
              key={rec.id}
              className={`rounded-lg border p-4 space-y-2 ${rec.is_key_person ? "border-amber-300 bg-amber-50" : "bg-gray-50"}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  {rec.is_key_person && (
                    <Star
                      size={14}
                      className="text-amber-500 shrink-0"
                      fill="currentColor"
                    />
                  )}
                  <div>
                    <p className="font-medium text-gray-900 text-sm">
                      {rec.name}
                    </p>
                    <p className="text-xs text-gray-500">{rec.relationship}</p>
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
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
              {rec.phone && (
                <p className="text-sm text-gray-700">
                  <span className="text-gray-400 text-xs">TEL </span>
                  {rec.phone}
                </p>
              )}
              {rec.address && (
                <p className="text-sm text-gray-700">
                  <span className="text-gray-400 text-xs">住所 </span>
                  {rec.address}
                </p>
              )}
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
