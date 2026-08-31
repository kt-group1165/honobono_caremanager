// ============================================================================
// 週間パターン (kaigo_visit_patterns) の精度を実績で測る — 書込なし
//
//   node migrations/verify_visit_patterns_vs_jisseki.mjs
//   RATIO=0.7 node migrations/verify_visit_patterns_vs_jisseki.mjs
//
// extract_visit_patterns_from_jisseki.mjs と同じ条件でパターンを起こし、
// 2026-06 の全日に展開して実績と突き合わせる。
//   ・空振り率  = 生成した予定のうち実績に無いもの (現場が消す作業)
//   ・カバー率  = 実績のうち予定で拾えたもの (残りは手で足す作業)
// 閾値 STABLE_RATIO はこの 2 つの合計が最小になる 0.6 を採用している。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const env = {};
for (const l of readFileSync(KAIGO + ".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PAGE = 1000;
async function fetchAll(t, s, tw) {
  const out = [];
  for (let f = 0; ; f += PAGE) {
    let q = sb.from(t).select(s).order("id").range(f, f + PAGE - 1);
    if (tw) q = tw(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}
const hhmm = (v) => String(v ?? "").slice(0, 5);
const rows = await fetchAll("kaigo_visit_schedule", "user_id, visit_date, start_time, end_time, system",
  (q) => q.gte("visit_date", "2026-06-01").lt("visit_date", "2026-07-01").eq("status", "completed"));

// 実績を (利用者, 日, 開始, 終了) の集合にする = 段や2人行の重複を潰す
const actual = new Set(rows.map((r) => `${r.user_id}|${r.visit_date}|${hhmm(r.start_time)}|${hhmm(r.end_time)}`));
console.log(`実績の訪問 (重複を潰した後): ${actual.size} 件 / 生の行 ${rows.length} 件`);

// パターンを再現 (抽出 script と同じロジック)
const dowDays = new Map(), slots = new Map();
for (const r of rows) {
  const dow = new Date(`${r.visit_date}T00:00:00Z`).getUTCDay();
  const dk = `${r.user_id}|${dow}`;
  if (!dowDays.has(dk)) dowDays.set(dk, new Set());
  dowDays.get(dk).add(r.visit_date);
  const k = `${r.user_id}|${dow}|${hhmm(r.start_time)}|${hhmm(r.end_time)}|${r.system ?? ""}`;
  if (!slots.has(k)) slots.set(k, { user_id: r.user_id, dow, start: hhmm(r.start_time), end: hhmm(r.end_time), dates: new Set() });
  slots.get(k).dates.add(r.visit_date);
}
const RATIO = Number(process.env.RATIO ?? "0.6");
const pats = [...slots.values()].filter((s) => {
  const d = dowDays.get(`${s.user_id}|${s.dow}`)?.size ?? 0;
  return d > 0 && s.dates.size >= Math.max(2, d * RATIO);
});
console.log(`STABLE_RATIO = ${RATIO}`);
console.log(`パターン ${pats.length} 件`);

// 6 月の全日に展開
const june = [];
for (let d = 1; d <= 30; d++) june.push(`2026-06-${String(d).padStart(2, "0")}`);
let hit = 0, miss = 0;
const genSet = new Set();
for (const p of pats) {
  for (const d of june) {
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== p.dow) continue;
    const key = `${p.user_id}|${d}|${p.start}|${p.end}`;
    if (genSet.has(key)) continue;
    genSet.add(key);
    if (actual.has(key)) hit++; else miss++;
  }
}
const covered = [...actual].filter((k) => genSet.has(k)).length;
console.log(`\n生成される予定        ${genSet.size} 件`);
console.log(`  うち実績と一致       ${hit}  (${(hit * 100 / genSet.size).toFixed(1)}%)`);
console.log(`  実績に無い(空振り)   ${miss}  (${(miss * 100 / genSet.size).toFixed(1)}%)  ← 現場が消す作業`);
console.log(`\n実績のうち予定で拾えた ${covered} / ${actual.size}  (${(covered * 100 / actual.size).toFixed(1)}%)`);
console.log(`  拾えない(手で足す)   ${actual.size - covered}`);

// 同じ (利用者,曜日,開始,終了) が 2 件以上ないか = 重複生成の検査
const dup = new Map();
for (const p of pats) {
  const k = `${p.user_id}|${p.dow}|${p.start}|${p.end}`;
  dup.set(k, (dup.get(k) ?? 0) + 1);
}
const dups = [...dup.values()].filter((n) => n > 1).length;
console.log(`\n同一 (利用者,曜日,時刻) の重複パターン: ${dups} 件  ${dups === 0 ? "✓" : "← 制度違いで並ぶ"}`);
