"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

/** 請求画面 共通の月ナビ (R8/6 形式表示) */
export function MonthNav({
  year,
  month,
  onChange,
}: {
  year: number;
  month: number;
  onChange: (y: number, m: number) => void;
}) {
  const prev = () => {
    if (month === 1) onChange(year - 1, 12);
    else onChange(year, month - 1);
  };
  const next = () => {
    if (month === 12) onChange(year + 1, 1);
    else onChange(year, month + 1);
  };
  // 令和表記 (2019 = R1)
  const reiwa = year - 2018;
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border bg-white px-1 py-0.5">
      <button
        type="button"
        onClick={prev}
        className="rounded p-1.5 text-gray-500 hover:bg-gray-100"
      >
        <ChevronLeft size={16} />
      </button>
      <span className="min-w-[90px] text-center text-sm font-bold text-gray-800">
        R{reiwa}/{month} 請求分
      </span>
      <button
        type="button"
        onClick={next}
        className="rounded p-1.5 text-gray-500 hover:bg-gray-100"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
