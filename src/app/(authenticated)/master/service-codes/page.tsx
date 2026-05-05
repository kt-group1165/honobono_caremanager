"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Plus,
  Edit2,
  Trash2,
  Search,
  X,
  Save,
  Loader2,
  Tag,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ServiceCode {
  id: string;
  service_category: string;
  service_category_name: string;
  service_code: string;
  service_name: string;
  units: number;
  unit_type: string;
  calculation_type: "基本" | "加算" | "減算";
  valid_from: string | null;
  valid_until: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

type FormData = Omit<ServiceCode, "id" | "created_at" | "updated_at">;

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVICE_CATEGORIES: { value: string; label: string }[] = [
  { value: "11", label: "11:訪問介護" },
  { value: "13", label: "13:訪問看護" },
  { value: "14", label: "14:訪問リハ" },
  { value: "15", label: "15:通所介護" },
  { value: "16", label: "16:通所リハ" },
  { value: "17", label: "17:福祉用具貸与" },
  { value: "21", label: "21:短期入所" },
  { value: "43", label: "43:居宅介護支援" },
  { value: "46", label: "46:介護予防支援" },
];

const CATEGORY_NAMES: Record<string, string> = {
  "11": "訪問介護",
  "13": "訪問看護",
  "14": "訪問リハビリテーション",
  "15": "通所介護",
  "16": "通所リハビリテーション",
  "17": "福祉用具貸与",
  "21": "短期入所生活介護",
  "43": "居宅介護支援",
  "46": "介護予防支援",
};

const UNIT_TYPES = ["1回につき", "1日につき", "1月につき"];
const CALCULATION_TYPES = ["基本", "加算", "減算"] as const;

const CALC_TYPE_COLORS: Record<string, string> = {
  基本: "bg-blue-100 text-blue-700",
  加算: "bg-green-100 text-green-700",
  減算: "bg-red-100 text-red-700",
};

const EMPTY_FORM: FormData = {
  service_category: "",
  service_category_name: "",
  service_code: "",
  service_name: "",
  units: 0,
  unit_type: "1回につき",
  calculation_type: "基本",
  valid_from: null,
  valid_until: null,
  notes: null,
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function ServiceCodesPage() {
  const supabase = createClient();

  const [records, setRecords] = useState<ServiceCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCategory, setFilterCategory] = useState("");
  const [filterCalcType, setFilterCalcType] = useState("");
  const [searchText, setSearchText] = useState("");

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Delete confirm
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ─── Data fetch ──────────────────────────────────────────────────────────────

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from("kaigo_service_codes")
        .select("*")
        .order("service_category", { ascending: true })
        .order("service_code", { ascending: true });

      if (filterCategory) query = query.eq("service_category", filterCategory);
      if (filterCalcType)
        query = query.eq("calculation_type", filterCalcType);
      if (searchText) {
        query = query.or(
          `service_code.ilike.%${searchText}%,service_name.ilike.%${searchText}%`
        );
      }

      const { data, error } = await query.limit(1000);
      if (error) throw error;
      setRecords(data || []);
    } catch (err: unknown) {
      toast.error(
        "データの取得に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoading(false);
    }
  }, [supabase, filterCategory, filterCalcType, searchText]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchRecords();
  }, [fetchRecords]);

  // ─── Form helpers ────────────────────────────────────────────────────────────

  function openCreate() {
    setEditingId(null);
    setFormData(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(record: ServiceCode) {
    setEditingId(record.id);
    setFormData({
      service_category: record.service_category,
      service_category_name: record.service_category_name,
      service_code: record.service_code,
      service_name: record.service_name,
      units: record.units,
      unit_type: record.unit_type,
      calculation_type: record.calculation_type,
      valid_from: record.valid_from,
      valid_until: record.valid_until,
      notes: record.notes,
    });
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingId(null);
    setFormData(EMPTY_FORM);
  }

  function handleCategoryChange(value: string) {
    setFormData((prev) => ({
      ...prev,
      service_category: value,
      service_category_name: CATEGORY_NAMES[value] ?? "",
    }));
  }

  function setField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setFormData((prev) => ({ ...prev, [key]: value }));
  }

  // ─── Save ────────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!formData.service_category) {
      toast.error("サービス種類を選択してください");
      return;
    }
    if (!formData.service_code.trim()) {
      toast.error("サービスコードを入力してください");
      return;
    }
    if (!/^\d{6}$/.test(formData.service_code.trim())) {
      toast.error("サービスコードは6桁の数字で入力してください");
      return;
    }
    if (!formData.service_name.trim()) {
      toast.error("サービス名称を入力してください");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...formData,
        service_code: formData.service_code.trim(),
        service_name: formData.service_name.trim(),
        notes: formData.notes?.trim() || null,
        valid_from: formData.valid_from || null,
        valid_until: formData.valid_until || null,
      };

      if (editingId) {
        const { error } = await supabase
          .from("kaigo_service_codes")
          .update(payload)
          .eq("id", editingId);
        if (error) throw error;
        toast.success("サービスコードを更新しました");
      } else {
        const { error } = await supabase
          .from("kaigo_service_codes")
          .insert(payload);
        if (error) throw error;
        toast.success("サービスコードを登録しました");
      }

      closeDialog();
      fetchRecords();
    } catch (err: unknown) {
      toast.error(
        "保存に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("kaigo_service_codes")
        .delete()
        .eq("id", deleteId);
      if (error) throw error;
      toast.success("サービスコードを削除しました");
      setDeleteId(null);
      fetchRecords();
    } catch (err: unknown) {
      toast.error(
        "削除に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setDeleting(false);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Header ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 rounded-lg">
              <Tag className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-800">
                サービスコードマスタ
              </h1>
              <p className="text-sm text-gray-500">介護サービスコードの管理</p>
            </div>
            {!loading && (
              <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">
                {records.length}件
              </span>
            )}
          </div>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            新規登録
          </button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Service category */}
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="">全て（種類）</option>
            {SERVICE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>

          {/* Calculation type */}
          <select
            value={filterCalcType}
            onChange={(e) => setFilterCalcType(e.target.value)}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="">全て（区分）</option>
            {CALCULATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          {/* Text search */}
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="コード・名称で検索..."
              className="w-full text-sm border border-gray-300 rounded-lg pl-9 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
            {searchText && (
              <button
                onClick={() => setSearchText("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Table ── */}
      <div className="px-6 py-4">
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mr-2" />
              <span className="text-gray-500 text-sm">読み込み中...</span>
            </div>
          ) : records.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <Tag className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm">データがありません</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      サービス種類
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      サービスコード
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">
                      サービス名称
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      単位数
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      算定単位
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      区分
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {records.map((record) => (
                    <tr
                      key={record.id}
                      className="hover:bg-gray-50 transition-colors"
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
                          {record.service_category}
                        </span>
                        <span className="ml-1.5 text-gray-600 text-xs">
                          {record.service_category_name}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono whitespace-nowrap">
                        {record.service_code}
                      </td>
                      <td className="px-4 py-3 text-gray-800">
                        {record.service_name}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-800 whitespace-nowrap">
                        {record.units.toLocaleString("ja-JP")}
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {record.unit_type}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            CALC_TYPE_COLORS[record.calculation_type] ??
                            "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {record.calculation_type}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => openEdit(record)}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                            title="編集"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setDeleteId(record.id)}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                            title="削除"
                          >
                            <Trash2 className="w-4 h-4" />
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
      </div>

      {/* ── CRUD Dialog ── */}
      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={closeDialog}
          />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            {/* Dialog header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-800">
                {editingId
                  ? "サービスコード編集"
                  : "サービスコード新規登録"}
              </h2>
              <button
                onClick={closeDialog}
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Dialog body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              {/* Row: service_category */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    サービス種類
                    <span className="text-red-500 ml-0.5">*</span>
                  </label>
                  <select
                    value={formData.service_category}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    <option value="">選択してください</option>
                    {SERVICE_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    サービス種類名
                  </label>
                  <input
                    type="text"
                    value={formData.service_category_name}
                    readOnly
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-gray-500 cursor-not-allowed"
                    placeholder="種類を選択すると自動入力"
                  />
                </div>
              </div>

              {/* Row: service_code / service_name */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    サービスコード（6桁）
                    <span className="text-red-500 ml-0.5">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.service_code}
                    onChange={(e) => setField("service_code", e.target.value)}
                    maxLength={6}
                    placeholder="例: 111111"
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    サービス名称
                    <span className="text-red-500 ml-0.5">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.service_name}
                    onChange={(e) => setField("service_name", e.target.value)}
                    placeholder="例: 身体介護1"
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Row: units / unit_type / calculation_type */}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    単位数
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={formData.units}
                    onChange={(e) =>
                      setField("units", Number(e.target.value))
                    }
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    算定単位
                  </label>
                  <select
                    value={formData.unit_type}
                    onChange={(e) => setField("unit_type", e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    {UNIT_TYPES.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    区分
                  </label>
                  <select
                    value={formData.calculation_type}
                    onChange={(e) =>
                      setField(
                        "calculation_type",
                        e.target.value as "基本" | "加算" | "減算"
                      )
                    }
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    {CALCULATION_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Row: valid_from / valid_until */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    適用開始日
                  </label>
                  <input
                    type="date"
                    value={formData.valid_from ?? ""}
                    onChange={(e) =>
                      setField("valid_from", e.target.value || null)
                    }
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    適用終了日
                  </label>
                  <input
                    type="date"
                    value={formData.valid_until ?? ""}
                    onChange={(e) =>
                      setField("valid_until", e.target.value || null)
                    }
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* notes */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  備考
                </label>
                <textarea
                  value={formData.notes ?? ""}
                  onChange={(e) =>
                    setField("notes", e.target.value || null)
                  }
                  rows={3}
                  placeholder="備考・説明など"
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>

            {/* Dialog footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
              <button
                onClick={closeDialog}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                {editingId ? "更新する" : "登録する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirm dialog ── */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDeleteId(null)}
          />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-800 mb-2">
              削除の確認
            </h2>
            <p className="text-sm text-gray-600 mb-6">
              このサービスコードを削除してもよろしいですか？この操作は取り消せません。
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setDeleteId(null)}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {deleting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
                削除する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
