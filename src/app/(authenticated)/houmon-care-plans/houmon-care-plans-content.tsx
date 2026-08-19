"use client";

/**
 * 訪問介護計画書 v2 (2026-08-07)
 *
 * ほのぼの NEXT「訪問介護計画書作成編」の流れに合わせた画面:
 *   Ⅰ カンファレンス      → /care-conferences (この画面から参照・紐付け)
 *   Ⅱ 訪問介護計画書       → この画面 (作成・複写・印刷)
 *   Ⅱ-2 詳細計画 (手順書)  → /visit-procedures
 *   Ⅲ 実施記録            → /visit-records
 *
 * ほのぼのの「居宅があれば同内容を取り込める」に相当する機能として、
 * 居宅サービス計画書 第1表/第2表 + アセスメント からの取込ボタンを持つ。
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { BunreiPicker } from "@/components/bunrei/bunrei-picker";
import { toast } from "sonner";
import {
  ClipboardList,
  Plus,
  Pencil,
  Trash2,
  Copy,
  Save,
  X,
  Loader2,
  AlertCircle,
  ArrowLeft,
  Printer,
  FileText,
  Download,
  MessagesSquare,
  BookOpen,
  ClipboardCheck,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import {
  duplicatePlan,
  fetchCarePlanImport,
  getPlan,
  getPlansByUser,
  getRecentConferences,
  isSchemaV1Error,
  savePlan,
  softDeletePlan,
  type ConferenceRef,
} from "@/lib/houmon-care-plan/queries";
import { createProcedureFromPlan, linkProcedureToPlan } from "@/lib/houmon-care-plan/to-procedure";
import {
  emptyGoalRow,
  emptyHoumonCarePlan,
  emptyWeeklyServiceRow,
  formatDays,
  HOUMON_CARE_PLAN_STATUSES,
  HOUMON_PLAN_KINDS,
  VISIT_CARE_SERVICE_KINDS,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  type HoumonCarePlan,
  type HoumonCarePlanStatus,
  type HoumonCarePlanSummary,
  type HoumonGoalRow,
  type HoumonPlanKind,
  type VisitCareServiceKind,
  type WeekdayKey,
  type WeeklyServiceRow,
} from "@/lib/houmon-care-plan/types";

export interface KaigoUser {
  id: string;
  name: string;
  name_kana: string | null;
}

export interface HoumonCarePlansContentProps {
  userId: string;
  initialUser: KaigoUser | null;
  initialPlans: HoumonCarePlanSummary[];
  /** migration (houmon_care_plans_v2.sql) 未適用フラグ (server 側判定) */
  initialSchemaOutdated?: boolean;
}

const inputClass =
  "w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";
const textareaClass = `${inputClass} resize-y min-h-[72px]`;
const cellInputClass =
  "w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";
const cellTextareaClass = `${cellInputClass} resize-y min-h-[56px]`;

const STATUS_CONFIG: Record<HoumonCarePlanStatus, { label: string; cls: string }> = {
  draft: { label: "作成中", cls: "bg-yellow-100 text-yellow-700" },
  completed: { label: "完成", cls: "bg-green-100 text-green-700" },
};

const PLAN_KIND_CLS: Record<HoumonPlanKind, string> = {
  初回: "bg-sky-100 text-sky-700",
  変更: "bg-amber-100 text-amber-700",
  更新: "bg-violet-100 text-violet-700",
};

function formatDateJa(date: string | null | undefined): string {
  if (!date) return "—";
  try {
    return format(parseISO(date), "yyyy年M月d日(E)", { locale: ja });
  } catch {
    return date;
  }
}

function formatDateShort(date: string | null | undefined): string {
  if (!date) return "—";
  try {
    return format(parseISO(date), "yyyy/M/d", { locale: ja });
  } catch {
    return date;
  }
}

