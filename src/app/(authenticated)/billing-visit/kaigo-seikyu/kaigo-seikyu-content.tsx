"use client";

/**
 * 介護請求 — 利用者ごとの月次単位数集計 (参考: ほのぼの 介護請求タブ)
 *
 * 左: 利用者一覧 (1 行 = 1 利用者、被保険者番号 / 名前 / 総単位数 / 保険請求額)
 * 右: 選択利用者の 明細情報 (サービス内容 / 単位数/単価 / 回数 / 単位数)
 */

import { useState } from "react";
import { Loader2, Calculator, AlertCircle } from "lucide-react";
import { MonthNav } from "../_shared/month-nav";
import { useSeikyuData } from "../_shared/use-seikyu-data";

export function KaigoSeikyuContent() {
  const { year, month, onMonthChange, rows, recordCount, loading, error, officeName } =
    useSeikyuData();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const selected = rows.find((r) => r.user_id === selectedUserId) ?? rows[0] ?? null;

  const totalUnits = rows.reduce((s, r) => s + r.totalUnits, 0);
  const totalInsurance = rows.reduce((s, r) => s + r.insuranceAmount, 0);
  const totalUser = rows.reduce((s, r) => s + r.userAmount, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <Calculator size={20} className="text-blue-600" />
            介護請求
          </h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {officeName ?? ""} — 実績 (完了) ベースの月次集計。利用者ごとに単位数と保険請求額を表示
          </p>
        </div>
        <MonthNav year={year} month={month} onChange={onMonthChange} />
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
          対象月の実績 (完了) がありません。サービス提供表で実績を確定してください。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {/* 左: 利用者一覧 */}
          <div className="lg:col-span-3 rounded-lg border bg-white shadow-sm overflow-hidden">
            <table className="min-w-full text-sm">
              <thead className="bg-blue-100 text-left text-xs font-medium text-blue-900">
                <tr>
                  <th className="px-3 py-2">被保険者番号</th>
                  <th className="px-3 py-2">利用者名</th>
                  <th className="px-3 py-2">要介護度</th>
                  <th className="px-3 py-2 text-right">総単位数</th>
                  <th className="px-3 py-2 text-right">保険請求額</th>
                  <th className="px-3 py-2 text-right">利用者負担</th>
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
                        ? "bg-blue-50"
                        : "hover:bg-gray-50")
                    }
                  >
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.insured_number ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-medium">{r.user_name}</td>
                    <td className="px-3 py-2 text-xs">{r.care_level ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.totalUnits.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-blue-700">
                      {r.insuranceAmount.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                      {r.userAmount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                <tr>
                  <td className="px-3 py-2 text-xs text-gray-500" colSpan={2}>
                    合計 {rows.length} 名 / 実績 {recordCount} 件
                  </td>
                  <td></td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {totalUnits.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-blue-700">
                    {totalInsurance.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {totalUser.toLocaleString()}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* 右: 明細情報 */}
          <div className="lg:col-span-2 rounded-lg border bg-white shadow-sm">
            <header className="border-b bg-blue-100 px-4 py-2 text-sm font-bold text-blue-900">
              明細情報 {selected ? `— ${selected.user_name}` : ""}
            </header>
            {selected ? (
              <div className="p-3">
                <table className="min-w-full text-xs">
                  <thead className="bg-blue-50 text-left text-[10px] font-medium text-blue-900">
                    <tr>
                      <th className="rounded-l px-2 py-1.5">サービス内容</th>
                      <th className="px-2 py-1.5 text-right">単位数/単価</th>
                      <th className="px-2 py-1.5 text-right">回数</th>
                      <th className="rounded-r px-2 py-1.5 text-right">単位数</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {selected.details.map((d) => (
                      <tr key={d.service_type}>
                        <td className="px-2 py-1.5">
                          {d.short_name ?? d.service_type}
                          {d.short_name && (
                            <span className="ml-1 text-[9px] text-gray-400">
                              {d.service_type}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {d.unit_per.toLocaleString()}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {d.count}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-semibold">
                          {d.units.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                    {selected.addonUnits > 0 && (
                      <tr className="text-purple-700">
                        <td className="px-2 py-1.5">
                          {selected.addonLabel ?? "処遇改善加算"}
                        </td>
                        <td className="px-2 py-1.5 text-right">—</td>
                        <td className="px-2 py-1.5 text-right">1</td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-semibold">
                          {selected.addonUnits.toLocaleString()}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {/* 金額サマリ (ほのぼの 請求画面の右下ボックス準拠) */}
                <div className="mt-4 rounded border bg-gray-50 p-3 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-gray-500">地域単価</span>
                    <span className="tabular-nums">{selected.unitPrice.toFixed(2)} 円/単位</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">総額</span>
                    <span className="tabular-nums">
                      ¥{selected.totalAmount.toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1 border-t pt-2">
                    <SummaryCell label="特定介護請求額" value="" />
                    <SummaryCell label="軽減額" value="" />
                    <SummaryCell label="保険単位数" value={selected.totalUnits.toLocaleString()} />
                    <SummaryCell
                      label="公費単位数"
                      value={selected.kohiUnits != null ? selected.kohiUnits.toLocaleString() : ""}
                    />
                    <SummaryCell
                      label={`保険請求額 (${Math.round((1 - selected.copay_rate) * 100)}%)`}
                      value={`¥${selected.insuranceAmount.toLocaleString()}`}
                      emphasis="blue"
                    />
                    <SummaryCell
                      label="公費請求額"
                      value={selected.kohiAmount != null ? `¥${selected.kohiAmount.toLocaleString()}` : ""}
                      emphasis={selected.kohiAmount != null ? "purple" : undefined}
                    />
                    <SummaryCell
                      label={`利用者負担額 (${Math.round(selected.copay_rate * 10)}割)`}
                      value={selected.publicExpense ? "" : `¥${selected.userAmount.toLocaleString()}`}
                    />
                    <SummaryCell
                      label="公費分本人負担"
                      value={selected.publicExpense ? "¥0" : ""}
                    />
                  </div>
                  {selected.publicExpense && (
                    <p className="pt-1 text-[10px] text-purple-600">
                      公費: {selected.publicExpense} (本人負担分を公費請求へ振替)
                    </p>
                  )}
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

// ほのぼの風 請求サマリの 1 セル (ラベル + 右寄せ数値。空文字 = 該当なし)
function SummaryCell({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: "blue" | "purple";
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 rounded border border-blue-100 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-900 whitespace-nowrap">
        {label}
      </span>
      <span
        className={
          emphasis === "blue"
            ? "font-bold tabular-nums text-blue-700"
            : emphasis === "purple"
            ? "font-bold tabular-nums text-purple-700"
            : "font-bold tabular-nums text-gray-800"
        }
      >
        {value || <span className="text-gray-300 font-normal">—</span>}
      </span>
    </div>
  );
}
