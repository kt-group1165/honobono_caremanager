"use client";

/**
 * 月次情報 (居宅介護支援) — 請求前チェック一覧
 * (見た目: billing-visit/_shared/monthly-info-content.tsx = order-app 月次情報タブと同一トーン)
 *
 * 左: あかさたな索引 / 中央: ◀ 年月 ▶ ツールバー + 格子テーブル。
 * 居宅では計画単位数 = 自事業所の給付管理 (/billing/benefits) と同義のため、
 * ここでは実績単位数 (= レセプト単位数) 中心の表示にする。
 *
 * 警告バッジ (目視確認用):
 *   - 認定有効期間が対象月に掛からない → 保険変更列に赤「認定切れ」
 *   - 被保険者番号/保険者番号 未登録 → 該当列に橙バッジ
 *   - レセプト未確定 (draft) → 状態列に黄「未確定」
 */

import { Loader2, AlertCircle } from "lucide-react";
import {
  useKyotakuSeikyuContext,
  SeikyuKanaSidebar,
  SeikyuMonthNav,
} from "./_seikyu-context";
import type { ClaimStatus } from "../claims/claims-shared";

// 認定有効期間 (certStart〜certEnd) が対象月 (year/month) に掛かるか判定する。
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

const STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: "未確定",
  confirmed: "確定済",
  submitted: "請求済",
};

const STATUS_CLS: Record<ClaimStatus, string> = {
  draft: "bg-yellow-100 text-yellow-700",
  confirmed: "bg-green-100 text-green-700",
  submitted: "bg-blue-100 text-blue-700",
};

export function KyotakuMonthlyInfoContent() {
  const { year, month, filteredRows, loading, error } = useKyotakuSeikyuContext();

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={22} className="animate-spin text-indigo-400" />
      </div>
    );
  }

  const totalUnits = filteredRows.reduce((s, r) => s + r.totalUnits, 0);
  const totalAmount = filteredRows.reduce((s, r) => s + r.insuranceAmount, 0);
  const draftCount = filteredRows.filter((r) => r.claimStatus === "draft").length;

  return (
    <div className="flex flex-1 min-h-0">
      {/* 左: かな行フィルター */}
      <SeikyuKanaSidebar />

      {/* 中央: ツールバー + テーブル */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2">
          <SeikyuMonthNav variant="square" />
          <span className="text-xs text-gray-500 ml-2">{filteredRows.length} 件</span>
          {draftCount > 0 && (
            <span className="rounded bg-yellow-100 px-2 py-0.5 text-[11px] font-bold text-yellow-700">
              未確定 {draftCount} 件
            </span>
          )}
          <div className="ml-auto text-[11px] text-gray-500">
            レセプトの生成・確定は「介護請求」タブの「レセプト編集」から行います
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
                <th className="px-2 py-1.5 border border-gray-300 text-left">要介護度</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">認定有効期間</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">サービス内容</th>
                <th
                  className="px-2 py-1.5 border border-gray-300 text-right cursor-help underline decoration-dotted decoration-gray-400 underline-offset-2"
                  title="レセプト (基本 + 加算 − 減算) の総単位数。居宅介護支援費は区分支給限度額管理の対象外です。"
                >
                  実績単位数
                </th>
                <th className="px-2 py-1.5 border border-gray-300 text-right">保険請求額</th>
                <th className="px-2 py-1.5 border border-gray-300 text-center">状態</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const certOk = certCoversMonth(r.certStart, r.certEnd, year, month);
                return (
                  <tr key={r.user_id} className="hover:bg-blue-50">
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
                      {r.insurer_name ?? r.insurer_number ?? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                          未登録
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 border border-gray-200 font-mono">
                      {r.insured_number ?? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                          未登録
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 border border-gray-200">{r.user_name}</td>
                    <td className="px-2 py-1 border border-gray-200">{r.care_level ?? "-"}</td>
                    <td className="px-2 py-1 border border-gray-200 font-mono whitespace-nowrap">
                      {r.certStart ?? "?"} 〜 {r.certEnd ?? "?"}
                    </td>
                    <td className="px-2 py-1 border border-gray-200 truncate max-w-[200px]" title={r.serviceName}>
                      {r.serviceName}
                    </td>
                    <td className="px-2 py-1 border border-gray-200 text-right font-mono">
                      {r.totalUnits.toLocaleString()}
                    </td>
                    <td className="px-2 py-1 border border-gray-200 text-right font-mono">
                      {r.insuranceAmount.toLocaleString()}
                    </td>
                    <td className="px-2 py-1 border border-gray-200 text-center">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${STATUS_CLS[r.claimStatus]}`}>
                        {STATUS_LABELS[r.claimStatus]}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-center text-gray-400 text-sm">
                    対象月のレセプトがありません (「介護請求」タブの「レセプト編集」から一括生成できます)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* フッター合計 (billing-visit 月次情報タブと同トーン) */}
        <div className="border-t border-gray-300 bg-gray-50 px-3 py-2 shrink-0 text-[11px] text-gray-700">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span>
              件数 <strong className="font-mono">{filteredRows.length.toLocaleString()}</strong>
            </span>
            <span>
              実績単位数合計 <strong className="font-mono">{totalUnits.toLocaleString()}</strong>
            </span>
            <span>
              保険請求額合計 <strong className="font-mono">¥{totalAmount.toLocaleString()}</strong>
            </span>
            <span className="text-gray-500">
              ※ 居宅介護支援費は 10 割給付 (利用者負担 0 円)
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
