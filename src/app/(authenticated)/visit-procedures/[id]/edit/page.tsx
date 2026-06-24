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

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, BookOpen, Plus, Trash2, Save, Loader2, AlertCircle, Copy, X, ChevronUp, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import {
  getDocument,
  saveDocument,
  getStepDurationMax,
  getStepTemplates,
  createStepTemplate,
} from "@/lib/visit-procedure/queries";
import {
  emptyDocument,
  emptyWeeklyRow,
  SERVICE_NOS,
  STEP_TEMPLATE_CATEGORIES,
  VISIT_SERVICE_KINDS,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  WEEKLY_HOUR_OPTIONS,
  WEEKLY_MINUTE_OPTIONS,
  buildStepDurationOptions,
  parseHHMM,
  formatHHMM,
  sumServiceMinutes,
  type StepTemplateCategory,
  type VisitProcedureDocument,
  type VisitProcedureService,
  type VisitProcedureStep,
  type VisitProcedureStepTemplate,
  type WeekdayKey,
  type WeeklyRow,
  type WeeklySchedule,
} from "@/lib/visit-procedure/types";

// ── step rows auto-extend ロジック ─────────────────────────────────────
// 仕様 (2026-06-22 user 確定):
//   - 上限 12 行
//   - default 3 行表示
//   - 末尾の空行が 1 行以下になったら自動で空行を追加 → 常に 2 行の空行が末尾に残る
//   - 12 行に達したら自動追加停止
const STEP_CAP = 12;
const STEP_DEFAULT = 3;
const STEP_TRAILING_EMPTY = 2;

function isEmptyStep(s: VisitProcedureStep): boolean {
  return (!s.content || !s.content.trim()) && (!s.detail || !s.detail.trim());
}

function makeEmptyStep(stepNo: number): VisitProcedureStep {
  return { step_no: stepNo, content: "", minutes: 5, detail: "" };
}

/**
 * steps を normalize: 末尾空行を 2 行に揃える (12 上限)、最低 3 行。
 * 入力途中の row 数増減で focus が消えないよう、末尾追加 / 末尾削除のみ行う。
 */
