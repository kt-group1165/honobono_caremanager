"use client";

/**
 * 経営分析タブ (居宅介護支援) — ほのぼの「経営分析」相当
 *
 * セクション:
 *   1. 担当利用者数の推移 (給付管理ベース = kaigo_benefit_management のユニーク利用者) +
 *      新規/終了 (前月比) + 請求件数/単位数/保険請求額 + 単価 (1件あたり単位数・1人あたり請求額)
 *   2. 逓減状況: 常勤換算 (入力) あたり取扱件数。45件以上で居宅介護支援費の逓減
 *      (ICT活用・事務職員配置の届出時は 50件以上)
 *
 * データ源: kaigo_benefit_management + kaigo_care_support_claims (自事業所の
 *          client_office_assignments で限定) — 月単位クエリを並列 + page-loop。
 * 性能: タブを開いた時に初めて fetch (遅延読込)。同一期間は再 fetch しない。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  computeKyotakuAnalysis,
  downloadCsv,
  fetchKyotakuMonthData,
  heatStyle,
  mapWithConcurrency,
  monthsInRangeCapped,
  prevMonthKey,
  reiwaMonthLabel,
  type KyotakuMonthData,
  type KyotakuMonthlyMetrics,
} from "@/lib/keiei-bunseki";

const MONTH_CAP = 24;

const thCls = "px-2 py-1.5 border border-gray-300 text-gray-700";
const tdCls = "px-2 py-1 border border-gray-200";

export function KeieiBunsekiKyotakuTab({
  active,
  officeId,
  fromMonth,
  toMonth,
}: {
  active: boolean;
  officeId: string;
  fromMonth: string;
  toMonth: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [months, setMonths] = useState<string[]>([]);
  const [monthly, setMonthly] = useState<KyotakuMonthlyMetrics[]>([]);
  // 逓減判定用の常勤換算数 (介護支援専門員)。手入力 (シフト連携は未実装)
  const [joukinInput, setJoukinInput] = useState("1");
  const loadedKeyRef = useRef<string | null>(null);

  const rangeValid =
    /^\d{4}-\d{2}$/.test(fromMonth) && /^\d{4}-\d{2}$/.test(toMonth) && fromMonth <= toMonth;
  const periodKey = `${officeId}:${fromMonth}:${toMonth}`;

  useEffect(() => {
    if (!active || !rangeValid || loadedKeyRef.current === periodKey) return;
    loadedKeyRef.current = periodKey;
    let stale = false;

    (async () => {
      const targetMonths = monthsInRangeCapped(fromMonth, toMonth, MONTH_CAP);
      const baseMonth = prevMonthKey(targetMonths[0]);

      // 自事業所の利用者 (client_office_assignments)。失敗時は全件 (フィルタなし) で続行
      let clientFilter: Set<string> | null = null;
      {
        const { data, error } = await supabase
          .from("client_office_assignments")
          .select("client_id")
          .eq("office_id", officeId);
        if (error) {
          console.error("client_office_assignments fetch failed:", error.message);
          toast.error("事業所割当の取得に失敗 (全件で集計します): " + error.message);
        } else {
          clientFilter = new Set(
            ((data ?? []) as { client_id: string }[]).map((a) => a.client_id),
          );
        }
      }

      // 月別 fetch (並列 4 本。各月内は page-loop)
      const results = await mapWithConcurrency([baseMonth, ...targetMonths], 4, (m) =>
        fetchKyotakuMonthData(supabase, m),
      );
      const byMonth = new Map<string, KyotakuMonthData>();
      let fetchError: string | null = null;
      for (const r of results) {
        byMonth.set(r.data.month, r.data);
        if (r.error && !fetchError) fetchError = r.error;
      }
      if (fetchError) toast.error(fetchError);

      const m = computeKyotakuAnalysis(targetMonths, baseMonth, byMonth, clientFilter);

      if (stale) return;
      setMonths(targetMonths);
      setMonthly(m);
      setLoadedFor(periodKey);
    })().catch((e: unknown) => {
      if (stale) return;
      loadedKeyRef.current = null; // 失敗時は次回アクティブ化で再試行
      toast.error("経営分析の集計に失敗: " + (e instanceof Error ? e.message : String(e)));
    });

    return () => {
      stale = true;
    };
  }, [active, rangeValid, periodKey, fromMonth, toMonth, officeId, supabase]);

  const joukin = (() => {
    const v = parseFloat(joukinInput);
    return Number.isFinite(v) && v > 0 ? v : null;
  })();

  const maxUsers = useMemo(
    () => Math.max(1, ...monthly.map((m) => m.kanriUsers)),
    [monthly],
  );

  const exportCsv = () => {
    if (monthly.length === 0) {
      toast.error("出力対象がありません");
      return;
    }
    downloadCsv(
      `kyotaku_keiei_bunseki_${fromMonth}_${toMonth}.csv`,
      [
        "対象月",
        "担当利用者数(給付管理)",
        "新規(前月比)",
        "終了(前月比)",
        "請求件数",
        "単位数",
        "保険請求額",
        "1件あたり平均単位数",
        "1人あたり平均請求額",
        "常勤換算",
        "常勤換算あたり件数",
      ],
      monthly.map((m) => [
        m.month,
        m.kanriUsers,
        m.newUsers,
        m.endedUsers,
        m.claimCount,
        m.unitsSum,
        m.amountSum,
        m.claimCount > 0 ? (m.unitsSum / m.claimCount).toFixed(1) : "",
        m.claimCount > 0 ? Math.round(m.amountSum / m.claimCount) : "",
        joukin ?? "",
        joukin ? (m.kanriUsers / joukin).toFixed(1) : "",
      ]),
    );
    toast.success(`CSV を出力しました (${monthly.length} ヶ月)`);
  };

  if (!rangeValid) {
    return (
      <div className="px-3 py-8 text-center text-gray-400 text-sm">期間の指定が不正です</div>
    );
  }
  if (loadedFor !== periodKey) {
    return (
      <div className="flex flex-col items-center gap-2 py-16">
        <Loader2 size={22} className="animate-spin text-indigo-400" />
        <span className="text-xs text-gray-400">月別データを並列取得しています…</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── 操作列 ── */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={exportCsv}
          disabled={monthly.length === 0}
          title="担当利用者数・請求・逓減指標を CSV で出力"
          className="border border-blue-500 rounded bg-blue-50 px-2.5 py-1 text-blue-700 hover:bg-blue-100 flex items-center gap-1.5 text-xs font-medium disabled:opacity-50"
        >
          <Download size={13} />
          経営分析CSV
        </button>
        <span className="text-[11px] text-gray-400">
          給付管理 (kaigo_benefit_management) + 居宅介護支援費 (kaigo_care_support_claims) の月次集計 (
          {months[0] ?? fromMonth} 〜 {months[months.length - 1] ?? toMonth}
          {months.length >= MONTH_CAP ? ` / 直近${MONTH_CAP}ヶ月に制限` : ""})
        </span>
      </div>

      {/* ── 1. 担当利用者数の推移 ── */}
      <section className="space-y-1">
        <h2 className="text-sm font-bold text-gray-800">担当利用者数の推移 (給付管理ベース)</h2>
        <p className="text-[11px] text-gray-400">
          担当利用者数 = 月内に給付管理データがあるユニーク利用者 (自事業所割当で限定)。新規/終了は前月比
        </p>
        <div className="overflow-auto border border-gray-300 rounded">
          <table className="min-w-full text-xs border-collapse">
            <thead className="bg-gray-100 sticky top-0 z-10">
              <tr>
                <th className={`${thCls} text-left w-20`}>対象月</th>
                <th className={`${thCls} text-right w-28`}>担当利用者数</th>
                <th className={`${thCls} text-right w-20`}>新規</th>
                <th className={`${thCls} text-right w-20`}>終了</th>
                <th className={`${thCls} text-right w-24`}>請求件数</th>
                <th className={`${thCls} text-right w-28`}>単位数</th>
                <th className={`${thCls} text-right w-32`}>保険請求額</th>
                <th className={`${thCls} text-right w-28`}>平均単位数/件</th>
                <th className={`${thCls} text-right w-32`}>平均請求額/人</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month} className="hover:bg-blue-50">
                  <td className={`${tdCls} font-mono`}>{reiwaMonthLabel(m.month)}</td>
                  <td
                    className={`${tdCls} text-right font-mono`}
                    style={heatStyle(m.kanriUsers, maxUsers)}
                  >
                    {m.kanriUsers.toLocaleString()}
                  </td>
                  <td className={`${tdCls} text-right font-mono ${m.newUsers > 0 ? "text-emerald-600" : "text-gray-400"}`}>
                    {m.newUsers > 0 ? `+${m.newUsers}` : "0"}
                  </td>
                  <td className={`${tdCls} text-right font-mono ${m.endedUsers > 0 ? "text-red-600" : "text-gray-400"}`}>
                    {m.endedUsers > 0 ? `-${m.endedUsers}` : "0"}
                  </td>
                  <td className={`${tdCls} text-right font-mono`}>
                    {m.claimCount.toLocaleString()}
                  </td>
                  <td className={`${tdCls} text-right font-mono`}>
                    {m.unitsSum.toLocaleString()}
                  </td>
                  <td className={`${tdCls} text-right font-mono`}>
                    ¥{m.amountSum.toLocaleString()}
                  </td>
                  <td className={`${tdCls} text-right font-mono`}>
                    {m.claimCount > 0 ? (m.unitsSum / m.claimCount).toFixed(1) : "—"}
                  </td>
                  <td className={`${tdCls} text-right font-mono`}>
                    {m.claimCount > 0
                      ? `¥${Math.round(m.amountSum / m.claimCount).toLocaleString()}`
                      : "—"}
                  </td>
                </tr>
              ))}
              {monthly.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-gray-400 text-sm">
                    期間内にデータがありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 2. 逓減状況 ── */}
      <section className="space-y-1">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-bold text-gray-800">逓減状況 (常勤換算あたり件数)</h2>
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            介護支援専門員 常勤換算
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={joukinInput}
              onChange={(e) => setJoukinInput(e.target.value)}
              className="w-20 rounded border border-gray-300 px-2 py-1 text-right focus:border-indigo-400 focus:outline-none"
            />
            人
          </label>
        </div>
        <p className="text-[11px] text-gray-400">
          件数 = 給付管理ベースの担当利用者数 ÷ 常勤換算 (手入力)。45件以上で居宅介護支援費(Ⅰ)の逓減
          (ICT活用・事務職員配置の届出がある場合は 50件以上)。要支援 (介護予防支援の受託分) の
          1/3 換算は未対応 — 正式判定は保険者提出資料で確認してください
        </p>
        <div className="overflow-auto border border-gray-300 rounded">
          <table className="min-w-full text-xs border-collapse">
            <thead className="bg-gray-100 sticky top-0 z-10">
              <tr>
                <th className={`${thCls} text-left w-20`}>対象月</th>
                <th className={`${thCls} text-right w-28`}>担当利用者数</th>
                <th className={`${thCls} text-right w-32`}>常勤換算あたり件数</th>
                <th className={`${thCls} text-center w-40`}>判定 (45件/50件)</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => {
                const perCm = joukin ? m.kanriUsers / joukin : null;
                const level =
                  perCm == null ? null : perCm >= 45 ? "over45" : perCm >= 40 ? "near" : "ok";
                return (
                  <tr key={m.month} className={level === "over45" ? "bg-red-50" : "hover:bg-blue-50"}>
                    <td className={`${tdCls} font-mono`}>{reiwaMonthLabel(m.month)}</td>
                    <td className={`${tdCls} text-right font-mono`}>
                      {m.kanriUsers.toLocaleString()}
                    </td>
                    <td
                      className={`${tdCls} text-right font-mono ${level === "over45" ? "text-red-600 font-bold" : level === "near" ? "text-amber-600 font-semibold" : ""}`}
                    >
                      {perCm != null ? perCm.toFixed(1) : "—"}
                    </td>
                    <td
                      className={`${tdCls} text-center font-semibold ${level === "over45" ? "text-red-600" : level === "near" ? "text-amber-600" : "text-emerald-600"}`}
                    >
                      {perCm == null
                        ? "常勤換算を入力してください"
                        : level === "over45"
                          ? "逓減の可能性 (45件以上)"
                          : level === "near"
                            ? "接近 (40件以上)"
                            : "OK"}
                    </td>
                  </tr>
                );
              })}
              {monthly.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-gray-400 text-sm">
                    期間内にデータがありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
