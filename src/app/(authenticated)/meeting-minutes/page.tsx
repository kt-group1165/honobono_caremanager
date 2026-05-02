"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  MessagesSquare,
  Plus,
  Save,
  Printer,
  Trash2,
  Loader2,
  FileText,
  ArrowLeft,
} from "lucide-react";
import { format, parseISO } from "date-fns";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KaigoUserLite {
  id: string;
  name: string;
  name_kana: string | null;
}

interface CarePlanSummary {
  id: string;
  plan_number: string | null;
  plan_type: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
}

interface Attendee {
  affiliation: string; // 所属（職種）
  name: string;        // 氏名
}

interface MeetingContent {
  meeting_date: string;       // 開催日 YYYY-MM-DD
  location: string;           // 開催場所
  time_range: string;         // 開催時間 (例: 14:00〜15:30)
  session_number: string;     // 開催回数
  creator_name: string;       // 居宅サービス計画作成者(担当者)氏名
  attendees: Attendee[];      // 会議出席者
  self_attended: boolean;     // 本人出席
  family_attended: boolean;   // 家族出席
  family_relationship: string;// 続柄
  remarks: string;            // 備考
  topics: string;             // 検討した項目
  discussion: string;         // 検討内容
  conclusion: string;         // 結論
  remaining_issues: string;   // 残された課題(次回の開催時期)
}

interface MeetingDoc {
  id: string;
  user_id: string;
  care_plan_id: string | null;
  report_type: "meeting-minutes";
  title: string;
  content: MeetingContent;
  status: "draft" | "completed";
  updated_at: string;
}

const REPORT_TYPE = "meeting-minutes";

const emptyAttendee = (): Attendee => ({ affiliation: "", name: "" });

