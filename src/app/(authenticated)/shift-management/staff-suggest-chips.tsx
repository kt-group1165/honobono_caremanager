"use client";

// ヘルパー割当サジェストの候補チップ (予定編集/追加モーダルの担当職員欄の下に置く)。
// 「候補」ボタン押下で展開 (lazy)。チップクリックで onSelect → 既存の手動選択はそのまま残る。
//
// データ取得方針 (heavy query を作らない):
//   - monthSchedules / availability を props で渡されたらそれを使う (user-calendar は月データを保持済み)
//   - 渡されない呼出元 (月間個別・共有編集モーダル) は対象日 1 日分のみ fetch (page-loop 付き)
//   - 優先ヘルパー (client_office_assignments.preferred_staff) は 1 行 fetch。
//     migration 未適用 (42703) は優先加点なしで動くフォールバック

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { Loader2, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchDayAvailability,
  fetchDayBathBusy,
  fetchDaySchedules,
  fetchPreferredStaffIds,
  suggestStaff,
  type SuggestScheduleRow,
} from "@/lib/staff-suggest";
import type { KaigoStaff, StaffAvailabilitySlot } from "./_shared";

interface StaffSuggestChipsProps {
  /** 対象利用者。null/空なら何も表示しない */
  userId: string | null | undefined;
  /** 対象日 "yyyy-MM-dd"。空なら何も表示しない (未保存の複写行等) */
  visitDate: string | null | undefined;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  /** 候補プール (自事業所の active 職員) */
  staff: KaigoStaff[];
  /** 現在選択中の職員 (チップの強調表示用) */
  currentStaffId?: string;
  /** 編集中の予定 id (自分自身を重複扱いしない) */
  excludeScheduleId?: string;
  /** 候補から外す職員 (追加職員に割当済み等) */
  excludeStaffIds?: string[];
  /** 表示月の全予定 (あれば使う。無ければ対象日 1 日分を自前 fetch) */
  monthSchedules?: SuggestScheduleRow[];
  /** 表示月の出勤可否 (同上) */
  availability?: StaffAvailabilitySlot[];
  onSelect: (staffId: string) => void;
}

