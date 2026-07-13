"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Save, Building2, Loader2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBusinessType } from "@/lib/business-type-context";
import { AppliedFormulaSection } from "./_applied-formula";
import { AddonRegistrySection } from "./_addon-registry";
import { GensanSection } from "./_gensan-settings";

// 令和6年度改定 居宅介護支援 特定事業所加算
const TOKUTEI_OPTIONS = [
  { value: "なし", label: "なし", units: 0 },
  { value: "Ⅰ", label: "特定事業所加算(Ⅰ)", units: 519 },
  { value: "Ⅱ", label: "特定事業所加算(Ⅱ)", units: 421 },
  { value: "Ⅲ", label: "特定事業所加算(Ⅲ)", units: 323 },
  { value: "A", label: "特定事業所加算(A)", units: 114 },
];

// 令和6年度 地域区分別 1単位単価 (円)。人件費割合区分でサービス種別ごとに異なる。
//   70%: 訪問介護 / 訪問入浴 / 訪問看護 / 居宅介護支援 / 定期巡回 / 夜間対応
//   55%: 訪問リハ / 通所リハ / 認知症対応型通所 / 小規模多機能 / 短期入所生活 等
//   45%: 通所介護 / 短期入所療養 / 特定施設 / 認知症対応型共同生活 等
//   福祉用具貸与は全国一律 10.00
const AREA_PRICE_TABLE: Record<string, { p70: number; p55: number; p45: number }> = {
  "1級地": { p70: 11.40, p55: 11.10, p45: 10.90 },
  "2級地": { p70: 11.12, p55: 10.88, p45: 10.72 },
  "3級地": { p70: 11.05, p55: 10.83, p45: 10.68 },
  "4級地": { p70: 10.84, p55: 10.66, p45: 10.54 },
  "5級地": { p70: 10.70, p55: 10.55, p45: 10.45 },
  "6級地": { p70: 10.42, p55: 10.33, p45: 10.27 },
  "7級地": { p70: 10.21, p55: 10.17, p45: 10.14 },
  "その他": { p70: 10.00, p55: 10.00, p45: 10.00 },
};
const AREA_VALUES = Object.keys(AREA_PRICE_TABLE);

function laborBand(serviceType: string | null | undefined): "p70" | "p55" | "p45" | "flat" {
  const t = serviceType ?? "";
  if (t.includes("福祉用具")) return "flat";
  if (/訪問リハ|通所リハ|認知症対応型通所|小規模多機能|短期入所生活/.test(t)) return "p55";
  if (/通所介護|短期入所療養|特定施設|共同生活|グループホーム/.test(t)) return "p45";
  // 訪問介護 / 訪問入浴 / 訪問看護 / 居宅介護支援 / 定期巡回 / 夜間対応 → 70%
  return "p70";
}

function areaPrice(area: string, serviceType: string | null | undefined): number {
  const row = AREA_PRICE_TABLE[area];
  if (!row) return 10.0;
  const band = laborBand(serviceType);
  return band === "flat" ? 10.0 : row[band];
}

// 共通マスタ offices の subset（kaigo-app 自事業所設定で使うフィールド）
// Phase 2-3-7 で kaigo_office_settings から張替え。
//   旧 kaigo_office_settings → 新 offices
//   office_name      → name
//   provider_number  → business_number
//   business_type    → service_type
export type OfficeSettings = {
  id: string;
  tenant_id: string;
  company_id: string | null;
  name: string;
  office_name_kana: string | null;
  business_number: string | null;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  fax: string | null;
  representative_name: string | null;
  manager_name: string | null;
  tokutei_kassan_type: string;
  tokutei_kassan_units: number;
  medical_cooperation_kassan: boolean;
  medical_cooperation_units: number;
  area_category: string;
  unit_price: number;
  notes: string | null;
  ai_enabled: boolean;
  ai_api_key: string;
  service_type: string;
  app_type: string | null;
  is_active: boolean;
  // 訪問介護 手順書 モード: 'standalone'=手順書内で自入力 (先行スタート) / 'integrated'=本体 clients と連携
  visit_procedure_mode?: "standalone" | "integrated";
  // 逓減制 (居宅介護支援)。migrations/teigen_settings.sql 適用前は列が無く undefined
  /** 介護支援専門員の常勤換算数 (NULL/0 = 逓減制の自動判定をしない) */
  caremane_jokin_kansan?: number | string | null;
  /** 逓減制の緩和要件 (ICT活用・事務職員配置 = 居宅介護支援費(Ⅱ)体制) 該当 */
  teigen_kanwa?: boolean | null;
};