function emptyContent(): MeetingContent {
  return {
    meeting_date: format(new Date(), "yyyy-MM-dd"),
    location: "",
    time_range: "",
    session_number: "",
    creator_name: "",
    attendees: Array.from({ length: 9 }, () => emptyAttendee()),
    self_attended: false,
    family_attended: false,
    family_relationship: "",
    remarks: "",
    topics: "",
    discussion: "",
    conclusion: "",
    remaining_issues: "",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    return format(parseISO(d), "yyyy/M/d");
  } catch {
    return d;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function MeetingMinutesPage() {
  const supabase = createClient();

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<KaigoUserLite | null>(null);

  // Care plan selection
  const [carePlans, setCarePlans] = useState<CarePlanSummary[]>([]);
  const [selectedCarePlanId, setSelectedCarePlanId] = useState<string | null>(null);
  const [loadingCarePlans, setLoadingCarePlans] = useState(false);

  // Docs
  const [docs, setDocs] = useState<MeetingDoc[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);

  // Edit mode
  const [mode, setMode] = useState<"list" | "edit">("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [content, setContent] = useState<MeetingContent>(emptyContent());
  const [docStatus, setDocStatus] = useState<"draft" | "completed">("draft");
  const [saving, setSaving] = useState(false);

  // ── Fetch user ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedUserId) {
      setSelectedUser(null);
      setCarePlans([]);
      setSelectedCarePlanId(null);
      setDocs([]);
      return;
    }
    (async () => {
      const { data } = await supabase
        .from("clients")
        .select("id, name, name_kana")
        .eq("id", selectedUserId)
        .single();
      setSelectedUser(data ?? null);
    })();
  }, [selectedUserId, supabase]);

  // ── Fetch care plans ────────────────────────────────────────────────────────
  const fetchCarePlans = useCallback(async () => {
    if (!selectedUserId) return;
    setLoadingCarePlans(true);
    try {
      const { data } = await supabase
        .from("kaigo_care_plans")
        .select("id, plan_number, plan_type, start_date, end_date, status")
        .eq("user_id", selectedUserId)
        .order("start_date", { ascending: false });
      const plans = (data as CarePlanSummary[]) ?? [];
      setCarePlans(plans);
      if (plans.length > 0) {
        setSelectedCarePlanId((prev) => {
          if (prev && plans.some((p) => p.id === prev)) return prev;
          const active = plans.find((p) => p.status === "active");
          return active?.id ?? plans[0].id;
        });
      } else {
        setSelectedCarePlanId(null);
      }
    } finally {
      setLoadingCarePlans(false);
    }
  }, [supabase, selectedUserId]);

  useEffect(() => {
    fetchCarePlans();
  }, [fetchCarePlans]);

  // ── Fetch docs ──────────────────────────────────────────────────────────────
  const fetchDocs = useCallback(async () => {
    if (!selectedUserId) {
      setDocs([]);
      return;
    }
    setLoadingDocs(true);
    try {
      let query = supabase
        .from("kaigo_report_documents")
        .select("*")
        .eq("user_id", selectedUserId)
        .eq("report_type", REPORT_TYPE)
        .order("updated_at", { ascending: false });
      if (selectedCarePlanId) {
        query = query.eq("care_plan_id", selectedCarePlanId);
      }
      const { data, error } = await query;
      if (error) throw error;
      setDocs((data as MeetingDoc[]) ?? []);
    } catch (err: unknown) {
      toast.error(
        "会議録の取得に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoadingDocs(false);
    }
  }, [supabase, selectedUserId, selectedCarePlanId]);

  useEffect(() => {
    if (mode === "list") fetchDocs();
  }, [fetchDocs, mode]);

  // ── Open new ────────────────────────────────────────────────────────────────
  const openNew = () => {
    if (!selectedCarePlanId) {
      toast.error("先に対応する計画期間を選択してください");
      return;
    }
    setEditingId(null);
    setContent(emptyContent());
    setDocStatus("draft");
    setMode("edit");
  };

  // ── Open existing ───────────────────────────────────────────────────────────
  const openEdit = (doc: MeetingDoc) => {
    setEditingId(doc.id);
    // Merge with empty content to ensure all fields exist
    const base = emptyContent();
    const merged = { ...base, ...(doc.content ?? {}) };
    if (!Array.isArray(merged.attendees) || merged.attendees.length < 9) {
      const arr = Array.from({ length: 9 }, (_, i) => merged.attendees?.[i] ?? emptyAttendee());
      merged.attendees = arr;
    }
    setContent(merged);
    setDocStatus(doc.status);
    setMode("edit");
  };

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!selectedUserId || !selectedCarePlanId) return;
    setSaving(true);
    try {
      const title = `サービス担当者会議の要点　${content.meeting_date || ""}`.trim();
      if (editingId) {
        const { error } = await supabase
          .from("kaigo_report_documents")
          .update({
            title,
            content,
            status: docStatus,
            care_plan_id: selectedCarePlanId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", editingId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("kaigo_report_documents")
          .insert({
            user_id: selectedUserId,
            care_plan_id: selectedCarePlanId,
            report_type: REPORT_TYPE,
            title,
            content,
            status: docStatus,
          })
          .select("id")
          .single();
        if (error) throw error;
        setEditingId(data.id);
      }
      toast.success("会議録を保存しました");
    } catch (err: unknown) {
      toast.error(
        "保存に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この会議録を削除しますか？")) return;
    const { error } = await supabase
      .from("kaigo_report_documents")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error("削除に失敗しました: " + error.message);
      return;
    }
    toast.success("削除しました");
    fetchDocs();
  };

  const handlePrint = () => window.print();

  const updateAttendee = (i: number, key: keyof Attendee, value: string) => {
    setContent((prev) => {
      const next = [...prev.attendees];
      next[i] = { ...next[i], [key]: value };
      return { ...prev, attendees: next };
    });
  };

  const setField = <K extends keyof MeetingContent>(k: K, v: MeetingContent[K]) => {
    setContent((prev) => ({ ...prev, [k]: v }));
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        @media print {
          body > * { display: none !important; }
          #meeting-print-root { display: block !important; }
          #meeting-print-root { position: fixed; inset: 0; background: white; font-family: "MS Mincho", "ＭＳ 明朝", "Noto Serif JP", serif; }
          @page { size: A4 landscape; margin: 8mm; }
          .no-print { display: none !important; }
        }
        @media screen {
          #meeting-print-root { display: none; }
        }
      `}</style>

      <div className="flex h-full -m-6">
        <UserSidebar
          selectedUserId={selectedUserId}
          onSelectUser={(id) => {
            setSelectedUserId(id);
            setMode("list");
          }}
        />

        <div className="flex-1 overflow-y-auto p-6 no-print">
          {!selectedUserId ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <MessagesSquare size={48} className="mb-4 text-gray-300" />
              <p className="text-sm">利用者を選択してください</p>
            </div>
          ) : mode === "list" ? (
            <ListView
              user={selectedUser}
              docs={docs}
              loading={loadingDocs}
              carePlans={carePlans}
              selectedCarePlanId={selectedCarePlanId}
              setSelectedCarePlanId={setSelectedCarePlanId}
              loadingCarePlans={loadingCarePlans}
              onNew={openNew}
              onOpen={openEdit}
              onDelete={handleDelete}
            />
          ) : (
            <EditView
              user={selectedUser}
              content={content}
              onChange={setContent}
              updateAttendee={updateAttendee}
              setField={setField}
              docStatus={docStatus}
              setDocStatus={setDocStatus}
              saving={saving}
              onSave={handleSave}
              onBack={() => setMode("list")}
              onPrint={handlePrint}
              selectedPlan={carePlans.find((p) => p.id === selectedCarePlanId) ?? null}
            />
          )}
        </div>
      </div>

      {/* Print-only area */}
      {mode === "edit" && (
        <div id="meeting-print-root">
          <PrintView content={content} userName={selectedUser?.name ?? ""} />
        </div>
      )}
    </>
  );
}

// ─── List View ────────────────────────────────────────────────────────────────

function ListView({
  user,
  docs,
  loading,
  carePlans,
  selectedCarePlanId,
  setSelectedCarePlanId,
  loadingCarePlans,
  onNew,
  onOpen,
  onDelete,
}: {
  user: KaigoUserLite | null;
  docs: MeetingDoc[];
  loading: boolean;
  carePlans: CarePlanSummary[];
  selectedCarePlanId: string | null;
  setSelectedCarePlanId: (id: string) => void;
  loadingCarePlans: boolean;
  onNew: () => void;
  onOpen: (doc: MeetingDoc) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessagesSquare className="text-indigo-600" size={24} />
          <h1 className="text-xl font-bold text-gray-900">
            サービス担当者会議の要点（第4表）
          </h1>
          {user && (
            <span className="text-gray-500 text-sm">— {user.name} 様</span>
          )}
        </div>
        <button
          onClick={onNew}
          disabled={!selectedCarePlanId}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          <Plus size={16} />
          新規作成
        </button>
      </div>

      {/* 計画期間タブ */}
      {loadingCarePlans ? (
        <div className="rounded-lg border bg-white p-4 text-center text-xs text-gray-400">
          ケアプランを読み込み中...
        </div>
      ) : carePlans.length === 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          有効なケアプランがありません。先にケアプランを作成してください。
        </div>
      ) : (
        <div>
          <div className="text-xs text-gray-500 mb-1">対応する計画期間を選択</div>
          <div className="border-b border-gray-200 overflow-x-auto">
            <div className="flex gap-1 min-w-max">
              {carePlans.map((plan) => {
                const isActive = selectedCarePlanId === plan.id;
                return (
                  <button
                    key={plan.id}
                    onClick={() => setSelectedCarePlanId(plan.id)}
                    className={`flex flex-col items-start px-4 py-2 text-xs border-b-2 whitespace-nowrap transition-colors ${
                      isActive
                        ? "border-indigo-600 text-indigo-700 bg-indigo-50 font-semibold"
                        : "border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                    }`}
                  >
                    <span className="font-bold">
                      {plan.plan_type ?? "ケアプラン"}
                      {plan.plan_number && (
                        <span className="ml-1 font-normal text-gray-500">
                          #{plan.plan_number}
                        </span>
                      )}
                      {plan.status === "active" && (
                        <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                          有効
                        </span>
                      )}
                    </span>
                    <span className="text-[10px] text-gray-500 mt-0.5">
                      {fmtDate(plan.start_date)} 〜 {fmtDate(plan.end_date)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 会議録一覧 */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-indigo-500" />
        </div>
      ) : docs.length === 0 ? (
        <div className="rounded-lg border bg-white py-16 text-center shadow-sm">
          <FileText size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-gray-500">まだ会議録がありません</p>
          {selectedCarePlanId && (
            <button
              onClick={onNew}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              <Plus size={14} />
              新規作成
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">開催日</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">開催回数</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">検討した項目</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-600">状態</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">更新日時</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {docs.map((doc) => (
                <tr key={doc.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium">
                    {fmtDate(doc.content?.meeting_date)}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {doc.content?.session_number || "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-700 max-w-md truncate">
                    {doc.content?.topics || "—"}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        doc.status === "completed"
                          ? "bg-green-100 text-green-700"
                          : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {doc.status === "completed" ? "完成" : "下書き"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {fmtDate(doc.updated_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        onClick={() => onOpen(doc)}
                        className="text-xs text-indigo-600 hover:underline"
                      >
                        開く
                      </button>
                      <button
                        onClick={() => onDelete(doc.id)}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Edit View ────────────────────────────────────────────────────────────────

function EditView({
  user,
  content,
  updateAttendee,
  setField,
  docStatus,
  setDocStatus,
  saving,
  onSave,
  onBack,
  onPrint,
  selectedPlan,
}: {
  user: KaigoUserLite | null;
  content: MeetingContent;
  onChange: (c: MeetingContent) => void;
  updateAttendee: (i: number, key: keyof Attendee, value: string) => void;
  setField: <K extends keyof MeetingContent>(k: K, v: MeetingContent[K]) => void;
  docStatus: "draft" | "completed";
  setDocStatus: (s: "draft" | "completed") => void;
  saving: boolean;
  onSave: () => void;
  onBack: () => void;
  onPrint: () => void;
  selectedPlan: CarePlanSummary | null;
}) {
  const inp =
    "w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
  const ta =
    "w-full border border-gray-300 rounded px-2 py-1.5 text-xs bg-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y";

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <ArrowLeft size={14} />
            一覧に戻る
          </button>
          <MessagesSquare className="text-indigo-600" size={22} />
          <h1 className="text-lg font-bold text-gray-900">
            サービス担当者会議の要点
            {user && (
              <span className="ml-2 text-gray-500 text-sm font-normal">
                {user.name} 様
              </span>
            )}
          </h1>
          {selectedPlan && (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs text-indigo-700">
              <FileText size={10} />
              対象計画期間: {fmtDate(selectedPlan.start_date)} 〜 {fmtDate(selectedPlan.end_date)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={docStatus}
            onChange={(e) => setDocStatus(e.target.value as "draft" | "completed")}
            className="rounded-lg border px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="draft">下書き</option>
            <option value="completed">完成</option>
          </select>
          <button
            onClick={onPrint}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <Printer size={14} />
            印刷
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存
          </button>
        </div>
      </div>

      {/* Edit form matching 第4表 */}
      <div className="rounded-lg border bg-white shadow-sm p-4 space-y-3">
        {/* 利用者名・計画作成者 */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-0.5">
              利用者名
            </label>
            <div className={`${inp} bg-gray-50`}>{user?.name ?? "—"} 殿</div>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-0.5">
              居宅サービス計画作成者（担当者）氏名
            </label>
            <input
              type="text"
              value={content.creator_name}
              onChange={(e) => setField("creator_name", e.target.value)}
              className={inp}
            />
          </div>
        </div>

        {/* 開催日・場所・時間・回数 */}
        <div className="grid grid-cols-4 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-0.5">
              開催日
            </label>
            <input
              type="date"
              value={content.meeting_date}
              onChange={(e) => setField("meeting_date", e.target.value)}
              className={inp}
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-0.5">
              開催場所
            </label>
            <input
              type="text"
              value={content.location}
              onChange={(e) => setField("location", e.target.value)}
              className={inp}
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-0.5">
              開催時間
            </label>
            <input
              type="text"
              value={content.time_range}
              onChange={(e) => setField("time_range", e.target.value)}
              placeholder="14:00〜15:30"
              className={inp}
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-0.5">
              開催回数
            </label>
            <input
              type="text"
              value={content.session_number}
              onChange={(e) => setField("session_number", e.target.value)}
              placeholder="第○回"
              className={inp}
            />
          </div>
        </div>

        {/* 会議出席者 */}
        <div>
          <div className="text-[11px] font-semibold text-gray-700 mb-1">
            会議出席者
          </div>
          <div className="grid grid-cols-[140px_1fr] gap-2">
            {/* 左: 利用者・家族の出席 */}
            <div className="rounded border border-red-200 bg-red-50/30 p-2 text-[11px]">
              <div className="mb-1 font-medium text-red-700">利用者・家族の出席</div>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={content.self_attended}
                  onChange={(e) => setField("self_attended", e.target.checked)}
                  className="h-3 w-3 accent-red-600"
                />
                <span>本人</span>
              </label>
              <label className="flex items-center gap-1.5 mt-1">
                <input
                  type="checkbox"
                  checked={content.family_attended}
                  onChange={(e) => setField("family_attended", e.target.checked)}
                  className="h-3 w-3 accent-red-600"
                />
                <span>家族</span>
              </label>
              <div className="mt-1">
                <input
                  type="text"
                  value={content.family_relationship}
                  onChange={(e) => setField("family_relationship", e.target.value)}
                  placeholder="続柄"
                  className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]"
                />
              </div>
              <div className="mt-2 border-t border-red-200 pt-1">
                <div className="text-[10px] text-gray-600 mb-0.5">※備考</div>
                <textarea
                  rows={2}
                  value={content.remarks}
                  onChange={(e) => setField("remarks", e.target.value)}
                  className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px] resize-none"
                />
              </div>
            </div>

            {/* 右: 所属(職種)・氏名 のグリッド (3列×3行) */}
            <div className="grid grid-cols-3 gap-1">
              {content.attendees.map((att, i) => (
                <div key={i} className="border border-gray-300 rounded p-1.5 bg-white">
                  <input
                    type="text"
                    value={att.affiliation}
                    onChange={(e) => updateAttendee(i, "affiliation", e.target.value)}
                    placeholder="所属(職種)"
                    className="w-full border-b border-gray-200 text-[11px] pb-0.5 mb-0.5 focus:outline-none focus:border-indigo-500"
                  />
                  <input
                    type="text"
                    value={att.name}
                    onChange={(e) => updateAttendee(i, "name", e.target.value)}
                    placeholder="氏名"
                    className="w-full text-[11px] focus:outline-none"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 検討した項目 */}
        <div>
          <label className="block text-[11px] font-semibold text-gray-700 mb-0.5">
            検討した項目
          </label>
          <textarea
            rows={2}
            value={content.topics}
            onChange={(e) => setField("topics", e.target.value)}
            className={ta}
          />
        </div>

        {/* 検討内容 */}
        <div>
          <label className="block text-[11px] font-semibold text-gray-700 mb-0.5">
            検討内容
          </label>
          <textarea
            rows={4}
            value={content.discussion}
            onChange={(e) => setField("discussion", e.target.value)}
            className={ta}
          />
        </div>

        {/* 結論 */}
        <div>
          <label className="block text-[11px] font-semibold text-gray-700 mb-0.5">
            結論
          </label>
          <textarea
            rows={3}
            value={content.conclusion}
            onChange={(e) => setField("conclusion", e.target.value)}
            className={ta}
          />
        </div>

        {/* 残された課題 */}
        <div>
          <label className="block text-[11px] font-semibold text-gray-700 mb-0.5">
            残された課題（次回の開催時期）
          </label>
          <textarea
            rows={2}
            value={content.remaining_issues}
            onChange={(e) => setField("remaining_issues", e.target.value)}
            className={ta}
          />
        </div>
      </div>

      {/* ── 第4表 プレビュー（画面表示） ── */}
      <div className="rounded-lg border-2 border-indigo-200 bg-white shadow-md">
        <div className="flex items-center justify-between border-b border-indigo-100 bg-indigo-50 px-4 py-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-indigo-700">
            <FileText size={16} />
            第4表 サービス担当者会議の要点 プレビュー
          </div>
          <button
            type="button"
            onClick={onPrint}
            className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
          >
            <Printer size={11} />
            印刷
          </button>
        </div>
        <div className="p-4 overflow-x-auto bg-gray-50">
          <div className="bg-white shadow-sm" style={{ minWidth: "260mm" }}>
            <PrintView content={content} userName={user?.name ?? ""} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Print View (第4表 A4横) ───────────────────────────────────────────────────

function PrintView({ content, userName }: { content: MeetingContent; userName: string }) {
  const B = "1px solid #000";
  const cellBase: React.CSSProperties = {
    border: B,
    padding: "1px 4px",
    fontSize: "8pt",
    verticalAlign: "top",
  };
  const thStyle: React.CSSProperties = {
    ...cellBase,
    textAlign: "center",
    fontWeight: "normal",
  };
  const fmtMeetingDate = (d: string) => {
    if (!d) return "　年　月　日";
    try {
      const dt = parseISO(d);
      return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`;
    } catch {
      return d;
    }
  };

  return (
    <div
      style={{
        fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif',
        fontSize: "9pt",
        color: "#000",
        padding: "4mm",
      }}
    >
      {/* ヘッダー */}
      <div style={{ position: "relative", marginBottom: "6px" }}>
        <div
          style={{
            border: B,
            display: "inline-block",
            padding: "1px 8px",
            fontSize: "8pt",
          }}
        >
          第４表
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            textAlign: "center",
            fontSize: "13pt",
            fontWeight: "bold",
            letterSpacing: "0.2em",
          }}
        >
          サービス担当者会議の要点
        </div>
        <div style={{ position: "absolute", right: 0, top: "2px", fontSize: "8pt" }}>
          作成年月日　　年　　月　　日
        </div>
      </div>

      {/* 利用者名・計画作成者 */}
      <div style={{ display: "flex", gap: "16px", fontSize: "9pt", marginBottom: "4px" }}>
        <div style={{ flex: 1, borderBottom: B }}>
          利用者名　{userName || "　　　　　　"}　殿
        </div>
        <div style={{ flex: 1, borderBottom: B }}>
          居宅サービス計画作成者（担当者）氏名　{content.creator_name || "　　　　　　"}
        </div>
      </div>

      {/* 開催日・場所・時間・回数 */}
      <div style={{ display: "flex", gap: "8px", fontSize: "9pt", marginBottom: "6px" }}>
        <div style={{ borderBottom: B, paddingRight: "8px" }}>
          開催日　{fmtMeetingDate(content.meeting_date)}
        </div>
        <div style={{ borderBottom: B, flex: 1, paddingRight: "8px" }}>
          開催場所　{content.location || "　　　　"}
        </div>
        <div style={{ borderBottom: B, paddingRight: "8px" }}>
          開催時間　{content.time_range || "　　　　"}
        </div>
        <div style={{ borderBottom: B, paddingRight: "8px" }}>
          開催回数　{content.session_number || "　　"}
        </div>
      </div>

      {/* 会議出席者テーブル */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "4px" }}>
        <colgroup>
          <col style={{ width: "18%" }} />
          <col style={{ width: "13.7%" }} />
          <col style={{ width: "13.7%" }} />
          <col style={{ width: "13.7%" }} />
          <col style={{ width: "13.7%" }} />
          <col style={{ width: "13.7%" }} />
          <col style={{ width: "13.5%" }} />
        </colgroup>
        <thead>
          <tr style={{ height: "18px" }}>
            <th rowSpan={4} style={{ ...thStyle, verticalAlign: "top", paddingTop: "4px" }}>
              <div style={{ fontWeight: "bold" }}>会議出席者</div>
              <div
                style={{
                  marginTop: "6px",
                  fontSize: "7pt",
                  color: "#c00",
                  textAlign: "left",
                  lineHeight: 1.3,
                }}
              >
                利用者・家族の出席
                <br />
                本人：【{content.self_attended ? "✓" : "　"}】
                <br />
                家族：【{content.family_attended ? "✓" : "　"}】
                <br />
                （続柄：{content.family_relationship || "　　"}）
                <br />
                <br />
                ※備考
                <div
                  style={{
                    marginTop: "2px",
                    color: "#000",
                    fontSize: "7pt",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {content.remarks}
                </div>
              </div>
            </th>
            <th style={thStyle}>所属(職種)</th>
            <th style={thStyle}>氏　名</th>
            <th style={thStyle}>所属(職種)</th>
            <th style={thStyle}>氏　名</th>
            <th style={thStyle}>所属(職種)</th>
            <th style={thStyle}>氏　名</th>
          </tr>
          {[0, 1, 2].map((row) => (
            <tr key={row} style={{ height: "22px" }}>
              {[0, 1, 2].map((col) => {
                const idx = row * 3 + col;
                const att = content.attendees[idx] ?? { affiliation: "", name: "" };
                return (
                  <>
                    <td key={`${row}-${col}-aff`} style={cellBase}>
                      {att.affiliation}
                    </td>
                    <td key={`${row}-${col}-name`} style={cellBase}>
                      {att.name}
                    </td>
                  </>
                );
              })}
            </tr>
          ))}
        </thead>
      </table>

      {/* 検討した項目 */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "4px" }}>
        <tbody>
          <tr>
            <td style={{ ...thStyle, width: "18%", fontWeight: "bold" }}>検討した項目</td>
            <td
              style={{
                ...cellBase,
                minHeight: "22px",
                whiteSpace: "pre-wrap",
              }}
            >
              {content.topics}
            </td>
          </tr>
          <tr>
            <td style={{ ...thStyle, fontWeight: "bold" }}>検討内容</td>
            <td
              style={{
                ...cellBase,
                whiteSpace: "pre-wrap",
                height: "60px",
              }}
            >
              {content.discussion}
            </td>
          </tr>
          <tr>
            <td style={{ ...thStyle, fontWeight: "bold" }}>結論</td>
            <td
              style={{
                ...cellBase,
                whiteSpace: "pre-wrap",
                height: "50px",
              }}
            >
              {content.conclusion}
            </td>
          </tr>
          <tr>
            <td style={{ ...thStyle, fontWeight: "bold", lineHeight: 1.2 }}>
              残された課題
              <br />
              <span style={{ fontSize: "7pt", fontWeight: "normal" }}>
                （次回の開催時期）
              </span>
            </td>
            <td
              style={{
                ...cellBase,
                whiteSpace: "pre-wrap",
                height: "40px",
              }}
            >
              {content.remaining_issues}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
