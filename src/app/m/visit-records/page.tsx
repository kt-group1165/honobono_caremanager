"use client";

/**
 * スマホ用 サービス実施記録 (訪問介護)
 *
 * URL: /m/visit-records
 *
 * 職員が「自分の担当訪問」を日付で選び、実施内容＋利用者サインを取得して
 * kaigo_visit_records に保存する軽量フォーム。
 *
 * - サイドバー / ヘッダなしのミニマル SP UI (/m/visit-procedures と同系統)
 * - 職員解決: members.auth_user_id = auth.uid()
 * - 一覧: kaigo_visit_schedule を visit_date + (主担当 staff_id OR 従担当
 *   staff_id_2 / staff_id_3 OR additional_staff jsonb に自分を含む) で絞込み。
 *   従担当 (2 人体制の同行者) の訪問も記録・サイン可能。
 *   ※ staff_id_2/3・additional_staff 列が未適用 (42703) や cs 演算子非対応の
 *     環境では主 + 2/3 だけ、さらに主のみへ段階的に fallback する (握らず warning)。
 * - 署名保存: PC 版 visit-records-content.tsx (署名 v2 方式) を流用。
 *   dataURL → PNG blob → Storage "signatures" bucket upload →
 *   kaigo_visit_records に signature_image_path / signed_at / signer_name。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { format, addDays } from "date-fns";
import {
  ClipboardList,
  Loader2,
  ChevronLeft,
  ChevronRight,
  LogOut,
  CheckCircle2,
  ArrowLeft,
  Clock,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { SignaturePad } from "@/components/signature-pad";
import { resolvePreferredTenantId } from "@/lib/tenant-resolver";
import { VoiceInputButton } from "@/components/shared/VoiceInputButton";

// ─── 型 ───────────────────────────────────────────────────────────────────────

interface Member {
  id: string;
  name: string;
}

interface ScheduleRow {
  id: string;
  user_id: string;
  staff_id: string | null;
  staff_id_2: string | null;
  staff_id_3: string | null;
  additional_staff: Array<{ staff_id: string }> | null;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  service_type: string | null;
  // 打刻 (migrations/visit_clock.sql 未適用の環境では列が無い → fetch 側で
  // 42703 を検知して打刻機能を無効化するため optional 扱い)
  clock_in_at?: string | null;
  clock_out_at?: string | null;
  clients: { name: string | null } | null;
}

// 自分がこの訪問で担う役割
type StaffRole = "主" | "従";

/** schedule 行から自分 (me = member.id) の役割を判定する。主担当を優先。 */
function myRole(s: ScheduleRow, me: string): StaffRole {
  if (s.staff_id === me) return "主";
  return "従";
}

// schedule_id で既存 record を突合するための最小型
interface ExistingRecord {
  id: string;
  schedule_id: string | null;
  signature_image_path: string | null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const hhmm = (t: string | null): string => (t ? t.slice(0, 5) : "");

/** 打刻 TIMESTAMPTZ → "HH:mm" (ローカル時刻)。parse 不能はそのまま返す。 */
function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return format(new Date(iso), "HH:mm");
  } catch {
    return iso;
  }
}

