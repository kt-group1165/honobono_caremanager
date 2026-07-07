"use client";

/**
 * 介護請求 — 利用者ごとの月次請求管理 (参考: ほのぼの 介護請求タブ)
 *
 * 1 画面で:
 *   - 行チェック + 状態バッジ (未発行 / 発行済 / 国保対象)
 *   - 月遅れ / 返戻 / 過誤 フラグ (チェックで kaigo_billing_status に upsert)
 *   - 明細書 (様式第二) / 請求書 (様式第一 総括) / 国保対象 の各ボタン
 * 右: 選択利用者の 明細情報パネル
 *
 * ※ Phase 2: 月遅れ/返戻の再請求を実装。過去月の月遅れ/返戻 (未・国保対象) を
 *    元提供月で再集計し、当月一覧にバッジ付きで合流。明細書・伝送・国保対象化は
 *    各自の元提供月で反映する。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Calculator,
  AlertCircle,
  FileText,
  Printer,
  Landmark,
  Download,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { toast } from "sonner";
import { MonthNav } from "../_shared/month-nav";
import { useSeikyuData } from "../_shared/use-seikyu-data";
import { MeisaiPrintSheet } from "../../billing/forms/_meisai";
import { SeikyuForm } from "../../billing/forms/_seikyu";
import {
  loadReSeikyuRows,
  type ReSeikyuRow,
} from "@/lib/visit-seikyu/re-seikyu";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";

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
    year, month, onMonthChange, rows, recordCount, loading, error,
    officeName, officeNumber, officeAddress, officePhone, officePostal,
    officeId, tenantId, unitPrice, appliedFormulaCodes,
  } = useSeikyuData();
  const { currentOffice } = useBusinessType();
  const supabase = useMemo(() => createClient(), []);

  // 選択・チェックは (利用者 × 提供月) 単位。月遅れ/返戻で同一利用者が
  // 当月行 + 過去月行で二重に並ぶため、user_id 単体ではなく複合キーで持つ。
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [statusByClient, setStatusByClient] = useState<Map<string, BillingStatusRow>>(new Map());
  const [printMode, setPrintMode] = useState<"meisai" | "seikyu" | null>(null);
  // 月遅れ/返戻の再請求行 (過去月を元提供月で再集計したもの)
  const [reRows, setReRows] = useState<ReSeikyuRow[]>([]);

  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  // ── 表示用の統合行 (当月通常行 + 再請求行) ──
  // rowKey: 当月行は "cur:<user_id>" / 再請求行は "re:<user_id>:<origMonthKey>"
  const displayRows = useMemo<DisplayRow[]>(() => {
    const cur: DisplayRow[] = rows.map((r) => ({
      key: `cur:${r.user_id}`,
      row: r,
      origMonthKey: monthKey,
      isReSeikyu: false,
      reasons: null,
    }));
    const re: DisplayRow[] = reRows.map((r) => ({
      key: `re:${r.user_id}:${r.__origMonthKey}`,
      row: r,
      origMonthKey: r.__origMonthKey,
      isReSeikyu: true,
      reasons: r.__reasons,
    }));
    // 再請求 (過去分) を上、当月を下に並べる
    return [...re, ...cur];
  }, [rows, reRows, monthKey]);

  const selected =
    displayRows.find((d) => d.key === selectedKey)?.row ??
    displayRows[0]?.row ??
    null;

  // 合計は当月の通常行のみ (再請求分は元提供月の別集計なので当月合計には含めない)
  const totalUnits = rows.reduce((s, r) => s + r.totalUnits, 0);
  const totalInsurance = rows.reduce((s, r) => s + r.insuranceAmount, 0);
  const totalUser = rows.reduce((s, r) => s + r.userAmount, 0);

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
  const printMeisai = async () => {
    if (targetDisplayRows.length === 0) return;
    const now = new Date().toISOString();
    const payload = targetDisplayRows.map((d) => {
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
    setPrintMode("meisai");
    setTimeout(() => {
      window.print();
      setPrintMode(null);
    }, 100);
  };

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

  return (
    <div className="space-y-4">
      {/* 画面ヘッダ (印刷時非表示) */}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <Calculator size={20} className="text-blue-600" />
            介護請求
          </h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {officeName ?? ""} — 実績 (完了) ベースの月次請求。明細書・請求書の発行と請求状態の管理
          </p>
        </div>
        <MonthNav year={year} month={month} onChange={onMonthChange} />
      </div>

      {/* 月遅れ/返戻の再請求 案内 (印刷時非表示) */}
      {!loading && reRows.length > 0 && (
        <div className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 print:hidden">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>
            過去月の月遅れ・返戻 {reRows.length} 件を当月請求に合流しています
            (元提供月で明細書・伝送に反映)。国保対象化すると一覧から外れます。
          </span>
        </div>
      )}

      {/* 操作ボタン (印刷時非表示) */}
      {!loading && displayRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <button
            type="button"
            onClick={printMeisai}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            title="対象者の介護給付費明細書 (様式第二) を印刷。印刷で発行済になります"
          >
            <FileText size={14} />
            明細書 ({targets.length}件)
          </button>
          <button
            type="button"
            onClick={printSeikyu}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            title="事業所単位の総括請求書 (様式第一) を印刷"
          >
            <Printer size={14} />
            請求書
          </button>
          <button
            type="button"
            onClick={markKokuhoTarget}
            className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            title="発行済の利用者を国保連請求の対象にする"
          >
            <Landmark size={14} />
            国保対象
          </button>
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1 rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50"
            title="明細一覧を Excel 閲覧用 CSV で出力"
          >
            <Download size={14} />
            確認用CSV
          </button>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={toggleAll}
              className="rounded border border-gray-300 bg-white px-2.5 py-1 font-medium text-gray-600 hover:bg-gray-50"
            >
              {checked.size === displayRows.length && displayRows.length > 0
                ? "全解除"
                : "全選択"}
            </button>
            <button
              type="button"
              onClick={selectUnissued}
              className="rounded border border-gray-300 bg-white px-2.5 py-1 font-medium text-gray-600 hover:bg-gray-50"
            >
              未発行のみ
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 print:hidden">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400 print:hidden">
          <Loader2 size={20} className="mr-2 animate-spin" />
          集計中...
        </div>
      ) : displayRows.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-gray-50 p-12 text-center text-sm text-gray-500 print:hidden">
          対象月の実績 (完了) がありません。サービス提供表で実績を確定してください。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5 print:hidden">
          {/* 左: 利用者一覧 */}
          <div className="lg:col-span-3 rounded-lg border bg-white shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-blue-100 text-left text-xs font-medium text-blue-900">
                  <tr>
                    <th className="w-10 px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={
                          checked.size === displayRows.length &&
                          displayRows.length > 0
                        }
                        onChange={toggleAll}
                        className="h-3.5 w-3.5 accent-blue-600 cursor-pointer"
                      />
                    </th>
                    <th className="px-2 py-2">状態</th>
                    <th className="px-3 py-2">利用者名</th>
                    <th className="px-3 py-2">被保険者番号</th>
                    <th className="px-3 py-2">要介護度</th>
                    <th className="px-3 py-2 text-right">総単位数</th>
                    <th className="px-3 py-2 text-right">保険請求額</th>
                    <th className="px-3 py-2 text-right">利用者負担</th>
                    <th className="px-2 py-2 text-center">月遅れ</th>
                    <th className="px-2 py-2 text-center">返戻</th>
                    <th className="px-2 py-2 text-center">過誤</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {displayRows.map((d) => {
                    const r = d.row;
                    // 当月行のみ status を突合 (再請求行は過去月レコードなので理由バッジで代替)
                    const st = d.isReSeikyu
                      ? undefined
                      : statusByClient.get(r.user_id);
                    return (
                      <tr
                        key={d.key}
                        onClick={() => setSelectedKey(d.key)}
                        className={
                          "cursor-pointer transition-colors " +
                          (selectedKey === d.key
                            ? "bg-blue-50"
                            : d.isReSeikyu
                            ? "bg-amber-50/40 hover:bg-amber-50"
                            : "hover:bg-gray-50")
                        }
                      >
                        <td
                          className="px-2 py-2 text-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={checked.has(d.key)}
                            onChange={() => toggle(d.key)}
                            className="h-3.5 w-3.5 accent-blue-600 cursor-pointer"
                          />
                        </td>
                        <td className="px-2 py-2">
                          {d.isReSeikyu ? (
                            <ReSeikyuBadge reasons={d.reasons} />
                          ) : (
                            <StatusBadge status={st} />
                          )}
                        </td>
                        <td className="px-3 py-2 font-medium">
                          {r.user_name}
                          {d.isReSeikyu && (
                            <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-700">
                              元 {origMonthLabel(d.origMonthKey)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {r.insured_number ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-xs">{r.care_level ?? "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.totalUnits.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-blue-700">
                          {r.insuranceAmount.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                          {r.userAmount.toLocaleString()}
                        </td>
                        {/* 月遅れ / 返戻 / 過誤 — 当月行はチェックで upsert、再請求行は読取専用表示 */}
                        <td
                          className="px-2 py-2 text-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={
                              d.isReSeikyu
                                ? d.reasons?.tsukiokure ?? false
                                : st?.tsukiokure ?? false
                            }
                            disabled={d.isReSeikyu}
                            onChange={(e) =>
                              setFlag(r.user_id, "tsukiokure", e.target.checked)
                            }
                            className="h-3.5 w-3.5 accent-amber-600 cursor-pointer disabled:cursor-default disabled:opacity-60"
                          />
                        </td>
                        <td
                          className="px-2 py-2 text-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={
                              d.isReSeikyu
                                ? d.reasons?.henrei ?? false
                                : st?.henrei ?? false
                            }
                            disabled={d.isReSeikyu}
                            onChange={(e) =>
                              setFlag(r.user_id, "henrei", e.target.checked)
                            }
                            className="h-3.5 w-3.5 accent-red-600 cursor-pointer disabled:cursor-default disabled:opacity-60"
                          />
                        </td>
                        <td
                          className="px-2 py-2 text-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={d.isReSeikyu ? false : st?.kago ?? false}
                            disabled={d.isReSeikyu}
                            onChange={(e) =>
                              setFlag(r.user_id, "kago", e.target.checked)
                            }
                            className="h-3.5 w-3.5 accent-purple-600 cursor-pointer disabled:cursor-default disabled:opacity-60"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                  <tr>
                    <td className="px-3 py-2 text-xs text-gray-500" colSpan={4}>
                      当月 {rows.length} 名 / 実績 {recordCount} 件
                      {reRows.length > 0 && ` + 再請求 ${reRows.length} 件`}
                    </td>
                    <td></td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {totalUnits.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-blue-700">
                      {totalInsurance.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {totalUser.toLocaleString()}
                    </td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* 右: 明細情報 */}
          <div className="lg:col-span-2 rounded-lg border bg-white shadow-sm">
            <header className="border-b bg-blue-100 px-4 py-2 text-sm font-bold text-blue-900">
              明細情報 {selected ? `— ${selected.user_name}` : ""}
            </header>
            {selected ? (
              <div className="p-3">
                <table className="min-w-full text-xs">
                  <thead className="bg-blue-50 text-left text-[10px] font-medium text-blue-900">
                    <tr>
                      <th className="rounded-l px-2 py-1.5">サービス内容</th>
                      <th className="px-2 py-1.5 text-right">単位数/単価</th>
                      <th className="px-2 py-1.5 text-right">回数</th>
                      <th className="rounded-r px-2 py-1.5 text-right">単位数</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {selected.details.map((d) => (
                      <tr key={d.service_type}>
                        <td className="px-2 py-1.5">
                          {d.short_name ?? d.service_type}
                          {d.short_name && (
                            <span className="ml-1 text-[9px] text-gray-400">
                              {d.service_type}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {d.unit_per.toLocaleString()}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {d.count}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-semibold">
                          {d.units.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                    {selected.addonUnits > 0 && (
                      <tr className="text-purple-700">
                        <td className="px-2 py-1.5">
                          {selected.addonLabel ?? "処遇改善加算"}
                        </td>
                        <td className="px-2 py-1.5 text-right">—</td>
                        <td className="px-2 py-1.5 text-right">1</td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-semibold">
                          {selected.addonUnits.toLocaleString()}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {/* 金額サマリ (ほのぼの 請求画面の右下ボックス準拠) */}
                <div className="mt-4 rounded border bg-gray-50 p-3 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-gray-500">地域単価</span>
                    <span className="tabular-nums">{selected.unitPrice.toFixed(2)} 円/単位</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">総額</span>
                    <span className="tabular-nums">
                      ¥{selected.totalAmount.toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1 border-t pt-2">
                    <SummaryCell label="特定介護請求額" value="" />
                    <SummaryCell label="軽減額" value="" />
                    <SummaryCell label="保険単位数" value={selected.totalUnits.toLocaleString()} />
                    <SummaryCell
                      label="公費単位数"
                      value={selected.kohiUnits != null ? selected.kohiUnits.toLocaleString() : ""}
                    />
                    <SummaryCell
                      label={`保険請求額 (${Math.round((1 - selected.copay_rate) * 100)}%)`}
                      value={`¥${selected.insuranceAmount.toLocaleString()}`}
                      emphasis="blue"
                    />
                    <SummaryCell
                      label="公費請求額"
                      value={selected.kohiAmount != null ? `¥${selected.kohiAmount.toLocaleString()}` : ""}
                      emphasis={selected.kohiAmount != null ? "purple" : undefined}
                    />
                    <SummaryCell
                      label={`利用者負担額 (${Math.round(selected.copay_rate * 10)}割)`}
                      value={selected.publicExpense ? "" : `¥${selected.userAmount.toLocaleString()}`}
                    />
                    <SummaryCell
                      label="公費分本人負担"
                      value={selected.publicExpense ? "¥0" : ""}
                    />
                  </div>
                  {selected.publicExpense && (
                    <p className="pt-1 text-[10px] text-purple-600">
                      公費: {selected.publicExpense} (本人負担分を公費請求へ振替)
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-gray-400">
                左の一覧から利用者を選択
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== 印刷 view: 明細書 (様式第二) — 利用者 1 名 = 1 枚 ===== */}
      {/* 再請求行は元提供月 (origMonthKey) で reiwa/month を出す */}
      {printMode === "meisai" && (
        <div className="hidden print:block">
          {targetDisplayRows.map((d) => {
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
    </div>
  );
}

// 提供月 (YYYY-MM) → "R{年}/{月}" ラベル (令和換算)
function origMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map((n) => Number(n));
  if (!y || !m) return monthKey;
  return `R${y - 2018}/${m}`;
}

// 再請求バッジ (月遅れ / 返戻)。両方立つ場合は併記
function ReSeikyuBadge({
  reasons,
}: {
  reasons: { tsukiokure: boolean; henrei: boolean } | null;
}) {
  if (reasons?.henrei) {
    return (
      <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
        返戻{reasons.tsukiokure ? "・月遅れ" : ""}
      </span>
    );
  }
  return (
    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
      月遅れ
    </span>
  );
}

// 状態バッジ (未発行 / 発行済 / 国保対象)
function StatusBadge({ status }: { status: BillingStatusRow | undefined }) {
  if (status?.kokuho_target) {
    return (
      <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">
        国保対象
      </span>
    );
  }
  if (status?.issued_at) {
    return (
      <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-bold text-green-700">
        発行済
      </span>
    );
  }
  return (
    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold text-gray-500">
      未発行
    </span>
  );
}

// ほのぼの風 請求サマリの 1 セル (ラベル + 右寄せ数値。空文字 = 該当なし)
function SummaryCell({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: "blue" | "purple";
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 rounded border border-blue-100 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-900 whitespace-nowrap">
        {label}
      </span>
      <span
        className={
          emphasis === "blue"
            ? "font-bold tabular-nums text-blue-700"
            : emphasis === "purple"
            ? "font-bold tabular-nums text-purple-700"
            : "font-bold tabular-nums text-gray-800"
        }
      >
        {value || <span className="text-gray-300 font-normal">—</span>}
      </span>
    </div>
  );
}
