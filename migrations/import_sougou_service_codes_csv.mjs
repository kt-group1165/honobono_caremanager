// ============================================================================
// 総合事業サービスコードを **国保連統一 CSV** から取り込む (自治体共通・汎用版)。
//
// ── なぜ汎用化したか ──────────────────────────────────────────────────
//   市原市 / 千葉市6区 / 木更津市 で同じ内容のスクリプトを 3 本書いていた。
//   四街道市 (4 本目) を足すにあたり 1 本にまとめる。
//   PDF しか無い自治体 (大網白里/山武/九十九里/袖ケ浦) は従来どおり
//   import_sougou_oamishirasato.mjs 系を使う。
//
// ── CSV の並び (col 24) ───────────────────────────────────────────────
//   0 保険者番号 / 1 サービス種類 (A2/A6/AF) / 2 サービス項目 (4桁)
//   3 適用開始 YYYYMM / 4 適用終了 YYYYMM (999999=無期限)
//   5 サービス内容略称 (全角空白 padding) / 6 単位数 / 7 算定単位区分
//
// ── 世代管理 ──────────────────────────────────────────────────────────
//   **現行 (999999) だけでなく全世代を入れる**。月遅れ・返戻の再請求で
//   validInMonth が過去月のコードを引けるようにするため。
//   UNIQUE(system, service_code, valid_from) の衝突は skip (冪等)。
//
// ── formula (処遇改善等の %加算) ──────────────────────────────────────
//   ⚠ CSV には率が載らず単位数列に「‰の分子」が入っているだけ。
//     formula が無いと aggregate-sougou が処遇改善を乗せられず**過少請求**になる
//     (市原で実際に起きた。fix_ichihara_sougou_formula.mjs で後追い修正した)。
//   → 率は国基準で市町村共通なので、**既存の他自治体版の同 suffix コード**から
//     同世代 (無ければ直近の過去世代) の formula を複製する。
//
//   CSV=<path> INSURER=<6桁> PREFIX=<XX_> CITY=<市名> \
//     node migrations/import_sougou_service_codes_csv.mjs            # DRY RUN
//   … --execute で投入
//
//   例) 四街道市:
//     CSV=サービスコード/四街道市/20260601.csv INSURER=122283 PREFIX=YT_ CITY=四街道市 \
//       node migrations/import_sougou_service_codes_csv.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import iconv from "encoding-japanese";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const SYSTEM = "総合事業";

const CSV = process.env.CSV;
const INSURER = process.env.INSURER;
const PREFIX = process.env.PREFIX;
const CITY = process.env.CITY || "";
if (!CSV || !INSURER || !PREFIX || !CITY) {
  console.error("✗ CSV / INSURER / PREFIX / CITY を指定してください");
  process.exit(1);
}
if (!/^[A-Z]+_$/.test(PREFIX)) { console.error(`✗ PREFIX は英大文字+_ で (例 YT_)。受け取り: ${PREFIX}`); process.exit(1); }

const CSV_PATH = path.isAbsolute(CSV) ? CSV : path.join(KAIGO, CSV);
if (!existsSync(CSV_PATH)) { console.error(`✗ CSV 不在: ${CSV_PATH}`); process.exit(1); }

const CAT_NAME = {
  A2: `訪問介護相当・独自サービス (${CITY})`,
  A6: `通所介護相当・独自サービス (${CITY})`,
  AF: `介護予防ケアマネジメント (${CITY})`,
};
// ⚠ 算定単位区分は自治体で桁が揃っていない (市原 "01/02/03" / 四街道 "1/2/3")。
//   ゼロ詰めを揃えずに引くと**月額包括コードが「1回につき」になり単位数が跳ね上がる**。
const UNIT_TYPE = { 1: "1回につき", 2: "1日につき", 3: "1月につき" };
const unitTypeOf = (raw) => UNIT_TYPE[Number.parseInt(raw, 10)] ?? null;
const NOTES = `${CITY} 総合事業 (保険者=${INSURER})`;

