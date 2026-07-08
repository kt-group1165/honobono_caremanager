"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { validInMonth, monthRange } from "@/lib/service-code-valid";
import { registerNavGuard } from "@/lib/nav-guard";
import { ChevronLeft, ChevronRight, Loader2, Printer, Droplets, Plus, Search, X, Save } from "lucide-react";

// 訪問入浴の提供表 固定サービス行 (全身/部分 × 職員のみ)
const BATH_ROWS = [
  { code: "121111", label: "訪問入浴（全身浴）", bath_type: "全身浴" as const, staff_only: false },
  { code: "121121", label: "訪問入浴（全身浴・職員のみ）", bath_type: "全身浴" as const, staff_only: true },
  { code: "121112", label: "訪問入浴（部分浴・清拭）", bath_type: "部分浴" as const, staff_only: false },
  { code: "121122", label: "訪問入浴（部分浴・職員のみ）", bath_type: "部分浴" as const, staff_only: true },
];
const BASE_CODES = new Set(BATH_ROWS.map((r) => r.code));

type Rec = {
  id: string; // 未保存の新規セルは "tmp-<code>-<day>"
  visit_date: string;
  service_code: string | null;
  planned: boolean;
  actual: boolean;
  // 新規 insert 用 (ローカル作成セルのみ保持。読込済セルは undefined)
  bath_type?: "全身浴" | "部分浴";
  staff_only?: boolean;
};
type Row = { code: string; label: string; bath_type: "全身浴" | "部分浴"; staff_only: boolean };

const WD = ["日", "月", "火", "水", "木", "金", "土"];

