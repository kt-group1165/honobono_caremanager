"use client";

/**
 * 国保請求 — 国保連請求の集計 + 伝送ファイル・確認用CSV の作成 (参考: ほのぼの 国保請求タブ)
 *
 * 構成:
 *  上段: 介護給付費明細書 (様式2 相当) の一覧 — 利用者 × 保険請求額
 *  下段: 集計サマリ (件数 / 単位数 / 保険請求額)
 *  出力: 国保連伝送ファイル (7111 + 7131 / Shift_JIS) + 確認用CSV
 *
 * ※ 明細書・請求書の発行は「介護請求」画面へ移設済み。
 */

import { useMemo, useState } from "react";
import {
  Loader2,
  Landmark,
  AlertCircle,
  Download,
  Send,
} from "lucide-react";
import Encoding from "encoding-japanese";
import { toast } from "sonner";
import { MonthNav } from "../_shared/month-nav";
import { useSeikyuData } from "../_shared/use-seikyu-data";
import { buildKokuhoDensou } from "@/lib/kokuho-densou/build";

export function KokuhoSeikyuContent() {
  const {
    year, month, onMonthChange, rows, loading, error,
    officeName, officeNumber, unitPrice,
  } = useSeikyuData();
  const [checked, setChecked] = useState<Set<string>>(new Set());

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
      {/* 画面ヘッダ */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <Landmark size={20} className="text-indigo-600" />
            国保請求
          </h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {officeName ?? ""} — 国保連への介護給付費請求の集計と、伝送ファイルの作成
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MonthNav year={year} month={month} onChange={onMonthChange} />
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
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 size={20} className="mr-2 animate-spin" />
          集計中...
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-gray-50 p-12 text-center text-sm text-gray-500">
          対象月の実績 (完了) がありません
        </div>
      ) : (
        <>
          {/* 明細一覧 (画面) */}
          <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
          <p className="text-[11px] text-gray-400">
            ※ チェックで出力対象を絞込 (未チェック時は全件)。「伝送ファイル」は国保中央会
            伝送通信ソフト取込用の正式形式 (7111 請求書 + 7131 様式第二 / Shift_JIS)。
            初回は伝送ソフトの取込チェックで内容を確認してください。「確認用CSV」は Excel 閲覧用。
            明細書・請求書の発行は「介護請求」画面で行います。
          </p>
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