function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const lastDay = (y, m) => new Date(y, m, 0).getDate();

function parseCsv() {
  const text = iconv.convert(readFileSync(CSV_PATH), { to: "UNICODE", from: "SJIS", type: "string" });
  const out = [];
  let total = 0, otherInsurer = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split(",");
    if (c.length < 8) continue;
    total++;
    if (c[0].trim() !== INSURER) { otherInsurer++; continue; }
    const vf = c[3].trim(), vu = c[4].trim();
    const units = Number.parseInt(c[6], 10);
    out.push({
      cat: c[1].trim(),
      codeNum: c[2].trim(),
      name: c[5].replace(/[　\s]+$/, ""),
      units: Number.isFinite(units) ? units : null,
      unitTypeCode: c[7].trim(),
      validFrom: /^\d{6}$/.test(vf) ? `${vf.slice(0, 4)}-${vf.slice(4)}-01` : null,
      validUntil:
        vu !== "999999" && /^\d{6}$/.test(vu)
          ? `${vu.slice(0, 4)}-${vu.slice(4)}-${String(lastDay(+vu.slice(0, 4), +vu.slice(4))).padStart(2, "0")}`
          : null,
      isCurrent: vu === "999999",
    });
  }
  return { total, otherInsurer, rows: out };
}

function toRow(r) {
  const bare = `${r.cat}${r.codeNum}`;
  let calc = "基本";
  if (typeof r.units === "number" && r.units < 0) calc = "減算";
  else if (r.name.includes("加算")) calc = "加算";
  else if (r.name.includes("減算")) calc = "減算";
  return {
    system: SYSTEM,
    service_category: r.cat,
    service_category_name: CAT_NAME[r.cat] ?? `その他 ${r.cat} (${CITY})`,
    service_code: `${PREFIX}${bare}`,
    service_name: r.name,
    units: r.units,
    unit_type: unitTypeOf(r.unitTypeCode),
    calculation_type: calc,
    valid_from: r.validFrom,
    valid_until: r.validUntil,
    notes: NOTES,
    _bare: bare,
  };
}

