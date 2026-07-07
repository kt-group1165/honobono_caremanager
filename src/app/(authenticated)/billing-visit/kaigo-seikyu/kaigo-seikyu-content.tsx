"use client";

/**
 * 介護請求 — 利用者ごとの月次請求管理 (見た目: order-app 介護請求タブと同一)
 *
 * 左: あかさたな索引 / 中央: ツールバー + グリッドテーブル + 合計フッタ /
 * 右: 明細情報ペイン (行クリックで表示)。
 *
 * 機能 (従来どおり):
 *   - 行チェック + 状態表示 (未発行 / 発行済 / 国保対象)
 *   - 月遅 / 返戻 / 過誤 フラグ (kaigo_billing_status に upsert)
 *   - 明細書 (様式第二) / 請求書 (様式第一 総括) / 国保対象 / 確認用CSV
 *
 * ※ Phase 2: 月遅れ/返戻の再請求。過去月の月遅れ/返戻 (未・国保対象) を
 *    元提供月で再集計し、当月一覧にバッジ付きで合流。明細書・伝送・国保対象化は
 *    各自の元提供月で反映する。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  AlertCircle,
  FileText,
  Printer,
  Landmark,
  Download,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { toast } from "sonner";
import {
  useSeikyuContext,
  SeikyuKanaSidebar,
  SeikyuMonthNav,
} from "../_shared/seikyu-context";
import { MeisaiPrintSheet } from "../../billing/forms/_meisai";
import { SeikyuForm } from "../../billing/forms/_seikyu";
import {
  loadReSeikyuRows,
  type ReSeikyuRow,
} from "@/lib/visit-seikyu/re-seikyu";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";

// order-app 介護請求タブのグリッド列定義 (完全コピー、サービス事業所列を除く)
const GRID_COLS =
  "grid grid-cols-[32px_64px_72px_60px_60px_104px_1fr_64px_72px_44px]";

// kaigo_billing_status の 1 行 (利用者 × 月)
interface BillingStatusRow {
  client_id: string;
  issued_at: string | null;
  kokuho_target: boolean;
  tsukiokure: boolean;
  henrei: boolean;
  kago: boolean;
}

// 一覧の 1 行 (当月通常行 or 過去月の再請求行)
interface DisplayRow {
  /** 一意キー (利用者 × 提供月)。当月="cur:<id>" / 再請求="re:<id>:<origMonthKey>" */
  key: string;
  row: UserSeikyuRow;
  /** この行の提供月 (YYYY-MM)。当月行は当月、再請求行は元提供月 */
  origMonthKey: string;
  /** 月遅れ/返戻の再請求行か */
  isReSeikyu: boolean;
  /** 再請求理由 (月遅れ/返戻)。当月通常行は null */
  reasons: { tsukiokure: boolean; henrei: boolean } | null;
}

