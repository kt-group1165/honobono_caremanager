"use client";

/**
 * 訪問介護計画書: 自事業所の作成状況 一覧 (利用者 未選択時に表示)
 *
 * 目的: 「誰の計画書が無い / 期限切れか」を横断で見えるようにする。
 *       運営指導では 訪問介護計画の未作成・期限切れが指摘対象になるため、
 *       利用者を 1 人ずつ開かないと分からない状態を解消する。
 *
 * 判定と母集団の定義は lib/houmon-care-plan/plan-alert.ts に集約
 * (= 通知アラートと同じ判定を使う)。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { ClipboardList, Loader2, Search, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { isSchemaV1Error } from "@/lib/houmon-care-plan/queries";
import { runHoumonPlanAlertScan, type PlanState, type PlanStateRow } from "@/lib/houmon-care-plan/plan-alert";

const STATE_CONFIG: Record<PlanState, { label: string; cls: string }> = {
  none: { label: "未作成", cls: "bg-red-100 text-red-700" },
  expired: { label: "期限切れ", cls: "bg-red-100 text-red-700" },
  soon: { label: "30日以内", cls: "bg-amber-100 text-amber-700" },
  draft: { label: "作成中", cls: "bg-yellow-100 text-yellow-700" },
  ok: { label: "有効", cls: "bg-green-100 text-green-700" },
};

const FILTERS: { key: "all" | PlanState; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "none", label: "未作成" },
  { key: "expired", label: "期限切れ" },
  { key: "soon", label: "30日以内" },
  { key: "draft", label: "作成中" },
  { key: "ok", label: "有効" },
];

function fmt(date: string | null | undefined): string {
  if (!date) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return m ? `${m[1]}/${Number(m[2])}/${Number(m[3])}` : date;
}

export function HoumonCarePlanOverview() {
  const supabase = useMemo(() => createClient(), []);
  const { businessType, currentOffice, currentOfficeId, loading: btLoading } = useBusinessType();
  const [rows, setRows] = useState<PlanStateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | PlanState>("all");
  const [query, setQuery] = useState("");
  const [schemaOutdated, setSchemaOutdated] = useState(false);

  const tenantId = currentOffice?.tenant_id ?? null;

  const load = useCallback(async () => {
    if (!currentOfficeId || !tenantId) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      // 判定 + 未通知分の通知作成 (cron が無いので画面読込時に回す)
      const { rows: next } = await runHoumonPlanAlertScan(supabase, {
        officeId: currentOfficeId,
        tenantId,
      });
      setRows(next);
      setSchemaOutdated(false);
    } catch (err) {
      console.error("訪問介護計画書 作成状況の取得に失敗:", err);
      if (isSchemaV1Error(err)) {
        setSchemaOutdated(true);
      } else {
        toast.error(
          "作成状況の取得に失敗しました: " + (err instanceof Error ? err.message : String(err)),
        );
      }
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, currentOfficeId, tenantId]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount 時 / 事業所切替時の非同期取得 (HANDOVER §2) */
    if (btLoading) return;
    load();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [btLoading, load]);

  const counts = useMemo(() => {
    const c: Record<PlanState, number> = { none: 0, expired: 0, soon: 0, draft: 0, ok: 0 };
    for (const r of rows) c[r.state]++;
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim();
    return rows.filter((r) => {
      if (filter !== "all" && r.state !== filter) return false;
      if (!q) return true;
      return r.clientName.includes(q) || (r.furigana ?? "").includes(q);
    });
  }, [rows, filter, query]);

  if (!btLoading && businessType !== "訪問介護") {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-800 flex items-start gap-3">
          <AlertCircle size={20} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">この機能は訪問介護モード専用です</p>
            <p className="text-sm mt-1">
              サイドバー下部の事業所セレクタから訪問介護の自事業所を選択してください。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
            <ClipboardList size={22} className="text-emerald-600 shrink-0" />
            訪問介護計画書
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-gray-500">
            自事業所の利用者ごとの作成状況です。行をクリックするとその利用者の計画書に移動します。
            未作成・期限切れ・30日以内は通知にも積まれます。
          </p>
        </div>

        {schemaOutdated ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 flex items-start gap-2">
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <p>
              訪問介護計画書 v2 の migration が未適用です
              (migrations/applied_archive/houmon_care_plans_v2.sql)
            </p>
          </div>
        ) : null}

        {/* filter + 検索 */}
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => {
            const n = f.key === "all" ? rows.length : counts[f.key];
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  active
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                {f.label}
                <span className={`ml-1 ${active ? "text-emerald-50" : "text-gray-400"}`}>{n}</span>
              </button>
            );
          })}
          <div className="relative ml-auto">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="氏名・かなで絞込"
              className="w-48 rounded-md border border-gray-300 py-1.5 pl-7 pr-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
        </div>

        {/* 一覧 (1 利用者 = 1 行) */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" />
            読込中...
          </div>
        ) : !currentOfficeId ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-12 text-center text-sm text-gray-500">
            サイドバー下部の事業所セレクタから訪問介護の自事業所を選択してください
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-12 text-center text-sm text-gray-500">
            該当する利用者がいません
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
                  <th className="px-3 py-2 font-medium">利用者</th>
                  <th className="w-24 px-3 py-2 font-medium">状態</th>
                  <th className="w-20 px-3 py-2 font-medium">区分</th>
                  <th className="w-28 px-3 py-2 font-medium">計画作成日</th>
                  <th className="w-28 px-3 py-2 font-medium">期限</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const cfg = STATE_CONFIG[r.state];
                  return (
                    <tr
                      key={r.clientId}
                      className="border-b border-gray-100 last:border-0 hover:bg-emerald-50/40"
                    >
                      <td className="px-3 py-2">
                        <Link
                          href={`/houmon-care-plans?user=${encodeURIComponent(r.clientId)}`}
                          className="block truncate font-medium text-gray-900 hover:text-emerald-700 hover:underline"
                          title={r.clientName}
                        >
                          {r.clientName}
                          {r.furigana ? (
                            <span className="ml-2 text-xs font-normal text-gray-400">
                              {r.furigana}
                            </span>
                          ) : null}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ${cfg.cls}`}
                        >
                          {cfg.label}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                        {r.plan?.plan_kind ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                        {fmt(r.plan?.plan_date)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                        {fmt(r.plan?.valid_until)}
                        {r.state === "soon" && r.daysLeft !== null ? (
                          <span className="ml-1 text-[11px] text-amber-600">残{r.daysLeft}日</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
