/**
 * contract template 版間 diff 計算
 *
 * flat key + articles ツリー の両方を比較する。
 * 依存: 純 TypeScript (LCS 手実装)
 */

import type { ArticleNode, ItemNode, ParagraphNode } from "./types";

export type ChangeKind = "equal" | "add" | "remove";

export interface LineDiff {
  kind: ChangeKind;
  text: string;
}

/** LCS ベースの行 diff */
export function diffLines(a: string, b: string): LineDiff[] {
  const A = (a ?? "").split(/\r?\n/);
  const B = (b ?? "").split(/\r?\n/);
  const m = A.length;
  const n = B.length;

  // LCS DP テーブル
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (A[i] === B[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: LineDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ kind: "equal", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "remove", text: A[i] });
      i++;
    } else {
      out.push({ kind: "add", text: B[j] });
      j++;
    }
  }
  while (i < m) out.push({ kind: "remove", text: A[i++] });
  while (j < n) out.push({ kind: "add", text: B[j++] });
  return out;
}

// ─────────────────────────────────────────────────────

export type ArticleChangeKind =
  | "unchanged"
  | "added"
  | "removed"
  | "modified"
  | "reordered";

export interface ArticleDiff {
  id: string;
  kind: ArticleChangeKind;
  // legacy 番号 (parent 内 index) / current 番号 (current 内 index)
  parentIndex: number | null;
  currentIndex: number | null;
  parentNode: ArticleNode | null;
  currentNode: ArticleNode | null;
  chapeauDiff?: LineDiff[];
  paragraphs?: ParagraphDiff[];
}

export interface ParagraphDiff {
  id: string;
  kind: ArticleChangeKind;
  parentIndex: number | null;
  currentIndex: number | null;
  parentNode: ParagraphNode | null;
  currentNode: ParagraphNode | null;
  chapeauDiff?: LineDiff[];
  items?: ItemDiff[];
}

export interface ItemDiff {
  id: string;
  kind: ArticleChangeKind;
  parentIndex: number | null;
  currentIndex: number | null;
  parentNode: ItemNode | null;
  currentNode: ItemNode | null;
  textDiff?: LineDiff[];
}

/** id で match、順序と内容の変化を計算 */
export function diffArticles(
  parent: ArticleNode[],
  current: ArticleNode[],
): ArticleDiff[] {
  const parentById = new Map<string, { node: ArticleNode; index: number }>();
  parent.forEach((n, i) => parentById.set(n.id, { node: n, index: i }));
  const currentIds = new Set(current.map((n) => n.id));

  const result: ArticleDiff[] = [];

  current.forEach((cn, ci) => {
    const p = parentById.get(cn.id);
    if (!p) {
      result.push({
        id: cn.id,
        kind: "added",
        parentIndex: null,
        currentIndex: ci,
        parentNode: null,
        currentNode: cn,
      });
      return;
    }
    const chapeauChanged = p.node.chapeau !== cn.chapeau;
    const titleChanged = (p.node.title ?? "") !== (cn.title ?? "");
    const paragraphs = diffParagraphs(p.node.paragraphs, cn.paragraphs);
    const nestedChanged = paragraphs.some((pd) => pd.kind !== "unchanged");
    const contentChanged = chapeauChanged || titleChanged || nestedChanged;
    const reordered = p.index !== ci;

    let kind: ArticleChangeKind = "unchanged";
    if (contentChanged) kind = "modified";
    else if (reordered) kind = "reordered";
    result.push({
      id: cn.id,
      kind,
      parentIndex: p.index,
      currentIndex: ci,
      parentNode: p.node,
      currentNode: cn,
      chapeauDiff: chapeauChanged ? diffLines(p.node.chapeau, cn.chapeau) : undefined,
      paragraphs,
    });
  });

  // parent にのみあるもの = 削除
  parent.forEach((pn, pi) => {
    if (!currentIds.has(pn.id)) {
      result.push({
        id: pn.id,
        kind: "removed",
        parentIndex: pi,
        currentIndex: null,
        parentNode: pn,
        currentNode: null,
      });
    }
  });

  return result;
}

function diffParagraphs(
  parent: ParagraphNode[],
  current: ParagraphNode[],
): ParagraphDiff[] {
  const parentById = new Map<string, { node: ParagraphNode; index: number }>();
  parent.forEach((n, i) => parentById.set(n.id, { node: n, index: i }));
  const currentIds = new Set(current.map((n) => n.id));

  const result: ParagraphDiff[] = [];
  current.forEach((cn, ci) => {
    const p = parentById.get(cn.id);
    if (!p) {
      result.push({
        id: cn.id,
        kind: "added",
        parentIndex: null,
        currentIndex: ci,
        parentNode: null,
        currentNode: cn,
      });
      return;
    }
    const chapeauChanged = p.node.chapeau !== cn.chapeau;
    const items = diffItems(p.node.items, cn.items);
    const nestedChanged = items.some((it) => it.kind !== "unchanged");
    const contentChanged = chapeauChanged || nestedChanged;
    const reordered = p.index !== ci;
    let kind: ArticleChangeKind = "unchanged";
    if (contentChanged) kind = "modified";
    else if (reordered) kind = "reordered";
    result.push({
      id: cn.id,
      kind,
      parentIndex: p.index,
      currentIndex: ci,
      parentNode: p.node,
      currentNode: cn,
      chapeauDiff: chapeauChanged ? diffLines(p.node.chapeau, cn.chapeau) : undefined,
      items,
    });
  });
  parent.forEach((pn, pi) => {
    if (!currentIds.has(pn.id)) {
      result.push({
        id: pn.id,
        kind: "removed",
        parentIndex: pi,
        currentIndex: null,
        parentNode: pn,
        currentNode: null,
      });
    }
  });
  return result;
}

