"use client";

/**
 * 障害請求 — 障害福祉サービスの月次請求集計 + 国保連 CSV
 *
 * 左: 利用者一覧 (受給者証番号 / 名前 / 区分 / 総単位数 / 給付費請求額 / 負担額)
 * 右: 明細 (サービス種類 / コード / 単位数 / 回数)
 * 出力: 国保連請求 CSV (J121 明細書 相当の項目)
 */

import { useMemo, useState, useEffect, useCallback } from "react";
import { Loader2, Accessibility, AlertCircle, Download } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { MonthNav } from "../_shared/month-nav";
import {
  aggregateMonthlyShogaiSeikyu,
  buildShogaiSeikyuCsv,
  type ShogaiSeikyuRow,
} from "@/lib/shogai-seikyu/aggregate";

export function ShogaiSeikyuContent() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, loading: btLoading } = useBusinessType();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [rows, setRows] = useState<ShogaiSeikyuRow[]>([]);
  const [recordCount, setRecordCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let unitPrice: number | undefined;
      if (currentOffice) {
        const { data: o } = await supabase
          .from("offices")
          .select("unit_price")
          .eq("id", currentOffice.id)
          .maybeSingle();
        unitPrice = (o as { unit_price?: number } | null)?.unit_price;
      }
      const result = await aggregateMonthlyShogaiSeikyu(supabase, {
        year,
        month,
        unitPrice,
      });
      setRows(result.rows);
      setRecordCount(result.recordCount);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, currentOffice, year, month]);

  useEffect(() => {
    if (btLoading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/月変更時の fetch
    load();
  }, [btLoading, load]);

  const selected = rows.find((r) => r.user_id === selectedUserId) ?? rows[0] ?? null;
  const totalUnits = rows.reduce((s, r) => s + r.totalUnits, 0);
  const totalBenefit = rows.reduce((s, r) => s + r.benefitAmount, 0);
  const totalUser = rows.reduce((s, r) => s + r.userAmount, 0);

  const exportCsv = () => {
    const csv = buildShogaiSeikyuCsv(rows, year, month);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `shogai_seikyu_${year}${String(month).padStart(2, "0")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <Accessibility size={20} className="text-violet-600" />
            障害請求
          </h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {currentOffice?.name ?? ""} — 障害福祉サービス実績 (確定) の月次集計と国保連請求 CSV
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MonthNav
            year={year}
            month={month}
            onChange={(y, m) => {
              setYear(y);
              setMonth(m);
            }}
          />
          <button
            type="button"
            disabled={rows.length === 0}
            onClick={exportCsv}
            className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            title="国保連請求 CSV (明細書相当) を出力"
          >
            <Download size={14} />
            請求CSV
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {loading || btLoading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 size={20} className="mr-2 animate-spin" />
          集計中...
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-gray-50 p-12 text-center text-sm text-gray-500">
          対象月の実績 (確定) がありません。障害福祉 → サービス提供実績 で記録を確定してください。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {/* 左: 利用者一覧 */}
          <div className="lg:col-span-3 overflow-hidden rounded-lg border bg-white shadow-sm">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-600">
                <tr>
                  <th className="px-3 py-2">受給者証番号</th>
                  <th className="px-3 py-2">利用者名</th>
                  <th className="px-3 py-2">区分</th>
                  <th className="px-3 py-2 text-right">総単位数</th>
                  <th className="px-3 py-2 text-right">給付費請求額</th>
                  <th className="px-3 py-2 text-right">利用者負担</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr
                    key={r.user_id}
                    onClick={() => setSelectedUserId(r.user_id)}
                    className={
                      "cursor-pointer transition-colors " +
                      (selected?.user_id === r.user_id
                        ? "bg-violet-50"
                        : "hover:bg-gray-50")
                    }
                  >
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.beneficiary_number ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {r.user_name}
                      {r.seiho && (
                        <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[9px] text-amber-700 ring-1 ring-amber-200">
                          生保
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{r.support_level ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.totalUnits.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-violet-700">
                      {r.benefitAmount.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.userAmount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                <tr>
                  <td className="px-3 py-2 text-xs text-gray-500" colSpan={3}>
                    合計 {rows.length} 名 / 実績 {recordCount} 件
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {totalUnits.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-violet-700">
                    {totalBenefit.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {totalUser.toLocaleString()}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* 右: 明細 */}
          <div className="lg:col-span-2 rounded-lg border bg-white shadow-sm">
            <header className="border-b bg-gray-50 px-4 py-2 text-sm font-bold text-gray-800">
              明細情報 {selected ? `— ${selected.user_name}` : ""}
            </header>
            {selected ? (
              <div className="p-3">
                <table className="min-w-full text-xs">
                  <thead className="text-left text-[10px] text-gray-500">
                    <tr>
                      <th className="px-2 py-1">サービス</th>
                      <th className="px-2 py-1">コード</th>
                      <th className="px-2 py-1 text-right">単位数</th>
                      <th className="px-2 py-1 text-right">回数</th>
                      <th className="px-2 py-1 text-right">小計</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {selected.details.map((d, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1.5">
                          {d.service_type}
                          {d.service_category && (
                            <span className="ml-1 text-[9px] text-gray-400">
                              {d.service_category}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-[10px]">
                          {d.service_code ?? "—"}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {d.unit_per.toLocaleString()}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{d.count}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-semibold">
                          {d.units.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="mt-4 space-y-1 rounded border bg-gray-50 p-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">合計単位数</span>
                    <span className="font-bold tabular-nums">
                      {selected.totalUnits.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">地域単価</span>
                    <span className="tabular-nums">
                      {selected.unitPrice.toFixed(2)} 円/単位
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">総費用額</span>
                    <span className="tabular-nums">
                      ¥{selected.totalAmount.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">
                      負担上限月額 {selected.seiho ? "(生保 = 負担なし)" : ""}
                    </span>
                    <span className="tabular-nums">
                      ¥{selected.self_payment_limit.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">利用者負担額</span>
                    <span className="font-bold tabular-nums">
                      ¥{selected.userAmount.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between text-violet-700">
                    <span className="font-bold">介護給付費請求額</span>
                    <span className="font-bold tabular-nums">
                      ¥{selected.benefitAmount.toLocaleString()}
                    </span>
                  </div>
                </div>

                {/* 上限額管理 (ほのぼのmore 上限管理事業所の登録に相当) */}
                <JogenKanriSection
                  key={`${selected.user_id}-${year}-${month}`}
                  row={selected}
                  year={year}
                  month={month}
                  onSaved={load}
                />
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-gray-400">
                左の一覧から利用者を選択
              </div>
            )}
          </div>
        </div>
      )}

      <p className="text-[11px] text-gray-400">
        ※ 「請求CSV」は国保連 介護給付費・訓練等給付費等明細書 (J121) 相当の項目を
        持つ明細 CSV。伝送ソフトの固定長 interface 仕様には取込仕様確定後に対応。
        上限管理の設定 (管理事業所の登録) は 利用者管理 → 受給者証 で行います。
      </p>
    </div>
  );
}

// ─── 利用者負担上限額管理 (月次の管理結果入力) ────────────────────────────────
function JogenKanriSection({
  row,
  year,
  month,
  onSaved,
}: {
  row: ShogaiSeikyuRow;
  year: number;
  month: number;
  onSaved: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [result, setResult] = useState<string>(row.kanriResult != null ? String(row.kanriResult) : "");
  const [amount, setAmount] = useState<string>(row.kanriResultAmount != null ? String(row.kanriResultAmount) : "");
  const [saving, setSaving] = useState(false);

  if (row.jogenKanriKubun === "なし") {
    return (
      <div className="mt-3 rounded border border-dashed bg-gray-50 px-3 py-2 text-[11px] text-gray-400">
        上限額管理: 対象外 (受給者証で管理事業所を設定すると月次の管理結果を入力できます)
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    const monthStr = `${year}-${String(month).padStart(2, "0")}`;
    const { error } = await supabase.from("shogai_jogen_kanri_results").upsert(
      {
        client_id: row.user_id,
        target_month: monthStr,
        kanri_result: result ? parseInt(result, 10) : null,
        kanri_result_amount: amount !== "" ? parseInt(amount, 10) : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id,target_month" },
    );
    setSaving(false);
    if (error) {
      alert("上限管理結果の保存に失敗しました: " + error.message);
      return;
    }
    onSaved();
  };

  return (
    <div className="mt-3 rounded border border-violet-200 bg-violet-50/50 p-3 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-bold text-violet-800">利用者負担上限額管理</span>
        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
          {row.jogenKanriKubun}が管理
        </span>
      </div>
      {row.jogenKanriKubun === "他事業所" && (
        <p className="text-[10px] text-gray-500">
          管理事業所: {row.jogenKanriOfficeName ?? "未設定"}
          {row.jogenKanriOfficeNumber ? ` (${row.jogenKanriOfficeNumber})` : ""}
          — 管理結果票を受領したら下に入力してください
        </p>
      )}
      <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
        <div>
          <label className="mb-0.5 block text-[10px] text-gray-500">管理結果区分</label>
          <select
            value={result}
            onChange={(e) => setResult(e.target.value)}
            className="w-full rounded border px-2 py-1.5 text-xs focus:border-violet-500 focus:outline-none"
          >
            <option value="">未入力</option>
            <option value="1">1: 管理事業所で充当 (他は負担なし)</option>
            <option value="2">2: 合算が上限以下 (調整なし)</option>
            <option value="3">3: 管理結果票のとおり調整</option>
          </select>
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] text-gray-500">調整後負担額</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={result === "2" || result === ""}
            placeholder="円"
            className="w-24 rounded border px-2 py-1.5 text-right text-xs tabular-nums focus:border-violet-500 focus:outline-none disabled:bg-gray-100"
          />
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
      <p className="text-[10px] text-gray-400">
        区分 1・3 は調整後負担額が利用者負担額・給付費請求額に反映されます。
      </p>
    </div>
  );
}
