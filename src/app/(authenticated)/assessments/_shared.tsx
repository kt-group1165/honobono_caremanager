"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SupportMatrix, SupportMatrixRow } from "./_types";

// ─── Section ──────────────────────────────────────────────────────────────────

export function Section({ title, subtitle, action, children }: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3 pb-2 border-b-2 border-blue-500">
        <div>
          <h2 className="text-lg font-bold text-gray-900">{title}</h2>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

export function SubSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg border bg-gray-50/50 p-3", className)}>
      <h3 className="text-sm font-semibold text-gray-700 mb-2 border-l-4 border-blue-400 pl-2">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

// ─── Field Primitives ────────────────────────────────────────────────────────

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <label className="text-xs text-gray-600 shrink-0 min-w-[5rem]">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  );
}

export function TextInput({ value, onChange, placeholder, className, type = "text" }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn("rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500", className)}
    />
  );
}

export function Textarea({ value, onChange, rows = 3, placeholder, className }: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
}) {
  return (
    <textarea
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      className={cn("w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y", className)}
    />
  );
}

// ─── Radio ────────────────────────────────────────────────────────────────────

export function Radio<T extends string>({ name, options, value, onChange, inline = true }: {
  name: string;
  options: readonly T[] | readonly { value: T; label: string }[];
  value: T | "";
  onChange: (v: T) => void;
  inline?: boolean;
}) {
  const opts = options.map((o) => (typeof o === "string" ? { value: o as T, label: o as string } : o));
  return (
    <div className={cn("flex gap-3", inline ? "flex-row flex-wrap" : "flex-col")}>
      {opts.map((opt) => (
        <label key={opt.value} className="flex items-center gap-1 cursor-pointer text-sm">
          <input
            type="radio"
            name={name}
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            className="accent-blue-600 w-3.5 h-3.5"
          />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  );
}

// ─── Checkbox ────────────────────────────────────────────────────────────────

export function Checkbox({ label, checked, onChange, className }: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  className?: string;
}) {
  return (
    <label className={cn("flex items-center gap-1 cursor-pointer text-sm", className)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-blue-600 rounded w-3.5 h-3.5"
      />
      <span>{label}</span>
    </label>
  );
}

export function CheckboxGroup({ options, value, onChange, inline = true }: {
  options: readonly string[];
  value: string[];
  onChange: (v: string[]) => void;
  inline?: boolean;
}) {
  const toggle = (opt: string) => {
    if (value.includes(opt)) onChange(value.filter((v) => v !== opt));
    else onChange([...value, opt]);
  };
  return (
    <div className={cn("flex gap-3", inline ? "flex-row flex-wrap" : "flex-col")}>
      {options.map((opt) => (
        <Checkbox key={opt} label={opt} checked={value.includes(opt)} onChange={() => toggle(opt)} />
      ))}
    </div>
  );
}

// ─── Number Radio (1-14 等の選択) ────────────────────────────────────────────

export function NumberRadio({ name, count, value, onChange, multi = false }: {
  name: string;
  count: number;
  value: string;
  onChange: (v: string) => void;
  multi?: boolean;
}) {
  const selected = value ? value.split(",") : [];
  const toggle = (n: string) => {
    if (multi) {
      const next = selected.includes(n) ? selected.filter((s) => s !== n) : [...selected, n];
      onChange(next.sort((a, b) => Number(a) - Number(b)).join(","));
    } else {
      onChange(selected.includes(n) ? "" : n);
    }
  };
  return (
    <div className="flex gap-1">
      {Array.from({ length: count }, (_, i) => (i + 1).toString()).map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => toggle(n)}
          className={cn(
            "min-w-[1.75rem] px-1.5 py-0.5 text-xs rounded border transition-colors",
            selected.includes(n)
              ? "bg-blue-600 text-white border-blue-600"
              : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
          )}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

// ─── Certification Items Row ─────────────────────────────────────────────────

export function CertItemRow({ label, count, value, onChange, multi = false }: {
  label: string;
  count: number;
  value: string;
  onChange: (v: string) => void;
  multi?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-1 border-b border-gray-100 last:border-b-0">
      <label className="text-xs text-gray-700 flex-1 min-w-0 truncate">{label}</label>
      <NumberRadio name={label} count={count} value={value} onChange={onChange} multi={multi} />
    </div>
  );
}

// ─── Support Matrix Table ────────────────────────────────────────────────────

export function SupportMatrixTable({ rows, value, onChange }: {
  rows: string[];
  value: SupportMatrix;
  onChange: (v: SupportMatrix) => void;
}) {
  const setRow = (row: string, field: keyof SupportMatrixRow, val: boolean) => {
    onChange({
      ...value,
      [row]: { ...(value[row] ?? { family_exec: false, service_exec: false, wish: false, needs_plan: false }), [field]: val },
    });
  };
  return (
    <table className="w-full text-xs border-collapse border border-gray-300">
      <thead>
        <tr className="bg-gray-50">
          <th className="border border-gray-300 px-2 py-1 text-left">項目</th>
          <th className="border border-gray-300 px-2 py-1" colSpan={2}>援助の現状</th>
          <th className="border border-gray-300 px-2 py-1">希望</th>
          <th className="border border-gray-300 px-2 py-1">要援助→計画</th>
        </tr>
        <tr className="bg-gray-50 text-[10px]">
          <th className="border border-gray-300"></th>
          <th className="border border-gray-300 px-1 py-0.5">家族実施</th>
          <th className="border border-gray-300 px-1 py-0.5">サービス実施</th>
          <th className="border border-gray-300"></th>
          <th className="border border-gray-300"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const r = value[row] ?? { family_exec: false, service_exec: false, wish: false, needs_plan: false };
          return (
            <tr key={row}>
              <td className="border border-gray-300 px-2 py-1">{row}</td>
              <td className="border border-gray-300 text-center">
                <input type="checkbox" checked={r.family_exec} onChange={(e) => setRow(row, "family_exec", e.target.checked)} className="accent-blue-600" />
              </td>
              <td className="border border-gray-300 text-center">
                <input type="checkbox" checked={r.service_exec} onChange={(e) => setRow(row, "service_exec", e.target.checked)} className="accent-blue-600" />
              </td>
              <td className="border border-gray-300 text-center">
                <input type="checkbox" checked={r.wish} onChange={(e) => setRow(row, "wish", e.target.checked)} className="accent-blue-600" />
              </td>
              <td className="border border-gray-300 text-center">
                <input type="checkbox" checked={r.needs_plan} onChange={(e) => setRow(row, "needs_plan", e.target.checked)} className="accent-blue-600" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Label Helper ────────────────────────────────────────────────────────────

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <label className={cn("block text-xs font-medium text-gray-600", className)}>{children}</label>;
}
