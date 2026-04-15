"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  Plus,
  X,
  Save,
  Loader2,
  ClipboardList,
  Clock,
  User,
  Thermometer,
  Heart,
  ChevronDown,
  ChevronUp,
  CalendarDays,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { TemplatePicker } from "@/components/templates/template-picker";
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
  staff_id: string | null;
  staff_name?: string | null;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

  // Helper for rendering sections
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="mb-3">
      <p className="mb-1.5 text-xs font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded">{title}</p>
      <div className="pl-2 text-sm text-gray-700 space-y-0.5">{children}</div>
    </div>
  );
  const Row = ({ label, value }: { label: string; value: string | number | null | undefined }) => {
    if (!value && value !== 0) return null;
    return <div className="flex gap-2"><span className="text-gray-500 shrink-0 w-20">{label}</span><span className="font-medium">{value}</span></div>;
  };
  const Tags = ({ items }: { items: { label: string; active: boolean }[] }) => {
    const active = items.filter((i) => i.active);
    if (active.length === 0) return null;
    return <div className="flex flex-wrap gap-1">{active.map((i) => <span key={i.label} className="rounded bg-blue-50 text-blue-700 px-2 py-0.5 text-xs font-medium">{i.label}</span>)}</div>;
  };

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

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function VisitRecordsPage() {
  const supabase = createClient();

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [records, setRecords] = useState<VisitRecord[]>([]);
  const [staffList, setStaffList] = useState<KaigoStaff[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formBase, setFormBase] = useState({ visit_date: format(new Date(), "yyyy-MM-dd"), staff_id: "", service_type: "身体介護" as ServiceType, start_time: "", end_time: "" });
  const [formCare, setFormCare] = useState<CareData>(emptyCareData());
  const [formSection, setFormSection] = useState<string | null>("pre_check");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Fetch staff list once
  useEffect(() => {
    const fetchStaff = async () => {
      const { data } = await supabase
        .from("kaigo_staff")
        .select("id, name")
        .order("name");
      setStaffList(data || []);
    };
    fetchStaff();
  }, []);

  // Fetch records when user changes
  const fetchRecords = useCallback(async (userId: string) => {
    setLoading(true);
    setRecords([]);
    const { data, error } = await supabase
      .from("kaigo_visit_records")
      .select("*, kaigo_staff(name)")
      .eq("user_id", userId)
      .order("visit_date", { ascending: false })
      .order("start_time", { ascending: false });
    if (error) {
      toast.error("記録の取得に失敗しました");
    } else {
      const mapped = (data || []).map((r: any) => ({
        ...r,
        staff_name: r.kaigo_staff?.name ?? null,
      }));
      setRecords(mapped);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (selectedUserId) {
      fetchRecords(selectedUserId);
      setShowForm(false);
      setExpandedId(null);
    }
  }, [selectedUserId, fetchRecords]);

  // Form helpers
  const handleOpenForm = () => {
    setFormBase({ visit_date: format(new Date(), "yyyy-MM-dd"), staff_id: "", service_type: "身体介護", start_time: "", end_time: "" });
    setFormCare(emptyCareData());
    setFormSection("pre_check");
    setShowForm(true);
  };

  const updCare = <K extends keyof CareData>(key: K, val: Partial<CareData[K]>) => {
    setFormCare((prev) => ({ ...prev, [key]: typeof prev[key] === "object" && !Array.isArray(prev[key]) ? { ...(prev[key] as Record<string, unknown>), ...val } : val }));
  };

  const handleSave = async () => {
    if (!selectedUserId) return;
    if (!formBase.visit_date) { toast.error("訪問日を入力してください"); return; }

    setSaving(true);
    const payload = {
      user_id: selectedUserId,
      visit_date: formBase.visit_date,
      staff_id: formBase.staff_id || null,
      service_type: formBase.service_type,
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

    const { error } = await supabase.from("kaigo_visit_records").insert(payload);
    setSaving(false);

    if (error) {
      toast.error("保存に失敗しました: " + error.message);
    } else {
      toast.success("サービス実施記録を保存しました");
      setShowForm(false);
      fetchRecords(selectedUserId);
    }
  };

  // Section toggle for form
  const isFormOpen = (id: string) => formSection === id;
  const toggleFormSection = (id: string) => setFormSection(formSection === id ? null : id);

  // Reusable form components
  const FSelect = ({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) => (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">選択してください</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
  const FInput = ({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) => (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputClass} />
    </div>
  );
  const FTextarea = ({ label, value, onChange, placeholder, rows = 2 }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) => (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-xs font-medium text-gray-700">{label}</label>
        <TemplatePicker category="visit_record" currentText={value} onInsert={onChange} />
      </div>
      <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputClass} />
    </div>
  );
  const FCheck = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) => (
    <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${checked ? "border-blue-400 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
      <input type="checkbox" checked={checked} onChange={() => onChange(!checked)} className="accent-blue-600" />
      {label}
    </label>
  );
  const FSectionBtn = ({ id, label }: { id: string; label: string }) => (
    <button onClick={() => toggleFormSection(id)} className="flex items-center justify-between w-full px-3 py-2.5 bg-gray-100 rounded-lg text-sm font-bold text-gray-700 hover:bg-gray-200 transition-colors">
      {label}
      <ChevronDown size={14} className={`text-gray-400 transition-transform ${isFormOpen(id) ? "rotate-180" : ""}`} />
    </button>
  );

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* Sidebar */}
      <UserSidebar
        selectedUserId={selectedUserId}
        onSelectUser={setSelectedUserId}
      />

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b bg-white px-6 py-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">サービス実施記録</h1>
            <p className="mt-0.5 text-xs text-gray-500">訪問介護サービスの実施内容を記録します</p>
          </div>
          {selectedUserId && (
            <button
              onClick={handleOpenForm}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
            >
              <Plus size={16} />
              新規記録
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto bg-gray-50 p-6">
          {!selectedUserId ? (
            <div className="flex h-48 items-center justify-center text-sm text-gray-400">
              <div className="text-center">
                <User size={32} className="mx-auto mb-2 text-gray-300" />
                <p>左の利用者一覧から対象者を選択してください</p>
              </div>
            </div>
          ) : loading ? (
            <div className="flex h-48 items-center justify-center text-sm text-gray-400">
              <Loader2 size={20} className="animate-spin mr-2" />
              読込中...
            </div>
          ) : records.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-gray-400">
              <div className="text-center">
                <ClipboardList size={32} className="mx-auto mb-2 text-gray-300" />
                <p>記録がありません</p>
                <button
                  onClick={handleOpenForm}
                  className="mt-3 text-blue-600 hover:underline text-xs"
                >
                  新規記録を作成する
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {records.map((rec) => {
                const colors = SERVICE_TYPE_COLORS[rec.service_type] ?? SERVICE_TYPE_COLORS["身体介護"];
                const isExpanded = expandedId === rec.id;
                const careItems = getActiveCareItems(rec);
                const duration = calcDuration(rec.start_time, rec.end_time);
                return (
                  <div
                    key={rec.id}
                    className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden"
                  >
                    {/* Card header */}
                    <button
                      className="flex w-full items-start gap-4 p-4 text-left hover:bg-gray-50 transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : rec.id)}
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
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Modal — 22カテゴリ対応の新規記録フォーム */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-start justify-end overflow-auto bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl flex flex-col max-h-[calc(100vh-2rem)]">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="text-base font-bold text-gray-900">サービス実施記録 — 新規</h2>
              <button onClick={() => setShowForm(false)} className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"><X size={18} /></button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
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
              <FSectionBtn id="pre_check" label="事前チェック" />
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
              <FSectionBtn id="vitals" label="バイタルサイン・身体測定" />
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
              <FSectionBtn id="excretion" label="排泄介助" />
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
              <FSectionBtn id="hydration" label="水分摂取" />
              {isFormOpen("hydration") && (
                <div className="space-y-2 pl-1">
                  <FInput label="飲み物の種類" value={formCare.hydration.drink_type} onChange={(v) => updCare("hydration", { drink_type: v, done: true })} placeholder="お茶、水等" />
                  <FInput label="量 (ml)" value={formCare.hydration.amount} onChange={(v) => updCare("hydration", { amount: v })} placeholder="200" type="number" />
                  <FSelect label="とろみ" value={formCare.hydration.thickener} onChange={(v) => updCare("hydration", { thickener: v })} options={["なし", "薄い", "中間", "濃い"]} />
                </div>
              )}

              {/* 5. 食事 */}
              <FSectionBtn id="meal" label="食事介助" />
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
              <FSectionBtn id="oral_care" label="口腔ケア" />
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
              <FSectionBtn id="bathing" label="清拭・入浴" />
              {isFormOpen("bathing") && (
                <div className="space-y-2 pl-1">
                  <FSelect label="入浴種類" value={formCare.bathing.bath_type} onChange={(v) => updCare("bathing", { bath_type: v, done: true })} options={["一般浴", "シャワー浴", "清拭", "足浴", "手浴", "部分浴"]} />
                  <FSelect label="自立度" value={formCare.bathing.independence} onChange={(v) => updCare("bathing", { independence: v })} options={["自立", "見守り", "一部介助", "全介助"]} />
                  <FSelect label="皮膚状態" value={formCare.bathing.skin_condition} onChange={(v) => updCare("bathing", { skin_condition: v })} options={["異常なし", "発赤", "褥瘡", "湿疹", "乾燥", "傷", "その他"]} />
                </div>
              )}

              {/* 8. 身体整容 */}
              <FSectionBtn id="grooming" label="身体整容" />
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
              <FSectionBtn id="dressing" label="更衣介助" />
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
              <FSectionBtn id="positioning" label="体位変換・移動" />
              {isFormOpen("positioning") && (
                <div className="space-y-2 pl-1">
                  <FSelect label="体位" value={formCare.positioning.position_type} onChange={(v) => updCare("positioning", { position_type: v, done: true })} options={["仰臥位", "側臥位", "座位", "半座位", "起立位", "その他"]} />
                  <FSelect label="移動手段" value={formCare.positioning.mobility_device} onChange={(v) => updCare("positioning", { mobility_device: v })} options={["徒歩", "杖", "歩行器", "車椅子", "ストレッチャー", "その他"]} />
                </div>
              )}

              {/* 11. 服薬 */}
              <FSectionBtn id="medication" label="服薬介助" />
              {isFormOpen("medication") && (
                <div className="space-y-2 pl-1">
                  <FSelect label="投与方法" value={formCare.medication.med_type} onChange={(v) => updCare("medication", { med_type: v, done: true })} options={["内服", "外用", "点眼", "吸入", "座薬", "注射", "その他"]} />
                  <FCheck label="服薬確認済み" checked={formCare.medication.confirmed} onChange={(v) => updCare("medication", { confirmed: v })} />
                </div>
              )}

              {/* 12. 通院・外出 */}
              <FSectionBtn id="outing" label="通院・外出介助" />
              {isFormOpen("outing") && (
                <div className="space-y-2 pl-1">
                  <FSelect label="種類" value={formCare.outing.outing_type} onChange={(v) => updCare("outing", { outing_type: v, done: true })} options={["通院", "買物同行", "散歩", "外出付添", "その他"]} />
                  <FSelect label="移動手段" value={formCare.outing.transport} onChange={(v) => updCare("outing", { transport: v })} options={["徒歩", "車", "公共交通", "車椅子", "その他"]} />
                </div>
              )}

              {/* 13. 起床・就寝 */}
              <FSectionBtn id="wake_sleep" label="起床・就寝介助" />
              {isFormOpen("wake_sleep") && (
                <div className="grid grid-cols-3 gap-2 pl-1">
                  <FCheck label="起床介助" checked={formCare.wake_sleep.wake_up} onChange={(v) => updCare("wake_sleep", { wake_up: v, done: true })} />
                  <FCheck label="就寝介助" checked={formCare.wake_sleep.go_to_bed} onChange={(v) => updCare("wake_sleep", { go_to_bed: v, done: true })} />
                  <FCheck label="ベッドメイク" checked={formCare.wake_sleep.bed_making} onChange={(v) => updCare("wake_sleep", { bed_making: v, done: true })} />
                </div>
              )}

              {/* 14. 医療的ケア */}
              <FSectionBtn id="medical_care" label="医療的ケア" />
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
              <FSectionBtn id="independence" label="自立支援" />
              {isFormOpen("independence") && (
                <div className="grid grid-cols-2 gap-2 pl-1">
                  <FCheck label="運動・リハビリ" checked={formCare.independence_support.exercise} onChange={(v) => updCare("independence_support", { exercise: v, done: true })} />
                  <FCheck label="認知機能訓練" checked={formCare.independence_support.cognitive} onChange={(v) => updCare("independence_support", { cognitive: v, done: true })} />
                  <FCheck label="コミュニケーション" checked={formCare.independence_support.communication} onChange={(v) => updCare("independence_support", { communication: v, done: true })} />
                  <FCheck label="社会参加" checked={formCare.independence_support.social} onChange={(v) => updCare("independence_support", { social: v, done: true })} />
                </div>
              )}

              {/* 16. 生活援助 */}
              <FSectionBtn id="living" label="生活援助" />
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
              <FSectionBtn id="exit_check" label="退出確認" />
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
              <FSectionBtn id="text_sections" label="経過記録・申し送り・詳細報告" />
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
    </div>
  );
}
