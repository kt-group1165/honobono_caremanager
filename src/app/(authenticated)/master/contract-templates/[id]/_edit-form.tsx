"use client";

import { useState, useTransition } from "react";
import { Save } from "lucide-react";
import { updateTemplateContent } from "../_actions";

interface Item {
  key: string;
  label: string;
  multiline: boolean;
  group: string;
}

interface Props {
  id: string;
  initialContent: Record<string, string>;
  initialNotes: string;
  groupedSections: Array<{ group: string; items: Item[] }>;
}

export function EditTemplateForm({
  id,
  initialContent,
  initialNotes,
  groupedSections,
}: Props) {
  const [content, setContent] = useState<Record<string, string>>(initialContent);
  const [notes, setNotes] = useState(initialNotes);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);

  const set = (key: string, value: string) =>
    setContent((prev) => ({ ...prev, [key]: value }));

  const onSave = () => {
    setSaved(null);
    start(async () => {
      try {
        await updateTemplateContent(id, content, notes || null);
        setSaved(new Date().toLocaleTimeString("ja-JP"));
      } catch (e) {
        alert(String(e));
      }
    });
  };

  return (
    <div className="space-y-4">
      {/* Sticky 保存バー */}
      <div className="sticky top-0 z-10 flex items-center justify-between rounded border bg-white/95 p-3 shadow-sm backdrop-blur">
        <div className="text-xs text-gray-600">
          全 {groupedSections.reduce((s, g) => s + g.items.length, 0)} 項目
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

      {/* 備考 */}
      <div className="rounded border bg-white p-4 shadow-sm">
        <label className="mb-1 block text-xs font-medium text-gray-600">
          版の備考 (= 改定理由・法令根拠 等)
        </label>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="例: 令和 7 年 4 月介護報酬改定対応"
          className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-400 focus:outline-none"
        />
      </div>

      {/* section group ごと */}
      {groupedSections.map(({ group, items }) => (
        <section key={group} className="rounded border bg-white shadow-sm">
          <header className="border-b bg-gray-50 px-4 py-2 text-sm font-bold text-gray-800">
            {group}
          </header>
          <div className="divide-y">
            {items.map((it) => {
              const v = content[it.key] ?? "";
              return (
                <div key={it.key} className="px-4 py-3">
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs font-medium text-gray-700">
                      {it.label}
                    </label>
                    <code className="text-[10px] text-gray-400">{it.key}</code>
                  </div>
                  {it.multiline ? (
                    <textarea
                      value={v}
                      onChange={(e) => set(it.key, e.target.value)}
                      rows={Math.max(3, Math.min(20, v.split("\n").length + 1))}
                      className="w-full rounded border border-gray-300 px-3 py-2 text-sm font-serif leading-relaxed focus:border-indigo-400 focus:outline-none"
                    />
                  ) : (
                    <input
                      type="text"
                      value={v}
                      onChange={(e) => set(it.key, e.target.value)}
                      className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-400 focus:outline-none"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {/* 下部 保存 */}
      <div className="flex justify-end pb-8">
        <button
          type="button"
          disabled={pending}
          onClick={onSave}
          className="inline-flex items-center gap-1 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          <Save size={14} /> {pending ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}
