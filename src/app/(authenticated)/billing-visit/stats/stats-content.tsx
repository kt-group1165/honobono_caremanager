"use client";

/**
 * 請求統計 — ほのぼのNEXT「請求統計 (月遅れ・返戻者一覧)」相当
 *
 * 上部: 期間 (開始月〜終了月。既定 = 当年度 4 月〜当月)
 * タブ 1: 月遅れ・返戻者一覧 — kaigo_billing_status の tsukiokure/henrei/kago
 *         いずれか true の行を期間で一覧 (利用者名は clients を join)。CSV 出力付き
 * タブ 2: 月次推移 — riyou_seikyu_payments を月ごとに集計
 *         (請求額合計 / 入金額合計 / 未収額 = billed−paid の正分 / 件数)
 *
 * デザインは請求 4 タブと同じトーン (グレーヘッダ格子・text-xs)。
 * table 未作成 (42P01) は空として続行、他エラーは toast。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Download, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

// kaigo_billing_status の 1 行 (月遅れ・返戻・過誤のいずれか true のみ取得)
interface FlagRow {
  client_id: string;
  target_month: string;
  issued_at: string | null;
  kokuho_target: boolean;
  tsukiokure: boolean;
  henrei: boolean;
  kago: boolean;
  notes: string | null;
}

// riyou_seikyu_payments の 1 行 (月次推移の集計用)
interface PaymentRow {
  client_id: string;
  target_month: string;
  billed_amount: number;
  paid_amount: number;
}

// 区分バッジの配色 (月遅 = 橙 / 返戻 = 赤 / 過誤 = 紫)
const FLAG_BADGES: { key: "tsukiokure" | "henrei" | "kago"; label: string; cls: string }[] = [
  { key: "tsukiokure", label: "月遅", cls: "bg-amber-100 text-amber-700" },
  { key: "henrei", label: "返戻", cls: "bg-red-100 text-red-700" },
  { key: "kago", label: "過誤", cls: "bg-purple-100 text-purple-700" },
];

// 当年度の 4 月 (YYYY-MM)。1〜3 月は前年の 4 月
function fiscalYearStart(): string {
  const now = new Date();
  const y = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-04`;
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// YYYY-MM → 「R8/ 5」表記 (請求タブと同じ和暦月)
function reiwaMonth(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `R${parseInt(m[1], 10) - 2018}/${parseInt(m[2], 10)}`;
}

// 期間内の全月 (YYYY-MM) を列挙 (上限 60 ヶ月で打ち切り)
function monthsInRange(from: string, to: string): string[] {
  const re = /^(\d{4})-(\d{2})$/;
  const f = re.exec(from);
  const t = re.exec(to);
  if (!f || !t) return [];
  let y = parseInt(f[1], 10);
  let mo = parseInt(f[2], 10);
  const ty = parseInt(t[1], 10);
  const tmo = parseInt(t[2], 10);
  const out: string[] = [];
  while ((y < ty || (y === ty && mo <= tmo)) && out.length < 60) {
    out.push(`${y}-${String(mo).padStart(2, "0")}`);
    mo += 1;
    if (mo > 12) {
      mo = 1;
      y += 1;
    }
  }
  return out;
}

export function StatsContent() {
  const supabase = useMemo(() => createClient(), []);
  const [fromMonth, setFromMonth] = useState(fiscalYearStart());
  const [toMonth, setToMonth] = useState(currentMonthKey());
  const [tab, setTab] = useState<"flags" | "trend">("flags");
  const [loading, setLoading] = useState(true);
  const [flagRows, setFlagRows] = useState<FlagRow[]>([]);
  const [paymentRows, setPaymentRows] = useState<PaymentRow[]>([]);
  const [nameById, setNameById] = useState<Map<string, string>>(new Map());

  const rangeValid =
    /^\d{4}-\d{2}$/.test(fromMonth) &&
    /^\d{4}-\d{2}$/.test(toMonth) &&
    fromMonth <= toMonth;

  const load = useCallback(async () => {
    if (!rangeValid) return;
    setLoading(true);

    // ── 1) 月遅れ・返戻・過誤の行 (kaigo_billing_status) ──
    // 状態行は事業所単位 (居宅介護支援の行も同居) のため訪問介護 office に限定する
    let houmonOfficeIds: string[] = [];
    {
      const { data, error } = await supabase
        .from("offices")
        .select("id")
        .eq("service_type", "訪問介護");
      if (error) {
        toast.error("事業所一覧の取得に失敗: " + error.message);
      } else {
        houmonOfficeIds = ((data ?? []) as { id: string }[]).map((o) => o.id);
      }
    }
    let flags: FlagRow[] = [];
    if (houmonOfficeIds.length > 0) {
      const { data, error } = await supabase
        .from("kaigo_billing_status")
        .select(
          "client_id, target_month, issued_at, kokuho_target, tsukiokure, henrei, kago, notes",
        )
        .in("office_id", houmonOfficeIds)
        .gte("target_month", fromMonth)
        .lte("target_month", toMonth)
        .or("tsukiokure.eq.true,henrei.eq.true,kago.eq.true")
        .order("target_month");
      if (error) {
        // table 未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) 時は 0 件として続行
        if (error.code !== "42P01" && error.code !== "PGRST205") {
          toast.error("請求状態の取得に失敗: " + error.message);
        }
      } else {
        flags = (data ?? []) as FlagRow[];
      }
    }

    // ── 2) 月次推移 (riyou_seikyu_payments) — order 付き page-loop (1000 行上限対策) ──
    const pays: PaymentRow[] = [];
    {
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("riyou_seikyu_payments")
          .select("client_id, target_month, billed_amount, paid_amount")
          .gte("target_month", fromMonth)
          .lte("target_month", toMonth)
          .order("target_month", { ascending: true })
          .order("client_id", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) {
          if (error.code !== "42P01" && error.code !== "PGRST205") {
            toast.error("入金状況の取得に失敗: " + error.message);
          }
          break;
        }
        const rows = (data ?? []) as PaymentRow[];
        pays.push(...rows);
        if (rows.length < PAGE) break;
        offset += PAGE;
      }
    }

    // ── 3) 利用者名 (clients を client_id in で取得) ──
    const ids = [...new Set(flags.map((f) => f.client_id))];
    const names = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { data, error } = await supabase
        .from("clients")
        .select("id, name")
        .in("id", chunk);
      if (error) {
        toast.error("利用者名の取得に失敗: " + error.message);
        break;
      }
      for (const c of (data ?? []) as { id: string; name: string }[]) {
        names.set(c.id, c.name);
      }
    }

    setFlagRows(flags);
    setPaymentRows(pays);
    setNameById(names);
    setLoading(false);
  }, [supabase, fromMonth, toMonth, rangeValid]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 期間変更時の fetch
    load();
  }, [load]);

  // ── 月次推移の集計 (期間内の全月を出す。データ無し月は 0) ──
  const monthly = useMemo(() => {
    const byMonth = new Map<
      string,
      { billed: number; paid: number; misyu: number; count: number }
    >();
    for (const p of paymentRows) {
      const cur =
        byMonth.get(p.target_month) ?? { billed: 0, paid: 0, misyu: 0, count: 0 };
      cur.billed += p.billed_amount;
      cur.paid += p.paid_amount;
      const diff = p.billed_amount - p.paid_amount;
      if (diff > 0) cur.misyu += diff;
      cur.count += 1;
      byMonth.set(p.target_month, cur);
    }
    return monthsInRange(fromMonth, toMonth).map((ym) => ({
      month: ym,
      ...(byMonth.get(ym) ?? { billed: 0, paid: 0, misyu: 0, count: 0 }),
    }));
  }, [paymentRows, fromMonth, toMonth]);

  const monthlyTotal = useMemo(
    () =>
      monthly.reduce(
        (acc, m) => ({
          billed: acc.billed + m.billed,
          paid: acc.paid + m.paid,
          misyu: acc.misyu + m.misyu,
          count: acc.count + m.count,
        }),
        { billed: 0, paid: 0, misyu: 0, count: 0 },
      ),
    [monthly],
  );

  // ── 月遅れ・返戻者一覧の CSV 出力 (Excel 互換の BOM 付き UTF-8) ──
  const exportCsv = () => {
    if (flagRows.length === 0) {
      toast.error("出力対象がありません");
      return;
    }
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const header = ["対象月", "利用者名", "月遅れ", "返戻", "過誤", "状態", "国保対象", "備考"];
    const lines = flagRows.map((f) =>
      [
        f.target_month,
        esc(nameById.get(f.client_id) ?? f.client_id),
        f.tsukiokure ? "1" : "",
        f.henrei ? "1" : "",
        f.kago ? "1" : "",
        f.issued_at ? "発行済" : "未発行",
        f.kokuho_target ? "1" : "",
        esc(f.notes ?? ""),
      ].join(","),
    );
    const csv = [header.join(","), ...lines].join("\r\n");
    // Excel 互換のため BOM 付き UTF-8
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `seikyu_stats_${fromMonth}_${toMonth}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success(`CSV を出力しました (${flagRows.length} 件)`);
  };

  const thCls = "px-2 py-1.5 border border-gray-300 text-gray-700";
  const tdCls = "px-2 py-1 border border-gray-200";

  return (
    <div className="space-y-4">
      {/* ── ヘッダ + 期間指定 ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <BarChart3 size={20} className="text-indigo-600" />
            請求統計
          </h1>
          <p className="mt-0.5 text-xs text-gray-500">
            月遅れ・返戻者一覧と月次推移 (利用請求の請求/入金/未収)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="text-gray-600">期間</label>
          <input
            type="month"
            value={fromMonth}
            onChange={(e) => setFromMonth(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 focus:border-indigo-400 focus:outline-none"
          />
          <span className="text-gray-400">〜</span>
          <input
            type="month"
            value={toMonth}
            onChange={(e) => setToMonth(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 focus:border-indigo-400 focus:outline-none"
          />
          {!rangeValid && (
            <span className="text-red-500">開始月 ≦ 終了月 で指定してください</span>
          )}
        </div>
      </div>

      {/* ── タブ ── */}
      <div className="flex items-center gap-1 border-b border-gray-300">
        {(
          [
            { key: "flags", label: `月遅れ・返戻者一覧 (${flagRows.length})` },
            { key: "trend", label: "月次推移" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t border border-b-0 ${
              tab === t.key
                ? "bg-white border-gray-300 text-indigo-700 -mb-px"
                : "bg-gray-100 border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 size={22} className="animate-spin text-indigo-400" />
        </div>
      ) : tab === "flags" ? (
        /* ── タブ 1: 月遅れ・返戻者一覧 ── */
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportCsv}
              disabled={flagRows.length === 0}
              title="月遅れ・返戻者一覧を Excel 閲覧用 CSV で出力"
              className="border border-blue-500 rounded bg-blue-50 px-2.5 py-1 text-blue-700 hover:bg-blue-100 flex items-center gap-1.5 text-xs font-medium disabled:opacity-50"
            >
              <Download size={13} />
              CSV出力 ({flagRows.length}件)
            </button>
            <span className="text-[11px] text-gray-400">
              kaigo_billing_status の 月遅れ / 返戻 / 過誤 フラグ行 ({fromMonth} 〜 {toMonth})
            </span>
          </div>
          <div className="overflow-auto border border-gray-300 rounded">
            <table className="min-w-full text-xs border-collapse">
              <thead className="bg-gray-100 sticky top-0 z-10">
                <tr>
                  <th className={`${thCls} text-left w-20`}>対象月</th>
                  <th className={`${thCls} text-left`}>利用者名</th>
                  <th className={`${thCls} text-center w-32`}>区分</th>
                  <th className={`${thCls} text-center w-28`}>状態</th>
                  <th className={`${thCls} text-left`}>備考</th>
                </tr>
              </thead>
              <tbody>
                {flagRows.map((f) => (
                  <tr key={`${f.client_id}-${f.target_month}`} className="hover:bg-blue-50">
                    <td className={`${tdCls} font-mono`}>{reiwaMonth(f.target_month)}</td>
                    <td className={`${tdCls} font-medium`}>
                      {nameById.get(f.client_id) ?? "(不明)"}
                    </td>
                    <td className={`${tdCls} text-center`}>
                      <span className="inline-flex gap-1">
                        {FLAG_BADGES.filter((b) => f[b.key]).map((b) => (
                          <span
                            key={b.key}
                            className={`inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-semibold ${b.cls}`}
                          >
                            {b.label}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className={`${tdCls} text-center`}>
                      <span className="inline-flex gap-1">
                        <span
                          className={`inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                            f.issued_at
                              ? "bg-blue-100 text-blue-700"
                              : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {f.issued_at ? "発行済" : "未発行"}
                        </span>
                        {f.kokuho_target && (
                          <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700">
                            国保対象
                          </span>
                        )}
                      </span>
                    </td>
                    <td className={`${tdCls} text-gray-600`}>{f.notes ?? ""}</td>
                  </tr>
                ))}
                {flagRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-gray-400 text-sm">
                      期間内に 月遅れ / 返戻 / 過誤 の利用者はいません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* ── タブ 2: 月次推移 (請求/入金/未収) ── */
        <div className="space-y-2">
          <span className="text-[11px] text-gray-400">
            riyou_seikyu_payments の月次集計 (未収額 = 請求額 − 入金額 の正分の合計)
          </span>
          <div className="overflow-auto border border-gray-300 rounded">
            <table className="min-w-full text-xs border-collapse">
              <thead className="bg-gray-100 sticky top-0 z-10">
                <tr>
                  <th className={`${thCls} text-left w-24`}>対象月</th>
                  <th className={`${thCls} text-right w-20`}>件数</th>
                  <th className={`${thCls} text-right w-32`}>請求額合計</th>
                  <th className={`${thCls} text-right w-32`}>入金額合計</th>
                  <th className={`${thCls} text-right w-32`}>未収額</th>
                </tr>
              </thead>
              <tbody>
                {monthly.map((m) => (
                  <tr key={m.month} className="hover:bg-blue-50">
                    <td className={`${tdCls} font-mono`}>{reiwaMonth(m.month)}</td>
                    <td className={`${tdCls} text-right font-mono`}>
                      {m.count.toLocaleString()}
                    </td>
                    <td className={`${tdCls} text-right font-mono`}>
                      ¥{m.billed.toLocaleString()}
                    </td>
                    <td className={`${tdCls} text-right font-mono`}>
                      ¥{m.paid.toLocaleString()}
                    </td>
                    <td
                      className={`${tdCls} text-right font-mono ${m.misyu > 0 ? "text-red-600 font-semibold" : ""}`}
                    >
                      ¥{m.misyu.toLocaleString()}
                    </td>
                  </tr>
                ))}
                {monthly.length > 0 && (
                  <tr className="bg-gray-50 font-semibold">
                    <td className={`${tdCls}`}>合計</td>
                    <td className={`${tdCls} text-right font-mono`}>
                      {monthlyTotal.count.toLocaleString()}
                    </td>
                    <td className={`${tdCls} text-right font-mono`}>
                      ¥{monthlyTotal.billed.toLocaleString()}
                    </td>
                    <td className={`${tdCls} text-right font-mono`}>
                      ¥{monthlyTotal.paid.toLocaleString()}
                    </td>
                    <td
                      className={`${tdCls} text-right font-mono ${monthlyTotal.misyu > 0 ? "text-red-600" : ""}`}
                    >
                      ¥{monthlyTotal.misyu.toLocaleString()}
                    </td>
                  </tr>
                )}
                {monthly.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-gray-400 text-sm">
                      期間の指定が不正です
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
