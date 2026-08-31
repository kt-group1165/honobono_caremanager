"use client";

/**
 * 請求統計 (居宅介護支援) — billing-visit/stats (訪問介護版) の居宅版
 *
 * 上部: 期間 (開始月〜終了月。既定 = 当年度 4 月〜当月)
 * タブ 1: 月遅れ・返戻者一覧 — kaigo_billing_status (office_id = 現在の居宅事業所) の
 *         tsukiokure/henrei/kago いずれか true の行を期間で一覧。CSV 出力付き
 * タブ 2: 月次推移 — kaigo_care_support_claims を月ごとに集計
 *         (請求件数 / 単位数 / 保険請求額) + 月遅れ数 / 返戻数。
 *         kokuho_nyukin_records があれば入金状況も併記 (table 未作成なら列非表示)
 * タブ 3: 集中減算 — 特定事業所集中減算の判定 (判定期間 前期/後期 選択、
 *         利用票ベースの法人単位集計。shuchu-gensan-tab.tsx で遅延読込)
 * タブ 4: 経営分析 — 給付管理ベースの担当利用者数推移 + 逓減状況
 *         (keiei-bunseki-tab.tsx。タブを開いた時に月別クエリを並列で遅延読込)
 *
 * office 解決は useBusinessType (currentOfficeId)。居宅介護支援 office でのみ動作。
 * デザインは billing-visit/stats と同じトーン (グレーヘッダ格子・text-xs)。
 * table 未作成 (42P01 / PGRST205) は空として続行、他エラーは toast。
 */

import { ID_IN_CHUNK } from "@/lib/chunk-parallel";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Download, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { toast } from "sonner";
import { KeieiBunsekiKyotakuTab } from "./keiei-bunseki-tab";
import { ShuchuGensanTab } from "./shuchu-gensan-tab";
import { UneiKijunTab } from "./unei-kijun-tab";

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

// kaigo_care_support_claims の 1 行 (月次推移の集計用)
interface ClaimRow {
  billing_month: string;
  units: number;
  insurance_amount: number;
  status: string;
}

// kokuho_nyukin_records の 1 行 (入金状況の併記用)
interface NyukinRow {
  target_month: string;
  seikyu_amount: number;
  kettei_amount: number | null;
  nyukin_date: string | null;
  status: string;
}

// 区分バッジの配色 (月遅 = 橙 / 返戻 = 赤 / 過誤 = 紫)
const FLAG_BADGES: { key: "tsukiokure" | "henrei" | "kago"; label: string; cls: string }[] = [
  { key: "tsukiokure", label: "月遅", cls: "bg-amber-100 text-amber-700" },
  { key: "henrei", label: "返戻", cls: "bg-red-100 text-red-700" },
  { key: "kago", label: "過誤", cls: "bg-purple-100 text-purple-700" },
];

