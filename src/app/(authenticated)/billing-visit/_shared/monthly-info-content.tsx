"use client";

/**
 * 月次情報 — 訪問介護の請求前チェック一覧 (参考: order-app 月次情報タブ)
 *
 * 対象月の請求対象利用者を一覧し、請求前に目視で確認したい項目を並べる:
 *   保険者番号 / 被保険者番号 / 利用者名 / 要介護度 / 認定有効期間 /
 *   担当居宅事業所番号 / 作成区分 / 単位数
 *
 * 警告バッジ (目視確認用):
 *   - 認定有効期間が対象月に掛からない → 赤「認定切れ」
 *   - 担当居宅事業所番号が未設定 → 橙「担当居宅未設定」
 */

import { Loader2, AlertCircle, ClipboardList } from "lucide-react";
import { useSeikyuContext } from "./seikyu-context";

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
  const { year, month, rows, recordCount, loading, error, officeName } =
    useSeikyuContext();

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500 print:hidden">
        {officeName ?? ""} — 請求前チェック (認定有効期間 / 担当居宅 / 単位数)。
        赤・橙のバッジは目視確認してください。
      </p>

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
          <ClipboardList size={24} className="mx-auto mb-2 text-gray-300" />
          対象月の実績 (完了) がありません
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-blue-100 text-left text-xs font-medium text-blue-900">
                <tr>
                  <th className="px-3 py-2">保険者番号</th>
                  <th className="px-3 py-2">被保険者番号</th>
                  <th className="px-3 py-2">利用者名</th>
                  <th className="px-3 py-2">要介護度</th>
                  <th className="px-3 py-2">認定有効期間</th>
                  <th className="px-3 py-2">担当居宅事業所番号</th>
                  <th className="px-3 py-2">作成区分</th>
                  <th className="px-3 py-2 text-right">単位数</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => {
                  const certOk = certCoversMonth(
                    r.certStart,
                    r.certEnd,
                    year,
                    month,
                  );
                  const hasCareOffice = !!r.careOfficeNumber;
                  return (
                    <tr key={r.user_id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono text-xs">
                        {r.insurer_number ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {r.insured_number ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-medium">{r.user_name}</td>
                      <td className="px-3 py-2 text-xs">
                        {r.care_level ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
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
                      <td className="px-3 py-2 font-mono text-xs">
                        {hasCareOffice ? (
                          r.careOfficeNumber
                        ) : (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                            担当居宅未設定
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {hasCareOffice ? "居宅介護支援事業者作成" : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.totalUnits.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                <tr>
                  <td
                    className="px-3 py-2 text-xs text-gray-500"
                    colSpan={7}
                  >
                    {rows.length} 名 / 実績 {recordCount} 件
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {rows
                      .reduce((s, r) => s + r.totalUnits, 0)
                      .toLocaleString()}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
