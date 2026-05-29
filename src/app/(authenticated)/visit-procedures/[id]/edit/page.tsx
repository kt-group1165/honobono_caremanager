"use client";

/**
 * 訪問介護 手順書 詳細/編集 page
 *
 * - URL: /visit-procedures/[id]
 *   - id = "new" の時は空テンプレで新規作成
 *   - それ以外は既存 document をロード
 * - 2 タブ:
 *   - 手順 (編集可): 週次表 + サービス毎 ステップ
 *   - モジュール (read-only): 5 分刻みグリッドで step を帯表示
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, BookOpen, Plus, Trash2, Save, Loader2, AlertCircle, Layers, LayoutGrid } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { getDocument, saveDocument } from "@/lib/visit-procedure/queries";
import {
  emptyDocument,
  SERVICE_NOS,
  VISIT_SERVICE_KINDS,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  type VisitProcedureDocument,
  type VisitProcedureService,
  type VisitProcedureStep,
  type WeekdayKey,
} from "@/lib/visit-procedure/types";

type Tab = "procedure" | "module";

// 5 分刻みの time options: 06:00 〜 22:00
const TIME_OPTIONS: string[] = (() => {
  const out: string[] = [];
  for (let h = 6; h <= 22; h++) {
    for (let m = 0; m < 60; m += 5) {
      if (h === 22 && m > 0) break;
      out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return out;
})();

/** "HH:MM-HH:MM" を { start, end } に parse (失敗時は空文字) */
function parseTimeRange(s: string | null | undefined): { start: string; end: string } {
  if (!s) return { start: "", end: "" };
  const m = /^(\d{1,2}[:：]\d{1,2})\s*[-〜~]\s*(\d{1,2}[:：]\d{1,2})$/.exec(s);
  if (!m) return { start: "", end: "" };
  const norm = (t: string) => {
    const mm = /^(\d{1,2})[:：](\d{1,2})$/.exec(t);
    if (!mm) return "";
    return `${String(Number(mm[1])).padStart(2, "0")}:${String(Number(mm[2])).padStart(2, "0")}`;
  };
  return { start: norm(m[1]), end: norm(m[2]) };
}

/** 開始/終了 5 分刻み select コンポーネント */
function TimeRangeSelect({
  value,
  onChange,
  size = "sm",
}: {
  value: string;
  onChange: (v: string) => void;
  size?: "xs" | "sm";
}) {
  const { start, end } = parseTimeRange(value);
  const emit = (s: string, e: string) => onChange(s && e ? `${s}-${e}` : s || e ? `${s}-${e}` : "");
  const cls = size === "xs"
    ? "rounded border border-gray-200 px-1 py-1 text-xs bg-white"
    : "rounded border border-gray-200 px-1.5 py-1 text-xs bg-white";
  return (
    <div className="flex items-center gap-0.5">
      <select value={start} onChange={(ev) => emit(ev.target.value, end)} className={cls}>
        <option value="">--</option>
        {TIME_OPTIONS.map((t) => <option key={`s-${t}`} value={t}>{t}</option>)}
      </select>
      <span className="text-gray-400 text-xs">〜</span>
      <select value={end} onChange={(ev) => emit(start, ev.target.value)} className={cls}>
        <option value="">--</option>
        {TIME_OPTIONS.map((t) => <option key={`e-${t}`} value={t}>{t}</option>)}
      </select>
    </div>
  );
}

