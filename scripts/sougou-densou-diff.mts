/**
 * 総合事業 (介護予防・日常生活支援総合事業) の伝送突合ハーネス。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────
 *   介護 (7111/7131)・障害 (J111/J121)・居宅 (8124/8222) には突合があるのに、
 *   **総合事業 (7113 請求書 / 71R1 明細書) だけ無かった**。
 *   `kaigo-densou-diff.mts` は「総合事業だけのファイルは除く」と明記して外している。
 *   そのため 2026-06 の総合事業は一度も ほのぼの と突き合わされていない。
 *   実際に袖ケ浦で単位数が 78,956 (当方) / 81,603 (ほのぼの) とずれていた。
 *
 * ── 使い方 ────────────────────────────────────────────────────────────
 *   TARGET_MONTH=2026-06 OFFICE_ID=<uuid> AREA_DIR=<拠点> \
 *     npx tsx scripts/sougou-densou-diff.mts
 *
 *   DENSOU_DIR   伝送データ/ 以下の相対パス (既定 <拠点>/訪問介護/介護/<YYYYMM>)
 *   KK_FILE      ほのぼの側のファイル名を明示 (71R1 を含むものが複数あるとき)
 *   ZERO_BLANK=strict  「0」と空欄を別物として比較する (既定は同一視)
 *
 * ⚠ 事業所番号は **保険者ごとに分かれる** (office_sougou_numbers)。1 ファイル =
 *   1 事業所番号なので、当方も ほのぼの も複数ファイルになりうる。番号で突き合わせる。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Encoding from "encoding-japanese";
import { aggregateMonthlyVisitSeikyu } from "@/lib/visit-seikyu/aggregate";
import {
  buildSougouDensou,
  groupSougouRowsByOfficeNumber,
  type SougouDensouRow,
} from "@/lib/kokuho-densou/build-sougou";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TARGET_MONTH = process.env.TARGET_MONTH || "2026-06";
const YEAR = Number(TARGET_MONTH.slice(0, 4));
const MONTH = Number(TARGET_MONTH.slice(5, 7));
const YM = TARGET_MONTH.replace("-", "");
const OFFICE_ID = process.env.OFFICE_ID || "b9a17be0-7fba-4376-b66e-b1aad414e4b2"; // 袖ケ浦
const AREA_DIR = process.env.AREA_DIR || "袖ケ浦";
const DENSOU_BASE = process.env.DENSOU_DIR
  ? join(__dirname, "..", "伝送データ", ...process.env.DENSOU_DIR.split("/"))
  : join(__dirname, "..", "伝送データ", AREA_DIR, "訪問介護", "介護", YM);
const HONOBONO_DIR = join(DENSOU_BASE, process.env.HONOBONO_SUBDIR || "ほのぼのから");
const OUT_DIR = join(DENSOU_BASE, "新システム");
const HONOBONO_KK = process.env.KK_FILE || "";

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

function writeSjis(dir: string, fileName: string, content: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sjis = Encoding.convert(Encoding.stringToCode(content), { to: "SJIS", from: "UNICODE" });
  writeFileSync(join(dir, fileName), Buffer.from(sjis));
}

// ─── CSV パース (kaigo-densou-diff.mts と同じ。ハーネスごとに持つ運用) ───────
interface PRow { seq: string; cols: string[] }
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
function toParsed(lines: string[]): ParsedFile {
  let control: string[] = [], end: string[] = [];
  const rows: PRow[] = [];
  for (const line of lines) {
    const c = splitCsvLine(line);
    if (c[0] === "1") control = c;
    else if (c[0] === "3") end = c;
    else if (c[0] === "2") rows.push({ seq: c[1], cols: c.slice(2) });
  }
  return { control, rows, end };
}
function readSjis(path: string): string {
  return Encoding.codeToString(
    Encoding.convert(new Uint8Array(readFileSync(path)), { to: "UNICODE", from: "SJIS" }),
  );
}
const lines = (t: string) => t.split(/\r\n|\n/).filter((l) => l.length > 0);
const unq = (s: string | undefined) => (s ?? "").replace(/^"|"$/g, "").trim();

/** 総合事業のレコードを含むか (7113 請求書 または 71R1 明細書) */
const hasSougou = (p: ParsedFile) =>
  p.rows.some((r) => unq(r.cols[0]) === "71R1" || unq(r.cols[0]) === "7113");
/** コントロールレコードの事業所番号 */
const officeOf = (p: ParsedFile) => unq(p.control[7]);

