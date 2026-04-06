"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Trash2,
  X,
  Search,
  Building2,
  Loader2,
  Phone,
  Printer,
} from "lucide-react";

type ProviderStatus = "active" | "inactive";

interface ServiceProvider {
  id: string;
  provider_number: string;
  provider_name: string;
  provider_name_kana: string;
  service_categories: string[];
  address: string;
  phone: string;
  fax: string;
  manager_name: string;
  unit_price: number;
  status: ProviderStatus;
  created_at?: string;
}

const SERVICE_CATEGORY_MAP: Record<string, string> = {
  "11": "訪問介護",
  "13": "訪問看護",
  "14": "訪問リハ",
  "15": "通所介護",
  "16": "通所リハ",
  "17": "福祉用具貸与",
  "21": "短期入所",
  "43": "居宅介護支援",
};

const SERVICE_CATEGORY_CODES = Object.keys(SERVICE_CATEGORY_MAP);

const UNIT_PRICE_OPTIONS = [10.0, 10.14, 10.27, 10.42, 10.7, 10.84, 11.05, 11.12];

const SERVICE_BADGE_COLORS: Record<string, string> = {
  "11": "bg-orange-100 text-orange-700",
  "13": "bg-blue-100 text-blue-700",
  "14": "bg-cyan-100 text-cyan-700",
  "15": "bg-green-100 text-green-700",
  "16": "bg-teal-100 text-teal-700",
  "17": "bg-purple-100 text-purple-700",
  "21": "bg-yellow-100 text-yellow-700",
  "43": "bg-rose-100 text-rose-700",
};

const EMPTY_FORM: Omit<ServiceProvider, "id" | "created_at"> = {
  provider_number: "",
  provider_name: "",
  provider_name_kana: "",
  service_categories: [],
  address: "",
  phone: "",
  fax: "",
  manager_name: "",
  unit_price: 10.0,
  status: "active",
};

