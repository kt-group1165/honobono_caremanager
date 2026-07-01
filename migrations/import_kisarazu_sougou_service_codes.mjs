// 木更津市 総合事業 サービスコード import
//   input:  C:/Users/domen-PC/AppData/Local/Temp/G240P22C.csv  (cp932 / Shift_JIS)
//   target: kaigo_service_codes (system='総合事業')
//
// CSV = 国保連統一フォーマット (143+列):
//   col 0 : 保険者番号 (122069 = 木更津市)
//   col 1 : サービス種類 (A2/A3/A6/AF 等)
//   col 2 : サービス項目 (4桁)
//   col 3 : 適用開始 YYYYMM
//   col 4 : 適用終了 YYYYMM (999999 = 無期限)  ← 現行有効のみ抽出
//   col 5 : サービス内容略称 (全角空白 padding — rstrip 必要)
//   col 6 : 単位数 (5桁 zero-padded / 例 01168 → 1168)
//   col 7 : 算定単位区分 (03=1月につき / 01=1回につき / 02=1日につき)
//
// 千葉市 (system='総合事業') と service_code が衝突するため
// 木更津市は `K_<original>` prefix で区別する (例 K_A21111)。
// service_category は元コード (A2 等) を保持、service_name は木更津の表記。
//
// UNIQUE (system, service_code, valid_from) — 既存衝突は skip
//
// 実行:
//   node --env-file=.env.local migrations/import_kisarazu_sougou_service_codes.mjs
//   node --env-file=.env.local migrations/import_kisarazu_sougou_service_codes.mjs --execute

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

const CSV_PATH = "C:/Users/domen-PC/AppData/Local/Temp/G240P22C.csv";
const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_TMP = resolve(__dirname, "_kisarazu_sougou_extracted.json");

const SYSTEM = "総合事業";
const CITY_PREFIX = "K_"; // 木更津 = K
const NOTES_BASE = "木更津市 総合事業 保険者番号=122069";

const CAT_NAME = {
  A2: "訪問介護相当サービス (木更津市)",
  A3: "生活援助型訪問サービス (木更津市)",
  A6: "通所介護相当サービス (木更津市)",
  A7: "ミニデイ型通所サービス (木更津市)",
  AF: "介護予防ケアマネジメント (木更津市)",
};

const UNIT_TYPE_MAP = {
  "01": "1回につき",
  "02": "1日につき",
  "03": "1月につき",
};

