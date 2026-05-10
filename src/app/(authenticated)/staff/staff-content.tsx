"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  UserPlus,
  UserCheck,
  Pencil,
  Trash2,
  X,
  Search,
  UserCog,
  Loader2,
  Copy,
  Check,
} from "lucide-react";
import { useBusinessType } from "@/lib/business-type-context";

type EmploymentType = "常勤" | "非常勤" | "パート";
type StaffStatus = "active" | "inactive";

// 共通マスタ members の subset。Phase 2-3-2 で kaigo_staff から張替え。
//   kaigo_staff.name_kana → members.furigana
export interface Staff {
  id: string;
  tenant_id: string;
  name: string;
  furigana: string;
  role: string;
  qualifications: string;
  email: string;
  phone: string;
  employment_type: EmploymentType;
  hire_date: string;
  status: StaffStatus;
  created_at?: string;
}

const ROLES = [
  "介護福祉士",
  "ケアマネージャー",
  "看護師",
  "准看護師",
  "ヘルパー",
  "相談員",
  "管理者",
  "その他",
];

const EMPLOYMENT_TYPES: EmploymentType[] = ["常勤", "非常勤", "パート"];

type StaffForm = Omit<Staff, "id" | "tenant_id" | "created_at">;

type InviteRole = "member" | "office_admin";

type InviteForm = {
  display_name: string;
  login_id: string;
  role: InviteRole;
};

const EMPTY_INVITE_FORM: InviteForm = {
  display_name: "",
  login_id: "",
  role: "member",
};

type InviteResult = {
  invite_url: string;
  initial_password: string;
  login_id: string;
  login_id_was_renamed: boolean;
  expires_at: string | null;
};

const EMPTY_FORM: StaffForm = {
  name: "",
  furigana: "",
  role: "",
  qualifications: "",
  email: "",
  phone: "",
  employment_type: "常勤",
  hire_date: "",
  status: "active",
};

