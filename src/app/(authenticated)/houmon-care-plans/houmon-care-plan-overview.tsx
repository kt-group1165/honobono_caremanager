"use client";

/**
 * 訪問介護計画書: 自事業所の作成状況 一覧 (利用者 未選択時に表示)
 *
 * 目的: 「誰の計画書が無い / 期限切れか」を横断で見えるようにする。
 *       運営指導では 訪問介護計画の未作成・期限切れが指摘対象になるため、
 *       利用者を 1 人ずつ開かないと分からない状態を解消する。
 *
 * 母集団: 自事業所 (client_office_assignments 経由) の active 利用者
 *         ← 直接 clients.office_id では引かない (CLAUDE.md §3.1)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { ID_IN_CHUNK, mapChunksParallel } from "@/lib/chunk-parallel";
import { ClipboardList, Loader2, Search, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { isSchemaV1Error } from "@/lib/houmon-care-plan/queries";
import type { HoumonCarePlanStatus, HoumonPlanKind } from "@/lib/houmon-care-plan/types";

interface ClientRow {
  id: string;
  name: string;
  furigana: string | null;
}

interface PlanRow {
  id: string;
  user_id: string;
  plan_kind: HoumonPlanKind;
  plan_date: string;
  valid_until: string | null;
  status: HoumonCarePlanStatus;
}

type PlanState = "none" | "expired" | "soon" | "draft" | "ok";

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

interface Row {
  client: ClientRow;
  plan: PlanRow | null;
  state: PlanState;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function plusDaysStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 計画の状態を決める。
 *  - 計画が無い                → none
 *  - 期限 (valid_until) 経過   → expired
 *  - 30 日以内に期限到来       → soon
 *  - status が draft のまま    → draft
 *  - それ以外                  → ok (期限未設定も ok 扱い)
 */
export function resolvePlanState(plan: PlanRow | null, today: string, limit: string): PlanState {
  if (!plan) return "none";
  if (plan.valid_until && plan.valid_until < today) return "expired";
  if (plan.valid_until && plan.valid_until <= limit) return "soon";
  if (plan.status === "draft") return "draft";
  return "ok";
}

function fmt(date: string | null | undefined): string {
  if (!date) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return m ? `${m[1]}/${Number(m[2])}/${Number(m[3])}` : date;
}

export function HoumonCarePlanOverview() {
  const supabase = useMemo(() => createClient(), []);
  const { businessType, currentOfficeId, loading: btLoading } = useBusinessType();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | PlanState>("all");
  const [query, setQuery] = useState("");
  const [schemaOutdated, setSchemaOutdated] = useState(false);

  const load = useCallback(async () => {
    if (!currentOfficeId) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      // 自事業所の active 利用者 (junction を !inner 埋め込みで 1 往復)
      const { data: clientData, error: cErr } = await supabase
        .from("clients")
        .select("id, name, furigana, client_office_assignments!inner(office_id)")
        .eq("client_office_assignments.office_id", currentOfficeId)
        .is("client_office_assignments.end_date", null)
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("furigana", { ascending: true, nullsFirst: false })
        .range(0, 9999);
      if (cErr) throw cErr;
      const clients = ((clientData ?? []) as unknown as ClientRow[]).map((c) => ({
        id: c.id,
        name: c.name,
        furigana: c.furigana,
      }));

      // 計画書は id chunk 並列で取得 (URL 長 / 1000 行制限対策)
      let plans: PlanRow[] = [];
      if (clients.length > 0) {
        const chunks = await mapChunksParallel(
          clients.map((c) => c.id),
          ID_IN_CHUNK,
          async (ids) => {
            const { data, error } = await supabase
              .from("kaigo_houmon_care_plans")
              .select("id, user_id, plan_kind, plan_date, valid_until, status")
              .in("user_id", ids)
              .order("plan_date", { ascending: false });
            if (error) throw error;
            return (data ?? []) as PlanRow[];
          },
        );
        plans = chunks.flat();
      }

      // 利用者ごとに最新 1 件 (plan_date 降順で先に来たものを採用)
      const latest = new Map<string, PlanRow>();
      for (const p of plans) {
        const cur = latest.get(p.user_id);
        if (!cur || p.plan_date > cur.plan_date) latest.set(p.user_id, p);
      }

      const today = todayStr();
      const limit = plusDaysStr(30);
      setRows(
        clients.map((c) => {
          const plan = latest.get(c.id) ?? null;
          return { client: c, plan, state: resolvePlanState(plan, today, limit) };
        }),
      );
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
  }, [supabase, currentOfficeId]);

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
      return r.client.name.includes(q) || (r.client.furigana ?? "").includes(q);
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
                    <tr key={r.client.id} className="border-b border-gray-100 last:border-0 hover:bg-emerald-50/40">
                      <td className="px-3 py-2">
                        <Link
                          href={`/houmon-care-plans?user=${encodeURIComponent(r.client.id)}`}
                          className="block truncate font-medium text-gray-900 hover:text-emerald-700 hover:underline"
                          title={r.client.name}
                        >
                          {r.client.name}
                          {r.client.furigana ? (
                            <span className="ml-2 text-xs font-normal text-gray-400">
                              {r.client.furigana}
                            </span>
                          ) : null}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ${cfg.cls}`}>
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
