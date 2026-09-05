/**
 * 居宅の伝送バイト照合 (kyotaku-s-diff / kyotaku-k-diff) を全拠点まとめて回す。
 *
 *   S = 請求書 7111 + 明細書 8124 / K = 給付管理票 8222
 *
 * 拠点とファイルは伝送データから自動で決める:
 *   伝送データ/<拠点>/居宅/<提供年月>/ 配下の KK ファイル → 8124 の 項4 = 事業所番号
 *     → offices.business_number 一致で office_id
 *   同じフォルダの KY*.CSV を給付管理票として使う
 *
 * ⚠ 「金額が合っている」より一段強い照合。国保連は形式で弾くので、
 *   桁・ゼロ埋め・項目数・行の並びまで合っていないと送れない。
 *
 *   MONTH=2026-06 npx tsx scripts/kyotaku-densou-diff-all.mts
 *   MONTH=2026-07 AREAS=四街道,木更津 npx tsx scripts/kyotaku-densou-diff-all.mts
 *   KIND=S だけ / KIND=K だけ も指定できる (既定は両方)
 */
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import Encoding from "encoding-japanese";

const MONTH = process.env.MONTH ?? "2026-06";
const YM = MONTH.replace("-", "");
const ONLY = (process.env.AREAS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const KIND = (process.env.KIND ?? "SK").toUpperCase();
/** ★ 回帰網が読む JSON の出力先 (KYOTAKU_DIFF_JSON=path) */
const JSON_OUT = process.env.KYOTAKU_DIFF_JSON ?? "";
type DiffCell = { newRows: number; honoRows: number; match: number; diff: number } | null;
const jsonRows: { area: string; officeId: string; s: DiffCell; k: DiffCell }[] = [];
// ⚠ URL.pathname は日本語パスを URL エンコードするので使えない
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DENSOU = join(ROOT, "伝送データ");

const env: Record<string, string> = {};
for (const l of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const { data: offices, error } = await sb.from("offices").select("id, name, business_number");
if (error) { console.error(`✗ 事業所取得失敗: ${error.message}`); process.exit(1); }
const byBn = new Map((offices ?? []).filter((o) => o.business_number).map((o) => [o.business_number as string, o]));

const sjis = (p: string) =>
  Encoding.convert(readFileSync(p), { to: "UNICODE", from: "SJIS", type: "string" }) as string;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

interface Job { area: string; officeId: string; officeName: string; kk: string; ky: string | null }
const jobs: Job[] = [];
const skipped: string[] = [];

for (const area of readdirSync(DENSOU)) {
  if (ONLY.length && !ONLY.includes(area)) continue;
  const base = join(DENSOU, area, "居宅", YM);
  if (!existsSync(base)) continue;
  const files = walk(base);
  // その提供年月の 8124 が入っている KK を探す (ファイル名は処理年月なので中身で見る)
  let kk: string | null = null, bn: string | null = null;
  for (const f of files.filter((x) => /KK\d+\.CSV$/i.test(x))) {
    const hit = sjis(f).split(/\r?\n/).find((l) => {
      const c = l.split(",").map((x) => x.replace(/^"|"$/g, "").trim());
      return c[2] === "8124" && c[5] === YM;
    });
    if (!hit) continue;
    kk = f;
    bn = (hit.split(",").map((x) => x.replace(/^"|"$/g, "").trim()))[3] ?? null;
    break;
  }
  if (!kk || !bn) { skipped.push(`${area}: 提供年月 ${YM} の 8124 が入った KK が無い`); continue; }
  const off = byBn.get(bn);
  if (!off) { skipped.push(`${area}: 事業所番号 ${bn} が offices に無い`); continue; }
  const ky = files.find((x) => /KY\d+\.CSV$/i.test(x)) ?? null;
  jobs.push({ area, officeId: off.id, officeName: off.name ?? "", kk, ky });
}

const results: string[] = [];
for (const j of jobs) {
  const line: string[] = [`${j.area.padEnd(8, "　").slice(0, 8)} ${j.officeName}`];
  const run = (script: string, extra: Record<string, string>) => {
    try {
      return execFileSync("npx", ["tsx", script], {
        cwd: ROOT, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, MONTH, OFFICE_ID: j.officeId, AREA_DIR: j.area, ...extra },
      });
    } catch (e) {
      const err = e as { stdout?: string; message: string };
      return `__FAILED__ ${String(err.stdout ?? "").split("\n").filter(Boolean).slice(-1)[0] ?? err.message.split("\n")[0]}`;
    }
  };
  // 出力の締めに「一致」「不一致 n 件」が出る前提。拾えなければ生の末尾を出す。
  //   ⚠ 2026-09-01 是正: kyotaku-s-diff.mts / kyotaku-k-diff.mts の実際の締め行は
  //   「突合: new N / hono M → 一致 X / 差 Y」形式で、旧正規表現(不一致N件)は
  //   一度もマッチしていなかった (毎回 "?" 表示になっていた)。実書式に合わせる。
  const verdict = (out: string, label: string) => {
    if (out.startsWith("__FAILED__")) return `${label} ✗ ${out.slice(11)}`;
    const m = /一致\s*(\d+)\s*\/\s*差\s*(\d+)/.exec(out);
    if (m) return `${label} ${m[2] === "0" ? "✓ 一致" : `★ 一致${m[1]}/差${m[2]}`}`;
    const m2 = /不一致\s*(\d+)\s*件/.exec(out);
    if (m2) return `${label} ${m2[1] === "0" ? "✓ 一致" : `★ 不一致 ${m2[1]} 件`}`;
    if (/完全一致|差分なし|一致しました/.test(out)) return `${label} ✓ 一致`;
    const tail = out.split("\n").filter(Boolean).slice(-1)[0] ?? "";
    return `${label} ? ${tail.slice(0, 60)}`;
  };
  // ⚠ 2026-09-01 是正: KK_FILE/KY_FILE を固定で渡すと、両スクリプトとも
  //   「拠点配下を再帰探索して対象月の対象レコードを含むファイルを全部集める」
  //   自動探索ロジックを迂回してしまい ①複数バッチ(月遅れ)拠点は1本しか見ない
  //   ②202607 のように ほのぼのから/ が無いフォルダ構成だと ENOENT で全滅する、
  //   という2つの不具合を生んでいた (両スクリプトの自動探索自体は正しく動く)。
  //   → KK_FILE/KY_FILE は渡さず、各スクリプト自身の自動探索に任せる。
  let sOut = "", kOut = "";
  if (KIND.includes("S")) { sOut = run("scripts/kyotaku-s-diff.mts", {}); line.push(verdict(sOut, "S")); }
  if (KIND.includes("K")) {
    if (!j.ky) line.push("K — KY 無し");
    else { kOut = run("scripts/kyotaku-k-diff.mts", {}); line.push(verdict(kOut, "K")); }
  }
  console.log("  " + line.join("   "));
  results.push(line.join("   "));
  // ★ 機械可読にも出す (回帰網が読む)。分母 (new/hono) と 一致/差 を持たせる
  const parse = (out: string) => {
    // ⚠ ★ S は「new N / hono M」、K は「new N ★票★ / hono M 票」。★ 票 を許さないと K だけ拾えない
    //   (2026-09-05: 実際に K だけ 0 件になり、基準値に K が入らなかった)
    const m = /突合:\s*new\s*(\d+)\s*票?\s*\/\s*hono\s*(\d+)\s*票?\s*→\s*一致\s*(\d+)\s*\/\s*差\s*(\d+)/.exec(out);
    return m ? { newRows: +m[1], honoRows: +m[2], match: +m[3], diff: +m[4] } : null;
  };
  jsonRows.push({ area: j.area, officeId: j.officeId, s: parse(sOut), k: parse(kOut) });
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ month: MONTH, rows: jsonRows }, null, 2) + "\n", "utf8");
  console.log(`\n→ ${JSON_OUT} に ${jsonRows.length} 拠点ぶんを書きました`);
}
console.log(`\n===== 居宅 伝送バイト照合 ${MONTH} (${jobs.length} 拠点) =====`);
for (const r of results) console.log("  " + r);
if (skipped.length) {
  console.log("\n--- スキップ ---");
  for (const s of skipped) console.log("  " + s);
}
