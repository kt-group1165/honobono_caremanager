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
 * - 一覧: kaigo_visit_schedule を visit_date + staff_id (主担当) で絞込み
 *   ※ MVP は staff_id (主担当) のみ対象。staff_id_2 / staff_id_3 /
 *     additional_staff の 2 人体制 従事者は対象外 (将来対応)。
 * - 署名保存: PC 版 visit-records-content.tsx (署名 v2 方式) を流用。
 *   dataURL → PNG blob → Storage "signatures" bucket upload →
 *   kaigo_visit_records に signature_image_path / signed_at / signer_name。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { SignaturePad } from "@/components/signature-pad";
import { resolvePreferredTenantId } from "@/lib/tenant-resolver";

// ─── 型 ───────────────────────────────────────────────────────────────────────

interface Member {
  id: string;
  name: string;
}

interface ScheduleRow {
  id: string;
  user_id: string;
  staff_id: string | null;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  service_type: string | null;
  clients: { name: string | null } | null;
}

// schedule_id で既存 record を突合するための最小型
interface ExistingRecord {
  id: string;
  schedule_id: string | null;
  signature_image_path: string | null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const hhmm = (t: string | null): string => (t ? t.slice(0, 5) : "");

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

  // フォーム state
  const [bodyCare, setBodyCare] = useState("");
  const [livingSupport, setLivingSupport] = useState("");
  const [userCondition, setUserCondition] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [signerName, setSignerName] = useState("");
  const [saving, setSaving] = useState(false);

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
    // 担当訪問: staff_id (主担当) のみ。2 人体制 (staff_id_2/3) は MVP 対象外。
    const { data: schData, error: schErr } = await supabase
      .from("kaigo_visit_schedule")
      .select(
        "id, user_id, staff_id, visit_date, start_time, end_time, service_type, clients(name)"
      )
      .eq("visit_date", date)
      .eq("staff_id", member.id)
      .neq("status", "cancelled")
      .order("start_time");
    if (schErr) {
      console.error("schedule fetch failed:", schErr.message);
      toast.error("訪問予定の取得に失敗しました: " + schErr.message);
      setSchedules([]);
      setRecords([]);
      setListLoading(false);
      return;
    }
    const rows = (schData ?? []) as unknown as ScheduleRow[];
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

  // ── フォームを開く ─────────────────────────────────────────────────────────
  const openForm = (s: ScheduleRow) => {
    setSelected(s);
    setBodyCare("");
    setLivingSupport("");
    setUserCondition("");
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

    const body = {
      body_care: bodyCare.trim() || null,
      living_support: livingSupport.trim() || null,
      user_condition: userCondition.trim() || null,
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
            <div className="text-base font-bold text-gray-900 break-words leading-tight">
              {clientName}
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
          </section>

          {/* 実施内容 (任意) */}
          <section className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                身体介護 (実施メモ)
              </label>
              <textarea
                value={bodyCare}
                onChange={(e) => setBodyCare(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                placeholder="任意"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                生活援助 (実施メモ)
              </label>
              <textarea
                value={livingSupport}
                onChange={(e) => setLivingSupport(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                placeholder="任意"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                利用者の状態
              </label>
              <textarea
                value={userCondition}
                onChange={(e) => setUserCondition(e.target.value)}
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
                        <div className="text-sm font-semibold text-gray-900 break-words leading-tight">
                          {s.clients?.name ?? "(利用者不明)"}
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
