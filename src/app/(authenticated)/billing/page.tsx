"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Receipt,
  Plus,
  Filter,
  RefreshCw,
  Loader2,
  TrendingUp,
  Wallet,
  CreditCard,
} from "lucide-react";
import { format } from "date-fns";
import { ja } from "date-fns/locale";

interface BillingRecord {
  id: string;
  user_id: string;
  billing_month: string;
  service_type: string;
  total_units: number;
  unit_price: number;
  total_amount: number;
  insurance_amount: number;
  copay_amount: number;
  status: "draft" | "submitted" | "paid";
  created_at: string;
  updated_at: string;
  kaigo_users?: { name: string };
}

const STATUS_LABELS: Record<string, string> = {
  draft: "下書き",
  submitted: "請求済",
  paid: "入金済",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  submitted: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
};

function formatAmount(amount: number): string {
  return amount.toLocaleString("ja-JP") + "円";
}

function formatMonth(yyyyMm: string): string {
  if (!yyyyMm) return "—";
  try {
    const [y, m] = yyyyMm.split("-");
    return `${y}年${parseInt(m, 10)}月`;
  } catch {
    return yyyyMm;
  }
}

function getCurrentMonth(): string {
  return format(new Date(), "yyyy-MM");
}

export default function BillingPage() {
  const supabase = createClient();
  const [records, setRecords] = useState<BillingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterMonth, setFilterMonth] = useState(getCurrentMonth());
  const [filterStatus, setFilterStatus] = useState("");

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from("kaigo_billing_records")
        .select("*, kaigo_users(name)")
        .order("billing_month", { ascending: false })
        .order("created_at", { ascending: false });

      if (filterMonth) query = query.eq("billing_month", filterMonth);
      if (filterStatus) query = query.eq("status", filterStatus);

      const { data, error } = await query.limit(500);
      if (error) throw error;
      setRecords(data || []);
    } catch (err: unknown) {
      toast.error(
        "請求データの取得に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoading(false);
    }
  }, [supabase, filterMonth, filterStatus]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const summary = records.reduce(
    (acc, r) => ({
      total_amount: acc.total_amount + (r.total_amount || 0),
      insurance_amount: acc.insurance_amount + (r.insurance_amount || 0),
      copay_amount: acc.copay_amount + (r.copay_amount || 0),
    }),
    { total_amount: 0, insurance_amount: 0, copay_amount: 0 }
  );

  const handleStatusChange = async (
    id: string,
    newStatus: "draft" | "submitted" | "paid"
  ) => {
    try {
      const { error } = await supabase
        .from("kaigo_billing_records")
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      toast.success("ステータスを更新しました");
      fetchRecords();
    } catch (err: unknown) {
      toast.error(
        "更新に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Receipt className="text-blue-600" size={24} />
          <h1 className="text-xl font-bold text-gray-900">請求管理</h1>
          <span className="ml-2 rounded-full bg-gray-100 px-2.5 py-0.5 text-sm text-gray-600">
            {records.length}件
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchRecords}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <RefreshCw size={14} />
            更新
          </button>
          <Link
            href="/billing/create"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Plus size={16} />
            請求データ作成
          </Link>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <TrendingUp size={15} className="text-blue-500" />
            請求合計
          </div>
          <p className="text-2xl font-bold text-gray-900">
            {formatAmount(summary.total_amount)}
          </p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <Wallet size={15} className="text-green-500" />
            保険請求額
          </div>
          <p className="text-2xl font-bold text-gray-900">
            {formatAmount(summary.insurance_amount)}
          </p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <CreditCard size={15} className="text-orange-500" />
            利用者負担合計
          </div>
          <p className="text-2xl font-bold text-gray-900">
            {formatAmount(summary.copay_amount)}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-3 text-sm font-medium text-gray-700">
          <Filter size={15} />
          絞り込み
        </div>
        <div className="flex flex-wrap gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">請求月</label>
            <input
              type="month"
              value={filterMonth}
              onChange={(e) => setFilterMonth(e.target.value)}
              className="rounded-lg border px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">ステータス</label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="rounded-lg border px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">すべて</option>
              <option value="draft">下書き</option>
              <option value="submitted">請求済</option>
              <option value="paid">入金済</option>
            </select>
          </div>
          {(filterMonth || filterStatus) && (
            <div className="flex items-end">
              <button
                onClick={() => {
                  setFilterMonth(getCurrentMonth());
                  setFilterStatus("");
                }}
                className="text-xs text-blue-600 hover:underline pb-1.5"
              >
                リセット
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-blue-500" />
          </div>
        ) : records.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">
            <Receipt size={40} className="mx-auto mb-3 opacity-20" />
            <p>請求データがありません</p>
            {filterMonth && (
              <p className="mt-1 text-xs text-gray-400">
                {formatMonth(filterMonth)}のデータはまだ作成されていません
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    利用者
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    請求月
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    サービス種別
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">
                    単位数
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">
                    請求額
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">
                    保険分
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">
                    自己負担
                  </th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">
                    ステータス
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {records.map((record) => (
                  <tr
                    key={record.id}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {record.kaigo_users?.name || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                      {formatMonth(record.billing_month)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700">
                        {record.service_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {(record.total_units || 0).toLocaleString("ja-JP")}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {formatAmount(record.total_amount || 0)}
                    </td>
                    <td className="px-4 py-3 text-right text-green-700">
                      {formatAmount(record.insurance_amount || 0)}
                    </td>
                    <td className="px-4 py-3 text-right text-orange-700">
                      {formatAmount(record.copay_amount || 0)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <select
                        value={record.status}
                        onChange={(e) =>
                          handleStatusChange(
                            record.id,
                            e.target.value as "draft" | "submitted" | "paid"
                          )
                        }
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium cursor-pointer border-0 focus:outline-none focus:ring-2 focus:ring-blue-500 ${STATUS_COLORS[record.status]}`}
                      >
                        {Object.entries(STATUS_LABELS).map(([val, label]) => (
                          <option key={val} value={val}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t bg-gray-50">
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-3 text-sm font-medium text-gray-600"
                  >
                    合計 ({records.length}件)
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-bold text-gray-900">
                    {formatAmount(summary.total_amount)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-bold text-green-700">
                    {formatAmount(summary.insurance_amount)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-bold text-orange-700">
                    {formatAmount(summary.copay_amount)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Navigation Links */}
      <div className="flex gap-4 text-sm">
        <Link
          href="/billing/history"
          className="text-blue-600 hover:underline flex items-center gap-1"
        >
          <TrendingUp size={14} />
          請求履歴・月次集計
        </Link>
      </div>
    </div>
  );
}
