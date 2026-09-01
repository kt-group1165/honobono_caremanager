"use client";

/**
 * 本部請求 (本部集計) — 自社全事業所の月次請求を法人ごとに横断集計して表示。
 * 金額は各事業所の請求タブと 1 円も違わない (aggregateHonbu は集計式に触れず整数加算のみ)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Building2, Loader2, Printer } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { MonthNav } from "@/app/(authenticated)/billing-visit/_shared/month-nav";
import {
  aggregateHonbu,
  billedAmount,
  combineAll,
  type HonbuResult,
  type HonbuSummary,
  type HonbuOfficeRow,
} from "@/lib/honbu-seikyu/aggregate-honbu";

const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");

export function HonbuContent({ initialYear, initialMonth, initialResult, initialError }: {
  initialYear: number;
  initialMonth: number;
  initialResult: HonbuResult | null;
  initialError: string | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HonbuResult | null>(initialResult);
  const [error, setError] = useState<string | null>(initialError);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await aggregateHonbu(supabase, { year, month });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [supabase, year, month]);

  // 初回 mount は server から渡された initialResult をそのまま使い、
  // 月変更 (MonthNav 操作) のときだけ client fetch する。
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    load();
  }, [load]);

  const reiwa = year - 2018;
  const officeCount = result
    ? result.groups.reduce((s, g) => s + g.offices.length, 0)
    : 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-4 print:max-w-none print:px-0">
      {/* ヘッダー */}
      <div className="mb-3 flex items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-2">
          <Building2 className="text-indigo-600" size={20} />
          <h1 className="text-lg font-bold text-gray-900">本部請求（本部集計）</h1>
          <span className="text-xs text-gray-500">自社全事業所を法人横断で集計</span>
        </div>
        <div className="flex items-center gap-2">
          <MonthNav
            year={year}
            month={month}
            onChange={(y, m) => {
              setYear(y);
              setMonth(m);
            }}
          />
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1 rounded-lg border bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            <Printer size={15} /> 印刷
          </button>
        </div>
      </div>

      {/* 印刷用タイトル */}
      <div className="mb-2 hidden print:block">
        <h1 className="text-base font-bold">
          本部請求集計表　令和{reiwa}年{month}月 提供分
        </h1>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>集計に失敗しました: {error}</span>
        </div>
      )}

      {result && result.errors.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <div className="mb-1 flex items-center gap-1 font-semibold">
            <AlertTriangle size={14} /> 一部事業所の集計に失敗しました（下記以外は正常）
          </div>
          <ul className="list-disc pl-5">
            {result.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-gray-500">
          <Loader2 className="animate-spin" size={20} /> 全事業所を集計中…
        </div>
      ) : result ? (
        <>
          {/* 全社サマリ カード */}
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            <SummaryCard label="請求額計" value={yen(billedAmount(result.grand.all))} accent />
            <SummaryCard label="保険・給付費" value={yen(result.grand.all.insuranceAmount)} />
            <SummaryCard label="公費" value={yen(result.grand.all.kohiAmount)} />
            <SummaryCard label="利用者負担" value={yen(result.grand.all.userAmount)} />
            <SummaryCard label="総額" value={yen(result.grand.all.totalAmount)} />
            <SummaryCard label="事業所数" value={`${officeCount} 所`} />
          </div>

          {/* 制度別 全社内訳 */}
          <div className="mb-5 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="bg-indigo-50 text-indigo-900">
                  <th className="border-b px-3 py-1.5 text-left">制度</th>
                  <th className="border-b px-3 py-1.5 text-right">件数</th>
                  <th className="border-b px-3 py-1.5 text-right">単位数</th>
                  <th className="border-b px-3 py-1.5 text-right">請求額</th>
                  <th className="border-b px-3 py-1.5 text-right">利用者負担</th>
                  <th className="border-b px-3 py-1.5 text-right">総額</th>
                </tr>
              </thead>
              <tbody>
                <SeidoRow label="介護保険給付" s={result.grand.kaigo} />
                <SeidoRow label="総合事業" s={result.grand.sougou} />
                <SeidoRow label="障害福祉サービス" s={result.grand.shogai} />
                <SeidoRow label="全制度 合計" s={result.grand.all} bold />
              </tbody>
            </table>
          </div>

          {/* 法人ごとの事業所別内訳 */}
          {result.groups.map((g) => (
            <div key={g.companyId ?? "none"} className="mb-5">
              <div className="mb-1 flex items-baseline justify-between">
                <h2 className="text-sm font-bold text-gray-800">{g.companyName}</h2>
                <span className="text-xs text-gray-500">
                  {g.offices.length} 事業所 / 請求額計 {yen(billedAmount(g.subtotal.all))}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead>
                    <tr className="bg-gray-100 text-gray-700">
                      <th className="border-b px-3 py-1.5 text-left">事業所</th>
                      <th className="border-b px-3 py-1.5 text-right">介護保険</th>
                      <th className="border-b px-3 py-1.5 text-right">総合事業</th>
                      <th className="border-b px-3 py-1.5 text-right">障害福祉</th>
                      <th className="border-b px-3 py-1.5 text-right">請求額計</th>
                      <th className="border-b px-3 py-1.5 text-right">利用者負担</th>
                      <th className="border-b px-3 py-1.5 text-right">総額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.offices.map((o) => (
                      <OfficeRow key={o.officeId} o={o} />
                    ))}
                    {/* 法人小計 */}
                    <tr className="bg-indigo-50 font-semibold text-indigo-900">
                      <td className="border-t px-3 py-1.5">法人小計</td>
                      <td className="border-t px-3 py-1.5 text-right font-mono">
                        {yen(billedAmount(g.subtotal.kaigo))}
                      </td>
                      <td className="border-t px-3 py-1.5 text-right font-mono">
                        {yen(billedAmount(g.subtotal.sougou))}
                      </td>
                      <td className="border-t px-3 py-1.5 text-right font-mono">
                        {yen(billedAmount(g.subtotal.shogai))}
                      </td>
                      <td className="border-t px-3 py-1.5 text-right font-mono">
                        {yen(billedAmount(g.subtotal.all))}
                      </td>
                      <td className="border-t px-3 py-1.5 text-right font-mono">
                        {yen(g.subtotal.all.userAmount)}
                      </td>
                      <td className="border-t px-3 py-1.5 text-right font-mono">
                        {yen(g.subtotal.all.totalAmount)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {officeCount === 0 && (
            <div className="py-10 text-center text-sm text-gray-500">
              対象事業所の請求データがありません（{year}年{month}月）。
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        accent ? "border-indigo-200 bg-indigo-50" : "bg-white"
      }`}
    >
      <div className="text-[11px] text-gray-500">{label}</div>
      <div
        className={`mt-0.5 font-mono text-base font-bold ${
          accent ? "text-indigo-700" : "text-gray-800"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function SeidoRow({
  label,
  s,
  bold,
}: {
  label: string;
  s: HonbuSummary;
  bold?: boolean;
}) {
  return (
    <tr className={bold ? "bg-indigo-50 font-bold text-indigo-900" : ""}>
      <td className="border-b px-3 py-1.5">{label}</td>
      <td className="border-b px-3 py-1.5 text-right font-mono">{s.count}</td>
      <td className="border-b px-3 py-1.5 text-right font-mono">
        {s.totalUnits.toLocaleString("ja-JP")}
      </td>
      <td className="border-b px-3 py-1.5 text-right font-mono">
        {yen(billedAmount(s))}
      </td>
      <td className="border-b px-3 py-1.5 text-right font-mono">
        {yen(s.userAmount)}
      </td>
      <td className="border-b px-3 py-1.5 text-right font-mono">
        {yen(s.totalAmount)}
      </td>
    </tr>
  );
}

function OfficeRow({ o }: { o: HonbuOfficeRow }) {
  const all = combineAll(o);
  return (
    <tr className="hover:bg-gray-50">
      <td className="whitespace-nowrap border-b px-3 py-1.5">
        <span className="font-medium text-gray-800">{o.officeName}</span>
        <span className="ml-1.5 rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-500">
          {o.serviceType}
        </span>
      </td>
      <td className="border-b px-3 py-1.5 text-right font-mono text-gray-700">
        {billedAmount(o.kaigo) ? yen(billedAmount(o.kaigo)) : "—"}
      </td>
      <td className="border-b px-3 py-1.5 text-right font-mono text-gray-700">
        {billedAmount(o.sougou) ? yen(billedAmount(o.sougou)) : "—"}
      </td>
      <td className="border-b px-3 py-1.5 text-right font-mono text-gray-700">
        {billedAmount(o.shogai) ? yen(billedAmount(o.shogai)) : "—"}
      </td>
      <td className="border-b px-3 py-1.5 text-right font-mono font-semibold text-gray-900">
        {yen(billedAmount(all))}
      </td>
      <td className="border-b px-3 py-1.5 text-right font-mono text-gray-700">
        {yen(all.userAmount)}
      </td>
      <td className="border-b px-3 py-1.5 text-right font-mono text-gray-700">
        {yen(all.totalAmount)}
      </td>
    </tr>
  );
}
