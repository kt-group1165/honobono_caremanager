"use client";

/**
 * 訪問介護 手順書 編集 page (v2: 2026-06-22 確定仕様)
 *
 * 構成:
 *  1. 基本情報 (利用者氏名 / 期間 / 作成者 / 作成理由)
 *  2. 週次サービス表 (編集可能化、各日 N 行、開始時刻のみ入力、終了は自動)
 *  3. 全体特記事項
 *  4. サービス①〜⑤ (種類 select 必須、step 行に複製ボタン、サービス間複製 dropdown)
 *
 * v2 変更:
 *  - サマリ表廃止 → 編集可 週次表に統合
 *  - 時間帯 input / 実施曜日 chip を廃止 (週次表で完結)
 *  - step 所要時間プルダウン上限は app_settings から動的取得
 *  - 24:00 跨ぎは 25:00 表記
 *  - 種類 未選択 service は保存 block
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, BookOpen, Plus, Trash2, Save, Loader2, AlertCircle, Copy, X } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import {
  getDocument,
  saveDocument,
  getStepDurationMax,
} from "@/lib/visit-procedure/queries";
import {
  emptyDocument,
  emptyWeeklyRow,
  SERVICE_NOS,
  VISIT_SERVICE_KINDS,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  WEEKLY_START_TIME_OPTIONS,
  buildStepDurationOptions,
  parseHHMM,
  formatHHMM,
  sumServiceMinutes,
  type VisitProcedureDocument,
  type VisitProcedureService,
  type VisitProcedureStep,
  type WeekdayKey,
  type WeeklyRow,
} from "@/lib/visit-procedure/types";

export default function VisitProcedureEditPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = params?.id ?? "new";
  const supabase = useMemo(() => createClient(), []);
  const { businessType, currentOffice, loading: btLoading } = useBusinessType();
  const [doc, setDoc] = useState<VisitProcedureDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [stepDurationMax, setStepDurationMax] = useState<number>(60);

  const tenantId = currentOffice?.tenant_id ?? null;
  const officeId = currentOffice?.id ?? null;
  const officeQuery = search?.get("office") ? `?office=${encodeURIComponent(search.get("office")!)}` : "";

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount-time async fetch */
    if (btLoading) return;
    if (!tenantId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        // step 所要時間プルダウン上限を取得 (失敗時は default 60)
        const max = await getStepDurationMax(supabase);
        if (!cancelled) setStepDurationMax(max);

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
              return existing ?? {
                service_no: no,
                service_kind: "" as const,
                special_notes: "",
                steps: [],
              };
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ── doc state 更新 helpers ──
  const updateDoc = (patch: Partial<VisitProcedureDocument>) =>
    setDoc((prev) => (prev ? { ...prev, ...patch } : prev));

  const updateService = (no: number, patch: Partial<VisitProcedureService>) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => (s.service_no === no ? { ...s, ...patch } : s));
      return { ...prev, services };
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

  /** step 行を複製 (= 次行に同内容で挿入) */
  const duplicateStep = (svcNo: number, stepIdx: number) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => {
        if (s.service_no !== svcNo) return s;
        const src = s.steps[stepIdx];
        if (!src) return s;
        const cloned: VisitProcedureStep = {
          step_no: stepIdx + 2,
          content: src.content,
          minutes: src.minutes,
          detail: src.detail,
        };
        const before = s.steps.slice(0, stepIdx + 1);
        const after = s.steps.slice(stepIdx + 1);
        const steps = [...before, cloned, ...after].map((st, i) => ({ ...st, step_no: i + 1 }));
        return { ...s, steps };
      });
      return { ...prev, services };
    });
  };

  /** サービス単位 複製 (= source の種類 + 特記 + steps を target に上書きコピー) */
  const duplicateServiceTo = (sourceNo: number, targetNo: number) => {
    if (!doc) return;
    const source = doc.services.find((s) => s.service_no === sourceNo);
    const target = doc.services.find((s) => s.service_no === targetNo);
    if (!source || !target) return;
    const hasContent = (target.service_kind && target.service_kind.length > 0) ||
      (target.special_notes && target.special_notes.length > 0) ||
      target.steps.length > 0;
    if (hasContent) {
      if (!confirm(`サービス${targetNo} は既に内容があります。上書きしますか？`)) return;
    }
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => {
        if (s.service_no !== targetNo) return s;
        return {
          ...s,
          service_kind: source.service_kind,
          special_notes: source.special_notes,
          steps: source.steps.map((st, i) => ({
            step_no: i + 1,
            content: st.content,
            minutes: st.minutes,
            detail: st.detail,
          })),
        };
      });
      return { ...prev, services };
    });
    toast.success(`サービス${sourceNo} → サービス${targetNo} に複製しました`);
  };

  // ── 週次表 操作 ──
  const updateWeeklyCell = (day: WeekdayKey, rowIdx: number, svcNo: number, patch: { start?: string } | null) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const ws = { ...(prev.weekly_schedule ?? {}) };
      const rows = [...(ws[day] ?? [emptyWeeklyRow()])];
      const row: WeeklyRow = { ...(rows[rowIdx] ?? emptyWeeklyRow()) };
      if (patch === null || !patch.start) {
        row[String(svcNo)] = null;
      } else {
        row[String(svcNo)] = { start: patch.start };
      }
      rows[rowIdx] = row;
      ws[day] = rows;
      return { ...prev, weekly_schedule: ws };
    });
  };

  const addWeeklyRow = (day: WeekdayKey) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const ws = { ...(prev.weekly_schedule ?? {}) };
      const rows = [...(ws[day] ?? []), emptyWeeklyRow()];
      ws[day] = rows;
      return { ...prev, weekly_schedule: ws };
    });
  };

  const removeWeeklyRow = (day: WeekdayKey, rowIdx: number) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const ws = { ...(prev.weekly_schedule ?? {}) };
      const rows = [...(ws[day] ?? [])];
      if (rows.length <= 1) {
        // 最低 1 行残す = 行内容をクリアするだけ
        ws[day] = [emptyWeeklyRow()];
      } else {
        rows.splice(rowIdx, 1);
        ws[day] = rows;
      }
      return { ...prev, weekly_schedule: ws };
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
    // 各サービス: 週次表で使われている / 特記あり / step ありの service は kind 必須
    const usedServiceNos = new Set<number>();
    for (const day of WEEKDAY_KEYS) {
      const rows = doc.weekly_schedule?.[day] ?? [];
      for (const row of rows) {
        for (const no of SERVICE_NOS) {
          if (row?.[String(no)]?.start) usedServiceNos.add(no);
        }
      }
    }
    for (const s of doc.services) {
      const hasContent = (s.special_notes && s.special_notes.trim().length > 0) || s.steps.length > 0;
      const used = usedServiceNos.has(s.service_no);
      if ((hasContent || used) && (!s.service_kind || s.service_kind.length === 0)) {
        toast.error(`サービス${s.service_no} の種類を選択してください`);
        return;
      }
    }
    setSaving(true);
    try {
      const newId = await saveDocument(supabase, doc);
      toast.success("手順書を保存しました");
      if (id === "new") {
        router.replace(`/visit-procedures/${newId}${officeQuery}`);
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

  const stepDurationOptions = buildStepDurationOptions(stepDurationMax);

  return (
    <div className="space-y-6">
      {/* ── ヘッダ ── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href={`/visit-procedures/${id}${officeQuery}`}
            className="text-gray-400 hover:text-gray-600 shrink-0"
            title="プレビューに戻る"
          >
            <ArrowLeft size={20} />
          </Link>
          <h1 className="text-base sm:text-xl font-bold text-gray-900 flex items-center gap-2 min-w-0">
            <BookOpen size={20} className="text-green-600 shrink-0" />
            <span className="truncate">編集: {doc.client_name || "(無題)"}</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/visit-procedures/${id}${officeQuery}`}
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

      {/* ── 基本情報 ── */}
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
            placeholder="短期目標更新の為 等"
          />
        </div>
      </div>

      {/* ── 週次サービス表 (編集可能) ── */}
      <WeeklyScheduleEditor
        doc={doc}
        onCellChange={updateWeeklyCell}
        onAddRow={addWeeklyRow}
        onRemoveRow={removeWeeklyRow}
      />

      {/* ── 全体 特記事項 ── */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <label className="text-sm font-semibold text-gray-700 mb-2 block">特記事項 (全体)</label>
        <textarea
          value={doc.special_notes ?? ""}
          onChange={(e) => updateDoc({ special_notes: e.target.value })}
          rows={2}
          className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
      </section>

      {/* ── サービス①〜⑤ ── */}
      {doc.services.map((svc) => (
        <ServiceEditor
          key={svc.service_no}
          svc={svc}
          stepDurationOptions={stepDurationOptions}
          onServiceChange={(patch) => updateService(svc.service_no, patch)}
          onStepChange={(idx, patch) => updateStep(svc.service_no, idx, patch)}
          onStepAdd={() => addStep(svc.service_no)}
          onStepRemove={(idx) => removeStep(svc.service_no, idx)}
          onStepDuplicate={(idx) => duplicateStep(svc.service_no, idx)}
          onDuplicateTo={(targetNo) => duplicateServiceTo(svc.service_no, targetNo)}
        />
      ))}
    </div>
  );
}

// =====================================================================
// 週次サービス表 (編集可能)
// =====================================================================
function WeeklyScheduleEditor({
  doc,
  onCellChange,
  onAddRow,
  onRemoveRow,
}: {
  doc: VisitProcedureDocument;
  onCellChange: (day: WeekdayKey, rowIdx: number, svcNo: number, patch: { start?: string } | null) => void;
  onAddRow: (day: WeekdayKey) => void;
  onRemoveRow: (day: WeekdayKey, rowIdx: number) => void;
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
        <h2 className="text-sm font-semibold text-gray-700">週次サービス表</h2>
        <p className="text-[11px] text-gray-500 mt-0.5">
          各曜日の開始時刻を入力すると、終了時刻は サービスの step 合計分から自動算出されます。24:00 跨ぎは 25:00 表記。
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-2 py-1.5 border border-gray-200 text-center w-12">曜日</th>
              {SERVICE_NOS.map((no) => {
                const svc = doc.services.find((s) => s.service_no === no);
                const kindLabel = svc?.service_kind ? svc.service_kind : "未設定";
                return (
                  <th key={no} className="px-2 py-1.5 border border-gray-200 text-center">
                    サービス{no} <span className="text-gray-400 font-normal">({kindLabel})</span>
                  </th>
                );
              })}
              <th className="px-2 py-1.5 border border-gray-200 text-center w-16">操作</th>
            </tr>
          </thead>
          <tbody>
            {WEEKDAY_KEYS.map((day) => {
              const rows = doc.weekly_schedule?.[day] ?? [emptyWeeklyRow()];
              return rows.map((row, rowIdx) => (
                <tr key={`${day}-${rowIdx}`} className="border-t border-gray-200">
                  {rowIdx === 0 && (
                    <td
                      className="px-2 py-1 border border-gray-200 text-center font-medium bg-gray-50 align-middle"
                      rowSpan={rows.length}
                    >
                      {WEEKDAY_LABELS[day]}
                    </td>
                  )}
                  {SERVICE_NOS.map((no) => {
                    const cell = row?.[String(no)] ?? null;
                    const svc = doc.services.find((s) => s.service_no === no);
                    const totalMin = sumServiceMinutes(svc);
                    const start = cell?.start ?? "";
                    const startMin = parseHHMM(start);
                    const endLabel = (() => {
                      if (!start || startMin === null) return "";
                      if (totalMin <= 0) return "";
                      return formatHHMM(startMin + totalMin);
                    })();
                    return (
                      <td key={no} className="px-1 py-1 border border-gray-200 align-middle">
                        <div className="flex items-center justify-center gap-1 flex-wrap">
                          <select
                            value={start}
                            onChange={(e) =>
                              onCellChange(day, rowIdx, no, e.target.value ? { start: e.target.value } : null)
                            }
                            className="rounded border border-gray-200 px-1 py-1 text-xs bg-white"
                            aria-label={`${WEEKDAY_LABELS[day]} サービス${no} 開始時刻`}
                          >
                            <option value="">--</option>
                            {WEEKLY_START_TIME_OPTIONS.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                          {endLabel && (
                            <span className="text-[10px] text-gray-500 tabular-nums whitespace-nowrap">
                              - {endLabel}
                              <span className="ml-0.5 text-gray-400">(自動)</span>
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                  <td className="px-1 py-1 border border-gray-200 text-center align-middle">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        type="button"
                        onClick={() => onRemoveRow(day, rowIdx)}
                        className="text-red-500 hover:bg-red-50 rounded p-1"
                        aria-label="この行を削除"
                        title={rows.length <= 1 ? "クリア" : "行を削除"}
                      >
                        <X size={12} />
                      </button>
                      {rowIdx === rows.length - 1 && (
                        <button
                          type="button"
                          onClick={() => onAddRow(day)}
                          className="text-green-600 hover:bg-green-50 rounded p-1"
                          aria-label="行追加"
                          title="この曜日に行を追加"
                        >
                          <Plus size={12} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// =====================================================================
// サービス editor (種類 + 特記 + step 行)
// =====================================================================
function ServiceEditor({
  svc,
  stepDurationOptions,
  onServiceChange,
  onStepChange,
  onStepAdd,
  onStepRemove,
  onStepDuplicate,
  onDuplicateTo,
}: {
  svc: VisitProcedureService;
  stepDurationOptions: number[];
  onServiceChange: (patch: Partial<VisitProcedureService>) => void;
  onStepChange: (idx: number, patch: Partial<VisitProcedureStep>) => void;
  onStepAdd: () => void;
  onStepRemove: (idx: number) => void;
  onStepDuplicate: (idx: number) => void;
  onDuplicateTo: (targetNo: number) => void;
}) {
  const [dupTarget, setDupTarget] = useState<string>("");
  const kindMissing = !svc.service_kind;
  const otherNos = SERVICE_NOS.filter((n) => n !== svc.service_no);

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <div className="px-3 sm:px-4 py-2.5 border-b border-gray-200 bg-gray-50 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-700">サービス{svc.service_no}</h3>
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-500">種類 *</label>
            <select
              value={svc.service_kind ?? ""}
              onChange={(e) => onServiceChange({ service_kind: e.target.value as never })}
              className={`rounded px-2 py-1 text-xs w-32 bg-white border ${
                kindMissing ? "border-red-400 ring-1 ring-red-200" : "border-gray-300"
              }`}
            >
              <option value="">-- 選択 --</option>
              {VISIT_SERVICE_KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
          {/* サービス複製 dropdown */}
          <div className="ml-auto flex items-center gap-1">
            <Copy size={12} className="text-gray-400" />
            <label className="text-xs text-gray-500">複製先</label>
            <select
              value={dupTarget}
              onChange={(e) => {
                const val = e.target.value;
                setDupTarget("");
                if (!val) return;
                const targetNo = Number(val);
                if (Number.isFinite(targetNo)) onDuplicateTo(targetNo);
              }}
              className="rounded border border-gray-300 px-2 py-1 text-xs bg-white"
              disabled={!svc.service_kind && svc.steps.length === 0}
              title={!svc.service_kind && svc.steps.length === 0 ? "複製元に内容がありません" : ""}
            >
              <option value="">-- 選択 --</option>
              {otherNos.map((n) => (
                <option key={n} value={n}>サービス{n} へ</option>
              ))}
            </select>
          </div>
        </div>
        {kindMissing && (
          <div className="text-[11px] text-red-600 flex items-center gap-1">
            <AlertCircle size={12} />
            種類が未選択です。保存前に選択してください。
          </div>
        )}
      </div>

      <div className="p-3 sm:p-4 space-y-3">
        {/* PC: 横並び table */}
        <table className="hidden sm:table w-full text-xs">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-2 py-1.5 border border-gray-200 w-32 text-left">サービス内容</th>
              <th className="px-2 py-1.5 border border-gray-200 w-20 text-right">時間(分)</th>
              <th className="px-2 py-1.5 border border-gray-200 text-left">具体的取り組内容及び手順</th>
              <th className="px-2 py-1.5 border border-gray-200 w-20"></th>
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
                      onChange={(e) => onStepChange(idx, { content: e.target.value })}
                      className="w-full rounded border border-gray-200 px-1.5 py-1 text-xs"
                    />
                  </td>
                  <td className="px-1 py-1 border border-gray-200">
                    <select
                      value={step.minutes}
                      onChange={(e) => onStepChange(idx, { minutes: Number(e.target.value) })}
                      className="w-full rounded border border-gray-200 px-1.5 py-1 text-xs text-right tabular-nums bg-white"
                    >
                      {/* current 値が options 外なら option として追加 (= 上限変更で取り残された値) */}
                      {!stepDurationOptions.includes(step.minutes) && step.minutes > 0 && (
                        <option value={step.minutes}>{step.minutes}</option>
                      )}
                      {stepDurationOptions.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-1 py-1 border border-gray-200">
                    <textarea
                      value={step.detail ?? ""}
                      rows={1}
                      onChange={(e) => onStepChange(idx, { detail: e.target.value })}
                      className="w-full rounded border border-gray-200 px-1.5 py-1 text-xs resize-y"
                    />
                  </td>
                  <td className="px-1 py-1 border border-gray-200 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        type="button"
                        onClick={() => onStepDuplicate(idx)}
                        className="text-blue-500 hover:bg-blue-50 rounded p-1"
                        aria-label="この step を複製"
                        title="この step を複製"
                      >
                        <Copy size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onStepRemove(idx)}
                        className="text-red-500 hover:bg-red-50 rounded p-1"
                        aria-label="ステップ削除"
                        title="ステップ削除"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
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
                    onChange={(e) => onStepChange(idx, { content: e.target.value })}
                    className="flex-1 min-w-0 rounded border border-gray-200 px-2 py-1.5 text-sm"
                  />
                  <select
                    value={step.minutes}
                    onChange={(e) => onStepChange(idx, { minutes: Number(e.target.value) })}
                    className="shrink-0 w-20 rounded border border-gray-200 px-1.5 py-1.5 text-sm text-right tabular-nums bg-white"
                  >
                    {!stepDurationOptions.includes(step.minutes) && step.minutes > 0 && (
                      <option value={step.minutes}>{step.minutes}分</option>
                    )}
                    {stepDurationOptions.map((m) => (
                      <option key={m} value={m}>{m}分</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => onStepDuplicate(idx)}
                    className="shrink-0 text-blue-500 hover:bg-blue-50 rounded p-1.5"
                    aria-label="この step を複製"
                    title="この step を複製"
                  >
                    <Copy size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onStepRemove(idx)}
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
                  onChange={(e) => onStepChange(idx, { detail: e.target.value })}
                  className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm resize-y"
                />
              </div>
            ))
          )}
        </div>

        <button
          type="button"
          onClick={onStepAdd}
          className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
        >
          <Plus size={12} />
          ステップ追加
        </button>

        <div>
          <label className="text-xs text-gray-500 mb-1 block">サービス{svc.service_no} 特記事項</label>
          <textarea
            value={svc.special_notes ?? ""}
            onChange={(e) => onServiceChange({ special_notes: e.target.value })}
            rows={2}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs"
          />
        </div>

        {/* 合計時間表示 */}
        <div className="text-[11px] text-gray-500 text-right">
          合計 {sumServiceMinutes(svc)} 分
          <span className="ml-2 text-gray-400">
            (= 週次表で開始時刻入力時の自動算出に使用)
          </span>
        </div>
      </div>
    </section>
  );
}
