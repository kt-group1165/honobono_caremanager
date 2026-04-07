"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Download,
  ChevronLeft,
  ChevronRight,
  Loader2,
  User,
  BarChart3,
  RefreshCw,
} from "lucide-react";
import { format, startOfMonth, endOfMonth, parseISO, differenceInMinutes, parse } from "date-fns";
import { ja } from "date-fns/locale";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawRecord {
  id: string;
  user_id: string;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  service_type: string;
  kaigo_users: { name: string; name_kana: string | null } | { name: string; name_kana: string | null }[] | null;
}

interface BillingRow {
  user_id: string;
  user_name: string;
  user_name_kana: string | null;
  service_type: string;
  total_visits: number;
  total_minutes: number;
  total_units: number; // estimate: 1 unit per 20 min for 身体 or 1 per 20 min for 生活
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Simplified unit calculation: 1 unit = 20 minutes (placeholder logic)
const MINUTES_PER_UNIT = 20;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcMinutes(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  try {
    const s = parse(start, "HH:mm:ss", new Date());
    const e = parse(end, "HH:mm:ss", new Date());
    const diff = differenceInMinutes(e, s);
    return diff > 0 ? diff : 0;
  } catch {
    return 0;
  }
}

function formatMinutes(mins: number): string {
  if (mins === 0) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}時間${m > 0 ? m + "分" : ""}` : `${m}分`;
}

function escapeCSV(val: string | number | null | undefined): string {
  const s = String(val ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function VisitBillingPage() {
  const supabase = createClient();

  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [records, setRecords] = useState<RawRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const monthLabel = format(currentMonth, "yyyy年M月", { locale: ja });

  const fetchRecords = async (month: Date) => {
    setLoading(true);
    const from = format(startOfMonth(month), "yyyy-MM-dd");
    const to = format(endOfMonth(month), "yyyy-MM-dd");

    const { data, error } = await supabase
      .from("kaigo_visit_records")
      .select(`
        id,
        user_id,
        visit_date,
        start_time,
        end_time,
        service_type,
        kaigo_users(name, name_kana)
      `)
      .gte("visit_date", from)
      .lte("visit_date", to)
      .order("visit_date");

    if (error) {
      toast.error("実績データの取得に失敗しました");
    } else {
      setRecords(data || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchRecords(currentMonth);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMonth]);

  // Aggregate by user + service_type
  const billingRows = useMemo((): BillingRow[] => {
    const map = new Map<string, BillingRow>();

    for (const rec of records) {
      const key = `${rec.user_id}__${rec.service_type}`;
      const mins = calcMinutes(rec.start_time, rec.end_time);

      if (map.has(key)) {
        const row = map.get(key)!;
        row.total_visits += 1;
        row.total_minutes += mins;
        row.total_units = Math.ceil(row.total_minutes / MINUTES_PER_UNIT);
      } else {
        map.set(key, {
          user_id: rec.user_id,
          user_name: (Array.isArray(rec.kaigo_users) ? rec.kaigo_users[0]?.name : rec.kaigo_users?.name) ?? "不明",
          user_name_kana: (Array.isArray(rec.kaigo_users) ? rec.kaigo_users[0]?.name_kana : rec.kaigo_users?.name_kana) ?? null,
          service_type: rec.service_type,
          total_visits: 1,
          total_minutes: mins,
          total_units: Math.ceil(mins / MINUTES_PER_UNIT),
        });
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      const kana = (a.user_name_kana ?? a.user_name).localeCompare(
        b.user_name_kana ?? b.user_name,
        "ja"
      );
      if (kana !== 0) return kana;
      return a.service_type.localeCompare(b.service_type, "ja");
    });
  }, [records]);

  // Totals
  const totals = useMemo(() => {
    return billingRows.reduce(
      (acc, row) => ({
        visits: acc.visits + row.total_visits,
        minutes: acc.minutes + row.total_minutes,
        units: acc.units + row.total_units,
      }),
      { visits: 0, minutes: 0, units: 0 }
    );
  }, [billingRows]);

  // CSV export
  const handleExportCSV = () => {
    const headers = ["利用者名", "ふりがな", "サービス種別", "訪問回数", "提供時間（分）", "単位数（概算）"];
    const rows = billingRows.map((row) => [
      escapeCSV(row.user_name),
      escapeCSV(row.user_name_kana),
      escapeCSV(row.service_type),
      escapeCSV(row.total_visits),
      escapeCSV(row.total_minutes),
      escapeCSV(row.total_units),
    ]);

    const csvContent = [
      `# 訪問介護実績 ${monthLabel}`,
      headers.join(","),
      ...rows.map((r) => r.join(",")),
      `,,合計,${totals.visits},${totals.minutes},${totals.units}`,
    ].join("\n");

    const bom = "\uFEFF";
    const blob = new Blob([bom + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `visit_billing_${format(currentMonth, "yyyyMM")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("CSVをダウンロードしました");
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-white px-6 py-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">実績管理</h1>
          <p className="mt-0.5 text-xs text-gray-500">月別の訪問介護サービス実績を集計します</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Month selector */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              className="rounded-lg border border-gray-300 p-1.5 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="min-w-[7rem] text-center text-sm font-semibold text-gray-900">
              {monthLabel}
            </span>
            <button
              onClick={() => setCurrentMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              className="rounded-lg border border-gray-300 p-1.5 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <button
            onClick={() => fetchRecords(currentMonth)}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            更新
          </button>

          <button
            onClick={handleExportCSV}
            disabled={loading || billingRows.length === 0}
            className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60 transition-colors"
          >
            <Download size={15} />
            CSV出力
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 border-b bg-gray-50 px-6 py-4">
        <div className="rounded-xl bg-white border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-500">延べ訪問回数</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{totals.visits}<span className="ml-1 text-sm font-normal text-gray-500">回</span></p>
        </div>
        <div className="rounded-xl bg-white border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-500">延べ提供時間</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">
            {formatMinutes(totals.minutes)}
            {totals.minutes > 0 && (
              <span className="ml-1 text-xs font-normal text-gray-400">({totals.minutes}分)</span>
            )}
          </p>
        </div>
        <div className="rounded-xl bg-white border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-500">概算単位数 <span className="text-[10px] text-gray-400">(20分=1単位)</span></p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{totals.units}<span className="ml-1 text-sm font-normal text-gray-500">単位</span></p>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" />
            集計中...
          </div>
        ) : billingRows.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-400">
            <div className="text-center">
              <BarChart3 size={32} className="mx-auto mb-2 text-gray-300" />
              <p>{monthLabel}の実績データがありません</p>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">利用者名</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">サービス種別</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500">訪問回数</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500">提供時間</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500">単位数(概算)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {billingRows.map((row, i) => (
                  <tr key={`${row.user_id}-${row.service_type}-${i}`} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-blue-600 shrink-0">
                          <User size={13} />
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{row.user_name}</p>
                          {row.user_name_kana && (
                            <p className="text-[11px] text-gray-400">{row.user_name_kana}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700">
                        {row.service_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">
                      {row.total_visits}<span className="ml-0.5 text-xs font-normal text-gray-500">回</span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {formatMinutes(row.total_minutes)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">
                      {row.total_units}<span className="ml-0.5 text-xs font-normal text-gray-500">単位</span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-200 bg-gray-50">
                  <td colSpan={2} className="px-4 py-3 text-sm font-bold text-gray-700">合計</td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">
                    {totals.visits}<span className="ml-0.5 text-xs font-normal">回</span>
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">
                    {formatMinutes(totals.minutes)}
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">
                    {totals.units}<span className="ml-0.5 text-xs font-normal">単位</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Footer note */}
      <div className="border-t bg-white px-6 py-2.5 text-xs text-gray-400">
        ※ 単位数は概算（20分=1単位）です。正式な単位計算はサービスコードマスタに基づいて行ってください。
        介護給付費の請求には「請求管理」メニューをご利用ください。
      </div>
    </div>
  );
}
