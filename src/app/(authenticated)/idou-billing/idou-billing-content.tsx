"use client";

/**
 * 地域生活支援給付 請求 (千葉市)
 *
 * 移動支援 (kaigo_idou_shien_records) + 訪問入浴[障害] (kaigo_bath_visit_records scheme=地域生活支援)
 * の当月・確定分を集計し、千葉市提出用の帳票を印刷する:
 *   - 様式3-1 移動支援サービス提供実績記録票 (利用者別)
 *   - 様式13   地域生活支援給付費明細書 (利用者別)
 *   - 様式12   地域生活支援給付費請求書 (事業所集計)
 *
 * 請求は国保連伝送ではなく千葉市へ直接提出 (翌月17日まで)。1単位=10円。
 * 利用者負担は 生保/非課税=0円、課税世帯=10%。既定は0円 (非課税前提) とし、
 * 課税世帯の利用者は負担割合を切り替える。
 *
 * 制度定義: migrations/_if_idou_shien_chiba.txt
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { validInMonth } from "@/lib/service-code-valid";
import { ChevronLeft, ChevronRight, Loader2, Printer, Footprints } from "lucide-react";

const UNIT_YEN = 10;

type IdouRow = {
  id: string;
  client_id: string;
  service_date: string;
  plan_start_time: string | null;
  plan_end_time: string | null;
  start_time: string | null;
  end_time: string | null;
  calc_minutes: number | null;
  staff_count: number;
  service_code: string | null;
  units: number | null;
  addon_shokai: boolean;
  addon_kinkyu: boolean;
  user_confirmed: boolean;
};
type BathRow = {
  id: string;
  client_id: string;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  service_code: string | null;
  addon_shokai: boolean;
  staff_only: boolean;
};
type Client = { id: string; name: string };

const hm = (t: string | null) => (t ? t.slice(0, 5) : "");
const dow = (d: string) => "日月火水木金土"[new Date(d + "T00:00:00").getDay()];
const fmtHM = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const minsBetween = (s: string | null, e: string | null) => {
  if (!s || !e) return 0;
  const [sh, sm] = s.split(":").map(Number);
  const [eh, em] = e.split(":").map(Number);
  let d = eh * 60 + em - (sh * 60 + sm);
  if (d < 0) d += 24 * 60;
  return d;
};

// 明細行 (コード単位に集計)
type MeisaiLine = { code: string; name: string; unit: number; count: number; total: number };

export function IdouBillingContent() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, currentOfficeId } = useBusinessType();

  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [clients, setClients] = useState<Client[]>([]);
  const [idouRows, setIdouRows] = useState<IdouRow[]>([]);
  const [bathRows, setBathRows] = useState<BathRow[]>([]);
  const [codeInfo, setCodeInfo] = useState<Map<string, { name: string; unit: number }>>(new Map());
  const [certs, setCerts] = useState<Map<string, string>>(new Map()); // client_id → 受給者証番号
  const [burden10, setBurden10] = useState<Set<string>>(new Set()); // 課税世帯 (10%負担) の利用者
  const [loading, setLoading] = useState(true);

  const [y, mo] = month.split("-").map(Number);
  const clientName = useCallback((id: string) => clients.find((c) => c.id === id)?.name ?? "(不明)", [clients]);

  const load = useCallback(async () => {
    if (!currentOfficeId) return;
    setLoading(true);
    try {
      const { data: assigns } = await supabase
        .from("client_office_assignments").select("client_id").eq("office_id", currentOfficeId);
      const ids = Array.from(new Set((assigns ?? []).map((a: { client_id: string }) => a.client_id)));
      const [clientsRes, idouRes, bathRes, certRes] = await Promise.all([
        ids.length
          ? supabase.from("clients").select("id, name").in("id", ids).is("deleted_at", null).order("furigana")
          : Promise.resolve({ data: [], error: null }),
        supabase.from("kaigo_idou_shien_records").select("*")
          .eq("office_id", currentOfficeId).gte("service_date", `${month}-01`).lte("service_date", `${month}-31`)
          .neq("status", "draft"),
        supabase.from("kaigo_bath_visit_records").select("id, client_id, visit_date, start_time, end_time, service_code, addon_shokai, staff_only, scheme, status")
          .eq("office_id", currentOfficeId).eq("scheme", "地域生活支援")
          .gte("visit_date", `${month}-01`).lte("visit_date", `${month}-31`).neq("status", "draft"),
        ids.length
          ? supabase.from("shougai_certifications").select("client_id, beneficiary_number").in("client_id", ids)
          : Promise.resolve({ data: [], error: null }),
      ]);
      setClients((clientsRes.data ?? []) as Client[]);
      const idou = (idouRes.data ?? []) as IdouRow[];
      const bath = (bathRes.data ?? []) as unknown as BathRow[];
      setIdouRows(idou);
      setBathRows(bath);

      const certMap = new Map<string, string>();
      for (const c of (certRes.data ?? []) as { client_id: string; beneficiary_number: string | null }[]) {
        if (c.beneficiary_number && !certMap.has(c.client_id)) certMap.set(c.client_id, c.beneficiary_number);
      }
      setCerts(certMap);

      // コード → 名称・単位数 (マスタから、対象月世代)
      const codes = Array.from(new Set([...idou, ...bath].map((r) => r.service_code).filter(Boolean))) as string[];
      const info = new Map<string, { name: string; unit: number }>();
      if (codes.length) {
        const { data: cn } = await validInMonth(
          supabase.from("kaigo_service_codes").select("service_code, service_name, units")
            .eq("system", "地域生活支援").in("service_code", codes.slice(0, 300)),
          y, mo,
        );
        for (const c of (cn ?? []) as { service_code: string; service_name: string; units: number }[]) {
          if (!info.has(c.service_code)) info.set(c.service_code, { name: c.service_name, unit: c.units });
        }
      }
      setCodeInfo(info);
    } catch (e) {
      console.error("請求データ読込に失敗:", e instanceof Error ? e.message : e);
    } finally {
      setLoading(false);
    }
  }, [supabase, currentOfficeId, month, y, mo]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/月変更時の fetch
    load();
  }, [load]);

  const moveMonth = (delta: number) => {
    const d = new Date(y, mo - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  // 利用者ごとに明細行を集計
  const perClient = useMemo(() => {
    const map = new Map<string, MeisaiLine[]>();
    const addLine = (clientId: string, code: string | null) => {
      if (!code) return;
      const info = codeInfo.get(code);
      const unit = info?.unit ?? 0;
      const name = info?.name ?? code;
      let lines = map.get(clientId);
      if (!lines) { lines = []; map.set(clientId, lines); }
      const ex = lines.find((l) => l.code === code);
      if (ex) { ex.count += 1; ex.total += unit; }
      else lines.push({ code, name, unit, count: 1, total: unit });
    };
    for (const r of idouRows) {
      addLine(r.client_id, r.service_code);
      if (r.staff_count === 2 && r.service_code) addLine(r.client_id, r.service_code); // 2人目 = 同単位もう1行
    }
    for (const b of bathRows) addLine(b.client_id, b.service_code);
    return map;
  }, [idouRows, bathRows, codeInfo]);

  const clientIdsWithData = useMemo(
    () => Array.from(new Set([...idouRows, ...bathRows].map((r) => r.client_id))),
    [idouRows, bathRows],
  );

  // 請求書 (事業所集計)
  const summary = useMemo(() => {
    let totalUnits = 0;
    let burden = 0;
    for (const [cid, lines] of perClient) {
      const clientUnits = lines.reduce((s, l) => s + l.total, 0);
      totalUnits += clientUnits;
      if (burden10.has(cid)) burden += Math.floor(clientUnits * UNIT_YEN * 0.1);
    }
    const totalCost = totalUnits * UNIT_YEN;
    return { count: perClient.size, totalUnits, totalCost, burden, cityClaim: totalCost - burden };
  }, [perClient, burden10]);

  if (currentOffice && currentOffice.service_type !== "移動支援") {
    return (
      <div className="p-6">
        <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-700">
          この画面は移動支援事業所専用です。右上の事業所切替から移動支援の事業所を選択してください。
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      {/* ツールバー (印刷では非表示) */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-2">
          <Footprints className="text-violet-600" size={22} />
          <h1 className="text-lg font-bold text-gray-800">地域生活支援 請求</h1>
          <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-600">千葉市 (翌月17日まで提出)</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => moveMonth(-1)} className="rounded-lg border border-gray-200 p-1.5 hover:bg-gray-50"><ChevronLeft size={16} /></button>
          <span className="min-w-24 text-center text-sm font-semibold text-gray-700">{y}年{mo}月</span>
          <button onClick={() => moveMonth(1)} className="rounded-lg border border-gray-200 p-1.5 hover:bg-gray-50"><ChevronRight size={16} /></button>
          <button onClick={() => window.print()} className="ml-2 flex items-center gap-1.5 rounded-xl bg-violet-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-violet-700">
            <Printer size={15} />印刷
          </button>
        </div>
      </div>

      {/* 課税世帯 (10%負担) 指定 */}
      {!loading && clientIdsWithData.length > 0 && (
        <div className="mb-4 rounded-xl border border-gray-100 bg-white p-3 text-sm shadow-sm print:hidden">
          <p className="mb-2 text-xs font-medium text-gray-500">利用者負担割合 (既定=無料。市民税課税世帯のみ10%にチェック)</p>
          <div className="flex flex-wrap gap-3">
            {clientIdsWithData.map((cid) => (
              <label key={cid} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={burden10.has(cid)}
                  onChange={(e) => setBurden10((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(cid); else next.delete(cid);
                    return next;
                  })}
                  className="accent-violet-600"
                />
                {clientName(cid)} <span className="text-[11px] text-gray-400">{burden10.has(cid) ? "10%" : "無料"}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="animate-spin text-gray-300" size={28} /></div>
      ) : clientIdsWithData.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-200 py-16 text-center text-sm text-gray-400">
          {y}年{mo}月の確定済みデータがありません (記録を「確定」にすると集計されます)
        </p>
      ) : (
        <div className="space-y-6">
          {/* 様式12 請求書 (集計) */}
          <SeikyushoSheet
            y={y} mo={mo}
            officeName={currentOffice?.name ?? ""}
            officeNumber={currentOffice?.business_number ?? ""}
            summary={summary}
          />

          {/* 利用者ごとに 明細書 + 実績記録票 */}
          {clientIdsWithData.map((cid) => (
            <div key={cid}>
              <MeisaishoSheet
                y={y} mo={mo}
                clientName={clientName(cid)}
                cert={certs.get(cid) ?? ""}
                officeName={currentOffice?.name ?? ""}
                officeNumber={currentOffice?.business_number ?? ""}
                lines={perClient.get(cid) ?? []}
                burden10={burden10.has(cid)}
              />
              <JissekiSheet
                y={y} mo={mo}
                clientName={clientName(cid)}
                cert={certs.get(cid) ?? ""}
                officeName={currentOffice?.name ?? ""}
                officeNumber={currentOffice?.business_number ?? ""}
                rows={idouRows.filter((r) => r.client_id === cid)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 様式12 地域生活支援給付費請求書 ─────────────────────────────────────────
function SeikyushoSheet({ y, mo, officeName, officeNumber, summary }: {
  y: number; mo: number; officeName: string; officeNumber: string;
  summary: { count: number; totalUnits: number; totalCost: number; burden: number; cityClaim: number };
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 text-black shadow-sm print:border-0 print:shadow-none" style={{ pageBreakAfter: "always" }}>
      <div className="mb-1 flex items-end justify-between text-xs">
        <span>様式第12号</span><span>令和{y - 2018}年{mo}月分</span>
      </div>
      <h1 className="mb-4 text-center text-lg font-bold tracking-widest">千葉市地域生活支援給付費請求書</h1>
      <table className="mb-3 w-full border-collapse text-xs">
        <tbody>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1 w-28">事業所番号</td>
            <td className="border border-black px-2 py-1 font-mono">{officeNumber || "　"}</td>
            <td className="border border-black bg-gray-100 px-2 py-1 w-28">事業所名称</td>
            <td className="border border-black px-2 py-1">{officeName}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1">あて先</td>
            <td className="border border-black px-2 py-1" colSpan={3}>千葉市長</td>
          </tr>
        </tbody>
      </table>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-100 text-xs">
            <th className="border border-black px-2 py-1">区分</th>
            <th className="border border-black px-2 py-1">件数</th>
            <th className="border border-black px-2 py-1">単位数</th>
            <th className="border border-black px-2 py-1">費用合計</th>
            <th className="border border-black px-2 py-1">市請求額</th>
            <th className="border border-black px-2 py-1">利用者負担額</th>
          </tr>
        </thead>
        <tbody>
          <tr className="text-right tabular-nums">
            <td className="border border-black px-2 py-1 text-center">地域生活支援給付</td>
            <td className="border border-black px-2 py-1">{summary.count}</td>
            <td className="border border-black px-2 py-1">{summary.totalUnits.toLocaleString()}</td>
            <td className="border border-black px-2 py-1">{summary.totalCost.toLocaleString()}</td>
            <td className="border border-black px-2 py-1">{summary.cityClaim.toLocaleString()}</td>
            <td className="border border-black px-2 py-1">{summary.burden.toLocaleString()}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-[9px] text-gray-600">
        ※ 1単位=10円。利用者負担は生保・非課税世帯=0円、市民税課税世帯=10%。上限額管理 (障害福祉サービスとの合算) は別途。
      </p>
    </div>
  );
}

// ── 様式13 地域生活支援給付費明細書 ─────────────────────────────────────────
function MeisaishoSheet({ y, mo, clientName, cert, officeName, officeNumber, lines, burden10 }: {
  y: number; mo: number; clientName: string; cert: string; officeName: string; officeNumber: string;
  lines: MeisaiLine[]; burden10: boolean;
}) {
  const totalUnits = lines.reduce((s, l) => s + l.total, 0);
  const totalCost = totalUnits * UNIT_YEN;
  const burden = burden10 ? Math.floor(totalCost * 0.1) : 0;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 text-black shadow-sm print:border-0 print:shadow-none" style={{ pageBreakAfter: "always" }}>
      <div className="mb-1 flex items-end justify-between text-xs">
        <span>様式第13号</span><span>令和{y - 2018}年{mo}月分</span>
      </div>
      <h1 className="mb-3 text-center text-lg font-bold tracking-widest">千葉市地域生活支援給付費明細書</h1>
      <table className="mb-3 w-full border-collapse text-xs">
        <tbody>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1 w-28">受給者証番号</td>
            <td className="border border-black px-2 py-1 font-mono">{cert || "　"}</td>
            <td className="border border-black bg-gray-100 px-2 py-1 w-36">支給決定障害者等氏名</td>
            <td className="border border-black px-2 py-1">{clientName}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1">事業所番号</td>
            <td className="border border-black px-2 py-1 font-mono">{officeNumber || "　"}</td>
            <td className="border border-black bg-gray-100 px-2 py-1">事業者及びその事業所名</td>
            <td className="border border-black px-2 py-1">{officeName}</td>
          </tr>
        </tbody>
      </table>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-1 py-1 text-left">サービス内容</th>
            <th className="border border-black px-1 py-1">サービスコード</th>
            <th className="border border-black px-1 py-1">単位数</th>
            <th className="border border-black px-1 py-1">回数</th>
            <th className="border border-black px-1 py-1">サービス単位数</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.code} className="tabular-nums">
              <td className="border border-black px-1 py-1 text-left">{l.name}</td>
              <td className="border border-black px-1 py-1 text-center font-mono">{l.code}</td>
              <td className="border border-black px-1 py-1 text-right">{l.unit.toLocaleString()}</td>
              <td className="border border-black px-1 py-1 text-right">{l.count}</td>
              <td className="border border-black px-1 py-1 text-right">{l.total.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* 請求額集計欄 */}
      <table className="mt-3 w-full border-collapse text-[11px]">
        <tbody className="tabular-nums">
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1 w-40">給付単位数</td>
            <td className="border border-black px-2 py-1 text-right">{totalUnits.toLocaleString()}</td>
            <td className="border border-black bg-gray-100 px-2 py-1 w-40">単位数単価</td>
            <td className="border border-black px-2 py-1 text-right">{UNIT_YEN}.00 円/単位</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1">総費用額</td>
            <td className="border border-black px-2 py-1 text-right">{totalCost.toLocaleString()}</td>
            <td className="border border-black bg-gray-100 px-2 py-1">利用者負担額</td>
            <td className="border border-black px-2 py-1 text-right">{burden.toLocaleString()}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1">市請求額</td>
            <td className="border border-black px-2 py-1 text-right font-bold">{(totalCost - burden).toLocaleString()}</td>
            <td className="border border-black px-2 py-1" colSpan={2}></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── 様式3-1 移動支援サービス提供実績記録票 ──────────────────────────────────
function JissekiSheet({ y, mo, clientName, cert, officeName, officeNumber, rows }: {
  y: number; mo: number; clientName: string; cert: string; officeName: string; officeNumber: string;
  rows: IdouRow[];
}) {
  const sorted = [...rows].sort((a, b) => a.service_date.localeCompare(b.service_date) || hm(a.start_time).localeCompare(hm(b.start_time)));
  const planTotal = sorted.reduce((s, r) => s + minsBetween(r.plan_start_time, r.plan_end_time), 0);
  const calcTotal = sorted.reduce((s, r) => s + (r.calc_minutes ?? 0), 0);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 text-black shadow-sm print:border-0 print:shadow-none" style={{ pageBreakAfter: "always" }}>
      <div className="mb-1 flex items-end justify-between text-xs">
        <span>様式3-1</span><span>令和{y - 2018}年{mo}月分</span>
      </div>
      <h1 className="mb-3 text-center text-lg font-bold tracking-widest">移動支援サービス提供実績記録票</h1>
      <table className="mb-3 w-full border-collapse text-xs">
        <tbody>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1 w-28">受給者証番号</td>
            <td className="border border-black px-2 py-1 font-mono">{cert || "　"}</td>
            <td className="border border-black bg-gray-100 px-2 py-1 w-36">支給決定障害者等氏名</td>
            <td className="border border-black px-2 py-1">{clientName}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1">事業所番号</td>
            <td className="border border-black px-2 py-1 font-mono">{officeNumber || "　"}</td>
            <td className="border border-black bg-gray-100 px-2 py-1">事業者及びその事業所</td>
            <td className="border border-black px-2 py-1">{officeName}</td>
          </tr>
        </tbody>
      </table>
      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-1 py-1" rowSpan={2}>日付</th>
            <th className="border border-black px-1 py-1" rowSpan={2}>曜日</th>
            <th className="border border-black px-1 py-1" colSpan={3}>移動支援計画</th>
            <th className="border border-black px-1 py-1" colSpan={2}>サービス提供実績</th>
            <th className="border border-black px-1 py-1" rowSpan={2}>算定<br />時間</th>
            <th className="border border-black px-1 py-1" rowSpan={2}>派遣<br />人数</th>
            <th className="border border-black px-1 py-1" rowSpan={2}>初回<br />加算</th>
            <th className="border border-black px-1 py-1" rowSpan={2}>利用者<br />確認欄</th>
          </tr>
          <tr className="bg-gray-100">
            <th className="border border-black px-1 py-1">開始</th>
            <th className="border border-black px-1 py-1">終了</th>
            <th className="border border-black px-1 py-1">計画<br />時間数</th>
            <th className="border border-black px-1 py-1">開始</th>
            <th className="border border-black px-1 py-1">終了</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const planMins = minsBetween(r.plan_start_time, r.plan_end_time);
            return (
              <tr key={r.id} className="tabular-nums">
                <td className="border border-black px-1 py-1 text-center">{parseInt(r.service_date.slice(8), 10)}</td>
                <td className="border border-black px-1 py-1 text-center">{dow(r.service_date)}</td>
                <td className="border border-black px-1 py-1 text-center font-mono">{hm(r.plan_start_time)}</td>
                <td className="border border-black px-1 py-1 text-center font-mono">{hm(r.plan_end_time)}</td>
                <td className="border border-black px-1 py-1 text-center">{planMins > 0 ? fmtHM(planMins) : ""}</td>
                <td className="border border-black px-1 py-1 text-center font-mono">{hm(r.start_time)}</td>
                <td className="border border-black px-1 py-1 text-center font-mono">{hm(r.end_time)}</td>
                <td className="border border-black px-1 py-1 text-center">{r.calc_minutes != null ? fmtHM(r.calc_minutes) : ""}</td>
                <td className="border border-black px-1 py-1 text-center">{r.staff_count}</td>
                <td className="border border-black px-1 py-1 text-center">{r.addon_shokai ? "○" : ""}</td>
                <td className="border border-black px-1 py-1"></td>
              </tr>
            );
          })}
          <tr className="font-bold tabular-nums">
            <td className="border border-black px-1 py-1 text-center" colSpan={4}>合計</td>
            <td className="border border-black px-1 py-1 text-center">{fmtHM(planTotal)}</td>
            <td className="border border-black px-1 py-1" colSpan={2}></td>
            <td className="border border-black px-1 py-1 text-center">{fmtHM(calcTotal)}</td>
            <td className="border border-black px-1 py-1" colSpan={3}></td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-[9px] text-gray-600">
        ※ 算定時間 = 実績時間 − 運転等控除。要支援区間の説明・院内介助等は備考に記載 (提出前に手書き追記可)。
      </p>
    </div>
  );
}
