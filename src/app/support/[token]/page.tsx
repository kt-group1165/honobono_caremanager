"use client";

import { useState, useEffect, useCallback, useMemo, use } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  Loader2,
  User,
  Plus,
  Save,
  X,
  Clock,
  NotebookPen,
  Phone,
  House,
  MapPin,
  Mail,
  Users,
  ClipboardList,
  Activity,
  MoreHorizontal,
  Printer as FaxIcon,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { TemplatePicker } from "@/components/templates/template-picker";

// /support/[token] : 訪問先での支援経過記録モバイル画面（未認証アクセス可）。
// データアクセスは全て /api/support/[token]/* 経由（service_role）。
// Phase 2-6b で fetch ベースに書換。

// ─── Types ────────────────────────────────────────────────────────────────────

interface KaigoUser {
  id: string;
  name: string;
  name_kana: string;
}

interface SupportRecord {
  id: string;
  user_id: string;
  record_date: string;
  record_time: string | null;
  category: string;
  content: string;
  staff_name: string | null;
  created_at: string;
}

const CATEGORIES = [
  "電話", "訪問", "来所", "メール", "FAX", "カンファレンス",
  "サービス担当者会議", "モニタリング", "その他",
];

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  "電話": <Phone size={12} />,
  "訪問": <House size={12} />,
  "来所": <MapPin size={12} />,
  "メール": <Mail size={12} />,
  "FAX": <FaxIcon size={12} />,
  "カンファレンス": <Users size={12} />,
  "サービス担当者会議": <ClipboardList size={12} />,
  "モニタリング": <Activity size={12} />,
  "その他": <MoreHorizontal size={12} />,
};

const CATEGORY_COLORS: Record<string, string> = {
  "電話": "bg-blue-50 text-blue-700 border-blue-200",
  "訪問": "bg-green-50 text-green-700 border-green-200",
  "来所": "bg-teal-50 text-teal-700 border-teal-200",
  "メール": "bg-purple-50 text-purple-700 border-purple-200",
  "FAX": "bg-pink-50 text-pink-700 border-pink-200",
  "カンファレンス": "bg-yellow-50 text-yellow-700 border-yellow-200",
  "サービス担当者会議": "bg-orange-50 text-orange-700 border-orange-200",
  "モニタリング": "bg-indigo-50 text-indigo-700 border-indigo-200",
  "その他": "bg-gray-50 text-gray-700 border-gray-200",
};

