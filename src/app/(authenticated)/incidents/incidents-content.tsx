"use client";

/**
 * 事故報告書 / 苦情受付簿 (事業所単位の台帳)
 *
 * 2026-09-01 監査是正で新設。それまで DB にもアプリにも置き場が無かった。
 * 運営基準で作成・保存が義務で、実地指導では必ず提出を求められる。
 * 契約書テンプレに「苦情対応窓口を設置し迅速に対応します」「事故発生時の対応」を
 * 利用者に約束する文面が入っているのに、記録の置き場が無い状態だった。
 *
 * 利用者に紐づかない事故 (職員の負傷・物損) や、申出人が利用者でない苦情もあるので
 * client_id は任意。利用者選択サイドバーではなく事業所単位の一覧にしている。
 *
 * 保存先: migrations/incident_and_complaint_v1.sql
 *   kaigo_incident_reports / kaigo_complaints
 *   (RLS tenant scope + audit_log トリガ付き)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  AlertTriangle,
  MessageSquareWarning,
  Plus,
  Save,
  Trash2,
  Loader2,
  X,
} from "lucide-react";
import { useBusinessType } from "@/lib/business-type-context";

type Tab = "incident" | "nearmiss" | "complaint";
type Row = Record<string, unknown>;

export interface ClientLite {
  id: string;
  name: string;
}

/** 入力欄の定義。1 か所で持って表と編集モーダルの両方を組み立てる */
type Field = {
  key: string;
  label: string;
  type: "text" | "textarea" | "date" | "datetime" | "bool" | "select" | "client";
  options?: string[];
  /** 一覧の列にも出す */
  inList?: boolean;
  /** 空欄だと運営指導で指摘されやすい = 警告を出す */
  warnIfEmpty?: boolean;
};

const INCIDENT_FIELDS: Field[] = [
  { key: "occurred_at", label: "発生日時", type: "datetime", inList: true },
  { key: "client_id", label: "対象利用者", type: "client", inList: true },
  {
    key: "incident_type", label: "事故の種別", type: "select", inList: true,
    options: ["転倒", "転落", "誤薬", "誤嚥", "無断外出", "紛失・破損", "感染症", "その他"],
  },
  { key: "occurred_place", label: "発生場所", type: "text" },
  { key: "discoverer_name", label: "発見者", type: "text" },
  { key: "description", label: "発生状況", type: "textarea" },
  {
    key: "injury_level", label: "傷害の程度", type: "select", inList: true,
    options: ["なし", "軽傷", "通院", "入院", "死亡"],
  },
  { key: "medical_visited", label: "受診の有無", type: "bool" },
  { key: "medical_institution", label: "医療機関名", type: "text" },
  { key: "diagnosis", label: "診断名", type: "text" },
  { key: "family_notified_at", label: "家族への連絡日時", type: "datetime", warnIfEmpty: true },
  { key: "family_notified_to", label: "連絡した相手 (続柄)", type: "text" },
  { key: "municipality_reported_at", label: "市町村へ報告した日", type: "date", inList: true, warnIfEmpty: true },
  { key: "municipality_name", label: "報告先の市町村", type: "text" },
  { key: "insurer_reported_at", label: "保険者へ報告した日", type: "date" },
  { key: "immediate_action", label: "事故発生時の対応", type: "textarea", warnIfEmpty: true },
  { key: "cause_analysis", label: "原因分析", type: "textarea", warnIfEmpty: true },
  { key: "prevention", label: "再発防止策", type: "textarea", warnIfEmpty: true },
  { key: "compensation", label: "損害賠償", type: "text" },
  { key: "reporter_name", label: "記入者", type: "text" },
  { key: "notes", label: "備考", type: "textarea" },
];

