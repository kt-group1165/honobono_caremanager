// 千葉市 6区 総合事業 サービスコード import (国保連統一 CSV 版)
//   input:  C:/Users/domen-PC/Downloads/202606_2kai_1_chuou.csv  (cp932 / Shift_JIS)
//     千葉市 6区 (中央/花見川/稲毛/若葉/緑/美浜) は保険者番号だけ違い、
//     コード内容は完全同一なので 中央区 CSV を代表として取込む。
//   target: kaigo_service_codes (system='総合事業')
//
// CSV = 国保連統一フォーマット:
//   col 0 : 保険者番号 (121012 = 千葉市中央区)
//   col 1 : サービス種類 (A2/A3/A6/A7/AF)
//   col 2 : サービス項目 (4桁)
//   col 3 : 適用開始 YYYYMM
//   col 4 : 適用終了 YYYYMM (999999 = 無期限)  ← 現行有効のみ抽出
//   col 5 : サービス内容略称 (全角空白 padding — rstrip 必要)
//   col 6 : 単位数 (5桁 zero-padded)
//   col 7 : 算定単位区分 (03=1月/01=1回/02=1日)
//
// 事前:
//   既存 Excel 由来 千葉市データ (notes LIKE '%千葉市 総合事業%' AND service_code NOT LIKE 'K_%')
//   を DELETE してから CSV データで置換する。
//
// service_code は `CB_<cat><code_num>` (例 CB_A21111) 形式で 木更津 K_ と区別。
//
// UNIQUE (system, service_code, valid_from) — 既存衝突は skip
//
// 実行:
//   node --env-file=.env.local migrations/import_chiba_6ku_sougou_service_codes.mjs
//   node --env-file=.env.local migrations/import_chiba_6ku_sougou_service_codes.mjs --execute

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

const CSV_PATH = "C:/Users/domen-PC/Downloads/202606_2kai_1_chuou.csv";
const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_TMP = resolve(__dirname, "_chiba_6ku_sougou_extracted.json");

const SYSTEM = "総合事業";
const CITY_PREFIX = "CB_"; // Chiba-shi
const NOTES_BASE =
  "千葉市 総合事業 6区共通 (保険者=中央121012/花見川121020/稲毛121038/若葉121046/緑121053/美浜121061)";