export function BathProvisionContent({ userId, userName }: { userId: string; userName: string | null }) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, currentOfficeId } = useBusinessType();

  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [records, setRecords] = useState<Rec[]>([]); // 編集中 (ローカル作業コピー)
  const [savedRecords, setSavedRecords] = useState<Rec[]>([]); // サーバ確定スナップショット
  const [unitByCode, setUnitByCode] = useState<Record<string, number>>({});
  const [nameByCode, setNameByCode] = useState<Record<string, string>>({});
  const [extraCodes, setExtraCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  // dirty の最新値を guard/ハンドラの closure から参照するための ref
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = useMemo(() => Array.from({ length: daysInMonth }, (_, i) => i + 1), [daysInMonth]);

  // 指定コードの単位/名称をマスタから補完
  const ensureCodes = useCallback(
    async (codes: string[]) => {
      const need = codes.filter((c) => c && unitByCode[c] == null);
      if (need.length === 0) return;
      const { data } = await validInMonth(
        supabase.from("kaigo_service_codes").select("service_code, service_name, units").in("service_code", need).eq("system", "介護"),
        y,
        m,
      );
      const um: Record<string, number> = {};
      const nm: Record<string, string> = {};
      for (const u of (data ?? []) as { service_code: string; service_name: string; units: number }[]) {
        if (um[u.service_code] == null) { um[u.service_code] = u.units; nm[u.service_code] = u.service_name; }
      }
      setUnitByCode((prev) => ({ ...um, ...prev }));
      setNameByCode((prev) => ({ ...nm, ...prev }));
    },
    [supabase, unitByCode, y, m],
  );

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
      const recs = (recData ?? []) as Rec[];
      setRecords(recs);
      setSavedRecords(recs);
      setDirty(false);

      const codes = Array.from(new Set([...BATH_ROWS.map((r) => r.code), ...recs.map((r) => r.service_code).filter(Boolean) as string[]]));
      const { data: uData } = await validInMonth(
        supabase.from("kaigo_service_codes").select("service_code, service_name, units").in("service_code", codes).eq("system", "介護"),
        y,
        m,
      );
      const um: Record<string, number> = {};
      const nm: Record<string, string> = {};
      for (const u of (uData ?? []) as { service_code: string; service_name: string; units: number }[]) {
        if (um[u.service_code] == null) { um[u.service_code] = u.units; nm[u.service_code] = u.service_name; }
      }
      setUnitByCode(um);
      setNameByCode(nm);
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

  // 表示行 = 固定4行 + (実績にあるコード + 追加コード) のうち非固定
  const displayRows = useMemo<Row[]>(() => {
    const extra = new Set<string>();
    for (const c of extraCodes) if (!BASE_CODES.has(c)) extra.add(c);
    for (const r of records) { const c = r.service_code; if (c && !BASE_CODES.has(c)) extra.add(c); }
    const extraRows: Row[] = Array.from(extra).sort().map((code) => ({ code, label: nameByCode[code] ?? code, bath_type: "全身浴", staff_only: false }));
    return [...BATH_ROWS, ...extraRows];
  }, [extraCodes, records, nameByCode]);

  const recByCell = useMemo(() => {
    const map = new Map<string, Rec>();
    for (const rec of records) {
      const day = Number(rec.visit_date.slice(8, 10));
      map.set(`${rec.service_code ?? ""}-${day}`, rec);
    }
    return map;
  }, [records]);

  const okToChangeMonth = () =>
    !dirtyRef.current || window.confirm("未保存の変更があります。保存せずに月を切り替えますか？");
  const prevMonth = () => { if (!okToChangeMonth()) return; const d = new Date(y, m - 2, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const nextMonth = () => { if (!okToChangeMonth()) return; const d = new Date(y, m, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };

  // セルクリック = ローカル編集のみ (DB へは保存ボタンで確定)
  const toggle = (row: Row, day: number, which: "planned" | "actual") => {
    if (!currentOfficeId) { alert("事業所を選択してください"); return; }
    setDirty(true);
    setRecords((prev) => {
      const idx = prev.findIndex(
        (r) => r.service_code === row.code && Number(r.visit_date.slice(8, 10)) === day,
      );
      if (idx === -1) {
        // 新規セル (未保存)。実績クリックなら予定にも計上
        const newRec: Rec = {
          id: `tmp-${row.code}-${day}`,
          visit_date: `${month}-${String(day).padStart(2, "0")}`,
          service_code: row.code,
          planned: true,
          actual: which === "actual",
          bath_type: row.bath_type,
          staff_only: row.staff_only,
        };
        return [...prev, newRec];
      }
      const rec = prev[idx];
      let planned = rec.planned;
      let actual = rec.actual;
      if (which === "planned") planned = !planned;
      else { actual = !actual; if (actual) planned = true; }
      if (!planned && !actual) {
        // 予定・実績とも 0 → 行削除 (保存時に DB からも消す)
        return prev.filter((_, i) => i !== idx);
      }
      return prev.map((r, i) => (i === idx ? { ...r, planned, actual } : r));
    });
  };

  // 保存: サーバスナップショット (savedRecords) と作業コピー (records) の差分を
  // insert / update / delete で確定する。cell key = `${code}-${day}`。
  const cellKeyOf = (r: Rec) => `${r.service_code ?? ""}-${Number(r.visit_date.slice(8, 10))}`;
  const save = async () => {
    if (!currentOfficeId) { alert("事業所を選択してください"); return; }
    setSaving(true);
    try {
      const savedByKey = new Map(savedRecords.map((r) => [cellKeyOf(r), r]));
      const workByKey = new Map(records.map((r) => [cellKeyOf(r), r]));
      const toInsert: Rec[] = [];
      const toUpdate: { id: string; planned: boolean; actual: boolean }[] = [];
      const toDeleteIds: string[] = [];
      for (const [k, w] of workByKey) {
        const s = savedByKey.get(k);
        if (!s) toInsert.push(w);
        else if (s.planned !== w.planned || s.actual !== w.actual)
          toUpdate.push({ id: s.id, planned: w.planned, actual: w.actual });
      }
      for (const [k, s] of savedByKey) {
        if (!workByKey.has(k)) toDeleteIds.push(s.id);
      }

      if (toDeleteIds.length > 0) {
        const { error } = await supabase.from("kaigo_bath_visit_records").delete().in("id", toDeleteIds);
        if (error) throw error;
      }
      for (const u of toUpdate) {
        const { error } = await supabase
          .from("kaigo_bath_visit_records")
          .update({ planned: u.planned, actual: u.actual })
          .eq("id", u.id);
        if (error) throw error;
      }
      if (toInsert.length > 0) {
        const rowByCode = new Map(displayRows.map((r) => [r.code, r]));
        const payload = toInsert.map((w) => {
          const r = rowByCode.get(w.service_code ?? "");
          return {
            client_id: userId,
            office_id: currentOfficeId,
            tenant_id: currentOffice?.tenant_id ?? "kt-group",
            visit_date: w.visit_date,
            bath_type: w.bath_type ?? r?.bath_type ?? "全身浴",
            staff_only: w.staff_only ?? r?.staff_only ?? false,
            service_code: w.service_code,
            status: "confirmed",
            planned: w.planned,
            actual: w.actual,
          };
        });
        const { error } = await supabase.from("kaigo_bath_visit_records").insert(payload);
        if (error) throw error;
      }
      // 新規 id を反映するため再読込 (records/savedRecords/dirty を確定)
      await load();
    } catch (e) {
      alert("保存に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  // ── 未保存離脱ガード ──
  // 1) ブラウザのリロード/タブ閉じ = beforeunload
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
  // 2) アプリ内遷移 (UserSidebar の利用者切替等) = nav-guard レジストリ
  useEffect(() => {
    registerNavGuard({
      isDirty: () => dirtyRef.current,
      message: "未保存の変更があります。保存せずに移動しますか？",
    });
    return () => registerNavGuard(null);
  }, []);

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
    const rows = displayRows.map((r) => {
      const c = counts(r.code);
      const unit = unitByCode[r.code] ?? 0;
      return { ...r, planned: c.planned, actual: c.actual, unit, actualUnits: c.actual * unit };
    });
    const totalActual = rows.reduce((s, r) => s + r.actual, 0);
    const totalUnits = rows.reduce((s, r) => s + r.actualUnits, 0);
    const daysUsed = new Set(records.filter((r) => r.actual && BASE_CODES.has(r.service_code ?? "")).map((r) => r.visit_date)).size;
    return { rows: rows.filter((r) => BASE_CODES.has(r.code) || r.actual > 0 || r.planned > 0), totalActual, totalUnits, daysUsed };
  }, [displayRows, counts, unitByCode, records]);

  const cellCls = (on: boolean, which: "planned" | "actual") =>
    on ? (which === "planned" ? "bg-blue-100 font-semibold text-blue-800" : "bg-green-100 font-semibold text-green-800") : "text-gray-300";

  const shownCodes = useMemo(() => new Set(displayRows.map((r) => r.code)), [displayRows]);

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
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700">
          <Plus size={14} />サービス追加
        </button>
        {dirty && (
          <span className="flex items-center gap-1 rounded bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700">
            ● 未保存の変更
          </span>
        )}
        <button
          onClick={save}
          disabled={!dirty || saving}
          className={`ml-auto flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-white ${
            dirty && !saving ? "bg-blue-600 hover:bg-blue-700" : "bg-gray-300 cursor-not-allowed"
          }`}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? "保存中…" : "保存"}
        </button>
        <button onClick={() => window.print()} className="flex items-center gap-1 rounded-lg bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800">
          <Printer size={14} />印刷
        </button>
      </div>

      <p className="border-b border-gray-100 bg-cyan-50 px-4 py-1 text-[11px] text-cyan-700 no-print">
        予定/実績のセルをクリックで「1」を入力/削除（実績を入れると予定にも計上）。<span className="font-semibold">変更は「保存」ボタンで確定</span>します（未保存のまま利用者・月を切り替えると警告）。「サービス追加」で加算等の行を追加できます。詳細な入浴記録・バイタルは「入浴実施記録」で編集。
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
              {displayRows.map((row) => {
                const c = counts(row.code);
                const unit = unitByCode[row.code] ?? 0;
                const isExtra = !BASE_CODES.has(row.code);
                return (
                  <tbody key={row.code}>
                    <tr>
                      <td rowSpan={2} className={`sticky left-0 z-10 border border-gray-300 px-2 py-1 text-left align-middle ${isExtra ? "bg-amber-50 text-amber-800" : "bg-white"}`}>{row.label}</td>
                      <td className="border border-gray-300 bg-blue-50 px-1 py-1 text-[10px] text-blue-700">予定</td>
                      {days.map((d) => {
                        const rec = recByCell.get(`${row.code}-${d}`);
                        return (
                          <td key={d} onClick={() => toggle(row, d, "planned")} className={`cursor-pointer border border-gray-200 px-0.5 py-1 hover:bg-blue-50 ${cellCls(!!rec?.planned, "planned")}`}>
                            {rec?.planned ? "1" : ""}
                          </td>
                        );
                      })}
                      <td className="border border-gray-300 px-2 py-1 text-blue-700">{c.planned || ""}</td>
                      <td rowSpan={2} className="border border-gray-300 px-2 py-1 align-middle tabular-nums text-gray-600">{c.actual > 0 ? (c.actual * unit).toLocaleString() : ""}</td>
                    </tr>
                    <tr>
                      <td className="border border-gray-300 bg-green-50 px-1 py-1 text-[10px] text-green-700">実績</td>
                      {days.map((d) => {
                        const rec = recByCell.get(`${row.code}-${d}`);
                        return (
                          <td key={d} onClick={() => toggle(row, d, "actual")} className={`cursor-pointer border border-gray-200 px-0.5 py-1 hover:bg-green-50 ${cellCls(!!rec?.actual, "actual")}`}>
                            {rec?.actual ? "1" : ""}
                          </td>
                        );
                      })}
                      <td className="border border-gray-300 px-2 py-1 font-semibold text-green-700">{c.actual || ""}</td>
                    </tr>
                  </tbody>
                );
              })}
            </table>

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
              <p className="mt-1 text-[10px] text-gray-400">※ 処遇改善加算等の月次%加算は「請求」画面で自動計上されます（この表には出しません）。</p>
            </div>
          </>
        )}
      </div>

      {showAdd && (
        <AddServiceModal
          y={y}
          m={m}
          excludeCodes={shownCodes}
          onClose={() => setShowAdd(false)}
          onPick={(code) => {
            setExtraCodes((prev) => (prev.includes(code) ? prev : [...prev, code]));
            void ensureCodes([code]);
            setShowAdd(false);
          }}
        />
      )}

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

// ── サービス追加モーダル: 種類12 のコードから選ぶ (処遇改善系は除外=請求で自動) ──
function AddServiceModal({
  y, m, excludeCodes, onClose, onPick,
}: {
  y: number;
  m: number;
  excludeCodes: Set<string>;
  onClose: () => void;
  onPick: (code: string) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [opts, setOpts] = useState<{ code: string; name: string; units: number }[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await validInMonth(
        supabase.from("kaigo_service_codes").select("service_code, service_name, units").like("service_code", "12%").eq("system", "介護"),
        y,
        m,
      );
      if (!alive) return;
      const list = ((data ?? []) as { service_code: string; service_name: string; units: number }[])
        .filter((d) => !excludeCodes.has(d.service_code) && !/処遇改善|特定処遇|ベースアップ/.test(d.service_name))
        .map((d) => ({ code: d.service_code, name: d.service_name, units: d.units }))
        .sort((a, b) => a.code.localeCompare(b.code));
      // 同名重複を排除
      const seen = new Set<string>();
      const uniq = list.filter((o) => (seen.has(o.code) ? false : (seen.add(o.code), true)));
      setOpts(uniq);
      setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount 時のみ
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim();
    if (!s) return opts;
    return opts.filter((o) => o.name.includes(s) || o.code.includes(s));
  }, [opts, q]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3 shrink-0">
          <h3 className="text-sm font-semibold text-gray-800">サービス追加（訪問入浴・加算）</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="border-b border-gray-100 px-4 py-2">
          <div className="flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-1.5">
            <Search size={14} className="text-gray-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="名称・コードで検索" className="flex-1 bg-transparent text-sm outline-none" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-cyan-400" /></div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-400">該当するサービスがありません</p>
          ) : (
            filtered.map((o) => (
              <button key={o.code} onClick={() => onPick(o.code)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-cyan-50">
                <span className="font-mono text-xs text-gray-400">{o.code}</span>
                <span className="flex-1 text-gray-800">{o.name}</span>
                <span className="text-xs tabular-nums text-gray-500">{o.units}単位</span>
              </button>
            ))
          )}
        </div>
        <p className="border-t border-gray-100 px-4 py-2 text-[10px] text-gray-400">※ 処遇改善加算等の月次%加算は請求画面で自動計上のため一覧に出しません。</p>
      </div>
    </div>
  );
}
