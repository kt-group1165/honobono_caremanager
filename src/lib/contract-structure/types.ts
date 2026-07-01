/**
 * 契約書 構造モデル (条 / 項 / 号 / 柱書)
 *
 * 番号 (第X条 / 第Y項 / 第Z号) は JSONB に埋めない = 配列 index から render 時に計算する。
 * こうすることで
 *  - 4条の後に新規追加 → 5条以下が自動リナンバー
 *  - 引用参照は uuid で行い、番号は resolver が現時点の番号に解決する
 * が両立する。
 *
 * 各 node には安定 UUID を必ず持たせる (= 引用参照の永続 identity)。
 */

export interface ItemNode {
  id: string;
  marker: "nakaguro" | "iroha" | "arabic"; // ・ / イロハ… / 1.2.3.
  text: string;
}

export interface ParagraphNode {
  id: string;
  chapeau: string; // 項の柱書 (号が無ければこれが項本文)
  items: ItemNode[];
}

export interface ArticleNode {
  id: string;
  title?: string; // 「契約の目的」等の見出し (省略可)
  chapeau: string; // 条の柱書 (項が無ければこれが条本文)
  paragraphs: ParagraphNode[];
}

export interface ContractDocumentV2 {
  version: 2;
  articles: ArticleNode[];
}

/**
 * content jsonb 内でこの key に格納する。
 * = tree があるか判定するにも使う
 */
export const STRUCTURE_KEY = "articles" as const;
