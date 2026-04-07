"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Save, Building2, Loader2 } from "lucide-react";

const TOKUTEI_OPTIONS = [
  { value: "なし", label: "なし", units: 0 },
  { value: "A", label: "特定事業所加算(A)", units: 505 },
  { value: "B", label: "特定事業所加算(B)", units: 407 },
  { value: "C", label: "特定事業所加算(C)", units: 309 },
];

const AREA_CATEGORIES = [
  { value: "1級地", label: "1級地", price: 11.40 },
  { value: "2級地", label: "2級地", price: 11.12 },
  { value: "3級地", label: "3級地", price: 11.05 },
  { value: "4級地", label: "4級地", price: 10.84 },
  { value: "5級地", label: "5級地", price: 10.70 },
  { value: "6級地", label: "6級地", price: 10.42 },
  { value: "7級地", label: "7級地", price: 10.14 },
  { value: "その他", label: "その他", price: 10.00 },
];

type OfficeSettings = {
  id: string;
  office_name: string;
  office_name_kana: string;
  provider_number: string;
  postal_code: string;
  address: string;
  phone: string;
  fax: string;
  representative_name: string;
  manager_name: string;
  tokutei_kassan_type: string;
  tokutei_kassan_units: number;
  medical_cooperation_kassan: boolean;
  medical_cooperation_units: number;
  area_category: string;
  unit_price: number;
  notes: string;
};

export default function OfficeSettingsPage() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<OfficeSettings | null>(null);

  useEffect(() => {
    const fetch = async () => {
      const { data } = await supabase.from("kaigo_office_settings").select("*").limit(1).single();
      setForm(data as OfficeSettings | null);
      setLoading(false);
    };
    fetch();
  }, [supabase]);

  const handleChange = (key: keyof OfficeSettings, value: string | number | boolean) => {
    if (!form) return;
    const updated = { ...form, [key]: value };

    // 特定事業所加算の単位数を自動設定
    if (key === "tokutei_kassan_type") {
      const opt = TOKUTEI_OPTIONS.find((o) => o.value === value);
      updated.tokutei_kassan_units = opt?.units ?? 0;
    }

    // 医療介護連携加算
    if (key === "medical_cooperation_kassan") {
      updated.medical_cooperation_units = value ? 125 : 0;
    }

    // 地域区分 → 単価自動設定
    if (key === "area_category") {
      const area = AREA_CATEGORIES.find((a) => a.value === value);
      updated.unit_price = area?.price ?? 10.00;
    }

    setForm(updated);
  };

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    const { error } = await supabase
      .from("kaigo_office_settings")
      .update({
        office_name: form.office_name,
        office_name_kana: form.office_name_kana,
        provider_number: form.provider_number,
        postal_code: form.postal_code,
        address: form.address,
        phone: form.phone,
        fax: form.fax,
        representative_name: form.representative_name,
        manager_name: form.manager_name,
        tokutei_kassan_type: form.tokutei_kassan_type,
        tokutei_kassan_units: form.tokutei_kassan_units,
        medical_cooperation_kassan: form.medical_cooperation_kassan,
        medical_cooperation_units: form.medical_cooperation_units,
        area_category: form.area_category,
        unit_price: form.unit_price,
        notes: form.notes,
      })
      .eq("id", form.id);
    setSaving(false);
    if (error) {
      toast.error("保存に失敗しました: " + error.message);
    } else {
      toast.success("事業所設定を保存しました");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <Loader2 size={24} className="animate-spin mr-2" /> 読み込み中...
      </div>
    );
  }

  if (!form) {
    return <div className="py-24 text-center text-gray-400">設定データがありません</div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Building2 size={24} className="text-blue-600" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">自事業所設定</h1>
            <p className="text-xs text-gray-500">居宅介護支援事業所の基本情報と加算設定</p>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          保存
        </button>
      </div>

      {/* 基本情報 */}
      <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-gray-700 border-b pb-2">基本情報</h2>
        <div className="grid grid-cols-2 gap-4">
          <Field label="事業所名" value={form.office_name} onChange={(v) => handleChange("office_name", v)} />
          <Field label="フリガナ" value={form.office_name_kana} onChange={(v) => handleChange("office_name_kana", v)} />
          <Field label="事業所番号（10桁）" value={form.provider_number} onChange={(v) => handleChange("provider_number", v)} placeholder="2970100007" />
          <Field label="郵便番号" value={form.postal_code} onChange={(v) => handleChange("postal_code", v)} placeholder="630-8007" />
          <Field label="住所" value={form.address} onChange={(v) => handleChange("address", v)} className="col-span-2" />
          <Field label="電話番号" value={form.phone} onChange={(v) => handleChange("phone", v)} />
          <Field label="FAX番号" value={form.fax} onChange={(v) => handleChange("fax", v)} />
          <Field label="代表者名" value={form.representative_name} onChange={(v) => handleChange("representative_name", v)} />
          <Field label="管理者名" value={form.manager_name} onChange={(v) => handleChange("manager_name", v)} />
        </div>
      </div>

      {/* 加算設定 */}
      <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-gray-700 border-b pb-2">加算設定</h2>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">特定事業所加算</label>
            <select
              value={form.tokutei_kassan_type}
              onChange={(e) => handleChange("tokutei_kassan_type", e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {TOKUTEI_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}{o.units > 0 ? `（${o.units}単位/月）` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end pb-1">
            {form.tokutei_kassan_type !== "なし" && (
              <div className="rounded-lg bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700">
                +{form.tokutei_kassan_units} 単位/月
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.medical_cooperation_kassan}
              onChange={(e) => handleChange("medical_cooperation_kassan", e.target.checked)}
              className="h-4 w-4 rounded accent-blue-600"
            />
            <span className="text-sm text-gray-700">特定事業所医療介護連携加算</span>
          </label>
          {form.medical_cooperation_kassan && (
            <span className="rounded-lg bg-green-50 px-3 py-1 text-sm font-medium text-green-700">
              +125 単位/月
            </span>
          )}
        </div>
      </div>

      {/* 地域区分 */}
      <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-gray-700 border-b pb-2">地域区分・単価</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">地域区分</label>
            <select
              value={form.area_category}
              onChange={(e) => handleChange("area_category", e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {AREA_CATEGORIES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}（{a.price}円/単位）
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end pb-1">
            <div className="rounded-lg bg-gray-50 px-4 py-2 text-sm">
              単位数単価: <span className="font-bold text-gray-900">{form.unit_price}</span> 円
            </div>
          </div>
        </div>
      </div>

      {/* 備考 */}
      <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-gray-700 border-b pb-2">備考</h2>
        <textarea
          value={form.notes ?? ""}
          onChange={(e) => handleChange("notes", e.target.value)}
          rows={3}
          className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="メモ・備考"
        />
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, className }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        type="text"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        placeholder={placeholder}
      />
    </div>
  );
}