export function HoumonCarePlansContent({
  userId,
  initialUser,
  initialPlans,
  initialSchemaOutdated = false,
}: HoumonCarePlansContentProps) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const { businessType, currentOffice, loading: btLoading } = useBusinessType();

  const [user] = useState<KaigoUser | null>(initialUser);
  const [plans, setPlans] = useState<HoumonCarePlanSummary[]>(initialPlans);
  const [loadingList, setLoadingList] = useState(false);
  const [schemaOutdated, setSchemaOutdated] = useState(initialSchemaOutdated);

  const [mode, setMode] = useState<"list" | "edit">("list");
  const [editingPlan, setEditingPlan] = useState<HoumonCarePlan | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [conferences, setConferences] = useState<ConferenceRef[]>([]);
  const [creatingProcedureFor, setCreatingProcedureFor] = useState<string | null>(null);

  const tenantId = currentOffice?.tenant_id ?? null;
  const officeId = currentOffice?.id ?? null;
  const officeQuery = officeId ? `?office=${encodeURIComponent(officeId)}` : "";

  const handleError = useCallback((err: unknown, prefix: string) => {
    console.error(prefix, err);
    if (isSchemaV1Error(err)) {
      setSchemaOutdated(true);
      toast.error("訪問介護計画書 v2 の migration が未適用です (migrations/applied_archive/houmon_care_plans_v2.sql)");
      return;
    }
    toast.error(`${prefix}: ` + (err instanceof Error ? err.message : String(err)));
  }, []);

  const fetchPlans = useCallback(async () => {
    setLoadingList(true);
    try {
      const rows = await getPlansByUser(supabase, userId);
      setPlans(rows);
      setSchemaOutdated(false);
    } catch (err) {
      handleError(err, "計画書一覧の取得に失敗しました");
    } finally {
      setLoadingList(false);
    }
  }, [supabase, userId, handleError]);

  // カンファレンス候補 (= 計画の根拠として紐付ける) は編集前に一度だけ取得
  useEffect(() => {
    let cancelled = false;
    getRecentConferences(supabase, userId)
      .then((rows) => {
        if (!cancelled) setConferences(rows);
      })
      .catch((err) => {
        console.error("カンファレンス取得に失敗:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, userId]);

  // ── 操作 ──────────────────────────────────────────

  const handleNew = () => {
    if (!tenantId) {
      toast.error("現在の事業所が解決できません (サイドバー下部から訪問介護の自事業所を選択してください)");
      return;
    }
    const base = emptyHoumonCarePlan(tenantId, userId, officeId);
    // 2 版目以降は既定で「変更」、初回作成日は最古の計画から引き継ぐ
    if (plans.length > 0) {
      const oldest = plans[plans.length - 1];
      base.plan_kind = "変更";
      base.initial_plan_date = oldest.plan_date;
    }
    setEditingPlan(base);
    setMode("edit");
  };

  const handleEdit = async (id: string) => {
    setLoadingEdit(true);
    try {
      const plan = await getPlan(supabase, id);
      if (!plan) {
        toast.error("計画書が見つかりません");
        return;
      }
      setEditingPlan(plan);
      setMode("edit");
    } catch (err) {
      handleError(err, "計画書の取得に失敗しました");
    } finally {
      setLoadingEdit(false);
    }
  };

  const handleDuplicate = async (id: string) => {
    if (!confirm("この計画書を複写して新しい版を作成しますか？")) return;
    const today = format(new Date(), "yyyy-MM-dd");
    try {
      const newId = await duplicatePlan(supabase, id, today);
      toast.success("計画書を複写しました");
      await fetchPlans();
      await handleEdit(newId);
    } catch (err) {
      handleError(err, "複写に失敗しました");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この計画書を削除しますか？（取り消しできません）")) return;
    try {
      await softDeletePlan(supabase, id);
      toast.success("計画書を削除しました");
      await fetchPlans();
    } catch (err) {
      handleError(err, "削除に失敗しました");
    }
  };

  /**
   * 計画書 → 手順書 (個別援助詳細計画) を作成して編集画面へ。
   * ほのぼの Ⅱ-2「作成した訪問介護計画書をもとに詳細のサービス手順書を作成」に相当。
   */
  const handleCreateProcedure = async (planId: string) => {
    if (!user?.name) {
      toast.error("利用者名が取得できていないため手順書を作成できません");
      return;
    }
    if (!confirm("この計画書の週間サービス計画から手順書を作成しますか？")) return;
    setCreatingProcedureFor(planId);
    try {
      const full = await getPlan(supabase, planId);
      if (!full) {
        toast.error("計画書が見つかりません");
        return;
      }
      const integrated = currentOffice?.visit_procedure_mode === "integrated";
      const { documentId, overflow, unsupportedKinds } = await createProcedureFromPlan(supabase, full, {
        clientName: user.name,
        clientId: integrated ? userId : null,
      });
      await linkProcedureToPlan(supabase, planId, documentId);
      if (overflow > 0) {
        toast.warning(`手順書はサービス 5 枠までのため ${overflow} 件を引き継げませんでした`);
      }
      if (unsupportedKinds.length > 0) {
        toast.warning(
          `${unsupportedKinds.join("・")} は手順書の区分に無いため 身体1 で仮置きしました。手順書側で確認してください`,
        );
      }
      toast.success("手順書を作成しました");
      router.push(`/visit-procedures/${documentId}/edit${officeQuery}`);
    } catch (err) {
      handleError(err, "手順書の作成に失敗しました");
    } finally {
      setCreatingProcedureFor(null);
    }
  };

  const handleSave = async () => {
    if (!editingPlan) return;
    if (!editingPlan.plan_date) {
      toast.error("計画作成日を入力してください");
      return;
    }
    if (!editingPlan.tenant_id) {
      toast.error("tenant_id が解決できません");
      return;
    }
    if (
      editingPlan.status === "completed" &&
      editingPlan.goals.every((g) => !g.needs.trim() && !g.long_term_goal.trim() && !g.short_term_goal.trim())
    ) {
      toast.error("「完成」にする前に 課題・目標 を 1 件以上入力してください");
      return;
    }
    setSaving(true);
    try {
      const newId = await savePlan(supabase, editingPlan);
      toast.success(editingPlan.id ? "計画書を更新しました" : "計画書を作成しました");
      setEditingPlan({ ...editingPlan, id: newId });
      await fetchPlans();
      setMode("list");
    } catch (err) {
      handleError(err, "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  // ── 訪問介護モード以外は guard ──

  if (!btLoading && businessType !== "訪問介護") {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-800 flex items-start gap-3">
          <AlertCircle size={20} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">この機能は訪問介護モード専用です</p>
            <p className="text-sm mt-1">
              サイドバー下部の事業所セレクタから訪問介護の自事業所を選択してください。
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── 編集モード ──

  if (mode === "edit" && editingPlan) {
    return (
      <PlanEditor
        plan={editingPlan}
        user={user}
        userId={userId}
        saving={saving}
        conferences={conferences}
        onChange={setEditingPlan}
        onSave={handleSave}
        onCancel={() => {
          setMode("list");
          setEditingPlan(null);
        }}
        onError={handleError}
      />
    );
  }

  // ── 一覧モード ──

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        {/* header */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
              <ClipboardList size={22} className="text-emerald-600 shrink-0" />
              訪問介護計画書
            </h1>
            <p className="mt-1 text-xs sm:text-sm text-gray-500">
              {user ? (
                <>
                  <span className="font-medium text-gray-700">{user.name}</span>
                  {user.name_kana ? <span className="text-gray-400 ml-1">({user.name_kana})</span> : null}
                  の計画書
                </>
              ) : (
                "利用者情報の取得中..."
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleNew}
              disabled={btLoading || !tenantId || schemaOutdated}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Plus size={16} />
              新規作成
            </button>
          </div>
        </div>

        {schemaOutdated ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 flex items-start gap-2">
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">訪問介護計画書 v2 の migration が未適用です</p>
              <p className="mt-1 text-xs">
                Supabase SQL Editor で{" "}
                <code className="rounded bg-white px-1 py-0.5">
                  apps/kaigo-app/migrations/applied_archive/houmon_care_plans_v2.sql
                </code>{" "}
                を実行してください（BEGIN 〜 COMMIT を 1 ブロックで貼付）。
              </p>
            </div>
          </div>
        ) : null}

        {/* 関連メニュー (= ほのぼのの処理の流れ) */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-400">関連:</span>
          <Link
            href={`/care-conferences?user=${encodeURIComponent(userId)}`}
            className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-gray-700 hover:bg-gray-50"
          >
            <MessagesSquare size={12} />
            カンファレンス記録
          </Link>
          <Link
            href={
              user?.name
                ? `/visit-procedures/clients/${encodeURIComponent(user.name)}`
                : "/visit-procedures"
            }
            className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-gray-700 hover:bg-gray-50"
          >
            <BookOpen size={12} />
            手順書 (詳細計画)
          </Link>
          <Link
            href={`/visit-records?user=${encodeURIComponent(userId)}`}
            className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-gray-700 hover:bg-gray-50"
          >
            <ClipboardCheck size={12} />
            サービス実施記録
          </Link>
        </div>

        {/* list */}
        {loadingList || loadingEdit ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" />
            読込中...
          </div>
        ) : plans.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-12 text-center">
            <FileText size={40} className="mx-auto mb-3 text-gray-300" />
            <p className="text-sm text-gray-500">計画書がまだありません</p>
            <p className="text-xs text-gray-400 mt-1">右上の「新規作成」から作成してください</p>
          </div>
        ) : (
          <div className="space-y-2">
            {plans.map((p) => {
              const cfg = STATUS_CONFIG[p.status] ?? STATUS_CONFIG.draft;
              const kindCls = PLAN_KIND_CLS[p.plan_kind] ?? PLAN_KIND_CLS["初回"];
              return (
                <div
                  key={p.id}
                  className="rounded-lg border border-gray-200 bg-white p-3 sm:p-4 hover:border-emerald-400 hover:shadow-sm transition"
                >
                  <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 text-[11px] rounded-full px-2 py-0.5 ${kindCls}`}>
                          {p.plan_kind ?? "初回"}
                        </span>
                        <span className="font-medium text-gray-900">{formatDateJa(p.plan_date)}</span>
                        <span className={`shrink-0 text-[11px] rounded-full px-2 py-0.5 ${cfg.cls}`}>
                          {cfg.label}
                        </span>
                        {p.user_consent_date ? (
                          <span className="shrink-0 text-[11px] rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">
                            同意 {formatDateShort(p.user_consent_date)}
                          </span>
                        ) : (
                          <span className="shrink-0 text-[11px] rounded-full bg-gray-100 px-2 py-0.5 text-gray-500">
                            同意未取得
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-gray-500 flex flex-wrap items-center gap-x-3">
                        <span>
                          計画期間: {formatDateShort(p.valid_from)} 〜 {formatDateShort(p.valid_until)}
                        </span>
                        {p.author_name ? <span>提供責任者: {p.author_name}</span> : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Link
                        href={`/houmon-care-plans/${p.id}`}
                        className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                        title="印刷プレビュー"
                      >
                        <Printer size={12} />
                        印刷
                      </Link>
                      <button
                        onClick={() => handleEdit(p.id)}
                        className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        <Pencil size={12} />
                        編集
                      </button>
                      <button
                        onClick={() => handleDuplicate(p.id)}
                        className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                        title="この版を複写して新しい版を作る"
                      >
                        <Copy size={12} />
                        複写
                      </button>
                      {p.procedure_document_id ? (
                        <Link
                          href={`/visit-procedures/${p.procedure_document_id}${officeQuery}`}
                          className="inline-flex items-center gap-1 rounded border border-sky-300 px-2 py-1 text-xs text-sky-700 hover:bg-sky-50"
                          title="この計画書から作成した手順書を開く"
                        >
                          <BookOpen size={12} />
                          手順書
                        </Link>
                      ) : (
                        <button
                          onClick={() => handleCreateProcedure(p.id)}
                          disabled={creatingProcedureFor === p.id}
                          className="inline-flex items-center gap-1 rounded border border-sky-300 px-2 py-1 text-xs text-sky-700 hover:bg-sky-50 disabled:opacity-50"
                          title="週間サービス計画から手順書 (詳細計画) を作成する"
                        >
                          {creatingProcedureFor === p.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <BookOpen size={12} />
                          )}
                          手順書作成
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(p.id)}
                        className="inline-flex items-center gap-1 rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                      >
                        <Trash2 size={12} />
                        削除
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// PlanEditor (= 編集 form)
// =====================================================================

interface PlanEditorProps {
  plan: HoumonCarePlan;
  user: KaigoUser | null;
  userId: string;
  saving: boolean;
  conferences: ConferenceRef[];
  onChange: (plan: HoumonCarePlan) => void;
  onSave: () => void;
  onCancel: () => void;
  onError: (err: unknown, prefix: string) => void;
}

function PlanEditor({
  plan,
  user,
  userId,
  saving,
  conferences,
  onChange,
  onSave,
  onCancel,
  onError,
}: PlanEditorProps) {
  const supabase = useMemo(() => createClient(), []);
  const [importing, setImporting] = useState(false);

  const updateField = <K extends keyof HoumonCarePlan>(key: K, value: HoumonCarePlan[K]) => {
    onChange({ ...plan, [key]: value });
  };

  // ── 目標行 ──
  const updateGoal = (idx: number, patch: Partial<HoumonGoalRow>) => {
    onChange({ ...plan, goals: plan.goals.map((g, i) => (i === idx ? { ...g, ...patch } : g)) });
  };
  const addGoal = () => onChange({ ...plan, goals: [...plan.goals, emptyGoalRow()] });
  const removeGoal = (idx: number) => {
    const next = plan.goals.filter((_, i) => i !== idx);
    onChange({ ...plan, goals: next.length > 0 ? next : [emptyGoalRow()] });
  };

  // ── 週間サービス行 ──
  const updateService = (idx: number, patch: Partial<WeeklyServiceRow>) => {
    onChange({
      ...plan,
      weekly_services: plan.weekly_services.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    });
  };
  const toggleDay = (idx: number, day: WeekdayKey) => {
    const row = plan.weekly_services[idx];
    const has = row.days.includes(day);
    const nextDays = has ? row.days.filter((d) => d !== day) : [...row.days, day];
    updateService(idx, { days: WEEKDAY_KEYS.filter((d) => nextDays.includes(d)) });
  };
  const addService = () =>
    onChange({ ...plan, weekly_services: [...plan.weekly_services, emptyWeeklyServiceRow()] });
  const removeService = (idx: number) => {
    const next = plan.weekly_services.filter((_, i) => i !== idx);
    onChange({ ...plan, weekly_services: next.length > 0 ? next : [emptyWeeklyServiceRow()] });
  };

  // ── 居宅サービス計画書からの取込 ──
  const handleImport = async () => {
    if (
      !confirm(
        "居宅サービス計画書 (第1表・第2表) とアセスメントから取り込みます。\n" +
          "取込先の項目 (意向・基本方針・課題/目標) は上書きされます。よろしいですか？",
      )
    ) {
      return;
    }
    setImporting(true);
    try {
      const { patch, sources } = await fetchCarePlanImport(supabase, userId);
      if (sources.length === 0) {
        toast.error("取り込める内容が見つかりませんでした (居宅の第1表・第2表 / アセスメント が未作成)");
        return;
      }
      onChange({ ...plan, ...patch });
      toast.success(`取込完了: ${sources.join(" / ")}`);
    } catch (err) {
      onError(err, "居宅計画からの取込に失敗しました");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        {/* header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
              title="一覧に戻る"
            >
              <ArrowLeft size={14} />
              一覧へ
            </button>
            <h2 className="text-lg sm:text-xl font-bold text-gray-900 flex items-center gap-2">
              <ClipboardList size={20} className="text-emerald-600 shrink-0" />
              訪問介護計画書 {plan.id ? "編集" : "新規作成"}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleImport}
              disabled={saving || importing}
              className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
              title="居宅サービス計画書 (第1表・第2表) とアセスメントから取り込む"
            >
              {importing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              居宅計画から取込
            </button>
            <button
              onClick={onCancel}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <X size={14} />
              キャンセル
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              保存
            </button>
          </div>
        </div>

        <div className="text-xs text-gray-500">
          利用者: <span className="font-medium text-gray-700">{user?.name ?? "(取得中)"}</span>
        </div>

        {/* 基本情報 */}
        <Section title="基本情報">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="作成区分">
              <select
                value={plan.plan_kind}
                onChange={(e) => updateField("plan_kind", e.target.value as HoumonPlanKind)}
                className={inputClass}
              >
                {HOUMON_PLAN_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="計画作成日 *">
              <input
                type="date"
                value={plan.plan_date}
                onChange={(e) => updateField("plan_date", e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="初回作成日">
              <input
                type="date"
                value={plan.initial_plan_date ?? ""}
                onChange={(e) => updateField("initial_plan_date", e.target.value || null)}
                className={inputClass}
              />
            </Field>
            <Field label="計画期間 開始">
              <input
                type="date"
                value={plan.valid_from ?? ""}
                onChange={(e) => updateField("valid_from", e.target.value || null)}
                className={inputClass}
              />
            </Field>
            <Field label="計画期間 終了">
              <input
                type="date"
                value={plan.valid_until ?? ""}
                onChange={(e) => updateField("valid_until", e.target.value || null)}
                className={inputClass}
              />
            </Field>
            <Field label="ステータス">
              <select
                value={plan.status}
                onChange={(e) => updateField("status", e.target.value as HoumonCarePlanStatus)}
                className={inputClass}
              >
                {HOUMON_CARE_PLAN_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_CONFIG[s].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="サービス提供責任者">
              <input
                type="text"
                value={plan.author_name}
                onChange={(e) => updateField("author_name", e.target.value)}
                className={inputClass}
                placeholder="例: 山田 花子"
              />
            </Field>
            <Field label="計画作成者">
              <input
                type="text"
                value={plan.creator_name}
                onChange={(e) => updateField("creator_name", e.target.value)}
                className={inputClass}
                placeholder="提供責任者と異なる場合"
              />
            </Field>
            <Field label="根拠カンファレンス">
              <select
                value={plan.conference_id ?? ""}
                onChange={(e) => updateField("conference_id", e.target.value || null)}
                className={inputClass}
              >
                <option value="">(紐付けなし)</option>
                {conferences.map((c) => (
                  <option key={c.id} value={c.id}>
                    {formatDateShort(c.held_on)}
                    {c.agenda ? ` / ${c.agenda.slice(0, 20)}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Section>

        {/* 意向・基本方針 */}
        <Section title="本人・家族の意向 / 援助の基本方針">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FieldWithBunrei
              label="本人の意向"
              category="計画1-意向"
              value={plan.user_intention}
              onChange={(v) => updateField("user_intention", v)}
              placeholder="例: できる限り自宅で生活を続けたい"
            />
            <FieldWithBunrei
              label="家族の意向"
              category="計画1-意向"
              value={plan.family_intention}
              onChange={(v) => updateField("family_intention", v)}
              placeholder="例: 日中独居となる時間帯の見守りをお願いしたい"
            />
          </div>
          <div className="mt-3">
            <FieldWithBunrei
              label="援助の基本方針"
              category="計画1-方針"
              value={plan.basic_policy}
              onChange={(v) => updateField("basic_policy", v)}
              placeholder="居宅サービス計画の総合的な援助の方針を踏まえた訪問介護としての方針"
            />
          </div>
        </Section>

        {/* 利用者・家族の状況 */}
        <Section title="利用者・家族の状況">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="利用者の状況">
              <textarea
                value={plan.user_situation}
                onChange={(e) => updateField("user_situation", e.target.value)}
                className={textareaClass}
                placeholder="ADL / 認知 / 主病・既往 / 生活リズム など"
              />
            </Field>
            <Field label="家族の状況">
              <textarea
                value={plan.family_situation}
                onChange={(e) => updateField("family_situation", e.target.value)}
                className={textareaClass}
                placeholder="同居家族の構成 / 介護負担 / インフォーマルサポート など"
              />
            </Field>
          </div>
        </Section>

        {/* 課題・目標 */}
        <Section
          title="生活全般の解決すべき課題 (ニーズ) と目標"
          action={
            <button
              onClick={addGoal}
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              <Plus size={12} />
              行を追加
            </button>
          }
        >
          <div className="space-y-3">
            {plan.goals.map((g, idx) => (
              <div key={idx} className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-gray-600">課題 {idx + 1}</span>
                  <button
                    onClick={() => removeGoal(idx)}
                    className="inline-flex items-center gap-1 rounded border border-red-300 px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-50"
                  >
                    <Trash2 size={10} />
                    削除
                  </button>
                </div>
                <FieldWithBunrei
                  label="生活全般の解決すべき課題 (ニーズ)"
                  category="計画2-課題"
                  value={g.needs}
                  onChange={(v) => updateGoal(idx, { needs: v })}
                  small
                />
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <FieldWithBunrei
                      label="長期目標"
                      category="計画2-長期目標"
                      value={g.long_term_goal}
                      onChange={(v) => updateGoal(idx, { long_term_goal: v })}
                      small
                    />
                    <div className="mt-1">
                      <input
                        type="text"
                        value={g.long_term_period}
                        onChange={(e) => updateGoal(idx, { long_term_period: e.target.value })}
                        className={cellInputClass}
                        placeholder="期間 例: R8/4/1〜R9/3/31"
                      />
                    </div>
                  </div>
                  <div>
                    <FieldWithBunrei
                      label="短期目標"
                      category="計画2-短期目標"
                      value={g.short_term_goal}
                      onChange={(v) => updateGoal(idx, { short_term_goal: v })}
                      small
                    />
                    <div className="mt-1">
                      <input
                        type="text"
                        value={g.short_term_period}
                        onChange={(e) => updateGoal(idx, { short_term_period: e.target.value })}
                        className={cellInputClass}
                        placeholder="期間 例: R8/4/1〜R8/9/30"
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* 週間サービス計画 */}
        <Section
          title="訪問介護の内容 (週間サービス計画)"
          action={
            <button
              onClick={addService}
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              <Plus size={12} />
              サービス追加
            </button>
          }
        >
          <div className="space-y-3">
            {plan.weekly_services.map((svc, idx) => (
              <div key={idx} className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-gray-600">
                    サービス {idx + 1}
                    {svc.days.length > 0 ? (
                      <span className="ml-2 font-normal text-gray-500">{formatDays(svc.days)}</span>
                    ) : null}
                  </span>
                  <button
                    onClick={() => removeService(idx)}
                    className="inline-flex items-center gap-1 rounded border border-red-300 px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-50"
                  >
                    <Trash2 size={10} />
                    削除
                  </button>
                </div>

                {/* 曜日 chips */}
                <div className="mb-2">
                  <label className="text-xs text-gray-500 mb-1 block">曜日</label>
                  <div className="flex flex-wrap gap-1">
                    {WEEKDAY_KEYS.map((d) => {
                      const on = svc.days.includes(d);
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() => toggleDay(idx, d)}
                          className={`h-7 w-8 rounded border text-xs font-medium transition ${
                            on
                              ? "border-emerald-500 bg-emerald-500 text-white"
                              : "border-gray-300 bg-white text-gray-600 hover:bg-gray-100"
                          }`}
                        >
                          {WEEKDAY_LABELS[d]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Field label="開始時刻">
                    <input
                      type="time"
                      value={svc.start_time}
                      onChange={(e) => updateService(idx, { start_time: e.target.value })}
                      className={cellInputClass}
                    />
                  </Field>
                  <Field label="終了時刻">
                    <input
                      type="time"
                      value={svc.end_time}
                      onChange={(e) => updateService(idx, { end_time: e.target.value })}
                      className={cellInputClass}
                    />
                  </Field>
                  <Field label="サービス区分">
                    <select
                      value={svc.service_kind}
                      onChange={(e) =>
                        updateService(idx, {
                          service_kind: e.target.value as VisitCareServiceKind | "",
                        })
                      }
                      className={cellInputClass}
                    >
                      <option value="">(未選択)</option>
                      {VISIT_CARE_SERVICE_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="所要時間">
                    <div className="px-2 py-1 text-sm text-gray-600">
                      {durationLabel(svc.start_time, svc.end_time)}
                    </div>
                  </Field>
                </div>

                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <FieldWithBunrei
                    label="援助内容"
                    category="計画2-サービス内容"
                    value={svc.content}
                    onChange={(v) => updateService(idx, { content: v })}
                    placeholder="例: 全身清拭、更衣、口腔ケア、排泄介助"
                    small
                  />
                  <Field label="留意点">
                    <textarea
                      value={svc.notes}
                      onChange={(e) => updateService(idx, { notes: e.target.value })}
                      className={cellTextareaClass}
                      placeholder="例: 右片麻痺のため左側から介助"
                    />
                  </Field>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* 留意事項 */}
        <Section title="留意事項・緊急時の対応">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="サービス提供上の留意事項">
              <textarea
                value={plan.precautions}
                onChange={(e) => updateField("precautions", e.target.value)}
                className={textareaClass}
                placeholder="疾患・服薬・住環境上の注意点 など"
              />
            </Field>
            <Field label="緊急時の対応">
              <textarea
                value={plan.emergency_response}
                onChange={(e) => updateField("emergency_response", e.target.value)}
                className={textareaClass}
                placeholder="連絡先の優先順位 / 主治医 / 救急時の判断基準 など"
              />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="特記事項">
              <textarea
                value={plan.special_notes}
                onChange={(e) => updateField("special_notes", e.target.value)}
                className={textareaClass}
                placeholder="他職種との連携 など"
              />
            </Field>
          </div>
        </Section>

        {/* 説明・同意 */}
        <Section title="説明・同意">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="説明日">
              <input
                type="date"
                value={plan.explained_on ?? ""}
                onChange={(e) => updateField("explained_on", e.target.value || null)}
                className={inputClass}
              />
            </Field>
            <Field label="同意日">
              <input
                type="date"
                value={plan.user_consent_date ?? ""}
                onChange={(e) => updateField("user_consent_date", e.target.value || null)}
                className={inputClass}
              />
            </Field>
            <Field label="同意者名 (本人)">
              <input
                type="text"
                value={plan.user_consent_name}
                onChange={(e) => updateField("user_consent_name", e.target.value)}
                className={inputClass}
                placeholder="署名者の氏名"
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="代理人氏名">
                <input
                  type="text"
                  value={plan.consent_proxy_name}
                  onChange={(e) => updateField("consent_proxy_name", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="続柄">
                <input
                  type="text"
                  value={plan.consent_proxy_relation}
                  onChange={(e) => updateField("consent_proxy_relation", e.target.value)}
                  className={inputClass}
                  placeholder="例: 長女"
                />
              </Field>
            </div>
          </div>
        </Section>

        {/* footer save */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <X size={14} />
            キャンセル
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

/** "09:00" - "09:45" → "45分" (不正・未入力は空表示) */
function durationLabel(start: string, end: string): string {
  const parse = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const s = parse(start);
  const e = parse(end);
  if (s === null || e === null) return "—";
  const diff = e - s;
  if (diff <= 0) return "—";
  const h = Math.floor(diff / 60);
  const mi = diff % 60;
  return h > 0 ? `${h}時間${mi > 0 ? `${mi}分` : ""}` : `${mi}分`;
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      {label ? <label className="text-xs text-gray-500 mb-1 block">{label}</label> : null}
      {children}
    </div>
  );
}

/** textarea + 文例ピッカー (bunrei_master 未適用でも壊れない) */
function FieldWithBunrei({
  label,
  category,
  value,
  onChange,
  placeholder,
  small,
}: {
  label: string;
  category: React.ComponentProps<typeof BunreiPicker>["category"];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  small?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="text-xs text-gray-500">{label}</label>
        <BunreiPicker category={category} currentText={value} onInsert={onChange} />
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={small ? cellTextareaClass : textareaClass}
        placeholder={placeholder}
      />
    </div>
  );
}