function diffItems(parent: ItemNode[], current: ItemNode[]): ItemDiff[] {
  const parentById = new Map<string, { node: ItemNode; index: number }>();
  parent.forEach((n, i) => parentById.set(n.id, { node: n, index: i }));
  const currentIds = new Set(current.map((n) => n.id));

  const result: ItemDiff[] = [];
  current.forEach((cn, ci) => {
    const p = parentById.get(cn.id);
    if (!p) {
      result.push({
        id: cn.id,
        kind: "added",
        parentIndex: null,
        currentIndex: ci,
        parentNode: null,
        currentNode: cn,
      });
      return;
    }
    const textChanged = p.node.text !== cn.text;
    const markerChanged = p.node.marker !== cn.marker;
    const contentChanged = textChanged || markerChanged;
    const reordered = p.index !== ci;
    let kind: ArticleChangeKind = "unchanged";
    if (contentChanged) kind = "modified";
    else if (reordered) kind = "reordered";
    result.push({
      id: cn.id,
      kind,
      parentIndex: p.index,
      currentIndex: ci,
      parentNode: p.node,
      currentNode: cn,
      textDiff: textChanged ? diffLines(p.node.text, cn.text) : undefined,
    });
  });
  parent.forEach((pn, pi) => {
    if (!currentIds.has(pn.id)) {
      result.push({
        id: pn.id,
        kind: "removed",
        parentIndex: pi,
        currentIndex: null,
        parentNode: pn,
        currentNode: null,
      });
    }
  });
  return result;
}

// ─────────────────────────────────────────────────────

export interface FlatKeyDiff {
  key: string;
  kind: ArticleChangeKind;
  parentValue: string;
  currentValue: string;
  lineDiff?: LineDiff[];
}

export function diffFlatKeys(
  parent: Record<string, unknown>,
  current: Record<string, unknown>,
): FlatKeyDiff[] {
  const IGNORE = new Set(["articles"]);
  const keys = new Set<string>([
    ...Object.keys(parent),
    ...Object.keys(current),
  ]);
  const out: FlatKeyDiff[] = [];
  for (const key of Array.from(keys).sort()) {
    if (IGNORE.has(key)) continue;
    const p = parent[key];
    const c = current[key];
    const pStr = typeof p === "string" ? p : p == null ? "" : JSON.stringify(p);
    const cStr = typeof c === "string" ? c : c == null ? "" : JSON.stringify(c);
    if (pStr === cStr) {
      out.push({ key, kind: "unchanged", parentValue: pStr, currentValue: cStr });
      continue;
    }
    if (!pStr && cStr) {
      out.push({ key, kind: "added", parentValue: "", currentValue: cStr });
      continue;
    }
    if (pStr && !cStr) {
      out.push({ key, kind: "removed", parentValue: pStr, currentValue: "" });
      continue;
    }
    out.push({
      key,
      kind: "modified",
      parentValue: pStr,
      currentValue: cStr,
      lineDiff: diffLines(pStr, cStr),
    });
  }
  return out;
}

export function summarizeDiff(
  articles: ArticleDiff[],
  flats: FlatKeyDiff[],
): { added: number; removed: number; modified: number; reordered: number } {
  let added = 0;
  let removed = 0;
  let modified = 0;
  let reordered = 0;
  for (const a of articles) {
    if (a.kind === "added") added++;
    else if (a.kind === "removed") removed++;
    else if (a.kind === "modified") modified++;
    else if (a.kind === "reordered") reordered++;
    // paragraphs / items も 個別カウント
    for (const p of a.paragraphs ?? []) {
      if (p.kind === "added") added++;
      else if (p.kind === "removed") removed++;
      else if (p.kind === "modified") modified++;
      else if (p.kind === "reordered") reordered++;
      for (const it of p.items ?? []) {
        if (it.kind === "added") added++;
        else if (it.kind === "removed") removed++;
        else if (it.kind === "modified") modified++;
        else if (it.kind === "reordered") reordered++;
      }
    }
  }
  for (const f of flats) {
    if (f.kind === "added") added++;
    else if (f.kind === "removed") removed++;
    else if (f.kind === "modified") modified++;
  }
  return { added, removed, modified, reordered };
}
