"use client";

/**
 * 月次情報 — 訪問介護の請求前チェック一覧 (見た目: order-app 月次情報タブと同一)
 *
 * 左: あかさたな索引 / 中央: ◀ 年月 ▶ ツールバー + 格子テーブル。
 * 列構成 (ほのぼの 1-4「居宅の情報 / 計画単位数の設定」再現):
 *   保険変更 / 保険者 / 被保険者番号 / 利用者名 / 利用者番号 / 作成区分 /
 *   支援事業所番号 / 居宅介護支援事業所名 /
 *   区分支給限度基準内単位数 (= 計画単位数。kaigo_monthly_plan_units、クリックで手入力) /
 *   実績単位数 (= 実績集計 totalUnits)
 *
 * 計画単位数の入力経路:
 *   - セルクリック → 手入力 (source='manual')
 *   - 「別表から取込」→ kaigo_report_documents (report_type='service-usage-detail') の
 *     content.items[] から自事業所 (provider_number=事業所番号 or provider_name=事業所名) の
 *     within_limit_units を合算して一括 upsert (source='careplan')
 *   - 「前月複写」→ 前月の kaigo_monthly_plan_units を当月へコピー (当月値ありは skip、source='copy')
 *
 * 警告バッジ (目視確認用):
 *   - 認定有効期間が対象月に掛からない → 保険変更列に赤「認定切れ」
 *   - 担当居宅事業所番号が未設定 → 支援事業所番号列に橙「担当居宅未設定」
 *   - 実績 > 計画 → 実績列に赤「計画超過」(超過分は保険請求不可)
 *   - 計画 0 / 未設定 → 計画列にグレー「未設定」
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, AlertCircle, FileDown, Copy } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { monthRange } from "@/lib/cert-for-month";
import { mergeSegmentRows } from "@/lib/visit-seikyu/aggregate";
import { useBusinessType } from "@/lib/business-type-context";
import {
  useSeikyuContext,
  SeikyuKanaSidebar,
  SeikyuMonthNav,
} from "./seikyu-context";

// 認定有効期間 (certStart〜certEnd) が対象月 (year/month) に掛かるか判定する。
// 開始が月末より後、または 終了が月初より前なら「掛からない」= 認定切れ扱い。
// 月初・月末は monthRange (文字列演算・TZ 安全)。toISOString は UTC 変換で
// 月末が 1 日ずれる (JST 深夜に前日扱い) ため使わない。
function certCoversMonth(
  certStart: string | null,
  certEnd: string | null,
  year: number,
  month: number,
): boolean {
  const { from: monthStart, to: monthEnd } = monthRange(year, month);
  if (certStart && certStart > monthEnd) return false;
  if (certEnd && certEnd < monthStart) return false;
  return true;
}

// ── 計画単位数 (kaigo_monthly_plan_units) ────────────────────────────────────

interface PlanEntry {
  planned_units: number;
  source: string;
}

const PLAN_SOURCE_LABEL: Record<string, string> = {
  manual: "手入力",
  careplan: "別表取込",
  copy: "前月複写",
};

// テーブル未作成 (42P01 = undefined_table / PGRST205 = schema cache に無い) 判定
function isTableMissing(code: string | null | undefined, message: string | null | undefined): boolean {
  if (code === "42P01" || code === "PGRST205") return true;
  return !!message?.includes("kaigo_monthly_plan_units") && !!message?.includes("schema cache");
}

// 別表 (第7表) content.items[] の 1 行
interface UsageDetailItem {
  provider_number?: string | null;
  provider_name?: string | null;
  within_limit_units?: number | string | null;
}

export function MonthlyInfoContent() {
  const {
    year,
    month,
    filteredRows: rawFilteredRows,
    recordCount,
    loading,
    error,
    officeNumber,
    officeName,
    tenantId,
  } = useSeikyuContext();
  // 保険者変更 (転居) の分割セグメント行 (Phase 2) は利用者単位に合算して表示する
  // (計画単位数は利用者×月の 1 値。分割行が無ければ同一参照)
  const filteredRows = useMemo(
    () => mergeSegmentRows(rawFilteredRows),
    [rawFilteredRows],
  );
  const supabase = useMemo(() => createClient(), []);
  const { businessType } = useBusinessType();
  // 訪問入浴は計画単位数を bath_monthly_plan_units に持つ (schema 同型)
  const planTable = businessType === "訪問入浴" ? "bath_monthly_plan_units" : "kaigo_monthly_plan_units";

  const targetMonth = `${year}-${String(month).padStart(2, "0")}-01`;

  const [planMap, setPlanMap] = useState<Record<string, PlanEntry>>({});
  const [planTableMissing, setPlanTableMissing] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // ── 当月の計画単位数を取得 ──────────────────────────────────────────────
  const loadPlans = useCallback(async () => {
    setPlanLoading(true);
    const map: Record<string, PlanEntry> = {};
    const PAGE = 1000;
    let from = 0;
    let missing = false;
    while (true) {
      const { data, error: qErr } = await supabase
        .from(planTable)
        .select("client_id, planned_units, source")
        .eq("target_month", targetMonth)
        .range(from, from + PAGE - 1);
      if (qErr) {
        if (isTableMissing(qErr.code, qErr.message)) {
          missing = true;
        } else {
          toast.error(`計画単位数の取得に失敗: ${qErr.message}`);
        }
        break;
      }
      for (const r of (data ?? []) as { client_id: string; planned_units: number | null; source: string | null }[]) {
        map[r.client_id] = {
          planned_units: r.planned_units ?? 0,
          source: r.source ?? "manual",
        };
      }
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    setPlanTableMissing(missing);
    setPlanMap(map);
    setPlanLoading(false);
  }, [supabase, targetMonth, planTable]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/月変更時の fetch
    loadPlans();
  }, [loadPlans]);

  // ── upsert helper (tenant_id NOT NULL 規約に合わせて付与) ────────────────
  const buildPayload = useCallback(
    (clientId: string, units: number, source: string) => ({
      client_id: clientId,
      target_month: targetMonth,
      planned_units: units,
      source,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    }),
    [targetMonth, tenantId],
  );

  // ── 手入力保存 ──────────────────────────────────────────────────────────
  const savePlanManual = useCallback(
    async (clientId: string, units: number) => {
      const { error: upErr } = await supabase
        .from(planTable)
        .upsert(buildPayload(clientId, units, "manual"), {
          onConflict: "client_id,target_month",
        });
      if (upErr) {
        toast.error(`計画単位数の保存に失敗: ${upErr.message}`);
        return;
      }
      setPlanMap((prev) => ({
        ...prev,
        [clientId]: { planned_units: units, source: "manual" },
      }));
    },
    [supabase, buildPayload, planTable],
  );

  const startEdit = (clientId: string, current: PlanEntry | undefined) => {
    if (planTableMissing) return;
    setEditingId(clientId);
    setEditDraft(current ? String(current.planned_units) : "");
  };

  const commitEdit = async () => {
    const clientId = editingId;
    setEditingId(null);
    if (!clientId) return;
    const v = editDraft.trim();
    if (v === "") return; // 空 = キャンセル扱い
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("計画単位数は 0 以上の数値を入力してください");
      return;
    }
    const units = Math.round(n);
    const prev = planMap[clientId];
    if (prev && prev.planned_units === units) return; // 変更なし
    await savePlanManual(clientId, units);
  };

  // ── 別表から取込 ────────────────────────────────────────────────────────
  const importFromBeppyo = async () => {
    if (planTableMissing) return;
    if (!officeNumber && !officeName) {
      toast.error("自事業所の事業所番号・名称が取得できないため取込できません");
      return;
    }
    setImporting(true);
    try {
      const ym = `${year}-${String(month).padStart(2, "0")}`;
      // 別表 (第7表) を対象月で取得。report_month が正 (reports 編集画面)、
      // year_month は旧 careplan-import 形式のフォールバック。
      const { data, error: qErr } = await supabase
        .from("kaigo_report_documents")
        .select("user_id, content, created_at")
        .eq("report_type", "service-usage-detail")
        .or(`content->>report_month.eq.${ym},content->>year_month.eq.${ym}`)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (qErr) {
        toast.error(`別表の取得に失敗: ${qErr.message}`);
        return;
      }

      // user ごとに「最新の、自事業所 items を持つ別表」を採用
      const byUser = new Map<string, number>();
      for (const doc of (data ?? []) as { user_id: string; content: unknown }[]) {
        if (byUser.has(doc.user_id)) continue;
        const content = doc.content as { items?: UsageDetailItem[] } | null;
        if (!content || !Array.isArray(content.items)) continue;
        const own = content.items.filter(
          (it) =>
            (officeNumber != null && it.provider_number === officeNumber) ||
            (officeName != null && it.provider_name === officeName),
        );
        if (own.length === 0) continue;
        const sum = own.reduce(
          (s, it) => s + (Number(it.within_limit_units) || 0),
          0,
        );
        byUser.set(doc.user_id, sum);
      }

      if (byUser.size === 0) {
        toast.info("対象データがありません (対象月の別表に自事業所分の明細が見つかりません)");
        return;
      }

      const payload = [...byUser.entries()].map(([clientId, units]) =>
        buildPayload(clientId, units, "careplan"),
      );
      const { error: upErr } = await supabase
        .from(planTable)
        .upsert(payload, { onConflict: "client_id,target_month" });
      if (upErr) {
        toast.error(`計画単位数の取込に失敗: ${upErr.message}`);
        return;
      }
      toast.success(`${payload.length} 名分の計画単位数を別表から取込みました`);
      await loadPlans();
    } finally {
      setImporting(false);
    }
  };

  // ── 前月複写 ────────────────────────────────────────────────────────────
  const copyPrevMonth = async () => {
    if (planTableMissing) return;
    const prevY = month === 1 ? year - 1 : year;
    const prevM = month === 1 ? 12 : month - 1;
    const prevMonthStr = `${prevY}-${String(prevM).padStart(2, "0")}-01`;
    if (
      !window.confirm(
        `${prevY}年${prevM}月 の計画単位数を ${year}年${month}月 に複写します。\n当月に既に値がある利用者はスキップされます。よろしいですか？`,
      )
    ) {
      return;
    }
    setCopying(true);
    try {
      const { data, error: qErr } = await supabase
        .from(planTable)
        .select("client_id, planned_units")
        .eq("target_month", prevMonthStr)
        .limit(1000);
      if (qErr) {
        toast.error(`前月データの取得に失敗: ${qErr.message}`);
        return;
      }
      const prevRows = (data ?? []) as { client_id: string; planned_units: number | null }[];
      if (prevRows.length === 0) {
        toast.info("前月の計画単位数データがありません");
        return;
      }
      const toCopy = prevRows.filter((r) => !(r.client_id in planMap));
      if (toCopy.length === 0) {
        toast.info("複写対象がありません (全利用者に当月の値があります)");
        return;
      }
      const payload = toCopy.map((r) =>
        buildPayload(r.client_id, r.planned_units ?? 0, "copy"),
      );
      const { error: upErr } = await supabase
        .from(planTable)
        .upsert(payload, {
          onConflict: "client_id,target_month",
          ignoreDuplicates: true,
        });
      if (upErr) {
        toast.error(`前月複写に失敗: ${upErr.message}`);
        return;
      }
      toast.success(
        `${toCopy.length} 名分を前月から複写しました (当月値ありスキップ ${prevRows.length - toCopy.length} 名)`,
      );
      await loadPlans();
    } finally {
      setCopying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={22} className="animate-spin text-indigo-400" />
      </div>
    );
  }

  const plannedTotal = filteredRows.reduce(
    (s, r) => s + (planMap[r.user_id]?.planned_units ?? 0),
    0,
  );

  return (
    <div className="flex flex-1 min-h-0">
      {/* 左: かな行フィルター */}
      <SeikyuKanaSidebar />

      {/* 中央: ツールバー + テーブル */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2">
          <SeikyuMonthNav variant="square" />
          <span className="text-xs text-gray-500 ml-2">{filteredRows.length} 件</span>
          <div className="ml-auto flex items-center gap-2">
            {planTableMissing && (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">
                計画単位数テーブル未作成
              </span>
            )}
            <button
              type="button"
              onClick={importFromBeppyo}
              disabled={planTableMissing || planLoading || importing || copying}
              title="ケアプラン取込済みの別表 (第7表) から、自事業所分の区分支給限度基準内単位数を一括取込します"
              className="flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {importing ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <FileDown size={13} />
              )}
              別表から取込
            </button>
            <button
              type="button"
              onClick={copyPrevMonth}
              disabled={planTableMissing || planLoading || importing || copying}
              title="前月の計画単位数を当月へコピーします (当月に値がある利用者はスキップ)"
              className="flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {copying ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Copy size={13} />
              )}
              前月複写
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-b border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        <div className="flex-1 overflow-auto">
          <table className="min-w-full text-xs border-collapse">
            <thead className="bg-gray-100 text-gray-700 sticky top-0 z-10">
              <tr>
                <th className="px-2 py-1.5 border border-gray-300 text-left">保険変更</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">保険者</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">被保険者番号</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">利用者名</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">利用者番号</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">作成区分</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">支援事業所番号</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">居宅介護支援事業所名</th>
                <th
                  className="px-2 py-1.5 border border-gray-300 text-right cursor-help underline decoration-dotted decoration-gray-400 underline-offset-2"
                  title="ケアマネの提供票別表 (第7表) 由来の、自事業所分の計画単位数 (区分支給限度基準内)。セルをクリックすると手入力できます。「別表から取込」「前月複写」でも設定できます。"
                >
                  区分支給限度基準内単位数
                </th>
                <th
                  className="px-2 py-1.5 border border-gray-300 text-right cursor-help underline decoration-dotted decoration-gray-400 underline-offset-2"
                  title="対象月の実績 (完了) から集計した総単位数。計画単位数を超えた分は保険請求できません (超過分は自費)。"
                >
                  実績単位数
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const certOk = certCoversMonth(r.certStart, r.certEnd, year, month);
                const hasCareOffice = !!r.careOfficeNumber;
                const plan = planMap[r.user_id];
                const planSet = !!plan && plan.planned_units > 0;
                const overrun = planSet && r.totalUnits > plan.planned_units;
                return (
                  <tr key={r.user_id} className="hover:bg-blue-50 whitespace-nowrap">
                    <td className="px-2 py-1 border border-gray-200 text-center text-gray-400">
                      {certOk ? (
                        "-"
                      ) : (
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
                          認定切れ
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 border border-gray-200">
                      {r.insurer_name ?? r.insurer_number ?? "-"}
                    </td>
                    <td className="px-2 py-1 border border-gray-200 font-mono">
                      {r.insured_number ?? "-"}
                    </td>
                    <td className="px-2 py-1 border border-gray-200">{r.user_name}</td>
                    <td className="px-2 py-1 border border-gray-200 font-mono">
                      {r.user_number ?? "-"}
                    </td>
                    <td className="px-2 py-1 border border-gray-200">
                      {hasCareOffice ? "居宅介護支援事業者作成" : "-"}
                    </td>
                    <td className="px-2 py-1 border border-gray-200 font-mono">
                      {hasCareOffice ? (
                        r.careOfficeNumber
                      ) : (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                          担当居宅未設定
                        </span>
                      )}
                    </td>
                    <td
                      className="px-2 py-1 border border-gray-200 truncate max-w-[200px]"
                      title={r.careOfficeName ?? ""}
                    >
                      {r.careOfficeName ?? "-"}
                    </td>
                    {/* 計画単位数 (クリックで手入力) */}
                    <td
                      className={`px-2 py-1 border border-gray-200 text-right font-mono ${planTableMissing ? "" : "cursor-pointer"}`}
                      title={
                        planTableMissing
                          ? "計画単位数テーブル未作成"
                          : plan
                            ? `入力元: ${PLAN_SOURCE_LABEL[plan.source] ?? plan.source} (クリックで編集)`
                            : "クリックで手入力"
                      }
                      onClick={() => {
                        if (editingId !== r.user_id) startEdit(r.user_id, plan);
                      }}
                    >
                      {editingId === r.user_id ? (
                        <input
                          type="number"
                          min={0}
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") {
                              setEditDraft("");
                              setEditingId(null);
                            }
                          }}
                          className="w-24 rounded border border-blue-400 px-1 py-0.5 text-right text-xs font-mono focus:outline-none"
                        />
                      ) : planTableMissing ? (
                        <span className="text-gray-400">-</span>
                      ) : planSet ? (
                        plan.planned_units.toLocaleString()
                      ) : (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold text-gray-500">
                          未設定
                        </span>
                      )}
                    </td>
                    {/* 実績単位数 (計画超過チェック) */}
                    <td className="px-2 py-1 border border-gray-200 font-mono whitespace-nowrap align-middle">
                      {/* バッジを左・数字を右端に。flex items-center で縦揃え、
                          数字を末尾に置くことでバッジ有無に依らず数字の右端が一直線に並ぶ */}
                      <div className="flex items-center justify-end gap-1">
                        {overrun && (
                          <span
                            title={`計画単位数を ${(r.totalUnits - plan.planned_units).toLocaleString()} 単位超過しています。超過分は保険請求できません (自費)。`}
                            className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold leading-none text-red-700"
                          >
                            計画超過
                          </span>
                        )}
                        <span>{r.totalUnits.toLocaleString()}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-center text-gray-400 text-sm">
                    対象月の実績 (完了) がありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* フッター合計 (order-app 介護請求タブの box レイアウトと同トーン) */}
        <div className="border-t border-gray-300 bg-gray-50 px-3 py-2 shrink-0 text-[11px] text-gray-700">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span>
              件数 <strong className="font-mono">{filteredRows.length.toLocaleString()}</strong>
            </span>
            <span>
              実績 <strong className="font-mono">{recordCount.toLocaleString()}</strong> 件
            </span>
            <span>
              計画単位数合計{" "}
              <strong className="font-mono">
                {planTableMissing ? "-" : plannedTotal.toLocaleString()}
              </strong>
            </span>
            <span>
              実績単位数合計{" "}
              <strong className="font-mono">
                {filteredRows.reduce((s, r) => s + r.totalUnits, 0).toLocaleString()}
              </strong>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
