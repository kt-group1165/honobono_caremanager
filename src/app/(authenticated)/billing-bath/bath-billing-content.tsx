"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { aggregateBathVisitSeikyu } from "@/lib/bath-seikyu/aggregate";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import { buildKokuhoDensou, type DensouRow } from "@/lib/kokuho-densou/build";
import Encoding from "encoding-japanese";
import { ChevronLeft, ChevronRight, Loader2, Download, Droplets, AlertTriangle } from "lucide-react";

function downloadSjis(content: string, fileName: string) {
  const sjis = Encoding.convert(Encoding.stringToCode(content), { to: "SJIS", from: "UNICODE" });
  const blob = new Blob([new Uint8Array(sjis)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function BathBillingContent() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, currentOfficeId } = useBusinessType();

  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [rows, setRows] = useState<UserSeikyuRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [officeNumber, setOfficeNumber] = useState<string | null>(null);
  const [unitPrice, setUnitPrice] = useState(10);

  const load = useCallback(async () => {
    if (!currentOfficeId) return;
    setLoading(true);
    try {
      const [y, m] = month.split("-").map(Number);
      const { data: office } = await supabase
        .from("offices")
        .select("unit_price, business_number, applied_formula_codes")
        .eq("id", currentOfficeId)
        .maybeSingle();
      const up = (office?.unit_price as number | null) ?? 10;
      const bn = (office?.business_number as string | null) ?? null;
      const codes = (office?.applied_formula_codes as string[] | null) ?? [];
      setUnitPrice(up);
      setOfficeNumber(bn);
      const result = await aggregateBathVisitSeikyu(supabase, {
        officeId: currentOfficeId,
        tenantId: currentOffice?.tenant_id ?? "kt-group",
        year: y,
        month: m,
        unitPrice: up,
        appliedFormulaCodes: codes,
      });
      setRows(result.rows);
      setWarnings(result.warnings);
    } catch (e) {
      console.error("入浴請求の集計に失敗:", e);
      alert("集計に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [supabase, currentOfficeId, currentOffice, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/月変更時の async fetch
    load();
  }, [load]);

  const prevMonth = () => { const [y, m] = month.split("-").map(Number); const d = new Date(y, m - 2, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const nextMonth = () => { const [y, m] = month.split("-").map(Number); const d = new Date(y, m, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };

  const totals = useMemo(() => ({
    units: rows.reduce((s, r) => s + r.totalUnits, 0),
    insurance: rows.reduce((s, r) => s + r.insuranceAmount, 0),
    user: rows.reduce((s, r) => s + r.userAmount, 0),
  }), [rows]);

  const exportDensou = () => {
    if (rows.length === 0) { alert("対象データがありません"); return; }
    if (!officeNumber) { alert("事業所番号(business_number)が未設定です。設定画面で登録してください。"); return; }
    const [y, m] = month.split("-").map(Number);
    const result = buildKokuhoDensou(rows as DensouRow[], {
      officeNumber,
      year: y,
      month: m,
      unitPrice,
    });
    if (result.warnings.length) console.warn("伝送 warnings:", result.warnings);
    downloadSjis(result.content, result.fileName);
  };

  if (!currentOfficeId) {
    return <div className="p-8 text-sm text-gray-400">訪問入浴事業所を選択してください。</div>;
  }
  const [y, m] = month.split("-").map(Number);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col bg-white">
      <div className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2 shrink-0">
        <Droplets size={18} className="text-cyan-600" />
        <h1 className="text-sm font-semibold text-gray-800">訪問入浴 請求</h1>
        <div className="flex items-center gap-0.5 rounded border border-gray-300 bg-white px-2 py-1">
          <button onClick={prevMonth} className="text-gray-500 hover:text-gray-800"><ChevronLeft size={14} /></button>
          <span className="px-1.5 text-sm font-semibold text-gray-800">{y}年{m}月</span>
          <button onClick={nextMonth} className="text-gray-500 hover:text-gray-800"><ChevronRight size={14} /></button>
        </div>
        <span className="text-xs text-gray-400">{rows.length}名 / 単価 {unitPrice}</span>
        <button
          onClick={exportDensou}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
        >
          <Download size={14} />伝送(J)CSV出力
        </button>
      </div>

      {warnings.length > 0 && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>{warnings.slice(0, 5).map((w, i) => <div key={i}>{w}</div>)}{warnings.length > 5 && <div>ほか {warnings.length - 5}件</div>}</div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-cyan-400" /></div>
        ) : rows.length === 0 ? (
          <p className="py-16 text-center text-sm text-gray-400">この月の確定済み入浴実績がありません（記録を「確定」にすると集計されます）</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-gray-100 text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">利用者</th>
                <th className="px-3 py-2 text-left font-semibold">被保険者番号</th>
                <th className="px-3 py-2 text-left font-semibold">要介護度</th>
                <th className="px-3 py-2 text-right font-semibold">実日数</th>
                <th className="px-3 py-2 text-right font-semibold">総単位数</th>
                <th className="px-3 py-2 text-right font-semibold">保険請求額</th>
                <th className="px-3 py-2 text-right font-semibold">利用者負担</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.user_id} className="hover:bg-gray-50">
                  <td className="px-3 py-1.5 font-medium text-gray-800">{r.user_name}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-600">{r.insured_number ?? "—"}</td>
                  <td className="px-3 py-1.5 text-gray-600">{r.care_level ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{r.serviceDays}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-800">{r.totalUnits.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-gray-800">¥{r.insuranceAmount.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">¥{r.userAmount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="sticky bottom-0 bg-gray-50 font-semibold">
              <tr className="border-t-2 border-gray-300">
                <td className="px-3 py-2 text-gray-700" colSpan={4}>合計</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-800">{totals.units.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-800">¥{totals.insurance.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">¥{totals.user.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      <div className="border-t border-gray-100 bg-gray-50 px-4 py-1.5 text-[11px] text-gray-400 shrink-0">
        v1: 基本(全身/部分×職員のみ)＋処遇改善(月次)。初回/認知症/中山間加算・限度額超過・公費は今後対応。
      </div>
    </div>
  );
}
