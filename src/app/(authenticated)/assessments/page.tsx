"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { UserSidebar } from "@/components/users/user-sidebar";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import { Plus, Save, Loader2, ClipboardCheck, FileText, Trash2, Printer, ArrowLeft, Check, Edit3 } from "lucide-react";
import { cn } from "@/lib/utils";

import type { AssessmentFormData } from "./_types";
import { emptyAssessment } from "./_types";
import { Tab1FaceSheet } from "./_components/Tab1FaceSheet";
import { Tab2Family } from "./_components/Tab2Family";
import { Tab3Services } from "./_components/Tab3Services";
import { Tab4Housing } from "./_components/Tab4Housing";
import { Tab5Health } from "./_components/Tab5Health";
import { Tab6Basic } from "./_components/Tab6Basic";
import { Tab6LifeFunction } from "./_components/Tab6LifeFunction";
import { Tab6Cognition } from "./_components/Tab6Cognition";
import { Tab6Social } from "./_components/Tab6Social";
import { Tab6Medical } from "./_components/Tab6Medical";
import { Tab6Doctor } from "./_components/Tab6Doctor";
import { Tab7Summary } from "./_components/Tab7Summary";
import { Tab7Schedule } from "./_components/Tab7Schedule";
import { PreviewTab1 } from "./_previews/PreviewTab1";
import { PreviewTab2 } from "./_previews/PreviewTab2";
import { PreviewTab3 } from "./_previews/PreviewTab3";
import { PreviewTab4 } from "./_previews/PreviewTab4";
import { PreviewTab5 } from "./_previews/PreviewTab5";
import { PreviewTab6Basic } from "./_previews/PreviewTab6Basic";
import { PreviewTab6LifeFunction } from "./_previews/PreviewTab6LifeFunction";
import { PreviewTab6Cognition } from "./_previews/PreviewTab6Cognition";
import { PreviewTab6Social } from "./_previews/PreviewTab6Social";
import { PreviewTab6Medical } from "./_previews/PreviewTab6Medical";
import { PreviewTab6Doctor } from "./_previews/PreviewTab6Doctor";
import { PreviewTab7Summary } from "./_previews/PreviewTab7Summary";
import { PreviewTab7Schedule } from "./_previews/PreviewTab7Schedule";
import { PREVIEW_PRINT_CSS } from "./_preview";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KaigoUser {
  id: string;
  name: string;
  name_kana: string | null;
  gender: string | null;
}

interface Certification {
  id: string;
  care_level: string;
  start_date: string;
  end_date: string;
}

type AssessmentStatus = "draft" | "completed";

interface Assessment {
  id: string;
  user_id: string;
  certification_id: string | null;
  assessment_date: string;
  assessor_name: string | null;
  status: AssessmentStatus;
  form_data: AssessmentFormData;
  created_at: string;
  updated_at: string;
}

type TabKey = "1" | "2" | "3" | "4" | "5" | "6-1" | "6-2" | "6-34" | "6-5" | "6-6" | "6-dr" | "7s" | "7sch";

const TABS: { key: TabKey; label: string }[] = [
  { key: "1", label: "1" },
  { key: "2", label: "2" },
  { key: "3", label: "3" },
  { key: "4", label: "4" },
  { key: "5", label: "5" },
  { key: "6-1", label: "6①" },
  { key: "6-2", label: "6②" },
  { key: "6-34", label: "6③-④" },
  { key: "6-5", label: "6⑤" },
  { key: "6-6", label: "6⑥" },
  { key: "6-dr", label: "6医" },
  { key: "7s", label: "7まとめ" },
  { key: "7sch", label: "7スケジュ" },
];

// ─── Main ────────────────────────────────────────────────────────────────────

