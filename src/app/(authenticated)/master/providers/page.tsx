"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Search,
  Building2,
  Loader2,
  Save,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

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

// ────────────────────────────────────────────────────────────────────────────
// Provider sidebar (vertical list on the left, mirrors UserSidebar pattern)
// ────────────────────────────────────────────────────────────────────────────
function ProviderSidebar({
  providers,
  selectedId,
  onSelect,
  onCreate,
  loading,
}: {
  providers: ServiceProvider[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  loading: boolean;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ProviderStatus>("active");

  const filtered = useMemo(() => {
    return providers.filter((p) => {
      const matchesSearch =
        !search ||
        p.provider_name.includes(search) ||
        p.provider_name_kana.includes(search) ||
        p.provider_number.includes(search);
      const matchesStatus = statusFilter === "all" || p.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [providers, search, statusFilter]);

  return (
    <div className="flex h-full w-56 flex-col border-r bg-white">
      <div className="border-b p-2 space-y-2">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="事業所検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border bg-gray-50 py-1.5 pl-7 pr-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "all" | ProviderStatus)}
          className="w-full rounded-md border bg-white py-1 px-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="active">有効のみ</option>
          <option value="inactive">無効のみ</option>
          <option value="all">全ステータス</option>
        </select>
        <button
          onClick={onCreate}
          className="w-full inline-flex items-center justify-center gap-1 rounded-md bg-blue-600 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
        >
          <Plus size={12} />
          新規登録
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-3 text-center text-xs text-gray-400">読込中...</div>
        ) : filtered.length === 0 ? (
          <div className="p-3 text-center text-xs text-gray-400">該当なし</div>
        ) : (
          <ul className="py-1">
            {filtered.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => onSelect(p.id)}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
                    selectedId === p.id
                      ? "bg-blue-50 text-blue-700 border-r-2 border-blue-600"
                      : "text-gray-700 hover:bg-gray-50"
                  )}
                >
                  <Building2 size={13} className="mt-0.5 shrink-0 text-gray-400" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium leading-tight">
                      {p.provider_name}
                    </div>
                    {p.provider_name_kana && (
                      <div className="truncate text-[10px] text-gray-400 leading-tight">
                        {p.provider_name_kana}
                      </div>
                    )}
                    {p.status === "inactive" && (
                      <span className="inline-block mt-0.5 rounded bg-gray-100 px-1 text-[9px] text-gray-500">
                        無効
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t px-3 py-1.5 text-[10px] text-gray-400">
        {filtered.length}件
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main page
// ────────────────────────────────────────────────────────────────────────────
export default function ProvidersPage() {
  const supabase = createClient();
  const [providers, setProviders] = useState<ServiceProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchProviders();
  }, [fetchProviders]);

  // 最初の有効な事業所を自動選択
  useEffect(() => {
    if (loading || isCreating) return;
    if (selectedId && providers.some((p) => p.id === selectedId)) return;
    const firstActive = providers.find((p) => p.status === "active") ?? providers[0];
    if (firstActive) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
      setSelectedId(firstActive.id);
    }
  }, [loading, providers, selectedId, isCreating]);

  const selectedProvider = providers.find((p) => p.id === selectedId) ?? null;

  // 選択された事業所の内容をフォームに反映
  useEffect(() => {
    if (isCreating) return;
    if (selectedProvider) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
      setForm({
        provider_number: selectedProvider.provider_number,
        provider_name: selectedProvider.provider_name,
        provider_name_kana: selectedProvider.provider_name_kana,
        service_categories: selectedProvider.service_categories ?? [],
        address: selectedProvider.address,
        phone: selectedProvider.phone,
        fax: selectedProvider.fax,
        manager_name: selectedProvider.manager_name,
        unit_price: selectedProvider.unit_price,
        status: selectedProvider.status,
      });
    }
  }, [selectedProvider, isCreating]);

  const openCreate = () => {
    setIsCreating(true);
    setSelectedId(null);
    setForm(EMPTY_FORM);
  };

  const cancelCreate = () => {
    setIsCreating(false);
    if (providers.length > 0) {
      const firstActive = providers.find((p) => p.status === "active") ?? providers[0];
      setSelectedId(firstActive?.id ?? null);
    }
  };

  const handleSelect = (id: string) => {
    setIsCreating(false);
    setSelectedId(id);
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
      if (isCreating) {
        const { data, error } = await supabase
          .from("kaigo_service_providers")
          .insert([payload])
          .select()
          .single();
        if (error) throw error;
        toast.success("事業所を登録しました");
        await fetchProviders();
        setIsCreating(false);
        if (data) setSelectedId(data.id);
      } else if (selectedId) {
        const { error } = await supabase
          .from("kaigo_service_providers")
          .update(payload)
          .eq("id", selectedId);
        if (error) throw error;
        toast.success("事業所情報を更新しました");
        await fetchProviders();
      }
    } catch (err: unknown) {
      toast.error(
        "保存に失敗しました: " + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedProvider) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("kaigo_service_providers")
        .delete()
        .eq("id", selectedProvider.id);
      if (error) throw error;
      toast.success("事業所を削除しました");
      setDeleteDialogOpen(false);
      setSelectedId(null);
      fetchProviders();
    } catch (err: unknown) {
      toast.error(
        "削除に失敗しました: " + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const showForm = isCreating || !!selectedProvider;

  return (
    <div className="flex h-full -m-6">
      <ProviderSidebar
        providers={providers}
        selectedId={selectedId}
        onSelect={handleSelect}
        onCreate={openCreate}
        loading={loading}
      />

      <div className="flex-1 overflow-y-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <Building2 className="text-blue-600" size={24} />
            <h1 className="text-xl font-bold text-gray-900">サービス事業所マスタ</h1>
            <span className="ml-2 rounded-full bg-gray-100 px-2.5 py-0.5 text-sm text-gray-600">
              {providers.length}件
            </span>
          </div>
          {!isCreating && selectedProvider && (
            <button
              onClick={() => setDeleteDialogOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
            >
              <Trash2 size={13} />
              削除
            </button>
          )}
        </div>

        {/* Empty state */}
        {!loading && providers.length === 0 && !isCreating && (
          <div className="rounded-lg border bg-white py-16 text-center text-sm text-gray-500">
            <Building2 size={40} className="mx-auto mb-3 text-gray-300" />
            事業所データがありません
            <div className="mt-3">
              <button
                onClick={openCreate}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                <Plus size={14} />
                新規登録
              </button>
            </div>
          </div>
        )}

        {/* Detail / Edit form */}
        {showForm && (
          <form onSubmit={handleSave} className="space-y-5">
            <div className="rounded-lg border bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-800">
                  {isCreating ? "新規事業所登録" : "事業所情報"}
                </h2>
                <div className="flex items-center gap-2">
                  {isCreating && (
                    <button
                      type="button"
                      onClick={cancelCreate}
                      className="rounded-md border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      キャンセル
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                    {isCreating ? "登録" : "保存"}
                  </button>
                </div>
              </div>

              {/* 事業所番号・ステータス */}
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
              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  提供サービス
                </label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {SERVICE_CATEGORY_CODES.map((code) => {
                    const checked = (form.service_categories ?? []).includes(code);
                    return (
                      <label
                        key={code}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                          checked
                            ? "border-blue-400 bg-blue-50 text-blue-700"
                            : "border-gray-200 text-gray-700 hover:bg-gray-50"
                        )}
                      >
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-blue-600"
                          checked={checked}
                          onChange={() => toggleServiceCategory(code)}
                        />
                        <span className="leading-tight">
                          <span className={cn("mr-1 rounded px-1 text-[10px]", SERVICE_BADGE_COLORS[code])}>
                            {code}
                          </span>
                          {SERVICE_CATEGORY_MAP[code]}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 連絡先・住所 */}
            <div className="rounded-lg border bg-white p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">連絡先</h3>
              <div className="grid grid-cols-1 gap-4">
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
              </div>
            </div>
          </form>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      {deleteDialogOpen && selectedProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white shadow-xl p-6">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-base font-semibold text-gray-900">事業所を削除</h2>
              <button
                onClick={() => setDeleteDialogOpen(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X size={16} />
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-6">
              <span className="font-medium text-gray-900">
                {selectedProvider.provider_name}
              </span>{" "}
              を削除しますか？この操作は取り消せません。
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteDialogOpen(false)}
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
