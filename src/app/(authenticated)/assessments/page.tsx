"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { UserSidebar } from "@/components/users/user-sidebar";
import { format, parseISO, differenceInYears } from "date-fns";
import { ja } from "date-fns/locale";
import {
  Plus,
  Edit2,
  Trash2,
  Printer,
  CheckCircle,
  FileText,
  ChevronDown,
  X,
  Save,
  Loader2,
  Eye,
  AlertTriangle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KaigoUser {
  id: string;
  name: string;
  name_kana: string | null;
  gender: "男" | "女";
  birth_date: string;
  address: string | null;
  postal_code: string | null;
  status: string;
}

type AdlLevel = "自立" | "見守り" | "一部介助" | "全介助" | "";

interface AdlRecord {
  level: AdlLevel;
  notes: string;
}

interface IadlRecord {
  level: AdlLevel;
}

interface AssessmentFormData {
  // Section 2
  family_situation: string;
  informal_support: string;
  // Section 3
  current_services: string;
  // Section 4
  housing_type: string;
  housing_situation: string;
  housing_issues: string;
  // Section 5
  health_condition: string;
  medical_visits: string;
  medications: string;
  // Section 6 ADL
  adl_mobility: AdlRecord;
  adl_eating: AdlRecord;
  adl_toileting: AdlRecord;
  adl_bathing: AdlRecord;
  adl_dressing: AdlRecord;
  adl_grooming: AdlRecord;
  adl_communication: AdlRecord;
  adl_cognition: AdlRecord;
  // Section 6 IADL
  iadl_cooking: IadlRecord;
  iadl_cleaning: IadlRecord;
  iadl_laundry: IadlRecord;
  iadl_shopping: IadlRecord;
  iadl_money_management: IadlRecord;
  // Section 7
  user_request: string;
  family_request: string;
  overall_summary: string;
  issues: string;
  // Section 8
  daily_schedule: string;
  // Meta
  assessor_name: string;
}

interface Assessment {
  id: string;
  user_id: string;
  assessor_name: string | null;
  status: "draft" | "completed";
  assessment_date: string;
  form_data: AssessmentFormData;
  created_at: string;
  updated_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ADL_LEVELS: AdlLevel[] = ["自立", "見守り", "一部介助", "全介助"];

const ADL_ITEMS: { key: keyof AssessmentFormData; label: string }[] = [
  { key: "adl_mobility", label: "移動" },
  { key: "adl_eating", label: "食事" },
  { key: "adl_toileting", label: "排泄" },
  { key: "adl_bathing", label: "入浴" },
  { key: "adl_dressing", label: "更衣" },
  { key: "adl_grooming", label: "整容" },
  { key: "adl_communication", label: "コミュニケーション" },
  { key: "adl_cognition", label: "認知" },
];

const IADL_ITEMS: { key: keyof AssessmentFormData; label: string }[] = [
  { key: "iadl_cooking", label: "調理" },
  { key: "iadl_cleaning", label: "掃除" },
  { key: "iadl_laundry", label: "洗濯" },
  { key: "iadl_shopping", label: "買物" },
  { key: "iadl_money_management", label: "金銭管理" },
];

const HOUSING_TYPES = ["戸建", "マンション", "アパート", "公営住宅", "その他"];

const ADL_LEVEL_COLORS: Record<string, string> = {
  自立: "bg-green-100 text-green-800 border-green-200",
  見守り: "bg-yellow-100 text-yellow-800 border-yellow-200",
  一部介助: "bg-orange-100 text-orange-800 border-orange-200",
  全介助: "bg-red-100 text-red-800 border-red-200",
  "": "bg-gray-100 text-gray-500 border-gray-200",
};

const ADL_LEVEL_DOT: Record<string, string> = {
  自立: "bg-green-500",
  見守り: "bg-yellow-500",
  一部介助: "bg-orange-500",
  全介助: "bg-red-500",
  "": "bg-gray-300",
};

function emptyFormData(): AssessmentFormData {
  const emptyAdl = (): AdlRecord => ({ level: "", notes: "" });
  const emptyIadl = (): IadlRecord => ({ level: "" });
  return {
    family_situation: "",
    informal_support: "",
    current_services: "",
    housing_type: "",
    housing_situation: "",
    housing_issues: "",
    health_condition: "",
    medical_visits: "",
    medications: "",
    adl_mobility: emptyAdl(),
    adl_eating: emptyAdl(),
    adl_toileting: emptyAdl(),
    adl_bathing: emptyAdl(),
    adl_dressing: emptyAdl(),
    adl_grooming: emptyAdl(),
    adl_communication: emptyAdl(),
    adl_cognition: emptyAdl(),
    iadl_cooking: emptyIadl(),
    iadl_cleaning: emptyIadl(),
    iadl_laundry: emptyIadl(),
    iadl_shopping: emptyIadl(),
    iadl_money_management: emptyIadl(),
    user_request: "",
    family_request: "",
    overall_summary: "",
    issues: "",
    daily_schedule: "",
    assessor_name: "",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcAge(birthDate: string): number {
  try {
    return differenceInYears(new Date(), parseISO(birthDate));
  } catch {
    return 0;
  }
}

function formatDateJa(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "yyyy年M月d日", { locale: ja });
  } catch {
    return dateStr;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ number, title }: { number: number; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-bold flex items-center justify-center">
        {number}
      </div>
      <h3 className="text-base font-semibold text-gray-800 border-b border-blue-200 flex-1 pb-1">
        {title}
      </h3>
    </div>
  );
}

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-sm font-medium text-gray-700 mb-1">
      {children}
      {required && <span className="text-red-500 ml-1">*</span>}
    </label>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-sm text-gray-800 min-h-[38px]">
        {value || <span className="text-gray-400">—</span>}
      </div>
    </div>
  );
}

