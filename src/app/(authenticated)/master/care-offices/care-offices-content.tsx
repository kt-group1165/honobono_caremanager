"use client";

// ケアマネ事業所マスタ (care_offices) 管理画面
// - order-app (福祉用具) と共有のテーブル。他社居宅介護支援事業所が多数入っている
// - 利用者との紐付けは client_insurance_records.care_office_id (介護認定タブで選択)
// - tenant_id は現状 'kt-group' 統一 (Phase 8 office-centric 統合後)

import { useState, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Plus, Trash2, Search, Home, Loader2, Save, X, Pencil } from "lucide-react";

export interface CareOffice {
  id: string;
  tenant_id: string;
  name: string;
  office_number: string | null;
  created_at: string | null;
}

const TENANT_ID = "kt-group";

type FormState = {
  name: string;
  office_number: string;
};

const EMPTY_FORM: FormState = { name: "", office_number: "" };

/** name / office_number のバリデーション。エラーメッセージ or null */
function validateForm(form: FormState): string | null {
  if (!form.name.trim()) return "事業所名は必須です";
  if (form.office_number && !/^\d{10}$/.test(form.office_number))
    return "事業所番号は 10 桁の数字で入力してください";
  return null;
}

/** Supabase error → ユーザー向けメッセージ */
function friendlyError(err: { code?: string; message: string }, action: string): string {
  if (err.code === "23505") return "同名の事業所が既に登録されています";
  if (err.code === "23503")
    return "この事業所は利用者の保険情報等から参照されているため削除できません";
  return `${action}に失敗しました: ${err.message}`;
}

