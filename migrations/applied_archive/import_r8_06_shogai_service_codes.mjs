// 障害福祉サービスコード 令和8年6月改定版 (処遇改善加算見直し: Ⅰロ・Ⅱロ新設等) 取込
//
// 入手元: 厚労省「報酬算定構造・サービスコード表等」障害福祉 (令和8年6月施行分)
//   https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000174644_00022.html
//   - 001696436.xlsx (居宅介護〜生活介護)
//   - 001696437.xlsx (短期入所〜地域定着支援)
//   - 001696438.xlsx (児童発達支援〜医療型障害児入所施設)
//   ※ CSV 標準マスタは未配布 (xlsx コード表のみ) → xlsx を直接解析する
//
// 動作:
//   DRY RUN (既定): 解析件数 / カテゴリ別内訳 / 現行との差分 (単位数変更・新規・廃止) を表示。DB へは SELECT のみ。
//   --execute:
//     1. 現行行 (system='障害', valid_until IS NULL) を valid_until='2026-05-31' にクローズ
//     2. 新行 (valid_from='2026-06-01', valid_until=null) を batch 500 で INSERT
//        (既に 2026-06-01 行がある code は skip = 再実行 idempotent)
//
// 実行:
//   node --env-file=.env.local migrations/import_r8_06_shogai_service_codes.mjs             # DRY RUN
//   node --env-file=.env.local migrations/import_r8_06_shogai_service_codes.mjs --execute   # 本番
//   --dir="..." で xlsx 置き場を変更可
//
// 注意 (dry-run 出力にも出る):
//   - 処遇改善加算等の「率もの」コード (units=0) の formula (所定単位×N/1000) は
//     xlsx コード表に率が載っていないため自動生成できない。
//     既存行と service_code+service_name が完全一致する場合のみ旧 formula を継承し、
//     名称が変わった code (例: 処遇改善加算Ⅰ → Ⅰイ) は formula=null で入るので
//     手動 backfill が必要 → dry-run が対象一覧を出す。

import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("env missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)"); process.exit(1); }

const EXECUTE = process.argv.includes("--execute");
const dirArg = process.argv.find(a => a.startsWith("--dir="));
const XLSX_DIR = (dirArg ? dirArg.slice(6) : "C:/Users/domen-PC/AppData/Local/Temp/claude/C--Users-domen-PC-Downloads---------/ba129db7-65f4-4a0a-a09c-d1b505058c03/scratchpad/r8codes-shogai").replace(/\/+$/, "") + "/";
const FILES = ["001696436.xlsx", "001696437.xlsx", "001696438.xlsx"];

const NEW_VALID_FROM = "2026-06-01";
const CLOSE_DATE = "2026-05-31";
const NOTES = "令和8年6月改定 (処遇改善見直し)";
const BATCH = 500;

const sb = createClient(SB_URL, SB_KEY);

// 種類コード → カテゴリ名 fallback (既存 DB の多数派名を優先し、無い場合のみ使用)
const CATEGORY_NAMES = {
  "11": "居宅介護", "12": "重度訪問介護", "13": "行動援護", "14": "重度障害者等包括支援",
  "15": "同行援護", "21": "療養介護", "22": "生活介護", "24": "短期入所(福祉型)",
  "32": "施設入所支援", "33": "共同生活援助", "34": "宿泊型自立訓練", "35": "自立生活援助",
  "41": "自立訓練(機能訓練)", "42": "自立訓練(生活訓練)", "43": "就労移行支援",
  "44": "就労移行支援(養成)", "45": "就労継続支援A型", "46": "就労継続支援B型",
  "47": "就労定着支援", "48": "就労選択支援", "52": "計画相談支援", "53": "地域移行支援",
  "54": "地域定着支援", "55": "障害児相談支援", "61": "児童発達支援",
  "62": "医療型児童発達支援", "63": "放課後等デイサービス", "64": "保育所等訪問支援",
  "65": "居宅訪問型児童発達支援", "71": "福祉型障害児入所施設", "72": "医療型障害児入所施設",
};

