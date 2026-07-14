"use client";

/**
 * 移動支援記録 (千葉市地域生活支援給付)
 *
 * 1 行 = 1 サービス提供。計画 (開始/終了) と実績 (開始/終了 + 運転等控除) を持ち、
 * 算定時間 = 実績時間 − 控除 を自動計算して単一時間帯コードを解決する。
 * 時間帯跨ぎは複合コードが必要なため Phase 2 (算定エンジン) まで手動運用
 * (コード未確定のまま保存し、警告表示)。
 *
 * 制度定義: migrations/_if_idou_shien_chiba.txt
 * 請求: 国保連伝送ではなく千葉市へ様式12/13 + 実績記録票 (様式3-1) を直接提出。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import {
  resolveIdouCode,
  calcMinutes,
  type IdouCodeResult,
} from "@/lib/idou-shien-code";
import {
  ChevronLeft, ChevronRight, Plus, Loader2, X, Pencil, Trash2, Footprints, AlertTriangle,
} from "lucide-react";

type Client = { id: string; name: string; furigana: string | null; user_number: string | null };
type Staff = { id: string; name: string };

type IdouRecord = {
  id: string;
  client_id: string;
  office_id: string | null;
  tenant_id: string;
  service_date: string;
  plan_start_time: string | null;
  plan_end_time: string | null;
  start_time: string | null;
  end_time: string | null;
  deduct_minutes: number;
  calc_minutes: number | null;
  with_body_care: boolean;
  staff_count: number;
  staff_ids: string[];
  service_code: string | null;
  units: number | null;
  destination: string | null;
  addon_shokai: boolean;
  addon_kinkyu: boolean;
  user_confirmed: boolean;
  notes: string | null;
  status: "draft" | "confirmed" | "submitted";
};

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const hm = (t: string | null) => (t ? t.slice(0, 5) : "");
const fmtMin = (m: number | null) =>
  m == null ? "-" : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

type FormState = Omit<IdouRecord, "id" | "office_id" | "tenant_id" | "service_code" | "units" | "calc_minutes">;

const emptyForm = (): FormState => ({
  client_id: "",
  service_date: todayStr(),
  plan_start_time: "",
  plan_end_time: "",
  start_time: "",
  end_time: "",
  deduct_minutes: 0,
  with_body_care: false,
  staff_count: 1,
  staff_ids: [],
  destination: "",
  addon_shokai: false,
  addon_kinkyu: false,
  user_confirmed: false,
  notes: "",
  status: "draft",
});

export function IdouRecordsContent() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, currentOfficeId } = useBusinessType();

  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [clients, setClients] = useState<Client[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [records, setRecords] = useState<IdouRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<IdouRecord | "new" | null>(null);

  const clientName = useCallback(
    (id: string) => clients.find((c) => c.id === id)?.name ?? "(不明)",
    [clients]
  );

  const load = useCallback(async () => {
    if (!currentOfficeId) return;
    setLoading(true);
    try {
      const { data: assigns, error: aErr } = await supabase
        .from("client_office_assignments")
        .select("client_id")
        .eq("office_id", currentOfficeId);
      if (aErr) throw aErr;
      const ids = Array.from(new Set((assigns ?? []).map((a: { client_id: string }) => a.client_id)));
      const [clientsRes, staffRes, recordsRes] = await Promise.all([
        ids.length
          ? supabase.from("clients").select("id, name, furigana, user_number").in("id", ids).is("deleted_at", null).order("furigana")
          : Promise.resolve({ data: [], error: null }),
        supabase.from("members").select("id, name").eq("status", "active").order("name"),
        supabase
          .from("kaigo_idou_shien_records")
          .select("*")
          .eq("office_id", currentOfficeId)
          .gte("service_date", `${month}-01`)
          .lte("service_date", `${month}-31`)
          .order("service_date", { ascending: false }),
      ]);
      if (clientsRes.error) throw clientsRes.error;
      if (staffRes.error) throw staffRes.error;
      if (recordsRes.error) throw recordsRes.error;
      setClients((clientsRes.data ?? []) as Client[]);
      setStaff((staffRes.data ?? []) as Staff[]);
      setRecords((recordsRes.data ?? []) as IdouRecord[]);
    } catch (e) {
      console.error("移動支援記録の読込に失敗:", e instanceof Error ? e.message : e);
    } finally {
      setLoading(false);
    }
  }, [supabase, currentOfficeId, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/月変更時の async fetch
    load();
  }, [load]);

  const moveMonth = (delta: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const handleDelete = async (rec: IdouRecord) => {
    if (!confirm(`${hm(rec.start_time)}〜 ${clientName(rec.client_id)} の記録を削除しますか?`)) return;
    const { error } = await supabase.from("kaigo_idou_shien_records").delete().eq("id", rec.id);
    if (error) { alert("削除に失敗しました: " + error.message); return; }
    load();
  };

  // 月間集計 (算定時間)
  const totalCalcMin = records.reduce((s, r) => s + (r.calc_minutes ?? 0), 0);
  const totalUnits = records.reduce((s, r) => s + (r.units ?? 0) * (r.staff_count === 2 ? 2 : 1), 0);

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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Footprints className="text-violet-600" size={22} />
          <h1 className="text-lg font-bold text-gray-800">移動支援記録</h1>
          <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-600">千葉市地域生活支援給付</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => moveMonth(-1)} className="rounded-lg border border-gray-200 p-1.5 hover:bg-gray-50"><ChevronLeft size={16} /></button>
          <span className="min-w-24 text-center text-sm font-semibold text-gray-700">{month.replace("-", "年")}月</span>
          <button onClick={() => moveMonth(1)} className="rounded-lg border border-gray-200 p-1.5 hover:bg-gray-50"><ChevronRight size={16} /></button>
          <button onClick={() => setEditing("new")} className="ml-2 flex items-center gap-1.5 rounded-xl bg-violet-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-violet-700">
            <Plus size={15} />新規記録
          </button>
        </div>
      </div>

      {/* 月間サマリ */}
      <div className="mb-4 flex flex-wrap gap-3">
        <div className="rounded-xl border border-gray-100 bg-white px-4 py-2.5 text-sm shadow-sm">
          <span className="text-gray-500">件数 </span><span className="font-semibold text-gray-800">{records.length}</span>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white px-4 py-2.5 text-sm shadow-sm">
          <span className="text-gray-500">算定時間計 </span><span className="font-semibold text-gray-800">{fmtMin(totalCalcMin)}</span>
          <span className="ml-1 text-[11px] text-gray-400">(標準支給量 月25時間)</span>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white px-4 py-2.5 text-sm shadow-sm">
          <span className="text-gray-500">単位数計 </span><span className="font-semibold text-gray-800">{totalUnits.toLocaleString()}</span>
          <span className="ml-1 text-[11px] text-gray-400">(1単位=10円)</span>
        </div>
        {totalCalcMin > 25 * 60 && (
          <div className="flex items-center gap-1.5 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
            <AlertTriangle size={14} />標準支給量 (月25時間) を超えています (事業所計)
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="animate-spin text-gray-300" size={28} /></div>
      ) : records.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-200 py-16 text-center text-sm text-gray-400">
          {month.replace("-", "年")}月の記録はまだありません
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-100 bg-white shadow-sm">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="px-3 py-2.5">日付</th>
                <th className="px-3 py-2.5">利用者</th>
                <th className="px-3 py-2.5">計画</th>
                <th className="px-3 py-2.5">実績</th>
                <th className="px-3 py-2.5 text-right">控除</th>
                <th className="px-3 py-2.5 text-right">算定時間</th>
                <th className="px-3 py-2.5">身体介護</th>
                <th className="px-3 py-2.5 text-right">人数</th>
                <th className="px-3 py-2.5">算定コード</th>
                <th className="px-3 py-2.5 text-right">単位</th>
                <th className="px-3 py-2.5">確認</th>
                <th className="px-3 py-2.5">状態</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="px-3 py-2 whitespace-nowrap">{r.service_date.slice(5).replace("-", "/")}</td>
                  <td className="px-3 py-2 whitespace-nowrap font-medium text-gray-800">{clientName(r.client_id)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">
                    {r.plan_start_time ? `${hm(r.plan_start_time)}-${hm(r.plan_end_time)}` : "-"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.start_time ? `${hm(r.start_time)}-${hm(r.end_time)}` : "-"}
                  </td>
                  <td className="px-3 py-2 text-right">{r.deduct_minutes ? `${r.deduct_minutes}分` : "-"}</td>
                  <td className="px-3 py-2 text-right font-medium">{fmtMin(r.calc_minutes)}</td>
                  <td className="px-3 py-2">{r.with_body_care ? <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-600">有り</span> : <span className="text-[11px] text-gray-400">無し</span>}</td>
                  <td className="px-3 py-2 text-right">{r.staff_count}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.service_code ?? <span className="flex items-center gap-1 text-amber-600"><AlertTriangle size={12} />未解決</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{r.units?.toLocaleString() ?? "-"}</td>
                  <td className="px-3 py-2">{r.user_confirmed ? "✓" : ""}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${r.status === "confirmed" ? "bg-green-50 text-green-600" : r.status === "submitted" ? "bg-blue-50 text-blue-600" : "bg-gray-100 text-gray-500"}`}>
                      {r.status === "confirmed" ? "確定" : r.status === "submitted" ? "提出済" : "下書き"}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <button onClick={() => setEditing(r)} className="p-1 text-gray-400 hover:text-violet-600"><Pencil size={14} /></button>
                    <button onClick={() => handleDelete(r)} className="p-1 text-gray-400 hover:text-red-500"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && currentOfficeId && (
        <IdouRecordForm
          supabase={supabase}
          record={editing === "new" ? null : editing}
          clients={clients}
          staff={staff}
          officeId={currentOfficeId}
          tenantId={currentOffice?.tenant_id ?? "kt-group"}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function IdouRecordForm({
  supabase, record, clients, staff, officeId, tenantId, onClose, onSaved,
}: {
  supabase: ReturnType<typeof createClient>;
  record: IdouRecord | null;
  clients: Client[];
  staff: Staff[];
  officeId: string;
  tenantId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<FormState>(() => {
    if (!record) return emptyForm();
    const { id: _id, office_id: _o, tenant_id: _t, service_code: _s, units: _u, calc_minutes: _c, ...rest } = record;
    void _id; void _o; void _t; void _s; void _u; void _c;
    return { ...emptyForm(), ...rest, plan_start_time: hm(rest.plan_start_time), plan_end_time: hm(rest.plan_end_time), start_time: hm(rest.start_time), end_time: hm(rest.end_time) };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const toggleStaff = (id: string) =>
    setF((p) => ({ ...p, staff_ids: p.staff_ids.includes(id) ? p.staff_ids.filter((x) => x !== id) : [...p.staff_ids, id] }));

  // 算定プレビュー
  const cMin = calcMinutes(f.start_time ?? "", f.end_time ?? "", f.deduct_minutes);
  const resolved = f.start_time && f.end_time
    ? resolveIdouCode(f.start_time, f.end_time, f.deduct_minutes, f.with_body_care)
    : null;
  const codeOk = resolved !== null && "code" in resolved;

  const handleSave = async () => {
    if (!f.client_id) { setError("利用者を選択してください"); return; }
    if (!f.service_date) { setError("日付を入力してください"); return; }
    setSaving(true);
    setError("");
    const r = codeOk ? (resolved as IdouCodeResult) : null;
    const payload = {
      ...f,
      office_id: officeId,
      tenant_id: tenantId,
      plan_start_time: f.plan_start_time || null,
      plan_end_time: f.plan_end_time || null,
      start_time: f.start_time || null,
      end_time: f.end_time || null,
      calc_minutes: cMin,
      service_code: r?.code ?? null,
      units: r?.units ?? null,
      destination: f.destination || null,
      notes: f.notes || null,
    };
    const { error: err } = record
      ? await supabase.from("kaigo_idou_shien_records").update(payload).eq("id", record.id)
      : await supabase.from("kaigo_idou_shien_records").insert(payload);
    setSaving(false);
    if (err) { setError("保存に失敗しました: " + err.message); return; }
    onSaved();
  };

  const inputCls = "w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm outline-none focus:border-violet-400";
  const labelCls = "mb-1 block text-xs font-medium text-gray-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3 shrink-0">
          <h3 className="text-sm font-semibold text-gray-800">{record ? "移動支援記録の編集" : "移動支援記録の新規作成"}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>利用者 *</label>
              <select value={f.client_id} onChange={(e) => set("client_id", e.target.value)} className={inputCls}>
                <option value="">選択してください</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>日付 *</label>
              <input type="date" value={f.service_date} onChange={(e) => set("service_date", e.target.value)} className={inputCls} />
            </div>
          </div>

          {/* 計画 / 実績 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-gray-50 p-3">
              <p className="mb-2 text-xs font-medium text-gray-600">移動支援計画</p>
              <div className="grid grid-cols-2 gap-2">
                <input type="time" value={f.plan_start_time ?? ""} onChange={(e) => set("plan_start_time", e.target.value)} className={inputCls} />
                <input type="time" value={f.plan_end_time ?? ""} onChange={(e) => set("plan_end_time", e.target.value)} className={inputCls} />
              </div>
            </div>
            <div className="rounded-xl bg-violet-50 p-3">
              <p className="mb-2 text-xs font-medium text-gray-600">サービス提供実績</p>
              <div className="grid grid-cols-2 gap-2">
                <input type="time" value={f.start_time ?? ""} onChange={(e) => set("start_time", e.target.value)} className={inputCls} />
                <input type="time" value={f.end_time ?? ""} onChange={(e) => set("end_time", e.target.value)} className={inputCls} />
              </div>
            </div>
          </div>

          {/* 算定 */}
          <div className="rounded-xl bg-violet-50 p-3">
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-1.5 text-sm">
                運転等控除
                <input type="number" min={0} step={5} value={f.deduct_minutes} onChange={(e) => set("deduct_minutes", Number(e.target.value) || 0)} className="w-20 rounded border border-gray-200 px-1.5 py-0.5 text-sm" />分
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={f.with_body_care} onChange={(e) => set("with_body_care", e.target.checked)} className="accent-violet-600" />
                身体介護有り
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                派遣人数
                <select value={f.staff_count} onChange={(e) => set("staff_count", Number(e.target.value))} className="rounded border border-gray-200 px-1.5 py-0.5 text-sm">
                  <option value={1}>1人</option>
                  <option value={2}>2人</option>
                </select>
              </label>
            </div>
            <div className="mt-2 text-[11px] text-gray-600">
              算定時間: <span className="font-semibold">{cMin != null ? `${Math.floor(cMin / 60)}時間${cMin % 60}分` : "-"}</span>
              {" ／ "}
              {resolved === null ? (
                <span className="text-gray-400">実績時刻を入力するとコードを自動判定します</span>
              ) : "code" in resolved ? (
                <>
                  算定コード: <span className="font-mono font-semibold text-violet-700">{resolved.code}</span>
                  {" "}({resolved.label} / {resolved.units.toLocaleString()}単位{f.staff_count === 2 ? ` ×2人 = ${(resolved.units * 2).toLocaleString()}単位` : ""})
                </>
              ) : resolved.reason === "cross_band" ? (
                <span className="font-medium text-amber-600">時間帯跨ぎ ({resolved.bands.join("+")}) — 複合コードは請求機能 (Phase 2) で対応予定。コード未確定で保存されます</span>
              ) : resolved.reason === "over_max" ? (
                <span className="font-medium text-amber-600">{resolved.band}帯の上限 ({resolved.maxBrackets * 0.5}時間) を超えています</span>
              ) : (
                <span className="text-gray-400">時刻の入力が不正です</span>
              )}
            </div>
          </div>

          {/* 行き先・従事職員 */}
          <div>
            <label className={labelCls}>行き先・外出目的</label>
            <input value={f.destination ?? ""} onChange={(e) => set("destination", e.target.value)} placeholder="例: ○○病院への通院、△△デパートで買物" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>従事職員（複数選択）</label>
            <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-gray-200 p-2">
              {staff.length === 0 ? <span className="text-xs text-gray-400">職員データがありません</span> : staff.map((s) => (
                <button key={s.id} type="button" onClick={() => toggleStaff(s.id)}
                  className={`rounded-full px-2.5 py-1 text-xs ${f.staff_ids.includes(s.id) ? "bg-violet-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          {/* 加算・確認 */}
          <div className="flex flex-wrap items-center gap-4 rounded-xl bg-gray-50 p-3">
            <span className="text-xs font-medium text-gray-600">加算等</span>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={f.addon_shokai} onChange={(e) => set("addon_shokai", e.target.checked)} className="accent-violet-600" />初回加算 (月1回)
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={f.addon_kinkyu} onChange={(e) => set("addon_kinkyu", e.target.checked)} className="accent-violet-600" />緊急時対応加算 (身体介護有りのみ・月2回)
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={f.user_confirmed} onChange={(e) => set("user_confirmed", e.target.checked)} className="accent-violet-600" />利用者確認
            </label>
          </div>

          <div>
            <label className={labelCls}>備考 (要支援区間の説明・院内介助の記録など)</label>
            <textarea value={f.notes ?? ""} onChange={(e) => set("notes", e.target.value)} rows={2} className={`${inputCls} resize-none`} />
          </div>

          {error && <p className="rounded-lg bg-red-50 p-2.5 text-sm text-red-500">{error}</p>}
        </div>

        <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3 shrink-0">
          <select value={f.status} onChange={(e) => set("status", e.target.value as FormState["status"])} className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm">
            <option value="draft">下書き</option>
            <option value="confirmed">確定</option>
          </select>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
            <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50">
              {saving && <Loader2 size={14} className="animate-spin" />}保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