type Params = { token: string };

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SupportMobilePage({ params }: { params: Promise<Params> }) {
  const { token } = use(params);
  const apiBase = useMemo(() => `/api/support/${encodeURIComponent(token)}`, [token]);

  const [valid, setValid] = useState<boolean | null>(null);
  const [tokenName, setTokenName] = useState("");

  // "users" → "records"
  const [screen, setScreen] = useState<"users" | "records">("users");
  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<KaigoUser | null>(null);
  const [records, setRecords] = useState<SupportRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // 新規フォーム
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    record_date: format(new Date(), "yyyy-MM-dd"),
    record_time: format(new Date(), "HH:mm"),
    category: "訪問",
    content: "",
    staff_name: "",
  });

  // 削除確認
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Validate token + fetch users
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(apiBase, { cache: "no-store" });
      if (cancelled) return;
      if (!res.ok) {
        setValid(false);
        return;
      }
      const data = (await res.json()) as { name: string };
      setValid(true);
      setTokenName(data.name);

      const usersRes = await fetch(`${apiBase}/users`, { cache: "no-store" });
      if (cancelled) return;
      if (usersRes.ok) {
        const json = (await usersRes.json()) as { users: KaigoUser[] };
        setUsers(json.users ?? []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  // Fetch records for selected user
  const fetchRecords = useCallback(async (userId: string) => {
    setLoading(true);
    try {
      const res = await fetch(
        `${apiBase}/records?user=${encodeURIComponent(userId)}`,
        { cache: "no-store" }
      );
      if (res.ok) {
        const json = (await res.json()) as { records: SupportRecord[] };
        setRecords(json.records ?? []);
      } else {
        setRecords([]);
      }
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  const openUser = (u: KaigoUser) => {
    setSelectedUser(u);
    setScreen("records");
    fetchRecords(u.id);
  };

  const handleDelete = async () => {
    if (!deleteTargetId || !selectedUser) return;
    setDeleting(true);
    const res = await fetch(`${apiBase}/records/${encodeURIComponent(deleteTargetId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error("削除に失敗: " + ((j as { error?: string }).error ?? res.status));
    } else {
      toast.success("支援経過を削除しました");
      setDeleteTargetId(null);
      fetchRecords(selectedUser.id);
    }
    setDeleting(false);
  };

  const handleAdd = async () => {
    if (!selectedUser) return;
    if (!form.content.trim()) { toast.error("内容を入力してください"); return; }
    setSaving(true);
    const res = await fetch(`${apiBase}/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: selectedUser.id,
        record_date: form.record_date,
        record_time: form.record_time || null,
        category: form.category,
        content: form.content,
        staff_name: form.staff_name || null,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error("追加に失敗: " + ((j as { error?: string }).error ?? res.status));
    } else {
      toast.success("支援経過を追加しました");
      setShowForm(false);
      setForm({
        record_date: format(new Date(), "yyyy-MM-dd"),
        record_time: format(new Date(), "HH:mm"),
        category: "訪問",
        content: "",
        staff_name: form.staff_name, // 職員名は保持
      });
      fetchRecords(selectedUser.id);
    }
    setSaving(false);
  };

  // ─── Loading / Invalid ───────────────────────────────────────────────────────

  if (valid === null) {
    return <div className="flex min-h-screen items-center justify-center"><Loader2 size={28} className="animate-spin text-blue-500" /></div>;
  }
  if (!valid) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="text-center">
          <NotebookPen size={48} className="mx-auto mb-3 text-red-400" />
          <h1 className="text-lg font-bold text-gray-900">無効なURLです</h1>
          <p className="mt-1 text-sm text-gray-500">このリンクは有効ではありません</p>
        </div>
      </div>
    );
  }

  // ─── Records View ────────────────────────────────────────────────────────────

  if (screen === "records" && selectedUser) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-white border-b px-4 py-3 shadow-sm">
          <button onClick={() => { setScreen("users"); setSelectedUser(null); }} className="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-100 active:bg-gray-200">
            <ChevronLeft size={20} />
          </button>
          <div className="flex-1">
            <h1 className="text-base font-bold text-gray-900">{selectedUser.name}</h1>
            <p className="text-xs text-gray-500">支援経過 {records.length}件</p>
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1 px-3 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold active:bg-blue-700 active:scale-95 transition-all"
          >
            <Plus size={16} />
            追加
          </button>
        </div>

        <div className="p-3">
          {loading ? (
            <div className="flex h-40 items-center justify-center"><Loader2 size={24} className="animate-spin text-blue-500" /></div>
          ) : records.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <NotebookPen size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">支援経過がまだありません</p>
            </div>
          ) : (
            <div className="space-y-2">
              {records.map((r) => (
                <div key={r.id} className="bg-white rounded-xl border border-gray-200 p-3 shadow-sm">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-gray-900 tabular-nums">
                        {format(parseISO(r.record_date), "M月d日(E)", { locale: ja })}
                      </span>
                      {r.record_time && (
                        <span className="text-xs text-gray-500 tabular-nums flex items-center gap-0.5">
                          <Clock size={10} />{r.record_time.slice(0, 5)}
                        </span>
                      )}
                    </div>
                    <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border", CATEGORY_COLORS[r.category] || CATEGORY_COLORS["その他"])}>
                      {CATEGORY_ICONS[r.category] || CATEGORY_ICONS["その他"]}
                      {r.category}
                    </span>
                  </div>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{r.content}</p>
                  <div className="mt-2 flex items-center justify-between">
                    <p className="text-xs text-gray-400">
                      {r.staff_name ? `記録者: ${r.staff_name}` : ""}
                    </p>
                    <button
                      onClick={() => setDeleteTargetId(r.id)}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600 active:bg-red-100"
                      title="この記録を削除（誤入力時）"
                    >
                      <Trash2 size={12} />
                      削除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 削除確認モーダル */}
        {deleteTargetId && (() => {
          const target = records.find((r) => r.id === deleteTargetId);
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              onClick={() => !deleting && setDeleteTargetId(null)}
            >
              <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl p-5"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-start gap-3 mb-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100">
                    <AlertTriangle size={20} className="text-red-600" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-base font-bold text-gray-900">
                      本当に削除しますか？
                    </h3>
                    <p className="mt-1 text-xs text-gray-500">
                      誤入力の取り消し用です。<br />
                      <span className="font-medium text-red-600">この操作は取り消せません。</span>
                    </p>
                  </div>
                </div>
                {target && (
                  <div className="mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-gray-600 mb-1">
                      <Clock size={11} />
                      <span className="font-semibold">
                        {format(parseISO(target.record_date), "M月d日(E)", { locale: ja })}
                        {target.record_time ? ` ${target.record_time.slice(0, 5)}` : ""}
                      </span>
                      <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-gray-700 border">
                        {target.category}
                      </span>
                    </div>
                    <p className="text-xs text-gray-700 whitespace-pre-wrap line-clamp-3 leading-relaxed">
                      {target.content}
                    </p>
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => setDeleteTargetId(null)}
                    disabled={deleting}
                    className="flex-1 rounded-xl border px-4 py-2.5 text-sm font-medium text-gray-600 active:bg-gray-50 disabled:opacity-50"
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex-1 inline-flex items-center justify-center gap-1 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white active:bg-red-700 disabled:opacity-50"
                  >
                    {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    削除する
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* 新規追加モーダル */}
        {showForm && (
          <div className="fixed inset-0 z-50 bg-white flex flex-col">
            <div className="sticky top-0 flex items-center justify-between border-b px-4 py-3 bg-white">
              <button onClick={() => setShowForm(false)} className="text-gray-500 active:text-gray-700 p-1">
                <X size={24} />
              </button>
              <h2 className="text-base font-bold text-gray-900">支援経過を追加</h2>
              <button onClick={handleAdd} disabled={saving} className="flex items-center gap-1 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold active:bg-blue-700 disabled:opacity-50">
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                保存
              </button>
            </div>

            <div className="flex-1 overflow-auto p-4 space-y-4">
              {/* 利用者 */}
              <div className="px-3 py-2 rounded-xl bg-blue-50 border border-blue-100 flex items-center gap-2">
                <User size={16} className="text-blue-600" />
                <span className="text-sm font-bold text-blue-900">{selectedUser.name}</span>
              </div>

              {/* 日付・時刻 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">日付</label>
                  <input
                    type="date"
                    value={form.record_date}
                    onChange={(e) => setForm({ ...form, record_date: e.target.value })}
                    className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-base focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">時刻</label>
                  <input
                    type="time"
                    value={form.record_time}
                    onChange={(e) => setForm({ ...form, record_time: e.target.value })}
                    className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-base focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* カテゴリ */}
              <div>
                <label className="block text-xs text-gray-500 mb-1">カテゴリ</label>
                <div className="grid grid-cols-3 gap-2">
                  {CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setForm({ ...form, category: cat })}
                      className={cn(
                        "flex items-center justify-center gap-1 px-2 py-2.5 rounded-xl border text-xs font-medium transition-all active:scale-95",
                        form.category === cat
                          ? CATEGORY_COLORS[cat]
                          : "bg-white border-gray-200 text-gray-600"
                      )}
                    >
                      {CATEGORY_ICONS[cat]}
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* 内容 */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs text-gray-500">内容 <span className="text-red-500">*</span></label>
                  <TemplatePicker
                    category="support_record"
                    currentText={form.content}
                    onInsert={(v) => setForm({ ...form, content: v })}
                    fetchUrl={`${apiBase}/templates`}
                  />
                </div>
                <textarea
                  rows={8}
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  placeholder="支援内容・利用者の様子・話した内容など..."
                  className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-base focus:border-blue-500 focus:outline-none resize-none"
                />
              </div>

              {/* 記録者 */}
              <div>
                <label className="block text-xs text-gray-500 mb-1">記録者</label>
                <input
                  type="text"
                  value={form.staff_name}
                  onChange={(e) => setForm({ ...form, staff_name: e.target.value })}
                  placeholder="例: 山田"
                  className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-base focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div className="h-4" />
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Users List ──────────────────────────────────────────────────────────────

  const filteredUsers = searchQuery
    ? users.filter((u) =>
        u.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        u.name_kana.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : users;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-10 bg-white border-b px-4 py-3 shadow-sm text-center">
        <h1 className="text-lg font-bold text-gray-900 flex items-center justify-center gap-2">
          <NotebookPen size={20} className="text-blue-500" />
          支援経過
        </h1>
        <p className="text-xs text-gray-500 mt-0.5">{tokenName}</p>
      </div>

      <div className="p-4 max-w-lg mx-auto">
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="利用者を検索（氏名・カナ）"
          className="w-full mb-3 rounded-xl border border-gray-300 px-3 py-2.5 text-base focus:border-blue-500 focus:outline-none"
        />
        <p className="text-sm text-gray-600 mb-3">{filteredUsers.length}名の利用者</p>
        <div className="space-y-2">
          {filteredUsers.map((u) => (
            <button
              key={u.id}
              onClick={() => openUser(u)}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white border border-gray-200 shadow-sm active:bg-gray-50 transition-colors text-left"
            >
              <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                <User size={18} className="text-blue-600" />
              </div>
              <div className="flex-1">
                <div className="text-base font-semibold text-gray-900">{u.name}</div>
                <div className="text-xs text-gray-400">{u.name_kana}</div>
              </div>
              <ChevronLeft size={16} className="text-gray-400 rotate-180" />
            </button>
          ))}
          {filteredUsers.length === 0 && (
            <p className="text-center text-sm text-gray-400 py-8">該当する利用者がいません</p>
          )}
        </div>
      </div>
    </div>
  );
}
