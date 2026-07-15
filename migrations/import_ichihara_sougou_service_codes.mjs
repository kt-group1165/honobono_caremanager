// 市原市 総合事業 サービスコード import (国保連統一 CSV 版・全世代)
//   input: apps/kaigo-app/サービスコード/市原市/令和8年6月以降（標準以外）.csv (cp932)
//   target: kaigo_service_codes (system='総合事業')
//
// CSV = 国保連統一フォーマット (col数24):
//   col 0 : 保険者番号 (122192 = 市原市)
//   col 1 : サービス種類 (A2/A6/AF)
//   col 2 : サービス項目 (4桁)
//   col 3 : 適用開始 YYYYMM  → valid_from = YYYY-MM-01
//   col 4 : 適用終了 YYYYMM (999999=無期限→valid_until=null / else=当月末)
//   col 5 : サービス内容略称 (全角空白 padding — rstrip 必要)
//   col 6 : 単位数 (5桁 zero-padded)
//   col 7 : 算定単位区分 (03=1月/01=1回/02=1日)
//
// 千葉市6区版 (import_chiba_6ku_...) との違い:
//   - service_code 接頭辞 = `IH_` (Ichihara。CB_千葉市 / K_木更津 と区別)
//   - **現行(999999)のみでなく全世代を取込む** (valid_from/valid_until で世代管理)
//     → 月遅れ・返戻の再請求 (validInMonth) が過去月でも正しく引ける
//   - 既存 IH_ 行との UNIQUE(system, service_code, valid_from) 衝突は skip (冪等)
//   - 破壊的 DELETE は行わない (新規 prefix なので不要)
//
// 実行:
//   node --env-file=.env.local migrations/import_ichihara_sougou_service_codes.mjs            # DRY RUN
//   node --env-file=.env.local migrations/import_ichihara_sougou_service_codes.mjs --execute  # 本番

import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("env missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)"); process.exit(1); }
const EXECUTE = process.argv.includes("--execute");
const sb = createClient(SB_URL, SB_KEY);

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(__dirname, "../サービスコード/市原市/令和8年6月以降（標準以外）.csv");
const JSON_TMP = resolve(__dirname, "_ichihara_sougou_extracted.json");

const SYSTEM = "総合事業";
const CITY_PREFIX = "IH_"; // Ichihara-shi
const INSURER = "122192";
const NOTES_BASE = "市原市 総合事業 (保険者=市原市122192)";

const CAT_NAME = {
  A2: "訪問介護相当・独自サービス (市原市)",
  A6: "通所介護相当・独自サービス (市原市)",
  AF: "介護予防ケアマネジメント (市原市)",
};

const UNIT_TYPE_MAP = {
  "01": "1回につき",
  "02": "1日につき",
  "03": "1月につき",
};

// ─────────────────────────────────────────────────────────
// Python で cp932 CSV → JSON 抽出 (全世代・valid_from/until 計算)
// ─────────────────────────────────────────────────────────
function extractCsvToJson() {
  if (!existsSync(CSV_PATH)) {
    console.error(`csv 不在: ${CSV_PATH}`);
    process.exit(1);
  }
  const pyCode = `
import csv, json, calendar
total = 0
rows = []
bad_insurer = 0
with open(r"${CSV_PATH}", encoding="cp932", newline="") as f:
    for row in csv.reader(f):
        if not row or len(row) < 8:
            continue
        total += 1
        if row[0].strip() != "${INSURER}":
            bad_insurer += 1
            continue
        cat = row[1].strip()
        code_num = row[2].strip()
        name = row[5].rstrip("　").rstrip()
        try:
            units = int(row[6])
        except:
            units = None
        unit_type_code = row[7].strip()
        vf_raw = row[3].strip()
        vu_raw = row[4].strip()
        valid_from = None
        if len(vf_raw) == 6 and vf_raw.isdigit():
            valid_from = f"{vf_raw[:4]}-{vf_raw[4:6]}-01"
        valid_until = None
        if vu_raw != "999999" and len(vu_raw) == 6 and vu_raw.isdigit():
            y, m = int(vu_raw[:4]), int(vu_raw[4:6])
            last = calendar.monthrange(y, m)[1]
            valid_until = f"{vu_raw[:4]}-{vu_raw[4:6]}-{last:02d}"
        rows.append({
            "cat": cat, "code_num": code_num, "name": name, "units": units,
            "unit_type_code": unit_type_code,
            "valid_from": valid_from, "valid_until": valid_until,
            "is_current": vu_raw == "999999",
        })
with open(r"${JSON_TMP}", "w", encoding="utf-8") as f:
    json.dump({"total": total, "bad_insurer": bad_insurer, "rows": rows}, f, ensure_ascii=False)
print(f"total={total} 他保険者skip={bad_insurer} extracted={len(rows)}")
`;
  const r = spawnSync("python", ["-c", pyCode], { encoding: "utf-8" });
  if (r.status !== 0) {
    console.error("Python extract 失敗:", r.stderr);
    process.exit(1);
  }
  console.log(`  Python 抽出結果: ${r.stdout.trim()}`);
  return JSON.parse(readFileSync(JSON_TMP, "utf-8"));
}

function toRow({ cat, code_num, name, units, unit_type_code, valid_from, valid_until }) {
  const orig_code = `${cat}${code_num}`;
  const service_code = `${CITY_PREFIX}${orig_code}`; // IH_A21111
  const service_category_name = CAT_NAME[cat] ?? `その他 ${cat} (市原市)`;
  const unit_type = UNIT_TYPE_MAP[unit_type_code] ?? "1回につき";

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
    valid_until,
    notes: NOTES_BASE,
  };
}

