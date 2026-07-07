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
 * ※ Phase 1: 画面・状態・フラグ・ボタン移設まで。月遅れ/返戻の再請求ロジックは対象外。
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

// kaigo_billing_status の 1 行 (利用者 × 月)
interface BillingStatusRow {
  client_id: string;
  issued_at: string | null;
  kokuho_target: boolean;
  tsukiokure: boolean;
  henrei: boolean;
  kago: boolean;
}

export function KaigoSeikyuContent() {
  const {
    year, month, onMonthChange, rows, recordCount, loading, error,
    officeName, officeNumber, officeAddress, officePhone, officePostal,
  } = useSeikyuData();
  const { currentOffice } = useBusinessType();
  const supabase = useMemo(() => createClient(), []);

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [statusByClient, setStatusByClient] = useState<Map<string, BillingStatusRow>>(new Map());
  const [printMode, setPrintMode] = useState<"meisai" | "seikyu" | null>(null);

  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const reiwa = year - 2018;

  const selected = rows.find((r) => r.user_id === selectedUserId) ?? rows[0] ?? null;

  const totalUnits = rows.reduce((s, r) => s + r.totalUnits, 0);
  const totalInsurance = rows.reduce((s, r) => s + r.insuranceAmount, 0);
  const totalUser = rows.reduce((s, r) => s + r.userAmount, 0);

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

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setChecked((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.user_id)),
    );
  const selectUnissued = () =>
    setChecked(
      new Set(
        rows
          .filter((r) => !statusByClient.get(r.user_id)?.issued_at)
          .map((r) => r.user_id),
      ),
    );

  // 対象: チェックあり → その利用者 / チェックなし → 全件
  const targets = useMemo(
    () => (checked.size > 0 ? rows.filter((r) => checked.has(r.user_id)) : rows),
    [rows, checked],
  );

  // 集計 (請求書用)
  const targetUnits = targets.reduce((s, r) => s + r.totalUnits, 0);
  const targetCost = targets.reduce((s, r) => s + r.totalAmount, 0);
  const targetInsurance = targets.reduce((s, r) => s + r.insuranceAmount, 0);
  const targetUser = targets.reduce((s, r) => s + r.userAmount, 0);

  // ── 明細書: 対象者の様式第二を印刷 → 印刷実行時に issued_at を now() で upsert (発行済化) ──
  const printMeisai = async () => {
    if (targets.length === 0) return;
    const now = new Date().toISOString();
    const payload = targets.map((r) => {
      const cur = statusByClient.get(r.user_id);
      return {
        client_id: r.user_id,
        target_month: monthKey,
        tenant_id: currentOffice?.tenant_id ?? "kt-group",
        office_id: currentOffice?.id ?? null,
        issued_at: now,
        // 既存フラグを保持
        kokuho_target: cur?.kokuho_target ?? false,
        tsukiokure: cur?.tsukiokure ?? false,
        henrei: cur?.henrei ?? false,
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

  // ── 国保対象: 選択した「発行済」の行を kokuho_target=true に upsert (未発行はスキップ) ──
  const markKokuhoTarget = async () => {
    const issued = targets.filter((r) => statusByClient.get(r.user_id)?.issued_at);
    const skipped = targets.length - issued.length;
    if (issued.length === 0) {
      toast.warning("国保対象にできる「発行済」の利用者がありません (先に明細書を発行してください)");
      return;
    }
    const payload = issued.map((r) => {
      const cur = statusByClient.get(r.user_id)!;
      return {
        client_id: r.user_id,
        target_month: monthKey,
        tenant_id: currentOffice?.tenant_id ?? "kt-group",
        office_id: currentOffice?.id ?? null,
        issued_at: cur.issued_at,
        kokuho_target: true,
        tsukiokure: cur.tsukiokure,
        henrei: cur.henrei,
        kago: cur.kago,
      };
    });
    const { error: e } = await supabase
      .from("kaigo_billing_status")
      .upsert(payload, { onConflict: "client_id,target_month" });
    if (e) {
      toast.error("国保対象の保存に失敗: " + e.message);
      return;
    }
    toast.success(
      `${issued.length} 名を国保対象にしました${skipped > 0 ? ` (未発行 ${skipped} 名はスキップ)` : ""}`,
    );
    loadStatus();
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
    for (const r of targets) {
      const st = statusByClient.get(r.user_id);
      const state = st?.kokuho_target ? "国保対象" : st?.issued_at ? "発行済" : "未発行";
      lines.push(
        [
          ym,
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

      {/* 操作ボタン (印刷時非表示) */}
      {!loading && rows.length > 0 && (
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
              {checked.size === rows.length && rows.length > 0 ? "全解除" : "全選択"}
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
      ) : rows.length === 0 ? (
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
                        checked={checked.size === rows.length && rows.length > 0}
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
                  {rows.map((r) => {
                    const st = statusByClient.get(r.user_id);
                    return (
                      <tr
                        key={r.user_id}
                        onClick={() => setSelectedUserId(r.user_id)}
                        className={
                          "cursor-pointer transition-colors " +
                          (selected?.user_id === r.user_id
                            ? "bg-blue-50"
                            : "hover:bg-gray-50")
                        }
                      >
                        <td
                          className="px-2 py-2 text-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={checked.has(r.user_id)}
                            onChange={() => toggle(r.user_id)}
                            className="h-3.5 w-3.5 accent-blue-600 cursor-pointer"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <StatusBadge status={st} />
                        </td>
                        <td className="px-3 py-2 font-medium">{r.user_name}</td>
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
                        <td
                          className="px-2 py-2 text-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={st?.tsukiokure ?? false}
                            onChange={(e) => setFlag(r.user_id, "tsukiokure", e.target.checked)}
                            className="h-3.5 w-3.5 accent-amber-600 cursor-pointer"
                          />
                        </td>
                        <td
                          className="px-2 py-2 text-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={st?.henrei ?? false}
                            onChange={(e) => setFlag(r.user_id, "henrei", e.target.checked)}
                            className="h-3.5 w-3.5 accent-red-600 cursor-pointer"
                          />
                        </td>
                        <td
                          className="px-2 py-2 text-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={st?.kago ?? false}
                            onChange={(e) => setFlag(r.user_id, "kago", e.target.checked)}
                            className="h-3.5 w-3.5 accent-purple-600 cursor-pointer"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                  <tr>
                    <td className="px-3 py-2 text-xs text-gray-500" colSpan={4}>
                      合計 {rows.length} 名 / 実績 {recordCount} 件
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
      {printMode === "meisai" && (
        <div className="hidden print:block">
          {targets.map((r) => (
            <MeisaiPrintSheet
              key={r.user_id}
              row={r}
              officeName={officeName}
              officeNumber={officeNumber}
              officeAddress={officeAddress}
              officePhone={officePhone}
              officePostal={officePostal}
              reiwa={reiwa}
              month={month}
            />
          ))}
        </div>
      )}

      {/* ===== 印刷 view: 請求書 (様式第一) — 事業所単位の総括 1 枚 ===== */}
      {printMode === "seikyu" && (
        <div className="hidden print:block">
          <SeikyuForm
            providerNumber={officeNumber ?? ""}
            officeName={officeName ?? ""}
            officeAddress={officeAddress ?? ""}
            officePhone={officePhone ?? ""}
            postalCode={officePostal ?? ""}
            billingMonth={monthKey}
            totalCount={targets.length}
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
