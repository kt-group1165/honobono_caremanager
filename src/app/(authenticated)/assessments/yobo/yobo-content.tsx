"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import { Plus, Save, Loader2, FileText, Printer, ArrowLeft, Check, Edit3, Eye, HeartPulse } from "lucide-react";
import { cn } from "@/lib/utils";

import type { YoboFormData } from "./_types";
import { emptyYoboAssessment } from "./_types";
import { YoboForm } from "./_form";
import { YoboPreview } from "./_preview";
import { PREVIEW_PRINT_CSS } from "../_preview";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KaigoUser {
  id: string;
  name: string;
  name_kana: string | null;
  gender: string | null;
}

export interface Certification {
  id: string;
  care_level: string;
  start_date: string;
  end_date: string;
}

export type YoboAssessmentStatus = "draft" | "completed";

export interface YoboAssessment {
  id: string;
  user_id: string;
  certification_id: string | null;
  assessment_date: string;
  assessor_name: string | null;
  status: YoboAssessmentStatus;
  assessment_type: string;
  form_data: YoboFormData;
  created_at: string;
  updated_at: string;
}

export interface YoboContentProps {
  userId: string;
  initialUser: KaigoUser | null;
  initialCertifications: Certification[];
  initialAssessments: YoboAssessment[];
}

