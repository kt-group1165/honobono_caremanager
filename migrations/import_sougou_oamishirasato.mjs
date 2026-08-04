// ============================================================================
// 大網白里市 総合事業サービスコード投入 (prefix OA_, 保険者122390)
//   源: サービスコード/大網白里市/oamishirasato_servicecode_R8.06.01.pdf (令和8年6月1日版)
//   単位数 = PDF の実値 (大網白里市の独自単位。A21111=1176/A22511=179 等)。
//   名称/単位種別/計算区分 = 既存DB総合コード(全prefix横断)の項目構造で補完 (全国共通構造)。
//     PDFで単位が読めない項目(処遇改善6xxx等=全国一律率)はDB辞書の単位で補完。
//   ※ PDF抽出は migrations/_oa_pdf_units.json (python fitz で事前生成) を読む。
//
//   node migrations/import_sougou_oamishirasato.mjs            # DRY RUN
//   node migrations/import_sougou_oamishirasato.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const SYSTEM = "総合事業";
const PREFIX = process.env.PREFIX || "OA_";
const NOTES = process.env.NOTES || "大網白里市 総合事業(122390) R8.6.1";
const UNITS_JSON = process.env.UNITS_JSON || "migrations/_oa_pdf_units.json";
const VALID_FROM = "2026-06-01";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function main() {
  console.log(`=== 大網白里市 総合コード投入 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const pdf = JSON.parse(readFileSync(path.join(KAIGO, UNITS_JSON), "utf8")); // {A2xxxx: units|null}

  // DB辞書: 全prefixの総合コードから 項目(prefix除去) -> {name,unit_type,calc,units} を集める
  const all = []; for (let f = 0; ; f += 1000) { const { data, error } = await sb.from("kaigo_service_codes").select("service_code,service_name,service_category_name,unit_type,calculation_type,units,formula").eq("system", SYSTEM).range(f, f + 999); if (error) throw error; all.push(...data); if (data.length < 1000) break; }
  const dict = {}; for (const r of all) { const bare = r.service_code.replace(/^[A-Z]+_/, ""); if (!dict[bare]) dict[bare] = r; }

  const payloads = []; const missing = [];
  for (const [code, pdfUnits] of Object.entries(pdf)) {
    const ref = dict[code];
    if (!ref) { missing.push(code); continue; } // DB辞書に無い項目 (名称/種別不明) はスキップ
    const cat = code.slice(0, 2); // A2/A6/AF/A4
    const units = pdfUnits != null ? pdfUnits : ref.units; // PDF優先、無ければDB(全国率)
    payloads.push({
      system: SYSTEM,
      service_category: cat,
      service_category_name: (ref.service_category_name ?? `総合事業 ${cat}`).replace(/\(.*?\)\s*$/, `(${NOTES.split(" ")[0]})`),
      service_code: `${PREFIX}${code}`,
      service_name: ref.service_name,
      units,
      unit_type: ref.unit_type,
      calculation_type: ref.calculation_type,
      formula: ref.formula ?? null, // 処遇改善等の率 (monthly_aggregate)。MB_等と同等に写す
      valid_from: VALID_FROM,
      valid_until: null,
      notes: NOTES,
      _src: pdfUnits != null ? "PDF" : "DB補完",
    });
  }
  // A2系だけ抜粋表示 (訪問介護officeが使う)
  const a2 = payloads.filter((p) => p.service_category === "A2");
  console.log(`投入対象: ${payloads.length}件 (A2訪問=${a2.length} / A6通所等=${payloads.length - a2.length})`);
  console.log(`  DB辞書に無くスキップ: ${missing.length}件 ${missing.length ? "(" + missing.join(",") + ")" : ""}`);
  console.log("  A2主要コード:");
  for (const c of ["A21111", "A21211", "A21321", "A22411", "A22511", "A22621", "A26184"]) {
    const p = a2.find((x) => x.service_code === PREFIX + c);
    if (p) console.log(`    ${p.service_code} ${p.units}単位 ${p.unit_type} ${p.calculation_type} [${p._src}]`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で 既存OA_削除→投入。"); return; }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest 除外用 (_src を落として INSERT)
  const rows = payloads.map(({ _src, ...r }) => r);
  const { error: delErr } = await sb.from("kaigo_service_codes").delete().eq("system", SYSTEM).like("service_code", `${PREFIX}%`);
  if (delErr) { console.error(`✗ 既存OA_削除失敗: ${delErr.message}`); process.exit(1); }
  const { error } = await sb.from("kaigo_service_codes").insert(rows);
  if (error) { console.error(`✗ 投入失敗: ${error.message}`); process.exit(1); }
  console.log(`\n✓ 完了: ${rows.length}件 (OA_)`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
