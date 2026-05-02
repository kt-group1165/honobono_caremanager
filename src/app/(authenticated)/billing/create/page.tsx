"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Receipt,
  ChevronRight,
  ChevronLeft,
  Check,
  Loader2,
  Users,
  Calendar,
  FileText,
  Save,
} from "lucide-react";
import { format, startOfMonth, endOfMonth, parseISO } from "date-fns";
import { ja } from "date-fns/locale";

// 共通マスタ clients の subset。Phase 2-3-8 で kaigo_users から張替え。
//   kaigo_users.name_kana → clients.furigana
interface KaigoUser {
  id: string;
  name: string;
  furigana: string | null;
}

interface ServiceRecord {
  id: string;
  user_id: string;
  service_date: string;
  service_type: string;
  start_time: string | null;
  end_time: string | null;
}

interface BillingPreviewItem {
  user_id: string;
  user_name: string;
  service_type: string;
  total_units: number;
  unit_price: number;
  total_amount: number;
  insurance_amount: number;
  copay_amount: number;
  details: {
    service_date: string;
    service_code: string;
    service_name: string;
    units: number;
    amount: number;
  }[];
}

// Simple unit calculation: each service record = 1 unit, unit price defaults by type
const UNIT_PRICES: Record<string, number> = {
  訪問介護: 396,
  訪問看護: 821,
  訪問リハビリ: 302,
  通所介護: 728,
  通所リハビリ: 712,
  短期入所: 820,
  居宅療養管理指導: 298,
  福祉用具貸与: 100,
  その他: 200,
};

const COPAY_RATE = 0.1; // 1割負担（デフォルト）

function getServiceCode(serviceType: string): string {
  const codes: Record<string, string> = {
    訪問介護: "11",
    訪問看護: "13",
    訪問リハビリ: "14",
    通所介護: "15",
    通所リハビリ: "16",
    短期入所: "21",
    居宅療養管理指導: "31",
    福祉用具貸与: "17",
    その他: "99",
  };
  return codes[serviceType] || "99";
}

function formatMonth(yyyyMm: string): string {
  if (!yyyyMm) return "—";
  const [y, m] = yyyyMm.split("-");
  return `${y}年${parseInt(m, 10)}月`;
}

