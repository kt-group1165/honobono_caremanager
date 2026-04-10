"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  Plus,
  Pencil,
  Trash2,
  X,
  FileText,
  Loader2,
  ChevronDown,
  ChevronUp,
  PlusCircle,
  MinusCircle,
} from "lucide-react";
import { format } from "date-fns";
import { ja } from "date-fns/locale";

type PlanStatus = "draft" | "active" | "completed" | "cancelled";

const PLAN_TYPES = [
  "居宅サービス計画",
  "介護予防サービス計画",
  "施設サービス計画",
  "その他",
];

const SERVICE_FREQUENCIES = [
  "毎日",
  "週1回",
  "週2回",
  "週3回",
  "週4回",
  "週5回",
  "隔週",
  "月1回",
  "月2回",
  "随時",
  "その他",
];

interface KaigoUser {
  id: string;
  name: string;
}

interface CarePlanService {
  id?: string;
  care_plan_id?: string;
  service_type: string;
  service_content: string;
  frequency: string;
  provider: string;
}

interface CarePlan {
  id: string;
  user_id: string;
  plan_number: string;
  plan_type: string;
  start_date: string;
  end_date: string;
  long_term_goals: string;
  short_term_goals: string;
  status: PlanStatus;
  created_at?: string;
  kaigo_users?: { name: string };
  kaigo_care_plan_services?: CarePlanService[];
}

const EMPTY_SERVICE: CarePlanService = {
  service_type: "",
  service_content: "",
  frequency: "",
  provider: "",
};

const EMPTY_FORM = {
  user_id: "",
  plan_number: "",
  plan_type: "",
  start_date: "",
  end_date: "",
  long_term_goals: "",
  short_term_goals: "",
  status: "draft" as PlanStatus,
};

const STATUS_CONFIG: Record<PlanStatus, { label: string; cls: string }> = {
  draft: { label: "下書き", cls: "bg-gray-100 text-gray-600" },
  active: { label: "有効", cls: "bg-green-100 text-green-700" },
  completed: { label: "完了", cls: "bg-blue-100 text-blue-700" },
  cancelled: { label: "取消", cls: "bg-red-100 text-red-600" },
};

