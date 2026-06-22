"use client";

/**
 * 訪問介護 手順書 step テンプレート 管理画面 (2026-06-22)
 *
 * 仕様:
 *  - office_id ごとに master 登録 (= currentOffice を基準)
 *  - フィールド: name (= サービス内容) + detail (= 具体的取り組内容) + sort_order
 *  - 時間は登録しない (= 各 step 行で毎回手入力)
 *  - UNIQUE (office_id, name) なので同一 office 内で重複不可
 *  - 既存手順書とは独立 (= テキスト一致のみ、編集の影響を既存に反映しない)
 *  - soft delete (= deleted_at)
 *
 * UI:
 *  - 「+ 新規追加」で inline row 追加 → name + detail + sort_order 入力 → 保存
 *  - 各行に「編集 / 削除」ボタン
 *  - 並び順は 数値 input
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Plus,
  Trash2,
  Save,
  Loader2,
  AlertCircle,
  Pencil,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import {
  getStepTemplates,
  createStepTemplate,
  updateStepTemplate,
  softDeleteStepTemplate,
} from "@/lib/visit-procedure/queries";
import type { VisitProcedureStepTemplate } from "@/lib/visit-procedure/types";

interface DraftRow {
  name: string;
  detail: string;
  sort_order: number;
}

export default function VisitProcedureStepTemplatesPage() {
  const supabase = useMemo(() => createClient(), []);
  const { businessType, currentOffice, loading: btLoading } = useBusinessType();
  const [templates, setTemplates] = useState<VisitProcedureStepTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 新規追加 inline row 用
  const [addDraft, setAddDraft] = useState<DraftRow | null>(null);

  // 編集中 row (id → draft)
  const [editDrafts, setEditDrafts] = useState<Record<string, DraftRow>>({});

  const officeId = currentOffice?.id ?? null;
  const tenantId = currentOffice?.tenant_id ?? null;
  const officeQuery = officeId ? `?office=${encodeURIComponent(officeId)}` : "";

  const loadTemplates = async (oid: string) => {
    try {
      const rows = await getStepTemplates(supabase, oid);
      setTemplates(rows);
    } catch (err) {
      console.error(err);
      toast.error("テンプレート一覧の読込失敗: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount-time async fetch */
    if (btLoading) return;
    if (!officeId) {
      setLoading(false);
      setTemplates([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const rows = await getStepTemplates(supabase, officeId);
        if (!cancelled) setTemplates(rows);
      } catch (err) {
        console.error(err);
        toast.error("テンプレート一覧の読込失敗: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [supabase, officeId, btLoading]);

  // 訪問介護モード以外はガード
  if (!btLoading && businessType !== "訪問介護") {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">手順書 テンプレート管理</h1>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-800 flex items-start gap-3">
          <AlertCircle size={20} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">この機能は訪問介護モード専用です</p>
            <p className="text-sm mt-1">サイドバー下部の事業所セレクタから訪問介護の自事業所を選択してください。</p>
          </div>
        </div>
      </div>
    );
  }

  // currentOffice 解決中
  if (btLoading || !currentOffice || !officeId || !tenantId) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        <Loader2 size={20} className="animate-spin mr-2" />
        読込中...
      </div>
    );
  }

  // ── 新規追加 ──
  const startAdd = () => {
    if (addDraft) return;
    // sort_order の default は 既存最大+10 (= 既存の合間に挿入しやすく)
    const maxSort = templates.reduce((m, t) => Math.max(m, t.sort_order), 0);
    setAddDraft({ name: "", detail: "", sort_order: maxSort + 10 });
  };

  const cancelAdd = () => setAddDraft(null);

  const commitAdd = async () => {
    if (!addDraft || !officeId || !tenantId) return;
    const name = addDraft.name.trim();
    if (!name) {
      toast.error("サービス内容を入力してください");
      return;
    }
    setSaving(true);
    try {
      await createStepTemplate(supabase, {
        office_id: officeId,
        tenant_id: tenantId,
        name,
        detail: addDraft.detail.trim() || null,
        sort_order: Number.isFinite(addDraft.sort_order) ? addDraft.sort_order : 0,
      });
      toast.success("追加しました");
      setAddDraft(null);
      await loadTemplates(officeId);
    } catch (err) {
      console.error(err);
      toast.error("追加失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  // ── 編集 ──
  const startEdit = (t: VisitProcedureStepTemplate) => {
    setEditDrafts((prev) => ({
      ...prev,
      [t.id]: { name: t.name, detail: t.detail ?? "", sort_order: t.sort_order },
    }));
  };

  const cancelEdit = (id: string) => {
    setEditDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const commitEdit = async (id: string) => {
    const draft = editDrafts[id];
    if (!draft || !officeId) return;
    const name = draft.name.trim();
    if (!name) {
      toast.error("サービス内容を入力してください");
      return;
    }
    setSaving(true);
    try {
      await updateStepTemplate(supabase, id, {
        name,
        detail: draft.detail.trim() || null,
        sort_order: Number.isFinite(draft.sort_order) ? draft.sort_order : 0,
      });
      toast.success("更新しました");
      cancelEdit(id);
      await loadTemplates(officeId);
    } catch (err) {
      console.error(err);
      toast.error("更新失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  // ── 削除 (soft delete) ──
  const handleDelete = async (t: VisitProcedureStepTemplate) => {
    if (!officeId) return;
    if (!confirm(`「${t.name}」を削除しますか？\n(既存の手順書には影響しません)`)) return;
    setSaving(true);
    try {
      await softDeleteStepTemplate(supabase, t.id);
      toast.success("削除しました");
      await loadTemplates(officeId);
    } catch (err) {
      console.error(err);
      toast.error("削除失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── ヘッダ ── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href={`/visit-procedures${officeQuery}`}
            className="text-gray-400 hover:text-gray-600 shrink-0"
            title="手順書 利用者一覧へ戻る"
          >
            <ArrowLeft size={20} />
          </Link>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
              <BookOpen size={22} className="text-green-600 shrink-0" />
              テンプレート管理
            </h1>
            <p className="mt-1 text-xs sm:text-sm text-gray-500">
              事業所: <span className="font-medium text-gray-700">{currentOffice.name}</span>
            </p>
          </div>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            onClick={startAdd}
            disabled={!!addDraft || saving}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            <Plus size={16} />
            新規追加
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 flex items-start gap-2">
        <AlertCircle size={14} className="shrink-0 mt-0.5" />
        <div>
          ここで登録した「サービス内容 + 具体的取り組内容」のセットは、手順書編集画面の各 step 行で候補として表示されます。<br />
          既存の手順書とはテキスト一致での参照のみで、ここを編集・削除しても既存手順書には影響しません。
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 size={20} className="animate-spin mr-2" />
          読込中...
        </div>
      ) : (
        <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs sm:text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-2 py-2 border-b border-gray-200 text-left w-40 sm:w-48">サービス内容 *</th>
                  <th className="px-2 py-2 border-b border-gray-200 text-left">具体的取り組内容</th>
                  <th className="px-2 py-2 border-b border-gray-200 text-right w-20">並び順</th>
                  <th className="px-2 py-2 border-b border-gray-200 text-center w-28">操作</th>
                </tr>
              </thead>
              <tbody>
                {/* 新規追加 inline row */}
                {addDraft && (
                  <tr className="border-t border-gray-200 bg-green-50/40">
                    <td className="px-2 py-1.5 border-b border-gray-200 align-top">
                      <input
                        type="text"
                        autoFocus
                        value={addDraft.name}
                        onChange={(e) => setAddDraft({ ...addDraft, name: e.target.value })}
                        placeholder="例: 訪問・手洗・挨拶"
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm"
                      />
                    </td>
                    <td className="px-2 py-1.5 border-b border-gray-200 align-top">
                      <textarea
                        value={addDraft.detail}
                        onChange={(e) => setAddDraft({ ...addDraft, detail: e.target.value })}
                        rows={2}
                        placeholder="例: 訪問。手洗い、うがいを済ませ..."
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm resize-y"
                      />
                    </td>
                    <td className="px-2 py-1.5 border-b border-gray-200 align-top">
                      <input
                        type="number"
                        value={addDraft.sort_order}
                        onChange={(e) => setAddDraft({ ...addDraft, sort_order: Number(e.target.value) })}
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm text-right tabular-nums"
                      />
                    </td>
                    <td className="px-2 py-1.5 border-b border-gray-200 text-center align-top">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          onClick={commitAdd}
                          disabled={saving}
                          className="inline-flex items-center gap-1 rounded bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                          title="保存"
                        >
                          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                          保存
                        </button>
                        <button
                          type="button"
                          onClick={cancelAdd}
                          disabled={saving}
                          className="text-gray-500 hover:bg-gray-100 rounded p-1 disabled:opacity-50"
                          title="キャンセル"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )}

                {templates.length === 0 && !addDraft ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-12 text-center text-gray-400">
                      <BookOpen size={32} className="mx-auto mb-2 text-gray-300" />
                      <p className="text-sm">テンプレートが登録されていません</p>
                      <p className="text-xs mt-1">右上の「新規追加」から登録してください</p>
                    </td>
                  </tr>
                ) : (
                  templates.map((t) => {
                    const editing = editDrafts[t.id];
                    if (editing) {
                      return (
                        <tr key={t.id} className="border-t border-gray-200 bg-amber-50/40">
                          <td className="px-2 py-1.5 border-b border-gray-200 align-top">
                            <input
                              type="text"
                              value={editing.name}
                              onChange={(e) =>
                                setEditDrafts((prev) => ({
                                  ...prev,
                                  [t.id]: { ...editing, name: e.target.value },
                                }))
                              }
                              className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm"
                            />
                          </td>
                          <td className="px-2 py-1.5 border-b border-gray-200 align-top">
                            <textarea
                              value={editing.detail}
                              onChange={(e) =>
                                setEditDrafts((prev) => ({
                                  ...prev,
                                  [t.id]: { ...editing, detail: e.target.value },
                                }))
                              }
                              rows={2}
                              className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm resize-y"
                            />
                          </td>
                          <td className="px-2 py-1.5 border-b border-gray-200 align-top">
                            <input
                              type="number"
                              value={editing.sort_order}
                              onChange={(e) =>
                                setEditDrafts((prev) => ({
                                  ...prev,
                                  [t.id]: { ...editing, sort_order: Number(e.target.value) },
                                }))
                              }
                              className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm text-right tabular-nums"
                            />
                          </td>
                          <td className="px-2 py-1.5 border-b border-gray-200 text-center align-top">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                type="button"
                                onClick={() => commitEdit(t.id)}
                                disabled={saving}
                                className="inline-flex items-center gap-1 rounded bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                                title="保存"
                              >
                                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                                保存
                              </button>
                              <button
                                type="button"
                                onClick={() => cancelEdit(t.id)}
                                disabled={saving}
                                className="text-gray-500 hover:bg-gray-100 rounded p-1 disabled:opacity-50"
                                title="キャンセル"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={t.id} className="border-t border-gray-200 hover:bg-gray-50/50">
                        <td className="px-2 py-2 border-b border-gray-200 align-top font-medium text-gray-800">
                          {t.name}
                        </td>
                        <td className="px-2 py-2 border-b border-gray-200 align-top text-gray-700 whitespace-pre-wrap">
                          {t.detail || <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-2 py-2 border-b border-gray-200 align-top text-right tabular-nums text-gray-600">
                          {t.sort_order}
                        </td>
                        <td className="px-2 py-2 border-b border-gray-200 text-center align-top">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => startEdit(t)}
                              className="text-blue-600 hover:bg-blue-50 rounded p-1"
                              title="編集"
                              aria-label={`${t.name} を編集`}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(t)}
                              disabled={saving}
                              className="text-red-500 hover:bg-red-50 rounded p-1 disabled:opacity-50"
                              title="削除"
                              aria-label={`${t.name} を削除`}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
