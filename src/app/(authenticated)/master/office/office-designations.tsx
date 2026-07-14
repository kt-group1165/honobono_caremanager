"use client";

/**
 * 事業所の追加指定サービス編集 (案②)
 *
 * 1 事業所マスタが 居宅介護支援(43, = offices の主番号) に加えて
 * 介護予防支援(46) 等の指定を持つ場合の、番号・加算・指定区分を管理する。
 * office_service_designations テーブル (migration: office_service_designations_v1.sql)。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Plus, Trash2, Loader2 } from "lucide-react";

type Designation = {
  id: string;
  office_id: string;
  service_category: string;
  service_category_name: string | null;
  business_number: string | null;
  designation_type: "指定" | "委託";
  designated_from: string | null;
  notes: string | null;
};

// 追加できるサービス種類 (主番号=居宅43 の事業所に付け足す想定。当面 46 中心)
const CATEGORY_OPTIONS: { value: string; name: string }[] = [
  { value: "46", name: "介護予防支援" },
];

export function OfficeDesignations({ officeId }: { officeId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Designation[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("office_service_designations")
      .select("id, office_id, service_category, service_category_name, business_number, designation_type, designated_from, notes")
      .eq("office_id", officeId)
      .order("service_category");
    if (error) { toast.error("追加指定の取得に失敗: " + error.message); setLoading(false); return; }
    setRows((data ?? []) as Designation[]);
    setLoading(false);
  }, [supabase, officeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 事業所切替時の再取得
    load();
  }, [load]);

  const addRow = async () => {
    // 未登録のカテゴリを1つ選ぶ
    const used = new Set(rows.map((r) => r.service_category));
    const opt = CATEGORY_OPTIONS.find((o) => !used.has(o.value));
    if (!opt) { toast.info("追加できる指定はすべて登録済みです"); return; }
    const { error } = await supabase.from("office_service_designations").insert({
      office_id: officeId,
      service_category: opt.value,
      service_category_name: opt.name,
      designation_type: "指定",
    });
    if (error) { toast.error("追加に失敗: " + error.message); return; }
    load();
  };

  const saveRow = async (row: Designation) => {
    setSavingId(row.id);
    const { error } = await supabase
      .from("office_service_designations")
      .update({
        business_number: row.business_number || null,
        designation_type: row.designation_type,
        designated_from: row.designated_from || null,
        notes: row.notes || null,
      })
      .eq("id", row.id);
    setSavingId(null);
    if (error) { toast.error("保存に失敗: " + error.message); return; }
    toast.success("保存しました");
  };

  const deleteRow = async (row: Designation) => {
    if (!confirm(`${row.service_category_name || row.service_category} の指定を削除しますか?`)) return;
    const { error } = await supabase.from("office_service_designations").delete().eq("id", row.id);
    if (error) { toast.error("削除に失敗: " + error.message); return; }
    load();
  };

  const patch = (id: string, k: keyof Designation, v: string) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [k]: v } : r)));

  const inputCls = "w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
      <div className="flex items-center justify-between border-b pb-2">
        <h2 className="text-sm font-bold text-gray-700">追加の指定サービス</h2>
        <button onClick={addRow} className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
          <Plus size={14} />指定を追加
        </button>
      </div>
      <p className="text-xs text-gray-500">
        居宅介護支援(主番号は上の「事業所番号」)に加えて、介護予防支援(46)など別のサービス種類の
        指定を持つ場合に、その事業所番号・指定区分を登録します。予防給付の請求は要支援者を
        この番号で出します。番号は自前指定でも地域包括委託先の番号でも構いません。
      </p>

      {loading ? (
        <div className="flex justify-center py-6"><Loader2 size={20} className="animate-spin text-gray-300" /></div>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-gray-400">追加指定はありません</p>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <div key={r.id} className="rounded-lg border border-gray-100 bg-gray-50/50 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                  {r.service_category}：{r.service_category_name}
                </span>
                <div className="flex items-center gap-2">
                  <button onClick={() => saveRow(r)} disabled={savingId === r.id}
                    className="flex items-center gap-1 rounded-lg border border-blue-200 bg-white px-3 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50">
                    {savingId === r.id && <Loader2 size={12} className="animate-spin" />}保存
                  </button>
                  <button onClick={() => deleteRow(r)} className="p-1 text-gray-400 hover:text-red-500"><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">事業所番号（10桁）</label>
                  <input value={r.business_number ?? ""} onChange={(e) => patch(r.id, "business_number", e.target.value)} placeholder="1201100011" className={inputCls} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">指定区分</label>
                  <select value={r.designation_type} onChange={(e) => patch(r.id, "designation_type", e.target.value)} className={inputCls}>
                    <option value="指定">指定（自前）</option>
                    <option value="委託">委託（地域包括）</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">指定年月日</label>
                  <input type="date" value={r.designated_from ?? ""} onChange={(e) => patch(r.id, "designated_from", e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">備考</label>
                  <input value={r.notes ?? ""} onChange={(e) => patch(r.id, "notes", e.target.value)} className={inputCls} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