export function YoboContent({
  userId,
  initialUser,
  initialCertifications,
  initialAssessments,
}: YoboContentProps) {
  const supabase = useMemo(() => createClient(), []);

  const [selectedUser] = useState<KaigoUser | null>(initialUser);
  const [certifications] = useState<Certification[]>(initialCertifications);
  const [selectedCertId, setSelectedCertId] = useState<string | null>(
    initialCertifications[0]?.id ?? null
  );
  const [assessments, setAssessments] = useState<YoboAssessment[]>(initialAssessments);
  const [loadingList, setLoadingList] = useState(false);

  const [mode, setMode] = useState<"list" | "edit" | "view">("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingCertId, setEditingCertId] = useState<string | null>(null);
  const [assessmentDate, setAssessmentDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [assessorName, setAssessorName] = useState("");
  const [status, setStatus] = useState<YoboAssessmentStatus>("draft");
  const [formData, setFormData] = useState<YoboFormData>(emptyYoboAssessment());
  const [saving, setSaving] = useState(false);

  // 一覧取得 (assessment_type='yobo' でフィルタ)
  const fetchAssessments = useCallback(async () => {
    setLoadingList(true);
    let query = supabase
      .from("kaigo_assessments")
      .select("*")
      .eq("user_id", userId)
      .eq("assessment_type", "yobo");
    if (selectedCertId) query = query.eq("certification_id", selectedCertId);
    const { data, error } = await query.order("assessment_date", { ascending: false });
    if (error) {
      console.error("kaigo_assessments (yobo) fetch failed:", error.message);
      toast.error("予防アセスメントの取得に失敗しました: " + error.message);
    } else {
      setAssessments((data as YoboAssessment[]) ?? []);
    }
    setLoadingList(false);
  }, [userId, selectedCertId, supabase]);

  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    fetchAssessments();
  }, [fetchAssessments]);

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
    setFormData(emptyYoboAssessment());
    setMode("edit");
  };

  const openEdit = (a: YoboAssessment) => {
    setEditingId(a.id);
    setEditingCertId(a.certification_id);
    setAssessmentDate(a.assessment_date);
    setAssessorName(a.assessor_name ?? "");
    setStatus(a.status);
    const merged = { ...emptyYoboAssessment(), ...(a.form_data ?? {}) };
    setFormData(merged as YoboFormData);
    setMode("edit");
  };

  const openView = (a: YoboAssessment) => {
    setEditingId(a.id);
    setEditingCertId(a.certification_id);
    setAssessmentDate(a.assessment_date);
    setAssessorName(a.assessor_name ?? "");
    setStatus(a.status);
    const merged = { ...emptyYoboAssessment(), ...(a.form_data ?? {}) };
    setFormData(merged as YoboFormData);
    setMode("view");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        user_id: userId,
        certification_id: editingCertId,
        assessment_date: assessmentDate,
        assessor_name: assessorName || null,
        status,
        assessment_type: "yobo",
        form_data: formData,
      };
      if (editingId) {
        const { error } = await supabase
          .from("kaigo_assessments")
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq("id", editingId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("kaigo_assessments")
          .insert(payload)
          .select("id")
          .single();
        if (error) throw error;
        setEditingId(data.id);
      }
      toast.success("予防アセスメントを保存しました");
    } catch (err) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      toast.error("保存に失敗しました: " + msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("この予防アセスメントを削除しますか？")) return;
    const { error } = await supabase.from("kaigo_assessments").delete().eq("id", id);
    if (error) {
      toast.error("削除に失敗しました: " + error.message);
      return;
    }
    toast.success("削除しました");
    fetchAssessments();
  };

  const dFormatted = assessmentDate
    ? (() => {
        const d = parseISO(assessmentDate);
        const y = d.getFullYear();
        const era = y >= 2019 ? `令和${y - 2018}` : `平成${y - 1988}`;
        return `${era}年 ${d.getMonth() + 1}月${d.getDate()}日`;
      })()
    : "";

  return (
    <div className="flex-1 overflow-y-auto">
      <style>{PREVIEW_PRINT_CSS}</style>
      {mode === "list" && (
        <div className="p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HeartPulse className="text-emerald-600" size={24} />
              <h1 className="text-xl font-bold text-gray-900">介護予防のためのアセスメント</h1>
              {selectedUser && <span className="text-gray-500 text-sm">— {selectedUser.name} 様</span>}
            </div>
            <button onClick={openNew} disabled={!selectedCertId} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 transition-colors disabled:opacity-50">
              <Plus size={16} /> 新規作成
            </button>
          </div>

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
                          ? "border-emerald-600 text-emerald-700 bg-emerald-50 font-semibold"
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
            <div className="flex items-center justify-center py-16"><Loader2 size={24} className="animate-spin text-emerald-500" /></div>
          ) : assessments.length === 0 ? (
            <div className="rounded-lg border bg-white py-16 text-center shadow-sm">
              <FileText size={40} className="mx-auto mb-3 text-gray-300" />
              <p className="text-sm text-gray-500">まだ予防アセスメントがありません</p>
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
                        {a.status === "completed" && (
                          <button onClick={() => openView(a)} className="text-gray-600 hover:underline text-xs mr-3">閲覧</button>
                        )}
                        <button onClick={() => openEdit(a)} className="text-emerald-600 hover:underline text-xs mr-3">編集</button>
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

      {(mode === "edit" || mode === "view") && (
        <div className="flex flex-col h-full">
          <div className="sticky top-0 z-20 bg-white border-b px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button onClick={() => setMode("list")} className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
                <ArrowLeft size={14} /> 一覧へ戻る
              </button>
              {mode === "view" ? <Eye className="text-gray-600" size={20} /> : <HeartPulse className="text-emerald-600" size={20} />}
              <h1 className="text-base font-bold text-gray-900">{mode === "view" ? "予防アセスメント閲覧" : "介護予防のためのアセスメント"}</h1>
              {selectedUser && <span className="text-gray-500 text-sm">— {selectedUser.name} 様</span>}
              {mode === "view" && (
                <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">読み取り専用</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {mode === "edit" ? (
                <>
                  <input type="date" value={assessmentDate} onChange={(e) => setAssessmentDate(e.target.value)} className="rounded border px-2 py-1 text-sm" />
                  <input type="text" value={assessorName} onChange={(e) => setAssessorName(e.target.value)} placeholder="作成者" className="rounded border px-2 py-1 text-sm w-32" />
                  <button onClick={() => setStatus(status === "draft" ? "completed" : "draft")} className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                    {status === "draft" ? <><Edit3 size={14} /> 下書き</> : <><Check size={14} /> 完了</>}
                  </button>
                </>
              ) : (
                <>
                  <span className="rounded border px-2 py-1 text-sm bg-gray-50 text-gray-700">
                    {format(parseISO(assessmentDate), "yyyy/M/d")}
                  </span>
                  <span className="rounded border px-2 py-1 text-sm bg-gray-50 text-gray-700 w-32 truncate" title={assessorName || "—"}>
                    {assessorName || "—"}
                  </span>
                </>
              )}
              <button onClick={() => window.print()} className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                <Printer size={14} /> 印刷
              </button>
              {mode === "edit" && (
                <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  保存
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {mode !== "view" && <YoboForm data={formData} onChange={setFormData} />}
            <YoboPreview data={formData} userName={selectedUser?.name ?? ""} date={dFormatted} />
          </div>
        </div>
      )}
    </div>
  );
}