export default function VisitProcedureDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "new";
  const supabase = useMemo(() => createClient(), []);
  const { businessType, currentOffice, loading: btLoading } = useBusinessType();
  const [tab, setTab] = useState<Tab>("procedure");
  const [doc, setDoc] = useState<VisitProcedureDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const tenantId = currentOffice?.tenant_id ?? null;
  const officeId = currentOffice?.id ?? null;

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount-time async fetch (HANDOVER §2) */
    if (btLoading) return;
    if (!tenantId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        if (id === "new") {
          if (!cancelled) setDoc(emptyDocument(tenantId, officeId));
        } else {
          const found = await getDocument(supabase, id);
          if (!cancelled) {
            if (!found) {
              toast.error("手順書が見つかりません");
              router.push("/visit-procedures");
              return;
            }
            // services が 5 つ未満なら空 service で埋める (UI 上常に 5 表示)
            const filledServices = SERVICE_NOS.map((no) => {
              const existing = found.services.find((s) => s.service_no === no);
              return existing ?? { service_no: no, time_range: "", service_kind: "" as const, special_notes: "", steps: [] };
            });
            setDoc({ ...found, services: filledServices });
          }
        }
      } catch (err) {
        console.error(err);
        toast.error("読込失敗: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
    /* eslint-enable react-hooks/set-state-in-effect */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- id/tenantId 変化のみで再 load
  }, [id, tenantId, btLoading]);

  if (!btLoading && businessType !== "訪問介護") {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">手順書</h1>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-800 flex items-start gap-3">
          <AlertCircle size={20} className="shrink-0 mt-0.5" />
          <p className="font-medium">この機能は訪問介護モード専用です</p>
        </div>
      </div>
    );
  }

  if (loading || !doc) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        <Loader2 size={20} className="animate-spin mr-2" />
        読込中...
      </div>
    );
  }

  // ── doc state 更新 helper ──
  const updateDoc = (patch: Partial<VisitProcedureDocument>) =>
    setDoc((prev) => (prev ? { ...prev, ...patch } : prev));


  const updateService = (no: number, patch: Partial<VisitProcedureService>) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => (s.service_no === no ? { ...s, ...patch } : s));
      // 時間 / 区分 が変わったら、当該サービスを使っている全曜日セルにも propagate
      const ws = { ...(prev.weekly_schedule ?? {}) };
      const updated = services.find((s) => s.service_no === no);
      if (updated) {
        for (const day of WEEKDAY_KEYS) {
          const dayMap = { ...(ws[day] ?? {}) };
          if (dayMap[String(no)]) {
            dayMap[String(no)] = {
              time_range: updated.time_range ?? "",
              service_kind: (updated.service_kind || "") as never,
            };
            ws[day] = dayMap;
          }
        }
      }
      return { ...prev, services, weekly_schedule: ws };
    });
  };

  /** サービス no がどの曜日に設定されてるか */
  const getServiceDays = (doc: VisitProcedureDocument, svcNo: number): Set<WeekdayKey> => {
    const days = new Set<WeekdayKey>();
    for (const day of WEEKDAY_KEYS) {
      const cell = doc.weekly_schedule?.[day]?.[String(svcNo)];
      if (cell?.time_range || cell?.service_kind) days.add(day);
    }
    return days;
  };

  /** 曜日チップトグル: そのサービスをその曜日に追加/削除 */
  const toggleServiceDay = (svcNo: number, day: WeekdayKey) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const svc = prev.services.find((s) => s.service_no === svcNo);
      if (!svc) return prev;
      const ws = { ...(prev.weekly_schedule ?? {}) };
      const dayMap = { ...(ws[day] ?? {}) };
      if (dayMap[String(svcNo)]?.time_range || dayMap[String(svcNo)]?.service_kind) {
        delete dayMap[String(svcNo)];
      } else {
        dayMap[String(svcNo)] = {
          time_range: svc.time_range ?? "",
          service_kind: (svc.service_kind || "") as never,
        };
      }
      ws[day] = dayMap;
      return { ...prev, weekly_schedule: ws };
    });
  };

  const updateStep = (svcNo: number, stepIdx: number, patch: Partial<VisitProcedureStep>) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => {
        if (s.service_no !== svcNo) return s;
        const steps = s.steps.map((st, i) => (i === stepIdx ? { ...st, ...patch } : st));
        return { ...s, steps };
      });
      return { ...prev, services };
    });
  };

  const addStep = (svcNo: number) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => {
        if (s.service_no !== svcNo) return s;
        const nextStepNo = s.steps.length + 1;
        return {
          ...s,
          steps: [...s.steps, { step_no: nextStepNo, content: "", minutes: 5, detail: "" }],
        };
      });
      return { ...prev, services };
    });
  };

  const removeStep = (svcNo: number, stepIdx: number) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => {
        if (s.service_no !== svcNo) return s;
        const steps = s.steps.filter((_, i) => i !== stepIdx).map((st, i) => ({ ...st, step_no: i + 1 }));
        return { ...s, steps };
      });
      return { ...prev, services };
    });
  };

  // ── 保存 ──
  const handleSave = async () => {
    if (!doc) return;
    if (!doc.client_name.trim()) {
      toast.error("利用者氏名を入力してください");
      return;
    }
    if (!doc.plan_start_date) {
      toast.error("計画開始日を入力してください");
      return;
    }
    setSaving(true);
    try {
      const newId = await saveDocument(supabase, doc);
      toast.success("手順書を保存しました");
      if (id === "new") {
        router.replace(`/visit-procedures/${newId}`);
      } else {
        setDoc((prev) => (prev ? { ...prev, id: newId } : prev));
      }
    } catch (err) {
      console.error(err);
      toast.error("保存失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── ヘッダ ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/visit-procedures/${id}`} className="text-gray-400 hover:text-gray-600" title="プレビューに戻る">
            <ArrowLeft size={20} />
          </Link>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <BookOpen size={22} className="text-green-600" />
            編集: {doc.client_name || "(無題)"}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/visit-procedures/${id}`}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            プレビュー
          </Link>
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            保存
          </button>
        </div>
      </div>

      {/* ── 基本情報 (両タブで共通表示) ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <div>
          <label className="text-xs text-gray-500 mb-1 block">利用者氏名 *</label>
          <input
            type="text"
            value={doc.client_name}
            onChange={(e) => updateDoc({ client_name: e.target.value })}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">計画開始日 *</label>
          <input
            type="date"
            value={doc.plan_start_date}
            onChange={(e) => updateDoc({ plan_start_date: e.target.value })}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">計画終了日</label>
          <input
            type="date"
            value={doc.plan_end_date ?? ""}
            onChange={(e) => updateDoc({ plan_end_date: e.target.value || null })}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">サービス提供責任者</label>
          <input
            type="text"
            value={doc.author_name ?? ""}
            onChange={(e) => updateDoc({ author_name: e.target.value })}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">作成理由</label>
          <input
            type="text"
            value={doc.creation_reason ?? ""}
            onChange={(e) => updateDoc({ creation_reason: e.target.value })}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="短期目標更新の為 / 入浴介助追加 / 掃除手順変更 等"
          />
        </div>
      </div>

      {/* ── タブ切替 ── */}
      <div className="flex gap-1 border-b border-gray-200">
        <button
          onClick={() => setTab("procedure")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "procedure"
              ? "border-green-600 text-green-700"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          <Layers size={16} />
          手順
        </button>
        <button
          onClick={() => setTab("module")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "module"
              ? "border-green-600 text-green-700"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          <LayoutGrid size={16} />
          モジュール
        </button>
      </div>

      {tab === "procedure" ? (
        <ProcedureTab
          doc={doc}
          onDocChange={updateDoc}
          onServiceChange={updateService}
          onStepChange={updateStep}
          onStepAdd={addStep}
          onStepRemove={removeStep}
          getServiceDays={(svcNo) => getServiceDays(doc, svcNo)}
          onToggleServiceDay={toggleServiceDay}
        />
      ) : (
        <ModuleTab doc={doc} />
      )}
    </div>
  );
}

// =====================================================================
// 手順 タブ
// =====================================================================

function ProcedureTab({
  doc,
  onDocChange,
  onServiceChange,
  onStepChange,
  onStepAdd,
  onStepRemove,
  getServiceDays,
  onToggleServiceDay,
}: {
  doc: VisitProcedureDocument;
  onDocChange: (patch: Partial<VisitProcedureDocument>) => void;
  onServiceChange: (no: number, patch: Partial<VisitProcedureService>) => void;
  onStepChange: (svcNo: number, stepIdx: number, patch: Partial<VisitProcedureStep>) => void;
  onStepAdd: (svcNo: number) => void;
  onStepRemove: (svcNo: number, stepIdx: number) => void;
  getServiceDays: (svcNo: number) => Set<WeekdayKey>;
  onToggleServiceDay: (svcNo: number, day: WeekdayKey) => void;
}) {
  return (
    <div className="space-y-6">
      {/* ── サマリ (現在の週次概観、read-only) ── */}
      <section className="rounded-lg border border-gray-200 bg-white">
        <h2 className="px-3 py-2 border-b border-gray-200 text-sm font-semibold text-gray-700 bg-gray-50">
          週次サービス サマリ
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse table-fixed">
            <colgroup>
              <col className="w-12" />
              {SERVICE_NOS.map((no) => <col key={no} />)}
            </colgroup>
            <thead>
              <tr className="bg-gray-50 text-gray-600">
                <th className="px-2 py-1.5 border border-gray-200 text-center">曜日</th>
                {SERVICE_NOS.map((no) => (
                  <th key={no} className="px-2 py-1.5 border border-gray-200 text-center">サービス{no}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WEEKDAY_KEYS.map((day) => (
                <tr key={day} className="border-t border-gray-200">
                  <td className="px-2 py-1 border border-gray-200 text-center font-medium bg-gray-50">
                    {WEEKDAY_LABELS[day]}
                  </td>
                  {SERVICE_NOS.map((no) => {
                    const c = doc.weekly_schedule?.[day]?.[String(no)] ?? {};
                    const hasContent = c.time_range || c.service_kind;
                    return (
                      <td key={no} className="px-2 py-1 border border-gray-200 align-middle">
                        {hasContent ? (
                          <div className="flex items-baseline justify-center gap-3">
                            <span className="text-gray-800 tabular-nums text-right" style={{ width: "6rem" }}>{c.time_range || "—"}</span>
                            <span className="text-gray-500 text-left" style={{ minWidth: "5rem" }}>{c.service_kind || ""}</span>
                          </div>
                        ) : (
                          <span className="block text-gray-300 text-center">&nbsp;</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-3 py-1.5 text-[11px] text-gray-500 border-t border-gray-200 bg-gray-50">
          ※ 下の各サービスの「実施曜日」チップで月〜日を選択するとここに反映されます
        </p>
      </section>

      {/* ── 全体 特記事項 ── */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <label className="text-sm font-semibold text-gray-700 mb-2 block">特記事項 (全体)</label>
        <textarea
          value={doc.special_notes ?? ""}
          onChange={(e) => onDocChange({ special_notes: e.target.value })}
          rows={2}
          className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
      </section>

      {/* ── サービス①〜⑤ ── */}
      {doc.services.map((svc) => {
        const days = getServiceDays(svc.service_no);
        return (
        <section key={svc.service_no} className="rounded-lg border border-gray-200 bg-white">
          <div className="px-3 sm:px-4 py-2.5 border-b border-gray-200 bg-gray-50 space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              <h3 className="text-sm font-semibold text-gray-700">サービス{svc.service_no}</h3>
              <TimeRangeSelect
                value={svc.time_range ?? ""}
                onChange={(v) => onServiceChange(svc.service_no, { time_range: v })}
                size="sm"
              />
              <select
                value={svc.service_kind ?? ""}
                onChange={(e) => onServiceChange(svc.service_no, { service_kind: e.target.value as never })}
                className="rounded border border-gray-300 px-2 py-1 text-xs font-normal w-32 bg-white"
              >
                <option value="">区分 --</option>
                {VISIT_SERVICE_KINDS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-xs text-gray-500 mr-1">実施曜日:</span>
              {WEEKDAY_KEYS.map((day) => {
                const on = days.has(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => onToggleServiceDay(svc.service_no, day)}
                    className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-xs font-medium transition ${
                      on ? "bg-green-600 text-white" : "bg-white text-gray-500 border border-gray-300 hover:bg-gray-100"
                    }`}
                  >
                    {WEEKDAY_LABELS[day]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="p-3 sm:p-4 space-y-3">
            {/* PC: 横並び table */}
            <table className="hidden sm:table w-full text-xs">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-2 py-1.5 border border-gray-200 w-32">サービス内容</th>
                  <th className="px-2 py-1.5 border border-gray-200 w-20">時間(分)</th>
                  <th className="px-2 py-1.5 border border-gray-200">具体的取り組内容及び手順</th>
                  <th className="px-2 py-1.5 border border-gray-200 w-12"></th>
                </tr>
              </thead>
              <tbody>
                {svc.steps.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-center text-gray-400 italic">
                      ステップ未登録
                    </td>
                  </tr>
                ) : (
                  svc.steps.map((step, idx) => (
                    <tr key={idx} className="border-t border-gray-200">
                      <td className="px-1 py-1 border border-gray-200">
                        <input
                          type="text"
                          value={step.content}
                          onChange={(e) => onStepChange(svc.service_no, idx, { content: e.target.value })}
                          className="w-full rounded border border-gray-200 px-1.5 py-1 text-xs"
                        />
                      </td>
                      <td className="px-1 py-1 border border-gray-200">
                        <select
                          value={step.minutes}
                          onChange={(e) => onStepChange(svc.service_no, idx, { minutes: Number(e.target.value) })}
                          className="w-full rounded border border-gray-200 px-1.5 py-1 text-xs text-right tabular-nums bg-white"
                        >
                          {Array.from({ length: 25 }, (_, i) => i * 5).map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-1 py-1 border border-gray-200">
                        <textarea
                          value={step.detail ?? ""}
                          rows={1}
                          onChange={(e) => onStepChange(svc.service_no, idx, { detail: e.target.value })}
                          className="w-full rounded border border-gray-200 px-1.5 py-1 text-xs resize-y"
                        />
                      </td>
                      <td className="px-1 py-1 border border-gray-200 text-center">
                        <button
                          onClick={() => onStepRemove(svc.service_no, idx)}
                          className="text-red-500 hover:bg-red-50 rounded p-1"
                          aria-label="ステップ削除"
                          title="ステップ削除"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {/* SP: カード式 */}
            <div className="sm:hidden space-y-3">
              {svc.steps.length === 0 ? (
                <p className="text-xs text-gray-400 italic text-center py-2">ステップ未登録</p>
              ) : (
                svc.steps.map((step, idx) => (
                  <div key={idx} className="rounded border border-gray-200 bg-white p-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        placeholder="サービス内容"
                        value={step.content}
                        onChange={(e) => onStepChange(svc.service_no, idx, { content: e.target.value })}
                        className="flex-1 min-w-0 rounded border border-gray-200 px-2 py-1.5 text-sm"
                      />
                      <select
                        value={step.minutes}
                        onChange={(e) => onStepChange(svc.service_no, idx, { minutes: Number(e.target.value) })}
                        className="shrink-0 w-20 rounded border border-gray-200 px-1.5 py-1.5 text-sm text-right tabular-nums bg-white"
                      >
                        {Array.from({ length: 25 }, (_, i) => i * 5).map((m) => (
                          <option key={m} value={m}>{m}分</option>
                        ))}
                      </select>
                      <button
                        onClick={() => onStepRemove(svc.service_no, idx)}
                        className="shrink-0 text-red-500 hover:bg-red-50 rounded p-1.5"
                        aria-label="ステップ削除"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <textarea
                      placeholder="具体的取り組内容及び手順"
                      value={step.detail ?? ""}
                      rows={2}
                      onChange={(e) => onStepChange(svc.service_no, idx, { detail: e.target.value })}
                      className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm resize-y"
                    />
                  </div>
                ))
              )}
            </div>
            <button
              onClick={() => onStepAdd(svc.service_no)}
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
            >
              <Plus size={12} />
              ステップ追加
            </button>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">サービス{svc.service_no} 特記事項</label>
              <textarea
                value={svc.special_notes ?? ""}
                onChange={(e) => onServiceChange(svc.service_no, { special_notes: e.target.value })}
                rows={2}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs"
              />
            </div>
          </div>
        </section>
        );
      })}
    </div>
  );
}

// =====================================================================
// モジュール タブ (5 分刻みグリッド、read-only)
// =====================================================================

function ModuleTab({ doc }: { doc: VisitProcedureDocument }) {
  // 18 列 (5 分 × 18 = 90 分)
  const COLS = Array.from({ length: 18 }, (_, i) => (i + 1) * 5);
  // サービス毎の色 (5 種類)
  const SERVICE_COLORS = [
    "bg-blue-200",
    "bg-emerald-200",
    "bg-amber-200",
    "bg-rose-200",
    "bg-violet-200",
  ];

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        5 分刻みでサービス毎のステップを帯表示。手順タブで編集してください。
      </p>
      {doc.services.map((svc, svcIdx) => {
        // ステップを開始分 (累積) で位置決め
        let cursor = 0;
        const bands = svc.steps.map((st) => {
          const start = cursor;
          const len = Math.max(0, Math.floor(st.minutes));
          cursor += len;
          return { ...st, start, len };
        });
        const total = cursor;
        const cellW = 28; // 1 列 ≒ 5 分 ≒ 28 px

        return (
          <section key={svc.service_no} className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="flex items-center gap-3 text-sm font-medium text-gray-700 mb-2">
              <span>サービス{svc.service_no}</span>
              <span className="text-xs text-gray-500">
                {svc.time_range || "(時間帯 未設定)"}
                {svc.service_kind ? ` / ${svc.service_kind}` : ""}
              </span>
              <span className="text-xs text-gray-400 ml-auto">合計 {total} 分</span>
            </div>
            {/* 列見出し */}
            <div className="overflow-x-auto">
              <div className="flex border-b border-gray-200 text-[10px] text-gray-500 mb-1" style={{ width: `${cellW * COLS.length + 120}px` }}>
                <div className="w-[120px] shrink-0 px-2">内容</div>
                {COLS.map((m) => (
                  <div key={m} className="text-center" style={{ width: `${cellW}px` }}>
                    {m}
                  </div>
                ))}
              </div>
              {/* ステップ帯 */}
              {bands.length === 0 ? (
                <div className="text-center text-xs text-gray-400 italic py-3">
                  ステップが未登録です
                </div>
              ) : (
                bands.map((b, i) => {
                  const startCols = Math.floor(b.start / 5);
                  const widthCols = Math.max(1, Math.floor(b.len / 5));
                  const leftPx = startCols * cellW;
                  const widthPx = widthCols * cellW;
                  return (
                    <div
                      key={i}
                      className="flex items-stretch border-t border-gray-100 relative"
                      style={{ width: `${cellW * COLS.length + 120}px`, minHeight: 26 }}
                    >
                      <div className="w-[120px] shrink-0 px-2 py-1 text-xs truncate" title={b.content}>
                        {b.content || `ステップ${i + 1}`}
                      </div>
                      <div className="relative" style={{ width: `${cellW * COLS.length}px` }}>
                        {/* グリッド線 */}
                        {COLS.map((m) => (
                          <div
                            key={m}
                            className="absolute top-0 bottom-0 border-r border-gray-100"
                            style={{ left: `${(m / 5 - 1) * cellW}px`, width: `${cellW}px` }}
                          />
                        ))}
                        {/* バー */}
                        <div
                          className={`absolute top-1 bottom-1 rounded ${SERVICE_COLORS[svcIdx % SERVICE_COLORS.length]} flex items-center justify-center text-[10px] text-gray-700 px-1`}
                          style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                          title={`${b.content} (${b.len} 分)`}
                        >
                          {b.len > 0 ? `${b.len}分` : ""}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