const COMPLAINT_FIELDS: Field[] = [
  { key: "received_at", label: "受付日時", type: "datetime", inList: true },
  {
    key: "received_via", label: "受付方法", type: "select", inList: true,
    options: ["電話", "来所", "訪問", "書面", "メール", "第三者委員", "行政", "国保連"],
  },
  { key: "client_id", label: "対象利用者", type: "client", inList: true },
  { key: "complainant_name", label: "申出人", type: "text", inList: true },
  {
    key: "complainant_relation", label: "申出人の続柄", type: "select",
    options: ["本人", "家族", "近隣", "他事業所", "行政", "その他"],
  },
  { key: "receiver_name", label: "受付者", type: "text" },
  { key: "content", label: "苦情の内容", type: "textarea" },
  { key: "responder_name", label: "対応者", type: "text" },
  { key: "response", label: "対応内容", type: "textarea", warnIfEmpty: true },
  { key: "responded_at", label: "対応日時", type: "datetime" },
  { key: "resolved_at", label: "解決日", type: "date", inList: true },
  {
    key: "result", label: "結果", type: "select", inList: true,
    options: ["解決", "継続中", "他機関へ移管", "取り下げ"],
  },
  { key: "prevention", label: "再発防止策", type: "textarea", warnIfEmpty: true },
  { key: "reported_to", label: "外部への報告先", type: "text" },
  { key: "reported_at", label: "外部へ報告した日", type: "date" },
  { key: "notes", label: "備考", type: "textarea" },
];

/**
 * ヒヤリハットは **実害に至っていない**ので、事故報告書の
 * 「傷害の程度 / 受診 / 家族への連絡 / 市町村への報告 / 損害賠償」は出さない。
 * 発生状況・要因・再発防止策は事故とまったく同じ形で書く (分析を合わせて行うため)。
 */
const NEARMISS_FIELDS: Field[] = [
  { key: "occurred_at", label: "発生日時", type: "datetime", inList: true },
  { key: "client_id", label: "対象利用者", type: "client", inList: true },
  {
    key: "incident_type", label: "種別", type: "select", inList: true,
    options: ["転倒", "転落", "誤薬", "誤嚥", "無断外出", "紛失・破損", "感染症", "その他"],
  },
  { key: "occurred_place", label: "発生場所", type: "text" },
  { key: "discoverer_name", label: "気づいた職員", type: "text" },
  { key: "description", label: "どんなことが起きかけたか", type: "textarea" },
  { key: "immediate_action", label: "その場で取った対応", type: "textarea" },
  { key: "cause_analysis", label: "要因", type: "textarea", warnIfEmpty: true },
  { key: "prevention", label: "再発防止策", type: "textarea", warnIfEmpty: true },
  { key: "reporter_name", label: "記入者", type: "text" },
  { key: "notes", label: "備考", type: "textarea" },
];

const CONF = {
  incident: {
    table: "kaigo_incident_reports",
    fields: INCIDENT_FIELDS,
    dateKey: "occurred_at",
    label: "事故報告書",
    icon: AlertTriangle,
    kind: "事故",
    sql: "migrations/incident_near_miss_v1.sql",
  },
  nearmiss: {
    table: "kaigo_incident_reports",
    fields: NEARMISS_FIELDS,
    dateKey: "occurred_at",
    label: "ヒヤリハット",
    icon: AlertTriangle,
    kind: "ヒヤリハット",
    sql: "migrations/incident_near_miss_v1.sql",
  },
  complaint: {
    table: "kaigo_complaints",
    fields: COMPLAINT_FIELDS,
    dateKey: "received_at",
    label: "苦情受付簿",
    icon: MessageSquareWarning,
    sql: "migrations/incident_and_complaint_v1.sql",
  },
} as const;

// 42P01/PGRST205 = テーブルが無い、42703/PGRST204 = 列が無い (report_kind 未適用)
const isMissingSchema = (code?: string) =>
  code === "42P01" || code === "PGRST205" || code === "42703" || code === "PGRST204";

