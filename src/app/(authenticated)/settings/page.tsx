"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Settings, Eye, EyeOff, Building2, ChevronRight, CalendarDays, Plus, Save, Loader2, Trash2, Link2, Copy } from "lucide-react";
import Link from "next/link";
import { useBusinessType } from "@/lib/business-type-context";

// ─── 年度別単位数管理 ──────────────────────────────────────────────────────

interface CareSupportRate {
  id?: string;
  fiscal_year: string;
  care_level: string;
  units: number;
  service_code: string;
  service_name: string;
}

const CARE_LEVELS = ["要支援1", "要支援2", "要介護1", "要介護2", "要介護3", "要介護4", "要介護5"];

function FiscalYearRatesSection() {
  const supabase = createClient();
  const [rates, setRates] = useState<CareSupportRate[]>([]);
  const [loadingRates, setLoadingRates] = useState(true);
  const [savingRates, setSavingRates] = useState(false);
  const [newFy, setNewFy] = useState("");

  useEffect(() => {
    const load = async () => {
      setLoadingRates(true);
      const { data } = await supabase
        .from("kaigo_care_support_rates")
        .select("*")
        .order("fiscal_year", { ascending: false })
        .order("care_level");
      setRates((data as CareSupportRate[]) ?? []);
      setLoadingRates(false);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fiscalYears = [...new Set(rates.map((r) => r.fiscal_year))].sort().reverse();

  const updateRate = (fy: string, cl: string, field: keyof CareSupportRate, value: string | number) => {
    setRates((prev) =>
      prev.map((r) =>
        r.fiscal_year === fy && r.care_level === cl ? { ...r, [field]: value } : r
      )
    );
  };

  const addFiscalYear = () => {
    if (!newFy || fiscalYears.includes(newFy)) {
      toast.error("年度を正しく入力してください");
      return;
    }
    const newRows: CareSupportRate[] = CARE_LEVELS.map((cl) => ({
      fiscal_year: newFy,
      care_level: cl,
      units: 0,
      service_code: "",
      service_name: "",
    }));
    setRates((prev) => [...newRows, ...prev]);
    setNewFy("");
  };

  const deleteFiscalYear = async (fy: string) => {
    if (!window.confirm(`${fy}年度のデータを削除しますか？`)) return;
    await supabase.from("kaigo_care_support_rates").delete().eq("fiscal_year", fy);
    setRates((prev) => prev.filter((r) => r.fiscal_year !== fy));
    toast.success(`${fy}年度を削除しました`);
  };

  const saveRates = async () => {
    setSavingRates(true);
    try {
      // 直接 state mutation せず、コピーに対して id 反映してから setState で commit
      const updated = [...rates];
      for (let i = 0; i < updated.length; i++) {
        const r = updated[i];
        if (r.id) {
          await supabase.from("kaigo_care_support_rates").update({
            units: r.units,
            service_code: r.service_code,
            service_name: r.service_name,
          }).eq("id", r.id);
        } else {
          const { data } = await supabase.from("kaigo_care_support_rates").upsert({
            fiscal_year: r.fiscal_year,
            care_level: r.care_level,
            units: r.units,
            service_code: r.service_code,
            service_name: r.service_name,
          }, { onConflict: "fiscal_year,care_level" }).select("id").single();
          if (data) updated[i] = { ...r, id: data.id };
        }
      }
      setRates(updated);
      toast.success("年度別単位数を保存しました");
    } catch (err) {
      toast.error("保存に失敗しました");
      console.error(err);
    } finally {
      setSavingRates(false);
    }
  };

  if (loadingRates) {
    return (
      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <CalendarDays size={20} className="text-blue-600" />
          <h2 className="text-lg font-semibold text-gray-900">年度別 居宅介護支援費 単位数</h2>
        </div>
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-blue-500" /></div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <CalendarDays size={20} className="text-blue-600" />
          <h2 className="text-lg font-semibold text-gray-900">年度別 居宅介護支援費 単位数</h2>
        </div>
        <button onClick={saveRates} disabled={savingRates} className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
          {savingRates ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 保存
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-4">介護報酬改定（約2年ごと）に合わせて年度別の単位数を管理します。レセプト生成時に請求月の年度から自動判定されます。</p>

      {/* Add fiscal year */}
      <div className="flex items-center gap-2 mb-4">
        <input
          type="text"
          value={newFy}
          onChange={(e) => setNewFy(e.target.value)}
          placeholder="年度（例: 2027）"
          className="rounded border px-3 py-1.5 text-sm w-40 focus:border-blue-500 focus:outline-none"
        />
        <button onClick={addFiscalYear} className="flex items-center gap-1 rounded border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
          <Plus size={14} /> 年度追加
        </button>
      </div>

      {/* Tables per fiscal year */}
      <div className="space-y-6">
        {fiscalYears.map((fy) => {
          const fyRates = rates.filter((r) => r.fiscal_year === fy);
          return (
            <div key={fy} className="rounded-lg border overflow-hidden">
              <div className="flex items-center justify-between bg-gray-50 px-4 py-2">
                <h3 className="text-sm font-bold text-gray-800">{fy}年度（{fy}年4月〜{Number(fy) + 1}年3月）</h3>
                <button onClick={() => deleteFiscalYear(fy)} className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1">
                  <Trash2 size={12} /> 削除
                </button>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-t">
                    <th className="px-3 py-2 text-left text-xs text-gray-600 w-24">要介護度</th>
                    <th className="px-3 py-2 text-right text-xs text-gray-600 w-24">単位数</th>
                    <th className="px-3 py-2 text-left text-xs text-gray-600 w-28">サービスコード</th>
                    <th className="px-3 py-2 text-left text-xs text-gray-600">サービス名称</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {CARE_LEVELS.map((cl) => {
                    const r = fyRates.find((x) => x.care_level === cl);
                    if (!r) return null;
                    return (
                      <tr key={cl}>
                        <td className="px-3 py-1.5 text-sm font-medium">{cl}</td>
                        <td className="px-3 py-1.5">
                          <input type="number" value={r.units} onChange={(e) => updateRate(fy, cl, "units", parseInt(e.target.value) || 0)}
                            className="w-full text-right rounded border px-2 py-1 text-sm focus:border-blue-500 focus:outline-none" />
                        </td>
                        <td className="px-3 py-1.5">
                          <input type="text" value={r.service_code} onChange={(e) => updateRate(fy, cl, "service_code", e.target.value)}
                            className="w-full rounded border px-2 py-1 text-sm font-mono focus:border-blue-500 focus:outline-none" />
                        </td>
                        <td className="px-3 py-1.5">
                          <input type="text" value={r.service_name} onChange={(e) => updateRate(fy, cl, "service_name", e.target.value)}
                            className="w-full rounded border px-2 py-1 text-sm focus:border-blue-500 focus:outline-none" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
        {fiscalYears.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-4">年度データがありません。Supabaseでマイグレーション014を実行してください。</p>
        )}
      </div>
    </div>
  );
}

// ─── 年度別特定事業所加算 ──────────────────────────────────────────────────

interface TokuteiKassanRate {
  id?: string;
  fiscal_year: string;
  business_type: string;
  kassan_type: string;
  units: number;
}

const KASSAN_TYPES = ["Ⅰ", "Ⅱ", "Ⅲ", "A"];
const BUSINESS_TYPES = ["居宅介護支援", "訪問介護"];

function FiscalYearTokuteiKassanSection() {
  const supabase = createClient();
  const [rates, setRates] = useState<TokuteiKassanRate[]>([]);
  const [loadingRates, setLoadingRates] = useState(true);
  const [savingRates, setSavingRates] = useState(false);
  const [newFy, setNewFy] = useState("");
  const [newBt, setNewBt] = useState(BUSINESS_TYPES[0]);

  useEffect(() => {
    const load = async () => {
      setLoadingRates(true);
      const { data } = await supabase
        .from("kaigo_tokutei_kassan_rates")
        .select("*")
        .order("fiscal_year", { ascending: false })
        .order("business_type")
        .order("kassan_type");
      setRates((data as TokuteiKassanRate[]) ?? []);
      setLoadingRates(false);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Unique [fiscal_year, business_type] combinations
  const groups = [...new Set(rates.map((r) => `${r.fiscal_year}|${r.business_type}`))]
    .sort()
    .reverse();

  const updateRate = (fy: string, bt: string, kt: string, units: number) => {
    setRates((prev) =>
      prev.map((r) =>
        r.fiscal_year === fy && r.business_type === bt && r.kassan_type === kt
          ? { ...r, units }
          : r
      )
    );
  };

  const addGroup = () => {
    if (!newFy) { toast.error("年度を入力してください"); return; }
    if (groups.includes(`${newFy}|${newBt}`)) { toast.error("既に存在します"); return; }
    const newRows: TokuteiKassanRate[] = KASSAN_TYPES.map((kt) => ({
      fiscal_year: newFy,
      business_type: newBt,
      kassan_type: kt,
      units: 0,
    }));
    setRates((prev) => [...newRows, ...prev]);
    setNewFy("");
  };

  const deleteGroup = async (fy: string, bt: string) => {
    if (!window.confirm(`${fy}年度 ${bt} のデータを削除しますか？`)) return;
    await supabase
      .from("kaigo_tokutei_kassan_rates")
      .delete()
      .eq("fiscal_year", fy)
      .eq("business_type", bt);
    setRates((prev) => prev.filter((r) => !(r.fiscal_year === fy && r.business_type === bt)));
    toast.success("削除しました");
  };

  const saveRates = async () => {
    setSavingRates(true);
    try {
      // 直接 state mutation せず、コピーに対して id 反映してから setState で commit
      const updated = [...rates];
      for (let i = 0; i < updated.length; i++) {
        const r = updated[i];
        if (r.id) {
          await supabase
            .from("kaigo_tokutei_kassan_rates")
            .update({ units: r.units })
            .eq("id", r.id);
        } else {
          const { data } = await supabase
            .from("kaigo_tokutei_kassan_rates")
            .upsert(
              {
                fiscal_year: r.fiscal_year,
                business_type: r.business_type,
                kassan_type: r.kassan_type,
                units: r.units,
              },
              { onConflict: "fiscal_year,business_type,kassan_type" }
            )
            .select("id")
            .single();
          if (data) updated[i] = { ...r, id: data.id };
        }
      }
      setRates(updated);
      toast.success("特定事業所加算単位数を保存しました");
    } catch (err) {
      toast.error("保存に失敗しました");
      console.error(err);
    } finally {
      setSavingRates(false);
    }
  };

  if (loadingRates) {
    return (
      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <CalendarDays size={20} className="text-purple-600" />
          <h2 className="text-lg font-semibold text-gray-900">年度別 特定事業所加算 単位数</h2>
        </div>
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-purple-500" /></div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <CalendarDays size={20} className="text-purple-600" />
          <h2 className="text-lg font-semibold text-gray-900">年度別 特定事業所加算 単位数</h2>
        </div>
        <button onClick={saveRates} disabled={savingRates} className="flex items-center gap-1 rounded-lg bg-purple-600 px-3 py-1.5 text-sm text-white hover:bg-purple-700 disabled:opacity-50">
          {savingRates ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 保存
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-4">居宅介護支援・訪問介護などサービス種別・年度ごとに特定事業所加算の単位数を管理します。</p>

      {/* Add group */}
      <div className="flex items-center gap-2 mb-4">
        <input
          type="text"
          value={newFy}
          onChange={(e) => setNewFy(e.target.value)}
          placeholder="年度（例: 2027）"
          className="rounded border px-3 py-1.5 text-sm w-32 focus:border-purple-500 focus:outline-none"
        />
        <select
          value={newBt}
          onChange={(e) => setNewBt(e.target.value)}
          className="rounded border px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none"
        >
          {BUSINESS_TYPES.map((bt) => <option key={bt} value={bt}>{bt}</option>)}
        </select>
        <button onClick={addGroup} className="flex items-center gap-1 rounded border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
          <Plus size={14} /> 追加
        </button>
      </div>

      {/* Tables */}
      <div className="space-y-4">
        {groups.map((key) => {
          const [fy, bt] = key.split("|");
          const groupRates = rates.filter((r) => r.fiscal_year === fy && r.business_type === bt);
          return (
            <div key={key} className="rounded-lg border overflow-hidden">
              <div className="flex items-center justify-between bg-gray-50 px-4 py-2">
                <h3 className="text-sm font-bold text-gray-800">
                  {fy}年度 - <span className="text-purple-700">{bt}</span>
                </h3>
                <button onClick={() => deleteGroup(fy, bt)} className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1">
                  <Trash2 size={12} /> 削除
                </button>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-t">
                    <th className="px-3 py-2 text-left text-xs text-gray-600">区分</th>
                    <th className="px-3 py-2 text-right text-xs text-gray-600">単位数</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {KASSAN_TYPES.map((kt) => {
                    const r = groupRates.find((x) => x.kassan_type === kt);
                    if (!r) return null;
                    return (
                      <tr key={kt}>
                        <td className="px-3 py-1.5 text-sm font-medium">特定事業所加算 {kt}</td>
                        <td className="px-3 py-1.5">
                          <input
                            type="number"
                            value={r.units}
                            onChange={(e) => updateRate(fy, bt, kt, parseInt(e.target.value) || 0)}
                            className="w-32 text-right rounded border px-2 py-1 text-sm focus:border-purple-500 focus:outline-none"
                          />
                          <span className="ml-2 text-xs text-gray-400">単位</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
        {groups.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-4">データがありません。Supabaseでマイグレーション015を実行してください。</p>
        )}
      </div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

// ─── 自事業所切替 ──────────────────────────────────────────────────────────

function OfficeSwitcher() {
  const { offices, currentOfficeId, setCurrentOfficeId, currentOffice } = useBusinessType();
  const typeLabel = (bt: string) =>
    bt === "care_manager" || bt === "居宅介護支援" ? "居宅介護支援"
    : bt === "home_care" || bt === "訪問介護" ? "訪問介護"
    : bt === "day_service" || bt === "通所介護" ? "通所介護"
    : bt;
  const shareUrl = typeof window !== "undefined" && currentOfficeId
    ? `${window.location.origin}/dashboard?office=${currentOfficeId}`
    : "";

  if (offices.length === 0) {
    return (
      <div className="rounded-lg border bg-yellow-50 p-4 max-w-lg">
        <p className="text-sm text-yellow-800">自事業所が登録されていません。下の「自事業所管理」から追加してください。</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white p-5 shadow-sm max-w-2xl">
      <div className="flex items-center gap-2 mb-3">
        <Building2 size={18} className="text-blue-600" />
        <h2 className="font-semibold text-gray-900">自事業所を選択</h2>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        現在操作している自事業所を選択します。事業種別（居宅介護支援／訪問介護）は事業所ごとに設定され、切り替えると自動的に追従します。
        <br />
        <span className="text-gray-400">※ 事業種別を変更したい場合は「マスタ管理 → 自事業所管理」で事業所ごとに設定してください。</span>
      </p>
      <div className="space-y-2">
        {offices.map((o) => {
          const isCurrent = o.id === currentOfficeId;
          return (
            <label
              key={o.id}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all ${
                isCurrent ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:bg-gray-50"
              }`}
            >
              <input
                type="radio"
                name="office"
                checked={isCurrent}
                onChange={() => setCurrentOfficeId(o.id)}
                className="accent-blue-600"
              />
              <div className="flex-1">
                <div className="text-sm font-semibold text-gray-900">{o.name || "(名称未設定)"}</div>
                <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500">
                  <span className="inline-block px-2 py-0.5 rounded-full bg-gray-100">{typeLabel(o.service_type)}</span>
                  {o.business_number && <span>事業所番号: {o.business_number}</span>}
                  {!o.is_active && <span className="text-red-500">停止中</span>}
                </div>
              </div>
            </label>
          );
        })}
      </div>
      {currentOffice && (
        <div className="mt-4 pt-3 border-t">
          <p className="text-xs text-gray-500 mb-1">共有用URL（別事業所として開く）</p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={shareUrl}
              className="flex-1 text-xs bg-gray-50 border rounded px-2 py-1.5 text-gray-600"
            />
            <button
              onClick={() => { navigator.clipboard.writeText(shareUrl); toast.success("URLをコピーしました"); }}
              className="shrink-0 p-1.5 rounded hover:bg-gray-100"
            >
              <Copy size={14} className="text-gray-500" />
            </button>
          </div>
          <p className="text-[10px] text-gray-400 mt-1">このURLを開くと、選択中の自事業所として操作できます</p>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const supabase = createClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!currentPassword) {
      toast.error("現在のパスワードを入力してください");
      return;
    }
    if (newPassword.length < 6) {
      toast.error("新しいパスワードは6文字以上で入力してください");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("新しいパスワードが一致しません");
      return;
    }

    setLoading(true);
    try {
      // Verify current password by attempting sign-in
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user?.email) {
        toast.error("ユーザー情報の取得に失敗しました");
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });
      if (signInError) {
        toast.error("現在のパスワードが正しくありません");
        return;
      }

      // Update password
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (updateError) {
        toast.error(`パスワードの変更に失敗しました: ${updateError.message}`);
        return;
      }

      toast.success("パスワードを変更しました");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "エラーが発生しました";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">設定</h1>
        <p className="mt-1 text-sm text-gray-500">
          アカウント設定・事業所設定・パスワード変更
        </p>
      </div>

      {/* 自事業所切替 */}
      <OfficeSwitcher />

      {/* Office Settings Link */}
      <Link
        href="/master/office"
        className="flex items-center justify-between rounded-lg border bg-white p-5 shadow-sm hover:shadow-md transition-shadow max-w-lg"
      >
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-purple-50 p-2.5">
            <Building2 size={20} className="text-purple-600" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-900">自事業所管理</h2>
            <p className="text-xs text-gray-500">複数の自事業所の登録・編集・切替</p>
          </div>
        </div>
        <ChevronRight size={18} className="text-gray-400" />
      </Link>

      {/* Password Change Card */}
      <div className="rounded-lg border bg-white p-6 shadow-sm max-w-lg">
        <div className="flex items-center gap-2 mb-6">
          <Settings size={20} className="text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">
            パスワード変更
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Current Password */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              現在のパスワード
            </label>
            <div className="relative">
              <input
                type={showCurrent ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full rounded-md border px-3 py-2 pr-10 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="現在のパスワードを入力"
              />
              <button
                type="button"
                onClick={() => setShowCurrent(!showCurrent)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showCurrent ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* New Password */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              新しいパスワード
            </label>
            <div className="relative">
              <input
                type={showNew ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-md border px-3 py-2 pr-10 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="6文字以上の新しいパスワード"
              />
              <button
                type="button"
                onClick={() => setShowNew(!showNew)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Confirm Password */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              新しいパスワード（確認）
            </label>
            <div className="relative">
              <input
                type={showConfirm ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-md border px-3 py-2 pr-10 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="新しいパスワードを再入力"
              />
              <button
                type="button"
                onClick={() => setShowConfirm(!showConfirm)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Submit */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "変更中..." : "パスワードを変更"}
            </button>
          </div>
        </form>
      </div>

      {/* 年度別単位数管理 */}
      <FiscalYearRatesSection />

      {/* 年度別特定事業所加算管理 */}
      <FiscalYearTokuteiKassanSection />
    </div>
  );
}
