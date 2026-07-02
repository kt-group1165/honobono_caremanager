"use client";

/**
 * 利用請求 — 利用者本人への請求一覧 (参考: ほのぼの 利用請求タブ)
 *
 * 左: 利用者一覧 (名前 / 請求額 = 利用者負担額)
 * 右: 利用明細欄 (利用料項目 / 単価 / 数量 / 金額)
 */

import { useState } from "react";
import { Loader2, Receipt, AlertCircle, Printer } from "lucide-react";
import { MonthNav } from "../_shared/month-nav";
import { useSeikyuData } from "../_shared/use-seikyu-data";

export function RiyouSeikyuContent() {
  const { year, month, onMonthChange, rows, loading, error, officeName } =
    useSeikyuData();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const selected = rows.find((r) => r.user_id === selectedUserId) ?? rows[0] ?? null;
  const totalBilled = rows.reduce((s, r) => s + r.userAmount, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <Receipt size={20} className="text-emerald-600" />
            利用請求
          </h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {officeName ?? ""} — 利用者本人への請求 (負担割合分) 一覧
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MonthNav year={year} month={month} onChange={onMonthChange} />
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            <Printer size={14} />
            印刷
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 size={20} className="mr-2 animate-spin" />
          集計中...
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-gray-50 p-12 text-center text-sm text-gray-500">
          対象月の実績 (完了) がありません
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {/* 左: 請求一覧 */}
          <div className="lg:col-span-3 overflow-hidden rounded-lg border bg-white shadow-sm">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-600">
                <tr>
                  <th className="px-3 py-2">利用者名</th>
                  <th className="px-3 py-2">被保険者番号</th>
                  <th className="px-3 py-2 text-center">負担割合</th>
                  <th className="px-3 py-2 text-right">請求額</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr
                    key={r.user_id}
                    onClick={() => setSelectedUserId(r.user_id)}
                    className={
                      "cursor-pointer transition-colors " +
                      (selected?.user_id === r.user_id
                        ? "bg-emerald-50"
                        : "hover:bg-gray-50")
                    }
                  >
                    <td className="px-3 py-2 font-medium">{r.user_name}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.insured_number ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      {Math.round(r.copay_rate * 100)}割
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-700">
                      ¥{r.userAmount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                <tr>
                  <td className="px-3 py-2 text-xs text-gray-500" colSpan={3}>
                    請求額合計 ({rows.length} 名)
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-700">
                    ¥{totalBilled.toLocaleString()}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* 右: 利用明細欄 */}
          <div className="lg:col-span-2 rounded-lg border bg-white shadow-sm">
            <header className="border-b bg-gray-50 px-4 py-2 text-sm font-bold text-gray-800">
              利用明細欄 {selected ? `— ${selected.user_name}` : ""}
            </header>
            {selected ? (
              <div className="p-3">
                <table className="min-w-full text-xs">
                  <thead className="text-left text-[10px] text-gray-500">
                    <tr>
                      <th className="px-2 py-1">利用料項目</th>
                      <th className="px-2 py-1 text-right">単価</th>
                      <th className="px-2 py-1 text-right">数量</th>
                      <th className="px-2 py-1 text-right">金額</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {selected.details.map((d) => {
                      // 明細ごとの利用者負担額 (比例配分)
                      const share =
                        selected.totalUnits > 0
                          ? Math.floor(
                              (d.units / selected.totalUnits) * selected.userAmount,
                            )
                          : 0;
                      return (
                        <tr key={d.service_type}>
                          <td className="px-2 py-1.5">
                            {d.short_name ?? d.service_type}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {d.unit_per.toLocaleString()}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{d.count}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            ¥{share.toLocaleString()}
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="font-semibold">
                      <td className="px-2 py-1.5">利用者負担額 合計</td>
                      <td></td>
                      <td></td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-emerald-700">
                        ¥{selected.userAmount.toLocaleString()}
                      </td>
                    </tr>
                  </tbody>
                </table>

                <div className="mt-4 space-y-1 rounded border bg-gray-50 p-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">合計金額</span>
                    <span className="font-bold tabular-nums">
                      ¥{selected.userAmount.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">消費税額</span>
                    <span className="tabular-nums">¥0 (非課税)</span>
                  </div>
                  <div className="flex justify-between text-emerald-700">
                    <span className="font-bold">請求金額</span>
                    <span className="font-bold tabular-nums">
                      ¥{selected.userAmount.toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-gray-400">
                左の一覧から利用者を選択
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
