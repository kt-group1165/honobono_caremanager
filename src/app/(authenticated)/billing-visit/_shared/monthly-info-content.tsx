"use client";

/**
 * 月次情報 — 訪問介護の請求前チェック一覧 (見た目: order-app 月次情報タブと同一)
 *
 * 左: あかさたな索引 / 中央: ◀ 年月 ▶ ツールバー + 格子テーブル。
 * 対象月の請求対象利用者を一覧し、請求前に目視で確認したい項目を並べる:
 *   保険者番号 / 被保険者番号 / 利用者名 / 要介護度 / 認定有効期間 /
 *   担当居宅事業所番号 / 作成区分 / 単位数
 *
 * 警告バッジ (目視確認用):
 *   - 認定有効期間が対象月に掛からない → 赤「認定切れ」
 *   - 担当居宅事業所番号が未設定 → 橙「担当居宅未設定」
 */

import { Loader2, AlertCircle } from "lucide-react";
import {
  useSeikyuContext,
  SeikyuKanaSidebar,
  SeikyuMonthNav,
} from "./seikyu-context";

// 認定有効期間 (certStart〜certEnd) が対象月 (year/month) に掛かるか判定する。
// 開始が月末より後、または 終了が月初より前なら「掛からない」= 認定切れ扱い。
function certCoversMonth(
  certStart: string | null,
  certEnd: string | null,
  year: number,
  month: number,
): boolean {
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = new Date(year, month, 0).toISOString().split("T")[0];
  if (certStart && certStart > monthEnd) return false;
  if (certEnd && certEnd < monthStart) return false;
  return true;
}

// YYYY-MM-DD → YYYY/M/D 表示。null は空。
function fmtDate(d: string | null): string {
  if (!d) return "";
  const [y, m, dd] = d.split("-").map((n) => Number(n));
  if (!y || !m || !dd) return d;
  return `${y}/${m}/${dd}`;
}

export function MonthlyInfoContent() {
  const { year, month, filteredRows, recordCount, loading, error } =
    useSeikyuContext();

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={22} className="animate-spin text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* 左: かな行フィルター */}
      <SeikyuKanaSidebar />

      {/* 中央: ツールバー + テーブル */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2">
          <SeikyuMonthNav variant="square" />
          <span className="text-xs text-gray-500 ml-2">{filteredRows.length} 件</span>
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
                <th className="px-2 py-1.5 border border-gray-300 text-left">保険者番号</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">被保険者番号</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">利用者名</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">要介護度</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">認定有効期間</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">担当居宅事業所番号</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">作成区分</th>
                <th className="px-2 py-1.5 border border-gray-300 text-right">区分支給限度基準内単位数</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const certOk = certCoversMonth(r.certStart, r.certEnd, year, month);
                const hasCareOffice = !!r.careOfficeNumber;
                return (
                  <tr key={r.user_id} className="hover:bg-blue-50">
                    <td className="px-2 py-1 border border-gray-200 font-mono">
                      {r.insurer_number ?? "-"}
                    </td>
                    <td className="px-2 py-1 border border-gray-200 font-mono">
                      {r.insured_number ?? "-"}
                    </td>
                    <td className="px-2 py-1 border border-gray-200">{r.user_name}</td>
                    <td className="px-2 py-1 border border-gray-200">
                      {r.care_level ?? "-"}
                    </td>
                    <td className="px-2 py-1 border border-gray-200">
                      {r.certStart || r.certEnd ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="tabular-nums">
                            {fmtDate(r.certStart)}
                            {"〜"}
                            {fmtDate(r.certEnd)}
                          </span>
                          {!certOk && (
                            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
                              認定切れ
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
                          認定切れ
                        </span>
                      )}
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
                    <td className="px-2 py-1 border border-gray-200">
                      {hasCareOffice ? "居宅介護支援事業者作成" : "-"}
                    </td>
                    <td className="px-2 py-1 border border-gray-200 text-right font-mono">
                      {r.totalUnits.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-gray-400 text-sm">
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
              合計単位数{" "}
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
