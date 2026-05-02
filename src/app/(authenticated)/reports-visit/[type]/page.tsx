"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { UserSidebar } from "@/components/users/user-sidebar";
import { toast } from "sonner";
import {
  FileText, ClipboardList, Printer, Save, Loader2, ChevronLeft, Plus, X, Info,
  ArrowDown, Wand2,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";

// ─── Config ────────────────────────────────────────────────────────────────
const REPORT_CONFIG: Record<string, { titleJa: string; titleEn: string }> = {
  "visit-care-plan": { titleJa: "訪問介護計画書", titleEn: "Home Care Plan" },
  "visit-implementation": { titleJa: "サービス実施記録書", titleEn: "Visit Implementation Record" },
  "visit-results": { titleJa: "実績報告書", titleEn: "Results Report" },
};

// ─── Types ─────────────────────────────────────────────────────────────────
type GoalItem = { goal: string; period: string };
type WeekDay = "月" | "火" | "水" | "木" | "金" | "土" | "日";
type WeeklyService = {
  day_of_week: string;           // "月" | "火" | ... | "月水金"（複数可）
  start_time: string;             // "09:00"
  end_time: string;               // "10:00"
  service_type: string;           // 身体介護/生活援助/身体・生活
  content: string;                // 援助内容の詳細
  staff_note: string;             // 担当者/備考
};

interface VisitCarePlanContent {
  // ヘッダー
  creation_date: string;          // 計画作成日
  initial_creation_date: string;  // 初回作成日
  office_name: string;            // 事業所名
  manager_name: string;           // サービス提供責任者名
  creator_name: string;           // 計画作成者
  // 利用者情報（手動補填可能）
  user_name: string;
  user_kana: string;
  user_gender: string;
  user_birth_date: string;
  user_age: string;
  user_address: string;
  user_phone: string;
  care_level: string;
  cert_period: string;
  // 本人・家族の意向
  user_intention: string;
  family_intention: string;
  // 援助の基本方針
  basic_policy: string;
  // 援助目標
  long_term_goals: GoalItem[];
  short_term_goals: GoalItem[];
  // 週間スケジュール
  weekly_services: WeeklyService[];
  // 留意事項・緊急時対応
  precautions: string;
  emergency_response: string;
  // 同意確認
  consent_date: string;
  consent_user_name: string;      // 利用者署名
  consent_proxy_name: string;     // 代理人名
  consent_proxy_relation: string; // 続柄
}

const emptyContent = (): VisitCarePlanContent => ({
  creation_date: format(new Date(), "yyyy-MM-dd"),
  initial_creation_date: "",
  office_name: "",
  manager_name: "",
  creator_name: "",
  user_name: "", user_kana: "", user_gender: "", user_birth_date: "", user_age: "",
  user_address: "", user_phone: "",
  care_level: "", cert_period: "",
  user_intention: "",
  family_intention: "",
  basic_policy: "",
  long_term_goals: [{ goal: "", period: "" }],
  short_term_goals: [{ goal: "", period: "" }],
  weekly_services: [],
  precautions: "",
  emergency_response: "",
  consent_date: "",
  consent_user_name: "",
  consent_proxy_name: "",
  consent_proxy_relation: "",
});

const SERVICE_TYPES = ["身体介護", "生活援助", "身体・生活", "通院等乗降介助"];
const WEEK_DAYS: WeekDay[] = ["月", "火", "水", "木", "金", "土", "日"];

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function ReportsVisitEditorPage() {
  const params = useParams<{ type: string }>();
  const reportType = params.type;
  const supabase = useMemo(() => createClient(), []);
  const config = REPORT_CONFIG[reportType];

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [content, setContent] = useState<VisitCarePlanContent>(emptyContent());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // ─── 利用者情報＋既存ドキュメントをロード ─────────────────────────
  const loadDocument = useCallback(async (userId: string) => {
    setLoading(true);

    // 利用者情報取得
    const { data: userData } = await supabase
      .from("clients")
      .select("name, name_kana:furigana, gender, birth_date, address, phone")
      .eq("id", userId)
      .single();

    // 認定情報取得（client_insurance_records、PostgREST 列エイリアスでフィールド名維持）
    const { data: certData } = await supabase
      .from("client_insurance_records")
      .select("care_level, start_date:certification_start_date, end_date:certification_end_date")
      .eq("client_id", userId)
      .eq("certification_status", "active")
      .order("certification_start_date", { ascending: false, nullsFirst: false })
      .limit(1);

    // 既存文書
    const { data: docData } = await supabase
      .from("kaigo_report_documents")
      .select("id, content")
      .eq("user_id", userId)
      .eq("report_type", reportType)
      .order("updated_at", { ascending: false })
      .limit(1);

    // 事業所情報（共通マスタ offices, kaigo-app の自事業所、PostgREST 列エイリアスで旧フィールド名維持）
    // 旧 business_type='home_care' → 新 service_type='訪問介護'
    const { data: officeData } = await supabase
      .from("offices")
      .select("office_name:name, manager_name")
      .eq("app_type", "kaigo-app")
      .eq("service_type", "訪問介護")
      .eq("is_active", true)
      .limit(1);

    let c: VisitCarePlanContent = emptyContent();
    if (docData && docData.length > 0) {
      c = { ...emptyContent(), ...(docData[0].content as Partial<VisitCarePlanContent>) };
      setDocId(docData[0].id);
    } else {
      setDocId(null);
    }

    // 利用者情報を自動反映
    if (userData) {
      c.user_name = c.user_name || userData.name || "";
      c.user_kana = c.user_kana || userData.name_kana || "";
      c.user_gender = c.user_gender || userData.gender || "";
      c.user_birth_date = c.user_birth_date || userData.birth_date || "";
      c.user_address = c.user_address || userData.address || "";
      c.user_phone = c.user_phone || userData.phone || "";
      if (!c.user_age && userData.birth_date) {
        const age = new Date().getFullYear() - new Date(userData.birth_date).getFullYear();
        c.user_age = String(age);
      }
    }
    if (certData && certData.length > 0) {
      c.care_level = c.care_level || certData[0].care_level || "";
      c.cert_period = c.cert_period || (certData[0].start_date && certData[0].end_date
        ? `${certData[0].start_date} 〜 ${certData[0].end_date}` : "");
    }
    if (officeData && officeData.length > 0) {
      c.office_name = c.office_name || officeData[0].office_name || "";
      c.manager_name = c.manager_name || officeData[0].manager_name || "";
    }

    setContent(c);
    setLoading(false);
  }, [supabase, reportType]);

  useEffect(() => {
    if (selectedUserId) loadDocument(selectedUserId);
  }, [selectedUserId, loadDocument]);

  // ─── 保存 ─────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!selectedUserId) { toast.error("利用者を選択してください"); return; }
    setSaving(true);
    const payload = {
      user_id: selectedUserId,
      report_type: reportType,
      title: `${config?.titleJa} ${content.creation_date ?? ""}`,
      content: content as unknown as Record<string, unknown>,
      status: "draft" as const,
    };
    if (docId) {
      const { error } = await supabase.from("kaigo_report_documents").update(payload).eq("id", docId);
      if (error) toast.error("保存失敗: " + error.message);
      else toast.success("保存しました");
    } else {
      const { data, error } = await supabase.from("kaigo_report_documents").insert(payload).select("id").single();
      if (error) toast.error("保存失敗: " + error.message);
      else { toast.success("保存しました"); setDocId(data.id); }
    }
    setSaving(false);
  };

  // ─── ケアプラン（第2表）から援助目標と週間サービスを自動取得 ──────
  const handleImportFromCarePlan = async () => {
    if (!selectedUserId) return;
    toast.info("ケアプランから取り込み中...");
    const { data: docs } = await supabase
      .from("kaigo_report_documents")
      .select("content, updated_at")
      .eq("user_id", selectedUserId)
      .eq("report_type", "care-plan-2")
      .order("updated_at", { ascending: false })
      .limit(1);

    if (!docs || docs.length === 0) {
      toast.error("第2表が未作成です");
      return;
    }
    const c = docs[0].content as Record<string, unknown>;
    const blocks = (c.needs_blocks ?? c.blocks ?? []) as Array<Record<string, unknown>>;

    const longGoals: GoalItem[] = [];
    const shortGoals: GoalItem[] = [];

    for (const blk of blocks) {
      const ltg = String(blk.long_term_goal ?? "").trim();
      const ltp = String(blk.long_term_period ?? "").trim();
      if (ltg) longGoals.push({ goal: ltg, period: ltp });
      const goals = (blk.goals ?? []) as Array<Record<string, unknown>>;
      for (const g of goals) {
        const stg = String(g.short_term_goal ?? "").trim();
        const stp = String(g.short_term_period ?? "").trim();
        if (stg) shortGoals.push({ goal: stg, period: stp });
      }
    }

    // 訪問介護スケジュールから週間サービスを取得（直近4週間分の予定から頻度推定）
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 28);
    const { data: schedules } = await supabase
      .from("kaigo_visit_schedule")
      .select("visit_date, start_time, end_time, service_type")
      .eq("user_id", selectedUserId)
      .gte("visit_date", format(fromDate, "yyyy-MM-dd"))
      .order("visit_date");

    const weekMap = new Map<string, WeeklyService>();
    for (const s of (schedules ?? []) as Array<Record<string, unknown>>) {
      const date = parseISO(String(s.visit_date));
      const dayJa = ["日", "月", "火", "水", "木", "金", "土"][date.getDay()];
      const start = String(s.start_time ?? "").slice(0, 5);
      const end = String(s.end_time ?? "").slice(0, 5);
      const type = String(s.service_type ?? "");
      const key = `${dayJa}_${start}_${end}_${type}`;
      if (!weekMap.has(key)) {
        weekMap.set(key, { day_of_week: dayJa, start_time: start, end_time: end, service_type: type, content: "", staff_note: "" });
      }
    }

    setContent((prev) => ({
      ...prev,
      long_term_goals: longGoals.length > 0 ? longGoals : prev.long_term_goals,
      short_term_goals: shortGoals.length > 0 ? shortGoals : prev.short_term_goals,
      weekly_services: weekMap.size > 0 ? Array.from(weekMap.values()) : prev.weekly_services,
    }));
    toast.success(`${longGoals.length}件の長期目標・${shortGoals.length}件の短期目標・${weekMap.size}件の週間サービスを取り込みました`);
  };

  const handlePrint = () => window.print();

  // ─── 編集ヘルパ ─────────────────────────────────────────────────────
  const update = <K extends keyof VisitCarePlanContent>(k: K, v: VisitCarePlanContent[K]) =>
    setContent((p) => ({ ...p, [k]: v }));

  if (!config) {
    return (
      <div className="p-6">
        <p>不明な帳票タイプです: {reportType}</p>
        <Link href="/reports-visit" className="text-blue-600 hover:underline">戻る</Link>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      <div className="print:hidden">
        <UserSidebar selectedUserId={selectedUserId} onSelectUser={setSelectedUserId} />
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 border-b bg-white px-6 py-4 flex items-center justify-between print:hidden">
          <div className="flex items-center gap-3">
            <Link href="/reports-visit" className="text-gray-400 hover:text-gray-600"><ChevronLeft size={20} /></Link>
            <div>
              <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                <FileText size={22} className="text-emerald-600" />
                {config.titleJa}
              </h1>
              <p className="text-xs text-gray-500">{config.titleEn}</p>
            </div>
          </div>
          {selectedUserId && (
            <div className="flex items-center gap-2">
              <button onClick={handleImportFromCarePlan} className="flex items-center gap-1 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-sm font-medium text-purple-700 hover:bg-purple-100">
                <Wand2 size={14} />
                ケアプランから取込
              </button>
              <button onClick={handlePrint} className="flex items-center gap-1 rounded-lg border px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                <Printer size={14} />印刷
              </button>
              <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}保存
              </button>
            </div>
          )}
        </div>

        {/* Body */}
        {!selectedUserId ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-400">
            利用者を選択してください
          </div>
        ) : loading ? (
          <div className="flex h-48 items-center justify-center"><Loader2 size={20} className="animate-spin text-gray-400" /></div>
        ) : (
          <>
            {/* 編集ビュー */}
            <div className="p-6 print:hidden">
              <EditVisitCarePlan content={content} update={update} />
            </div>

            {/* プレビュー区切り（画面のみ） */}
            <div className="print:hidden px-6 pb-2">
              <div className="max-w-5xl mx-auto flex items-center gap-3 border-t pt-6">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                  <ArrowDown size={16} className="text-emerald-600" />
                  印刷プレビュー
                </div>
                <span className="text-xs text-gray-400">
                  下のプレビューはA4印刷時のレイアウトです。編集内容は自動で反映されます。
                </span>
              </div>
            </div>

            {/* 印刷プレビュー（画面・印刷 共通表示） */}
            <div className="px-6 pb-10 print:p-0">
              <div className="max-w-5xl mx-auto bg-white shadow-md ring-1 ring-gray-200 print:shadow-none print:ring-0 print:max-w-none">
                <PrintVisitCarePlan content={content} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* 印刷時のCSS */}
      <style jsx global>{`
        @media print {
          @page { size: A4 portrait; margin: 12mm; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
    </div>
  );
}

// ─── 編集ビュー ─────────────────────────────────────────────────────────

function EditVisitCarePlan({ content, update }: {
  content: VisitCarePlanContent;
  update: <K extends keyof VisitCarePlanContent>(k: K, v: VisitCarePlanContent[K]) => void;
}) {
  const Input = ({ label, value, onChange, type = "text", textarea, rows = 2, className = "" }: {
    label: string; value: string; onChange: (v: string) => void;
    type?: string; textarea?: boolean; rows?: number; className?: string;
  }) => (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <label className="text-xs font-medium text-gray-500">{label}</label>
      {textarea ? (
        <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
      ) : (
        <input type={type} value={value} onChange={(e) => onChange(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
      )}
    </div>
  );

  const updateGoalArr = (key: "long_term_goals" | "short_term_goals", idx: number, field: "goal" | "period", v: string) => {
    const arr = [...content[key]];
    arr[idx] = { ...arr[idx], [field]: v };
    update(key, arr);
  };
  const addGoal = (key: "long_term_goals" | "short_term_goals") => update(key, [...content[key], { goal: "", period: "" }]);
  const removeGoal = (key: "long_term_goals" | "short_term_goals", idx: number) => {
    const arr = content[key].filter((_, i) => i !== idx);
    update(key, arr.length > 0 ? arr : [{ goal: "", period: "" }]);
  };

  const updateService = (idx: number, field: keyof WeeklyService, v: string) => {
    const arr = [...content.weekly_services];
    arr[idx] = { ...arr[idx], [field]: v };
    update("weekly_services", arr);
  };
  const addService = () => update("weekly_services", [...content.weekly_services, {
    day_of_week: "月", start_time: "09:00", end_time: "10:00", service_type: "身体介護", content: "", staff_note: "",
  }]);
  const removeService = (idx: number) => update("weekly_services", content.weekly_services.filter((_, i) => i !== idx));

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* ヘッダー情報 */}
      <Section title="計画書基本情報">
        <div className="grid grid-cols-4 gap-3">
          <Input label="計画作成日" type="date" value={content.creation_date} onChange={(v) => update("creation_date", v)} />
          <Input label="初回作成日" type="date" value={content.initial_creation_date} onChange={(v) => update("initial_creation_date", v)} />
          <Input label="事業所名" value={content.office_name} onChange={(v) => update("office_name", v)} />
          <Input label="サービス提供責任者" value={content.manager_name} onChange={(v) => update("manager_name", v)} />
          <Input label="計画作成者" value={content.creator_name} onChange={(v) => update("creator_name", v)} className="col-span-2" />
        </div>
      </Section>

      {/* 利用者情報 */}
      <Section title="利用者情報">
        <div className="grid grid-cols-4 gap-3">
          <Input label="氏名" value={content.user_name} onChange={(v) => update("user_name", v)} />
          <Input label="フリガナ" value={content.user_kana} onChange={(v) => update("user_kana", v)} />
          <Input label="性別" value={content.user_gender} onChange={(v) => update("user_gender", v)} />
          <Input label="生年月日" type="date" value={content.user_birth_date} onChange={(v) => update("user_birth_date", v)} />
          <Input label="年齢" value={content.user_age} onChange={(v) => update("user_age", v)} />
          <Input label="要介護度" value={content.care_level} onChange={(v) => update("care_level", v)} />
          <Input label="認定有効期間" value={content.cert_period} onChange={(v) => update("cert_period", v)} className="col-span-2" />
          <Input label="住所" value={content.user_address} onChange={(v) => update("user_address", v)} className="col-span-3" />
          <Input label="電話番号" value={content.user_phone} onChange={(v) => update("user_phone", v)} />
        </div>
      </Section>

      {/* 意向・基本方針 */}
      <Section title="本人・家族の意向と基本方針">
        <div className="grid grid-cols-2 gap-3">
          <Input label="本人の意向" value={content.user_intention} onChange={(v) => update("user_intention", v)} textarea rows={3} />
          <Input label="家族の意向" value={content.family_intention} onChange={(v) => update("family_intention", v)} textarea rows={3} />
        </div>
        <Input label="援助の基本方針" value={content.basic_policy} onChange={(v) => update("basic_policy", v)} textarea rows={3} className="mt-3" />
      </Section>

      {/* 援助目標 */}
      <Section title="援助目標">
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-gray-700">長期目標</h4>
              <button onClick={() => addGoal("long_term_goals")} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800">
                <Plus size={12} />追加
              </button>
            </div>
            {content.long_term_goals.map((g, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 mb-2">
                <Input label={`長期目標 ${i + 1}`} value={g.goal} onChange={(v) => updateGoalArr("long_term_goals", i, "goal", v)} textarea rows={2} />
                <Input label="期間" value={g.period} onChange={(v) => updateGoalArr("long_term_goals", i, "period", v)} />
                {content.long_term_goals.length > 1 && (
                  <button onClick={() => removeGoal("long_term_goals", i)} className="self-end mb-1 p-1 text-gray-400 hover:text-red-500"><X size={14} /></button>
                )}
              </div>
            ))}
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-gray-700">短期目標</h4>
              <button onClick={() => addGoal("short_term_goals")} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800">
                <Plus size={12} />追加
              </button>
            </div>
            {content.short_term_goals.map((g, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 mb-2">
                <Input label={`短期目標 ${i + 1}`} value={g.goal} onChange={(v) => updateGoalArr("short_term_goals", i, "goal", v)} textarea rows={2} />
                <Input label="期間" value={g.period} onChange={(v) => updateGoalArr("short_term_goals", i, "period", v)} />
                {content.short_term_goals.length > 1 && (
                  <button onClick={() => removeGoal("short_term_goals", i)} className="self-end mb-1 p-1 text-gray-400 hover:text-red-500"><X size={14} /></button>
                )}
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* 週間サービス */}
      <Section title="週間サービススケジュール">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Info size={12} />
            <span>曜日・時間・サービス種別・援助内容を入力。「ケアプランから取込」で提供表の内容を自動反映できます。</span>
          </div>
          <button onClick={addService} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800">
            <Plus size={12} />サービス追加
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 text-xs">
                <th className="border p-1 w-16">曜日</th>
                <th className="border p-1 w-20">開始</th>
                <th className="border p-1 w-20">終了</th>
                <th className="border p-1 w-28">種別</th>
                <th className="border p-1">援助内容</th>
                <th className="border p-1 w-28">担当/備考</th>
                <th className="border p-1 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {content.weekly_services.length === 0 ? (
                <tr><td colSpan={7} className="border p-4 text-center text-gray-400 text-xs">サービスが登録されていません。「サービス追加」または「ケアプランから取込」してください</td></tr>
              ) : content.weekly_services.map((s, i) => (
                <tr key={i}>
                  <td className="border p-0.5">
                    <select value={s.day_of_week} onChange={(e) => updateService(i, "day_of_week", e.target.value)}
                      className="w-full px-1 py-1 text-sm bg-white border-0 focus:ring-1 focus:ring-blue-500">
                      {WEEK_DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </td>
                  <td className="border p-0.5">
                    <input type="time" value={s.start_time} onChange={(e) => updateService(i, "start_time", e.target.value)}
                      className="w-full px-1 py-1 text-sm border-0 focus:ring-1 focus:ring-blue-500" />
                  </td>
                  <td className="border p-0.5">
                    <input type="time" value={s.end_time} onChange={(e) => updateService(i, "end_time", e.target.value)}
                      className="w-full px-1 py-1 text-sm border-0 focus:ring-1 focus:ring-blue-500" />
                  </td>
                  <td className="border p-0.5">
                    <select value={s.service_type} onChange={(e) => updateService(i, "service_type", e.target.value)}
                      className="w-full px-1 py-1 text-sm bg-white border-0 focus:ring-1 focus:ring-blue-500">
                      {SERVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td className="border p-0.5">
                    <input type="text" value={s.content} onChange={(e) => updateService(i, "content", e.target.value)}
                      className="w-full px-1 py-1 text-sm border-0 focus:ring-1 focus:ring-blue-500" />
                  </td>
                  <td className="border p-0.5">
                    <input type="text" value={s.staff_note} onChange={(e) => updateService(i, "staff_note", e.target.value)}
                      className="w-full px-1 py-1 text-sm border-0 focus:ring-1 focus:ring-blue-500" />
                  </td>
                  <td className="border p-0.5 text-center">
                    <button onClick={() => removeService(i)} className="p-1 text-gray-400 hover:text-red-500"><X size={12} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* 留意事項・緊急時対応 */}
      <Section title="留意事項・緊急時対応">
        <div className="grid grid-cols-2 gap-3">
          <Input label="留意事項" value={content.precautions} onChange={(v) => update("precautions", v)} textarea rows={4} />
          <Input label="緊急時の対応" value={content.emergency_response} onChange={(v) => update("emergency_response", v)} textarea rows={4} />
        </div>
      </Section>

      {/* 同意確認 */}
      <Section title="同意確認">
        <div className="grid grid-cols-4 gap-3">
          <Input label="同意日" type="date" value={content.consent_date} onChange={(v) => update("consent_date", v)} />
          <Input label="利用者署名" value={content.consent_user_name} onChange={(v) => update("consent_user_name", v)} />
          <Input label="代理人氏名" value={content.consent_proxy_name} onChange={(v) => update("consent_proxy_name", v)} />
          <Input label="続柄" value={content.consent_proxy_relation} onChange={(v) => update("consent_proxy_relation", v)} />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-white p-5 shadow-sm">
      <h3 className="text-sm font-bold text-gray-800 border-b pb-2 mb-3">{title}</h3>
      {children}
    </div>
  );
}

// ─── 印刷ビュー ───────────────────────────────────────────────────────────

function PrintVisitCarePlan({ content }: { content: VisitCarePlanContent }) {
  const fmtDate = (d: string) => {
    if (!d) return "";
    try { return format(parseISO(d), "yyyy年M月d日", { locale: ja }); } catch { return d; }
  };

  return (
    <div className="p-4 text-[11px] text-black bg-white print-area font-serif">
      <h1 className="text-center text-xl font-bold mb-4">訪問介護計画書</h1>

      {/* ヘッダー */}
      <div className="flex justify-between mb-3 text-[10px]">
        <div>
          作成年月日: <span className="font-semibold">{fmtDate(content.creation_date)}</span>
          {content.initial_creation_date && (
            <span className="ml-4">初回作成日: {fmtDate(content.initial_creation_date)}</span>
          )}
        </div>
        <div className="text-right">
          事業所: <span className="font-semibold">{content.office_name}</span><br />
          サービス提供責任者: <span className="font-semibold">{content.manager_name}</span>
        </div>
      </div>

      {/* 利用者情報 */}
      <table className="w-full border-collapse mb-3 text-[10px]">
        <tbody>
          <tr>
            <td className="border p-1 bg-gray-100 w-24 font-semibold">氏名</td>
            <td className="border p-1">{content.user_name}（{content.user_kana}）</td>
            <td className="border p-1 bg-gray-100 w-20 font-semibold">性別</td>
            <td className="border p-1 w-16">{content.user_gender}</td>
            <td className="border p-1 bg-gray-100 w-24 font-semibold">生年月日</td>
            <td className="border p-1">{fmtDate(content.user_birth_date)}（{content.user_age}歳）</td>
          </tr>
          <tr>
            <td className="border p-1 bg-gray-100 font-semibold">住所</td>
            <td colSpan={3} className="border p-1">{content.user_address}</td>
            <td className="border p-1 bg-gray-100 font-semibold">電話番号</td>
            <td className="border p-1">{content.user_phone}</td>
          </tr>
          <tr>
            <td className="border p-1 bg-gray-100 font-semibold">要介護度</td>
            <td className="border p-1">{content.care_level}</td>
            <td colSpan={2} className="border p-1 bg-gray-100 font-semibold">認定有効期間</td>
            <td colSpan={2} className="border p-1">{content.cert_period}</td>
          </tr>
        </tbody>
      </table>

      {/* 意向・基本方針 */}
      <table className="w-full border-collapse mb-3 text-[10px]">
        <tbody>
          <tr>
            <td className="border p-1 bg-gray-100 w-32 font-semibold">本人の意向</td>
            <td className="border p-1 whitespace-pre-wrap">{content.user_intention}</td>
          </tr>
          <tr>
            <td className="border p-1 bg-gray-100 font-semibold">家族の意向</td>
            <td className="border p-1 whitespace-pre-wrap">{content.family_intention}</td>
          </tr>
          <tr>
            <td className="border p-1 bg-gray-100 font-semibold">援助の基本方針</td>
            <td className="border p-1 whitespace-pre-wrap">{content.basic_policy}</td>
          </tr>
        </tbody>
      </table>

      {/* 援助目標 */}
      <div className="mb-3">
        <h3 className="text-xs font-semibold mb-1">援助目標</h3>
        <table className="w-full border-collapse text-[10px]">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-1 w-20"></th>
              <th className="border p-1">目標</th>
              <th className="border p-1 w-40">期間</th>
            </tr>
          </thead>
          <tbody>
            {content.long_term_goals.filter((g) => g.goal || g.period).map((g, i, arr) => (
              <tr key={`l${i}`}>
                {i === 0 && <td rowSpan={arr.length} className="border p-1 bg-gray-50 font-semibold text-center">長期目標</td>}
                <td className="border p-1">{g.goal}</td>
                <td className="border p-1">{g.period}</td>
              </tr>
            ))}
            {content.short_term_goals.filter((g) => g.goal || g.period).map((g, i, arr) => (
              <tr key={`s${i}`}>
                {i === 0 && <td rowSpan={arr.length} className="border p-1 bg-gray-50 font-semibold text-center">短期目標</td>}
                <td className="border p-1">{g.goal}</td>
                <td className="border p-1">{g.period}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 週間サービス */}
      <div className="mb-3">
        <h3 className="text-xs font-semibold mb-1">週間サービス計画</h3>
        <table className="w-full border-collapse text-[10px]">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-1 w-12">曜日</th>
              <th className="border p-1 w-24">時間</th>
              <th className="border p-1 w-24">サービス種別</th>
              <th className="border p-1">援助内容</th>
              <th className="border p-1 w-24">備考</th>
            </tr>
          </thead>
          <tbody>
            {content.weekly_services.length === 0 ? (
              <tr><td colSpan={5} className="border p-2 text-center text-gray-400">（該当なし）</td></tr>
            ) : content.weekly_services.map((s, i) => (
              <tr key={i}>
                <td className="border p-1 text-center">{s.day_of_week}</td>
                <td className="border p-1 text-center">{s.start_time}〜{s.end_time}</td>
                <td className="border p-1 text-center">{s.service_type}</td>
                <td className="border p-1">{s.content}</td>
                <td className="border p-1">{s.staff_note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 留意事項・緊急時対応 */}
      <table className="w-full border-collapse mb-3 text-[10px]">
        <tbody>
          <tr>
            <td className="border p-1 bg-gray-100 w-32 font-semibold">留意事項</td>
            <td className="border p-1 whitespace-pre-wrap">{content.precautions}</td>
          </tr>
          <tr>
            <td className="border p-1 bg-gray-100 font-semibold">緊急時の対応</td>
            <td className="border p-1 whitespace-pre-wrap">{content.emergency_response}</td>
          </tr>
        </tbody>
      </table>

      {/* 同意確認 */}
      <div className="mt-6 border-t pt-3">
        <h3 className="text-xs font-semibold mb-2">同意確認</h3>
        <p className="text-[10px] mb-3">上記の訪問介護計画書の内容について説明を受け、同意いたしました。</p>
        <table className="w-full border-collapse text-[10px]">
          <tbody>
            <tr>
              <td className="border p-2 bg-gray-100 w-24 font-semibold">同意日</td>
              <td className="border p-2 w-40">{fmtDate(content.consent_date)}</td>
              <td className="border p-2 bg-gray-100 w-24 font-semibold">利用者署名</td>
              <td className="border p-2">{content.consent_user_name}</td>
            </tr>
            <tr>
              <td className="border p-2 bg-gray-100 font-semibold">代理人氏名</td>
              <td className="border p-2">{content.consent_proxy_name}</td>
              <td className="border p-2 bg-gray-100 font-semibold">続柄</td>
              <td className="border p-2">{content.consent_proxy_relation}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="text-right text-[10px] mt-2 text-gray-500">
        作成者: {content.creator_name}
      </div>
    </div>
  );
}
