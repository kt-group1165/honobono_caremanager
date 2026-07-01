"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Trash2,
  X,
  Save,
  Loader2,
  FileSignature,
  Printer,
  ExternalLink,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUS_COLORS,
  BUSINESS_TYPES,
  emptyContractInput,
  getSectionsForType,
  type ContractStatus,
  type UserContract,
  type UserContractContent,
  type UserContractInput,
} from "@/lib/user-contract/types";
import {
  getContractsByUser,
  saveContract,
  deleteContract,
} from "@/lib/user-contract/queries";

export interface KaigoClient {
  id: string;
  name: string;
  furigana: string | null;
}

interface OfficeOption {
  id: string;
  name: string;
  service_type: string | null;
  tenant_id: string;
}

interface OfficeMeta {
  business_number: string | null;
  address: string | null;
  phone: string | null;
}

export interface UserContractsContentProps {
  userId: string;
  initialUser: KaigoClient | null;
  initialContracts: UserContract[];
}

const inputClass =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

function formatDate(date: string | null): string {
  if (!date) return "—";
  try {
    return format(parseISO(date), "yyyy/M/d(E)", { locale: ja });
  } catch {
    return date;
  }
}

export function UserContractsContent({
  userId,
  initialUser,
  initialContracts,
}: UserContractsContentProps) {
  const supabase = useMemo(() => createClient(), []);
  const { offices, currentOffice } = useBusinessType();

  const [user] = useState<KaigoClient | null>(initialUser);
  const [contracts, setContracts] = useState<UserContract[]>(initialContracts);
  const [loading, setLoading] = useState(false);

  // filterType は 1 値運用になったため不要
  const [filterStatus, setFilterStatus] = useState<ContractStatus | "">("");

  const [showDialog, setShowDialog] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<UserContractInput | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 自事業所の詳細情報 (= 重要事項説明書 auto-fill の元データ)
  const [officeMeta, setOfficeMeta] = useState<Record<string, OfficeMeta>>({});

  // 契約書兼重要事項説明書 は居宅介護支援事業所カテゴリの契約書
  // = service_type = "居宅介護支援" の office にだけ紐付ける
  const officeOptions = useMemo<OfficeOption[]>(() => {
    return offices
      .filter((o) => o.service_type === "居宅介護支援")
      .map((o) => ({
        id: o.id,
        name: o.name,
        service_type: o.service_type ?? null,
        tenant_id: o.tenant_id,
      }));
  }, [offices]);

  // current office を default に
  const defaultOfficeId = currentOffice?.id ?? officeOptions[0]?.id ?? null;
  const defaultTenantId = currentOffice?.tenant_id ?? officeOptions[0]?.tenant_id ?? "kt-group";

  // offices.business_number は context にあるが、住所/電話は無いため別途 fetch
  const fetchOfficeMeta = useCallback(async () => {
    const ids = officeOptions.map((o) => o.id);
    if (ids.length === 0) return;
    const { data, error } = await supabase
      .from("offices")
      .select("id, business_number, address, phone")
      .in("id", ids);
    if (error) {
      console.warn("offices meta fetch failed:", error.message);
      return;
    }
    const map: Record<string, OfficeMeta> = {};
    for (const row of (data ?? []) as {
      id: string;
      business_number: string | null;
      address: string | null;
      phone: string | null;
    }[]) {
      map[row.id] = {
        business_number: row.business_number,
        address: row.address,
        phone: row.phone,
      };
    }
    setOfficeMeta(map);
  }, [supabase, officeOptions]);

  const initialMetaFetched = useRef(false);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount-time async fetch (HANDOVER §2) */
    if (initialMetaFetched.current) return;
    if (officeOptions.length === 0) return;
    initialMetaFetched.current = true;
    fetchOfficeMeta();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [officeOptions, fetchOfficeMeta]);

  const fetchContracts = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await getContractsByUser(supabase, userId);
      setContracts(rows);
    } catch (err: unknown) {
      toast.error(
        "契約書一覧の取得に失敗: " +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setLoading(false);
    }
  }, [supabase, userId]);

  const filtered = useMemo(() => {
    return contracts.filter((c) => {
      if (filterStatus && c.status !== filterStatus) return false;
      return true;
    });
  }, [contracts, filterStatus]);

  const openNew = () => {
    const officeId = defaultOfficeId;
    const tenantId = defaultTenantId;
    setEditId(null);
    setForm(
      emptyContractInput({
        tenantId,
        userId,
        officeId,
        contractType: "契約書兼重要事項説明書",
        businessType: currentOffice?.service_type ?? null,
      }),
    );
    setShowDialog(true);
  };

  const openEdit = (row: UserContract) => {
    setEditId(row.id);
    setForm({
      id: row.id,
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      office_id: row.office_id,
      contract_type: row.contract_type,
      business_type: row.business_type,
      issued_date: row.issued_date,
      effective_from: row.effective_from,
      effective_until: row.effective_until,
      signed_at: row.signed_at,
      signed_by_name: row.signed_by_name,
      signed_by_relation: row.signed_by_relation,
      content: row.content ?? {},
      attachment_url: row.attachment_url,
      status: row.status,
      notes: row.notes,
    });
    setShowDialog(true);
  };

  const closeDialog = () => {
    setShowDialog(false);
    setEditId(null);
    setForm(null);
  };

  const updateForm = useCallback(<K extends keyof UserContractInput>(
    key: K,
    value: UserContractInput[K],
  ) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  const updateContentField = useCallback((key: string, value: string) => {
    setForm((prev) => {
      if (!prev) return prev;
      const nextContent: UserContractContent = { ...(prev.content ?? {}) };
      if (value === "") delete nextContent[key];
      else nextContent[key] = value;
      return { ...prev, content: nextContent };
    });
  }, []);

  /** 自事業所情報を content に流し込む (= 重要事項説明書 / 契約書兼重要事項説明書) */
  const autoFillFromOffice = () => {
    if (!form) return;
    const office = officeOptions.find((o) => o.id === form.office_id);
    if (!office) {
      toast.error("先に契約 office を選択してください");
      return;
    }
    const next: UserContractContent = { ...(form.content ?? {}) };
    const meta = officeMeta[office.id];

    if (form.contract_type === "契約書兼重要事項説明書") {
      // 契約書兼重要事項説明書 用: docx の事業者欄に相当する key 群を上書き
      if (!next.company_office_name) next.company_office_name = office.name;
      if (!next.company_address && meta?.address) next.company_address = meta.address;
      if (!next.company_phone && meta?.phone) next.company_phone = meta.phone;
      if (!next.office_designation_number && meta?.business_number) {
        next.office_designation_number = meta.business_number;
      }
    } else {
      // 重要事項説明書 (旧) 用: 既存挙動を維持
      if (!next.company_name) next.company_name = office.name;
      if (!next.service_types && office.service_type) next.service_types = office.service_type;
      if (!next.company_address && meta?.address) next.company_address = meta.address;
      if (!next.company_phone && meta?.phone) next.company_phone = meta.phone;
    }
    setForm({ ...form, content: next });
    toast.success("事業所情報を取り込みました");
  };

  /**
   * 2026-06-29: 種別 select 削除に伴い handleContractTypeChange 撤去。
   * 新規作成時は emptyContractInput で contract_type が固定される。
   */

  const handleSave = async () => {
    if (!form) return;
    if (!form.contract_type) {
      toast.error("種別は必須です");
      return;
    }
    if (!form.issued_date) {
      toast.error("交付日は必須です");
      return;
    }
    setSaving(true);
    try {
      await saveContract(supabase, form);
      toast.success(editId ? "更新しました" : "登録しました");
      closeDialog();
      await fetchContracts();
    } catch (err: unknown) {
      toast.error(
        "保存に失敗しました: " +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await deleteContract(supabase, deleteId);
      toast.success("削除しました");
      setDeleteId(null);
      await fetchContracts();
    } catch (err: unknown) {
      toast.error(
        "削除に失敗しました: " +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setDeleting(false);
    }
  };

  const sections = form ? getSectionsForType(form.contract_type) : [];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-800">
            <FileSignature size={22} className="text-indigo-600" />
            重要事項説明書 / 契約書
          </h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {user ? `${user.name} 様${user.furigana ? ` (${user.furigana})` : ""}` : "利用者情報なし"}
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
        >
          <Plus size={16} /> 新規発行
        </button>
      </div>

      {/* フィルタ */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-gray-200 bg-white p-2 text-xs">
        <span className="font-medium text-gray-600">絞り込み:</span>
        {/* 種別 filter は 1 値のみ運用 (= 契約書兼重要事項説明書) になったため非表示 */}
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus((e.target.value as ContractStatus) || "")}
          className="rounded border border-gray-300 px-2 py-1"
        >
          <option value="">状態: すべて</option>
          {CONTRACT_STATUSES.map((s) => (
            <option key={s} value={s}>{CONTRACT_STATUS_LABELS[s]}</option>
          ))}
        </select>
        <span className="ml-auto text-gray-500">
          {filtered.length} 件 / {contracts.length} 件
        </span>
      </div>

      {/* 一覧 */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-gray-700">業務</th>
              <th className="px-3 py-2 text-left font-medium text-gray-700">交付日</th>
              <th className="px-3 py-2 text-left font-medium text-gray-700">効力発生</th>
              <th className="px-3 py-2 text-left font-medium text-gray-700">効力終了</th>
              <th className="px-3 py-2 text-left font-medium text-gray-700">署名者</th>
              <th className="px-3 py-2 text-left font-medium text-gray-700">状態</th>
              <th className="px-3 py-2 text-right font-medium text-gray-700">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-gray-400">
                  <Loader2 size={18} className="mx-auto mb-1 animate-spin" /> 読込中...
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center text-gray-400">
                  該当する契約書がありません
                </td>
              </tr>
            ) : (
              filtered.map((c) => {
                const sColor = CONTRACT_STATUS_COLORS[c.status];
                return (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {c.business_type ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-700">
                      {formatDate(c.issued_date)}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-700">
                      {formatDate(c.effective_from)}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-700">
                      {formatDate(c.effective_until)}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-700">
                      {c.signed_by_name ?? "—"}
                      {c.signed_by_relation ? (
                        <span className="ml-1 text-gray-400">({c.signed_by_relation})</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${sColor.bg} ${sColor.text} ${sColor.border}`}
                      >
                        {CONTRACT_STATUS_LABELS[c.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <Link
                          href={`/user-contracts/${c.id}?user=${userId}`}
                          className="inline-flex items-center rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                          title="印刷プレビュー"
                        >
                          <Printer size={14} />
                        </Link>
                        <button
                          type="button"
                          onClick={() => openEdit(c)}
                          className="inline-flex items-center rounded p-1 text-indigo-600 hover:bg-indigo-50"
                          title="編集"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteId(c.id)}
                          className="inline-flex items-center rounded p-1 text-red-500 hover:bg-red-50"
                          title="削除"
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

      {/* 編集 modal */}
      {showDialog && form && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-base font-semibold text-gray-800">
                {editId ? "契約書を編集" : "契約書を新規発行"}
              </h2>
              <button
                type="button"
                onClick={closeDialog}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {/* 種別 select 削除 (= 2026-06-29 user 確定で 1 値のみ運用)。
                    新規作成時に既に "契約書兼重要事項説明書" で固定される。 */}
                <div className="col-span-1">
                  <label className="mb-1 block text-xs font-medium text-gray-600">業務</label>
                  <select
                    value={form.business_type ?? ""}
                    onChange={(e) =>
                      updateForm("business_type", e.target.value || null)
                    }
                    className={inputClass}
                  >
                    <option value="">—</option>
                    {BUSINESS_TYPES.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-1">
                  <label className="mb-1 block text-xs font-medium text-gray-600">状態</label>
                  <select
                    value={form.status}
                    onChange={(e) => updateForm("status", e.target.value as ContractStatus)}
                    className={inputClass}
                  >
                    {CONTRACT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {CONTRACT_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-1">
                  <label className="mb-1 block text-xs font-medium text-gray-600">
                    交付日 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={form.issued_date}
                    onChange={(e) => updateForm("issued_date", e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div className="col-span-1">
                  <label className="mb-1 block text-xs font-medium text-gray-600">効力発生</label>
                  <input
                    type="date"
                    value={form.effective_from ?? ""}
                    onChange={(e) => updateForm("effective_from", e.target.value || null)}
                    className={inputClass}
                  />
                </div>
                <div className="col-span-1">
                  <label className="mb-1 block text-xs font-medium text-gray-600">効力終了</label>
                  <input
                    type="date"
                    value={form.effective_until ?? ""}
                    onChange={(e) => updateForm("effective_until", e.target.value || null)}
                    className={inputClass}
                  />
                </div>
                <div className="col-span-1">
                  <label className="mb-1 block text-xs font-medium text-gray-600">署名取得日</label>
                  <input
                    type="date"
                    value={form.signed_at ?? ""}
                    onChange={(e) => updateForm("signed_at", e.target.value || null)}
                    className={inputClass}
                  />
                </div>
                <div className="col-span-1">
                  <label className="mb-1 block text-xs font-medium text-gray-600">署名者</label>
                  <input
                    type="text"
                    value={form.signed_by_name ?? ""}
                    onChange={(e) => updateForm("signed_by_name", e.target.value || null)}
                    placeholder="氏名"
                    className={inputClass}
                  />
                </div>
                <div className="col-span-1">
                  <label className="mb-1 block text-xs font-medium text-gray-600">続柄</label>
                  <input
                    type="text"
                    value={form.signed_by_relation ?? ""}
                    onChange={(e) => updateForm("signed_by_relation", e.target.value || null)}
                    placeholder="本人 / 長男 等"
                    className={inputClass}
                  />
                </div>
                <div className="col-span-2 sm:col-span-3">
                  <label className="mb-1 block text-xs font-medium text-gray-600">契約 office</label>
                  <select
                    value={form.office_id ?? ""}
                    onChange={(e) => updateForm("office_id", e.target.value || null)}
                    className={inputClass}
                  >
                    <option value="">—</option>
                    {officeOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                        {o.service_type ? ` (${o.service_type})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2 sm:col-span-3">
                  <label className="mb-1 block text-xs font-medium text-gray-600">添付 (PDF URL)</label>
                  <input
                    type="text"
                    value={form.attachment_url ?? ""}
                    onChange={(e) => updateForm("attachment_url", e.target.value || null)}
                    placeholder="スキャン PDF などのリンク"
                    className={inputClass}
                  />
                </div>
              </div>

              {/* 内容 sections */}
              <div className="mt-5 rounded-md border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-700">内容</h3>
                  {form.contract_type === "契約書兼重要事項説明書" && (
                    <button
                      type="button"
                      onClick={autoFillFromOffice}
                      className="rounded border border-indigo-200 bg-white px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-50"
                    >
                      事業所情報を取り込み
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {sections.map((sec) => {
                    const value = form.content?.[sec.key] ?? "";
                    const wide = sec.type === "textarea";
                    return (
                      <div key={sec.key} className={wide ? "sm:col-span-2" : ""}>
                        <label className="mb-1 block text-xs font-medium text-gray-600">
                          {sec.label}
                        </label>
                        {sec.type === "textarea" ? (
                          <textarea
                            value={value}
                            onChange={(e) => updateContentField(sec.key, e.target.value)}
                            placeholder={sec.placeholder}
                            rows={3}
                            className={inputClass}
                          />
                        ) : (
                          <input
                            type="text"
                            value={value}
                            onChange={(e) => updateContentField(sec.key, e.target.value)}
                            placeholder={sec.placeholder}
                            className={inputClass}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-4">
                <label className="mb-1 block text-xs font-medium text-gray-600">備考</label>
                <textarea
                  value={form.notes ?? ""}
                  onChange={(e) => updateForm("notes", e.target.value || null)}
                  rows={2}
                  className={inputClass}
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t bg-gray-50 px-4 py-3">
              {editId && (
                <Link
                  href={`/user-contracts/${editId}?user=${userId}`}
                  target="_blank"
                  className="mr-auto inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                  <ExternalLink size={12} /> プレビュー
                </Link>
              )}
              <button
                type="button"
                onClick={closeDialog}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 削除 confirm */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white shadow-xl">
            <div className="border-b px-4 py-3">
              <h2 className="text-base font-semibold text-gray-800">削除しますか?</h2>
            </div>
            <div className="px-4 py-3 text-sm text-gray-600">
              この契約書を削除すると元に戻せません。
            </div>
            <div className="flex justify-end gap-2 border-t bg-gray-50 px-4 py-3">
              <button
                type="button"
                onClick={() => setDeleteId(null)}
                disabled={deleting}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                削除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
