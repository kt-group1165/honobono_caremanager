"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import {
  GENSAN_LABELS,
  type GensanType,
} from "@/lib/visit-seikyu/gyakutai-bcp";

// ─── 減算 (体制未整備) — 訪問介護・訪問入浴の 虐防/業未 減算の適用期間設定 ──────
// 高齢者虐待防止措置未実施減算 / 業務継続計画(BCP)未策定減算 (各 1%)。
// 訪問介護 (種類11)・訪問入浴介護 (種類12) には独立減算コードが無く、基本コードの
// 合成バリエーション (「身体介護２・虐防・業未」「訪問入浴・虐防・業未」等) で
// 算定するため、ここで設定した期間の月は請求集計 (visit-seikyu / bath-seikyu の
// aggregate) が基本サービスコードを自動で差し替える。
// 保存先: kaigo_office_gensan_periods (migrations/gyakutai_bcp_gensan.sql)。
// テーブル未適用の環境は案内バナー表示 + 従来動作 (減算なし)。

interface GensanPeriodRow {
  id: string;
  gensan_type: GensanType;
  start_month: string | null;
  end_month: string | null;
  notes: string | null;
}

const GENSAN_OPTIONS: { value: GensanType; label: string }[] = [
  { value: "gyakutai", label: `${GENSAN_LABELS.gyakutai} (所定単位数の1%減算)` },
  { value: "bcp", label: `${GENSAN_LABELS.bcp} (所定単位数の1%減算)` },
];

const currentMonthStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export function GensanSection({
  officeId,
  tenantId,
}: {
  officeId: string;
  tenantId: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<GensanPeriodRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tableMissing, setTableMissing] = useState(false);
  const [newType, setNewType] = useState<GensanType | "">("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("kaigo_office_gensan_periods")
      .select("id, gensan_type, start_month, end_month, notes")
      .eq("office_id", officeId)
      .order("start_month", { ascending: true, nullsFirst: true });
    if (error) {
      // テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) → 案内表示で続行
      if (error.code === "42P01" || error.code === "PGRST205") {
        setTableMissing(true);
      } else {
        toast.error("減算設定の読込に失敗: " + error.message);
      }
      setRows([]);
      setLoading(false);
      return;
    }
    setTableMissing(false);
    setRows((data ?? []) as GensanPeriodRow[]);
    setLoading(false);
  }, [supabase, officeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 依存変更で再読込
    load();
  }, [load]);

  const handleAdd = async () => {
    if (!newType) {
      toast.error("減算の種類を選択してください");
      return;
    }
    if (newStart && newEnd && newStart > newEnd) {
      toast.error("開始月が終了月より後になっています");
      return;
    }
    setAdding(true);
    const { error } = await supabase.from("kaigo_office_gensan_periods").insert({
      office_id: officeId,
      tenant_id: tenantId,
      gensan_type: newType,
      start_month: newStart || null,
      end_month: newEnd || null,
    });
    setAdding(false);
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205") {
        setTableMissing(true);
        toast.error("テーブル (kaigo_office_gensan_periods) が未作成です");
      } else {
        toast.error("追加に失敗: " + error.message);
      }
      return;
    }
    toast.success("減算の適用期間を追加しました");
    setNewType("");
    setNewStart("");
    setNewEnd("");
    await load();
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("この減算の適用期間を削除します。よろしいですか？")) return;
    const { error } = await supabase
      .from("kaigo_office_gensan_periods")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error("削除に失敗: " + error.message);
      return;
    }
    toast.success("減算の適用期間を削除しました");
    await load();
  };

  const nowMonth = currentMonthStr();
  const isActiveNow = (r: GensanPeriodRow) =>
    (r.start_month == null || r.start_month <= nowMonth) &&
    (r.end_month == null || r.end_month >= nowMonth);

  return (
    <div className="rounded-xl border bg-white p-6 shadow-sm space-y-3">
      <div>
        <h2 className="text-sm font-bold text-gray-700 border-b pb-2">
          減算 (体制未整備)
        </h2>
        <p className="text-xs text-gray-500 mt-2">
          高齢者虐待防止措置未実施減算・業務継続計画(BCP)未策定減算 (各 所定単位数の1%)。
          適用期間内の月は、請求集計時に基本サービスコードを減算織込み済の合成コード
          (「・虐防」「・業未」付き) へ自動で差し替えます。減算は体制が改善されるまでの
          期間性のため、改善月の前月を終了月に設定してください (空欄 = 無期限)。
        </p>
      </div>
      {tableMissing ? (
        <p className="text-sm text-amber-700 bg-amber-50 rounded px-3 py-2">
          テーブル (kaigo_office_gensan_periods) が未作成です。
          migrations/gyakutai_bcp_gensan.sql を Supabase SQL Editor で適用すると
          利用できます (適用まで減算なしで集計します)。
        </p>
      ) : loading ? (
        <p className="text-sm text-gray-400 py-2">読込中...</p>
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="text-sm text-gray-400 py-1">
              適用中の減算はありません (通常の基本コードで請求します)
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-y">
                  <th className="px-2 py-1.5 text-left text-xs text-gray-600">減算</th>
                  <th className="px-2 py-1.5 text-left text-xs text-gray-600">開始月</th>
                  <th className="px-2 py-1.5 text-left text-xs text-gray-600">終了月</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-2 py-1.5">
                      <span className="text-gray-800">
                        {GENSAN_LABELS[r.gensan_type] ?? r.gensan_type}
                      </span>{" "}
                      <span className="text-[10px] text-red-500 font-medium">-1%</span>
                      {isActiveNow(r) && (
                        <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600">
                          今月適用中
                        </span>
                      )}
                      {r.notes && (
                        <span className="ml-1 text-[10px] text-gray-400">({r.notes})</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-gray-700">{r.start_month ?? "最初から"}</td>
                    <td className="px-2 py-1.5 text-gray-700">{r.end_month ?? "無期限"}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => handleDelete(r.id)}
                        className="text-xs text-red-500 hover:text-red-700 inline-flex items-center gap-1"
                      >
                        <Trash2 size={12} /> 削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex flex-wrap items-end gap-2 pt-1">
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-gray-500">減算の種類</span>
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as GensanType | "")}
                className="rounded border px-2 py-1 text-sm focus:border-blue-500 focus:outline-none max-w-xs"
              >
                <option value="">選択...</option>
                {GENSAN_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-gray-500">開始月 (空=最初から)</span>
              <input
                type="month"
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
                className="rounded border px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-gray-500">終了月 (空=無期限)</span>
              <input
                type="month"
                value={newEnd}
                onChange={(e) => setNewEnd(e.target.value)}
                className="rounded border px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
              />
            </label>
            <button
              type="button"
              onClick={handleAdd}
              disabled={adding || !newType}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40 inline-flex items-center gap-1"
            >
              <Plus size={14} /> {adding ? "追加中..." : "行追加"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
