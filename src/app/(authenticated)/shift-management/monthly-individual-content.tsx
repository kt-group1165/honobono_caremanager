"use client";

import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";
import { getServiceSystemMap } from "@/lib/service-system-lookup";
import { validInMonth } from "@/lib/service-code-valid";
import { isJudoHoumonService, resolveDoukouVariant } from "@/lib/shogai-doukou";
import { Fragment, useState, useEffect, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Check,
  Loader2,
  Copy,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
  X,
  Plus,
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
import { ServiceSelector } from "@/components/services/service-selector";
import { StaffCombobox } from "@/components/shared/staff-combobox";
import {
  SERVICE_TYPE_COLORS,
  buildAdditionalStaffPayload,
  insertVisitSchedules,
  supportsAdditionalStaff,
  supportsCancelColumns,
  supportsKinkyuHoumon,
  supportsStaff2Times,
  twoPersonMismatchWarning,
  staffTimeRelationWarning,
  type KaigoStaff,
  type VisitSchedule,
} from "./_shared";
import {
  AdditionalStaffSection,
  type AdditionalStaffRow,
} from "./additional-staff-section";
import { StaffSuggestChips } from "./staff-suggest-chips";
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
import { removeCancelFeeJippi, syncCancelFeeJippi } from "@/lib/visit-cancel";

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
  /** 未保存 (pending 状態変更 or 複写行) の有無を親へ通知。親は view/利用者/職員 切替を confirmIfPending でガードする */
  onPendingChangesChange?: (hasPending: boolean) => void;
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
  onPendingChangesChange,
}: MonthlyIndividualViewProps) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOfficeId } = useBusinessType();
  // 楽観的 local state (複写行 _isCopy 等)。SWR data の到着で sync する。
  const [schedules, setSchedules] = useState<VisitSchedule[]>(initialData.schedules);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);

  // 実績反映 (予実トグル / 実績変換 / 予定に戻す) は「保存ボタンで確定」方式。
  // ここでは DB を書かず pending として貯め (id → 変更後 status)、保存時に一括コミットする。
  const [pendingStatus, setPendingStatus] = useState<Map<string, "completed" | "scheduled">>(
    () => new Map(),
  );
  // sync effect (SWR→local) から最新 pending を参照するための ref ミラー
  const pendingStatusRef = useRef(pendingStatus);
  useEffect(() => { pendingStatusRef.current = pendingStatus; }, [pendingStatus]);
  const [saving, setSaving] = useState(false);

  // ─── サービス追加 (新規予定) モーダルの state ───
  // 追加は利用者ビューでのみ有効 (この画面の entityId を user_id として INSERT する)
  const canAdd = entityType === "user";
  // 列適用状況 (未適用環境では ServiceSelector の緊急時トグルや個別時間 UI を出さない。
  // INSERT 側は insertVisitSchedules が欠損列を strip して retry する)
  const [kinkyuSupported, setKinkyuSupported] = useState(false);
  const [staff2TimesSupported, setStaff2TimesSupported] = useState(false);
  const [additionalStaffSupported, setAdditionalStaffSupported] = useState(false);
  // キャンセル管理列 (migration visit_cancel_fee.sql)。未適用ならキャンセル UI 非表示
  const [cancelSupported, setCancelSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void supportsKinkyuHoumon(supabase).then((ok) => { if (!cancelled) setKinkyuSupported(ok); });
    void supportsStaff2Times(supabase).then((ok) => { if (!cancelled) setStaff2TimesSupported(ok); });
    void supportsAdditionalStaff(supabase).then((ok) => { if (!cancelled) setAdditionalStaffSupported(ok); });
    void supportsCancelColumns(supabase).then((ok) => { if (!cancelled) setCancelSupported(ok); });
    return () => { cancelled = true; };
  }, [supabase]);

  // ─── キャンセル (欠課) モーダルの state ───
  const [cancelModal, setCancelModal] = useState<VisitSchedule | null>(null);
  const [cancelForm, setCancelForm] = useState({ reason: "", fee: "" });
  const [cancelSaving, setCancelSaving] = useState(false);

  // キャンセル済行の理由・料金。SWR/初期 fetch の select には cancel 列を含めない
  // (列未適用環境で 42703 になるため)。対応 DB では cancelled 行分だけ単発で引く。
  const [cancelInfo, setCancelInfo] = useState<
    Map<string, { cancel_fee: number; cancel_reason: string | null }>
  >(new Map());
  useEffect(() => {
    if (!cancelSupported) return;
    const missing = schedules
      .filter(
        (s) =>
          s.status === "cancelled" &&
          !s._isCopy &&
          s.cancel_fee === undefined &&
          !cancelInfo.has(s.id),
      )
      .map((s) => s.id);
    if (missing.length === 0) return;
    let aborted = false;
    (async () => {
      const { data, error } = await supabase
        .from("kaigo_visit_schedule")
        .select("id, cancel_fee, cancel_reason")
        .in("id", missing);
      if (aborted) return;
      if (error) {
        console.error("cancel info fetch failed:", error.message);
        return;
      }
      setCancelInfo((prev) => {
        const next = new Map(prev);
        for (const r of (data ?? []) as { id: string; cancel_fee: number | null; cancel_reason: string | null }[]) {
          next.set(r.id, { cancel_fee: r.cancel_fee ?? 0, cancel_reason: r.cancel_reason });
        }
        return next;
      });
    })();
    return () => { aborted = true; };
  }, [schedules, cancelSupported, cancelInfo, supabase]);

  // 行のキャンセル料 (行自身の値 → 単発 fetch 済 map → 0)
  const cancelFeeOf = (s: VisitSchedule): number =>
    s.cancel_fee ?? cancelInfo.get(s.id)?.cancel_fee ?? 0;
  const cancelReasonOf = (s: VisitSchedule): string | null =>
    s.cancel_reason ?? cancelInfo.get(s.id)?.cancel_reason ?? null;

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({
    visit_date: "",
    start_time: "09:00",
    end_time: "10:00",
    service_type: "",
    staff_id: "",
    service_code: "",
    service_name: "",
    kinkyu_houmon: false,
  });
  const [addAdditional, setAddAdditional] = useState<AdditionalStaffRow[]>([]);
  const [addDoukou, setAddDoukou] = useState(false);
  const [addServiceSystem, setAddServiceSystem] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);
  const [showAddServiceSelector, setShowAddServiceSelector] = useState(false);

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

  // server truth の status (pending が server 値に戻ったら pending から外す判定に使う)
  const serverStatusById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of swrSchedules) m.set(s.id, s.status ?? "scheduled");
    return m;
  }, [swrSchedules]);

  // SWR data → local state へ sync。以下を保持する:
  //  - 未保存の複写行 _isCopy (DB 未挿入)
  //  - 未保存の pending 状態変更 (実績反映)。server 行に override を再適用する
  // ★ sentinel(null) 初期化: マウント時に swrSchedules が既にキャッシュ済 (同一参照) でも
  //   初回 sync を必ず走らせる (タブ切替直後に空表示になるバグの修正)。
  const lastSwrRef = useRef<VisitSchedule[] | null>(null);
  useEffect(() => {
    if (swrSchedules === lastSwrRef.current) return;
    lastSwrRef.current = swrSchedules;
    setSchedules((prev) => {
      const pendingCopies = prev.filter((s) => s._isCopy);
      const overrides = pendingStatusRef.current;
      const merged =
        overrides.size === 0
          ? swrSchedules
          : swrSchedules.map((s) => {
              const ov = overrides.get(s.id);
              return ov ? { ...s, status: ov } : s;
            });
      return pendingCopies.length > 0 ? [...merged, ...pendingCopies] : merged;
    });
  }, [swrSchedules]);

  // ─── 未保存 (dirty) 判定 + 離脱警告 ───────────────────────────────────────────
  // dirty = pending 状態変更あり or ローカル複写行あり
  const dirty = pendingStatus.size > 0 || schedules.some((s) => s._isCopy);
  // 親へ通知 (親は confirmIfPending で 利用者/職員/ビュー 切替をガード)
  useEffect(() => {
    onPendingChangesChange?.(dirty);
  }, [dirty, onPendingChangesChange]);
  // アンマウント時は親の pending フラグをクリア (別 view に残さない)
  useEffect(() => {
    return () => { onPendingChangesChange?.(false); };
  }, [onPendingChangesChange]);
  // ブラウザ閉じる / リロード / 戻る (非 SPA) の離脱警告
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // 月切替は key 変更で当 component が再マウント → pending が失われるため、dirty 時は confirm
  const guardedMonthChange = (d: Date) => {
    if (dirty && !window.confirm("未保存の変更があります。破棄して月を移動しますか？")) return;
    onMonthChange(d);
  };

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

  // pending へ状態変更を積む共通処理 (DB は書かない)。
  // server 値と一致する状態に戻したら pending から外す (= 実質未変更)。
  const stageStatus = (targets: VisitSchedule[], next: "completed" | "scheduled") => {
    if (targets.length === 0) return;
    const ids = new Set(targets.map((t) => t.id));
    // 表示を楽観更新
    setSchedules((prev) => prev.map((s) => (ids.has(s.id) ? { ...s, status: next } : s)));
    setPendingStatus((prev) => {
      const map = new Map(prev);
      for (const t of targets) {
        if (serverStatusById.get(t.id) === next) map.delete(t.id);
        else map.set(t.id, next);
      }
      return map;
    });
  };

  // 予実トグル (単発)。DB 書込はせず pending に積むだけ (保存ボタンで確定)。
  const toggleStatus = (sched: VisitSchedule) => {
    // キャンセル行・複写行・保存中は対象外
    if (sched.status === "cancelled" || sched._isCopy || saving) return;
    const next = sched.status === "completed" ? "scheduled" : "completed";
    stageStatus([sched], next);
  };

  // pending 1 件を DB にコミット (保存ボタンから呼ぶ)。成功で true。
  // 副作用: 実績化=visit_records(draft) insert / 予定戻し=visit_records delete。
  // ★ end_time + service_type まで一致で確認/削除 — 同日同開始時刻の別サービス記録
  //   (署名・バイタル入力済みを含む) と混同・巻き込み削除しないため (99f248b)。
  const commitStatusChange = async (
    sched: VisitSchedule,
    target: "completed" | "scheduled",
  ): Promise<boolean> => {
    if (target === "completed") {
      const { data: existing, error: existErr } = await supabase
        .from("kaigo_visit_records")
        .select("id")
        .eq("user_id", sched.user_id)
        .eq("visit_date", sched.visit_date)
        .eq("start_time", sched.start_time)
        .eq("end_time", sched.end_time)
        .eq("service_type", sched.service_type)
        .limit(1);
      if (existErr) {
        // 存在確認に失敗したまま INSERT すると重複記録を作りうるため中断
        console.error("visit_records existence check error:", existErr.message);
        return false;
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
          console.error("visit_records insert error:", error.message);
          return false;
        }
      }
      const { error: upErr } = await supabase
        .from("kaigo_visit_schedule")
        .update({ status: "completed" })
        .eq("id", sched.id);
      if (upErr) {
        console.error("visit_schedule update error:", upErr.message);
        return false;
      }
      return true;
    } else {
      const { error: delErr } = await supabase
        .from("kaigo_visit_records")
        .delete()
        .eq("user_id", sched.user_id)
        .eq("visit_date", sched.visit_date)
        .eq("start_time", sched.start_time)
        .eq("end_time", sched.end_time)
        .eq("service_type", sched.service_type);
      if (delErr) {
        // 記録が残ったまま schedule だけ予定に戻すと提供表・請求と食い違うため中断
        console.error("visit_records delete error:", delErr.message);
        return false;
      }
      const { error: upErr } = await supabase
        .from("kaigo_visit_schedule")
        .update({ status: "scheduled" })
        .eq("id", sched.id);
      if (upErr) {
        console.error("visit_schedule update error:", upErr.message);
        return false;
      }
      return true;
    }
  };

  // 保存: pending 状態変更を一括コミット。成功分のみ pending から外す (失敗分は残す = silent failure なし)。
  const handleSaveActuals = async () => {
    if (pendingStatus.size === 0 || saving) return;
    setSaving(true);
    const entries = Array.from(pendingStatus.entries());
    const done = new Set<string>(); // pending から外す id (成功 or 行消失)
    let successCount = 0;
    let failCount = 0;
    for (const [id, target] of entries) {
      const sched = schedules.find((s) => s.id === id);
      if (!sched) { done.add(id); continue; } // 行が消えている (削除済等) → pending 掃除のみ
      const ok = await commitStatusChange(sched, target);
      if (ok) { done.add(id); successCount++; } else { failCount++; }
    }
    setPendingStatus((prev) => {
      const next = new Map(prev);
      for (const id of done) next.delete(id);
      return next;
    });
    setSaving(false);
    if (failCount === 0) {
      toast.success(`${successCount}件の実績反映を保存しました（提供表にも反映）`);
    } else {
      toast.error(`${successCount}/${entries.length}件のみ保存できました（失敗分は未保存のまま・コンソール参照）`);
    }
    // server truth で SWR を更新。sync effect が残 pending override / 複写行を保持して再適用する。
    active.mutate();
  };

  // 破棄: pending 状態変更を捨て、表示を server 値に戻す (複写行は保持)。
  const handleDiscardActuals = () => {
    if (saving) return;
    setSchedules((prev) =>
      prev.map((s) => {
        const srv = serverStatusById.get(s.id);
        return srv && !s._isCopy && s.status !== srv ? { ...s, status: srv } : s;
      }),
    );
    setPendingStatus(new Map());
  };

  // ─── キャンセル (欠課) 操作 ───────────────────────────────────────────────
  const openCancelModal = (sched: VisitSchedule) => {
    const fee = cancelFeeOf(sched);
    setCancelForm({
      reason: cancelReasonOf(sched) ?? "",
      fee: fee > 0 ? String(fee) : "",
    });
    setCancelModal(sched);
  };

  const handleCancelSave = async () => {
    if (!cancelModal) return;
    const fee = parseInt(cancelForm.fee, 10) || 0;
    if (fee < 0) { toast.error("キャンセル料は 0 以上で入力してください"); return; }
    const reason = cancelForm.reason.trim() || null;
    setCancelSaving(true);
    const cancelledAt = new Date().toISOString();
    const { error } = await supabase
      .from("kaigo_visit_schedule")
      .update({
        status: "cancelled",
        cancelled_at: cancelledAt,
        cancel_reason: reason,
        cancel_fee: fee,
      })
      .eq("id", cancelModal.id);
    if (error) {
      toast.error("キャンセルの保存に失敗しました: " + error.message);
      setCancelSaving(false);
      return;
    }
    // キャンセル料 >0 は利用請求の実費へ連動 (0 は連動行を削除 = 記録のみ)
    const sync = await syncCancelFeeJippi(supabase, cancelModal, fee, reason);
    if (sync.error) {
      toast.error(
        "キャンセル料の実費連動に失敗: " + sync.error + " (利用請求タブの実費を手動で確認してください)",
      );
    } else if (sync.warning) {
      toast.warning(sync.warning);
    }
    setSchedules((prev) =>
      prev.map((s) =>
        s.id === cancelModal.id
          ? { ...s, status: "cancelled", cancelled_at: cancelledAt, cancel_reason: reason, cancel_fee: fee }
          : s,
      ),
    );
    setCancelInfo((prev) =>
      new Map(prev).set(cancelModal.id, { cancel_fee: fee, cancel_reason: reason }),
    );
    if (!sync.error && !sync.warning) {
      toast.success(
        fee > 0
          ? `キャンセルしました (キャンセル料 ¥${fee.toLocaleString()} を利用請求の実費に計上)`
          : "キャンセルしました (キャンセル料なし)",
      );
    }
    setCancelModal(null);
    setCancelSaving(false);
    active.mutate();
  };

  const handleUncancel = async () => {
    if (!cancelModal) return;
    setCancelSaving(true);
    const { error } = await supabase
      .from("kaigo_visit_schedule")
      .update({ status: "scheduled", cancelled_at: null, cancel_reason: null, cancel_fee: 0 })
      .eq("id", cancelModal.id);
    if (error) {
      toast.error("キャンセル解除に失敗しました: " + error.message);
      setCancelSaving(false);
      return;
    }
    // 連動していた実費行を削除 (二重計上・請求残り防止)
    const rm = await removeCancelFeeJippi(supabase, cancelModal.id);
    if (rm.error) {
      toast.error(
        "連動実費の削除に失敗: " + rm.error + " (利用請求タブの実費を手動で削除してください)",
      );
    }
    setSchedules((prev) =>
      prev.map((s) =>
        s.id === cancelModal.id
          ? { ...s, status: "scheduled", cancelled_at: null, cancel_reason: null, cancel_fee: 0 }
          : s,
      ),
    );
    setCancelInfo((prev) => {
      const next = new Map(prev);
      next.delete(cancelModal.id);
      return next;
    });
    toast.success("キャンセルを解除し、予定に戻しました");
    setCancelModal(null);
    setCancelSaving(false);
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

  // 一括「実績変換」: DB は書かず pending に積む (保存ボタンで確定)。
  const bulkToCompleted = () => {
    if (selectedIds.size === 0) { toast.error("対象を選択してください"); return; }
    // キャンセル行・複写行は実績変換の対象外
    const targets = schedules.filter(
      (s) => selectedIds.has(s.id) && s.status !== "completed" && s.status !== "cancelled" && !s._isCopy,
    );
    if (targets.length === 0) { toast.info("選択された予定はすべて実績済みかキャンセル済みです"); return; }
    stageStatus(targets, "completed");
    setSelectedIds(new Set());
    toast.success(`${targets.length}件を実績変換しました（保存ボタンで確定）`);
  };

  // 一括「予定に戻す」: DB は書かず pending に積む (保存ボタンで確定)。
  const bulkToScheduled = () => {
    if (selectedIds.size === 0) { toast.error("対象を選択してください"); return; }
    const targets = schedules.filter((s) => selectedIds.has(s.id) && s.status === "completed" && !s._isCopy);
    if (targets.length === 0) { toast.info("選択された予定はすべて予定状態です"); return; }
    stageStatus(targets, "scheduled");
    setSelectedIds(new Set());
    toast.success(`${targets.length}件を予定に戻しました（保存ボタンで確定）`);
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
          // キャンセル行の複写は通常の予定として作る (キャンセル情報は引き継がない)
          cancelled_at: null,
          cancel_reason: null,
          cancel_fee: 0,
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

  const openAddModal = () => {
    // 対象月内の初期値 (当月に今日が含まれれば今日、なければ月初)
    const todayStr = format(new Date(), "yyyy-MM-dd");
    const defaultAddDate = todayStr >= monthFrom && todayStr <= monthTo ? todayStr : monthFrom;
    setAddForm({
      visit_date: defaultAddDate,
      start_time: "09:00",
      end_time: "10:00",
      service_type: "",
      staff_id: "",
      service_code: "",
      service_name: "",
      kinkyu_houmon: false,
    });
    setAddAdditional([]);
    setAddDoukou(false);
    setAddServiceSystem(null);
    setAddOpen(true);
  };

  const handleAddSave = async () => {
    if (!addForm.visit_date) { toast.error("利用日を選択してください"); return; }
    if (!addForm.service_name) { toast.error("サービスを選択してください"); return; }
    setAddSaving(true);
    // 熟練同行: 障害の重訪で 2 人以上 + チェック ON のとき、同行コードへ差し替え
    const addBaseService = addForm.service_name || addForm.service_type;
    let addServiceType = addBaseService;
    const addHasSecond = addAdditional.some((r) => r.staff_id);
    if (
      addDoukou &&
      addServiceSystem === "障害" &&
      isJudoHoumonService(addBaseService) &&
      addHasSecond
    ) {
      const variant = await resolveDoukouVariant(
        supabase,
        addBaseService,
        Number(addForm.visit_date.slice(0, 4)),
        Number(addForm.visit_date.slice(5, 7)),
      );
      if (variant) {
        addServiceType = variant.name;
      } else {
        toast.warning("同行コードが見つかりません。基本コードで登録します");
      }
    }
    // 追加職員: additional_staff (jsonb) + 従来列 staff_id_2/3 + staff2/3_*_time ミラー。
    // 列未適用は insertVisitSchedules が strip して retry
    const addlPayload = buildAdditionalStaffPayload(addAdditional);
    const payload: Record<string, unknown> = {
      user_id: entityId,
      visit_date: addForm.visit_date,
      start_time: addForm.start_time + ":00",
      end_time: addForm.end_time + ":00",
      service_type: addServiceType,
      staff_id: addForm.staff_id || null,
      status: "scheduled",
      // C3: 緊急時訪問介護加算 (列未適用は strip)
      ...(kinkyuSupported ? { kinkyu_houmon: addForm.kinkyu_houmon } : {}),
      ...addlPayload,
      // C5: 発生元 office (列未適用は strip)
      ...(currentOfficeId ? { office_id: currentOfficeId } : {}),
    };
    const { error } = await insertVisitSchedules(supabase, [payload]);
    if (error) {
      toast.error("追加に失敗しました: " + error.message);
      setAddSaving(false);
      return;
    }
    toast.success("予定を追加しました");
    // 2人体制・時間関係の警告 (ブロックはしない)
    const first = addAdditional.find((r) => r.staff_id);
    const warn = twoPersonMismatchWarning(
      addForm.service_name || addForm.service_type,
      first?.staff_id || null,
    );
    if (warn) toast.warning(warn);
    if (first && first.custom && first.start && first.end) {
      const timeWarn = staffTimeRelationWarning(
        addForm.start_time, addForm.end_time,
        first.start, first.end,
        addForm.service_name || addForm.service_type,
        addServiceSystem === "障害",
      );
      if (timeWarn) toast.warning(timeWarn);
    }
    setAddOpen(false);
    setAddSaving(false);
    active.mutate();
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
      // キャンセル行の削除は連動実費行も先に消す (FK は SET NULL なので明示削除)
      if (sched.status === "cancelled" && cancelSupported) {
        const rm = await removeCancelFeeJippi(supabase, sched.id);
        if (rm.error) {
          console.error("riyou_jippi_entries delete error:", rm.error);
          continue;
        }
      }
      const { error: recDelErr } = await supabase.from("kaigo_visit_records").delete()
        // ★ 単発側と同じく end_time + service_type まで一致で削除 (別サービス記録の巻き込み削除防止)
        .eq("user_id", sched.user_id).eq("visit_date", sched.visit_date).eq("start_time", sched.start_time)
        .eq("end_time", sched.end_time).eq("service_type", sched.service_type);
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
    // 削除した行の pending 状態変更は無効になるので掃除 (stale pending 防止)
    setPendingStatus((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const id of succeeded) next.delete(id);
      return next.size === prev.size ? prev : next;
    });
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
      // キャンセル行は予定にも実績にも数えない (件数・料金は別サマリ)
      if (s.status === "cancelled") continue;
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
          <button onClick={() => guardedMonthChange(subMonths(currentMonth, 1))} className="rounded border p-1 hover:bg-gray-50"><ChevronLeft size={14} /></button>
          <span className="text-sm font-semibold">{format(currentMonth, "yyyy年M月", { locale: ja })}</span>
          <button onClick={() => guardedMonthChange(addMonths(currentMonth, 1))} className="rounded border p-1 hover:bg-gray-50"><ChevronRight size={14} /></button>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          予定 {schedules.filter((s) => s.status !== "completed" && s.status !== "cancelled").length}件
          / 実績 {schedules.filter((s) => s.status === "completed").length}件
          {(() => {
            // キャンセルの件数・料金合計 (一覧性サマリ)
            const cancelledRows = schedules.filter((s) => s.status === "cancelled" && !s._isCopy);
            if (cancelledRows.length === 0) return null;
            const feeSum = cancelledRows.reduce((sum, s) => sum + cancelFeeOf(s), 0);
            return (
              <span className="text-gray-600">
                / <span className="font-medium text-red-600">キャンセル {cancelledRows.length}件</span>
                {feeSum > 0 && <span className="text-red-600"> (料 ¥{feeSum.toLocaleString()})</span>}
              </span>
            );
          })()}
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
          disabled={bulkProcessing || saving || selectedIds.size === 0}
          className="inline-flex items-center gap-1 rounded border border-orange-300 bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-700 hover:bg-orange-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Check size={12} />
          実績変換
        </button>
        <button
          onClick={bulkToScheduled}
          disabled={bulkProcessing || saving || selectedIds.size === 0}
          className="inline-flex items-center gap-1 rounded border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <RotateCcw size={12} />
          予定に戻す
        </button>
        <button
          onClick={bulkCopy}
          disabled={bulkProcessing || saving || selectedIds.size === 0}
          className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Copy size={12} />
          複写
        </button>
        <button
          onClick={bulkDelete}
          disabled={bulkProcessing || saving || selectedIds.size === 0}
          className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Trash2 size={12} />
          削除
        </button>
        {bulkProcessing && <Loader2 size={14} className="animate-spin text-blue-500 ml-1" />}
        <div className="ml-auto flex items-center gap-2">
          {/* 実績反映 (予実トグル / 実績変換 / 予定に戻す) の未保存 pending。保存で一括コミット */}
          {pendingStatus.size > 0 && (
            <>
              <span className="text-xs font-medium text-amber-600 whitespace-nowrap">
                {pendingStatus.size}件の未保存の実績反映
              </span>
              <button
                onClick={handleDiscardActuals}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Undo2 size={12} />
                取消
              </button>
              <button
                onClick={handleSaveActuals}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                保存
              </button>
            </>
          )}
          {canAdd && (
            <button
              onClick={openAddModal}
              disabled={bulkProcessing || saving}
              className="inline-flex items-center gap-1 rounded border border-green-300 bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Plus size={12} />
              サービス追加
            </button>
          )}
        </div>
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
                {cancelSupported && (
                  <th className="border border-gray-300 px-1 py-1.5 text-center font-bold w-12">取消</th>
                )}
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
                const isCancelled = sched.status === "cancelled";
                const rowCancelFee = isCancelled ? cancelFeeOf(sched) : 0;
                // pending 状態変更 (未保存) の行はハイライト
                const isPending = pendingStatus.has(sched.id);

                return (
                  <tr
                    key={sched.id}
                    className={cn(
                      "hover:bg-yellow-50/50 transition-colors",
                      isCopy ? "bg-green-50/40"
                        : isCancelled ? "bg-gray-100/70 text-gray-400"
                        : isSun ? "bg-red-50/20" : isSat ? "bg-blue-50/20" : ""
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
                      ) : isCancelled ? (
                        <button
                          onClick={() => openCancelModal(sched)}
                          className="rounded-full bg-gray-300 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-gray-400 transition-colors"
                          title={`キャンセル済${cancelReasonOf(sched) ? ` (${cancelReasonOf(sched)})` : ""} — クリックで編集/解除`}
                        >
                          取消
                        </button>
                      ) : (
                        <button
                          onClick={() => toggleStatus(sched)}
                          disabled={saving}
                          title={
                            (isCompleted ? "実績 → 予定に戻す" : "予定 → 実績に変更") +
                            (isPending ? " (未保存 — 保存ボタンで確定)" : "")
                          }
                        >
                          {/* ラベルをピル内部に置く (隣接だと列が縮んだ時に重なる) */}
                          <span className={cn(
                            "relative inline-block h-[18px] w-10 shrink-0 rounded-full align-middle transition-colors",
                            isCompleted ? "bg-orange-500" : "bg-gray-300",
                            // 未保存の pending はリング表示 / 保存中は淡色
                            isPending && "ring-2 ring-amber-400 ring-offset-1",
                            saving && "opacity-50"
                          )}>
                            <span className={cn(
                              "absolute top-1/2 -translate-y-1/2 text-[10px] font-bold leading-none",
                              isCompleted ? "left-1.5 text-white" : "right-1.5 text-gray-600"
                            )}>
                              {isCompleted ? "実" : "予"}
                            </span>
                            <span className={cn(
                              // 白丸は left を calc(100%-16px)=トラック幅追従 で右アンカー。translate の
                              // 固定値だとトラック幅とズレて右にはみ出るため。left 遷移でスライドも維持
                              // (knob14px + 右余白2px = 16px / 左は 2px)
                              "absolute top-0.5 h-[14px] w-[14px] rounded-full bg-white shadow transition-all",
                              isCompleted ? "left-[calc(100%_-_16px)]" : "left-0.5"
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
                      <span className={cn("font-mono", isCancelled && "line-through")}>{sched.start_time?.slice(0, 5)}-{sched.end_time?.slice(0, 5)}</span>
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
                        SERVICE_TYPE_COLORS[sched.service_type] ?? "bg-gray-100 text-gray-700",
                        isCancelled && "line-through opacity-60"
                      )}>
                        {sched.service_type}
                      </span>
                      {isCancelled && (
                        <span
                          className="ml-1 inline-block rounded border border-red-200 bg-red-50 px-1 py-0.5 text-[9px] font-bold text-red-500 whitespace-nowrap"
                          title={cancelReasonOf(sched) ?? undefined}
                        >
                          キャンセル{rowCancelFee > 0 ? ` ¥${rowCancelFee.toLocaleString()}` : ""}
                        </span>
                      )}
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
                    {cancelSupported && (
                      <td className="border border-gray-300 px-1 py-1 text-center">
                        {isCopy ? null : isCancelled ? (
                          <button
                            onClick={() => openCancelModal(sched)}
                            className="text-[10px] font-medium text-red-500 hover:text-red-700 underline decoration-dotted"
                            title="キャンセル内容の編集 / 解除"
                          >
                            {rowCancelFee > 0 ? `¥${rowCancelFee.toLocaleString()}` : "編集"}
                          </button>
                        ) : isCompleted ? (
                          <span className="text-gray-300" title="実績は一旦予定に戻してからキャンセルしてください">—</span>
                        ) : (
                          <button
                            onClick={() => openCancelModal(sched)}
                            className="text-gray-300 hover:text-red-500 transition-colors"
                            title="キャンセル (欠課) にする"
                          >
                            <Ban size={14} />
                          </button>
                        )}
                      </td>
                    )}
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

      {/* サービス追加モーダル (新規予定。介護・障害 両対応) */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-semibold text-gray-900">サービス追加 — {entityName}</h2>
              <button onClick={() => setAddOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">利用日</label>
                <input
                  type="date"
                  value={addForm.visit_date}
                  min={monthFrom}
                  max={monthTo}
                  onChange={(e) => setAddForm((f) => ({ ...f, visit_date: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">開始時間</label>
                  <input
                    type="time"
                    value={addForm.start_time}
                    onChange={(e) => { const v = e.target.value; setAddForm((f) => ({ ...f, start_time: v, end_time: f.end_time <= v ? v : f.end_time })); }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">終了時間</label>
                  <input
                    type="time"
                    value={addForm.end_time}
                    min={addForm.start_time}
                    onChange={(e) => { const v = e.target.value; setAddForm((f) => ({ ...f, end_time: v < f.start_time ? f.start_time : v })); }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                  サービス
                  <ServiceSystemBadge system={addServiceSystem} />
                </label>
                <button
                  type="button"
                  onClick={() => setShowAddServiceSelector(true)}
                  className="w-full flex items-center justify-between rounded-lg border border-gray-300 px-3 py-2 text-sm text-left hover:bg-gray-50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
                >
                  <span className={addForm.service_name ? "text-gray-900" : "text-gray-400"}>
                    {addForm.service_name || "サービスを選択..."}
                  </span>
                  {addForm.service_code ? (
                    <span className="text-xs text-gray-400 font-mono">{addForm.service_code}</span>
                  ) : (
                    <ChevronRight size={14} className="text-gray-400" />
                  )}
                </button>
                {/* ServiceSelector は 介護・障害 両タブを内包 (system 未指定でユーザーがタブ切替) */}
                <ServiceSelector
                  open={showAddServiceSelector}
                  onClose={() => setShowAddServiceSelector(false)}
                  startTime={addForm.start_time}
                  endTime={addForm.end_time}
                  showVisitAddons={kinkyuSupported}
                  kinkyu={addForm.kinkyu_houmon}
                  onKinkyuChange={(v) => setAddForm((f) => ({ ...f, kinkyu_houmon: v }))}
                  onSelect={(service) => {
                    setAddForm((f) => ({
                      ...f,
                      service_type: service.categoryName,
                      service_code: service.code,
                      service_name: service.name,
                    }));
                    setAddServiceSystem(service.system);
                    setShowAddServiceSelector(false);
                  }}
                />
                {kinkyuSupported && addForm.kinkyu_houmon && (
                  <p className="mt-1 text-xs font-medium text-red-600">＋ 緊急時訪問介護加算</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">担当職員</label>
                <StaffCombobox
                  value={addForm.staff_id}
                  onChange={(id) => setAddForm((f) => ({ ...f, staff_id: id }))}
                  options={staff.map((s) => ({
                    id: s.id,
                    name: s.name,
                    furigana: (s as unknown as { furigana?: string | null }).furigana ?? null,
                  }))}
                />
                {/* 割当サジェスト (候補提示のみ)。この view は月データ (全利用者分) を持たないため対象日 1 日分を自前 fetch */}
                <StaffSuggestChips
                  userId={entityType === "user" ? entityId : null}
                  visitDate={addForm.visit_date}
                  startTime={addForm.start_time}
                  endTime={addForm.end_time}
                  staff={staff}
                  currentStaffId={addForm.staff_id}
                  excludeStaffIds={addAdditional.map((r) => r.staff_id).filter(Boolean)}
                  onSelect={(id) => setAddForm((f) => ({ ...f, staff_id: id }))}
                />
              </div>

              {/* 追加職員 (2人体制・同行、主 + 最大9名) */}
              <AdditionalStaffSection
                rows={addAdditional}
                onChange={setAddAdditional}
                staffOptions={staff.map((s) => ({
                  id: s.id,
                  name: s.name,
                  furigana: (s as unknown as { furigana?: string | null }).furigana ?? null,
                }))}
                mainStaffId={addForm.staff_id}
                mainStart={addForm.start_time}
                mainEnd={addForm.end_time}
                serviceName={addForm.service_name || addForm.service_type}
                isShogai={addServiceSystem === "障害"}
                showCustomTime={staff2TimesSupported && additionalStaffSupported}
                doukou={addDoukou}
                onDoukouChange={setAddDoukou}
                serviceIsJudoHoumon={isJudoHoumonService(addForm.service_name || addForm.service_type)}
              />
            </div>

            <div className="flex justify-end gap-2 border-t px-5 py-4">
              <button
                onClick={() => setAddOpen(false)}
                className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleAddSave}
                disabled={addSaving}
                className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {addSaving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                追加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* キャンセル (欠課) モーダル — 理由 + キャンセル料 (自費)。料 >0 は利用請求の実費に連動 */}
      {cancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-gray-900">
                  {cancelModal.status === "cancelled" ? "キャンセル内容の編集" : "訪問をキャンセル (欠課)"}
                </h2>
                {cancelModal.status === "cancelled" && (
                  <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-bold text-gray-600">キャンセル済</span>
                )}
              </div>
              <button onClick={() => setCancelModal(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                <p className="font-semibold">
                  {format(parseISO(cancelModal.visit_date), "yyyy年M月d日(E)", { locale: ja })}{" "}
                  {cancelModal.start_time?.slice(0, 5)}-{cancelModal.end_time?.slice(0, 5)}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">{cancelModal.service_type}</p>
              </div>
              <p className="text-xs text-gray-500 leading-relaxed">
                キャンセルにすると保険請求 (実績集計) の対象外になります。
                キャンセル料を入力すると利用請求タブの「利用実費」に自動計上されます (0 円 = 記録のみ)。
              </p>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">キャンセル理由</label>
                <input
                  type="text"
                  value={cancelForm.reason}
                  onChange={(e) => setCancelForm((f) => ({ ...f, reason: e.target.value }))}
                  placeholder="例: 利用者都合 (当日連絡)"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">キャンセル料 (円・自費)</label>
                <input
                  type="number"
                  min={0}
                  value={cancelForm.fee}
                  onChange={(e) => setCancelForm((f) => ({ ...f, fee: e.target.value }))}
                  placeholder="0 (記録のみ)"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-right tabular-nums focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
                />
                {(parseInt(cancelForm.fee, 10) || 0) > 0 && (
                  <p className="mt-1 text-xs font-medium text-emerald-700">
                    ¥{(parseInt(cancelForm.fee, 10) || 0).toLocaleString()} を
                    {Number(cancelModal.visit_date.slice(5, 7))}月の利用請求 (実費) に計上します
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between border-t px-5 py-4">
              {cancelModal.status === "cancelled" ? (
                <button
                  onClick={handleUncancel}
                  disabled={cancelSaving}
                  className="inline-flex items-center gap-1 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors"
                >
                  <RotateCcw size={14} />
                  キャンセル解除 (予定に戻す)
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setCancelModal(null)}
                  className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  閉じる
                </button>
                <button
                  onClick={handleCancelSave}
                  disabled={cancelSaving}
                  className="flex items-center gap-1 rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                >
                  {cancelSaving ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
                  {cancelModal.status === "cancelled" ? "更新" : "キャンセルする"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── サービス種別バッジ (選択したサービスの制度区分を自動表示) ────────────────
function ServiceSystemBadge({ system }: { system: string | null }) {
  if (!system) return null;
  const label = system === "総合事業" ? "総合" : system === "独自" ? "独自" : system === "地域生活支援" ? "地域" : system;
  const cls =
    system === "介護"
      ? "bg-blue-100 text-blue-700"
      : system === "総合事業"
      ? "bg-emerald-100 text-emerald-700"
      : system === "障害"
      ? "bg-purple-100 text-purple-700"
      : system === "地域生活支援"
      ? "bg-violet-100 text-violet-700"
      : "bg-amber-100 text-amber-700";
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", cls)}>
      {label}
    </span>
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
