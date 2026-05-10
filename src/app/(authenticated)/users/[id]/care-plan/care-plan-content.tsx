"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Plus,
  Save,
  Trash2,
  Loader2,
  FileText,
  ClipboardList,
  CalendarDays,
  Activity,
  ExternalLink,
} from "lucide-react";
import type { CarePlan } from "@/types/database";

const STATUS_OPTIONS: CarePlan["status"][] = ["draft", "active", "completed", "cancelled"];

const STATUS_LABELS: Record<CarePlan["status"], string> = {
  draft: "下書き",
  active: "有効",
  completed: "完了",
  cancelled: "中止",
};

const STATUS_COLORS: Record<CarePlan["status"], string> = {
  draft: "bg-yellow-100 text-yellow-700",
  active: "bg-green-100 text-green-700",
  completed: "bg-gray-200 text-gray-600",
  cancelled: "bg-red-100 text-red-600",
};

interface CarePlanContentProps {
  userId: string;
  initialPlans: CarePlan[];
}

type FormState = {
  start_date: string;
  end_date: string;
  plan_type: string;
  status: CarePlan["status"];
  long_term_goals: string;
  short_term_goals: string;
};

const EMPTY_FORM: FormState = {
  start_date: "",
  end_date: "",
  plan_type: "居宅サービス計画",
  status: "active",
  long_term_goals: "",
  short_term_goals: "",
};

function planToForm(p: CarePlan): FormState {
  return {
    start_date: p.start_date ?? "",
    end_date: p.end_date ?? "",
    plan_type: p.plan_type ?? "居宅サービス計画",
    status: p.status,
    long_term_goals: p.long_term_goals ?? "",
    short_term_goals: p.short_term_goals ?? "",
  };
}

