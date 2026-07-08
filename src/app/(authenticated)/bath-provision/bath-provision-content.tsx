"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { validInMonth, monthRange } from "@/lib/service-code-valid";
import { ChevronLeft, ChevronRight, Loader2, Printer, Droplets } from "lucide-react";

// 訪問入浴の提供表 固定サービス行 (全身/部分 × 職員のみ)
const BATH_ROWS = [
  { code: "121111", label: "訪問入浴（全身浴）", bath_type: "全身浴" as const, staff_only: false },
  { code: "121121", label: "訪問入浴（全身浴・職員のみ）", bath_type: "全身浴" as const, staff_only: true },
  { code: "121112", label: "訪問入浴（部分浴・清拭）", bath_type: "部分浴" as const, staff_only: false },
  { code: "121122", label: "訪問入浴（部分浴・職員のみ）", bath_type: "部分浴" as const, staff_only: true },
];

type Rec = { id: string; visit_date: string; service_code: string | null; planned: boolean; actual: boolean };

const WD = ["日", "月", "火", "水", "木", "金", "土"];

export function BathProvisionContent({ userId, userName }: { userId: string; userName: string | null }) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, currentOfficeId } = useBusinessType();

  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [records, setRecords] = useState<Rec[]>([]);
  const [unitByCode, setUnitByCode] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [busyCell, setBusyCell] = useState<string | null>(null);

  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = useMemo(() => Array.from({ length: daysInMonth }, (_, i) => i + 1), [daysInMonth]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { monthStart, monthEnd } = monthRange(y, m);
      const recQ = supabase
        .from("kaigo_bath_visit_records")
        .select("id, visit_date, service_code, planned, actual")
        .eq("client_id", userId)
        .gte("visit_date", monthStart)
        .lte("visit_date", monthEnd);
      const { data: recData, error: recErr } = currentOfficeId ? await recQ.eq("office_id", currentOfficeId) : await recQ;
      if (recErr) throw recErr;
      setRecords((recData ?? []) as Rec[]);

      const { data: uData } = await validInMonth(
        supabase.from("kaigo_service_codes").select("service_code, units").in("service_code", BATH_ROWS.map((r) => r.code)).eq("system", "介護"),
        y,
        m,
      );
      const um: Record<string, number> = {};
      for (const u of (uData ?? []) as { service_code: string; units: number }[]) if (um[u.service_code] == null) um[u.service_code] = u.units;
      setUnitByCode(um);
    } catch (e) {
      console.error("提供表の読込に失敗:", e);
      alert("読込に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [supabase, userId, currentOfficeId, y, m]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/月変更時の async fetch
    load();
  }, [load]);

  // (code, day) → その日の record (1件想定)
  const recByCell = useMemo(() => {
    const map = new Map<string, Rec>();
    for (const rec of records) {
      const day = Number(rec.visit_date.slice(8, 10));
      map.set(`${rec.service_code ?? ""}-${day}`, rec);
    }
    return map;
  }, [records]);

  const prevMonth = () => { const d = new Date(y, m - 2, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const nextMonth = () => { const d = new Date(y, m, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };

  // 予定/実績 セルの toggle。実績ONは予定も立てる(ほのぼの準拠)。両方offで削除。
  const toggle = async (row: (typeof BATH_ROWS)[number], day: number, which: "planned" | "actual") => {
    if (!currentOfficeId) { alert("事業所を選択してください"); return; }
    const key = `${row.code}-${day}`;
    setBusyCell(key);
    try {
      const rec = recByCell.get(key);
      if (!rec) {
        const planned = true;
        const actual = which === "actual";
        const { data, error } = await supabase
          .from("kaigo_bath_visit_records")
          .insert({
            client_id: userId,
            office_id: currentOfficeId,
            tenant_id: currentOffice?.tenant_id ?? "kt-group",
            visit_date: `${month}-${String(day).padStart(2, "0")}`,
            bath_type: row.bath_type,
            staff_only: row.staff_only,
            service_code: row.code,
            status: "confirmed",
            planned,
            actual,
          })
          .select("id, visit_date, service_code, planned, actual")
          .single();
        if (error) throw error;
        setRecords((prev) => [...prev, data as Rec]);
      } else {
        let planned = rec.planned;
        let actual = rec.actual;
        if (which === "planned") planned = !planned;
        else { actual = !actual; if (actual) planned = true; }
        if (!planned && !actual) {
          const { error } = await supabase.from("kaigo_bath_visit_records").delete().eq("id", rec.id);
          if (error) throw error;
          setRecords((prev) => prev.filter((r) => r.id !== rec.id));
        } else {
          const { error } = await supabase.from("kaigo_bath_visit_records").update({ planned, actual }).eq("id", rec.id);
          if (error) throw error;
          setRecords((prev) => prev.map((r) => (r.id === rec.id ? { ...r, planned, actual } : r)));
        }
      }
    } catch (e) {
      alert("更新に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyCell(null);
    }
  };

  const counts = useCallback(
    (code: string) => {
      let planned = 0;
      let actual = 0;
      for (const d of days) {
        const rec = recByCell.get(`${code}-${d}`);
        if (rec?.planned) planned++;
        if (rec?.actual) actual++;
      }
      return { planned, actual };
    },
    [days, recByCell],
  );

  const summary = useMemo(() => {
    const rows = BATH_ROWS.map((r) => {
      const c = counts(r.code);
      const unit = unitByCode[r.code] ?? 0;
      return { ...r, planned: c.planned, actual: c.actual, unit, actualUnits: c.actual * unit };
    });
    const totalActual = rows.reduce((s, r) => s + r.actual, 0);
    const totalUnits = rows.reduce((s, r) => s + r.actualUnits, 0);
    const daysUsed = new Set(records.filter((r) => r.actual).map((r) => r.visit_date)).size;
    return { rows, totalActual, totalUnits, daysUsed };
  }, [counts, unitByCode, records]);

  const cellCls = (on: boolean, which: "planned" | "actual") =>
    on
      ? which === "planned"
        ? "bg-blue-100 font-semibold text-blue-800"
        : "bg-green-100 font-semibold text-green-800"
      : "text-gray-300";

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-white">
      <div className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2 shrink-0 no-print">
        <Droplets size={18} className="text-cyan-600" />
        <h1 className="text-sm font-semibold text-gray-800">訪問入浴 サービス提供表（実績）</h1>
        <span className="text-sm text-gray-600">{userName ?? ""} 様</span>
        <div className="flex items-center gap-0.5 rounded border border-gray-300 bg-white px-2 py-1">
          <button onClick={prevMonth} className="text-gray-500 hover:text-gray-800"><ChevronLeft size={14} /></button>
          <span className="px-1.5 text-sm font-semibold text-gray-800">{y}年{m}月</span>
          <button onClick={nextMonth} className="text-gray-500 hover:text-gray-800"><ChevronRight size={14} /></button>
        </div>
        <span className="text-xs text-gray-400">実日数 {summary.daysUsed}日 / {summary.totalUnits.toLocaleString()}単位</span>
        <button onClick={() => window.print()} className="ml-auto flex items-center gap-1 rounded-lg bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800">
          <Printer size={14} />印刷
        </button>
      </div>

      <p className="border-b border-gray-100 bg-cyan-50 px-4 py-1 text-[11px] text-cyan-700 no-print">
        予定/実績のセルをクリックで「1」を入力/削除できます（実績を入れると予定にも計上）。詳細な入浴記録・バイタルは「入浴実施記録」で編集。
      </p>

      <div className="flex-1 overflow-auto p-3" id="bath-provision-print">
        <div className="mb-2 hidden text-sm font-bold print:block">
          訪問入浴 サービス提供表（実績）　{y}年{m}月　{userName ?? ""} 様
        </div>
        {loading ? (
          <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-cyan-400" /></div>
        ) : (
          <>
            <table className="border-collapse text-center text-[11px]">
              <thead>
                <tr className="bg-gray-100">
                  <th className="sticky left-0 z-10 border border-gray-300 bg-gray-100 px-2 py-1 text-left" style={{ minWidth: 170 }}>サービス内容</th>
                  <th className="border border-gray-300 px-1 py-1" style={{ minWidth: 34 }}>区分</th>
                  {days.map((d) => {
                    const wd = new Date(y, m - 1, d).getDay();
                    return (
                      <th key={d} className={`border border-gray-300 px-0.5 py-1 ${wd === 0 ? "text-red-500" : wd === 6 ? "text-blue-500" : "text-gray-600"}`} style={{ minWidth: 22 }}>
                        <div>{d}</div>
                        <div className="text-[9px]">{WD[wd]}</div>
                      </th>
                    );
                  })}
                  <th className="border border-gray-300 px-2 py-1" style={{ minWidth: 34 }}>回数</th>
                  <th className="border border-gray-300 px-2 py-1" style={{ minWidth: 54 }}>単位</th>
                </tr>
              </thead>
              {BATH_ROWS.map((row) => {
                const c = counts(row.code);
                const unit = unitByCode[row.code] ?? 0;
                return (
                  <tbody key={row.code}>
                    {/* 予定 */}
                    <tr>
                      <td rowSpan={2} className="sticky left-0 z-10 border border-gray-300 bg-white px-2 py-1 text-left align-middle">{row.label}</td>
                      <td className="border border-gray-300 bg-blue-50 px-1 py-1 text-[10px] text-blue-700">予定</td>
                      {days.map((d) => {
                        const rec = recByCell.get(`${row.code}-${d}`);
                        const key = `${row.code}-${d}`;
                        return (
                          <td key={d} onClick={() => busyCell === null && toggle(row, d, "planned")} className={`cursor-pointer border border-gray-200 px-0.5 py-1 hover:bg-blue-50 ${cellCls(!!rec?.planned, "planned")}`}>
                            {busyCell === key ? "…" : rec?.planned ? "1" : ""}
                          </td>
                        );
                      })}
                      <td className="border border-gray-300 px-2 py-1 text-blue-700">{c.planned || ""}</td>
                      <td rowSpan={2} className="border border-gray-300 px-2 py-1 align-middle tabular-nums text-gray-600">{c.actual > 0 ? (c.actual * unit).toLocaleString() : ""}</td>
                    </tr>
                    {/* 実績 */}
                    <tr>
                      <td className="border border-gray-300 bg-green-50 px-1 py-1 text-[10px] text-green-700">実績</td>
                      {days.map((d) => {
                        const rec = recByCell.get(`${row.code}-${d}`);
                        const key = `${row.code}-${d}`;
                        return (
                          <td key={d} onClick={() => busyCell === null && toggle(row, d, "actual")} className={`cursor-pointer border border-gray-200 px-0.5 py-1 hover:bg-green-50 ${cellCls(!!rec?.actual, "actual")}`}>
                            {busyCell === key ? "…" : rec?.actual ? "1" : ""}
                          </td>
                        );
                      })}
                      <td className="border border-gray-300 px-2 py-1 font-semibold text-green-700">{c.actual || ""}</td>
                    </tr>
                  </tbody>
                );
              })}
            </table>

            {/* 単位数集計 */}
            <div className="mt-4 max-w-lg">
              <div className="mb-1 text-xs font-semibold text-gray-600">単位数集計（実績）</div>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-gray-100 text-gray-600">
                    <th className="border border-gray-300 px-2 py-1 text-left">サービス内容</th>
                    <th className="border border-gray-300 px-2 py-1 text-right">予定</th>
                    <th className="border border-gray-300 px-2 py-1 text-right">実績</th>
                    <th className="border border-gray-300 px-2 py-1 text-right">単位/回</th>
                    <th className="border border-gray-300 px-2 py-1 text-right">実績単位計</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.rows.map((r) => (
                    <tr key={r.code}>
                      <td className="border border-gray-300 px-2 py-1 text-left">{r.label}</td>
                      <td className="border border-gray-300 px-2 py-1 text-right tabular-nums text-gray-500">{r.planned}</td>
                      <td className="border border-gray-300 px-2 py-1 text-right tabular-nums">{r.actual}</td>
                      <td className="border border-gray-300 px-2 py-1 text-right tabular-nums">{r.unit || "—"}</td>
                      <td className="border border-gray-300 px-2 py-1 text-right tabular-nums font-semibold">{r.actualUnits.toLocaleString()}</td>
                    </tr>
                  ))}
                  <tr className="bg-gray-50 font-semibold">
                    <td className="border border-gray-300 px-2 py-1 text-left">合計</td>
                    <td className="border border-gray-300 px-2 py-1"></td>
                    <td className="border border-gray-300 px-2 py-1 text-right tabular-nums">{summary.totalActual}</td>
                    <td className="border border-gray-300 px-2 py-1"></td>
                    <td className="border border-gray-300 px-2 py-1 text-right tabular-nums">{summary.totalUnits.toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-gray-400">※ 処遇改善加算等の月次加算は「請求」画面で自動計上されます。</p>
            </div>
          </>
        )}
      </div>

      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #bath-provision-print, #bath-provision-print * { visibility: visible !important; }
          #bath-provision-print { position: fixed; inset: 0; padding: 6mm; background: white; overflow: visible; }
          .no-print { display: none !important; }
          @page { size: A4 landscape; margin: 6mm; }
          table { border-collapse: collapse; font-size: 7pt; }
          th, td { border: 1px solid #333 !important; padding: 0.5mm 1mm !important; }
        }
      `}</style>
    </div>
  );
}
