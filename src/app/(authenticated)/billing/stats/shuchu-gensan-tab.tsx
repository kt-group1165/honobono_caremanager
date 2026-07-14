"use client";

/**
 * 集中減算タブ (居宅介護支援) — 特定事業所集中減算の判定チェック
 *
 * 判定期間 (前期 3/1〜8/31 → 10月から適用 / 後期 9/1〜翌2月末 → 4月から適用) を
 * 選択し、対象 4 サービス (訪問介護 / 通所介護 / 地域密着型通所介護 / 福祉用具貸与)
 * ごとに「法人単位」の位置付け件数・構成比を表示。最大法人の紹介率 80% 超で
 * 減算該当のおそれ (▲200単位/月)。
 *
 * データ源: 判定期間内の月次利用票 (kaigo_report_documents / service-usage) の
 *   サービス行から (利用者 × 事業所) をユニーク化した近似値。利用票から 1 件も
 *   取れないときは第2表 (care-plan-2 / created_at が期間内) に fallback。
 * 名寄せ: offices→companies (自社) / kaigo_service_providers→partner_companies (他社)。
 *   partner_companies 等の migration 未適用でもクラッシュせず「(法人未設定)」扱い。
 * 性能: タブを開いた時に初めて fetch (遅延読込)。同一 期間×office は再 fetch しない。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  aggregateConcentration,
  buildCorpResolver,
  currentShuchuPeriod,
  extractFromCarePlan2,
  extractFromServiceUsage,
  fetchCarePlan2Docs,
  fetchServiceUsageDocs,
  shuchuPeriodInfo,
  shuchuPeriodMonths,
  type ServiceConcentration,
  type ShuchuPeriod,
} from "@/lib/shuchu-gensan";

const thCls = "px-2 py-1.5 border border-gray-300 text-gray-700";
const tdCls = "px-2 py-1 border border-gray-200";

type ShuchuResult = {
  services: ServiceConcentration[];
  hasUnregistered: boolean;
  /** 実際に使った帳票: usage=利用票 / plan2=第2表 fallback / none=どちらも 0 件 */
  source: "usage" | "plan2" | "none";
  usageDocCount: number; // 期間内の利用票 (自事業所) 件数
  usageDocsWithRows: number; // うちサービス行がある件数
  plan2DocCount: number; // fallback 時のみ >0
};

