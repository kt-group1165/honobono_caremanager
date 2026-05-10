// 介護保険サービスコード表 PDF からサービスコードマスタ CSV を生成。
//
// 入力: 厚労省刊行の「介護保険サービスコード表」PDF (CID-keyed Japanese fonts)
// 出力: kaigo_service_codes.csv (CSV import UI でそのまま読込可能)
//
// 列: service_category, service_category_name, service_code, service_name,
//     units, unit_type, calculation_type, valid_from, valid_until, notes
//
// 仕組み:
//   1. PDF.js (legacy build) で各ページのテキストを座標付きで取得
//      (CMap を内蔵してるので CID-keyed CJK が正しく decode される)
//   2. テキスト item を y 座標でグループ化して論理行に
//   3. 各行を「{2桁}{4桁英数} + 名前 + 数値」のパターンで service-code 行と判定
//   4. 直前のヘッダー行 ("１ 訪問介護サービスコード表" 等) からサービス種類名を継承
//   5. 加算/減算 と単位列の値から calculation_type を推定
//
// 使い方:
//   node extract_service_codes.mjs <pdf-path> [out.csv] [start-page] [end-page]
//
// 例:
//   node extract_service_codes.mjs "../docs/介護ソフト関連/介護保険サービスコード表.pdf" service_codes.csv 1 318
//   (1-318 ページ = 在宅サービス + 居宅介護支援関連)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node extract_service_codes.mjs <pdf-path> [out.csv] [start-page] [end-page] [--zaitaku-only]");
  console.error("  --zaitaku-only : 在宅系サービスのみ出力 (施設サービス 51-59 を除外)");
  process.exit(1);
}
const pdfPath = args[0];
const positional = args.slice(1).filter((a) => !a.startsWith("--"));
const flags = new Set(args.slice(1).filter((a) => a.startsWith("--")));
const outCsv = positional[0] ?? "service_codes.csv";
const startPage = positional[1] ? Number(positional[1]) : 1;
let endPage = positional[2] ? Number(positional[2]) : null;
const zaitakuOnly = flags.has("--zaitaku-only");

// 在宅系 (居宅サービス + 居宅介護支援 + 介護予防 + 地域密着)
const ZAITAKU_PREFIXES = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18",
  "21", "22", "23", "24", "27",
  "31", "32", "33", "36", "37", "38",
  "43", "46", "61", "63", "64", "65", "66", "67", "68", "71", "72", "73", "78", "79",
]);

const cmapDir = resolve(__dirname, "node_modules/pdfjs-dist/cmaps/");
const standardFontDir = resolve(__dirname, "node_modules/pdfjs-dist/standard_fonts/");

const data = new Uint8Array(readFileSync(pdfPath));
const doc = await pdfjs.getDocument({
  data,
  cMapUrl: cmapDir + "/",
  cMapPacked: true,
  standardFontDataUrl: standardFontDir + "/",
  verbosity: 0,
}).promise;

if (!endPage) endPage = doc.numPages;
console.error(`PDF: ${doc.numPages} pages, extracting ${startPage}-${endPage}`);

// ─── pattern を判定するための regex ───────────────────────────────────────────
const RE_CATEGORY_PREFIX = /^\d{2}$/; // "11", "13", ...
const RE_CODE_SUFFIX = /^[0-9A-HJ-NPR-Z]{4}$/; // "4845", "B401", "A001" (I/O/Q 除く)
const RE_INTEGER = /^\d{1,5}$/; // 単位数
const RE_HEADING_CATEGORY = /^[０-９0-9]+\s*[一-鿿].*サービスコード表$/; // "１ 訪問介護サービスコード表"

