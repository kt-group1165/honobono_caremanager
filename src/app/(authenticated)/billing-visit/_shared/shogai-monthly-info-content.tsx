"use client";

/**
 * 障害・月次情報 — 障害福祉サービスの請求前チェック一覧
 * (介護の MonthlyInfoContent と同じ見た目。障害は「計画単位数」ではなく
 *  受給者証の支給量・上限額が基準なので読み取り専用の警告一覧)
 *
 * 左: あかさたな索引 / 中央: ◀ 年月 ▶ ツールバー + 格子テーブル。
 * 列構成:
 *   認定 / 市町村 / 受給者証番号 / 利用者名 / 障害支援区分 /
 *   上限額管理 (区分 + 管理事業所) / 負担上限月額 / 総単位数 (実績)
 *
 * 警告バッジ (目視確認用):
 *   - 認定有効期間が対象月に掛からない → 認定列に赤「認定切れ」
 *   - 受給者証番号 未設定 → 受給者証番号列に橙「受給者証未設定」
 *   - 負担上限月額 未設定 (null) → 負担上限列に橙「上限額未設定」
 *   - 上限額管理あり (なし以外) で管理結果未入力 → 上限管理列に橙「管理結果待ち」
 *   - 支給量超過 (受給者証 支給量 < 実績) → 実績列に赤「支給量超過」
 *
 * データは SeikyuProvider が集計済みの filteredShogaiRows を共有 (fetch なし)。
 */

import { Loader2, AlertCircle } from "lucide-react";
import { monthRange } from "@/lib/cert-for-month";
import { useSeikyuContext, SeikyuKanaSidebar, SeikyuMonthNav } from "./seikyu-context";

// 認定有効期間 (certStart〜certEnd) が対象月に掛かるか (MonthlyInfoContent と同判定)。
function certCoversMonth(
  certStart: string | null,
  certEnd: string | null,
  year: number,
  month: number,
): boolean {
  const { from: monthStart, to: monthEnd } = monthRange(year, month);
  if (certStart && certStart > monthEnd) return false;
  if (certEnd && certEnd < monthStart) return false;
  return true;
}

export function ShogaiMonthlyInfoContent() {
  const { year, month, filteredShogaiRows, loading, error } = useSeikyuContext();

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={22} className="animate-spin text-indigo-400" />
      </div>
    );
  }

  const rows = filteredShogaiRows;
  const totalUnits = rows.reduce((s, r) => s + r.totalUnits, 0);

  return (
    <div className="flex flex-1 min-h-0">
      {/* 左: かな行フィルター */}
      <SeikyuKanaSidebar />

      {/* 中央: ツールバー + テーブル */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2">
          <SeikyuMonthNav variant="square" />
          <span className="text-xs text-gray-500 ml-2">{rows.length} 件</span>
          <span className="ml-auto text-[11px] text-gray-400">
            受給者証 (支給量・上限額) 基準の請求前チェック
          </span>
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
                <th className="px-2 py-1.5 border border-gray-300 text-left">認定</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">市町村</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">受給者証番号</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">利用者名</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">障害支援区分</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">上限額管理</th>
                <th className="px-2 py-1.5 border border-gray-300 text-right">負担上限月額</th>
                <th
                  className="px-2 py-1.5 border border-gray-300 text-right cursor-help underline decoration-dotted decoration-gray-400 underline-offset-2"
                  title="対象月の確定実績から集計した総単位数 (所定+加算)。受給者証の支給量を超えた分は原則保険請求できません。"
                >
                  総単位数 (実績)
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const certOk = certCoversMonth(r.certStart, r.certEnd, year, month);
                const hasBeneficiary = !!r.beneficiary_number;
                const limitUnset = r.self_payment_limit === null;
                const kanriOn = r.jogenKanriKubun !== "なし";
                const kanriPending = kanriOn && r.kanriResult === null;
                const over = r.shikyuryoOver.length > 0;
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
                    <td className="px-2 py-1 border border-gray-200 font-mono">
                      {r.municipality ?? "-"}
                    </td>
                    <td className="px-2 py-1 border border-gray-200 font-mono">
                      {hasBeneficiary ? (
                        r.beneficiary_number
                      ) : (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                          受給者証未設定
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 border border-gray-200">{r.user_name}</td>
                    <td className="px-2 py-1 border border-gray-200">
                      {r.support_level ?? "-"}
                    </td>
                    <td
                      className="px-2 py-1 border border-gray-200 truncate max-w-[200px]"
                      title={r.jogenKanriOfficeName ?? ""}
                    >
                      {r.jogenKanriKubun === "なし" ? (
                        <span className="text-gray-400">なし</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          {r.jogenKanriKubun}
                          {r.jogenKanriKubun === "他事業所" && r.jogenKanriOfficeName && (
                            <span className="text-gray-500">({r.jogenKanriOfficeName})</span>
                          )}
                          {kanriPending && (
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                              管理結果待ち
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 border border-gray-200 text-right font-mono">
                      {r.seiho ? (
                        <span className="text-gray-500">0 (生保)</span>
                      ) : limitUnset ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                          上限額未設定
                        </span>
                      ) : (
                        `${r.self_payment_limit!.toLocaleString()} 円`
                      )}
                    </td>
                    <td className="px-2 py-1 border border-gray-200 text-right font-mono whitespace-nowrap">
                      {r.totalUnits.toLocaleString()}
                      {over && (
                        <span
                          title={`受給者証の支給量を超えています: ${r.shikyuryoOver.join(" / ")}`}
                          className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700"
                        >
                          支給量超過
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-gray-400 text-sm">
                    対象月の障害福祉サービス実績 (確定) がありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* フッター合計 */}
        <div className="border-t border-gray-300 bg-gray-50 px-3 py-2 shrink-0 text-[11px] text-gray-700">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span>
              件数 <strong className="font-mono">{rows.length.toLocaleString()}</strong>
            </span>
            <span>
              総単位数合計 <strong className="font-mono">{totalUnits.toLocaleString()}</strong>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