export function CareOfficesContent({ initialOffices }: { initialOffices: CareOffice[] }) {
  const supabase = createClient();

  const [offices, setOffices] = useState<CareOffice[]>(initialOffices);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // 新規追加フォーム
  const [isCreating, setIsCreating] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(EMPTY_FORM);

  // 行インライン編集
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);

  // 削除確認ダイアログ
  const [deleteTarget, setDeleteTarget] = useState<CareOffice | null>(null);

  const fetchOffices = useCallback(async () => {
    const { data, error } = await supabase
      .from("care_offices")
      .select("id, tenant_id, name, office_number, created_at")
      .order("name");
    if (error) {
      console.error("care_offices fetch failed:", error.message);
      toast.error(`ケアマネ事業所の取得に失敗しました: ${error.message}`);
      return;
    }
    setOffices((data ?? []) as CareOffice[]);
  }, [supabase]);

  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q) return offices;
    return offices.filter(
      (o) => o.name.includes(q) || (o.office_number ?? "").includes(q),
    );
  }, [offices, search]);

  // ── 新規追加 ────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    const validationError = validateForm(createForm);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("care_offices").insert({
        tenant_id: TENANT_ID,
        name: createForm.name.trim(),
        office_number: createForm.office_number || null,
      });
      if (error) {
        toast.error(friendlyError(error, "登録"));
        return;
      }
      toast.success("ケアマネ事業所を登録しました");
      setIsCreating(false);
      setCreateForm(EMPTY_FORM);
      await fetchOffices();
    } finally {
      setSaving(false);
    }
  };

  // ── 編集 ────────────────────────────────────────────────────────────────

  const startEdit = (office: CareOffice) => {
    setEditingId(office.id);
    setEditForm({ name: office.name, office_number: office.office_number ?? "" });
  };

  const handleUpdate = async () => {
    if (!editingId) return;
    const validationError = validateForm(editForm);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from("care_offices")
        .update({
          name: editForm.name.trim(),
          office_number: editForm.office_number || null,
        })
        .eq("id", editingId);
      if (error) {
        toast.error(friendlyError(error, "更新"));
        return;
      }
      toast.success("ケアマネ事業所を更新しました");
      setEditingId(null);
      await fetchOffices();
    } finally {
      setSaving(false);
    }
  };

  // ── 削除 ────────────────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("care_offices")
        .delete()
        .eq("id", deleteTarget.id);
      if (error) {
        // 利用者の保険情報 (client_insurance_records.care_office_id) 等から
        // 参照されていると FK 制約 (23503) で失敗する
        toast.error(friendlyError(error, "削除"));
        return;
      }
      toast.success("ケアマネ事業所を削除しました");
      setDeleteTarget(null);
      await fetchOffices();
    } finally {
      setSaving(false);
    }
  };

  // ── レンダリング ──────────────────────────────────────────────────────────

  const numberInputChange = (v: string) => v.replace(/[^0-9]/g, "").slice(0, 10);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Home className="text-rose-600" size={24} />
          <h1 className="text-xl font-bold text-gray-900">ケアマネ事業所マスタ</h1>
          <span className="ml-2 rounded-full bg-gray-100 px-2.5 py-0.5 text-sm text-gray-600">
            {offices.length}件
          </span>
        </div>
        {!isCreating && (
          <button
            onClick={() => {
              setIsCreating(true);
              setCreateForm(EMPTY_FORM);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Plus size={14} />
            新規登録
          </button>
        )}
      </div>

      <p className="text-sm text-gray-500 -mt-3">
        担当居宅介護支援事業所（外部ケアマネ事業所）のマスタです。福祉用具発注アプリ（order-app）と共有しており、利用者の介護認定タブ「担当居宅介護支援事業所」の選択肢になります。
      </p>

      {/* 新規追加フォーム */}
      {isCreating && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-800">新規ケアマネ事業所登録</h2>
            <button
              onClick={() => setIsCreating(false)}
              className="text-gray-400 hover:text-gray-600"
              title="閉じる"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-700">
                事業所名 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={createForm.name}
                onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="〇〇居宅介護支援事業所"
              />
            </div>
            <div className="w-44">
              <label className="mb-1 block text-xs font-medium text-gray-700">
                事業所番号 <span className="text-xs text-gray-400">(10桁・任意)</span>
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={createForm.office_number}
                onChange={(e) =>
                  setCreateForm((p) => ({ ...p, office_number: numberInputChange(e.target.value) }))
                }
                className="w-full rounded-lg border px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="1270000000"
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              登録
            </button>
          </div>
        </div>
      )}

      {/* 検索 */}
      <div className="relative max-w-sm">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border bg-white py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="事業所名・事業所番号で検索"
        />
      </div>

      {/* 一覧テーブル */}
      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-xs text-gray-600">
              <th className="px-4 py-2.5 font-medium">事業所名</th>
              <th className="w-40 px-4 py-2.5 font-medium">事業所番号</th>
              <th className="w-32 px-4 py-2.5 font-medium">登録日</th>
              <th className="w-24 px-4 py-2.5 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-gray-400">
                  <Home size={32} className="mx-auto mb-2 text-gray-300" />
                  {search ? "検索条件に一致する事業所がありません" : "ケアマネ事業所が登録されていません"}
                </td>
              </tr>
            ) : (
              filtered.map((office) => {
                const isEditing = editingId === office.id;
                return (
                  <tr key={office.id} className="border-b last:border-b-0 hover:bg-gray-50">
                    {isEditing ? (
                      <>
                        <td className="px-4 py-2">
                          <input
                            type="text"
                            value={editForm.name}
                            onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                            className="w-full rounded border px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={editForm.office_number}
                            onChange={(e) =>
                              setEditForm((p) => ({
                                ...p,
                                office_number: numberInputChange(e.target.value),
                              }))
                            }
                            className="w-full rounded border px-2 py-1 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            placeholder="10桁"
                          />
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-400">
                          {office.created_at ? office.created_at.slice(0, 10) : "—"}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={handleUpdate}
                              disabled={saving}
                              className="rounded p-1.5 text-blue-600 hover:bg-blue-50 disabled:opacity-50 transition-colors"
                              title="保存"
                            >
                              {saving ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Save size={14} />
                              )}
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              disabled={saving}
                              className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                              title="キャンセル"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-2.5 font-medium text-gray-800">{office.name}</td>
                        <td className="px-4 py-2.5 font-mono text-gray-600">
                          {office.office_number ?? (
                            <span className="text-xs text-gray-300">未登録</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-400">
                          {office.created_at ? office.created_at.slice(0, 10) : "—"}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => startEdit(office)}
                              className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-blue-600 transition-colors"
                              title="編集"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => setDeleteTarget(office)}
                              className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                              title="削除"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <div className="border-t px-4 py-2 text-xs text-gray-400">
          {filtered.length}件を表示
          {search && ` (全${offices.length}件中)`}
        </div>
      </div>

      {/* 削除確認ダイアログ */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">ケアマネ事業所を削除</h2>
              <button
                onClick={() => setDeleteTarget(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X size={16} />
              </button>
            </div>
            <p className="mb-6 text-sm text-gray-600">
              <span className="font-medium text-gray-900">{deleteTarget.name}</span>{" "}
              を削除しますか？利用者の保険情報などから参照されている場合は削除できません。
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleDelete}
                disabled={saving}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                削除する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