// ─────────────────────────────────────────────────────
// xlsx 解析
// ─────────────────────────────────────────────────────
const SKIP_SHEET = /表紙|説明|名前定義/;

function cellVal(cell) {
  let v = cell.value;
  if (v == null) return null;
  if (typeof v === "object") {
    if (v.richText) v = v.richText.map(t => t.text).join("");
    else if (v.result !== undefined) v = v.result;
    else if (v.text !== undefined) v = v.text;
  }
  return v;
}
function cellStr(cell) {
  const v = cellVal(cell);
  return v == null ? "" : String(v).replace(/\s+/g, "");
}
// 全角数字 → 半角 (算定単位の正規化: １回につき → 1回につき)
function normUnitType(s) {
  if (!s) return null;
  return s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function parseSheet(ws) {
  // header 行 = col1 が「種類」の行
  let hdrRow = -1;
  for (let r = 1; r <= Math.min(12, ws.rowCount); r++) {
    if (cellStr(ws.getRow(r).getCell(1)) === "種類") { hdrRow = r; break; }
  }
  if (hdrRow < 0) return { error: "header(種類) が見つからない" };

  // 列検出: hdrRow / hdrRow-1 を走査して 合成単位数列 と 算定単位列 を探す
  let colAbbr = -1, colUnits = -1, colUnitType = -1;
  const rowH = ws.getRow(hdrRow), rowH1 = ws.getRow(hdrRow - 1);
  for (let c = 1; c <= ws.columnCount; c++) {
    const a = cellStr(rowH1.getCell(c)), b = cellStr(rowH.getCell(c));
    if (colAbbr < 0 && (a.includes("略称") || b.includes("略称"))) colAbbr = c;
    if (colUnits < 0 && (a.includes("合成") || a === "単位数" || b === "単位数" || a === "合成単位数" || b === "合成単位数")) colUnits = c;
    if (colUnitType < 0 && ((a === "算定" && b === "単位") || a === "算定単位" || b === "算定単位")) colUnitType = c;
  }
  if (colUnitType < 0) { // fallback: units 列より右の「単位」cell
    for (let c = (colUnits > 0 ? colUnits + 1 : 4); c <= ws.columnCount; c++) {
      if (cellStr(rowH.getCell(c)) === "単位") { colUnitType = c; break; }
    }
  }
  if (colAbbr < 0) colAbbr = 3;
  if (colUnits < 0) return { error: `単位数列が見つからない (hdrRow=${hdrRow})` };

  const rows = [];
  let lastUnitType = null;
  for (let r = hdrRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const kind = cellStr(row.getCell(1));
    const item = cellStr(row.getCell(2));
    // 種類 = 2桁数字 / 項目 = 4桁英数字 (例: 1111, H501, Z011, ZZ03)
    if (!/^\d{2}$/.test(kind) || !/^[0-9A-Z]{4}$/.test(item)) continue;
    const abbr = String(cellVal(row.getCell(colAbbr)) ?? "").trim();
    if (!abbr) continue;
    let units = cellVal(row.getCell(colUnits));
    if (typeof units === "string") units = units.replace(/[,，\s]/g, "").replace(/[▲△]/, "-");
    let n = units === null || units === "" ? null : Number(units);
    // 既存 DB 規約: units は正値 + calculation_type='減算' で表現 (負値は絶対値化)
    let wasNegative = false;
    if (Number.isFinite(n) && n < 0) { n = Math.abs(n); wasNegative = true; }
    const ut = normUnitType(cellStr(row.getCell(colUnitType >= 0 ? colUnitType : 0)));
    if (ut) lastUnitType = ut;
    rows.push({
      code: kind + item,
      category: kind,
      name: abbr,
      units: Number.isFinite(n) ? n : null,   // null = 率もの (単位加算/単位減算) → 後で 0 に
      unitType: ut || lastUnitType,           // 縦結合 cell は直前値を引き継ぐ
      wasNegative,
      sheet: ws.name,
    });
  }
  return { rows };
}

async function parseAll() {
  const byCode = new Map();
  const conflicts = [];
  let rawRows = 0;
  for (const f of FILES) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.readFile(XLSX_DIR + f);
    } catch (e) {
      console.error(`❌ ${XLSX_DIR}${f} を読めない: ${e.message}`);
      console.error("   厚労省ページから 3 ファイルを DL して --dir= で場所を指定すること");
      process.exit(1);
    }
    wb.eachSheet(ws => {
      if (SKIP_SHEET.test(ws.name)) return;
      const p = parseSheet(ws);
      if (p.error) { console.warn(`  ⚠ sheet skip: ${f} / ${ws.name} : ${p.error}`); return; }
      rawRows += p.rows.length;
      for (const x of p.rows) {
        const prev = byCode.get(x.code);
        if (prev) {
          // シート間重複 (増分/補正シート等)。内容一致なら無視、不一致は conflict
          if (prev.name !== x.name || prev.units !== x.units) conflicts.push({ prev, next: x });
        } else {
          byCode.set(x.code, x);
        }
      }
    });
  }
  return { byCode, conflicts, rawRows };
}

