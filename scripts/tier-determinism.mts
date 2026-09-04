/**
 * ★ 所要時間から 段 (サービスコード) が決まるか — 段階を分けて測る (READ ONLY)
 *
 *   npx tsx scripts/tier-determinism.mts
 *   SYSTEM=障害 npx tsx scripts/tier-determinism.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   ★ ほのぼのを置き換えると サービスコードを 当方が決めることになる。
 *   ★ 「何が分かれば決まるのか」を 段階を分けて測らないと、
 *   ★ 何を入力させる画面を作ればよいかが決まらない。
 *
 * ⚠ ★ 母数の定義で 数字が 10 倍変わる。★ だから 2 段階で出す。
 *     段階1 ★ 所要時間だけ            → 介護 40.6% / 障害 43.8% が誤る
 *     段階2 ★ 族 と 時間帯 も既知     → 介護 4.6%  / 障害 6.7%  が誤る
 *   ★ 段階1 の数字を見出しにすると 過大に見える (族が分からないのは当然なので)。
 *   ★ 段階2 が「本当に足りない入力」の大きさ。
 *
 * ⚠ ★ これは「告示の規則」ではなく「★ ほのぼのが実際にやったこと」。
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

const FROM = process.env.MONTHS_FROM ?? "2026-06-01";
const TO = process.env.MONTHS_TO ?? "2026-07-31";
const SYSTEM = process.env.SYSTEM ?? "介護";

type Row = { service_type: string | null; start_time: string | null; end_time: string | null };
const toMin = (t: string | null): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const zoneOf = (s: number) => (s >= 360 && s < 480 ? "早" : s >= 480 && s < 1080 ? "日" : s >= 1080 && s < 1320 ? "夜" : "深");

const rows: Row[] = [];
for (let off = 0; ; off += 1000) {
  const { data, error } = await sb
    .from("kaigo_visit_schedule").select("service_type, start_time, end_time")
    .eq("status", "completed").eq("system", SYSTEM)
    .gte("visit_date", FROM).lte("visit_date", TO)
    .order("id", { ascending: true }).range(off, off + 999);
  if (error) throw new Error(`取得失敗: ${error.message}`);
  const r = (data ?? []) as unknown as Row[];
  rows.push(...r);
  if (r.length < 1000) break;
}
if (rows.length === 0) { console.log(`★ FAIL 0 行です (${SYSTEM} / ${FROM}〜${TO})。`); process.exit(1); }

/** 名前を ★ 族 (何のサービスか) と ★ 段 (どの長さか) に分ける */
function split(name: string): { fam: string; tier: string } | null {
  const n = name.normalize("NFKC");
  let m: RegExpExecArray | null;
  if ((m = /^身体介護(0?\d)(?!.*生活)/.exec(n))) return { fam: "身体単独", tier: m[1] };
  if ((m = /^身体(\d)生活(\d)/.exec(n))) return { fam: "身体+生活", tier: `${m[1]}-${m[2]}` };
  if ((m = /^生活援助(\d)/.exec(n))) return { fam: "生活単独", tier: m[1] };
  if ((m = /^(身体|家事)[日夜深早](\d+\.\d)/.exec(n))) return { fam: `${m[1]}(障害)`, tier: m[2] };
  return null;
}

type Cell = Map<string, number>;
const lv1 = new Map<string, Cell>(); // 所要時間だけ
const lv2 = new Map<string, Cell>(); // 族 + 時間帯 + 所要時間
const byFam = new Map<string, { n: number; wrong: number }>();
let skipped = 0;

for (const r of rows) {
  const sp = split(String(r.service_type ?? ""));
  if (!sp) { skipped++; continue; }
  const s = toMin(r.start_time), e0 = toMin(r.end_time);
  if (s == null || e0 == null) { skipped++; continue; }
  const d = (e0 <= s ? e0 + 1440 : e0) - s;
  const put = (map: Map<string, Cell>, key: string) => {
    let c = map.get(key); if (!c) { c = new Map(); map.set(key, c); }
    const label = `${sp.fam}:${sp.tier}`;
    c.set(label, (c.get(label) ?? 0) + 1);
  };
  put(lv1, `${d}`);
  put(lv2, `${sp.fam}|${zoneOf(s)}|${d}`);
}

/** ★ 少数側 = その粒度で「多数決」に倒したとき 実際に間違える件数 */
function score(map: Map<string, Cell>) {
  let total = 0, wrong = 0, ambGroups = 0;
  for (const [, c] of map) {
    const vals = [...c.values()];
    const n = vals.reduce((a, b) => a + b, 0);
    total += n;
    if (c.size >= 2) { ambGroups++; wrong += n - Math.max(...vals); }
  }
  return { total, wrong, ambGroups, groups: map.size };
}

const s1 = score(lv1), s2 = score(lv2);
console.log(`段の決まりやすさ — ${SYSTEM} / ${FROM}〜${TO} / ${rows.length} 行 (対象 ${s1.total} 行・対象外 ${skipped} 行)\n`);
console.log(`★ 段階1  所要時間だけ         組 ${s1.groups} (割れる ${s1.ambGroups})  ★ 誤り ${s1.wrong} / ${s1.total} = ${((s1.wrong / s1.total) * 100).toFixed(2)}%`);
console.log(`★ 段階2  + 族 と 時間帯も既知   組 ${s2.groups} (割れる ${s2.ambGroups})  ★ 誤り ${s2.wrong} / ${s2.total} = ${((s2.wrong / s2.total) * 100).toFixed(2)}%`);
console.log("");
console.log("⚠ ★ 見出しにするのは 段階2 です。★ 段階1 は「族が分からない」という当然のことを");
console.log("   含んでいるので ★ 過大に見えます (母数の定義で 数字が 10 倍変わる、の実例)。");

// ★ 残った誤りが どの族に集中しているか = ★ 足りない入力が何か
console.log("\n★ 段階2 で残る誤りが どの族に集まっているか");
for (const [k, c] of lv2) {
  const fam = k.split("|")[0];
  const vals = [...c.values()];
  const n = vals.reduce((a, b) => a + b, 0);
  const w = c.size >= 2 ? n - Math.max(...vals) : 0;
  const cur = byFam.get(fam) ?? { n: 0, wrong: 0 };
  cur.n += n; cur.wrong += w; byFam.set(fam, cur);
}
for (const [fam, v] of [...byFam].sort((a, b) => b[1].wrong - a[1].wrong)) {
  console.log(`  ${fam.padEnd(12)} ${String(v.wrong).padStart(5)} / ${String(v.n).padStart(6)} = ${((v.wrong / v.n) * 100).toFixed(2)}%`);
}
console.log("\n⚠ ★ 身体+生活 に集中していれば、★ 足りない入力は「身体/生活の分単位の内訳」です。");
console.log("   ★ 合計時間だけでは 内訳が復元できないため。");
console.log("⚠ ★ これは「告示の規則」ではなく「ほのぼのが実際にやったこと」です。");
