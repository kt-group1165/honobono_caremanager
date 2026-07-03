"use client";

/**
 * 国保請求 — 国保連請求の集計 + 明細書・請求書 発行 (参考: ほのぼの 国保請求タブ)
 *
 * 構成:
 *  上段: 介護給付費明細書 (様式2 相当) の一覧 — 利用者 × 保険請求額
 *  下段: 集計サマリ (件数 / 単位数 / 保険請求額)
 *  印刷: 明細書 (利用者ごと) / 請求書 (事業所単位の総括) を印刷 view で発行
 */

import { useMemo, useState } from "react";
import {
  Loader2,
  Landmark,
  AlertCircle,
  Printer,
  FileText,
  Download,
} from "lucide-react";
import { MonthNav } from "../_shared/month-nav";
import { useSeikyuData } from "../_shared/use-seikyu-data";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";

export function KokuhoSeikyuContent() {
  const { year, month, onMonthChange, rows, loading, error, officeName } =
    useSeikyuData();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [printMode, setPrintMode] = useState<"meisai" | "seikyu" | null>(null);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setChecked((prev) =>
      prev.size === rows.length
        ? new Set()
        : new Set(rows.map((r) => r.user_id)),
    );

  const targets = useMemo(
    () => (checked.size > 0 ? rows.filter((r) => checked.has(r.user_id)) : rows),
    [rows, checked],
  );

  const totalUnits = targets.reduce((s, r) => s + r.totalUnits, 0);
  const totalInsurance = targets.reduce((s, r) => s + r.insuranceAmount, 0);
  const totalUser = targets.reduce((s, r) => s + r.userAmount, 0);

  const reiwa = year - 2018;

  const doPrint = (mode: "meisai" | "seikyu") => {
    setPrintMode(mode);
    // print CSS 適用後に印刷 dialog
    setTimeout(() => {
      window.print();
      setPrintMode(null);
    }, 100);
  };

  // 国保連伝送用 CSV (様式2 相当の明細行)。
  // 完全な interface 仕様 (固定長/複数レコード種別) は伝送ソフト側の取込仕様
  // 確定後に対応。まずは項目網羅の明細 CSV を出す。
  const exportCsv = () => {
    const ym = `${year}${String(month).padStart(2, "0")}`;
    const header = [
      "提供年月",
      "保険者番号",
      "被保険者番号",
      "利用者名",
      "要介護度",
      "サービス内容",
      "サービス単位数",
      "回数",
      "小計単位数",
      "合計単位数",
      "保険請求額",
      "利用者負担額",
    ];
    const lines: string[] = [header.join(",")];
    for (const r of targets) {
      for (const d of r.details) {
        lines.push(
          [
            ym,
            r.insurer_number ?? "",
            r.insured_number ?? "",
            `"${r.user_name}"`,
            r.care_level ?? "",
            `"${d.service_type}"`,
            d.unit_per,
            d.count,
            d.units,
            r.totalUnits,
            r.insuranceAmount,
            r.userAmount,
          ].join(","),
        );
      }
      if (r.addonUnits > 0) {
        lines.push(
          [
            ym,
            r.insurer_number ?? "",
            r.insured_number ?? "",
            `"${r.user_name}"`,
            r.care_level ?? "",
            `"${r.addonLabel ?? "処遇改善加算"}"`,
            "",
            1,
            r.addonUnits,
            r.totalUnits,
            r.insuranceAmount,
            r.userAmount,
          ].join(","),
        );
      }
    }
    // Excel 互換のため BOM 付き UTF-8
    const blob = new Blob(["﻿" + lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kokuho_seikyu_${ym}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-4">
      {/* 画面ヘッダ (印刷時非表示) */}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <Landmark size={20} className="text-indigo-600" />
            国保請求
          </h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {officeName ?? ""} — 国保連への介護給付費請求の集計と、明細書・請求書の発行
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MonthNav year={year} month={month} onChange={onMonthChange} />
          <button
            type="button"
            disabled={rows.length === 0}
            onClick={() => doPrint("meisai")}
            className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <FileText size={14} />
            明細書
          </button>
          <button
            type="button"
            disabled={rows.length === 0}
            onClick={() => doPrint("seikyu")}
            className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Printer size={14} />
            請求書
          </button>
          <button
            type="button"
            disabled={rows.length === 0}
            onClick={exportCsv}
            className="inline-flex items-center gap-1 rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
            title="国保連伝送用の明細 CSV を出力"
          >
            <Download size={14} />
            伝送CSV
          </button>
        </div>
      </div>

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
          対象月の実績 (完了) がありません
        </div>
      ) : (
        <>
          {/* 明細一覧 (画面) */}
          <div className="overflow-hidden rounded-lg border bg-white shadow-sm print:hidden">
            <div className="border-b bg-indigo-50 px-4 py-2 text-sm font-bold text-indigo-800">
              介護給付費明細書 (様式第2) — {targets.length} 件
            </div>
            <table className="min-w-full text-sm">
              <thead className="bg-blue-100 text-left text-xs font-medium text-blue-900">
                <tr>
                  <th className="w-14 px-2 py-1.5 text-center">
                    <label className="inline-flex cursor-pointer select-none flex-col items-center gap-0.5">
                      <input
                        type="checkbox"
                        checked={checked.size === rows.length && rows.length > 0}
                        onChange={toggleAll}
                        className="h-3.5 w-3.5 accent-blue-600 cursor-pointer"
                      />
                      <span className="whitespace-nowrap text-[9px] font-normal text-blue-700">
                        全選択
                      </span>
                    </label>
                  </th>
                  <th className="px-3 py-2">提供年月</th>
                  <th className="px-3 py-2">保険者番号</th>
                  <th className="px-3 py-2">被保険者番号</th>
                  <th className="px-3 py-2">利用者名</th>
                  <th className="px-3 py-2">要介護度</th>
                  <th className="px-3 py-2 text-right">単位数</th>
                  <th className="px-3 py-2 text-right">保険請求額</th>
                  <th className="px-3 py-2 text-right">利用者負担</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.user_id} className="hover:bg-gray-50">
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={checked.has(r.user_id)}
                        onChange={() => toggle(r.user_id)}
                      />
                    </td>
                    <td className="px-3 py-2 text-xs">
                      R{reiwa}/{month}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.insurer_number ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.insured_number ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-medium">{r.user_name}</td>
                    <td className="px-3 py-2 text-xs">{r.care_level ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.totalUnits.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-indigo-700 font-semibold">
                      {r.insuranceAmount.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.userAmount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 集計サマリ (画面) */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 print:hidden">
            <SummaryCard label="合計件数" value={`${targets.length} 件`} />
            <SummaryCard label="合計単位数" value={totalUnits.toLocaleString()} />
            <SummaryCard
              label="保険請求額"
              value={`¥${totalInsurance.toLocaleString()}`}
              accent="text-indigo-700"
            />
            <SummaryCard
              label="利用者負担額"
              value={`¥${totalUser.toLocaleString()}`}
            />
          </div>
          <p className="text-[11px] text-gray-400 print:hidden">
            ※ チェックで発行対象を絞込 (未チェック時は全件)。「伝送CSV」は明細 CSV 形式
            (国保連の固定長 interface 仕様には伝送ソフトの取込仕様確定後に対応)。
          </p>

          {/* ===== 印刷 view ===== */}
          {printMode === "meisai" && (
            <div className="hidden print:block">
              {targets.map((r) => (
                <MeisaiPrintSheet
                  key={r.user_id}
                  row={r}
                  officeName={officeName}
                  reiwa={reiwa}
                  month={month}
                />
              ))}
            </div>
          )}
          {printMode === "seikyu" && (
            <div className="hidden print:block">
              <SeikyuPrintSheet
                rows={targets}
                officeName={officeName}
                reiwa={reiwa}
                month={month}
                totalUnits={totalUnits}
                totalInsurance={totalInsurance}
                totalUser={totalUser}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border bg-white p-3 shadow-sm">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`mt-1 text-lg font-bold tabular-nums ${accent ?? "text-gray-900"}`}>
        {value}
      </div>
    </div>
  );
}

// ─── 印刷: 介護給付費明細書 (利用者 1 名 = 1 枚) ─────────────────────────────

function MeisaiPrintSheet({
  row,
  officeName,
  reiwa,
  month,
}: {
  row: UserSeikyuRow;
  officeName: string | null;
  reiwa: number;
  month: number;
}) {
  return (
    <div style={{ pageBreakAfter: "always", padding: "10mm", fontSize: "10pt" }}>
      <h2 style={{ textAlign: "center", fontSize: "14pt", fontWeight: "bold" }}>
        介護給付費明細書 (訪問介護)
      </h2>
      <p style={{ textAlign: "right" }}>
        令和{reiwa}年{month}月分
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "4mm" }}>
        <tbody>
          <tr>
            <Th>保険者番号</Th>
            <Td>{row.insurer_number ?? ""}</Td>
            <Th>被保険者番号</Th>
            <Td>{row.insured_number ?? ""}</Td>
          </tr>
          <tr>
            <Th>利用者名</Th>
            <Td>{row.user_name}</Td>
            <Th>要介護度</Th>
            <Td>{row.care_level ?? ""}</Td>
          </tr>
          <tr>
            <Th>事業所</Th>
            <Td colSpan={3}>{officeName ?? ""}</Td>
          </tr>
        </tbody>
      </table>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "6mm" }}>
        <thead>
          <tr>
            <Th>サービス内容</Th>
            <Th style={{ textAlign: "right" }}>単位数/単価</Th>
            <Th style={{ textAlign: "right" }}>回数</Th>
            <Th style={{ textAlign: "right" }}>単位数</Th>
          </tr>
        </thead>
        <tbody>
          {row.details.map((d) => (
            <tr key={d.service_type}>
              <Td>{d.service_type}</Td>
              <Td style={{ textAlign: "right" }}>{d.unit_per.toLocaleString()}</Td>
              <Td style={{ textAlign: "right" }}>{d.count}</Td>
              <Td style={{ textAlign: "right" }}>{d.units.toLocaleString()}</Td>
            </tr>
          ))}
          {row.addonUnits > 0 && (
            <tr>
              <Td>{row.addonLabel ?? "処遇改善加算"}</Td>
              <Td style={{ textAlign: "right" }}>—</Td>
              <Td style={{ textAlign: "right" }}>1</Td>
              <Td style={{ textAlign: "right" }}>{row.addonUnits.toLocaleString()}</Td>
            </tr>
          )}
          <tr style={{ fontWeight: "bold" }}>
            <Td colSpan={3}>合計単位数</Td>
            <Td style={{ textAlign: "right" }}>{row.totalUnits.toLocaleString()}</Td>
          </tr>
        </tbody>
      </table>

      <table style={{ width: "60%", borderCollapse: "collapse", marginTop: "6mm", marginLeft: "auto" }}>
        <tbody>
          <tr>
            <Th>総額</Th>
            <Td style={{ textAlign: "right" }}>¥{row.totalAmount.toLocaleString()}</Td>
          </tr>
          <tr>
            <Th>保険請求額</Th>
            <Td style={{ textAlign: "right", fontWeight: "bold" }}>
              ¥{row.insuranceAmount.toLocaleString()}
            </Td>
          </tr>
          <tr>
            <Th>利用者負担額</Th>
            <Td style={{ textAlign: "right" }}>¥{row.userAmount.toLocaleString()}</Td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── 印刷: 介護給付費請求書 (事業所単位の総括 1 枚) ──────────────────────────

function SeikyuPrintSheet({
  rows,
  officeName,
  reiwa,
  month,
  totalUnits,
  totalInsurance,
  totalUser,
}: {
  rows: UserSeikyuRow[];
  officeName: string | null;
  reiwa: number;
  month: number;
  totalUnits: number;
  totalInsurance: number;
  totalUser: number;
}) {
  return (
    <div style={{ padding: "10mm", fontSize: "10pt" }}>
      <h2 style={{ textAlign: "center", fontSize: "14pt", fontWeight: "bold" }}>
        介護給付費請求書 (訪問介護)
      </h2>
      <p style={{ textAlign: "right" }}>
        令和{reiwa}年{month}月分
      </p>
      <p style={{ marginTop: "4mm" }}>事業所: {officeName ?? ""}</p>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "6mm" }}>
        <thead>
          <tr>
            <Th>被保険者番号</Th>
            <Th>利用者名</Th>
            <Th style={{ textAlign: "right" }}>単位数</Th>
            <Th style={{ textAlign: "right" }}>保険請求額</Th>
            <Th style={{ textAlign: "right" }}>利用者負担</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.user_id}>
              <Td>{r.insured_number ?? ""}</Td>
              <Td>{r.user_name}</Td>
              <Td style={{ textAlign: "right" }}>{r.totalUnits.toLocaleString()}</Td>
              <Td style={{ textAlign: "right" }}>{r.insuranceAmount.toLocaleString()}</Td>
              <Td style={{ textAlign: "right" }}>{r.userAmount.toLocaleString()}</Td>
            </tr>
          ))}
          <tr style={{ fontWeight: "bold" }}>
            <Td colSpan={2}>合計 ({rows.length} 件)</Td>
            <Td style={{ textAlign: "right" }}>{totalUnits.toLocaleString()}</Td>
            <Td style={{ textAlign: "right" }}>{totalInsurance.toLocaleString()}</Td>
            <Td style={{ textAlign: "right" }}>{totalUser.toLocaleString()}</Td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  style,
  colSpan,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  colSpan?: number;
}) {
  return (
    <th
      colSpan={colSpan}
      style={{
        border: "1px solid #000",
        padding: "2mm",
        background: "#f0f0f0",
        textAlign: "left",
        fontWeight: "normal",
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  style,
  colSpan,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      style={{ border: "1px solid #000", padding: "2mm", ...style }}
    >
      {children}
    </td>
  );
}
