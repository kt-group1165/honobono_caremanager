/**
 * 介護 (訪問介護) 伝送 突合ハーネス (READ ONLY — DB 書込一切なし)
 *
 * 大網・2026-06 の介護給付費請求 (7111/7131 様式第二) について、新システムの伝送を
 * ヘッドレス生成し (アプリ起動せず aggregate.ts / build.ts を直接呼ぶ)、ほのぼのの
 * 正解伝送 KK260701 と被保険者番号別にフィールド突合する。
 *
 * 実行:  npx tsx scripts/kaigo-densou-diff.mts
 *   env: OFFICE_ID / AREA_DIR で事業所切替 (既定=大網)
 *   出力: 伝送データ/{AREA}/訪問介護/202606/新システム/ (SJIS) + 標準出力に diff レポート
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Encoding from "encoding-japanese";
import { aggregateMonthlyVisitSeikyu } from "@/lib/visit-seikyu/aggregate";
import { buildKokuhoDensou, type DensouRow } from "@/lib/kokuho-densou/build";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 対象 ─────────────────────────────────────────────────────────────────────
const YEAR = 2026;
const MONTH = 6;
const OFFICE_ID = process.env.OFFICE_ID || "269d77bc-5b61-4114-a2ea-e8dc2f220823"; // 大網
const AREA_DIR = process.env.AREA_DIR || "大網";
// DENSOU_DIR … 伝送データ/ 以下の相対パス。正規形は <拠点>/訪問介護/介護/<YYYYMM>。事業所ごとに
//   フォルダ構成が揃っていないため、丸ごと指定できるようにしている (shogai 側と同じ)。
const DENSOU_BASE = process.env.DENSOU_DIR
  ? join(__dirname, "..", "伝送データ", ...process.env.DENSOU_DIR.split("/"))
  : join(__dirname, "..", "伝送データ", AREA_DIR, "訪問介護", "介護", "202606");
// ほのぼの実伝送の置き場も揃っていない (ほのぼのから / ほのぼの)
const HONOBONO_DIR = join(DENSOU_BASE, process.env.HONOBONO_SUBDIR || "ほのぼのから");
const OUT_DIR = join(DENSOU_BASE, "新システム");
const HONOBONO_KK = process.env.KK_FILE || "KK260701.CSV";

// ─── env ──────────────────────────────────────────────────────────────────────
function loadEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
    const vars: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envFile = loadEnvLocal();
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? envFile.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? envFile.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("env 不足: .env.local の SUPABASE URL/SERVICE_ROLE_KEY が必要");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// ─── SJIS 書き出し ────────────────────────────────────────────────────────────
function writeSjis(dir: string, fileName: string, content: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sjis = Encoding.convert(Encoding.stringToCode(content), { to: "SJIS", from: "UNICODE" });
  writeFileSync(join(dir, fileName), Buffer.from(sjis));
}

// ─── CSV パース ───────────────────────────────────────────────────────────────
interface PRow { seq: string; cols: string[] } // cols = col2 以降 (cols[0]=識別番号 7111/7131)
interface ParsedFile { control: string[]; rows: PRow[]; end: string[] }

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}
function toParsed(lines: string[], split: (l: string) => string[]): ParsedFile {
  let control: string[] = [], end: string[] = [];
  const rows: PRow[] = [];
  for (const line of lines) {
    const c = split(line);
    if (c[0] === "1") control = c;
    else if (c[0] === "3") end = c;
    else if (c[0] === "2") rows.push({ seq: c[1], cols: c.slice(2) });
  }
  return { control, rows, end };
}
function parseDensou(path: string): ParsedFile {
  const buf = readFileSync(path);
  const text = Encoding.codeToString(Encoding.convert(new Uint8Array(buf), { to: "UNICODE", from: "SJIS" }));
  return toParsed(text.split(/\r\n|\n/).filter((l) => l.length > 0), splitCsvLine);
}
function parseContent(content: string): ParsedFile {
  return toParsed(content.split(/\r\n|\n/).filter((l) => l.length > 0), (l) => l.split(","));
}

// ─── 突合ユーティリティ ──────────────────────────────────────────────────────
const unq = (s: string | undefined) => (s ?? "").replace(/^"|"$/g, "").trim();
const N = (s: string | undefined) => {
  const n = Number(unq(s));
  return Number.isFinite(n) ? n : 0;
};

// 7131 レコードを 種別(01/02/10) で分ける。cols[0]='7131', cols[1]=種別。
// 基本01/集計10 のキー = 被保険者番号(cols[5]) + 証記載保険者(cols[4])
const insKey = (c: string[]) => `${unq(c[4])}|${unq(c[5])}`;

async function main() {
  console.log(`===== 介護 (訪問介護) 伝送 突合 ${AREA_DIR} ${YEAR}-${String(MONTH).padStart(2, "0")} =====\n`);

  // ── office ──
  const { data: o, error: oe } = await sb
    .from("offices")
    .select("name, business_number, unit_price, area_category, applied_formula_codes, tenant_id")
    .eq("id", OFFICE_ID)
    .maybeSingle();
  if (oe || !o) { console.error("事業所取得失敗:", oe?.message); process.exit(1); }
  const officeNumber = ((o.business_number ?? "") as string).trim();
  const unitPrice = (o.unit_price ?? 10) as number;
  const appliedFormulaCodes = (o.applied_formula_codes ?? []) as string[];
  const tenantId = (o.tenant_id ?? "kt-group") as string;
  console.log(`office: ${o.name} / 事業所番号=${officeNumber} / 単価=${unitPrice} (${o.area_category}) / formula=${JSON.stringify(appliedFormulaCodes)}`);

  // ── 新システム: 集計 → 生成 ──
  const agg = await aggregateMonthlyVisitSeikyu(sb, {
    officeId: OFFICE_ID, tenantId, year: YEAR, month: MONTH, unitPrice, appliedFormulaCodes,
  });
  console.log(`aggregate: rows=${agg.rows.length} recordCount=${agg.recordCount} warnings=${agg.warnings.length}`);
  for (const w of agg.warnings.slice(0, 8)) console.log("  ⚠", w);

  const res = buildKokuhoDensou(agg.rows as DensouRow[], {
    officeNumber, year: YEAR, month: MONTH, unitPrice, seikyuYear: YEAR, seikyuMonth: MONTH,
  });
  writeSjis(OUT_DIR, res.fileName, res.content);
  console.log(`\n新システム出力: ${res.fileName} (dataRows=${res.dataRecordCount}) → ${OUT_DIR}`);
  for (const w of res.warnings.slice(0, 8)) console.log("  ⚠", w);

  const nw = parseContent(res.content);
  const hb = parseDensou(join(HONOBONO_DIR, HONOBONO_KK));

  // ── エンベロープ ──
  console.log("\n===== エンベロープ =====");
  const envF = (p: ParsedFile) => `件数=${p.control[3]} 種別=${p.control[4]} 事業所=${p.control[6]} 処理年月=${p.control[9]} 媒体=${p.control[8]}`;
  console.log("  新:", envF(nw));
  console.log("  ほ:", envF(hb));
  const kindCount = (p: ParsedFile) => {
    const m: Record<string, number> = {};
    for (const r of p.rows) { const k = `${unq(r.cols[0])}-${unq(r.cols[1])}`; m[k] = (m[k] ?? 0) + 1; }
    return m;
  };
  console.log("  新レコ内訳:", JSON.stringify(kindCount(nw)));
  console.log("  ほレコ内訳:", JSON.stringify(kindCount(hb)));

  // ── 7111 請求書 (保険公費区分 × 法別番号) ──
  console.log("\n===== 7111 請求書 =====");
  const g7111 = (p: ParsedFile) => {
    const m = new Map<string, string[]>();
    for (const r of p.rows) if (unq(r.cols[0]) === "7111") m.set(`区分${unq(r.cols[3])}-法別${unq(r.cols[4])}`, r.cols);
    return m;
  };
  const n11 = g7111(nw), h11 = g7111(hb);
  const keys11 = [...new Set([...n11.keys(), ...h11.keys()])].sort();
  for (const k of keys11) {
    const a = n11.get(k), b = h11.get(k);
    if (!a) { console.log(`  ${k}: ★新に無し (ほ 件数=${N(b![6])})`); continue; }
    if (!b) { console.log(`  ${k}: ★ほに無し (新 件数=${N(a[6])})`); continue; }
    const flds: [string, number][] = [["件数", 6], ["単位数", 7], ["費用", 8], ["保険請求", 9], ["公費請求", 10], ["利用者負担", 11]];
    const d = flds.filter(([, i]) => N(a[i]) !== N(b[i])).map(([nm, i]) => `${nm} 新=${N(a[i])} ほ=${N(b[i])}`);
    console.log(`  ${k}: ${d.length ? "✗ " + d.join(" / ") : "✓ 一致"}`);
  }

  // ── 7131 明細書 (被保険者番号別: 基本01 + 集計10 + 明細02) ──
  console.log("\n===== 7131 明細書 (被保険者別) =====");
  const pick = (p: ParsedFile, kind: string) =>
    p.rows.filter((r) => unq(r.cols[0]) === "7131" && unq(r.cols[1]) === kind);
  const mapBy = (rows: PRow[]) => { const m = new Map<string, string[]>(); for (const r of rows) m.set(insKey(r.cols), r.cols); return m; };
  const nBasic = mapBy(pick(nw, "01")), hBasic = mapBy(pick(hb, "01"));
  const nSum = mapBy(pick(nw, "10")), hSum = mapBy(pick(hb, "10"));
  // 明細02: 被保番 → コード別集計
  const codeMap = (rows: PRow[]) => {
    const m = new Map<string, Map<string, { count: number; units: number }>>();
    for (const r of rows) {
      const k = insKey(r.cols);
      if (!m.has(k)) m.set(k, new Map());
      const code = `${unq(r.cols[6])}${unq(r.cols[7])}`;
      const cur = m.get(k)!.get(code) ?? { count: 0, units: 0 };
      cur.count += N(r.cols[9]); cur.units += N(r.cols[13]);
      m.get(k)!.set(code, cur);
    }
    return m;
  };
  const nCode = codeMap(pick(nw, "02")), hCode = codeMap(pick(hb, "02"));

  const allIns = [...new Set([...nBasic.keys(), ...hBasic.keys()])].sort();
  let match = 0; const mism: string[] = []; const onlyNew: string[] = []; const onlyHb: string[] = [];
  for (const k of allIns) {
    const a = nBasic.get(k), b = hBasic.get(k);
    if (!a) { onlyHb.push(k); continue; }
    if (!b) { onlyNew.push(k); continue; }
    const diffs: string[] = [];
    // 基本01: 保険給付率28 / 合計単位32 / 請求額33 / 利用者負担34
    for (const [nm, i] of [["給付率", 28], ["合計単位", 32], ["請求額", 33], ["利用者負担", 34]] as [string, number][])
      if (N(a[i]) !== N(b[i])) diffs.push(`${nm} 新=${N(a[i])} ほ=${N(b[i])}`);
    // 集計10: 実日数7 / 限度対象9 / 対象外10 / 保険単位合計13 / 単価14 / 保険請求15 / 利用者16
    const as = nSum.get(k), bs = hSum.get(k);
    if (as && bs)
      for (const [nm, i] of [["実日数", 7], ["限度対象", 9], ["対象外", 10], ["保険単位計", 13], ["単価", 14], ["保険請求", 15], ["利用者", 16]] as [string, number][])
        if (N(as[i]) !== N(bs[i])) diffs.push(`集計:${nm} 新=${N(as[i])} ほ=${N(bs[i])}`);
    // 明細02 コード別
    const ac = nCode.get(k) ?? new Map(), bc = hCode.get(k) ?? new Map();
    for (const code of new Set([...ac.keys(), ...bc.keys()])) {
      const x = ac.get(code), y = bc.get(code);
      if (!x) diffs.push(`code ${code}: 新に無し (ほ 回=${y!.count} 単位=${y!.units})`);
      else if (!y) diffs.push(`code ${code}: ほに無し (新 回=${x.count} 単位=${x.units})`);
      else if (x.count !== y.count || x.units !== y.units) diffs.push(`code ${code} 回 新=${x.count} ほ=${y.count} 単位 新=${x.units} ほ=${y.units}`);
    }
    if (diffs.length === 0) match++;
    else mism.push(`  被保番 ${k}:\n      - ${diffs.join("\n      - ")}`);
  }
  console.log(`一致 ${match} / 不一致 ${mism.length} / 新のみ ${onlyNew.length} / ほのみ ${onlyHb.length} (被保番 計${allIns.length})`);
  if (onlyNew.length) console.log("  ★新のみ(=DB余剰実績疑い):", onlyNew.join(", "));
  if (onlyHb.length) console.log("  ★ほのみ(=新で欠落):", onlyHb.join(", "));
  for (const s of mism.slice(0, 40)) console.log(s);
  if (mism.length > 40) console.log(`  … 他 ${mism.length - 40} 名`);

  // ── 全項目比較 (行単位) ────────────────────────────────────────────────────
  // 上のサマリ比較は抜き出した項目しか見ていないため、公費 (法別・負担者番号) や
  // 日付系の差を取り逃す。kyotaku-*-diff と同じく行を丸ごと突き合わせる。
  // 正規化: 連番 (レコード内 2 列目) のみ * に落とす。
  console.log("\n===== 全項目比較 (行単位) =====");
  // ほのぼのは未使用の数値欄を "0" で、当システムは空欄で埋める家風差がある。
  // ZERO_BLANK=strict で無効化すれば byte 相当の厳密比較になる。
  const zeroBlank = (process.env.ZERO_BLANK ?? "loose") !== "strict";
  const lineGroups = (p: ParsedFile) => {
    const g = new Map<string, string[]>();
    for (const r of p.rows) {
      const c = r.cols.map(unq).map((x, i) => (zeroBlank && i > 5 && x === "0" ? "" : x));
      const id = c[0];
      const key =
        id === "7111"
          ? `7111|区分${c[3]}|法別${c[4]}`
          : `${id}|種別${c[1]}|${c[4]}|${c[5]}`;
      if (!g.has(key)) g.set(key, []);
      // 末尾の空欄は桁数の家風差になるだけなので落とす
      const trimmed = [...c];
      while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
      g.get(key)!.push(trimmed.join(","));
    }
    for (const v of g.values()) v.sort();
    return g;
  };
  const NG = lineGroups(nw), HG = lineGroups(hb);
  let lmatch = 0;
  const ldiff: string[] = [];
  for (const [k, nv] of NG) {
    const hv = HG.get(k);
    if (!hv) { ldiff.push(`ONLY-NEW ${k} (${nv.length}行)`); continue; }
    if (nv.join("\n") === hv.join("\n")) { lmatch++; continue; }
    ldiff.push(`DIFF ${k}`);
    for (let i = 0; i < Math.max(nv.length, hv.length); i++)
      if (nv[i] !== hv[i]) ldiff.push(`  新 : ${nv[i] ?? "(なし)"}\n  ほ : ${hv[i] ?? "(なし)"}`);
  }
  for (const k of HG.keys()) if (!NG.has(k)) ldiff.push(`ONLY-HONO ${k} (${HG.get(k)!.length}行)`);
  const ldiffHeads = ldiff.filter((d) => !d.startsWith("  ")).length;
  console.log(`グループ 新 ${NG.size} / ほ ${HG.size} → 完全一致 ${lmatch} / 差 ${ldiffHeads}`);
  for (const d of ldiff.slice(0, 120)) console.log(d);
  if (ldiff.length > 120) console.log(`  … 他 ${ldiff.length - 120} 行`);
  if (ldiff.length === 0) console.log("✅ 全項目一致");

  console.log("\n########## 突合レポート end ##########");
}
main().catch((e) => { console.error(e); process.exit(1); });
