"use client";

import { useState, useTransition } from "react";
import { Save } from "lucide-react";
import { updateTemplateContent } from "../_actions";
import { ArticlesEditor, AutoTextArea } from "./_articles-editor";
import type { ArticleNode } from "@/lib/contract-structure/types";

interface Item {
  key: string;
  label: string;
  multiline: boolean;
  group: string;
}

interface Props {
  id: string;
  initialContent: Record<string, unknown>;
  initialNotes: string;
  groupedSections: Array<{ group: string; items: Item[] }>;
}

export function EditTemplateForm({
  id,
  initialContent,
  initialNotes,
  groupedSections,
}: Props) {
  // flat keys + jsonb tree を同じ state で保持し保存時に merge。
  // flat key の string 値だけを分離管理して type-safe に。
  const [flatContent, setFlatContent] = useState<Record<string, string>>(() => {
    const rec: Record<string, string> = {};
    for (const [k, v] of Object.entries(initialContent)) {
      if (typeof v === "string") rec[k] = v;
    }
    return rec;
  });
  const [articles, setArticles] = useState<ArticleNode[]>(() => {
    const arr = (initialContent as { articles?: ArticleNode[] }).articles;
    return Array.isArray(arr) ? arr : [];
  });
  const [notes, setNotes] = useState(initialNotes);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);

  // 契約本文 (第1〜22条) は articles ツリー側で編集するため、
  // flat sections からは article_* を除外する。
  const nonArticleSections = groupedSections
    .map((g) => ({
      group: g.group,
      items: g.items.filter((it) => !it.key.startsWith("article_")),
    }))
    .filter((g) => g.items.length > 0);

  const set = (key: string, value: string) =>
    setFlatContent((prev) => ({ ...prev, [key]: value }));

  const onSave = () => {
    setSaved(null);
    start(async () => {
      try {
        // flat + articles を merge。既存の他 key (= jsonb 内の任意 key) はそのまま保持するため
        // initialContent を base にする。
        const merged: Record<string, unknown> = { ...initialContent };
        for (const k of Object.keys(flatContent)) merged[k] = flatContent[k];
        merged.articles = articles;
        await updateTemplateContent(id, merged, notes || null);
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
          条 {articles.length} 個 + flat項目{" "}
          {nonArticleSections.reduce((s, g) => s + g.items.length, 0)}
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

      {/* 契約本文 (条・項・号) — 構造化エディタ */}
      <ArticlesEditor value={articles} onChange={setArticles} />

      {/* 契約本文以外の flat sections */}
      {nonArticleSections.map(({ group, items }) => (
        <section key={group} className="rounded border bg-white shadow-sm">
          <header className="border-b bg-gray-50 px-4 py-2 text-sm font-bold text-gray-800">
            {group}
          </header>
          <div className="divide-y">
            {items.map((it) => {
              const v = flatContent[it.key] ?? "";
              return (
                <div key={it.key} className="px-4 py-3">
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs font-medium text-gray-700">
                      {it.label}
                    </label>
                    <code className="text-[10px] text-gray-400">{it.key}</code>
                  </div>
                  {it.multiline ? (
                    <AutoTextArea
                      value={v}
                      onChange={(nv) => set(it.key, nv)}
                      minRows={3}
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
