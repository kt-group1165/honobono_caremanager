// PDF.js (Mozilla) でテキスト抽出。
// Adobe-Japan1 CMap を bundle してるので、CJK fonts が CID-keyed でも正しく decode できる。
//
// 使い方: node extract_pdf_text.mjs <pdf-path> [start-page] [end-page]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Legacy build (no Worker dependency, runs in plain Node)
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node extract_pdf_text.mjs <pdf-path> [start-page] [end-page]");
  process.exit(1);
}
const pdfPath = args[0];
const startPage = args[1] ? Number(args[1]) : 1;
const endPage = args[2] ? Number(args[2]) : null;

const data = new Uint8Array(readFileSync(pdfPath));
// pdfjs-dist は CMap データを node_modules/pdfjs-dist/cmaps/ に持ってる
const cmapDir = resolve(__dirname, "node_modules/pdfjs-dist/cmaps/");
const standardFontDir = resolve(__dirname, "node_modules/pdfjs-dist/standard_fonts/");

const doc = await pdfjs.getDocument({
  data,
  cMapUrl: cmapDir + "/",
  cMapPacked: true,
  standardFontDataUrl: standardFontDir + "/",
  // verbosity を WARNINGS に下げて出力ノイズを減らす
  verbosity: 0,
}).promise;

const last = endPage ?? doc.numPages;
console.log(JSON.stringify({ event: "meta", pages: doc.numPages, extracting: { from: startPage, to: last } }));

for (let i = startPage; i <= last; i++) {
  const page = await doc.getPage(i);
  const tc = await page.getTextContent();
  // テキストとその座標を出力 (table 抽出のために x/y が要る)
  const items = tc.items.map((it) => ({
    str: it.str,
    x: Math.round(it.transform[4]),
    y: Math.round(it.transform[5]),
    w: Math.round(it.width),
    h: Math.round(it.height),
  }));
  console.log(JSON.stringify({ event: "page", page: i, items }));
}
