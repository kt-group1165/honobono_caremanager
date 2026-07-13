"use client";

/**
 * 経営分析タブ (訪問介護) — ほのぼの「経営分析」相当
 *
 * セクション:
 *   1. 利用者数・キャンセル: 実利用者数 / 新規 / 終了 (前月比) / キャンセル件数・率
 *   2. サービス提供量: 訪問回数 / 提供時間 / 種類別構成比 (身体/生活/身生/乗降/障害/総合/入浴)
 *   3. 職員稼働: 職員別の月間訪問件数マトリクス (上位 20 名) + 合計時間
 *   4. 単価分析: 利用者1人あたり平均請求額 (利用請求) / 訪問1回あたり平均単位数
 *
 * データ源: kaigo_visit_schedule (予定/実績/キャンセル) + kaigo_bath_visit_records
 *          (入浴実施記録 actual=true) + kaigo_service_codes (単位数/制度) +
 *          riyou_seikyu_payments (親から props で受領 = 追加 fetch なし)
 *
 * 性能: タブを開いた時に初めて fetch (遅延読込)。月単位のクエリを並列 4 本 ×
 *       各 page-loop で取得し、12ヶ月一括の巨大クエリを作らない。
 *       同一期間の再オープンは再 fetch しない (期間キーでキャッシュ)。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  CATEGORY_KEYS,
  computeVisitAnalysis,
  downloadCsv,
  fetchMemberNames,
  fetchServiceMaster,
  fetchVisitMonthData,
  heatStyle,
  heatStyleRed,
  mapWithConcurrency,
  monthsInRangeCapped,
  prevMonthKey,
  reiwaMonthLabel,
  type MonthVisitData,
  type StaffStatRow,
  type VisitMonthlyMetrics,
} from "@/lib/keiei-bunseki";

/** 親 (StatsContent) が fetch 済の利用請求行 (単価分析に再利用) */
export interface PaymentLite {
  client_id: string;
  target_month: string;
  billed_amount: number;
}

const MONTH_CAP = 24; // 経営分析の対象月数上限 (期間が長すぎる時は直近側を採用)
const STAFF_TOP = 20; // 職員稼働の表示上限

const thCls = "px-2 py-1.5 border border-gray-300 text-gray-700";
const tdCls = "px-2 py-1 border border-gray-200";

const fmtH = (min: number) => (min / 60).toFixed(1); // 分 → 時間 (小数1桁)

