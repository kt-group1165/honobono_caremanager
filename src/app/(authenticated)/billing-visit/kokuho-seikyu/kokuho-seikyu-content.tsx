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
  Send,
} from "lucide-react";
import Encoding from "encoding-japanese";
import { toast } from "sonner";
import { MonthNav } from "../_shared/month-nav";
import { useSeikyuData } from "../_shared/use-seikyu-data";
import { buildKokuhoDensou } from "@/lib/kokuho-densou/build";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import { SeikyuForm, type SeikyuKohiRow } from "../../billing/forms/_seikyu";

export function KokuhoSeikyuContent() {
  const {
    year, month, onMonthChange, rows, loading, error,
    officeName, officeNumber, officeAddress, officePhone, officePostal, unitPrice,
  } = useSeikyuData();
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
  const totalCost = targets.reduce((s, r) => s + r.totalAmount, 0);
  const totalInsurance = targets.reduce((s, r) => s + r.insuranceAmount, 0);
  const totalUser = targets.reduce((s, r) => s + r.userAmount, 0);
  const totalKohi = targets.reduce((s, r) => s + (r.kohiAmount ?? 0), 0);

  // 公費請求テーブル用: 法別番号ごとに集計 (生保 12 等)
  const kohiRows = useMemo<SeikyuKohiRow[]>(() => {
    const map = new Map<string, SeikyuKohiRow>();
    for (const r of targets) {
      if (!r.kohiHobetsu || !(r.kohiAmount ?? 0)) continue;
      const e = map.get(r.kohiHobetsu) ?? { code: r.kohiHobetsu, count: 0, units: 0, cost: 0, kohi: 0 };
      e.count += 1;
      e.units += r.totalUnits;
      e.cost += r.totalAmount;
      e.kohi += r.kohiAmount ?? 0;
      map.set(r.kohiHobetsu, e);
    }
    return [...map.values()];
  }, [targets]);

  const reiwa = year - 2018;

  const doPrint = (mode: "meisai" | "seikyu") => {
    setPrintMode(mode);
    // print CSS 適用後に印刷 dialog
    setTimeout(() => {
      window.print();
      setPrintMode(null);
    }, 100);
  };

  // 国保連伝送ファイル (正式インタフェース仕様: 7111 + 7131 / Shift_JIS)
  const exportDensou = () => {
    const result = buildKokuhoDensou(targets, {
      officeNumber: officeNumber ?? "",
      year,
      month,
      unitPrice,
    });
    if (result.warnings.length > 0) {
      const list = result.warnings.slice(0, 12).join("\n・");
      const ok = window.confirm(
        `以下の項目が不足しています (伝送ソフトの取込チェックでエラーになる可能性があります):\n\n・${list}${result.warnings.length > 12 ? `\n…他 ${result.warnings.length - 12} 件` : ""}\n\nこのままファイルを出力しますか？`,
      );
      if (!ok) return;
    }
    // Shift_JIS で出力 (仕様: 伝送ファイルの文字コードはシフト JIS)
    const sjis = Encoding.convert(Encoding.stringToCode(result.content), {
      to: "SJIS",
      from: "UNICODE",
    });
    const blob = new Blob([new Uint8Array(sjis)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = result.fileName;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success(
      `伝送ファイル ${result.fileName} を出力しました (データレコード ${result.dataRecordCount} 件)`,
    );
  };

  // 確認用 CSV (Excel で内容確認する用の明細一覧。伝送形式ではない)
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
            onClick={exportDensou}
            className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            title="国保中央会 伝送通信ソフト取込用の正式形式 (Shift_JIS) で出力"
          >
            <Send size={14} />
            伝送ファイル
          </button>
          <button
            type="button"
            disabled={rows.length === 0}
            onClick={exportCsv}
            className="inline-flex items-center gap-1 rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
            title="Excel で内容確認する用の明細 CSV (伝送形式ではない)"
          >
            <Download size={14} />
            確認用CSV
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
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={checked.has(r.user_id)}
                        onChange={() => toggle(r.user_id)}
                        className="h-3.5 w-3.5 accent-blue-600 cursor-pointer"
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
            ※ チェックで発行対象を絞込 (未チェック時は全件)。「伝送ファイル」は国保中央会
            伝送通信ソフト取込用の正式形式 (7111 請求書 + 7131 様式第二 / Shift_JIS)。
            初回は伝送ソフトの取込チェックで内容を確認してください。「確認用CSV」は Excel 閲覧用。
          </p>

          {/* ===== 印刷 view ===== */}
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
          {printMode === "seikyu" && (
            <div className="hidden print:block">
              <SeikyuForm
                providerNumber={officeNumber ?? ""}
                officeName={officeName ?? ""}
                officeAddress={officeAddress ?? ""}
                officePhone={officePhone ?? ""}
                postalCode={officePostal ?? ""}
                billingMonth={`${year}-${String(month).padStart(2, "0")}`}
                totalCount={targets.length}
                totalUnits={totalUnits}
                totalAmount={totalCost}
                insuranceAmount={totalInsurance}
                userCopay={totalUser}
                kubunLabel={"居宅サービス・地域密着型\nサービス・介護予防サービス"}
                kohiRequestAmount={totalKohi}
                kohiRows={kohiRows}
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

// ─── 印刷: 居宅サービス介護給付費明細書 (様式第二) — 利用者 1 名 = 1 枚 ───────
//
// 国保連インタフェース仕様書「様式第二」(migrations/_if_form2.txt) の
//   基本情報レコード / 明細情報レコード / 集計情報レコード
// の項目定義に沿って、ほのぼの Next の紙帳票と同等の体裁を再現する。
//
// レイアウト構成:
//   1) 上部ヘッダブロック
//      左: 公費負担者・受給者番号 / 保険者番号 / 被保険者番号 / フリガナ・氏名 /
//          生年月日・性別 / 要介護状態区分 / 認定有効期間
//      右: 事業所番号 / 事業所名称・所在地
//   2) 居宅サービス計画欄 (作成区分 / 居宅介護支援事業所番号)
//   3) 開始・中止年月日 / サービス実日数
//   4) 給付費明細欄 (サービス内容 / サービスコード / 単位数 / 回数 /
//      サービス単位数 / 公費分回数 / 公費対象単位数 / 摘要)
//   5) 請求額集計欄 (サービス種類 / サービス単位数 / 単位数単価 / 給付率 /
//      請求額 / 利用者負担 / 公費対象単位数 / 公費請求額 / 公費本人負担)

// 帳票用の桝目 (1 文字 = 1 マス) — 公式様式の番号欄を再現。
// 右詰めで value を流し込み、余りは空マス。境界は marginLeft -0.5pt で二重線回避。
function DigitCells({
  value,
  cells,
  cw = 5,
  h = 6,
}: {
  value: string | null | undefined;
  cells: number;
  /** 1 マスの幅 (mm) */
  cw?: number;
  /** マスの高さ (mm) */
  h?: number;
}) {
  const chars = (value ?? "").padStart(cells, " ").slice(-cells).split("");
  return (
    <span style={{ display: "inline-flex", verticalAlign: "middle" }}>
      {chars.map((c, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            width: `${cw}mm`,
            height: `${h}mm`,
            border: "0.5pt solid #000",
            marginLeft: i === 0 ? 0 : "-0.5pt",
            textAlign: "center",
            lineHeight: `${h}mm`,
            fontFamily: '"MS Gothic","ＭＳ ゴシック",monospace',
            fontSize: "10pt",
            fontWeight: "bold",
          }}
        >
          {c === " " ? " " : c}
        </span>
      ))}
    </span>
  );
}

// 丸数字ラベル (①②③…) — 欄番号の丸囲み表示
function Circle({ n }: { n: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: "5mm",
        height: "5mm",
        lineHeight: "4.6mm",
        borderRadius: "50%",
        border: "0.75pt solid #000",
        textAlign: "center",
        fontSize: "8pt",
        fontWeight: "bold",
        fontFamily: '"MS Gothic","ＭＳ ゴシック",sans-serif',
      }}
    >
      {n}
    </span>
  );
}

// 帳票の見出しセル (ラベル欄)
function Lb({
  children,
  style,
  rowSpan,
  colSpan,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  rowSpan?: number;
  colSpan?: number;
}) {
  return (
    <td
      rowSpan={rowSpan}
      colSpan={colSpan}
      style={{
        border: "0.5pt solid #000",
        padding: "0.8mm 1mm",
        textAlign: "center",
        fontWeight: "normal",
        fontSize: "7.5pt",
        lineHeight: 1.2,
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

// 帳票の値セル
function Vc({
  children,
  style,
  rowSpan,
  colSpan,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  rowSpan?: number;
  colSpan?: number;
}) {
  return (
    <td
      rowSpan={rowSpan}
      colSpan={colSpan}
      style={{
        border: "0.5pt solid #000",
        padding: "0.8mm 1mm",
        fontSize: "8pt",
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

// 和暦 (令和) の YYYY-MM-DD → 元号数値 + 年月日桝 の分解
function warekiParts(iso: string | null | undefined): {
  gengoIndex: number | null; // 1:明治 2:大正 3:昭和 4:平成 5:令和
  y: string;
  m: string;
  d: string;
} {
  if (!iso) return { gengoIndex: null, y: "", m: "", d: "" };
  const mt = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!mt) return { gengoIndex: null, y: "", m: "", d: "" };
  const yy = Number(mt[1]);
  const mm = Number(mt[2]);
  const dd = Number(mt[3]);
  // 元号判定 (境界年の月日簡略化: 年のみで判定)
  let gengoIndex: number;
  let wy: number;
  if (yy >= 2019) {
    gengoIndex = 5;
    wy = yy - 2018;
  } else if (yy >= 1989) {
    gengoIndex = 4;
    wy = yy - 1988;
  } else if (yy >= 1926) {
    gengoIndex = 3;
    wy = yy - 1925;
  } else if (yy >= 1912) {
    gengoIndex = 2;
    wy = yy - 1911;
  } else {
    gengoIndex = 1;
    wy = yy - 1867;
  }
  return {
    gengoIndex,
    y: String(wy).padStart(2, "0"),
    m: String(mm).padStart(2, "0"),
    d: String(dd).padStart(2, "0"),
  };
}

// 認定有効期間の 1 行 (平成/令和 + 年月日桝 + 接尾) — from/to 用
function CertDateRow({
  iso,
  suffix,
}: {
  iso: string | null | undefined;
  suffix: string;
}) {
  const p = warekiParts(iso);
  const gengoLabel =
    p.gengoIndex === 5 ? "令和" : p.gengoIndex === 4 ? "平成" : "";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5mm",
        fontSize: "7.5pt",
      }}
    >
      <span style={{ width: "8mm", textAlign: "center" }}>{gengoLabel}</span>
      <DigitCells value={p.y} cells={2} cw={4} h={5} />
      <span>年</span>
      <DigitCells value={p.m} cells={2} cw={4} h={5} />
      <span>月</span>
      <DigitCells value={p.d} cells={2} cw={4} h={5} />
      <span>日</span>
      <span style={{ marginLeft: "1mm" }}>{suffix}</span>
    </span>
  );
}

const R2: React.CSSProperties = { textAlign: "right" };
const CT: React.CSSProperties = { textAlign: "center" };

// 集計欄の行ラベルセル (左端の項番 + 名称)
function AggLb({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        border: "0.5pt solid #000",
        padding: "0.6mm 1mm",
        fontSize: "7pt",
        lineHeight: 1.15,
        verticalAlign: "middle",
        width: "34%",
      }}
    >
      {children}
    </td>
  );
}

// 集計欄の値セル (訪問介護列)
function AggVc({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <td
      style={{
        border: "0.5pt solid #000",
        padding: "0.6mm 1.5mm",
        fontSize: "8.5pt",
        fontFamily: '"MS Gothic","ＭＳ ゴシック",monospace',
        textAlign: "right",
        verticalAlign: "middle",
        height: "4.7mm",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

function MeisaiPrintSheet({
  row,
  officeName,
  officeNumber,
  officeAddress,
  officePhone,
  officePostal,
  reiwa,
  month,
}: {
  row: UserSeikyuRow;
  officeName: string | null;
  officeNumber: string | null;
  officeAddress: string | null;
  officePhone: string | null;
  officePostal: string | null;
  reiwa: number;
  month: number;
}) {
  // 給付率 = 100 - 利用者負担割合(%)。copay_rate は分数 (0.1/0.2/0.3) で保持されている
  // (aggregate.ts: raw>=1 は /10 済み)。したがって給付率 = round((1 - copay_rate) * 100)。
  const kyufuRate = Math.round((1 - row.copay_rate) * 100);
  const hasKohi = !!row.kohiHobetsu && !!(row.kohiAmount ?? 0);

  // 生年月日 (元号 + 年月日桝) / 性別
  const birth = warekiParts(row.birthDate);
  const genderIndex = row.gender?.includes("男")
    ? 1
    : row.gender?.includes("女")
      ? 2
      : null;

  // 明細行 (基本サービス + 加算) を 様式第二 の明細情報レコードに対応させる
  const detailLines: {
    name: string;
    code: string | null;
    unit: number | null;
    count: number;
    units: number;
    tekiyo: string;
  }[] = row.details.map((d) => ({
    name: d.service_type,
    code: d.service_code,
    unit: d.unit_per,
    count: d.count,
    units: d.units,
    tekiyo: "",
  }));
  if (row.addonUnits > 0) {
    detailLines.push({
      name: row.addonLabel ?? "処遇改善加算",
      code: row.addonCode,
      unit: null,
      count: 1,
      units: row.addonUnits,
      tekiyo: "",
    });
  }
  // 明細欄は最低 6 行 (空行で枠を埋める) — 公式様式の桝目再現。A4 1枚に収める
  const MIN_ROWS = 6;
  const emptyRows = Math.max(0, MIN_ROWS - detailLines.length);

  // 集計欄の数値 (⑫)
  const planUnits = row.totalUnits; // ④計画単位数
  const kanriUnits = row.baseUnits; // ⑤限度額管理対象単位数 (本体)
  const kanriGaiUnits = row.addonUnits; // ⑥限度額管理対象外単位数 (加算)
  const kyufuUnits = row.totalUnits; // ⑦給付単位数

  // 給付費明細欄の共通ヘッダ style
  const th: React.CSSProperties = {
    border: "0.5pt solid #000",
    padding: "0.8mm",
    fontSize: "7pt",
    fontWeight: "normal",
    textAlign: "center",
    lineHeight: 1.15,
    verticalAlign: "middle",
  };

  return (
    <div
      style={{
        pageBreakAfter: "always",
        padding: "4mm 5mm",
        fontFamily: '"MS Mincho","ＭＳ 明朝","游明朝",serif',
        color: "#000",
        fontSize: "8pt",
        lineHeight: 1.3,
        width: "210mm",
        boxSizing: "border-box",
      }}
    >
      {/* ── 標題行 (様式第二 右上) ── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: "1.5mm",
        }}
      >
        <div style={{ width: "20%" }} />
        <div style={{ textAlign: "center", flex: 1 }}>
          <div
            style={{
              fontSize: "10.5pt",
              fontWeight: "bold",
              letterSpacing: "1pt",
            }}
          >
            居宅サービス・地域密着型サービス介護給付費明細書
          </div>
          <div style={{ fontSize: "6.5pt", marginTop: "0.5mm" }}>
            （訪問介護・訪問入浴介護・訪問看護・訪問リハ・居宅療養管理指導・通所介護・通所リハ・福祉用具貸与・
            <br />
            夜間対応型訪問介護・認知症対応型通所介護・小規模多機能型居宅介護）
          </div>
        </div>
        <div
          style={{
            width: "20%",
            textAlign: "right",
            fontSize: "11pt",
            fontWeight: "bold",
          }}
        >
          様式第二
        </div>
      </div>

      {/* ── 最上段: ①提供年月 / ③保険者番号 (右上) / ②公費番号 (左) ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
        }}
      >
        <tbody>
          <tr>
            {/* 左: ② 公費番号 */}
            <td
              style={{
                width: "58%",
                border: "0.5pt solid #000",
                padding: "1mm",
                verticalAlign: "top",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "1.5mm" }}
              >
                <Circle n="②" />
                <span style={{ width: "26mm", fontSize: "7.5pt" }}>
                  公費負担者番号
                </span>
                <DigitCells value={row.kohiFutanshaNumber ?? ""} cells={8} cw={5} />
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1.5mm",
                  marginTop: "1.5mm",
                }}
              >
                <span style={{ width: "5mm" }} />
                <span style={{ width: "26mm", fontSize: "7.5pt" }}>
                  公費受給者番号
                </span>
                <DigitCells value={row.kohiJukyushaNumber ?? ""} cells={7} cw={5} />
              </div>
            </td>
            {/* 右: ① 提供年月 + ③ 保険者番号 */}
            <td
              style={{
                width: "42%",
                border: "0.5pt solid #000",
                padding: "1mm",
                verticalAlign: "top",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "1.5mm" }}
              >
                <Circle n="①" />
                <span style={{ fontSize: "8pt" }}>令和</span>
                <DigitCells
                  value={String(reiwa).padStart(2, "0")}
                  cells={2}
                  cw={5}
                />
                <span style={{ fontSize: "8pt" }}>年</span>
                <DigitCells
                  value={String(month).padStart(2, "0")}
                  cells={2}
                  cw={5}
                />
                <span style={{ fontSize: "8pt" }}>月分</span>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1.5mm",
                  marginTop: "1.5mm",
                }}
              >
                <Circle n="③" />
                <span style={{ fontSize: "8pt" }}>保険者番号</span>
                <DigitCells value={row.insurer_number ?? ""} cells={6} cw={5} />
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── ④被保険者 (左) / ⑥請求事業者 (右) ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "33%" }} />
          <col style={{ width: "5%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "33%" }} />
        </colgroup>
        <tbody>
          {/* 被保険者番号 / 事業所番号 */}
          <tr>
            <Lb
              rowSpan={5}
              style={{ writingMode: "vertical-rl", letterSpacing: "1pt" }}
            >
              <Circle n="④" />
              <span style={{ marginTop: "1mm" }}>被保険者</span>
            </Lb>
            <Lb>
              被保険者
              <br />
              番号
            </Lb>
            <Vc>
              <DigitCells value={row.insured_number ?? ""} cells={10} cw={6} />
            </Vc>
            <Lb
              rowSpan={5}
              style={{ writingMode: "vertical-rl", letterSpacing: "1pt" }}
            >
              <Circle n="⑥" />
              <span style={{ marginTop: "1mm" }}>請求事業者</span>
            </Lb>
            <Lb>
              事業所
              <br />
              番号
            </Lb>
            <Vc>
              <DigitCells value={officeNumber ?? ""} cells={10} cw={6} />
            </Vc>
          </tr>
          {/* フリガナ / 事業所名称 */}
          <tr>
            <Lb>（フリガナ）</Lb>
            <Vc style={{ fontSize: "7pt", height: "4mm" }}>
              {row.user_name_kana ?? ""}
            </Vc>
            <Lb rowSpan={2}>
              事業所
              <br />
              名称
            </Lb>
            <Vc
              rowSpan={2}
              style={{
                fontWeight: "bold",
                fontSize: "9pt",
                verticalAlign: "middle",
              }}
            >
              {officeName ?? ""}
            </Vc>
          </tr>
          {/* 氏名 / (事業所名称 続き) */}
          <tr>
            <Lb>氏名</Lb>
            <Vc style={{ fontWeight: "bold", fontSize: "10pt" }}>
              {row.user_name}
            </Vc>
          </tr>
          {/* 生年月日・性別 / 所在地 */}
          <tr>
            <Lb>
              生年月日
              <br />
              性別
            </Lb>
            <Vc>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1mm",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: "6.5pt" }}>
                  1.明治 2.大正 3.昭和 4.平成 5.令和
                </span>
                {birth.gengoIndex != null && (
                  <span style={{ fontSize: "7pt", fontWeight: "bold" }}>
                    〔{birth.gengoIndex}〕
                  </span>
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5mm",
                  marginTop: "0.5mm",
                }}
              >
                <DigitCells value={birth.y} cells={2} cw={4} h={5} />
                <span>年</span>
                <DigitCells value={birth.m} cells={2} cw={4} h={5} />
                <span>月</span>
                <DigitCells value={birth.d} cells={2} cw={4} h={5} />
                <span>日</span>
                <span style={{ marginLeft: "1.5mm", fontSize: "7pt" }}>
                  性別 {genderIndex === 1 ? "〔1〕男" : "1.男"}{" "}
                  {genderIndex === 2 ? "〔2〕女" : "2.女"}
                </span>
              </div>
            </Vc>
            <Lb rowSpan={2}>所在地</Lb>
            <Vc
              rowSpan={2}
              style={{ fontSize: "7.5pt", verticalAlign: "top" }}
            >
              <div>〒{officePostal ?? ""}</div>
              <div style={{ marginTop: "0.5mm" }}>{officeAddress ?? ""}</div>
              <div style={{ marginTop: "1mm" }}>
                連絡先　電話番号　{officePhone ?? ""}
              </div>
            </Vc>
          </tr>
          {/* ⑤要介護状態区分 (被保険者ブロック内) */}
          <tr>
            <Lb>
              <Circle n="⑤" />
              <br />
              要介護
              <br />
              状態区分
            </Lb>
            <Vc style={{ fontSize: "7.5pt" }}>
              経過的要介護・要介護{" "}
              <span style={{ fontWeight: "bold", fontSize: "9pt" }}>
                {row.care_level ?? ""}
              </span>
            </Vc>
          </tr>
          {/* 認定有効期間 (被保険者ブロック直下、全幅) */}
          <tr>
            <Lb colSpan={2}>
              認定有効
              <br />
              期間
            </Lb>
            <Vc colSpan={4} style={{ padding: "1mm" }}>
              <div>
                <CertDateRow iso={row.certStart} suffix="から" />
              </div>
              <div style={{ marginTop: "1mm" }}>
                <CertDateRow iso={row.certEnd} suffix="まで" />
              </div>
            </Vc>
          </tr>
        </tbody>
      </table>

      {/* ── ⑦居宅サービス計画 ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "50%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "21%" }} />
        </colgroup>
        <tbody>
          <tr>
            <Lb
              rowSpan={2}
              style={{ writingMode: "vertical-rl", letterSpacing: "1pt" }}
            >
              <Circle n="⑦" />
              <span style={{ marginTop: "1mm" }}>居宅サービス計画</span>
            </Lb>
            <Lb colSpan={4} style={{ textAlign: "left", fontSize: "7.5pt" }}>
              1. 居宅介護支援事業者作成　　2. 被保険者自己作成
            </Lb>
          </tr>
          <tr>
            <Lb>
              事業所
              <br />
              番号
            </Lb>
            <Vc>
              <DigitCells value={row.careOfficeNumber ?? ""} cells={10} cw={6} />
            </Vc>
            <Lb>
              事業所
              <br />
              名称
            </Lb>
            <Vc></Vc>
          </tr>
        </tbody>
      </table>

      {/* ── ⑧開始・中止年月日 / ⑨中止理由 ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "36%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "35%" }} />
        </colgroup>
        <tbody>
          <tr>
            <Lb>
              <Circle n="⑧" />
            </Lb>
            <Lb>
              開始
              <br />
              年月日
            </Lb>
            <Vc style={{ fontSize: "7pt" }}>
              <CertDateRow iso={null} suffix="" />
            </Vc>
            <Lb>
              <Circle n="⑨" />
              中止
              <br />
              年月日
            </Lb>
            <Vc style={{ fontSize: "7pt" }}>
              <CertDateRow iso={null} suffix="" />
            </Vc>
          </tr>
          <tr>
            <Lb colSpan={2}>
              中止
              <br />
              理由
            </Lb>
            <Vc colSpan={3} style={{ fontSize: "6.5pt" }}>
              1.非該当　3.医療機関入院　4.死亡　5.その他　6.介護老人福祉施設入所　7.介護老人保健施設入所　8.介護療養型医療施設入院
            </Vc>
          </tr>
        </tbody>
      </table>

      {/* ── ⑩給付費明細欄 ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "24%" }} />
          <col style={{ width: "13%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "7%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "10%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...th }} rowSpan={2}>
              <Circle n="⑩" />
              <br />
              給付費明細欄
            </th>
            <th style={{ ...th }}>サービス内容</th>
            <th style={{ ...th }}>サービスコード</th>
            <th style={{ ...th }}>単位数</th>
            <th style={{ ...th }}>回数</th>
            <th style={{ ...th }}>
              サービス
              <br />
              単位数
            </th>
            <th style={{ ...th }}>
              公費分
              <br />
              回数
            </th>
            <th style={{ ...th }}>
              公費対象
              <br />
              単位数
            </th>
            <th style={{ ...th }}>摘要</th>
          </tr>
        </thead>
        <tbody>
          {detailLines.map((d, i) => (
            <tr key={`${d.code ?? d.name}-${i}`}>
              {i === 0 && (
                <td
                  rowSpan={detailLines.length + emptyRows}
                  style={{ border: "0.5pt solid #000" }}
                />
              )}
              <Vc style={{ fontSize: "7.5pt" }}>{d.name}</Vc>
              <Vc style={{ padding: 0 }}>
                <DigitCells value={d.code ?? ""} cells={6} cw={3.5} h={5} />
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {d.unit != null ? d.unit.toLocaleString() : ""}
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {d.count}
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {d.units.toLocaleString()}
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {hasKohi ? d.count : ""}
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {hasKohi ? d.units.toLocaleString() : ""}
              </Vc>
              <Vc style={{ ...CT, fontSize: "7pt" }}>{d.tekiyo}</Vc>
            </tr>
          ))}
          {Array.from({ length: emptyRows }).map((_, i) => (
            <tr key={`empty-${i}`} style={{ height: "4.7mm" }}>
              <Vc></Vc>
              <Vc style={{ padding: 0 }}>
                <DigitCells value="" cells={6} cw={3.5} h={5} />
              </Vc>
              <Vc></Vc>
              <Vc></Vc>
              <Vc></Vc>
              <Vc></Vc>
              <Vc></Vc>
              <Vc></Vc>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── ⑫請求額集計欄 (+ ⑬給付率) ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "29%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "22%" }} />
        </colgroup>
        <tbody>
          {/* ① サービス種類コード / 名称 */}
          <tr>
            <Lb
              rowSpan={13}
              style={{ writingMode: "vertical-rl", letterSpacing: "1pt" }}
            >
              <Circle n="⑫" />
              <span style={{ marginTop: "1mm" }}>請求額集計欄</span>
            </Lb>
            <AggLb>①サービス種類コード／②名称</AggLb>
            <AggVc style={{ textAlign: "left", fontFamily: "inherit" }}>
              <span
                style={{
                  fontFamily: '"MS Gothic",monospace',
                  fontWeight: "bold",
                }}
              >
                11
              </span>{" "}
              訪問介護
            </AggVc>
            <AggVc style={{ textAlign: "center" }} />
            <AggVc style={{ textAlign: "left", verticalAlign: "bottom" }}>
              <span style={{ fontSize: "7pt" }}>
                <Circle n="⑬" /> 給付率（/100）
              </span>
            </AggVc>
          </tr>
          {/* ③ サービス実日数 */}
          <tr>
            <AggLb>③サービス実日数</AggLb>
            <AggVc>
              {row.serviceDays} <span style={{ fontSize: "7pt" }}>日</span>
            </AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left" }} />
          </tr>
          {/* ④ 計画単位数 */}
          <tr>
            <AggLb>④計画単位数</AggLb>
            <AggVc>{planUnits.toLocaleString()}</AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left" }} />
          </tr>
          {/* ⑤ 限度額管理対象単位数 */}
          <tr>
            <AggLb>⑤限度額管理対象単位数</AggLb>
            <AggVc>{kanriUnits.toLocaleString()}</AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left" }} />
          </tr>
          {/* ⑥ 限度額管理対象外単位数 */}
          <tr>
            <AggLb>⑥限度額管理対象外単位数</AggLb>
            <AggVc>{kanriGaiUnits ? kanriGaiUnits.toLocaleString() : ""}</AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left" }} />
          </tr>
          {/* ⑦ 給付単位数 */}
          <tr>
            <AggLb>⑦給付単位数（④⑤のうち少ない数）＋⑥</AggLb>
            <AggVc>{kyufuUnits.toLocaleString()}</AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left", padding: "0.6mm 1.5mm" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: "7pt" }}>保険</span>
                <span
                  style={{
                    fontFamily: '"MS Gothic",monospace',
                    fontWeight: "bold",
                  }}
                >
                  {kyufuRate}
                </span>
              </div>
            </AggVc>
          </tr>
          {/* ⑧ 公費分単位数 */}
          <tr>
            <AggLb>⑧公費分単位数</AggLb>
            <AggVc>{hasKohi ? (row.kohiUnits ?? 0).toLocaleString() : ""}</AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: "7pt" }}>公費</span>
                <span />
              </div>
            </AggVc>
          </tr>
          {/* ⑨ 単位数単価 */}
          <tr>
            <AggLb>⑨単位数単価</AggLb>
            <AggVc>
              {row.unitPrice.toFixed(2)}{" "}
              <span style={{ fontSize: "7pt" }}>円/単位</span>
            </AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left" }}>
              <span style={{ fontSize: "7pt" }}>合計</span>
            </AggVc>
          </tr>
          {/* ⑩ 保険請求額 */}
          <tr>
            <AggLb>⑩保険請求額</AggLb>
            <AggVc style={{ fontWeight: "bold" }}>
              {row.insuranceAmount.toLocaleString()}
            </AggVc>
            <AggVc />
            <AggVc>{row.insuranceAmount.toLocaleString()}</AggVc>
          </tr>
          {/* ⑪ 利用者負担額 */}
          <tr>
            <AggLb>⑪利用者負担額</AggLb>
            <AggVc>{row.userAmount.toLocaleString()}</AggVc>
            <AggVc />
            <AggVc>{row.userAmount.toLocaleString()}</AggVc>
          </tr>
          {/* ⑫ 公費請求額 */}
          <tr>
            <AggLb>⑫公費請求額</AggLb>
            <AggVc>{hasKohi ? (row.kohiAmount ?? 0).toLocaleString() : ""}</AggVc>
            <AggVc />
            <AggVc>{hasKohi ? (row.kohiAmount ?? 0).toLocaleString() : ""}</AggVc>
          </tr>
          {/* ⑬ 公費分本人負担 */}
          <tr>
            <AggLb>⑬公費分本人負担</AggLb>
            <AggVc />
            <AggVc />
            <AggVc />
          </tr>
        </tbody>
      </table>

      {/* ── ⑮社会福祉法人等軽減欄 ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "27%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "20%" }} />
        </colgroup>
        <tbody>
          <tr>
            <Lb
              rowSpan={6}
              style={{ writingMode: "vertical-rl", letterSpacing: "0.5pt" }}
            >
              <Circle n="⑮" />
              <span style={{ marginTop: "1mm" }}>社会福祉法人等による軽減欄</span>
            </Lb>
            <Lb colSpan={2}>軽減率</Lb>
            <Vc
              style={{
                textAlign: "right",
                fontFamily: '"MS Gothic",monospace',
              }}
            >
              <span style={{ fontSize: "7pt" }}>％</span>
            </Vc>
            <Lb>軽減額</Lb>
            <Lb>備考</Lb>
          </tr>
          {[
            { code: "11", label: "訪問介護" },
            { code: "15", label: "通所介護" },
            { code: "71", label: "夜間対応型訪問介護" },
            { code: "72", label: "認知症対応型通所介護" },
            { code: "73", label: "小規模多機能型居宅介護" },
          ].map((s) => (
            <tr key={s.code}>
              <Vc style={{ ...CT, fontFamily: '"MS Gothic",monospace' }}>
                {s.code}
              </Vc>
              <Vc style={{ fontSize: "7.5pt" }}>{s.label}</Vc>
              <Vc />
              <Vc />
              <Vc />
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── 枚数 (右下) ── */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginTop: "1.5mm",
        }}
      >
        <table style={{ borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <Vc
                style={{
                  ...CT,
                  width: "8mm",
                  fontFamily: '"MS Gothic",monospace',
                }}
              >
                1
              </Vc>
              <Vc style={{ ...CT, width: "12mm", fontSize: "7pt" }}>枚目</Vc>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