const toLocalInput = (v: unknown, type: Field["type"]): string => {
  if (typeof v !== "string" || !v) return "";
  if (type === "date") return v.slice(0, 10);
  // datetime-local は秒なし。TZ は Date に任せず文字列で切る (UTC ずれ防止)
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function IncidentsContent({ clients }: { clients: ClientLite[] }) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice } = useBusinessType();
  const officeId = currentOffice?.id ?? null;

  const [tab, setTab] = useState<Tab>("incident");
  const [year, setYear] = useState(() => String(new Date().getFullYear()));
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [missingSql, setMissingSql] = useState<string | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [saving, setSaving] = useState(false);

  const conf = CONF[tab];
  const nameById = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);

  const load = useCallback(async () => {
    if (!officeId) return;
    setLoading(true);
    setMissingSql(null);
    const from = `${year}-01-01T00:00:00`;
    const to = `${Number(year) + 1}-01-01T00:00:00`;
    // 事故報告書とヒヤリハットは同じ台帳。report_kind で切り分ける
    let q = supabase
      .from(conf.table)
      .select("*")
      .eq("office_id", officeId)
      .gte(conf.dateKey, from)
      .lt(conf.dateKey, to);
    if ("kind" in conf) q = q.eq("report_kind", conf.kind);
    const { data, error } = await q.order(conf.dateKey, { ascending: false });
    setLoading(false);
    if (error) {
      if (isMissingSchema(error.code)) {
        setMissingSql(conf.sql);
        setRows([]);
        return;
      }
      toast.error(`読み込みに失敗しました: ${error.message}`);
      setRows([]);
      return;
    }
    setRows((data ?? []) as Row[]);
    // conf は CONF[tab] の参照そのもの (モジュール定数) なので毎回同じ。conf 単位で依存させる
  }, [supabase, officeId, year, conf]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- タブ/年/事業所の切替で読み直す
    load();
  }, [load]);

  const startNew = () => {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    setEditing({
      [conf.dateKey]: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`,
    });
  };

  const save = async () => {
    if (!editing) return;
    if (!officeId) {
      toast.error("事業所が未選択のため保存できません");
      return;
    }
    const dateVal = editing[conf.dateKey];
    if (typeof dateVal !== "string" || !dateVal) {
      toast.error(`${conf.fields[0].label}は必須です`);
      return;
    }
    setSaving(true);
    const payload: Row = { ...editing, office_id: officeId, updated_at: new Date().toISOString() };
    // 新規は開いているタブの種別で入れる (既存行の種別は付け替えないので触らない)
    if ("kind" in conf && !editing.id) payload.report_kind = conf.kind;
    // 空文字は NULL にする (date/timestamp 列に "" を入れると 22007 で落ちる)
    for (const f of conf.fields) {
      if (payload[f.key] === "") payload[f.key] = null;
    }
    const { error } = editing.id
      ? await supabase.from(conf.table).update(payload).eq("id", editing.id as string)
      : await supabase.from(conf.table).insert(payload);
    setSaving(false);
    if (error) {
      toast.error(`保存に失敗しました: ${error.message}`);
      return;
    }
    toast.success("保存しました");
    setEditing(null);
    load();
  };

  const remove = async (row: Row) => {
    if (!row.id) return;
    if (!confirm(`この${conf.label}を削除します。よろしいですか？\n(削除は監査ログに残ります)`)) return;
    const { error } = await supabase.from(conf.table).delete().eq("id", row.id as string);
    if (error) {
      toast.error(`削除に失敗しました: ${error.message}`);
      return;
    }
    toast.success("削除しました");
    setEditing(null);
    load();
  };

  /** 運営指導で空欄だと指摘されやすい欄が埋まっていないか */
  const missingOf = (row: Row) =>
    conf.fields.filter((f) => f.warnIfEmpty && !row[f.key]).map((f) => f.label);

  const listFields = conf.fields.filter((f) => f.inList);

  const renderCell = (row: Row, f: Field) => {
    const v = row[f.key];
    if (f.type === "client") return typeof v === "string" ? (nameById.get(v) ?? "—") : "—";
    if (!v) return "—";
    if (f.type === "date") return String(v).slice(0, 10);
    if (f.type === "datetime") return toLocalInput(v, "datetime").replace("T", " ");
    return String(v);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 border-b border-gray-300">
          {(["incident", "nearmiss", "complaint"] as const).map((t) => {
            const Icon = CONF[t].icon;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`flex items-center gap-1 rounded-t border border-b-0 px-3 py-1.5 text-xs font-medium ${
                  tab === t
                    ? "-mb-px border-gray-300 bg-white text-indigo-700"
                    : "border-transparent bg-gray-100 text-gray-500 hover:text-gray-700"
                }`}
              >
                <Icon size={13} /> {CONF[t].label}
              </button>
            );
          })}
        </div>
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
          onClick={startNew}
          disabled={!officeId}
          className="flex items-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          <Plus size={13} /> 新規
        </button>
      </div>

      {missingSql && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          ⚠ テーブルまたは列が未作成です。
          <code className="mx-1">{missingSql}</code>
          を Supabase SQL Editor で適用してください。
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-gray-300" size={28} />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-200 py-16 text-center text-sm text-gray-400">
          {year} 年の{conf.label}はまだありません
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-xs">
            <thead className="border-b border-gray-200 bg-gray-50 text-gray-500">
              <tr>
                {listFields.map((f) => (
                  <th key={f.key} className="whitespace-nowrap px-3 py-2 text-left font-medium">
                    {f.label}
                  </th>
                ))}
                <th className="px-3 py-2 text-left font-medium">未記入</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const miss = missingOf(r);
                return (
                  <tr
                    key={String(r.id)}
                    onClick={() => setEditing({ ...r })}
                    className={`cursor-pointer border-b border-gray-100 hover:bg-indigo-50/40 ${
                      miss.length > 0 ? "bg-amber-50/40" : ""
                    }`}
                  >
                    {listFields.map((f) => (
                      <td key={f.key} className="whitespace-nowrap px-3 py-1.5 text-gray-800">
                        {renderCell(r, f)}
                      </td>
                    ))}
                    <td className="px-3 py-1.5">
                      {miss.length === 0 ? (
                        <span className="text-emerald-600">✓</span>
                      ) : (
                        <span className="text-amber-700" title={miss.join(" / ")}>
                          ⚠ {miss.length} 項目
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6">
          <div className="w-full max-w-3xl rounded-xl bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-800">
                {conf.label}
                {editing.id ? " の編集" : " の新規作成"}
              </h2>
              <button type="button" onClick={() => setEditing(null)} className="text-gray-400 hover:text-gray-700">
                <X size={18} />
              </button>
            </div>

            {missingOf(editing).length > 0 && (
              <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                ⚠ 運営指導で確認される項目が未記入です: {missingOf(editing).join(" / ")}
              </div>
            )}

            <div className="grid max-h-[60vh] grid-cols-1 gap-3 overflow-y-auto pr-1 md:grid-cols-2">
              {conf.fields.map((f) => {
                const v = editing[f.key];
                const set = (nv: unknown) => setEditing({ ...editing, [f.key]: nv });
                const cls = "w-full rounded border border-gray-300 px-2 py-1 text-xs";
                return (
                  <label
                    key={f.key}
                    className={`text-xs text-gray-600 ${f.type === "textarea" ? "md:col-span-2" : ""}`}
                  >
                    {f.label}
                    {f.warnIfEmpty && <span className="ml-1 text-amber-600">*</span>}
                    {f.type === "textarea" ? (
                      <textarea rows={3} className={cls} value={(v as string) ?? ""} onChange={(e) => set(e.target.value)} />
                    ) : f.type === "bool" ? (
                      <div className="pt-1">
                        <input type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} />
                      </div>
                    ) : f.type === "select" ? (
                      <select className={cls} value={(v as string) ?? ""} onChange={(e) => set(e.target.value)}>
                        <option value="">—</option>
                        {f.options?.map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    ) : f.type === "client" ? (
                      <select className={cls} value={(v as string) ?? ""} onChange={(e) => set(e.target.value || null)}>
                        <option value="">— (利用者に紐づかない)</option>
                        {clients.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={f.type === "date" ? "date" : f.type === "datetime" ? "datetime-local" : "text"}
                        className={cls}
                        value={f.type === "text" ? ((v as string) ?? "") : toLocalInput(v, f.type)}
                        onChange={(e) => set(e.target.value)}
                      />
                    )}
                  </label>
                );
              })}
            </div>

            <div className="mt-4 flex items-center justify-between">
              {editing.id ? (
                <button
                  type="button"
                  onClick={() => remove(editing)}
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
