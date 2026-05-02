"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { parseISO, format } from "date-fns";
import {
  Pencil,
  Save,
  X,
} from "lucide-react";
import type { Client } from "@/types/database";
import { useBusinessType } from "@/lib/business-type-context";

const STATUS_LABELS: Record<string, string> = {
  active: "在籍中",
  inactive: "退所",
  deceased: "死亡",
};

const inputClass =
  "w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

// EditForm は UI 入力用の中間型。DB カラム名（共通 clients）にマッピングして保存。
//   name_kana    → clients.furigana
//   mobile_phone → clients.mobile
//   notes        → client_memos.body (scope='tenant')
// Phase 2-3-1 スコープ外: care_manager_staff_id（ケアマネ統合は別フェーズで再設計）
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

// ─── 利用中の自事業所サービス ─────────────────────────────────────────────

/** 訪問介護のサービス種別 */
const HOME_CARE_CATEGORIES = [
  "介護",
  "総合事業",
  "居宅介護",
  "重度訪問介護",
  "同行援護",
  "移動支援",
  "自費",
] as const;
type HomeCareCategoryName = (typeof HOME_CARE_CATEGORIES)[number];

type HomeCareCategory = {
  category: HomeCareCategoryName;
  active: boolean;
  start_date: string | null;
  end_date: string | null;
};

type OfficeServiceRow = {
  id: string;
  office_id: string;
  start_date: string | null;
  end_date: string | null;
  service_notes: string | null;
  home_care_categories: HomeCareCategory[];
};

// 共通マスタ offices.service_type は日本語値のみ（'訪問介護'|'訪問入浴'|'訪問看護'|'居宅介護支援'|'福祉用具'）
// 訪問介護系は home_care_categories の細分化対象
const isHomeCareType = (bt: string | null | undefined) => bt === "訪問介護";

/** DBから取得した値を7カテゴリ全てが揃った配列に正規化 */
function normalizeCategories(raw: unknown): HomeCareCategory[] {
  const list = Array.isArray(raw) ? (raw as Partial<HomeCareCategory>[]) : [];
  return HOME_CARE_CATEGORIES.map((name) => {
    const found = list.find((c) => c?.category === name);
    return {
      category: name,
      active: !!found?.active,
      start_date: found?.start_date ?? null,
      end_date: found?.end_date ?? null,
    };
  });
}

