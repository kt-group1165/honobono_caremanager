"use client";

import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";
import { getServiceSystemMap } from "@/lib/service-system-lookup";
import { validInMonth } from "@/lib/service-code-valid";
import { Fragment, useState, useEffect, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Check,
  Loader2,
  Copy,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  addMonths,
  subMonths,
  parseISO,
} from "date-fns";
import { ja } from "date-fns/locale";
import { cn } from "@/lib/utils";
import {
  SERVICE_TYPE_COLORS,
  insertVisitSchedules,
  twoPersonMismatchWarning,
  type KaigoStaff,
  type VisitSchedule,
} from "./_shared";
import {
  useKaigoVisitSchedulesByUser,
  useKaigoVisitSchedulesByStaff,
} from "@/lib/swr/use-kaigo-visit-schedules";
import { useBusinessType } from "@/lib/business-type-context";
import {
  getHospitalizationMap,
  isHospitalizedOn,
  type HospitalizationPeriod,
} from "@/lib/hospitalization";

export interface MonthlyIndividualInitialData {
  schedules: VisitSchedule[];
}

interface MonthlyIndividualViewProps {
  entityId: string;
  entityName: string;
  entityType: "user" | "staff";
  currentMonth: Date;
  onMonthChange: (d: Date) => void;
  staff: KaigoStaff[];
  onEditSchedule?: (sched: VisitSchedule) => void;
  initialData: MonthlyIndividualInitialData;
}

