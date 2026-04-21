"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  Building2,
  Plus,
  Save,
  Trash2,
  Loader2,
  LogIn,
  LogOut,
  X,
} from "lucide-react";
import { format, parseISO, differenceInDays } from "date-fns";
import { ja } from "date-fns/locale";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Hospitalization {
  id: string;
  user_id: string;
  hospital_name: string;
  department: string | null;
  admission_date: string;
  discharge_date: string | null;
  reason: string | null;
  discharge_destination: string | null;
  notes: string | null;
  status: "admitted" | "discharged";
  created_at: string;
}

interface UserInfo {
  id: string;
  name: string;
  name_kana: string | null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function HospitalizationsPage() {
  const supabase = createClient();

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<UserInfo | null>(null);
  const [records, setRecords] = useState<Hospitalization[]>([]);
  const [loading, setLoading] = useState(false);

  // Form
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAllAdmitted, setShowAllAdmitted] = useState(false);
  const [allAdmitted, setAllAdmitted] = useState<(Hospitalization & { user_name: string })[]>([]);
  const [loadingAllAdmitted, setLoadingAllAdmitted] = useState(false);
  const [form, setForm] = useState({
    hospital_name: "",
    department: "",
    admission_date: format(new Date(), "yyyy-MM-dd"),
    discharge_date: "",
    reason: "",
    discharge_destination: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);

  // ── Fetch user ──
  useEffect(() => {
    if (!selectedUserId) {
      setSelectedUser(null);
      setRecords([]);
      return;
    }
    supabase
      .from("kaigo_users")
      .select("id, name, name_kana")
      .eq("id", selectedUserId)
      .single()
      .then(({ data }: { data: UserInfo | null }) => setSelectedUser(data));
  }, [selectedUserId, supabase]);

  // ── Fetch records ──
  const fetchRecords = useCallback(async () => {
    if (!selectedUserId) {
      setRecords([]);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from("kaigo_hospitalizations")
      .select("*")
      .eq("user_id", selectedUserId)
      .order("admission_date", { ascending: false });
    if (error) {
      toast.error("入退院情報の取得に失敗しました: " + error.message);
    } else {
      setRecords((data as Hospitalization[]) ?? []);
    }
    setLoading(false);
  }, [supabase, selectedUserId]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  // ── Fetch all admitted ──
  const fetchAllAdmitted = async () => {
    setLoadingAllAdmitted(true);
    const { data } = await supabase
      .from("kaigo_hospitalizations")
      .select("*, kaigo_users(name)")
      .eq("status", "admitted")
      .order("admission_date", { ascending: true });
    const rows = (data ?? []).map((r: any) => ({  // eslint-disable-line @typescript-eslint/no-explicit-any
      ...r,
      user_name: r.kaigo_users?.name ?? "—",
    })) as (Hospitalization & { user_name: string })[];
    setAllAdmitted(rows);
    setLoadingAllAdmitted(false);
    setShowAllAdmitted(true);
  };

  // ── Open form ──
  const openNew = () => {
    setEditingId(null);
    setForm({
      hospital_name: "",
      department: "",
      admission_date: format(new Date(), "yyyy-MM-dd"),
      discharge_date: "",
      reason: "",
      discharge_destination: "",
      notes: "",
    });
    setShowForm(true);
  };

  const openEdit = (rec: Hospitalization) => {
    setEditingId(rec.id);
    setForm({
      hospital_name: rec.hospital_name,
      department: rec.department ?? "",
      admission_date: rec.admission_date,
      discharge_date: rec.discharge_date ?? "",
      reason: rec.reason ?? "",
      discharge_destination: rec.discharge_destination ?? "",
      notes: rec.notes ?? "",
    });
    setShowForm(true);
  };

  // ── Save ──
  const handleSave = async () => {
    if (!selectedUserId) return;
    if (!form.admission_date) {
      toast.error("入院日は必須です");
      return;
    }

    setSaving(true);
    try {
      const status = form.discharge_date ? "discharged" : "admitted";
      const payload = {
        user_id: selectedUserId,
        hospital_name: form.hospital_name.trim() || "（未入力）",
        department: form.department.trim() || null,
        admission_date: form.admission_date,
        discharge_date: form.discharge_date || null,
        reason: form.reason.trim() || null,
        discharge_destination: form.discharge_destination.trim() || null,
        notes: form.notes.trim() || null,
        status,
      };

      if (editingId) {
        const { error } = await supabase
          .from("kaigo_hospitalizations")
          .update(payload)
          .eq("id", editingId);
        if (error) throw error;
        toast.success("更新しました");
      } else {
        const { error } = await supabase
          .from("kaigo_hospitalizations")
          .insert(payload);
        if (error) throw error;

        // ── 支援経過に自動追加 ──
        const userName = selectedUser?.name ?? "";

        // 該当日のケアプランを検索
        const findPlanId = async (dateStr: string) => {
          const { data: plans } = await supabase
            .from("kaigo_care_plans")
            .select("id, start_date, end_date")
            .eq("user_id", selectedUserId!)
            .lte("start_date", dateStr)
            .order("start_date", { ascending: false });
          const p = (plans || []).find((x: { id: string; start_date: string; end_date: string | null }) =>
            !x.end_date || x.end_date >= dateStr
          );
          return p?.id ?? null;
        };

        // 入院の記録
        const admissionPlanId = await findPlanId(form.admission_date);
        await supabase.from("kaigo_support_records").insert({
          user_id: selectedUserId,
          record_date: form.admission_date,
          record_time: null,
          category: "その他",
          content: `【入院】${userName} 様が ${form.hospital_name}${form.department ? "（" + form.department + "）" : ""} に入院。${form.reason ? "理由: " + form.reason : ""}`.trim(),
          staff_name: null,
          care_plan_id: admissionPlanId,
        });

        // 退院の記録（退院日があれば）
        if (form.discharge_date) {
          const dischargePlanId = await findPlanId(form.discharge_date);
          await supabase.from("kaigo_support_records").insert({
            user_id: selectedUserId,
            record_date: form.discharge_date,
            record_time: null,
            category: "その他",
            content: `【退院】${userName} 様が ${form.hospital_name} を退院。${form.discharge_destination ? "退院先: " + form.discharge_destination : ""}`.trim(),
            staff_name: null,
            care_plan_id: dischargePlanId,
          });
        }

        toast.success("入院情報を登録し、支援経過に自動追加しました");
      }

      setShowForm(false);
      fetchRecords();
    } catch (err: unknown) {
      toast.error(
        "保存に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  // ── 退院登録（既存の入院中レコードに退院日を追加） ──
  const handleDischarge = async (rec: Hospitalization) => {
    const dischargeDate = prompt(
      "退院日を入力してください（YYYY-MM-DD）",
      format(new Date(), "yyyy-MM-dd")
    );
    if (!dischargeDate) return;

    const dest = prompt("退院先を入力してください（自宅/施設/転院 等）", "自宅");

    try {
      const { error } = await supabase
        .from("kaigo_hospitalizations")
        .update({
          discharge_date: dischargeDate,
          discharge_destination: dest || null,
          status: "discharged",
        })
        .eq("id", rec.id);
      if (error) throw error;

      // 該当利用者の退院日を含むケアプランを検索（care_plan_idを紐付けて支援経過画面で見えるように）
      const { data: userName2 } = await supabase.from("kaigo_users").select("name").eq("id", rec.user_id).single();
      const userName = userName2?.name ?? selectedUser?.name ?? "";
      const { data: plans } = await supabase
        .from("kaigo_care_plans")
        .select("id, start_date, end_date")
        .eq("user_id", rec.user_id)
        .lte("start_date", dischargeDate)
        .order("start_date", { ascending: false });
      const activePlan = (plans || []).find((p: { id: string; start_date: string; end_date: string | null }) =>
        !p.end_date || p.end_date >= dischargeDate
      );

      // 支援経過に退院記録を追加
      await supabase.from("kaigo_support_records").insert({
        user_id: rec.user_id,
        record_date: dischargeDate,
        record_time: null,
        category: "その他",
        content: `【退院】${userName} 様が ${rec.hospital_name} を退院。${dest ? "退院先: " + dest : ""}`.trim(),
        staff_name: null,
        care_plan_id: activePlan?.id ?? null,
      });

      toast.success("退院を登録し、支援経過に自動追加しました");
      fetchRecords();
    } catch (err: unknown) {
      toast.error(
        "退院登録に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  };

  // ── Delete ──
  const handleDelete = async (id: string) => {
    if (!confirm("この入退院記録を削除しますか？\n（登録時に自動作成された支援経過も併せて削除されます）")) return;

    // ① 削除対象の入退院情報を先に取得（自動生成された支援経過を特定するため）
    const { data: target, error: fetchErr } = await supabase
      .from("kaigo_hospitalizations")
      .select("user_id, hospital_name, admission_date, discharge_date")
      .eq("id", id)
      .single<{
        user_id: string;
        hospital_name: string;
        admission_date: string;
        discharge_date: string | null;
      }>();
    if (fetchErr || !target) {
      toast.error("削除対象の取得に失敗しました: " + (fetchErr?.message ?? "not found"));
      return;
    }

    // ② 自動生成された支援経過を削除
    //    識別条件: user_id + record_date(入院日 or 退院日) + 病院名を含む
    //              + content が 【入院】 または 【退院】 で始まる
    let supportDeleted = 0;
    const dates = [target.admission_date, target.discharge_date].filter(
      (d): d is string => !!d,
    );
    if (dates.length > 0) {
      const { data: candidates } = await supabase
        .from("kaigo_support_records")
        .select("id, content, record_date")
        .eq("user_id", target.user_id)
        .in("record_date", dates);
      const matchIds = (candidates ?? [])
        .filter((r: { id: string; content: string | null }) => {
          const c = r.content ?? "";
          return (
            (c.startsWith("【入院】") || c.startsWith("【退院】")) &&
            c.includes(target.hospital_name)
          );
        })
        .map((r: { id: string }) => r.id);
      if (matchIds.length > 0) {
        const { error: delErr } = await supabase
          .from("kaigo_support_records")
          .delete()
          .in("id", matchIds);
        if (delErr) {
          toast.error("支援経過の削除に失敗しました: " + delErr.message);
          return;
        }
        supportDeleted = matchIds.length;
      }
    }

    // ③ 入退院レコードを削除
    const { error } = await supabase
      .from("kaigo_hospitalizations")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error("削除に失敗しました: " + error.message);
      return;
    }

    toast.success(
      supportDeleted > 0
        ? `削除しました（支援経過 ${supportDeleted} 件も併せて削除）`
        : "削除しました",
    );
    fetchRecords();
  };

  // ── Helpers ──
  const fmtDate = (d: string | null) => {
    if (!d) return "—";
    try {
      return format(parseISO(d), "yyyy年M月d日", { locale: ja });
    } catch {
      return d;
    }
  };

  const currentlyAdmitted = records.filter((r) => r.status === "admitted");
  const pastRecords = records.filter((r) => r.status === "discharged");

  const inp =
    "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full -m-6">
      <UserSidebar selectedUserId={selectedUserId} onSelectUser={setSelectedUserId} />

      <div className="flex-1 overflow-y-auto p-6">
        <div className="space-y-5">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Building2 className="text-blue-600" size={24} />
              <h1 className="text-xl font-bold text-gray-900">入退院管理</h1>
              {selectedUser && (
                <span className="text-gray-500 text-sm">— {selectedUser.name} 様</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={fetchAllAdmitted}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors"
              >
                <LogIn size={14} />
                入院中一覧
              </button>
              {selectedUserId && (
                <button
                  onClick={openNew}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
                >
                  <Plus size={16} />
                  入院登録
                </button>
              )}
            </div>
          </div>

          {!selectedUserId ? (
            <div className="rounded-lg border bg-white py-16 text-center text-sm text-gray-500">
              <Building2 size={40} className="mx-auto mb-3 text-gray-300" />
              左の利用者一覧から利用者を選択してください
            </div>
          ) : loading ? (
            <div className="flex justify-center py-16">
              <Loader2 size={24} className="animate-spin text-blue-500" />
            </div>
          ) : (
            <>
              {/* 現在入院中 */}
              {currentlyAdmitted.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold text-red-700 mb-2 flex items-center gap-1">
                    <LogIn size={14} />
                    現在入院中
                  </h2>
                  <div className="space-y-2">
                    {currentlyAdmitted.map((rec) => {
                      const days = differenceInDays(new Date(), parseISO(rec.admission_date));
                      return (
                        <div
                          key={rec.id}
                          className="rounded-lg border-2 border-red-200 bg-red-50 p-4 shadow-sm"
                        >
                          <div className="flex items-start justify-between">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-medium text-white">
                                  入院中
                                </span>
                                <span className="text-sm text-red-700">
                                  {days}日目
                                </span>
                              </div>
                              <div className="mt-2 text-base font-bold text-gray-900">
                                {rec.hospital_name}
                                {rec.department && (
                                  <span className="ml-2 text-sm font-normal text-gray-600">
                                    {rec.department}
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 text-sm text-gray-600">
                                入院日: {fmtDate(rec.admission_date)}
                              </div>
                              {rec.reason && (
                                <div className="mt-1 text-sm text-gray-600">
                                  理由: {rec.reason}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleDischarge(rec)}
                                className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                              >
                                <LogOut size={12} />
                                退院登録
                              </button>
                              <button
                                onClick={() => openEdit(rec)}
                                className="rounded p-1.5 text-gray-500 hover:bg-white hover:text-blue-600"
                                title="編集"
                              >
                                <Save size={14} />
                              </button>
                              <button
                                onClick={() => handleDelete(rec.id)}
                                className="rounded p-1.5 text-gray-500 hover:bg-white hover:text-red-600"
                                title="削除"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 入退院履歴 */}
              <div>
                <h2 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1">
                  <LogOut size={14} />
                  入退院履歴
                </h2>
                {pastRecords.length === 0 && currentlyAdmitted.length === 0 ? (
                  <div className="rounded-lg border bg-white py-12 text-center text-sm text-gray-500">
                    入退院の記録がありません
                    <div className="mt-2">
                      <button
                        onClick={openNew}
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                      >
                        <Plus size={12} />
                        入院登録
                      </button>
                    </div>
                  </div>
                ) : pastRecords.length === 0 ? (
                  <div className="rounded-lg border bg-white py-6 text-center text-xs text-gray-400">
                    退院済みの記録はありません
                  </div>
                ) : (
                  <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b">
                        <tr>
                          <th className="px-4 py-2.5 text-left font-semibold text-gray-600">病院名</th>
                          <th className="px-4 py-2.5 text-left font-semibold text-gray-600">診療科</th>
                          <th className="px-4 py-2.5 text-left font-semibold text-gray-600">入院日</th>
                          <th className="px-4 py-2.5 text-left font-semibold text-gray-600">退院日</th>
                          <th className="px-4 py-2.5 text-left font-semibold text-gray-600">入院日数</th>
                          <th className="px-4 py-2.5 text-left font-semibold text-gray-600">退院先</th>
                          <th className="px-4 py-2.5 text-left font-semibold text-gray-600">理由</th>
                          <th className="px-4 py-2.5" />
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {pastRecords.map((rec) => {
                          const days =
                            rec.discharge_date
                              ? differenceInDays(
                                  parseISO(rec.discharge_date),
                                  parseISO(rec.admission_date)
                                )
                              : null;
                          return (
                            <tr key={rec.id} className="hover:bg-gray-50">
                              <td className="px-4 py-2.5 font-medium">{rec.hospital_name}</td>
                              <td className="px-4 py-2.5 text-gray-600">{rec.department ?? "—"}</td>
                              <td className="px-4 py-2.5 text-gray-700">{fmtDate(rec.admission_date)}</td>
                              <td className="px-4 py-2.5 text-gray-700">{fmtDate(rec.discharge_date)}</td>
                              <td className="px-4 py-2.5 text-gray-600">{days !== null ? `${days}日` : "—"}</td>
                              <td className="px-4 py-2.5 text-gray-600">{rec.discharge_destination ?? "—"}</td>
                              <td className="px-4 py-2.5 text-gray-600 max-w-xs truncate">{rec.reason ?? "—"}</td>
                              <td className="px-4 py-2.5 text-right">
                                <div className="inline-flex gap-1">
                                  <button
                                    onClick={() => openEdit(rec)}
                                    className="rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-600"
                                  >
                                    <Save size={13} />
                                  </button>
                                  <button
                                    onClick={() => handleDelete(rec.id)}
                                    className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── 入院登録/編集 モーダル ── */}
      {showForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowForm(false)}
        >
          <div
            className="w-full max-w-lg rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h2 className="text-sm font-semibold text-gray-900">
                {editingId ? "入退院情報を編集" : "入院登録"}
              </h2>
              <button
                onClick={() => setShowForm(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  病院名
                </label>
                <input
                  type="text"
                  value={form.hospital_name}
                  onChange={(e) => setForm({ ...form, hospital_name: e.target.value })}
                  className={inp}
                  placeholder="〇〇総合病院"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  診療科・病棟
                </label>
                <input
                  type="text"
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                  className={inp}
                  placeholder="整形外科、3階東病棟 等"
                />
              </div>
              <div className={editingId ? "grid grid-cols-2 gap-3" : ""}>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    入院日 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={form.admission_date}
                    onChange={(e) => setForm({ ...form, admission_date: e.target.value })}
                    className={inp}
                  />
                </div>
                {/* 退院日は編集時のみ表示（新規登録時は退院登録ボタンで対応） */}
                {editingId && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      退院日
                    </label>
                    <input
                      type="date"
                      value={form.discharge_date}
                      onChange={(e) => setForm({ ...form, discharge_date: e.target.value })}
                      className={inp}
                    />
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  入院理由
                </label>
                <input
                  type="text"
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  className={inp}
                  placeholder="骨折、手術、検査入院 等"
                />
              </div>
              {editingId && form.discharge_date && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    退院先
                  </label>
                  <input
                    type="text"
                    value={form.discharge_destination}
                    onChange={(e) => setForm({ ...form, discharge_destination: e.target.value })}
                    className={inp}
                    placeholder="自宅 / 施設 / 転院 等"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  備考
                </label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className={inp + " resize-y"}
                  rows={2}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t bg-gray-50 px-5 py-3">
              <button
                onClick={() => setShowForm(false)}
                className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                {editingId ? "更新" : "登録"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 入院中一覧モーダル ── */}
      {showAllAdmitted && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowAllAdmitted(false)}
        >
          <div
            className="w-full max-w-2xl rounded-lg bg-white shadow-xl max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-5 py-3 bg-red-50">
              <h2 className="text-sm font-semibold text-red-700 flex items-center gap-1.5">
                <LogIn size={16} />
                現在入院中の利用者一覧
              </h2>
              <button
                onClick={() => setShowAllAdmitted(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loadingAllAdmitted ? (
                <div className="flex justify-center py-12">
                  <Loader2 size={20} className="animate-spin text-red-500" />
                </div>
              ) : allAdmitted.length === 0 ? (
                <div className="py-12 text-center text-sm text-gray-500">
                  現在入院中の利用者はいません
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b sticky top-0">
                    <tr>
                      <th className="px-4 py-2.5 text-left font-semibold text-gray-600">利用者名</th>
                      <th className="px-4 py-2.5 text-left font-semibold text-gray-600">病院名</th>
                      <th className="px-4 py-2.5 text-left font-semibold text-gray-600">入院日</th>
                      <th className="px-4 py-2.5 text-left font-semibold text-gray-600">入院日数</th>
                      <th className="px-4 py-2.5 text-left font-semibold text-gray-600">理由</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {allAdmitted.map((rec) => {
                      const days = differenceInDays(new Date(), parseISO(rec.admission_date));
                      return (
                        <tr
                          key={rec.id}
                          className="hover:bg-red-50/30 cursor-pointer"
                          onClick={() => {
                            setSelectedUserId(rec.user_id);
                            setShowAllAdmitted(false);
                          }}
                        >
                          <td className="px-4 py-2.5 font-medium">{rec.user_name}</td>
                          <td className="px-4 py-2.5 text-gray-700">{rec.hospital_name}</td>
                          <td className="px-4 py-2.5 text-gray-700">{fmtDate(rec.admission_date)}</td>
                          <td className="px-4 py-2.5">
                            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                              {days}日目
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-gray-600 max-w-xs truncate">{rec.reason ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="border-t bg-gray-50 px-5 py-2 text-xs text-gray-500">
              {allAdmitted.length}名が入院中 — クリックで該当利用者の詳細に移動
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