function normalizeSteps(steps: VisitProcedureStep[]): VisitProcedureStep[] {
  let result = [...steps];
  // 末尾の空行数を数える
  const countTrailing = () => {
    let n = 0;
    for (let i = result.length - 1; i >= 0; i--) {
      if (isEmptyStep(result[i])) n++;
      else break;
    }
    return n;
  };
  // 末尾空行が 2 を超えていれば trim (= 但し default 3 行は確保)
  while (countTrailing() > STEP_TRAILING_EMPTY && result.length > STEP_DEFAULT) {
    result = result.slice(0, -1);
  }
  // 末尾空行が 2 未満かつ 12 未満ならば追加
  while (countTrailing() < STEP_TRAILING_EMPTY && result.length < STEP_CAP) {
    result = [...result, makeEmptyStep(result.length + 1)];
  }
  // default 3 行未満は強制で埋める (= 新規 doc 等)
  while (result.length < STEP_DEFAULT) {
    result = [...result, makeEmptyStep(result.length + 1)];
  }
  return result.map((st, i) => ({ ...st, step_no: i + 1 }));
}

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
  const [stepTemplates, setStepTemplates] = useState<VisitProcedureStepTemplate[]>([]);
  // dirty 追跡: ユーザ編集で true、save 成功で false に戻す。離脱時の警告に使用。
  const [dirty, setDirty] = useState(false);

  // beforeunload: タブ閉じ・リロード時に警告 (= browser native dialog)
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome 等は returnValue を要求
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // back ボタン / Link click をインターセプトする共通 helper
  const confirmLeaveIfDirty = (): boolean => {
    if (!dirty) return true;
    return window.confirm("未保存の変更があります。保存しないで戻りますか？\n（OK で破棄して戻る／キャンセルで編集を続ける）");
  };

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
          if (!cancelled) {
            const blank = emptyDocument(tenantId, officeId);
            // 新規 doc も steps を normalize (= default 3 行表示)
            const normalized = {
              ...blank,
              services: blank.services.map((s) => ({ ...s, steps: normalizeSteps(s.steps) })),
            };
            setDoc(normalized);
          }
        } else {
          const found = await getDocument(supabase, id);
          if (!cancelled) {
            if (!found) {
              toast.error("手順書が見つかりません");
              router.push("/visit-procedures");
              return;
            }
            // services が 5 つ未満なら空 service で埋める (UI 上常に 5 表示)
            // また各 service の steps は normalize (= 末尾空行 2 行確保、最低 3 行、12 上限)
            const filledServices = SERVICE_NOS.map((no) => {
              const existing = found.services.find((s) => s.service_no === no);
              const base = existing ?? {
                service_no: no,
                service_kind: "" as const,
                special_notes: "",
                steps: [],
              };
              return { ...base, steps: normalizeSteps(base.steps) };
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

  // step テンプレート (= office ごとの サービス内容 + 取り組内容 master) を取得
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount-time async fetch */
    if (btLoading) return;
    if (!officeId) {
      setStepTemplates([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rows = await getStepTemplates(supabase, officeId);
        if (!cancelled) setStepTemplates(rows);
      } catch (err) {
        // テンプレートは補助機能なので失敗しても save flow は止めない
        console.warn("step テンプレート読込失敗:", err instanceof Error ? err.message : err);
        if (!cancelled) setStepTemplates([]);
      }
    })();
    return () => { cancelled = true; };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [supabase, officeId, btLoading]);

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
  const updateDoc = (patch: Partial<VisitProcedureDocument>) => {
    setDirty(true);
    setDoc((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateService = (no: number, patch: Partial<VisitProcedureService>) => {
    setDirty(true);
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => (s.service_no === no ? { ...s, ...patch } : s));
      return { ...prev, services };
    });
  };

  const updateStep = (svcNo: number, stepIdx: number, patch: Partial<VisitProcedureStep>) => {
    setDirty(true);
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => {
        if (s.service_no !== svcNo) return s;
        const patched = s.steps.map((st, i) => (i === stepIdx ? { ...st, ...patch } : st));
        return { ...s, steps: normalizeSteps(patched) };
      });
      return { ...prev, services };
    });
  };

  const addStep = (svcNo: number) => {
    setDirty(true);
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => {
        if (s.service_no !== svcNo) return s;
        if (s.steps.length >= STEP_CAP) {
          toast.info(`ステップは最大 ${STEP_CAP} 行までです`);
          return s;
        }
        return {
          ...s,
          steps: [...s.steps, makeEmptyStep(s.steps.length + 1)],
        };
      });
      return { ...prev, services };
    });
  };

  const removeStep = (svcNo: number, stepIdx: number) => {
    setDirty(true);
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => {
        if (s.service_no !== svcNo) return s;
        const removed = s.steps.filter((_, i) => i !== stepIdx);
        return { ...s, steps: normalizeSteps(removed) };
      });
      return { ...prev, services };
    });
  };

  /** step 行を複製 (= 次行に同内容で挿入。12 上限超は toast で拒否) */
  const duplicateStep = (svcNo: number, stepIdx: number) => {
    setDirty(true);
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => {
        if (s.service_no !== svcNo) return s;
        const src = s.steps[stepIdx];
        if (!src) return s;
        if (s.steps.length >= STEP_CAP) {
          toast.info(`ステップは最大 ${STEP_CAP} 行までです`);
          return s;
        }
        const cloned: VisitProcedureStep = {
          step_no: stepIdx + 2,
          content: src.content,
          minutes: src.minutes,
          detail: src.detail,
        };
        const before = s.steps.slice(0, stepIdx + 1);
        const after = s.steps.slice(stepIdx + 1);
        const merged = [...before, cloned, ...after].map((st, i) => ({ ...st, step_no: i + 1 }));
        return { ...s, steps: normalizeSteps(merged) };
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
    setDirty(true);
    setDoc((prev) => {
      if (!prev) return prev;
      const services = prev.services.map((s) => {
        if (s.service_no !== targetNo) return s;
        const copied = source.steps.map((st, i) => ({
          step_no: i + 1,
          content: st.content,
          minutes: st.minutes,
          detail: st.detail,
        }));
        return {
          ...s,
          service_kind: source.service_kind,
          special_notes: source.special_notes,
          steps: normalizeSteps(copied),
        };
      });
      return { ...prev, services };
    });
    toast.success(`サービス${sourceNo} → サービス${targetNo} に複製しました`);
  };

  /**
   * サービス並び替え (= service_no が adjNo (= no±1) のサービスと中身 + 番号を swap)
   *  - state 上で services[] を入れ替え、service_no を index + 1 で再 assign
   *  - 週次表も同列を swap (= 列ヘッダーは services[].service_kind で自動追従)
   *  - 保存は既存 onSave flow に乗る (= DELETE → 再 INSERT で UNIQUE 制約衝突なし)
   */
  const swapServices = (svcNo: number, adjNo: number) => {
    if (svcNo === adjNo) return;
    const inRange = (n: number) => (SERVICE_NOS as readonly number[]).includes(n);
    if (!inRange(svcNo) || !inRange(adjNo)) return;
    setDirty(true);
    setDoc((prev) => {
      if (!prev) return prev;
      const fromIdx = prev.services.findIndex((s) => s.service_no === svcNo);
      const toIdx = prev.services.findIndex((s) => s.service_no === adjNo);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const services = [...prev.services];
      [services[fromIdx], services[toIdx]] = [services[toIdx], services[fromIdx]];
      // service_no を index + 1 で再 assign (= UI 上の順番 = service_no を維持)
      const renumbered = services.map((s, i) => ({ ...s, service_no: i + 1 }));

      // 週次表も同列を swap (= 全曜日・全行で svcNo ↔ adjNo)
      const fromKey = String(svcNo);
      const toKey = String(adjNo);
      const ws: WeeklySchedule = {};
      for (const day of WEEKDAY_KEYS) {
        const rows = prev.weekly_schedule?.[day] ?? [emptyWeeklyRow()];
        ws[day] = rows.map((row) => {
          const next: WeeklyRow = { ...row };
          const a = next[fromKey] ?? null;
          const b = next[toKey] ?? null;
          next[fromKey] = b;
          next[toKey] = a;
          return next;
        });
      }
      return { ...prev, services: renumbered, weekly_schedule: ws };
    });
  };

  // ── 週次表 操作 ──
  const updateWeeklyCell = (day: WeekdayKey, rowIdx: number, svcNo: number, patch: { start?: string } | null) => {
    setDirty(true);
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
    setDirty(true);
    setDoc((prev) => {
      if (!prev) return prev;
      const ws = { ...(prev.weekly_schedule ?? {}) };
      const rows = [...(ws[day] ?? []), emptyWeeklyRow()];
      ws[day] = rows;
      return { ...prev, weekly_schedule: ws };
    });
  };

  const removeWeeklyRow = (day: WeekdayKey, rowIdx: number) => {
    setDirty(true);
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
      const nonEmptySteps = s.steps.filter((st) => !isEmptyStep(st));
      const hasContent = (s.special_notes && s.special_notes.trim().length > 0) || nonEmptySteps.length > 0;
      const used = usedServiceNos.has(s.service_no);
      if ((hasContent || used) && (!s.service_kind || s.service_kind.length === 0)) {
        toast.error(`サービス${s.service_no} の種類を選択してください`);
        return;
      }
    }
    setSaving(true);
    try {
      // 保存時は空行 (= 末尾の auto-extend 空 row) を DB に送らない
      const savedDoc = {
        ...doc,
        services: doc.services.map((s) => ({
          ...s,
          steps: s.steps
            .filter((st) => !isEmptyStep(st))
            .map((st, i) => ({ ...st, step_no: i + 1 })),
        })),
      };
      const newId = await saveDocument(supabase, savedDoc);
      toast.success("手順書を保存しました");
      setDirty(false); // 保存成功で dirty 解除
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

  /**
   * step テンプレートを inline で新規登録 (= combobox の「+ "xxx" を新規登録」)
   *  - office が確定していない場合は no-op
   *  - 成功時に local state へ append (= 直後の auto-fill / 候補表示に使う)
   *  - 失敗時は toast でエラー表示し null を返す
   */
  const handleCreateInlineTemplate = async (
    name: string,
    detail: string | null,
    category: StepTemplateCategory,
  ): Promise<VisitProcedureStepTemplate | null> => {
    if (!officeId || !tenantId) {
      toast.error("事業所が確定していないため登録できません");
      return null;
    }
    const trimmedName = name.trim();
    if (!trimmedName) return null;
    try {
      const created = await createStepTemplate(supabase, {
        office_id: officeId,
        tenant_id: tenantId,
        name: trimmedName,
        detail: detail && detail.trim().length > 0 ? detail.trim() : null,
        category,
        sort_order: (stepTemplates.reduce((m, t) => Math.max(m, t.sort_order), 0) + 10),
      });
      setStepTemplates((prev) => {
        const next = [...prev, created];
        // queries.ts と同じ並び (category → sort_order → name)
        next.sort((a, b) =>
          (a.category ?? "その他").localeCompare(b.category ?? "その他", "ja") ||
          a.sort_order - b.sort_order ||
          a.name.localeCompare(b.name, "ja"),
        );
        return next;
      });
      toast.success(`「${trimmedName}」をテンプレートに登録しました`);
      return created;
    } catch (err) {
      console.error(err);
      toast.error("テンプレート登録失敗: " + (err instanceof Error ? err.message : String(err)));
      return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* ── ヘッダ ── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href={`/visit-procedures/${id}${officeQuery}`}
            className="text-gray-400 hover:text-gray-600 shrink-0"
            title="プレビューに戻る"
            onClick={(e) => { if (!confirmLeaveIfDirty()) e.preventDefault(); }}
          >
            <ArrowLeft size={20} />
          </Link>
          <h1 className="text-base sm:text-xl font-bold text-gray-900 flex items-center gap-2 min-w-0">
            <BookOpen size={20} className="text-green-600 shrink-0" />
            <span className="truncate">編集: {doc.client_name || "(無題)"}</span>
            {dirty && (
              <span className="text-xs font-normal text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                未保存
              </span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/visit-procedures/${id}${officeQuery}`}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            onClick={(e) => { if (!confirmLeaveIfDirty()) e.preventDefault(); }}
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
      <div id="weekly-schedule" className="scroll-mt-20">
        <WeeklyScheduleEditor
          doc={doc}
          onCellChange={updateWeeklyCell}
          onAddRow={addWeeklyRow}
          onRemoveRow={removeWeeklyRow}
        />
      </div>

      {/* ── 全体 特記事項 ── */}
      <section id="special-notes" className="scroll-mt-20 rounded-lg border border-gray-200 bg-white p-4">
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
        <div key={svc.service_no} id={`service-${svc.service_no}`} className="scroll-mt-20">
          <ServiceEditor
            svc={svc}
            totalServices={doc.services.length}
            stepDurationOptions={stepDurationOptions}
            stepTemplates={stepTemplates}
            onCreateTemplate={handleCreateInlineTemplate}
            onServiceChange={(patch) => updateService(svc.service_no, patch)}
            onStepChange={(idx, patch) => updateStep(svc.service_no, idx, patch)}
            onStepAdd={() => addStep(svc.service_no)}
            onStepRemove={(idx) => removeStep(svc.service_no, idx)}
            onStepDuplicate={(idx) => duplicateStep(svc.service_no, idx)}
            onDuplicateTo={(targetNo) => duplicateServiceTo(svc.service_no, targetNo)}
            onSwap={(adjNo) => swapServices(svc.service_no, adjNo)}
          />
        </div>
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
                    const hh = startMin !== null ? Math.floor(startMin / 60) : null;
                    const mm = startMin !== null ? startMin % 60 : null;
                    const endLabel = (() => {
                      if (!start || startMin === null) return "";
                      if (totalMin <= 0) return "";
                      return formatHHMM(startMin + totalMin);
                    })();
                    // 時/分 を分離プルダウン化。時 "--" → clear、分 "--" + 時 set → 分=0 で commit。
                    const commit = (newH: number | null, newM: number | null) => {
                      if (newH === null) {
                        onCellChange(day, rowIdx, no, null);
                        return;
                      }
                      const M = newM ?? 0;
                      onCellChange(day, rowIdx, no, { start: formatHHMM(newH * 60 + M) });
                    };
                    return (
                      <td key={no} className="px-2 py-1.5 border border-gray-200 align-middle">
                        {/* picker を cell 中央に固定。end-label slot を右に置き、左に同サイズの invisible spacer を置いて完全中央。 */}
                        <div className="flex items-center justify-center gap-1 whitespace-nowrap">
                          <span aria-hidden="true" className="inline-block w-[88px]" />
                          <select
                            value={hh ?? ""}
                            onChange={(e) =>
                              commit(e.target.value === "" ? null : Number(e.target.value), mm)
                            }
                            className="rounded border border-gray-300 pl-1.5 pr-0.5 py-1 text-xs bg-white tabular-nums"
                            aria-label={`${WEEKDAY_LABELS[day]} サービス${no} 開始 時`}
                          >
                            <option value="">--</option>
                            {WEEKLY_HOUR_OPTIONS.map((h) => (
                              <option key={h} value={h}>{String(h).padStart(2, "0")}</option>
                            ))}
                          </select>
                          <span className="text-gray-400 text-xs">:</span>
                          <select
                            value={mm ?? ""}
                            onChange={(e) =>
                              commit(hh, e.target.value === "" ? null : Number(e.target.value))
                            }
                            className="rounded border border-gray-300 pl-1.5 pr-0.5 py-1 text-xs bg-white tabular-nums"
                            aria-label={`${WEEKDAY_LABELS[day]} サービス${no} 開始 分`}
                          >
                            <option value="">--</option>
                            {WEEKLY_MINUTE_OPTIONS.map((m) => (
                              <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
                            ))}
                          </select>
                          <span className="text-[10px] text-gray-500 tabular-nums w-[88px] inline-block text-left">
                            {endLabel
                              ? <>- {endLabel} <span className="text-gray-400">(自動)</span></>
                              : <>&nbsp;</>}
                          </span>
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
  totalServices,
  stepDurationOptions,
  stepTemplates,
  onCreateTemplate,
  onServiceChange,
  onStepChange,
  onStepAdd,
  onStepRemove,
  onStepDuplicate,
  onDuplicateTo,
  onSwap,
}: {
  svc: VisitProcedureService;
  totalServices: number;
  stepDurationOptions: number[];
  stepTemplates: VisitProcedureStepTemplate[];
  /**
   * combobox の「+ "xxx" を新規登録」用 callback
   * 成功時は新 row、失敗時は null を返す
   */
  onCreateTemplate: (
    name: string,
    detail: string | null,
    category: StepTemplateCategory,
  ) => Promise<VisitProcedureStepTemplate | null>;
  onServiceChange: (patch: Partial<VisitProcedureService>) => void;
  onStepChange: (idx: number, patch: Partial<VisitProcedureStep>) => void;
  onStepAdd: () => void;
  onStepRemove: (idx: number) => void;
  onStepDuplicate: (idx: number) => void;
  onDuplicateTo: (targetNo: number) => void;
  onSwap: (adjNo: number) => void;
}) {
  const [dupTarget, setDupTarget] = useState<string>("");
  const kindMissing = !svc.service_kind;
  const otherNos = SERVICE_NOS.filter((n) => n !== svc.service_no);
  const canMoveUp = svc.service_no > 1;
  const canMoveDown = svc.service_no < totalServices;

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <div className="px-3 sm:px-4 py-2.5 border-b border-gray-200 bg-gray-50 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-700">サービス{svc.service_no}</h3>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onSwap(svc.service_no - 1)}
              disabled={!canMoveUp}
              className="text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded p-1 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              aria-label={`サービス${svc.service_no} を 1 つ上へ`}
              title="1 つ上へ (= 前のサービスと入替)"
            >
              <ChevronUp size={14} />
            </button>
            <button
              type="button"
              onClick={() => onSwap(svc.service_no + 1)}
              disabled={!canMoveDown}
              className="text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded p-1 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              aria-label={`サービス${svc.service_no} を 1 つ下へ`}
              title="1 つ下へ (= 次のサービスと入替)"
            >
              <ChevronDown size={14} />
            </button>
          </div>
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
                    <StepContentCombobox
                      value={step.content}
                      currentDetail={step.detail ?? ""}
                      templates={stepTemplates}
                      onSelectTemplate={(t) =>
                        onStepChange(idx, { content: t.name, detail: t.detail ?? "" })
                      }
                      onChangeText={(v) => onStepChange(idx, { content: v })}
                      onCreateTemplate={onCreateTemplate}
                      size="sm"
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
                  <div className="flex-1 min-w-0">
                    <StepContentCombobox
                      value={step.content}
                      currentDetail={step.detail ?? ""}
                      templates={stepTemplates}
                      placeholder="サービス内容"
                      onSelectTemplate={(t) =>
                        onStepChange(idx, { content: t.name, detail: t.detail ?? "" })
                      }
                      onChangeText={(v) => onStepChange(idx, { content: v })}
                      onCreateTemplate={onCreateTemplate}
                      size="md"
                    />
                  </div>
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
          disabled={svc.steps.length >= STEP_CAP}
          className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          title={svc.steps.length >= STEP_CAP ? `ステップは最大 ${STEP_CAP} 行までです` : ""}
        >
          <Plus size={12} />
          ステップ追加 ({svc.steps.length} / {STEP_CAP})
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

// =====================================================================
// step サービス内容 combobox
//   - input + dropdown の hybrid
//   - focus / 入力で候補 list 表示
//   - 候補クリックで name + detail を auto-fill
//   - 入力値が候補に無ければ「+ "xxx" を新規登録」option を表示
//   - 自由入力は OK (= 候補に無くてもそのまま保存される)
// =====================================================================
function StepContentCombobox({
  value,
  currentDetail,
  templates,
  placeholder,
  size,
  onChangeText,
  onSelectTemplate,
  onCreateTemplate,
}: {
  value: string;
  /** 現在の step.detail (= 新規 template 登録時に template の detail として使う) */
  currentDetail: string;
  templates: VisitProcedureStepTemplate[];
  placeholder?: string;
  size: "sm" | "md";
  onChangeText: (v: string) => void;
  onSelectTemplate: (t: VisitProcedureStepTemplate) => void;
  onCreateTemplate: (
    name: string,
    detail: string | null,
    category: StepTemplateCategory,
  ) => Promise<VisitProcedureStepTemplate | null>;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  /** 新規登録時の category (= default 「その他」) */
  const [newCategory, setNewCategory] = useState<StepTemplateCategory>("その他");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // ARIA で <input role="combobox"> と popup を紐付けるための uniq id (SSR-safe)
  const reactId = useId();
  const popupId = `step-content-cb-${reactId}`;

  // 外側クリックで close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const q = value.trim();
  // 候補絞り込み (= 入力 substring に name または detail がマッチ)
  const filtered = q.length === 0
    ? templates
    : templates.filter((t) =>
        t.name.toLowerCase().includes(q.toLowerCase()) ||
        (t.detail ? t.detail.toLowerCase().includes(q.toLowerCase()) : false),
      );

  // 表示上限 (= 旧 logic と同じ 20 件)
  const visible = filtered.slice(0, 20);

  // 表示分を category ごとに group
  const groupedVisible = useMemo(() => {
    const groups = new Map<StepTemplateCategory, VisitProcedureStepTemplate[]>();
    for (const c of STEP_TEMPLATE_CATEGORIES) groups.set(c, []);
    for (const t of visible) {
      const c = (t.category ?? "その他") as StepTemplateCategory;
      const list = groups.get(c) ?? [];
      list.push(t);
      groups.set(c, list);
    }
    return groups;
  }, [visible]);

  // 完全一致が無い & 入力値が空でなければ「+ 新規登録」候補を出す
  const exactExists = templates.some((t) => t.name === q);
  const showCreateOption = q.length > 0 && !exactExists;

  const inputCls = size === "sm"
    ? "w-full rounded border border-gray-200 px-1.5 py-1 text-xs"
    : "w-full rounded border border-gray-200 px-2 py-1.5 text-sm";

  const handleCreate = async () => {
    if (creating) return;
    if (!q) return;
    setCreating(true);
    try {
      const created = await onCreateTemplate(q, currentDetail || null, newCategory);
      if (created) {
        // 登録した内容を step にも反映 (= name + detail)
        onSelectTemplate(created);
        setOpen(false);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChangeText(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className={inputCls}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={popupId}
      />
      {open && (visible.length > 0 || showCreateOption) && (
        <div
          id={popupId}
          className="absolute z-30 left-0 right-0 top-full mt-0.5 max-h-60 overflow-y-auto rounded-md border border-gray-300 bg-white shadow-lg text-xs"
          role="listbox"
        >
          {/* category 別に group 表示 (= 候補が無い category は heading を出さない) */}
          {STEP_TEMPLATE_CATEGORIES.map((cat) => {
            const rows = groupedVisible.get(cat) ?? [];
            if (rows.length === 0) return null;
            return (
              <div key={cat}>
                <div className="px-2 py-1 bg-gray-50 text-[10px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 sticky top-0">
                  {cat}
                </div>
                {rows.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onMouseDown={(e) => {
                      // mousedown で先回り (= input blur より前に発火)
                      e.preventDefault();
                      onSelectTemplate(t);
                      setOpen(false);
                    }}
                    className="block w-full text-left px-2 py-1.5 hover:bg-green-50 border-b border-gray-100 last:border-b-0"
                    role="option"
                    aria-selected={false}
                  >
                    <div className="font-medium text-gray-800 truncate">{t.name}</div>
                    {t.detail && (
                      <div className="text-[11px] text-gray-500 truncate">{t.detail}</div>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
          {showCreateOption && (
            <div className="border-t border-gray-200">
              {/* category select + 新規登録ボタン を 1 row に */}
              <div className="px-2 py-1.5 flex items-center gap-1.5 bg-blue-50/30">
                <label className="text-[10px] text-gray-500 shrink-0">分類:</label>
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value as StepTemplateCategory)}
                  onMouseDown={(e) => e.stopPropagation()}
                  disabled={creating}
                  className="rounded border border-gray-300 px-1 py-0.5 text-[11px] bg-white"
                  aria-label="新規テンプレートのカテゴリ"
                >
                  {STEP_TEMPLATE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleCreate();
                }}
                disabled={creating}
                className="block w-full text-left px-2 py-1.5 hover:bg-blue-50 text-blue-700 font-medium disabled:opacity-50"
              >
                {creating ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin" />
                    登録中...
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Plus size={12} />
                    「{q}」を新規登録
                    {currentDetail.trim() && (
                      <span className="text-[10px] text-gray-500 ml-1">
                        (取り組内容も含めて保存)
                      </span>
                    )}
                  </span>
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
