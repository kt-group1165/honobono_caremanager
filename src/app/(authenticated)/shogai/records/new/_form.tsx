"use client";

import { useState, useMemo, useTransition } from "react";
import { Save } from "lucide-react";
import { submitCreateRecord } from "../_actions";
import { SHOGAI_SERVICE_TYPES } from "@/lib/shogai-fukushi/types";
import { findServiceCode } from "@/lib/shogai-fukushi/billing";
import { useBusinessType } from "@/lib/business-type-context";

interface Client {
  id: string;
  name: string;
  furigana: string | null;
  tenant_id: string;
}
interface Code {
  id: string;
  service_type: string;
  service_category: string | null;
  code: string;
  name: string;
  unit_count: number;
  min_minutes: number | null;
  max_minutes: number | null;
  is_addon: boolean;
}

export function NewRecordForm({
  clients,
  codes,
}: {
  clients: Client[];
  codes: Code[];
}) {
  const { currentOffice } = useBusinessType();
  const _d = new Date(); // ローカル日付 (UTC ズレ防止)
  const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, "0")}-${String(_d.getDate()).padStart(2, "0")}`;
  const [form, setForm] = useState({
    client_id: "",
    service_date: today,
    start_time: "09:00",
    end_time: "10:00",
    service_type: "居宅介護",
    service_category: "身体介護",
    activities: "",
    client_condition: "",
    handover_notes: "",
    notes: "",
  });
  const [pending, start] = useTransition();

  const set = (k: keyof typeof form, v: string) =>
    setForm((p) => ({ ...p, [k]: v }));

  const durationMinutes = useMemo(() => {
    if (!form.start_time || !form.end_time) return 0;
    const [sh, sm] = form.start_time.split(":").map(Number);
    const [eh, em] = form.end_time.split(":").map(Number);
    let d = eh * 60 + em - (sh * 60 + sm);
    if (d < 0) d += 24 * 60;
    return d;
  }, [form.start_time, form.end_time]);

  // カテゴリ候補 (サービス種別ごと)
  const categories = useMemo(() => {
    const set = new Set<string>();
    codes
      .filter(
        (c) => c.service_type === form.service_type && !c.is_addon && c.service_category,
      )
      .forEach((c) => c.service_category && set.add(c.service_category));
    return Array.from(set);
  }, [codes, form.service_type]);

  // 自動判定した本体サービスコード + 単位数
  const matched = useMemo(() => {
    return findServiceCode(
      codes.map((c) => ({
        ...c,
        fiscal_year: 2024,
        time_bracket: null,
        is_active: true,
        notes: null,
      })) as Parameters<typeof findServiceCode>[0],
      {
        serviceType: form.service_type as (typeof SHOGAI_SERVICE_TYPES)[number],
        serviceCategory: form.service_category || null,
        durationMinutes,
      },
    );
  }, [codes, form.service_type, form.service_category, durationMinutes]);

  const onSubmit = () => {
    if (!form.client_id) return alert("利用者を選択してください");
    const c = clients.find((x) => x.id === form.client_id);
    if (!c) return;
    const fd = new FormData();
    fd.set("tenant_id", c.tenant_id);
    // 自事業所を付与 (office スコープの対象にする)
    if (currentOffice) fd.set("office_id", currentOffice.id);
    fd.set("client_id", form.client_id);
    fd.set("service_date", form.service_date);
    fd.set("start_time", form.start_time);
    fd.set("end_time", form.end_time);
    fd.set("service_type", form.service_type);
    fd.set("service_category", form.service_category);
    if (matched) {
      fd.set("service_code", matched.code);
      fd.set("unit_count", String(matched.unit_count));
    }
    fd.set("activities", form.activities);
    fd.set("client_condition", form.client_condition);
    fd.set("handover_notes", form.handover_notes);
    fd.set("notes", form.notes);
    start(async () => {
      try {
        await submitCreateRecord(fd);
      } catch (e) {
        alert(String(e));
      }
    });
  };

  return (
    <div className="space-y-4 rounded border bg-white p-6 shadow-sm">
      <div className="grid grid-cols-2 gap-4">
        <F label="利用者">
          <select
            value={form.client_id}
            onChange={(e) => set("client_id", e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            <option value="">選択…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.furigana ? `(${c.furigana})` : ""}
              </option>
            ))}
          </select>
        </F>
        <F label="サービス提供日">
          <input
            type="date"
            value={form.service_date}
            onChange={(e) => set("service_date", e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
          />
        </F>
        <F label="開始時刻">
          <input
            type="time"
            step={300}
            value={form.start_time}
            onChange={(e) => set("start_time", e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
          />
        </F>
        <F label="終了時刻">
          <input
            type="time"
            step={300}
            value={form.end_time}
            onChange={(e) => set("end_time", e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
          />
        </F>
        <F label="サービス種別">
          <select
            value={form.service_type}
            onChange={(e) => {
              set("service_type", e.target.value);
              set("service_category", "");
            }}
            className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            {SHOGAI_SERVICE_TYPES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </F>
        <F label="サービス内容 (カテゴリ)">
          {categories.length > 0 ? (
            <select
              value={form.service_category}
              onChange={(e) => set("service_category", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              <option value="">—</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          ) : (
            <div className="text-xs text-gray-500 py-1.5">カテゴリなし</div>
          )}
        </F>
      </div>

      <div className="rounded border border-gray-200 bg-gray-50 p-3 text-xs">
        <div>
          分数: <strong>{durationMinutes} 分</strong>
        </div>
        {matched ? (
          <div>
            自動判定: {matched.code} / {matched.name} ={" "}
            <strong>{matched.unit_count.toLocaleString()} 単位</strong>
          </div>
        ) : (
          <div className="text-amber-700">
            適合するサービスコードが見つかりません (時間帯・カテゴリ確認)
          </div>
        )}
      </div>

      <F label="実施内容">
        <textarea
          rows={3}
          value={form.activities}
          onChange={(e) => set("activities", e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
      </F>
      <F label="利用者の状態">
        <textarea
          rows={2}
          value={form.client_condition}
          onChange={(e) => set("client_condition", e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
      </F>
      <F label="引継事項">
        <textarea
          rows={2}
          value={form.handover_notes}
          onChange={(e) => set("handover_notes", e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
      </F>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={pending}
          onClick={onSubmit}
          className="inline-flex items-center gap-1 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          <Save size={14} /> {pending ? "保存中..." : "下書き保存"}
        </button>
      </div>
    </div>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
      {children}
    </div>
  );
}
