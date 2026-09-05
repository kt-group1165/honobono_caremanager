/**
 * ★ 月を表す列の 書式ずれを全表で見張る (READ ONLY)
 *
 *   npx tsx scripts/month-format-check.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   ★ 月の列が text 型だと ★ "2026-06" と "2026-06-01" の両方が入る。
 *   ★ 書く側と読む側で書式が違うと ★ エラーも出ず 0 件になる。
 *
 *   実例 (2026-09-05 に発見): `kaigo_visit_addon_lines.target_month`
 *     画面は 常に "2026-06" で書く / ★ 障害の集計は "2026-06-01" で読む
 *     → ★ 画面から入れた障害の加算は 請求に乗らない (未発火)
 *     ★ しかも コードのコメントは「date 型なので」と ★ 誤った理由を書いていた
 *
 *   ★ 月の列は ★ 39 個 が text 型。★ 同じ事故が起きうる面積を 数字にする。
 *
 * ⚠ ★ 「混在している = バグ」ではありません。制度ごとに使い分けている表もあります。
 *   ★ 混在を 見えるようにするのが目的。判定は 読む側のコードを見ないと決まりません。
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
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
const sb = createClient(SB, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/** ★ 表の一覧は PostgREST の OpenAPI を正とする (コード grep は必ず漏れる) */
const spec = (await (await fetch(`${SB}/rest/v1/`, { headers: H })).json()) as {
  definitions?: Record<string, { properties?: Record<string, { format?: string }> }>;
};
const targets: [string, string][] = [];
for (const [t, d] of Object.entries(spec.definitions ?? {})) {
  for (const [c, p] of Object.entries(d.properties ?? {})) {
    if (!/(^|_)month$/.test(c)) continue;
    if (p.format !== "text") continue; // ★ date 型は DB が弾くので対象外
    targets.push([t, c]);
  }
}
console.log(`月を表す text 列 ★ ${targets.length} 個 を点検\n`);

/**
 * ★ 書式が揃っていなくても 読む側が正規化していれば問題ない。
 *   ★ 確認したものを ここに理由つきで書く。★ 「その他」を見て毎回調べ直さないため。
 */
const KNOWN_OK: Record<string, string> = {
  "payroll_office_form_records.year_month":
    "自由書式 (2026/02 / 2026/1 / 25-Dec) だが payroll/page.tsx の normalizeYM が YYYYMM に正規化する。2026-09-05 に 4 件を実データで確認済み",
};

const shape = (v: string): string =>
  /^\d{4}-\d{2}$/.test(v) ? "YYYY-MM"
  : /^\d{4}-\d{2}-\d{2}$/.test(v) ? "YYYY-MM-DD"
  : /^\d{6}$/.test(v) ? "YYYYMM"
  : v === "" ? "(空)" : "★ その他";

const mixed: string[] = [];
const empty: string[] = [];
let scanned = 0;

for (const [t, c] of targets) {
  const rows: Record<string, string>[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from(t).select(c).order(c, { ascending: true }).range(off, off + 999);
    if (error) {
      // ★ 権限や view で読めない表は 飛ばすが ★ 黙って飛ばさない
      console.log(`  ⚠ ${t}.${c}  読めません: ${error.code} ${error.message}`);
      break;
    }
    const r = (data ?? []) as unknown as Record<string, string>[];
    rows.push(...r);
    if (r.length < 1000) break;
  }
  scanned++;
  if (rows.length === 0) { empty.push(`${t}.${c}`); continue; }
  const tally = new Map<string, number>();
  for (const r of rows) {
    const v = String(r[c] ?? "");
    tally.set(shape(v), (tally.get(shape(v)) ?? 0) + 1);
  }
  // ★ 空 / NULL は「月に紐づかない」「無期限」の意味で使われることが多い。
  //   ★ 書式の衝突とは別物なので 分けて数える。混ぜると 7 件中 6 件が偽陽性になる。
  const kinds = [...tally.keys()].filter((k) => k !== "(空)");
  const label = [...tally].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" / ");
  if (kinds.length >= 2) {
    mixed.push(`${t}.${c}`);
    console.log(`  ★ 混在  ${t}.${c}`);
    console.log(`           ${label}`);
  } else {
    const nul = tally.get("(空)") ?? 0;
    // ★ 「その他」でも 読む側が正規化していれば問題ない。確認済みのものは そう書く
    const note = KNOWN_OK[`${t}.${c}`] ? `  ★ ${KNOWN_OK[`${t}.${c}`]}` : "";
    console.log(`     ${(kinds[0] ?? "(空のみ)").padEnd(10)} ${t}.${c}  (${rows.length} 行${nul ? ` / うち空 ${nul}` : ""})${note}`);
  }
}

console.log("");
console.log(`点検した列 ${scanned} / ★ 非空の書式が 2 種以上ある列 ${mixed.length} / 0 行の列 ${empty.length}`);
console.log("   ⚠ ★ 空 / NULL は 別に数えています (「月に紐づかない」「無期限」の意味で使われるため)");
if (empty.length) console.log(`  0 行: ${empty.join(" , ")}`);
if (mixed.length) {
  console.log("");
  console.log("★ 混在している列:");
  for (const m of mixed) console.log(`   ${m}`);
  console.log("");
  console.log("⚠ ★ 混在 = バグ ではありません。制度ごとに使い分けている表もあります。");
  console.log("   ★ ただし ★ 書く側と読む側で書式が違うと エラーも出ず 0 件になります。");
  console.log("   ★ 混在している列は ★ 読む側のコードを 1 つずつ確認してください。");
  console.log("   ★ 既知: kaigo_visit_addon_lines.target_month は");
  console.log("     ★ 画面が YYYY-MM で書き / 障害の集計が YYYY-MM-DD で読む (未発火)。");
}
