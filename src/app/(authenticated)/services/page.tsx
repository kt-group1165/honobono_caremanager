"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Plus,
  Search,
  ClipboardList,
  Loader2,
  X,
  Filter,
  Pencil,
  Trash2,
} from "lucide-react";
import { format } from "date-fns";
import { ja } from "date-fns/locale";

const SERVICE_TYPES = [
  "訪問介護",
  "訪問看護",
  "訪問リハビリ",
  "通所介護",
  "通所リハビリ",
  "短期入所",
  "居宅療養管理指導",
  "福祉用具貸与",
  "その他",
];

interface KaigoUser {
  id: string;
  name: string;
}

interface KaigoStaff {
  id: string;
  name: string;
}

interface ServiceRecord {
  id: string;
  service_date: string;
  service_type: string;
  start_time: string;
  end_time: string;
  content: string;
  user_id: string;
  staff_id: string;
  notes: string;
  clients?: { name: string };
  members?: { name: string };
}

const EMPTY_FORM = {
  service_date: format(new Date(), "yyyy-MM-dd"),
  service_type: "",
  start_time: "",
  end_time: "",
  content: "",
  user_id: "",
  staff_id: "",
  notes: "",
};

export default function ServicesPage() {
  const supabase = createClient();
  const [records, setRecords] = useState<ServiceRecord[]>([]);
  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [staff, setStaff] = useState<KaigoStaff[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<ServiceRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServiceRecord | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  // Filters
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterUser, setFilterUser] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    // PostgREST embed: kaigo_service_records.user_id → clients, .staff_id → members (FK redirect 済)
    let query = supabase
      .from("kaigo_service_records")
      .select(
        "*, clients(name), members(name)"
      )
      .order("service_date", { ascending: false })
      .order("start_time", { ascending: false });

    if (filterDateFrom) query = query.gte("service_date", filterDateFrom);
    if (filterDateTo) query = query.lte("service_date", filterDateTo);
    if (filterType) query = query.eq("service_type", filterType);
    if (filterUser) query = query.eq("user_id", filterUser);

    const { data, error } = await query.limit(200);
    if (error) {
      toast.error("サービス記録の取得に失敗しました");
    } else {
      setRecords(data || []);
    }
    setLoading(false);
  }, [supabase, filterDateFrom, filterDateTo, filterType, filterUser]);

  const fetchMasters = useCallback(async () => {
    const [usersRes, staffRes] = await Promise.all([
      supabase.from("clients").select("id, name").is("deleted_at", null).order("name"),
      supabase.from("members").select("id, name").eq("status", "active").order("furigana", { nullsFirst: false }),
    ]);
    if (!usersRes.error) setUsers(usersRes.data || []);
    if (!staffRes.error) setStaff(staffRes.data || []);
  }, [supabase]);

  useEffect(() => {
    fetchMasters();
  }, [fetchMasters]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const openCreateDialog = () => {
    setEditingRecord(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEditDialog = (record: ServiceRecord) => {
    setEditingRecord(record);
    setForm({
      service_date: record.service_date,
      service_type: record.service_type,
      start_time: record.start_time || "",
      end_time: record.end_time || "",
      content: record.content || "",
      user_id: record.user_id || "",
      staff_id: record.staff_id || "",
      notes: record.notes || "",
    });
    setDialogOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingRecord) {
        const { error } = await supabase
          .from("kaigo_service_records")
          .update(form)
          .eq("id", editingRecord.id);
        if (error) throw error;
        toast.success("サービス記録を更新しました");
      } else {
        const { error } = await supabase.from("kaigo_service_records").insert([form]);
        if (error) throw error;
        toast.success("サービス記録を登録しました");
      }
      setDialogOpen(false);
      fetchRecords();
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
        .from("kaigo_service_records")
        .delete()
        .eq("id", deleteTarget.id);
      if (error) throw error;
      toast.success("サービス記録を削除しました");
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
      fetchRecords();
    } catch (err: unknown) {
      toast.error(
        "削除に失敗しました: " + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const filtered = records.filter((r) => {
    if (!searchQuery) return true;
    const userName = r.clients?.name || "";
    const staffName = r.members?.name || "";
    return (
      userName.includes(searchQuery) ||
      staffName.includes(searchQuery) ||
      r.service_type.includes(searchQuery) ||
      (r.content || "").includes(searchQuery)
    );
  });

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "—";
    try {
      return format(new Date(dateStr), "M月d日(E)", { locale: ja });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ClipboardList className="text-blue-600" size={24} />
          <h1 className="text-xl font-bold text-gray-900">サービス記録</h1>
          <span className="ml-2 rounded-full bg-gray-100 px-2.5 py-0.5 text-sm text-gray-600">
            {filtered.length}件
          </span>
        </div>
        <button
          onClick={openCreateDialog}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          <Plus size={16} />
          新規記録
        </button>
      </div>

      {/* Filters */}
      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-3 text-sm font-medium text-gray-700">
          <Filter size={15} />
          絞り込み
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <div>
            <label className="block text-xs text-gray-500 mb-1">日付（開始）</label>
            <input
              type="date"
              value={filterDateFrom}
              onChange={(e) => setFilterDateFrom(e.target.value)}
              className="w-full rounded-lg border px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">日付（終了）</label>
            <input
              type="date"
              value={filterDateTo}
              onChange={(e) => setFilterDateTo(e.target.value)}
              className="w-full rounded-lg border px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">サービス種別</label>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="w-full rounded-lg border px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">すべて</option>
              {SERVICE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">利用者</label>
            <select
              value={filterUser}
              onChange={(e) => setFilterUser(e.target.value)}
              className="w-full rounded-lg border px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">すべて</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">キーワード</label>
            <div className="relative">
              <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-lg border pl-7 pr-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="検索..."
              />
            </div>
          </div>
        </div>
        {(filterDateFrom || filterDateTo || filterType || filterUser || searchQuery) && (
          <button
            onClick={() => {
              setFilterDateFrom("");
              setFilterDateTo("");
              setFilterType("");
              setFilterUser("");
              setSearchQuery("");
            }}
            className="mt-2 text-xs text-blue-600 hover:underline"
          >
            フィルターをリセット
          </button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-blue-500" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">
            サービス記録がありません
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">日付</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">利用者</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">サービス種別</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">時間</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">担当職員</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">内容</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((record) => (
                  <tr key={record.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-700 whitespace-nowrap">
                      {formatDate(record.service_date)}
                    </td>
                    <td className="px-4 py-3 text-gray-900">
                      {record.clients?.name || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700">
                        {record.service_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                      {record.start_time && record.end_time
                        ? `${record.start_time} 〜 ${record.end_time}`
                        : record.start_time || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {record.members?.name || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-600 max-w-[200px] truncate" title={record.content}>
                      {record.content || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => openEditDialog(record)}
                          className="rounded p-1.5 text-gray-500 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                          title="編集"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => {
                            setDeleteTarget(record);
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

      {/* Create/Edit Dialog */}
      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b px-6 py-4 sticky top-0 bg-white z-10">
              <h2 className="text-base font-semibold text-gray-900">
                {editingRecord ? "サービス記録を編集" : "新規サービス記録"}
              </h2>
              <button
                onClick={() => setDialogOpen(false)}
                className="rounded p-1 text-gray-400 hover:text-gray-600"
              >
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    日付 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={form.service_date}
                    onChange={(e) => setForm({ ...form, service_date: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    サービス種別 <span className="text-red-500">*</span>
                  </label>
                  <select
                    required
                    value={form.service_type}
                    onChange={(e) => setForm({ ...form, service_type: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">選択してください</option>
                    {SERVICE_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    利用者 <span className="text-red-500">*</span>
                  </label>
                  <select
                    required
                    value={form.user_id}
                    onChange={(e) => setForm({ ...form, user_id: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">選択してください</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    担当職員
                  </label>
                  <select
                    value={form.staff_id}
                    onChange={(e) => setForm({ ...form, staff_id: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">選択してください</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    開始時間
                  </label>
                  <input
                    type="time"
                    value={form.start_time}
                    onChange={(e) => setForm({ ...form, start_time: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    終了時間
                  </label>
                  <input
                    type="time"
                    value={form.end_time}
                    onChange={(e) => setForm({ ...form, end_time: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  サービス内容
                </label>
                <textarea
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  rows={3}
                  className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="実施したサービスの内容を入力"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  備考
                </label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="特記事項など"
                />
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
                  {editingRecord ? "更新する" : "登録する"}
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
            <h2 className="text-base font-semibold text-gray-900 mb-2">記録を削除</h2>
            <p className="text-sm text-gray-600 mb-6">
              {formatDate(deleteTarget.service_date)} の{" "}
              <span className="font-medium text-gray-900">
                {deleteTarget.clients?.name}
              </span>{" "}
              さんのサービス記録を削除しますか？
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
