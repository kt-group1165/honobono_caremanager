// 千葉市 総合事業 サービスコード import
//   input:  C:/Users/domen-PC/Downloads/202606serviscode.xls
//   target: kaigo_service_codes (system='総合事業', valid_from='2026-06-01')
//
// Excel は 2 シート:
//   Sheet1 「ｺｰﾄﾞ表」 (令和8.6.1〜)  = A2/A3/A6/A7 4 カテゴリ 882 行 (うち units 有効 861)
//     - A2: 訪問介護相当サービス (千葉市)
//     - A3: 生活援助型訪問サービス (千葉市)
//     - A6: 通所介護相当サービス (千葉市)
//     - A7: ミニデイ型通所サービス (千葉市)
//   Sheet2 「Sheet1」 = 旧版 A3 生活援助型 15 行 (単位数が Sheet1 と異なる = R6以前)
//     → Sheet1 の A3 が現行版なので Sheet2 は skip
//
// 列位置 (Sheet1):
//   col 0  : サービスコード 種類 (例 'A2')
//   col 1  : サービスコード 項目 (例 '1111')
//   col 2  : サービス内容略称
//   col 3  : 算定項目
//   col 32 : 減算値
//   col 43 : 合成単位数
//   col 44 : 単位数 (最終値、単価)   ← ここが本命 (仕様書の col 43 とは 1 個ズレ)
//   col 45 : 単位 (例 '1月につき')
//
// UNIQUE 制約: (system, service_code, valid_from)
//   既存衝突は skip
//
// 実行:
//   node --env-file=.env.local migrations/import_chiba_sougou_service_codes.mjs
//   node --env-file=.env.local migrations/import_chiba_sougou_service_codes.mjs --execute
//
// 依存: Python (pandas + xlrd) — xls → JSON 変換に使う

import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("env missing"); process.exit(1); }
const EXECUTE = process.argv.includes("--execute");
const sb = createClient(SB_URL, SB_KEY);

const XLS_PATH = "C:/Users/domen-PC/Downloads/202606serviscode.xls";
const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_TMP = resolve(__dirname, "_chiba_sougou_extracted.json");

const VALID_FROM = "2026-06-01"; // 令和8年6月1日
const SYSTEM = "総合事業";

const CAT_NAME = {
  A2: "訪問介護相当サービス (千葉市)",
  A3: "生活援助型訪問サービス (千葉市)",
  A6: "通所介護相当サービス (千葉市)",
  A7: "ミニデイ型通所サービス (千葉市)",
};

// ─────────────────────────────────────────────────────────
// Python で xls → JSON 抽出
// ─────────────────────────────────────────────────────────
function extractXlsToJson() {
  if (!existsSync(XLS_PATH)) {
    console.error(`xls 不在: ${XLS_PATH}`);
    process.exit(1);
  }
  const pyCode = `
import json, re, sys
import pandas as pd
xl = pd.ExcelFile(r"${XLS_PATH}", engine="xlrd")
df1 = pd.read_excel(xl, sheet_name="ｺｰﾄﾞ表", header=None, dtype=str)
df2 = pd.read_excel(xl, sheet_name="Sheet1", header=None, dtype=str)

def parse_units(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or v == "":
        return None
    try:
        return int(float(str(v).replace(",", "").replace("△", "-")))
    except:
        return None

sheet1_rows = []
for r in range(df1.shape[0]):
    c0 = df1.iloc[r, 0]
    c1 = df1.iloc[r, 1]
    if not (isinstance(c0, str) and re.fullmatch(r"A\\d", c0)):
        continue
    if not (isinstance(c1, str) and re.fullmatch(r"\\d{4}", c1)):
        continue
    c2 = df1.iloc[r, 2]
    c3 = df1.iloc[r, 3]
    c44 = df1.iloc[r, 44] if df1.shape[1] > 44 else None
    c45 = df1.iloc[r, 45] if df1.shape[1] > 45 else None
    sheet1_rows.append({
        "cat": c0,
        "code_num": c1,
        "name": str(c2) if pd.notna(c2) else "",
        "sanshi_koumoku": str(c3) if pd.notna(c3) else "",
        "units": parse_units(c44),
        "unit_type": str(c45) if pd.notna(c45) else "",
    })

sheet2_rows = []
for r in range(df2.shape[0]):
    c0 = df2.iloc[r, 0]
    c1 = df2.iloc[r, 1]
    if not (isinstance(c0, str) and re.fullmatch(r"A\\d", c0)):
        continue
    if not (isinstance(c1, str) and re.fullmatch(r"\\d{4}", c1)):
        continue
    c2 = df2.iloc[r, 2]
    c3 = df2.iloc[r, 3]
    c40 = df2.iloc[r, 40] if df2.shape[1] > 40 else None
    c41 = df2.iloc[r, 41] if df2.shape[1] > 41 else None
    sheet2_rows.append({
        "cat": c0,
        "code_num": c1,
        "name": str(c2) if pd.notna(c2) else "",
        "sanshi_koumoku": str(c3) if pd.notna(c3) else "",
        "units": parse_units(c40),
        "unit_type": str(c41) if pd.notna(c41) else "",
    })

with open(r"${JSON_TMP}", "w", encoding="utf-8") as f:
    json.dump({"sheet1": sheet1_rows, "sheet2": sheet2_rows}, f, ensure_ascii=False)
print(f"sheet1={len(sheet1_rows)} sheet2={len(sheet2_rows)}")
`;
  const r = spawnSync("python", ["-c", pyCode], { encoding: "utf-8" });
  if (r.status !== 0) {
    console.error("Python extract 失敗:", r.stderr);
    process.exit(1);
  }
  console.log(`  Python 抽出結果: ${r.stdout.trim()}`);
  const raw = readFileSync(JSON_TMP, "utf-8");
  return JSON.parse(raw);
}

