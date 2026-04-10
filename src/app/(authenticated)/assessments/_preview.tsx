"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";

// ─── Preview Frame ─────────────────────────────────────────────────────────────
// 各タブのプレビューを共通のA4サイズの枠で包む

export function PVFrame({ children, userName, date }: {
  children: ReactNode;
  userName: string;
  date: string;
}) {
  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold text-gray-600">▼ 印刷プレビュー</h3>
      </div>
      <div className="bg-white border shadow-sm overflow-auto" style={{ maxHeight: "75vh" }}>
        <div
          className="pv-sheet"
          style={{
            width: "210mm",
            minHeight: "297mm",
            padding: "10mm",
            fontFamily: '"MS Gothic","Yu Gothic","Hiragino Sans",sans-serif',
            fontSize: "9pt",
            color: "#000",
            background: "#fff",
            margin: "0 auto",
          }}
        >
          {/* Header row */}
          <div className="flex justify-between border-b border-gray-400 pb-1 mb-2 text-xs">
            <span>利用者氏名：{userName}</span>
            <span>{date}</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── Section title (numbered) ─────────────────────────────────────────────────

export function PVTitle({ number, children, small = false }: { number?: string; children: ReactNode; small?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 mb-2", small ? "" : "")}>
      {number && (
        <span className={cn(
          "inline-flex items-center justify-center bg-black text-white font-bold shrink-0",
          small ? "w-5 h-5 text-xs" : "w-7 h-7 text-sm"
        )}>
          {number}
        </span>
      )}
      <h2 className={cn("font-bold", small ? "text-sm" : "text-base")}>{children}</h2>
    </div>
  );
}

// ─── Subsection title (blue header bar) ──────────────────────────────────────

export function PVBar({ children }: { children: ReactNode }) {
  return (
    <div className="bg-blue-100 border-t border-b border-gray-400 px-2 py-0.5 text-xs font-bold">
      {children}
    </div>
  );
}

// ─── Cell styling helpers ────────────────────────────────────────────────────

export const cellBase: React.CSSProperties = {
  border: "0.5pt solid #000",
  padding: "1mm 1.5mm",
  fontSize: "8.5pt",
  verticalAlign: "top",
};

export const cellHead: React.CSSProperties = {
  ...cellBase,
  background: "#cfe0f0",
  fontWeight: "bold",
  textAlign: "center",
};

export const cellLabel: React.CSSProperties = {
  ...cellBase,
  background: "#f3f6fa",
  fontWeight: "normal",
  width: "20mm",
};

// ─── Circle for selected ○/◯ ─────────────────────────────────────────────────

export function PVCircle({ on, children }: { on: boolean; children?: ReactNode }) {
  return (
    <span className={cn("inline-block", on && "relative")}>
      {on && (
        <span
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{
            border: "1.2pt solid #000",
            borderRadius: "50%",
            width: "1.4em",
            height: "1.4em",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
          }}
        />
      )}
      <span className="relative z-10">{children}</span>
    </span>
  );
}

// ─── Checkbox ✓ ──────────────────────────────────────────────────────────────

export function PVCheck({ on }: { on: boolean }) {
  return (
    <span
      className="inline-flex items-center justify-center align-middle"
      style={{
        width: "3mm",
        height: "3mm",
        border: "0.6pt solid #000",
        marginRight: "1mm",
        fontSize: "7pt",
        lineHeight: "1",
      }}
    >
      {on ? "✓" : ""}
    </span>
  );
}

// ─── Labeled checkbox inline ─────────────────────────────────────────────────

export function PVCheckLabel({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="inline-flex items-center mr-2">
      <PVCheck on={on} />
      <span>{label}</span>
    </span>
  );
}

// ─── Radio list (inline, with ○ on selected) ────────────────────────────────

export function PVRadioList({ options, value }: { options: readonly string[]; value: string }) {
  return (
    <span>
      {options.map((opt, i) => (
        <span key={opt} className="mr-3">
          <PVCircle on={value === opt}>{opt}</PVCircle>
          {i < options.length - 1 && ""}
        </span>
      ))}
    </span>
  );
}

// ─── Line with underline for free text ──────────────────────────────────────

export function PVUnderline({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-block border-b border-gray-400 px-1 min-w-[8em]", className)}>
      {children || "\u00A0"}
    </span>
  );
}

// ─── Simple bordered box ─────────────────────────────────────────────────────

export function PVBox({ children, className, style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={cn("border border-gray-800 p-1", className)} style={style}>
      {children}
    </div>
  );
}

// ─── Print stylesheet (to be used by host page) ──────────────────────────────

export const PREVIEW_PRINT_CSS = `
  @media print {
    body * { visibility: hidden !important; }
    .pv-sheet, .pv-sheet * { visibility: visible !important; }
    .pv-sheet { position: fixed; left: 0; top: 0; margin: 0; box-shadow: none; }
    @page { size: A4; margin: 6mm; }
  }
`;