async function main() {
  console.log(`===== 総合事業 伝送 突合 ${AREA_DIR} ${TARGET_MONTH} =====\n`);

  const { data: o, error: oe } = await sb
    .from("offices")
    .select("name, business_number, unit_price, area_category, applied_formula_codes, tenant_id")
    .eq("id", OFFICE_ID)
    .maybeSingle();
  if (oe || !o) { console.error("事業所取得失敗:", oe?.message); process.exit(1); }
  const officeNumber = ((o.business_number ?? "") as string).trim();
  const unitPrice = (o.unit_price ?? 10) as number;
  const tenantId = (o.tenant_id ?? "kt-group") as string;
  console.log(`office: ${o.name} / 介護の事業所番号=${officeNumber} / 単価=${unitPrice}`);

  // 保険者ごとの総合事業 事業所番号。テーブル未適用でも介護の番号で続行する
  const byInsurer: Record<string, string> = {};
  const { data: sn, error: snErr } = await sb
    .from("office_sougou_numbers")
    .select("insurer_number, business_number")
    .eq("office_id", OFFICE_ID);
  if (snErr) console.log(`  ⚠ office_sougou_numbers 取得不可 (${snErr.message}) — 介護の番号で続行`);
  else for (const r of (sn ?? []) as { insurer_number: string; business_number: string }[]) {
    byInsurer[r.insurer_number] = r.business_number;
  }
  if (Object.keys(byInsurer).length) console.log(`  保険者別番号: ${JSON.stringify(byInsurer)}`);

  // ── 新システム: 集計 → 生成 ──
  const agg = await aggregateMonthlyVisitSeikyu(sb, {
    officeId: OFFICE_ID, tenantId, year: YEAR, month: MONTH, unitPrice,
    appliedFormulaCodes: (o.applied_formula_codes ?? []) as string[],
  });
  const sougouRows = (agg.sougouRows ?? []) as SougouDensouRow[];
  console.log(`aggregate: 総合事業 ${sougouRows.length} 行`);
  if (sougouRows.length === 0) {
    console.log("総合事業の実績が 0 件。突合しない。");
    return;
  }

  const byOffice = groupSougouRowsByOfficeNumber(sougouRows, officeNumber, byInsurer);
  const mine = new Map<string, ParsedFile>();
  let seq = 0;
  for (const [offNo, rowsForOffice] of byOffice) {
    seq += 1;
    const res = buildSougouDensou(rowsForOffice, {
      officeNumber: offNo, year: YEAR, month: MONTH, unitPrice,
      seikyuYear: YEAR, seikyuMonth: MONTH,
      fileSeq: byOffice.size > 1 ? seq : undefined,
    });
    writeSjis(OUT_DIR, res.fileName, res.content);
    console.log(`新システム出力: ${res.fileName} (事業所 ${offNo} / ${rowsForOffice.length} 行) → ${OUT_DIR}`);
    for (const w of res.warnings.slice(0, 8)) console.log("  ⚠", w);
    mine.set(offNo, toParsed(lines(res.content)));
  }

  // ── ほのぼの側: 71R1/7113 を含むファイルを事業所番号で引く ──
  const cands = HONOBONO_KK
    ? [HONOBONO_KK]
    : readdirSync(HONOBONO_DIR).filter((f) => /^KK.*\.CSV$/i.test(f) && !f.includes("解説"));
  const hono = new Map<string, { file: string; parsed: ParsedFile }>();
  for (const f of cands) {
    const p = toParsed(lines(readSjis(join(HONOBONO_DIR, f))));
    if (!hasSougou(p)) continue;
    const on = officeOf(p);
    if (hono.has(on)) {
      console.error(`FATAL: 事業所 ${on} の総合事業ファイルが複数あります (${hono.get(on)!.file}, ${f})`);
      console.error("  KK_FILE=... で明示するか、提供年月ごとにフォルダを分けてください");
      process.exit(1);
    }
    hono.set(on, { file: f, parsed: p });
  }
  if (hono.size === 0) {
    console.error(`FATAL: ${HONOBONO_DIR} に総合事業 (71R1/7113) を含む KK がありません`);
    process.exit(1);
  }
  console.log(`ほのぼの: ${[...hono].map(([n, v]) => `${v.file}(事業所${n})`).join(" / ")}\n`);

  // ── 事業所番号ごとに突合 ──
  const zeroBlank = (process.env.ZERO_BLANK ?? "loose") !== "strict";
  const lineGroups = (p: ParsedFile) => {
    const g = new Map<string, string[]>();
    for (const r of p.rows) {
      const c = r.cols.map(unq).map((x, i) => (zeroBlank && i > 5 && x === "0" ? "" : x));
      const id = c[0];
      // 7113 請求書は 保険公費区分 × 法別番号 / 71R1 明細書は 保険者 + 被保険者番号
      const key = id === "7113" ? `7113|区分${c[3]}|法別${c[4]}` : `${id}|種別${c[1]}|${c[4]}|${c[5]}`;
      if (!g.has(key)) g.set(key, []);
      const trimmed = [...c];
      while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
      g.get(key)!.push(trimmed.join(","));
    }
    for (const v of g.values()) v.sort();
    return g;
  };

  let totalDiff = 0;
  const allOffices = new Set([...mine.keys(), ...hono.keys()]);
  for (const offNo of [...allOffices].sort()) {
    const nw = mine.get(offNo);
    const hb = hono.get(offNo)?.parsed;
    console.log(`===== 事業所 ${offNo} =====`);
    if (!nw) { console.log("  ★ 当方に無し (ほのぼのだけが請求している)"); totalDiff++; continue; }
    if (!hb) { console.log("  ★ ほのぼのに無し (当方だけが請求している)"); totalDiff++; continue; }

    const kindCount = (p: ParsedFile) => {
      const m: Record<string, number> = {};
      for (const r of p.rows) { const k = `${unq(r.cols[0])}-${unq(r.cols[1])}`; m[k] = (m[k] ?? 0) + 1; }
      return m;
    };
    console.log("  新レコ内訳:", JSON.stringify(kindCount(nw)));
    console.log("  ほレコ内訳:", JSON.stringify(kindCount(hb)));

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
    const heads = ldiff.filter((d) => !d.startsWith("  ")).length;
    console.log(`  グループ 新 ${NG.size} / ほ ${HG.size} → 完全一致 ${lmatch} / 差 ${heads}`);
    for (const d of ldiff.slice(0, 80)) console.log("  " + d);
    if (ldiff.length > 80) console.log(`    … 他 ${ldiff.length - 80} 行`);
    if (heads === 0) console.log("  ✅ 全項目一致");
    totalDiff += heads;
    console.log("");
  }

  console.log(`########## 総合事業 突合 end (差 ${totalDiff}) ##########`);
}
main().catch((e) => { console.error(e); process.exit(1); });
