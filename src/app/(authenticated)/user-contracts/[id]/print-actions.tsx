"use client";

import { ReactNode } from "react";

/**
 * 印刷ボタン (= 印刷時にも見せない wrapper を提供)
 *
 * children に印刷ボタンの内側を渡す。
 */
export function ContractPrintActions({ children }: { children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded transition"
    >
      {children}
    </button>
  );
}
