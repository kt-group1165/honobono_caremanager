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

// 帳票用の桝目 (1 文字 = 1 マス) — ほのぼの帳票の番号欄を再現
function DigitCells({
  value,
  cells,
  cw = 5,
}: {
  value: string | null | undefined;
  cells: number;
  /** 1 マスの幅 (mm) */
  cw?: number;
}) {
  const chars = (value ?? "").padStart(cells, " ").slice(-cells).split("");
  return (
    <span style={{ display: "inline-flex" }}>
      {chars.map((c, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            width: `${cw}mm`,
            height: "5mm",
            border: "0.5pt solid #000",
            marginRight: "-0.5pt",
            textAlign: "center",
            lineHeight: "5mm",
            fontFamily: "monospace",
            fontSize: "8pt",
          }}
        >
          {c === " " ? " " : c}
        </span>
      ))}
    </span>
  );
}

// 帳票の見出しセル (ラベル・縦書き風の細い見出し)
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
        padding: "1mm 1.5mm",
        background: "#eee",
        textAlign: "center",
        fontWeight: "normal",
        fontSize: "8pt",
        whiteSpace: "nowrap",
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
        padding: "1mm 1.5mm",
        fontSize: "8.5pt",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

// 和暦 (令和) の YYYY-MM-DD → "R x. m. d" 表記
function toWareki(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const y = Number(m[1]);
  const r = y - 2018; // 令和 = 西暦 - 2018
  return r >= 1 ? `令和${r}.${Number(m[2])}.${Number(m[3])}` : iso;
}

