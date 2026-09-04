/**
 * ★ 所要時間の網羅率を シフト実績から測る (READ ONLY)
 *
 *   npx tsx scripts/coverage-duration.mts
 *
 * ── なぜ別の script か ──────────────────────────────────────────────────
 *   `check:coverage` は 所要時間を ★ 未測定にしている。理由は _factors.mts に
 *   書いてあるとおり「集計行は所要時間を持たず、サービス名から分数を読むのは
 *   告示の読み替えで、間違えると ★ 網羅率を実際より高く見せる」。
 *
 *   ★ ただし `kaigo_visit_schedule` は start_time / end_time を持っている。
 *   ★ 名前から推測せず、実際の時刻から測れば 根拠のある数字が出せる。
 *
 * ⚠ ★ これは「請求に使われた所要時間」ではありません。★ シフトの時刻です。
 *   ほのぼのは請求ベースの時刻を持っていて、★ 当方のシフトは待機・移動を含む
 *   (SESSION_START の B2)。★ 段の判定に使う時間とは一致しないことがあります。
 *   → ★ 「どの段が実データに出るか」の目安として読むこと。
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

const FROM = process.env.FROM ?? "2026-06-01";
const TO = process.env.TO ?? "2026-07-31";

/** _factors.mts の 所要時間 と同じ 5 値 */
const DURATION = ["20分未満", "20-30分", "30-60分", "60-90分", "90分超"] as const;
const bucketOf = (min: number): (typeof DURATION)[number] =>
  min < 20 ? "20分未満" : min < 30 ? "20-30分" : min < 60 ? "30-60分" : min < 90 ? "60-90分" : "90分超";

/** 時間帯 (障害の zoneOf と同じ切り方: 早朝6-8 / 日中8-18 / 夜間18-22 / 深夜22-6) */
const zoneOf = (startMin: number): string =>
  startMin >= 360 && startMin < 480 ? "早朝"
  : startMin >= 480 && startMin < 1080 ? "日中"
  : startMin >= 1080 && startMin < 1320 ? "夜間" : "深夜";

const toMin = (t: string | null): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

type Row = { user_id: string; start_time: string | null; end_time: string | null; service_type: string | null; staff_id_2: string | null; system: string | null };

/** ★ PostgREST は 1000 行キャップ。order 付きで必ずページングする */
async function loadSchedule(): Promise<Row[]> {
  const out: Row[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from("kaigo_visit_schedule")
      .select("user_id, start_time, end_time, service_type, staff_id_2, system")
      .eq("status", "completed")
      .gte("visit_date", FROM)
      .lte("visit_date", TO)
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`kaigo_visit_schedule 取得失敗: ${error.message}`);
    const rows = (data ?? []) as unknown as Row[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const rows = await loadSchedule();

console.log(`所要時間の網羅率 — ${FROM} 〜 ${TO} / kaigo_visit_schedule (completed) ★ ${rows.length} 行\n`);
if (rows.length === 0) { console.log("★ FAIL 0 行です。網羅率は測れません。"); process.exit(1); }

// ★ 制度で分ける。混ぜると障害の 重訪 (長時間) が介護の網羅率を押し上げる
const groups: Record<string, Row[]> = { 介護: [], 障害: [], 未設定: [] };
for (const r of rows) groups[r.system === "障害" ? "障害" : r.system === "介護" ? "介護" : "未設定"].push(r);

let unreadable = 0;
for (const [label, list] of Object.entries(groups)) {
  if (!list.length) { console.log(`── ${label}: 0 行\n`); continue; }
  const dur = new Map<string, number>();
  const zone = new Map<string, number>();
  const pair = new Set<string>();
  let n = 0;
  for (const r of list) {
    const s = toMin(r.start_time), e0 = toMin(r.end_time);
    if (s == null || e0 == null) { unreadable++; continue; }
    const e = e0 <= s ? e0 + 1440 : e0; // ★ 0 時またぎ
    const b = bucketOf(e - s);
    const z = zoneOf(s);
    dur.set(b, (dur.get(b) ?? 0) + 1);
    zone.set(z, (zone.get(z) ?? 0) + 1);
    pair.add(`${b}|${z}`);
    n++;
  }
  console.log(`── ${label}  ${n} 行`);
  const missDur = DURATION.filter((d) => !dur.has(d));
  console.log(`   所要時間 ${DURATION.length - missDur.length}/${DURATION.length}${missDur.length ? `   ★ 出ない値: ${missDur.join(" / ")}` : ""}`);
  for (const d of DURATION) console.log(`      ${d.padEnd(8)} ${String(dur.get(d) ?? 0).padStart(6)} 件`);
  const ZONES = ["日中", "早朝", "夜間", "深夜"];
  const missZone = ZONES.filter((z) => !zone.has(z));
  console.log(`   時間帯   ${ZONES.length - missZone.length}/${ZONES.length}${missZone.length ? `   ★ 出ない値: ${missZone.join(" / ")}` : ""}`);
  console.log(`   ★ 所要時間 × 時間帯 のペア: ${pair.size} / ${DURATION.length * ZONES.length}\n`);
}

if (unreadable) console.log(`⚠ 時刻が読めなかった行: ${unreadable}`);

// ★ 2人派遣は staff_id_2 では測れない — その事実を出す
const two = rows.filter((r) => r.staff_id_2).length;
const twoByName = rows.filter((r) => /２人|2人/.test((r.service_type ?? "").normalize("NFKC"))).length;
console.log("── 2人派遣 の測り方");
console.log(`   staff_id_2 が入っている行     ★ ${two} / ${rows.length}`);
console.log(`   サービス名に「2人」を含む行   ★ ${twoByName} / ${rows.length}`);
if (two === 0 && twoByName > 0) {
  console.log("   ★ staff_id_2 は使われていない。★ 2人派遣は サービス名でしか判定できない。");
  console.log("   ⚠ 「2人で行った」という事実は ★ どこにも記録されていない (名前に畳み込まれているだけ)。");
}
console.log("");
console.log("⚠ ★ これは「請求に使われた所要時間」ではありません。★ シフトの時刻です。");
console.log("   ほのぼのは請求ベースの時刻を持ち、★ 当方のシフトは待機・移動を含みます (SESSION_START B2)。");
console.log("   ★ 段の判定に使う時間とは一致しないことがあります。");
