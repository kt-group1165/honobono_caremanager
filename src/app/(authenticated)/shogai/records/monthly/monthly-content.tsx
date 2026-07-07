"use client";

/**
 * 障害福祉 実績月間管理 — ほのぼのmore の「予定実績管理」画面 参考
 *
 * 1 行 = 1 サービス提供 (計画 = kaigo_visit_schedule の障害サービス予定 /
 * 提供 = shogai_service_records の実績) を (日付, 開始時刻) で突合して表示。
 *   日付 | 区分 | 計画時間 | → | 提供時間 | 人数 | サービス名 | 算定時間 | 状態
 * 「→」で計画から実績を作成 (確定済みとして登録)。
 * 下部に 計画合計 / 提供合計 × (単位数・時間・区分別時間) を集計。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Accessibility,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Printer,
  Trash2,
} from "lucide-react";
import { getServiceSystemMap, isShogaiService } from "@/lib/service-system-lookup";
import { validInMonth } from "@/lib/service-code-valid";
import { useBusinessType } from "@/lib/business-type-context";

// ─── 区分判定 (身体介護 / 家事援助 / 乗降介助 / 通院・身体 / 通院介助) ─────────
const CATS = ["身体介護", "家事援助", "乗降介助", "通院・身体", "通院介助", "その他"] as const;
type Cat = (typeof CATS)[number];

function catOf(name: string | null | undefined): Cat {
  const s = name ?? "";
  if (s.includes("乗降")) return "乗降介助";
  if (s.includes("通院") && (s.includes("伴う") || s.includes("身体"))) return "通院・身体";
  if (s.includes("通院")) return "通院介助";
  if (s.includes("家事")) return "家事援助";
  if (s.includes("身体")) return "身体介護";
  return "その他";
}

const hm = (t: string | null | undefined) => (t ? t.slice(0, 5) : "");
const minsBetween = (s: string | null | undefined, e: string | null | undefined) => {
  if (!s || !e) return 0;
  const [sh, sm] = s.split(":").map(Number);
  const [eh, em] = e.split(":").map(Number);
  const d = eh * 60 + em - (sh * 60 + sm);
  return d > 0 ? d : 0;
};
const fmtHM = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

interface PlanRow {
  id: string;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  service_type: string;
}
interface RecRow {
  id: string;
  service_date: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  service_type: string;
  service_category: string | null;
  service_code: string | null;
  unit_count: number | null;
  status: string;
}
interface MergedRow {
  key: string;
  date: string;
  plan: PlanRow | null;
  rec: RecRow | null;
}

export function ShogaiMonthlyContent() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice } = useBusinessType();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [userId, setUserId] = useState<string>("");
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [recs, setRecs] = useState<RecRow[]>([]);
  const [codeNames, setCodeNames] = useState<Map<string, string>>(new Map());
  const [cert, setCert] = useState<{ beneficiary_number: string | null; contract_amount_text: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  const monthStr = `${year}-${String(month).padStart(2, "0")}`;
  const lastDay = new Date(year, month, 0).getDate();
  const from = `${monthStr}-01`;
  const to = `${monthStr}-${String(lastDay).padStart(2, "0")}`;

  // 利用者 (受給者証を持つ利用者)
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("shougai_certifications")
        .select("client_id, clients(name)")
        .order("client_id");
      if (error) {
        toast.error("利用者取得失敗: " + error.message);
        return;
      }
      const seen = new Map<string, string>();
      for (const r of (data ?? []) as unknown as { client_id: string; clients: { name: string } | null }[]) {
        if (!seen.has(r.client_id)) seen.set(r.client_id, r.clients?.name ?? "(不明)");
      }
      const list = Array.from(seen, ([id, name]) => ({ id, name }));
      setUsers(list);
      setUserId((prev) => prev || list[0]?.id || "");
      // 受給者証登録者が 0 名のときは load() が走らないためここで解除
      if (list.length === 0) setLoading(false);
    })();
  }, [supabase]);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      // 計画 = カレンダー予定のうち障害サービスのもの
      const { data: sched, error: e1 } = await supabase
        .from("kaigo_visit_schedule")
        .select("id, visit_date, start_time, end_time, service_type")
        .eq("user_id", userId)
        .gte("visit_date", from)
        .lte("visit_date", to)
        .order("visit_date")
        .order("start_time");
      if (e1) throw new Error("予定取得失敗: " + e1.message);
      const allPlans = (sched ?? []) as PlanRow[];
      const sysMap = await getServiceSystemMap(supabase, allPlans.map((p) => p.service_type), { year, month });
      setPlans(allPlans.filter((p) => isShogaiService(sysMap, p.service_type)));

      // 提供 = 障害実績
      const { data: rec, error: e2 } = await supabase
        .from("shogai_service_records")
        .select(
          "id, service_date, start_time, end_time, duration_minutes, service_type, service_category, service_code, unit_count, status",
        )
        .eq("client_id", userId)
        .gte("service_date", from)
        .lte("service_date", to)
        .neq("status", "cancelled")
        .order("service_date")
        .order("start_time");
      if (e2) throw new Error("実績取得失敗: " + e2.message);
      const recRows = (rec ?? []) as RecRow[];
      setRecs(recRows);

      // サービスコード → 名称 (障害マスタ)
      const codes = Array.from(new Set(recRows.map((r) => r.service_code).filter(Boolean))) as string[];
      if (codes.length > 0) {
        // 有効期間: 対象月に有効な世代のみ (改定跨ぎの同一コード複数世代ヒット防止)
        const { data: cn } = await validInMonth(
          supabase
            .from("kaigo_service_codes")
            .select("service_code, service_name")
            .eq("system", "障害")
            .in("service_code", codes.slice(0, 200)),
          year,
          month,
        );
        setCodeNames(
          new Map(((cn ?? []) as { service_code: string; service_name: string }[]).map((c) => [c.service_code, c.service_name])),
        );
      } else {
        setCodeNames(new Map());
      }

      // 受給者証 (実績記録票のヘッダ用: 受給者証番号 / 契約支給量)
      const { data: certRow } = await supabase
        .from("shougai_certifications")
        .select("beneficiary_number, contract_amount_text, certification_start_date")
        .eq("client_id", userId)
        .order("certification_start_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      setCert(
        (certRow as { beneficiary_number: string | null; contract_amount_text: string | null } | null) ?? null,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, userId, from, to, year, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/月・利用者変更時の fetch
    load();
  }, [load]);

  // (日付, 開始時刻) で 計画↔提供 を突合
  const rows: MergedRow[] = useMemo(() => {
    const map = new Map<string, MergedRow>();
    for (const p of plans) {
      const key = `${p.visit_date}__${hm(p.start_time)}`;
      map.set(key, { key, date: p.visit_date, plan: p, rec: null });
    }
    for (const r of recs) {
      const key = `${r.service_date}__${hm(r.start_time)}`;
      const cur = map.get(key);
      if (cur) cur.rec = r;
      else map.set(key, { key, date: r.service_date, plan: null, rec: r });
    }
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [plans, recs]);

  // 集計 (計画 / 提供 × 単位数・時間・区分別時間)
  const totals = useMemo(() => {
    const mk = () => ({ units: 0, mins: 0, byCat: Object.fromEntries(CATS.map((c) => [c, 0])) as Record<Cat, number> });
    const plan = mk();
    const teikyo = mk();
    for (const p of plans) {
      const m = minsBetween(p.start_time, p.end_time);
      plan.mins += m;
      plan.byCat[catOf(p.service_type)] += m;
    }
    for (const r of recs) {
      const m = r.duration_minutes ?? minsBetween(r.start_time, r.end_time);
      teikyo.mins += m;
      teikyo.units += r.unit_count ?? 0;
      teikyo.byCat[catOf(r.service_category ?? r.service_type)] += m;
    }
    return { plan, teikyo };
  }, [plans, recs]);

  // 計画 → 提供 (実績作成)
  const copyToRecord = async (row: MergedRow) => {
    if (!row.plan || row.rec) return;
    setBusyKey(row.key);
    const p = row.plan;
    const { error } = await supabase.from("shogai_service_records").insert({
      client_id: userId,
      service_date: p.visit_date,
      start_time: p.start_time,
      end_time: p.end_time,
      duration_minutes: minsBetween(p.start_time, p.end_time),
      service_type: p.service_type,
      service_category: catOf(p.service_type),
      status: "confirmed",
      tenant_id: "kt-group",
    });
    setBusyKey(null);
    if (error) {
      toast.error("実績作成に失敗: " + error.message);
      return;
    }
    toast.success("計画から実績を作成しました");
    load();
  };

  const deleteRecord = async (row: MergedRow) => {
    if (!row.rec) return;
    if (!window.confirm("この実績を削除しますか？")) return;
    setBusyKey(row.key);
    const { error } = await supabase.from("shogai_service_records").delete().eq("id", row.rec.id);
    setBusyKey(null);
    if (error) {
      toast.error("削除に失敗: " + error.message);
      return;
    }
    toast.success("実績を削除しました");
    load();
  };

  const dow = (d: string) => "日月火水木金土"[new Date(d + "T00:00:00").getDay()];

  const prevMonth = () => {
    if (month === 1) { setYear(year - 1); setMonth(12); } else setMonth(month - 1);
  };
  const nextMonth = () => {
    if (month === 12) { setYear(year + 1); setMonth(1); } else setMonth(month + 1);
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <Accessibility size={20} className="text-purple-600" />
            障害福祉 実績月間管理
          </h1>
          <p className="mt-0.5 text-xs text-gray-500">
            計画 (カレンダー予定) と提供実績を突合して月間管理 — 「→」で計画から実績を作成
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="rounded-lg border px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none"
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
          <div className="flex items-center gap-1 rounded-lg border bg-white px-2 py-1">
            <button onClick={prevMonth} className="rounded p-1 hover:bg-gray-100"><ChevronLeft size={14} /></button>
            <span className="min-w-[90px] text-center text-sm font-semibold">R{year - 2018}/{month} 提供分</span>
            <button onClick={nextMonth} className="rounded p-1 hover:bg-gray-100"><ChevronRight size={14} /></button>
          </div>
          <button
            type="button"
            disabled={rows.length === 0}
            onClick={() => {
              setPrinting(true);
              setTimeout(() => {
                window.print();
                setPrinting(false);
              }, 100);
            }}
            className="inline-flex items-center gap-1 rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
            title="サービス提供実績記録票 (様式第十八の一 準拠) を印刷"
          >
            <Printer size={14} />
            実績記録票
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400 print:hidden">
          <Loader2 size={20} className="mr-2 animate-spin" /> 読み込み中...
        </div>
      ) : users.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-gray-50 p-12 text-center text-sm text-gray-500 print:hidden">
          受給者証が登録された利用者がいません。
          <br />
          利用者管理 → 各利用者の「受給者証」から登録してください。
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-gray-50 p-12 text-center text-sm text-gray-500 print:hidden">
          対象月の障害サービスの計画・実績がありません
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-white shadow-sm print:hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-xs [&_th]:whitespace-nowrap">
              <thead className="bg-blue-100 text-left font-medium text-blue-900">
                <tr>
                  <th className="px-2 py-2">日付</th>
                  <th className="px-2 py-2">区分</th>
                  <th className="px-2 py-2 text-center">計画時間</th>
                  <th className="px-1 py-2 text-center w-8"></th>
                  <th className="px-2 py-2 text-center">提供時間</th>
                  <th className="px-2 py-2 text-right">人数</th>
                  <th className="px-2 py-2">サービス名</th>
                  <th className="px-2 py-2 text-right">単位数</th>
                  <th className="px-2 py-2 text-center">状態</th>
                  <th className="px-1 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row) => {
                  const name =
                    (row.rec?.service_code ? codeNames.get(row.rec.service_code) : null) ??
                    row.rec?.service_type ??
                    row.plan?.service_type ??
                    "";
                  const cat = catOf(row.rec?.service_category ?? row.rec?.service_type ?? row.plan?.service_type);
                  const busy = busyKey === row.key;
                  return (
                    <tr key={row.key} className="hover:bg-purple-50/40">
                      <td className="whitespace-nowrap px-2 py-1.5 font-medium">
                        {parseInt(row.date.slice(8), 10)} ({dow(row.date)})
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">{cat}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-center font-mono tabular-nums">
                        {row.plan ? `${hm(row.plan.start_time)}〜${hm(row.plan.end_time)}` : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-1 py-1.5 text-center">
                        {row.plan && !row.rec && (
                          <button
                            onClick={() => copyToRecord(row)}
                            disabled={busy}
                            title="計画から実績を作成"
                            className="rounded bg-blue-600 p-1 text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            {busy ? <Loader2 size={11} className="animate-spin" /> : <ArrowRight size={11} />}
                          </button>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-center font-mono tabular-nums">
                        {row.rec ? `${hm(row.rec.start_time)}〜${hm(row.rec.end_time)}` : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">1</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{name}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {row.rec?.unit_count ? row.rec.unit_count.toLocaleString() : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {row.rec ? (
                          row.rec.status === "confirmed" ? (
                            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-700">実績</span>
                          ) : (
                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold text-gray-600">下書</span>
                          )
                        ) : (
                          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">計画</span>
                        )}
                      </td>
                      <td className="px-1 py-1.5 text-center">
                        {row.rec && (
                          <button
                            onClick={() => deleteRecord(row)}
                            disabled={busy}
                            title="実績を削除"
                            className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500"
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 下部集計 (ほのぼの 準拠: 計画合計 / 提供合計) */}
          <div className="overflow-x-auto border-t bg-gray-50 px-3 py-2">
            <table className="text-[11px] font-mono leading-6 whitespace-nowrap">
              <thead>
                <tr className="text-gray-500">
                  <td className="pr-4"></td>
                  <td className="px-3 text-right">単位数</td>
                  <td className="px-3 text-right">時間</td>
                  {CATS.filter((c) => c !== "その他" || totals.plan.byCat[c] + totals.teikyo.byCat[c] > 0).map((c) => (
                    <td key={c} className="px-3 text-right">{c}</td>
                  ))}
                </tr>
              </thead>
              <tbody>
                {([["計画合計", totals.plan, false], ["提供合計", totals.teikyo, true]] as const).map(
                  ([label, t, showUnits]) => (
                    <tr key={label}>
                      <td className="pr-4 font-bold text-gray-700">{label}</td>
                      <td className="px-3 text-right tabular-nums font-bold">
                        {showUnits ? t.units.toLocaleString() : ""}
                      </td>
                      <td className="px-3 text-right tabular-nums">{fmtHM(t.mins)}</td>
                      {CATS.filter((c) => c !== "その他" || totals.plan.byCat[c] + totals.teikyo.byCat[c] > 0).map((c) => (
                        <td key={c} className="px-3 text-right tabular-nums">{fmtHM(t.byCat[c])}</td>
                      ))}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-[11px] text-gray-400 print:hidden">
        ※ 計画はシフト管理カレンダーの障害サービス予定、提供は障害サービス実績 (確定/下書)。
        実績の単位数・詳細の編集は サービス提供実績 の各記録から行えます。
      </p>

      {/* ===== 印刷: サービス提供実績記録票 (様式第十八の一 準拠) ===== */}
      {printing && (
        <div className="hidden print:block">
          <JissekiKirokuhyoSheet
            rows={rows}
            codeNames={codeNames}
            userName={users.find((u) => u.id === userId)?.name ?? ""}
            beneficiaryNumber={cert?.beneficiary_number ?? ""}
            contractAmount={cert?.contract_amount_text ?? ""}
            officeName={currentOffice?.name ?? ""}
            officeNumber={currentOffice?.business_number ?? ""}
            year={year}
            month={month}
          />
        </div>
      )}
    </div>
  );
}

// ─── 印刷: 居宅介護サービス提供実績記録票 (様式第十八の一 準拠 簡易版) ─────────
function JissekiKirokuhyoSheet({
  rows,
  codeNames,
  userName,
  beneficiaryNumber,
  contractAmount,
  officeName,
  officeNumber,
  year,
  month,
}: {
  rows: MergedRow[];
  codeNames: Map<string, string>;
  userName: string;
  beneficiaryNumber: string;
  contractAmount: string;
  officeName: string;
  officeNumber: string;
  year: number;
  month: number;
}) {
  const dow = (d: string) => "日月火水木金土"[new Date(d + "T00:00:00").getDay()];
  const planTotal = rows.reduce(
    (s, r) => s + (r.plan ? minsBetween(r.plan.start_time, r.plan.end_time) : 0),
    0,
  );
  const actualTotal = rows.reduce(
    (s, r) =>
      s + (r.rec ? r.rec.duration_minutes ?? minsBetween(r.rec.start_time, r.rec.end_time) : 0),
    0,
  );

  return (
    <div className="p-6 text-black" style={{ pageBreakAfter: "always" }}>
      <div className="mb-1 flex items-end justify-between text-xs">
        <span>様式第十八の一 (準拠)</span>
        <span>
          令和{year - 2018}年{month}月分
        </span>
      </div>
      <h1 className="mb-3 text-center text-lg font-bold tracking-widest">
        居宅介護サービス提供実績記録票
      </h1>

      <table className="mb-3 w-full border-collapse text-xs">
        <tbody>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1 w-28">受給者証番号</td>
            <td className="border border-black px-2 py-1 font-mono">{beneficiaryNumber || "　"}</td>
            <td className="border border-black bg-gray-100 px-2 py-1 w-40">支給決定障害者等氏名</td>
            <td className="border border-black px-2 py-1">{userName}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1">事業所番号</td>
            <td className="border border-black px-2 py-1 font-mono">{officeNumber || "　"}</td>
            <td className="border border-black bg-gray-100 px-2 py-1">事業者及びその事業所名</td>
            <td className="border border-black px-2 py-1">{officeName}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 px-2 py-1">契約支給量</td>
            <td className="border border-black px-2 py-1" colSpan={3}>{contractAmount || "　"}</td>
          </tr>
        </tbody>
      </table>

      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-1 py-1" rowSpan={2}>日付</th>
            <th className="border border-black px-1 py-1" rowSpan={2}>曜日</th>
            <th className="border border-black px-1 py-1" rowSpan={2}>サービス内容</th>
            <th className="border border-black px-1 py-1" colSpan={3}>居宅介護計画</th>
            <th className="border border-black px-1 py-1" colSpan={3}>サービス提供実績</th>
            <th className="border border-black px-1 py-1" rowSpan={2}>派遣<br />人数</th>
            <th className="border border-black px-1 py-1" rowSpan={2}>利用者<br />確認印</th>
            <th className="border border-black px-1 py-1" rowSpan={2}>備考</th>
          </tr>
          <tr className="bg-gray-100">
            <th className="border border-black px-1 py-1">開始時間</th>
            <th className="border border-black px-1 py-1">終了時間</th>
            <th className="border border-black px-1 py-1">計画<br />時間数</th>
            <th className="border border-black px-1 py-1">開始時間</th>
            <th className="border border-black px-1 py-1">終了時間</th>
            <th className="border border-black px-1 py-1">算定<br />時間数</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const name =
              (r.rec?.service_code ? codeNames.get(r.rec.service_code) : null) ??
              r.rec?.service_type ??
              r.plan?.service_type ??
              "";
            const planMins = r.plan ? minsBetween(r.plan.start_time, r.plan.end_time) : 0;
            const actMins = r.rec
              ? r.rec.duration_minutes ?? minsBetween(r.rec.start_time, r.rec.end_time)
              : 0;
            return (
              <tr key={r.key}>
                <td className="border border-black px-1 py-1 text-center tabular-nums">
                  {parseInt(r.date.slice(8), 10)}
                </td>
                <td className="border border-black px-1 py-1 text-center">{dow(r.date)}</td>
                <td className="border border-black px-1 py-1">{name}</td>
                <td className="border border-black px-1 py-1 text-center font-mono">
                  {r.plan ? hm(r.plan.start_time) : ""}
                </td>
                <td className="border border-black px-1 py-1 text-center font-mono">
                  {r.plan ? hm(r.plan.end_time) : ""}
                </td>
                <td className="border border-black px-1 py-1 text-center tabular-nums">
                  {planMins > 0 ? fmtHM(planMins) : ""}
                </td>
                <td className="border border-black px-1 py-1 text-center font-mono">
                  {r.rec ? hm(r.rec.start_time) : ""}
                </td>
                <td className="border border-black px-1 py-1 text-center font-mono">
                  {r.rec ? hm(r.rec.end_time) : ""}
                </td>
                <td className="border border-black px-1 py-1 text-center tabular-nums">
                  {actMins > 0 ? fmtHM(actMins) : ""}
                </td>
                <td className="border border-black px-1 py-1 text-center">1</td>
                <td className="border border-black px-1 py-1"></td>
                <td className="border border-black px-1 py-1"></td>
              </tr>
            );
          })}
          <tr className="font-bold">
            <td className="border border-black px-1 py-1 text-center" colSpan={5}>
              合計
            </td>
            <td className="border border-black px-1 py-1 text-center tabular-nums">
              {fmtHM(planTotal)}
            </td>
            <td className="border border-black px-1 py-1" colSpan={2}></td>
            <td className="border border-black px-1 py-1 text-center tabular-nums">
              {fmtHM(actualTotal)}
            </td>
            <td className="border border-black px-1 py-1" colSpan={3}></td>
          </tr>
        </tbody>
      </table>

      <p className="mt-2 text-[9px] text-gray-700">
        ※ 本票は様式第十八の一に準拠した簡易版です。初回加算・緊急時対応加算等の欄は算定時に追記してください。
      </p>
    </div>
  );
}
