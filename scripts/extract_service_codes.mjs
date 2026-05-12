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
  console.error("Usage: node extract_service_codes.mjs <pdf-path> [out.csv] [start-page] [end-page] [opts]");
  console.error("  --zaitaku-only          : 在宅系サービスのみ出力 (施設サービス 51-59 を除外、介護保険のみ意味あり)");
  console.error("  --system=介護|障害|総合事業 : 出力 CSV の system 列値 (default: 介護)");
  console.error("  --valid-from=YYYY-MM-DD : 適用開始日 (default: 2024-06-01 = 令和6年6月改定)");
  console.error("  --notes=<text>          : notes 列に書き込む追加文字列 (PDF ページ番号は常に併記)");
  process.exit(1);
}
const pdfPath = args[0];
const positional = args.slice(1).filter((a) => !a.startsWith("--"));
const flagArgs = args.slice(1).filter((a) => a.startsWith("--"));
const flags = new Set(flagArgs.filter((a) => !a.includes("=")));
const kwargs = Object.fromEntries(
  flagArgs
    .filter((a) => a.includes("="))
    .map((a) => {
      const [k, ...rest] = a.replace(/^--/, "").split("=");
      return [k, rest.join("=")];
    }),
);
const outCsv = positional[0] ?? "service_codes.csv";
const startPage = positional[1] ? Number(positional[1]) : 1;
let endPage = positional[2] ? Number(positional[2]) : null;
const zaitakuOnly = flags.has("--zaitaku-only");
const validFrom = kwargs["valid-from"] ?? "2024-06-01"; // 令和6年6月改定 default
const extraNotes = kwargs["notes"] ?? "";
const systemArg = kwargs["system"] ?? "介護";

// validFrom 形式チェック
if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) {
  console.error(`--valid-from は YYYY-MM-DD 形式で指定: "${validFrom}"`);
  process.exit(1);
}
if (!["介護", "障害", "総合事業"].includes(systemArg)) {
  console.error(`--system は '介護' / '障害' / '総合事業' のいずれか: "${systemArg}"`);
  process.exit(1);
}

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
// 単位数 (カンマ区切り対応: "1,086" / "10,830" 等)
const RE_INTEGER = /^\d{1,3}(,\d{3})+$|^\d{1,6}$/;
const parseUnits = (s) => Number(String(s).replace(/,/g, ""));
const RE_HEADING_CATEGORY = /^[０-９0-9]+\s*[一-鿿].*サービスコード表$/; // "１ 訪問介護サービスコード表"

// system 別 category prefix → category name map
// PDF ヘッダー検出失敗時の fallback / 表示用
const CATEGORY_NAME_BY_SYSTEM = {
  // ─ 介護保険 (令和6年度報酬改定) ─
  介護: {
    "11": "訪問介護",
    "12": "訪問入浴介護",
    "13": "訪問看護",
    "14": "訪問リハビリテーション",
    "15": "通所介護",
    "16": "通所リハビリテーション",
    "17": "福祉用具貸与",
    "18": "特定福祉用具販売",
    "21": "短期入所生活介護",
    "22": "短期入所療養介護(老健)",
    "23": "短期入所療養介護(病院療養型)",
    "24": "短期入所療養介護(介護療養院)",
    "27": "短期特定施設入居者生活介護",
    "31": "居宅療養管理指導",
    "32": "定期巡回・随時対応型訪問介護看護",
    "33": "夜間対応型訪問介護",
    "36": "認知症対応型通所介護",
    "37": "小規模多機能型居宅介護",
    "38": "認知症対応型共同生活介護",
    "43": "居宅介護支援",
    "46": "介護予防支援",
    "73": "看護小規模多機能型居宅介護",
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
  },
  // ─ 障害福祉サービス (令和6年度報酬改定) ─
  // 厚労省「介護給付費等単位数サービスコード」PDF より実証された prefix
  障害: {
    "11": "居宅介護",
    "12": "重度訪問介護",
    "13": "行動援護",
    "14": "重度障害者等包括支援",
    "15": "同行援護",
    "21": "療養介護",
    "22": "生活介護",
    "24": "短期入所(福祉型)",
    "32": "施設入所支援",
    "33": "共同生活援助",
    "34": "自立訓練(生活訓練)",
    "35": "自立生活援助",
    "41": "自立訓練(機能訓練)",
    "42": "自立訓練(生活訓練)",
    "43": "就労移行支援",
    "44": "就労移行支援(養成)",
    "45": "就労継続支援A型",
    "46": "就労継続支援B型",
    "47": "就労定着支援",
    "48": "就労選択支援",
    "52": "計画相談支援",
    "53": "地域移行支援",
    "54": "地域定着支援",
    "55": "障害児相談支援",
    // 障害児支援 (part3 PDF — 実 prefix で確認済)
    "61": "児童発達支援",
    "62": "医療型児童発達支援",
    "63": "放課後等デイサービス",
    "64": "保育所等訪問支援",
    "65": "居宅訪問型児童発達支援",
    "71": "福祉型障害児入所施設",
    "72": "医療型障害児入所施設",
  },
  // ─ 総合事業 (各自治体実施) ─
  総合事業: {
    A1: "訪問型サービスⅠ(従前相当)",
    A2: "訪問型サービスⅡ(緩和基準)",
    A5: "通所型サービスⅠ(従前相当)",
    A6: "通所型サービスⅡ(緩和基準)",
  },
};