// 在宅系で扱う category prefix → category name (ヘッダー検出失敗時の fallback)
// PDF 抽出で実証された prefix を含む。介護給付サービス種類コード一覧 (令和6年度) 準拠。
const CATEGORY_NAME_BY_CODE = {
  // 訪問系
  "11": "訪問介護",
  "12": "訪問入浴介護",
  "13": "訪問看護",
  "14": "訪問リハビリテーション",
  // 通所系
  "15": "通所介護",
  "16": "通所リハビリテーション",
  // 福祉用具
  "17": "福祉用具貸与",
  "18": "特定福祉用具販売",
  // 短期入所系
  "21": "短期入所生活介護",
  "22": "短期入所療養介護(老健)",
  "23": "短期入所療養介護(病院療養型)",
  "24": "短期入所療養介護(介護療養院)",
  "27": "短期特定施設入居者生活介護",
  // 居宅療養管理指導
  "31": "居宅療養管理指導",
  // 地域密着型サービス
  "32": "定期巡回・随時対応型訪問介護看護",
  "33": "夜間対応型訪問介護",
  "36": "認知症対応型通所介護",
  "37": "小規模多機能型居宅介護",
  "38": "認知症対応型共同生活介護",
  // 居宅支援
  "43": "居宅介護支援",
  "46": "介護予防支援",
  "73": "看護小規模多機能型居宅介護",
  // 介護予防系 (61〜68)
  "61": "介護予防訪問入浴介護",
  "63": "介護予防訪問看護",
  "64": "介護予防訪問リハビリテーション",
  "65": "介護予防通所リハビリテーション",
  "66": "介護予防短期入所生活介護",
  "67": "介護予防短期入所療養介護(老健)",
  "68": "介護予防短期入所療養介護(病院療養型)",
  "71": "介護予防認知症対応型通所介護",
  "72": "介護予防小規模多機能型居宅介護",
  "78": "介護予防福祉用具貸与",
  "79": "介護予防特定福祉用具販売",
};

// ─── 抽出 ────────────────────────────────────────────────────────────────────
const records = [];
const seen = new Set(); // service_code dedupe (PDF 内に同一コードが何度か出ても 1 行に)
let currentCategoryName = null;