export function CarePlanContent({ userId, initialPlans }: CarePlanContentProps) {
  const supabase = useMemo(() => createClient(), []);
  const [plans, setPlans] = useState<CarePlan[]>(initialPlans);
  const [selectedId, setSelectedId] = useState<string | null>(initialPlans[0]?.id ?? null);
  const [form, setForm] = useState<FormState>(
    initialPlans[0] ? planToForm(initialPlans[0]) : EMPTY_FORM,
  );
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const selected = plans.find((p) => p.id === selectedId) ?? null;

  const reload = async () => {
    const { data } = await supabase
      .from("kaigo_care_plans")
      .select("*")
      .eq("user_id", userId)
      .order("start_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
    const next = (data ?? []) as CarePlan[];
    setPlans(next);
    if (next.length === 0) {
      setSelectedId(null);
      setForm(EMPTY_FORM);
    } else if (!next.some((p) => p.id === selectedId)) {
      setSelectedId(next[0].id);
      setForm(planToForm(next[0]));
    }
  };

  const handleSelect = (p: CarePlan) => {
    setSelectedId(p.id);
    setForm(planToForm(p));
  };

  const handleNew = async () => {
    setCreating(true);
    try {
      const today = new Date().toISOString().split("T")[0];
      // 既存 active を draft 候補にしたければ手動で変更してもらう (自動 close はしない)
      const { data, error } = await supabase
        .from("kaigo_care_plans")
        .insert({
          user_id: userId,
          plan_number: "",
          plan_type: "居宅サービス計画",
          start_date: today,
          end_date: null,
          long_term_goals: "",
          short_term_goals: "",
          status: "draft",
        })
        .select()
        .single();
      if (error) throw error;
      const created = data as CarePlan;
      setPlans((prev) => [created, ...prev]);
      setSelectedId(created.id);
      setForm(planToForm(created));
      toast.success("ケアプランを新規作成しました");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("作成に失敗: " + msg);
    } finally {
      setCreating(false);
    }
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const patch = {
        plan_type: form.plan_type || "居宅サービス計画",
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        status: form.status,
        long_term_goals: form.long_term_goals || null,
        short_term_goals: form.short_term_goals || null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase
        .from("kaigo_care_plans")
        .update(patch)
        .eq("id", selected.id);
      if (error) throw error;
      toast.success("保存しました");
      await reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("保存に失敗: " + msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!window.confirm("このケアプランを削除します。よろしいですか？")) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("kaigo_care_plans")
        .delete()
        .eq("id", selected.id);
      if (error) throw error;
      toast.success("削除しました");
      await reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("削除に失敗: " + msg);
    } finally {
      setDeleting(false);
    }
  };

  // 関連帳票へのクイックリンク (利用者を選択した状態で開く)
  const userParam = `?user=${encodeURIComponent(userId)}`;
  const relatedLinks: { label: string; href: string; icon: typeof FileText; note?: string }[] = [
    { label: "アセスメント", href: `/assessments${userParam}`, icon: ClipboardList },
    { label: "第1表 (居宅サービス計画書1)", href: `/reports/care-plan-1${userParam}`, icon: FileText },
    { label: "第2表 (居宅サービス計画書2)", href: `/reports/care-plan-2${userParam}`, icon: FileText },
    { label: "第3表 (週間サービス計画表)", href: `/reports/care-plan-3${userParam}`, icon: FileText },
    { label: "第4表 (担当者会議の要点)", href: `/meeting-minutes${userParam}`, icon: FileText },
    { label: "第5表 (居宅介護支援経過)", href: `/support-records${userParam}`, icon: FileText },
    { label: "第6表 (利用票・提供票)", href: `/reports/service-usage${userParam}`, icon: FileText, note: "受信実績の取込もここ" },
    { label: "第7表 (利用票別表)", href: `/reports/service-usage-detail${userParam}`, icon: FileText },
    { label: "モニタリング", href: `/monitoring${userParam}`, icon: Activity },
  ];

  return (
    <div className="space-y-4">
      {/* プラン一覧 + 新規作成 */}
      <div className="rounded-lg border bg-white shadow-sm">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
            <CalendarDays size={14} className="text-blue-600" />
            ケアプラン一覧 ({plans.length} 件)
          </h2>
          <button
            type="button"
            onClick={handleNew}
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            新規作成
          </button>
        </div>
        {plans.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-400">
            ケアプランがありません。「新規作成」で作成できます。
          </div>
        ) : (
          <div className="divide-y">
            {plans.map((p) => {
              const isSelected = p.id === selectedId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSelect(p)}
                  className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-gray-50 ${isSelected ? "bg-blue-50" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-800">{p.plan_type || "居宅サービス計画"}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLORS[p.status]}`}>
                        {STATUS_LABELS[p.status]}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-500">
                      期間: {p.start_date ?? "—"} 〜 {p.end_date ?? "—"}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 計画詳細 */}
      {selected && (
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">計画詳細</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting || saving}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                削除
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || deleting}
                className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                保存
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-gray-500">計画区分</label>
              <input
                type="text"
                value={form.plan_type}
                onChange={(e) => setForm((f) => ({ ...f, plan_type: e.target.value }))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                placeholder="居宅サービス計画"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">状態</label>
              <select
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as CarePlan["status"] }))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">開始日</label>
              <input
                type="date"
                value={form.start_date}
                onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">終了日</label>
              <input
                type="date"
                value={form.end_date}
                onChange={(e) => setForm((f) => ({ ...f, end_date: e.target.value }))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-gray-500">長期目標</label>
              <textarea
                rows={3}
                value={form.long_term_goals}
                onChange={(e) => setForm((f) => ({ ...f, long_term_goals: e.target.value }))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-gray-500">短期目標</label>
              <textarea
                rows={3}
                value={form.short_term_goals}
                onChange={(e) => setForm((f) => ({ ...f, short_term_goals: e.target.value }))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
          </div>
        </div>
      )}

      {/* 関連帳票クイックリンク */}
      <div className="rounded-lg border bg-white shadow-sm">
        <div className="border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
            <ExternalLink size={14} className="text-blue-600" />
            関連帳票・記録
          </h2>
          <p className="mt-0.5 text-[11px] text-gray-500">
            この利用者を選択した状態で各画面に遷移します
          </p>
        </div>
        <ul className="grid grid-cols-1 divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
          {relatedLinks.map((l, idx) => {
            const Icon = l.icon;
            const isLeftCol = idx % 2 === 0;
            return (
              <li
                key={l.href}
                className={`${idx >= 2 ? "md:border-t md:border-gray-200" : ""} ${isLeftCol ? "" : ""}`}
              >
                <Link
                  href={l.href}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-blue-50"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon size={14} className="shrink-0 text-gray-400" />
                    <span className="truncate text-gray-800">{l.label}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {l.note && (
                      <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                        {l.note}
                      </span>
                    )}
                    <ExternalLink size={12} className="text-gray-400" />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
