"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { resolveChiikiBathCode } from "@/lib/idou-shien-code";
import {
  ChevronLeft, ChevronRight, Plus, Loader2, X, Pencil, Trash2, Droplets,
} from "lucide-react";

type Client = { id: string; name: string; furigana: string | null; user_number: string | null };
type Staff = { id: string; name: string };

type BathRecord = {
  id: string;
  client_id: string;
  office_id: string | null;
  tenant_id: string;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  bath_type: "全身浴" | "部分浴";
  staff_only: boolean;
  /** 制度: 介護保険の訪問入浴介護 / 千葉市地域生活支援給付 (障害) の訪問入浴サービス */
  scheme: "介護保険" | "地域生活支援";
  service_code: string | null;
  staff_ids: string[];
  vital_temperature: number | null;
  vital_bp_sys: number | null;
  vital_bp_dia: number | null;
  vital_pulse: number | null;
  vital_spo2: number | null;
  water_temp: number | null;
  condition_before: string | null;
  condition_after: string | null;
  skin_notes: string | null;
  addon_shokai: boolean;
  addon_ninchi: "I" | "II" | null;
  addon_chuusankan: boolean;
  notes: string | null;
  status: "draft" | "confirmed" | "submitted";
};

// 入浴種別 × 職員のみ → 算定コード
function resolveBathCode(bathType: "全身浴" | "部分浴", staffOnly: boolean): string {
  if (bathType === "全身浴") return staffOnly ? "121121" : "121111";
  return staffOnly ? "121122" : "121112"; // 部分浴・清拭
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type FormState = Omit<BathRecord, "id" | "office_id" | "tenant_id" | "service_code">;

const emptyForm = (): FormState => ({
  client_id: "",
  visit_date: todayStr(),
  start_time: "",
  end_time: "",
  bath_type: "全身浴",
  staff_only: false,
  scheme: "介護保険",
  staff_ids: [],
  vital_temperature: null,
  vital_bp_sys: null,
  vital_bp_dia: null,
  vital_pulse: null,
  vital_spo2: null,
  water_temp: null,
  condition_before: "",
  condition_after: "",
  skin_notes: "",
  addon_shokai: false,
  addon_ninchi: null,
  addon_chuusankan: false,
  notes: "",
  status: "draft",
});

export function BathRecordsContent() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, currentOfficeId } = useBusinessType();

  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [clients, setClients] = useState<Client[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [records, setRecords] = useState<BathRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<BathRecord | "new" | null>(null);

  const clientName = useCallback(
    (id: string) => clients.find((c) => c.id === id)?.name ?? "(不明)",
    [clients]
  );

  const load = useCallback(async () => {
    if (!currentOfficeId) return;
    setLoading(true);
    try {
      // 自事業所の利用者 (client_office_assignments 経由)
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
        supabase.from("members").select("id, name").eq("status", "active").is("deleted_at", null).order("name"),
        supabase
          .from("kaigo_bath_visit_records")
          .select("*")
          .eq("office_id", currentOfficeId)
          .gte("visit_date", `${month}-01`)
          .lte("visit_date", `${month}-31`)
          .order("visit_date", { ascending: false }),
      ]);
      if (clientsRes.error) throw clientsRes.error;
      if (staffRes.error) throw staffRes.error;
      if (recordsRes.error) throw recordsRes.error;
      setClients((clientsRes.data ?? []) as Client[]);
      setStaff((staffRes.data ?? []) as Staff[]);
      setRecords((recordsRes.data ?? []) as BathRecord[]);
    } catch (e) {
      console.error("入浴記録の読込に失敗:", e);
      alert("読込に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [supabase, currentOfficeId, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/月変更時の async fetch
    load();
  }, [load]);

  const prevMonth = () => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 2, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const nextMonth = () => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const handleDelete = async (r: BathRecord) => {
    if (!window.confirm(`${clientName(r.client_id)} 様 ${r.visit_date} の入浴記録を削除します。よろしいですか？`)) return;
    const { error } = await supabase.from("kaigo_bath_visit_records").delete().eq("id", r.id);
    if (error) {
      alert("削除に失敗しました: " + error.message);
      return;
    }
    setRecords((prev) => prev.filter((x) => x.id !== r.id));
  };

  if (!currentOfficeId) {
    return <div className="p-8 text-sm text-gray-400">訪問入浴事業所を選択してください。</div>;
  }

  const [y, m] = month.split("-").map(Number);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col bg-white">
      {/* ツールバー */}
      <div className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2 shrink-0">
        <Droplets size={18} className="text-cyan-600" />
        <h1 className="text-sm font-semibold text-gray-800">入浴実施記録</h1>
        <div className="flex items-center gap-0.5 rounded border border-gray-300 bg-white px-2 py-1">
          <button onClick={prevMonth} className="text-gray-500 hover:text-gray-800"><ChevronLeft size={14} /></button>
          <span className="px-1.5 text-sm font-semibold text-gray-800">{y}年{m}月</span>
          <button onClick={nextMonth} className="text-gray-500 hover:text-gray-800"><ChevronRight size={14} /></button>
        </div>
        <span className="text-xs text-gray-400">{records.length}件</span>
        <button
          onClick={() => setEditing("new")}
          className="ml-auto flex items-center gap-1 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700"
        >
          <Plus size={14} />新規記録
        </button>
      </div>

      {/* 一覧 */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-cyan-400" /></div>
        ) : records.length === 0 ? (
          <p className="py-16 text-center text-sm text-gray-400">この月の入浴記録はありません</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-gray-100 text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">日付</th>
                <th className="px-3 py-2 text-left font-semibold">利用者</th>
                <th className="px-3 py-2 text-left font-semibold">種別</th>
                <th className="px-3 py-2 text-left font-semibold">加算</th>
                <th className="px-3 py-2 text-left font-semibold">職員</th>
                <th className="px-3 py-2 text-left font-semibold">状態</th>
                <th className="px-3 py-2 text-right font-semibold"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {records.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-3 py-1.5 text-gray-700">{r.visit_date.slice(5)}</td>
                  <td className="px-3 py-1.5 font-medium text-gray-800">{clientName(r.client_id)}</td>
                  <td className="px-3 py-1.5 text-gray-600">
                    {r.scheme === "地域生活支援" && <span className="mr-1 rounded bg-violet-50 px-1 py-0.5 text-[10px] text-violet-600">障害</span>}
                    {r.bath_type}{r.staff_only && <span className="ml-1 text-amber-600">職員のみ</span>}
                  </td>
                  <td className="px-3 py-1.5 text-gray-500">
                    {[r.addon_shokai && "初回", r.addon_ninchi && `認知症${r.addon_ninchi}`, r.addon_chuusankan && "中山間"].filter(Boolean).join("・") || "—"}
                  </td>
                  <td className="px-3 py-1.5 text-gray-500">{r.staff_ids.length}名</td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      r.status === "confirmed" ? "bg-emerald-100 text-emerald-700" : r.status === "submitted" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"
                    }`}>
                      {r.status === "confirmed" ? "確定" : r.status === "submitted" ? "請求済" : "下書き"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    <button onClick={() => setEditing(r)} className="mr-1 p-1 text-gray-400 hover:text-cyan-600"><Pencil size={14} /></button>
                    <button onClick={() => handleDelete(r)} className="p-1 text-gray-400 hover:text-red-500"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <BathRecordForm
          supabase={supabase}
          record={editing === "new" ? null : editing}
          clients={clients}
          staff={staff}
          officeId={currentOfficeId}
          tenantId={currentOffice?.tenant_id ?? "kt-group"}
          allRecords={records}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

// 日曜起点の週 (Sun-Sat) キー = その週の日曜の YYYY-MM-DD
function weekKey(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - dt.getDay()); // 日曜へ戻す
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function BathRecordForm({
  supabase, record, clients, staff, officeId, tenantId, allRecords, onClose, onSaved,
}: {
  supabase: ReturnType<typeof createClient>;
  record: BathRecord | null;
  clients: Client[];
  staff: Staff[];
  officeId: string;
  tenantId: string;
  allRecords: BathRecord[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<FormState>(() => {
    if (!record) return emptyForm();
    const { id: _id, office_id: _o, tenant_id: _t, service_code: _s, ...rest } = record;
    void _id; void _o; void _t; void _s;
    return { ...emptyForm(), ...rest };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const numOrNull = (s: string): number | null => (s === "" ? null : Number(s));
  const toggleStaff = (id: string) =>
    setF((p) => ({ ...p, staff_ids: p.staff_ids.includes(id) ? p.staff_ids.filter((x) => x !== id) : [...p.staff_ids, id] }));

  // 地域生活支援 訪問入浴: 週2回限度 (日曜起点の週)。同一利用者・同一週の既存件数を数える
  const chiikiWeekCount =
    f.scheme === "地域生活支援" && f.client_id && f.visit_date
      ? allRecords.filter(
          (r) =>
            r.id !== record?.id &&
            r.scheme === "地域生活支援" &&
            r.client_id === f.client_id &&
            weekKey(r.visit_date) === weekKey(f.visit_date),
        ).length
      : 0;

  const handleSave = async () => {
    if (!f.client_id) { setError("利用者を選択してください"); return; }
    if (!f.visit_date) { setError("日付を入力してください"); return; }
    setSaving(true);
    setError("");
    const payload = {
      ...f,
      office_id: officeId,
      tenant_id: tenantId,
      service_code:
        f.scheme === "地域生活支援"
          ? resolveChiikiBathCode(f.staff_only, false)
          : resolveBathCode(f.bath_type, f.staff_only),
      start_time: f.start_time || null,
      end_time: f.end_time || null,
      condition_before: f.condition_before || null,
      condition_after: f.condition_after || null,
      skin_notes: f.skin_notes || null,
      notes: f.notes || null,
    };
    const { error } = record
      ? await supabase.from("kaigo_bath_visit_records").update(payload).eq("id", record.id)
      : await supabase.from("kaigo_bath_visit_records").insert(payload);
    setSaving(false);
    if (error) { setError("保存に失敗しました: " + error.message); return; }
    onSaved();
  };

  const inputCls = "w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm outline-none focus:border-cyan-400";
  const labelCls = "mb-1 block text-xs font-medium text-gray-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3 shrink-0">
          <h3 className="text-sm font-semibold text-gray-800">{record ? "入浴記録の編集" : "入浴記録の新規作成"}</h3>
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
              <input type="date" value={f.visit_date} onChange={(e) => set("visit_date", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>開始時刻</label>
              <input type="time" value={f.start_time ?? ""} onChange={(e) => set("start_time", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>終了時刻</label>
              <input type="time" value={f.end_time ?? ""} onChange={(e) => set("end_time", e.target.value)} className={inputCls} />
            </div>
          </div>

          {/* 算定 */}
          <div className="rounded-xl bg-cyan-50 p-3">
            <div className="mb-2 flex items-center gap-3">
              <span className="text-xs font-medium text-gray-600">制度</span>
              {(["介護保険", "地域生活支援"] as const).map((sc) => (
                <label key={sc} className="flex items-center gap-1 text-sm">
                  <input type="radio" checked={f.scheme === sc} onChange={() => set("scheme", sc)} className="accent-cyan-600" />
                  {sc === "地域生活支援" ? "地域生活支援給付 (障害・千葉市)" : "介護保険"}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-4">
              {f.scheme === "介護保険" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-600">入浴種別</span>
                  {(["全身浴", "部分浴"] as const).map((bt) => (
                    <label key={bt} className="flex items-center gap-1 text-sm">
                      <input type="radio" checked={f.bath_type === bt} onChange={() => set("bath_type", bt)} className="accent-cyan-600" />
                      {bt === "部分浴" ? "部分浴・清拭" : bt}
                    </label>
                  ))}
                </div>
              )}
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={f.staff_only} onChange={(e) => set("staff_only", e.target.checked)} className="accent-cyan-600" />
                {f.scheme === "地域生活支援" ? "介護職員3人（看護職員なし）" : "職員のみ（看護職員同行なし・減算）"}
              </label>
            </div>
            <p className="mt-1.5 text-[11px] text-gray-500">
              算定コード: <span className="font-mono font-semibold text-cyan-700">
                {f.scheme === "地域生活支援" ? resolveChiikiBathCode(f.staff_only, false) : resolveBathCode(f.bath_type, f.staff_only)}
              </span>
              {f.scheme === "地域生活支援" && <span className="ml-2 text-gray-400">週2回限度 (千葉市算定基準)。中止時コード等は請求機能で対応</span>}
            </p>
            {f.scheme === "地域生活支援" && chiikiWeekCount >= 2 && (
              <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-amber-600">
                ⚠ この利用者は同じ週 (日〜土) に既に {chiikiWeekCount} 件あります。週2回を超える分は原則算定できません
              </p>
            )}
          </div>

          {/* 従事職員 */}
          <div>
            <label className={labelCls}>従事職員（複数選択）</label>
            <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-gray-200 p-2">
              {staff.length === 0 ? <span className="text-xs text-gray-400">職員データがありません</span> : staff.map((s) => (
                <button key={s.id} type="button" onClick={() => toggleStaff(s.id)}
                  className={`rounded-full px-2.5 py-1 text-xs ${f.staff_ids.includes(s.id) ? "bg-cyan-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          {/* バイタル */}
          <div>
            <label className={labelCls}>バイタル</label>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              <input placeholder="体温" type="number" step="0.1" value={f.vital_temperature ?? ""} onChange={(e) => set("vital_temperature", numOrNull(e.target.value))} className={inputCls} />
              <input placeholder="血圧上" type="number" value={f.vital_bp_sys ?? ""} onChange={(e) => set("vital_bp_sys", numOrNull(e.target.value))} className={inputCls} />
              <input placeholder="血圧下" type="number" value={f.vital_bp_dia ?? ""} onChange={(e) => set("vital_bp_dia", numOrNull(e.target.value))} className={inputCls} />
              <input placeholder="脈拍" type="number" value={f.vital_pulse ?? ""} onChange={(e) => set("vital_pulse", numOrNull(e.target.value))} className={inputCls} />
              <input placeholder="SpO2" type="number" value={f.vital_spo2 ?? ""} onChange={(e) => set("vital_spo2", numOrNull(e.target.value))} className={inputCls} />
              <input placeholder="湯温" type="number" step="0.1" value={f.water_temp ?? ""} onChange={(e) => set("water_temp", numOrNull(e.target.value))} className={inputCls} />
            </div>
          </div>

          {/* 状態 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className={labelCls}>入浴前の状態</label>
              <textarea value={f.condition_before ?? ""} onChange={(e) => set("condition_before", e.target.value)} rows={2} className={`${inputCls} resize-none`} />
            </div>
            <div>
              <label className={labelCls}>入浴後の状態</label>
              <textarea value={f.condition_after ?? ""} onChange={(e) => set("condition_after", e.target.value)} rows={2} className={`${inputCls} resize-none`} />
            </div>
            <div>
              <label className={labelCls}>皮膚の観察</label>
              <textarea value={f.skin_notes ?? ""} onChange={(e) => set("skin_notes", e.target.value)} rows={2} className={`${inputCls} resize-none`} />
            </div>
          </div>

          {/* 加算 */}
          <div className="flex flex-wrap items-center gap-4 rounded-xl bg-gray-50 p-3">
            <span className="text-xs font-medium text-gray-600">加算</span>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={f.addon_shokai} onChange={(e) => set("addon_shokai", e.target.checked)} className="accent-cyan-600" />初回加算
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              認知症専門ケア
              <select value={f.addon_ninchi ?? ""} onChange={(e) => set("addon_ninchi", (e.target.value || null) as "I" | "II" | null)} className="rounded border border-gray-200 px-1.5 py-0.5 text-sm">
                <option value="">なし</option>
                <option value="I">Ⅰ</option>
                <option value="II">Ⅱ</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={f.addon_chuusankan} onChange={(e) => set("addon_chuusankan", e.target.checked)} className="accent-cyan-600" />中山間地域等提供加算
            </label>
          </div>

          <div>
            <label className={labelCls}>特記事項・申し送り</label>
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
            <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
              {saving && <Loader2 size={14} className="animate-spin" />}保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
