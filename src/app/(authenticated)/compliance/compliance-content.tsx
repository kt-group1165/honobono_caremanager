"use client";

/**
 * 体制整備の記録 (委員会・指針・研修・訓練・担当者選任)
 *
 * 2026-09-01 監査是正で新設。虐待防止 / BCP の **1% + 1% 減算**の立証に直結する。
 *
 * 現状 kaigo_office_gensan_periods は 0 件 = 全 59 事業所が「減算なし」で請求している。
 * 実地指導で体制未整備と判定されると遡って返還になる。
 * さらに契約書テンプレには「委員会を設置し、指針を整備し、定期的に研修及び訓練を
 * 実施します」と利用者に約束する文面が入っている。約束していて記録が無いのが一番まずい。
 *
 * 分野 × 種別 のマトリクスで「その年に何件あるか」を一望できるようにした。
 * 5 分野それぞれに画面を作ると結局どれも埋まらないので 1 画面に統合している。
 *
 * ⚠ 必要な実施頻度 (年1回以上 等) はサービス種別・自治体で差があり経過措置もあった。
 *   **この画面は頻度を判定しない。0 件を警告するだけ。** 頻度の判断は人がする。
 *   誤った頻度をシステムが正としてしまうほうが危険なため。
 *
 * 保存先: migrations/compliance_records_v1.sql (kaigo_compliance_records)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { ShieldCheck, Plus, Save, Trash2, Loader2, X } from "lucide-react";
import { useBusinessType } from "@/lib/business-type-context";

const CATEGORIES = [
  "虐待防止",
  "身体拘束適正化",
  "感染症対策",
  "業務継続(BCP)",
  "ハラスメント対策",
  "事故防止",
  "その他",
] as const;

const KINDS = ["委員会", "指針", "研修", "訓練", "担当者選任"] as const;

/** 減算に直結する分野 (未整備だと所定単位数の 1%) */
const GENSAN_CATEGORIES = new Set(["虐待防止", "業務継続(BCP)"]);

export type Row = {
  id?: string;
  office_id?: string | null;
  category: string;
  kind: string;
  held_on: string;
  title?: string | null;
  attendees?: string | null;
  attendee_count?: number | null;
  leader_name?: string | null;
  content?: string | null;
  document_name?: string | null;
  revised_on?: string | null;
  next_due_on?: string | null;
  notes?: string | null;
};

export const isMissingTable = (code?: string) => code === "42P01" || code === "PGRST205";

