"use client";

/**
 * 構造化条文エディタ
 *
 * 条 / 項 / 号 のツリーを編集する。番号 (第X条・第Y項・第Z号) は
 * index から計算するため、途中に新規追加すると以降が自動リナンバー。
 */

import { useState, useCallback, useLayoutEffect, useRef } from "react";
import { ChevronUp, ChevronDown, Plus, Trash2, GripVertical } from "lucide-react";

/**
 * 内容に合わせて自動高さ調整する textarea。
 * - モダンブラウザは CSS `field-sizing: content` で自動追従
 * - 古いブラウザは useLayoutEffect で scrollHeight → height 反映
 */
export function AutoTextArea({
  value,
  onChange,
  minRows = 1,
  className = "",
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  minRows?: number;
  className?: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // field-sizing: content 対応ブラウザは何もしない (CSS が優先)。
    // 未対応環境向け fallback: 高さを auto に戻してから scrollHeight を反映。
    if (
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("field-sizing", "content")
    ) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={minRows}
      placeholder={placeholder}
      className={`resize-y overflow-hidden [field-sizing:content] ${className}`}
    />
  );
}
import type {
  ArticleNode,
  ItemNode,
  ParagraphNode,
} from "@/lib/contract-structure/types";
import {
  articleLabel,
  paragraphMarker,
  itemMarker,
} from "@/lib/contract-structure/numbering";

function uuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const newItem = (): ItemNode => ({ id: uuid(), marker: "nakaguro", text: "" });
const newParagraph = (): ParagraphNode => ({ id: uuid(), chapeau: "", items: [] });
const newArticle = (): ArticleNode => ({
  id: uuid(),
  title: "",
  chapeau: "",
  paragraphs: [],
});

interface Props {
  value: ArticleNode[];
  onChange: (next: ArticleNode[]) => void;
}