async function fetchAll(table, cols, filt) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    let q = sb.from(table).select(cols).order("id").order("id").range(f, f + 999);
    if (filt) q = filt(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== ${CITY} 総合事業コード投入 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===`);
  console.log(`   CSV: ${path.relative(KAIGO, CSV_PATH)}`);
  console.log(`   保険者 ${INSURER} / prefix ${PREFIX}\n`);

  const { total, otherInsurer, rows: raw } = parseCsv();
  console.log(`CSV ${total} 行 / 他保険者 skip ${otherInsurer} / 抽出 ${raw.length}`);

  const byCat = {}, curByCat = {};
  for (const r of raw) {
    byCat[r.cat] = (byCat[r.cat] ?? 0) + 1;
    if (r.isCurrent) curByCat[r.cat] = (curByCat[r.cat] ?? 0) + 1;
  }
  for (const c of Object.keys(byCat).sort())
    console.log(`  ${c} ${CAT_NAME[c] ?? c}: 全世代 ${byCat[c]} / 現行 ${curByCat[c] ?? 0}`);

  const withUnits = raw.filter((r) => typeof r.units === "number");
  console.log(`\n単位数あり ${withUnits.length} / 単位数なし skip ${raw.length - withUnits.length}`);

  // (code, valid_from) で dedup
  const uniq = new Map();
  for (const r of withUnits) {
    const k = `${r.cat}${r.codeNum}|${r.validFrom ?? "null"}`;
    if (!uniq.has(k)) uniq.set(k, r);
  }
  const rows = [...uniq.values()].map(toRow);
  console.log(`(コード, 適用開始) で一意化: ${rows.length}`);

  // 算定単位区分を読めなかった行があれば中止 (推測で埋めると単位数を取り違える)
  const badUnit = rows.filter((r) => !r.unit_type);
  if (badUnit.length) {
    console.error(`\n✗ 中止: 算定単位区分を解釈できない行が ${badUnit.length} 件`);
    for (const r of badUnit.slice(0, 5)) console.error(`   ${r.service_code} ${r.service_name}`);
    process.exit(1);
  }
  const utDist = {};
  for (const r of rows) utDist[r.unit_type] = (utDist[r.unit_type] ?? 0) + 1;
  console.log(`算定単位: ${JSON.stringify(utDist)}`);

  // ── formula を他自治体版から複製 ──────────────────────────────────
  const ref = await fetchAll(
    "kaigo_service_codes",
    "service_code, valid_from, formula",
    (q) => q.eq("system", SYSTEM).not("formula", "is", null),
  );
  const bySuffix = new Map(); // 'A26184' -> [{valid_from, formula}] 昇順
  for (const r of ref) {
    if (r.service_code.startsWith(PREFIX)) continue; // 自分自身は参照しない
    const i = r.service_code.indexOf("_");
    const suffix = i > 0 ? r.service_code.slice(i + 1) : r.service_code;
    if (!bySuffix.has(suffix)) bySuffix.set(suffix, []);
    bySuffix.get(suffix).push({ valid_from: r.valid_from, formula: r.formula });
  }
  for (const list of bySuffix.values()) list.sort((a, b) => String(a.valid_from).localeCompare(String(b.valid_from)));

  let withFormula = 0;
  for (const r of rows) {
    const gens = bySuffix.get(r._bare);
    if (!gens?.length) continue;
    // 同世代 → 無ければ直近の過去世代 → 無ければ最古
    const same = gens.find((g) => g.valid_from === r.valid_from);
    const past = [...gens].reverse().find((g) => String(g.valid_from) <= String(r.valid_from));
    r.formula = (same ?? past ?? gens[0]).formula;
    withFormula++;
  }
  console.log(`formula 複製 (処遇改善等の%加算): ${withFormula} 行`);

  // ── 既存 (service_code, valid_from) の衝突を除く ──────────────────
  const existing = new Set();
  const codes = [...new Set(rows.map((r) => r.service_code))];
  for (let i = 0; i < codes.length; i += 300) {
    const d = await fetchAll("kaigo_service_codes", "service_code, valid_from", (q) =>
      q.eq("system", SYSTEM).in("service_code", codes.slice(i, i + 300)),
    );
    for (const r of d) existing.add(`${r.service_code}|${r.valid_from ?? "null"}`);
  }
  const toInsert = rows
    .filter((r) => !existing.has(`${r.service_code}|${r.valid_from ?? "null"}`))
    .map(({ _bare, ...rest }) => rest);
  console.log(`\n既存と衝突 skip ${rows.length - toInsert.length} / 新規 INSERT ${toInsert.length}`);

  console.log(`\nサンプル:`);
  for (const r of toInsert.slice(0, 8))
    console.log(
      `  ${r.service_code.padEnd(12)} ${String(r.units).padStart(6)}単位 ${r.unit_type.padEnd(8)}` +
        ` ${r.valid_from}~${r.valid_until ?? "現行"} ${r.formula ? "式あり " : "       "}${r.service_name}`,
    );

  if (!EXECUTE) { console.log(`\n※ DRY RUN。--execute で投入します。`); return; }
  if (!toInsert.length) { console.log(`\n新規なし。何もしません。`); return; }

  let n = 0;
  for (let i = 0; i < toInsert.length; i += 100) {
    const slice = toInsert.slice(i, i + 100);
    const { error } = await sb.from("kaigo_service_codes").insert(slice);
    if (error) {
      console.error(`✗ INSERT 失敗 (${i}〜): ${error.message}`);
      console.error(`  先頭: ${JSON.stringify(slice[0])}`);
      process.exit(1);
    }
    n += slice.length;
  }
  console.log(`\n✓ 完了: ${n} 行 INSERT`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
