"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Plus,
  X,
  Save,
  Loader2,
  ClipboardList,
  Clock,
  User,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  CalendarClock,
  CheckCircle2,
  AlertTriangle,
  PenLine,
  Printer,
  Send,
} from "lucide-react";
import { format, parseISO, addMonths } from "date-fns";
import { TemplatePicker } from "@/components/templates/template-picker";
import { SignaturePadModal } from "@/components/signature/SignaturePadModal";
import { SignaturePad } from "@/components/signature-pad";
import { resolvePreferredTenantId } from "@/lib/tenant-resolver";
import { SendDocumentModal } from "@/components/shared/SendDocumentModal";
import { VoiceInputButton } from "@/components/shared/VoiceInputButton";
import { useBusinessType } from "@/lib/business-type-context";
import { useSignedUrls } from "@/lib/use-signed-url";
import { resolveVisitAddonLines } from "@/lib/visit-addons";
import { ja } from "date-fns/locale";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KaigoStaff {
  id: string;
  name: string;
}

type ServiceType = "身体介護" | "生活援助" | "身体・生活" | "通院等乗降介助";

interface VisitRecord {
  id: string;
  user_id: string;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  service_type: ServiceType;
  // Phase Shougai-1: 請求区分 (kaigo=介護保険 / shougai=障害福祉)
  // migration 未適用環境では undefined になりうるため optional
  service_category?: "kaigo" | "shougai" | null;
  staff_id: string | null;
  staff_name?: string | null;
  // 記録の状態 (draft / confirmed / submitted)。draft は月次実績送信の対象外
  status?: string | null;
  // 予定 (kaigo_visit_schedule) との正式紐付け。
  // migration 未適用環境では undefined になりうるため optional 扱いで参照する。
  schedule_id?: string | null;
  // body care
  care_excretion: boolean;
  care_meal: boolean;
  care_bath: boolean;
  care_wipe: boolean;
  care_positioning: boolean;
  care_transfer: boolean;
  care_dressing: boolean;
  care_oral: boolean;
  care_medication: boolean;
  // living support
  support_cooking: boolean;
  support_laundry: boolean;
  support_cleaning: boolean;
  support_shopping: boolean;
  support_trash: boolean;
  support_clothing: boolean;
  // vitals
  temperature: number | null;
  bp_sys: number | null;
  bp_dia: number | null;
  pulse: number | null;
  // notes
  user_condition: string | null;
  notes: string | null;
  created_at: string;
  // 電子署名
  // v2: signature_image_path を主に保存。表示時に useSignedUrls で動的発行する。
  // signature_image_url は v1 互換用 deprecated 列 (path 未 backfill record の fallback)。
  signature_image_path: string | null;
  signature_image_url: string | null;
  signed_at: string | null;
  signer_name: string | null;
}

// 新形式: care_record_data JSONB にすべて格納
interface CareData {
  pre_check: { complexion: string; condition: string; room_temp: string; humidity: string; notes: string };
  vitals: { temperature: string; bp_sys: string; bp_dia: string; pulse: string; spo2: string; respiration: string; blood_sugar: string; weight: string; notes: string };
  excretion: { done: boolean; urine: boolean; stool: boolean; urine_amount: string; stool_amount: string; stool_type: string; independence: string; device: string; notes: string };
  hydration: { done: boolean; drink_type: string; amount: string; thickener: string; notes: string };
  meal: { done: boolean; staple_amount: string; side_amount: string; meal_form: string; independence: string; notes: string };
  oral_care: { done: boolean; denture: string; brushing: boolean; gargling: boolean; denture_cleaning: boolean; mouth_wipe: boolean; notes: string };
  bathing: { done: boolean; bath_type: string; independence: string; skin_condition: string; notes: string };
  grooming: { done: boolean; face_wash: boolean; hair: boolean; nail: boolean; ear: boolean; shaving: boolean; notes: string };
  dressing: { done: boolean; upper: boolean; lower: boolean; independence: string; notes: string };
  positioning: { done: boolean; position_type: string; mobility_device: string; notes: string };
  medication: { done: boolean; med_type: string; confirmed: boolean; notes: string };
  outing: { done: boolean; outing_type: string; transport: string; notes: string };
  wake_sleep: { done: boolean; wake_up: boolean; go_to_bed: boolean; bed_making: boolean; notes: string };
  medical_care: { done: boolean; suction: boolean; tube_feeding: boolean; stoma: boolean; catheter: boolean; wound_care: boolean; oxygen: boolean; notes: string };
  independence_support: { done: boolean; exercise: boolean; cognitive: boolean; communication: boolean; social: boolean; notes: string };
  living_support: { cooking: boolean; cooking_notes: string; cleaning: boolean; cleaning_notes: string; laundry: boolean; laundry_notes: string; shopping: boolean; shopping_notes: string; trash: boolean; clothing: boolean; medication_mgmt: boolean; health_mgmt: boolean; other_notes: string };
  exit_check: { fire_check: boolean; lock_check: boolean; appliance_check: boolean; user_condition: string; notes: string };
  progress_notes: string;
  handover: { priority: string; notes: string };
  detailed_report: string;
  user_condition: string;
  notes: string;
}

const emptyCareData = (): CareData => ({
  pre_check: { complexion: "", condition: "", room_temp: "", humidity: "", notes: "" },
  vitals: { temperature: "", bp_sys: "", bp_dia: "", pulse: "", spo2: "", respiration: "", blood_sugar: "", weight: "", notes: "" },
  excretion: { done: false, urine: false, stool: false, urine_amount: "", stool_amount: "", stool_type: "", independence: "", device: "", notes: "" },
  hydration: { done: false, drink_type: "", amount: "", thickener: "", notes: "" },
  meal: { done: false, staple_amount: "", side_amount: "", meal_form: "", independence: "", notes: "" },
  oral_care: { done: false, denture: "", brushing: false, gargling: false, denture_cleaning: false, mouth_wipe: false, notes: "" },
  bathing: { done: false, bath_type: "", independence: "", skin_condition: "", notes: "" },
  grooming: { done: false, face_wash: false, hair: false, nail: false, ear: false, shaving: false, notes: "" },
  dressing: { done: false, upper: false, lower: false, independence: "", notes: "" },
  positioning: { done: false, position_type: "", mobility_device: "", notes: "" },
  medication: { done: false, med_type: "", confirmed: false, notes: "" },
  outing: { done: false, outing_type: "", transport: "", notes: "" },
  wake_sleep: { done: false, wake_up: false, go_to_bed: false, bed_making: false, notes: "" },
  medical_care: { done: false, suction: false, tube_feeding: false, stoma: false, catheter: false, wound_care: false, oxygen: false, notes: "" },
  independence_support: { done: false, exercise: false, cognitive: false, communication: false, social: false, notes: "" },
  living_support: { cooking: false, cooking_notes: "", cleaning: false, cleaning_notes: "", laundry: false, laundry_notes: "", shopping: false, shopping_notes: "", trash: false, clothing: false, medication_mgmt: false, health_mgmt: false, other_notes: "" },
  exit_check: { fire_check: false, lock_check: false, appliance_check: false, user_condition: "", notes: "" },
  progress_notes: "",
  handover: { priority: "通常", notes: "" },
  detailed_report: "",
  user_condition: "",
  notes: "",
});

// Legacy FormData (kept for type compat)
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
type FormData = Record<string, unknown>;

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVICE_TYPES: ServiceType[] = [
  "身体介護",
  "生活援助",
  "身体・生活",
  "通院等乗降介助",
];

const SERVICE_TYPE_COLORS: Record<ServiceType, { bg: string; text: string; border: string }> = {
  身体介護: { bg: "bg-blue-100", text: "text-blue-700", border: "border-blue-200" },
  生活援助: { bg: "bg-green-100", text: "text-green-700", border: "border-green-200" },
  "身体・生活": { bg: "bg-purple-100", text: "text-purple-700", border: "border-purple-200" },
  通院等乗降介助: { bg: "bg-orange-100", text: "text-orange-700", border: "border-orange-200" },
};

// (旧 BODY_CARE_ITEMS / LIVING_SUPPORT_ITEMS / EMPTY_FORM は削除済み — 新形式 CareData を使用)

const inputClass =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

// 訪問予定 (kaigo_visit_schedule) — 本画面では読取専用 (書込は shift-management 側の管轄)
interface VisitSchedule {
  id: string;
  user_id: string;
  staff_id: string | null;
  staff_id_2: string | null;
  staff_id_3: string | null;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  service_type: string | null; // shift 側の自由書式 (例: "身体日１．０", "家事日１．０")
  status: "scheduled" | "completed" | "cancelled";
  // スマホ打刻 (/m/visit-records)。migrations/visit_clock.sql 未適用環境では
  // 列が無い → fetch 側で 42703 を検知して列なし SELECT に fallback するため optional。
  // ここでは参考表示のみ (編集経路なし)。
  clock_in_at?: string | null;
  clock_out_at?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// "10:00:00" → "10:00" (time input / 比較用)
function hhmm(t: string | null | undefined): string {
  return t ? t.slice(0, 5) : "";
}

// 打刻 TIMESTAMPTZ → "HH:mm" (ローカル時刻)。parse 不能はそのまま返す。
function fmtClockHm(iso: string): string {
  try {
    return format(new Date(iso), "HH:mm");
  } catch {
    return iso;
  }
}

// 予定の service_type (shift 側の自由書式) を記録の ServiceType 4 区分へベストエフォート変換
function mapScheduleServiceType(s: string | null): ServiceType {
  const t = s ?? "";
  if (t.includes("乗降") || t.includes("通院")) return "通院等乗降介助";
  const body = t.includes("身体") || t.includes("身");
  const life = t.includes("生活") || t.includes("家事");
  if (body && life) return "身体・生活";
  if (life) return "生活援助";
  return "身体介護";
}

// PostgREST の「列が存在しない」エラーから列名を抽出 (migration 未適用環境の fallback 用)
// - PGRST204: Could not find the 'xxx' column of '...' in the schema cache
// - 42703:    column kaigo_visit_records.xxx does not exist
function extractMissingColumn(message: string): string | null {
  const m =
    message.match(/Could not find the '([^']+)' column/) ??
    message.match(/column\s+(?:[\w"]+\.)?"?(\w+)"?\s+does not exist/);
  return m ? m[1] : null;
}

function formatVisitDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "yyyy年M月d日(E)", { locale: ja });
  } catch {
    return dateStr;
  }
}

function formatTimeRange(start: string | null, end: string | null): string {
  if (!start && !end) return "時間未記録";
  if (start && end) return `${start} 〜 ${end}`;
  if (start) return `${start} 〜`;
  return `〜 ${end}`;
}