const CATEGORY_NAME_BY_CODE = CATEGORY_NAME_BY_SYSTEM[systemArg] ?? CATEGORY_NAME_BY_SYSTEM.介護;

// ─── 抽出 ────────────────────────────────────────────────────────────────────
const records = [];
const seen = new Set(); // service_code dedupe (PDF 内に同一コードが何度か出ても 1 行に)
let currentCategoryName = null;
// service_category 別「最後に確定した unit_type」(派生行の unit_type 省略時 fallback 用)
const lastUnitTypeByCat = {};

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
  // 単位列の x 位置: PDF レイアウトで単位数列は右側に並ぶ。
  //   介護保険 PDF: x≈493-510
  //   障害福祉 PDF: x≈455
  // 本文中の数値 (例「567 単位 ＋」at x≈220) を誤拾いしないために閾値設定。
  // 440 にすることで両方の単位列をカバーし、本文の中央寄り数値は除外。
  const UNIT_COLUMN_MIN_X = 440;
  for (const [, lineItems] of sortedRows) {
    lineItems.sort((a, b) => a.x - b.x);
    // x 情報を保持したまま処理
    const positioned = lineItems
      .map((it) => ({ str: it.str.trim(), x: it.x }))
      .filter((it) => it.str);
    if (positioned.length < 4) continue;
    const trimmed = positioned.map((it) => it.str);

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

    // 単位数:
    //   1) 「単位列 (x >= UNIT_COLUMN_MIN_X) の中で末尾の integer」を最優先
    //   2) 見つからなければ 0 (本文中の数値を誤拾いしない)
    let units = 0;
    for (let i = positioned.length - 1; i >= 3; i--) {
      const v = positioned[i];
      if (v.x < UNIT_COLUMN_MIN_X) continue; // 本文中の数値は無視
      if (RE_INTEGER.test(v.str)) {
        const n = parseUnits(v.str);
        if (n >= 1 && n <= 100000) {
          units = n;
          break;
        }
      }
    }

    // unit_type: 末尾項目に "1回につき" / "1日につき" / "1月につき" のいずれかがあれば採用。
    // PDF は最初の行にだけ単位を書いて以後省略するパターンが多いので、
    // 同じ service_category の「直前の確定 unit_type」を fallback として継承する。
    let unitType = null;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      const v = trimmed[i];
      if (v.includes("1回につき")) { unitType = "1回につき"; break; }
      if (v.includes("1日につき")) { unitType = "1日につき"; break; }
      if (v.includes("1月につき")) { unitType = "1月につき"; break; }
    }
    if (!unitType) {
      unitType = lastUnitTypeByCat[cat] ?? "1回につき";
    } else {
      lastUnitTypeByCat[cat] = unitType;
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

    // ─── formula 自動検出 ─────────────────────────────────────────────────
    // 「所定単位×N/1000」「所定単位数の N/1000」等の表記を検出して
    // monthly_aggregate type の formula JSON を生成。
    // 処遇改善加算 / サービス提供体制強化加算 / 特定処遇改善加算 等を網羅。
    let formula = null;
    // パターン1: "所定単位 × 245/1000" or "所定単位数の 100/1000"
    const aggMatch =
      inline.match(/所定単位[数]?[\s×x の]+(\d{1,4})\s*\/\s*(\d{2,5})/) ||
      inline.match(/(\d{1,4})\s*\/\s*(\d{2,5})\s*加算/);
    if (aggMatch) {
      const num = parseInt(aggMatch[1], 10);
      const den = parseInt(aggMatch[2], 10);
      // 妥当性チェック: 1〜999 / 1000 (or 100) など
      if (num >= 1 && num < den && den <= 10000) {
        formula = {
          type: "monthly_aggregate",
          service_category: cat,
          numerator: num,
          denominator: den,
          label: `所定単位×${num}/${den}`,
          rounding: "round",
        };
      }
    }

    records.push({
      system: systemArg,
      service_category: cat,
      service_category_name: categoryName,
      service_code: fullCode,
      service_name: nameRaw,
      units,
      unit_type: unitType,
      calculation_type: calcType,
      valid_from: validFrom,
      valid_until: "",
      notes: extraNotes ? `${extraNotes} / PDF p.${pageNum}` : `PDF p.${pageNum}`,
      formula: formula ? JSON.stringify(formula) : "",
    });
    seen.add(fullCode);
  }

  if (pageNum % 20 === 0 || pageNum === endPage) {
    console.error(`  page ${pageNum}/${endPage} (records so far: ${records.length})`);
  }
}

// ─── CSV 出力 ────────────────────────────────────────────────────────────────
const headers = [
  "system",
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
  "formula",
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
