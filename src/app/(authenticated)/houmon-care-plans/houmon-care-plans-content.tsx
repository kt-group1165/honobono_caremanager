"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
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
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import {
  duplicatePlan,
  getPlan,
  getPlansByUser,
  savePlan,
  softDeletePlan,
} from "@/lib/houmon-care-plan/queries";
import {
  emptyHoumonCarePlan,
  emptyVisitCareService,
  HOUMON_CARE_PLAN_STATUSES,
  VISIT_CARE_SERVICE_KINDS,
  type HoumonCarePlan,
  type HoumonCarePlanStatus,
  type HoumonCarePlanSummary,
  type VisitCareService,
  type VisitCareServiceKind,
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
}

const inputClass =
  "w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";
const textareaClass = `${inputClass} resize-y min-h-[72px]`;

const STATUS_CONFIG: Record<HoumonCarePlanStatus, { label: string; cls: string }> = {
  draft: { label: "下書き", cls: "bg-yellow-100 text-yellow-700" },
  completed: { label: "完了", cls: "bg-green-100 text-green-700" },
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
}: HoumonCarePlansContentProps) {
  const supabase = useMemo(() => createClient(), []);
  const { businessType, currentOffice, loading: btLoading } = useBusinessType();

  const [user] = useState<KaigoUser | null>(initialUser);
  const [plans, setPlans] = useState<HoumonCarePlanSummary[]>(initialPlans);
  const [loadingList, setLoadingList] = useState(false);

  const [mode, setMode] = useState<"list" | "edit">("list");
  const [editingPlan, setEditingPlan] = useState<HoumonCarePlan | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);

  const tenantId = currentOffice?.tenant_id ?? null;
  const officeId = currentOffice?.id ?? null;

  const fetchPlans = useCallback(async () => {
    setLoadingList(true);
    try {
      const rows = await getPlansByUser(supabase, userId);
      setPlans(rows);
    } catch (err) {
      console.error(err);
      toast.error("計画書一覧の取得に失敗しました: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoadingList(false);
    }
  }, [supabase, userId]);

  // initial render は server から受領、以降の operation 後のみ refetch
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    // 何もしない (operation 側で明示 fetchPlans)
  }, []);

  // ── 操作 ──────────────────────────────────────────

  const handleNew = () => {
    if (!tenantId) {
      toast.error("現在の事業所が解決できません (サイドバー下部から訪問介護の自事業所を選択してください)");
      return;
    }
    setEditingPlan(emptyHoumonCarePlan(tenantId, userId, officeId));
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
      console.error(err);
      toast.error("計画書の取得に失敗しました: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoadingEdit(false);
    }
  };

  const handleDuplicate = async (id: string) => {
    if (!confirm("この計画書を複製して新しいバージョンを作成しますか？")) return;
    const today = format(new Date(), "yyyy-MM-dd");
    try {
      const newId = await duplicatePlan(supabase, id, today);
      toast.success("計画書を複製しました");
      await fetchPlans();
      await handleEdit(newId);
    } catch (err) {
      console.error(err);
      toast.error("複製に失敗しました: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この計画書を削除しますか？（取り消しできません）")) return;
    try {
      await softDeletePlan(supabase, id);
      toast.success("計画書を削除しました");
      await fetchPlans();
    } catch (err) {
      console.error(err);
      toast.error("削除に失敗しました: " + (err instanceof Error ? err.message : String(err)));
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
    setSaving(true);
    try {
      const newId = await savePlan(supabase, editingPlan);
      toast.success(editingPlan.id ? "計画書を更新しました" : "計画書を作成しました");
      setEditingPlan({ ...editingPlan, id: newId });
      await fetchPlans();
      setMode("list");
    } catch (err) {
      console.error(err);
      toast.error("保存に失敗しました: " + (err instanceof Error ? err.message : String(err)));
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
        saving={saving}
        onChange={setEditingPlan}
        onSave={handleSave}
        onCancel={() => {
          setMode("list");
          setEditingPlan(null);
        }}
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
              disabled={btLoading || !tenantId}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Plus size={16} />
              新規作成
            </button>
          </div>
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
              const cfg = STATUS_CONFIG[p.status];
              return (
                <div
                  key={p.id}
                  className="rounded-lg border border-gray-200 bg-white p-3 sm:p-4 hover:border-emerald-400 hover:shadow-sm transition"
                >
                  <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900">
                          {formatDateJa(p.plan_date)}
                        </span>
                        <span className={`shrink-0 text-[11px] rounded-full px-2 py-0.5 ${cfg.cls}`}>
                          {cfg.label}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-gray-500 flex flex-wrap items-center gap-x-3">
                        <span>
                          有効期間: {formatDateShort(p.valid_from)} 〜 {formatDateShort(p.valid_until)}
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
                      >
                        <Copy size={12} />
                        複製
                      </button>
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
  saving: boolean;
  onChange: (plan: HoumonCarePlan) => void;
  onSave: () => void;
  onCancel: () => void;
}

function PlanEditor({ plan, user, saving, onChange, onSave, onCancel }: PlanEditorProps) {
  const updateField = <K extends keyof HoumonCarePlan>(key: K, value: HoumonCarePlan[K]) => {
    onChange({ ...plan, [key]: value });
  };

  const updateService = (idx: number, patch: Partial<VisitCareService>) => {
    const next = plan.services.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChange({ ...plan, services: next });
  };

  const addService = () => {
    onChange({ ...plan, services: [...plan.services, emptyVisitCareService()] });
  };

  const removeService = (idx: number) => {
    const next = plan.services.filter((_, i) => i !== idx);
    onChange({ ...plan, services: next.length > 0 ? next : [emptyVisitCareService()] });
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl space-y-5">
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
            <Field label="計画作成日 *">
              <input
                type="date"
                value={plan.plan_date}
                onChange={(e) => updateField("plan_date", e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="有効期間 開始">
              <input
                type="date"
                value={plan.valid_from ?? ""}
                onChange={(e) => updateField("valid_from", e.target.value || null)}
                className={inputClass}
              />
            </Field>
            <Field label="有効期間 終了">
              <input
                type="date"
                value={plan.valid_until ?? ""}
                onChange={(e) => updateField("valid_until", e.target.value || null)}
                className={inputClass}
              />
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
          </div>
        </Section>

        {/* 目標 */}
        <Section title="目標">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="長期目標">
              <textarea
                value={plan.long_term_goal}
                onChange={(e) => updateField("long_term_goal", e.target.value)}
                className={textareaClass}
                placeholder="例: 自宅での生活を継続し、可能な限り自立した生活を送る"
              />
            </Field>
            <Field label="短期目標">
              <textarea
                value={plan.short_term_goal}
                onChange={(e) => updateField("short_term_goal", e.target.value)}
                className={textareaClass}
                placeholder="例: 入浴を安全に実施できる / 食事の準備を負担なく行える"
              />
            </Field>
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

        {/* サービス内容 */}
        <Section
          title="サービス内容"
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
            {plan.services.map((svc, idx) => (
              <div key={idx} className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-gray-600">サービス {idx + 1}</span>
                  <button
                    onClick={() => removeService(idx)}
                    className="inline-flex items-center gap-1 rounded border border-red-300 px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-50"
                  >
                    <Trash2 size={10} />
                    削除
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Field label="サービス区分">
                    <select
                      value={svc.kind}
                      onChange={(e) =>
                        updateService(idx, { kind: e.target.value as VisitCareServiceKind | "" })
                      }
                      className={inputClass}
                    >
                      <option value="">(未選択)</option>
                      {VISIT_CARE_SERVICE_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="頻度">
                    <input
                      type="text"
                      value={svc.frequency}
                      onChange={(e) => updateService(idx, { frequency: e.target.value })}
                      className={inputClass}
                      placeholder="例: 週3回"
                    />
                  </Field>
                  <Field label="時間帯">
                    <input
                      type="text"
                      value={svc.time_range}
                      onChange={(e) => updateService(idx, { time_range: e.target.value })}
                      className={inputClass}
                      placeholder="例: 9:00-9:45"
                    />
                  </Field>
                </div>
                <div className="mt-2">
                  <Field label="具体的内容">
                    <textarea
                      value={svc.content}
                      onChange={(e) => updateService(idx, { content: e.target.value })}
                      className={textareaClass}
                      placeholder="例: 全身清拭、更衣、口腔ケア、排泄介助"
                    />
                  </Field>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* 特記事項 */}
        <Section title="特記事項">
          <Field label="">
            <textarea
              value={plan.special_notes}
              onChange={(e) => updateField("special_notes", e.target.value)}
              className={textareaClass}
              placeholder="留意事項 / 緊急時対応 / 他職種との連携 など"
            />
          </Field>
        </Section>

        {/* 利用者同意 */}
        <Section title="利用者同意">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="同意日">
              <input
                type="date"
                value={plan.user_consent_date ?? ""}
                onChange={(e) => updateField("user_consent_date", e.target.value || null)}
                className={inputClass}
              />
            </Field>
            <Field label="同意者名">
              <input
                type="text"
                value={plan.user_consent_name}
                onChange={(e) => updateField("user_consent_name", e.target.value)}
                className={inputClass}
                placeholder="本人 / 代理人氏名"
              />
            </Field>
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
