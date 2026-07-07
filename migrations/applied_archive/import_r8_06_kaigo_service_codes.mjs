#!/usr/bin/env node
/**
 * 介護保険サービスコードマスタ 令和8年6月版 (R8.6.1 施行) 取込
 *
 * データ源: WAM 令和8年5月25日事務連絡 Excel版コード表 (介護/予防/地域密着 3 workbook)
 *   → 抽出済 JSON: r8_06_kaigo_service_codes.json (本 script と同 dir)
 *
 * 動作:
 *   1. kaigo_service_codes へ R8 行を INSERT
 *      (valid_from='2026-06-01', valid_until=null, system='介護',
 *       notes='令和8年6月改定 (処遇改善拡充)')
 *   2. 既存 R6 行 (system='介護', valid_from='2024-06-01') のうち
 *      「R8 データに同カテゴリが存在する行」を valid_until='2026-05-31' でクローズ
 *      ※ R8 Excel に無いカテゴリ (44 販売 / 45 住宅改修 / 61 / A1 / A2 / A5) は
 *        置換データが無いためクローズせず残す (dry-run に残置一覧を表示)
 *
 * 引継ロジック (R6 同一 service_code から):
 *   - short_name / formula : 常に引継 (formula は処遇改善率改定の可能性 → 報告のみ、内容は変更しない)
 *   - unit_type            : Excel 値優先 → 無ければ R6 → 既定 '1回につき'
 *   - calculation_type     : R6 優先 → 新規コードは名称 heuristic (加算/減算/基本)
 *
 * 使い方:
 *   node migrations/import_r8_06_kaigo_service_codes.mjs               # DRY RUN (書き込みゼロ)
 *   node migrations/import_r8_06_kaigo_service_codes.mjs --execute     # 本実行
 *   オプション: --json=<path>  抽出 JSON の場所を上書き
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXECUTE = process.argv.includes("--execute");
const jsonArg = process.argv.find((a) => a.startsWith("--json="));
const JSON_PATH = jsonArg
  ? jsonArg.slice("--json=".length)
  : path.join(__dirname, "r8_06_kaigo_service_codes.json");

const NEW_VALID_FROM = "2026-06-01";
const OLD_VALID_FROM = "2024-06-01";
const CLOSE_DATE = "2026-05-31";
const NOTES = "令和8年6月改定 (処遇改善拡充)";
const SYSTEM = "介護";
const BATCH = 500;

// ---- 公式 種類コード → サービス種類名 (R8.6 時点) ----
const CATEGORY_NAMES = {
  "11": "訪問介護",
  "12": "訪問入浴介護",
  "13": "訪問看護",
  "14": "訪問リハビリテーション",
  "15": "通所介護",
  "16": "通所リハビリテーション",
  "17": "福祉用具貸与",
  "21": "短期入所生活介護",
  "22": "短期入所療養介護(老健)",
  "23": "短期入所療養介護(病院療養型)",
  "24": "介護予防短期入所生活介護",
  "25": "介護予防短期入所療養介護(老健)",
  "26": "介護予防短期入所療養介護(病院療養型)",
  "27": "特定施設入居者生活介護(短期利用)",
  "28": "地域密着型特定施設入居者生活介護(短期利用)",
  "2A": "短期入所療養介護(介護医療院)",
  "2B": "介護予防短期入所療養介護(介護医療院)",
  "31": "居宅療養管理指導",
  "32": "認知症対応型共同生活介護",
  "33": "特定施設入居者生活介護",
  "34": "介護予防居宅療養管理指導",
  "35": "介護予防特定施設入居者生活介護",
  "36": "地域密着型特定施設入居者生活介護",
  "37": "介護予防認知症対応型共同生活介護",
  "38": "認知症対応型共同生活介護(短期利用)",
  "39": "介護予防認知症対応型共同生活介護(短期利用)",
  "43": "居宅介護支援",
  "46": "介護予防支援",
  "51": "介護福祉施設サービス",
  "52": "介護保健施設サービス",
  "54": "地域密着型介護福祉施設サービス",
  "55": "介護医療院サービス",
  "62": "介護予防訪問入浴介護",
  "63": "介護予防訪問看護",
  "64": "介護予防訪問リハビリテーション",
  "66": "介護予防通所リハビリテーション",
  "67": "介護予防福祉用具貸与",
  "68": "小規模多機能型居宅介護(短期利用)",
  "69": "介護予防小規模多機能型居宅介護(短期利用)",
  "71": "夜間対応型訪問介護",
  "72": "認知症対応型通所介護",
  "73": "小規模多機能型居宅介護",
  "74": "介護予防認知症対応型通所介護",
  "75": "介護予防小規模多機能型居宅介護",
  "76": "定期巡回・随時対応型訪問介護看護",
  "77": "看護小規模多機能型居宅介護",
  "78": "地域密着型通所介護",
  "79": "看護小規模多機能型居宅介護(短期利用)",
};

// ---- env ----
function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env.local");
  const text = readFileSync(envPath, "utf-8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local に無い");
  process.exit(1);
}

const HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

async function fetchAll(query) {
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const res = await fetch(`${SB_URL}/rest/v1/kaigo_service_codes?${query}`, {
      headers: { ...HEADERS, Range: `${from}-${from + page - 1}` },
    });
    if (!res.ok) {
      console.error(`SELECT failed (${res.status}):`, await res.text());
      process.exit(1);
    }
    const chunk = await res.json();
    rows.push(...chunk);
    if (chunk.length < page) break;
  }
  return rows;
}

// 全角数字 → 半角 (Excel の「１月につき」ゆれ吸収)
function normUnitType(s) {
  if (!s) return null;
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
}

function heuristicCalcType(name) {
  if (/減算|・業未|・虐防|・高齢者虐待防止|未実施|未策定/.test(name)) return "減算";
  if (/加算|処遇改善|・夜$|・深$|・夜・|・深・/.test(name)) return "加算";
  return "基本";
}

async function main() {
  console.log(EXECUTE ? "=== EXECUTE MODE ===" : "=== DRY RUN (書き込みゼロ) ===");
  console.log(`JSON: ${JSON_PATH}`);

  // ---- 抽出 JSON 読込 ----
  const data = JSON.parse(readFileSync(JSON_PATH, "utf-8"));
  const r8rows = data.rows;
  console.log(`抽出データ: ${r8rows.length} 行 (${data.source})`);

  // ---- 既存 R8 行チェック (二重実行防止) ----
  const existingR8 = await fetchAll(
    `select=service_code&system=eq.${encodeURIComponent(SYSTEM)}&valid_from=eq.${NEW_VALID_FROM}&order=service_code.asc`
  );
  if (existingR8.length > 0) {
    console.error(`ERROR: valid_from=${NEW_VALID_FROM} の行が既に ${existingR8.length} 件存在。二重取込を防ぐため中止。`);
    process.exit(1);
  }

  // ---- R6 行 fetch ----
  console.log("R6 行を fetch 中...");
  const r6rows = await fetchAll(
    `select=service_code,service_category,service_category_name,service_name,units,unit_type,calculation_type,short_name,formula,valid_until&system=eq.${encodeURIComponent(SYSTEM)}&valid_from=eq.${OLD_VALID_FROM}&order=service_code.asc`
  );
  console.log(`R6 行: ${r6rows.length} 件`);
  const r6map = new Map(r6rows.map((r) => [r.service_code, r]));

  // ---- R8 insert 行の構築 ----
  const r8cats = new Set(r8rows.map((r) => r.service_category));
  const inserts = [];
  let inheritShort = 0;
  let inheritFormula = 0;
  let inheritCalc = 0;
  let unitTypeFromExcel = 0;
  let unitTypeFromR6 = 0;
  let unitTypeDefault = 0;
  let unitsNull = 0;

  for (const r of r8rows) {
    const old = r6map.get(r.service_code);
    const excelUnitType = normUnitType(r.unit_type);
    let unit_type;
    if (excelUnitType) {
      unit_type = excelUnitType;
      unitTypeFromExcel++;
    } else if (old?.unit_type) {
      unit_type = old.unit_type;
      unitTypeFromR6++;
    } else {
      unit_type = "1回につき";
      unitTypeDefault++;
    }
    let calculation_type;
    if (old?.calculation_type) {
      calculation_type = old.calculation_type;
      inheritCalc++;
    } else {
      calculation_type = heuristicCalcType(r.service_name);
    }
    if (old?.short_name) inheritShort++;
    if (old?.formula) inheritFormula++;
    if (r.units == null) unitsNull++;

    inserts.push({
      service_category: r.service_category,
      service_category_name: CATEGORY_NAMES[r.service_category] ?? old?.service_category_name ?? r.service_category,
      service_code: r.service_code,
      service_name: r.service_name,
      units: r.units ?? 0,
      unit_type,
      calculation_type,
      valid_from: NEW_VALID_FROM,
      valid_until: null,
      notes: NOTES,
      system: SYSTEM,
      short_name: old?.short_name ?? null,
      formula: old?.formula ?? null,
    });
  }

  // ---- R6 クローズ対象 (R8 に同カテゴリがある行のみ) ----
  const toClose = r6rows.filter((r) => r8cats.has(r.service_category));
  const toKeep = r6rows.filter((r) => !r8cats.has(r.service_category));

  // ---- 差分レポート ----
  const r8map = new Map(inserts.map((r) => [r.service_code, r]));
  const changed = [];
  const added = [];
  const removed = [];
  for (const r of inserts) {
    const old = r6map.get(r.service_code);
    if (!old) added.push(r);
    else if ((old.units ?? 0) !== r.units) changed.push({ code: r.service_code, name: r.service_name, r6: old.units, r8: r.units });
  }
  for (const o of r6rows) {
    if (r8cats.has(o.service_category) && !r8map.has(o.service_code)) removed.push(o);
  }

  const byCat = new Map();
  for (const r of inserts) {
    const c = byCat.get(r.service_category) ?? { r8: 0, add: 0, chg: 0 };
    c.r8++;
    byCat.set(r.service_category, c);
  }
  for (const a of added) byCat.get(a.service_category).add++;
  for (const c of changed) byCat.get(c.code.slice(0, 2)).chg++;
  const remByCat = new Map();
  for (const o of removed) remByCat.set(o.service_category, (remByCat.get(o.service_category) ?? 0) + 1);
  const r6ByCat = new Map();
  for (const o of r6rows) r6ByCat.set(o.service_category, (r6ByCat.get(o.service_category) ?? 0) + 1);

  console.log("\n--- カテゴリ別内訳 (R8投入 / R6既存 / 新規 / 単位数変更 / 廃止) ---");
  const allCats = [...new Set([...byCat.keys(), ...r6ByCat.keys()])].sort();
  for (const cat of allCats) {
    const c = byCat.get(cat);
    const name = CATEGORY_NAMES[cat] ?? "?";
    if (!c) continue; // R8 に無いカテゴリは後述の残置一覧で表示
    console.log(
      `  ${cat} ${name}: R8=${c.r8} R6=${r6ByCat.get(cat) ?? 0} 新規=${c.add} 単位変更=${c.chg} 廃止=${remByCat.get(cat) ?? 0}`
    );
  }

  console.log("\n--- R6 残置 (R8 Excel にカテゴリが無い = クローズしない) ---");
  const keepByCat = new Map();
  for (const o of toKeep) keepByCat.set(o.service_category, (keepByCat.get(o.service_category) ?? 0) + 1);
  for (const [cat, n] of [...keepByCat].sort()) {
    const label = toKeep.find((o) => o.service_category === cat)?.service_category_name ?? "";
    console.log(`  ${cat} ${label}: ${n} 件 (valid_until=null のまま)`);
  }

  // ---- DB カテゴリ名と公式名の mismatch 警告 ----
  console.log("\n--- DB R6 カテゴリ名 vs 公式名 mismatch (参考: R8 は公式名で投入) ---");
  const dbNames = new Map();
  for (const o of r6rows) {
    if (!dbNames.has(o.service_category)) dbNames.set(o.service_category, o.service_category_name);
  }
  let mismatch = 0;
  for (const [cat, dbName] of [...dbNames].sort()) {
    const official = CATEGORY_NAMES[cat];
    if (official && dbName !== official) {
      console.log(`  ${cat}: DB="${dbName}" → 公式="${official}"`);
      mismatch++;
    }
  }
  if (mismatch === 0) console.log("  (mismatch なし)");

  // ---- サマリ ----
  console.log("\n--- サマリ ---");
  console.log(`INSERT 予定: ${inserts.length} 件 (valid_from=${NEW_VALID_FROM})`);
  console.log(`R6 クローズ予定: ${toClose.length} 件 → valid_until=${CLOSE_DATE}`);
  console.log(`R6 残置: ${toKeep.length} 件`);
  console.log(`単位数変更 (同一コード): ${changed.length} 件`);
  console.log(`新規コード: ${added.length} 件`);
  console.log(`廃止コード (R6にあり R8に無い): ${removed.length} 件`);
  console.log(`units=0 扱い (Excel 単位数なし = 単価按分/率加算系): ${unitsNull} 件`);
  console.log(`short_name 引継: ${inheritShort} / 新規 null: ${inserts.length - inheritShort}`);
  console.log(`formula 引継: ${inheritFormula} 件 (内容は R6 のまま — 処遇改善率の改定は別途確認)`);
  console.log(`calculation_type: R6引継=${inheritCalc} / heuristic=${inserts.length - inheritCalc}`);
  console.log(`unit_type: Excel=${unitTypeFromExcel} / R6引継=${unitTypeFromR6} / 既定値=${unitTypeDefault}`);

  console.log("\n--- 単位数変更 サンプル (先頭 20 件) ---");
  for (const c of changed.slice(0, 20)) console.log(`  ${c.code} ${c.name}: ${c.r6} → ${c.r8}`);

  console.log("\n--- 廃止コード サンプル (先頭 20 件) ---");
  for (const o of removed.slice(0, 20)) console.log(`  ${o.service_code} ${o.service_name}`);

  // ---- 処遇改善 新区分 ----
  console.log("\n--- 処遇改善加算 新区分コード (新規のみ) ---");
  const shoguNew = added.filter((r) => r.service_name.includes("処遇改善"));
  for (const r of shoguNew) console.log(`  ${r.service_code} ${r.service_name} (units=${r.units})`);
  console.log(`計 ${shoguNew.length} 件`);
  const shoguRemoved = removed.filter((o) => o.service_name?.includes("処遇改善"));
  console.log(`処遇改善系の廃止 (R6→R8 で消えるコード): ${shoguRemoved.length} 件`);
  for (const o of shoguRemoved.slice(0, 30)) console.log(`  ${o.service_code} ${o.service_name}`);
  const formulaCodes = r6rows.filter((o) => o.formula);
  const formulaGone = formulaCodes.filter((o) => !r8map.has(o.service_code));
  console.log(
    `formula 保有 R6 コード: ${formulaCodes.length} 件 / うち R8 に存在せず失効: ${formulaGone.length} 件 (→ 新区分コードへの formula 再設定が必要か要確認)`
  );

  if (!EXECUTE) {
    console.log("\nDRY RUN 終了。実行するには --execute を付ける。");
    return;
  }

  // ================= EXECUTE =================
  console.log("\n=== INSERT 開始 ===");
  for (let i = 0; i < inserts.length; i += BATCH) {
    const batch = inserts.slice(i, i + BATCH);
    const res = await fetch(`${SB_URL}/rest/v1/kaigo_service_codes`, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      console.error(`INSERT failed at batch ${i / BATCH} (${res.status}):`, await res.text());
      console.error("中止。ここまでの INSERT 行は valid_from=2026-06-01 で特定して手動確認のこと。");
      process.exit(1);
    }
    console.log(`  inserted ${Math.min(i + BATCH, inserts.length)}/${inserts.length}`);
  }

  console.log("=== R6 クローズ (PATCH) ===");
  const catList = [...r8cats].sort().join(",");
  const patchRes = await fetch(
    `${SB_URL}/rest/v1/kaigo_service_codes?system=eq.${encodeURIComponent(SYSTEM)}&valid_from=eq.${OLD_VALID_FROM}&service_category=in.(${catList})`,
    {
      method: "PATCH",
      headers: { ...HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({ valid_until: CLOSE_DATE }),
    }
  );
  if (!patchRes.ok) {
    console.error(`PATCH failed (${patchRes.status}):`, await patchRes.text());
    process.exit(1);
  }

  // ---- 件数確認 ----
  console.log("=== 件数確認 ===");
  const check1 = await fetch(
    `${SB_URL}/rest/v1/kaigo_service_codes?select=service_code&system=eq.${encodeURIComponent(SYSTEM)}&valid_from=eq.${NEW_VALID_FROM}`,
    { headers: { ...HEADERS, Prefer: "count=exact", Range: "0-0" } }
  );
  console.log(`R8 行数: ${check1.headers.get("content-range")}`);
  const check2 = await fetch(
    `${SB_URL}/rest/v1/kaigo_service_codes?select=service_code&system=eq.${encodeURIComponent(SYSTEM)}&valid_from=eq.${OLD_VALID_FROM}&valid_until=eq.${CLOSE_DATE}`,
    { headers: { ...HEADERS, Prefer: "count=exact", Range: "0-0" } }
  );
  console.log(`R6 クローズ済 行数: ${check2.headers.get("content-range")}`);
  console.log("完了。");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
