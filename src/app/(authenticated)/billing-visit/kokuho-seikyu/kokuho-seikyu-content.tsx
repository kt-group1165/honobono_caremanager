"use client";

/**
 * 国保請求 — 国保連請求の集計 + 伝送ファイル・確認用CSV の作成
 * (見た目: 介護請求タブ = order-app 介護請求タブと同一のグレーヘッダ + 格子テーブル)
 *
 * 構成:
 *  左: あかさたな索引 / 中央: ツールバー + 格子テーブル + 合計フッタ
 *  出力: 国保連伝送ファイル (7111 + 7131 / Shift_JIS) + 確認用CSV
 *
 * 機能 (従来どおり): チェックで出力対象を絞込 (未チェック時は全件)。
 * ※ 明細書・請求書の発行は「介護請求」画面へ移設済み。
 */

import { useMemo, useState } from "react";
import {
  Loader2,
  AlertCircle,
  Download,
  Send,
} from "lucide-react";
import Encoding from "encoding-japanese";
import { toast } from "sonner";
import {
  useSeikyuContext,
  SeikyuKanaSidebar,
  SeikyuMonthNav,
} from "../_shared/seikyu-context";
import { buildKokuhoDensou } from "@/lib/kokuho-densou/build";

// 介護請求タブと同じグリッド列定義の流儀 (格子テーブル)
const GRID_COLS =
  "grid grid-cols-[32px_64px_88px_104px_1fr_72px_80px_96px_96px]";

export function KokuhoSeikyuContent() {
  const {
    year, month, filteredRows, loading, error,
    officeNumber, unitPrice,
  } = useSeikyuContext();
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
      prev.size === filteredRows.length
        ? new Set()
        : new Set(filteredRows.map((r) => r.user_id)),
    );

  const targets = useMemo(
    () =>
      checked.size > 0
        ? filteredRows.filter((r) => checked.has(r.user_id))
        : filteredRows,
    [filteredRows, checked],
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

  const allChecked =
    checked.size === filteredRows.length && filteredRows.length > 0;

  return (
    <div className="flex flex-1 min-h-0">
      {/* ── 左: かな行フィルター ── */}
      <SeikyuKanaSidebar />

      {/* ── 中央: ツールバー + テーブル + フッタ ── */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* ツールバー (伝送ファイル / 確認用CSV — order-app の CSV 出力ボタン風) */}
        <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
          <SeikyuMonthNav />
          <span className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 font-medium">国保請求分</span>
          <span className="text-xs text-gray-500">{filteredRows.length} 件</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={exportCsv}
              disabled={filteredRows.length === 0}
              title="Excel で内容確認する用の明細 CSV (伝送形式ではない)"
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Download size={13} />確認用CSV
            </button>
            <button
              type="button"
              onClick={exportDensou}
              disabled={filteredRows.length === 0}
              title="国保中央会 伝送通信ソフト取込用の正式形式 (Shift_JIS) で出力"
              className="border border-indigo-500 rounded bg-indigo-500 px-3 py-1 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Send size={13} />伝送ファイル ({targets.length}件)
            </button>
          </div>
        </div>

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
              {/* ヘッダー行: 対象 / 提供年月 / 保険者番号 / 被保険者番号 / 利用者名 / 要介護度 / 単位数 / 保険請求額 / 利用者負担 */}
              <div className={`${GRID_COLS} border-b border-gray-300 bg-gray-100 text-xs font-semibold text-gray-600 sticky top-0 z-10`}>
                <div className="px-1 py-2 flex items-center justify-center">
                  <button
                    onClick={toggleAll}
                    title="全選択"
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                      allChecked ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                    }`}
                  >
                    {allChecked && (
                      <span className="text-white text-[8px] font-bold leading-none">✓</span>
                    )}
                  </button>
                </div>
                <div className="px-2 py-2 border-l border-gray-200">提供年月</div>
                <div className="px-2 py-2 border-l border-gray-200">保険者番号</div>
                <div className="px-2 py-2 border-l border-gray-200">被保険者番号</div>
                <div className="px-2 py-2 border-l border-gray-200">利用者名</div>
                <div className="px-2 py-2 border-l border-gray-200">要介護度</div>
                <div className="px-2 py-2 border-l border-gray-200 text-right">単位数</div>
                <div className="px-2 py-2 border-l border-gray-200 text-right">保険請求額</div>
                <div className="px-2 py-2 border-l border-gray-200 text-right">利用者負担</div>
              </div>

              {filteredRows.length === 0 ? (
                <p className="text-gray-400 text-center py-10">
                  対象月の実績 (完了) がありません
                </p>
              ) : filteredRows.map((r, idx) => {
                const isChecked = checked.has(r.user_id);
                return (
                  <div
                    key={r.user_id}
                    onClick={() => toggle(r.user_id)}
                    className={`${GRID_COLS} border-b border-gray-100 text-xs cursor-pointer transition-colors ${
                      isChecked
                        ? "bg-indigo-50"
                        : idx % 2 === 0
                        ? "bg-white hover:bg-gray-50"
                        : "bg-gray-50/50 hover:bg-gray-100"
                    }`}
                  >
                    <div className="px-1 py-2 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => toggle(r.user_id)}
                        className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                          isChecked ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                        }`}
                      >
                        {isChecked && <span className="text-white text-[8px] font-bold leading-none">✓</span>}
                      </button>
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-gray-500">
                      R{reiwa}/{month}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 font-mono text-gray-700">
                      {r.insurer_number ?? "—"}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 font-mono text-gray-700">
                      {r.insured_number ?? "—"}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 font-medium text-gray-800 truncate">
                      {r.user_name}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-gray-700">
                      {r.care_level ?? "—"}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-right font-mono text-gray-700">
                      {r.totalUnits.toLocaleString()}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-right font-mono font-semibold text-indigo-700">
                      {r.insuranceAmount.toLocaleString()}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-right font-mono text-gray-700">
                      {r.userAmount.toLocaleString()}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── フッター合計 (介護請求タブと同じ box レイアウト) ── */}
            <div className="border-t border-gray-300 bg-gray-50 px-3 py-2 shrink-0 text-[11px] text-gray-700">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mb-1.5">
                <span>合計件数 <strong className="font-mono">{targets.length.toLocaleString()}</strong></span>
                <span>
                  出力対象{" "}
                  <strong className="font-mono">
                    {checked.size > 0 ? `チェック ${checked.size} 件` : "全件"}
                  </strong>
                </span>
              </div>
              <div className="border border-gray-300 rounded bg-white px-2 py-1.5 grid grid-cols-3 gap-x-4 gap-y-1">
                <span>合計単位数 <strong className="font-mono">{totalUnits.toLocaleString()}</strong></span>
                <span>保険請求額 <strong className="font-mono text-indigo-700">¥{totalInsurance.toLocaleString()}</strong></span>
                <span>利用者負担額 <strong className="font-mono">¥{totalUser.toLocaleString()}</strong></span>
              </div>
              <p className="mt-1.5 text-[10px] text-gray-400">
                ※ チェックで出力対象を絞込 (未チェック時は全件)。「伝送ファイル」は国保中央会
                伝送通信ソフト取込用の正式形式 (7111 請求書 + 7131 様式第二 / Shift_JIS)。
                初回は伝送ソフトの取込チェックで内容を確認してください。「確認用CSV」は Excel 閲覧用。
                明細書・請求書の発行は「介護請求」画面で行います。
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
