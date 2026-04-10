/**
 * 国保連伝送用ファイル（固定長テキスト・Shift-JIS）のエンコーディング
 *
 * 国保連のインターフェース仕様:
 * - 文字コード: Shift-JIS (MS932)
 * - 改行コード: CR+LF
 * - 英数: 左詰め、後ろは半角スペース埋め
 * - 数字: 右詰め、前は0埋め
 * - 全角: 全角スペース埋め (Shift-JIS 2バイト/文字)
 * - 符号付き数字: 先頭に "+"/"-" + 数字（右詰め0埋め）
 */

import Encoding from "encoding-japanese";

// ─── Shift-JIS バイト長計算 ──────────────────────────────────────────────────
// Shift-JIS では ASCII/半角カナは 1バイト、全角文字は 2バイト

/**
 * 文字列を Shift-JIS でエンコードしたときのバイト数を返す
 */
export function sjisByteLength(text: string): number {
  if (!text) return 0;
  const unicodeArr = Encoding.stringToCode(text);
  const sjisArr = Encoding.convert(unicodeArr, { to: "SJIS", from: "UNICODE" });
  return sjisArr.length;
}

/**
 * 文字列を Shift-JIS バイト列に変換
 */
export function toSjisBytes(text: string): Uint8Array {
  if (!text) return new Uint8Array(0);
  const unicodeArr = Encoding.stringToCode(text);
  const sjisArr = Encoding.convert(unicodeArr, { to: "SJIS", from: "UNICODE" });
  return new Uint8Array(sjisArr);
}

// ─── パディング関数 ───────────────────────────────────────────────────────────

/**
 * 英数字項目: 左詰め、後ろ半角スペース埋め
 * @param value 値
 * @param byteLength 固定バイト長
 */
export function padAN(value: string | null | undefined, byteLength: number): string {
  const s = (value ?? "").toString();
  const currentBytes = sjisByteLength(s);
  if (currentBytes > byteLength) {
    // バイト長超過 → 末尾切り詰め
    return truncateToSjisBytes(s, byteLength);
  }
  return s + " ".repeat(byteLength - currentBytes);
}

/**
 * 数字項目: 右詰め、前0埋め
 * @param value 値（数値または文字列）
 * @param byteLength 固定バイト長
 */
export function padN(value: string | number | null | undefined, byteLength: number): string {
  if (value === null || value === undefined || value === "") {
    return "0".repeat(byteLength);
  }
  // 数字のみを抽出（カンマ等を除去）
  const s = String(value).replace(/[^0-9]/g, "");
  if (s.length > byteLength) {
    // 桁数超過 → 下位桁を残す（仕様書上はエラーだが安全策）
    return s.slice(-byteLength);
  }
  return s.padStart(byteLength, "0");
}

/**
 * 符号付き数字項目: 先頭に符号(+/-) + 数字（右詰め0埋め）
 * 仕様書では「符号+10桁数字」のような合計桁数で定義されていることが多い
 * @param value 値
 * @param byteLength 符号を含む総バイト長
 */
export function padSignedN(value: number | string | null | undefined, byteLength: number): string {
  if (value === null || value === undefined || value === "") {
    return "+" + "0".repeat(byteLength - 1);
  }
  const num = typeof value === "string" ? parseInt(value, 10) : value;
  if (isNaN(num)) return "+" + "0".repeat(byteLength - 1);
  const sign = num >= 0 ? "+" : "-";
  const absStr = Math.abs(num).toString();
  if (absStr.length > byteLength - 1) {
    return sign + absStr.slice(-(byteLength - 1));
  }
  return sign + absStr.padStart(byteLength - 1, "0");
}

/**
 * 全角/半角混在項目: Shift-JIS バイト長で右側を全角スペース埋め
 * @param value 値
 * @param byteLength 固定バイト長
 */
export function padZen(value: string | null | undefined, byteLength: number): string {
  const s = (value ?? "").toString();
  const currentBytes = sjisByteLength(s);
  if (currentBytes > byteLength) {
    return truncateToSjisBytes(s, byteLength);
  }
  const remainingBytes = byteLength - currentBytes;
  // 全角スペース(U+3000)は Shift-JIS で2バイト
  const fullWidthSpace = "\u3000";
  const fullWidthCount = Math.floor(remainingBytes / 2);
  const halfWidthCount = remainingBytes % 2;
  return s + fullWidthSpace.repeat(fullWidthCount) + " ".repeat(halfWidthCount);
}

/**
 * 文字列を Shift-JIS バイト長で切り詰め
 */
function truncateToSjisBytes(text: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const ch of text) {
    const chBytes = sjisByteLength(ch);
    if (bytes + chBytes > maxBytes) break;
    result += ch;
    bytes += chBytes;
  }
  // 残りを半角スペースで埋める
  return result + " ".repeat(maxBytes - bytes);
}

// ─── ファイル生成 ─────────────────────────────────────────────────────────────

/**
 * 複数のレコード文字列を CR+LF で結合し、Shift-JIS バイト列として Blob を生成
 * @param records レコード文字列の配列
 * @param addTrailingNewline 最終レコードの後ろにもCR+LFを付けるか（デフォルト: true）
 */
export function buildSjisBlob(records: string[], addTrailingNewline = true): Blob {
  const text = records.join("\r\n") + (addTrailingNewline ? "\r\n" : "");
  const sjisBytes = toSjisBytes(text);
  // Copy into a fresh ArrayBuffer to satisfy BlobPart typing
  const buffer = new ArrayBuffer(sjisBytes.length);
  new Uint8Array(buffer).set(sjisBytes);
  return new Blob([buffer], { type: "text/plain" });
}

/**
 * Blob をダウンロード
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
