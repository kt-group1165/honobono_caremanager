"use client";

/**
 * 利用請求 — 利用者本人への請求一覧 (参考: ほのぼの 利用請求タブ)
 *
 * 左: 利用者一覧 (対象チェック / 名前 / 請求額 = 利用者負担額)
 * 右: 利用明細欄 (利用料項目 / 単価 / 数量 / 金額)
 * 請求書発行: チェックした利用者分の利用料請求書を印刷 view で発行
 * (未チェック時は全件対象 — 国保請求と同じ流儀)
 */

import { useMemo, useState } from "react";
import { Loader2, Receipt, AlertCircle, Printer } from "lucide-react";
import { MonthNav } from "../_shared/month-nav";
import { useSeikyuData } from "../_shared/use-seikyu-data";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";

export function RiyouSeikyuContent() {
  const { year, month, onMonthChange, rows, loading, error, officeName } =
    useSeikyuData();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState(false);

  const selected = rows.find((r) => r.user_id === selectedUserId) ?? rows[0] ?? null;
  const totalBilled = rows.reduce((s, r) => s + r.userAmount, 0);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setChecked((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.user_id)),
    );

  // 発行対象: チェックあり → その利用者のみ / チェックなし → 全件
  const targets = useMemo(
    () => (checked.size > 0 ? rows.filter((r) => checked.has(r.user_id)) : rows),
    [rows, checked],
  );

  const reiwa = year - 2018;

  const issueSeikyusho = () => {
    setPrinting(true);
    // print CSS 適用後に印刷 dialog
    setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 100);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
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
            onClick={issueSeikyusho}
            disabled={rows.length === 0}
            className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <Printer size={14} />
            請求書発行 ({targets.length}件)
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 print:hidden">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400 print:hidden">
          <Loader2 size={20} className="mr-2 animate-spin" />
          集計中...
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-gray-50 p-12 text-center text-sm text-gray-500 print:hidden">
          対象月の実績 (完了) がありません
        </div>
      ) : (
        <>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5 print:hidden">
          {/* 左: 請求一覧 */}
          <div className="lg:col-span-3 overflow-hidden rounded-lg border bg-white shadow-sm">
            <table className="min-w-full text-sm">
              <thead className="bg-blue-100 text-left text-xs font-medium text-blue-900">
                <tr>
                  <th className="px-2 py-1.5 text-center w-14">
                    <label className="inline-flex cursor-pointer select-none flex-col items-center gap-0.5">
                      <input
                        type="checkbox"
                        checked={rows.length > 0 && checked.size === rows.length}
                        onChange={toggleAll}
                        className="h-3.5 w-3.5 accent-blue-600 cursor-pointer"
                      />
                      <span className="whitespace-nowrap text-[9px] font-normal text-blue-700">
                        全選択
                      </span>
                    </label>
                  </th>
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
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={checked.has(r.user_id)}
                        onChange={() => toggle(r.user_id)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-3.5 w-3.5 accent-emerald-600 cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">{r.user_name}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.insured_number ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      {Math.round(r.copay_rate * 10)}割
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-700">
                      ¥{r.userAmount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                <tr>
                  <td className="px-3 py-2 text-xs text-gray-500" colSpan={4}>
                    請求額合計 ({rows.length} 名{checked.size > 0 ? ` / 選択 ${checked.size} 名` : ""})
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
            <header className="border-b bg-blue-100 px-4 py-2 text-sm font-bold text-blue-900">
              利用明細欄 {selected ? `— ${selected.user_name}` : ""}
            </header>
            {selected ? (
              <div className="p-3">
                <table className="min-w-full text-xs">
                  <thead className="bg-blue-50 text-left text-[10px] font-medium text-blue-900">
                    <tr>
                      <th className="rounded-l px-2 py-1.5">利用料項目</th>
                      <th className="px-2 py-1.5 text-right">単価</th>
                      <th className="px-2 py-1.5 text-right">数量</th>
                      <th className="rounded-r px-2 py-1.5 text-right">金額</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {splitUserAmount(selected).map((l) => (
                      <tr key={l.label}>
                        <td className="px-2 py-1.5">{l.label}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {l.unitPer != null ? l.unitPer.toLocaleString() : "—"}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{l.count}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          ¥{l.amount.toLocaleString()}
                        </td>
                      </tr>
                    ))}
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
        <p className="text-[11px] text-gray-400 print:hidden">
          ※ チェックで発行対象を絞込 (未チェック時は全件発行)。請求書は利用者 1 名につき 1 枚で印刷されます。
        </p>

        {/* ===== 印刷 view: 利用料請求書 (利用者 1 名 = 1 枚) ===== */}
        {printing && (
          <div className="hidden print:block">
            {targets.map((r) => (
              <RiyouSeikyuPrintSheet
                key={r.user_id}
                row={r}
                officeName={officeName}
                reiwa={reiwa}
                month={month}
              />
            ))}
          </div>
        )}
        </>
      )}
    </div>
  );
}

// ─── 明細行の利用者負担額 比例配分 (端数は最大行に寄せて合計を一致させる) ──────
interface RiyouLine {
  label: string;
  unitPer: number | null;
  count: number;
  amount: number;
}

function splitUserAmount(row: UserSeikyuRow): RiyouLine[] {
  const lines: RiyouLine[] = row.details.map((d) => ({
    label: d.short_name ?? d.service_type,
    unitPer: d.unit_per,
    count: d.count,
    amount:
      row.totalUnits > 0
        ? Math.floor((d.units / row.totalUnits) * row.userAmount)
        : 0,
  }));
  if (row.addonUnits > 0) {
    lines.push({
      label: row.addonLabel ?? "処遇改善加算",
      unitPer: null,
      count: 1,
      amount:
        row.totalUnits > 0
          ? Math.floor((row.addonUnits / row.totalUnits) * row.userAmount)
          : 0,
    });
  }
  // floor の切捨て分を最大金額の行に加算して合計 = userAmount にする
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  const diff = row.userAmount - sum;
  if (diff !== 0 && lines.length > 0) {
    const maxLine = lines.reduce((a, b) => (b.amount > a.amount ? b : a));
    maxLine.amount += diff;
  }
  return lines;
}

// ─── 印刷: 利用料請求書 (利用者 1 名 = 1 枚) ─────────────────────────────────
function RiyouSeikyuPrintSheet({
  row,
  officeName,
  reiwa,
  month,
}: {
  row: UserSeikyuRow;
  officeName: string | null;
  reiwa: number;
  month: number;
}) {
  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const lines = splitUserAmount(row);

  return (
    <div className="p-10 text-black" style={{ pageBreakAfter: "always" }}>
      <h1 className="mb-8 text-center text-2xl font-bold tracking-[0.5em]">
        利用料請求書
      </h1>

      <div className="mb-8 flex items-start justify-between">
        <div>
          <p className="inline-block border-b border-black pb-1 pr-12 text-lg">
            {row.user_name} 様
          </p>
          <p className="mt-3 text-sm">
            令和{reiwa}年{month}月分のサービス利用料を下記のとおりご請求申し上げます。
          </p>
        </div>
        <div className="text-right text-sm leading-6">
          <p>発行日: {issueDate}</p>
          <p className="mt-3 font-medium">{officeName ?? ""}</p>
        </div>
      </div>

      <div className="mb-6 flex items-center gap-3">
        <span className="border border-black px-4 py-2 text-lg font-bold">
          ご請求金額 ¥{row.userAmount.toLocaleString()} －
        </span>
        <span className="text-xs">(消費税: 非課税)</span>
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-2 py-1.5 text-left">利用料項目</th>
            <th className="border border-black px-2 py-1.5 text-right w-24">単価 (単位)</th>
            <th className="border border-black px-2 py-1.5 text-right w-16">数量</th>
            <th className="border border-black px-2 py-1.5 text-right w-28">金額</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.label}>
              <td className="border border-black px-2 py-1.5">{l.label}</td>
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                {l.unitPer != null ? l.unitPer.toLocaleString() : "—"}
              </td>
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                {l.count}
              </td>
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                ¥{l.amount.toLocaleString()}
              </td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className="border border-black px-2 py-1.5" colSpan={3}>
              合計 (利用者負担額{Math.round(row.copay_rate * 10)}割)
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              ¥{row.userAmount.toLocaleString()}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="mt-6 text-xs text-gray-700">
        ※ 本請求は介護保険サービス利用に伴う利用者負担分です (保険単位数{" "}
        {row.totalUnits.toLocaleString()} 単位、単価 {row.unitPrice.toFixed(2)} 円/単位)。
      </p>
    </div>
  );
}
