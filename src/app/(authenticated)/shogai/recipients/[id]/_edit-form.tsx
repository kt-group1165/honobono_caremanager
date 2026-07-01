"use client";

import { useState, useTransition } from "react";
import { Save, Plus, Trash2 } from "lucide-react";
import {
  updateRecipientCert,
  upsertAllocation,
  deleteAllocation,
} from "../_actions";
import {
  SHOGAI_SERVICE_TYPES,
  type ShogaiRecipientCert,
  type ShogaiBenefitAllocation,
} from "@/lib/shogai-fukushi/types";

interface Props {
  cert: ShogaiRecipientCert;
  allocations: ShogaiBenefitAllocation[];
}

export function RecipientEditForm({ cert, allocations: initAllocs }: Props) {
  const [form, setForm] = useState({
    recipient_number: cert.recipient_number ?? "",
    municipality_code: cert.municipality_code ?? "",
    disability_category: cert.disability_category ?? "",
    disability_class: cert.disability_class ? String(cert.disability_class) : "",
    benefit_start_date: cert.benefit_start_date ?? "",
    benefit_end_date: cert.benefit_end_date ?? "",
    self_payment_limit: String(cert.self_payment_limit),
    self_payment_percent: String(cert.self_payment_percent),
    seiho_flag: cert.seiho_flag,
    soudan_office_name: cert.soudan_office_name ?? "",
    soudan_manager_name: cert.soudan_manager_name ?? "",
    notes: cert.notes ?? "",
  });
  const [allocations, setAllocations] = useState(initAllocs);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);

  const setField = (k: keyof typeof form, v: string | boolean) =>
    setForm((p) => ({ ...p, [k]: v }));

  const onSave = () => {
    setSaved(null);
    start(async () => {
      try {
        await updateRecipientCert(cert.id, {
          recipient_number: form.recipient_number || null,
          municipality_code: form.municipality_code || null,
          disability_category: form.disability_category || null,
          disability_class: form.disability_class
            ? Number(form.disability_class)
            : null,
          benefit_start_date: form.benefit_start_date || null,
          benefit_end_date: form.benefit_end_date || null,
          self_payment_limit: Number(form.self_payment_limit) || 0,
          self_payment_percent: Number(form.self_payment_percent) || 10,
          seiho_flag: form.seiho_flag,
          soudan_office_name: form.soudan_office_name || null,
          soudan_manager_name: form.soudan_manager_name || null,
          notes: form.notes || null,
        });
        setSaved(new Date().toLocaleTimeString("ja-JP"));
      } catch (e) {
        alert(String(e));
      }
    });
  };

  const addAllocation = async (serviceType: string, monthlyUnits: number) => {
    try {
      await upsertAllocation({
        cert_id: cert.id,
        service_type: serviceType,
        monthly_units: monthlyUnits,
      });
      // reload
      window.location.reload();
    } catch (e) {
      alert(String(e));
    }
  };

  const removeAllocation = async (allocId: string) => {
    if (!confirm("削除しますか？")) return;
    try {
      await deleteAllocation(allocId, cert.id);
      setAllocations(allocations.filter((a) => a.id !== allocId));
    } catch (e) {
      alert(String(e));
    }
  };

  return (
    <>
      <div className="sticky top-0 z-10 flex items-center justify-between rounded border bg-white/95 p-3 shadow-sm backdrop-blur">
        <div className="text-xs text-gray-600">
          受給者証情報
          {saved && <span className="ml-3 text-emerald-600">✅ {saved} に保存</span>}
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={onSave}
          className="inline-flex items-center gap-1 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          <Save size={14} /> {pending ? "保存中..." : "保存"}
        </button>
      </div>

      <div className="rounded border bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-bold text-gray-800">受給者証情報</h2>
        <div className="grid grid-cols-2 gap-4">
          <Field label="受給者証番号">
            <input
              type="text"
              value={form.recipient_number}
              onChange={(e) => setField("recipient_number", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label="保険者番号 (市町村コード)">
            <input
              type="text"
              value={form.municipality_code}
              onChange={(e) => setField("municipality_code", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label="障害区分">
            <select
              value={form.disability_category}
              onChange={(e) => setField("disability_category", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              <option value="">—</option>
              {["身体", "知的", "精神", "難病等"].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="障害支援区分">
            <select
              value={form.disability_class}
              onChange={(e) => setField("disability_class", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              <option value="">—</option>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  区分{n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="支給開始日">
            <input
              type="date"
              value={form.benefit_start_date}
              onChange={(e) => setField("benefit_start_date", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label="支給終了日">
            <input
              type="date"
              value={form.benefit_end_date}
              onChange={(e) => setField("benefit_end_date", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label="自己負担上限額 (月/円)">
            <input
              type="number"
              value={form.self_payment_limit}
              onChange={(e) => setField("self_payment_limit", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label="自己負担割合 (%)">
            <input
              type="number"
              step="0.01"
              value={form.self_payment_percent}
              onChange={(e) => setField("self_payment_percent", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label="相談支援事業所">
            <input
              type="text"
              value={form.soudan_office_name}
              onChange={(e) => setField("soudan_office_name", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label="相談支援専門員">
            <input
              type="text"
              value={form.soudan_manager_name}
              onChange={(e) => setField("soudan_manager_name", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            />
          </Field>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.seiho_flag}
            onChange={(e) => setField("seiho_flag", e.target.checked)}
          />
          生保受給者 (自己負担 0 円)
        </label>
        <Field label="備考">
          <textarea
            value={form.notes}
            onChange={(e) => setField("notes", e.target.value)}
            rows={3}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
      </div>

      {/* 支給決定 (サービス種別ごとの月間上限) */}
      <div className="mt-4 rounded border bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-bold text-gray-800">
          サービス種別ごとの月間支給量
        </h2>
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-600">
            <tr>
              <th className="px-2 py-1">サービス種別</th>
              <th className="px-2 py-1">月間支給 (単位数)</th>
              <th className="px-2 py-1">備考</th>
              <th className="px-2 py-1 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {allocations.length === 0 && (
              <tr>
                <td colSpan={4} className="px-2 py-3 text-center text-xs text-gray-500">
                  支給決定サービスが登録されていません
                </td>
              </tr>
            )}
            {allocations.map((a) => (
              <tr key={a.id} className="border-t">
                <td className="px-2 py-2 font-medium">{a.service_type}</td>
                <td className="px-2 py-2 font-mono">{a.monthly_units.toLocaleString()}</td>
                <td className="px-2 py-2 text-xs text-gray-600">{a.notes ?? "—"}</td>
                <td className="px-2 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => removeAllocation(a.id)}
                    className="rounded p-1 text-red-500 hover:bg-red-50"
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-3 flex items-end gap-2 border-t pt-3">
          <AllocationAdder onAdd={addAllocation} />
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
      {children}
    </div>
  );
}

function AllocationAdder({
  onAdd,
}: {
  onAdd: (serviceType: string, monthlyUnits: number) => void;
}) {
  const [st, setSt] = useState("居宅介護");
  const [units, setUnits] = useState("0");
  return (
    <>
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-700">
          サービス種別
        </label>
        <select
          value={st}
          onChange={(e) => setSt(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
        >
          {SHOGAI_SERVICE_TYPES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-700">
          月間支給 (単位数)
        </label>
        <input
          type="number"
          value={units}
          onChange={(e) => setUnits(e.target.value)}
          className="w-32 rounded border border-gray-300 px-2 py-1 text-sm"
        />
      </div>
      <button
        type="button"
        onClick={() => onAdd(st, Number(units) || 0)}
        className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
      >
        <Plus size={12} /> 追加
      </button>
    </>
  );
}