export function MonthlyIndividualView({
  entityId,
  entityName,
  entityType,
  currentMonth,
  onMonthChange,
  staff,
  onEditSchedule,
  initialData,
}: MonthlyIndividualViewProps) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOfficeId } = useBusinessType();
  // 楽観的 local state (複写行 _isCopy 等)。SWR data の到着で sync する。
  const [schedules, setSchedules] = useState<VisitSchedule[]>(initialData.schedules);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);

  const monthFrom = useMemo(() => format(startOfMonth(currentMonth), "yyyy-MM-dd"), [currentMonth]);
  const monthTo = useMemo(() => format(endOfMonth(currentMonth), "yyyy-MM-dd"), [currentMonth]);
  const hasInitial = initialData.schedules.length > 0;

  // entityType に応じて hook を使い分け。SWR の hook は条件的に呼べないので両方呼び、
  // 使う方の data だけ採用する (key が null だと fetch は走らない)。
  const userResult = useKaigoVisitSchedulesByUser(
    entityType === "user" ? entityId : null,
    monthFrom,
    monthTo,
    entityType === "user" && hasInitial ? initialData.schedules : undefined,
  );
  const staffResult = useKaigoVisitSchedulesByStaff(
    entityType === "staff" ? entityId : null,
    monthFrom,
    monthTo,
    entityType === "staff" && hasInitial ? initialData.schedules : undefined,
  );
  const active = entityType === "user" ? userResult : staffResult;
  const swrSchedules = useMemo(() => {
    // by-user は visit_date 順序保証なし (start_time のみ order)、表示時は元来 visit_date,start_time 二段ソート。
    return [...active.schedules].sort((a, b) => {
      if (a.visit_date !== b.visit_date) return a.visit_date.localeCompare(b.visit_date);
      return (a.start_time ?? "").localeCompare(b.start_time ?? "");
    });
  }, [active.schedules]);
  // keepPreviousData のため key 切替 (利用者/月/ビュー変更) 直後は isLoading=false のまま
  // 前 key のデータが残る。データ未着ならローディング表示にする (空表示のちらつき防止)
  const loading = active.isLoading || (active.isValidating && active.schedules.length === 0);
  // fetch エラーを「予定なし」と混同させない (silent failure 防止)
  const fetchError = active.error ? (active.error as Error).message : null;

  // 制度区分 (介護/総合事業/障害/独自) の lookup — 区分列のバッジ表示用
  const [systemMap, setSystemMap] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const types = Array.from(new Set(schedules.map((s) => s.service_type))).filter(
      (t) => t && !systemMap.has(toHankakuDigits(t)),
    );
    if (types.length === 0) return;
    let cancelled = false;
    void getServiceSystemMap(supabase, types, {
      year: currentMonth.getFullYear(),
      month: currentMonth.getMonth() + 1,
    }).then((m) => {
      if (cancelled || m.size === 0) return;
      setSystemMap((prev) => new Map([...prev, ...m]));
    });
    return () => {
      cancelled = true;
    };
  }, [schedules, systemMap, supabase, currentMonth]);

  // 入院期間 (🏥 バッジ用、利用者ビューのみ)。entity 切替で 1 回 fetch。
  const [hospPeriods, setHospPeriods] = useState<HospitalizationPeriod[]>([]);
  useEffect(() => {
    if (entityType !== "user") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- entity 切替に伴う derived reset
      setHospPeriods([]);
      return;
    }
    let cancelled = false;
    getHospitalizationMap(supabase, [entityId])
      .then((m) => {
        if (!cancelled) setHospPeriods(m.get(entityId) ?? []);
      })
      .catch((e) => {
        console.error("hospitalization fetch failed:", e);
      });
    return () => { cancelled = true; };
  }, [supabase, entityType, entityId]);

  // SWR data → local state へ sync (未保存のローカル複写行 _isCopy は保持する)
  const lastSwrRef = useRef(swrSchedules);
  useEffect(() => {
    if (swrSchedules !== lastSwrRef.current) {
      lastSwrRef.current = swrSchedules;
      setSchedules((prev) => {
        const pendingCopies = prev.filter((s) => s._isCopy);
        return pendingCopies.length > 0 ? [...swrSchedules, ...pendingCopies] : swrSchedules;
      });
    }
  }, [swrSchedules]);

  // 単位数を on-demand 補完 (提供表と同パターン:
  //  「基本」全件 fetch は 1000 行制限で欠けるため .in() で絞る。
  //  マスタは全角数字 (身体介護３) / schedule は半角混在のため variants 検索 + 正規化 lookup)
  const [serviceUnits, setServiceUnits] = useState<Record<string, number>>({});
  // 改定 (世代) を跨ぐと同名サービスでも単位数が変わるため、月切替時はキャッシュを破棄して引き直す
  const unitsMonthRef = useRef(monthFrom);
  useEffect(() => {
    if (unitsMonthRef.current === monthFrom) return;
    unitsMonthRef.current = monthFrom;
    setServiceUnits({});
  }, [monthFrom]);
  useEffect(() => {
    const missing = Array.from(
      new Set(schedules.map((s) => s.service_type)),
    ).filter((t) => t && serviceUnits[t] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      // 有効期間: 表示月に有効な世代のみ (改定跨ぎの複数世代ヒット防止)
      const { data, error } = await validInMonth(
        supabase
          .from("kaigo_service_codes")
          .select("service_name, units")
          .in("service_name", serviceNameVariantsAll(missing))
          .eq("calculation_type", "基本"),
        currentMonth.getFullYear(),
        currentMonth.getMonth() + 1,
      );
      if (cancelled || error) return;
      const byNorm = new Map<string, number>();
      for (const sc of (data ?? []) as { service_name: string; units: number }[]) {
        const key = toHankakuDigits(sc.service_name);
        if (!byNorm.has(key)) byNorm.set(key, sc.units);
      }
      const found: Record<string, number> = {};
      for (const t of missing) {
        // マスタに無い service_type は 0 を入れて再フェッチループを防ぐ
        found[t] = byNorm.get(toHankakuDigits(t)) ?? 0;
      }
      setServiceUnits((prev) => ({ ...prev, ...found }));
    })();
    return () => {
      cancelled = true;
    };
  }, [schedules, serviceUnits, supabase, currentMonth]);

  // 職員 2/3 の割当変更 (2人対応・同行用)
  const updateStaffN = async (
    sched: VisitSchedule,
    field: "staff_id_2" | "staff_id_3",
    value: string,
  ) => {
    const next = value || null;
    const { error } = await supabase
      .from("kaigo_visit_schedule")
      .update({ [field]: next })
      .eq("id", sched.id);
    if (error) {
      toast.error("職員の割当に失敗: " + error.message);
      return;
    }
    setSchedules((prev) =>
      prev.map((s) => (s.id === sched.id ? { ...s, [field]: next } : s)),
    );
    // 2人体制の整合警告 (職員2 とサービス名の「２人」有無の食い違い。ブロックはしない)
    if (field === "staff_id_2") {
      const warn = twoPersonMismatchWarning(sched.service_type, next);
      if (warn) toast.warning(warn);
    }
  };

  const toggleStatus = async (sched: VisitSchedule) => {
    const isCurrentlyCompleted = sched.status === "completed";
    setTogglingId(sched.id);

    if (!isCurrentlyCompleted) {
      const { data: existing, error: existErr } = await supabase
        .from("kaigo_visit_records")
        .select("id")
        .eq("user_id", sched.user_id)
        .eq("visit_date", sched.visit_date)
        .eq("start_time", sched.start_time)
        .limit(1);
      if (existErr) {
        // 存在確認に失敗したまま INSERT すると重複記録を作りうるため中断
        toast.error("実績記録の確認に失敗しました: " + existErr.message);
        setTogglingId(null);
        return;
      }
      if (!existing || existing.length === 0) {
        // status CHECK 制約は draft/confirmed/submitted のみ。自動生成は下書き記録として作る
        const { error } = await supabase.from("kaigo_visit_records").insert({
          user_id: sched.user_id,
          staff_id: sched.staff_id,
          visit_date: sched.visit_date,
          start_time: sched.start_time,
          end_time: sched.end_time,
          service_type: sched.service_type,
          status: "draft",
        });
        if (error) {
          toast.error("実績登録に失敗しました: " + error.message);
          console.error("visit_records insert error:", error);
          setTogglingId(null);
          return;
        }
      }
      const { error: upErr } = await supabase.from("kaigo_visit_schedule").update({ status: "completed" }).eq("id", sched.id);
      if (upErr) {
        toast.error("実績変更に失敗しました: " + upErr.message);
        setTogglingId(null);
        return;
      }
      setSchedules((prev) => prev.map((s) => s.id === sched.id ? { ...s, status: "completed" } : s));
      toast.success("実績に変更しました（提供表にも反映）");
    } else {
      const { error: delErr } = await supabase
        .from("kaigo_visit_records")
        .delete()
        .eq("user_id", sched.user_id)
        .eq("visit_date", sched.visit_date)
        .eq("start_time", sched.start_time);
      if (delErr) {
        // 記録が残ったまま schedule だけ予定に戻すと提供表・請求と食い違うため中断
        toast.error("実績記録の削除に失敗しました: " + delErr.message);
        setTogglingId(null);
        return;
      }
      const { error: upErr } = await supabase.from("kaigo_visit_schedule").update({ status: "scheduled" }).eq("id", sched.id);
      if (upErr) {
        toast.error("予定への変更に失敗しました: " + upErr.message);
        setTogglingId(null);
        return;
      }
      setSchedules((prev) => prev.map((s) => s.id === sched.id ? { ...s, status: "scheduled" } : s));
      toast.success("予定に戻しました（提供表の実績も削除）");
    }
    setTogglingId(null);
    // SWR cache を server truth で更新 (月/エンティティ切替時の stale 表示防止)
    active.mutate();
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (selectedIds.size === schedules.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(schedules.map((s) => s.id)));
    }
  };

  const bulkToCompleted = async () => {
    if (selectedIds.size === 0) { toast.error("対象を選択してください"); return; }
    const targets = schedules.filter((s) => selectedIds.has(s.id) && s.status !== "completed");
    if (targets.length === 0) { toast.info("選択された予定はすべて実績済みです"); return; }
    setBulkProcessing(true);
    const succeeded = new Set<string>();
    for (const sched of targets) {
      const { data: existing, error: existErr } = await supabase
        .from("kaigo_visit_records").select("id")
        .eq("user_id", sched.user_id).eq("visit_date", sched.visit_date).eq("start_time", sched.start_time).limit(1);
      if (existErr) {
        // 存在確認に失敗したまま INSERT すると重複記録を作りうるためこの行はスキップ
        console.error("visit_records existence check error:", existErr.message);
        continue;
      }
      if (!existing || existing.length === 0) {
        const { error } = await supabase.from("kaigo_visit_records").insert({
          user_id: sched.user_id, staff_id: sched.staff_id,
          visit_date: sched.visit_date, start_time: sched.start_time, end_time: sched.end_time,
          service_type: sched.service_type, status: "draft",
        });
        if (error) {
          console.error("visit_records insert error:", error.message);
          continue;
        }
      }
      const { error: upErr } = await supabase.from("kaigo_visit_schedule").update({ status: "completed" }).eq("id", sched.id);
      if (upErr) {
        console.error("visit_schedule update error:", upErr.message);
        continue;
      }
      succeeded.add(sched.id);
    }
    setSchedules((prev) => prev.map((s) => succeeded.has(s.id) ? { ...s, status: "completed" } : s));
    if (succeeded.size === targets.length) {
      toast.success(`${succeeded.size}件を実績に変換しました`);
    } else {
      toast.error(`${succeeded.size}/${targets.length}件のみ実績に変換できました (失敗分はコンソール参照)`);
    }
    setSelectedIds(new Set());
    setBulkProcessing(false);
    active.mutate();
  };

  const bulkToScheduled = async () => {
    if (selectedIds.size === 0) { toast.error("対象を選択してください"); return; }
    const targets = schedules.filter((s) => selectedIds.has(s.id) && s.status === "completed");
    if (targets.length === 0) { toast.info("選択された予定はすべて予定状態です"); return; }
    setBulkProcessing(true);
    // 行ごとに error をチェックし、成功分のみ state 反映 (silent failure 防止)
    const succeeded = new Set<string>();
    for (const sched of targets) {
      const { error: delErr } = await supabase.from("kaigo_visit_records").delete()
        .eq("user_id", sched.user_id).eq("visit_date", sched.visit_date).eq("start_time", sched.start_time);
      if (delErr) {
        console.error("visit_records delete error:", delErr.message);
        continue;
      }
      const { error: upErr } = await supabase.from("kaigo_visit_schedule").update({ status: "scheduled" }).eq("id", sched.id);
      if (upErr) {
        console.error("visit_schedule update error:", upErr.message);
        continue;
      }
      succeeded.add(sched.id);
    }
    setSchedules((prev) => prev.map((s) => succeeded.has(s.id) ? { ...s, status: "scheduled" } : s));
    if (succeeded.size === targets.length) {
      toast.success(`${succeeded.size}件を予定に戻しました`);
    } else {
      toast.error(`${succeeded.size}/${targets.length}件のみ予定に戻せました (失敗分はコンソール参照)`);
    }
    setSelectedIds(new Set());
    setBulkProcessing(false);
    active.mutate();
  };

  const bulkCopy = () => {
    if (selectedIds.size === 0) { toast.error("対象を選択してください"); return; }
    const targets = schedules.filter((s) => selectedIds.has(s.id) && s.status !== "completed");
    if (targets.length === 0) { toast.error("予定のみ複写できます（実績は不可）"); return; }
    const newSchedules: VisitSchedule[] = [];
    for (const sched of schedules) {
      newSchedules.push(sched);
      if (targets.some((t) => t.id === sched.id)) {
        const copyId = `copy-${sched.id}-${Date.now()}`;
        newSchedules.push({
          ...sched,
          id: copyId,
          visit_date: "",
          status: "scheduled",
          _isCopy: true,
        });
      }
    }
    setSchedules(newSchedules);
    setSelectedIds(new Set());
    toast.success(`${targets.length}件を複写しました（日付を設定してください）`);
  };

  const saveCopyDate = async (copyRow: VisitSchedule, dateStr: string) => {
    const { data, error } = await insertVisitSchedules(supabase, [{
      user_id: copyRow.user_id, staff_id: copyRow.staff_id,
      staff_id_2: copyRow.staff_id_2 ?? null, staff_id_3: copyRow.staff_id_3 ?? null,
      visit_date: dateStr,
      start_time: copyRow.start_time, end_time: copyRow.end_time,
      service_type: copyRow.service_type, status: "scheduled",
      // C5: 発生元 office (列未適用は helper が strip)
      ...(currentOfficeId ? { office_id: currentOfficeId } : {}),
    }], "id");
    if (error || !data || data.length === 0) {
      toast.error("保存に失敗しました: " + (error?.message ?? "不明なエラー"));
      return;
    }
    const newId = (data[0] as { id: string }).id;
    setSchedules((prev) => prev.map((s) =>
      s.id === copyRow.id ? { ...s, id: newId, visit_date: dateStr, _isCopy: false } : s
    ));
    toast.success("予定を保存しました");
    active.mutate();
  };

  const removeCopyRow = (copyId: string) => {
    setSchedules((prev) => prev.filter((s) => s.id !== copyId));
  };

  const bulkDelete = async () => {
    if (selectedIds.size === 0) { toast.error("対象を選択してください"); return; }
    const ok = window.confirm(`選択された${selectedIds.size}件を削除します。\n予定も実績も削除されますが、本当によろしいですか？`);
    if (!ok) return;
    setBulkProcessing(true);
    const targets = schedules.filter((s) => selectedIds.has(s.id));
    // 行ごとに error をチェックし、成功分のみ state から除去 (silent failure 防止)
    const succeeded = new Set<string>();
    for (const sched of targets) {
      // ローカル複写行 (未保存) は DB 操作不要
      if (sched._isCopy) {
        succeeded.add(sched.id);
        continue;
      }
      const { error: recDelErr } = await supabase.from("kaigo_visit_records").delete()
        .eq("user_id", sched.user_id).eq("visit_date", sched.visit_date).eq("start_time", sched.start_time);
      if (recDelErr) {
        console.error("visit_records delete error:", recDelErr.message);
        continue;
      }
      const { error: schedDelErr } = await supabase.from("kaigo_visit_schedule").delete().eq("id", sched.id);
      if (schedDelErr) {
        console.error("visit_schedule delete error:", schedDelErr.message);
        continue;
      }
      succeeded.add(sched.id);
    }
    setSchedules((prev) => prev.filter((s) => !succeeded.has(s.id)));
    if (succeeded.size === targets.length) {
      toast.success(`${succeeded.size}件を削除しました`);
    } else {
      toast.error(`${succeeded.size}/${targets.length}件のみ削除できました (失敗分はコンソール参照)`);
    }
    setSelectedIds(new Set());
    setBulkProcessing(false);
    active.mutate();
  };

  const dowStr = (dateStr: string) => {
    try { return format(parseISO(dateStr), "E", { locale: ja }); } catch { return ""; }
  };

  const durationShort = (start: string | null, end: string | null) => {
    if (!start || !end) return "";
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    const totalMins = (eh * 60 + em) - (sh * 60 + sm);
    if (totalMins <= 0) return "";
    return `(${(totalMins / 60).toFixed(1)}h)`;
  };

  // ─── 下部集計 (ほのぼの 月間個別 準拠: 残予定/実績 × 身体・身生・生活・乗降) ───
  const footerStats = useMemo(() => {
    type Agg = { c: number; m: number; u: number };
    type Cat = "身体" | "身生" | "生活" | "乗降" | "その他";
    const CATS: Cat[] = ["身体", "身生", "生活", "乗降", "その他"];
    const categorize = (raw: string): Cat => {
      const s = toHankakuDigits(raw ?? "");
      if (s.includes("乗降")) return "乗降";
      const hasBody = s.includes("身体") || /身\d/.test(s);
      const hasLife = s.includes("生活") || /生\d/.test(s);
      if (hasBody && hasLife) return "身生";
      if (hasBody) return "身体";
      if (hasLife) return "生活";
      return "その他";
    };
    const mins = (start: string | null, end: string | null) => {
      if (!start || !end) return 0;
      const [sh, sm] = start.split(":").map(Number);
      const [eh, em] = end.split(":").map(Number);
      const d = (eh * 60 + em) - (sh * 60 + sm);
      return d > 0 ? d : 0;
    };
    const mkAgg = (): Agg => ({ c: 0, m: 0, u: 0 });
    const mkGroup = () => ({
      total: mkAgg(),
      by: Object.fromEntries(CATS.map((c) => [c, mkAgg()])) as Record<Cat, Agg>,
    });
    // 支援 = 総合事業/介護予防系 (訪問型サービス等) を別段で集計
    const isShien = (raw: string) => {
      const s = raw ?? "";
      return s.includes("訪問型") || s.includes("予防") || s.includes("総合事業");
    };
    const groups = {
      planned: mkGroup(),
      actual: mkGroup(),
      shienPlanned: mkGroup(),
      shienActual: mkGroup(),
    };
    for (const s of schedules) {
      if (s._isCopy || !s.visit_date) continue;
      const done = s.status === "completed";
      const g = isShien(s.service_type)
        ? (done ? groups.shienActual : groups.shienPlanned)
        : (done ? groups.actual : groups.planned);
      const m = mins(s.start_time, s.end_time);
      const u = serviceUnits[s.service_type] ?? 0;
      const cat = categorize(s.service_type);
      g.total.c += 1; g.total.m += m; g.total.u += u;
      g.by[cat].c += 1; g.by[cat].m += m; g.by[cat].u += u;
    }
    return groups;
  }, [schedules, serviceUnits]);

  const fmtHM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  // 回数 / (時間) / 単位 をそれぞれ独立セルにして、行間で () や単位の桁が縦に揃うようにする
  const footerCats = useMemo(() => {
    const base: ("身体" | "身生" | "生活" | "乗降" | "その他")[] = ["身体", "身生", "生活", "乗降"];
    const groups = [footerStats.planned, footerStats.actual, footerStats.shienPlanned, footerStats.shienActual];
    if (groups.some((g) => g.by["その他"].c > 0)) base.push("その他");
    return base;
  }, [footerStats]);
  const aggCells = (a: { c: number; m: number; u: number }) => (
    <>
      <td className="text-right tabular-nums">{a.c}回</td>
      <td className="tabular-nums px-0.5">({fmtHM(a.m)})</td>
      <td className="text-right tabular-nums pl-1">{a.u.toLocaleString()}単位</td>
    </>
  );
  const groupCells = (g: typeof footerStats.planned, blank: boolean) =>
    blank ? (
      <>
        <td colSpan={4} />
        {footerCats.map((c) => <td key={c} colSpan={4} />)}
      </>
    ) : (
      <>
        {aggCells(g.total)}
        <td className="px-2 text-gray-400">/</td>
        {footerCats.map((c) => (
          <Fragment key={c}>
            <td className="pl-4 text-gray-500">{c}:</td>
            {aggCells(g.by[c])}
          </Fragment>
        ))}
      </>
    );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b bg-white">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-gray-900">{entityName}</span>
          <button onClick={() => onMonthChange(subMonths(currentMonth, 1))} className="rounded border p-1 hover:bg-gray-50"><ChevronLeft size={14} /></button>
          <span className="text-sm font-semibold">{format(currentMonth, "yyyy年M月", { locale: ja })}</span>
          <button onClick={() => onMonthChange(addMonths(currentMonth, 1))} className="rounded border p-1 hover:bg-gray-50"><ChevronRight size={14} /></button>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          予定 {schedules.filter((s) => s.status !== "completed").length}件
          / 実績 {schedules.filter((s) => s.status === "completed").length}件
          / 合計 {schedules.length}件
          / 実績単位 {schedules
            .filter((s) => s.status === "completed")
            .reduce((sum, s) => sum + (serviceUnits[s.service_type] ?? 0), 0)
            .toLocaleString()}
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 py-1.5 border-b bg-gray-50 shrink-0">
        <span className="text-xs text-gray-500 mr-1">
          {selectedIds.size > 0 ? `${selectedIds.size}件選択中` : "一括操作"}
        </span>
        <button
          onClick={bulkToCompleted}
          disabled={bulkProcessing || selectedIds.size === 0}
          className="inline-flex items-center gap-1 rounded border border-orange-300 bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-700 hover:bg-orange-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Check size={12} />
          実績変換
        </button>
        <button
          onClick={bulkToScheduled}
          disabled={bulkProcessing || selectedIds.size === 0}
          className="inline-flex items-center gap-1 rounded border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <RotateCcw size={12} />
          予定に戻す
        </button>
        <button
          onClick={bulkCopy}
          disabled={bulkProcessing || selectedIds.size === 0}
          className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Copy size={12} />
          複写
        </button>
        <button
          onClick={bulkDelete}
          disabled={bulkProcessing || selectedIds.size === 0}
          className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Trash2 size={12} />
          削除
        </button>
        {bulkProcessing && <Loader2 size={14} className="animate-spin text-blue-500 ml-1" />}
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center"><Loader2 size={24} className="animate-spin text-blue-500" /></div>
      ) : fetchError && schedules.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            予定の取得に失敗しました: {fetchError}
          </div>
        </div>
      ) : schedules.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-400">この月の予定はありません</div>
      ) : (
        <div className="flex-1 overflow-auto">
          {/* min-w で列潰れ (縦書き化) を防ぎ、狭い画面では横スクロールに逃がす */}
          <table className="w-full min-w-[960px] text-xs border-collapse [&_th]:whitespace-nowrap">
            <thead className="bg-yellow-50 border-b sticky top-0 z-10">
              <tr>
                <th className="border border-gray-300 px-1 py-1.5 text-center font-bold w-8">
                  <input
                    type="checkbox"
                    checked={schedules.length > 0 && selectedIds.size === schedules.length}
                    onChange={toggleSelectAll}
                    className="h-3.5 w-3.5 accent-blue-600 cursor-pointer"
                    title="全選択/解除"
                  />
                </th>
                <th className="border border-gray-300 px-1 py-1.5 text-center font-bold w-14">予実</th>
                <th className="border border-gray-300 px-2 py-1.5 text-left font-bold text-red-700">利用日</th>
                <th className="border border-gray-300 px-2 py-1.5 text-left font-bold">利用時間</th>
                <th className="border border-gray-300 px-1 py-1.5 text-center font-bold w-12">区分</th>
                <th className="border border-gray-300 px-2 py-1.5 text-left font-bold text-red-700">*サービス内容</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right font-bold w-16">単位数</th>
                <th className="border border-gray-300 px-2 py-1.5 text-center font-bold">
                  {entityType === "user" ? "職員 1" : "利用者"}
                </th>
                {entityType === "user" && (
                  <>
                    <th className="border border-gray-300 px-2 py-1.5 text-center font-bold">職員 2</th>
                    <th className="border border-gray-300 px-2 py-1.5 text-center font-bold">職員 3</th>
                  </>
                )}
                <th className="border border-gray-300 px-2 py-1.5 text-center font-bold w-12">記録</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((sched) => {
                const isCopy = sched._isCopy === true;
                const hasDate = !!sched.visit_date;
                const day = hasDate ? parseInt(sched.visit_date.split("-")[2], 10) : 0;
                const dow = hasDate ? dowStr(sched.visit_date) : "";
                const isSat = dow === "土";
                const isSun = dow === "日";
                const isCompleted = sched.status === "completed";
                const isToggling = togglingId === sched.id;

                return (
                  <tr
                    key={sched.id}
                    className={cn(
                      "hover:bg-yellow-50/50 transition-colors",
                      isCopy ? "bg-green-50/40" : isSun ? "bg-red-50/20" : isSat ? "bg-blue-50/20" : ""
                    )}
                  >
                    <td className="border border-gray-300 px-1 py-1 text-center">
                      {!isCopy ? (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(sched.id)}
                          onChange={() => toggleSelect(sched.id)}
                          className="h-3.5 w-3.5 accent-blue-600 cursor-pointer"
                        />
                      ) : (
                        <button
                          onClick={() => removeCopyRow(sched.id)}
                          className="text-red-400 hover:text-red-600"
                          title="複写を取消"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </td>
                    <td className="border border-gray-300 px-1 py-1 text-center">
                      {isCopy ? (
                        <span className="text-[10px] text-green-600 font-bold">複写</span>
                      ) : (
                        <button
                          onClick={() => toggleStatus(sched)}
                          disabled={isToggling}
                          title={isCompleted ? "実績 → 予定に戻す" : "予定 → 実績に変更"}
                        >
                          {/* ラベルをピル内部に置く (隣接だと列が縮んだ時に重なる) */}
                          <span className={cn(
                            "relative inline-block h-[18px] w-10 shrink-0 rounded-full align-middle transition-colors",
                            isCompleted ? "bg-orange-500" : "bg-gray-300",
                            isToggling && "opacity-50"
                          )}>
                            <span className={cn(
                              "absolute top-1/2 -translate-y-1/2 text-[10px] font-bold leading-none",
                              isCompleted ? "left-1.5 text-white" : "right-1.5 text-gray-600"
                            )}>
                              {isCompleted ? "実" : "予"}
                            </span>
                            <span className={cn(
                              "absolute top-0.5 h-[14px] w-[14px] rounded-full bg-white shadow transition-transform",
                              isCompleted ? "translate-x-[24px]" : "translate-x-0.5"
                            )} />
                          </span>
                        </button>
                      )}
                    </td>
                    <td className="border border-gray-300 px-2 py-1 whitespace-nowrap">
                      {isCopy && !hasDate ? (
                        <div className="flex items-center gap-1">
                          <span className="text-gray-400 italic text-[10px]">日付未設定</span>
                          <label className="cursor-pointer text-blue-500 hover:text-blue-700" title="日付を選択">
                            <CalendarDays size={14} />
                            <input
                              type="date"
                              className="sr-only"
                              onChange={(e) => {
                                if (e.target.value) saveCopyDate(sched, e.target.value);
                              }}
                            />
                          </label>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <span className="font-bold">{day}</span>
                          <span className={cn(
                            "ml-0.5",
                            isSun ? "text-red-500" : isSat ? "text-blue-500" : "text-gray-500"
                          )}>
                            ({dow})
                          </span>
                          {(() => {
                            if (entityType !== "user" || !hasDate) return null;
                            const hosp = isHospitalizedOn(hospPeriods, sched.visit_date);
                            if (!hosp) return null;
                            return (
                              <span
                                className="rounded bg-rose-100 px-1 py-0.5 text-[9px] font-bold text-rose-700 leading-none whitespace-nowrap"
                                title={`入院中${hosp.hospital_name ? ` (${hosp.hospital_name})` : ""}: ${hosp.admission_date}〜${hosp.discharge_date ?? "退院日未定"}`}
                              >
                                🏥入院中
                              </span>
                            );
                          })()}
                          {!isCopy && (
                            <label className="cursor-pointer text-gray-300 hover:text-blue-500 ml-auto" title="日付を変更">
                              <CalendarDays size={12} />
                              <input
                                type="date"
                                className="sr-only"
                                defaultValue={sched.visit_date}
                                onChange={async (e) => {
                                  if (!e.target.value || e.target.value === sched.visit_date) return;
                                  const { error } = await supabase.from("kaigo_visit_schedule")
                                    .update({ visit_date: e.target.value }).eq("id", sched.id);
                                  if (error) { toast.error("日付変更に失敗: " + error.message); return; }
                                  setSchedules((prev) => prev.map((s) =>
                                    s.id === sched.id ? { ...s, visit_date: e.target.value } : s
                                  ));
                                  toast.success("日付を変更しました");
                                  active.mutate();
                                }}
                              />
                            </label>
                          )}
                        </div>
                      )}
                    </td>
                    <td
                      className="border border-gray-300 px-2 py-1 whitespace-nowrap cursor-pointer hover:bg-blue-50"
                      onClick={() => onEditSchedule?.(sched)}
                    >
                      <span className="font-mono">{sched.start_time?.slice(0, 5)}-{sched.end_time?.slice(0, 5)}</span>
                      <span className="ml-1 text-gray-400">{durationShort(sched.start_time, sched.end_time)}</span>
                    </td>
                    <td className="border border-gray-300 px-1 py-1 text-center">
                      {(() => {
                        const sys = systemMap.get(toHankakuDigits(sched.service_type));
                        if (!sys) return <span className="text-gray-300">—</span>;
                        const label = sys === "総合事業" ? "総合" : sys;
                        const cls =
                          sys === "介護" ? "bg-blue-100 text-blue-700"
                          : sys === "総合事業" ? "bg-emerald-100 text-emerald-700"
                          : sys === "障害" ? "bg-purple-100 text-purple-700"
                          : "bg-amber-100 text-amber-700";
                        return (
                          <span className={cn("rounded px-1 py-0.5 text-[10px] font-bold whitespace-nowrap", cls)}>
                            {label}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="border border-gray-300 px-2 py-1">
                      <span className={cn(
                        "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
                        SERVICE_TYPE_COLORS[sched.service_type] ?? "bg-gray-100 text-gray-700"
                      )}>
                        {sched.service_type}
                      </span>
                    </td>
                    <td className="border border-gray-300 px-2 py-1 text-right font-mono whitespace-nowrap">
                      {serviceUnits[sched.service_type]
                        ? serviceUnits[sched.service_type].toLocaleString()
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="border border-gray-300 px-2 py-1 text-center whitespace-nowrap">
                      {entityType === "user"
                        ? sched.staff_name ?? "未割当"
                        : sched.user_name ?? "不明"}
                    </td>
                    {entityType === "user" && (
                      <>
                        <td className="border border-gray-300 px-1 py-1 text-center">
                          {!isCopy && (
                            <StaffMiniSelect
                              value={sched.staff_id_2 ?? ""}
                              staff={staff}
                              excludeIds={[sched.staff_id, sched.staff_id_3].filter(Boolean) as string[]}
                              onChange={(v) => updateStaffN(sched, "staff_id_2", v)}
                            />
                          )}
                        </td>
                        <td className="border border-gray-300 px-1 py-1 text-center">
                          {!isCopy && (
                            <StaffMiniSelect
                              value={sched.staff_id_3 ?? ""}
                              staff={staff}
                              excludeIds={[sched.staff_id, sched.staff_id_2].filter(Boolean) as string[]}
                              onChange={(v) => updateStaffN(sched, "staff_id_3", v)}
                            />
                          )}
                        </td>
                      </>
                    )}
                    <td className="border border-gray-300 px-1 py-1 text-center">
                      {isCompleted && (
                        <span className="inline-block w-3 h-3 rounded-sm bg-orange-200 border border-orange-400" title="実績記録あり" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 下部集計 (ほのぼの 準拠) */}
      <div className="shrink-0 border-t bg-gray-50 px-4 py-2 overflow-x-auto">
        <table className="text-[11px] font-mono whitespace-nowrap leading-5">
          <tbody>
            <tr>
              <td className="pr-3 font-bold text-blue-700">【残予定 合計】</td>
              {groupCells(footerStats.planned, false)}
            </tr>
            <tr>
              <td className="pr-3 font-bold text-orange-700">【 実績 合計 】</td>
              {groupCells(footerStats.actual, false)}
            </tr>
            <tr>
              <td className="pr-3 font-bold text-blue-700">【支援予 合計】</td>
              {groupCells(footerStats.shienPlanned, footerStats.shienPlanned.total.c === 0)}
            </tr>
            <tr>
              <td className="pr-3 font-bold text-orange-700">【支援実 合計】</td>
              {groupCells(footerStats.shienActual, footerStats.shienActual.total.c === 0)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── 職員 2/3 用のミニセレクト ────────────────────────────────────────────────
function StaffMiniSelect({
  value,
  staff,
  excludeIds,
  onChange,
}: {
  value: string;
  staff: KaigoStaff[];
  excludeIds: string[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "w-full max-w-[110px] rounded border px-1 py-0.5 text-[11px]",
        value ? "border-gray-300 text-gray-800" : "border-gray-200 text-gray-400",
      )}
    >
      <option value="">—</option>
      {staff
        .filter((s) => s.id === value || !excludeIds.includes(s.id))
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
    </select>
  );
}