// ─────────────────────────────────────────────────────────
// 行 → kaigo_service_codes 用 dict
// ─────────────────────────────────────────────────────────
function toRow({ cat, code_num, name, sanshi_koumoku, units, unit_type }) {
  const service_code = `${cat}${code_num}`;
  const service_category_name = CAT_NAME[cat] ?? `${cat} (千葉市)`;
  // calculation_type 判定
  let calculation_type = "基本";
  if (typeof units === "number" && units < 0) calculation_type = "減算";
  else if (typeof name === "string" && name.includes("加算")) calculation_type = "加算";
  else if (typeof name === "string" && name.includes("減算")) calculation_type = "減算";
  return {
    system: SYSTEM,
    service_category: cat,           // 'A2' / 'A3' / 'A6' / 'A7'
    service_category_name,
    service_code,
    service_name: name,
    units,
    unit_type: unit_type || "1回につき",
    calculation_type,
    valid_from: VALID_FROM,
    valid_until: null,
    notes: sanshi_koumoku
      ? `千葉市 総合事業 / ${sanshi_koumoku}`
      : `千葉市 総合事業`,
  };
}

// ─────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📥 千葉市 総合事業 サービスコード import`);
  console.log(`   source: ${XLS_PATH}`);
  console.log(`   target: kaigo_service_codes (system='${SYSTEM}', valid_from='${VALID_FROM}')`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (INSERT)" : "🔍 DRY RUN");

  // 1. 抽出
  const { sheet1, sheet2 } = extractXlsToJson();
  console.log(`\n[抽出] Sheet1 ${sheet1.length} 行, Sheet2 ${sheet2.length} 行`);

  // 2. Sheet1 のみを使う (Sheet2 は 旧版 = skip)
  //    Sheet2 (旧版 R6 前) の 3 unique 初回加算 code (A31009/1019/1029) は
  //    Sheet1 の現行 (R8.6.1) に含まれないが、旧単価 (200単位/月) のまま流用は
  //    危険なので現行版のみ import する。将来 Sheet2 を投入する場合は
  //    service_category を 'A3-legacy' 等に分けて 別 valid_from で入れる。
  const useSheet2 = false;
  console.log(`  Sheet2: ${useSheet2 ? "使用" : "skip (旧版のため)"}`);

  const src = useSheet2 ? [...sheet1, ...sheet2] : sheet1;

  // 3. units が None の行 (同一建物減算等 = ratio ベースで数値なし) を除外
  const withUnits = src.filter((r) => typeof r.units === "number");
  const withoutUnits = src.length - withUnits.length;
  console.log(`\n[filter] units 数値有効: ${withUnits.length} / null (skip): ${withoutUnits}`);

  // 4. dedup by service_code (念のため — 実際は Sheet1 内 dup ゼロ確認済)
  const byCode = new Map();
  for (const r of withUnits) {
    const code = `${r.cat}${r.code_num}`;
    if (!byCode.has(code)) byCode.set(code, r);
  }
  console.log(`  unique by service_code: ${byCode.size}`);

  // 5. 行を DB 形式に変換
  const rows = Array.from(byCode.values()).map(toRow);

  // per-cat 内訳
  const catCount = rows.reduce((acc, r) => {
    acc[r.service_category] = (acc[r.service_category] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n[per-category]`);
  for (const [c, n] of Object.entries(catCount)) {
    console.log(`  ${c} (${CAT_NAME[c] ?? c}): ${n} 件`);
  }

  // 6. 事前件数
  const { count: beforeCount, error: cntErr } = await sb
    .from("kaigo_service_codes")
    .select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM);
  if (cntErr) { console.error("既存件数 SELECT 失敗:", cntErr.message); process.exit(1); }
  console.log(`\n[事前] system='${SYSTEM}' 既存件数: ${beforeCount}`);

  // 7. 既存 code check (UNIQUE (system, service_code, valid_from))
  const allCodes = rows.map((r) => r.service_code);
  const existingCodes = new Set();
  const CHUNK_LOOKUP = 500;
  for (let i = 0; i < allCodes.length; i += CHUNK_LOOKUP) {
    const slice = allCodes.slice(i, i + CHUNK_LOOKUP);
    const { data, error } = await sb
      .from("kaigo_service_codes")
      .select("service_code, valid_from")
      .eq("system", SYSTEM)
      .eq("valid_from", VALID_FROM)
      .in("service_code", slice);
    if (error) { console.error("既存 lookup 失敗:", error.message); process.exit(1); }
    for (const r of data ?? []) existingCodes.add(r.service_code);
  }
  const toInsert = rows.filter((r) => !existingCodes.has(r.service_code));
  console.log(`\n[既存 check] 衝突 skip: ${rows.length - toInsert.length} / 新規 INSERT 対象: ${toInsert.length}`);

  // 8. サンプル 5 件 preview
  console.log(`\n[サンプル 5 件]`);
  for (const r of toInsert.slice(0, 5)) {
    console.log(`  ${r.service_code}  ${r.units}単位  ${r.unit_type}  ${r.service_name.slice(0, 40)}`);
  }

  if (!EXECUTE) {
    console.log(`\n(DRY RUN — 実行するには --execute)`);
    cleanup();
    return;
  }

  if (toInsert.length === 0) {
    console.log(`\n新規 INSERT 対象なし → 何もしない`);
    cleanup();
    return;
  }

  // 9. INSERT chunk 100
  const CHUNK = 100;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const slice = toInsert.slice(i, i + CHUNK);
    const { error } = await sb.from("kaigo_service_codes").insert(slice);
    if (error) {
      console.error(`  ❌ INSERT 失敗 (batch ${i / CHUNK}):`, error.message);
      console.error(`     先頭行 sample:`, JSON.stringify(slice[0]));
      process.exit(1);
    }
    inserted += slice.length;
    console.log(`  ✅ ${inserted}/${toInsert.length}`);
  }

  // 10. 事後件数 + 内訳
  const { count: afterCount, error: cnt2Err } = await sb
    .from("kaigo_service_codes")
    .select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM);
  if (cnt2Err) { console.error("事後件数 SELECT 失敗:", cnt2Err.message); }

  console.log(`\n✅ 完了`);
  console.log(`  INSERT 成功: ${inserted}`);
  console.log(`  system='${SYSTEM}' before → after: ${beforeCount} → ${afterCount}`);

  // per-cat 事後内訳
  for (const cat of ["A2", "A3", "A6", "A7"]) {
    const { count } = await sb
      .from("kaigo_service_codes")
      .select("service_code", { count: "exact", head: true })
      .eq("system", SYSTEM)
      .eq("service_category", cat)
      .eq("valid_from", VALID_FROM);
    console.log(`  ${cat} (${CAT_NAME[cat]}): ${count} 件`);
  }

  cleanup();
}

function cleanup() {
  try { if (existsSync(JSON_TMP)) unlinkSync(JSON_TMP); } catch {}
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