const R2: React.CSSProperties = { textAlign: "right" };
const CT: React.CSSProperties = { textAlign: "center" };

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
  // 給付率 = 100 - 利用者負担割合(%)。copay_rate は分数 (0.1/0.2/0.3) で保持されている
  // (aggregate.ts: raw>=1 は /10 済み)。したがって給付率 = round((1 - copay_rate) * 100)。
  const kyufuRate = Math.round((1 - row.copay_rate) * 100);
  const hasKohi = !!row.kohiHobetsu && !!(row.kohiAmount ?? 0);
  // 明細行 (基本サービス + 加算) を 様式第二 の明細情報レコードに対応させる
  const detailLines: {
    name: string;
    code: string | null;
    unit: number | null;
    count: number;
    units: number;
  }[] = row.details.map((d) => ({
    name: d.short_name ?? d.service_type,
    code: d.service_code,
    unit: d.unit_per,
    count: d.count,
    units: d.units,
  }));
  if (row.addonUnits > 0) {
    detailLines.push({
      name: row.addonLabel ?? "処遇改善加算",
      code: row.addonCode,
      unit: null,
      count: 1,
      units: row.addonUnits,
    });
  }
  // 明細欄は最低 10 行 (空行で枠を埋める) — 帳票らしさのため
  const MIN_ROWS = 10;
  const emptyRows = Math.max(0, MIN_ROWS - detailLines.length);

  const th: React.CSSProperties = {
    border: "0.5pt solid #000",
    background: "#eee",
    padding: "1mm",
    fontSize: "7.5pt",
    fontWeight: "normal",
    textAlign: "center",
    whiteSpace: "nowrap",
  };

  return (
    <div
      style={{
        pageBreakAfter: "always",
        padding: "8mm 6mm",
        fontFamily: '"MS Mincho","ＭＳ 明朝","游明朝",serif',
        color: "#000",
        fontSize: "9pt",
        lineHeight: 1.3,
      }}
    >
      {/* ── 標題 ── */}
      <div style={{ position: "relative", marginBottom: "2mm" }}>
        <div style={{ textAlign: "center", fontSize: "8pt" }}>
          様式第二（居宅サービス・地域密着型サービス）
        </div>
        <h2
          style={{
            textAlign: "center",
            fontSize: "13pt",
            fontWeight: "bold",
            margin: "1mm 0 0",
            letterSpacing: "2pt",
          }}
        >
          居宅サービス・地域密着型サービス介護給付費明細書
        </h2>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "4mm",
            marginTop: "1mm",
            fontSize: "9pt",
          }}
        >
          <span>
            公費負担者番号{" "}
            <DigitCells value={row.kohiFutanshaNumber ?? ""} cells={8} />
          </span>
          <span>
            サービス提供年月{" "}
            <span style={{ fontWeight: "bold" }}>
              令和{String(reiwa).padStart(2, "0")}年
              {String(month).padStart(2, "0")}月分
            </span>
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1mm", fontSize: "9pt" }}>
          <span>
            公費受給者番号{" "}
            <DigitCells value={row.kohiJukyushaNumber ?? ""} cells={7} />
          </span>
        </div>
      </div>

      {/* ── 上部: 被保険者情報 (左) / 事業所情報 (右) ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
        }}
      >
        <tbody>
          <tr>
            {/* 左ブロック: 保険者・被保険者 */}
            <Lb style={{ width: "22%" }}>保険者番号</Lb>
            <Vc style={{ width: "28%" }}>
              <DigitCells value={row.insurer_number ?? ""} cells={6} />
            </Vc>
            {/* 右ブロック: 事業所 */}
            <Lb style={{ width: "22%" }}>事業所番号</Lb>
            <Vc style={{ width: "28%" }}>
              <DigitCells value="" cells={10} />
            </Vc>
          </tr>
          <tr>
            <Lb>被保険者番号</Lb>
            <Vc>
              <DigitCells value={row.insured_number ?? ""} cells={10} />
            </Vc>
            <Lb rowSpan={3}>
              請求事業所
            </Lb>
            <Vc rowSpan={3} style={{ verticalAlign: "top", fontSize: "9pt" }}>
              <div>名称</div>
              <div style={{ fontWeight: "bold", padding: "0.5mm 0" }}>
                {officeName ?? ""}
              </div>
            </Vc>
          </tr>
          <tr>
            <Lb>
              （フリガナ）
              <br />
              氏名
            </Lb>
            <Vc>
              <div style={{ fontSize: "7pt" }}>{row.user_name_kana ?? ""}</div>
              <div style={{ fontWeight: "bold" }}>{row.user_name}</div>
            </Vc>
          </tr>
          <tr>
            <Lb>生年月日 / 性別</Lb>
            <Vc>
              {toWareki(row.birthDate)} / {row.gender ?? ""}
            </Vc>
          </tr>
          <tr>
            <Lb>要介護状態区分</Lb>
            <Vc style={{ fontWeight: "bold" }}>{row.care_level ?? ""}</Vc>
            <Lb>認定有効期間</Lb>
            <Vc style={{ fontSize: "8pt" }}>
              {toWareki(row.certStart)} 〜 {toWareki(row.certEnd)}
            </Vc>
          </tr>
        </tbody>
      </table>

      {/* ── 居宅サービス計画 / 開始・中止 / 実日数 ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <tbody>
          <tr>
            <Lb style={{ width: "22%" }}>
              居宅介護支援事業所
              <br />
              →当該事業所番号
            </Lb>
            <Vc style={{ width: "28%" }}>
              <DigitCells value={row.careOfficeNumber ?? ""} cells={10} />
            </Vc>
            <Lb style={{ width: "22%" }}>作成区分</Lb>
            <Vc style={{ width: "28%" }}>1. 居宅介護支援事業所作成</Vc>
          </tr>
          <tr>
            <Lb>開始年月日</Lb>
            <Vc></Vc>
            <Lb>中止年月日</Lb>
            <Vc></Vc>
          </tr>
          <tr>
            <Lb>中止理由</Lb>
            <Vc></Vc>
            <Lb>サービス実日数</Lb>
            <Vc style={{ fontWeight: "bold" }}>{row.serviceDays} 日</Vc>
          </tr>
        </tbody>
      </table>

      {/* ── 給付費明細欄 (明細情報レコード) ── */}
      <div style={{ marginTop: "3mm", fontSize: "8pt", fontWeight: "bold" }}>
        給付費明細欄
      </div>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
        }}
      >
        <thead>
          <tr>
            <th style={{ ...th, width: "26%" }}>サービス内容</th>
            <th style={{ ...th, width: "14%" }}>サービスコード</th>
            <th style={{ ...th, width: "11%" }}>単位数</th>
            <th style={{ ...th, width: "8%" }}>回数</th>
            <th style={{ ...th, width: "13%" }}>
              サービス
              <br />
              単位数
            </th>
            <th style={{ ...th, width: "8%" }}>
              公費分
              <br />
              回数
            </th>
            <th style={{ ...th, width: "13%" }}>
              公費対象
              <br />
              単位数
            </th>
            <th style={{ ...th, width: "7%" }}>摘要</th>
          </tr>
        </thead>
        <tbody>
          {detailLines.map((d, i) => (
            <tr key={`${d.code ?? d.name}-${i}`}>
              <Vc style={{ fontSize: "8pt" }}>{d.name}</Vc>
              <Vc style={{ ...CT, fontFamily: "monospace" }}>{d.code ?? ""}</Vc>
              <Vc style={R2}>{d.unit != null ? d.unit.toLocaleString() : ""}</Vc>
              <Vc style={R2}>{d.count}</Vc>
              <Vc style={R2}>{d.units.toLocaleString()}</Vc>
              <Vc style={R2}>{hasKohi ? d.count : ""}</Vc>
              <Vc style={R2}>{hasKohi ? d.units.toLocaleString() : ""}</Vc>
              <Vc></Vc>
            </tr>
          ))}
          {Array.from({ length: emptyRows }).map((_, i) => (
            <tr key={`empty-${i}`} style={{ height: "5mm" }}>
              <Vc></Vc>
              <Vc></Vc>
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

      {/* ── 請求額集計欄 (集計情報レコード) ── */}
      <div style={{ marginTop: "3mm", fontSize: "8pt", fontWeight: "bold" }}>
        請求額集計欄
      </div>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
        }}
      >
        <thead>
          <tr>
            <th style={{ ...th, width: "18%" }}>サービス種類</th>
            <th style={{ ...th }}>
              サービス
              <br />
              単位数
            </th>
            <th style={{ ...th }}>
              単位数
              <br />
              単価
            </th>
            <th style={{ ...th }}>
              保険
              <br />
              給付率
            </th>
            <th style={{ ...th }}>
              請求額
              <br />
              (保険)
            </th>
            <th style={{ ...th }}>
              利用者
              <br />
              負担額
            </th>
            <th style={{ ...th }}>
              公費対象
              <br />
              単位数
            </th>
            <th style={{ ...th }}>
              公費
              <br />
              請求額
            </th>
          </tr>
        </thead>
        <tbody>
          {/* 訪問介護は 1 サービス種類 (種類コード 11) として集計 */}
          <tr>
            <Vc style={{ fontSize: "8pt" }}>訪問介護</Vc>
            <Vc style={R2}>{row.totalUnits.toLocaleString()}</Vc>
            <Vc style={R2}>{row.unitPrice.toFixed(2)} 円</Vc>
            <Vc style={CT}>{kyufuRate}%</Vc>
            <Vc style={{ ...R2, fontWeight: "bold" }}>
              {row.insuranceAmount.toLocaleString()}
            </Vc>
            <Vc style={R2}>{row.userAmount.toLocaleString()}</Vc>
            <Vc style={R2}>
              {hasKohi ? (row.kohiUnits ?? 0).toLocaleString() : ""}
            </Vc>
            <Vc style={R2}>
              {hasKohi ? (row.kohiAmount ?? 0).toLocaleString() : ""}
            </Vc>
          </tr>
          {/* 合計行 */}
          <tr style={{ fontWeight: "bold", background: "#f5f5f5" }}>
            <Vc style={CT}>合計</Vc>
            <Vc style={R2}>{row.totalUnits.toLocaleString()}</Vc>
            <Vc style={CT}>—</Vc>
            <Vc style={CT}>—</Vc>
            <Vc style={R2}>{row.insuranceAmount.toLocaleString()}</Vc>
            <Vc style={R2}>{row.userAmount.toLocaleString()}</Vc>
            <Vc style={R2}>
              {hasKohi ? (row.kohiUnits ?? 0).toLocaleString() : ""}
            </Vc>
            <Vc style={R2}>
              {hasKohi ? (row.kohiAmount ?? 0).toLocaleString() : ""}
            </Vc>
          </tr>
        </tbody>
      </table>

      {/* ── 費用総額 (フッタ) ── */}
      <table
        style={{
          width: "60%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "2mm",
          marginLeft: "auto",
        }}
      >
        <tbody>
          <tr>
            <Lb style={{ width: "50%" }}>費用総額</Lb>
            <Vc style={{ ...R2, fontWeight: "bold" }}>
              ¥{row.totalAmount.toLocaleString()}
            </Vc>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
