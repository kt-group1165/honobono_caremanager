"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { differenceInYears, parseISO, format } from "date-fns";
import {
  ChevronLeft,
  Pencil,
  Save,
  X,
  User,
} from "lucide-react";
import type { KaigoUser } from "@/types/database";

const TABS = [
  { label: "基本情報", href: "" },
  { label: "介護認定", href: "/care-cert" },
  { label: "医療保険", href: "/medical" },
  { label: "ADL", href: "/adl" },
  { label: "健康管理", href: "/health" },
  { label: "親族・関係者", href: "/family" },
  { label: "既往歴", href: "/history" },
];

const STATUS_LABELS: Record<string, string> = {
  active: "在籍中",
  inactive: "退所",
  deceased: "死亡",
};

const inputClass =
  "w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

type EditForm = {
  name: string;
  name_kana: string;
  gender: string;
  birth_date: string;
  blood_type: string;
  postal_code: string;
  address: string;
  phone: string;
  mobile_phone: string;
  email: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  admission_date: string;
  status: string;
  notes: string;
};

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex gap-2 py-2 border-b last:border-0">
      <span className="w-40 shrink-0 text-sm text-gray-500">{label}</span>
      <span className="text-sm text-gray-900">{value || "—"}</span>
    </div>
  );
}

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();

  const [user, setUser] = useState<KaigoUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<EditForm>({
    name: "",
    name_kana: "",
    gender: "女",
    birth_date: "",
    blood_type: "",
    postal_code: "",
    address: "",
    phone: "",
    mobile_phone: "",
    email: "",
    emergency_contact_name: "",
    emergency_contact_phone: "",
    admission_date: "",
    status: "active",
    notes: "",
  });

  const fetchUser = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_users")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      setUser(data);
      setForm({
        name: data.name ?? "",
        name_kana: data.name_kana ?? "",
        gender: data.gender ?? "女",
        birth_date: data.birth_date ?? "",
        blood_type: data.blood_type ?? "",
        postal_code: data.postal_code ?? "",
        address: data.address ?? "",
        phone: data.phone ?? "",
        mobile_phone: data.mobile_phone ?? "",
        email: data.email ?? "",
        emergency_contact_name: data.emergency_contact_name ?? "",
        emergency_contact_phone: data.emergency_contact_phone ?? "",
        admission_date: data.admission_date ?? "",
        status: data.status ?? "active",
        notes: data.notes ?? "",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "取得に失敗しました";
      toast.error(message);
      router.push("/users");
    } finally {
      setLoading(false);
    }
  }, [supabase, id, router]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error("氏名は必須です");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from("kaigo_users")
        .update({
          name: form.name.trim(),
          name_kana: form.name_kana.trim(),
          gender: form.gender,
          birth_date: form.birth_date,
          blood_type: form.blood_type || null,
          postal_code: form.postal_code || null,
          address: form.address || null,
          phone: form.phone || null,
          mobile_phone: form.mobile_phone || null,
          email: form.email || null,
          emergency_contact_name: form.emergency_contact_name || null,
          emergency_contact_phone: form.emergency_contact_phone || null,
          admission_date: form.admission_date || null,
          status: form.status,
          notes: form.notes || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
      toast.success("保存しました");
      setEditing(false);
      fetchUser();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "保存に失敗しました";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const baseHref = `/users/${id}`;

  // Determine active tab
  const activeTabHref = TABS.find((t) => {
    if (t.href === "") return pathname === baseHref;
    return pathname.startsWith(baseHref + t.href);
  })?.href ?? "";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        読み込み中...
      </div>
    );
  }

  if (!user) return null;

  const age = differenceInYears(new Date(), parseISO(user.birth_date));

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3">
        <Link
          href="/users"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <ChevronLeft size={16} />
          利用者一覧
        </Link>
      </div>

      {/* User header */}
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-100">
              <User size={28} className="text-blue-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">{user.name}</h1>
              <p className="text-sm text-gray-500">{user.name_kana}</p>
              <div className="mt-1 flex items-center gap-2 text-sm text-gray-600">
                <span>{user.gender}</span>
                <span>·</span>
                <span>{age}歳</span>
                <span>·</span>
                <span>
                  {format(parseISO(user.birth_date), "yyyy年M月d日")} 生
                </span>
              </div>
            </div>
          </div>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              user.status === "active"
                ? "bg-green-100 text-green-800"
                : user.status === "deceased"
                  ? "bg-red-100 text-red-700"
                  : "bg-gray-100 text-gray-600"
            }`}
          >
            {STATUS_LABELS[user.status] ?? user.status}
          </span>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="border-b bg-white rounded-t-lg shadow-sm overflow-x-auto">
        <nav className="flex min-w-max">
          {TABS.map((tab) => {
            const isActive = tab.href === activeTabHref;
            return (
              <Link
                key={tab.href}
                href={baseHref + tab.href}
                className={`px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  isActive
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Basic info tab content (only rendered when on this route) */}
      {pathname === baseHref && (
        <div className="rounded-b-lg border border-t-0 bg-white p-6 shadow-sm space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-800">基本情報</h2>
            {!editing ? (
              <button
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <Pencil size={14} />
                編集
              </button>
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setEditing(false);
                    fetchUser();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  <X size={14} />
                  キャンセル
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  <Save size={14} />
                  {saving ? "保存中..." : "保存"}
                </button>
              </div>
            )}
          </div>

          {!editing ? (
            <div className="grid grid-cols-1 gap-0 sm:grid-cols-2">
              <div className="sm:pr-6">
                <InfoRow label="氏名" value={user.name} />
                <InfoRow label="氏名（かな）" value={user.name_kana} />
                <InfoRow label="性別" value={user.gender} />
                <InfoRow
                  label="生年月日"
                  value={
                    user.birth_date
                      ? format(parseISO(user.birth_date), "yyyy年M月d日")
                      : null
                  }
                />
                <InfoRow
                  label="血液型"
                  value={user.blood_type ? `${user.blood_type}型` : null}
                />
                <InfoRow
                  label="ステータス"
                  value={STATUS_LABELS[user.status] ?? user.status}
                />
                <InfoRow
                  label="入所日"
                  value={
                    user.admission_date
                      ? format(parseISO(user.admission_date), "yyyy年M月d日")
                      : null
                  }
                />
              </div>
              <div className="sm:pl-6 sm:border-l">
                <InfoRow label="郵便番号" value={user.postal_code} />
                <InfoRow label="住所" value={user.address} />
                <InfoRow label="電話番号" value={user.phone} />
                <InfoRow label="携帯電話" value={user.mobile_phone} />
                <InfoRow label="メール" value={user.email} />
                <InfoRow
                  label="緊急連絡先氏名"
                  value={user.emergency_contact_name}
                />
                <InfoRow
                  label="緊急連絡先電話"
                  value={user.emergency_contact_phone}
                />
              </div>
              {user.notes && (
                <div className="sm:col-span-2 mt-4 pt-4 border-t">
                  <p className="text-sm text-gray-500 mb-1">備考</p>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">
                    {user.notes}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    氏名 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, name: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    氏名（かな） <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.name_kana}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, name_kana: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    性別
                  </label>
                  <select
                    value={form.gender}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, gender: e.target.value }))
                    }
                    className={inputClass}
                  >
                    <option value="女">女</option>
                    <option value="男">男</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    生年月日
                  </label>
                  <input
                    type="date"
                    value={form.birth_date}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, birth_date: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    血液型
                  </label>
                  <select
                    value={form.blood_type}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, blood_type: e.target.value }))
                    }
                    className={inputClass}
                  >
                    <option value="">不明</option>
                    <option value="A">A型</option>
                    <option value="B">B型</option>
                    <option value="O">O型</option>
                    <option value="AB">AB型</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    ステータス
                  </label>
                  <select
                    value={form.status}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, status: e.target.value }))
                    }
                    className={inputClass}
                  >
                    <option value="active">在籍中</option>
                    <option value="inactive">退所</option>
                    <option value="deceased">死亡</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    入所日
                  </label>
                  <input
                    type="date"
                    value={form.admission_date}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, admission_date: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    郵便番号
                  </label>
                  <input
                    type="text"
                    value={form.postal_code}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, postal_code: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    住所
                  </label>
                  <input
                    type="text"
                    value={form.address}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, address: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    電話番号
                  </label>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, phone: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    携帯電話
                  </label>
                  <input
                    type="tel"
                    value={form.mobile_phone}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, mobile_phone: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    メールアドレス
                  </label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, email: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    緊急連絡先氏名
                  </label>
                  <input
                    type="text"
                    value={form.emergency_contact_name}
                    onChange={(e) =>
                      setForm((p) => ({
                        ...p,
                        emergency_contact_name: e.target.value,
                      }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    緊急連絡先電話番号
                  </label>
                  <input
                    type="tel"
                    value={form.emergency_contact_phone}
                    onChange={(e) =>
                      setForm((p) => ({
                        ...p,
                        emergency_contact_phone: e.target.value,
                      }))
                    }
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    備考
                  </label>
                  <textarea
                    value={form.notes}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, notes: e.target.value }))
                    }
                    rows={3}
                    className="w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