export function KaigoSeikyuContent() {
  const {
    year, month, filteredRows, kanaMatches, recordCount, loading, error,
    officeName, officeNumber, officeAddress, officePhone, officePostal,
    officeId, tenantId, unitPrice, appliedFormulaCodes,
  } = useSeikyuContext();
  const { currentOffice } = useBusinessType();
  const supabase = useMemo(() => createClient(), []);

  // 選択・チェックは (利用者 × 提供月) 単位。月遅れ/返戻で同一利用者が
  // 当月行 + 過去月行で二重に並ぶため、user_id 単体ではなく複合キーで持つ。
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [statusByClient, setStatusByClient] = useState<Map<string, BillingStatusRow>>(new Map());
  const [printMode, setPrintMode] = useState<"meisai" | "seikyu" | null>(null);
  // 行内「明細書」ボタン用: 印刷対象を明示指定するとき (null = targetDisplayRows)
  const [meisaiPrintRows, setMeisaiPrintRows] = useState<DisplayRow[] | null>(null);
  // 月遅れ/返戻の再請求行 (過去月を元提供月で再集計したもの)
  const [reRows, setReRows] = useState<ReSeikyuRow[]>([]);

  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  // ── 表示用の統合行 (当月通常行 + 再請求行)。カナ索引で共通絞込 ──
  // rowKey: 当月行は "cur:<user_id>" / 再請求行は "re:<user_id>:<origMonthKey>"
  const displayRows = useMemo<DisplayRow[]>(() => {
    const cur: DisplayRow[] = filteredRows.map((r) => ({
      key: `cur:${r.user_id}`,
      row: r,
      origMonthKey: monthKey,
      isReSeikyu: false,
      reasons: null,
    }));
    const re: DisplayRow[] = reRows.filter(kanaMatches).map((r) => ({
      key: `re:${r.user_id}:${r.__origMonthKey}`,
      row: r,
      origMonthKey: r.__origMonthKey,
      isReSeikyu: true,
      reasons: r.__reasons,
    }));
    // 再請求 (過去分) を上、当月を下に並べる
    return [...re, ...cur];
  }, [filteredRows, reRows, kanaMatches, monthKey]);

  const selected =
    displayRows.find((d) => d.key === selectedKey)?.row ?? null;

  // 合計は当月の通常行のみ (再請求分は元提供月の別集計なので当月合計には含めない)
  const totalUnits = filteredRows.reduce((s, r) => s + r.totalUnits, 0);
  const totalInsurance = filteredRows.reduce((s, r) => s + r.insuranceAmount, 0);
  const totalUser = filteredRows.reduce((s, r) => s + r.userAmount, 0);
  const totalKohiUnits = filteredRows.reduce((s, r) => s + (r.kohiUnits ?? 0), 0);
  const totalKohiAmount = filteredRows.reduce((s, r) => s + (r.kohiAmount ?? 0), 0);
  const kokuhoCount = filteredRows.filter(
    (r) => statusByClient.get(r.user_id)?.kokuho_target,
  ).length;

  // ── 月遅れ/返戻の再請求行を読み込む ──
  const loadReRows = useCallback(async () => {
    if (!officeId || !tenantId) {
      setReRows([]);
      return;
    }
    try {
      const list = await loadReSeikyuRows(supabase, {
        officeId,
        tenantId,
        unitPrice,
        appliedFormulaCodes,
        currentMonthKey: monthKey,
      });
      setReRows(list);
    } catch (e) {
      toast.error(
        "再請求分の集計に失敗: " + (e instanceof Error ? e.message : String(e)),
      );
      setReRows([]);
    }
  }, [supabase, officeId, tenantId, unitPrice, appliedFormulaCodes, monthKey]);

  useEffect(() => {
    if (loading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月/事業所変更時の fetch
    loadReRows();
  }, [loading, loadReRows]);

  // ── kaigo_billing_status を (target_month) で読み、client_id で突合 ──
  const loadStatus = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("kaigo_billing_status")
      .select("client_id, issued_at, kokuho_target, tsukiokure, henrei, kago")
      .eq("target_month", monthKey);
    if (e) {
      // table 未作成 (migration 未適用) 時は状態なしとして続行
      if (e.code !== "42P01") toast.error("請求状態の取得に失敗: " + e.message);
      setStatusByClient(new Map());
      return;
    }
    setStatusByClient(
      new Map(((data ?? []) as BillingStatusRow[]).map((r) => [r.client_id, r])),
    );
  }, [supabase, monthKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadStatus();
  }, [loadStatus]);

  // ── フラグ (月遅れ/返戻/過誤) の upsert ──
  const setFlag = async (
    clientId: string,
    field: "tsukiokure" | "henrei" | "kago",
    value: boolean,
  ) => {
    const cur = statusByClient.get(clientId);
    const payload: Record<string, unknown> = {
      client_id: clientId,
      target_month: monthKey,
      tenant_id: currentOffice?.tenant_id ?? "kt-group",
      office_id: currentOffice?.id ?? null,
      // 既存値を保持しつつ対象フラグだけ更新
      tsukiokure: cur?.tsukiokure ?? false,
      henrei: cur?.henrei ?? false,
      kago: cur?.kago ?? false,
      [field]: value,
    };
    const { error: e } = await supabase
      .from("kaigo_billing_status")
      .upsert(payload, { onConflict: "client_id,target_month" });
    if (e) {
      toast.error("フラグの保存に失敗: " + e.message);
      return;
    }
    loadStatus();
  };

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleAll = () =>
    setChecked((prev) =>
      prev.size === displayRows.length
        ? new Set()
        : new Set(displayRows.map((d) => d.key)),
    );
  const selectUnissued = () =>
    setChecked(
      new Set(
        displayRows
          .filter(
            (d) =>
              // 再請求行は常に未発行扱い / 当月行は issued_at 無しのみ
              d.isReSeikyu || !statusByClient.get(d.row.user_id)?.issued_at,
          )
          .map((d) => d.key),
      ),
    );

  // 対象: チェックあり → その行 / チェックなし → 全件 (当月 + 再請求)
  const targetDisplayRows = useMemo(
    () =>
      checked.size > 0
        ? displayRows.filter((d) => checked.has(d.key))
        : displayRows,
    [displayRows, checked],
  );
  const targets = useMemo(
    () => targetDisplayRows.map((d) => d.row),
    [targetDisplayRows],
  );

  // 集計 (請求書用) — 様式第一 総括は当月の通常行のみを対象とする
  // (再請求分は元提供月の別請求書になるため、当月総括には含めない)
  const seikyuTargets = useMemo(
    () => targetDisplayRows.filter((d) => !d.isReSeikyu).map((d) => d.row),
    [targetDisplayRows],
  );
  const targetUnits = seikyuTargets.reduce((s, r) => s + r.totalUnits, 0);
  const targetCost = seikyuTargets.reduce((s, r) => s + r.totalAmount, 0);
  const targetInsurance = seikyuTargets.reduce((s, r) => s + r.insuranceAmount, 0);
  const targetUser = seikyuTargets.reduce((s, r) => s + r.userAmount, 0);

  // ── 明細書: 対象者の様式第二を印刷 → 印刷実行時に issued_at を now() で upsert (発行済化) ──
  //    再請求行は元提供月 (origMonthKey) に対して upsert する。
  //    rowsToPrint 指定時 (行内ボタン) はその行のみ対象。
  const printMeisaiFor = async (rowsToPrint: DisplayRow[]) => {
    if (rowsToPrint.length === 0) return;
    const now = new Date().toISOString();
    const payload = rowsToPrint.map((d) => {
      // 当月行のみ既存フラグを引き継ぐ (再請求行は過去月の別レコード)
      const cur = d.isReSeikyu ? undefined : statusByClient.get(d.row.user_id);
      return {
        client_id: d.row.user_id,
        target_month: d.origMonthKey,
        tenant_id: currentOffice?.tenant_id ?? "kt-group",
        office_id: currentOffice?.id ?? null,
        issued_at: now,
        // 既存フラグを保持 (再請求行は理由フラグを保持)
        kokuho_target: cur?.kokuho_target ?? false,
        tsukiokure: d.reasons?.tsukiokure ?? cur?.tsukiokure ?? false,
        henrei: d.reasons?.henrei ?? cur?.henrei ?? false,
        kago: cur?.kago ?? false,
      };
    });
    const { error: e } = await supabase
      .from("kaigo_billing_status")
      .upsert(payload, { onConflict: "client_id,target_month" });
    if (e) {
      toast.error("発行状態の保存に失敗: " + e.message);
    } else {
      loadStatus();
    }
    // 保存の成否に関わらず印刷は実行 (状態が保存できなくても紙は出せるように)
    setMeisaiPrintRows(rowsToPrint);
    setPrintMode("meisai");
    setTimeout(() => {
      window.print();
      setPrintMode(null);
      setMeisaiPrintRows(null);
    }, 100);
  };

  const printMeisai = () => printMeisaiFor(targetDisplayRows);

  // ── 請求書: 事業所単位の総括 (様式第一) を印刷 ──
  const printSeikyu = () => {
    if (targets.length === 0) return;
    setPrintMode("seikyu");
    setTimeout(() => {
      window.print();
      setPrintMode(null);
    }, 100);
  };

  // ── 国保対象: 選択行を kokuho_target=true に upsert ──
  //    当月行は「発行済」のみ (未発行はスキップ)。
  //    再請求行 (月遅れ/返戻) は元提供月に対し kokuho_target=true + notes='再請求' で立てる
  //    (未発行なら発行済化も同時に行う)。
  const markKokuhoTarget = async () => {
    const now = new Date().toISOString();
    const payload: Record<string, unknown>[] = [];
    let skipped = 0;

    for (const d of targetDisplayRows) {
      if (d.isReSeikyu) {
        // 再請求分: 元提供月に kokuho_target を立てる (発行済でなくても許可)
        const prevNotes = "再請求";
        payload.push({
          client_id: d.row.user_id,
          target_month: d.origMonthKey,
          tenant_id: currentOffice?.tenant_id ?? "kt-group",
          office_id: currentOffice?.id ?? null,
          issued_at: now,
          kokuho_target: true,
          tsukiokure: d.reasons?.tsukiokure ?? false,
          henrei: d.reasons?.henrei ?? false,
          kago: false,
          notes: prevNotes,
        });
      } else {
        const cur = statusByClient.get(d.row.user_id);
        if (!cur?.issued_at) {
          skipped++;
          continue;
        }
        payload.push({
          client_id: d.row.user_id,
          target_month: monthKey,
          tenant_id: currentOffice?.tenant_id ?? "kt-group",
          office_id: currentOffice?.id ?? null,
          issued_at: cur.issued_at,
          kokuho_target: true,
          tsukiokure: cur.tsukiokure,
          henrei: cur.henrei,
          kago: cur.kago,
        });
      }
    }

    if (payload.length === 0) {
      toast.warning(
        "国保対象にできる行がありません (当月分は先に明細書を発行してください)",
      );
      return;
    }
    const { error: e } = await supabase
      .from("kaigo_billing_status")
      .upsert(payload, { onConflict: "client_id,target_month" });
    if (e) {
      toast.error("国保対象の保存に失敗: " + e.message);
      return;
    }
    toast.success(
      `${payload.length} 件を国保対象にしました${skipped > 0 ? ` (未発行 ${skipped} 名はスキップ)` : ""}`,
    );
    loadStatus();
    // 再請求分は kokuho_target 化されたので一覧から外れる → 再読込
    loadReRows();
  };

  // ── 確認用 CSV (明細一覧) ──
  const exportCsv = () => {
    const ym = `${year}${String(month).padStart(2, "0")}`;
    const header = [
      "提供年月",
      "被保険者番号",
      "利用者名",
      "要介護度",
      "総単位数",
      "保険請求額",
      "利用者負担額",
      "状態",
    ];
    const lines: string[] = [header.join(",")];
    for (const d of targetDisplayRows) {
      const r = d.row;
      // 再請求行は元提供月 (YYYYMM) を提供年月として出す
      const rowYm = d.isReSeikyu ? d.origMonthKey.replace("-", "") : ym;
      const st = d.isReSeikyu ? undefined : statusByClient.get(r.user_id);
      const state = d.isReSeikyu
        ? d.reasons?.henrei
          ? "返戻(再請求)"
          : "月遅れ(再請求)"
        : st?.kokuho_target
        ? "国保対象"
        : st?.issued_at
        ? "発行済"
        : "未発行";
      lines.push(
        [
          rowYm,
          r.insured_number ?? "",
          `"${r.user_name}"`,
          r.care_level ?? "",
          r.totalUnits,
          r.insuranceAmount,
          r.userAmount,
          state,
        ].join(","),
      );
    }
    // Excel 互換のため BOM 付き UTF-8
    const blob = new Blob(["﻿" + lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kaigo_seikyu_${ym}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const allChecked = checked.size === displayRows.length && displayRows.length > 0;

  return (
    <>
      <div className="flex flex-1 min-h-0 print:hidden">
        {/* ── 行カナ絞り込みサイドバー ── */}
        <SeikyuKanaSidebar />

        {/* ── メインテーブル ── */}
        <div className="flex flex-col flex-1 min-w-0 border-r border-gray-200">
          {/* ── ツールバー ── */}
          <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
            <SeikyuMonthNav />
            <span className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 font-medium">請求分</span>
            <span className="text-xs text-gray-500">{displayRows.length} 件</span>
            <div className="w-px h-5 bg-gray-300 mx-1" />
            <button
              onClick={printMeisai}
              disabled={displayRows.length === 0}
              title="対象者の介護給付費明細書 (様式第二) を印刷。印刷で発行済になります"
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
            >
              <FileText size={13} />明細書 ({targets.length}件)
            </button>
            <button
              onClick={printSeikyu}
              disabled={displayRows.length === 0}
              title="事業所単位の総括請求書 (様式第一) を印刷"
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Printer size={13} />請求書
            </button>
            <button
              onClick={markKokuhoTarget}
              disabled={displayRows.length === 0}
              title="発行済の利用者を国保連請求の対象にする"
              className="border border-blue-500 rounded bg-blue-100 px-2.5 py-1 text-blue-800 font-semibold hover:bg-blue-200 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Landmark size={13} />国保対象
            </button>
            <button
              onClick={selectUnissued}
              disabled={displayRows.length === 0}
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              未発行のみ
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={exportCsv}
                disabled={displayRows.length === 0}
                title="明細一覧を Excel 閲覧用 CSV で出力"
                className="border border-indigo-500 rounded bg-indigo-500 px-3 py-1 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1.5 disabled:opacity-50"
              >
                <Download size={13} />確認用CSV
              </button>
            </div>
          </div>

          {/* 月遅れ/返戻の再請求 案内 */}
          {!loading && reRows.length > 0 && (
            <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>
                過去月の月遅れ・返戻 {reRows.length} 件を当月請求に合流しています
                (元提供月で明細書・伝送に反映)。国保対象化すると一覧から外れます。
              </span>
            </div>
          )}

          {error && (
            <div className="border-b border-red-200 bg-red-50 px-3 py-2 shrink-0 flex items-start gap-2 text-sm text-red-700">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 size={22} className="animate-spin text-indigo-400" />
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto">
                {/* ヘッダー行: 対象 / 申請中 / 状態 / 提出月 / 請求月 / 被保険者番号 / 利用者名 / 月遅 / 返戻 / 過誤 */}
                <div className={`${GRID_COLS} border-b border-gray-300 bg-gray-100 text-xs font-semibold text-gray-600 sticky top-0 z-10`}>
                  <div className="px-1 py-2 flex items-center justify-center">
                    <button
                      onClick={toggleAll}
                      className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                        allChecked ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                      }`}
                    >
                      {allChecked && (
                        <span className="text-white text-[8px] font-bold leading-none">✓</span>
                      )}
                    </button>
                  </div>
                  <div className="px-2 py-2 border-l border-gray-200 text-center">申請中</div>
                  <div className="px-2 py-2 border-l border-gray-200">状態</div>
                  <div className="px-2 py-2 border-l border-gray-200">提出月</div>
                  <div className="px-2 py-2 border-l border-gray-200">請求月</div>
                  <div className="px-2 py-2 border-l border-gray-200">被保険者番号</div>
                  <div className="px-2 py-2 border-l border-gray-200">利用者名</div>
                  <div className="px-2 py-2 border-l border-gray-200 text-center">月遅</div>
                  <div className="px-2 py-2 border-l border-gray-200 text-center">返戻</div>
                  <div className="px-2 py-2 border-l border-gray-200 text-center">過誤</div>
                </div>

                {displayRows.length === 0 ? (
                  <p className="text-gray-400 text-center py-10">
                    対象月の実績 (完了) がありません。サービス提供表で実績を確定してください。
                  </p>
                ) : displayRows.map((d, idx) => {
                  const r = d.row;
                  // 当月行のみ status を突合 (再請求行は過去月レコードなので理由表示で代替)
                  const st = d.isReSeikyu ? undefined : statusByClient.get(r.user_id);
                  const isDetail = selectedKey === d.key;
                  const isChecked = checked.has(d.key);
                  const [oy, om] = d.origMonthKey.split("-").map((n) => Number(n));
                  return (
                    <div
                      key={d.key}
                      onClick={() => setSelectedKey(isDetail ? null : d.key)}
                      className={`${GRID_COLS} border-b border-gray-100 text-xs cursor-pointer transition-colors ${
                        isDetail
                          ? "bg-blue-100"
                          : d.isReSeikyu
                          ? "bg-amber-50"
                          : isChecked
                          ? "bg-indigo-50"
                          : idx % 2 === 0
                          ? "bg-white hover:bg-gray-50"
                          : "bg-gray-50/50 hover:bg-gray-100"
                      }`}
                    >
                      <div className="px-1 py-2 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => toggle(d.key)}
                          className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                            isChecked ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                          }`}
                        >
                          {isChecked && <span className="text-white text-[8px] font-bold leading-none">✓</span>}
                        </button>
                      </div>
                      {/* 申請中: kaigo 側にデータなし → 空欄 (枠だけ揃える) */}
                      <div className="px-1 py-2 border-l border-gray-100 text-center" />
                      <div className="px-2 py-2 border-l border-gray-100">
                        {d.isReSeikyu ? (
                          <span className="text-amber-700 font-medium">再請求</span>
                        ) : st?.kokuho_target ? (
                          <span className="text-red-600 font-semibold">国保対象</span>
                        ) : st?.issued_at ? (
                          <span className="text-emerald-600 font-semibold">発行済</span>
                        ) : (
                          <span className="text-gray-400">未発行</span>
                        )}
                      </div>
                      {/* 提出月 = 提供月 (再請求は元提供月) / 請求月 = 当月 */}
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-500">
                        R{oy - 2018}/{om}
                      </div>
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-500">
                        R{year - 2018}/{month}
                      </div>
                      <div className="px-2 py-2 border-l border-gray-100 font-mono text-gray-700">
                        {r.insured_number ?? "—"}
                      </div>
                      <div className="px-2 py-2 border-l border-gray-100 font-medium text-gray-800 flex items-center gap-1.5 min-w-0">
                        <span className="flex-1 truncate">{r.user_name}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); printMeisaiFor([d]); }}
                          title="この利用者の明細書 (様式第二) を印刷"
                          className="shrink-0 text-[10px] border border-gray-300 rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                        >明細書</button>
                      </div>
                      {/* 月遅 / 返戻 / 過誤 — 当月行は操作可、再請求行は理由の読取専用表示 */}
                      <div className="px-1 py-2 border-l border-gray-100 text-center" onClick={(e) => e.stopPropagation()}>
                        {d.isReSeikyu ? (
                          d.reasons?.tsukiokure && (
                            <span className="text-yellow-700 text-[11px] font-semibold">月遅</span>
                          )
                        ) : (
                          <select
                            value={st?.tsukiokure ? "月遅" : ""}
                            onChange={(e) => setFlag(r.user_id, "tsukiokure", e.target.value === "月遅")}
                            title="月遅れ"
                            className={`w-full text-[11px] border rounded px-0.5 py-0.5 bg-white ${st?.tsukiokure ? "border-yellow-400 text-yellow-700 font-semibold" : "border-gray-300 text-gray-500"}`}
                          >
                            <option value=""></option>
                            <option value="月遅">月遅</option>
                          </select>
                        )}
                      </div>
                      <div className="px-1 py-2 border-l border-gray-100 text-center" onClick={(e) => e.stopPropagation()}>
                        {d.isReSeikyu ? (
                          d.reasons?.henrei && (
                            <span className="text-red-500 text-[11px] font-semibold">返戻</span>
                          )
                        ) : (
                          <select
                            value={st?.henrei ? "返戻" : ""}
                            onChange={(e) => setFlag(r.user_id, "henrei", e.target.value === "返戻")}
                            className={`w-full text-[11px] border rounded px-1 py-0.5 bg-white ${st?.henrei ? "border-red-400 text-red-600 font-semibold" : "border-gray-300 text-gray-500"}`}
                          >
                            <option value=""></option>
                            <option value="返戻">返戻</option>
                          </select>
                        )}
                      </div>
                      <div
                        className="px-1 py-2 border-l border-gray-100 text-center"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!d.isReSeikyu) setFlag(r.user_id, "kago", !st?.kago);
                        }}
                      >
                        {!d.isReSeikyu && (
                          <span
                            className={`inline-flex w-5 h-5 rounded-full border-2 items-center justify-center text-[10px] font-bold cursor-pointer transition-colors ${
                              st?.kago ? "border-red-500 bg-red-500 text-white" : "border-gray-300 text-transparent hover:border-red-300"
                            }`}
                            title="過誤"
                          >○</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ── フッター合計 (order-app の box レイアウト) ── */}
              <div className="border-t border-gray-300 bg-gray-50 px-3 py-2 shrink-0 text-[11px] text-gray-700">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mb-1.5">
                  <span>合計件数 <strong className="font-mono">{filteredRows.length.toLocaleString()}</strong></span>
                  <span>合計単位数 <strong className="font-mono">{totalUnits.toLocaleString()}</strong></span>
                  <span>国保件数 <strong className="font-mono">{kokuhoCount.toLocaleString()}</strong></span>
                  <span>実績 <strong className="font-mono">{recordCount.toLocaleString()}</strong> 件</span>
                  {reRows.length > 0 && (
                    <span>再請求 <strong className="font-mono">{reRows.length.toLocaleString()}</strong> 件</span>
                  )}
                </div>
                <div className="border border-gray-300 rounded bg-white px-2 py-1.5 grid grid-cols-3 gap-x-4 gap-y-1">
                  <span>特定介護請求額 <strong className="font-mono">—</strong></span>
                  <span>軽減額 <strong className="font-mono">—</strong></span>
                  <span>保険単位数 <strong className="font-mono">{totalUnits.toLocaleString()}</strong></span>
                  <span>公費単位数 <strong className="font-mono">{totalKohiUnits > 0 ? totalKohiUnits.toLocaleString() : "—"}</strong></span>
                  <span>保険請求額 <strong className="font-mono">{totalInsurance.toLocaleString()}</strong></span>
                  <span>公費請求額 <strong className="font-mono">{totalKohiAmount > 0 ? totalKohiAmount.toLocaleString() : "—"}</strong></span>
                  <span>利用者負担額 <strong className="font-mono text-red-600">{totalUser.toLocaleString()}</strong></span>
                  <span>公費分本人負担 <strong className="font-mono">—</strong></span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── 右：明細情報 ── */}
        <div className="w-80 shrink-0 flex flex-col bg-white">
          <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 text-xs font-bold text-gray-700 flex items-center gap-2">
            <span>明細情報</span>
            {selected && <span className="font-normal text-gray-500 truncate">{selected.user_name}</span>}
          </div>
          {selected ? (
            <>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-[11px] border-collapse">
                  <thead className="bg-gray-100 border-b border-gray-300 sticky top-0">
                    <tr>
                      <th className="text-left px-1.5 py-1.5 font-semibold text-gray-600 border-r border-gray-200">サービス内容</th>
                      <th className="text-right px-1.5 py-1.5 font-semibold text-gray-600 border-r border-gray-200 w-12">単位数</th>
                      <th className="text-right px-1.5 py-1.5 font-semibold text-gray-600 border-r border-gray-200 w-10">回数</th>
                      <th className="text-right px-1.5 py-1.5 font-semibold text-gray-600 border-r border-gray-200 w-14">単位数小計</th>
                      <th className="text-left px-1.5 py-1.5 font-semibold text-gray-600 w-20">摘要</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.details.map((dt, i) => (
                      <tr key={dt.service_type} className={`border-b border-gray-100 ${i % 2 === 0 ? "bg-white" : "bg-gray-50"}`}>
                        <td className="px-1.5 py-1 text-gray-700 leading-tight border-r border-gray-100">
                          {dt.short_name ?? dt.service_type}
                        </td>
                        <td className="px-1.5 py-1 text-right font-mono text-gray-700 border-r border-gray-100">
                          {dt.unit_per.toLocaleString()}
                        </td>
                        <td className="px-1.5 py-1 text-right font-mono text-gray-700 border-r border-gray-100">
                          {dt.count}
                        </td>
                        <td className="px-1.5 py-1 text-right font-mono font-semibold text-gray-800 border-r border-gray-100">
                          {dt.units.toLocaleString()}
                        </td>
                        <td className="px-1.5 py-1 text-gray-500 text-[10px] font-mono truncate" title={dt.service_code ?? ""}>
                          {dt.service_code ?? "—"}
                        </td>
                      </tr>
                    ))}
                    {selected.addonUnits > 0 && (
                      <tr className="border-b border-gray-100 bg-white">
                        <td className="px-1.5 py-1 text-gray-700 leading-tight border-r border-gray-100">
                          {selected.addonLabel ?? "処遇改善加算"}
                        </td>
                        <td className="px-1.5 py-1 text-right font-mono text-gray-700 border-r border-gray-100">—</td>
                        <td className="px-1.5 py-1 text-right font-mono text-gray-700 border-r border-gray-100">1</td>
                        <td className="px-1.5 py-1 text-right font-mono font-semibold text-gray-800 border-r border-gray-100">
                          {selected.addonUnits.toLocaleString()}
                        </td>
                        <td className="px-1.5 py-1 text-gray-500 text-[10px] font-mono truncate">
                          {selected.addonCode ?? "—"}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-gray-300 bg-gray-50 shrink-0">
                <table className="w-full text-[11px] border-collapse">
                  <tbody>
                    <tr className="border-t border-gray-200">
                      <td className="px-2 py-1 text-gray-600 border-r border-gray-200 bg-gray-100 font-medium">保険単位数</td>
                      <td className="px-2 py-1 text-right font-mono font-semibold text-gray-800">{selected.totalUnits.toLocaleString()}</td>
                      <td className="px-2 py-1 text-gray-600 border-l border-gray-200 bg-gray-100 font-medium">公費単位数</td>
                      <td className="px-2 py-1 text-right font-mono text-gray-400">
                        {selected.kohiUnits != null ? <span className="text-gray-800 font-semibold">{selected.kohiUnits.toLocaleString()}</span> : "—"}
                      </td>
                    </tr>
                    <tr className="border-t border-gray-200">
                      <td className="px-2 py-1 text-gray-600 border-r border-gray-200 bg-gray-100 font-medium">保険請求額</td>
                      <td className="px-2 py-1 text-right font-mono font-semibold text-gray-800">{selected.insuranceAmount.toLocaleString()}</td>
                      <td className="px-2 py-1 text-gray-600 border-l border-gray-200 bg-gray-100 font-medium">公費請求額</td>
                      <td className="px-2 py-1 text-right font-mono text-gray-400">
                        {selected.kohiAmount != null ? <span className="text-gray-800 font-semibold">{selected.kohiAmount.toLocaleString()}</span> : "—"}
                      </td>
                    </tr>
                    <tr className="border-t border-gray-200">
                      <td className="px-2 py-1 text-gray-600 border-r border-gray-200 bg-gray-100 font-medium">利用者負担額</td>
                      <td className="px-2 py-1 text-right font-mono font-semibold text-red-600">
                        {selected.publicExpense ? "0" : selected.userAmount.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-gray-600 border-l border-gray-200 bg-gray-100 font-medium">公費本人負担</td>
                      <td className="px-2 py-1 text-right font-mono text-gray-400">{selected.publicExpense ? "0" : "—"}</td>
                    </tr>
                    <tr className="border-t border-gray-200">
                      <td className="px-2 py-1 text-gray-600 border-r border-gray-200 bg-gray-100 font-medium">総額</td>
                      <td className="px-2 py-1 text-right font-mono font-semibold text-gray-800">{selected.totalAmount.toLocaleString()}</td>
                      <td className="px-2 py-1 text-gray-600 border-l border-gray-200 bg-gray-100 font-medium">地域単価</td>
                      <td className="px-2 py-1 text-right font-mono text-gray-800">{selected.unitPrice.toFixed(2)}</td>
                    </tr>
                  </tbody>
                </table>
                {selected.publicExpense && (
                  <p className="px-2 py-1 text-[10px] text-purple-600">
                    公費: {selected.publicExpense} (本人負担分を公費請求へ振替)
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
              行を選択してください
            </div>
          )}
        </div>
      </div>

      {/* ===== 印刷 view: 明細書 (様式第二) — 利用者 1 名 = 1 枚 ===== */}
      {/* 再請求行は元提供月 (origMonthKey) で reiwa/month を出す */}
      {printMode === "meisai" && (
        <div className="hidden print:block">
          {(meisaiPrintRows ?? targetDisplayRows).map((d) => {
            const [oy, om] = d.origMonthKey.split("-").map((n) => Number(n));
            return (
              <MeisaiPrintSheet
                key={d.key}
                row={d.row}
                officeName={officeName}
                officeNumber={officeNumber}
                officeAddress={officeAddress}
                officePhone={officePhone}
                officePostal={officePostal}
                reiwa={oy - 2018}
                month={om}
              />
            );
          })}
        </div>
      )}

      {/* ===== 印刷 view: 請求書 (様式第一) — 事業所単位の総括 1 枚 ===== */}
      {/* 総括は当月の通常分のみ (再請求は元提供月の別請求書扱い) */}
      {printMode === "seikyu" && (
        <div className="hidden print:block">
          <SeikyuForm
            providerNumber={officeNumber ?? ""}
            officeName={officeName ?? ""}
            officeAddress={officeAddress ?? ""}
            officePhone={officePhone ?? ""}
            postalCode={officePostal ?? ""}
            billingMonth={monthKey}
            totalCount={seikyuTargets.length}
            totalUnits={targetUnits}
            totalAmount={targetCost}
            insuranceAmount={targetInsurance}
            userCopay={targetUser}
            kubunLabel={"居宅サービス・地域密着型\nサービス・介護予防サービス"}
          />
        </div>
      )}
    </>
  );
}