function calcDuration(start: string | null, end: string | null): string {
  if (!start || !end) return "";
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}時間${m > 0 ? m + "分" : ""}` : `${m}分`;
}

function getActiveCareItems(record: VisitRecord): string[] {
  // New format: care_record_data JSONB
  const crd = (record as any).care_record_data;  // eslint-disable-line @typescript-eslint/no-explicit-any
  if (crd && typeof crd === "object") {
    const items: string[] = [];
    if (crd.pre_check?.complexion || crd.pre_check?.condition) items.push("事前チェック");
    if (crd.vitals?.temperature || crd.vitals?.bp_sys || crd.vitals?.pulse || crd.vitals?.spo2) items.push("バイタル");
    if (crd.excretion?.done) items.push("排泄介助");
    if (crd.hydration?.done) items.push("水分摂取");
    if (crd.meal?.done) items.push("食事介助");
    if (crd.oral_care?.done) items.push("口腔ケア");
    if (crd.bathing?.done) items.push("清拭・入浴");
    if (crd.grooming?.done) items.push("身体整容");
    if (crd.dressing?.done) items.push("更衣介助");
    if (crd.positioning?.done) items.push("体位・移動");
    if (crd.medication?.done) items.push("服薬介助");
    if (crd.outing?.done) items.push("通院・外出");
    if (crd.wake_sleep?.done) items.push("起床・就寝");
    if (crd.medical_care?.done) items.push("医療的ケア");
    if (crd.independence_support?.done) items.push("自立支援");
    const ls = crd.living_support;
    if (ls?.cooking || ls?.cleaning || ls?.laundry || ls?.shopping || ls?.trash) items.push("生活援助");
    if (crd.exit_check?.fire_check || crd.exit_check?.lock_check) items.push("退出確認");
    if (crd.progress_notes) items.push("経過記録");
    if (crd.handover?.notes) items.push("申し送り");
    if (crd.detailed_report) items.push("詳細報告");
    if (crd.photos?.length > 0) items.push("写真");
    if (items.length > 0) return items;
  }
  // Legacy fallback
  const items: string[] = [];
  if (record.care_excretion) items.push("排泄介助");
  if (record.care_meal) items.push("食事介助");
  if (record.care_bath) items.push("入浴介助");
  if (record.care_wipe) items.push("清拭");
  if (record.care_positioning) items.push("体位変換");
  if (record.care_transfer) items.push("移動介助");
  if (record.care_dressing) items.push("更衣介助");
  if (record.care_oral) items.push("口腔ケア");
  if (record.care_medication) items.push("服薬介助");
  if (record.support_cooking) items.push("調理");
  if (record.support_laundry) items.push("洗濯");
  if (record.support_cleaning) items.push("掃除");
  if (record.support_shopping) items.push("買物");
  if (record.support_trash) items.push("ゴミ出し");
  if (record.support_clothing) items.push("衣類の整理");
  return items;
}

// ─── 月次実績送付用 payload builder ─────────────────────────────────────────
// shared_documents.payload に保存される統一 schema (受信側 = 居宅介護支援が取込時に使用)
interface MonthlyServiceRecordItem {
  date: string;             // YYYY-MM-DD
  start_time: string | null;  // HH:MM
  end_time: string | null;    // HH:MM
  service_category: string; // service_type (身体介護 / 生活援助 / ...)
  service_content: string;  // care 項目を ", " で連結 (空なら notes)
  provider_name: string;    // staff_name
  duration_minutes: number | null;
}
/** 月次加算 (kaigo_visit_month_addons + kaigo_visit_addon_lines 由来) の送付行 */
interface MonthlyAddonItem {
  name: string;   // 初回加算 / 緊急時訪問介護加算 / 生活機能向上連携加算Ⅰ・Ⅱ
  count: number;  // 当月回数
}
interface MonthlyServiceRecordPayload {
  service_type: "訪問介護";
  year_month: string;        // YYYY-MM
  client_id: string;
  client_name: string;
  records: MonthlyServiceRecordItem[];
  /** 月次加算行 (受信側は任意参照。無い場合は加算なし) */
  addons?: MonthlyAddonItem[];
}
function diffMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const [sh, sm] = start.split(":").map((v) => Number(v));
  const [eh, em] = end.split(":").map((v) => Number(v));
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  return mins > 0 ? mins : null;
}
function buildMonthlyServiceRecordPayload({
  yearMonth,
  clientId,
  clientName,
  records,
  addons,
}: {
  yearMonth: string;
  clientId: string;
  clientName: string;
  records: VisitRecord[];
  addons?: MonthlyAddonItem[];
}): MonthlyServiceRecordPayload {
  return {
    service_type: "訪問介護",
    year_month: yearMonth,
    client_id: clientId,
    client_name: clientName,
    ...(addons && addons.length > 0 ? { addons } : {}),
    records: records.map<MonthlyServiceRecordItem>((r) => {
      const items = getActiveCareItems(r);
      // service_content: care 項目連結 → 空なら notes / progress_notes / detailed_report fallback
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed (DB row 直)
      const rr = r as any;
      const content =
        items.length > 0
          ? items.join("、")
          : (r.notes ?? rr.progress_notes ?? rr.detailed_report ?? "") || "";
      return {
        date: r.visit_date,
        start_time: r.start_time,
        end_time: r.end_time,
        service_category: r.service_type,
        service_content: content,
        provider_name: r.staff_name ?? "",
        duration_minutes: diffMinutes(r.start_time, r.end_time),
      };
    }),
  };
}

// VisitRecordsPage の form 内で使う入力 helper (module scope に hoist)
// TemplatePicker import は既に top にあり、closure 依存なし
function FSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">選択してください</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}
function FInput({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputClass} />
    </div>
  );
}
function FTextarea({ label, value, onChange, placeholder, rows = 2 }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  // 音声入力 (VoiceInputButton) がカーソル位置を読むための ref
  const taRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div>
      <div className="flex items-center justify-between mb-1 gap-2">
        <label className="block text-xs font-medium text-gray-700">{label}</label>
        <div className="flex items-center gap-1.5">
          <VoiceInputButton targetRef={taRef} value={value} onChange={onChange} />
          <TemplatePicker category="visit_record" currentText={value} onInsert={onChange} />
        </div>
      </div>
      <textarea ref={taRef} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputClass} />
    </div>
  );
}
function FCheck({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${checked ? "border-blue-400 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
      <input type="checkbox" checked={checked} onChange={() => onChange(!checked)} className="accent-blue-600" />
      {label}
    </label>
  );
}
function FSectionBtn({ id, label, openId, setOpenId }: { id: string; label: string; openId: string | null; setOpenId: (id: string | null) => void }) {
  const isOpen = openId === id;
  return (
    <button onClick={() => setOpenId(isOpen ? null : id)} className="flex items-center justify-between w-full px-3 py-2.5 bg-gray-100 rounded-lg text-sm font-bold text-gray-700 hover:bg-gray-200 transition-colors">
      {label}
      <ChevronDown size={14} className={`text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`} />
    </button>
  );
}

// CareRecordDetail で使う presentational helpers (module scope に hoist して
// react-hooks/static-components rule を満たす。closure 依存なしの純粋 component)
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p className="mb-1.5 text-xs font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded">{title}</p>
      <div className="pl-2 text-sm text-gray-700 space-y-0.5">{children}</div>
    </div>
  );
}
function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (!value && value !== 0) return null;
  return <div className="flex gap-2"><span className="text-gray-500 shrink-0 w-20">{label}</span><span className="font-medium">{value}</span></div>;
}
function Tags({ items }: { items: { label: string; active: boolean }[] }) {
  const active = items.filter((i) => i.active);
  if (active.length === 0) return null;
  return <div className="flex flex-wrap gap-1">{active.map((i) => <span key={i.label} className="rounded bg-blue-50 text-blue-700 px-2 py-0.5 text-xs font-medium">{i.label}</span>)}</div>;
}

// 22カテゴリ展開表示コンポーネント
function CareRecordDetail({ record }: { record: VisitRecord }) {
  const r = record as any;  // eslint-disable-line @typescript-eslint/no-explicit-any
  const crd = r.care_record_data;

  // care_record_dataが空or未使用 → レガシー個別列 + バイタル列で表示
  const hasNewData = crd && typeof crd === "object" && Object.keys(crd).some((k) => {
    const v = crd[k];
    if (v === null || v === undefined || v === "" || v === false) return false;
    if (typeof v === "object" && !Array.isArray(v)) return Object.values(v).some((sv) => sv !== null && sv !== undefined && sv !== "" && sv !== false);
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });

  if (!hasNewData) {
    // Legacy + バイタル個別列で表示
    const temp = r.vital_temperature ?? r.temperature;
    const bpSys = r.vital_bp_sys ?? r.bp_sys;
    const bpDia = r.vital_bp_dia ?? r.bp_dia;
    const pulse = r.vital_pulse ?? r.pulse;
    const spo2 = r.vital_spo2;
    const resp = r.vital_respiration;
    const bs = r.vital_blood_sugar;
    const uc = r.user_condition;
    const notes = r.notes;
    const ho = r.handover_notes;
    const pn = r.progress_notes;

    const hasVitals = temp || bpSys || pulse || spo2 || resp || bs;
    const hasAnything = hasVitals || uc || notes || ho || pn || r.care_excretion || r.care_meal || r.care_bath;

    if (!hasAnything) {
      return <p className="text-sm text-gray-400">記録内容がありません</p>;
    }

    return (
      <div className="space-y-3">
        {hasVitals && (
          <div>
            <p className="mb-1.5 text-xs font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded">バイタルサイン</p>
            <div className="flex flex-wrap gap-4 text-sm text-gray-700 pl-2">
              {temp && <span>体温: <strong>{temp}℃</strong></span>}
              {bpSys && bpDia && <span>血圧: <strong>{bpSys}/{bpDia} mmHg</strong></span>}
              {pulse && <span>脈拍: <strong>{pulse} bpm</strong></span>}
              {spo2 && <span>SpO2: <strong>{spo2}%</strong></span>}
              {resp && <span>呼吸: <strong>{resp} 回/分</strong></span>}
              {bs && <span>血糖: <strong>{bs} mg/dL</strong></span>}
            </div>
          </div>
        )}
        {uc && (
          <div><p className="mb-1 text-xs font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded">利用者の状態</p><p className="text-sm text-gray-700 whitespace-pre-wrap pl-2">{uc}</p></div>
        )}
        {ho && (
          <div><p className="mb-1 text-xs font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded">申し送り</p><p className="text-sm text-gray-700 whitespace-pre-wrap pl-2">{ho}</p></div>
        )}
        {pn && (
          <div><p className="mb-1 text-xs font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded">経過記録</p><p className="text-sm text-gray-700 whitespace-pre-wrap pl-2">{pn}</p></div>
        )}
        {notes && (
          <div><p className="mb-1 text-xs font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded">特記事項</p><p className="text-sm text-gray-700 whitespace-pre-wrap pl-2">{notes}</p></div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* サービス内容 */}
      {r.service_type && (
        <Section title="サービス内容">
          <div className="flex items-center gap-2">
            <span className="font-medium">{r.service_type}</span>
          </div>
        </Section>
      )}
      {/* 事前チェック */}
      {(crd.pre_check?.complexion || crd.pre_check?.condition) && (
        <Section title="事前チェック">
          <Row label="顔色" value={crd.pre_check.complexion} />
          <Row label="体調" value={crd.pre_check.condition} />
          <Row label="室温" value={crd.pre_check.room_temp && `${crd.pre_check.room_temp}℃`} />
          <Row label="湿度" value={crd.pre_check.humidity && `${crd.pre_check.humidity}%`} />
          {crd.pre_check.notes && <p className="text-xs text-gray-500 mt-1">{crd.pre_check.notes}</p>}
        </Section>
      )}
      {/* バイタル */}
      {(crd.vitals?.temperature || crd.vitals?.bp_sys || crd.vitals?.pulse || crd.vitals?.spo2) && (
        <Section title="バイタルサイン・身体測定">
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <Row label="体温" value={crd.vitals.temperature && `${crd.vitals.temperature}℃`} />
            <Row label="SpO2" value={crd.vitals.spo2 && `${crd.vitals.spo2}%`} />
            <Row label="血圧" value={crd.vitals.bp_sys && `${crd.vitals.bp_sys}/${crd.vitals.bp_dia} mmHg`} />
            <Row label="脈拍" value={crd.vitals.pulse && `${crd.vitals.pulse} bpm`} />
            <Row label="呼吸数" value={crd.vitals.respiration && `${crd.vitals.respiration} 回/分`} />
            <Row label="血糖値" value={crd.vitals.blood_sugar && `${crd.vitals.blood_sugar} mg/dL`} />
            <Row label="体重" value={crd.vitals.weight && `${crd.vitals.weight} kg`} />
          </div>
          {crd.vitals.notes && <p className="text-xs text-gray-500 mt-1">{crd.vitals.notes}</p>}
        </Section>
      )}
      {/* 排泄 */}
      {crd.excretion?.done && (
        <Section title="排泄介助">
          <Tags items={[{ label: "尿", active: crd.excretion.urine }, { label: "便", active: crd.excretion.stool }]} />
          <Row label="尿量" value={crd.excretion.urine_amount} />
          <Row label="便量" value={crd.excretion.stool_amount} />
          <Row label="便性状" value={crd.excretion.stool_type} />
          <Row label="自立度" value={crd.excretion.independence} />
          <Row label="使用器具" value={crd.excretion.device} />
          {crd.excretion.notes && <p className="text-xs text-gray-500 mt-1">{crd.excretion.notes}</p>}
        </Section>
      )}
      {/* 水分 */}
      {crd.hydration?.done && (
        <Section title="水分摂取">
          <Row label="飲み物" value={crd.hydration.drink_type} />
          <Row label="量" value={crd.hydration.amount && `${crd.hydration.amount} ml`} />
          <Row label="とろみ" value={crd.hydration.thickener} />
          {crd.hydration.notes && <p className="text-xs text-gray-500 mt-1">{crd.hydration.notes}</p>}
        </Section>
      )}
      {/* 食事 */}
      {crd.meal?.done && (
        <Section title="食事介助">
          <Row label="主食" value={crd.meal.staple_amount} />
          <Row label="副食" value={crd.meal.side_amount} />
          <Row label="食事形態" value={crd.meal.meal_form} />
          <Row label="自立度" value={crd.meal.independence} />
          {crd.meal.notes && <p className="text-xs text-gray-500 mt-1">{crd.meal.notes}</p>}
        </Section>
      )}
      {/* 口腔ケア */}
      {crd.oral_care?.done && (
        <Section title="口腔ケア">
          <Row label="義歯" value={crd.oral_care.denture} />
          <Tags items={[{ label: "歯磨き", active: crd.oral_care.brushing }, { label: "うがい", active: crd.oral_care.gargling }, { label: "義歯洗浄", active: crd.oral_care.denture_cleaning }, { label: "口腔清拭", active: crd.oral_care.mouth_wipe }]} />
          {crd.oral_care.notes && <p className="text-xs text-gray-500 mt-1">{crd.oral_care.notes}</p>}
        </Section>
      )}
      {/* 清拭・入浴 */}
      {crd.bathing?.done && (
        <Section title="清拭・入浴">
          <Row label="種類" value={crd.bathing.bath_type} />
          <Row label="自立度" value={crd.bathing.independence} />
          <Row label="皮膚状態" value={crd.bathing.skin_condition} />
          {crd.bathing.notes && <p className="text-xs text-gray-500 mt-1">{crd.bathing.notes}</p>}
        </Section>
      )}
      {/* 身体整容 */}
      {crd.grooming?.done && (
        <Section title="身体整容">
          <Tags items={[{ label: "洗顔", active: crd.grooming.face_wash }, { label: "整髪", active: crd.grooming.hair }, { label: "爪切り", active: crd.grooming.nail }, { label: "耳掃除", active: crd.grooming.ear }, { label: "髭剃り", active: crd.grooming.shaving }]} />
          {crd.grooming.notes && <p className="text-xs text-gray-500 mt-1">{crd.grooming.notes}</p>}
        </Section>
      )}
      {/* 更衣 */}
      {crd.dressing?.done && (
        <Section title="更衣介助">
          <Tags items={[{ label: "上衣", active: crd.dressing.upper }, { label: "下衣", active: crd.dressing.lower }]} />
          <Row label="自立度" value={crd.dressing.independence} />
          {crd.dressing.notes && <p className="text-xs text-gray-500 mt-1">{crd.dressing.notes}</p>}
        </Section>
      )}
      {/* 体位・移動 */}
      {crd.positioning?.done && (
        <Section title="体位変換・移動">
          <Row label="体位" value={crd.positioning.position_type} />
          <Row label="移動手段" value={crd.positioning.mobility_device} />
          {crd.positioning.notes && <p className="text-xs text-gray-500 mt-1">{crd.positioning.notes}</p>}
        </Section>
      )}
      {/* 服薬 */}
      {crd.medication?.done && (
        <Section title="服薬介助">
          <Row label="投与方法" value={crd.medication.med_type} />
          {crd.medication.confirmed && <span className="text-xs text-green-600 font-medium">✓ 服薬確認済み</span>}
          {crd.medication.notes && <p className="text-xs text-gray-500 mt-1">{crd.medication.notes}</p>}
        </Section>
      )}
      {/* 通院・外出 */}
      {crd.outing?.done && (
        <Section title="通院・外出介助">
          <Row label="種類" value={crd.outing.outing_type} />
          <Row label="移動手段" value={crd.outing.transport} />
          {crd.outing.notes && <p className="text-xs text-gray-500 mt-1">{crd.outing.notes}</p>}
        </Section>
      )}
      {/* 起床・就寝 */}
      {crd.wake_sleep?.done && (
        <Section title="起床・就寝介助">
          <Tags items={[{ label: "起床介助", active: crd.wake_sleep.wake_up }, { label: "就寝介助", active: crd.wake_sleep.go_to_bed }, { label: "ベッドメイキング", active: crd.wake_sleep.bed_making }]} />
          {crd.wake_sleep.notes && <p className="text-xs text-gray-500 mt-1">{crd.wake_sleep.notes}</p>}
        </Section>
      )}
      {/* 医療的ケア */}
      {crd.medical_care?.done && (
        <Section title="医療的ケア">
          <Tags items={[{ label: "吸引", active: crd.medical_care.suction }, { label: "経管栄養", active: crd.medical_care.tube_feeding }, { label: "ストーマ", active: crd.medical_care.stoma }, { label: "カテーテル", active: crd.medical_care.catheter }, { label: "創傷処置", active: crd.medical_care.wound_care }, { label: "酸素管理", active: crd.medical_care.oxygen }]} />
          {crd.medical_care.notes && <p className="text-xs text-gray-500 mt-1">{crd.medical_care.notes}</p>}
        </Section>
      )}
      {/* 自立支援 */}
      {crd.independence_support?.done && (
        <Section title="自立支援">
          <Tags items={[{ label: "運動・リハビリ", active: crd.independence_support.exercise }, { label: "認知機能訓練", active: crd.independence_support.cognitive }, { label: "コミュニケーション", active: crd.independence_support.communication }, { label: "社会参加", active: crd.independence_support.social }]} />
          {crd.independence_support.notes && <p className="text-xs text-gray-500 mt-1">{crd.independence_support.notes}</p>}
        </Section>
      )}
      {/* 生活援助 */}
      {(crd.living_support?.cooking || crd.living_support?.cleaning || crd.living_support?.laundry || crd.living_support?.shopping || crd.living_support?.trash) && (
        <Section title="生活援助">
          <Tags items={[{ label: "調理", active: crd.living_support.cooking }, { label: "掃除", active: crd.living_support.cleaning }, { label: "洗濯", active: crd.living_support.laundry }, { label: "買物", active: crd.living_support.shopping }, { label: "ゴミ出し", active: crd.living_support.trash }, { label: "衣類整理", active: crd.living_support.clothing }, { label: "服薬管理", active: crd.living_support.medication_mgmt }, { label: "健康管理", active: crd.living_support.health_mgmt }]} />
          {crd.living_support.cooking_notes && <p className="text-xs text-gray-500">調理: {crd.living_support.cooking_notes}</p>}
          {crd.living_support.cleaning_notes && <p className="text-xs text-gray-500">掃除: {crd.living_support.cleaning_notes}</p>}
          {crd.living_support.laundry_notes && <p className="text-xs text-gray-500">洗濯: {crd.living_support.laundry_notes}</p>}
          {crd.living_support.shopping_notes && <p className="text-xs text-gray-500">買物: {crd.living_support.shopping_notes}</p>}
          {crd.living_support.other_notes && <p className="text-xs text-gray-500">その他: {crd.living_support.other_notes}</p>}
        </Section>
      )}
      {/* 退出確認 */}
      {(crd.exit_check?.fire_check || crd.exit_check?.lock_check || crd.exit_check?.appliance_check) && (
        <Section title="退出確認">
          <Tags items={[{ label: "火の元確認", active: crd.exit_check.fire_check }, { label: "施錠確認", active: crd.exit_check.lock_check }, { label: "電化製品確認", active: crd.exit_check.appliance_check }]} />
          {crd.exit_check.user_condition && <p className="text-xs text-gray-500">退出時の状態: {crd.exit_check.user_condition}</p>}
          {crd.exit_check.notes && <p className="text-xs text-gray-500">{crd.exit_check.notes}</p>}
        </Section>
      )}
      {/* 経過記録 */}
      {crd.progress_notes && (
        <Section title="経過記録"><p className="whitespace-pre-wrap">{crd.progress_notes}</p></Section>
      )}
      {/* 申し送り */}
      {crd.handover?.notes && (
        <Section title="申し送り">
          {crd.handover.priority === "重要" && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded font-medium">重要</span>}
          <p className="whitespace-pre-wrap mt-1">{crd.handover.notes}</p>
        </Section>
      )}
      {/* 詳細報告 */}
      {crd.detailed_report && (
        <Section title="詳細報告"><p className="whitespace-pre-wrap">{crd.detailed_report}</p></Section>
      )}
      {/* 利用者の状態・特記 */}
      {crd.user_condition && (
        <Section title="利用者の状態"><p className="whitespace-pre-wrap">{crd.user_condition}</p></Section>
      )}
      {crd.notes && (
        <Section title="特記事項"><p className="whitespace-pre-wrap">{crd.notes}</p></Section>
      )}
      {/* 写真 */}
      {crd.photos?.length > 0 && (
        <Section title="写真">
          <div className="grid grid-cols-4 gap-2">
            {crd.photos.map((p: string, i: number) => (
              <div key={i} className="aspect-square rounded-lg overflow-hidden border">
                {/* eslint-disable-next-line @next/next/no-img-element -- 介護記録の写真表示、Next.js Image は外部 URL でも適合するが現在は単純な img で運用 */}
                <img src={p} alt="" className="w-full h-full object-cover" />
              </div>
            ))}
          </div>
        </Section>
      )}
      {/* 入退室記録 */}
      {(crd.entry || crd.exit) && (
        <Section title="入退室記録">
          {crd.entry && (
            <div className="flex items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-xs font-bold border border-emerald-200">入室</span>
              <span className="tabular-nums">{(() => { try { return format(new Date(crd.entry.time), "HH:mm"); } catch { return crd.entry.time; } })()}</span>
              {crd.entry.lat && (
                <a href={`https://maps.google.com/?q=${crd.entry.lat},${crd.entry.lng}`} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline text-xs flex items-center gap-0.5">
                  <span>📍地図</span>
                  <span className="text-gray-400">(±{crd.entry.accuracy}m)</span>
                </a>
              )}
            </div>
          )}
          {crd.exit && (
            <div className="flex items-center gap-2 text-sm mt-1">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-orange-50 text-orange-700 text-xs font-bold border border-orange-200">退室</span>
              <span className="tabular-nums">{(() => { try { return format(new Date(crd.exit.time), "HH:mm"); } catch { return crd.exit.time; } })()}</span>
              {crd.exit.lat && (
                <a href={`https://maps.google.com/?q=${crd.exit.lat},${crd.exit.lng}`} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline text-xs flex items-center gap-0.5">
                  <span>📍地図</span>
                  <span className="text-gray-400">(±{crd.exit.accuracy}m)</span>
                </a>
              )}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

// ─── 記録カード (展開式) ─────────────────────────────────────────────────────
// 予定行の中 (embedded) と「予定外の記録」リストの両方で使う共通カード。
// module scope に置いて react-hooks/static-components rule を満たす。
function RecordCard({
  rec,
  isExpanded,
  onToggle,
  onSign,
  signatureSrc,
  embedded,
}: {
  rec: VisitRecord;
  isExpanded: boolean;
  onToggle: () => void;
  onSign: () => void;
  /** 解決済みの署名画像 src (path → signed URL / v1 URL fallback)。null = 読み込み中 */
  signatureSrc: string | null;
  /** true = 予定行の中に埋め込み表示 (外枠なし) */
  embedded?: boolean;
}) {
  const colors = SERVICE_TYPE_COLORS[rec.service_type] ?? SERVICE_TYPE_COLORS["身体介護"];
  const careItems = getActiveCareItems(rec);
  const duration = calcDuration(rec.start_time, rec.end_time);
  return (
    <div
      className={
        embedded
          ? "bg-white"
          : "rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden"
      }
    >
      {/* Card header */}
      <button
        className="flex w-full items-start gap-4 p-4 text-left hover:bg-gray-50 transition-colors"
        onClick={onToggle}
      >
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="flex items-center gap-1 text-sm font-semibold text-gray-900">
              <CalendarDays size={14} className="text-gray-400" />
              {formatVisitDate(rec.visit_date)}
            </span>
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${colors.bg} ${colors.text} ${colors.border}`}>
              {rec.service_type}
            </span>
            {/* Phase Shougai-1: 制度区分 chip (kaigo/shougai 表示) */}
            {rec.service_category === "shougai" && (
              <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0 text-[10px] font-medium text-violet-700">
                障害
              </span>
            )}
            {rec.service_category === "kaigo" && (
              <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0 text-[10px] font-medium text-blue-700">
                介護
              </span>
            )}
            {/* 署名済み chip (一覧を開かなくても分かるように) */}
            {(rec.signature_image_path || rec.signature_image_url) && (
              <span className="inline-flex items-center gap-0.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0 text-[10px] font-medium text-emerald-700">
                <PenLine size={10} />
                署名済
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <Clock size={12} />
              {formatTimeRange(rec.start_time, rec.end_time)}
              {duration && <span className="ml-1 text-gray-400">({duration})</span>}
            </span>
            {rec.staff_name && (
              <span className="flex items-center gap-1">
                <User size={12} />
                {rec.staff_name}
              </span>
            )}
          </div>
          {careItems.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {careItems.map((item) => (
                <span
                  key={item}
                  className="rounded-md bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600"
                >
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 text-gray-400 mt-1">
          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>

      {/* Expanded detail — 22カテゴリ対応 */}
      {isExpanded && (
        <div className="border-t bg-gray-50 px-4 py-4">
          <CareRecordDetail record={rec} />

          {/* 電子署名 */}
          <div className="mt-4 border-t border-gray-200 pt-3">
            <p className="mb-1.5 text-xs font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded">
              利用者確認 (署名)
            </p>
            {(rec.signature_image_path || rec.signature_image_url) ? (
              <div className="pl-2 space-y-2">
                <div className="rounded-lg border border-gray-200 bg-white p-3 inline-block">
                  {signatureSrc ? (
                    /* eslint-disable-next-line @next/next/no-img-element -- Storage signed URL は外部 host (next/image 不適) */
                    <img src={signatureSrc} alt="電子署名" className="max-h-32 w-auto" />
                  ) : (
                    <span className="text-[11px] text-gray-400">署名画像を読み込み中...</span>
                  )}
                </div>
                <div className="text-xs text-gray-600 space-y-0.5">
                  {rec.signer_name && (
                    <div>署名者: <strong>{rec.signer_name}</strong></div>
                  )}
                  {rec.signed_at && (
                    <div>
                      署名日時:{" "}
                      {(() => {
                        try {
                          return format(parseISO(rec.signed_at), "yyyy/M/d HH:mm");
                        } catch {
                          return rec.signed_at;
                        }
                      })()}
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSign();
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  <PenLine size={12} />
                  再署名
                </button>
              </div>
            ) : (
              <div className="pl-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSign();
                  }}
                  className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                >
                  <PenLine size={12} />
                  署名する
                </button>
                <p className="mt-1 text-[11px] text-gray-500">
                  利用者または代理人の電子署名を取得します
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export interface VisitRecordsContentProps {
  userId: string;
  userName?: string | null;
  // Phase Shougai-1: 利用者の制度区分 (= form の radio デフォルト / 強制値)
  //   'kaigo'   → form の service_category は kaigo 固定
  //   'shougai' → 同 shougai 固定
  //   'both' | null → ラジオで選択可能 (default 'kaigo')
  userCategory?: "kaigo" | "shougai" | "both" | null;
  initialRecords: VisitRecord[];
  initialStaff: KaigoStaff[];
}

// form の制度区分初期値 (= 利用者カテゴリから決定)
function pickDefaultCategory(uc: "kaigo" | "shougai" | "both" | null | undefined): "kaigo" | "shougai" {
  if (uc === "shougai") return "shougai";
  return "kaigo"; // kaigo / both / undefined はデフォルト介護
}

export function VisitRecordsContent({ userId, userName, userCategory, initialRecords, initialStaff }: VisitRecordsContentProps) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice } = useBusinessType();

  const [records, setRecords] = useState<VisitRecord[]>(initialRecords);
  const [staffList] = useState<KaigoStaff[]>(initialStaff);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  // 利用者が 'both' の場合のみラジオ選択可。それ以外は固定。
  const canChooseCategory = userCategory === "both" || userCategory == null;
  const [formBase, setFormBase] = useState({
    visit_date: format(new Date(), "yyyy-MM-dd"),
    staff_id: "",
    service_type: "身体介護" as ServiceType,
    service_category: pickDefaultCategory(userCategory) as "kaigo" | "shougai",
    start_time: "",
    end_time: "",
  });
  // 予定から作成する場合の元予定 (= schedule_id 紐付け + フォーム上部のバナー表示に使用)
  const [formSchedule, setFormSchedule] = useState<VisitSchedule | null>(null);
  // 利用者確認サイン (フォーム内インライン署名パッド)
  const [formSignature, setFormSignature] = useState<string | null>(null);
  const [formSignerName, setFormSignerName] = useState("");
  // 一覧の制度区分フィルタ (= 'all' / 'kaigo' / 'shougai')
  const [categoryFilter, setCategoryFilter] = useState<"all" | "kaigo" | "shougai">("all");
  const [formCare, setFormCare] = useState<CareData>(emptyCareData());
  const [formSection, setFormSection] = useState<string | null>("pre_check");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [signTarget, setSignTarget] = useState<VisitRecord | null>(null);
  // 表示月 (予定一覧・記録一覧・月次実績送付の共通軸)
  const [month, setMonth] = useState<string>(() => format(new Date(), "yyyy-MM"));
  const [showSendModal, setShowSendModal] = useState(false);
  // migration 未適用で INSERT から除外した列名 (amber バナー表示用)
  const [missingColumns, setMissingColumns] = useState<string[]>([]);

  // 当該月の訪問予定 (kaigo_visit_schedule — 読取のみ)
  const [schedules, setSchedules] = useState<VisitSchedule[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(true);

  // 当月の月次加算 (office スコープ)。入力経路 2 系統を読んでマージする (集計 aggregate.ts と同規則):
  //   a. kaigo_visit_month_addons (旧 3固定フラグ。移行期データ)
  //   b. kaigo_visit_addon_lines (現行の提供表 加算エディタ)。月次4コード
  //      (初回 114001 / 緊急時 114000 / 生機Ⅰ 114003 / Ⅱ 114002) はフラグへ正規化
  //      (boolean は OR、回数は max = 二重計上防止)、それ以外は加算行としてそのまま送付/印字。
  // 編集は provision-tickets の加算エディタ — ここは送信ペイロード/印字用の読取のみ。
  const [monthAddons, setMonthAddons] = useState<{
    shokai: boolean;
    seikatsu_kino: string;
    kinkyu_count: number;
  } | null>(null);
  // 月次4コード以外の加算行 (名称×回数。単位はマスタ解決済 — resolveVisitAddonLines)
  const [serviceAddonItems, setServiceAddonItems] = useState<MonthlyAddonItem[]>([]);
  useEffect(() => {
    if (!currentOffice) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- office 未確定時の derived reset
      setMonthAddons(null);
      setServiceAddonItems([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [yStr, mStr] = month.split("-");
      const [oldRes, lines] = await Promise.all([
        supabase
          .from("kaigo_visit_month_addons")
          .select("shokai, seikatsu_kino, kinkyu_count")
          .eq("client_id", userId)
          .eq("target_month", month)
          .eq("office_id", currentOffice.id)
          .maybeSingle(),
        // テーブル未作成 (42P01/PGRST205) は空 Map。その他は加算なしで継続 (console のみ)
        resolveVisitAddonLines(supabase, [userId], Number(yStr), Number(mStr), currentOffice.id)
          .then((map) => map.get(userId) ?? [])
          .catch((e: unknown) => {
            console.error("addon lines fetch failed:", e instanceof Error ? e.message : String(e));
            return [];
          }),
      ]);
      if (cancelled) return;
      let flags: { shokai: boolean; seikatsu_kino: string; kinkyu_count: number } | null = null;
      if (oldRes.error) {
        // テーブル未作成 (42P01/PGRST205) は「加算なし」として継続
        if (oldRes.error.code !== "42P01" && oldRes.error.code !== "PGRST205") {
          console.error("month addons fetch failed:", oldRes.error.message);
        }
      } else if (oldRes.data) {
        const d = oldRes.data as { shokai: boolean | null; seikatsu_kino: string | null; kinkyu_count: number | null };
        flags = {
          shokai: !!d.shokai,
          seikatsu_kino: d.seikatsu_kino ?? "なし",
          kinkyu_count: d.kinkyu_count ?? 0,
        };
      }
      const generic: MonthlyAddonItem[] = [];
      for (const l of lines) {
        if (l.count <= 0) continue;
        if (l.code === "114001" || l.code === "114000" || l.code === "114002" || l.code === "114003") {
          if (!flags) flags = { shokai: false, seikatsu_kino: "なし", kinkyu_count: 0 };
          if (l.code === "114001") {
            flags.shokai = true;
          } else if (l.code === "114000") {
            flags.kinkyu_count = Math.max(flags.kinkyu_count, l.count);
          } else {
            const grade = l.code === "114002" ? "Ⅱ" : "Ⅰ";
            if (flags.seikatsu_kino !== "Ⅱ") flags.seikatsu_kino = grade;
          }
        } else {
          generic.push({ name: l.name, count: l.count });
        }
      }
      setMonthAddons(flags);
      setServiceAddonItems(generic);
    })();
    return () => { cancelled = true; };
  }, [supabase, userId, month, currentOffice]);

  // 月次加算 + サービス加算行 → 送付/印字用の加算行
  const addonItems = useMemo<MonthlyAddonItem[]>(() => {
    const out: MonthlyAddonItem[] = [];
    if (monthAddons) {
      if (monthAddons.shokai) out.push({ name: "初回加算", count: 1 });
      if (monthAddons.kinkyu_count > 0) out.push({ name: "緊急時訪問介護加算", count: monthAddons.kinkyu_count });
      if (monthAddons.seikatsu_kino === "Ⅰ" || monthAddons.seikatsu_kino === "Ⅱ") {
        out.push({ name: `生活機能向上連携加算${monthAddons.seikatsu_kino}`, count: 1 });
      }
    }
    out.push(...serviceAddonItems);
    return out;
  }, [monthAddons, serviceAddonItems]);

  // 当該月分の visit_records (date + start_time 昇順)
  const monthRecords = useMemo(() => {
    const filtered = records.filter((r) => (r.visit_date ?? "").startsWith(month));
    return [...filtered].sort((a, b) => {
      const ad = a.visit_date ?? "";
      const bd = b.visit_date ?? "";
      if (ad !== bd) return ad < bd ? -1 : 1;
      const at = a.start_time ?? "";
      const bt = b.start_time ?? "";
      if (at === bt) return 0;
      return at < bt ? -1 : 1;
    });
  }, [records, month]);

  // 月次実績の送信対象: draft (下書き) は除外し confirmed / submitted のみ
  const sendableRecords = useMemo(
    () => monthRecords.filter((r) => r.status === "confirmed" || r.status === "submitted"),
    [monthRecords],
  );

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    // PostgREST embed: kaigo_visit_records.staff_id → members (FK redirect 済)
    const { data, error } = await supabase
      .from("kaigo_visit_records")
      .select("*, members(name)")
      .eq("user_id", userId)
      .order("visit_date", { ascending: false })
      .order("start_time", { ascending: false });
    if (error) {
      toast.error("記録の取得に失敗しました");
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
      const mapped = (data || []).map((r: any) => ({
        ...r,
        staff_name: r.members?.name ?? null,
      }));
      setRecords(mapped);
    }
    setLoading(false);
  }, [supabase, userId]);

  // initial render は server からの initialRecords を使用、内部 mutation 後の refetch のみ
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    fetchRecords();
  }, [fetchRecords]);

  // 当該月の訪問予定を取得 (kaigo_visit_schedule は読取のみ — 書込は shift-management 側)
  // NOTE: loading の ON は月変更ハンドラ (changeMonth) 側で行う
  //       (effect 内の同期 setState を避ける — react-hooks/set-state-in-effect)
  const fetchSchedules = useCallback(async () => {
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) return; // changeMonth で空値は弾いているため通常到達しない
    const from = `${month}-01`;
    const to = format(new Date(y, m, 1), "yyyy-MM-dd"); // 翌月 1 日 (排他)
    const BASE_COLS =
      "id, user_id, staff_id, staff_id_2, staff_id_3, visit_date, start_time, end_time, service_type, status";
    const runQuery = (cols: string) =>
      supabase
        .from("kaigo_visit_schedule")
        .select(cols)
        .eq("user_id", userId)
        .gte("visit_date", from)
        .lt("visit_date", to)
        .order("visit_date")
        .order("start_time");
    // スマホ打刻列 (migrations/visit_clock.sql) を参考表示用に一緒に読む。
    // 未適用環境 (42703) では列なし SELECT に fallback (打刻表示なしで従来通り)。
    let res = await runQuery(BASE_COLS + ", clock_in_at, clock_out_at");
    if (res.error && /clock_(in|out)_at/i.test(res.error.message)) {
      console.warn("clock_in_at/clock_out_at 列が未適用のため打刻表示なしで再取得:", res.error.message);
      res = await runQuery(BASE_COLS);
    }
    if (res.error) {
      console.error("schedule fetch failed:", res.error.message);
      toast.error("訪問予定の取得に失敗しました: " + res.error.message);
    } else {
      setSchedules((res.data ?? []) as unknown as VisitSchedule[]);
    }
    setSchedulesLoading(false);
  }, [supabase, userId, month]);

  // 同一 month の重複 fetch を防ぐ guard (mount 時 + month 変更時のみ実行)
  const lastFetchedMonth = useRef<string | null>(null);
  useEffect(() => {
    if (lastFetchedMonth.current === month) return;
    lastFetchedMonth.current = month;
    fetchSchedules();
  }, [month, fetchSchedules]);

  // 表示月の変更 (予定を再取得するので loading を立てる)
  const changeMonth = (next: string) => {
    if (!next) return;
    setMonth(next);
    setSchedulesLoading(true);
  };

  // 予定⇄記録の突合:
  //   1. record.schedule_id === schedule.id (正式リンク — 予定から作成した記録)
  //   2. schedule_id 未設定の既存記録 (紐付け導入前のデータ) は
  //      訪問日 + 開始時刻 (HH:MM) の一致でベストエフォート表示 (利用者は既に同一)
  //   突合されなかった記録は「予定外の記録」として別グループに表示する。
  const { scheduleRecordMap, unscheduledRecords } = useMemo(() => {
    const map = new Map<string, VisitRecord>(); // schedule.id → record
    const used = new Set<string>();
    const byScheduleId = new Map<string, VisitRecord>();
    for (const r of monthRecords) {
      if (r.schedule_id) byScheduleId.set(r.schedule_id, r);
    }
    // pass 1: 正式リンク
    for (const s of schedules) {
      const linked = byScheduleId.get(s.id);
      if (linked) {
        map.set(s.id, linked);
        used.add(linked.id);
      }
    }
    // pass 2: 日付 + 開始時刻のベストエフォート
    for (const s of schedules) {
      if (map.has(s.id)) continue;
      const st = hhmm(s.start_time);
      const cand = monthRecords.find(
        (r) =>
          !used.has(r.id) &&
          !r.schedule_id &&
          r.visit_date === s.visit_date &&
          hhmm(r.start_time) === st
      );
      if (cand) {
        map.set(s.id, cand);
        used.add(cand.id);
      }
    }
    const unscheduled = monthRecords.filter((r) => !used.has(r.id));
    return { scheduleRecordMap: map, unscheduledRecords: unscheduled };
  }, [schedules, monthRecords]);

  const recordedCount = scheduleRecordMap.size;

  // 予定外の記録に制度区分フィルタを適用 (legacy 互換: 未設定は 'kaigo' 扱い)
  const filteredUnscheduled = useMemo(
    () =>
      unscheduledRecords.filter((rec) => {
        if (categoryFilter === "all") return true;
        const c = rec.service_category ?? "kaigo";
        return c === categoryFilter;
      }),
    [unscheduledRecords, categoryFilter]
  );

  // staff id → 氏名 (予定行の担当表示用)
  const staffNamesOf = useCallback(
    (s: VisitSchedule): string[] =>
      [s.staff_id, s.staff_id_2, s.staff_id_3]
        .filter((id): id is string => !!id)
        .map((id) => staffList.find((x) => x.id === id)?.name ?? "(不明)"),
    [staffList]
  );

  // Form helpers
  // schedule を渡すと「予定から作成」: 日時・サービス種別・担当職員をプリフィルし schedule_id を紐付ける。
  // 渡さない場合は従来のフリー入力 (予定外の飛び込み訪問用)。
  // NOTE: 2人体制の職員2/3 の個別時間 (kaigo_visit_schedule.staff2_start_time 等) は
  //       本フォームのプリフィルでは本体時間を使う。職員2として記録を作る場合は
  //       開始/終了を手で個別時間に直す運用 (個別時間の自動プリフィルは将来対応)。
  const handleOpenForm = (schedule?: VisitSchedule) => {
    if (schedule) {
      setFormBase({
        visit_date: schedule.visit_date,
        staff_id: schedule.staff_id ?? "",
        service_type: mapScheduleServiceType(schedule.service_type),
        service_category: pickDefaultCategory(userCategory),
        start_time: hhmm(schedule.start_time),
        end_time: hhmm(schedule.end_time),
      });
      setFormSchedule(schedule);
    } else {
      setFormBase({
        visit_date: format(new Date(), "yyyy-MM-dd"),
        staff_id: "",
        service_type: "身体介護",
        service_category: pickDefaultCategory(userCategory),
        start_time: "",
        end_time: "",
      });
      setFormSchedule(null);
    }
    setFormCare(emptyCareData());
    setFormSection("pre_check");
    setFormSignature(null);
    setFormSignerName(userName ?? "");
    setShowForm(true);
  };

  const updCare = <K extends keyof CareData>(key: K, val: Partial<CareData[K]>) => {
    setFormCare((prev) => ({ ...prev, [key]: typeof prev[key] === "object" && !Array.isArray(prev[key]) ? { ...(prev[key] as Record<string, unknown>), ...val } : val }));
  };

  const handleSave = async () => {
    if (!formBase.visit_date) { toast.error("訪問日を入力してください"); return; }
    if (formSignature && !formSignerName.trim()) {
      toast.error("署名がある場合は署名者名を入力してください");
      return;
    }

    setSaving(true);
    const payload: Record<string, unknown> = {
      user_id: userId,
      visit_date: formBase.visit_date,
      staff_id: formBase.staff_id || null,
      service_type: formBase.service_type,
      // Phase Shougai-1: 請求区分 (kaigo / shougai)
      // migration 未適用 DB では列が無く INSERT エラー → 下の missing-column fallback で
      // 当該列だけ除去して retry する (除去した列は toast + amber バナーで明示)。
      service_category: formBase.service_category,
      start_time: formBase.start_time || null,
      end_time: formBase.end_time || null,
      care_record_data: formCare,
      vital_temperature: formCare.vitals.temperature ? parseFloat(formCare.vitals.temperature) : null,
      vital_bp_sys: formCare.vitals.bp_sys ? parseInt(formCare.vitals.bp_sys) : null,
      vital_bp_dia: formCare.vitals.bp_dia ? parseInt(formCare.vitals.bp_dia) : null,
      vital_pulse: formCare.vitals.pulse ? parseInt(formCare.vitals.pulse) : null,
      vital_spo2: formCare.vitals.spo2 ? parseInt(formCare.vitals.spo2) : null,
      vital_respiration: formCare.vitals.respiration ? parseInt(formCare.vitals.respiration) : null,
      vital_blood_sugar: formCare.vitals.blood_sugar ? parseInt(formCare.vitals.blood_sugar) : null,
      user_condition: formCare.user_condition || null,
      handover_notes: formCare.handover.notes || null,
      notes: formCare.notes || null,
      progress_notes: formCare.progress_notes || null,
      status: "draft",
    };
    // 予定から作成した場合のみ紐付ける (予定外のフリー入力は schedule_id 無し)
    if (formSchedule) {
      payload.schedule_id = formSchedule.id;
    }

    // INSERT — migration 未適用環境 (列が存在しない: PGRST204 / 42703) では
    // エラーメッセージから欠損列を特定し、その列だけ除去して retry する。
    // silent failure にはしない: 除去列は console.warn + toast + amber バナーで通知。
    let insertedId: string | null = null;
    const stripped: string[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, error } = await supabase
        .from("kaigo_visit_records")
        .insert(payload)
        .select("id")
        .single();
      if (!error) {
        insertedId = (data as { id: string }).id;
        break;
      }
      const missing =
        error.code === "PGRST204" || error.code === "42703"
          ? extractMissingColumn(error.message)
          : null;
      if (missing && missing in payload) {
        delete payload[missing];
        stripped.push(missing);
        continue;
      }
      toast.error("保存に失敗しました: " + error.message);
      setSaving(false);
      return;
    }
    if (!insertedId) {
      toast.error("保存に失敗しました (列除去 retry 上限)");
      setSaving(false);
      return;
    }
    if (stripped.length > 0) {
      console.warn("kaigo_visit_records insert: DB 未適用列を除外して保存:", stripped.join(", "));
      toast.warning(
        `一部の列 (${stripped.join(", ")}) が DB 未適用のため除外して保存しました。` +
          "migrations/kaigo_visit_records_schedule_signature.sql を実行してください"
      );
      setMissingColumns((prev) => Array.from(new Set([...prev, ...stripped])));
    }

    // 署名 (利用者確認サイン) — 既存の電子署名 v2 方式に統一:
    // dataURL → PNG blob → Storage "signatures" bucket に upload → path を record に保存。
    // 失敗しても記録本体は保存済みなので、一覧の「署名する」から再取得できる旨を案内。
    if (formSignature) {
      try {
        const blob = await (await fetch(formSignature)).blob();
        const tenant = await resolvePreferredTenantId(supabase);
        if (!tenant.ok) throw new Error(tenant.error);
        const path = `${tenant.tenantId}/kaigo_visit_records/${insertedId}.png`;
        const { error: uploadErr } = await supabase.storage
          .from("signatures")
          .upload(path, blob, { contentType: "image/png", upsert: true });
        if (uploadErr) throw uploadErr;
        const { error: sigErr } = await supabase
          .from("kaigo_visit_records")
          .update({
            signature_image_path: path,
            signature_image_url: null, // v1 互換列は使わない
            signed_at: new Date().toISOString(), // 署名日時は保存時に自動記録
            signer_name: formSignerName.trim(),
          })
          .eq("id", insertedId);
        if (sigErr) throw sigErr;
      } catch (err: unknown) {
        console.error("signature save failed:", err);
        toast.error(
          "記録は保存しましたが署名の保存に失敗しました (一覧の「署名する」から再取得できます): " +
            (err instanceof Error ? err.message : String(err))
        );
      }
    }

    setSaving(false);
    toast.success("サービス実施記録を保存しました");
    setShowForm(false);
    fetchRecords();
  };

  // Section toggle for form
  const isFormOpen = (id: string) => formSection === id;

  // v2: signature_image_path から signed URL を一括動的発行 (1 時間期限 / 表示直前で再発行)
  const signaturePaths = useMemo(
    () => records.map((r) => r.signature_image_path),
    [records]
  );
  const signedUrlMap = useSignedUrls(signaturePaths);
  // 表示用 helper: path 優先 → URL fallback (path 未 backfill record 用)
  const resolveSignatureSrc = useCallback(
    (rec: VisitRecord): string | null => {
      if (rec.signature_image_path) {
        return signedUrlMap.get(rec.signature_image_path) ?? null;
      }
      return rec.signature_image_url;
    },
    [signedUrlMap]
  );

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #visit-records-print, #visit-records-print * { visibility: visible !important; }
          #visit-records-print {
            position: fixed; inset: 0;
            padding: 10mm;
            background: white;
            color: #000;
            font-family: "MS Mincho","游明朝","Hiragino Mincho ProN",serif;
            overflow: visible;
          }
          @page { size: A4 portrait; margin: 0; }
        }
      `}</style>

      {/* Header */}
      <div className="flex items-center justify-between border-b bg-white px-6 py-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">サービス実施記録</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            訪問予定から記録を作成します (予定外の飛び込み訪問はフリー入力)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSendModal(true)}
            disabled={!userName || !currentOffice || sendableRecords.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              sendableRecords.length === 0
                ? monthRecords.length > 0
                  ? "確定済み (confirmed/submitted) の実績がありません (下書きは送信対象外)"
                  : "対象月の実績がありません"
                : !currentOffice
                  ? "事業所が選択されていません"
                  : "居宅介護支援事業所へ月次実績を送付 (下書きは除外)"
            }
          >
            <Send size={14} />
            居宅事業所に実績送信
            <span className="ml-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
              {sendableRecords.length}件{addonItems.length > 0 ? ` +加算${addonItems.length}` : ""}
            </span>
          </button>
          <button
            onClick={() => window.print()}
            disabled={records.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-40"
          >
            <Printer size={14} />
            印刷
          </button>
          {/* 予定外の飛び込み訪問用のフリー入力 (小さく残す) */}
          <button
            onClick={() => handleOpenForm()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            title="予定に無い飛び込み訪問の記録をフリー入力で作成"
          >
            <Plus size={14} />
            予定外の記録を作成
          </button>
        </div>
      </div>

      {/* 月ナビ + 制度区分フィルタ */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-white px-6 py-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => changeMonth(format(addMonths(parseISO(`${month}-01`), -1), "yyyy-MM"))}
            className="rounded-md border border-gray-200 p-1.5 text-gray-500 hover:bg-gray-50"
            title="前月"
          >
            <ChevronLeft size={14} />
          </button>
          <input
            type="month"
            value={month}
            onChange={(e) => changeMonth(e.target.value)}
            className="rounded-md border border-gray-200 px-2 py-1 text-sm font-medium text-gray-700"
            title="表示月 (予定・記録・実績送信の対象月)"
          />
          <button
            onClick={() => changeMonth(format(addMonths(parseISO(`${month}-01`), 1), "yyyy-MM"))}
            className="rounded-md border border-gray-200 p-1.5 text-gray-500 hover:bg-gray-50"
            title="翌月"
          >
            <ChevronRight size={14} />
          </button>
          <button
            onClick={() => changeMonth(format(new Date(), "yyyy-MM"))}
            className="ml-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            今月
          </button>
          <span className="ml-3 text-xs text-gray-500">
            予定 <strong className="text-gray-700">{schedules.length}</strong> 件
            (記録済 <strong className="text-emerald-600">{recordedCount}</strong>
            {" / "}未記録 <strong className="text-amber-600">{Math.max(schedules.length - recordedCount, 0)}</strong>)
            {unscheduledRecords.length > 0 && (
              <> ・予定外の記録 <strong className="text-gray-700">{unscheduledRecords.length}</strong> 件</>
            )}
          </span>
        </div>
        {/* Phase Shougai-1: 制度区分フィルタ */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">制度区分:</span>
          {([
            { v: "all" as const, label: "すべて" },
            { v: "kaigo" as const, label: "介護" },
            { v: "shougai" as const, label: "障害" },
          ]).map((opt) => (
            <button
              key={opt.v}
              onClick={() => setCategoryFilter(opt.v)}
              className={`rounded-full border px-3 py-0.5 transition-colors ${
                categoryFilter === opt.v
                  ? "border-violet-500 bg-violet-50 text-violet-700 font-medium"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-gray-50 p-6">
        {/* migration 未適用の列があった場合の警告 (INSERT fallback で検知) */}
        {missingColumns.length > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-bold">SQL 未適用の列があります: {missingColumns.join(", ")}</p>
              <p className="mt-0.5">
                migrations/kaigo_visit_records_schedule_signature.sql を実行してください。
                未適用の間、該当列は保存されません (予定との紐付けは日付+開始時刻による推定表示になります)。
              </p>
            </div>
          </div>
        )}

        {loading || schedulesLoading ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" />
            読込中...
          </div>
        ) : schedules.length === 0 && monthRecords.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-400">
            <div className="text-center">
              <ClipboardList size={32} className="mx-auto mb-2 text-gray-300" />
              <p>{month.replace("-", "年")}月の訪問予定・記録はありません</p>
              <button
                onClick={() => handleOpenForm()}
                className="mt-3 text-blue-600 hover:underline text-xs"
              >
                予定外の記録を作成する
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* ── 訪問予定 (主役): 予定の中から「どの訪問の記録を作るか」を選ぶ ── */}
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-gray-700">
                <CalendarClock size={15} className="text-blue-600" />
                訪問予定 ({schedules.length}件)
              </h2>
              {schedules.length === 0 ? (
                <p className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-6 text-center text-xs text-gray-400">
                  この月の訪問予定はありません
                </p>
              ) : (
                <div className="space-y-2">
                  {schedules.map((s) => {
                    const rec = scheduleRecordMap.get(s.id) ?? null;
                    const cancelled = s.status === "cancelled";
                    const staffNames = staffNamesOf(s);
                    let dateLabel = s.visit_date;
                    let dowLabel = "";
                    try {
                      const d = parseISO(s.visit_date);
                      dateLabel = format(d, "M/d");
                      dowLabel = format(d, "E", { locale: ja });
                    } catch { dowLabel = ""; }
                    return (
                      <div
                        key={s.id}
                        className={`rounded-xl border bg-white shadow-sm overflow-hidden ${
                          rec ? "border-emerald-200" : cancelled ? "border-gray-200 opacity-60" : "border-amber-200"
                        }`}
                      >
                        <div className="flex items-center gap-3 px-4 py-2.5">
                          <div className="w-12 shrink-0 text-center">
                            <div className="text-sm font-bold text-gray-800">{dateLabel}</div>
                            <div className="text-[11px] text-gray-400">{dowLabel && `(${dowLabel})`}</div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-sm text-gray-800">
                              <span className="flex items-center gap-1 tabular-nums">
                                <Clock size={12} className="text-gray-400" />
                                {hhmm(s.start_time) || "--:--"} 〜 {hhmm(s.end_time) || "--:--"}
                              </span>
                              {s.service_type && (
                                <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0 text-[11px] font-medium text-blue-700">
                                  {s.service_type}
                                </span>
                              )}
                              {cancelled && (
                                <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0 text-[11px] font-medium text-red-600">
                                  キャンセル
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-xs text-gray-500">
                              担当: {staffNames.length > 0 ? staffNames.join("、") : "未定"}
                            </div>
                            {/* スマホ打刻 (参考表示のみ。編集経路なし) */}
                            {(s.clock_in_at || s.clock_out_at) && (
                              <div className="mt-0.5 text-[11px] text-gray-400 tabular-nums">
                                打刻 {s.clock_in_at ? fmtClockHm(s.clock_in_at) : "--:--"} 〜{" "}
                                {s.clock_out_at ? fmtClockHm(s.clock_out_at) : "--:--"}
                              </div>
                            )}
                          </div>
                          {rec ? (
                            <button
                              onClick={() => setExpandedId(rec.id)}
                              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 transition-colors"
                              title="記録を表示"
                            >
                              <CheckCircle2 size={13} />
                              記録済み
                              <ChevronRight size={12} />
                            </button>
                          ) : cancelled ? null : (
                            <div className="flex shrink-0 items-center gap-2">
                              <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                                未記録
                              </span>
                              <button
                                onClick={() => handleOpenForm(s)}
                                className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                              >
                                <PenLine size={12} />
                                記録を作成
                              </button>
                            </div>
                          )}
                        </div>
                        {/* 記録済みの閲覧はモーダル (下部の記録閲覧モーダル) で表示 */}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* ── 予定外の記録 (飛び込み訪問 / 予定に突合できなかった既存記録) ── */}
            {filteredUnscheduled.length > 0 && (
              <section>
                <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-gray-700">
                  <ClipboardList size={15} className="text-gray-500" />
                  予定外の記録 ({filteredUnscheduled.length}件)
                </h2>
                <div className="space-y-3">
                  {filteredUnscheduled.map((rec) => (
                    <RecordCard
                      key={rec.id}
                      rec={rec}
                      isExpanded={false}
                      onToggle={() => setExpandedId(rec.id)}
                      onSign={() => setSignTarget(rec)}
                      signatureSrc={resolveSignatureSrc(rec)}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {/* ── 記録閲覧モーダル (予定行の「記録済み」/ 予定外カードのクリックで開く) ── */}
      {(() => {
        const viewRec = expandedId
          ? records.find((r) => r.id === expandedId) ?? null
          : null;
        if (!viewRec) return null;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setExpandedId(null)}
          >
            <div
              className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-4 py-2.5">
                <h3 className="text-sm font-bold text-gray-800">サービス実施記録</h3>
                <button
                  onClick={() => setExpandedId(null)}
                  className="rounded p-1 text-gray-500 hover:bg-gray-100"
                  title="閉じる"
                >
                  <X size={18} />
                </button>
              </div>
              <RecordCard
                rec={viewRec}
                embedded
                isExpanded
                onToggle={() => setExpandedId(null)}
                onSign={() => setSignTarget(viewRec)}
                signatureSrc={resolveSignatureSrc(viewRec)}
              />
            </div>
          </div>
        );
      })()}

      {/* 印刷用 DOM (画面では hidden) */}
      <div id="visit-records-print" className="hidden">
        <VisitPrintView records={records} userName={userName ?? undefined} signedUrlMap={signedUrlMap} />
      </div>

      {/* 月次実績送付スナップショット用 DOM (画面では hidden、month + 確定済のみ) */}
      <div id="visit-records-month-print" className="hidden">
        <VisitPrintView
          records={sendableRecords}
          userName={userName ?? undefined}
          signedUrlMap={signedUrlMap}
          headerLabel={`${month.replace("-", "年")}月 訪問介護実績`}
          addons={addonItems}
        />
      </div>

      {/* 月次実績の居宅事業所への送信モーダル */}
      {showSendModal && userName && currentOffice && (
        <SendDocumentModal
          tenantId={currentOffice.tenant_id}
          client={{ id: userId, name: userName }}
          sourceOfficeId={currentOffice.id}
          documentType="service_record_monthly"
          targetServiceTypes={["居宅介護支援"]}
          title={`${month.replace("-", "年")}月 訪問介護実績 - ${userName} 様`}
          getHtmlSnapshot={() =>
            document.getElementById("visit-records-month-print")?.outerHTML ?? ""
          }
          payload={
            buildMonthlyServiceRecordPayload({
              yearMonth: month,
              clientId: userId,
              clientName: userName,
              // 下書き (draft) を除外した確定済のみを送付
              records: sendableRecords,
              // 月次加算 (初回/緊急時/生活機能向上) を加算行として同梱
              addons: addonItems,
            }) as unknown as Record<string, unknown>
          }
          onClose={() => setShowSendModal(false)}
          onSuccess={() => {
            setShowSendModal(false);
            toast.success("月次実績を送付しました");
          }}
          onError={(msg) => toast.error("送付失敗: " + msg)}
        />
      )}

      {/* Modal — 22カテゴリ対応の新規記録フォーム */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-start justify-end overflow-auto bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl flex flex-col max-h-[calc(100vh-2rem)]">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="text-base font-bold text-gray-900">
                サービス実施記録 — {formSchedule ? "予定から作成" : "新規 (予定外)"}
              </h2>
              <button onClick={() => setShowForm(false)} className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"><X size={18} /></button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {/* 予定から作成する場合: 元予定のサマリを表示 (日時・担当はプリフィル済み) */}
              {formSchedule && (
                <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs text-blue-800">
                  <CalendarClock size={15} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-bold">
                      {formatVisitDate(formSchedule.visit_date)} {hhmm(formSchedule.start_time)} 〜 {hhmm(formSchedule.end_time)}
                      {formSchedule.service_type && ` / ${formSchedule.service_type}`}
                    </p>
                    <p className="mt-0.5 text-blue-600">
                      予定の内容を下記フォームに自動入力しました (実際の訪問に合わせて修正できます)
                    </p>
                  </div>
                </div>
              )}

              {/* 基本情報 */}
              <section>
                <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-gray-500">基本情報</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="mb-1 block text-xs font-medium text-gray-700">訪問日 <span className="text-red-500">*</span></label>
                    <input type="date" value={formBase.visit_date} onChange={(e) => setFormBase({ ...formBase, visit_date: e.target.value })} className={inputClass} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">開始時刻</label>
                    <input type="time" value={formBase.start_time} onChange={(e) => setFormBase({ ...formBase, start_time: e.target.value })} className={inputClass} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">終了時刻</label>
                    <input type="time" value={formBase.end_time} onChange={(e) => setFormBase({ ...formBase, end_time: e.target.value })} className={inputClass} />
                  </div>
                  <div className="col-span-2">
                    <label className="mb-1 block text-xs font-medium text-gray-700">サービス種別</label>
                    <select value={formBase.service_type} onChange={(e) => setFormBase({ ...formBase, service_type: e.target.value as ServiceType })} className={inputClass}>
                      {SERVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  {/* Phase Shougai-1: 制度区分 (= 請求区分). 利用者が 'both' の場合のみ選択可能 */}
                  <div className="col-span-2">
                    <label className="mb-1 block text-xs font-medium text-gray-700">
                      制度区分
                      {!canChooseCategory && (
                        <span className="ml-1 text-[10px] font-normal text-gray-400">
                          (利用者の設定により固定)
                        </span>
                      )}
                    </label>
                    <div className="flex gap-4">
                      {([
                        { v: "kaigo" as const, label: "介護 (介護保険)" },
                        { v: "shougai" as const, label: "障害 (障害福祉)" },
                      ]).map((opt) => (
                        <label key={opt.v} className="flex items-center gap-1.5 text-sm cursor-pointer">
                          <input
                            type="radio"
                            name="service_category"
                            value={opt.v}
                            checked={formBase.service_category === opt.v}
                            disabled={!canChooseCategory}
                            onChange={() => setFormBase({ ...formBase, service_category: opt.v })}
                            className="accent-violet-600"
                          />
                          <span className={!canChooseCategory && formBase.service_category !== opt.v ? "text-gray-400" : ""}>
                            {opt.label}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="col-span-2">
                    <label className="mb-1 block text-xs font-medium text-gray-700">担当職員</label>
                    <select value={formBase.staff_id} onChange={(e) => setFormBase({ ...formBase, staff_id: e.target.value })} className={inputClass}>
                      <option value="">— 選択してください —</option>
                      {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                </div>
              </section>

              {/* 1. 事前チェック */}
              <FSectionBtn id="pre_check" label="事前チェック" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("pre_check") && (
                <div className="space-y-2 pl-1">
                  <div className="grid grid-cols-2 gap-2">
                    <FSelect label="顔色" value={formCare.pre_check.complexion} onChange={(v) => updCare("pre_check", { complexion: v })} options={["良好", "やや不良", "不良"]} />
                    <FSelect label="体調" value={formCare.pre_check.condition} onChange={(v) => updCare("pre_check", { condition: v })} options={["良好", "普通", "不良"]} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <FInput label="室温 (℃)" value={formCare.pre_check.room_temp} onChange={(v) => updCare("pre_check", { room_temp: v })} placeholder="25" type="number" />
                    <FInput label="湿度 (%)" value={formCare.pre_check.humidity} onChange={(v) => updCare("pre_check", { humidity: v })} placeholder="50" type="number" />
                  </div>
                  <FTextarea label="備考" value={formCare.pre_check.notes} onChange={(v) => updCare("pre_check", { notes: v })} />
                </div>
              )}

              {/* 2. バイタル */}
              <FSectionBtn id="vitals" label="バイタルサイン・身体測定" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("vitals") && (
                <div className="space-y-2 pl-1">
                  <div className="grid grid-cols-2 gap-2">
                    <FInput label="体温 (℃)" value={formCare.vitals.temperature} onChange={(v) => updCare("vitals", { temperature: v })} placeholder="36.5" type="number" />
                    <FInput label="SpO2 (%)" value={formCare.vitals.spo2} onChange={(v) => updCare("vitals", { spo2: v })} placeholder="98" type="number" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <FInput label="収縮期血圧" value={formCare.vitals.bp_sys} onChange={(v) => updCare("vitals", { bp_sys: v })} placeholder="120" type="number" />
                    <FInput label="拡張期血圧" value={formCare.vitals.bp_dia} onChange={(v) => updCare("vitals", { bp_dia: v })} placeholder="80" type="number" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <FInput label="脈拍 (bpm)" value={formCare.vitals.pulse} onChange={(v) => updCare("vitals", { pulse: v })} placeholder="72" type="number" />
                    <FInput label="呼吸数" value={formCare.vitals.respiration} onChange={(v) => updCare("vitals", { respiration: v })} placeholder="18" type="number" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <FInput label="血糖値 (mg/dL)" value={formCare.vitals.blood_sugar} onChange={(v) => updCare("vitals", { blood_sugar: v })} placeholder="100" type="number" />
                    <FInput label="体重 (kg)" value={formCare.vitals.weight} onChange={(v) => updCare("vitals", { weight: v })} placeholder="60.0" type="number" />
                  </div>
                </div>
              )}

              {/* 3. 排泄 */}
              <FSectionBtn id="excretion" label="排泄介助" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("excretion") && (
                <div className="space-y-2 pl-1">
                  <div className="grid grid-cols-2 gap-2">
                    <FCheck label="尿" checked={formCare.excretion.urine} onChange={(v) => updCare("excretion", { urine: v, done: v || formCare.excretion.stool })} />
                    <FCheck label="便" checked={formCare.excretion.stool} onChange={(v) => updCare("excretion", { stool: v, done: formCare.excretion.urine || v })} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <FSelect label="尿量" value={formCare.excretion.urine_amount} onChange={(v) => updCare("excretion", { urine_amount: v })} options={["少量", "普通", "多量"]} />
                    <FSelect label="便量" value={formCare.excretion.stool_amount} onChange={(v) => updCare("excretion", { stool_amount: v })} options={["少量", "普通", "多量"]} />
                  </div>
                  <FSelect label="便性状" value={formCare.excretion.stool_type} onChange={(v) => updCare("excretion", { stool_type: v })} options={["普通", "硬い", "軟便", "水様便"]} />
                  <FSelect label="自立度" value={formCare.excretion.independence} onChange={(v) => updCare("excretion", { independence: v })} options={["自立", "見守り", "一部介助", "全介助"]} />
                  <FSelect label="使用器具" value={formCare.excretion.device} onChange={(v) => updCare("excretion", { device: v })} options={["トイレ", "ポータブルトイレ", "おむつ", "パッド", "尿器"]} />
                  <FTextarea label="備考" value={formCare.excretion.notes} onChange={(v) => updCare("excretion", { notes: v })} />
                </div>
              )}

              {/* 4. 水分 */}
              <FSectionBtn id="hydration" label="水分摂取" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("hydration") && (
                <div className="space-y-2 pl-1">
                  <FInput label="飲み物の種類" value={formCare.hydration.drink_type} onChange={(v) => updCare("hydration", { drink_type: v, done: true })} placeholder="お茶、水等" />
                  <FInput label="量 (ml)" value={formCare.hydration.amount} onChange={(v) => updCare("hydration", { amount: v })} placeholder="200" type="number" />
                  <FSelect label="とろみ" value={formCare.hydration.thickener} onChange={(v) => updCare("hydration", { thickener: v })} options={["なし", "薄い", "中間", "濃い"]} />
                </div>
              )}

              {/* 5. 食事 */}
              <FSectionBtn id="meal" label="食事介助" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("meal") && (
                <div className="space-y-2 pl-1">
                  <div className="grid grid-cols-2 gap-2">
                    <FSelect label="主食摂取量" value={formCare.meal.staple_amount} onChange={(v) => updCare("meal", { staple_amount: v, done: true })} options={["全量", "3/4", "半分", "1/4", "少量", "なし"]} />
                    <FSelect label="副食摂取量" value={formCare.meal.side_amount} onChange={(v) => updCare("meal", { side_amount: v })} options={["全量", "3/4", "半分", "1/4", "少量", "なし"]} />
                  </div>
                  <FSelect label="食事形態" value={formCare.meal.meal_form} onChange={(v) => updCare("meal", { meal_form: v })} options={["普通", "きざみ", "ミキサー", "ペースト", "流動食"]} />
                  <FSelect label="自立度" value={formCare.meal.independence} onChange={(v) => updCare("meal", { independence: v })} options={["自立", "見守り", "一部介助", "全介助"]} />
                </div>
              )}

              {/* 6. 口腔ケア */}
              <FSectionBtn id="oral_care" label="口腔ケア" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("oral_care") && (
                <div className="space-y-2 pl-1">
                  <FSelect label="義歯" value={formCare.oral_care.denture} onChange={(v) => updCare("oral_care", { denture: v })} options={["なし", "上のみ", "下のみ", "上下"]} />
                  <div className="grid grid-cols-2 gap-2">
                    <FCheck label="歯磨き" checked={formCare.oral_care.brushing} onChange={(v) => updCare("oral_care", { brushing: v, done: true })} />
                    <FCheck label="うがい" checked={formCare.oral_care.gargling} onChange={(v) => updCare("oral_care", { gargling: v, done: true })} />
                    <FCheck label="義歯洗浄" checked={formCare.oral_care.denture_cleaning} onChange={(v) => updCare("oral_care", { denture_cleaning: v, done: true })} />
                    <FCheck label="口腔清拭" checked={formCare.oral_care.mouth_wipe} onChange={(v) => updCare("oral_care", { mouth_wipe: v, done: true })} />
                  </div>
                </div>
              )}

              {/* 7. 清拭・入浴 */}
              <FSectionBtn id="bathing" label="清拭・入浴" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("bathing") && (
                <div className="space-y-2 pl-1">
                  <FSelect label="入浴種類" value={formCare.bathing.bath_type} onChange={(v) => updCare("bathing", { bath_type: v, done: true })} options={["一般浴", "シャワー浴", "清拭", "足浴", "手浴", "部分浴"]} />
                  <FSelect label="自立度" value={formCare.bathing.independence} onChange={(v) => updCare("bathing", { independence: v })} options={["自立", "見守り", "一部介助", "全介助"]} />
                  <FSelect label="皮膚状態" value={formCare.bathing.skin_condition} onChange={(v) => updCare("bathing", { skin_condition: v })} options={["異常なし", "発赤", "褥瘡", "湿疹", "乾燥", "傷", "その他"]} />
                </div>
              )}

              {/* 8. 身体整容 */}
              <FSectionBtn id="grooming" label="身体整容" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("grooming") && (
                <div className="grid grid-cols-3 gap-2 pl-1">
                  <FCheck label="洗顔" checked={formCare.grooming.face_wash} onChange={(v) => updCare("grooming", { face_wash: v, done: true })} />
                  <FCheck label="整髪" checked={formCare.grooming.hair} onChange={(v) => updCare("grooming", { hair: v, done: true })} />
                  <FCheck label="爪切り" checked={formCare.grooming.nail} onChange={(v) => updCare("grooming", { nail: v, done: true })} />
                  <FCheck label="耳掃除" checked={formCare.grooming.ear} onChange={(v) => updCare("grooming", { ear: v, done: true })} />
                  <FCheck label="髭剃り" checked={formCare.grooming.shaving} onChange={(v) => updCare("grooming", { shaving: v, done: true })} />
                </div>
              )}

              {/* 9. 更衣 */}
              <FSectionBtn id="dressing" label="更衣介助" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("dressing") && (
                <div className="space-y-2 pl-1">
                  <div className="grid grid-cols-2 gap-2">
                    <FCheck label="上衣" checked={formCare.dressing.upper} onChange={(v) => updCare("dressing", { upper: v, done: true })} />
                    <FCheck label="下衣" checked={formCare.dressing.lower} onChange={(v) => updCare("dressing", { lower: v, done: true })} />
                  </div>
                  <FSelect label="自立度" value={formCare.dressing.independence} onChange={(v) => updCare("dressing", { independence: v })} options={["自立", "見守り", "一部介助", "全介助"]} />
                </div>
              )}

              {/* 10. 体位・移動 */}
              <FSectionBtn id="positioning" label="体位変換・移動" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("positioning") && (
                <div className="space-y-2 pl-1">
                  <FSelect label="体位" value={formCare.positioning.position_type} onChange={(v) => updCare("positioning", { position_type: v, done: true })} options={["仰臥位", "側臥位", "座位", "半座位", "起立位", "その他"]} />
                  <FSelect label="移動手段" value={formCare.positioning.mobility_device} onChange={(v) => updCare("positioning", { mobility_device: v })} options={["徒歩", "杖", "歩行器", "車椅子", "ストレッチャー", "その他"]} />
                </div>
              )}

              {/* 11. 服薬 */}
              <FSectionBtn id="medication" label="服薬介助" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("medication") && (
                <div className="space-y-2 pl-1">
                  <FSelect label="投与方法" value={formCare.medication.med_type} onChange={(v) => updCare("medication", { med_type: v, done: true })} options={["内服", "外用", "点眼", "吸入", "座薬", "注射", "その他"]} />
                  <FCheck label="服薬確認済み" checked={formCare.medication.confirmed} onChange={(v) => updCare("medication", { confirmed: v })} />
                </div>
              )}

              {/* 12. 通院・外出 */}
              <FSectionBtn id="outing" label="通院・外出介助" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("outing") && (
                <div className="space-y-2 pl-1">
                  <FSelect label="種類" value={formCare.outing.outing_type} onChange={(v) => updCare("outing", { outing_type: v, done: true })} options={["通院", "買物同行", "散歩", "外出付添", "その他"]} />
                  <FSelect label="移動手段" value={formCare.outing.transport} onChange={(v) => updCare("outing", { transport: v })} options={["徒歩", "車", "公共交通", "車椅子", "その他"]} />
                </div>
              )}

              {/* 13. 起床・就寝 */}
              <FSectionBtn id="wake_sleep" label="起床・就寝介助" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("wake_sleep") && (
                <div className="grid grid-cols-3 gap-2 pl-1">
                  <FCheck label="起床介助" checked={formCare.wake_sleep.wake_up} onChange={(v) => updCare("wake_sleep", { wake_up: v, done: true })} />
                  <FCheck label="就寝介助" checked={formCare.wake_sleep.go_to_bed} onChange={(v) => updCare("wake_sleep", { go_to_bed: v, done: true })} />
                  <FCheck label="ベッドメイク" checked={formCare.wake_sleep.bed_making} onChange={(v) => updCare("wake_sleep", { bed_making: v, done: true })} />
                </div>
              )}

              {/* 14. 医療的ケア */}
              <FSectionBtn id="medical_care" label="医療的ケア" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("medical_care") && (
                <div className="grid grid-cols-3 gap-2 pl-1">
                  <FCheck label="吸引" checked={formCare.medical_care.suction} onChange={(v) => updCare("medical_care", { suction: v, done: true })} />
                  <FCheck label="経管栄養" checked={formCare.medical_care.tube_feeding} onChange={(v) => updCare("medical_care", { tube_feeding: v, done: true })} />
                  <FCheck label="ストーマ" checked={formCare.medical_care.stoma} onChange={(v) => updCare("medical_care", { stoma: v, done: true })} />
                  <FCheck label="カテーテル" checked={formCare.medical_care.catheter} onChange={(v) => updCare("medical_care", { catheter: v, done: true })} />
                  <FCheck label="創傷処置" checked={formCare.medical_care.wound_care} onChange={(v) => updCare("medical_care", { wound_care: v, done: true })} />
                  <FCheck label="酸素管理" checked={formCare.medical_care.oxygen} onChange={(v) => updCare("medical_care", { oxygen: v, done: true })} />
                </div>
              )}

              {/* 15. 自立支援 */}
              <FSectionBtn id="independence" label="自立支援" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("independence") && (
                <div className="grid grid-cols-2 gap-2 pl-1">
                  <FCheck label="運動・リハビリ" checked={formCare.independence_support.exercise} onChange={(v) => updCare("independence_support", { exercise: v, done: true })} />
                  <FCheck label="認知機能訓練" checked={formCare.independence_support.cognitive} onChange={(v) => updCare("independence_support", { cognitive: v, done: true })} />
                  <FCheck label="コミュニケーション" checked={formCare.independence_support.communication} onChange={(v) => updCare("independence_support", { communication: v, done: true })} />
                  <FCheck label="社会参加" checked={formCare.independence_support.social} onChange={(v) => updCare("independence_support", { social: v, done: true })} />
                </div>
              )}

              {/* 16. 生活援助 */}
              <FSectionBtn id="living" label="生活援助" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("living") && (
                <div className="space-y-2 pl-1">
                  <div className="grid grid-cols-3 gap-2">
                    <FCheck label="調理" checked={formCare.living_support.cooking} onChange={(v) => updCare("living_support", { cooking: v })} />
                    <FCheck label="掃除" checked={formCare.living_support.cleaning} onChange={(v) => updCare("living_support", { cleaning: v })} />
                    <FCheck label="洗濯" checked={formCare.living_support.laundry} onChange={(v) => updCare("living_support", { laundry: v })} />
                    <FCheck label="買物" checked={formCare.living_support.shopping} onChange={(v) => updCare("living_support", { shopping: v })} />
                    <FCheck label="ゴミ出し" checked={formCare.living_support.trash} onChange={(v) => updCare("living_support", { trash: v })} />
                    <FCheck label="衣類整理" checked={formCare.living_support.clothing} onChange={(v) => updCare("living_support", { clothing: v })} />
                    <FCheck label="服薬管理" checked={formCare.living_support.medication_mgmt} onChange={(v) => updCare("living_support", { medication_mgmt: v })} />
                    <FCheck label="健康管理" checked={formCare.living_support.health_mgmt} onChange={(v) => updCare("living_support", { health_mgmt: v })} />
                  </div>
                </div>
              )}

              {/* 17. 退出確認 */}
              <FSectionBtn id="exit_check" label="退出確認" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("exit_check") && (
                <div className="space-y-2 pl-1">
                  <div className="grid grid-cols-3 gap-2">
                    <FCheck label="火の元確認" checked={formCare.exit_check.fire_check} onChange={(v) => updCare("exit_check", { fire_check: v })} />
                    <FCheck label="施錠確認" checked={formCare.exit_check.lock_check} onChange={(v) => updCare("exit_check", { lock_check: v })} />
                    <FCheck label="電化製品確認" checked={formCare.exit_check.appliance_check} onChange={(v) => updCare("exit_check", { appliance_check: v })} />
                  </div>
                  <FTextarea label="退出時の状態" value={formCare.exit_check.user_condition} onChange={(v) => updCare("exit_check", { user_condition: v })} />
                </div>
              )}

              {/* 18-20. テキスト系 */}
              <FSectionBtn id="text_sections" label="経過記録・申し送り・詳細報告" openId={formSection} setOpenId={setFormSection} />
              {isFormOpen("text_sections") && (
                <div className="space-y-3 pl-1">
                  <FTextarea label="経過記録" value={formCare.progress_notes} onChange={(v) => setFormCare({ ...formCare, progress_notes: v })} placeholder="サービス提供中の経過を記録..." rows={3} />
                  <div className="grid grid-cols-4 gap-2">
                    <div className="col-span-1">
                      <FSelect label="優先度" value={formCare.handover.priority} onChange={(v) => updCare("handover", { priority: v })} options={["通常", "重要"]} />
                    </div>
                    <div className="col-span-3">
                      <FTextarea label="申し送り" value={formCare.handover.notes} onChange={(v) => updCare("handover", { notes: v })} placeholder="次の担当者への申し送り..." />
                    </div>
                  </div>
                  <FTextarea label="利用者の状態" value={formCare.user_condition} onChange={(v) => setFormCare({ ...formCare, user_condition: v })} placeholder="訪問時の状態・様子..." rows={3} />
                  <FTextarea label="特記事項" value={formCare.notes} onChange={(v) => setFormCare({ ...formCare, notes: v })} placeholder="その他特記事項..." />
                  <FTextarea label="詳細報告" value={formCare.detailed_report} onChange={(v) => setFormCare({ ...formCare, detailed_report: v })} placeholder="詳細な報告内容..." rows={3} />
                </div>
              )}

              {/* 利用者確認 (署名) — フォーム最下部に常時表示 */}
              <section className="border-t border-gray-200 pt-4">
                <h3 className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-500">
                  <PenLine size={13} className="text-blue-600" />
                  利用者確認 (署名)
                </h3>
                <p className="mb-3 text-[11px] text-gray-500">
                  サービス内容を利用者または家族に確認いただきサインを取得します (任意)。
                  署名日時は保存時に自動記録されます。あとから一覧の「署名する」で取得することもできます。
                </p>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">
                      署名者名 (本人・家族名) {formSignature && <span className="text-red-500">*</span>}
                    </label>
                    <input
                      type="text"
                      value={formSignerName}
                      onChange={(e) => setFormSignerName(e.target.value)}
                      placeholder="本人 or 家族の氏名"
                      className={inputClass}
                    />
                  </div>
                  <SignaturePad value={formSignature} onChange={setFormSignature} disabled={saving} />
                </div>
              </section>
            </div>

            <div className="flex justify-end gap-3 border-t bg-gray-50 px-5 py-4">
              <button onClick={() => setShowForm(false)} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">キャンセル</button>
              <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors">
                {saving ? <><Loader2 size={15} className="animate-spin" /> 保存中...</> : <><Save size={15} /> 保存</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 電子署名 modal */}
      {signTarget && (
        <SignaturePadModal
          recordTable="kaigo_visit_records"
          recordId={signTarget.id}
          defaultSignerName={userName ?? undefined}
          onClose={() => setSignTarget(null)}
          onSubmit={async ({ signatureImagePath, signedAt, signerName }) => {
            const targetId = signTarget.id;
            // v2: path のみ保存 (URL は表示時に動的発行)。再署名時は v1 URL を null clear して整合性確保。
            const { error } = await supabase
              .from("kaigo_visit_records")
              .update({
                signature_image_path: signatureImagePath,
                signature_image_url: null,
                signed_at: signedAt,
                signer_name: signerName,
              })
              .eq("id", targetId);
            if (error) {
              toast.error("署名情報の保存に失敗: " + error.message);
              return;
            }
            toast.success("電子署名を保存しました");
            setRecords((prev) =>
              prev.map((r) =>
                r.id === targetId
                  ? {
                      ...r,
                      signature_image_path: signatureImagePath,
                      signature_image_url: null,
                      signed_at: signedAt,
                      signer_name: signerName,
                    }
                  : r
              )
            );
            setSignTarget(null);
          }}
        />
      )}
    </div>
  );
}

// ─── 印刷専用 View ─────────────────────────────────────────────────────────
function VisitPrintView({
  records,
  userName,
  signedUrlMap,
  headerLabel,
  addons,
}: {
  records: VisitRecord[];
  userName?: string;
  signedUrlMap: Map<string, string>;
  /** 表示タイトル (default: "サービス実施記録")。月次実績送付時は "2026年5月 訪問介護実績" 等を渡す。 */
  headerLabel?: string;
  /** 月次加算行 (初回/緊急時/生活機能向上)。月次実績送付スナップショット用 */
  addons?: MonthlyAddonItem[];
}) {
  const B = "1px solid #000";
  const cellBase: React.CSSProperties = {
    border: B,
    padding: "1mm 2mm",
    fontSize: "9pt",
    verticalAlign: "top",
    lineHeight: 1.3,
  };
  const thStyle: React.CSSProperties = {
    ...cellBase,
    textAlign: "center",
    fontWeight: "bold",
    background: "#fff",
  };
  const fmtSignedAt = (d: string | null | undefined) => {
    if (!d) return "";
    try {
      return format(parseISO(d), "yyyy/M/d HH:mm");
    } catch {
      return d;
    }
  };
  return (
    <div style={{ color: "#000" }}>
      <div style={{ textAlign: "center", fontSize: "14pt", fontWeight: "bold", letterSpacing: "0.2em", marginBottom: "3mm" }}>
        {headerLabel ?? "サービス実施記録"}
      </div>
      {userName && (
        <div style={{ fontSize: "10pt", marginBottom: "3mm", borderBottom: B, paddingBottom: "1mm" }}>
          利用者名　{userName}　殿
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <colgroup>
          <col style={{ width: "13%" }} />
          <col style={{ width: "11%" }} />
          <col style={{ width: "13%" }} />
          <col style={{ width: "15%" }} />
          <col style={{ width: "23%" }} />
          <col style={{ width: "25%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={thStyle}>訪問日</th>
            <th style={thStyle}>区分</th>
            <th style={thStyle}>時間</th>
            <th style={thStyle}>担当</th>
            <th style={thStyle}>援助内容</th>
            <th style={thStyle}>電子署名</th>
          </tr>
        </thead>
        <tbody>
          {records.map((rec) => {
            const careItems = getActiveCareItems(rec);
            return (
              <tr key={rec.id}>
                <td style={cellBase}>{formatVisitDate(rec.visit_date)}</td>
                <td style={cellBase}>{rec.service_type}</td>
                <td style={cellBase}>{formatTimeRange(rec.start_time, rec.end_time)}</td>
                <td style={cellBase}>{rec.staff_name ?? ""}</td>
                <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>
                  {careItems.length > 0 ? careItems.join("、") : ""}
                </td>
                <td style={{ ...cellBase, textAlign: "center" }}>
                  {(() => {
                    // v2: path 優先 (動的 signed URL) → v1 URL fallback
                    const printSrc = rec.signature_image_path
                      ? signedUrlMap.get(rec.signature_image_path) ?? null
                      : rec.signature_image_url;
                    if (!printSrc) {
                      return <span style={{ fontSize: "8pt", color: "#999" }}>未署名</span>;
                    }
                    return (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element -- 印刷用 Storage URL (next/image 不要) */}
                        <img
                          src={printSrc}
                          alt="電子署名"
                          style={{ display: "block", margin: "0 auto", maxHeight: "16mm", maxWidth: "50mm", height: "auto", width: "auto" }}
                        />
                        <span style={{ display: "block", fontSize: "7pt", marginTop: "0.5mm", color: "#333" }}>
                          {rec.signer_name && <>{rec.signer_name}<br /></>}
                          {rec.signed_at && fmtSignedAt(rec.signed_at)}
                        </span>
                      </>
                    );
                  })()}
                </td>
              </tr>
            );
          })}
          {/* 月次加算行 (kaigo_visit_month_addons 由来) */}
          {(addons ?? []).map((a) => (
            <tr key={`addon-${a.name}`}>
              <td style={{ ...cellBase, color: "#555" }}>—</td>
              <td style={{ ...cellBase, fontWeight: "bold" }}>加算</td>
              <td style={cellBase}>—</td>
              <td style={cellBase}></td>
              <td style={cellBase}>
                {a.name}
                {a.count > 1 ? `　× ${a.count}回` : ""}
              </td>
              <td style={cellBase}></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
