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

type FormData = {
  visit_date: string;
  staff_id: string;
  service_type: ServiceType;
  start_time: string;
  end_time: string;
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
  temperature: string;
  bp_sys: string;
  bp_dia: string;
  pulse: string;
  // notes
  user_condition: string;
  notes: string;
};

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

const BODY_CARE_ITEMS: { key: keyof FormData; label: string }[] = [
  { key: "care_excretion", label: "排泄介助" },
  { key: "care_meal", label: "食事介助" },
  { key: "care_bath", label: "入浴介助" },
  { key: "care_wipe", label: "清拭" },
  { key: "care_positioning", label: "体位変換" },
  { key: "care_transfer", label: "移動介助" },
  { key: "care_dressing", label: "更衣介助" },
  { key: "care_oral", label: "口腔ケア" },
  { key: "care_medication", label: "服薬介助" },
];

const LIVING_SUPPORT_ITEMS: { key: keyof FormData; label: string }[] = [
  { key: "support_cooking", label: "調理" },
  { key: "support_laundry", label: "洗濯" },
  { key: "support_cleaning", label: "掃除" },
  { key: "support_shopping", label: "買物" },
  { key: "support_trash", label: "ゴミ出し" },
  { key: "support_clothing", label: "衣類の整理" },
];

const EMPTY_FORM: FormData = {
  visit_date: format(new Date(), "yyyy-MM-dd"),
  staff_id: "",
  service_type: "身体介護",
  start_time: "",
  end_time: "",
  care_excretion: false,
  care_meal: false,
  care_bath: false,
  care_wipe: false,
  care_positioning: false,
  care_transfer: false,
  care_dressing: false,
  care_oral: false,
  care_medication: false,
  support_cooking: false,
  support_laundry: false,
  support_cleaning: false,
  support_shopping: false,
  support_trash: false,
  support_clothing: false,
  temperature: "",
  bp_sys: "",
  bp_dia: "",
  pulse: "",
  user_condition: "",
  notes: "",
};

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
  const crd = (record as any).care_record_data;  // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!crd || typeof crd !== "object") {
    // Legacy display
    return (
      <div className="space-y-3">
        {(record.temperature || record.bp_sys || record.pulse) && (
          <div>
            <p className="mb-1 text-xs font-semibold text-gray-600">バイタル</p>
            <div className="flex flex-wrap gap-4 text-sm text-gray-700">
              {record.temperature && <span>体温: <strong>{record.temperature}℃</strong></span>}
              {record.bp_sys && record.bp_dia && <span>血圧: <strong>{record.bp_sys}/{record.bp_dia}</strong></span>}
              {record.pulse && <span>脈拍: <strong>{record.pulse} bpm</strong></span>}
            </div>
          </div>
        )}
        {record.user_condition && (
          <div><p className="mb-1 text-xs font-semibold text-gray-600">利用者の状態</p><p className="text-sm text-gray-700 whitespace-pre-wrap">{record.user_condition}</p></div>
        )}
        {record.notes && (
          <div><p className="mb-1 text-xs font-semibold text-gray-600">特記事項</p><p className="text-sm text-gray-700 whitespace-pre-wrap">{record.notes}</p></div>
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
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
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
  const setField = <K extends keyof FormData>(key: K, value: FormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleBool = (key: keyof FormData) => {
    setForm((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleOpenForm = () => {
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!selectedUserId) return;
    if (!form.visit_date) { toast.error("訪問日を入力してください"); return; }

    setSaving(true);
    const payload = {
      user_id: selectedUserId,
      visit_date: form.visit_date,
      staff_id: form.staff_id || null,
      service_type: form.service_type,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      care_excretion: form.care_excretion,
      care_meal: form.care_meal,
      care_bath: form.care_bath,
      care_wipe: form.care_wipe,
      care_positioning: form.care_positioning,
      care_transfer: form.care_transfer,
      care_dressing: form.care_dressing,
      care_oral: form.care_oral,
      care_medication: form.care_medication,
      support_cooking: form.support_cooking,
      support_laundry: form.support_laundry,
      support_cleaning: form.support_cleaning,
      support_shopping: form.support_shopping,
      support_trash: form.support_trash,
      support_clothing: form.support_clothing,
      temperature: form.temperature ? parseFloat(form.temperature) : null,
      bp_sys: form.bp_sys ? parseInt(form.bp_sys) : null,
      bp_dia: form.bp_dia ? parseInt(form.bp_dia) : null,
      pulse: form.pulse ? parseInt(form.pulse) : null,
      user_condition: form.user_condition || null,
      notes: form.notes || null,
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

      {/* Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-start justify-end overflow-auto bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl flex flex-col max-h-[calc(100vh-2rem)]">
            {/* Modal header */}
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="text-base font-bold text-gray-900">サービス実施記録 — 新規</h2>
              <button
                onClick={() => setShowForm(false)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {/* 基本情報 */}
              <section>
                <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-gray-500">基本情報</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="mb-1 block text-xs font-medium text-gray-700">訪問日 <span className="text-red-500">*</span></label>
                    <input
                      type="date"
                      value={form.visit_date}
                      onChange={(e) => setField("visit_date", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">開始時刻</label>
                    <input
                      type="time"
                      value={form.start_time}
                      onChange={(e) => setField("start_time", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">終了時刻</label>
                    <input
                      type="time"
                      value={form.end_time}
                      onChange={(e) => setField("end_time", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="mb-1 block text-xs font-medium text-gray-700">サービス種別</label>
                    <select
                      value={form.service_type}
                      onChange={(e) => setField("service_type", e.target.value as ServiceType)}
                      className={inputClass}
                    >
                      {SERVICE_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="mb-1 block text-xs font-medium text-gray-700">担当職員</label>
                    <select
                      value={form.staff_id}
                      onChange={(e) => setField("staff_id", e.target.value)}
                      className={inputClass}
                    >
                      <option value="">— 選択してください —</option>
                      {staffList.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </section>

              {/* 身体介護 */}
              <section>
                <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-gray-500">身体介護</h3>
                <div className="grid grid-cols-3 gap-2">
                  {BODY_CARE_ITEMS.map(({ key, label }) => (
                    <label
                      key={key}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        form[key]
                          ? "border-blue-400 bg-blue-50 text-blue-700"
                          : "border-gray-200 text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={form[key] as boolean}
                        onChange={() => toggleBool(key)}
                        className="accent-blue-600"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </section>

              {/* 生活援助 */}
              <section>
                <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-gray-500">生活援助</h3>
                <div className="grid grid-cols-3 gap-2">
                  {LIVING_SUPPORT_ITEMS.map(({ key, label }) => (
                    <label
                      key={key}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        form[key]
                          ? "border-green-400 bg-green-50 text-green-700"
                          : "border-gray-200 text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={form[key] as boolean}
                        onChange={() => toggleBool(key)}
                        className="accent-green-600"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </section>

              {/* バイタル */}
              <section>
                <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-gray-500">バイタルサイン</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">体温 (℃)</label>
                    <input
                      type="number"
                      step="0.1"
                      min="33"
                      max="42"
                      placeholder="36.5"
                      value={form.temperature}
                      onChange={(e) => setField("temperature", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">脈拍 (bpm)</label>
                    <input
                      type="number"
                      min="0"
                      max="250"
                      placeholder="72"
                      value={form.pulse}
                      onChange={(e) => setField("pulse", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">収縮期血圧 (mmHg)</label>
                    <input
                      type="number"
                      min="0"
                      max="300"
                      placeholder="120"
                      value={form.bp_sys}
                      onChange={(e) => setField("bp_sys", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">拡張期血圧 (mmHg)</label>
                    <input
                      type="number"
                      min="0"
                      max="200"
                      placeholder="80"
                      value={form.bp_dia}
                      onChange={(e) => setField("bp_dia", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
              </section>

              {/* 状態・特記 */}
              <section>
                <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-gray-500">状態・特記事項</h3>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">利用者の状態</label>
                    <textarea
                      rows={3}
                      placeholder="訪問時の利用者の状態・様子を記入してください"
                      value={form.user_condition}
                      onChange={(e) => setField("user_condition", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">特記事項</label>
                    <textarea
                      rows={3}
                      placeholder="申し送り事項・連絡事項など"
                      value={form.notes}
                      onChange={(e) => setField("notes", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
              </section>
            </div>

            {/* Modal footer */}
            <div className="flex justify-end gap-3 border-t bg-gray-50 px-5 py-4">
              <button
                onClick={() => setShowForm(false)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
              >
                {saving ? (
                  <><Loader2 size={15} className="animate-spin" /> 保存中...</>
                ) : (
                  <><Save size={15} /> 保存</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
