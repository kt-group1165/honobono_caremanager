"use client";

import { useState, useTransition } from "react";
import { Save } from "lucide-react";
import { createRecipientCert } from "../_actions";

interface Client {
  id: string;
  name: string;
  furigana: string | null;
  tenant_id: string;
}

const CATS = ["身体", "知的", "精神", "難病等"];

export function RecipientForm({ clients }: { clients: Client[] }) {
  const [clientId, setClientId] = useState("");
  const [form, setForm] = useState({
    recipient_number: "",
    municipality_code: "",
    disability_category: "",
    disability_class: "",
    benefit_start_date: "",
    benefit_end_date: "",
    self_payment_limit: "0",
    self_payment_percent: "10.00",
    seiho_flag: false,
    soudan_office_name: "",
    soudan_manager_name: "",
    notes: "",
  });
  const [pending, start] = useTransition();

  const setField = (k: keyof typeof form, v: string | boolean) =>
    setForm((p) => ({ ...p, [k]: v }));

  const onSubmit = () => {
    if (!clientId) return alert("利用者を選択してください");
    const c = clients.find((x) => x.id === clientId);
    if (!c) return;
    start(async () => {
      try {
        await createRecipientCert({
          client_id: clientId,
          tenant_id: c.tenant_id,
          recipient_number: form.recipient_number || undefined,
          municipality_code: form.municipality_code || undefined,
          disability_category: form.disability_category || undefined,
          disability_class: form.disability_class
            ? Number(form.disability_class)
            : undefined,
          benefit_start_date: form.benefit_start_date || undefined,
          benefit_end_date: form.benefit_end_date || undefined,
          self_payment_limit: Number(form.self_payment_limit) || 0,
          self_payment_percent: Number(form.self_payment_percent) || 10,
          seiho_flag: form.seiho_flag,
          soudan_office_name: form.soudan_office_name || undefined,
          soudan_manager_name: form.soudan_manager_name || undefined,
          notes: form.notes || undefined,
        });
      } catch (e) {
        alert(String(e));
      }
    });
  };

  return (
    <div className="space-y-4 rounded border bg-white p-6 shadow-sm">
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-700">
          利用者 <span className="text-red-500">*</span>
        </label>
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="">選択してください</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} {c.furigana ? `(${c.furigana})` : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FieldText
          label="受給者証番号"
          value={form.recipient_number}
          onChange={(v) => setField("recipient_number", v)}
        />
        <FieldText
          label="保険者番号 (市町村コード)"
          value={form.municipality_code}
          onChange={(v) => setField("municipality_code", v)}
        />
        <FieldSelect
          label="障害区分"
          value={form.disability_category}
          onChange={(v) => setField("disability_category", v)}
          options={["", ...CATS]}
        />
        <FieldSelect
          label="障害支援区分"
          value={form.disability_class}
          onChange={(v) => setField("disability_class", v)}
          options={["", "1", "2", "3", "4", "5", "6"]}
        />
        <FieldText
          label="支給決定 開始日"
          type="date"
          value={form.benefit_start_date}
          onChange={(v) => setField("benefit_start_date", v)}
        />
        <FieldText
          label="支給決定 終了日"
          type="date"
          value={form.benefit_end_date}
          onChange={(v) => setField("benefit_end_date", v)}
        />
        <FieldText
          label="自己負担上限額 (月額 円)"
          type="number"
          value={form.self_payment_limit}
          onChange={(v) => setField("self_payment_limit", v)}
        />
        <FieldText
          label="自己負担割合 (%)"
          type="number"
          value={form.self_payment_percent}
          onChange={(v) => setField("self_payment_percent", v)}
        />
        <FieldText
          label="相談支援事業所 名称"
          value={form.soudan_office_name}
          onChange={(v) => setField("soudan_office_name", v)}
        />
        <FieldText
          label="相談支援専門員 氏名"
          value={form.soudan_manager_name}
          onChange={(v) => setField("soudan_manager_name", v)}
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.seiho_flag}
          onChange={(e) => setField("seiho_flag", e.target.checked)}
        />
        生保受給者 (自己負担 0 円扱い)
      </label>

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-700">備考</label>
        <textarea
          value={form.notes}
          onChange={(e) => setField("notes", e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          rows={3}
        />
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={pending}
          onClick={onSubmit}
          className="inline-flex items-center gap-1 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          <Save size={14} /> {pending ? "保存中..." : "登録"}
        </button>
      </div>
    </div>
  );
}

function FieldText({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
      />
    </div>
  );
}

function FieldSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o || "—"}
          </option>
        ))}
      </select>
    </div>
  );
}