function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  rows?: number;
  readOnly?: boolean;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      {readOnly ? (
        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-sm text-gray-800 whitespace-pre-wrap min-h-[80px]">
          {value || <span className="text-gray-400">—</span>}
        </div>
      ) : (
        <textarea
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
          rows={rows}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
        />
      )}
    </div>
  );
}

// ─── ADL Row ──────────────────────────────────────────────────────────────────

function AdlRow({
  label,
  value,
  onChange,
  readOnly,
}: {
  label: string;
  value: AdlRecord;
  onChange?: (v: AdlRecord) => void;
  readOnly: boolean;
}) {
  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-white">
      <div className="flex items-start gap-3">
        <span className="text-sm font-medium text-gray-700 w-28 flex-shrink-0 pt-1">{label}</span>
        <div className="flex-1 space-y-2">
          {readOnly ? (
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${ADL_LEVEL_COLORS[value.level]}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${ADL_LEVEL_DOT[value.level]}`} />
              {value.level || "未評価"}
            </span>
          ) : (
            <div className="flex flex-wrap gap-2">
              {ADL_LEVELS.map((lvl) => (
                <label
                  key={lvl}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer transition-all ${
                    value.level === lvl
                      ? ADL_LEVEL_COLORS[lvl]
                      : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
                  }`}
                >
                  <input
                    type="radio"
                    name={`adl-${label}`}
                    value={lvl}
                    checked={value.level === lvl}
                    onChange={() => onChange?.({ ...value, level: lvl })}
                    className="sr-only"
                  />
                  {lvl}
                </label>
              ))}
            </div>
          )}
          {readOnly ? (
            value.notes && (
              <p className="text-xs text-gray-600 mt-1 pl-1">{value.notes}</p>
            )
          ) : (
            <input
              type="text"
              className="w-full px-2 py-1 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
              placeholder="特記事項"
              value={value.notes}
              onChange={(e) => onChange?.({ ...value, notes: e.target.value })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function IadlRow({
  label,
  value,
  onChange,
  readOnly,
}: {
  label: string;
  value: IadlRecord;
  onChange?: (v: IadlRecord) => void;
  readOnly: boolean;
}) {
  return (
    <div className="flex items-center gap-3 border border-gray-200 rounded-lg p-3 bg-white">
      <span className="text-sm font-medium text-gray-700 w-28 flex-shrink-0">{label}</span>
      {readOnly ? (
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${ADL_LEVEL_COLORS[value.level]}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${ADL_LEVEL_DOT[value.level]}`} />
          {value.level || "未評価"}
        </span>
      ) : (
        <div className="flex flex-wrap gap-2">
          {ADL_LEVELS.map((lvl) => (
            <label
              key={lvl}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer transition-all ${
                value.level === lvl
                  ? ADL_LEVEL_COLORS[lvl]
                  : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
              }`}
            >
              <input
                type="radio"
                name={`iadl-${label}`}
                value={lvl}
                checked={value.level === lvl}
                onChange={() => onChange?.({ level: lvl })}
                className="sr-only"
              />
              {lvl}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Print View ───────────────────────────────────────────────────────────────

function PrintView({
  assessment,
  user,
}: {
  assessment: Assessment;
  user: KaigoUser;
}) {
  const fd = assessment.form_data;
  return (
    <div className="print-area font-sans text-sm text-gray-900 p-8 max-w-[210mm] mx-auto">
      {/* Header */}
      <div className="text-center mb-6">
        <h1 className="text-xl font-bold tracking-wide">居宅サービス計画ガイドライン方式</h1>
        <h2 className="text-lg font-semibold text-gray-700 mt-1">アセスメントシート</h2>
      </div>
      <div className="flex justify-between text-xs text-gray-600 mb-6 border-b pb-3">
        <span>作成日：{formatDateJa(assessment.assessment_date)}</span>
        <span>担当者：{assessment.assessor_name || "—"}</span>
        <span>
          状態：
          {assessment.status === "completed" ? "完成" : "下書き"}
        </span>
      </div>

      {/* Section 1 */}
      <PrintSection title="第1表　基本情報">
        <div className="grid grid-cols-2 gap-2">
          <PrintField label="氏名" value={user.name} />
          <PrintField label="ふりがな" value={user.name_kana || "—"} />
          <PrintField
            label="生年月日"
            value={`${formatDateJa(user.birth_date)}（${calcAge(user.birth_date)}歳）`}
          />
          <PrintField label="性別" value={user.gender} />
          <PrintField label="住所" value={user.address || "—"} span />
        </div>
      </PrintSection>

      {/* Section 2 */}
      <PrintSection title="第2表　家族状況・インフォーマルな支援の状況">
        <PrintField label="家族状況" value={fd.family_situation} multiline />
        <PrintField label="インフォーマルな支援" value={fd.informal_support} multiline />
      </PrintSection>

      {/* Section 3 */}
      <PrintSection title="第3表　サービス利用状況">
        <PrintField label="現在利用中のサービス" value={fd.current_services} multiline />
      </PrintSection>

      {/* Section 4 */}
      <PrintSection title="第4表　住居等の状況">
        <div className="grid grid-cols-2 gap-2">
          <PrintField label="住居種別" value={fd.housing_type || "—"} />
        </div>
        <PrintField label="住居の状況" value={fd.housing_situation} multiline />
        <PrintField label="住居に関する問題点" value={fd.housing_issues} multiline />
      </PrintSection>

      {/* Section 5 */}
      <PrintSection title="第5表　健康状態・受診等の状況">
        <PrintField label="健康状態" value={fd.health_condition} multiline />
        <PrintField label="受診状況" value={fd.medical_visits} multiline />
        <PrintField label="服薬状況" value={fd.medications} multiline />
      </PrintSection>

      {/* Section 6 */}
      <PrintSection title="第6表　基本動作等の状況・援助状況">
        <p className="text-xs font-semibold text-gray-600 mb-2">ADL（基本動作）</p>
        <table className="w-full text-xs border-collapse mb-3">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-2 py-1 text-left w-28">項目</th>
              <th className="border border-gray-300 px-2 py-1 text-center w-20">評価</th>
              <th className="border border-gray-300 px-2 py-1 text-left">特記事項</th>
            </tr>
          </thead>
          <tbody>
            {ADL_ITEMS.map(({ key, label }) => {
              const v = fd[key] as AdlRecord;
              return (
                <tr key={key}>
                  <td className="border border-gray-300 px-2 py-1">{label}</td>
                  <td className="border border-gray-300 px-2 py-1 text-center">{v.level || "—"}</td>
                  <td className="border border-gray-300 px-2 py-1">{v.notes || ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="text-xs font-semibold text-gray-600 mb-2">IADL（手段的日常生活動作）</p>
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-2 py-1 text-left w-28">項目</th>
              <th className="border border-gray-300 px-2 py-1 text-center">評価</th>
            </tr>
          </thead>
          <tbody>
            {IADL_ITEMS.map(({ key, label }) => {
              const v = fd[key] as IadlRecord;
              return (
                <tr key={key}>
                  <td className="border border-gray-300 px-2 py-1">{label}</td>
                  <td className="border border-gray-300 px-2 py-1 text-center">{v.level || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </PrintSection>

      {/* Section 7 */}
      <PrintSection title="第7表　全体のまとめ">
        <PrintField label="本人の意向" value={fd.user_request} multiline />
        <PrintField label="家族の意向" value={fd.family_request} multiline />
        <PrintField label="生活全般の解決すべき課題" value={fd.issues} multiline />
        <PrintField label="総合的な援助の方針" value={fd.overall_summary} multiline />
      </PrintSection>

      {/* Section 8 */}
      <PrintSection title="第8表　1日のスケジュール">
        <PrintField label="1日のスケジュール" value={fd.daily_schedule} multiline />
      </PrintSection>
    </div>
  );
}

function PrintSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="text-sm font-bold bg-gray-700 text-white px-3 py-1.5 rounded-t">{title}</h3>
      <div className="border border-gray-300 border-t-0 rounded-b p-3 space-y-2">{children}</div>
    </div>
  );
}

function PrintField({
  label,
  value,
  multiline,
  span,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  span?: boolean;
}) {
  return (
    <div className={span ? "col-span-2" : ""}>
      <span className="text-xs font-semibold text-gray-500">{label}：</span>
      {multiline ? (
        <p className="text-sm mt-0.5 whitespace-pre-wrap pl-2 text-gray-800">{value || "—"}</p>
      ) : (
        <span className="text-sm text-gray-800">{value || "—"}</span>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AssessmentsPage() {
  const supabase = createClient();
  const printRef = useRef<HTMLDivElement>(null);

  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<KaigoUser | null>(null);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingAssessments, setLoadingAssessments] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState(false);
  const [formData, setFormData] = useState<AssessmentFormData>(emptyFormData());
  const [assessmentDate, setAssessmentDate] = useState(
    format(new Date(), "yyyy-MM-dd")
  );

  // Print modal
  const [printTarget, setPrintTarget] = useState<Assessment | null>(null);

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // ── Fetch Users ──────────────────────────────────────────────────────────
  useEffect(() => {
    const fetchUsers = async () => {
      setLoadingUsers(true);
      const { data, error } = await supabase
        .from("kaigo_users")
        .select("id, name, name_kana, gender, birth_date, address, postal_code, status")
        .eq("status", "active")
        .order("name_kana", { ascending: true });

      if (error) {
        toast.error("利用者の取得に失敗しました");
      } else {
        setUsers(data || []);
        if (data && data.length > 0) {
          setSelectedUserId(data[0].id);
        }
      }
      setLoadingUsers(false);
    };
    fetchUsers();
  }, []);

  // ── Update selected user object ──────────────────────────────────────────
  useEffect(() => {
    const u = users.find((u) => u.id === selectedUserId) || null;
    setSelectedUser(u);
  }, [selectedUserId, users]);

  // ── Fetch Assessments ────────────────────────────────────────────────────
  const fetchAssessments = useCallback(async () => {
    if (!selectedUserId) return;
    setLoadingAssessments(true);
    const { data, error } = await supabase
      .from("kaigo_assessments")
      .select("*")
      .eq("user_id", selectedUserId)
      .order("assessment_date", { ascending: false });

    if (error) {
      toast.error("アセスメントの取得に失敗しました");
    } else {
      setAssessments((data || []) as Assessment[]);
    }
    setLoadingAssessments(false);
  }, [selectedUserId]);

  useEffect(() => {
    fetchAssessments();
    setShowForm(false);
    setEditingId(null);
  }, [fetchAssessments]);

  // ── Helpers ──────────────────────────────────────────────────────────────
  function updateField<K extends keyof AssessmentFormData>(key: K, value: AssessmentFormData[K]) {
    setFormData((prev) => ({ ...prev, [key]: value }));
  }

  function openNew() {
    setFormData(emptyFormData());
    setAssessmentDate(format(new Date(), "yyyy-MM-dd"));
    setEditingId(null);
    setViewMode(false);
    setShowForm(true);
  }

  function openEdit(a: Assessment) {
    setFormData(a.form_data);
    setAssessmentDate(a.assessment_date);
    setEditingId(a.id);
    setViewMode(false);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openView(a: Assessment) {
    setFormData(a.form_data);
    setAssessmentDate(a.assessment_date);
    setEditingId(a.id);
    setViewMode(true);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setViewMode(false);
  }

  async function handleSave() {
    if (!selectedUserId) return;
    setSaving(true);
    try {
      const payload = {
        user_id: selectedUserId,
        assessment_date: assessmentDate,
        assessor_name: formData.assessor_name || null,
        status: "draft" as const,
        form_data: formData,
      };

      if (editingId) {
        const { error } = await supabase
          .from("kaigo_assessments")
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq("id", editingId);
        if (error) throw error;
        toast.success("アセスメントを更新しました");
      } else {
        const { error } = await supabase.from("kaigo_assessments").insert(payload);
        if (error) throw error;
        toast.success("アセスメントを作成しました");
      }

      await fetchAssessments();
      closeForm();
    } catch (err) {
      toast.error("保存に失敗しました");
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleStatus(a: Assessment) {
    const nextStatus = a.status === "draft" ? "completed" : "draft";
    const { error } = await supabase
      .from("kaigo_assessments")
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq("id", a.id);

    if (error) {
      toast.error("ステータスの変更に失敗しました");
    } else {
      toast.success(nextStatus === "completed" ? "完成にしました" : "下書きに戻しました");
      await fetchAssessments();
    }
  }

  async function handleDelete(id: string) {
    const { error } = await supabase.from("kaigo_assessments").delete().eq("id", id);
    if (error) {
      toast.error("削除に失敗しました");
    } else {
      toast.success("アセスメントを削除しました");
      setDeleteConfirmId(null);
      await fetchAssessments();
    }
  }

  function handlePrint(a: Assessment) {
    setPrintTarget(a);
    setTimeout(() => {
      window.print();
    }, 300);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Print-only area */}
      {printTarget && selectedUser && (
        <div className="hidden print:block">
          <PrintView assessment={printTarget} user={selectedUser} />
        </div>
      )}

      {/* Screen content */}
      <div className="print:hidden flex h-full -m-6">
        <UserSidebar selectedUserId={selectedUserId} onSelectUser={setSelectedUserId} />
        <div className="flex-1 overflow-y-auto p-6">
      <div className="min-h-screen bg-gray-50">
        {/* Page header */}
        <div className="bg-white border-b border-gray-200 px-6 py-4">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <FileText className="w-4 h-4 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-gray-900">アセスメント</h1>
                <p className="text-xs text-gray-500">居宅サービス計画ガイドライン方式</p>
              </div>
            </div>
          </div>
        </div>

        <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
          {/* User selector */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center gap-4 flex-wrap">
              {selectedUser && (
                <div className="flex gap-4 text-sm text-gray-600">
                  <span>{selectedUser.gender}</span>
                  <span>
                    {formatDateJa(selectedUser.birth_date)}（{calcAge(selectedUser.birth_date)}歳）
                  </span>
                </div>
              )}

              {!showForm && (
                <button
                  onClick={openNew}
                  disabled={!selectedUserId}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ml-auto"
                >
                  <Plus className="w-4 h-4" />
                  新規作成
                </button>
              )}
            </div>
          </div>

          {/* Assessment form */}
          {showForm && selectedUser && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {/* Form header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-blue-50">
                <div className="flex items-center gap-3">
                  <h2 className="font-semibold text-gray-800">
                    {viewMode ? "アセスメント閲覧" : editingId ? "アセスメント編集" : "新規アセスメント"}
                  </h2>
                  {viewMode && (
                    <span className="text-xs text-gray-500">（閲覧モード）</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {viewMode ? (
                    <button
                      onClick={() => setViewMode(false)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                      編集
                    </button>
                  ) : (
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      {saving ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Save className="w-3.5 h-3.5" />
                      )}
                      保存
                    </button>
                  )}
                  <button
                    onClick={closeForm}
                    className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Form body */}
              <div className="p-6 space-y-8">
                {/* Meta fields */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <FieldLabel required>作成日</FieldLabel>
                    {viewMode ? (
                      <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-sm">
                        {formatDateJa(assessmentDate)}
                      </div>
                    ) : (
                      <input
                        type="date"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        value={assessmentDate}
                        onChange={(e) => setAssessmentDate(e.target.value)}
                      />
                    )}
                  </div>
                  <div>
                    <FieldLabel>担当者名</FieldLabel>
                    {viewMode ? (
                      <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-sm">
                        {formData.assessor_name || "—"}
                      </div>
                    ) : (
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="担当者名を入力"
                        value={formData.assessor_name}
                        onChange={(e) => updateField("assessor_name", e.target.value)}
                      />
                    )}
                  </div>
                </div>

                {/* Section 1: 基本情報 */}
                <section>
                  <SectionHeader number={1} title="基本情報" />
                  <div className="grid grid-cols-2 gap-4">
                    <ReadonlyField label="氏名" value={selectedUser.name} />
                    <ReadonlyField label="ふりがな" value={selectedUser.name_kana || "—"} />
                    <ReadonlyField
                      label="生年月日"
                      value={`${formatDateJa(selectedUser.birth_date)}（${calcAge(selectedUser.birth_date)}歳）`}
                    />
                    <ReadonlyField label="性別" value={selectedUser.gender} />
                    <div className="col-span-2">
                      <ReadonlyField
                        label="住所"
                        value={
                          [selectedUser.postal_code ? `〒${selectedUser.postal_code}` : null, selectedUser.address]
                            .filter(Boolean)
                            .join(" ") || "—"
                        }
                      />
                    </div>
                  </div>
                </section>

                {/* Section 2: 家族状況 */}
                <section>
                  <SectionHeader number={2} title="家族状況・インフォーマルな支援の状況" />
                  <div className="space-y-4">
                    <TextareaField
                      label="家族状況"
                      value={formData.family_situation}
                      onChange={(v) => updateField("family_situation", v)}
                      placeholder="家族構成、同居・別居状況など"
                      readOnly={viewMode}
                    />
                    <TextareaField
                      label="インフォーマルな支援の状況"
                      value={formData.informal_support}
                      onChange={(v) => updateField("informal_support", v)}
                      placeholder="近隣、友人、ボランティアなどによる支援状況"
                      readOnly={viewMode}
                    />
                  </div>
                </section>

                {/* Section 3: サービス利用状況 */}
                <section>
                  <SectionHeader number={3} title="サービス利用状況" />
                  <TextareaField
                    label="現在利用中のサービス"
                    value={formData.current_services}
                    onChange={(v) => updateField("current_services", v)}
                    placeholder="訪問介護、デイサービスなど現在利用中のサービスを記入"
                    readOnly={viewMode}
                  />
                </section>

                {/* Section 4: 住居等の状況 */}
                <section>
                  <SectionHeader number={4} title="住居等の状況" />
                  <div className="space-y-4">
                    <div>
                      <FieldLabel>住居種別</FieldLabel>
                      {viewMode ? (
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-sm">
                          {formData.housing_type || "—"}
                        </div>
                      ) : (
                        <div className="relative">
                          <select
                            className="w-full appearance-none border border-gray-300 rounded-md px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                            value={formData.housing_type}
                            onChange={(e) => updateField("housing_type", e.target.value)}
                          >
                            <option value="">選択してください</option>
                            {HOUSING_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                        </div>
                      )}
                    </div>
                    <TextareaField
                      label="住居の状況"
                      value={formData.housing_situation}
                      onChange={(v) => updateField("housing_situation", v)}
                      placeholder="バリアフリー対応状況、間取りなど"
                      readOnly={viewMode}
                    />
                    <TextareaField
                      label="住居に関する問題点"
                      value={formData.housing_issues}
                      onChange={(v) => updateField("housing_issues", v)}
                      placeholder="段差、手すりの有無など"
                      readOnly={viewMode}
                    />
                  </div>
                </section>

                {/* Section 5: 健康状態 */}
                <section>
                  <SectionHeader number={5} title="健康状態・受診等の状況" />
                  <div className="space-y-4">
                    <TextareaField
                      label="健康状態"
                      value={formData.health_condition}
                      onChange={(v) => updateField("health_condition", v)}
                      placeholder="主病名、既往歴など"
                      readOnly={viewMode}
                    />
                    <TextareaField
                      label="受診状況"
                      value={formData.medical_visits}
                      onChange={(v) => updateField("medical_visits", v)}
                      placeholder="主治医、受診科目、頻度など"
                      readOnly={viewMode}
                    />
                    <TextareaField
                      label="服薬状況"
                      value={formData.medications}
                      onChange={(v) => updateField("medications", v)}
                      placeholder="内服薬、服薬管理の状況など"
                      readOnly={viewMode}
                    />
                  </div>
                </section>

                {/* Section 6: ADL/IADL */}
                <section>
                  <SectionHeader number={6} title="基本動作等の状況・援助状況" />
                  <div className="space-y-5">
                    <div>
                      <p className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                        <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">ADL</span>
                        基本動作
                      </p>
                      <div className="grid grid-cols-1 gap-2">
                        {ADL_ITEMS.map(({ key, label }) => (
                          <AdlRow
                            key={key}
                            label={label}
                            value={formData[key] as AdlRecord}
                            onChange={(v) => updateField(key, v)}
                            readOnly={viewMode}
                          />
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                        <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">IADL</span>
                        手段的日常生活動作
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {IADL_ITEMS.map(({ key, label }) => (
                          <IadlRow
                            key={key}
                            label={label}
                            value={formData[key] as IadlRecord}
                            onChange={(v) => updateField(key, v)}
                            readOnly={viewMode}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </section>

                {/* Section 7: 全体のまとめ */}
                <section>
                  <SectionHeader number={7} title="全体のまとめ" />
                  <div className="space-y-4">
                    <TextareaField
                      label="本人の意向"
                      value={formData.user_request}
                      onChange={(v) => updateField("user_request", v)}
                      placeholder="本人が望む生活、希望など"
                      readOnly={viewMode}
                    />
                    <TextareaField
                      label="家族の意向"
                      value={formData.family_request}
                      onChange={(v) => updateField("family_request", v)}
                      placeholder="家族が望む生活、要望など"
                      readOnly={viewMode}
                    />
                    <TextareaField
                      label="生活全般の解決すべき課題（ニーズ）"
                      value={formData.issues}
                      onChange={(v) => updateField("issues", v)}
                      placeholder="生活上の問題点、ニーズを記入"
                      rows={4}
                      readOnly={viewMode}
                    />
                    <TextareaField
                      label="総合的な援助の方針"
                      value={formData.overall_summary}
                      onChange={(v) => updateField("overall_summary", v)}
                      placeholder="援助の基本方針、目標など"
                      rows={4}
                      readOnly={viewMode}
                    />
                  </div>
                </section>

                {/* Section 8: 1日のスケジュール */}
                <section>
                  <SectionHeader number={8} title="1日のスケジュール" />
                  <TextareaField
                    label="1日のスケジュール"
                    value={formData.daily_schedule}
                    onChange={(v) => updateField("daily_schedule", v)}
                    placeholder={"6:00 起床\n7:00 朝食\n9:00 デイサービス送迎\n..."}
                    rows={8}
                    readOnly={viewMode}
                  />
                </section>

                {/* Bottom save button */}
                {!viewMode && (
                  <div className="flex justify-end pt-4 border-t border-gray-200">
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      {saving ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      保存する
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Assessment list */}
          {!showForm && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="font-semibold text-gray-800">
                  アセスメント一覧
                  {selectedUser && (
                    <span className="ml-2 text-sm font-normal text-gray-500">
                      — {selectedUser.name}
                    </span>
                  )}
                </h2>
                <span className="text-sm text-gray-500">{assessments.length}件</span>
              </div>

              {loadingAssessments ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                </div>
              ) : assessments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                  <FileText className="w-12 h-12 mb-3 opacity-40" />
                  <p className="text-sm">アセスメントがありません</p>
                  <p className="text-xs mt-1">「新規作成」ボタンから作成してください</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {assessments.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center gap-4 px-6 py-4 hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-gray-800">
                            {formatDateJa(a.assessment_date)}
                          </span>
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                              a.status === "completed"
                                ? "bg-green-100 text-green-800"
                                : "bg-yellow-100 text-yellow-800"
                            }`}
                          >
                            {a.status === "completed" ? "完成" : "下書き"}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500">
                          担当者：{a.assessor_name || "—"}　作成：
                          {format(parseISO(a.created_at), "yyyy/MM/dd HH:mm", { locale: ja })}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 flex-shrink-0">
                        {/* View */}
                        <button
                          onClick={() => openView(a)}
                          title="閲覧"
                          className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
                        >
                          <Eye className="w-4 h-4" />
                        </button>

                        {/* Edit */}
                        <button
                          onClick={() => openEdit(a)}
                          title="編集"
                          className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-500 hover:text-blue-600 transition-colors"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>

                        {/* Toggle status */}
                        <button
                          onClick={() => handleToggleStatus(a)}
                          title={a.status === "draft" ? "完成にする" : "下書きに戻す"}
                          className={`p-1.5 rounded-lg transition-colors ${
                            a.status === "completed"
                              ? "hover:bg-yellow-50 text-green-600 hover:text-yellow-600"
                              : "hover:bg-green-50 text-gray-400 hover:text-green-600"
                          }`}
                        >
                          <CheckCircle className="w-4 h-4" />
                        </button>

                        {/* Print */}
                        <button
                          onClick={() => handlePrint(a)}
                          title="印刷"
                          className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
                        >
                          <Printer className="w-4 h-4" />
                        </button>

                        {/* Delete */}
                        {deleteConfirmId === a.id ? (
                          <div className="flex items-center gap-1 ml-1 px-2 py-1 bg-red-50 rounded-lg border border-red-200">
                            <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                            <span className="text-xs text-red-600">削除しますか？</span>
                            <button
                              onClick={() => handleDelete(a.id)}
                              className="text-xs text-red-600 font-semibold hover:text-red-800 ml-1"
                            >
                              はい
                            </button>
                            <button
                              onClick={() => setDeleteConfirmId(null)}
                              className="text-xs text-gray-500 hover:text-gray-700 ml-1"
                            >
                              キャンセル
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirmId(a.id)}
                            title="削除"
                            className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
        </div>
      </div>

      {/* Print button overlay when printTarget set */}
      {printTarget && !showForm && (
        <div className="print:hidden fixed bottom-6 right-6">
          <button
            onClick={() => setPrintTarget(null)}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-700 shadow-lg transition-colors"
          >
            <X className="w-4 h-4" />
            印刷プレビューを閉じる
          </button>
        </div>
      )}

      {/* Print styles */}
      <style jsx global>{`
        @media print {
          body * {
            visibility: hidden;
          }
          .print-area,
          .print-area * {
            visibility: visible;
          }
          .print-area {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
          }
        }
      `}</style>
    </>
  );
}
