"use client";

/**
 * 国保連 入金管理 (居宅介護支援) — billing/seikyu の入金管理タブ
 *
 * 対象 office × 請求月 (YYYY-MM) の kokuho_nyukin_records 1 行を管理する:
 *   - 行が無い → 「入金記録を作成」: kaigo_care_support_claims (confirmed/submitted) の
 *     当月合計 insurance_amount を請求額スナップショットとして INSERT
 *   - 行がある → 支払決定額 / 入金日 / 状態 / 備考 を編集して UPDATE
 *   - 請求額 − 支払決定額 の差額を表示。差額 ≠ 0 は赤字 + 「差額あり」を提案
 *   - 下に過去 6 ヶ月分の履歴一覧
 *
 * テーブル未作成 (42P01 / PGRST205) は amber バナーで migration 適用を案内
 * (master/office/_applied-formula.tsx と同じ流儀)。
 * デザインは billing-visit/riyou-seikyu の入金管理 (状態バッジ + text-xs) に合わせる。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Landmark, Loader2, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

interface NyukinRow {
  id: string;
  office_id: string;
  target_month: string;
  seikyu_amount: number;
  kettei_amount: number | null;
  nyukin_date: string | null;
  status: string;
  notes: string | null;
}

type NyukinStatus = "未入金" | "入金済" | "差額あり";

// 状態バッジの配色 (riyou-seikyu の PAYMENT_STATUS_CLS と同じトーン)
const STATUS_CLS: Record<string, string> = {
  未入金: "bg-gray-100 text-gray-600",
  入金済: "bg-emerald-100 text-emerald-700",
  差額あり: "bg-red-100 text-red-700",
};

// YYYY-MM に delta ヶ月を加算
function addMonths(ym: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const total = parseInt(m[1], 10) * 12 + (parseInt(m[2], 10) - 1) + delta;
  const y = Math.floor(total / 12);
  const mo = (total % 12) + 1;
  return `${y}-${String(mo).padStart(2, "0")}`;
}

// YYYY-MM → 「R8/ 5」表記 (請求タブと同じ和暦月)
function reiwaMonth(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `R${parseInt(m[1], 10) - 2018}/${parseInt(m[2], 10)}`;
}

export function NyukinContent({
  officeId,
  tenantId,
  month,
}: {
  officeId: string | null;
  tenantId: string | null;
  month: string; // 'YYYY-MM'
}) {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [tableMissing, setTableMissing] = useState(false);
  const [record, setRecord] = useState<NyukinRow | null>(null);
  const [history, setHistory] = useState<NyukinRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  // 編集フォーム (record 読込時に load() 内で同期)
  const [ketteiStr, setKetteiStr] = useState("");
  const [nyukinDate, setNyukinDate] = useState("");
  const [status, setStatus] = useState<NyukinStatus>("未入金");
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    if (!officeId) {
      setRecord(null);
      setHistory([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    // 当月 + 過去 6 ヶ月を 1 クエリで取得 (target_month は 'YYYY-MM' TEXT なので文字列比較で範囲指定可)
    const { data, error } = await supabase
      .from("kokuho_nyukin_records")
      .select(
        "id, office_id, target_month, seikyu_amount, kettei_amount, nyukin_date, status, notes",
      )
      .eq("office_id", officeId)
      .gte("target_month", addMonths(month, -6))
      .lte("target_month", month)
      .order("target_month", { ascending: false });
    if (error) {
      // テーブル未作成 (migration 未適用) → amber バナーで案内して続行
      if (error.code === "42P01" || error.code === "PGRST205") {
        setTableMissing(true);
      } else {
        toast.error("入金記録の取得に失敗: " + error.message);
      }
      setRecord(null);
      setHistory([]);
      setLoading(false);
      return;
    }
    setTableMissing(false);
    const rows = (data ?? []) as NyukinRow[];
    const cur = rows.find((r) => r.target_month === month) ?? null;
    setRecord(cur);
    setHistory(rows.filter((r) => r.target_month !== month));
    // 編集フォームへ反映
    setKetteiStr(cur?.kettei_amount != null ? String(cur.kettei_amount) : "");
    setNyukinDate(cur?.nyukin_date ?? "");
    setStatus((cur?.status as NyukinStatus) ?? "未入金");
    setNotes(cur?.notes ?? "");
    setLoading(false);
  }, [supabase, officeId, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- office/月変更時の再読込
    load();
  }, [load]);

  // ── 入金記録を作成: 当月の確定済請求 (confirmed/submitted) の保険請求額を snapshot ──
  const handleCreate = async () => {
    if (!officeId) return;
    setCreating(true);
    let total = 0;
    let count = 0;
    // PostgREST の 1000 行 limit を跨いでも合計が欠けないよう range でページング
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("kaigo_care_support_claims")
        .select("insurance_amount")
        .eq("billing_month", month)
        .in("status", ["confirmed", "submitted"])
        .range(from, from + PAGE - 1);
      if (error) {
        toast.error("請求額の集計に失敗: " + error.message);
        setCreating(false);
        return;
      }
      const rows = (data ?? []) as { insurance_amount: number | null }[];
      for (const r of rows) total += r.insurance_amount ?? 0;
      count += rows.length;
      if (rows.length < PAGE) break;
    }
    const { error: insertErr } = await supabase.from("kokuho_nyukin_records").insert({
      tenant_id: tenantId ?? "kt-group",
      office_id: officeId,
      target_month: month,
      seikyu_amount: total,
      status: "未入金",
    });
    setCreating(false);
    if (insertErr) {
      if (insertErr.code === "42P01" || insertErr.code === "PGRST205") {
        setTableMissing(true);
      } else {
        toast.error("入金記録の作成に失敗: " + insertErr.message);
      }
      return;
    }
    toast.success(
      `入金記録を作成しました (請求額 ¥${total.toLocaleString()} / 確定済 ${count} 件)`,
    );
    await load();
  };

  // ── 支払決定額 / 入金日 / 状態 / 備考 を保存 ──
  const handleSave = async () => {
    if (!record) return;
    const kettei = ketteiStr === "" ? null : parseInt(ketteiStr, 10);
    if (kettei != null && Number.isNaN(kettei)) {
      toast.error("支払決定額が数値ではありません");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("kokuho_nyukin_records")
      .update({
        kettei_amount: kettei,
        nyukin_date: nyukinDate || null,
        status,
        notes: notes || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", record.id);
    setSaving(false);
    if (error) {
      toast.error("保存に失敗: " + error.message);
      return;
    }
    toast.success("入金記録を保存しました");
    await load();
  };

  // 差額 = 請求額 − 支払決定額 (決定額未入力は null)
  const kettei = ketteiStr === "" ? null : parseInt(ketteiStr, 10);
  const diff =
    record && kettei != null && !Number.isNaN(kettei) ? record.seikyu_amount - kettei : null;

  const thCls = "px-2 py-1.5 border border-gray-300 text-gray-700";
  const tdCls = "px-2 py-1 border border-gray-200";

  if (tableMissing) {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        kokuho_nyukin_records テーブル未作成。migrations/kokuho_nyukin_records.sql を
        Supabase SQL Editor で実行してください。
      </div>
    );
  }

  if (!officeId) {
    return (
      <div className="rounded border border-gray-200 bg-gray-50 px-3 py-4 text-xs text-gray-500">
        事業所を選択してください
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 size={20} className="animate-spin text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4 text-xs">
      {/* ── 当月の入金記録 ── */}
      <div className="rounded border border-blue-200 bg-blue-50/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-bold text-blue-800">
            <Landmark size={14} />
            国保連入金管理 ({reiwaMonth(month)} 請求分)
          </span>
          {record && (
            <span
              className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold ${STATUS_CLS[record.status] ?? "bg-gray-100 text-gray-600"}`}
            >
              {record.status}
            </span>
          )}
        </div>

        {!record ? (
          <div className="space-y-2">
            <p className="text-gray-500">
              {reiwaMonth(month)} の入金記録はまだありません。作成すると当月の確定済請求
              (confirmed / submitted) の保険請求額合計をスナップショットとして保存します。
            </p>
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              入金記録を作成
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {/* 請求額 / 決定額 / 差額 */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <span>
                請求額 (スナップショット){" "}
                <span className="font-mono font-semibold">
                  ¥{record.seikyu_amount.toLocaleString()}
                </span>
              </span>
              {diff != null && (
                <span className={diff !== 0 ? "font-semibold text-red-600" : "text-gray-600"}>
                  差額 (請求 − 決定){" "}
                  <span className="font-mono">
                    {diff > 0 ? "" : diff < 0 ? "▲" : ""}¥{Math.abs(diff).toLocaleString()}
                  </span>
                  {diff !== 0 && status !== "差額あり" && (
                    <button
                      type="button"
                      onClick={() => setStatus("差額あり")}
                      className="ml-2 rounded border border-red-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-50"
                    >
                      「差額あり」にする
                    </button>
                  )}
                </span>
              )}
            </div>

            {/* 編集フォーム */}
            <div className="flex flex-wrap items-end gap-1.5">
              <div className="w-28">
                <label className="mb-0.5 block text-[10px] text-gray-500">支払決定額</label>
                <input
                  type="number"
                  value={ketteiStr}
                  onChange={(e) => setKetteiStr(e.target.value)}
                  placeholder="未通知"
                  className="w-full rounded border px-2 py-1.5 text-right tabular-nums focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-0.5 block text-[10px] text-gray-500">入金日</label>
                <input
                  type="date"
                  value={nyukinDate}
                  onChange={(e) => setNyukinDate(e.target.value)}
                  className="rounded border px-2 py-1.5 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-0.5 block text-[10px] text-gray-500">状態</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as NyukinStatus)}
                  className="rounded border px-2 py-1.5 focus:border-blue-500 focus:outline-none"
                >
                  <option>未入金</option>
                  <option>入金済</option>
                  <option>差額あり</option>
                </select>
              </div>
              <div className="min-w-40 flex-1">
                <label className="mb-0.5 block text-[10px] text-gray-500">備考</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="返戻分の再請求予定 など"
                  className="w-full rounded border px-2 py-1.5 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="rounded bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── 過去 6 ヶ月の履歴 ── */}
      <div className="space-y-1">
        <span className="text-[11px] text-gray-400">過去 6 ヶ月の入金記録</span>
        <div className="overflow-auto rounded border border-gray-300">
          <table className="min-w-full border-collapse text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className={`${thCls} w-20 text-left`}>請求月</th>
                <th className={`${thCls} w-28 text-right`}>請求額</th>
                <th className={`${thCls} w-28 text-right`}>支払決定額</th>
                <th className={`${thCls} w-24 text-right`}>差額</th>
                <th className={`${thCls} w-24 text-center`}>入金日</th>
                <th className={`${thCls} w-20 text-center`}>状態</th>
                <th className={`${thCls} text-left`}>備考</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const d = h.kettei_amount != null ? h.seikyu_amount - h.kettei_amount : null;
                return (
                  <tr key={h.id} className="hover:bg-blue-50">
                    <td className={`${tdCls} font-mono`}>{reiwaMonth(h.target_month)}</td>
                    <td className={`${tdCls} text-right font-mono`}>
                      ¥{h.seikyu_amount.toLocaleString()}
                    </td>
                    <td className={`${tdCls} text-right font-mono`}>
                      {h.kettei_amount != null ? `¥${h.kettei_amount.toLocaleString()}` : "—"}
                    </td>
                    <td
                      className={`${tdCls} text-right font-mono ${d != null && d !== 0 ? "font-semibold text-red-600" : ""}`}
                    >
                      {d != null ? `${d < 0 ? "▲" : ""}¥${Math.abs(d).toLocaleString()}` : "—"}
                    </td>
                    <td className={`${tdCls} text-center font-mono`}>{h.nyukin_date ?? "—"}</td>
                    <td className={`${tdCls} text-center`}>
                      <span
                        className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_CLS[h.status] ?? "bg-gray-100 text-gray-600"}`}
                      >
                        {h.status}
                      </span>
                    </td>
                    <td className={`${tdCls} text-gray-600`}>{h.notes ?? ""}</td>
                  </tr>
                );
              })}
              {history.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-sm text-gray-400">
                    過去 6 ヶ月の入金記録はありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