function UserOfficeServices({ userId, tenantId }: { userId: string; tenantId: string | null }) {
  const supabase = createClient();
  const [offices, setOffices] = useState<{ id: string; name: string; service_type: string }[]>([]);
  const [services, setServices] = useState<OfficeServiceRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    // 共通マスタの offices（kaigo-app 用）と client_office_assignments を並行取得
    const [{ data: offs }, { data: svcs }] = await Promise.all([
      supabase
        .from("offices")
        .select("id, name, service_type")
        .eq("app_type", "kaigo-app")
        .order("name"),
      supabase
        .from("client_office_assignments")
        .select("*")
        .eq("client_id", userId),
    ]);
    setOffices(offs || []);
    const normalized = (svcs || []).map((s: Record<string, unknown>) => ({
      ...s,
      home_care_categories: normalizeCategories(s.home_care_categories),
    })) as OfficeServiceRow[];
    setServices(normalized);
    setLoading(false);
  };

  useEffect(() => { load(); }, [userId]);  // eslint-disable-line react-hooks/exhaustive-deps

  const toggleOffice = async (officeId: string, currentlyUsing: boolean) => {
    const existing = services.find((s) => s.office_id === officeId);
    if (currentlyUsing && existing) {
      // 利用終了: end_date を埋める（client_office_assignments に is_active カラムは無い）
      const { error } = await supabase.from("client_office_assignments").update({
        end_date: existing.end_date ?? format(new Date(), "yyyy-MM-dd"),
      }).eq("id", existing.id);
      if (error) toast.error("更新に失敗: " + error.message);
      else { toast.success("サービス終了を登録しました"); load(); }
    } else if (existing) {
      // 再開: end_date を NULL に戻す
      const { error } = await supabase.from("client_office_assignments").update({
        end_date: null,
      }).eq("id", existing.id);
      if (error) toast.error("更新に失敗: " + error.message);
      else { toast.success("サービス再開を登録しました"); load(); }
    } else {
      // 新規（tenant_id は client_office_assignments の旧カラム互換のため埋める）
      if (!tenantId) {
        toast.error("自事業所が選択されていません");
        return;
      }
      const { error } = await supabase.from("client_office_assignments").insert({
        tenant_id: tenantId,
        client_id: userId,
        office_id: officeId,
        start_date: format(new Date(), "yyyy-MM-dd"),
      });
      if (error) toast.error("登録に失敗: " + error.message);
      else { toast.success("サービスを開始しました"); load(); }
    }
  };

  const updateDate = async (id: string, field: "start_date" | "end_date", value: string) => {
    const { error } = await supabase.from("client_office_assignments").update({ [field]: value || null }).eq("id", id);
    if (error) toast.error("更新に失敗: " + error.message);
    else { toast.success("保存しました"); load(); }
  };

  /** 訪問介護のサービス種別を更新 */
  const updateCategory = async (
    serviceId: string,
    categoryName: HomeCareCategoryName,
    patch: Partial<Omit<HomeCareCategory, "category">>,
  ) => {
    const svc = services.find((s) => s.id === serviceId);
    if (!svc) return;
    const next = svc.home_care_categories.map((c) =>
      c.category === categoryName ? { ...c, ...patch } : c,
    );
    // 楽観更新（即時反映）
    setServices((prev) =>
      prev.map((s) => (s.id === serviceId ? { ...s, home_care_categories: next } : s)),
    );
    const { error } = await supabase
      .from("client_office_assignments")
      .update({ home_care_categories: next })
      .eq("id", serviceId);
    if (error) {
      toast.error("更新に失敗: " + error.message);
      load(); // 失敗時は再読み込みで戻す
    }
  };

  if (loading) return <div className="py-2 text-xs text-gray-400">読み込み中...</div>;

  return (
    <div>
      <h3 className="text-sm font-bold text-gray-700 mb-2">利用中の自事業所サービス</h3>
      <p className="text-xs text-gray-500 mb-3">この利用者に自事業所のサービスを提供中/提供予定の場合にチェックしてください。</p>
      {offices.length === 0 ? (
        <p className="text-xs text-gray-400">自事業所が登録されていません（設定から追加してください）</p>
      ) : (
        <div className="space-y-2">
          {offices.map((o) => {
            const svc = services.find((s) => s.office_id === o.id);
            // 「現役」判定: client_office_assignments に is_active は無いので end_date IS NULL で判定
            const using = !!svc && svc.end_date === null;
            return (
              <div key={o.id} className={`rounded-lg border p-3 ${using ? "border-blue-300 bg-blue-50/30" : "border-gray-200"}`}>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={using}
                    onChange={() => toggleOffice(o.id, using)}
                    className="w-4 h-4 accent-blue-600 cursor-pointer"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-semibold text-gray-900">{o.name || "(名称未設定)"}</div>
                    <div className="text-xs text-gray-500">{o.service_type}</div>
                  </div>
                </div>
                {svc && (
                  <div className="flex items-center gap-2 mt-2 text-xs">
                    <label className="flex items-center gap-1">
                      <span className="text-gray-500">開始日:</span>
                      <input type="date" value={svc.start_date ?? ""} onChange={(e) => updateDate(svc.id, "start_date", e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-xs" />
                    </label>
                    <label className="flex items-center gap-1">
                      <span className="text-gray-500">終了日:</span>
                      <input type="date" value={svc.end_date ?? ""} onChange={(e) => updateDate(svc.id, "end_date", e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-xs" />
                    </label>
                  </div>
                )}
                {svc && using && isHomeCareType(o.service_type) && (
                  <div className="mt-3 rounded-md border border-blue-200 bg-white p-3">
                    <div className="text-xs font-semibold text-gray-700 mb-2">提供サービス種別</div>
                    <div className="space-y-1">
                      {svc.home_care_categories.map((c) => (
                        <div key={c.category} className="flex items-center gap-2 text-xs">
                          <label className="flex items-center gap-2 w-32 shrink-0 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={c.active}
                              onChange={(e) =>
                                updateCategory(svc.id, c.category, {
                                  active: e.target.checked,
                                  // チェックON: 未入力なら親事業所の開始日（無ければ今日）をデフォルトに
                                  // チェックOFF: 開始日・終了日をクリア
                                  start_date: e.target.checked
                                    ? (c.start_date ??
                                       svc.start_date ??
                                       format(new Date(), "yyyy-MM-dd"))
                                    : null,
                                  end_date: e.target.checked ? c.end_date : null,
                                })
                              }
                              className="w-3.5 h-3.5 accent-blue-600"
                            />
                            <span className="text-gray-700">{c.category}</span>
                          </label>
                          <label className="flex items-center gap-1">
                            <span className="text-gray-500">開始日:</span>
                            <input
                              type="date"
                              value={c.start_date ?? ""}
                              disabled={!c.active}
                              onChange={(e) =>
                                updateCategory(svc.id, c.category, {
                                  start_date: e.target.value || null,
                                })
                              }
                              className="rounded border border-gray-300 px-2 py-0.5 text-xs disabled:bg-gray-50 disabled:text-gray-400"
                            />
                          </label>
                          <label className="flex items-center gap-1">
                            <span className="text-gray-500">終了日:</span>
                            <input
                              type="date"
                              value={c.end_date ?? ""}
                              disabled={!c.active}
                              onChange={(e) =>
                                updateCategory(svc.id, c.category, {
                                  end_date: e.target.value || null,
                                })
                              }
                              className="rounded border border-gray-300 px-2 py-0.5 text-xs disabled:bg-gray-50 disabled:text-gray-400"
                            />
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const { currentOffice } = useBusinessType();

  const [user, setUser] = useState<Client | null>(null);
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

  // 自事業所スコープのメモ（client_memos の最新 1 件）。
  // 編集時にも参照するため id を保持しておく。
  const [tenantMemoId, setTenantMemoId] = useState<string | null>(null);

  const fetchUser = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("clients")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      setUser(data);

      // 自事業所スコープのメモを別途取得（最新 1 件）
      let memoBody = "";
      let memoId: string | null = null;
      if (currentOffice?.tenant_id) {
        const { data: memo } = await supabase
          .from("client_memos")
          .select("id, body")
          .eq("client_id", id)
          .eq("scope", "tenant")
          .eq("tenant_id", currentOffice.tenant_id)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (memo) {
          memoId = memo.id as string;
          memoBody = (memo.body as string) ?? "";
        }
      }
      setTenantMemoId(memoId);

      setForm({
        name: data.name ?? "",
        name_kana: data.furigana ?? "",
        gender: data.gender ?? "女",
        birth_date: data.birth_date ?? "",
        blood_type: data.blood_type ?? "",
        postal_code: data.postal_code ?? "",
        address: data.address ?? "",
        phone: data.phone ?? "",
        mobile_phone: data.mobile ?? "",
        email: data.email ?? "",
        emergency_contact_name: data.emergency_contact_name ?? "",
        emergency_contact_phone: data.emergency_contact_phone ?? "",
        admission_date: data.admission_date ?? "",
        status: data.status ?? "active",
        notes: memoBody,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "取得に失敗しました";
      toast.error(message);
      router.push("/users");
    } finally {
      setLoading(false);
    }
  }, [supabase, id, router, currentOffice?.tenant_id]);

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
      // clients への UPDATE（共通カラム名: furigana, mobile）
      // updated_at はトリガで自動更新されるので手動指定不要
      const { error } = await supabase
        .from("clients")
        .update({
          name: form.name.trim(),
          furigana: form.name_kana.trim(),
          gender: form.gender,
          birth_date: form.birth_date || null,
          blood_type: form.blood_type || null,
          postal_code: form.postal_code || null,
          address: form.address || null,
          phone: form.phone || null,
          mobile: form.mobile_phone || null,
          email: form.email || null,
          emergency_contact_name: form.emergency_contact_name || null,
          emergency_contact_phone: form.emergency_contact_phone || null,
          admission_date: form.admission_date || null,
          status: form.status,
        })
        .eq("id", id);
      if (error) throw error;

      // 備考の保存（client_memos の scope='tenant'、自事業所スコープ）
      if (currentOffice?.tenant_id) {
        const trimmedNotes = form.notes.trim();
        if (tenantMemoId) {
          // 既存メモを UPDATE（空なら DELETE）
          if (trimmedNotes === "") {
            await supabase.from("client_memos").delete().eq("id", tenantMemoId);
          } else {
            await supabase
              .from("client_memos")
              .update({ body: trimmedNotes })
              .eq("id", tenantMemoId);
          }
        } else if (trimmedNotes !== "") {
          // 新規メモを INSERT
          await supabase.from("client_memos").insert({
            client_id: id,
            scope: "tenant",
            tenant_id: currentOffice.tenant_id,
            body: trimmedNotes,
          });
        }
      }

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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        読み込み中...
      </div>
    );
  }

  if (!user) return null;

  return (
    <>
      {/* Basic info form（layout.tsx がヘッダー・タブを描画） */}
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
                <InfoRow label="氏名（かな）" value={user.furigana} />
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
                <InfoRow label="携帯電話" value={user.mobile} />
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
              {form.notes && (
                <div className="sm:col-span-2 mt-4 pt-4 border-t">
                  <p className="text-sm text-gray-500 mb-1">備考（自事業所スコープ）</p>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">
                    {form.notes}
                  </p>
                </div>
              )}
              {/* 利用中の自事業所サービス */}
              <div className="sm:col-span-2 mt-4 pt-4 border-t">
                <UserOfficeServices userId={id} tenantId={currentOffice?.tenant_id ?? null} />
              </div>
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
                {/* 担当ケアマネ UI は Phase 2-3-1 スコープ外（care_managers 統合と一緒に再設計予定） */}
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    備考（自事業所スコープ）
                  </label>
                  <textarea
                    value={form.notes}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, notes: e.target.value }))
                    }
                    rows={3}
                    className="w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
                    placeholder="自事業所スタッフのみ閲覧可能なメモ"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
