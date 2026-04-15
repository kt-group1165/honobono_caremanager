"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Save, Building2, Loader2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

// 令和6年度改定 居宅介護支援 特定事業所加算
const TOKUTEI_OPTIONS = [
  { value: "なし", label: "なし", units: 0 },
  { value: "Ⅰ", label: "特定事業所加算(Ⅰ)", units: 519 },
  { value: "Ⅱ", label: "特定事業所加算(Ⅱ)", units: 421 },
  { value: "Ⅲ", label: "特定事業所加算(Ⅲ)", units: 323 },
  { value: "A", label: "特定事業所加算(A)", units: 114 },
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
  ai_enabled: boolean;
  ai_api_key: string;
  business_type: string;
};

export default function OfficeSettingsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [offices, setOffices] = useState<OfficeSettings[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<OfficeSettings | null>(null);

  const loadOffices = async () => {
    const { data } = await supabase.from("kaigo_office_settings").select("*").order("office_name");
    const list = (data || []).map((d: OfficeSettings) => {
      // 旧区分マッピング
      const mapping: Record<string, string> = { A: "Ⅰ", B: "Ⅱ", C: "Ⅲ" };
      if (d.tokutei_kassan_type && mapping[d.tokutei_kassan_type]) {
        d.tokutei_kassan_type = mapping[d.tokutei_kassan_type];
        const opt = TOKUTEI_OPTIONS.find((o) => o.value === d.tokutei_kassan_type);
        if (opt) d.tokutei_kassan_units = opt.units;
      }
      return d;
    });
    setOffices(list);
    return list;
  };

  useEffect(() => {
    const init = async () => {
      const list = await loadOffices();
      if (list.length > 0) {
        setEditingId(list[0].id);
        setForm(list[0]);
      }
      setLoading(false);
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectOffice = (id: string) => {
    const o = offices.find((x) => x.id === id);
    if (o) { setEditingId(id); setForm(o); }
  };

  const handleAddNew = async () => {
    const newName = prompt("新規事業所の名前を入力してください", "新規事業所");
    if (!newName?.trim()) return;
    const { data, error } = await supabase
      .from("kaigo_office_settings")
      .insert({ office_name: newName.trim(), business_type: "居宅介護支援", tokutei_kassan_type: "なし", tokutei_kassan_units: 0 })
      .select("*").single();
    if (error) { toast.error("追加に失敗: " + error.message); return; }
    toast.success("事業所を追加しました");
    await loadOffices();
    setEditingId(data.id);
    setForm(data as OfficeSettings);
  };

  const handleDelete = async () => {
    if (!form || offices.length <= 1) { toast.error("最低1つの事業所が必要です"); return; }
    if (!confirm(`「${form.office_name}」を削除しますか？\n関連するデータは残りますが、この事業所を選択できなくなります。`)) return;
    const { error } = await supabase.from("kaigo_office_settings").delete().eq("id", form.id);
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
        ai_enabled: form.ai_enabled,
        ai_api_key: form.ai_api_key,
        business_type: form.business_type,
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
                <option key={o.id} value={o.id}>{o.office_name || "(名称未設定)"}（{o.business_type}）</option>
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
              form.business_type === type
                ? "border-blue-500 bg-blue-50 text-blue-700 font-bold"
                : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
            )}>
              <input
                type="radio"
                name="business_type"
                value={type}
                checked={form.business_type === type}
                onChange={(e) => handleChange("business_type", e.target.value)}
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

      {/* AI機能設定 */}
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