export default function BillingCreatePage() {
  const router = useRouter();
  const supabase = createClient();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [billingMonth, setBillingMonth] = useState(
    format(new Date(), "yyyy-MM")
  );
  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(
    new Set()
  );
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewItems, setPreviewItems] = useState<BillingPreviewItem[]>([]);

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const { data, error } = await supabase
        .from("clients")
        .select("id, name, furigana")
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("furigana", { nullsFirst: false });
      if (error) throw error;
      setUsers(data || []);
      // Select all by default
      setSelectedUserIds(new Set((data || []).map((u: KaigoUser) => u.id)));
    } catch (err: unknown) {
      toast.error(
        "利用者の取得に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoadingUsers(false);
    }
  }, [supabase]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const generatePreview = useCallback(async () => {
    if (selectedUserIds.size === 0) {
      toast.error("利用者を1名以上選択してください");
      return;
    }
    setLoadingPreview(true);
    try {
      const [year, month] = billingMonth.split("-").map(Number);
      const startDate = format(
        startOfMonth(new Date(year, month - 1)),
        "yyyy-MM-dd"
      );
      const endDate = format(
        endOfMonth(new Date(year, month - 1)),
        "yyyy-MM-dd"
      );

      const { data: serviceRecords, error } = await supabase
        .from("kaigo_service_records")
        .select("id, user_id, service_date, service_type, start_time, end_time")
        .in("user_id", Array.from(selectedUserIds))
        .gte("service_date", startDate)
        .lte("service_date", endDate)
        .order("service_date");

      if (error) throw error;

      // Group by user_id + service_type
      const grouped = new Map<string, ServiceRecord[]>();
      for (const rec of serviceRecords || []) {
        const key = `${rec.user_id}__${rec.service_type}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(rec);
      }

      const userMap = new Map(users.map((u) => [u.id, u]));
      const items: BillingPreviewItem[] = [];

      for (const [key, recs] of grouped) {
        const [userId, serviceType] = key.split("__");
        const user = userMap.get(userId);
        if (!user) continue;

        const unitPrice = UNIT_PRICES[serviceType] ?? 200;
        const totalUnits = recs.length; // 1 record = 1 unit
        const totalAmount = totalUnits * unitPrice * 10; // 単位×単価×10円
        const copayAmount = Math.floor(totalAmount * COPAY_RATE);
        const insuranceAmount = totalAmount - copayAmount;

        const details = recs.map((r) => ({
          service_date: r.service_date,
          service_code: getServiceCode(serviceType),
          service_name: serviceType,
          units: 1,
          amount: unitPrice * 10,
        }));

        items.push({
          user_id: userId,
          user_name: user.name,
          service_type: serviceType,
          total_units: totalUnits,
          unit_price: unitPrice,
          total_amount: totalAmount,
          insurance_amount: insuranceAmount,
          copay_amount: copayAmount,
          details,
        });
      }

      if (items.length === 0) {
        toast.error(
          `${formatMonth(billingMonth)}のサービス実績が見つかりません`
        );
      }

      setPreviewItems(items);
    } catch (err: unknown) {
      toast.error(
        "プレビューの生成に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoadingPreview(false);
    }
  }, [supabase, billingMonth, selectedUserIds, users]);

  const handleGoToStep2 = () => {
    if (!billingMonth) {
      toast.error("請求月を選択してください");
      return;
    }
    setStep(2);
  };

  const handleGoToStep3 = async () => {
    await generatePreview();
    setStep(3);
  };

  const handleSave = async () => {
    if (previewItems.length === 0) {
      toast.error("保存するデータがありません");
      return;
    }
    setSaving(true);
    try {
      // Check for existing records for this month
      const { data: existing } = await supabase
        .from("kaigo_billing_records")
        .select("id")
        .eq("billing_month", billingMonth)
        .in(
          "user_id",
          previewItems.map((i) => i.user_id)
        )
        .limit(1);

      if (existing && existing.length > 0) {
        const ok = window.confirm(
          `${formatMonth(billingMonth)}の請求データが既に存在します。上書きしますか？`
        );
        if (!ok) {
          setSaving(false);
          return;
        }
        // Delete existing records for this month/users
        await supabase
          .from("kaigo_billing_records")
          .delete()
          .eq("billing_month", billingMonth)
          .in(
            "user_id",
            previewItems.map((i) => i.user_id)
          );
      }

      const now = new Date().toISOString();

      // Insert billing records
      const billingRows = previewItems.map((item) => ({
        user_id: item.user_id,
        billing_month: billingMonth,
        service_type: item.service_type,
        total_units: item.total_units,
        unit_price: item.unit_price,
        total_amount: item.total_amount,
        insurance_amount: item.insurance_amount,
        copay_amount: item.copay_amount,
        status: "draft" as const,
        created_at: now,
        updated_at: now,
      }));

      const { data: insertedRecords, error: insertError } = await supabase
        .from("kaigo_billing_records")
        .insert(billingRows)
        .select("id");

      if (insertError) throw insertError;

      // Insert billing details
      const detailRows: {
        billing_record_id: string;
        service_date: string;
        service_code: string;
        service_name: string;
        units: number;
        amount: number;
        created_at: string;
      }[] = [];
      for (let i = 0; i < previewItems.length; i++) {
        const item = previewItems[i];
        const recordId = insertedRecords?.[i]?.id;
        if (!recordId) continue;
        for (const detail of item.details) {
          detailRows.push({
            billing_record_id: recordId,
            service_date: detail.service_date,
            service_code: detail.service_code,
            service_name: detail.service_name,
            units: detail.units,
            amount: detail.amount,
            created_at: now,
          });
        }
      }

      if (detailRows.length > 0) {
        const { error: detailError } = await supabase
          .from("kaigo_billing_details")
          .insert(detailRows);
        if (detailError) throw detailError;
      }

      toast.success(
        `${formatMonth(billingMonth)}の請求データを${previewItems.length}件作成しました`
      );
      router.push("/billing");
    } catch (err: unknown) {
      toast.error(
        "保存に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const toggleUser = (id: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedUserIds.size === users.length) {
      setSelectedUserIds(new Set());
    } else {
      setSelectedUserIds(new Set(users.map((u) => u.id)));
    }
  };

  const previewSummary = previewItems.reduce(
    (acc, item) => ({
      total_amount: acc.total_amount + item.total_amount,
      insurance_amount: acc.insurance_amount + item.insurance_amount,
      copay_amount: acc.copay_amount + item.copay_amount,
    }),
    { total_amount: 0, insurance_amount: 0, copay_amount: 0 }
  );

  const STEPS = [
    { num: 1, label: "請求月選択", icon: Calendar },
    { num: 2, label: "利用者選択", icon: Users },
    { num: 3, label: "確認・保存", icon: FileText },
  ];

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Receipt className="text-blue-600" size={24} />
        <h1 className="text-xl font-bold text-gray-900">請求データ作成</h1>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center gap-0">
        {STEPS.map((s, idx) => {
          const Icon = s.icon;
          const isActive = step === s.num;
          const isDone = step > s.num;
          return (
            <div key={s.num} className="flex items-center">
              <div
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-blue-600 text-white"
                    : isDone
                      ? "bg-green-100 text-green-700"
                      : "bg-gray-100 text-gray-400"
                }`}
              >
                {isDone ? (
                  <Check size={15} />
                ) : (
                  <Icon size={15} />
                )}
                <span>
                  {s.num}. {s.label}
                </span>
              </div>
              {idx < STEPS.length - 1 && (
                <ChevronRight size={18} className="text-gray-300 mx-1" />
              )}
            </div>
          );
        })}
      </div>

      {/* Step 1: Select billing month */}
      {step === 1 && (
        <div className="rounded-xl border bg-white p-6 shadow-sm space-y-6">
          <div>
            <h2 className="text-base font-semibold text-gray-900 mb-1 flex items-center gap-2">
              <Calendar size={18} className="text-blue-500" />
              ステップ1：請求月を選択
            </h2>
            <p className="text-sm text-gray-500">
              請求データを作成する対象月を選択してください。
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              請求月 <span className="text-red-500">*</span>
            </label>
            <input
              type="month"
              value={billingMonth}
              onChange={(e) => setBillingMonth(e.target.value)}
              className="rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 w-48"
            />
            {billingMonth && (
              <p className="mt-2 text-sm text-gray-600">
                対象月：
                <span className="font-medium text-gray-900">
                  {formatMonth(billingMonth)}
                </span>
              </p>
            )}
          </div>
          <div className="flex justify-end">
            <button
              onClick={handleGoToStep2}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
            >
              次へ
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Select users */}
      {step === 2 && (
        <div className="rounded-xl border bg-white p-6 shadow-sm space-y-6">
          <div>
            <h2 className="text-base font-semibold text-gray-900 mb-1 flex items-center gap-2">
              <Users size={18} className="text-blue-500" />
              ステップ2：対象利用者を選択
            </h2>
            <p className="text-sm text-gray-500">
              {formatMonth(billingMonth)}の請求対象となる利用者を選択してください。
            </p>
          </div>

          {loadingUsers ? (
            <div className="flex items-center gap-2 text-gray-400 py-8 justify-center">
              <Loader2 size={20} className="animate-spin" />
              読み込み中...
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-3">
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedUserIds.size === users.length && users.length > 0}
                    onChange={toggleAll}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  すべて選択 ({users.length}名)
                </label>
                <span className="text-xs text-gray-500">
                  {selectedUserIds.size}名選択中
                </span>
              </div>
              <div className="rounded-lg border divide-y max-h-80 overflow-y-auto">
                {users.map((user) => (
                  <label
                    key={user.id}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedUserIds.has(user.id)}
                      onChange={() => toggleUser(user.id)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div>
                      <span className="text-sm font-medium text-gray-900">
                        {user.name}
                      </span>
                      <span className="ml-2 text-xs text-gray-400">
                        {user.furigana ?? ""}
                      </span>
                    </div>
                  </label>
                ))}
                {users.length === 0 && (
                  <div className="px-4 py-8 text-sm text-center text-gray-400">
                    在籍中の利用者がいません
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-between">
            <button
              onClick={() => setStep(1)}
              className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <ChevronLeft size={16} />
              戻る
            </button>
            <button
              onClick={handleGoToStep3}
              disabled={selectedUserIds.size === 0 || loadingPreview}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loadingPreview && <Loader2 size={14} className="animate-spin" />}
              プレビュー生成
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Preview and save */}
      {step === 3 && (
        <div className="rounded-xl border bg-white p-6 shadow-sm space-y-6">
          <div>
            <h2 className="text-base font-semibold text-gray-900 mb-1 flex items-center gap-2">
              <FileText size={18} className="text-blue-500" />
              ステップ3：確認・保存
            </h2>
            <p className="text-sm text-gray-500">
              {formatMonth(billingMonth)}の請求データのプレビューです。内容を確認して保存してください。
            </p>
          </div>

          {/* Preview summary */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg bg-blue-50 p-3 text-center">
              <p className="text-xs text-blue-600 mb-1">請求合計</p>
              <p className="text-lg font-bold text-blue-900">
                {previewSummary.total_amount.toLocaleString("ja-JP")}円
              </p>
            </div>
            <div className="rounded-lg bg-green-50 p-3 text-center">
              <p className="text-xs text-green-600 mb-1">保険請求額</p>
              <p className="text-lg font-bold text-green-900">
                {previewSummary.insurance_amount.toLocaleString("ja-JP")}円
              </p>
            </div>
            <div className="rounded-lg bg-orange-50 p-3 text-center">
              <p className="text-xs text-orange-600 mb-1">自己負担合計</p>
              <p className="text-lg font-bold text-orange-900">
                {previewSummary.copay_amount.toLocaleString("ja-JP")}円
              </p>
            </div>
          </div>

          {previewItems.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-gray-400">
              サービス実績が見つかりませんでした。
              <br />
              {formatMonth(billingMonth)}にサービス記録が登録されていない可能性があります。
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-gray-50">
                  <tr>
                    <th className="px-3 py-2.5 text-left font-medium text-gray-600">
                      利用者
                    </th>
                    <th className="px-3 py-2.5 text-left font-medium text-gray-600">
                      サービス種別
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium text-gray-600">
                      単位数
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium text-gray-600">
                      単価
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium text-gray-600">
                      請求額
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium text-gray-600">
                      保険分
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium text-gray-600">
                      自己負担
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {previewItems.map((item, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-3 py-2.5 font-medium text-gray-900">
                        {item.user_name}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                          {item.service_type}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-gray-700">
                        {item.total_units}
                      </td>
                      <td className="px-3 py-2.5 text-right text-gray-500">
                        {item.unit_price}単位/回
                      </td>
                      <td className="px-3 py-2.5 text-right font-medium text-gray-900">
                        {item.total_amount.toLocaleString("ja-JP")}円
                      </td>
                      <td className="px-3 py-2.5 text-right text-green-700">
                        {item.insurance_amount.toLocaleString("ja-JP")}円
                      </td>
                      <td className="px-3 py-2.5 text-right text-orange-700">
                        {item.copay_amount.toLocaleString("ja-JP")}円
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-between">
            <button
              onClick={() => setStep(2)}
              className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <ChevronLeft size={16} />
              戻る
            </button>
            <button
              onClick={handleSave}
              disabled={saving || previewItems.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              請求データを保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
