"use client";

/**
 * 運営基準減算チェック (居宅介護支援)
 *
 * 2026-09-01 監査是正で新設。
 *
 * 【なぜ要るか】
 *   運営基準減算は所定単位数の **50%**、2 月以上継続で **100%**。要件は 3 つ:
 *     ① サービス担当者会議の開催
 *     ② 月 1 回以上の利用者宅訪問とモニタリング記録
 *     ③ 計画原案の説明・文書同意・交付
 *
 *   これまで請求画面の減算チェックは**手動チェックボックス**で、実績とも同意日とも
 *   一切連動していなかった。検知は /monitoring の「今月のモニタリングが未登録です」
 *   バナー 1 つだけで、しかも選択中の 1 利用者・当月のみ。
 *   2026-06 の実データでは レセプト 2,806 件に対し 減算 ON が 0 件、
 *   モニタリングシート 0 件、当月に居宅訪問の支援経過があるのは 179 名 (6.4%) だった。
 *   = 気づく手段が無い。この画面は**事業所横断で「立証できない利用者」を一覧にする**。
 *
 * 【判定の根拠にするもの】
 *   ① kaigo_support_records.category = 'サービス担当者会議'
 *      (kaigo_report_documents の 'meeting-minutes' は実データ 0 件。支援経過のほうが実態)
 *      ⚠ 会議は計画作成・更新・認定更新のときの要件で**毎月ではない**ので「これまでに有無」で見る
 *   ② kaigo_support_records.category = '訪問' または 'モニタリング' が対象月にあるか
 *      (kaigo_monitoring_sheets は実データ 0 件だが、あれば併せて見る)
 *   ③ 第1表 (kaigo_report_documents report_type='care-plan-1') の
 *      content->>'user_consent_date' が入っているか
 *
 * 【この画面は請求額を変えない】
 *   減算を自動で ON にはしない。判断は人がする。ここは「見えていなかったものを見せる」だけ。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { ID_IN_CHUNK, mapChunksParallel } from "@/lib/chunk-parallel";

const PAGE = 1000;

type Row = {
  clientId: string;
  name: string;
  hasKaigi: boolean;     // ① サービス担当者会議の記録 (通算)
  hasHoumon: boolean;    // ② 当月の訪問 / モニタリング
  hasConsent: boolean;   // ③ 第1表の同意日
  gensanOn: boolean;     // レセプトで運営基準減算を ON にしているか
};

const isMissingTable = (code?: string) =>
  code === "42P01" || code === "PGRST205" || code === "42703";

function prevMonth(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function UneiKijunTab({ active, officeId }: { active: boolean; officeId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [month, setMonth] = useState(prevMonth);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [retryTick, setRetryTick] = useState(0);

  const load = useCallback(async () => {
    if (!officeId) return;
    setLoading(true);
    setError(null);
    try {
      const monthStart = `${month}-01`;
      const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
      const monthEnd = `${month}-${String(lastDay).padStart(2, "0")}`;

      // 1) 自事業所の利用者 (client_office_assignments 経由)
      const clientIds: string[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error: e } = await supabase
          .from("client_office_assignments")
          .select("client_id")
          .eq("office_id", officeId)
          .order("client_id")
          .range(from, from + PAGE - 1);
        if (e) throw new Error(`自事業所の利用者取得に失敗: ${e.message}`);
        const page = (data ?? []) as { client_id: string }[];
        clientIds.push(...page.map((r) => r.client_id));
        if (page.length < PAGE) break;
      }
      const uniqueIds = Array.from(new Set(clientIds));
      if (uniqueIds.length === 0) {
        setRows([]);
        setLoadedFor(`${officeId}:${month}`);
        return;
      }

      // 2) 対象月のレセプト (= 請求している利用者だけが対象)
      const claimByUser = new Map<string, boolean>();
      for (let i = 0; i < uniqueIds.length; i += ID_IN_CHUNK) {
        const chunk = uniqueIds.slice(i, i + ID_IN_CHUNK);
        const { data, error: e } = await supabase
          .from("kaigo_care_support_claims")
          .select("user_id, unei_kijun_gensan")
          .eq("billing_month", month)
          .in("user_id", chunk);
        if (e) {
          // unei_kijun_gensan 列が未適用の環境では列なしで取り直す
          if (!isMissingTable(e.code)) throw new Error(`レセプト取得に失敗: ${e.message}`);
          const retry = await supabase
            .from("kaigo_care_support_claims")
            .select("user_id")
            .eq("billing_month", month)
            .in("user_id", chunk);
          if (retry.error) throw new Error(`レセプト取得に失敗: ${retry.error.message}`);
          for (const r of (retry.data ?? []) as { user_id: string }[]) claimByUser.set(r.user_id, false);
          continue;
        }
        for (const r of (data ?? []) as { user_id: string; unei_kijun_gensan: boolean | null }[]) {
          claimByUser.set(r.user_id, !!r.unei_kijun_gensan);
        }
      }
      const targetIds = Array.from(claimByUser.keys());
      if (targetIds.length === 0) {
        setRows([]);
        setLoadedFor(`${officeId}:${month}`);
        return;
      }

      // 3)〜5) は targetIds が決まれば互いに独立に取得できる (別テーブル・別集計軸)。
      // 直列ループを4本並べると往復が積み上がるので、chunkごとの並列化
      // (mapChunksParallel) + 4本の Promise.all で1波にまとめる
      // (feedback_dashboard_uriage_perf.md / feedback_chunk_serial_all_clients.md と同じ型)。
      const [kaigiHoumon, monitoringUsers, consentUsers, nameById] = await Promise.all([
        // 3) 支援経過 (通算の会議 + 当月の訪問/モニタリング)
        (async () => {
          const kaigiEver = new Set<string>();
          const houmonInMonth = new Set<string>();
          await mapChunksParallel(targetIds, ID_IN_CHUNK, async (chunk) => {
            for (let from = 0; ; from += PAGE) {
              const { data, error: e } = await supabase
                .from("kaigo_support_records")
                .select("user_id, category, record_date")
                .in("user_id", chunk)
                .order("id")
                .range(from, from + PAGE - 1);
              if (e) throw new Error(`支援経過の取得に失敗: ${e.message}`);
              const page = (data ?? []) as { user_id: string; category: string | null; record_date: string | null }[];
              for (const r of page) {
                if (r.category === "サービス担当者会議") kaigiEver.add(r.user_id);
                const inMonth = !!r.record_date && r.record_date >= monthStart && r.record_date <= monthEnd;
                if (inMonth && (r.category === "訪問" || r.category === "モニタリング")) {
                  houmonInMonth.add(r.user_id);
                }
              }
              if (page.length < PAGE) break;
            }
          });
          return { kaigiEver, houmonInMonth };
        })(),

        // 3b) モニタリングシート (実データは 0 件だが、あれば ② の根拠に加える)
        (async () => {
          const houmonInMonth = new Set<string>();
          await mapChunksParallel(targetIds, ID_IN_CHUNK, async (chunk) => {
            const { data, error: e } = await supabase
              .from("kaigo_monitoring_sheets")
              .select("user_id, monitoring_date")
              .in("user_id", chunk)
              .gte("monitoring_date", monthStart)
              .lte("monitoring_date", monthEnd);
            if (e) {
              if (!isMissingTable(e.code)) throw new Error(`モニタリングの取得に失敗: ${e.message}`);
              return;
            }
            for (const r of (data ?? []) as { user_id: string }[]) houmonInMonth.add(r.user_id);
          });
          return houmonInMonth;
        })(),

        // 4) 第1表の同意日 (content 全体を落とすと重いのでキーだけ select)
        (async () => {
          const consentUsers = new Set<string>();
          await mapChunksParallel(targetIds, ID_IN_CHUNK, async (chunk) => {
            const { data, error: e } = await supabase
              .from("kaigo_report_documents")
              .select("user_id, consent:content->>user_consent_date")
              .eq("report_type", "care-plan-1")
              .in("user_id", chunk);
            if (e) throw new Error(`第1表の取得に失敗: ${e.message}`);
            for (const r of (data ?? []) as { user_id: string; consent: string | null }[]) {
              if (r.consent && r.consent.trim()) consentUsers.add(r.user_id);
            }
          });
          return consentUsers;
        })(),

        // 5) 氏名
        (async () => {
          const nameById = new Map<string, string>();
          await mapChunksParallel(targetIds, ID_IN_CHUNK, async (chunk) => {
            const { data, error: e } = await supabase.from("clients").select("id, name").in("id", chunk);
            if (e) throw new Error(`利用者名の取得に失敗: ${e.message}`);
            for (const c of (data ?? []) as { id: string; name: string }[]) nameById.set(c.id, c.name);
          });
          return nameById;
        })(),
      ]);
      const kaigiEver = kaigiHoumon.kaigiEver;
      // 3) の訪問/モニタリングと 3b) のモニタリングシートを合算
      const houmonInMonth = new Set<string>([...kaigiHoumon.houmonInMonth, ...monitoringUsers]);

      const built: Row[] = targetIds.map((id) => ({
        clientId: id,
        name: nameById.get(id) ?? "(氏名不明)",
        hasKaigi: kaigiEver.has(id),
        hasHoumon: houmonInMonth.has(id),
        hasConsent: consentUsers.has(id),
        gensanOn: claimByUser.get(id) ?? false,
      }));
      built.sort((a, b) => a.name.localeCompare(b.name, "ja"));
      setRows(built);
      setLoadedFor(`${officeId}:${month}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, officeId, month]);

  useEffect(() => {
    if (!active) return;
    if (loadedFor === `${officeId}:${month}` && retryTick === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- タブを開いた時 / 月変更時の遅延読込
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadedFor は再読込の抑制にのみ使う
  }, [active, officeId, month, retryTick]);

  const stat = useMemo(() => {
    const n = rows.length;
    const cnt = (f: (r: Row) => boolean) => rows.filter(f).length;
    return {
      n,
      kaigi: cnt((r) => r.hasKaigi),
      houmon: cnt((r) => r.hasHoumon),
      consent: cnt((r) => r.hasConsent),
      gensan: cnt((r) => r.gensanOn),
      risk: rows.filter((r) => !r.hasHoumon || !r.hasConsent || !r.hasKaigi),
    };
  }, [rows]);

  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-gray-600">
          対象月{" "}
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </label>
        <button
          type="button"
          onClick={() => setRetryTick((t) => t + 1)}
          className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
        >
          <RefreshCw size={12} /> 再読込
        </button>
      </div>

      <p className="rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
        運営基準減算は<span className="font-medium">所定単位数の 50%（2 月以上継続で 100%）</span>。
        ①サービス担当者会議の開催 ②月 1 回以上の居宅訪問とモニタリング記録
        ③計画原案の説明・文書同意・交付 の 3 つが要件です。
        この画面は<span className="font-medium">立証できない利用者を出すだけ</span>で、請求額は変更しません。
      </p>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-gray-300" size={28} />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-200 py-16 text-center text-sm text-gray-400">
          {month} に居宅介護支援のレセプトがありません
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              { label: "① 担当者会議の記録 (通算)", v: stat.kaigi },
              { label: "② 当月の訪問・モニタリング", v: stat.houmon },
              { label: "③ 第1表に同意日", v: stat.consent },
              { label: "減算 ON のレセプト", v: stat.gensan },
            ].map((c) => (
              <div key={c.label} className="rounded-xl border border-gray-200 p-3">
                <div className="text-[11px] text-gray-500">{c.label}</div>
                <div className="mt-1 text-lg font-semibold text-gray-800">
                  {c.v}
                  <span className="ml-1 text-xs font-normal text-gray-400">
                    / {stat.n} 名 ({pct(c.v, stat.n)}%)
                  </span>
                </div>
              </div>
            ))}
          </div>

          {stat.risk.length > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              <div className="flex items-center gap-1 font-medium">
                <AlertTriangle size={14} />
                3 要件のいずれかを立証できない利用者が {stat.risk.length} 名います
              </div>
              <p className="mt-1 text-xs">
                実地指導で指摘されると、当該利用者・当該月の介護報酬返還につながります。
                記録を入れるか、該当するなら請求で減算を ON にしてください。
              </p>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-gray-200 text-gray-500">
                <tr>
                  <th className="px-2 py-2 text-left font-medium">利用者</th>
                  <th className="px-2 py-2 text-center font-medium">① 担当者会議</th>
                  <th className="px-2 py-2 text-center font-medium">② 当月訪問</th>
                  <th className="px-2 py-2 text-center font-medium">③ 同意日</th>
                  <th className="px-2 py-2 text-center font-medium">減算</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const ng = !r.hasKaigi || !r.hasHoumon || !r.hasConsent;
                  const mark = (ok: boolean) =>
                    ok ? <span className="text-emerald-600">✓</span> : <span className="text-red-500">✕</span>;
                  return (
                    <tr
                      key={r.clientId}
                      className={`border-b border-gray-100 ${ng ? "bg-red-50/40" : ""}`}
                    >
                      <td className="px-2 py-1.5 text-gray-800">{r.name}</td>
                      <td className="px-2 py-1.5 text-center">{mark(r.hasKaigi)}</td>
                      <td className="px-2 py-1.5 text-center">{mark(r.hasHoumon)}</td>
                      <td className="px-2 py-1.5 text-center">{mark(r.hasConsent)}</td>
                      <td className="px-2 py-1.5 text-center text-gray-500">
                        {r.gensanOn ? "ON" : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