export default function ProvidersPage() {
  const supabase = createClient();
  const [providers, setProviders] = useState<ServiceProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ProviderStatus>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ServiceProvider | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServiceProvider | null>(null);
  const [form, setForm] = useState<Omit<ServiceProvider, "id" | "created_at">>(EMPTY_FORM);

  const fetchProviders = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("kaigo_service_providers")
      .select("*")
      .order("provider_name_kana");
    if (error) {
      toast.error("事業所データの取得に失敗しました");
    } else {
      setProviders(data || []);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const openCreateDialog = () => {
    setEditingProvider(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEditDialog = (provider: ServiceProvider) => {
    setEditingProvider(provider);
    setForm({
      provider_number: provider.provider_number,
      provider_name: provider.provider_name,
      provider_name_kana: provider.provider_name_kana,
      service_categories: provider.service_categories ?? [],
      address: provider.address,
      phone: provider.phone,
      fax: provider.fax,
      manager_name: provider.manager_name,
      unit_price: provider.unit_price,
      status: provider.status,
    });
    setDialogOpen(true);
  };

  const toggleServiceCategory = (code: string) => {
    setForm((prev) => {
      const current = prev.service_categories ?? [];
      return {
        ...prev,
        service_categories: current.includes(code)
          ? current.filter((c) => c !== code)
          : [...current, code],
      };
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        service_categories: form.service_categories as string[],
      };
      if (editingProvider) {
        const { error } = await supabase
          .from("kaigo_service_providers")
          .update(payload)
          .eq("id", editingProvider.id);
        if (error) throw error;
        toast.success("事業所情報を更新しました");
      } else {
        const { error } = await supabase
          .from("kaigo_service_providers")
          .insert([payload]);
        if (error) throw error;
        toast.success("事業所を登録しました");
      }
      setDialogOpen(false);
      fetchProviders();
    } catch (err: unknown) {
      toast.error(
        "保存に失敗しました: " + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("kaigo_service_providers")
        .delete()
        .eq("id", deleteTarget.id);
      if (error) throw error;
      toast.success("事業所を削除しました");
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
      fetchProviders();
    } catch (err: unknown) {
      toast.error(
        "削除に失敗しました: " + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const filtered = providers.filter((p) => {
    const matchesSearch =
      searchQuery === "" ||
      p.provider_name.includes(searchQuery) ||
      p.provider_name_kana.includes(searchQuery) ||
      p.provider_number.includes(searchQuery);
    const matchesStatus =
      statusFilter === "all" || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const statusBadge = (status: ProviderStatus) => (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        status === "active"
          ? "bg-green-100 text-green-700"
          : "bg-gray-100 text-gray-500"
      }`}
    >
      {status === "active" ? "有効" : "無効"}
    </span>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="text-blue-600" size={24} />
          <h1 className="text-xl font-bold text-gray-900">サービス事業所マスタ</h1>
          <span className="ml-2 rounded-full bg-gray-100 px-2.5 py-0.5 text-sm text-gray-600">
            {providers.length}件
          </span>
        </div>
        <button
          onClick={openCreateDialog}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          <Plus size={16} />
          新規登録
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            placeholder="事業所名・番号で検索"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-64 rounded-lg border pl-9 pr-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "all" | ProviderStatus)}
          className="rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="all">全ステータス</option>
          <option value="active">有効</option>
          <option value="inactive">無効</option>
        </select>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-blue-500" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">
            事業所データがありません
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap">
                    事業所番号
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap">
                    事業所名
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap">
                    提供サービス
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap">
                    住所
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap">
                    電話 / FAX
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap">
                    管理者
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap">
                    地域区分単価
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap">
                    状態
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600 whitespace-nowrap">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((provider) => (
                  <tr
                    key={provider.id}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-gray-700 whitespace-nowrap">
                      {provider.provider_number}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {provider.provider_name}
                      </div>
                      <div className="text-xs text-gray-400">
                        {provider.provider_name_kana}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1 max-w-[200px]">
                        {(provider.service_categories ?? []).map((code) => (
                          <span
                            key={code}
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              SERVICE_BADGE_COLORS[code] ??
                              "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {SERVICE_CATEGORY_MAP[code] ?? code}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 max-w-[180px] truncate" title={provider.address}>
                      {provider.address || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      {provider.phone && (
                        <div className="flex items-center gap-1">
                          <Phone size={12} className="text-gray-400" />
                          {provider.phone}
                        </div>
                      )}
                      {provider.fax && (
                        <div className="flex items-center gap-1 text-xs">
                          <Printer size={12} className="text-gray-400" />
                          {provider.fax}
                        </div>
                      )}
                      {!provider.phone && !provider.fax && "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                      {provider.manager_name || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                      {provider.unit_price != null
                        ? provider.unit_price.toFixed(2)
                        : "—"}
                    </td>
                    <td className="px-4 py-3">{statusBadge(provider.status)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => openEditDialog(provider)}
                          className="rounded p-1.5 text-gray-500 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                          title="編集"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => {
                            setDeleteTarget(provider);
                            setDeleteDialogOpen(true);
                          }}
                          className="rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors"
                          title="削除"
                        >
                          <Trash2 size={15} />
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

      {/* Create / Edit Dialog */}
      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-8">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">
                {editingProvider ? "事業所情報を編集" : "事業所を新規登録"}
              </h2>
              <button
                onClick={() => setDialogOpen(false)}
                className="rounded p-1 text-gray-400 hover:text-gray-600"
              >
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-5">
              {/* 事業所番号・事業所名 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    事業所番号 <span className="text-red-500">*</span>
                    <span className="ml-1 text-xs text-gray-400">(10桁)</span>
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={10}
                    pattern="\d{10}"
                    title="10桁の数字を入力してください"
                    value={form.provider_number}
                    onChange={(e) =>
                      setForm({ ...form, provider_number: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="1234567890"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    ステータス
                  </label>
                  <select
                    value={form.status}
                    onChange={(e) =>
                      setForm({ ...form, status: e.target.value as ProviderStatus })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="active">有効</option>
                    <option value="inactive">無効</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    事業所名 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={form.provider_name}
                    onChange={(e) =>
                      setForm({ ...form, provider_name: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="○○介護サービス"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    フリガナ
                  </label>
                  <input
                    type="text"
                    value={form.provider_name_kana}
                    onChange={(e) =>
                      setForm({ ...form, provider_name_kana: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="マルマルカイゴサービス"
                  />
                </div>
              </div>

              {/* 提供サービス */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  提供サービス
                </label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {SERVICE_CATEGORY_CODES.map((code) => {
                    const checked = (form.service_categories ?? []).includes(code);
                    return (
                      <label
                        key={code}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                          checked
                            ? "border-blue-400 bg-blue-50 text-blue-700"
                            : "border-gray-200 text-gray-700 hover:bg-gray-50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-blue-600"
                          checked={checked}
                          onChange={() => toggleServiceCategory(code)}
                        />
                        <span className="leading-tight">
                          {SERVICE_CATEGORY_MAP[code]}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* 住所 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  住所
                </label>
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="東京都○○区○○町1-2-3"
                />
              </div>

              {/* 電話・FAX・管理者・単価 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    電話番号
                  </label>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="03-0000-0000"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    FAX番号
                  </label>
                  <input
                    type="tel"
                    value={form.fax}
                    onChange={(e) => setForm({ ...form, fax: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="03-0000-0001"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    管理者名
                  </label>
                  <input
                    type="text"
                    value={form.manager_name}
                    onChange={(e) =>
                      setForm({ ...form, manager_name: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="田中 一郎"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    地域区分単価
                  </label>
                  <select
                    value={form.unit_price}
                    onChange={(e) =>
                      setForm({ ...form, unit_price: parseFloat(e.target.value) })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {UNIT_PRICE_OPTIONS.map((p) => (
                      <option key={p} value={p}>
                        {p.toFixed(2)}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-400">
                    1単位あたりの単価（円）
                  </p>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setDialogOpen(false)}
                  className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  {editingProvider ? "更新する" : "登録する"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteDialogOpen && deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white shadow-xl p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">
              事業所を削除
            </h2>
            <p className="text-sm text-gray-600 mb-6">
              <span className="font-medium text-gray-900">
                {deleteTarget.provider_name}
              </span>{" "}
              を削除しますか？この操作は取り消せません。
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setDeleteDialogOpen(false);
                  setDeleteTarget(null);
                }}
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