function formatJpDate(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${Number(m[2])}月${Number(m[3])}日`;
}

// kaigo_visit_records.status は CHECK 制約で draft / confirmed / submitted のみ (completed 不可)。
// PC 版 insert に合わせ新規は "draft" で作成する。
const RECORD_STATUS = "draft";

// ─── ページ ───────────────────────────────────────────────────────────────────

export default function MobileVisitRecordsPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [member, setMember] = useState<Member | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [bootLoading, setBootLoading] = useState(true);

  const [date, setDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [records, setRecords] = useState<ExistingRecord[]>([]);
  const [listLoading, setListLoading] = useState(false);

  // 選択中の訪問 (フォーム表示)。null = 一覧表示。
  const [selected, setSelected] = useState<ScheduleRow | null>(null);

  // 打刻列 (clock_in_at/clock_out_at) が DB に適用済みか。
  // 未適用 (42703) を fetch 時に検知したら false にして打刻ボタンを非表示にする。
  // ref は fetchList の依存に入れず再フェッチループを避けるための鏡。
  const [clockSupported, setClockSupported] = useState(true);
  const clockSupportedRef = useRef(true);
  // 打刻の保存中フラグ ("scheduleId:in" / "scheduleId:out")
  const [clocking, setClocking] = useState<string | null>(null);

  // フォーム state
  const [bodyCare, setBodyCare] = useState("");
  const [livingSupport, setLivingSupport] = useState("");
  const [userCondition, setUserCondition] = useState("");
  // バイタル (任意)。空文字 = 未入力 → 保存時 null。
  const [vitalTemp, setVitalTemp] = useState("");
  const [vitalBpSys, setVitalBpSys] = useState("");
  const [vitalBpDia, setVitalBpDia] = useState("");
  const [vitalPulse, setVitalPulse] = useState("");
  const [vitalSpo2, setVitalSpo2] = useState("");
  const [notes, setNotes] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [signerName, setSignerName] = useState("");
  const [saving, setSaving] = useState(false);

  // 音声入力 (VoiceInputButton) がカーソル位置を読むための textarea ref
  const bodyCareRef = useRef<HTMLTextAreaElement>(null);
  const livingSupportRef = useRef<HTMLTextAreaElement>(null);
  const userConditionRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  // ── 1) 職員 (member) 解決 ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { user },
        error: authErr,
      } = await supabase.auth.getUser();
      if (cancelled) return;
      if (authErr || !user) {
        setMemberError("認証情報が取得できません。ログインし直してください。");
        setBootLoading(false);
        return;
      }
      const { data, error } = await supabase
        .from("members")
        .select("id, name")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setMemberError("職員情報の取得に失敗しました: " + error.message);
        setBootLoading(false);
        return;
      }
      if (!data) {
        setMemberError(
          "職員情報が見つかりません。このアカウントは訪問担当職員として登録されていません。"
        );
        setBootLoading(false);
        return;
      }
      setMember(data as Member);
      setBootLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // ── 2) 担当訪問 + 既存 record 取得 ───────────────────────────────────────────
  const fetchList = useCallback(async () => {
    if (!member) return;
    setListLoading(true);
    const me = member.id;
    // 担当訪問: 主担当 (staff_id) OR 従担当 (staff_id_2/3 / additional_staff)。
    // PostgREST の 42703 (列未適用) / cs 非対応時は段階的に fallback する。
    // - full   : 主 + 2/3 + additional_staff(cs)
    // - noCs    : 主 + 2/3           (additional_staff の cs を外す)
    // - primary : 主のみ             (2/3 列も無い最古環境)
    const BASE_COLS =
      "id, user_id, staff_id, staff_id_2, staff_id_3, additional_staff, visit_date, start_time, end_time, service_type, clients(name)";
    // 打刻列 (migrations/visit_clock.sql)。未適用環境では 42703 → 打刻機能を無効化して再取得。
    const CLOCK_COLS = ", clock_in_at, clock_out_at";
    // additional_staff は jsonb 配列 [{staff_id,...}]。contains (cs) で自分を含む行を拾う。
    const csFilter = `additional_staff.cs.[{"staff_id":"${me}"}]`;
    const orFull = `staff_id.eq.${me},staff_id_2.eq.${me},staff_id_3.eq.${me},${csFilter}`;
    const orNoCs = `staff_id.eq.${me},staff_id_2.eq.${me},staff_id_3.eq.${me}`;

    const runQuery = (orExpr: string | null, withClock: boolean) => {
      let q = supabase
        .from("kaigo_visit_schedule")
        .select(withClock ? BASE_COLS + CLOCK_COLS : BASE_COLS)
        .eq("visit_date", date)
        .neq("status", "cancelled");
      q = orExpr ? q.or(orExpr) : q.eq("staff_id", me);
      return q.order("start_time");
    };

    // 42703 (undefined column) / cs 演算子エラーを判定
    const isColumnOrCsError = (msg: string, code?: string): boolean =>
      code === "42703" ||
      /column .* does not exist/i.test(msg) ||
      /operator does not exist/i.test(msg) ||
      /invalid input syntax|cs\b|contains/i.test(msg);
    // 打刻列そのものの未適用 (42703 でメッセージに clock_in_at / clock_out_at)
    const isClockColumnError = (msg: string): boolean =>
      /clock_(in|out)_at/i.test(msg);

    // 既存の 3 段 fallback (full → noCs → primary) を打刻列あり/なしで実行
    const runChain = async (withClock: boolean) => {
      // 1) full (OR + cs)
      let res = await runQuery(orFull, withClock);
      if (res.error && !isClockColumnError(res.error.message) && isColumnOrCsError(res.error.message, res.error.code)) {
        console.warn("schedule OR+cs 非対応、主+2/3 に fallback:", res.error.message);
        // 2) noCs (OR without cs)
        res = await runQuery(orNoCs, withClock);
        if (res.error && !isClockColumnError(res.error.message) && isColumnOrCsError(res.error.message, res.error.code)) {
          console.warn("staff_id_2/3 列も未適用、主担当のみに fallback:", res.error.message);
          // 3) primary only
          res = await runQuery(null, withClock);
        }
      }
      return res;
    };

    let res = await runChain(clockSupportedRef.current);
    if (clockSupportedRef.current && res.error && isClockColumnError(res.error.message)) {
      console.warn("clock_in_at/clock_out_at 列が未適用のため打刻機能を無効化:", res.error.message);
      clockSupportedRef.current = false;
      setClockSupported(false);
      res = await runChain(false);
    }
    if (res.error) {
      console.error("schedule fetch failed:", res.error.message);
      toast.error("訪問予定の取得に失敗しました: " + res.error.message);
      setSchedules([]);
      setRecords([]);
      setListLoading(false);
      return;
    }
    let rows = (res.data ?? []) as unknown as ScheduleRow[];
    // fallback で additional_staff / 打刻列が来なくても型を満たすよう既定を補う
    rows = rows.map((r) => ({
      ...r,
      staff_id_2: r.staff_id_2 ?? null,
      staff_id_3: r.staff_id_3 ?? null,
      additional_staff: r.additional_staff ?? null,
      clock_in_at: r.clock_in_at ?? null,
      clock_out_at: r.clock_out_at ?? null,
    }));
    setSchedules(rows);

    // 当日分の既存 record を schedule_id で突合 (サイン済判定用)
    const scheduleIds = rows.map((r) => r.id);
    if (scheduleIds.length > 0) {
      const { data: recData, error: recErr } = await supabase
        .from("kaigo_visit_records")
        .select("id, schedule_id, signature_image_path")
        .in("schedule_id", scheduleIds);
      if (recErr) {
        console.error("record fetch failed:", recErr.message);
        toast.error("既存記録の取得に失敗しました: " + recErr.message);
        setRecords([]);
      } else {
        setRecords((recData ?? []) as ExistingRecord[]);
      }
    } else {
      setRecords([]);
    }
    setListLoading(false);
  }, [supabase, member, date]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- fetch on member/date change */
    if (member) fetchList();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [member, fetchList]);

  // schedule_id → 既存 record (突合用)
  const recordBySchedule = useMemo(() => {
    const map = new Map<string, ExistingRecord>();
    for (const r of records) {
      if (r.schedule_id) map.set(r.schedule_id, r);
    }
    return map;
  }, [records]);

  // ── 打刻 (開始/終了) ──────────────────────────────────────────────────────
  // 押下時刻を kaigo_visit_schedule.clock_in_at / clock_out_at に記録する。
  // 予定の start_time / end_time は変更しない (打刻は別データ = 予実対比用)。
  // 打刻済みの再押下は confirm の上で現在時刻に訂正する。
  const handleClock = async (s: ScheduleRow, kind: "in" | "out") => {
    const col = kind === "in" ? "clock_in_at" : "clock_out_at";
    const label = kind === "in" ? "開始" : "終了";
    const existing = kind === "in" ? s.clock_in_at : s.clock_out_at;
    if (existing) {
      const ok = window.confirm(
        `${label}打刻は ${fmtClock(existing)} で記録済みです。現在時刻で訂正しますか?`
      );
      if (!ok) return;
    }
    const now = new Date().toISOString();
    const key = `${s.id}:${kind}`;
    setClocking(key);
    const { error } = await supabase
      .from("kaigo_visit_schedule")
      .update({ [col]: now })
      .eq("id", s.id);
    setClocking(null);
    if (error) {
      console.error("clock update failed:", error.message);
      toast.error(`${label}打刻に失敗しました: ` + error.message);
      return;
    }
    setSchedules((prev) => prev.map((r) => (r.id === s.id ? { ...r, [col]: now } : r)));
    setSelected((prev) => (prev && prev.id === s.id ? { ...prev, [col]: now } : prev));
    toast.success(`${label}打刻を記録しました (${fmtClock(now)})`);
  };

  // ── フォームを開く ─────────────────────────────────────────────────────────
  const openForm = (s: ScheduleRow) => {
    setSelected(s);
    setBodyCare("");
    setLivingSupport("");
    setUserCondition("");
    setVitalTemp("");
    setVitalBpSys("");
    setVitalBpDia("");
    setVitalPulse("");
    setVitalSpo2("");
    setNotes("");
    setSignature(null);
    setSignerName(s.clients?.name ?? "");
  };

  const closeForm = () => {
    setSelected(null);
  };

  // ── 3) 保存 (upsert: schedule_id で既存検索 → update / insert) ───────────────
  const handleSave = async () => {
    if (!selected || !member) return;
    if (signature && !signerName.trim()) {
      toast.error("サインがある場合は署名者名を入力してください");
      return;
    }
    setSaving(true);

    // a) schedule_id で既存 record を検索
    const { data: existing, error: findErr } = await supabase
      .from("kaigo_visit_records")
      .select("id")
      .eq("schedule_id", selected.id)
      .maybeSingle();
    if (findErr) {
      console.error("record lookup failed:", findErr.message);
      toast.error("既存記録の確認に失敗しました: " + findErr.message);
      setSaving(false);
      return;
    }

    // number 文字列 → number | null。空/非数値は null。
    const numOrNull = (v: string): number | null => {
      const t = v.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    };
    const body = {
      body_care: bodyCare.trim() || null,
      living_support: livingSupport.trim() || null,
      user_condition: userCondition.trim() || null,
      vital_temperature: numOrNull(vitalTemp),
      vital_bp_sys: numOrNull(vitalBpSys),
      vital_bp_dia: numOrNull(vitalBpDia),
      vital_pulse: numOrNull(vitalPulse),
      vital_spo2: numOrNull(vitalSpo2),
      notes: notes.trim() || null,
    };

    let recordId: string;
    if (existing) {
      // b-1) 既存 → update (実施内容のみ更新。schedule 由来の列は触らない)
      recordId = (existing as { id: string }).id;
      const { error: updErr } = await supabase
        .from("kaigo_visit_records")
        .update(body)
        .eq("id", recordId);
      if (updErr) {
        console.error("record update failed:", updErr.message);
        toast.error("記録の更新に失敗しました: " + updErr.message);
        setSaving(false);
        return;
      }
    } else {
      // b-2) 新規 → insert。schedule から user_id/staff_id/visit_date/service_type/
      //       start_time/end_time/schedule_id を埋める。tenant_id は DB DEFAULT 'kt-group'。
      const payload = {
        user_id: selected.user_id,
        staff_id: selected.staff_id,
        visit_date: selected.visit_date,
        service_type: selected.service_type ?? "身体介護",
        start_time: selected.start_time,
        end_time: selected.end_time,
        schedule_id: selected.id,
        status: RECORD_STATUS,
        ...body,
      };
      const { data: ins, error: insErr } = await supabase
        .from("kaigo_visit_records")
        .insert(payload)
        .select("id")
        .single();
      if (insErr || !ins) {
        console.error("record insert failed:", insErr?.message);
        toast.error("記録の保存に失敗しました: " + (insErr?.message ?? "不明なエラー"));
        setSaving(false);
        return;
      }
      recordId = (ins as { id: string }).id;
    }

    // c) 署名 (利用者確認サイン) — PC 版 v2 方式を流用
    if (signature) {
      try {
        const blob = await (await fetch(signature)).blob();
        const tenant = await resolvePreferredTenantId(supabase);
        if (!tenant.ok) throw new Error(tenant.error);
        const path = `${tenant.tenantId}/kaigo_visit_records/${recordId}.png`;
        const { error: uploadErr } = await supabase.storage
          .from("signatures")
          .upload(path, blob, { contentType: "image/png", upsert: true });
        if (uploadErr) throw uploadErr;
        const { error: sigErr } = await supabase
          .from("kaigo_visit_records")
          .update({
            signature_image_path: path,
            signed_at: new Date().toISOString(),
            signer_name: signerName.trim(),
          })
          .eq("id", recordId);
        if (sigErr) throw sigErr;
      } catch (err: unknown) {
        console.error("signature save failed:", err);
        toast.error(
          "記録は保存しましたが署名の保存に失敗しました: " +
            (err instanceof Error ? err.message : String(err))
        );
        setSaving(false);
        // 記録本体は保存済み。一覧を更新して戻す。
        setSelected(null);
        fetchList();
        return;
      }
    }

    setSaving(false);
    toast.success("サービス実施記録を保存しました");
    setSelected(null);
    fetchList();
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (bootLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh] text-gray-400">
        <Loader2 size={20} className="animate-spin mr-2" />
        読込中...
      </div>
    );
  }

  if (memberError) {
    return (
      <div className="max-w-md mx-auto pt-10 space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {memberError}
        </div>
        <button
          onClick={async () => {
            await supabase.auth.signOut();
            router.push("/login");
          }}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          <LogOut size={14} />
          ログアウト
        </button>
      </div>
    );
  }

  const clientName = selected?.clients?.name ?? "利用者";

  return (
    <div className="space-y-3 max-w-2xl mx-auto pb-16">
      {/* sticky ヘッダー */}
      <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-gray-200 -mx-3 sm:-mx-6 px-3 sm:px-6 py-2 flex items-center gap-2">
        {selected ? (
          <button
            onClick={closeForm}
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-2 text-xs text-gray-700 hover:bg-gray-50 min-h-[44px]"
            aria-label="一覧へ戻る"
          >
            <ArrowLeft size={16} />
          </button>
        ) : (
          <ClipboardList size={18} className="text-green-600 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-gray-900 truncate">
            {selected ? clientName : "サービス実施記録"}
          </div>
          <div className="text-[11px] text-gray-500 truncate">
            {selected ? formatJpDate(selected.visit_date) : member?.name}
          </div>
        </div>
        {!selected && (
          <button
            onClick={async () => {
              await supabase.auth.signOut();
              router.push("/login");
            }}
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-2 text-xs text-gray-700 hover:bg-gray-50 min-h-[44px]"
            aria-label="ログアウト"
          >
            <LogOut size={16} />
          </button>
        )}
      </div>

      {selected ? (
        // ── 記録フォーム ─────────────────────────────────────────────────────
        <div className="space-y-3">
          {/* 訪問サマリ */}
          <section className="rounded-lg border border-gray-200 bg-white p-3 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-bold text-gray-900 break-words leading-tight">
                {clientName}
              </span>
              {member &&
                (myRole(selected, member.id) === "主" ? (
                  <span className="shrink-0 inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
                    主担当
                  </span>
                ) : (
                  <span className="shrink-0 inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                    従担当
                  </span>
                ))}
            </div>
            <div className="text-xs text-gray-600 tabular-nums">
              {formatJpDate(selected.visit_date)}
              {(selected.start_time || selected.end_time) && (
                <>
                  {" "}
                  {hhmm(selected.start_time)}
                  〜{hhmm(selected.end_time)}
                </>
              )}
            </div>
            {selected.service_type && (
              <div className="text-xs text-gray-500 break-words">{selected.service_type}</div>
            )}
            {clockSupported && (selected.clock_in_at || selected.clock_out_at) && (
              <div className="flex items-center gap-1 text-xs text-gray-600 tabular-nums">
                <Clock size={12} className="text-gray-400" />
                打刻 {selected.clock_in_at ? fmtClock(selected.clock_in_at) : "--:--"}
                〜{selected.clock_out_at ? fmtClock(selected.clock_out_at) : "--:--"}
              </div>
            )}
          </section>

          {/* 実施内容 (任意) */}
          <section className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="block text-xs font-medium text-gray-700">
                  身体介護 (実施メモ)
                </label>
                <VoiceInputButton
                  targetRef={bodyCareRef}
                  value={bodyCare}
                  onChange={setBodyCare}
                  disabled={saving}
                />
              </div>
              <textarea
                ref={bodyCareRef}
                value={bodyCare}
                onChange={(e) => setBodyCare(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                placeholder="任意"
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="block text-xs font-medium text-gray-700">
                  生活援助 (実施メモ)
                </label>
                <VoiceInputButton
                  targetRef={livingSupportRef}
                  value={livingSupport}
                  onChange={setLivingSupport}
                  disabled={saving}
                />
              </div>
              <textarea
                ref={livingSupportRef}
                value={livingSupport}
                onChange={(e) => setLivingSupport(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                placeholder="任意"
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="block text-xs font-medium text-gray-700">
                  利用者の状態
                </label>
                <VoiceInputButton
                  targetRef={userConditionRef}
                  value={userCondition}
                  onChange={setUserCondition}
                  disabled={saving}
                />
              </div>
              <textarea
                ref={userConditionRef}
                value={userCondition}
                onChange={(e) => setUserCondition(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                placeholder="任意"
              />
            </div>
          </section>

          {/* バイタル (任意) */}
          <section className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
            <div className="text-sm font-semibold text-gray-900">バイタル (任意)</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">体温 (℃)</label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  value={vitalTemp}
                  onChange={(e) => setVitalTemp(e.target.value)}
                  className="w-full min-h-[44px] rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  placeholder="36.5"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">脈拍 (回/分)</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={vitalPulse}
                  onChange={(e) => setVitalPulse(e.target.value)}
                  className="w-full min-h-[44px] rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  placeholder="72"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  血圧 収縮期 (mmHg)
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={vitalBpSys}
                  onChange={(e) => setVitalBpSys(e.target.value)}
                  className="w-full min-h-[44px] rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  placeholder="120"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  血圧 拡張期 (mmHg)
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={vitalBpDia}
                  onChange={(e) => setVitalBpDia(e.target.value)}
                  className="w-full min-h-[44px] rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  placeholder="80"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">SpO2 (%)</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={vitalSpo2}
                  onChange={(e) => setVitalSpo2(e.target.value)}
                  className="w-full min-h-[44px] rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  placeholder="98"
                />
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="block text-xs font-medium text-gray-700">特記事項</label>
                <VoiceInputButton
                  targetRef={notesRef}
                  value={notes}
                  onChange={setNotes}
                  disabled={saving}
                />
              </div>
              <textarea
                ref={notesRef}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                placeholder="任意"
              />
            </div>
          </section>

          {/* 利用者サイン */}
          <section className="rounded-lg border border-gray-200 bg-white p-3 space-y-2">
            <div className="text-sm font-semibold text-gray-900">利用者サイン</div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">署名者名</label>
              <input
                type="text"
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                placeholder="利用者名"
              />
            </div>
            <SignaturePad value={signature} onChange={setSignature} disabled={saving} />
          </section>

          {/* 保存 */}
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full min-h-[48px] rounded-lg bg-green-600 px-4 py-3 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                保存中...
              </>
            ) : (
              "保存"
            )}
          </button>
        </div>
      ) : (
        // ── 訪問一覧 ─────────────────────────────────────────────────────────
        <div className="space-y-3">
          {/* 日付選択 */}
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-2">
            <button
              onClick={() => setDate((d) => format(addDays(new Date(d), -1), "yyyy-MM-dd"))}
              className="shrink-0 inline-flex items-center justify-center rounded-md border border-gray-300 px-2 min-h-[44px] min-w-[44px] text-gray-700 hover:bg-gray-50"
              aria-label="前日"
            >
              <ChevronLeft size={18} />
            </button>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="flex-1 min-w-0 rounded-md border border-gray-300 px-2 py-2 text-sm text-center tabular-nums focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            <button
              onClick={() => setDate((d) => format(addDays(new Date(d), 1), "yyyy-MM-dd"))}
              className="shrink-0 inline-flex items-center justify-center rounded-md border border-gray-300 px-2 min-h-[44px] min-w-[44px] text-gray-700 hover:bg-gray-50"
              aria-label="翌日"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          {listLoading ? (
            <div className="flex items-center justify-center py-10 text-gray-400">
              <Loader2 size={18} className="animate-spin mr-2" />
              読込中...
            </div>
          ) : schedules.length === 0 ? (
            <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
              この日の担当訪問はありません
            </div>
          ) : (
            <ul className="space-y-2">
              {schedules.map((s) => {
                const rec = recordBySchedule.get(s.id);
                const signed = !!rec?.signature_image_path;
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => openForm(s)}
                      className="w-full text-left rounded-lg border border-gray-200 bg-white p-3 hover:bg-gray-50 min-h-[44px] flex items-center gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-sm font-semibold text-gray-900 break-words leading-tight">
                            {s.clients?.name ?? "(利用者不明)"}
                          </span>
                          {member &&
                            (myRole(s, member.id) === "主" ? (
                              <span className="shrink-0 inline-flex items-center rounded-full bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                                主担当
                              </span>
                            ) : (
                              <span className="shrink-0 inline-flex items-center rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                                従担当
                              </span>
                            ))}
                        </div>
                        <div className="mt-0.5 text-xs text-gray-600 tabular-nums">
                          {(s.start_time || s.end_time) && (
                            <>
                              {hhmm(s.start_time)}〜{hhmm(s.end_time)}
                              {s.service_type ? " ・ " : ""}
                            </>
                          )}
                          {s.service_type && (
                            <span className="text-gray-500">{s.service_type}</span>
                          )}
                        </div>
                      </div>
                      {signed ? (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-1 text-[11px] font-medium text-green-700">
                          <CheckCircle2 size={12} />
                          サイン済
                        </span>
                      ) : (
                        <ChevronRight size={18} className="shrink-0 text-gray-300" />
                      )}
                    </button>
                    {/* 打刻 (開始/終了)。列未適用 (clockSupported=false) の環境では非表示 */}
                    {clockSupported && (
                      <div className="mt-1 flex gap-2">
                        <button
                          onClick={() => handleClock(s, "in")}
                          disabled={clocking !== null}
                          className={`flex-1 min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-semibold disabled:opacity-50 ${
                            s.clock_in_at
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
                          }`}
                        >
                          {clocking === `${s.id}:in` ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Clock size={14} />
                          )}
                          {s.clock_in_at ? (
                            <span className="tabular-nums">開始 {fmtClock(s.clock_in_at)}</span>
                          ) : (
                            "開始"
                          )}
                        </button>
                        <button
                          onClick={() => handleClock(s, "out")}
                          disabled={clocking !== null}
                          className={`flex-1 min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-semibold disabled:opacity-50 ${
                            s.clock_out_at
                              ? "border-orange-200 bg-orange-50 text-orange-700"
                              : "border-orange-500 bg-orange-500 text-white hover:bg-orange-600"
                          }`}
                        >
                          {clocking === `${s.id}:out` ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Clock size={14} />
                          )}
                          {s.clock_out_at ? (
                            <span className="tabular-nums">終了 {fmtClock(s.clock_out_at)}</span>
                          ) : (
                            "終了"
                          )}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