export function ArticlesEditor({ value, onChange }: Props) {
  const upsertArticle = useCallback(
    (idx: number, updater: (a: ArticleNode) => ArticleNode) => {
      onChange(value.map((a, i) => (i === idx ? updater(a) : a)));
    },
    [value, onChange],
  );

  const insertAt = (idx: number) => {
    const next = [...value];
    next.splice(idx, 0, newArticle());
    onChange(next);
  };
  const deleteAt = (idx: number) => {
    if (!confirm(`${articleLabel(idx)} を削除しますか？以降の条は自動的にリナンバーされます。`))
      return;
    onChange(value.filter((_, i) => i !== idx));
  };
  const moveUp = (idx: number) => {
    if (idx === 0) return;
    const next = [...value];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onChange(next);
  };
  const moveDown = (idx: number) => {
    if (idx === value.length - 1) return;
    const next = [...value];
    [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
    onChange(next);
  };

  return (
    <div className="rounded border bg-white shadow-sm">
      <header className="border-b bg-gray-50 px-4 py-2 text-sm font-bold text-gray-800">
        契約本文 (条・項・号) — {value.length} 条
      </header>
      <div className="divide-y">
        {value.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            まだ条がありません。
            <button
              type="button"
              onClick={() => insertAt(0)}
              className="ml-2 inline-flex items-center gap-1 rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700"
            >
              <Plus size={12} /> 第1条を追加
            </button>
          </div>
        )}
        {value.map((art, i) => (
          <ArticleEditor
            key={art.id}
            node={art}
            index={i}
            total={value.length}
            onChange={(next) => upsertArticle(i, () => next)}
            onInsertBefore={() => insertAt(i)}
            onInsertAfter={() => insertAt(i + 1)}
            onDelete={() => deleteAt(i)}
            onMoveUp={() => moveUp(i)}
            onMoveDown={() => moveDown(i)}
          />
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────

function ArticleEditor({
  node,
  index,
  total,
  onChange,
  onInsertBefore,
  onInsertAfter,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  node: ArticleNode;
  index: number;
  total: number;
  onChange: (next: ArticleNode) => void;
  onInsertBefore: () => void;
  onInsertAfter: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const set = <K extends keyof ArticleNode>(key: K, v: ArticleNode[K]) =>
    onChange({ ...node, [key]: v });

  const addParagraph = () =>
    onChange({ ...node, paragraphs: [...node.paragraphs, newParagraph()] });

  const insertParagraphAt = (i: number) => {
    const next = [...node.paragraphs];
    next.splice(i, 0, newParagraph());
    onChange({ ...node, paragraphs: next });
  };
  const deleteParagraphAt = (i: number) => {
    if (!confirm(`${paragraphMarker(i)} を削除しますか？`)) return;
    onChange({
      ...node,
      paragraphs: node.paragraphs.filter((_, j) => j !== i),
    });
  };
  const moveParaUp = (i: number) => {
    if (i === 0) return;
    const next = [...node.paragraphs];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    onChange({ ...node, paragraphs: next });
  };
  const moveParaDown = (i: number) => {
    if (i === node.paragraphs.length - 1) return;
    const next = [...node.paragraphs];
    [next[i + 1], next[i]] = [next[i], next[i + 1]];
    onChange({ ...node, paragraphs: next });
  };
  const upsertPara = (
    i: number,
    updater: (p: ParagraphNode) => ParagraphNode,
  ) => {
    onChange({
      ...node,
      paragraphs: node.paragraphs.map((p, j) => (j === i ? updater(p) : p)),
    });
  };

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-bold text-indigo-800">
          {articleLabel(index)}
        </span>
        <input
          type="text"
          value={node.title ?? ""}
          onChange={(e) => set("title", e.target.value)}
          placeholder="見出し (例: 契約の目的)"
          className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm focus:border-indigo-400 focus:outline-none"
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            title="上へ"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === total - 1}
            title="下へ"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            onClick={onInsertBefore}
            title="この条の前に挿入"
            className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100"
          >
            ↑ 前に挿入
          </button>
          <button
            type="button"
            onClick={onInsertAfter}
            title="この条の後に挿入"
            className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100"
          >
            ↓ 後に挿入
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="この条を削除"
            className="rounded p-1 text-red-500 hover:bg-red-50"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <AutoTextArea
        value={node.chapeau}
        onChange={(v) => set("chapeau", v)}
        minRows={2}
        placeholder="条の柱書 (項が無ければこれが条本文)"
        className="w-full rounded border border-gray-300 px-2 py-1 text-sm font-serif leading-relaxed focus:border-indigo-400 focus:outline-none"
      />

      <div className="mt-2 space-y-1">
        {node.paragraphs.map((p, i) => (
          <ParagraphEditor
            key={p.id}
            node={p}
            index={i}
            total={node.paragraphs.length}
            onChange={(next) => upsertPara(i, () => next)}
            onInsertBefore={() => insertParagraphAt(i)}
            onInsertAfter={() => insertParagraphAt(i + 1)}
            onDelete={() => deleteParagraphAt(i)}
            onMoveUp={() => moveParaUp(i)}
            onMoveDown={() => moveParaDown(i)}
          />
        ))}
        <button
          type="button"
          onClick={addParagraph}
          className="ml-2 inline-flex items-center gap-1 rounded border border-dashed border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
        >
          <Plus size={10} /> 項を追加
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────

function ParagraphEditor({
  node,
  index,
  total,
  onChange,
  onInsertBefore,
  onInsertAfter,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  node: ParagraphNode;
  index: number;
  total: number;
  onChange: (next: ParagraphNode) => void;
  onInsertBefore: () => void;
  onInsertAfter: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const set = <K extends keyof ParagraphNode>(key: K, v: ParagraphNode[K]) =>
    onChange({ ...node, [key]: v });

  const addItem = () =>
    onChange({ ...node, items: [...node.items, newItem()] });

  const insertItemAt = (i: number) => {
    const next = [...node.items];
    next.splice(i, 0, newItem());
    onChange({ ...node, items: next });
  };
  const deleteItemAt = (i: number) => {
    onChange({ ...node, items: node.items.filter((_, j) => j !== i) });
  };
  const moveItemUp = (i: number) => {
    if (i === 0) return;
    const next = [...node.items];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    onChange({ ...node, items: next });
  };
  const moveItemDown = (i: number) => {
    if (i === node.items.length - 1) return;
    const next = [...node.items];
    [next[i + 1], next[i]] = [next[i], next[i + 1]];
    onChange({ ...node, items: next });
  };
  const upsertItem = (i: number, updater: (it: ItemNode) => ItemNode) =>
    onChange({
      ...node,
      items: node.items.map((it, j) => (j === i ? updater(it) : it)),
    });

  return (
    <div className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5">
      <div className="flex items-start gap-1">
        <span className="mt-1 min-w-[1.5em] rounded bg-white px-1 text-xs font-bold text-gray-700">
          {paragraphMarker(index)}
        </span>
        <AutoTextArea
          value={node.chapeau}
          onChange={(v) => set("chapeau", v)}
          minRows={1}
          placeholder="項の本文 (号が無ければこれが項本文)"
          className="flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-sm font-serif focus:border-indigo-400 focus:outline-none"
        />
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            className="rounded p-0.5 text-gray-500 hover:bg-white disabled:opacity-30"
          >
            <ChevronUp size={12} />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === total - 1}
            className="rounded p-0.5 text-gray-500 hover:bg-white disabled:opacity-30"
          >
            <ChevronDown size={12} />
          </button>
          <button
            type="button"
            onClick={onInsertAfter}
            title="下に項を挿入"
            className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-100"
          >
            +項
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="削除"
            className="rounded p-0.5 text-red-500 hover:bg-red-50"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {node.items.length > 0 && (
        <div className="mt-1 space-y-0.5 pl-6">
          {node.items.map((it, i) => (
            <ItemEditor
              key={it.id}
              node={it}
              index={i}
              total={node.items.length}
              onChange={(next) => upsertItem(i, () => next)}
              onInsertAfter={() => insertItemAt(i + 1)}
              onDelete={() => deleteItemAt(i)}
              onMoveUp={() => moveItemUp(i)}
              onMoveDown={() => moveItemDown(i)}
            />
          ))}
        </div>
      )}
      {node.items.length === 0 && (
        <div className="mt-1 pl-6">
          <button
            type="button"
            onClick={addItem}
            className="inline-flex items-center gap-1 rounded border border-dashed border-gray-300 bg-white px-2 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50"
          >
            <Plus size={8} /> 号を追加
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────

function ItemEditor({
  node,
  index,
  total,
  onChange,
  onInsertAfter,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  node: ItemNode;
  index: number;
  total: number;
  onChange: (next: ItemNode) => void;
  onInsertAfter: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const set = <K extends keyof ItemNode>(key: K, v: ItemNode[K]) =>
    onChange({ ...node, [key]: v });

  return (
    <div className="flex items-start gap-1">
      <span className="mt-1 min-w-[1.2em] text-xs text-gray-700">
        {itemMarker(index, node.marker)}
      </span>
      <select
        value={node.marker}
        onChange={(e) => set("marker", e.target.value as ItemNode["marker"])}
        className="mt-0.5 rounded border border-gray-300 bg-white px-1 py-0.5 text-[10px]"
      >
        <option value="nakaguro">・</option>
        <option value="iroha">イロハ</option>
        <option value="arabic">1.2.3.</option>
      </select>
      <AutoTextArea
        value={node.text}
        onChange={(v) => set("text", v)}
        minRows={1}
        className="flex-1 rounded border border-gray-300 bg-white px-2 py-0.5 text-sm font-serif focus:border-indigo-400 focus:outline-none"
      />
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={index === 0}
          className="rounded p-0.5 text-gray-500 hover:bg-white disabled:opacity-30"
        >
          <ChevronUp size={10} />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={index === total - 1}
          className="rounded p-0.5 text-gray-500 hover:bg-white disabled:opacity-30"
        >
          <ChevronDown size={10} />
        </button>
        <button
          type="button"
          onClick={onInsertAfter}
          title="下に号を挿入"
          className="rounded border border-gray-300 bg-white px-1 py-0.5 text-[9px] text-gray-700 hover:bg-gray-100"
        >
          +
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-0.5 text-red-500 hover:bg-red-50"
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  );
}

// Note: GripVertical is imported for future drag-drop support.
void GripVertical;
