// ============================================================================
// PDF から座標つきの語 (words) を取り出す共通ヘルパー。
//
// import_riyouhyou_service_usage.mjs の extractPages() を切り出したもの
// (2026-09-14, H指示)。中身は逐語コピーではなく移動のみ・挙動は変えていない。
//
// ⚠ 語の座標は **回転を適用してから** 返す。CubePDF の「ページの向き = 自動」で
//   出すと /Rotate 90 の縦用紙になり (mediabox 595x842)、get_text("words") が
//   回転前の座標を返す。そのままだとラベル近傍で座標を探す処理が全滅する
//   (2026-09-01 実測: 保険者番号・被保険者番号が全員 null → 引き当て 0 名)。
//   rotation 0 の PDF では rotation_matrix は単位行列なので既存の取込に影響しない。
// ============================================================================
import { execFileSync } from "node:child_process";

/**
 * PDF 1 ファイルの全ページのテキストと座標つき語を取り出す。
 * @param {string} pdfPath
 * @returns {{texts: string[], words: {x:number,y:number,t:string}[][]}}
 */
export function extractPages(pdfPath) {
  const py = [
    "import fitz, json, sys",
    "d = fitz.open(sys.argv[1])",
    "texts, words = [], []",
    "for i in range(d.page_count):",
    "    p = d[i]",
    "    texts.append(p.get_text())",
    "    m = p.rotation_matrix",
    '    words.append([{"x": (fitz.Point(w[0], w[1]) * m).x, "y": (fitz.Point(w[0], w[1]) * m).y, "t": w[4]} for w in p.get_text("words")])',
    'print(json.dumps({"texts": texts, "words": words}, ensure_ascii=False))',
  ].join("\n");
  // ⚠ Windows の python は既定 cp932 出力。UTF-8 を明示しないと氏名が壊れる
  const raw = execFileSync("python", ["-c", py, pdfPath], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw);
}