for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  // y 座標で降順 (PDF は左下原点、人間目線では上から)
  const items = tc.items.map((it) => ({
    str: it.str,
    x: it.transform[4],
    y: it.transform[5],
    w: it.width,
    h: it.height,
  }));

  // ─── ヘッダー検出: "１ 訪問介護サービスコード表" 形式の文字列を探す
  for (const it of items) {
    if (RE_HEADING_CATEGORY.test(it.str.trim())) {
      const m = it.str.match(/[一-鿿][一-鿿・ー]+/g);
      if (m && m.length > 0) {
        // "訪問介護サービスコード表" → "訪問介護"
        let cat = m.join("");
        cat = cat.replace(/サービスコード表$/, "");
        currentCategoryName = cat || currentCategoryName;
      }
    }
  }

  // ─── 行 (y) でグループ化、tolerance ±2px
  const rows = new Map();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    // 既存の行 key と近ければそれに追加、無ければ新規 key
    let bucketKey = null;
    for (const k of rows.keys()) {
      if (Math.abs(k - it.y) <= 2) {
        bucketKey = k;
        break;
      }
    }
    if (bucketKey == null) bucketKey = it.y;
    if (!rows.has(bucketKey)) rows.set(bucketKey, []);
    rows.get(bucketKey).push(it);
  }

  // ─── 行ごとに service-code 候補を組み立て
  // 同 y にある items を x 順にソート → [cat, code, name, ..., units, unit_type] のパターンを抽出
  const sortedRows = [...rows.entries()].sort((a, b) => b[0] - a[0]); // y 降順 = 上から下
  for (const [, lineItems] of sortedRows) {
    lineItems.sort((a, b) => a.x - b.x);
    const trimmed = lineItems.map((it) => it.str.trim()).filter(Boolean);
    if (trimmed.length < 4) continue;

    // pattern: 最初の 2 個が "{2桁}{4桁英数}" なら service-code 行
    const cat = trimmed[0];
    const codeSuffix = trimmed[1];
    if (!RE_CATEGORY_PREFIX.test(cat)) continue;
    if (!RE_CODE_SUFFIX.test(codeSuffix)) continue;

    const fullCode = cat + codeSuffix;
    if (seen.has(fullCode)) continue;

    // 名前 = trimmed[2] (最初の Japanese 文字列)
    const nameRaw = trimmed[2];
    if (!nameRaw || /^\d/.test(nameRaw)) continue; // 数字始まりは名前ではない

    // 単位数: 末尾に近い integer を探す。最後から逆順に走査して最初に当たった integer を採用。
    // ただし末尾は "1回につき" のような日本語が多いので、その手前の integer を探す。
    let units = 0;
    for (let i = trimmed.length - 1; i >= 3; i--) {
      const v = trimmed[i];
      if (RE_INTEGER.test(v)) {
        const n = Number(v);
        // 1〜30000 の範囲内を単位数候補とする (年や%は除外: 200% など)
        if (n >= 1 && n <= 30000) {
          units = n;
          break;
        }
      }
    }

    // unit_type: 末尾項目に "1回につき" / "1日につき" / "1月につき" のいずれかがあれば採用
    let unitType = "1回につき";
    for (let i = trimmed.length - 1; i >= 0; i--) {
      const v = trimmed[i];
      if (v.includes("1回につき") || v === "1回につき") {
        unitType = "1回につき";
        break;
      }
      if (v.includes("1日につき") || v === "1日につき") {
        unitType = "1日につき";
        break;
      }
      if (v.includes("1月につき") || v === "1月につき") {
        unitType = "1月につき";
        break;
      }
    }

    // calculation_type: 行内に "加算" / "減算" のリテラルがあるか
    let calcType = "基本";
    const inline = trimmed.join(" ");
    if (inline.includes("減算")) calcType = "減算";
    else if (inline.includes("加算")) calcType = "加算";

    // service_category_name: 既知の prefix → name map を優先 (ヘッダー検出は不安定なため fallback)
    const categoryName = CATEGORY_NAME_BY_CODE[cat] ?? currentCategoryName ?? "";

    if (zaitakuOnly && !ZAITAKU_PREFIXES.has(cat)) {
      seen.add(fullCode); // dedupe 用
      continue;
    }

    records.push({
      service_category: cat,
      service_category_name: categoryName,
      service_code: fullCode,
      service_name: nameRaw,
      units,
      unit_type: unitType,
      calculation_type: calcType,
      valid_from: "",
      valid_until: "",
      notes: `PDF p.${pageNum}`,
    });
    seen.add(fullCode);
  }

  if (pageNum % 20 === 0 || pageNum === endPage) {
    console.error(`  page ${pageNum}/${endPage} (records so far: ${records.length})`);
  }
}

// ─── CSV 出力 ────────────────────────────────────────────────────────────────
const headers = [
  "service_category",
  "service_category_name",
  "service_code",
  "service_name",
  "units",
  "unit_type",
  "calculation_type",
  "valid_from",
  "valid_until",
  "notes",
];
const escape = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
};
const lines = [headers.join(",")];
for (const r of records) {
  lines.push(headers.map((h) => escape(r[h])).join(","));
}
const bom = "﻿";
writeFileSync(outCsv, bom + lines.join("\r\n") + "\r\n", "utf-8");

console.error(`✓ ${records.length} 件を ${outCsv} に書き出しました`);

// 小さなサマリ
const byCat = {};
for (const r of records) {
  byCat[r.service_category] = (byCat[r.service_category] ?? 0) + 1;
}
console.error("カテゴリ別件数:");
for (const [k, v] of Object.entries(byCat).sort()) {
  console.error(`  ${k} (${CATEGORY_NAME_BY_CODE[k] ?? "?"}): ${v}`);
}