export function ShuchuGensanTab({ active, officeId }: { active: boolean; officeId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const initial = useMemo(() => currentShuchuPeriod(), []);
  const [year, setYear] = useState(initial.year);
  const [half, setHalf] = useState<ShuchuPeriod["half"]>(initial.half);

  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [result, setResult] = useState<ShuchuResult | null>(null);
  /** fetch 失敗 (スピナー永続の解消用)。key が現 periodKey のときのみ表示 */
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const loadedKeyRef = useRef<string | null>(null);

  const period: ShuchuPeriod = useMemo(() => ({ year, half }), [year, half]);
  const info = shuchuPeriodInfo(period);
  const periodKey = `${officeId}:${year}:${half}`;

  // 年の選択肢 (直近 4 年 + 来年)
  const yearOptions = useMemo(() => {
    const cur = initial.year;
    const ys = [];
    for (let y = cur - 3; y <= cur + 1; y += 1) ys.push(y);
    if (!ys.includes(year)) ys.push(year);
    return ys.sort((a, b) => a - b);
  }, [initial.year, year]);

  useEffect(() => {
    void retryTick; // 再試行ボタンで effect を再実行させるためのトリガー
    if (!active || loadedKeyRef.current === periodKey) return;
    loadedKeyRef.current = periodKey;
    let stale = false;

    (async () => {
      const months = shuchuPeriodMonths({ year, half });
      const range = shuchuPeriodInfo({ year, half });
      const softErrors: string[] = [];

      // ── 1) 自事業所の利用者 (client_office_assignments)。失敗時は全件で続行 ──
      let clientFilter: Set<string> | null = null;
      {
        const PAGE = 1000;
        const acc = new Set<string>();
        let failed = false;
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from("client_office_assignments")
            .select("client_id")
            .eq("office_id", officeId)
            .order("id") // page-loop の安定順序
            .range(from, from + PAGE - 1);
          if (error) {
            console.error("client_office_assignments fetch failed:", error.message);
            softErrors.push("事業所割当の取得に失敗 (全利用者で集計します): " + error.message);
            failed = true;
            break;
          }
          const rows = (data ?? []) as { client_id: string }[];
          for (const a of rows) acc.add(a.client_id);
          if (rows.length < PAGE) break;
        }
        if (!failed) clientFilter = acc;
      }
      const inOffice = <T extends { user_id: string }>(rows: T[]) =>
        clientFilter ? rows.filter((r) => clientFilter.has(r.user_id)) : rows;

      // ── 2) 主データ源: 判定期間内の月次利用票 ──
      const usage = await fetchServiceUsageDocs(supabase, months);
      if (usage.error) softErrors.push(usage.error);
      const usageRows = inOffice(usage.rows);
      const usageExtract = extractFromServiceUsage(usageRows);

      // ── 3) fallback: 利用票から 1 件も取れなければ第2表 (作成日が期間内) ──
      let pairs = usageExtract.pairs;
      let source: ShuchuResult["source"] = pairs.length > 0 ? "usage" : "none";
      let plan2DocCount = 0;
      if (pairs.length === 0) {
        const plan2 = await fetchCarePlan2Docs(supabase, range.start, range.endExclusive);
        if (plan2.error) softErrors.push(plan2.error);
        const plan2Rows = inOffice(plan2.rows);
        plan2DocCount = plan2Rows.length;
        const plan2Extract = extractFromCarePlan2(plan2Rows);
        if (plan2Extract.pairs.length > 0) {
          pairs = plan2Extract.pairs;
          source = "plan2";
        }
      }

      // ── 4) 法人名寄せ → 集計 (マスタ未適用は空扱いで続行) ──
      const { resolve, errors: masterErrors } = await buildCorpResolver(supabase);
      softErrors.push(...masterErrors);
      const agg = aggregateConcentration(pairs, resolve);

      if (stale) return;
      for (const msg of softErrors) toast.error(msg);
      setResult({
        ...agg,
        source,
        usageDocCount: usageRows.length,
        usageDocsWithRows: usageExtract.docsWithRows,
        plan2DocCount,
      });
      setLoadedFor(periodKey);
    })().catch((e: unknown) => {
      if (stale) return;
      loadedKeyRef.current = null; // 失敗時は次回アクティブ化で再試行
      const message = e instanceof Error ? e.message : String(e);
      setLoadError({ key: periodKey, message });
      toast.error("集中減算の集計に失敗: " + message);
    });

    return () => {
      stale = true;
    };
  }, [active, periodKey, year, half, officeId, supabase, retryTick]);

  const controls = (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="text-gray-600">判定期間</label>
      <select
        value={year}
        onChange={(e) => setYear(parseInt(e.target.value, 10))}
        className="rounded border border-gray-300 px-2 py-1 focus:border-indigo-400 focus:outline-none"
      >
        {yearOptions.map((y) => (
          <option key={y} value={y}>
            {y}年
          </option>
        ))}
      </select>
      <div className="inline-flex rounded border border-gray-300 overflow-hidden">
        {(
          [
            { key: "zenki", label: "前期 (3/1〜8/31)" },
            { key: "kouki", label: "後期 (9/1〜翌2月末)" },
          ] as const
        ).map((h) => (
          <button
            key={h.key}
            type="button"
            onClick={() => setHalf(h.key)}
            className={`px-2.5 py-1 font-medium ${
              half === h.key
                ? "bg-indigo-600 text-white"
                : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {h.label}
          </button>
        ))}
      </div>
      <span className="text-gray-500">
        {info.label}
        <span className="ml-2 text-gray-400">(減算の適用: {info.applyLabel})</span>
      </span>
    </div>
  );

  if (loadedFor !== periodKey) {
    // fetch 失敗時はスピナーを止め、再試行ボタンを出す
    if (loadError && loadError.key === periodKey) {
      return (
        <div className="space-y-4">
          {controls}
          <div className="flex flex-col items-center gap-3 py-16">
            <span className="text-xs text-red-600">
              集中減算の集計に失敗しました: {loadError.message}
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
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {controls}
        <div className="flex flex-col items-center gap-2 py-16">
          <Loader2 size={22} className="animate-spin text-indigo-400" />
          <span className="text-xs text-gray-400">判定期間の帳票を集計しています…</span>
        </div>
      </div>
    );
  }

  const r = result;
  return (
    <div className="space-y-4">
      {controls}

      {/* データ源の注記 */}
      {r && (
        <div className="text-[11px] text-gray-400">
          {r.source === "usage" ? (
            <>
              判定期間内の月次利用票 {r.usageDocCount} 件 (うちサービス行あり{" "}
              {r.usageDocsWithRows} 件) から集計しています。
            </>
          ) : r.source === "plan2" ? (
            <>
              判定期間内の利用票にサービス行が無いため、期間内に作成した第2表{" "}
              {r.plan2DocCount} 件から集計しています (fallback)。
            </>
          ) : (
            <>
              判定期間内にサービス行のある利用票・第2表がありません (利用票{" "}
              {r.usageDocCount} 件 / 第2表 {r.plan2DocCount} 件を確認)。
            </>
          )}
        </div>
      )}

      {/* サービス別カード */}
      <div className="grid gap-4 lg:grid-cols-2">
        {(r?.services ?? []).map((s) => {
          const over = s.total > 0 && s.topShare > 80;
          return (
            <section key={s.service} className="border border-gray-300 rounded">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-300 bg-gray-50 px-3 py-2">
                <h2 className="text-sm font-bold text-gray-800">{s.service}</h2>
                {s.total === 0 ? (
                  <span className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold bg-gray-100 text-gray-500">
                    対象プランなし
                  </span>
                ) : over ? (
                  <span className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold bg-red-100 text-red-700">
                    減算該当のおそれ (紹介率 {s.topShare.toFixed(1)}%)
                  </span>
                ) : (
                  <span className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold bg-emerald-100 text-emerald-700">
                    基準内 (紹介率 {s.topShare.toFixed(1)}%)
                  </span>
                )}
              </header>
              {s.total === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-gray-400">
                  判定期間内に {s.service} を位置付けたプランはありません
                </div>
              ) : (
                <table className="min-w-full text-xs border-collapse">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className={`${thCls} text-left`}>法人</th>
                      <th className={`${thCls} text-right w-28`}>位置付け件数</th>
                      <th className={`${thCls} text-right w-24`}>構成比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.corps.map((c) => {
                      const isTop = c.corp === s.topCorp;
                      return (
                        <tr
                          key={c.corp}
                          className={isTop ? (over ? "bg-red-50" : "bg-amber-50") : "hover:bg-blue-50"}
                        >
                          <td className={`${tdCls} ${isTop ? "font-semibold" : ""}`}>
                            {c.corp}
                            {isTop && (
                              <span className="ml-1.5 text-[10px] text-gray-400">(最大)</span>
                            )}
                          </td>
                          <td className={`${tdCls} text-right font-mono`}>
                            {c.count.toLocaleString()}
                          </td>
                          <td
                            className={`${tdCls} text-right font-mono ${
                              isTop && over ? "text-red-600 font-bold" : ""
                            }`}
                          >
                            {c.share.toFixed(1)}%
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="bg-gray-50 font-semibold">
                      <td className={tdCls}>合計</td>
                      <td className={`${tdCls} text-right font-mono`}>
                        {s.total.toLocaleString()}
                      </td>
                      <td className={`${tdCls} text-right font-mono`}>100.0%</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </div>

      {/* マスタ未登録の注記 */}
      {r?.hasUnregistered && (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          「(マスタ未登録)」の事業所はサービス事業所マスタに登録すると法人単位で集計されます
          (自社はマスタ管理の事業所、他社はサービス事業所マスタで法人を紐付けてください)。
        </div>
      )}

      {/* フッター注記 (集計方式と正式判定) */}
      <div className="text-[11px] text-gray-400 leading-relaxed">
        ※ 本タブは判定期間内の月次利用票 (無ければ第2表) のサービス行から (利用者 ×
        事業所) をユニーク化した<strong className="font-semibold">近似値</strong>です。
        正式な判定は「判定期間に作成したケアプラン (居宅サービス計画)
        に位置付けた事業所ごとの計画数」を法人単位で集計して行ってください。
        最大法人の紹介率が 80% を超えると特定事業所集中減算 (▲200単位/月)
        が適用期間 ({info.applyLabel}) に適用されます。
        正当な理由 (地域にサービス事業所が少ない場合等) に該当するときは、
        保険者へ届出することで減算の適用を除外できます。
      </div>
    </div>
  );
}