const CAT_NAME = {
  A2: "訪問介護相当サービス (千葉市)",
  A3: "生活援助型訪問サービス (千葉市)",
  A6: "通所介護相当サービス (千葉市)",
  A7: "ミニデイ型通所サービス (千葉市)",
  AF: "介護予防ケアマネジメント (千葉市)",
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
import csv, json
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
  const service_code = `${CITY_PREFIX}${orig_code}`; // CB_A21111
  const service_category_name = CAT_NAME[cat] ?? `その他 ${cat} (千葉市)`;

  const unit_type = UNIT_TYPE_MAP[unit_type_code] ?? "1回につき";

  let valid_from = null;
  if (/^\d{6}$/.test(valid_from_yyyymm)) {
    valid_from = `${valid_from_yyyymm.slice(0, 4)}-${valid_from_yyyymm.slice(4, 6)}-01`;
  }

  let calculation_type = "基本";
  if (typeof units === "number" && units < 0) calculation_type = "減算";
  else if (typeof name === "string" && name.includes("加算")) calculation_type = "加算";
  else if (typeof name === "string" && name.includes("減算")) calculation_type = "減算";

  return {
    system: SYSTEM,
    service_category: cat,
    service_category_name,
    service_code,
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
// 既存 千葉市 Excel 由来 データを DELETE
//   条件: system='総合事業' AND notes LIKE '%千葉市 総合事業%' AND service_code NOT LIKE 'K_%' AND service_code NOT LIKE 'CB_%'
//   (木更津 K_ は残す。今回入れる CB_ もまだ無いはずだが念のため除外)
// ─────────────────────────────────────────────────────────
async function deleteExistingChibaExcelRows() {
  // まず対象を SELECT で確認
  const { data: preview, error: selErr } = await sb
    .from("kaigo_service_codes")
    .select("id, service_code, service_name, valid_from, notes", { count: "exact" })
    .eq("system", SYSTEM)
    .like("notes", "%千葉市 総合事業%")
    .not("service_code", "like", "K_%")
    .not("service_code", "like", "CB_%");
  if (selErr) {
    console.error("削除対象 SELECT 失敗:", selErr.message);
    process.exit(1);
  }
  console.log(`\n[DELETE 対象] system='${SYSTEM}' 千葉市 Excel 由来 (K_/CB_ 除外): ${preview?.length ?? 0} 件`);

  const catBreakdown = (preview ?? []).reduce((acc, r) => {
    const cat = r.service_code?.slice(0, 2) ?? "??";
    acc[cat] = (acc[cat] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  内訳:`, catBreakdown);
  if ((preview ?? []).length > 0) {
    console.log(`  サンプル 3 件:`);
    for (const r of preview.slice(0, 3)) {
      console.log(`    ${r.service_code}  valid_from=${r.valid_from}  notes="${(r.notes ?? "").slice(0, 60)}"`);
    }
  }

  if (!EXECUTE) {
    console.log(`  (DRY RUN — DELETE は skip)`);
    return { deleted: 0, target: preview?.length ?? 0 };
  }

  if ((preview ?? []).length === 0) {
    console.log(`  DELETE 対象なし → skip`);
    return { deleted: 0, target: 0 };
  }

  const { error: delErr, count: deleted } = await sb
    .from("kaigo_service_codes")
    .delete({ count: "exact" })
    .eq("system", SYSTEM)
    .like("notes", "%千葉市 総合事業%")
    .not("service_code", "like", "K_%")
    .not("service_code", "like", "CB_%");
  if (delErr) {
    console.error("DELETE 失敗:", delErr.message);
    process.exit(1);
  }
  console.log(`  ✅ DELETE 成功: ${deleted}`);
  return { deleted: deleted ?? 0, target: preview.length };
}

// ─────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📥 千葉市 6区 総合事業 サービスコード import`);
  console.log(`   source: ${CSV_PATH}`);
  console.log(`   target: kaigo_service_codes (system='${SYSTEM}', prefix='${CITY_PREFIX}')`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (DELETE + INSERT)" : "🔍 DRY RUN");

  // 0. 事前 全体件数 (system='総合事業')
  const { count: t0, error: t0Err } = await sb
    .from("kaigo_service_codes")
    .select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM);
  if (t0Err) { console.error("事前件数 SELECT 失敗:", t0Err.message); process.exit(1); }
  const { count: k0, error: k0Err } = await sb
    .from("kaigo_service_codes")
    .select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM)
    .like("service_code", "K_%");
  if (k0Err) { console.error("K_ 件数 SELECT 失敗:", k0Err.message); process.exit(1); }
  const { count: cb0, error: cb0Err } = await sb
    .from("kaigo_service_codes")
    .select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM)
    .like("service_code", "CB_%");
  if (cb0Err) { console.error("CB_ 件数 SELECT 失敗:", cb0Err.message); process.exit(1); }
  console.log(`\n[事前 (DELETE 前)] system='${SYSTEM}' 全体: ${t0} / K_*: ${k0} / CB_*: ${cb0}`);

  // 1. 既存 千葉市 Excel 由来 データ DELETE
  const { deleted } = await deleteExistingChibaExcelRows();

  // 2. DELETE 後件数
  if (EXECUTE) {
    const { count: t1 } = await sb
      .from("kaigo_service_codes")
      .select("service_code", { count: "exact", head: true })
      .eq("system", SYSTEM);
    console.log(`\n[DELETE 後] system='${SYSTEM}' 全体: ${t1}`);
  }

  // 3. CSV 抽出
  const { total, active, rows: rawRows } = extractCsvToJson();
  console.log(`\n[抽出] CSV total=${total}, 現行有効(999999)=${active}, 抽出行=${rawRows.length}`);

  // 4. per-cat 内訳 (抽出後)
  const rawByCat = rawRows.reduce((acc, r) => {
    acc[r.cat] = (acc[r.cat] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n[per-category 抽出]`);
  for (const [c, n] of Object.entries(rawByCat)) {
    console.log(`  ${c} (${CAT_NAME[c] ?? c}): ${n} 件`);
  }

  // 5. units 数値有効行のみ
  const withUnits = rawRows.filter((r) => typeof r.units === "number");
  const withoutUnits = rawRows.length - withUnits.length;
  console.log(`\n[filter] units 数値有効: ${withUnits.length} / null (skip): ${withoutUnits}`);

  // 6. dedup by (cat, code_num, valid_from)
  const byKey = new Map();
  for (const r of withUnits) {
    const key = `${r.cat}${r.code_num}|${r.valid_from_yyyymm}`;
    if (!byKey.has(key)) byKey.set(key, r);
  }
  console.log(`  unique by (code, valid_from): ${byKey.size}`);

  // 7. DB 形式へ
  const rows = Array.from(byKey.values()).map(toRow);

  const catCount = rows.reduce((acc, r) => {
    acc[r.service_category] = (acc[r.service_category] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n[per-category (INSERT candidate)]`);
  for (const [c, n] of Object.entries(catCount)) {
    console.log(`  ${c} (${CAT_NAME[c] ?? c}): ${n} 件`);
  }

  // 8. 既存 (system, service_code, valid_from) 衝突 check
  const byValidFrom = new Map();
  for (const r of rows) {
    const key = r.valid_from ?? "null";
    if (!byValidFrom.has(key)) byValidFrom.set(key, []);
    byValidFrom.get(key).push(r);
  }
  const existingKeys = new Set();
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

  // 9. サンプル 5 件
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

  // 10. INSERT chunk 100
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

  // 11. 事後件数
  const { count: t2 } = await sb
    .from("kaigo_service_codes")
    .select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM);
  const { count: k2 } = await sb
    .from("kaigo_service_codes")
    .select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM)
    .like("service_code", "K_%");
  const { count: cb2 } = await sb
    .from("kaigo_service_codes")
    .select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM)
    .like("service_code", "CB_%");

  console.log(`\n✅ 完了`);
  console.log(`  DELETE 件数: ${deleted}`);
  console.log(`  INSERT 成功: ${inserted}`);
  console.log(`  system='${SYSTEM}' 全体 (事前 → 事後): ${t0} → ${t2}`);
  console.log(`  K_* (事前 → 事後): ${k0} → ${k2}`);
  console.log(`  CB_* (事前 → 事後): ${cb0} → ${cb2}`);

  console.log(`\n[事後 CB_* per-category]`);
  for (const cat of Object.keys(catCount)) {
    const { count } = await sb
      .from("kaigo_service_codes")
      .select("service_code", { count: "exact", head: true })
      .eq("system", SYSTEM)
      .eq("service_category", cat)
      .like("service_code", "CB_%");
    console.log(`  ${cat} (${CAT_NAME[cat] ?? cat}): ${count} 件`);
  }

  cleanup();
}

function cleanup() {
  try { if (existsSync(JSON_TMP)) unlinkSync(JSON_TMP); } catch {}
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
