"use client";

/**
 * 加算管理 一覧 + 編集 UI (居宅・訪問介護 両版共通)
 *
 * UI:
 *  - 現在 office + business_type に応じた加算一覧
 *  - 「+ 新規追加」inline row を一覧の上部に表示
 *  - 各行に「編集 / 削除 / 期限延長」操作
 *  - 加算コードは business_type に応じた dropdown
 *  - 算定根拠は textarea (= PDF link 等もテキストで)
 *  - status: active / expired / pending
 *
 * 通所介護モードは対象外 (= 居宅 / 訪問 専用)。
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  Loader2,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import {
  createAddon,
  deleteAddon,
  getAddons,
  updateAddon,
} from "@/lib/billing-addon/queries";
import {
  ADDON_CODES_BY_BUSINESS_TYPE,
  ADDON_STATUSES,
  ADDON_STATUS_LABELS,
  type AddonBusinessType,
  type AddonStatus,
  type BillingAddon,
} from "@/lib/billing-addon/types";

interface DraftRow {
  addon_code: string;
  addon_unit: string;            // input 上は文字列で扱い、保存時に number へ
  status: AddonStatus;
  applied_from: string;          // YYYY-MM-DD
  expires_at: string;            // YYYY-MM-DD or ""
  notification_filed_at: string; // YYYY-MM-DD or ""
  basis_documents: string;
  notes: string;
}

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const emptyDraft = (defaultCode: string): DraftRow => ({
  addon_code: defaultCode,
  addon_unit: "",
  status: "active",
  applied_from: today(),
  expires_at: "",
  notification_filed_at: "",
  basis_documents: "",
  notes: "",
});

const rowToDraft = (r: BillingAddon): DraftRow => ({
  addon_code: r.addon_code,
  addon_unit: r.addon_unit == null ? "" : String(r.addon_unit),
  status: r.status,
  applied_from: r.applied_from,
  expires_at: r.expires_at ?? "",
  notification_filed_at: r.notification_filed_at ?? "",
  basis_documents: r.basis_documents ?? "",
  notes: r.notes ?? "",
});

const parseUnit = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.floor(n) : null;
};

const STATUS_BADGE_CLS: Record<AddonStatus, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  expired: "bg-gray-100 text-gray-600 border-gray-300",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
};

export function AddonsContent() {
  const supabase = useMemo(() => createClient(), []);
  const {
    businessType,
    currentOffice,
    loading: btLoading,
  } = useBusinessType();

  const officeId = currentOffice?.id ?? null;
  const tenantId = currentOffice?.tenant_id ?? null;

  // 加算管理は 居宅介護支援 / 訪問介護 のみ対象。通所介護は対象外。
  const businessTypeForAddon: AddonBusinessType | null =
    businessType === "居宅介護支援" || businessType === "訪問介護"
      ? businessType
      : null;

  const [rows, setRows] = useState<BillingAddon[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 新規追加 row
  const [addDraft, setAddDraft] = useState<DraftRow | null>(null);
  // 編集中 row (id → draft)
  const [editDrafts, setEditDrafts] = useState<Record<string, DraftRow>>({});

  const codesForType: readonly string[] = businessTypeForAddon
    ? ADDON_CODES_BY_BUSINESS_TYPE[businessTypeForAddon]
    : [];

  const reload = async (oid: string, bt: AddonBusinessType) => {
    try {
      const data = await getAddons(supabase, oid, bt);
      setRows(data);
    } catch (err) {
      console.error(err);
      toast.error("加算一覧の読込失敗: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount-time async fetch */
    if (btLoading) return;
    if (!officeId || !businessTypeForAddon) {
      setLoading(false);
      setRows([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const data = await getAddons(supabase, officeId, businessTypeForAddon);
        if (!cancelled) setRows(data);
      } catch (err) {
        console.error(err);
        toast.error("加算一覧の読込失敗: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [supabase, officeId, businessTypeForAddon, btLoading]);

  // ─── ガード: 通所介護モード or 事業所未選択 ───
  if (!btLoading && !businessTypeForAddon) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Sparkles size={22} className="text-indigo-600 shrink-0" />
          加算管理
        </h1>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-800 flex items-start gap-3">
          <AlertCircle size={20} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">この機能は 居宅介護支援 / 訪問介護 モードでのみ利用できます</p>
            <p className="text-sm mt-1">
              サイドバー下部の事業所セレクタから 居宅介護支援 または 訪問介護 の自事業所を選択してください。
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (btLoading || !currentOffice || !officeId || !tenantId || !businessTypeForAddon) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        <Loader2 size={20} className="animate-spin mr-2" />
        読込中...
      </div>
    );
  }

  // ─── 新規追加 ───
  const startAdd = () => {
    if (addDraft) return;
    setAddDraft(emptyDraft(codesForType[0] ?? ""));
  };
  const cancelAdd = () => setAddDraft(null);

  const commitAdd = async () => {
    if (!addDraft) return;
    if (!addDraft.addon_code.trim()) {
      toast.error("加算コードを選択してください");
      return;
    }
    if (!addDraft.applied_from) {
      toast.error("算定開始日を入力してください");
      return;
    }
    setSaving(true);
    try {
      await createAddon(supabase, {
        tenant_id: tenantId,
        office_id: officeId,
        business_type: businessTypeForAddon,
        addon_code: addDraft.addon_code,
        addon_unit: parseUnit(addDraft.addon_unit),
        status: addDraft.status,
        applied_from: addDraft.applied_from,
        expires_at: addDraft.expires_at || null,
        notification_filed_at: addDraft.notification_filed_at || null,
        basis_documents: addDraft.basis_documents.trim() || null,
        notes: addDraft.notes.trim() || null,
      });
      toast.success("加算を追加しました");
      setAddDraft(null);
      await reload(officeId, businessTypeForAddon);
    } catch (err) {
      console.error(err);
      toast.error("追加失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  // ─── 編集 ───
  const startEdit = (r: BillingAddon) => {
    setEditDrafts((prev) => ({ ...prev, [r.id]: rowToDraft(r) }));
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
    if (!draft) return;
    if (!draft.addon_code.trim()) {
      toast.error("加算コードを選択してください");
      return;
    }
    if (!draft.applied_from) {
      toast.error("算定開始日を入力してください");
      return;
    }
    setSaving(true);
    try {
      await updateAddon(supabase, id, {
        addon_code: draft.addon_code,
        addon_unit: parseUnit(draft.addon_unit),
        status: draft.status,
        applied_from: draft.applied_from,
        expires_at: draft.expires_at || null,
        notification_filed_at: draft.notification_filed_at || null,
        basis_documents: draft.basis_documents.trim() || null,
        notes: draft.notes.trim() || null,
      });
      toast.success("更新しました");
      cancelEdit(id);
      await reload(officeId, businessTypeForAddon);
    } catch (err) {
      console.error(err);
      toast.error("更新失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  // ─── 削除 ───
  const handleDelete = async (r: BillingAddon) => {
    if (!confirm(`「${r.addon_code}」(算定開始: ${r.applied_from}) を削除しますか？`)) return;
    setSaving(true);
    try {
      await deleteAddon(supabase, r.id);
      toast.success("削除しました");
      await reload(officeId, businessTypeForAddon);
    } catch (err) {
      console.error(err);
      toast.error("削除失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  // ─── 期限延長 (= expires_at +1 年) ───
  const handleExtendExpiry = async (r: BillingAddon) => {
    const baseDate = r.expires_at ?? today();
    const d = new Date(baseDate + "T00:00:00");
    if (Number.isNaN(d.getTime())) {
      toast.error("既存の終了日を解析できません");
      return;
    }
    d.setFullYear(d.getFullYear() + 1);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!confirm(`「${r.addon_code}」の終了日を ${r.expires_at ?? "(未設定)"} → ${next} に変更しますか？`)) {
      return;
    }
    setSaving(true);
    try {
      await updateAddon(supabase, r.id, { expires_at: next });
      toast.success(`終了日を ${next} に更新しました`);
      await reload(officeId, businessTypeForAddon);
    } catch (err) {
      console.error(err);
      toast.error("期限延長失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── ヘッダ ── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Sparkles size={22} className="text-indigo-600 shrink-0" />
            加算管理
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-gray-500">
            事業所: <span className="font-medium text-gray-700">{currentOffice.name}</span>
            <span className="mx-2 text-gray-300">/</span>
            業種: <span className="font-medium text-gray-700">{businessTypeForAddon}</span>
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            onClick={startAdd}
            disabled={!!addDraft || saving}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Plus size={16} />
            新規追加
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 flex items-start gap-2">
        <AlertCircle size={14} className="shrink-0 mt-0.5" />
        <div>
          ここで登録した加算は事業所単位で管理されます。
          算定根拠 (届出書類の所在等) と届出受理日を記録しておくと、加算届出の更新時期管理に役立ちます。
        </div>
      </div>

      {/* ── 一覧 ── */}
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
                  <th className="px-2 py-2 border-b border-gray-200 text-left w-44 sm:w-56">加算コード *</th>
                  <th className="px-2 py-2 border-b border-gray-200 text-right w-20">単位</th>
                  <th className="px-2 py-2 border-b border-gray-200 text-left w-28">状態</th>
                  <th className="px-2 py-2 border-b border-gray-200 text-left w-32">開始日 *</th>
                  <th className="px-2 py-2 border-b border-gray-200 text-left w-32">終了日</th>
                  <th className="px-2 py-2 border-b border-gray-200 text-left w-32">届出日</th>
                  <th className="px-2 py-2 border-b border-gray-200 text-left">算定根拠 / 備考</th>
                  <th className="px-2 py-2 border-b border-gray-200 text-center w-44">操作</th>
                </tr>
              </thead>
              <tbody>
                {/* 新規追加 inline row */}
                {addDraft && (
                  <DraftRowEditor
                    draft={addDraft}
                    onChange={setAddDraft}
                    codes={codesForType}
                    saving={saving}
                    onSave={commitAdd}
                    onCancel={cancelAdd}
                    saveLabel="保存"
                    rowBg="bg-indigo-50/40"
                  />
                )}

                {rows.length === 0 && !addDraft ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-gray-400">
                      加算が登録されていません。右上の「新規追加」から登録してください。
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => {
                    const editing = editDrafts[r.id];
                    if (editing) {
                      return (
                        <DraftRowEditor
                          key={r.id}
                          draft={editing}
                          onChange={(d) => setEditDrafts((prev) => ({ ...prev, [r.id]: d }))}
                          codes={codesForType}
                          saving={saving}
                          onSave={() => commitEdit(r.id)}
                          onCancel={() => cancelEdit(r.id)}
                          saveLabel="更新"
                          rowBg="bg-amber-50/40"
                        />
                      );
                    }
                    return (
                      <DisplayRow
                        key={r.id}
                        row={r}
                        saving={saving}
                        onEdit={() => startEdit(r)}
                        onDelete={() => handleDelete(r)}
                        onExtend={() => handleExtendExpiry(r)}
                      />
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

// ====================================================================
// 表示行
// ====================================================================
function DisplayRow({
  row,
  saving,
  onEdit,
  onDelete,
  onExtend,
}: {
  row: BillingAddon;
  saving: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onExtend: () => void;
}) {
  return (
    <tr className="border-t border-gray-200 hover:bg-gray-50/60">
      <td className="px-2 py-2 align-top">
        <span className="font-medium text-gray-900">{row.addon_code}</span>
      </td>
      <td className="px-2 py-2 text-right tabular-nums align-top">
        {row.addon_unit == null ? <span className="text-gray-300">—</span> : row.addon_unit}
      </td>
      <td className="px-2 py-2 align-top">
        <span
          className={
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium " +
            STATUS_BADGE_CLS[row.status]
          }
        >
          {ADDON_STATUS_LABELS[row.status]}
        </span>
      </td>
      <td className="px-2 py-2 align-top tabular-nums text-gray-700">{row.applied_from}</td>
      <td className="px-2 py-2 align-top tabular-nums text-gray-700">
        {row.expires_at ?? <span className="text-gray-300">—</span>}
      </td>
      <td className="px-2 py-2 align-top tabular-nums text-gray-700">
        {row.notification_filed_at ?? <span className="text-gray-300">—</span>}
      </td>
      <td className="px-2 py-2 align-top">
        {row.basis_documents ? (
          <div className="whitespace-pre-wrap break-words text-gray-700">{row.basis_documents}</div>
        ) : (
          <span className="text-gray-300">—</span>
        )}
        {row.notes && (
          <div className="mt-1 text-[11px] text-gray-500 whitespace-pre-wrap break-words">
            {row.notes}
          </div>
        )}
      </td>
      <td className="px-2 py-2 text-center align-top">
        <div className="flex items-center justify-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={onExtend}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            title="終了日を +1 年"
          >
            <CalendarDays size={12} />
            +1年
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            title="編集"
          >
            <Pencil size={12} />
            編集
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded border border-red-300 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            title="削除"
          >
            <Trash2 size={12} />
            削除
          </button>
        </div>
      </td>
    </tr>
  );
}

// ====================================================================
// 編集 / 新規追加 共通 inline 行
// ====================================================================
function DraftRowEditor({
  draft,
  onChange,
  codes,
  saving,
  onSave,
  onCancel,
  saveLabel,
  rowBg,
}: {
  draft: DraftRow;
  onChange: (d: DraftRow) => void;
  codes: readonly string[];
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
  rowBg: string;
}) {
  return (
    <tr className={"border-t border-gray-200 " + rowBg}>
      <td className="px-2 py-1.5 align-top">
        <select
          value={draft.addon_code}
          onChange={(e) => onChange({ ...draft, addon_code: e.target.value })}
          className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm bg-white"
        >
          {/* 値が code 一覧に無ければ「(現在値)」として表示 (= enum 追加対応の braking 防止) */}
          {!codes.includes(draft.addon_code) && draft.addon_code && (
            <option value={draft.addon_code}>{draft.addon_code} (現在値)</option>
          )}
          {codes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1.5 align-top">
        <input
          type="number"
          inputMode="numeric"
          value={draft.addon_unit}
          onChange={(e) => onChange({ ...draft, addon_unit: e.target.value })}
          placeholder="例: 505"
          className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm text-right tabular-nums"
        />
      </td>
      <td className="px-2 py-1.5 align-top">
        <select
          value={draft.status}
          onChange={(e) => onChange({ ...draft, status: e.target.value as AddonStatus })}
          className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm bg-white"
        >
          {ADDON_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ADDON_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1.5 align-top">
        <input
          type="date"
          value={draft.applied_from}
          onChange={(e) => onChange({ ...draft, applied_from: e.target.value })}
          className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm"
        />
      </td>
      <td className="px-2 py-1.5 align-top">
        <input
          type="date"
          value={draft.expires_at}
          onChange={(e) => onChange({ ...draft, expires_at: e.target.value })}
          className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm"
        />
      </td>
      <td className="px-2 py-1.5 align-top">
        <input
          type="date"
          value={draft.notification_filed_at}
          onChange={(e) => onChange({ ...draft, notification_filed_at: e.target.value })}
          className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm"
        />
      </td>
      <td className="px-2 py-1.5 align-top">
        <textarea
          value={draft.basis_documents}
          onChange={(e) => onChange({ ...draft, basis_documents: e.target.value })}
          rows={2}
          placeholder="例: 加算届出書 (R6.4.1) / 保管: キャビネット A-3 / PDF: \\fileserver\addons\..."
          className="w-full rounded border border-gray-300 px-2 py-1 text-xs sm:text-sm resize-y"
        />
        <textarea
          value={draft.notes}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
          rows={1}
          placeholder="備考 (任意)"
          className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-[11px] resize-y"
        />
      </td>
      <td className="px-2 py-1.5 text-center align-top">
        <div className="flex items-center justify-center gap-1">
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            title="保存"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saveLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
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
