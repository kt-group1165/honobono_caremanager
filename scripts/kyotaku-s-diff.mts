/**
 * 居宅 計画費請求 (S ファイル / 7111 + 8124) 突合ハーネス (READ ONLY — DB 書込なし)
 *
 * 実DB から実アプリと同じ fetchKyotakuClaimRows で行を取り、実 builder
 * (buildKeikakuhiFile) で S ファイルをヘッドレス生成して、ほのぼのの正解 KK と
 * (保険/公費区分, 被保番) 単位で突合する。K 側 (kyotaku-k-diff.mts) の対。
 *
 * 正規化 (既知の家風差): クォート / 連番。ほのぼの側は対象年月 = 対象月のみ
 * (KK は提供月ごとに別ファイルなので、当月分の KK を KK_FILE で指定する)。
 *
 * 実行:  npx tsx scripts/kyotaku-s-diff.mts
 *   env: OFFICE_ID / AREA_DIR / KK_FILE (既定 KK260702.CSV)
 *   出力: 伝送データ/<AREA>/居宅/202606/新システム/S202606.CSV (SJIS) + diff レポート
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Encoding from "encoding-japanese";
import { buildKeikakuhiFile, type KeikakuhiUser } from "@/lib/kokuho-densou/build-kyotaku";
import { fetchKyotakuClaimRows } from "@/app/(authenticated)/billing/seikyu/_seikyu-context";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 対象月は env で指定する (MONTH=2026-07 等)。既定は 2026-06。
const [YEAR, MONTH] = (process.env.MONTH ?? "2026-06").split("-").map(Number);
const MONTH_KEY = `${YEAR}-${String(MONTH).padStart(2, "0")}`;
const YM = `${YEAR}${String(MONTH).padStart(2, "0")}`;
const OFFICE_ID = process.env.OFFICE_ID || "cb3190b6-4a74-4952-b0c9-76f913cbd1c8"; // 袖ヶ浦
const AREA_DIR = process.env.AREA_DIR || "袖ケ浦";
const BASE = join(__dirname, "..", "伝送データ", AREA_DIR, "居宅", YM);
const KK_FILE = process.env.KK_FILE || "KK260702.CSV";

function loadEnvLocal(): Record<string, string> {
  const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
    if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}
const envFile = loadEnvLocal();
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? envFile.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? envFile.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const { data: office, error: oe } = await sb
    .from("offices").select("name, business_number, area_category, unit_price").eq("id", OFFICE_ID).single();
  if (oe || !office?.business_number) throw new Error(`office 取得失敗: ${oe?.message}`);
  console.log(`=== 居宅 S突合 ${AREA_DIR} (${office.name} ${office.business_number}) ${MONTH_KEY} ===`);

  // 実アプリと同じローダ (事業所スコープ付き)
  const rows = await fetchKyotakuClaimRows(sb, MONTH_KEY, OFFICE_ID, { excludeNonKokuho: true });
  const draft = rows.filter((r) => r.claimStatus === "draft");
  const targets = rows.filter((r) => r.claimStatus !== "draft");
  console.log(`レセプト ${rows.length}件 (確定 ${targets.length} / 未確定 ${draft.length})`);
  if (draft.length > 0) console.log("  ⚠ 未確定は伝送から除外されます (アプリの「全件確定」を実行してください)");
  if (targets.length === 0) { console.log("確定済みレセプトが無いため中断"); return; }

  // 単価: レセプトに保存された単価 (事業所設定由来) を使う
  const unitPrice = targets[0].unitPrice;

  const users: KeikakuhiUser[] = targets.map((u) => ({
    userName: u.user_name,
    insurerNumber: u.insurer_number ?? "",
    insuredNumber: u.insured_number ?? "",
    birthDate: u.birth_date,
    gender: u.gender,
    careLevel: u.care_level,
    certStart: u.certStart,
    certEnd: u.certEnd,
    requestDate: u.requestDate ?? null,
    serviceCode: u.serviceCode,
    units: u.totalUnits,
    lines: u.lines.map((l) => ({ code: l.code, units: l.units, count: l.count })),
    careManagerNumber: u.careManagerNumber,
    kohiTandoku: u.kohiTandoku,
    kohiHobetsu: u.kohiHobetsu,
    kohiFutanshaNumber: u.kohiFutansha,
    kohiJukyushaNumber: u.kohiJukyusha,
    midMonthInsurerChange: u.midMonthInsurerChange,
  }));

  const f = buildKeikakuhiFile(users, {
    officeNumber: office.business_number, year: YEAR, month: MONTH, unitPrice,
    shoriYear: YEAR, shoriMonth: MONTH + 1,
  });
  for (const w of f.warnings) console.log("  ⚠", w);
  const outDir = join(BASE, "新システム");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, f.fileName),
    Buffer.from(Encoding.convert(Encoding.stringToCode(f.content), { to: "SJIS", from: "UNICODE" })));
  console.log(`出力: 新システム/${f.fileName} (${f.dataRecordCount} レコード)`);

  // 突合: 8124 = (被保番, 保険/公費区分) / 7111 = (保険公費区分)
  const norm = (p: string, filterYm: string | null) => {
    const groups = new Map<string, string[]>();
    for (const l of readFileSync(p, "latin1").split(/\r?\n/)) {
      if (!l.trim()) continue;
      const r = l.split(",").map((x) => x.replace(/^"(.*)"$/, "$1"));
      if (r[0] !== "2") continue;
      const st = r[2];
      const ym = st === "8124" ? r[5] : r[3];
      if (filterYm && ym !== filterYm) continue;
      r[1] = "*"; // 連番
      const k = st === "8124" ? `8124|${r[8]}|区分${r[4]}` : `7111|区分${r[5]}|法別${r[6]}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r.join(","));
    }
    for (const v of groups.values()) v.sort();
    return groups;
  };
  const N = norm(join(outDir, f.fileName), YM);
  // ── ほのぼの側は **提出バッチごとにファイルが分かれる** ──────────────────
  //   6 月提供でも月遅れ請求は 8月10日送信の KK に入り、置き場所は
  //   伝送データ/<拠点>/居宅/202607/ 直下 (ほのぼのから/ の外)。
  //   1 ファイルしか読まないと月遅れが全部「当方だけ」に見える。
  //   2026-06 は 14 拠点で 48 件がこれで、実際は**全件ほのぼのの KK に存在した**。
  //   → 提供年月が対象月の 8124 を持つ KK を **拠点配下から全部**集める。
  const kkPaths: string[] = [];
  if (process.env.KK_FILE) {
    kkPaths.push(join(BASE, "ほのぼのから", KK_FILE));
  } else {
    const areaRoot = join(__dirname, "..", "伝送データ", AREA_DIR, "居宅");
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const q = join(d, e.name);
        if (e.isDirectory()) walk(q);
        else if (/^KK.*\.CSV$/i.test(e.name) && !e.name.includes("解説")) {
          const txt = readFileSync(q, "latin1");
          if (txt.split(/\r?\n/).some((l) => {
            const c = l.split(",").map((x) => x.replace(/^"(.*)"$/, "$1"));
            return c[0] === "2" && c[2] === "8124" && c[5] === YM;
          })) kkPaths.push(q);
        }
      }
    };
    walk(areaRoot);
  }
  if (kkPaths.length === 0) { console.error(`FATAL: 提供年月 ${YM} の 8124 を持つ KK が ${AREA_DIR} に無い`); process.exit(1); }
  console.log(`ほのぼの KK (${kkPaths.length} 本): ${kkPaths.map((q) => q.split(/[\/]/).slice(-2).join("/")).join(" , ")}`);
  // 明細 (8124) は全ファイルから集める。請求書 (7111) は提出バッチ単位なので
  // 当方の「月1本」とは形が違う → 複数バッチのときは byte 比較せず参考値だけ出す。
  const H = new Map<string, string[]>();
  for (const q of kkPaths) {
    for (const [k, v] of norm(q, YM)) {
      if (k.startsWith("7111") && kkPaths.length > 1) continue;
      if (!H.has(k)) H.set(k, []);
      H.get(k)!.push(...v);
    }
  }
  for (const v of H.values()) v.sort();
  if (kkPaths.length > 1) {
    for (const k of [...N.keys()]) if (k.startsWith("7111")) N.delete(k);
    console.log("  (請求書 7111 は ほのぼのが提出バッチごとに分けるため比較対象外。明細 8124 で判定する)");
  }
  let match = 0; const diffs: string[] = [];
  for (const [k, nv] of N) {
    const hv = H.get(k);
    if (!hv) { diffs.push(`ONLY-NEW ${k}`); continue; }
    if (nv.join("\n") === hv.join("\n")) match++;
    else {
      diffs.push(`DIFF ${k}`);
      for (let i = 0; i < Math.max(nv.length, hv.length); i++)
        if (nv[i] !== hv[i]) diffs.push(`  new : ${nv[i] ?? "(なし)"}\n  hono: ${hv[i] ?? "(なし)"}`);
    }
  }
  for (const k of H.keys()) if (!N.has(k)) diffs.push(`ONLY-HONO ${k}`);
  console.log(`\n突合: new ${N.size} / hono ${H.size} → 一致 ${match} / 差 ${diffs.filter((d) => !d.startsWith("  ")).length}`);
  for (const d of diffs.slice(0, 40)) console.log(d);
  if (diffs.length === 0) console.log("✅ 完全一致");
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