// 旧区分 (A/B/C) → 新区分 (Ⅰ/Ⅱ/Ⅲ) のクライアント側変換は撤去済。
// DB 側で offices_tokutei_kassan_check_migrate.sql により表記移行し、
// CHECK も新表記 (なし/Ⅰ/Ⅱ/Ⅲ/A) に更新されている。
// ('A' は令和6年度の特定事業所加算(A) を意味する)
function normalizeOffices(list: OfficeSettings[]): OfficeSettings[] {
  return list;
}

export function OfficeContent({
  initialOffices,
}: {
  initialOffices: OfficeSettings[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOfficeId, setCurrentOfficeId } = useBusinessType();
  const [saving, setSaving] = useState(false);
  const [offices, setOffices] = useState<OfficeSettings[]>(() => normalizeOffices(initialOffices));
  const [editingId, setEditingId] = useState<string | null>(() => {
    const list = normalizeOffices(initialOffices);
    if (list.length === 0) return null;
    const found = currentOfficeId ? list.find((o) => o.id === currentOfficeId) : undefined;
    return (found ?? list[0]).id;
  });
  const [form, setForm] = useState<OfficeSettings | null>(() => {
    const list = normalizeOffices(initialOffices);
    if (list.length === 0) return null;
    const found = currentOfficeId ? list.find((o) => o.id === currentOfficeId) : undefined;
    return found ?? list[0];
  });

  const loadOffices = async () => {
    // 共通マスタ offices から、app_type='kaigo-app' の自事業所だけ取得
    const { data, error } = await supabase
      .from("offices")
      .select("*")
      .eq("app_type", "kaigo-app")
      .order("name");
    if (error) {
      toast.error("事業所一覧の再取得に失敗: " + error.message);
      return offices; // 既存表示を維持
    }
    const list = normalizeOffices((data || []) as OfficeSettings[]);
    setOffices(list);
    return list;
  };

  // currentOfficeIdが変わったら編集中もそれに追従（他画面で切替えた場合に同期）
  useEffect(() => {
    if (!currentOfficeId || offices.length === 0) return;
    const o = offices.find((x: OfficeSettings) => x.id === currentOfficeId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- cross-page context sync
    if (o && o.id !== editingId) { setEditingId(o.id); setForm(o); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOfficeId, offices]);

  const selectOffice = (id: string) => {
    const o = offices.find((x: OfficeSettings) => x.id === id);
    if (o) {
      setEditingId(id);
      setForm(o);
      // ドロップダウンで選んだら「現在の自事業所」も切り替える
      setCurrentOfficeId(id);
    }
  };

  const handleAddNew = async () => {
    const newName = prompt("新規事業所の名前を入力してください", "新規事業所");
    if (!newName?.trim()) return;
    // 新規 INSERT には offices.tenant_id + company_id が必要。
    // company_id は RLS policy `offices_admin_write` の WITH CHECK で
    // `auth_admin_company_ids()` 一致が要求されるため必須。
    // 現在の自事業所と同じ tenant/company に紐付ける。
    const baseTenant = form?.tenant_id ?? offices[0]?.tenant_id;
    const baseCompany = form?.company_id ?? offices[0]?.company_id;
    if (!baseTenant || !baseCompany) {
      toast.error("基準となる自事業所が無いため新規追加できません。先に既存の事業所を 1 件選択してください。");
      return;
    }
    const { data, error } = await supabase
      .from("offices")
      .insert({
        tenant_id: baseTenant,
        company_id: baseCompany,
        name: newName.trim(),
        service_type: "居宅介護支援",
        app_type: "kaigo-app",
        designation_type: "介護保険",
        tokutei_kassan_type: "なし",
        tokutei_kassan_units: 0,
        is_active: true,
      })
      .select("*").single();
    if (error) { toast.error("追加に失敗: " + error.message); return; }
    toast.success("事業所を追加しました");
    await loadOffices();
    setEditingId(data.id);
    setForm(data as OfficeSettings);
  };

  const handleDelete = async () => {
    if (!form || offices.length <= 1) { toast.error("最低1つの事業所が必要です"); return; }
    if (!confirm(`「${form.name}」を削除しますか？\n関連するデータは残りますが、この事業所を選択できなくなります。`)) return;
    const { error } = await supabase.from("offices").delete().eq("id", form.id);
    if (error) { toast.error("削除に失敗: " + error.message); return; }
    toast.success("削除しました");
    const list = await loadOffices();
    if (list.length > 0) { setEditingId(list[0].id); setForm(list[0]); }
    else { setEditingId(null); setForm(null); }
  };

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

    // 地域区分 → 単価自動設定 (サービス種別の人件費割合区分で単価が変わる)
    if (key === "area_category") {
      updated.unit_price = areaPrice(String(value), updated.service_type);
    }
    // サービス種別変更時も同じ地域区分で単価を再計算
    if (key === "service_type") {
      updated.unit_price = areaPrice(updated.area_category, String(value));
    }

    setForm(updated);
  };

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    const { error } = await supabase
      .from("offices")
      .update({
        name: form.name,
        office_name_kana: form.office_name_kana,
        business_number: form.business_number,
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
        ai_enabled: form.ai_enabled,
        ai_api_key: form.ai_api_key,
        service_type: form.service_type,
        visit_procedure_mode: form.visit_procedure_mode ?? "standalone",
      })
      .eq("id", form.id);
    if (error) {
      setSaving(false);
      toast.error("保存に失敗しました: " + error.message);
      return;
    }
    // 逓減制設定 (居宅のみ)。列未適用 (migrations/teigen_settings.sql) の環境でも
    // 本体の保存が巻き添えで失敗しないよう別 UPDATE に分離する。
    if (form.service_type === "居宅介護支援") {
      const rawFte = form.caremane_jokin_kansan;
      const fte =
        rawFte == null || rawFte === "" || !Number.isFinite(Number(rawFte))
          ? null
          : Number(rawFte);
      const { error: teigenErr } = await supabase
        .from("offices")
        .update({
          caremane_jokin_kansan: fte,
          teigen_kanwa: !!form.teigen_kanwa,
        })
        .eq("id", form.id);
      if (teigenErr) {
        setSaving(false);
        toast.warning(
          "逓減制設定は保存できませんでした (migrations/teigen_settings.sql が未適用の可能性): " +
            teigenErr.message,
        );
        return;
      }
    }
    setSaving(false);
    toast.success("事業所設定を保存しました");
  };

  if (!form) {
    return (
      <div className="max-w-3xl mx-auto space-y-6 py-24 text-center">
        <p className="text-gray-400">事業所がまだ登録されていません</p>
        <button
          onClick={handleAddNew}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus size={14} /> 新規事業所を追加
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Building2 size={24} className="text-blue-600" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">自事業所管理</h1>
            <p className="text-xs text-gray-500">複数の自事業所の登録・編集</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleAddNew}
            className="flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100"
          >
            <Plus size={14} /> 新規事業所
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存
          </button>
        </div>
      </div>

      {/* 事業所選択 */}
      {offices.length > 1 && (
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <label className="block text-xs font-medium text-gray-500 mb-2">編集中の事業所</label>
          <div className="flex items-center gap-2">
            <select
              value={editingId ?? ""}
              onChange={(e) => selectOffice(e.target.value)}
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              {offices.map((o) => (
                <option key={o.id} value={o.id}>{o.name || "(名称未設定)"}（{o.service_type}）</option>
              ))}
            </select>
            <button
              onClick={handleDelete}
              className="flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
            >
              <Trash2 size={14} /> 削除
            </button>
          </div>
        </div>
      )}

      {/* 事業種別 */}
      <div className="rounded-xl border-2 border-blue-200 bg-blue-50/30 p-6 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-blue-700 border-b border-blue-200 pb-2">事業種別</h2>
        <div className="flex items-center gap-4">
          {["居宅介護支援", "訪問介護", "通所介護"].map((type) => (
            <label key={type} className={cn(
              "flex items-center gap-2 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all",
              form.service_type === type
                ? "border-blue-500 bg-blue-50 text-blue-700 font-bold"
                : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
            )}>
              <input
                type="radio"
                name="service_type"
                value={type}
                checked={form.service_type === type}
                onChange={(e) => handleChange("service_type", e.target.value)}
                className="accent-blue-600"
              />
              {type}
            </label>
          ))}
        </div>
        <p className="text-xs text-gray-500">事業種別を切り替えると、サイドバーのメニューや利用可能な機能が変わります。保存後にページをリロードしてください。</p>
      </div>

      {/* 基本情報 */}
      <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-gray-700 border-b pb-2">基本情報</h2>
        <div className="grid grid-cols-2 gap-4">
          <Field label="事業所名" value={form.name} onChange={(v) => handleChange("name", v)} />
          <Field label="フリガナ" value={form.office_name_kana} onChange={(v) => handleChange("office_name_kana", v)} />
          <Field label="事業所番号（10桁）" value={form.business_number} onChange={(v) => handleChange("business_number", v)} placeholder="2970100007" />
          <Field label="郵便番号" value={form.postal_code} onChange={(v) => handleChange("postal_code", v)} placeholder="630-8007" />
          <Field label="住所" value={form.address} onChange={(v) => handleChange("address", v)} className="col-span-2" />
          <Field label="電話番号" value={form.phone} onChange={(v) => handleChange("phone", v)} />
          <Field label="FAX番号" value={form.fax} onChange={(v) => handleChange("fax", v)} />
          <Field label="代表者名" value={form.representative_name} onChange={(v) => handleChange("representative_name", v)} />
          <Field label="管理者名" value={form.manager_name} onChange={(v) => handleChange("manager_name", v)} />
        </div>
      </div>

      {/* 加算設定 (居宅介護支援の特定事業所加算 = 居宅のみ表示。
          訪問介護の特定事業所加算は%加算で別物のため、誤設定防止で非表示) */}
      {form.service_type === "居宅介護支援" && (
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
      )}

      {/* 逓減制 (取扱件数による居宅介護支援費の自動判定 = 居宅のみ表示) */}
      {form.service_type === "居宅介護支援" && (
      <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-gray-700 border-b pb-2">逓減制 (取扱件数)</h2>
        <p className="text-xs text-gray-500">
          介護支援専門員 1 人 (常勤換算) あたりの取扱件数が 45 件以上 (緩和要件該当なら 50 件以上) で
          居宅介護支援費(ⅱ)、60 件以上で (ⅲ) に逓減します。常勤換算数を設定すると、
          レセプト一括生成時に利用者ごとの基本サービスコードを自動判定します
          (未設定の場合は従来どおり件数警告のみ)。
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              介護支援専門員 常勤換算数
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              value={form.caremane_jokin_kansan ?? ""}
              onChange={(e) => handleChange("caremane_jokin_kansan", e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="例: 2.5 (空欄 = 自動判定しない)"
            />
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.teigen_kanwa ?? false}
                onChange={(e) => handleChange("teigen_kanwa", e.target.checked)}
                className="h-4 w-4 rounded accent-blue-600"
              />
              <span className="text-sm text-gray-700">
                緩和要件 (ICT活用・事務職員配置) に該当
                <span className="block text-xs text-gray-400">
                  該当時は居宅介護支援費(Ⅱ) の体制で判定・請求します (閾値 50/60 件)
                </span>
              </span>
            </label>
          </div>
        </div>
      </div>
      )}

      {/* 適用加算 (処遇改善加算等 = 訪問介護のみ表示。
          月計 × 加算率で自動算定される加算のチェックと期間指定) */}
      {form.service_type === "訪問介護" && (
        <AppliedFormulaSection
          key={form.id}
          officeId={form.id}
          tenantId={form.tenant_id}
          serviceType={form.service_type}
        />
      )}

      {/* 減算 (体制未整備 = 訪問介護・訪問入浴のみ表示。
          虐防/業未 減算の適用期間。期間内の月は請求集計が基本コードを
          合成バリエーション (・虐防/・業未) へ自動差し替え) */}
      {(form.service_type === "訪問介護" || form.service_type === "訪問入浴") && (
        <GensanSection
          key={`gensan-${form.id}`}
          officeId={form.id}
          tenantId={form.tenant_id}
        />
      )}

      {/* 加算管理 (届出・算定台帳 = 旧トップメニュー /addons を統合。
          居宅介護支援はレセプト作成が「算定中」の加算を自動反映、
          訪問介護は届出管理台帳 (率計算は上の適用加算)) */}
      {(form.service_type === "居宅介護支援" || form.service_type === "訪問介護") && (
        <AddonRegistrySection
          key={`addon-registry-${form.id}`}
          officeId={form.id}
          tenantId={form.tenant_id}
          serviceType={form.service_type}
        />
      )}

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
              {AREA_VALUES.map((a) => (
                <option key={a} value={a}>
                  {a}（{areaPrice(a, form.service_type).toFixed(2)}円/単位）
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end pb-1">
            <div className="rounded-lg bg-gray-50 px-4 py-2 text-sm">
              単位数単価: <span className="font-bold text-gray-900">{Number(form.unit_price).toFixed(2)}</span> 円/単位
            </div>
          </div>
        </div>
      </div>

      {/* 訪問介護 手順書 モード (=訪問介護事業所のみ) */}
      {form.service_type === "訪問介護" && (
        <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-bold text-gray-700 border-b pb-2">
            訪問介護 手順書モード
          </h2>
          <p className="text-xs text-gray-500">
            移行期の運用切替:
            <br />
            ・<strong>先行スタート</strong>: 手順書機能内で利用者名を自入力する
            (=本体マスタと分離)
            <br />
            ・<strong>通常</strong>: 本体の利用者管理 (clients) と連携し、
            自動で利用者情報が反映される
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(
              [
                {
                  value: "standalone",
                  label: "先行スタートモード",
                  desc: "手順書内で利用者名を自入力 (先行運用用)",
                },
                {
                  value: "integrated",
                  label: "通常モード",
                  desc: "本体マスタの利用者情報を使う",
                },
              ] as const
            ).map((opt) => {
              const active =
                (form.visit_procedure_mode ?? "standalone") === opt.value;
              return (
                <label
                  key={opt.value}
                  className={
                    "flex items-start gap-2 cursor-pointer rounded-lg border p-3 transition-colors " +
                    (active
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 bg-white hover:bg-gray-50")
                  }
                >
                  <input
                    type="radio"
                    name="visit_procedure_mode"
                    value={opt.value}
                    checked={active}
                    onChange={() =>
                      handleChange("visit_procedure_mode", opt.value)
                    }
                    className="mt-0.5"
                  />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium text-gray-800">
                      {opt.label}
                    </span>
                    <span className="text-xs text-gray-500">{opt.desc}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* AI機能設定 (AIケアプラン生成 = 居宅介護支援のみ表示) */}
      {form.service_type === "居宅介護支援" && (
      <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-gray-700 border-b pb-2">AI機能設定</h2>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.ai_enabled ?? false}
              onChange={(e) => handleChange("ai_enabled", e.target.checked)}
              className="h-5 w-5 rounded accent-blue-600"
            />
            <div>
              <span className="text-sm font-medium text-gray-800">AIケアプラン生成を有効にする</span>
              <p className="text-xs text-gray-500">ケアプラン作成時にAIが文章案を自動生成します（Anthropic API使用、従量課金）</p>
            </div>
          </label>
        </div>

        {form.ai_enabled && (
          <div className="ml-8 space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Anthropic APIキー</label>
              <input
                type="password"
                value={form.ai_api_key ?? ""}
                onChange={(e) => handleChange("ai_api_key", e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="sk-ant-api03-..."
              />
              <p className="mt-1 text-xs text-gray-400">
                <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                  Anthropic Console
                </a>
                でAPIキーを取得してください
              </p>
            </div>
            <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-700">
              <b>料金目安：</b>ケアプラン1件の生成あたり約3〜9円（Claude Sonnet使用）。月20件で約60〜180円程度です。
            </div>

            {/* AI使用量表示 */}
            <AiUsagePanel />
          </div>
        )}
      </div>
      )}

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
  label: string; value: string | null; onChange: (v: string) => void; placeholder?: string; className?: string;
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

// AI使用量パネル
function AiUsagePanel() {
  const supabase = createClient();
  const [logs, setLogs] = useState<{ month: string; count: number; input_tokens: number; output_tokens: number; cost: number }[]>([]);
  const [recentLogs, setRecentLogs] = useState<{ user_name: string; action: string; mode: string; input_tokens: number; output_tokens: number; estimated_cost: number; created_at: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLogs = async () => {
      // 直近のログ10件
      const { data: recent } = await supabase
        .from("kaigo_ai_usage_logs")
        .select("user_name, action, mode, input_tokens, output_tokens, estimated_cost, created_at")
        .order("created_at", { ascending: false })
        .limit(10);
      setRecentLogs((recent || []) as typeof recentLogs);

      // 月別集計（直近6ヶ月）
      const { data: all } = await supabase
        .from("kaigo_ai_usage_logs")
        .select("input_tokens, output_tokens, estimated_cost, created_at")
        .order("created_at", { ascending: false })
        .limit(500);

      const monthMap = new Map<string, { count: number; input_tokens: number; output_tokens: number; cost: number }>();
      for (const log of (all || []) as { input_tokens: number; output_tokens: number; estimated_cost: number; created_at: string }[]) {
        const month = log.created_at.slice(0, 7); // YYYY-MM
        const existing = monthMap.get(month) || { count: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
        existing.count += 1;
        existing.input_tokens += log.input_tokens;
        existing.output_tokens += log.output_tokens;
        existing.cost += Number(log.estimated_cost);
        monthMap.set(month, existing);
      }
      const monthlyData = Array.from(monthMap.entries())
        .map(([month, data]) => ({ month, ...data }))
        .sort((a, b) => b.month.localeCompare(a.month))
        .slice(0, 6);
      setLogs(monthlyData);
      setLoading(false);
    };
    fetchLogs();
  }, [supabase]);

  if (loading) return <div className="text-xs text-gray-400 py-2">使用量を読み込み中...</div>;

  const totalCost = logs.reduce((sum, l) => sum + l.cost, 0);
  const totalCount = logs.reduce((sum, l) => sum + l.count, 0);

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-gray-700">AI使用量</div>

      {/* サマリー */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-purple-50 p-2 text-center">
          <div className="text-lg font-bold text-purple-700">{totalCount}</div>
          <div className="text-[10px] text-purple-500">累計生成回数</div>
        </div>
        <div className="rounded-lg bg-purple-50 p-2 text-center">
          <div className="text-lg font-bold text-purple-700">{Math.round(totalCost * 10) / 10}円</div>
          <div className="text-[10px] text-purple-500">累計コスト</div>
        </div>
        <div className="rounded-lg bg-purple-50 p-2 text-center">
          <div className="text-lg font-bold text-purple-700">{totalCount > 0 ? Math.round(totalCost / totalCount * 10) / 10 : 0}円</div>
          <div className="text-[10px] text-purple-500">1回あたり平均</div>
        </div>
      </div>

      {/* 月別テーブル */}
      {logs.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-gray-600 mb-1">月別使用量</div>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50">
                <th className="border px-2 py-1 text-left">月</th>
                <th className="border px-2 py-1 text-right">回数</th>
                <th className="border px-2 py-1 text-right">入力トークン</th>
                <th className="border px-2 py-1 text-right">出力トークン</th>
                <th className="border px-2 py-1 text-right">コスト</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.month}>
                  <td className="border px-2 py-1">{l.month}</td>
                  <td className="border px-2 py-1 text-right">{l.count}回</td>
                  <td className="border px-2 py-1 text-right">{l.input_tokens.toLocaleString()}</td>
                  <td className="border px-2 py-1 text-right">{l.output_tokens.toLocaleString()}</td>
                  <td className="border px-2 py-1 text-right font-semibold">{Math.round(l.cost * 10) / 10}円</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 直近ログ */}
      {recentLogs.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-gray-600 mb-1">直近の使用履歴</div>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {recentLogs.map((log, i) => (
              <div key={i} className="flex items-center justify-between rounded bg-gray-50 px-2 py-1 text-[10px]">
                <div className="flex items-center gap-2">
                  <span className="text-gray-400">{new Date(log.created_at).toLocaleDateString("ja-JP")}</span>
                  <span className="font-medium">{log.user_name}</span>
                  <span className="text-gray-500">{log.mode === "from-services" ? "サービス→プラン" : "全体提案"}</span>
                </div>
                <span className="font-semibold text-purple-600">{Math.round(Number(log.estimated_cost) * 10) / 10}円</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {logs.length === 0 && recentLogs.length === 0 && (
        <div className="text-xs text-gray-400 text-center py-2">まだAI生成の使用履歴がありません</div>
      )}
    </div>
  );
}