// ─────────────────────────────────────────────────────
// DB fetch (SELECT のみ / 1000 行 paginate)
// ─────────────────────────────────────────────────────
async function fetchAllRows(filter, cols) {
  const out = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await sb.from("kaigo_service_codes")
      .select(cols)
      .eq("system", "障害")
      .order("id")
      .range(offset, offset + 999)
      .filter(...filter);
    if (error) { console.error("SELECT 失敗:", error.message); process.exit(1); }
    out.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return out;
}

// ─────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────
async function main() {
  console.log("📂 障害福祉サービスコード 令和8年6月改定版 取込");
  console.log(`   xlsx: ${XLSX_DIR}{${FILES.join(", ")}}`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE" : "🔍 DRY RUN (DB へは SELECT のみ)");

  // 1. xlsx 解析
  const { byCode, conflicts, rawRows } = await parseAll();
  console.log(`\n■ 解析: raw ${rawRows} 行 → uniq ${byCode.size} code (シート間重複 ${rawRows - byCode.size - conflicts.length} は同一内容)`);
  if (conflicts.length) {
    console.error(`❌ シート間で内容が食い違う code が ${conflicts.length} 件。要調査:`);
    conflicts.slice(0, 10).forEach(c => console.error(`   ${c.prev.code}: [${c.prev.sheet}] ${c.prev.name}/${c.prev.units} vs [${c.next.sheet}] ${c.next.name}/${c.next.units}`));
    process.exit(1);
  }

  // sanity check (Level 1): 主要コードの存在
  const sanity = [
    ["111111", "身体日０．５ (居宅介護)"],
    ["121171", "重訪Ⅰ日中１．０ (重度訪問介護)"],
  ];
  for (const [code, label] of sanity) {
    if (!byCode.has(code)) { console.error(`❌ sanity check 失敗: ${code} ${label} が解析結果に無い`); process.exit(1); }
  }
  if (byCode.size < 90000) { console.error(`❌ sanity check 失敗: 解析件数 ${byCode.size} < 90,000 (取りこぼし疑い)`); process.exit(1); }

  // 2. 現行行 fetch
  const CUR_COLS = "id,service_code,service_category,service_category_name,service_name,units,unit_type,calculation_type,short_name,formula,notes";
  const current = await fetchAllRows(["valid_until", "is", null], CUR_COLS);
  const curByCode = new Map();
  const customRows = [];  // 非公式 code (7桁 baseline seed / fake marker)
  for (const r of current) {
    if (/^\d{2}[0-9A-Z]{4}$/.test(r.service_code) && r.service_code.length === 6 && !(r.notes ?? "").includes("[fake")) {
      curByCode.set(r.service_code, r);
    } else {
      customRows.push(r);
    }
  }
  console.log(`\n■ 現行 (valid_until IS NULL): ${current.length} 件`);
  console.log(`   公式 6桁 code: ${curByCode.size} 件 / 独自 seed (7桁 baseline 等): ${customRows.length} 件`);

  // 既に 2026-06-01 の行があるか (idempotent 用)
  const already = await fetchAllRows(["valid_from", "eq", NEW_VALID_FROM], "service_code");
  const alreadySet = new Set(already.map(r => r.service_code));
  if (alreadySet.size) console.log(`   ※ valid_from=${NEW_VALID_FROM} が既に ${alreadySet.size} 件存在 (INSERT では skip)`);

  // カテゴリ名: 既存 DB の多数派を優先
  const catNameMajority = new Map(); // cat -> Map(name -> n)
  for (const r of current) {
    if (!catNameMajority.has(r.service_category)) catNameMajority.set(r.service_category, new Map());
    const m = catNameMajority.get(r.service_category);
    m.set(r.service_category_name, (m.get(r.service_category_name) ?? 0) + 1);
  }
  const catName = c => {
    const m = catNameMajority.get(c);
    if (m) return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return CATEGORY_NAMES[c] ?? null;
  };

  // 新規 code の short_name fallback 用: (category, 名称先頭2文字) → 多数派 short_name
  const snMajority = new Map();
  for (const r of current) {
    if (!r.short_name) continue;
    const k = r.service_category + "::" + r.service_name.slice(0, 2);
    if (!snMajority.has(k)) snMajority.set(k, new Map());
    const m = snMajority.get(k);
    m.set(r.short_name, (m.get(r.short_name) ?? 0) + 1);
  }
  const snFallback = (cat, name) => {
    const m = snMajority.get(cat + "::" + name.slice(0, 2));
    if (!m) return null;
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };

  // calculation_type heuristic (既存に無い新規 code 用)
  const calcType = (x) => {
    const sheetDown = /定超|欠員|人欠|責欠/.test(x.sheet);
    if (x.wasNegative || x.name.includes("減") || x.name.includes("未計画") || sheetDown) return "減算";
    if (x.name.includes("加算") || x.name.includes("処遇")) return "加算";
    return "基本";
  };

  // 3. 新行の組み立て + 差分集計
  const inserts = [];
  const diff = { added: [], removed: [], unitsChanged: [], nameChanged: [], formulaLost: [] };
  const catStat = new Map(); // cat -> {nu, cur}
  for (const [code, x] of byCode) {
    const cur = curByCode.get(code);
    const sameName = cur && cur.service_name === x.name;
    const row = {
      system: "障害",
      service_code: code,
      service_category: x.category,
      service_category_name: catName(x.category),
      service_name: x.name,
      units: x.units ?? 0,                       // 率もの (単位加算/単位減算) は 0 (既存 DB 流儀)
      unit_type: x.unitType ?? cur?.unit_type ?? null,
      calculation_type: cur ? cur.calculation_type : calcType(x),
      short_name: cur?.short_name ?? snFallback(x.category, x.name),
      // formula (処遇改善の 所定単位×N/1000 等) は xlsx に率が無いので
      // code+名称 完全一致のときのみ旧行から継承。名称が変わったものは手動 backfill 対象。
      formula: sameName ? (cur.formula ?? null) : null,
      valid_from: NEW_VALID_FROM,
      valid_until: null,
      notes: NOTES,
    };
    inserts.push(row);

    const cs = catStat.get(x.category) ?? { nu: 0, cur: 0 };
    cs.nu++; catStat.set(x.category, cs);
    if (!cur) diff.added.push(row);
    else {
      if (cur.units !== row.units) diff.unitsChanged.push({ code, name: x.name, old: cur.units, nu: row.units });
      if (!sameName) diff.nameChanged.push({ code, old: cur.service_name, nu: x.name });
      if (cur.formula && !row.formula) diff.formulaLost.push({ code, old: cur.service_name, nu: x.name });
    }
  }
  for (const [code, r] of curByCode) {
    const cs = catStat.get(r.service_category) ?? { nu: 0, cur: 0 };
    cs.cur++; catStat.set(r.service_category, cs);
    if (!byCode.has(code)) diff.removed.push(r);
  }

  // 4. dry-run レポート
  console.log(`\n■ カテゴリ別内訳 (R8/6 新版 vs 現行公式コード)`);
  console.log("   cat  カテゴリ名               新版      現行     差");
  for (const [cat, s] of [...catStat.entries()].sort()) {
    const d = s.nu - s.cur;
    console.log(`   ${cat}   ${(catName(cat) ?? "?").padEnd(14, "　")} ${String(s.nu).padStart(6)} ${String(s.cur).padStart(8)} ${(d >= 0 ? "+" : "") + d}`);
  }

  const negCount = [...byCode.values()].filter(x => x.wasNegative).length;
  if (negCount) console.log(`\n   ※ コード表上 負値 (▲) の units を絶対値化: ${negCount} 件 (DB 規約: 正値 + calculation_type='減算')`);

  console.log(`\n■ 差分サマリ`);
  console.log(`   INSERT 予定 (valid_from=${NEW_VALID_FROM}) : ${inserts.length} 件`);
  console.log(`   ├ 新規 code                              : ${diff.added.length} 件`);
  console.log(`   ├ 単位数変更                             : ${diff.unitsChanged.length} 件`);
  console.log(`   ├ 名称変更 (code 同一)                   : ${diff.nameChanged.length} 件`);
  console.log(`   └ formula 継承不可 (手動 backfill 必要)  : ${diff.formulaLost.length} 件`);
  console.log(`   廃止 (現行にあり新版に無い code)         : ${diff.removed.length} 件`);
  console.log(`   クローズ予定 (valid_until→${CLOSE_DATE})   : ${current.length} 件 (独自 seed ${customRows.length} 件を含む)`);

  const show = (arr, fmt, n = 20) => arr.slice(0, n).forEach(x => console.log("     " + fmt(x)));

  console.log(`\n■ 新規 code (処遇改善見直し関連を優先表示)`);
  const shoguNew = diff.added.filter(r => r.service_name.includes("処遇"));
  console.log(`   処遇改善系の新規: ${shoguNew.length} 件`);
  show(shoguNew, r => `${r.service_code} ${r.service_name} (${r.units}${r.unit_type ? " / " + r.unit_type : ""})`, 30);
  const otherNew = diff.added.filter(r => !r.service_name.includes("処遇"));
  console.log(`   その他の新規: ${otherNew.length} 件 (先頭 20)`);
  show(otherNew, r => `${r.service_code} ${r.service_name} (${r.units})`);

  console.log(`\n■ 単位数変更 (先頭 20)`);
  show(diff.unitsChanged, x => `${x.code} ${x.name}: ${x.old} → ${x.nu}`);

  console.log(`\n■ 名称変更 (先頭 20)`);
  show(diff.nameChanged, x => `${x.code}: ${x.old} → ${x.nu}`);

  console.log(`\n■ 廃止 code (先頭 20)`);
  show(diff.removed, r => `${r.service_code} ${r.service_name}`);

  console.log(`\n■ formula 手動 backfill 対象 (旧行に formula あり・名称変更で継承せず)`);
  show(diff.formulaLost, x => `${x.code}: ${x.old} → ${x.nu}`, 40);

  // 要件 4: 居宅介護(11) / 重度訪問介護(12) の確認
  console.log(`\n■ 確認: 居宅介護(11) / 重度訪問介護(12) 代表コード`);
  for (const code of ["111111", "111115", "111121", "121171", "121181", "115120", "115174", "125120", "125174"]) {
    const nu = inserts.find(r => r.service_code === code);
    const cur = curByCode.get(code);
    if (nu) console.log(`   ${code} ${nu.service_name.padEnd(16, "　")} units=${String(nu.units).padStart(5)} ${nu.unit_type ?? "?"} [現行: ${cur ? `${cur.service_name}/${cur.units}` : "無し (新規)"}]`);
  }
  const c11 = inserts.filter(r => r.service_category === "11").length;
  const c12 = inserts.filter(r => r.service_category === "12").length;
  console.log(`   居宅介護(11) 計 ${c11} 件 / 重度訪問介護(12) 計 ${c12} 件`);

  if (!EXECUTE) {
    console.log("\n🔍 DRY RUN 完了 (DB 変更なし)。実行するには --execute を付ける。");
    return;
  }

  // ───────────────────────────────────────────────
  // EXECUTE
  // ───────────────────────────────────────────────
  console.log(`\n⚠️  EXECUTE: 現行 ${current.length} 件をクローズ → ${inserts.length} 件 INSERT`);

  // 1. 現行行クローズ (category 単位で batch UPDATE、error check 必須)
  let closed = 0;
  const cats = [...new Set(current.map(r => r.service_category))].sort();
  for (const cat of cats) {
    const { data, error } = await sb.from("kaigo_service_codes")
      .update({ valid_until: CLOSE_DATE })
      .eq("system", "障害")
      .eq("service_category", cat)
      .is("valid_until", null)
      .lt("valid_from", NEW_VALID_FROM)   // 念のため: 2026-06-01 行を巻き込まない
      .select("id");
    if (error) { console.error(`❌ クローズ失敗 (cat=${cat}):`, error.message); process.exit(1); }
    closed += data.length;
    console.log(`   closed cat=${cat}: ${data.length}`);
  }
  console.log(`   クローズ合計: ${closed} 件 (想定 ${current.length})`);
  if (closed !== current.length) console.warn(`   ⚠ クローズ件数が想定と不一致 (差 ${current.length - closed})`);

  // 1.5 独自 seed (7桁 baseline / fake marker) はクローズ対象外 → valid_until を null に戻す
  //     (公式 R8/6 コード表に無い自社データのため、6月以降も継続有効にする)
  if (customRows.length > 0) {
    let restored = 0;
    for (let i = 0; i < customRows.length; i += BATCH) {
      const ids = customRows.slice(i, i + BATCH).map(r => r.id);
      const { data, error } = await sb.from("kaigo_service_codes")
        .update({ valid_until: null })
        .in("id", ids)
        .select("id");
      if (error) { console.error("❌ 独自seed 復元失敗:", error.message); process.exit(1); }
      restored += data.length;
    }
    console.log(`   独自 seed 復元 (valid_until→null): ${restored} 件 (想定 ${customRows.length})`);
  }

  // 2. 新行 INSERT (batch 500 / 既存 2026-06-01 は skip)
  const toInsert = inserts.filter(r => !alreadySet.has(r.service_code));
  console.log(`   INSERT: ${toInsert.length} 件 (skip ${inserts.length - toInsert.length})`);
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const slice = toInsert.slice(i, i + BATCH);
    const { error } = await sb.from("kaigo_service_codes").insert(slice);
    if (error) {
      console.error(`❌ INSERT 失敗 (offset ${i}):`, error.message);
      console.error("   先頭 row:", JSON.stringify(slice[0]));
      process.exit(1);
    }
    if ((i / BATCH) % 20 === 0 || i + BATCH >= toInsert.length) console.log(`   ✅ ${Math.min(i + BATCH, toInsert.length)}/${toInsert.length}`);
  }

  // 3. 件数確認
  const { count, error: cntErr } = await sb.from("kaigo_service_codes")
    .select("id", { count: "exact", head: true })
    .eq("system", "障害").eq("valid_from", NEW_VALID_FROM);
  if (cntErr) { console.error("件数確認失敗:", cntErr.message); process.exit(1); }
  console.log(`\n✅ 完了: valid_from=${NEW_VALID_FROM} 現在 ${count} 件 (期待 ${inserts.length})`);
  if (diff.formulaLost.length) console.log(`⚠ formula 手動 backfill が ${diff.formulaLost.length} 件残っている (処遇改善加算の率設定)`);
}

main().catch(e => { console.error(e); process.exit(1); });
