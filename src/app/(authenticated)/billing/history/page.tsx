"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  BarChart2,
  Download,
  RefreshCw,
  Loader2,
  ChevronLeft,
} from "lucide-react";
import { format } from "date-fns";
import { ja } from "date-fns/locale";

interface BillingRecord {
  id: string;
  user_id: string;
  billing_month: string;
  service_type: string;
  total_units: number;
  total_amount: number;
  insurance_amount: number;
  copay_amount: number;
  status: string;
}

interface MonthlySummary {
  month: string;
  user_count: number;
  record_count: number;
  total_amount: number;
  insurance_amount: number;
  copay_amount: number;
}

function formatMonth(yyyyMm: string): string {
  if (!yyyyMm) return "—";
  const [y, m] = yyyyMm.split("-");
  return `${y}年${parseInt(m, 10)}月`;
}

function formatAmount(n: number): string {
  return n.toLocaleString("ja-JP") + "円";
}

export default function BillingHistoryPage() {
  const supabase = createClient();
  const [records, setRecords] = useState<BillingRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_billing_records")
        .select(
          "id, user_id, billing_month, service_type, total_units, total_amount, insurance_amount, copay_amount, status"
        )
        .order("billing_month", { ascending: false })
        .limit(1000);
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
  }, [supabase]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  // Aggregate by month
  const monthlySummaries: MonthlySummary[] = (() => {
    const map = new Map<string, MonthlySummary>();
    for (const r of records) {
      const month = r.billing_month;
      if (!map.has(month)) {
        map.set(month, {
          month,
          user_count: 0,
          record_count: 0,
          total_amount: 0,
          insurance_amount: 0,
          copay_amount: 0,
        });
      }
      const s = map.get(month)!;
      s.record_count += 1;
      s.total_amount += r.total_amount || 0;
      s.insurance_amount += r.insurance_amount || 0;
      s.copay_amount += r.copay_amount || 0;
    }
    // Count unique users per month
    const usersByMonth = new Map<string, Set<string>>();
    for (const r of records) {
      if (!usersByMonth.has(r.billing_month)) {
        usersByMonth.set(r.billing_month, new Set());
      }
      usersByMonth.get(r.billing_month)!.add(r.user_id);
    }
    for (const [month, summary] of map) {
      summary.user_count = usersByMonth.get(month)?.size ?? 0;
    }
    return Array.from(map.values()).sort((a, b) =>
      b.month.localeCompare(a.month)
    );
  })();

  // Bar chart: scale bars relative to max amount
  const maxAmount = Math.max(...monthlySummaries.map((s) => s.total_amount), 1);

  // CSV export (国保連請求CSV format)
  const handleCsvExport = () => {
    if (records.length === 0) {
      toast.error("エクスポートするデータがありません");
      return;
    }

    // 国保連請求CSV形式（簡易版）
    const header = [
      "レコード種別",
      "請求月",
      "被保険者番号",
      "利用者ID",
      "サービス種別",
      "単位数合計",
      "請求額合計",
      "保険請求額",
      "利用者負担額",
      "ステータス",
    ];

    const STATUS_CSV_LABELS: Record<string, string> = {
      draft: "下書き",
      submitted: "請求済",
      paid: "入金済",
    };

    const rows = records.map((r) => [
      "51", // サービス費用請求レコード種別
      r.billing_month.replace("-", ""), // YYYYMM
      "", // 被保険者番号（未設定）
      r.user_id,
      r.service_type,
      String(r.total_units || 0),
      String(r.total_amount || 0),
      String(r.insurance_amount || 0),
      String(r.copay_amount || 0),
      STATUS_CSV_LABELS[r.status] ?? r.status,
    ]);

    const csvContent =
      "\uFEFF" +
      [header, ...rows]
        .map((row) => row.map((cell) => `"${cell}"`).join(","))
        .join("\r\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `国保連請求_${format(new Date(), "yyyyMMddHHmm")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("国保連請求CSVをエクスポートしました");
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart2 className="text-blue-600" size={24} />
          <h1 className="text-xl font-bold text-gray-900">請求履歴</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchRecords}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <RefreshCw size={14} />
            更新
          </button>
          <button
            onClick={handleCsvExport}
            className="inline-flex items-center gap-1.5 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm font-medium text-green-700 hover:bg-green-100 transition-colors"
          >
            <Download size={14} />
            国保連請求CSV
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-500" />
        </div>
      ) : (
        <>
          {/* Bar Chart */}
          {monthlySummaries.length > 0 && (
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">
                月別請求額推移
              </h2>
              <div className="space-y-3">
                {[...monthlySummaries]
                  .slice(0, 12)
                  .reverse()
                  .map((s) => {
                    const barPct = Math.round(
                      (s.total_amount / maxAmount) * 100
                    );
                    const insPct =
                      s.total_amount > 0
                        ? Math.round(
                            (s.insurance_amount / s.total_amount) * barPct
                          )
                        : 0;
                    const copayPct = barPct - insPct;
                    return (
                      <div key={s.month} className="flex items-center gap-3">
                        <div className="w-20 text-right text-xs font-medium text-gray-600 shrink-0">
                          {formatMonth(s.month)}
                        </div>
                        <div className="flex-1 relative h-7 bg-gray-100 rounded-md overflow-hidden">
                          {/* Insurance portion */}
                          <div
                            className="absolute left-0 top-0 h-full bg-green-400 transition-all duration-500"
                            style={{ width: `${insPct}%` }}
                          />
                          {/* Copay portion */}
                          <div
                            className="absolute top-0 h-full bg-orange-400 transition-all duration-500"
                            style={{
                              left: `${insPct}%`,
                              width: `${copayPct}%`,
                            }}
                          />
                          {barPct > 8 && (
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs font-medium text-white drop-shadow">
                              {formatAmount(s.total_amount)}
                            </span>
                          )}
                        </div>
                        <div className="w-28 text-right text-xs text-gray-500 shrink-0">
                          {s.user_count}名
                        </div>
                      </div>
                    );
                  })}
              </div>
              {/* Legend */}
              <div className="mt-4 flex items-center gap-4 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm bg-green-400" />
                  保険請求額
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm bg-orange-400" />
                  利用者負担
                </span>
              </div>
            </div>
          )}

          {/* Monthly Summary Table */}
          <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">
                月次集計
              </h2>
              <span className="text-xs text-gray-400">
                {monthlySummaries.length}ヶ月分
              </span>
            </div>
            {monthlySummaries.length === 0 ? (
              <div className="py-16 text-center text-sm text-gray-400">
                <BarChart2 size={40} className="mx-auto mb-3 opacity-20" />
                請求データがありません
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-gray-600">
                        請求月
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-gray-600">
                        請求人数
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-gray-600">
                        件数
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-gray-600">
                        請求合計
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-gray-600">
                        保険請求額
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-gray-600">
                        利用者負担
                      </th>
                      <th className="px-4 py-3 text-center font-medium text-gray-600">
                        詳細
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {monthlySummaries.map((s) => (
                      <tr
                        key={s.month}
                        className="hover:bg-gray-50 transition-colors"
                      >
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {formatMonth(s.month)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-700">
                          {s.user_count}名
                        </td>
                        <td className="px-4 py-3 text-right text-gray-500">
                          {s.record_count}件
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-gray-900">
                          {formatAmount(s.total_amount)}
                        </td>
                        <td className="px-4 py-3 text-right text-green-700">
                          {formatAmount(s.insurance_amount)}
                        </td>
                        <td className="px-4 py-3 text-right text-orange-700">
                          {formatAmount(s.copay_amount)}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Link
                            href={`/billing?month=${s.month}`}
                            className="text-xs text-blue-600 hover:underline"
                          >
                            明細を見る
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {monthlySummaries.length > 0 && (
                    <tfoot className="border-t bg-gray-50">
                      <tr>
                        <td
                          colSpan={3}
                          className="px-4 py-3 text-sm font-medium text-gray-600"
                        >
                          累計合計
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-bold text-gray-900">
                          {formatAmount(
                            monthlySummaries.reduce(
                              (acc, s) => acc + s.total_amount,
                              0
                            )
                          )}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-bold text-green-700">
                          {formatAmount(
                            monthlySummaries.reduce(
                              (acc, s) => acc + s.insurance_amount,
                              0
                            )
                          )}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-bold text-orange-700">
                          {formatAmount(
                            monthlySummaries.reduce(
                              (acc, s) => acc + s.copay_amount,
                              0
                            )
                          )}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Back link */}
      <div>
        <Link
          href="/billing"
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
        >
          <ChevronLeft size={14} />
          請求管理に戻る
        </Link>
      </div>
    </div>
  );
}