async function main() {
  console.log(`\n📥 市原市 総合事業 サービスコード import (全世代)`);
  console.log(`   source: ${CSV_PATH}`);
  console.log(`   target: kaigo_service_codes (system='${SYSTEM}', prefix='${CITY_PREFIX}')`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (INSERT)" : "🔍 DRY RUN");

  // 0. 事前件数
  const { count: t0, error: t0Err } = await sb
    .from("kaigo_service_codes").select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM);
  if (t0Err) { console.error("事前件数 SELECT 失敗:", t0Err.message); process.exit(1); }
  const { count: ih0, error: ih0Err } = await sb
    .from("kaigo_service_codes").select("service_code", { count: "exact", head: true })
    .eq("system", SYSTEM).like("service_code", "IH_%");
  if (ih0Err) { console.error("IH_ 件数 SELECT 失敗:", ih0Err.message); process.exit(1); }
  console.log(`\n[事前] system='${SYSTEM}' 全体: ${t0} / 既存 IH_*: ${ih0}`);

  // 1. CSV 抽出
  const { total, bad_insurer, rows: rawRows } = extractCsvToJson();
  console.log(`\n[抽出] CSV total=${total}, 他保険者skip=${bad_insurer}, 抽出行=${rawRows.length}`);

  const rawByCat = rawRows.reduce((a, r) => ((a[r.cat] = (a[r.cat] ?? 0) + 1), a), {});
  const curByCat = rawRows.filter((r) => r.is_current).reduce((a, r) => ((a[r.cat] = (a[r.cat] ?? 0) + 1), a), {});
  console.log(`\n[per-category] 全世代 / うち現行(valid_until=null)`);
  for (const c of Object.keys(rawByCat)) {
    console.log(`  ${c} (${CAT_NAME[c] ?? c}): ${rawByCat[c]} / ${curByCat[c] ?? 0}`);
  }

  // 2. units 数値有効行のみ
  const withUnits = rawRows.filter((r) => typeof r.units === "number");
  console.log(`\n[filter] units 数値有効: ${withUnits.length} / null(skip): ${rawRows.length - withUnits.length}`);

  // 3. dedup by (code, valid_from)
  const byKey = new Map();
  for (const r of withUnits) {
    const key = `${r.cat}${r.code_num}|${r.valid_from ?? "null"}`;
    if (!byKey.has(key)) byKey.set(key, r);
  }
  console.log(`  unique by (code, valid_from): ${byKey.size}`);

  const rows = Array.from(byKey.values()).map(toRow);

  // 4. 既存 (system, service_code, valid_from) 衝突 check
  const byVf = new Map();
  for (const r of rows) {
    const key = r.valid_from ?? "null";
    if (!byVf.has(key)) byVf.set(key, []);
    byVf.get(key).push(r);
  }
  const existingKeys = new Set();
  for (const [vf, group] of byVf) {
    const codes = group.map((r) => r.service_code);
    for (let i = 0; i < codes.length; i += 500) {
      const slice = codes.slice(i, i + 500);
      let q = sb.from("kaigo_service_codes").select("service_code, valid_from")
        .eq("system", SYSTEM).in("service_code", slice);
      q = vf === "null" ? q.is("valid_from", null) : q.eq("valid_from", vf);
      const { data, error } = await q;
      if (error) { console.error("既存 lookup 失敗:", error.message); process.exit(1); }
      for (const r of data ?? []) existingKeys.add(`${r.service_code}|${r.valid_from ?? "null"}`);
    }
  }
  const toInsert = rows.filter((r) => !existingKeys.has(`${r.service_code}|${r.valid_from ?? "null"}`));
  console.log(`\n[既存 check] 衝突 skip: ${rows.length - toInsert.length} / 新規 INSERT 対象: ${toInsert.length}`);

  console.log(`\n[サンプル 6 件]`);
  for (const r of toInsert.slice(0, 6)) {
    console.log(`  ${r.service_code}  ${r.units}単位  ${r.unit_type}  ${r.valid_from}~${r.valid_until ?? "現行"}  ${r.service_name.slice(0, 30)}`);
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

  // 5. INSERT chunk 100
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += 100) {
    const slice = toInsert.slice(i, i + 100);
    const { error } = await sb.from("kaigo_service_codes").insert(slice);
    if (error) {
      console.error(`  ❌ INSERT 失敗 (batch ${i / 100}):`, error.message);
      console.error(`     先頭行 sample:`, JSON.stringify(slice[0]));
      process.exit(1);
    }
    inserted += slice.length;
    console.log(`  ✅ ${inserted}/${toInsert.length}`);
  }

  const { count: t2 } = await sb.from("kaigo_service_codes").select("service_code", { count: "exact", head: true }).eq("system", SYSTEM);
  const { count: ih2 } = await sb.from("kaigo_service_codes").select("service_code", { count: "exact", head: true }).eq("system", SYSTEM).like("service_code", "IH_%");
  console.log(`\n✅ 完了`);
  console.log(`  INSERT 成功: ${inserted}`);
  console.log(`  system='${SYSTEM}' 全体 (事前→事後): ${t0} → ${t2}`);
  console.log(`  IH_* (事前→事後): ${ih0} → ${ih2}`);
  cleanup();
}

function cleanup() {
  try { if (existsSync(JSON_TMP)) unlinkSync(JSON_TMP); } catch {}
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