export default function CarePlansPage() {
  const supabase = createClient();
  const [plans, setPlans] = useState<CarePlan[]>([]);
  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<CarePlan | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CarePlan | null>(null);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [services, setServices] = useState<CarePlanService[]>([{ ...EMPTY_SERVICE }]);
  const [filterStatus, setFilterStatus] = useState<PlanStatus | "">("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [providersMaster, setProvidersMaster] = useState<{ provider_name: string; service_categories: string[] }[]>([]);

  // 事業所マスタ取得
  useEffect(() => {
    const fetchProviders = async () => {
      const { data } = await supabase.from("kaigo_service_providers").select("provider_name, service_categories").eq("status", "active").order("provider_name");
      setProvidersMaster(data || []);
    };
    fetchProviders();
  }, [supabase]);

  const fetchPlans = useCallback(async () => {
    if (!selectedUserId) {
      setPlans([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let query = supabase
      .from("kaigo_care_plans")
      .select("*, kaigo_users(name), kaigo_care_plan_services(*)")
      .eq("user_id", selectedUserId)
      .order("created_at", { ascending: false });

    if (filterStatus) query = query.eq("status", filterStatus);

    const { data, error } = await query;
    if (error) {
      toast.error("ケアプランの取得に失敗しました");
    } else {
      setPlans(data || []);
    }
    setLoading(false);
  }, [supabase, filterStatus, selectedUserId]);

  const fetchUsers = useCallback(async () => {
    const { data } = await supabase
      .from("kaigo_users")
      .select("id, name")
      .order("name");
    setUsers(data || []);
  }, [supabase]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  const openCreateDialog = () => {
    setEditingPlan(null);
    setForm({ ...EMPTY_FORM, user_id: selectedUserId ?? "" });
    setServices([{ ...EMPTY_SERVICE }]);
    setDialogOpen(true);
  };

  const openEditDialog = (plan: CarePlan) => {
    setEditingPlan(plan);
    setForm({
      user_id: plan.user_id,
      plan_number: plan.plan_number,
      plan_type: plan.plan_type,
      start_date: plan.start_date,
      end_date: plan.end_date,
      long_term_goals: plan.long_term_goals,
      short_term_goals: plan.short_term_goals,
      status: plan.status,
    });
    setServices(
      plan.kaigo_care_plan_services?.length
        ? plan.kaigo_care_plan_services.map((s) => ({
            id: s.id,
            service_type: s.service_type,
            service_content: s.service_content,
            frequency: s.frequency,
            provider: s.provider,
          }))
        : [{ ...EMPTY_SERVICE }]
    );
    setDialogOpen(true);
  };

  // 選択中ユーザーが変わったら展開・編集状態をリセット
  useEffect(() => {
    setExpandedPlan(null);
    setEditingPlan(null);
    setDialogOpen(false);
  }, [selectedUserId]);

  // 選択中ユーザーの名前
  const selectedUserName =
    users.find((u) => u.id === selectedUserId)?.name ?? "";

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      let planId: string;

      if (editingPlan) {
        const { error } = await supabase
          .from("kaigo_care_plans")
          .update(form)
          .eq("id", editingPlan.id);
        if (error) throw error;
        planId = editingPlan.id;

        // Delete existing services and re-insert
        await supabase
          .from("kaigo_care_plan_services")
          .delete()
          .eq("care_plan_id", planId);
        toast.success("ケアプランを更新しました");
      } else {
        const { data, error } = await supabase
          .from("kaigo_care_plans")
          .insert([form])
          .select("id")
          .single();
        if (error) throw error;
        planId = data.id;
        toast.success("ケアプランを登録しました");
      }

      // Insert services
      const validServices = services.filter((s) => s.service_type);
      if (validServices.length > 0) {
        const { error: svcError } = await supabase
          .from("kaigo_care_plan_services")
          .insert(
            validServices.map(({ service_type, service_content, frequency, provider }) => ({
              care_plan_id: planId,
              service_type,
              service_content,
              frequency,
              provider,
            }))
          );
        if (svcError) throw svcError;
      }

      setDialogOpen(false);
      fetchPlans();
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
      await supabase
        .from("kaigo_care_plan_services")
        .delete()
        .eq("care_plan_id", deleteTarget.id);
      const { error } = await supabase
        .from("kaigo_care_plans")
        .delete()
        .eq("id", deleteTarget.id);
      if (error) throw error;
      toast.success("ケアプランを削除しました");
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
      fetchPlans();
    } catch (err: unknown) {
      toast.error(
        "削除に失敗しました: " + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const addService = () => setServices([...services, { ...EMPTY_SERVICE }]);
  const removeService = (idx: number) =>
    setServices(services.filter((_, i) => i !== idx));
  const updateService = (idx: number, field: keyof CarePlanService, value: string) => {
    const updated = [...services];
    updated[idx] = { ...updated[idx], [field]: value };
    setServices(updated);
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "—";
    try {
      return format(new Date(dateStr), "yyyy年M月d日", { locale: ja });
    } catch {
      return dateStr;
    }
  };

  // プレビュー対象: 編集中ならフォーム、そうでなければ展開中プラン
  const previewTarget: {
    user_name: string;
    plan_number: string;
    plan_type: string;
    start_date: string;
    end_date: string;
    long_term_goals: string;
    short_term_goals: string;
    status: PlanStatus;
    services: CarePlanService[];
  } | null = dialogOpen
    ? {
        user_name: selectedUserName,
        plan_number: form.plan_number,
        plan_type: form.plan_type,
        start_date: form.start_date,
        end_date: form.end_date,
        long_term_goals: form.long_term_goals,
        short_term_goals: form.short_term_goals,
        status: form.status,
        services,
      }
    : expandedPlan
      ? (() => {
          const p = plans.find((pl) => pl.id === expandedPlan);
          if (!p) return null;
          return {
            user_name: p.kaigo_users?.name ?? "",
            plan_number: p.plan_number,
            plan_type: p.plan_type,
            start_date: p.start_date,
            end_date: p.end_date,
            long_term_goals: p.long_term_goals,
            short_term_goals: p.short_term_goals,
            status: p.status,
            services: p.kaigo_care_plan_services ?? [],
          };
        })()
      : null;

  return (
    <div className="flex h-full -m-6">
      <UserSidebar selectedUserId={selectedUserId} onSelectUser={setSelectedUserId} />

      {/* 中央: プラン一覧 + フォーム */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-gray-200 overflow-y-auto">
        <div className="border-b bg-white px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="text-blue-600" size={20} />
            <h1 className="text-base font-bold text-gray-900">ケアプラン管理</h1>
            {selectedUserName && (
              <span className="text-sm text-gray-500">
                — {selectedUserName}
              </span>
            )}
            <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
              {plans.length}件
            </span>
          </div>
          <button
            onClick={openCreateDialog}
            disabled={!selectedUserId}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <Plus size={14} />
            新規作成
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Filter */}
          {selectedUserId && (
            <div className="flex items-center gap-2">
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as PlanStatus | "")}
                className="rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">すべてのステータス</option>
                {(Object.entries(STATUS_CONFIG) as [PlanStatus, { label: string }][]).map(
                  ([key, { label }]) => (
                    <option key={key} value={key}>{label}</option>
                  )
                )}
              </select>
              {filterStatus && (
                <button
                  onClick={() => setFilterStatus("")}
                  className="text-xs text-blue-600 hover:underline"
                >
                  リセット
                </button>
              )}
            </div>
          )}

          {!selectedUserId ? (
            <div className="rounded-lg border bg-white py-16 text-center">
              <FileText size={40} className="mx-auto mb-3 text-gray-300" />
              <p className="text-sm text-gray-500">左の一覧から利用者を選択してください</p>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-blue-500" />
            </div>
          ) : plans.length === 0 ? (
            <div className="rounded-lg border bg-white py-10 text-center text-sm text-gray-500">
              {selectedUserName} さんのケアプランはまだありません
              <div className="mt-2">
                <button
                  onClick={openCreateDialog}
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                >
                  <Plus size={12} />
                  新規作成
                </button>
              </div>
            </div>
          ) : (
        <div className="space-y-3">
          {plans.map((plan) => {
            const isExpanded = expandedPlan === plan.id;
            const statusCfg = STATUS_CONFIG[plan.status];
            return (
              <div key={plan.id} className="rounded-lg border bg-white shadow-sm">
                <div className="flex items-center gap-4 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="font-semibold text-gray-900">
                        {plan.kaigo_users?.name || "—"}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusCfg.cls}`}>
                        {statusCfg.label}
                      </span>
                      {plan.plan_number && (
                        <span className="text-xs text-gray-500">#{plan.plan_number}</span>
                      )}
                      <span className="text-xs text-gray-500 bg-gray-100 rounded px-2 py-0.5">
                        {plan.plan_type || "—"}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-4 text-xs text-gray-500">
                      <span>
                        期間: {formatDate(plan.start_date)} 〜 {formatDate(plan.end_date)}
                      </span>
                      {plan.kaigo_care_plan_services && (
                        <span>
                          サービス: {plan.kaigo_care_plan_services.length}件
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => openEditDialog(plan)}
                      className="rounded p-1.5 text-gray-500 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                      title="編集"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => {
                        setDeleteTarget(plan);
                        setDeleteDialogOpen(true);
                      }}
                      className="rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors"
                      title="削除"
                    >
                      <Trash2 size={15} />
                    </button>
                    <button
                      onClick={() =>
                        setExpandedPlan(isExpanded ? null : plan.id)
                      }
                      className="rounded p-1.5 text-gray-500 hover:bg-gray-100 transition-colors"
                    >
                      {isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t px-4 pb-4 pt-3 space-y-4">
                    {plan.long_term_goals && (
                      <div>
                        <div className="text-xs font-medium text-gray-500 mb-1">長期目標</div>
                        <p className="text-sm text-gray-700 whitespace-pre-wrap">{plan.long_term_goals}</p>
                      </div>
                    )}
                    {plan.short_term_goals && (
                      <div>
                        <div className="text-xs font-medium text-gray-500 mb-1">短期目標</div>
                        <p className="text-sm text-gray-700 whitespace-pre-wrap">{plan.short_term_goals}</p>
                      </div>
                    )}
                    {plan.kaigo_care_plan_services && plan.kaigo_care_plan_services.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-gray-500 mb-2">サービス内容</div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border rounded">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="border-b px-3 py-2 text-left font-medium text-gray-600">サービス種別</th>
                                <th className="border-b px-3 py-2 text-left font-medium text-gray-600">内容</th>
                                <th className="border-b px-3 py-2 text-left font-medium text-gray-600">頻度</th>
                                <th className="border-b px-3 py-2 text-left font-medium text-gray-600">提供者</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {plan.kaigo_care_plan_services.map((svc, i) => (
                                <tr key={svc.id || i}>
                                  <td className="px-3 py-2 text-gray-700">{svc.service_type}</td>
                                  <td className="px-3 py-2 text-gray-600">{svc.service_content}</td>
                                  <td className="px-3 py-2 text-gray-600">{svc.frequency}</td>
                                  <td className="px-3 py-2 text-gray-600">{svc.provider}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create/Edit Form (inline) */}
      {dialogOpen && (
        <div className="rounded-lg border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-900">
              {editingPlan ? "ケアプランを編集" : "新規ケアプラン作成"}
            </h2>
            <button
              onClick={() => setDialogOpen(false)}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              title="閉じる"
            >
              <X size={16} />
            </button>
          </div>
          <form onSubmit={handleSave} className="p-5 space-y-5">
              {/* Basic Info */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3 pb-1 border-b">基本情報</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      利用者
                    </label>
                    <div className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                      {selectedUserName || "—"}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      計画番号
                    </label>
                    <input
                      type="text"
                      value={form.plan_number}
                      onChange={(e) => setForm({ ...form, plan_number: e.target.value })}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="例: 2024-001"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      計画種別
                    </label>
                    <select
                      value={form.plan_type}
                      onChange={(e) => setForm({ ...form, plan_type: e.target.value })}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      <option value="">選択してください</option>
                      {PLAN_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      ステータス
                    </label>
                    <select
                      value={form.status}
                      onChange={(e) =>
                        setForm({ ...form, status: e.target.value as PlanStatus })
                      }
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {(Object.entries(STATUS_CONFIG) as [PlanStatus, { label: string }][]).map(
                        ([key, { label }]) => (
                          <option key={key} value={key}>{label}</option>
                        )
                      )}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      開始日
                    </label>
                    <input
                      type="date"
                      value={form.start_date}
                      onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      終了日
                    </label>
                    <input
                      type="date"
                      value={form.end_date}
                      onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>

              {/* Goals */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3 pb-1 border-b">目標</h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">長期目標</label>
                    <textarea
                      value={form.long_term_goals}
                      onChange={(e) => setForm({ ...form, long_term_goals: e.target.value })}
                      rows={3}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="長期的な目標を入力"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">短期目標</label>
                    <textarea
                      value={form.short_term_goals}
                      onChange={(e) => setForm({ ...form, short_term_goals: e.target.value })}
                      rows={3}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="短期的な目標を入力"
                    />
                  </div>
                </div>
              </div>

              {/* Services */}
              <div>
                <div className="flex items-center justify-between mb-3 pb-1 border-b">
                  <h3 className="text-sm font-semibold text-gray-700">サービス内容</h3>
                  <button
                    type="button"
                    onClick={addService}
                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                  >
                    <PlusCircle size={14} />
                    追加
                  </button>
                </div>
                <div className="space-y-3">
                  {services.map((svc, idx) => (
                    <div key={idx} className="rounded-lg border p-3 bg-gray-50 relative">
                      {services.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeService(idx)}
                          className="absolute right-2 top-2 text-gray-400 hover:text-red-500"
                        >
                          <MinusCircle size={15} />
                        </button>
                      )}
                      <div className="grid grid-cols-2 gap-3 pr-4">
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">
                            サービス種別
                          </label>
                          <select
                            value={svc.service_type}
                            onChange={(e) => updateService(idx, "service_type", e.target.value)}
                            className="w-full rounded-lg border px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                          >
                            <option value="">選択してください</option>
                            <option value="訪問介護">訪問介護</option>
                            <option value="訪問看護">訪問看護</option>
                            <option value="訪問リハビリテーション">訪問リハビリテーション</option>
                            <option value="通所介護">通所介護</option>
                            <option value="通所リハビリテーション">通所リハビリテーション</option>
                            <option value="短期入所生活介護">短期入所生活介護</option>
                            <option value="福祉用具貸与">福祉用具貸与</option>
                            <option value="居宅療養管理指導">居宅療養管理指導</option>
                            <option value="その他">その他</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">
                            頻度
                          </label>
                          <select
                            value={svc.frequency}
                            onChange={(e) => updateService(idx, "frequency", e.target.value)}
                            className="w-full rounded-lg border px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                          >
                            <option value="">選択</option>
                            {SERVICE_FREQUENCIES.map((f) => (
                              <option key={f} value={f}>{f}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">
                            サービス内容
                          </label>
                          <input
                            type="text"
                            value={svc.service_content}
                            onChange={(e) => updateService(idx, "service_content", e.target.value)}
                            className="w-full rounded-lg border px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                            placeholder="具体的な内容"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">
                            提供事業所
                          </label>
                          <select
                            value={svc.provider}
                            onChange={(e) => updateService(idx, "provider", e.target.value)}
                            className="w-full rounded-lg border px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                          >
                            <option value="">選択してください</option>
                            {providersMaster.map((p) => (
                              <option key={p.provider_name} value={p.provider_name}>{p.provider_name}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <button
                  type="button"
                  onClick={() => setDialogOpen(false)}
                  className="rounded border border-gray-300 bg-white px-4 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex items-center gap-1 rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {saving && <Loader2 size={12} className="animate-spin" />}
                  {editingPlan ? "更新する" : "登録する"}
                </button>
              </div>
            </form>
        </div>
      )}

        </div>
      </div>

      {/* 右側: プレビューパネル */}
      <div className="w-[420px] shrink-0 overflow-y-auto bg-gray-50">
        <div className="border-b bg-white px-4 py-3 flex items-center gap-2">
          <FileText className="text-indigo-600" size={16} />
          <h2 className="text-sm font-semibold text-gray-900">ケアプランプレビュー</h2>
        </div>
        <div className="p-4">
          {!previewTarget ? (
            <div className="rounded-lg border border-dashed bg-white py-12 text-center text-xs text-gray-400">
              プランを選択または編集するとプレビューが表示されます
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border bg-white p-4 shadow-sm text-xs">
              {/* 第1表風プレビュー */}
              <div className="border-b pb-2">
                <div className="text-[10px] text-gray-500 mb-0.5">居宅サービス計画書（第1表）</div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-[9px] text-gray-500">利用者氏名</div>
                    <div className="font-semibold">{previewTarget.user_name || "—"}</div>
                  </div>
                  <div>
                    <div className="text-[9px] text-gray-500">計画番号</div>
                    <div>{previewTarget.plan_number || "—"}</div>
                  </div>
                  <div>
                    <div className="text-[9px] text-gray-500">計画種別</div>
                    <div>{previewTarget.plan_type || "—"}</div>
                  </div>
                  <div>
                    <div className="text-[9px] text-gray-500">ステータス</div>
                    <div>
                      <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CONFIG[previewTarget.status].cls}`}>
                        {STATUS_CONFIG[previewTarget.status].label}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="mt-2">
                  <div className="text-[9px] text-gray-500">計画期間</div>
                  <div>
                    {formatDate(previewTarget.start_date)} 〜 {formatDate(previewTarget.end_date)}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-[9px] text-gray-500 mb-0.5">長期目標</div>
                <div className="whitespace-pre-wrap rounded bg-gray-50 p-2 min-h-[40px]">
                  {previewTarget.long_term_goals || "（未入力）"}
                </div>
              </div>

              <div>
                <div className="text-[9px] text-gray-500 mb-0.5">短期目標</div>
                <div className="whitespace-pre-wrap rounded bg-gray-50 p-2 min-h-[40px]">
                  {previewTarget.short_term_goals || "（未入力）"}
                </div>
              </div>

              {/* 第2表風: サービス内容 */}
              <div className="border-t pt-2">
                <div className="text-[10px] text-gray-500 mb-1">サービス内容（第2表）</div>
                {previewTarget.services.filter((s) => s.service_type).length === 0 ? (
                  <div className="text-center text-[10px] text-gray-400 py-2">
                    サービスが登録されていません
                  </div>
                ) : (
                  <table className="w-full border-collapse text-[10px]">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className="border border-gray-300 px-1 py-1 text-left">種別</th>
                        <th className="border border-gray-300 px-1 py-1 text-left">内容</th>
                        <th className="border border-gray-300 px-1 py-1 text-left">頻度</th>
                        <th className="border border-gray-300 px-1 py-1 text-left">提供者</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewTarget.services
                        .filter((s) => s.service_type)
                        .map((svc, i) => (
                          <tr key={i}>
                            <td className="border border-gray-300 px-1 py-1">{svc.service_type}</td>
                            <td className="border border-gray-300 px-1 py-1">{svc.service_content || "—"}</td>
                            <td className="border border-gray-300 px-1 py-1">{svc.frequency || "—"}</td>
                            <td className="border border-gray-300 px-1 py-1">{svc.provider || "—"}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete Dialog */}
      {deleteDialogOpen && deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white shadow-xl p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">ケアプランを削除</h2>
            <p className="text-sm text-gray-600 mb-6">
              <span className="font-medium text-gray-900">
                {deleteTarget.kaigo_users?.name}
              </span>{" "}
              さんのケアプランを削除しますか？関連するサービス情報もすべて削除されます。
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