// ─────────────────────────────────────────────────────────
// Python で cp932 CSV → JSON 抽出 (現行有効のみ)
// ─────────────────────────────────────────────────────────
function extractCsvToJson() {
  if (!existsSync(CSV_PATH)) {
    console.error(`csv 不在: ${CSV_PATH}`);
    process.exit(1);
  }
  const pyCode = `
import csv, json, sys
total = 0
active = 0
rows = []
with open(r"${CSV_PATH}", encoding="cp932", newline="") as f:
    reader = csv.reader(f)
    for row in reader:
        total += 1
        if len(row) < 8:
            continue
        # col 4 適用終了 = '999999' の行だけ現行有効
        if row[4] != "999999":
            continue
        active += 1
        cat = row[1]
        code_num = row[2]
        name = row[5].rstrip("　").rstrip()
        try:
            units = int(row[6])
        except:
            units = None
        unit_type_code = row[7]
        valid_from_yyyymm = row[3]
        rows.append({
            "cat": cat,
            "code_num": code_num,
            "name": name,
            "units": units,
            "unit_type_code": unit_type_code,
            "valid_from_yyyymm": valid_from_yyyymm,
        })
with open(r"${JSON_TMP}", "w", encoding="utf-8") as f:
    json.dump({"total": total, "active": active, "rows": rows}, f, ensure_ascii=False)
print(f"total={total} active(999999)={active} extracted={len(rows)}")
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
function toRow({ cat, code_num, name, units, unit_type_code, valid_from_yyyymm }) {
  const orig_code = `${cat}${code_num}`;
  const service_code = `${CITY_PREFIX}${orig_code}`;
  const service_category_name = CAT_NAME[cat] ?? `${cat} (木更津市)`;

  // unit_type
  const unit_type = UNIT_TYPE_MAP[unit_type_code] ?? "1回につき";

  // valid_from : YYYYMM → 'YYYY-MM-01'
  let valid_from = null;
  if (/^\d{6}$/.test(valid_from_yyyymm)) {
    valid_from = `${valid_from_yyyymm.slice(0, 4)}-${valid_from_yyyymm.slice(4, 6)}-01`;
  }

  // calculation_type
  let calculation_type = "基本";
  if (typeof units === "number" && units < 0) calculation_type = "減算";
  else if (typeof name === "string" && name.includes("加算")) calculation_type = "加算";
  else if (typeof name === "string" && name.includes("減算")) calculation_type = "減算";

  return {
    system: SYSTEM,
    service_category: cat, // 元カテゴリ (A2/A3/A6/AF) を保持
    service_category_name,
    service_code, // K_A21111 形式
    service_name: name,
    units,
    unit_type,
    calculation_type,
    valid_from,
    valid_until: null,
    notes: NOTES_BASE,
  };
}

// ─────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📥 木更津市 総合事業 サービスコード import`);
  console.log(`   source: ${CSV_PATH}`);
  console.log(`   target: kaigo_service_codes (system='${SYSTEM}', prefix='${CITY_PREFIX}')`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (INSERT)" : "🔍 DRY RUN");

  // 1. 抽出
  const { total, active, rows: rawRows } = extractCsvToJson();
  console.log(`\n[抽出] CSV total=${total}, 現行有効(999999)=${active}, 抽出行=${rawRows.length}`);

  // 2. per-cat 内訳 (抽出後)
  const rawByCat = rawRows.reduce((acc, r) => {
    acc[r.cat] = (acc[r.cat] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n[per-category 抽出]`);
  for (const [c, n] of Object.entries(rawByCat)) {
    console.log(`  ${c} (${CAT_NAME[c] ?? c}): ${n} 件`);
  }

  // 3. units 数値有効行のみ (null は skip)
  const withUnits = rawRows.filter((r) => typeof r.units === "number");
  const withoutUnits = rawRows.length - withUnits.length;
  console.log(`\n[filter] units 数値有効: ${withUnits.length} / null (skip): ${withoutUnits}`);

  // 4. dedup by (cat, code_num, valid_from) — 同じ行が複数 valid_from で重複しないよう
  const byKey = new Map();
  for (const r of withUnits) {
    const key = `${r.cat}${r.code_num}|${r.valid_from_yyyymm}`;
    if (!byKey.has(key)) byKey.set(key, r);
  }
  console.log(`  unique by (code, valid_from): ${byKey.size}`);

  // 5. 行を DB 形式に変換
  const rows = Array.from(byKey.values()).map(toRow);

  // per-cat 事後内訳 (INSERT candidate 段階)
  const catCount = rows.reduce((acc, r) => {
    acc[r.service_category] = (acc[r.service_category] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n[per-category (INSERT candidate)]`);
  for (const [c, n] of Object.entries(catCount)) {
    console.log(`  ${c} (${CAT_NAME[c] ?? c}): ${n} 件`);
  }

  // 6. 事前件数 (system='総合事業' 全体 & K_ prefix)
  const { count: beforeTotal, error: cntErr } = await sb
    .from("kaigo_service_codes")
    .select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM);
  if (cntErr) { console.error("既存件数 SELECT 失敗:", cntErr.message); process.exit(1); }
  const { count: beforeKisarazu, error: cnt2Err } = await sb
    .from("kaigo_service_codes")
    .select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM)
    .like("service_code", `${CITY_PREFIX}%`);
  if (cnt2Err) { console.error("K_ 既存件数 SELECT 失敗:", cnt2Err.message); process.exit(1); }
  console.log(`\n[事前] system='${SYSTEM}' 全体: ${beforeTotal} / K_* prefix: ${beforeKisarazu}`);

  // 7. 既存 (system, service_code, valid_from) 衝突 check
  //    valid_from ごとに分けて lookup
  const byValidFrom = new Map();
  for (const r of rows) {
    const key = r.valid_from ?? "null";
    if (!byValidFrom.has(key)) byValidFrom.set(key, []);
    byValidFrom.get(key).push(r);
  }
  const existingKeys = new Set(); // `${service_code}|${valid_from}`
  const CHUNK_LOOKUP = 500;
  for (const [vf, group] of byValidFrom) {
    const codes = group.map((r) => r.service_code);
    for (let i = 0; i < codes.length; i += CHUNK_LOOKUP) {
      const slice = codes.slice(i, i + CHUNK_LOOKUP);
      let query = sb
        .from("kaigo_service_codes")
        .select("service_code, valid_from")
        .eq("system", SYSTEM)
        .in("service_code", slice);
      query = vf === "null" ? query.is("valid_from", null) : query.eq("valid_from", vf);
      const { data, error } = await query;
      if (error) { console.error("既存 lookup 失敗:", error.message); process.exit(1); }
      for (const r of data ?? []) {
        existingKeys.add(`${r.service_code}|${r.valid_from ?? "null"}`);
      }
    }
  }
  const toInsert = rows.filter(
    (r) => !existingKeys.has(`${r.service_code}|${r.valid_from ?? "null"}`)
  );
  console.log(`\n[既存 check] 衝突 skip: ${rows.length - toInsert.length} / 新規 INSERT 対象: ${toInsert.length}`);

  // 8. サンプル 5 件 preview
  console.log(`\n[サンプル 5 件]`);
  for (const r of toInsert.slice(0, 5)) {
    console.log(`  ${r.service_code}  ${r.units}単位  ${r.unit_type}  valid_from=${r.valid_from}  ${r.service_name.slice(0, 40)}`);
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
  const { count: afterTotal } = await sb
    .from("kaigo_service_codes")
    .select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM);
  const { count: afterKisarazu } = await sb
    .from("kaigo_service_codes")
    .select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM)
    .like("service_code", `${CITY_PREFIX}%`);

  console.log(`\n✅ 完了`);
  console.log(`  INSERT 成功: ${inserted}`);
  console.log(`  system='${SYSTEM}' 全体 before → after: ${beforeTotal} → ${afterTotal}`);
  console.log(`  K_* prefix   before → after: ${beforeKisarazu} → ${afterKisarazu}`);

  // per-cat 事後内訳 (K_ prefix のみ)
  console.log(`\n[事後 K_* per-category]`);
  for (const cat of Object.keys(CAT_NAME)) {
    const { count } = await sb
      .from("kaigo_service_codes")
      .select("service_code", { count: "exact", head: true })
      .eq("system", SYSTEM)
      .eq("service_category", cat)
      .like("service_code", `${CITY_PREFIX}%`);
    console.log(`  ${cat} (${CAT_NAME[cat]}): ${count} 件`);
  }

  cleanup();
}

function cleanup() {
  try { if (existsSync(JSON_TMP)) unlinkSync(JSON_TMP); } catch {}
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
