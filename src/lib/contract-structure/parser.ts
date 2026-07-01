/**
 * 契約書 flat text → ArticleNode tree parser
 *
 * 入力: 「① 〜」「② 〜」「・ 〜」等 markers 付きの本文文字列
 * 出力: ArticleNode
 *
 * 移行: 既存 v1 の content.article_01..article_22 を 1 つずつ parse し
 *      ArticleNode[] を組み立てる。
 */

import type {
  ArticleNode,
  ItemNode,
  ParagraphNode,
} from "./types";

// ID 生成 — crypto.randomUUID が Node18+ で利用可能
function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // fallback
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// paragraph marker: ①〜⑳ or （１）等
const PARAGRAPH_MARKER_RE = /^([①-⑳㉑-㉚])\s*(.*)$/;
// item marker: ・ or ／中黒/ゼロ幅系
const NAKAGURO_ITEM_RE = /^[・･]\s*(.*)$/;
// item marker: イロハ (単独文字 + 空白 + テキスト)
const IROHA_ITEM_RE = /^([イロハニホヘトチリヌルヲワカヨタレソツネナラム])\s+(.*)$/;
// item marker: 1. 2. 3.
const ARABIC_ITEM_RE = /^(\d+)[.\.]\s*(.*)$/;

export interface ParseArticleOptions {
  title?: string;
}

export function parseArticleText(
  raw: string,
  opts: ParseArticleOptions = {},
): ArticleNode {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/　/g, " ").trimEnd()); // 全角空白 → 半角

  const chapeauLines: string[] = [];
  const paragraphs: ParagraphNode[] = [];
  let curPara: ParagraphNode | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimStart();
    if (!line.trim()) {
      // 空行 → 継続 (前の container に \n を落とすだけ)
      appendContinuation(chapeauLines, curPara, "");
      continue;
    }

    // paragraph marker check
    const pm = PARAGRAPH_MARKER_RE.exec(line);
    if (pm) {
      curPara = {
        id: newId(),
        chapeau: pm[2].trim(),
        items: [],
      };
      paragraphs.push(curPara);
      continue;
    }

    // item marker check (号)
    if (curPara) {
      const naka = NAKAGURO_ITEM_RE.exec(line);
      if (naka) {
        const item: ItemNode = {
          id: newId(),
          marker: "nakaguro",
          text: naka[1].trim(),
        };
        curPara.items.push(item);
        continue;
      }
      const iroha = IROHA_ITEM_RE.exec(line);
      if (iroha) {
        const item: ItemNode = {
          id: newId(),
          marker: "iroha",
          text: iroha[2].trim(),
        };
        curPara.items.push(item);
        continue;
      }
      const arabic = ARABIC_ITEM_RE.exec(line);
      if (arabic) {
        const item: ItemNode = {
          id: newId(),
          marker: "arabic",
          text: arabic[2].trim(),
        };
        curPara.items.push(item);
        continue;
      }
    }

    // marker 無し = 継続
    appendContinuation(chapeauLines, curPara, line);
  }

  return {
    id: newId(),
    title: opts.title,
    chapeau: chapeauLines.join("\n").trim(),
    paragraphs,
  };
}

/** marker 無し行は「開いてる container」の末尾に \n で追記する */
function appendContinuation(
  chapeauLines: string[],
  curPara: ParagraphNode | null,
  line: string,
): void {
  if (!curPara) {
    chapeauLines.push(line);
    return;
  }
  // paragraph の item 無し → chapeau に追記
  if (curPara.items.length === 0) {
    curPara.chapeau = curPara.chapeau + (curPara.chapeau ? "\n" : "") + line;
    return;
  }
  // item に追記
  const last = curPara.items[curPara.items.length - 1];
  last.text = last.text + (last.text ? "\n" : "") + line;
}

/**
 * flat article_01..article_22 の集合を ArticleNode[] に変換
 */
export function migrateFlatArticles(
  content: Record<string, unknown>,
  articleLabels: Record<string, string> = {},
): ArticleNode[] {
  const articles: ArticleNode[] = [];
  for (let i = 1; i <= 22; i++) {
    const key = `article_${String(i).padStart(2, "0")}`;
    const raw = content[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    articles.push(
      parseArticleText(raw, { title: articleLabels[key] ?? undefined }),
    );
  }
  return articles;
}