export function ComplianceContent({
  initialOfficeId,
  initialYear,
  initialRows,
  initialTableMissing,
}: {
  initialOfficeId: string | null;
  initialYear: string;
  initialRows: Row[];
  initialTableMissing: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice } = useBusinessType();
  const officeId = currentOffice?.id ?? null;

  const [year, setYear] = useState(initialYear);
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [loading, setLoading] = useState(false);
  const [tableMissing, setTableMissing] = useState(initialTableMissing);
  const [editing, setEditing] = useState<Row | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!officeId) return;
    setLoading(true);
    setTableMissing(false);
    const { data, error } = await supabase
      .from("kaigo_compliance_records")
      .select("*")
      .eq("office_id", officeId)
      .gte("held_on", `${year}-01-01`)
      .lte("held_on", `${year}-12-31`)
      .order("held_on", { ascending: false });
    setLoading(false);
    if (error) {
      if (isMissingTable(error.code)) {
        setTableMissing(true);
        setRows([]);
        return;
      }
      toast.error(`読み込みに失敗しました: ${error.message}`);
      setRows([]);
      return;
    }
    setRows((data ?? []) as Row[]);
  }, [supabase, officeId, year]);

  // 初回 mount は server (?office= 付きなら) から渡された initial* をそのまま使う。
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      if (initialOfficeId && initialOfficeId === officeId) return;
    }
    load();
  }, [load, officeId, initialOfficeId]);

  /** 分野 × 種別 の件数 */
  const matrix = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(`${r.category}::${r.kind}`, (m.get(`${r.category}::${r.kind}`) ?? 0) + 1);
    return m;
  }, [rows]);

  const startNew = (category?: string, kind?: string) =>
    setEditing({
      category: category ?? CATEGORIES[0],
      kind: kind ?? KINDS[0],
      held_on: `${year}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`,
    });

  const save = async () => {
    if (!editing) return;
    if (!officeId) {
      toast.error("事業所が未選択のため保存できません");
      return;
    }
    if (!editing.held_on) {
      toast.error("実施日は必須です");
      return;
    }
    setSaving(true);
    const payload: Record<string, unknown> = {
      ...editing,
      office_id: officeId,
      updated_at: new Date().toISOString(),
    };
    // 空文字は NULL に (date 列に "" を入れると 22007 で落ちる)
    for (const k of ["revised_on", "next_due_on"]) {
      if (payload[k] === "") payload[k] = null;
    }
    if (payload.attendee_count === "" || Number.isNaN(payload.attendee_count)) {
      payload.attendee_count = null;
    }
    const { error } = editing.id
      ? await supabase.from("kaigo_compliance_records").update(payload).eq("id", editing.id)
      : await supabase.from("kaigo_compliance_records").insert(payload);
    setSaving(false);
    if (error) {
      toast.error(`保存に失敗しました: ${error.message}`);
      return;
    }
    toast.success("保存しました");
    setEditing(null);
    load();
  };

  const remove = async () => {
    if (!editing?.id) return;
    if (!confirm("この記録を削除します。よろしいですか？\n(削除は監査ログに残ります)")) return;
    const { error } = await supabase.from("kaigo_compliance_records").delete().eq("id", editing.id);
    if (error) {
      toast.error(`削除に失敗しました: ${error.message}`);
      return;
    }
    toast.success("削除しました");
    setEditing(null);
    load();
  };

  const inputCls = "w-full rounded border border-gray-300 px-2 py-1 text-xs";

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-sm font-semibold text-gray-800">
          <ShieldCheck size={16} /> 体制整備の記録
        </h1>
        <label className="text-xs text-gray-600">
          年{" "}
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="w-20 rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </label>
        <button
          type="button"
          onClick={() => startNew()}
          disabled={!officeId}
          className="flex items-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          <Plus size={13} /> 新規
        </button>
      </div>

      <p className="mb-4 rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
        <span className="font-medium">虐待防止</span> と{" "}
        <span className="font-medium">業務継続(BCP)</span>{" "}
        は未整備だと所定単位数の <span className="font-medium">1% ずつ</span>{" "}
        減算されます。契約書にも「委員会を設置し、指針を整備し、定期的に研修及び訓練を実施します」と
        記載しているので、実地指導ではここの記録を求められます。
        <br />
        <span className="text-gray-500">
          ⚠ 必要な実施回数はサービス種別・自治体で差があるため、この画面は
          <span className="font-medium">件数を出すだけで頻度の判定はしません</span>。
        </span>
      </p>

      {tableMissing && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          ⚠ テーブルが未作成です。
          <code className="mx-1">migrations/compliance_records_v1.sql</code>
          を Supabase SQL Editor で適用してください。
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-gray-300" size={28} />
        </div>
      ) : (
        <>
          {/* 分野 × 種別 マトリクス */}
          <div className="mb-6 overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full text-xs">
              <thead className="border-b border-gray-200 bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">分野</th>
                  {KINDS.map((k) => (
                    <th key={k} className="px-3 py-2 text-center font-medium">{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CATEGORIES.map((cat) => {
                  const gensan = GENSAN_CATEGORIES.has(cat);
                  return (
                    <tr key={cat} className="border-b border-gray-100">
                      <td className="px-3 py-2 text-gray-800">
                        {cat}
                        {gensan && (
                          <span className="ml-1 rounded bg-red-100 px-1 text-[10px] text-red-700">
                            減算 1%
                          </span>
                        )}
                      </td>
                      {KINDS.map((k) => {
                        const n = matrix.get(`${cat}::${k}`) ?? 0;
                        return (
                          <td key={k} className="px-3 py-2 text-center">
                            <button
                              type="button"
                              onClick={() => startNew(cat, k)}
                              title={`${cat} の ${k} を追加`}
                              className={`rounded px-2 py-0.5 ${
                                n > 0
                                  ? "bg-emerald-50 text-emerald-700"
                                  : gensan
                                    ? "bg-red-50 text-red-600"
                                    : "text-gray-300 hover:bg-gray-50"
                              }`}
                            >
                              {n > 0 ? `${n} 件` : "0"}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 明細 */}
          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
              {year} 年の記録はまだありません。上のマス目を押すとその分野・種別で新規作成できます。
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="w-full text-xs">
                <thead className="border-b border-gray-200 bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">実施日</th>
                    <th className="px-3 py-2 text-left font-medium">分野</th>
                    <th className="px-3 py-2 text-left font-medium">種別</th>
                    <th className="px-3 py-2 text-left font-medium">議題・研修名</th>
                    <th className="px-3 py-2 text-left font-medium">責任者・講師</th>
                    <th className="px-3 py-2 text-right font-medium">出席</th>
                    <th className="px-3 py-2 text-left font-medium">次回予定</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => setEditing({ ...r })}
                      className="cursor-pointer border-b border-gray-100 hover:bg-indigo-50/40"
                    >
                      <td className="whitespace-nowrap px-3 py-1.5 text-gray-800">{r.held_on}</td>
                      <td className="whitespace-nowrap px-3 py-1.5">{r.category}</td>
                      <td className="whitespace-nowrap px-3 py-1.5">{r.kind}</td>
                      <td className="px-3 py-1.5">{r.title || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-1.5">{r.leader_name || "—"}</td>
                      <td className="px-3 py-1.5 text-right">{r.attendee_count ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-gray-500">
                        {r.next_due_on || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6">
          <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-800">
                体制整備の記録{editing.id ? " の編集" : " の新規作成"}
              </h2>
              <button type="button" onClick={() => setEditing(null)} className="text-gray-400 hover:text-gray-700">
                <X size={18} />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="text-xs text-gray-600">
                分野
                <select
                  className={inputCls}
                  value={editing.category}
                  onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                >
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-600">
                種別
                <select
                  className={inputCls}
                  value={editing.kind}
                  onChange={(e) => setEditing({ ...editing, kind: e.target.value })}
                >
                  {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-600">
                実施日 (開催日 / 策定日)
                <input
                  type="date"
                  className={inputCls}
                  value={editing.held_on ?? ""}
                  onChange={(e) => setEditing({ ...editing, held_on: e.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600">
                次回予定日
                <input
                  type="date"
                  className={inputCls}
                  value={editing.next_due_on ?? ""}
                  onChange={(e) => setEditing({ ...editing, next_due_on: e.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600 md:col-span-2">
                議題・研修名
                <input
                  className={inputCls}
                  value={editing.title ?? ""}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600">
                責任者・講師・担当者
                <input
                  className={inputCls}
                  value={editing.leader_name ?? ""}
                  onChange={(e) => setEditing({ ...editing, leader_name: e.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600">
                出席者数
                <input
                  type="number"
                  className={inputCls}
                  value={editing.attendee_count ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      attendee_count: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="text-xs text-gray-600 md:col-span-2">
                出席者 (氏名)
                <textarea
                  rows={2}
                  className={inputCls}
                  value={editing.attendees ?? ""}
                  onChange={(e) => setEditing({ ...editing, attendees: e.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600 md:col-span-2">
                内容・議事の要点
                <textarea
                  rows={4}
                  className={inputCls}
                  value={editing.content ?? ""}
                  onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600">
                指針・計画の文書名
                <input
                  className={inputCls}
                  value={editing.document_name ?? ""}
                  onChange={(e) => setEditing({ ...editing, document_name: e.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600">
                指針・計画の改定日
                <input
                  type="date"
                  className={inputCls}
                  value={editing.revised_on ?? ""}
                  onChange={(e) => setEditing({ ...editing, revised_on: e.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600 md:col-span-2">
                備考
                <textarea
                  rows={2}
                  className={inputCls}
                  value={editing.notes ?? ""}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                />
              </label>
            </div>

            <div className="mt-4 flex items-center justify-between">
              {editing.id ? (
                <button
                  type="button"
                  onClick={remove}
                  className="flex items-center gap-1 rounded border border-red-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                >
                  <Trash2 size={13} /> 削除
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="flex items-center gap-1 rounded bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="animate-spin" size={13} /> : <Save size={13} />} 保存する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
