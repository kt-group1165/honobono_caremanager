"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Search, ChevronDown, X, User } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StaffOption {
  id: string;
  name: string;
  /** 追加ラベル (例: 「(対応不可)」「(重複)」) */
  suffix?: string;
  /** name の kana / furigana (=検索対象) */
  furigana?: string | null;
}

interface Props {
  value: string; // "" = 未割当
  onChange: (id: string) => void;
  options: StaffOption[];
  placeholder?: string;
  className?: string;
  /** 職員が対応不可等の suffix を含む option を disabled にする */
  disabledSuffixes?: string[];
}

/**
 * 検索付きの職員セレクト。ネイティブ <select> の代替。
 * 名前 or ふりがな の部分一致検索、null (=未割当) 選択可。
 */
export function StaffCombobox({
  value,
  onChange,
  options,
  placeholder = "未割当",
  className,
  disabledSuffixes = [],
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 選択中の option
  const selected = useMemo(
    () => options.find((o) => o.id === value) ?? null,
    [options, value],
  );

  // フィルタ
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        (o.furigana ?? "").toLowerCase().includes(q),
    );
  }, [options, query]);

  // 外側クリックで閉じる
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <span className="flex items-center gap-1.5 truncate text-left">
          <User size={14} className="text-gray-400" />
          <span className={cn("truncate", !selected && "text-gray-500")}>
            {selected ? `${selected.name}${selected.suffix ?? ""}` : placeholder}
          </span>
        </span>
        <ChevronDown
          size={16}
          className={cn(
            "text-gray-400 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="p-2 border-b border-gray-100">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="名前・ふりがなで検索..."
                className="w-full rounded border border-gray-300 pl-7 pr-7 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            <li>
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                  setQuery("");
                }}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50",
                  value === "" && "bg-blue-50 text-blue-700 font-medium",
                )}
              >
                — 未割当 —
              </button>
            </li>
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-gray-400">該当なし</li>
            )}
            {filtered.map((o) => {
              const isDisabled = disabledSuffixes.some(
                (s) => o.suffix?.includes(s),
              );
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    disabled={isDisabled}
                    onClick={() => {
                      onChange(o.id);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed",
                      value === o.id && "bg-blue-50 text-blue-700 font-medium",
                    )}
                  >
                    <span>{o.name}</span>
                    {o.suffix && (
                      <span className="ml-1 text-xs text-gray-500">
                        {o.suffix}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