// 入金状態バッジ (kokuho_nyukin_records.status)
const NYUKIN_CLS: Record<string, string> = {
  未入金: "bg-gray-100 text-gray-600",
  入金済: "bg-emerald-100 text-emerald-700",
  差額あり: "bg-red-100 text-red-700",
};

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
  const {
    businessType,
    currentOfficeId,
    currentOffice,
    loading: officeLoading,
  } = useBusinessType();
  const [fromMonth, setFromMonth] = useState(fiscalYearStart());
  const [toMonth, setToMonth] = useState(currentMonthKey());
  const [tab, setTab] = useState<"flags" | "trend" | "conc" | "unei" | "keiei">("flags");
  const [loading, setLoading] = useState(true);
  const [flagRows, setFlagRows] = useState<FlagRow[]>([]);
  const [claimRows, setClaimRows] = useState<ClaimRow[]>([]);
  const [nyukinRows, setNyukinRows] = useState<NyukinRow[]>([]);
  const [hasNyukin, setHasNyukin] = useState(false);
  const [nameById, setNameById] = useState<Map<string, string>>(new Map());

  const isKyotaku = businessType === "居宅介護支援";

  const rangeValid =
    /^\d{4}-\d{2}$/.test(fromMonth) &&
    /^\d{4}-\d{2}$/.test(toMonth) &&
    fromMonth <= toMonth;

  const load = useCallback(async () => {
    if (!rangeValid || !isKyotaku || !currentOfficeId) return;
    setLoading(true);

    // ── 1) 月遅れ・返戻・過誤の行 (kaigo_billing_status。現在の居宅 office に限定) ──
    let flags: FlagRow[] = [];
    {
      const { data, error } = await supabase
        .from("kaigo_billing_status")
        .select(
          "client_id, target_month, issued_at, kokuho_target, tsukiokure, henrei, kago, notes",
        )
        .eq("office_id", currentOfficeId)
        .gte("target_month", fromMonth)
        .lte("target_month", toMonth)
        .or("tsukiokure.eq.true,henrei.eq.true,kago.eq.true")
        .order("target_month");
      if (error) {
        // table 未作成 (migration 未適用) 時は 0 件として続行
        if (error.code !== "42P01" && error.code !== "PGRST205") {
          toast.error("請求状態の取得に失敗: " + error.message);
        }
      } else {
        flags = (data ?? []) as FlagRow[];
      }
    }

    // ── 2) 月次推移 (kaigo_care_support_claims。office_id 列が無いため
    //      client_office_assignments 経由で自事業所の利用者に絞る — 監査M-2:
    //      2つ目の居宅事業所を作った時に他事業所分を合算しないため) ──
    let officeClientIds: Set<string> | null = null;
    {
      const { data, error } = await supabase
        .from("client_office_assignments")
        .select("client_id")
        .eq("office_id", currentOfficeId);
      if (error) {
        console.error("client_office_assignments fetch failed:", error.message);
      } else {
        officeClientIds = new Set(((data ?? []) as { client_id: string }[]).map((a) => a.client_id));
      }
    }
    let claims: ClaimRow[] = [];
    {
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("kaigo_care_support_claims")
          .select("billing_month, units, insurance_amount, status, user_id")
          .gte("billing_month", fromMonth)
          .lte("billing_month", toMonth)
          .order("id").range(from, from + PAGE - 1);
        if (error) {
          if (error.code !== "42P01" && error.code !== "PGRST205") {
            toast.error("請求データの取得に失敗: " + error.message);
          }
          break;
        }
        let rows = (data ?? []) as (ClaimRow & { user_id?: string })[];
        // 割当が取れた場合のみ自事業所の利用者に限定 (取得失敗時は従来どおり全件)
        if (officeClientIds) rows = rows.filter((r) => !r.user_id || officeClientIds.has(r.user_id));
        claims = claims.concat(rows);
        if ((data ?? []).length < PAGE) break;
      }
    }

    // ── 3) 入金状況 (kokuho_nyukin_records。table 未作成なら列ごと非表示) ──
    let nyukin: NyukinRow[] = [];
    let nyukinAvailable = false;
    {
      const { data, error } = await supabase
        .from("kokuho_nyukin_records")
        .select("target_month, seikyu_amount, kettei_amount, nyukin_date, status")
        .eq("office_id", currentOfficeId)
        .gte("target_month", fromMonth)
        .lte("target_month", toMonth);
      if (error) {
        if (error.code !== "42P01" && error.code !== "PGRST205") {
          toast.error("入金状況の取得に失敗: " + error.message);
        }
      } else {
        nyukin = (data ?? []) as NyukinRow[];
        nyukinAvailable = true;
      }
    }

    // ── 4) 利用者名 (clients を client_id in で取得) ──
    const ids = [...new Set(flags.map((f) => f.client_id))];
    const names = new Map<string, string>();
    for (let i = 0; i < ids.length; i += ID_IN_CHUNK) {
      const chunk = ids.slice(i, i + ID_IN_CHUNK);
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
    setClaimRows(claims);
    setNyukinRows(nyukin);
    setHasNyukin(nyukinAvailable);
    setNameById(names);
    setLoading(false);
  }, [supabase, fromMonth, toMonth, rangeValid, isKyotaku, currentOfficeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 期間/office 変更時の fetch
    load();
  }, [load]);

  // ── 月次推移の集計 (期間内の全月を出す。データ無し月は 0) ──
  const monthly = useMemo(() => {
    const byMonth = new Map<
      string,
      { count: number; units: number; amount: number; tsukiokure: number; henrei: number }
    >();
    const blank = () => ({ count: 0, units: 0, amount: 0, tsukiokure: 0, henrei: 0 });
    for (const c of claimRows) {
      const cur = byMonth.get(c.billing_month) ?? blank();
      cur.count += 1;
      cur.units += c.units;
      cur.amount += c.insurance_amount;
      byMonth.set(c.billing_month, cur);
    }
    for (const f of flagRows) {
      const cur = byMonth.get(f.target_month) ?? blank();
      if (f.tsukiokure) cur.tsukiokure += 1;
      if (f.henrei) cur.henrei += 1;
      byMonth.set(f.target_month, cur);
    }
    const nyukinByMonth = new Map(nyukinRows.map((n) => [n.target_month, n]));
    return monthsInRange(fromMonth, toMonth).map((ym) => ({
      month: ym,
      ...(byMonth.get(ym) ?? blank()),
      nyukin: nyukinByMonth.get(ym) ?? null,
    }));
  }, [claimRows, flagRows, nyukinRows, fromMonth, toMonth]);

  const monthlyTotal = useMemo(
    () =>
      monthly.reduce(
        (acc, m) => ({
          count: acc.count + m.count,
          units: acc.units + m.units,
          amount: acc.amount + m.amount,
          tsukiokure: acc.tsukiokure + m.tsukiokure,
          henrei: acc.henrei + m.henrei,
        }),
        { count: 0, units: 0, amount: 0, tsukiokure: 0, henrei: 0 },
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
    a.download = `kyotaku_seikyu_stats_${fromMonth}_${toMonth}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success(`CSV を出力しました (${flagRows.length} 件)`);
  };

  const thCls = "px-2 py-1.5 border border-gray-300 text-gray-700";
  const tdCls = "px-2 py-1 border border-gray-200";

  if (officeLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 size={22} className="animate-spin text-indigo-400" />
      </div>
    );
  }

  // 居宅介護支援 office でのみ動作 (訪問介護は billing-visit/stats を使う)
  if (!isKyotaku || !currentOfficeId) {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        このページは居宅介護支援の事業所専用です。ヘッダーの事業所切替で居宅介護支援の事業所を選択してください
        (訪問介護の請求統計は 請求管理(訪問系) &gt; 請求統計 にあります)。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── ヘッダ + 期間指定 ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <BarChart3 size={20} className="text-indigo-600" />
            請求統計 (居宅介護支援)
          </h1>
          <p className="mt-0.5 text-xs text-gray-500">
            月遅れ・返戻者一覧と月次推移 (居宅介護支援費の件数/単位数/金額)
            {currentOffice ? ` — ${currentOffice.name}` : ""}
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
            { key: "conc", label: "集中減算" },
            // 2026-09-01 追加: 運営基準減算 (所定単位数の 50%、2 月以上継続で 100%) の
            //   3 要件を立証できない利用者を出す。請求額は変えない。
            { key: "unei", label: "運営基準減算" },
            { key: "keiei", label: "経営分析" },
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

      {loading && (tab === "flags" || tab === "trend") ? (
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
      ) : tab === "trend" ? (
        /* ── タブ 2: 月次推移 (件数/単位数/金額 + 月遅れ/返戻 + 入金状況) ── */
        <div className="space-y-2">
          <span className="text-[11px] text-gray-400">
            kaigo_care_support_claims の月次集計 (draft 含む全件)
            {hasNyukin ? " + kokuho_nyukin_records の入金状況" : ""}
          </span>
          <div className="overflow-auto border border-gray-300 rounded">
            <table className="min-w-full text-xs border-collapse">
              <thead className="bg-gray-100 sticky top-0 z-10">
                <tr>
                  <th className={`${thCls} text-left w-24`}>対象月</th>
                  <th className={`${thCls} text-right w-20`}>請求件数</th>
                  <th className={`${thCls} text-right w-28`}>単位数</th>
                  <th className={`${thCls} text-right w-32`}>保険請求額</th>
                  <th className={`${thCls} text-right w-20`}>月遅れ</th>
                  <th className={`${thCls} text-right w-20`}>返戻</th>
                  {hasNyukin && <th className={`${thCls} text-center w-32`}>入金状況</th>}
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
                      {m.units.toLocaleString()}
                    </td>
                    <td className={`${tdCls} text-right font-mono`}>
                      ¥{m.amount.toLocaleString()}
                    </td>
                    <td
                      className={`${tdCls} text-right font-mono ${m.tsukiokure > 0 ? "text-amber-600 font-semibold" : ""}`}
                    >
                      {m.tsukiokure.toLocaleString()}
                    </td>
                    <td
                      className={`${tdCls} text-right font-mono ${m.henrei > 0 ? "text-red-600 font-semibold" : ""}`}
                    >
                      {m.henrei.toLocaleString()}
                    </td>
                    {hasNyukin && (
                      <td className={`${tdCls} text-center`}>
                        {m.nyukin ? (
                          <span
                            className={`inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-semibold ${NYUKIN_CLS[m.nyukin.status] ?? "bg-gray-100 text-gray-600"}`}
                            title={
                              m.nyukin.nyukin_date
                                ? `入金日: ${m.nyukin.nyukin_date}`
                                : undefined
                            }
                          >
                            {m.nyukin.status}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {monthly.length > 0 && (
                  <tr className="bg-gray-50 font-semibold">
                    <td className={`${tdCls}`}>合計</td>
                    <td className={`${tdCls} text-right font-mono`}>
                      {monthlyTotal.count.toLocaleString()}
                    </td>
                    <td className={`${tdCls} text-right font-mono`}>
                      {monthlyTotal.units.toLocaleString()}
                    </td>
                    <td className={`${tdCls} text-right font-mono`}>
                      ¥{monthlyTotal.amount.toLocaleString()}
                    </td>
                    <td
                      className={`${tdCls} text-right font-mono ${monthlyTotal.tsukiokure > 0 ? "text-amber-600" : ""}`}
                    >
                      {monthlyTotal.tsukiokure.toLocaleString()}
                    </td>
                    <td
                      className={`${tdCls} text-right font-mono ${monthlyTotal.henrei > 0 ? "text-red-600" : ""}`}
                    >
                      {monthlyTotal.henrei.toLocaleString()}
                    </td>
                    {hasNyukin && <td className={`${tdCls}`} />}
                  </tr>
                )}
                {monthly.length === 0 && (
                  <tr>
                    <td
                      colSpan={hasNyukin ? 7 : 6}
                      className="px-3 py-8 text-center text-gray-400 text-sm"
                    >
                      期間の指定が不正です
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* ── タブ 3: 集中減算 (特定事業所集中減算の判定。判定期間は前期/後期をタブ内で選択。
           遅延読込。タブ切替でアンマウントしない = 再取得防止) ── */}
      <div className={tab === "unei" ? "" : "hidden"}>
        <UneiKijunTab active={tab === "unei"} officeId={currentOfficeId} />
      </div>

      <div className={tab === "conc" ? "" : "hidden"}>
        <ShuchuGensanTab active={tab === "conc"} officeId={currentOfficeId} />
      </div>

      {/* ── タブ 4: 経営分析 (遅延読込。タブ切替でアンマウントしない = 再取得防止) ── */}
      <div className={tab === "keiei" ? "" : "hidden"}>
        <KeieiBunsekiKyotakuTab
          active={tab === "keiei"}
          officeId={currentOfficeId}
          fromMonth={fromMonth}
          toMonth={toMonth}
        />
      </div>
    </div>
  );
}