export function StaffSuggestChips({
  userId,
  visitDate,
  startTime,
  endTime,
  staff,
  currentStaffId,
  excludeScheduleId,
  excludeStaffIds,
  monthSchedules,
  availability,
  onSelect,
}: StaffSuggestChipsProps) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOfficeId } = useBusinessType();

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 優先ヘルパー (fetch 済み)。null = 未取得
  const [preferredIds, setPreferredIds] = useState<string[] | null>(null);
  // fallback で取得した 1 日分データ (取得日をキーに保持)
  const [dayData, setDayData] = useState<{
    date: string;
    schedules: SuggestScheduleRow[];
    availability: StaffAvailabilitySlot[];
  } | null>(null);

  const needsDayFetch = !monthSchedules;

  // 訪問入浴の号車拘束 (兼務対応)。monthSchedules には入浴分が含まれないため常に対象日分を fetch
  const [bathBusy, setBathBusy] = useState<{ date: string; rows: SuggestScheduleRow[] } | null>(null);

  // userId / office が変わったら優先ヘルパーを取り直す (開いたままの月間個別モーダル等)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- key 変更に伴う derived reset
    setPreferredIds(null);
    setOpen(false);
    setError(null);
  }, [userId, currentOfficeId]);

  // 展開中に日付が変わったら 1 日分データを取り直す (月間個別の追加モーダル)
  useEffect(() => {
    if (!open || !needsDayFetch || !visitDate) return;
    if (dayData?.date === visitDate) return;
    let cancelled = false;
    (async () => {
      const [sched, avail] = await Promise.all([
        fetchDaySchedules(supabase, visitDate),
        fetchDayAvailability(supabase, visitDate),
      ]);
      if (cancelled) return;
      const err = sched.error ?? avail.error;
      if (err) {
        console.error("staff-suggest day fetch failed:", err);
        setError("候補の取得に失敗しました: " + err);
      } else {
        setError(null);
        setDayData({ date: visitDate, schedules: sched.rows, availability: avail.rows });
      }
    })();
    return () => { cancelled = true; };
  }, [open, needsDayFetch, visitDate, dayData, supabase]);

  // 展開中は対象日の号車拘束も取り直す (エラー時は拘束なしで続行、握りつぶさず log)
  useEffect(() => {
    if (!open || !visitDate) return;
    if (bathBusy?.date === visitDate) return;
    let cancelled = false;
    (async () => {
      const res = await fetchDayBathBusy(supabase, visitDate);
      if (cancelled) return;
      if (res.error) console.error("bath busy fetch failed:", res.error);
      setBathBusy({ date: visitDate, rows: res.rows });
    })();
    return () => { cancelled = true; };
  }, [open, visitDate, bathBusy, supabase]);

  const handleOpen = async () => {
    if (!userId || !visitDate) return;
    setOpen(true);
    setError(null);
    if (preferredIds === null) {
      if (currentOfficeId) {
        const res = await fetchPreferredStaffIds(supabase, userId, currentOfficeId);
        if (res.error) {
          // 優先加点なしで続行 (握りつぶさず表示はする)
          console.error("preferred_staff fetch failed:", res.error);
          setError("優先ヘルパーの取得に失敗しました (空き・実績のみで表示): " + res.error);
        }
        setPreferredIds(res.ids);
      } else {
        // office 未確定 (?office= なし) は優先加点なしで続行
        setPreferredIds([]);
      }
    }
  };

  const suggestions = useMemo(() => {
    if (!open || !userId || !visitDate || preferredIds === null) return null;
    const schedules = monthSchedules ?? (dayData?.date === visitDate ? dayData.schedules : null);
    const avail = availability ?? (dayData?.date === visitDate ? dayData.availability : null);
    if (!schedules || !avail) return null; // fetch 中
    if (bathBusy?.date !== visitDate) return null; // 号車拘束 fetch 中
    return suggestStaff({
      staff,
      userId,
      visitDate,
      startTime,
      endTime,
      schedules: bathBusy.rows.length ? [...schedules, ...bathBusy.rows] : schedules,
      availability: avail,
      preferredIds,
      excludeScheduleId,
      excludeStaffIds,
      limit: 5,
    });
  }, [
    open, userId, visitDate, startTime, endTime, staff, preferredIds,
    monthSchedules, availability, dayData, bathBusy, excludeScheduleId, excludeStaffIds,
  ]);

  if (!userId || !visitDate) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => void handleOpen()}
        className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors"
        title="空き・出勤可否・優先ヘルパー・担当実績から候補を提示します"
      >
        <Sparkles size={12} />
        候補を表示
      </button>
    );
  }

  return (
    <div className="mt-1.5 rounded-lg border border-blue-100 bg-blue-50/50 p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-700">
          <Sparkles size={10} />
          割当候補 (重複・出勤不可を除外)
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-gray-400 hover:text-gray-600"
          title="候補を閉じる"
        >
          <X size={12} />
        </button>
      </div>
      {error && (
        <p className="mb-1 text-[10px] text-red-600">{error}</p>
      )}
      {suggestions === null ? (
        !error && (
          <div className="flex items-center gap-1 py-1 text-xs text-gray-500">
            <Loader2 size={12} className="animate-spin" />
            計算中...
          </div>
        )
      ) : suggestions.length === 0 ? (
        <p className="py-0.5 text-xs text-gray-500">
          条件に合う職員がいません (全員が重複または出勤不可)
        </p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((s, i) => {
            const isCurrent = currentStaffId === s.staffId;
            return (
              <button
                key={s.staffId}
                type="button"
                onClick={() => onSelect(s.staffId)}
                title={`${s.name}: ${s.reasons.join(" / ")}`}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs transition-colors",
                  isCurrent
                    ? "border-blue-500 bg-blue-600 text-white"
                    : "border-blue-200 bg-white text-gray-700 hover:border-blue-400 hover:bg-blue-50",
                )}
              >
                <span className={cn("font-bold", isCurrent ? "text-blue-100" : "text-blue-500")}>
                  {i + 1}
                </span>
                <span className="font-medium">{s.name}</span>
                <span className={cn("text-[10px]", isCurrent ? "text-blue-100" : "text-gray-400")}>
                  {s.reasons.join("・")}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