export function StaffContent({
  initialStaff,
}: {
  initialStaff: Staff[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, currentOfficeId } = useBusinessType();
  const [staffList, setStaffList] = useState<Staff[]>(initialStaff);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState<Staff | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Staff | null>(null);
  const [form, setForm] = useState<StaffForm>(EMPTY_FORM);
  // Phase 9-6: 既定は active のみ表示。toggle ON で退職者も含めて再フェッチ。
  const [includeInactive, setIncludeInactive] = useState(false);
  // 招待発行 modal: form / 結果 / 進行状態
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteForm, setInviteForm] = useState<InviteForm>(EMPTY_INVITE_FORM);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  const [copiedField, setCopiedField] = useState<"url" | "password" | null>(null);

  // 既存職員を自事業所に追加 modal
  const [addExistingOpen, setAddExistingOpen] = useState(false);
  const [addExistingLoading, setAddExistingLoading] = useState(false);
  const [addExistingSubmitting, setAddExistingSubmitting] = useState(false);
  const [addCandidates, setAddCandidates] = useState<
    Array<{ id: string; name: string; furigana: string | null; role: string | null; offices: string[] }>
  >([]);
  const [addSelectedIds, setAddSelectedIds] = useState<Set<string>>(new Set());
  const [addSearchQuery, setAddSearchQuery] = useState("");

  const fetchStaff = useCallback(async () => {
    if (!currentOfficeId) {
      setStaffList([]);
      return;
    }
    setLoading(true);
    // 自事業所 (currentOfficeId) に primary office として紐付く職員のみ取得
    // (multi-office 兼務職員は user_offices を経由して見せたい場合に拡張する)
    // Phase 9 close: members.office_id DROP 済 → member_offices junction 経由で絞り込み
    let q = supabase
      .from("members")
      .select("id, tenant_id, name, furigana, role, qualifications, email, phone, employment_type, hire_date, status, created_at, member_offices!inner(office_id)")
      .eq("member_offices.office_id", currentOfficeId);
    if (!includeInactive) q = q.eq("status", "active");
    const { data, error } = await q.order("furigana", { nullsFirst: false });
    if (error) {
      toast.error("職員データの取得に失敗しました");
    } else {
      setStaffList((data || []) as Staff[]);
    }
    setLoading(false);
  }, [supabase, currentOfficeId, includeInactive]);

  // 自事業所が変わったら / 退職者 toggle が変わったら 再フェッチ
  useEffect(() => {
    if (currentOfficeId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time async fetch (HANDOVER §2)
      fetchStaff();
    }
  }, [currentOfficeId, fetchStaff]);

  const openInviteDialog = () => {
    setInviteForm(EMPTY_INVITE_FORM);
    setInviteResult(null);
    setCopiedField(null);
    setInviteDialogOpen(true);
  };

  const closeInviteDialog = () => {
    setInviteDialogOpen(false);
    setInviteForm(EMPTY_INVITE_FORM);
    setInviteResult(null);
    setCopiedField(null);
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentOfficeId) {
      toast.error("自事業所が選択されていません");
      return;
    }
    setInviting(true);
    try {
      const res = await fetch("/api/staff/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: inviteForm.display_name.trim(),
          login_id: inviteForm.login_id.trim() || undefined,
          role: inviteForm.role,
          office_id: currentOfficeId,
        }),
      });
      const json = (await res.json()) as Partial<InviteResult> & {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        toast.error(
          "招待発行に失敗しました: " + (json.message ?? json.error ?? `HTTP ${res.status}`)
        );
        return;
      }
      if (!json.invite_url || !json.initial_password || !json.login_id) {
        toast.error("招待発行: 応答に不足する項目があります");
        return;
      }
      setInviteResult({
        invite_url: json.invite_url,
        initial_password: json.initial_password,
        login_id: json.login_id,
        login_id_was_renamed: json.login_id_was_renamed ?? false,
        expires_at: json.expires_at ?? null,
      });
      toast.success("招待を発行しました");
    } catch (err: unknown) {
      toast.error(
        "招待発行に失敗しました: " + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setInviting(false);
    }
  };

  // ── 既存職員を自事業所に追加 ──────────────────────────────────────────
  const openAddExisting = async () => {
    if (!currentOffice || !currentOfficeId) {
      toast.error("自事業所が選択されていません");
      return;
    }
    setAddSelectedIds(new Set());
    setAddSearchQuery("");
    setAddExistingOpen(true);
    setAddExistingLoading(true);
    try {
      // 同 tenant の active members を全件取得 (既存 member_offices も embed)
      const { data: members, error } = await supabase
        .from("members")
        .select("id, name, furigana, role, status, member_offices(office_id)")
        .eq("tenant_id", currentOffice.tenant_id)
        .eq("status", "active")
        .order("furigana", { nullsFirst: false });
      if (error) throw error;

      // office_id → name map (label 用)
      const allOfficeIds = new Set<string>();
      type MemberRow = {
        id: string;
        name: string;
        furigana: string | null;
        role: string | null;
        member_offices: Array<{ office_id: string }> | null;
      };
      for (const m of (members ?? []) as MemberRow[]) {
        for (const mo of m.member_offices ?? []) {
          allOfficeIds.add(mo.office_id);
        }
      }
      let officeNameMap = new Map<string, string>();
      if (allOfficeIds.size > 0) {
        const { data: offs } = await supabase
          .from("offices")
          .select("id, name")
          .in("id", Array.from(allOfficeIds));
        officeNameMap = new Map(
          ((offs ?? []) as Array<{ id: string; name: string }>).map((o) => [o.id, o.name]),
        );
      }

      // 自事業所 (currentOfficeId) に既に紐付いてる member は除外
      const candidates = ((members ?? []) as MemberRow[])
        .filter(
          (m) => !(m.member_offices ?? []).some((mo) => mo.office_id === currentOfficeId),
        )
        .map((m) => ({
          id: m.id,
          name: m.name,
          furigana: m.furigana,
          role: m.role,
          offices: (m.member_offices ?? [])
            .map((mo) => officeNameMap.get(mo.office_id) ?? "")
            .filter(Boolean),
        }));
      setAddCandidates(candidates);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("候補の取得に失敗しました: " + msg);
    } finally {
      setAddExistingLoading(false);
    }
  };

  const handleAddExistingSubmit = async () => {
    if (!currentOfficeId) return;
    if (addSelectedIds.size === 0) {
      toast.error("追加する職員を選択してください");
      return;
    }
    setAddExistingSubmitting(true);
    try {
      const rows = Array.from(addSelectedIds).map((member_id) => ({
        member_id,
        office_id: currentOfficeId,
        is_primary: false, // 兼務扱い (既存 primary を奪わない)
      }));
      const { error } = await supabase
        .from("member_offices")
        .upsert(rows, { onConflict: "member_id,office_id", ignoreDuplicates: true });
      if (error) throw error;
      toast.success(`${addSelectedIds.size} 名を自事業所に追加しました`);
      setAddExistingOpen(false);
      await fetchStaff();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("追加に失敗しました: " + msg);
    } finally {
      setAddExistingSubmitting(false);
    }
  };

  const filteredAddCandidates = useMemo(() => {
    const q = addSearchQuery.trim().toLowerCase();
    if (!q) return addCandidates;
    return addCandidates.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.furigana ?? "").toLowerCase().includes(q) ||
        (c.role ?? "").toLowerCase().includes(q) ||
        c.offices.some((o) => o.toLowerCase().includes(q)),
    );
  }, [addCandidates, addSearchQuery]);

  const copyToClipboard = async (text: string, field: "url" | "password") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      window.setTimeout(() => {
        setCopiedField((c) => (c === field ? null : c));
      }, 1500);
    } catch {
      toast.error("クリップボードへのコピーに失敗しました");
    }
  };

  const openEditDialog = (staff: Staff) => {
    setEditingStaff(staff);
    setForm({
      name: staff.name,
      furigana: staff.furigana,
      role: staff.role,
      qualifications: staff.qualifications,
      email: staff.email,
      phone: staff.phone,
      employment_type: staff.employment_type,
      hire_date: staff.hire_date,
      status: staff.status,
    });
    setDialogOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStaff) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("members")
        .update(form)
        .eq("id", editingStaff.id);
      if (error) throw error;
      toast.success("職員情報を更新しました");
      setDialogOpen(false);
      fetchStaff();
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
        .from("members")
        .delete()
        .eq("id", deleteTarget.id);
      if (error) throw error;
      toast.success("職員を削除しました");
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
      fetchStaff();
    } catch (err: unknown) {
      toast.error(
        "削除に失敗しました: " + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const tenantId = currentOffice?.tenant_id;
  const tenantStaff = useMemo(
    () => (tenantId ? staffList.filter((s) => s.tenant_id === tenantId) : staffList),
    [staffList, tenantId]
  );

  const filtered = useMemo(
    () =>
      tenantStaff.filter(
        (s) =>
          s.name.includes(searchQuery) ||
          (s.furigana ?? "").includes(searchQuery) ||
          (s.role ?? "").includes(searchQuery)
      ),
    [tenantStaff, searchQuery]
  );

  const employmentBadge = (type: EmploymentType) => {
    const map: Record<EmploymentType, string> = {
      常勤: "bg-blue-100 text-blue-700",
      非常勤: "bg-yellow-100 text-yellow-700",
      パート: "bg-purple-100 text-purple-700",
    };
    return (
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[type]}`}>
        {type}
      </span>
    );
  };

  const statusBadge = (status: StaffStatus) => (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        status === "active"
          ? "bg-green-100 text-green-700"
          : "bg-gray-100 text-gray-500"
      }`}
    >
      {status === "active" ? "在職" : "退職"}
    </span>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserCog className="text-blue-600" size={24} />
          <h1 className="text-xl font-bold text-gray-900">職員管理</h1>
          <span className="ml-2 rounded-full bg-gray-100 px-2.5 py-0.5 text-sm text-gray-600">
            {tenantStaff.length}名
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openAddExisting}
            className="flex items-center gap-2 rounded-lg border border-blue-600 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 transition-colors"
            title="同じテナントの既存職員を自事業所に兼務として追加"
          >
            <UserCheck size={16} />
            既存職員を追加
          </button>
          <button
            onClick={openInviteDialog}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <UserPlus size={16} />
            招待発行
          </button>
        </div>
      </div>

      {/* Search + 退職者 toggle */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative max-w-sm flex-1 min-w-[240px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="氏名・ふりがな・職種で検索"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border pl-9 pr-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="rounded border-gray-300"
          />
          退職者を含める
        </label>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-blue-500" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">
            職員データがありません
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">氏名</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">ふりがな</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">職種</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">資格</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">雇用形態</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">入職日</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">連絡先</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">状態</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((staff) => (
                  <tr key={staff.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">{staff.name}</td>
                    <td className="px-4 py-3 text-gray-500">{staff.furigana}</td>
                    <td className="px-4 py-3 text-gray-700">{staff.role}</td>
                    <td className="px-4 py-3 text-gray-500 max-w-[140px] truncate" title={staff.qualifications}>
                      {staff.qualifications || "—"}
                    </td>
                    <td className="px-4 py-3">{employmentBadge(staff.employment_type)}</td>
                    <td className="px-4 py-3 text-gray-600">{staff.hire_date || "—"}</td>
                    <td className="px-4 py-3 text-gray-500">
                      <div>{staff.email}</div>
                      <div>{staff.phone}</div>
                    </td>
                    <td className="px-4 py-3">{statusBadge(staff.status)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => openEditDialog(staff)}
                          className="rounded p-1.5 text-gray-500 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                          title="編集"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => {
                            setDeleteTarget(staff);
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

      {/* Edit Dialog (編集専用 — 新規は招待発行 modal) */}
      {dialogOpen && editingStaff && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">
                職員情報を編集
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
                    氏名 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="山田 太郎"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    ふりがな <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={form.furigana}
                    onChange={(e) => setForm({ ...form, furigana: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="やまだ たろう"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    職種 <span className="text-red-500">*</span>
                  </label>
                  <select
                    required
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">選択してください</option>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    資格
                  </label>
                  <input
                    type="text"
                    value={form.qualifications}
                    onChange={(e) => setForm({ ...form, qualifications: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="介護福祉士、ヘルパー2級等"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    メールアドレス
                  </label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="example@company.com"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    電話番号
                  </label>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="090-0000-0000"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    雇用形態 <span className="text-red-500">*</span>
                  </label>
                  <select
                    required
                    value={form.employment_type}
                    onChange={(e) =>
                      setForm({ ...form, employment_type: e.target.value as EmploymentType })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {EMPLOYMENT_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    入職日
                  </label>
                  <input
                    type="date"
                    value={form.hire_date}
                    onChange={(e) => setForm({ ...form, hire_date: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    状態
                  </label>
                  <select
                    value={form.status}
                    onChange={(e) =>
                      setForm({ ...form, status: e.target.value as StaffStatus })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="active">在職</option>
                    <option value="inactive">退職</option>
                  </select>
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
                  更新する
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
            <h2 className="text-base font-semibold text-gray-900 mb-2">職員を削除</h2>
            <p className="text-sm text-gray-600 mb-6">
              <span className="font-medium text-gray-900">{deleteTarget.name}</span>{" "}
              さんを削除しますか？この操作は取り消せません。
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

      {/* Add Existing Members Dialog (既存職員を自事業所に追加) */}
      {addExistingOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => !addExistingSubmitting && setAddExistingOpen(false)}
          />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-base font-semibold text-gray-800">既存職員を自事業所に追加</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {currentOffice?.name} に兼務として追加します。既存の主所属は維持されます。
                </p>
              </div>
              <button
                type="button"
                onClick={() => !addExistingSubmitting && setAddExistingOpen(false)}
                disabled={addExistingSubmitting}
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-3 border-b">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="氏名・ふりがな・職種・所属事業所で検索"
                  value={addSearchQuery}
                  onChange={(e) => setAddSearchQuery(e.target.value)}
                  className="w-full rounded-lg border pl-9 pr-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                <span>
                  選択 {addSelectedIds.size} 名 / 候補 {filteredAddCandidates.length} 名
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setAddSelectedIds(new Set(filteredAddCandidates.map((c) => c.id)))}
                    className="rounded border border-gray-200 bg-white px-2 py-0.5 hover:bg-gray-50"
                  >
                    全選択
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddSelectedIds(new Set())}
                    className="rounded border border-gray-200 bg-white px-2 py-0.5 hover:bg-gray-50"
                  >
                    全解除
                  </button>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {addExistingLoading ? (
                <div className="flex items-center justify-center py-12 text-gray-500">
                  <Loader2 size={20} className="mr-2 animate-spin" />
                  候補読込中...
                </div>
              ) : filteredAddCandidates.length === 0 ? (
                <div className="text-center text-sm text-gray-400 py-12">
                  追加可能な職員がありません
                  <div className="mt-1 text-[11px] text-gray-400">
                    (同 tenant の active 職員のうち、自事業所未紐付けの者が候補)
                  </div>
                </div>
              ) : (
                <ul className="divide-y">
                  {filteredAddCandidates.map((c) => {
                    const checked = addSelectedIds.has(c.id);
                    return (
                      <li key={c.id}>
                        <label
                          className={`flex items-center gap-3 px-6 py-2.5 cursor-pointer hover:bg-gray-50 ${
                            checked ? "bg-blue-50/50" : ""
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setAddSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(c.id);
                                else next.delete(c.id);
                                return next;
                              });
                            }}
                            className="accent-blue-600"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-800">{c.name}</span>
                              {c.furigana && (
                                <span className="text-[11px] text-gray-400">({c.furigana})</span>
                              )}
                              {c.role && (
                                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                                  {c.role}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-gray-500 truncate mt-0.5">
                              {c.offices.length > 0
                                ? `所属: ${c.offices.join(" / ")}`
                                : "所属事業所なし"}
                            </div>
                          </div>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 border-t px-6 py-4 bg-gray-50 rounded-b-2xl">
              <button
                type="button"
                onClick={() => !addExistingSubmitting && setAddExistingOpen(false)}
                disabled={addExistingSubmitting}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleAddExistingSubmit}
                disabled={addExistingSubmitting || addSelectedIds.size === 0}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {addExistingSubmitting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <UserCheck size={14} />
                )}
                {addSelectedIds.size} 名 追加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Invite Dialog (招待発行) */}
      {inviteDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">
                {inviteResult ? "招待を発行しました" : "招待発行"}
              </h2>
              <button
                onClick={closeInviteDialog}
                className="rounded p-1 text-gray-400 hover:text-gray-600"
              >
                <X size={20} />
              </button>
            </div>

            {!inviteResult ? (
              <form onSubmit={handleInvite} className="p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    表示名 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={inviteForm.display_name}
                    onChange={(e) =>
                      setInviteForm({ ...inviteForm, display_name: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="山田 太郎"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    ログイン ID <span className="text-gray-400">(任意)</span>
                  </label>
                  <input
                    type="text"
                    value={inviteForm.login_id}
                    onChange={(e) =>
                      setInviteForm({ ...inviteForm, login_id: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="未指定なら表示名から自動生成"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    半角英数字と一部記号のみ。空欄なら表示名から派生します。
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    権限 <span className="text-red-500">*</span>
                  </label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input
                        type="radio"
                        name="invite-role"
                        value="member"
                        checked={inviteForm.role === "member"}
                        onChange={() =>
                          setInviteForm({ ...inviteForm, role: "member" })
                        }
                      />
                      member (一般職員)
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input
                        type="radio"
                        name="invite-role"
                        value="office_admin"
                        checked={inviteForm.role === "office_admin"}
                        onChange={() =>
                          setInviteForm({ ...inviteForm, role: "office_admin" })
                        }
                      />
                      office_admin (事業所管理者)
                    </label>
                  </div>
                </div>
                {currentOffice && (
                  <p className="text-xs text-gray-500">
                    招待対象事業所: <span className="font-medium">{currentOffice.name}</span>
                  </p>
                )}
                <div className="flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={closeInviteDialog}
                    className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    キャンセル
                  </button>
                  <button
                    type="submit"
                    disabled={inviting || !currentOfficeId}
                    className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {inviting && <Loader2 size={14} className="animate-spin" />}
                    発行
                  </button>
                </div>
              </form>
            ) : (
              <div className="p-6 space-y-4">
                <p className="text-sm text-gray-700">
                  以下を本人へ伝えてください。初回パスワードはこの画面でしか確認できません。
                </p>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    招待 URL
                  </label>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={inviteResult.invite_url}
                      onFocus={(e) => e.currentTarget.select()}
                      className="flex-1 rounded-lg border bg-gray-50 px-3 py-2 text-sm font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => copyToClipboard(inviteResult.invite_url, "url")}
                      className="flex items-center gap-1 rounded-lg border px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      {copiedField === "url" ? (
                        <>
                          <Check size={14} className="text-green-600" />
                          コピー済
                        </>
                      ) : (
                        <>
                          <Copy size={14} />
                          コピー
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    初回パスワード
                  </label>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={inviteResult.initial_password}
                      onFocus={(e) => e.currentTarget.select()}
                      className="flex-1 rounded-lg border bg-gray-50 px-3 py-2 text-sm font-mono"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        copyToClipboard(inviteResult.initial_password, "password")
                      }
                      className="flex items-center gap-1 rounded-lg border px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      {copiedField === "password" ? (
                        <>
                          <Check size={14} className="text-green-600" />
                          コピー済
                        </>
                      ) : (
                        <>
                          <Copy size={14} />
                          コピー
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 space-y-1">
                  <div>
                    ログイン ID:{" "}
                    <span className="font-mono">{inviteResult.login_id}</span>
                    {inviteResult.login_id_was_renamed && (
                      <span className="ml-2 text-amber-600">
                        (重複のため連番を付与)
                      </span>
                    )}
                  </div>
                  {inviteResult.expires_at && (
                    <div>
                      有効期限:{" "}
                      <span className="font-mono">
                        {new Date(inviteResult.expires_at).toLocaleString("ja-JP")}
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={closeInviteDialog}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
                  >
                    閉じる
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
