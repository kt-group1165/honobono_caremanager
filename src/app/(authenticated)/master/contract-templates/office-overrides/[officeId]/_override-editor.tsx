"use client";

import { useState, useTransition } from "react";
import { Save } from "lucide-react";
import { updateOfficeContractOverrides } from "../_actions";
import { AutoTextArea } from "../../[id]/_articles-editor";

interface Section {
  key: string;
  label: string;
  templateValue: string;
}

interface Props {
  officeId: string;
  initialOverrides: Record<string, string>;
  sections: Section[];
}

/** key prefix → 別紙見出しに group 化 */
function groupOf(key: string): string {
  if (key.startsWith("juyo_01")) return "別紙1 相談窓口";
  if (key.startsWith("juyo_02")) return "別紙2 事業所概要";
  if (key.startsWith("juyo_03")) return "別紙3 申込〜提供の流れ";
  if (key.startsWith("juyo_04")) return "別紙4 利用料金";
  if (key.startsWith("juyo_05")) return "別紙5 利用開始・終了";
  if (key.startsWith("juyo_06")) return "別紙6 事業所の運営方針";
  if (key.startsWith("juyo_07")) return "別紙7 相談・苦情窓口";
  if (key.startsWith("juyo_08")) return "別紙8 当社の概要";
  return "その他";
}

export function OverrideEditor({ officeId, initialOverrides, sections }: Props) {
  const [values, setValues] = useState<Record<string, string>>(initialOverrides);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);

  const grouped = new Map<string, Section[]>();
  for (const s of sections) {
    const g = groupOf(s.key);
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g)!.push(s);
  }

  const set = (key: string, value: string) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const clear = (key: string) =>
    setValues((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const onSave = () => {
    setSaved(null);
    start(async () => {
      try {
        await updateOfficeContractOverrides(officeId, values);
        setSaved(new Date().toLocaleTimeString("ja-JP"));
      } catch (e) {
        alert(String(e));
      }
    });
  };

  const overrideCount = Object.entries(values).filter(
    ([, v]) => v && v.trim().length > 0,
  ).length;

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 flex items-center justify-between rounded border bg-white/95 p-3 shadow-sm backdrop-blur">
        <div className="text-xs text-gray-600">
          上書き中: <strong>{overrideCount}</strong> key
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

      {Array.from(grouped.entries()).map(([group, items]) => (
        <section key={group} className="rounded border bg-white shadow-sm">
          <header className="border-b bg-gray-50 px-4 py-2 text-sm font-bold text-gray-800">
            {group}
          </header>
          <div className="divide-y">
            {items.map((it) => {
              const overrideVal = values[it.key] ?? "";
              const hasOverride = overrideVal.trim().length > 0;
              return (
                <div key={it.key} className="px-4 py-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-gray-700">
                      {it.label}
                    </label>
                    <div className="flex items-center gap-2">
                      {hasOverride && (
                        <button
                          type="button"
                          onClick={() => clear(it.key)}
                          className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[10px] text-gray-600 hover:bg-gray-100"
                          title="上書きを解除しテンプレ値に戻す"
                        >
                          上書き解除
                        </button>
                      )}
                      <code className="text-[10px] text-gray-400">{it.key}</code>
                    </div>
                  </div>
                  <AutoTextArea
                    value={overrideVal}
                    onChange={(v) => set(it.key, v)}
                    minRows={2}
                    placeholder={
                      it.templateValue
                        ? "(テンプレの値を使用中。ここに入力すると上書き)"
                        : "(テンプレも空。ここに入力すると上書き)"
                    }
                    className={`w-full rounded border px-3 py-2 text-sm font-serif leading-relaxed focus:border-indigo-400 focus:outline-none ${
                      hasOverride
                        ? "border-amber-300 bg-amber-50"
                        : "border-gray-300 bg-white"
                    }`}
                  />
                  {it.templateValue && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[10px] text-gray-500 hover:text-gray-700">
                        テンプレの値を表示 ({it.templateValue.length} 文字)
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-2 text-[11px] text-gray-600">
                        {it.templateValue}
                      </pre>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

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
