/**
 * ★ 実績単位の加算行 (kaigo_visit_addon_lines) の点検 (READ ONLY)
 *
 *   npx tsx scripts/addon-lines-check.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   ★ この表は 制度ごとに 別々の集計が読み、★ 読み方も違う:
 *     介護 / 総合事業  `.eq("target_month", "2026-06")`     ← ★ YYYY-MM
 *     障害             `.eq("target_month", "2026-06-01")`  ← ★ YYYY-MM-DD
 *   ★ 列は text 型で どちらの書式も入る。★ 書式を間違えて入れると
 *   ★ エラーも出ず 集計から丸ごと外れる (= 加算が請求に乗らない)。
 *
 * ⚠ ★ 「同じ列を 2 つの規約で使う」型。★ 今日この型で何度も事故が出ている。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const l of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY がありません。中止します。");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

type Line = { id: string; target_month: string; addon_code: string; system: string; count: number };
type Code = { service_code: string; service_name: string; units: number; system: string };

async function pageAll<T>(table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from(table).select(select).order("id", { ascending: true }).range(off, off + 999);
    if (error) throw new Error(`${table} 取得失敗: ${error.message}`);
    const r = (data ?? []) as unknown as T[];
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

const lines = await pageAll<Line>("kaigo_visit_addon_lines", "id, target_month, addon_code, system, count");
console.log(`加算行の点検 — ★ ${lines.length} 行\n`);
if (lines.length === 0) { console.log("★ FAIL 0 行です。点検できません。"); process.exit(1); }

const ng: string[] = [];
const warn: string[] = [];

// ① ★ 書式が 制度の読み方と合っているか
//    介護 / 総合事業 = YYYY-MM   障害 = YYYY-MM-DD
const EXPECT: Record<string, RegExp> = {
  介護: /^\d{4}-\d{2}$/,
  総合事業: /^\d{4}-\d{2}$/,
  障害: /^\d{4}-\d{2}-\d{2}$/,
};
const fmt = new Map<string, number>();
for (const l of lines) {
  const k = `${l.system}|${/^\d{4}-\d{2}$/.test(l.target_month) ? "YYYY-MM" : /^\d{4}-\d{2}-\d{2}$/.test(l.target_month) ? "YYYY-MM-DD" : "その他"}`;
  fmt.set(k, (fmt.get(k) ?? 0) + 1);
  const re = EXPECT[l.system];
  if (re && !re.test(l.target_month)) {
    ng.push(`★ 書式が集計の読み方と違う: system=${l.system} target_month=${l.target_month} code=${l.addon_code} → ★ 集計から外れます`);
  }
}
console.log("① target_month の書式 (制度別)");
for (const [k, v] of [...fmt].sort()) console.log(`   ${k.padEnd(18)} ${v} 行`);
console.log("   ★ 介護/総合事業 は YYYY-MM、障害 は YYYY-MM-DD で読まれます\n");

// ② ★ コードがマスタに実在するか (実在しないと単位数が引けない)
const codes = [...new Set(lines.map((l) => l.addon_code))];
const master = await pageAll<Code>("kaigo_service_codes", "service_code, service_name, units, system");
const byCode = new Map<string, Code>();
for (const c of master) if (!byCode.has(c.service_code)) byCode.set(c.service_code, c);
console.log("② 加算コードがマスタにあるか");
for (const c of codes.sort()) {
  const m = byCode.get(c);
  const n = lines.filter((l) => l.addon_code === c).length;
  if (m) { console.log(`     ${c}  ${String(n).padStart(4)}行  ${String(m.units).padStart(5)}単位  ${m.system}  ${m.service_name}`); continue; }
  // ⚠ ★ 総合事業は 保険者ごとに prefix が付く (IC_/OA_/SD_/IH_ …)。
  //   集計側は `${prefix}${addon_code}` で引くので、★ 素のコードで照合すると
  //   「マスタに無い」に見える。★ 私の検査がそれで誤検出を出した (2026-09-05)。
  const pref = master.filter((x) => x.service_code.endsWith(`_${c}`));
  if (pref.length) {
    const ps = [...new Set(pref.map((x) => x.service_code.split("_")[0]))].sort();
    console.log(`     ${c}  ${String(n).padStart(4)}行  ★ 保険者prefix付きで実在: ${ps.join(" / ")} (${pref[0].units}単位)`);
    continue;
  }
  ng.push(`★ マスタに無いコード: ${c} (${n} 行) → ★ 単位数が引けません`);
  console.log(`   ★ ${c}  ${String(n).padStart(4)}行  ★ マスタに無い (prefix 付きでも見つからない)`);
}

// ③ ★ 加算行の制度と マスタの制度が一致しているか
console.log("\n③ 加算行の制度と マスタの制度が一致しているか");
const mism = new Map<string, number>();
for (const l of lines) {
  const m = byCode.get(l.addon_code);
  if (!m) continue;
  if (m.system && l.system && m.system !== l.system) {
    mism.set(`${l.system}→${m.system}|${l.addon_code}|${m.service_name}`, (mism.get(`${l.system}→${m.system}|${l.addon_code}|${m.service_name}`) ?? 0) + 1);
  }
}
if (mism.size === 0) console.log("   (一致)");
for (const [k, v] of mism) {
  const [dir, code, name] = k.split("|");
  warn.push(`★ 制度が食い違う: 加算行=${dir.split("→")[0]} / マスタ=${dir.split("→")[1]}  ${code} ${name} (${v} 行)`);
  console.log(`   ★ ${dir}  ${code}  ${name}  ${v} 行`);
}

console.log("");
if (warn.length) { console.log("⚠ 要確認"); for (const w of warn) console.log(`   ${w}`); console.log(""); }
if (ng.length === 0) {
  console.log(`PASS — 書式・マスタ実在とも問題なし (${lines.length} 行)`);
  if (warn.length) console.log("   ⚠ ★ 上の「要確認」は 合否に入れていません (制度の食い違いは 意図的な場合があるため)");
} else {
  console.log(`★ FAIL ${ng.length} 件`);
  for (const x of ng) console.log(`   ${x}`);
  process.exitCode = 1;
}
