"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { Plus, Copy, Trash2, Save, X } from "lucide-react";

// ─── 所得区分 ─────────────────────────────────────────────────────────────────

const INCOME_CATEGORIES = [
  "生活保護",
  "低所得1",
  "低所得2",
  "一般1（一般）",
  "一般2",
] as const;
type IncomeCategoryName = (typeof INCOME_CATEGORIES)[number];

/** 所得区分ごとの 利用者負担上限月額（円） */
const INCOME_CATEGORY_CAP: Record<IncomeCategoryName, number> = {
  生活保護: 0,
  低所得1: 0,
  低所得2: 0,
  "一般1（一般）": 9300,
  一般2: 37200,
};

// ─── 型定義 ───────────────────────────────────────────────────────────────────

/** 事業者記入欄の1スロット分のデータ */
type BusinessEntry = {
  slot: number;                  // 1-6: 通常スロット、7-9: 予備1-3
  business_name: string;         // 事業所略称
  business_no: string;           // 番号
  contract_date: string | null;  // 契約日
  contract_type: "新規契約" | "契約変更" | "";  // 契約区分
  service_content: string;       // サービス内容
  contract_amount_hours: number; // 契約支給量(時間)
  contract_amount_minutes: number;
  service_end_date: string | null;          // 提供終了日
  end_type: string;                          // 終了区分
  pre_provided_hours: number;                // 提供終了月中の終了日までの既提供量(時間)
  pre_provided_minutes: number;
  note: string;
};

const TOTAL_BUSINESS_SLOTS = 9; // 1-6 + 予備1-3

const slotLabel = (slot: number) =>
  slot <= 6 ? String(slot) : `予備${slot - 6}`;

const emptyEntry = (slot: number): BusinessEntry => ({
  slot,
  business_name: "",
  business_no: slot <= 6 ? String(slot) : "",
  contract_date: null,
  contract_type: "",
  service_content: "",
  contract_amount_hours: 0,
  contract_amount_minutes: 0,
  service_end_date: null,
  end_type: "",
  pre_provided_hours: 0,
  pre_provided_minutes: 0,
  note: "",
});

/** 既存スロットを9個に正規化（不足分は空で埋める） */
function normalizeBusinessEntries(raw: unknown): BusinessEntry[] {
  const list = Array.isArray(raw) ? (raw as Partial<BusinessEntry>[]) : [];
  return Array.from({ length: TOTAL_BUSINESS_SLOTS }, (_, i) => {
    const slot = i + 1;
    const found = list.find((e) => e?.slot === slot);
    return { ...emptyEntry(slot), ...(found ?? {}) };
  });
}

/** スロットに何か入力があるか判定（ボタンの状態表示用） */
function hasEntryContent(e: BusinessEntry): boolean {
  return !!(
    e.business_name ||
    e.contract_date ||
    e.service_content ||
    e.contract_amount_hours ||
    e.contract_amount_minutes ||
    e.service_end_date ||
    e.note
  );
}