export function KeieiBunsekiTab({
  active,
  officeId,
  fromMonth,
  toMonth,
  payments,
}: {
  active: boolean;
  /** 自事業所 (kaigo_visit_schedule のスコープ)。null = スコープなし (全件) */
  officeId: string | null;
  fromMonth: string;
  toMonth: string;
  payments: PaymentLite[];
}) {
  const supabase = useMemo(() => createClient(), []);
  /** データ反映済みの期間キー (null = 未ロード)。スピナー表示の判定に使う */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [months, setMonths] = useState<string[]>([]);
  const [monthly, setMonthly] = useState<VisitMonthlyMetrics[]>([]);
  const [staffRows, setStaffRows] = useState<StaffStatRow[]>([]);
  const [staffNames, setStaffNames] = useState<Map<string, string>>(new Map());
  /** fetch 失敗 (スピナー永続の解消用)。key が現 periodKey のときのみ表示 */
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const loadedKeyRef = useRef<string | null>(null);

  const rangeValid =
    /^\d{4}-\d{2}$/.test(fromMonth) && /^\d{4}-\d{2}$/.test(toMonth) && fromMonth <= toMonth;
  const periodKey = `${officeId ?? "all"}:${fromMonth}:${toMonth}`;

  useEffect(() => {
    void retryTick; // 再試行ボタンで effect を再実行させるためのトリガー
    if (!active || !rangeValid || loadedKeyRef.current === periodKey) return;
    loadedKeyRef.current = periodKey;
    let stale = false;

    (async () => {
      const targetMonths = monthsInRangeCapped(fromMonth, toMonth, MONTH_CAP);
      const baseMonth = prevMonthKey(targetMonths[0]);

      // 月別 fetch (並列 4 本。各月内は page-loop。自事業所スコープ)
      const results = await mapWithConcurrency([baseMonth, ...targetMonths], 4, (m) =>
        fetchVisitMonthData(supabase, m, officeId),
      );
      const byMonth = new Map<string, MonthVisitData>();
      let fetchError: string | null = null;
      for (const r of results) {
        byMonth.set(r.data.month, r.data);
        if (r.error && !fetchError) fetchError = r.error;
      }
      if (fetchError) toast.error(fetchError);

      // 使用中サービス名の全世代マスタ (単位数解決 + 制度分類)
      const names = new Set<string>();
      for (const d of byMonth.values()) {
        for (const s of d.schedules) {
          if (s.service_type) names.add(s.service_type);
        }
      }
      const { master, error: masterErr } = await fetchServiceMaster(supabase, [...names]);
      if (masterErr) toast.error("サービスコードの取得に失敗: " + masterErr);

      const { monthly: m, staff } = computeVisitAnalysis(
        targetMonths,
        baseMonth,
        byMonth,
        master,
      );

      // 職員名 (上位のみで十分だが CSV 用に全員分)
      const { names: nameMap, error: nameErr } = await fetchMemberNames(
        supabase,
        staff.map((s) => s.staffId),
      );
      if (nameErr) toast.error("職員名の取得に失敗: " + nameErr);

      if (stale) return;
      setMonths(targetMonths);
      setMonthly(m);
      setStaffRows(staff);
      setStaffNames(nameMap);
      setLoadedFor(periodKey);
    })().catch((e: unknown) => {
      if (stale) return;
      loadedKeyRef.current = null; // 失敗時は次回アクティブ化で再試行
      const message = e instanceof Error ? e.message : String(e);
      setLoadError({ key: periodKey, message });
      toast.error("経営分析の集計に失敗: " + message);
    });

    return () => {
      stale = true;
    };
  }, [active, rangeValid, periodKey, fromMonth, toMonth, officeId, supabase, retryTick]);

  // ── 単価分析 (利用請求は親 fetch 済の payments を再利用) ──
  const paymentByMonth = useMemo(() => {
    const map = new Map<string, { billed: number; clients: Set<string> }>();
    for (const p of payments) {
      const cur = map.get(p.target_month) ?? { billed: 0, clients: new Set<string>() };
      cur.billed += p.billed_amount;
      cur.clients.add(p.client_id);
      map.set(p.target_month, cur);
    }
    return map;
  }, [payments]);

  // ヒートマップの最大値
  const maxCategory = useMemo(
    () =>
      Math.max(
        1,
        ...monthly.flatMap((m) => CATEGORY_KEYS.map((k) => m.byCategory[k])),
      ),
    [monthly],
  );
  const maxCancelRate = useMemo(
    () => Math.max(1, ...monthly.map((m) => m.cancelRate ?? 0)),
    [monthly],
  );
  const staffTop = useMemo(() => staffRows.slice(0, STAFF_TOP), [staffRows]);
  const maxStaffVisits = useMemo(
    () =>
      Math.max(
        1,
        ...staffTop.flatMap((s) => months.map((m) => s.visitsByMonth[m] ?? 0)),
      ),
    [staffTop, months],
  );

  // ── CSV 出力 ──
  const exportMonthlyCsv = () => {
    if (monthly.length === 0) {
      toast.error("出力対象がありません");
      return;
    }
    downloadCsv(
      `keiei_bunseki_${fromMonth}_${toMonth}.csv`,
      [
        "対象月",
        "実利用者数",
        "新規(前月比)",
        "終了(前月比)",
        "訪問回数",
        "入浴件数",
        "提供時間(h)",
        "キャンセル件数",
        "キャンセル率(%)",
        ...CATEGORY_KEYS,
        "利用請求額合計",
        "請求利用者数",
        "1人あたり平均請求額",
        "訪問1回あたり平均単位数",
        "訪問1回あたり平均時間(分)",
      ],
      monthly.map((m) => {
        const pay = paymentByMonth.get(m.month);
        return [
          m.month,
          m.users,
          m.newUsers,
          m.endedUsers,
          m.visits,
          m.bathVisits,
          fmtH(m.minutes),
          m.cancelled,
          m.cancelRate != null ? m.cancelRate.toFixed(1) : "",
          ...CATEGORY_KEYS.map((k) => m.byCategory[k]),
          pay?.billed ?? 0,
          pay?.clients.size ?? 0,
          pay && pay.clients.size > 0 ? Math.round(pay.billed / pay.clients.size) : "",
          m.unitsVisits > 0 ? (m.unitsSum / m.unitsVisits).toFixed(1) : "",
          m.visits > 0 ? (m.minutes / m.visits).toFixed(1) : "",
        ];
      }),
    );
    toast.success(`CSV を出力しました (${monthly.length} ヶ月)`);
  };

  const exportStaffCsv = () => {
    if (staffRows.length === 0) {
      toast.error("出力対象がありません");
      return;
    }
    downloadCsv(
      `keiei_staff_${fromMonth}_${toMonth}.csv`,
      ["職員名", ...months, "合計件数", "合計時間(h)"],
      staffRows.map((s) => [
        staffNames.get(s.staffId) ?? s.staffId,
        ...months.map((m) => s.visitsByMonth[m] ?? 0),
        s.totalVisits,
        fmtH(s.totalMinutes),
      ]),
    );
    toast.success(`CSV を出力しました (職員 ${staffRows.length} 名)`);
  };

  if (!rangeValid) {
    return (
      <div className="px-3 py-8 text-center text-gray-400 text-sm">期間の指定が不正です</div>
    );
  }
  if (loadedFor !== periodKey) {
    // fetch 失敗時はスピナーを止め、再試行ボタンを出す
    if (loadError && loadError.key === periodKey) {
      return (
        <div className="flex flex-col items-center gap-3 py-16">
          <span className="text-xs text-red-600">
            経営分析の集計に失敗しました: {loadError.message}
          </span>
          <button
            type="button"
            onClick={() => {
              setLoadError(null);
              setRetryTick((t) => t + 1);
            }}
            className="border border-gray-400 rounded bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            再試行
          </button>
        </div>
      );
    }
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
          onClick={exportMonthlyCsv}
          disabled={monthly.length === 0}
          title="月次指標 (利用者数/提供量/キャンセル/単価) を CSV で出力"
          className="border border-blue-500 rounded bg-blue-50 px-2.5 py-1 text-blue-700 hover:bg-blue-100 flex items-center gap-1.5 text-xs font-medium disabled:opacity-50"
        >
          <Download size={13} />
          月次指標CSV
        </button>
        <button
          type="button"
          onClick={exportStaffCsv}
          disabled={staffRows.length === 0}
          title="職員別の月間訪問件数・提供時間を CSV で出力"
          className="border border-blue-500 rounded bg-blue-50 px-2.5 py-1 text-blue-700 hover:bg-blue-100 flex items-center gap-1.5 text-xs font-medium disabled:opacity-50"
        >
          <Download size={13} />
          職員稼働CSV
        </button>
        <span className="text-[11px] text-gray-400">
          kaigo_visit_schedule (キャンセル除く) + 入浴実施記録の集計 ({months[0] ?? fromMonth} 〜{" "}
          {months[months.length - 1] ?? toMonth}
          {months.length >= MONTH_CAP ? ` / 直近${MONTH_CAP}ヶ月に制限` : ""})
        </span>
      </div>

      {/* ── 1. 利用者数・キャンセル ── */}
      <section className="space-y-1">
        <h2 className="text-sm font-bold text-gray-800">利用者数の推移・キャンセル</h2>
        <p className="text-[11px] text-gray-400">
          実利用者数 = 月内に非キャンセルの予定/実績 (入浴実績含む) がある利用者。新規/終了は前月比
        </p>
        <div className="overflow-auto border border-gray-300 rounded">
          <table className="min-w-full text-xs border-collapse">
            <thead className="bg-gray-100 sticky top-0 z-10">
              <tr>
                <th className={`${thCls} text-left w-20`}>対象月</th>
                <th className={`${thCls} text-right w-24`}>実利用者数</th>
                <th className={`${thCls} text-right w-20`}>新規</th>
                <th className={`${thCls} text-right w-20`}>終了</th>
                <th className={`${thCls} text-right w-24`}>訪問回数</th>
                <th className={`${thCls} text-right w-24`}>キャンセル</th>
                <th className={`${thCls} text-right w-28`}>キャンセル率</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month} className="hover:bg-blue-50">
                  <td className={`${tdCls} font-mono`}>{reiwaMonthLabel(m.month)}</td>
                  <td className={`${tdCls} text-right font-mono`}>{m.users.toLocaleString()}</td>
                  <td className={`${tdCls} text-right font-mono ${m.newUsers > 0 ? "text-emerald-600" : "text-gray-400"}`}>
                    {m.newUsers > 0 ? `+${m.newUsers}` : "0"}
                  </td>
                  <td className={`${tdCls} text-right font-mono ${m.endedUsers > 0 ? "text-red-600" : "text-gray-400"}`}>
                    {m.endedUsers > 0 ? `-${m.endedUsers}` : "0"}
                  </td>
                  <td className={`${tdCls} text-right font-mono`}>{m.visits.toLocaleString()}</td>
                  <td className={`${tdCls} text-right font-mono`}>{m.cancelled.toLocaleString()}</td>
                  <td
                    className={`${tdCls} text-right font-mono`}
                    style={heatStyleRed(m.cancelRate ?? 0, maxCancelRate)}
                  >
                    {m.cancelRate != null ? `${m.cancelRate.toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
              {monthly.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-gray-400 text-sm">
                    期間内にデータがありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 2. サービス提供量 ── */}
      <section className="space-y-1">
        <h2 className="text-sm font-bold text-gray-800">サービス提供量 (種類別構成)</h2>
        <p className="text-[11px] text-gray-400">
          種類はサービスコードマスタの制度 (障害/総合事業) とサービス名で分類。入浴は入浴実施記録
          (actual) の件数。セルは件数 (構成比%)
        </p>
        <div className="overflow-auto border border-gray-300 rounded">
          <table className="min-w-full text-xs border-collapse">
            <thead className="bg-gray-100 sticky top-0 z-10">
              <tr>
                <th className={`${thCls} text-left w-20`}>対象月</th>
                <th className={`${thCls} text-right w-24`}>訪問回数</th>
                <th className={`${thCls} text-right w-28`}>提供時間(h)</th>
                {CATEGORY_KEYS.map((k) => (
                  <th key={k} className={`${thCls} text-right w-24`}>
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => {
                const total = m.visits + m.bathVisits;
                return (
                  <tr key={m.month} className="hover:bg-blue-50">
                    <td className={`${tdCls} font-mono`}>{reiwaMonthLabel(m.month)}</td>
                    <td className={`${tdCls} text-right font-mono`}>
                      {m.visits.toLocaleString()}
                    </td>
                    <td className={`${tdCls} text-right font-mono`}>{fmtH(m.minutes)}</td>
                    {CATEGORY_KEYS.map((k) => {
                      const v = m.byCategory[k];
                      return (
                        <td
                          key={k}
                          className={`${tdCls} text-right font-mono`}
                          style={heatStyle(v, maxCategory)}
                        >
                          {v > 0
                            ? `${v.toLocaleString()} (${total > 0 ? ((v / total) * 100).toFixed(0) : 0}%)`
                            : "—"}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {monthly.length === 0 && (
                <tr>
                  <td
                    colSpan={3 + CATEGORY_KEYS.length}
                    className="px-3 py-6 text-center text-gray-400 text-sm"
                  >
                    期間内にデータがありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 3. 職員稼働 ── */}
      <section className="space-y-1">
        <h2 className="text-sm font-bold text-gray-800">
          職員稼働 (訪問件数 上位{Math.min(STAFF_TOP, staffRows.length)}名
          {staffRows.length > STAFF_TOP ? ` / 全${staffRows.length}名は CSV 出力` : ""})
        </h2>
        <p className="text-[11px] text-gray-400">
          シフト実績ベース (非キャンセルの担当予定/実績)。2人体制の職員2/3 も各 1 件で計上、
          追加職員の時間は本体時間で近似。セルは件数 (カーソルで時間表示)
        </p>
        <div className="overflow-auto border border-gray-300 rounded">
          <table className="min-w-full text-xs border-collapse">
            <thead className="bg-gray-100 sticky top-0 z-10">
              <tr>
                <th className={`${thCls} text-left min-w-32`}>職員名</th>
                {months.map((m) => (
                  <th key={m} className={`${thCls} text-right w-16`}>
                    {reiwaMonthLabel(m)}
                  </th>
                ))}
                <th className={`${thCls} text-right w-20`}>合計件数</th>
                <th className={`${thCls} text-right w-24`}>合計時間(h)</th>
              </tr>
            </thead>
            <tbody>
              {staffTop.map((s) => (
                <tr key={s.staffId} className="hover:bg-blue-50">
                  <td className={`${tdCls} font-medium whitespace-nowrap`}>
                    {staffNames.get(s.staffId) ?? "(名前未取得)"}
                  </td>
                  {months.map((m) => {
                    const v = s.visitsByMonth[m] ?? 0;
                    return (
                      <td
                        key={m}
                        className={`${tdCls} text-right font-mono`}
                        style={heatStyle(v, maxStaffVisits)}
                        title={v > 0 ? `${fmtH(s.minutesByMonth[m] ?? 0)} 時間` : undefined}
                      >
                        {v > 0 ? v.toLocaleString() : "—"}
                      </td>
                    );
                  })}
                  <td className={`${tdCls} text-right font-mono font-semibold`}>
                    {s.totalVisits.toLocaleString()}
                  </td>
                  <td className={`${tdCls} text-right font-mono`}>{fmtH(s.totalMinutes)}</td>
                </tr>
              ))}
              {staffTop.length === 0 && (
                <tr>
                  <td
                    colSpan={3 + months.length}
                    className="px-3 py-6 text-center text-gray-400 text-sm"
                  >
                    期間内に担当職員のある予定/実績がありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 4. 単価分析 ── */}
      <section className="space-y-1">
        <h2 className="text-sm font-bold text-gray-800">単価分析</h2>
        <p className="text-[11px] text-gray-400">
          平均請求額 = 利用請求 (riyou_seikyu_payments) の請求額合計 ÷ 請求利用者数。
          平均単位数 = サービスコードマスタ (対象月世代) で解決できた訪問の平均 (加算は含まない)
        </p>
        <div className="overflow-auto border border-gray-300 rounded">
          <table className="min-w-full text-xs border-collapse">
            <thead className="bg-gray-100 sticky top-0 z-10">
              <tr>
                <th className={`${thCls} text-left w-20`}>対象月</th>
                <th className={`${thCls} text-right w-32`}>利用請求額合計</th>
                <th className={`${thCls} text-right w-24`}>請求利用者数</th>
                <th className={`${thCls} text-right w-32`}>1人あたり請求額</th>
                <th className={`${thCls} text-right w-32`}>平均単位数/回</th>
                <th className={`${thCls} text-right w-28`}>平均時間(分)/回</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => {
                const pay = paymentByMonth.get(m.month);
                const perUser =
                  pay && pay.clients.size > 0 ? Math.round(pay.billed / pay.clients.size) : null;
                const avgUnits = m.unitsVisits > 0 ? m.unitsSum / m.unitsVisits : null;
                return (
                  <tr key={m.month} className="hover:bg-blue-50">
                    <td className={`${tdCls} font-mono`}>{reiwaMonthLabel(m.month)}</td>
                    <td className={`${tdCls} text-right font-mono`}>
                      {pay ? `¥${pay.billed.toLocaleString()}` : "—"}
                    </td>
                    <td className={`${tdCls} text-right font-mono`}>
                      {pay ? pay.clients.size.toLocaleString() : "—"}
                    </td>
                    <td className={`${tdCls} text-right font-mono`}>
                      {perUser != null ? `¥${perUser.toLocaleString()}` : "—"}
                    </td>
                    <td
                      className={`${tdCls} text-right font-mono`}
                      title={
                        m.unitsVisits > 0
                          ? `単位数解決 ${m.unitsVisits}/${m.visits} 件`
                          : undefined
                      }
                    >
                      {avgUnits != null ? avgUnits.toFixed(1) : "—"}
                    </td>
                    <td className={`${tdCls} text-right font-mono`}>
                      {m.visits > 0 ? (m.minutes / m.visits).toFixed(1) : "—"}
                    </td>
                  </tr>
                );
              })}
              {monthly.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-gray-400 text-sm">
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
