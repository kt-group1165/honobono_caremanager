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
  // client_id → 受給者証情報 (番号 / 契約支給量 / 負担上限月額 / 生保フラグ)。
  // 地域生活支援受給者証 (chiiki_recipient_certs) を優先、無ければ障害福祉受給者証を流用
  const [certs, setCerts] = useState<Map<string, { number: string; contract: string; limit: number; seiho: boolean }>>(new Map());
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
      const [clientsRes, idouRes, bathRes, certRes, chiikiCertRes] = await Promise.all([
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
          ? supabase.from("shougai_certifications")
              .select("client_id, beneficiary_number, self_payment_limit, seiho_flag, certification_start_date")
              .in("client_id", ids)
              .order("certification_start_date", { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        ids.length
          ? supabase.from("chiiki_recipient_certs")
              .select("client_id, beneficiary_number, shikyu_amount_text, self_payment_limit, seiho_flag")
              .in("client_id", ids)
          : Promise.resolve({ data: [], error: null }),
      ]);
      setClients((clientsRes.data ?? []) as Client[]);
      const idou = (idouRes.data ?? []) as IdouRow[];
      const bath = (bathRes.data ?? []) as unknown as BathRow[];
      setIdouRows(idou);
      setBathRows(bath);

      // 受給者証: 障害福祉 (最新) を土台に、地域生活支援受給者証があれば上書き
      const certMap = new Map<string, { number: string; contract: string; limit: number; seiho: boolean }>();
      for (const c of (certRes.data ?? []) as {
        client_id: string; beneficiary_number: string | null; self_payment_limit: number | null; seiho_flag: boolean | null;
      }[]) {
        if (!certMap.has(c.client_id)) {
          certMap.set(c.client_id, {
            number: c.beneficiary_number ?? "",
            contract: "",
            limit: c.self_payment_limit ?? 0,
            seiho: c.seiho_flag ?? false,
          });
        }
      }
      for (const c of (chiikiCertRes.data ?? []) as {
        client_id: string; beneficiary_number: string | null; shikyu_amount_text: string | null;
        self_payment_limit: number | null; seiho_flag: boolean | null;
      }[]) {
        certMap.set(c.client_id, {
          number: c.beneficiary_number ?? certMap.get(c.client_id)?.number ?? "",
          contract: c.shikyu_amount_text ?? "",
          limit: c.self_payment_limit ?? 0,
          seiho: c.seiho_flag ?? false,
        });
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

  // 2人目従業者コード = base+1 (千葉市コード表は単独/・2人 が連番。単位は同額)
  const secondPersonCode = (base: string): { code: string; name: string; unit: number } => {
    const code = String(Number(base) + 1).padStart(6, "0");
    const info = codeInfo.get(base);
    return { code, name: (info?.name ?? base) + "・2人", unit: info?.unit ?? 0 };
  };

  // 利用者ごとに明細行を集計
  const perClient = useMemo(() => {
    const map = new Map<string, MeisaiLine[]>();
    const addLine = (clientId: string, code: string, name: string, unit: number) => {
      let lines = map.get(clientId);
      if (!lines) { lines = []; map.set(clientId, lines); }
      const ex = lines.find((l) => l.code === code);
      if (ex) { ex.count += 1; ex.total += unit; }
      else lines.push({ code, name, unit, count: 1, total: unit });
    };
    const addByCode = (clientId: string, code: string | null) => {
      if (!code) return;
      const info = codeInfo.get(code);
      addLine(clientId, code, info?.name ?? code, info?.unit ?? 0);
    };
    for (const r of idouRows) {
      addByCode(r.client_id, r.service_code);
      // 2人目従業者は ・2人 コードで別行 (同単位)
      if (r.staff_count === 2 && r.service_code) {
        const s = secondPersonCode(r.service_code);
        addLine(r.client_id, s.code, s.name, s.unit);
      }
    }
    for (const b of bathRows) addByCode(b.client_id, b.service_code);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- secondPersonCode は codeInfo に依存
  }, [idouRows, bathRows, codeInfo]);

  // 利用者の負担額 = 生保→0 / それ以外→ min(総費用×10%, 負担上限月額)。上限0(非課税)→0
  const clientBurden = useCallback((clientId: string, cost: number): number => {
    const c = certs.get(clientId);
    if (!c || c.seiho) return 0;
    return Math.min(Math.floor(cost * 0.1), c.limit);
  }, [certs]);

  const clientIdsWithData = useMemo(
    () => Array.from(new Set([...idouRows, ...bathRows].map((r) => r.client_id))),
    [idouRows, bathRows],
  );

  // 確定済みだがコード未確定 = 請求に含まれない記録 (silent failure 防止)
  const unresolved = useMemo(
    () => [...idouRows, ...bathRows].filter((r) => !r.service_code),
    [idouRows, bathRows],
  );

  // 請求書 (事業所集計)
  const summary = useMemo(() => {
    let totalUnits = 0;
    let burden = 0;
    for (const [cid, lines] of perClient) {
      const clientUnits = lines.reduce((s, l) => s + l.total, 0);
      totalUnits += clientUnits;
      burden += clientBurden(cid, clientUnits * UNIT_YEN);
    }
    const totalCost = totalUnits * UNIT_YEN;
    return { count: perClient.size, totalUnits, totalCost, burden, cityClaim: totalCost - burden };
  }, [perClient, clientBurden]);

  if (currentOffice && currentOffice.service_type !== "移動支援" && currentOffice.service_type !== "訪問入浴") {
    return (
      <div className="p-6">
        <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-700">
          この画面は地域生活支援給付 (移動支援・訪問入浴) の事業所専用です。右上の事業所切替から該当事業所を選択してください。
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

      {/* 利用者負担 (受給者証の負担上限月額から算定。読み取り専用) */}
      {!loading && clientIdsWithData.length > 0 && (
        <div className="mb-4 rounded-xl border border-gray-100 bg-white p-3 text-sm shadow-sm print:hidden">
          <p className="mb-2 text-xs font-medium text-gray-500">
            利用者負担 (障害福祉受給者証の負担上限月額から算定 / 生保・非課税=無料)。
            上限額の変更は 利用者管理 → 障害福祉タブの受給者証から。
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {clientIdsWithData.map((cid) => {
              const c = certs.get(cid);
              const label = !c || c.seiho ? (c?.seiho ? "生保=無料" : "受給者証未登録=無料")
                : c.limit === 0 ? "非課税=無料" : `上限 ¥${c.limit.toLocaleString()}/月`;
              return (
                <span key={cid} className="text-xs">
                  <span className="text-gray-700">{clientName(cid)}</span>
                  <span className="ml-1 text-gray-400">{label}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* コード未確定の記録の警告 (請求から漏れる) */}
      {!loading && unresolved.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 print:hidden">
          ⚠ 算定コードが未確定の記録が {unresolved.length} 件あり、請求に含まれていません。
          移動支援記録で該当記録を開き「コードを手動選択」で確定してください。
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

          {/* 利用者ごとに 明細書 + 実績記録票 (移動支援=3-1 / 訪問入浴=3-2) */}
          {clientIdsWithData.map((cid) => {
            const lines = perClient.get(cid) ?? [];
            const cost = lines.reduce((s, l) => s + l.total, 0) * UNIT_YEN;
            const idouOfClient = idouRows.filter((r) => r.client_id === cid);
            const bathOfClient = bathRows.filter((r) => r.client_id === cid);
            return (
              <div key={cid}>
                <MeisaishoSheet
                  y={y} mo={mo}
                  clientName={clientName(cid)}
                  cert={certs.get(cid)?.number ?? ""}
                  officeName={currentOffice?.name ?? ""}
                  officeNumber={currentOffice?.business_number ?? ""}
                  lines={lines}
                  burden={clientBurden(cid, cost)}
                />
                {idouOfClient.length > 0 && (
                  <JissekiSheet
                    y={y} mo={mo}
                    clientName={clientName(cid)}
                    cert={certs.get(cid)?.number ?? ""}
                    contract={certs.get(cid)?.contract ?? ""}
                    officeName={currentOffice?.name ?? ""}
                    officeNumber={currentOffice?.business_number ?? ""}
                    rows={idouOfClient}
                  />
                )}
                {bathOfClient.length > 0 && (
                  <BathJissekiSheet
                    y={y} mo={mo}
                    clientName={clientName(cid)}
                    cert={certs.get(cid)?.number ?? ""}
                    contract={certs.get(cid)?.contract ?? ""}
                    officeName={currentOffice?.name ?? ""}
                    officeNumber={currentOffice?.business_number ?? ""}
                    rows={bathOfClient}
                  />
                )}
              </div>
            );
          })}
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
function MeisaishoSheet({ y, mo, clientName, cert, officeName, officeNumber, lines, burden }: {
  y: number; mo: number; clientName: string; cert: string; officeName: string; officeNumber: string;
  lines: MeisaiLine[]; burden: number;
}) {
  const totalUnits = lines.reduce((s, l) => s + l.total, 0);
  const totalCost = totalUnits * UNIT_YEN;
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
function JissekiSheet({ y, mo, clientName, cert, contract, officeName, officeNumber, rows }: {
  y: number; mo: number; clientName: string; cert: string; contract: string; officeName: string; officeNumber: string;
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
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1">契約支給量</td>
            <td className="border border-black px-2 py-1" colSpan={3}>{contract || "　"}</td>
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

// ── 様式3-2 訪問入浴サービス提供実績記録票 (地域生活支援) ────────────────────
function BathJissekiSheet({ y, mo, clientName, cert, contract, officeName, officeNumber, rows }: {
  y: number; mo: number; clientName: string; cert: string; contract: string; officeName: string; officeNumber: string;
  rows: BathRow[];
}) {
  const sorted = [...rows].sort((a, b) => a.visit_date.localeCompare(b.visit_date) || hm(a.start_time).localeCompare(hm(b.start_time)));
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 text-black shadow-sm print:border-0 print:shadow-none" style={{ pageBreakAfter: "always" }}>
      <div className="mb-1 flex items-end justify-between text-xs">
        <span>様式3-2</span><span>令和{y - 2018}年{mo}月分</span>
      </div>
      <h1 className="mb-3 text-center text-lg font-bold tracking-widest">訪問入浴サービス提供実績記録票</h1>
      <table className="mb-3 w-full border-collapse text-xs">
        <tbody>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1 w-28">受給者証番号</td>
            <td className="border border-black px-2 py-1 font-mono">{cert || "　"}</td>
            <td className="border border-black bg-gray-100 px-2 py-1 w-36">支給決定障害者氏名</td>
            <td className="border border-black px-2 py-1">{clientName}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1">事業所番号</td>
            <td className="border border-black px-2 py-1 font-mono">{officeNumber || "　"}</td>
            <td className="border border-black bg-gray-100 px-2 py-1">事業者及びその事業所</td>
            <td className="border border-black px-2 py-1">{officeName}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1">契約支給量</td>
            <td className="border border-black px-2 py-1" colSpan={3}>{contract || "　"}</td>
          </tr>
        </tbody>
      </table>
      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-1 py-1">実施日</th>
            <th className="border border-black px-1 py-1">曜日</th>
            <th className="border border-black px-1 py-1">開始時間</th>
            <th className="border border-black px-1 py-1">終了時間</th>
            <th className="border border-black px-1 py-1">入浴方法</th>
            <th className="border border-black px-1 py-1">利用者確認欄</th>
            <th className="border border-black px-1 py-1">備考</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.id} className="tabular-nums">
              <td className="border border-black px-1 py-1 text-center">{parseInt(r.visit_date.slice(8), 10)}</td>
              <td className="border border-black px-1 py-1 text-center">{dow(r.visit_date)}</td>
              <td className="border border-black px-1 py-1 text-center font-mono">{hm(r.start_time)}</td>
              <td className="border border-black px-1 py-1 text-center font-mono">{hm(r.end_time)}</td>
              <td className="border border-black px-1 py-1 text-center">{r.staff_only ? "介護職員3人" : "実施"}</td>
              <td className="border border-black px-1 py-1"></td>
              <td className="border border-black px-1 py-1"></td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className="border border-black px-1 py-1 text-center" colSpan={4}>合計 {sorted.length} 回</td>
            <td className="border border-black px-1 py-1" colSpan={3}></td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-[9px] text-gray-600">
        ※ 週2回限度 (日曜起点)。中止時の理由等は備考に記載 (提出前に手書き追記可)。
      </p>
    </div>
  );
}