type DisabilityCert = {
  id: string;
  user_id: string;
  recipient_number: string | null;
  issue_date: string | null;
  municipality_code: string | null;
  municipality_name: string | null;
  period_start: string | null;
  period_end: string | null;
  is_applying: boolean;
  support_level: number | null;
  is_deafblind: boolean;
  is_severely_disabled: boolean;
  is_post_h30_apr: boolean;
  is_short_multiple_visit: boolean;
  is_special_area: boolean;
  body_care_hours: number;
  body_care_minutes: number;
  transfer_assist_count: number;
  housework_hours: number;
  housework_minutes: number;
  hospital_escort_hours: number;
  hospital_escort_minutes: number;
  hospital_escort_with_body_hours: number;
  hospital_escort_with_body_minutes: number;
  accompany_hours: number;
  accompany_minutes: number;
  accompany_with_body_hours: number;
  accompany_with_body_minutes: number;
  behavior_support_hours: number;
  behavior_support_minutes: number;
  severe_inclusive_units: number;
  severe_visit_inclusive_hours: number;
  severe_visit_inclusive_minutes: number;
  severe_visit_lv6_hours: number;
  severe_visit_lv6_minutes: number;
  severe_visit_other_hours: number;
  severe_visit_other_minutes: number;
  burden_rate: number;
  income_category: string | null;
  monthly_burden_cap: number;
  is_swc_exemption: boolean;
  is_cap_reach_expected: boolean;
  monthly_burden_cap_reduced: number;
  is_household_cap_management: boolean;
  cap_management_office: string | null;
  municipality_amount: number;
  business_entries: BusinessEntry[];
  reserve1: string | null;
  reserve2: string | null;
  reserve3: string | null;
  memo: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type FormData = Omit<DisabilityCert, "id" | "user_id" | "created_at" | "updated_at">;

const EMPTY_FORM: FormData = {
  recipient_number: "",
  issue_date: "",
  municipality_code: "",
  municipality_name: "",
  period_start: "",
  period_end: "",
  is_applying: false,
  support_level: null,
  is_deafblind: false,
  is_severely_disabled: false,
  is_post_h30_apr: false,
  is_short_multiple_visit: false,
  is_special_area: false,
  body_care_hours: 0,
  body_care_minutes: 0,
  transfer_assist_count: 0,
  housework_hours: 0,
  housework_minutes: 0,
  hospital_escort_hours: 0,
  hospital_escort_minutes: 0,
  hospital_escort_with_body_hours: 0,
  hospital_escort_with_body_minutes: 0,
  accompany_hours: 0,
  accompany_minutes: 0,
  accompany_with_body_hours: 0,
  accompany_with_body_minutes: 0,
  behavior_support_hours: 0,
  behavior_support_minutes: 0,
  severe_inclusive_units: 0,
  severe_visit_inclusive_hours: 0,
  severe_visit_inclusive_minutes: 0,
  severe_visit_lv6_hours: 0,
  severe_visit_lv6_minutes: 0,
  severe_visit_other_hours: 0,
  severe_visit_other_minutes: 0,
  burden_rate: 10,
  income_category: "",
  monthly_burden_cap: 0,
  is_swc_exemption: false,
  is_cap_reach_expected: false,
  monthly_burden_cap_reduced: 0,
  is_household_cap_management: false,
  cap_management_office: "",
  municipality_amount: 0,
  business_entries: Array.from({ length: TOTAL_BUSINESS_SLOTS }, (_, i) => emptyEntry(i + 1)),
  reserve1: "",
  reserve2: "",
  reserve3: "",
  memo: "",
  status: "active",
};

// ─── 共通コンポーネント ───────────────────────────────────────────────────────

const inputCls =
  "rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-blue-500 bg-blue-50 text-blue-700"
          : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
      }`}
    >
      {children}
    </button>
  );
}

function HoursMinutesInput({
  hours,
  minutes,
  onChange,
}: {
  hours: number;
  minutes: number;
  onChange: (h: number, m: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        min={0}
        value={hours}
        onChange={(e) => onChange(Number(e.target.value || 0), minutes)}
        className={`${inputCls} w-16 text-right`}
      />
      <span className="text-xs text-gray-500">時間</span>
      <input
        type="number"
        min={0}
        max={59}
        value={minutes}
        onChange={(e) => onChange(hours, Number(e.target.value || 0))}
        className={`${inputCls} w-14 text-right`}
      />
      <span className="text-xs text-gray-500">分</span>
    </div>
  );
}

function CountInput({
  value,
  unit,
  onChange,
}: {
  value: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Number(e.target.value || 0))}
        className={`${inputCls} w-16 text-right`}
      />
      <span className="text-xs text-gray-500">{unit}</span>
    </div>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-2 py-1">
      <span className="text-xs text-gray-600">{label}</span>
      <div>{children}</div>
    </div>
  );
}

// ─── メインページ ─────────────────────────────────────────────────────────────

export default function UserDisabilityPage() {
  const params = useParams<{ id: string }>();
  const userId = params?.id;
  const supabase = createClient();

  const [records, setRecords] = useState<DisabilityCert[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isNew, setIsNew] = useState(false);
  // 事業者記入欄モーダル: 編集中スロット番号 (null = 閉じている)
  const [editingSlot, setEditingSlot] = useState<number | null>(null);

  // ─── データ読み込み ──────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("kaigo_disability_certifications")
      .select("*")
      .eq("user_id", userId)
      .order("period_start", { ascending: false, nullsFirst: false });
    if (error) {
      toast.error("読み込みに失敗: " + error.message);
      setLoading(false);
      return;
    }
    const list = (data || []) as DisabilityCert[];
    // business_entries の不足分を9スロットに補完（1-6 + 予備1-3）
    list.forEach((r) => {
      r.business_entries = normalizeBusinessEntries(r.business_entries);
    });
    setRecords(list);
    if (list.length > 0) {
      setSelectedId(list[0].id);
      setForm(recordToForm(list[0]));
      setIsNew(false);
    } else {
      setSelectedId(null);
      setForm(EMPTY_FORM);
      setIsNew(false);
    }
    setLoading(false);
  }, [userId, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  function recordToForm(r: DisabilityCert): FormData {
    const { id: _id, user_id: _u, created_at: _c, updated_at: _up, ...rest } = r;
    return rest;
  }

  // ─── アクション ──────────────────────────────────────────────────────────
  const handleNew = () => {
    setSelectedId(null);
    setForm(EMPTY_FORM);
    setIsNew(true);
  };

  const handleCopy = () => {
    if (!selectedId) {
      toast.error("複写する受給者証を選択してください");
      return;
    }
    setSelectedId(null);
    setIsNew(true);
    toast.info("内容を複写しました。新規として保存してください");
  };

  const handleDelete = async () => {
    if (!selectedId) {
      toast.error("削除する受給者証を選択してください");
      return;
    }
    if (!confirm("この受給者証を削除します。よろしいですか？")) return;
    const { error } = await supabase
      .from("kaigo_disability_certifications")
      .delete()
      .eq("id", selectedId);
    if (error) {
      toast.error("削除失敗: " + error.message);
      return;
    }
    toast.success("削除しました");
    load();
  };

  const handleSave = async () => {
    if (!userId) return;
    setSaving(true);
    try {
      const payload = {
        ...form,
        user_id: userId,
        // 空文字の日付は null に
        issue_date: form.issue_date || null,
        period_start: form.period_start || null,
        period_end: form.period_end || null,
      };
      if (selectedId && !isNew) {
        const { error } = await supabase
          .from("kaigo_disability_certifications")
          .update(payload)
          .eq("id", selectedId);
        if (error) throw error;
        toast.success("保存しました");
      } else {
        const { error } = await supabase
          .from("kaigo_disability_certifications")
          .insert(payload);
        if (error) throw error;
        toast.success("登録しました");
      }
      await load();
    } catch (err: unknown) {
      toast.error(
        "保存失敗: " + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const handleSelectRecord = (id: string) => {
    const rec = records.find((r) => r.id === id);
    if (!rec) return;
    setSelectedId(id);
    setForm(recordToForm(rec));
    setIsNew(false);
  };

  // ─── 部分更新ヘルパー ────────────────────────────────────────────────────
  const upd = <K extends keyof FormData>(key: K, value: FormData[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const updEntry = <K extends keyof BusinessEntry>(
    slot: number,
    field: K,
    value: BusinessEntry[K],
  ) => {
    setForm((f) => ({
      ...f,
      business_entries: f.business_entries.map((e) =>
        e.slot === slot ? { ...e, [field]: value } : e
      ),
    }));
  };

  /** 編集中スロットのデータをクリア（モーダルから呼び出す削除ボタン用） */
  const clearEntry = (slot: number) => {
    setForm((f) => ({
      ...f,
      business_entries: f.business_entries.map((e) =>
        e.slot === slot ? emptyEntry(slot) : e
      ),
    }));
  };

  if (loading) {
    return (
      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <p className="text-sm text-gray-400">読み込み中...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ─── ツールバー ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-white p-3 shadow-sm">
        <div className="flex items-center gap-2">
          <button
            onClick={handleNew}
            className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100"
          >
            <Plus size={14} /> 新規
          </button>
          <button
            onClick={handleCopy}
            disabled={!selectedId}
            className="inline-flex items-center gap-1.5 rounded-md border border-green-300 bg-green-50 px-3 py-1.5 text-sm font-medium text-green-700 hover:bg-green-100 disabled:opacity-50"
          >
            <Copy size={14} /> 複写
          </button>
          <button
            onClick={handleDelete}
            disabled={!selectedId}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            <Trash2 size={14} /> 削除
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Save size={14} /> 保存
          </button>
        </div>

        {records.length > 0 && (
          <select
            value={selectedId ?? ""}
            onChange={(e) => handleSelectRecord(e.target.value)}
            className={`${inputCls} min-w-[280px]`}
          >
            <option value="">— 新規入力中 —</option>
            {records.map((r) => (
              <option key={r.id} value={r.id}>
                {r.recipient_number || "(番号未設定)"} /{" "}
                {r.period_start ? format(parseISO(r.period_start), "yyyy/MM/dd") : "—"}
                {" ~ "}
                {r.period_end ? format(parseISO(r.period_end), "yyyy/MM/dd") : "—"}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* ─── 受給者証 ──────────────────────────────────────────────── */}
      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <h3 className="mb-3 border-b pb-2 text-sm font-bold text-gray-800">受給者証</h3>
        <div className="grid grid-cols-1 gap-y-1 lg:grid-cols-2 lg:gap-x-6">
          <FieldRow label="受給者証番号">
            <input
              type="text"
              value={form.recipient_number ?? ""}
              onChange={(e) => upd("recipient_number", e.target.value)}
              className={`${inputCls} w-48`}
            />
          </FieldRow>
          <FieldRow label="交付年月日">
            <input
              type="date"
              value={form.issue_date ?? ""}
              onChange={(e) => upd("issue_date", e.target.value)}
              className={inputCls}
            />
          </FieldRow>
          <FieldRow label="支給市町村">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="コード"
                value={form.municipality_code ?? ""}
                onChange={(e) => upd("municipality_code", e.target.value)}
                className={`${inputCls} w-24`}
              />
              <input
                type="text"
                placeholder="市町村名"
                value={form.municipality_name ?? ""}
                onChange={(e) => upd("municipality_name", e.target.value)}
                className={`${inputCls} flex-1`}
              />
            </div>
          </FieldRow>
          <FieldRow label="期間">
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={form.period_start ?? ""}
                onChange={(e) => upd("period_start", e.target.value)}
                className={inputCls}
              />
              <span className="text-xs text-gray-500">〜</span>
              <input
                type="date"
                value={form.period_end ?? ""}
                onChange={(e) => upd("period_end", e.target.value)}
                className={inputCls}
              />
            </div>
          </FieldRow>
          <FieldRow label="障害支援区分">
            <select
              value={form.support_level ?? ""}
              onChange={(e) =>
                upd(
                  "support_level",
                  e.target.value === "" ? null : Number(e.target.value)
                )
              }
              className={`${inputCls} w-24`}
            >
              <option value="">未設定</option>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  区分 {n}
                </option>
              ))}
            </select>
          </FieldRow>
        </div>

        {/* フラグ群 */}
        <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
          <ToggleButton
            active={form.is_applying}
            onClick={() => upd("is_applying", !form.is_applying)}
          >
            申請中
          </ToggleButton>
          <ToggleButton
            active={form.is_deafblind}
            onClick={() => upd("is_deafblind", !form.is_deafblind)}
          >
            盲ろう者
          </ToggleButton>
          <ToggleButton
            active={form.is_post_h30_apr}
            onClick={() => upd("is_post_h30_apr", !form.is_post_h30_apr)}
          >
            H30/4以降支給決定
          </ToggleButton>
          <ToggleButton
            active={form.is_severely_disabled}
            onClick={() => upd("is_severely_disabled", !form.is_severely_disabled)}
          >
            著しく重度の者
          </ToggleButton>
          <ToggleButton
            active={form.is_short_multiple_visit}
            onClick={() => upd("is_short_multiple_visit", !form.is_short_multiple_visit)}
          >
            短時間複数訪問
          </ToggleButton>
          <ToggleButton
            active={form.is_special_area}
            onClick={() => upd("is_special_area", !form.is_special_area)}
          >
            特別地域加算
          </ToggleButton>
        </div>
      </div>

      {/* ─── 支給量 ──────────────────────────────────────────────── */}
      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <h3 className="mb-3 border-b pb-2 text-sm font-bold text-gray-800">支給量</h3>
        <div className="grid grid-cols-1 gap-y-1 lg:grid-cols-2 lg:gap-x-6">
          <FieldRow label="身体介護中心">
            <HoursMinutesInput
              hours={form.body_care_hours}
              minutes={form.body_care_minutes}
              onChange={(h, m) => {
                upd("body_care_hours", h);
                upd("body_care_minutes", m);
              }}
            />
          </FieldRow>
          <FieldRow label="行動援護中心">
            <HoursMinutesInput
              hours={form.behavior_support_hours}
              minutes={form.behavior_support_minutes}
              onChange={(h, m) => {
                upd("behavior_support_hours", h);
                upd("behavior_support_minutes", m);
              }}
            />
          </FieldRow>
          <FieldRow label="乗降介助中心">
            <CountInput
              value={form.transfer_assist_count}
              unit="回"
              onChange={(v) => upd("transfer_assist_count", v)}
            />
          </FieldRow>
          <FieldRow label="重度包括中心">
            <CountInput
              value={form.severe_inclusive_units}
              unit="単位"
              onChange={(v) => upd("severe_inclusive_units", v)}
            />
          </FieldRow>
          <FieldRow label="家事援助中心">
            <HoursMinutesInput
              hours={form.housework_hours}
              minutes={form.housework_minutes}
              onChange={(h, m) => {
                upd("housework_hours", h);
                upd("housework_minutes", m);
              }}
            />
          </FieldRow>
          <FieldRow label="重度訪問介護包括支援">
            <HoursMinutesInput
              hours={form.severe_visit_inclusive_hours}
              minutes={form.severe_visit_inclusive_minutes}
              onChange={(h, m) => {
                upd("severe_visit_inclusive_hours", h);
                upd("severe_visit_inclusive_minutes", m);
              }}
            />
          </FieldRow>
          <FieldRow label="通院介助中心">
            <HoursMinutesInput
              hours={form.hospital_escort_hours}
              minutes={form.hospital_escort_minutes}
              onChange={(h, m) => {
                upd("hospital_escort_hours", h);
                upd("hospital_escort_minutes", m);
              }}
            />
          </FieldRow>
          <FieldRow label="重度訪問介護区分6該当">
            <HoursMinutesInput
              hours={form.severe_visit_lv6_hours}
              minutes={form.severe_visit_lv6_minutes}
              onChange={(h, m) => {
                upd("severe_visit_lv6_hours", h);
                upd("severe_visit_lv6_minutes", m);
              }}
            />
          </FieldRow>
          <FieldRow label="通院介助(身体あり)">
            <HoursMinutesInput
              hours={form.hospital_escort_with_body_hours}
              minutes={form.hospital_escort_with_body_minutes}
              onChange={(h, m) => {
                upd("hospital_escort_with_body_hours", h);
                upd("hospital_escort_with_body_minutes", m);
              }}
            />
          </FieldRow>
          <FieldRow label="重度訪問介護その他">
            <HoursMinutesInput
              hours={form.severe_visit_other_hours}
              minutes={form.severe_visit_other_minutes}
              onChange={(h, m) => {
                upd("severe_visit_other_hours", h);
                upd("severe_visit_other_minutes", m);
              }}
            />
          </FieldRow>
          <FieldRow label="同行援護中心">
            <HoursMinutesInput
              hours={form.accompany_hours}
              minutes={form.accompany_minutes}
              onChange={(h, m) => {
                upd("accompany_hours", h);
                upd("accompany_minutes", m);
              }}
            />
          </FieldRow>
          <FieldRow label="同行援護(身体あり)">
            <HoursMinutesInput
              hours={form.accompany_with_body_hours}
              minutes={form.accompany_with_body_minutes}
              onChange={(h, m) => {
                upd("accompany_with_body_hours", h);
                upd("accompany_with_body_minutes", m);
              }}
            />
          </FieldRow>
        </div>
      </div>

      {/* ─── 利用者負担割合 ────────────────────────────────────── */}
      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <h3 className="mb-3 border-b pb-2 text-sm font-bold text-gray-800">利用者負担割合</h3>
        <div className="grid grid-cols-1 gap-y-1 lg:grid-cols-2 lg:gap-x-6">
          <FieldRow label="負担割合">
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={100}
                value={form.burden_rate}
                onChange={(e) => upd("burden_rate", Number(e.target.value || 0))}
                className={`${inputCls} w-16 text-right`}
              />
              <span className="text-xs text-gray-500">%</span>
            </div>
          </FieldRow>
          <FieldRow label="所得区分">
            <select
              value={form.income_category ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setForm((f) => ({
                  ...f,
                  income_category: v || null,
                  // 既知の区分なら 利用者負担上限月額 を自動セット
                  monthly_burden_cap:
                    v && v in INCOME_CATEGORY_CAP
                      ? INCOME_CATEGORY_CAP[v as IncomeCategoryName]
                      : f.monthly_burden_cap,
                }));
              }}
              className={`${inputCls} w-48`}
            >
              <option value="">未選択</option>
              {INCOME_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </FieldRow>
          <FieldRow label="利用者負担上限月額">
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                value={form.monthly_burden_cap}
                onChange={(e) => upd("monthly_burden_cap", Number(e.target.value || 0))}
                className={`${inputCls} w-32 text-right`}
              />
              <span className="text-xs text-gray-500">円</span>
            </div>
          </FieldRow>
          <FieldRow label="軽減後上限月額">
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                value={form.monthly_burden_cap_reduced}
                onChange={(e) =>
                  upd("monthly_burden_cap_reduced", Number(e.target.value || 0))
                }
                className={`${inputCls} w-32 text-right`}
              />
              <span className="text-xs text-gray-500">円</span>
            </div>
          </FieldRow>
          <FieldRow label="上限額管理事業所">
            <input
              type="text"
              value={form.cap_management_office ?? ""}
              onChange={(e) => upd("cap_management_office", e.target.value)}
              className={`${inputCls} w-full max-w-md`}
            />
          </FieldRow>
          <FieldRow label="市町村が定める額">
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                value={form.municipality_amount}
                onChange={(e) => upd("municipality_amount", Number(e.target.value || 0))}
                className={`${inputCls} w-32 text-right`}
              />
              <span className="text-xs text-gray-500">円</span>
            </div>
          </FieldRow>
        </div>

        <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
          <ToggleButton
            active={form.is_swc_exemption}
            onClick={() => upd("is_swc_exemption", !form.is_swc_exemption)}
          >
            社会福祉法人減免
          </ToggleButton>
          <ToggleButton
            active={form.is_cap_reach_expected}
            onClick={() => upd("is_cap_reach_expected", !form.is_cap_reach_expected)}
          >
            上限額到達見込
          </ToggleButton>
          <ToggleButton
            active={form.is_household_cap_management}
            onClick={() => upd("is_household_cap_management", !form.is_household_cap_management)}
          >
            同一世帯の複数利用者で上限管理
          </ToggleButton>
        </div>
      </div>

      {/* ─── 事業者記入欄 ─────────────────────────────────────── */}
      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <h3 className="mb-3 border-b pb-2 text-sm font-bold text-gray-800">事業者記入欄</h3>
        <p className="mb-3 text-xs text-gray-500">
          各スロットをクリックすると詳細入力画面が開きます。
        </p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-9">
          {form.business_entries.map((entry) => {
            const filled = hasEntryContent(entry);
            return (
              <button
                key={entry.slot}
                type="button"
                onClick={() => setEditingSlot(entry.slot)}
                className={`flex flex-col items-center justify-center rounded-md border px-2 py-3 text-xs transition-colors ${
                  filled
                    ? "border-blue-400 bg-blue-50 text-blue-800 hover:bg-blue-100"
                    : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                <span className="font-semibold">{slotLabel(entry.slot)}</span>
                <span
                  className={`mt-1 truncate w-full text-center text-[10px] ${
                    filled ? "text-blue-600" : "text-gray-400"
                  }`}
                  title={entry.business_name || ""}
                >
                  {entry.business_name || "（未入力）"}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── メモ ─────────────────────────────────────────────── */}
      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <h3 className="mb-3 border-b pb-2 text-sm font-bold text-gray-800">メモ</h3>
        <textarea
          value={form.memo ?? ""}
          onChange={(e) => upd("memo", e.target.value)}
          rows={4}
          className={`${inputCls} w-full`}
        />
      </div>

      {/* ─── 事業者記入欄モーダル ───────────────────────────────── */}
      {editingSlot !== null &&
        (() => {
          const entry = form.business_entries.find((e) => e.slot === editingSlot);
          if (!entry) return null;
          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              onClick={() => setEditingSlot(null)}
            >
              <div
                className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                {/* モーダルヘッダ */}
                <div className="flex items-center justify-between border-b bg-gray-50 px-4 py-3">
                  <h3 className="text-sm font-bold text-gray-900">
                    事業者記入欄 — {slotLabel(entry.slot)}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setEditingSlot(null)}
                    className="rounded p-1 text-gray-500 hover:bg-gray-200"
                    aria-label="閉じる"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* モーダル本体 */}
                <div className="space-y-1 p-4">
                  <FieldRow label="事業所略称">
                    <input
                      type="text"
                      value={entry.business_name}
                      onChange={(e) => updEntry(entry.slot, "business_name", e.target.value)}
                      className={`${inputCls} w-full`}
                    />
                  </FieldRow>
                  <FieldRow label="番号">
                    <input
                      type="text"
                      value={entry.business_no}
                      onChange={(e) => updEntry(entry.slot, "business_no", e.target.value)}
                      className={`${inputCls} w-32`}
                    />
                  </FieldRow>
                  <FieldRow label="契約日">
                    <input
                      type="date"
                      value={entry.contract_date ?? ""}
                      onChange={(e) =>
                        updEntry(entry.slot, "contract_date", e.target.value || null)
                      }
                      className={inputCls}
                    />
                  </FieldRow>
                  <FieldRow label="契約区分">
                    <div className="flex items-center gap-4">
                      {(["新規契約", "契約変更"] as const).map((opt) => (
                        <label key={opt} className="flex items-center gap-1 text-sm cursor-pointer">
                          <input
                            type="radio"
                            name={`contract_type_${entry.slot}`}
                            value={opt}
                            checked={entry.contract_type === opt}
                            onChange={() => updEntry(entry.slot, "contract_type", opt)}
                            className="accent-blue-600"
                          />
                          <span>{opt}</span>
                        </label>
                      ))}
                      {entry.contract_type !== "" && (
                        <button
                          type="button"
                          onClick={() => updEntry(entry.slot, "contract_type", "")}
                          className="text-xs text-gray-500 underline hover:text-gray-700"
                        >
                          クリア
                        </button>
                      )}
                    </div>
                  </FieldRow>
                  <FieldRow label="サービス内容">
                    <input
                      type="text"
                      value={entry.service_content}
                      onChange={(e) => updEntry(entry.slot, "service_content", e.target.value)}
                      className={`${inputCls} w-full`}
                    />
                  </FieldRow>
                  <FieldRow label="契約支給量">
                    <HoursMinutesInput
                      hours={entry.contract_amount_hours}
                      minutes={entry.contract_amount_minutes}
                      onChange={(h, m) => {
                        updEntry(entry.slot, "contract_amount_hours", h);
                        updEntry(entry.slot, "contract_amount_minutes", m);
                      }}
                    />
                  </FieldRow>
                  <FieldRow label="提供終了日">
                    <input
                      type="date"
                      value={entry.service_end_date ?? ""}
                      onChange={(e) =>
                        updEntry(entry.slot, "service_end_date", e.target.value || null)
                      }
                      className={inputCls}
                    />
                  </FieldRow>
                  <FieldRow label="終了区分">
                    <input
                      type="text"
                      value={entry.end_type}
                      onChange={(e) => updEntry(entry.slot, "end_type", e.target.value)}
                      className={`${inputCls} w-48`}
                    />
                  </FieldRow>
                  <FieldRow label="終了月既提供量">
                    <HoursMinutesInput
                      hours={entry.pre_provided_hours}
                      minutes={entry.pre_provided_minutes}
                      onChange={(h, m) => {
                        updEntry(entry.slot, "pre_provided_hours", h);
                        updEntry(entry.slot, "pre_provided_minutes", m);
                      }}
                    />
                  </FieldRow>
                  <FieldRow label="備考">
                    <textarea
                      value={entry.note}
                      onChange={(e) => updEntry(entry.slot, "note", e.target.value)}
                      rows={2}
                      className={`${inputCls} w-full`}
                    />
                  </FieldRow>
                </div>

                {/* モーダルフッタ */}
                <div className="flex items-center justify-between border-t bg-gray-50 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (!confirm("この事業者記入欄をクリアします。よろしいですか？")) return;
                      clearEntry(entry.slot);
                      setEditingSlot(null);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
                  >
                    <Trash2 size={14} /> クリア
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingSlot(null)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-gray-400 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
                  >
                    閉じる
                  </button>
                </div>
                <p className="px-4 pb-3 text-[11px] text-gray-500">
                  画面下部の「保存」ボタンを押すまで DB には保存されません。
                </p>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
