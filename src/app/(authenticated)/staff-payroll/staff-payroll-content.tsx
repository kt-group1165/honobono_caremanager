"use client";

/**
 * パート職員 給与計算 (時給×実働) — 事業所×月。
 * 金額は純関数 calcPartTimePayroll (scripts/smoke-payroll.mts で回帰) に委譲。
 * 第1弾は時給×実働のみ。手当 (勤続/処遇改善/キャンセル 等) は第2弾で追加予定。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Settings,
  Wallet,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { MonthNav } from "../billing-visit/_shared/month-nav";
import {
  loadPartTimePayroll,
  type LoadPartTimeResult,
} from "@/lib/kaigo-payroll/load-part-time";

const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");
const hm = (min: number) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
};

export function StaffPayrollContent() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice } = useBusinessType();
  const officeId = currentOffice?.id ?? null;

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<LoadPartTimeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!officeId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await loadPartTimePayroll(supabase, { officeId, year, month });
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [supabase, officeId, year, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月/事業所変更時の fetch
    load();
  }, [load]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!officeId) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10 text-center text-sm text-gray-500">
        事業所を選択してください。
      </div>
    );
  }

  const reiwa = year - 2018;

  return (
    <div className="mx-auto max-w-5xl px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wallet className="text-indigo-600" size={20} />
          <h1 className="text-lg font-bold text-gray-900">パート給与</h1>
          <span className="text-xs text-gray-500">
            {currentOffice?.name}・時給×実働（第1弾）
          </span>
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
          <Link
            href="/staff-payroll/settings"
            className="inline-flex items-center gap-1 rounded-lg border bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            <Settings size={15} /> 時給設定
          </Link>
        </div>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-gray-500">
          <Loader2 className="animate-spin" size={20} /> 集計中…
        </div>
      ) : data ? (
        <>
          {data.settingsMissing && (
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              時給の設定がありません。
              <Link href="/staff-payroll/settings" className="ml-1 font-semibold underline">
                時給設定
              </Link>
              でサービス類型と時給を登録してください。
            </div>
          )}
          {data.result.unmappedServiceTypes.length > 0 && (
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span className="font-semibold">未割当のサービスがあります</span>
              （給与未計上）:{" "}
              {data.result.unmappedServiceTypes.join("、")} —{" "}
              <Link href="/staff-payroll/settings" className="font-semibold underline">
                割当設定へ
              </Link>
            </div>
          )}

          {/* サマリ */}
          <div className="mb-4 flex flex-wrap gap-2 text-sm">
            <div className="rounded-lg border bg-white px-3 py-2">
              <span className="text-[11px] text-gray-500">対象パート</span>
              <div className="font-bold text-gray-800">{data.partStaffCount} 名</div>
            </div>
            <div className="rounded-lg border bg-white px-3 py-2">
              <span className="text-[11px] text-gray-500">総実働</span>
              <div className="font-bold text-gray-800">
                {hm(data.result.grandTotalMinutes)}
              </div>
            </div>
            <div className="rounded-lg border bg-white px-3 py-2">
              <span className="text-[11px] text-gray-500">時給分</span>
              <div className="font-mono font-bold text-gray-800">
                {yen(data.result.grandTotalPay)}
              </div>
            </div>
            <div className="rounded-lg border bg-white px-3 py-2">
              <span className="text-[11px] text-gray-500">手当計</span>
              <div className="font-mono font-bold text-gray-800">
                {yen(data.result.grandAllowance)}
              </div>
            </div>
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2">
              <span className="text-[11px] text-gray-500">総支給</span>
              <div className="font-mono text-base font-bold text-indigo-700">
                {yen(data.result.grandGross)}
              </div>
            </div>
          </div>

          {/* 職員別 */}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600">
                  <th className="px-3 py-1.5 text-left">職員</th>
                  <th className="px-3 py-1.5 text-right">訪問</th>
                  <th className="px-3 py-1.5 text-right">実働</th>
                  <th className="px-3 py-1.5 text-right">時給分</th>
                  <th className="px-3 py-1.5 text-right">ｷｬﾝｾﾙ</th>
                  <th className="px-3 py-1.5 text-right">通信</th>
                  <th className="px-3 py-1.5 text-right">総支給</th>
                  <th className="px-3 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {data.result.byStaff.map((s) => {
                  const open = expanded.has(s.staffId);
                  return (
                    <FragmentRow
                      key={s.staffId}
                      open={open}
                      onToggle={() => toggle(s.staffId)}
                      s={s}
                    />
                  );
                })}
                {data.result.byStaff.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-gray-400">
                      令和{reiwa}年{month}月に、この事業所のパート職員の確定実績がありません。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

function FragmentRow({
  s,
  open,
  onToggle,
}: {
  s: LoadPartTimeResult["result"]["byStaff"][number];
  open: boolean;
  onToggle: () => void;
}) {
  const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");
  return (
    <>
      <tr className="border-t hover:bg-gray-50">
        <td className="px-3 py-1.5">
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex items-center gap-1 font-medium text-gray-800"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {s.staffName || "(名称未取得)"}
          </button>
          {s.unmappedCount > 0 && (
            <span className="ml-2 rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-700">
              未割当 {s.unmappedCount} 件
            </span>
          )}
        </td>
        <td className="px-3 py-1.5 text-right font-mono text-gray-600">
          {s.visits.length}
        </td>
        <td className="px-3 py-1.5 text-right font-mono text-gray-600">
          {Math.floor(s.totalMinutes / 60)}h{s.totalMinutes % 60 > 0 ? `${s.totalMinutes % 60}m` : ""}
        </td>
        <td className="px-3 py-1.5 text-right font-mono text-gray-700">
          {yen(s.totalPay)}
        </td>
        <td className="px-3 py-1.5 text-right font-mono text-gray-600">
          {s.cancelAllowance > 0 ? (
            <span title={`${s.cancelCount}件`}>{yen(s.cancelAllowance)}</span>
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-1.5 text-right font-mono text-gray-600">
          {s.commAllowance > 0 ? yen(s.commAllowance) : "—"}
        </td>
        <td className="px-3 py-1.5 text-right font-mono font-semibold text-gray-900">
          {yen(s.grossTotal)}
        </td>
        <td className="px-3 py-1.5"></td>
      </tr>
      {open && (
        <tr className="bg-gray-50/60">
          <td colSpan={8} className="px-3 py-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500">
                  <th className="px-2 py-1 text-left">日付</th>
                  <th className="px-2 py-1 text-left">サービス</th>
                  <th className="px-2 py-1 text-left">類型</th>
                  <th className="px-2 py-1 text-right">実働(分)</th>
                  <th className="px-2 py-1 text-right">時給</th>
                  <th className="px-2 py-1 text-right">支給</th>
                </tr>
              </thead>
              <tbody>
                {s.visits.map((v, i) => (
                  <tr key={i} className="border-t border-gray-200">
                    <td className="px-2 py-1 font-mono">{v.date}</td>
                    <td className="px-2 py-1 font-mono">{v.serviceType}</td>
                    <td className="px-2 py-1">
                      {v.categoryName ?? (
                        <span className="text-amber-600">未割当</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{v.minutes}</td>
                    <td className="px-2 py-1 text-right font-mono">
                      {v.hourlyRate !== null ? yen(v.hourlyRate) : "—"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">
                      {v.pay !== null ? yen(v.pay) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