export default function AssessmentPage() {
  const supabase = createClient();

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<KaigoUser | null>(null);
  const [certifications, setCertifications] = useState<Certification[]>([]);
  const [selectedCertId, setSelectedCertId] = useState<string | null>(null);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const [mode, setMode] = useState<"list" | "edit">("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingCertId, setEditingCertId] = useState<string | null>(null);
  const [assessmentDate, setAssessmentDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [assessorName, setAssessorName] = useState("");
  const [status, setStatus] = useState<AssessmentStatus>("draft");
  const [formData, setFormData] = useState<AssessmentFormData>(emptyAssessment());
  const [activeTab, setActiveTab] = useState<TabKey>("1");
  const [saving, setSaving] = useState(false);

  // Load user info when selected
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    if (!selectedUserId) { setSelectedUser(null); setCertifications([]); setSelectedCertId(null); return; }
    // 共通マスタ clients、PostgREST 列エイリアスで name_kana を維持
    supabase.from("clients").select("id, name, name_kana:furigana, gender").eq("id", selectedUserId).single().then(({ data }: { data: KaigoUser | null }) => setSelectedUser(data));
    // Load all certifications for this user（client_insurance_records、列エイリアスで旧フィールド名維持）
    supabase.from("client_insurance_records")
      .select("id, care_level, start_date:certification_start_date, end_date:certification_end_date")
      .eq("client_id", selectedUserId)
      .order("certification_start_date", { ascending: false, nullsFirst: false })
      .then(({ data }: { data: Certification[] | null }) => {
        const certs = data ?? [];
        setCertifications(certs);
        // Auto-select: 現在選択中の cert がこの利用者のものでなければ最新に切替
        if (certs.length === 0) {
          setSelectedCertId(null);
        } else if (!selectedCertId || !certs.some((c) => c.id === selectedCertId)) {
          setSelectedCertId(certs[0].id);
        }
      });
    setMode("list");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUserId, supabase]);

  // Fetch assessments list (filtered by certification_id if selected)
  const fetchAssessments = useCallback(async () => {
    if (!selectedUserId) { setAssessments([]); return; }
    setLoadingList(true);
    let query = supabase.from("kaigo_assessments").select("*").eq("user_id", selectedUserId);
    if (selectedCertId) query = query.eq("certification_id", selectedCertId);
    const { data } = await query.order("assessment_date", { ascending: false });
    setAssessments((data as Assessment[]) ?? []);
    setLoadingList(false);
  }, [selectedUserId, selectedCertId, supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    if (mode === "list") fetchAssessments();
  }, [fetchAssessments, mode]);

  // Open new
  const openNew = () => {
    if (!selectedCertId) {
      toast.error("認定期間を選択してください。介護認定情報がない場合は、先に利用者情報で登録してください。");
      return;
    }
    setEditingId(null);
    setEditingCertId(selectedCertId);
    setAssessmentDate(format(new Date(), "yyyy-MM-dd"));
    setAssessorName("");
    setStatus("draft");
    setFormData(emptyAssessment());
    setActiveTab("1");
    setMode("edit");
  };

  // Open existing
  const openEdit = (a: Assessment) => {
    setEditingId(a.id);
    setEditingCertId(a.certification_id);
    setAssessmentDate(a.assessment_date);
    setAssessorName(a.assessor_name ?? "");
    setStatus(a.status);
    const merged = { ...emptyAssessment(), ...(a.form_data ?? {}) };
    setFormData(merged as AssessmentFormData);
    setActiveTab("1");
    setMode("edit");
  };

  // Save
  const handleSave = async () => {
    if (!selectedUserId) return;
    setSaving(true);
    try {
      const payload = {
        user_id: selectedUserId,
        certification_id: editingCertId,
        assessment_date: assessmentDate,
        assessor_name: assessorName || null,
        status,
        form_data: formData,
      };
      if (editingId) {
        const { error } = await supabase.from("kaigo_assessments").update({ ...payload, updated_at: new Date().toISOString() }).eq("id", editingId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("kaigo_assessments").insert(payload).select("id").single();
        if (error) throw error;
        setEditingId(data.id);
      }
      toast.success("アセスメントを保存しました");
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
      const msg = err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as any).message) : JSON.stringify(err);
      toast.error("保存に失敗しました: " + msg);
    } finally {
      setSaving(false);
    }
  };

  // Delete
  const handleDelete = async (id: string) => {
    if (!window.confirm("このアセスメントを削除しますか？")) return;
    const { error } = await supabase.from("kaigo_assessments").delete().eq("id", id);
    if (error) {
      toast.error("削除に失敗しました");
      return;
    }
    toast.success("削除しました");
    fetchAssessments();
  };

  // Update tab data helper
  const updFormData = <K extends keyof AssessmentFormData>(key: K, value: AssessmentFormData[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="flex h-full -m-6">
      <style>{PREVIEW_PRINT_CSS}</style>
      <UserSidebar selectedUserId={selectedUserId} onSelectUser={setSelectedUserId} />

      <div className="flex-1 overflow-y-auto">
        {!selectedUserId && (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <ClipboardCheck size={48} className="mb-4 text-gray-300" />
            <p className="text-gray-500 text-sm">利用者を選択してください</p>
          </div>
        )}

        {selectedUserId && mode === "list" && (
          <div className="p-6 space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ClipboardCheck className="text-blue-600" size={24} />
                <h1 className="text-xl font-bold text-gray-900">アセスメント</h1>
                {selectedUser && <span className="text-gray-500 text-sm">— {selectedUser.name} 様</span>}
              </div>
              <button onClick={openNew} disabled={!selectedCertId} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50">
                <Plus size={16} /> 新規作成
              </button>
            </div>

            {/* 認定期間タブ */}
            {certifications.length > 0 ? (
              <div className="border-b overflow-x-auto">
                <div className="flex gap-1 min-w-max">
                  {certifications.map((cert) => {
                    const fmt = (d: string) => format(parseISO(d), "yyyy/M/d");
                    const isActive = selectedCertId === cert.id;
                    return (
                      <button
                        key={cert.id}
                        onClick={() => setSelectedCertId(cert.id)}
                        className={cn(
                          "flex flex-col px-4 py-2 text-xs border-b-2 whitespace-nowrap transition-colors",
                          isActive
                            ? "border-blue-600 text-blue-700 bg-blue-50 font-semibold"
                            : "border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                        )}
                      >
                        <span className="font-bold">{cert.care_level}</span>
                        <span className="text-[10px] text-gray-500">{fmt(cert.start_date)} 〜 {fmt(cert.end_date)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                介護認定情報が登録されていません。先に利用者情報で認定情報を登録してください。
              </div>
            )}

            {loadingList ? (
              <div className="flex items-center justify-center py-16"><Loader2 size={24} className="animate-spin text-blue-500" /></div>
            ) : assessments.length === 0 ? (
              <div className="rounded-lg border bg-white py-16 text-center shadow-sm">
                <FileText size={40} className="mx-auto mb-3 text-gray-300" />
                <p className="text-sm text-gray-500">まだアセスメントがありません</p>
              </div>
            ) : (
              <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-4 py-3 text-left font-semibold text-gray-600">実施日</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-600">作成者</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-600">ステータス</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-600">更新日時</th>
                      <th className="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {assessments.map((a) => (
                      <tr key={a.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium">{format(parseISO(a.assessment_date), "yyyy年M月d日", { locale: ja })}</td>
                        <td className="px-4 py-3 text-gray-700">{a.assessor_name || "—"}</td>
                        <td className="px-4 py-3">
                          <span className={cn(
                            "rounded-full px-2.5 py-0.5 text-xs font-medium",
                            a.status === "draft" ? "bg-yellow-100 text-yellow-700" : "bg-green-100 text-green-700"
                          )}>
                            {a.status === "draft" ? "下書き" : "完了"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">{format(parseISO(a.updated_at), "yyyy/MM/dd HH:mm")}</td>
                        <td className="px-4 py-3 text-right">
                          <button onClick={() => openEdit(a)} className="text-blue-600 hover:underline text-xs mr-3">編集</button>
                          <button onClick={() => handleDelete(a.id)} className="text-red-500 hover:underline text-xs">削除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {selectedUserId && mode === "edit" && (
          <div className="flex flex-col h-full">
            {/* Toolbar */}
            <div className="sticky top-0 z-20 bg-white border-b px-6 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button onClick={() => setMode("list")} className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
                  <ArrowLeft size={14} /> 一覧
                </button>
                <ClipboardCheck className="text-blue-600" size={20} />
                <h1 className="text-base font-bold text-gray-900">アセスメント</h1>
                {selectedUser && <span className="text-gray-500 text-sm">— {selectedUser.name} 様</span>}
              </div>
              <div className="flex items-center gap-2">
                <input type="date" value={assessmentDate} onChange={(e) => setAssessmentDate(e.target.value)} className="rounded border px-2 py-1 text-sm" />
                <input type="text" value={assessorName} onChange={(e) => setAssessorName(e.target.value)} placeholder="作成者" className="rounded border px-2 py-1 text-sm w-32" />
                <button onClick={() => setStatus(status === "draft" ? "completed" : "draft")} className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                  {status === "draft" ? <><Edit3 size={14} /> 下書き</> : <><Check size={14} /> 完了</>}
                </button>
                <button onClick={() => window.print()} className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                  <Printer size={14} /> 印刷
                </button>
                <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  保存
                </button>
              </div>
            </div>

            {/* Tab Bar */}
            <div className="sticky top-[49px] z-10 bg-gray-50 border-b flex overflow-x-auto">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={cn(
                    "px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors",
                    activeTab === t.key
                      ? "border-blue-600 text-blue-700 bg-white"
                      : "border-transparent text-gray-600 hover:text-gray-900 hover:bg-white/50"
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {(() => {
                const uname = selectedUser?.name ?? "";
                const dstr = assessmentDate ? format(parseISO(assessmentDate), "令和y'年' M'月' d'日'", { locale: ja }).replace(/令和/, (m) => {
                  const y = parseISO(assessmentDate).getFullYear();
                  return y >= 2019 ? `令和${y - 2018}年` : `${y}年`;
                }).replace(/令和\d+年\d+/, "令和") : "";
                const dFormatted = assessmentDate ? (() => {
                  const d = parseISO(assessmentDate);
                  const y = d.getFullYear();
                  const era = y >= 2019 ? `令和${y - 2018}` : `平成${y - 1988}`;
                  return `${era}年 ${d.getMonth() + 1}月${d.getDate()}日`;
                })() : "";
                return (
                  <>
                    {activeTab === "1" && (<>
                      <Tab1FaceSheet data={formData.face_sheet!} onChange={(v) => updFormData("face_sheet", v)} />
                      <PreviewTab1 data={formData.face_sheet!} userName={uname} date={dFormatted} />
                    </>)}
                    {activeTab === "2" && (<>
                      <Tab2Family
                        data={formData.family_support!}
                        onChange={(v) => updFormData("family_support", v)}
                        userName={selectedUser?.name ?? ""}
                        userGender={selectedUser?.gender ?? null}
                      />
                      <PreviewTab2 data={formData.family_support!} userName={uname} userGender={selectedUser?.gender ?? null} date={dFormatted} />
                    </>)}
                    {activeTab === "3" && (<>
                      <Tab3Services data={formData.service_usage!} onChange={(v) => updFormData("service_usage", v)} />
                      <PreviewTab3 data={formData.service_usage!} userName={uname} date={dFormatted} />
                    </>)}
                    {activeTab === "4" && (<>
                      <Tab4Housing data={formData.housing!} onChange={(v) => updFormData("housing", v)} />
                      <PreviewTab4 data={formData.housing!} userName={uname} date={dFormatted} />
                    </>)}
                    {activeTab === "5" && (<>
                      <Tab5Health data={formData.health!} onChange={(v) => updFormData("health", v)} />
                      <PreviewTab5 data={formData.health!} userName={uname} date={dFormatted} />
                    </>)}
                    {activeTab === "6-1" && (<>
                      <Tab6Basic data={formData.basic_motion!} onChange={(v) => updFormData("basic_motion", v)} />
                      <PreviewTab6Basic data={formData.basic_motion!} userName={uname} date={dFormatted} />
                    </>)}
                    {activeTab === "6-2" && (<>
                      <Tab6LifeFunction data={formData.life_function!} onChange={(v) => updFormData("life_function", v)} />
                      <PreviewTab6LifeFunction data={formData.life_function!} userName={uname} date={dFormatted} />
                    </>)}
                    {activeTab === "6-34" && (<>
                      <Tab6Cognition data={formData.cognition_behavior!} onChange={(v) => updFormData("cognition_behavior", v)} />
                      <PreviewTab6Cognition data={formData.cognition_behavior!} userName={uname} date={dFormatted} />
                    </>)}
                    {activeTab === "6-5" && (<>
                      <Tab6Social data={formData.social!} onChange={(v) => updFormData("social", v)} />
                      <PreviewTab6Social data={formData.social!} userName={uname} date={dFormatted} />
                    </>)}
                    {activeTab === "6-6" && (<>
                      <Tab6Medical data={formData.medical_health!} onChange={(v) => updFormData("medical_health", v)} />
                      <PreviewTab6Medical data={formData.medical_health!} userName={uname} date={dFormatted} />
                    </>)}
                    {activeTab === "6-dr" && (<>
                      <Tab6Doctor data={formData.doctor_opinion!} onChange={(v) => updFormData("doctor_opinion", v)} />
                      <PreviewTab6Doctor data={formData.doctor_opinion!} userName={uname} date={dFormatted} />
                    </>)}
                    {activeTab === "7s" && (<>
                      <Tab7Summary data={formData.summary!} onChange={(v) => updFormData("summary", v)} />
                      <PreviewTab7Summary data={formData.summary!} userName={uname} date={dFormatted} />
                    </>)}
                    {activeTab === "7sch" && (<>
                      <Tab7Schedule data={formData.daily_schedule!} onChange={(v) => updFormData("daily_schedule", v)} />
                      <PreviewTab7Schedule data={formData.daily_schedule!} userName={uname} date={dFormatted} />
                    </>)}
                  </>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
