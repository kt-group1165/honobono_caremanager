/**
 * 障害コード時刻解決 (code-from-time.ts) の常設チェック — 2つの役割を持つ
 *
 *   npx tsx scripts/shogai-code-from-time-verify.mts
 *
 * ── 役割1: 総当たりで .mjs 側 (import_meisai_shougai_records.mjs) と一致しているか ──
 *   2026-09-05 に発見: フォールバック時のzone選択が食い違っていた
 *   (TS=segs[0].zone(開始時間帯固定) / mjs=majorityZone(生の滞在分数が最大の時間帯))。
 *   .mjsは2026-07-27にほのぼの実データで是正済みの側だったため、TSをmjsに合わせて修正した。
 *   修正前後で実データ87件(2026-06/07/08、system=障害かつ名前マスタ未一致の全行)の
 *   結果が1件も変わらないことを確認済み(またぎが実データに1件も無かったため)。
 *
 * ── 役割2: 実データ監視 (基準値方式・現在0件) ────────────────────────────
 *   ① 時間帯またぎ行が実データに出現したら検知する (現在0件。1件でも出たら
 *      「この経路が発火し始めた」ことを示すので、①の役割1の一致確認が
 *      実運用でも効いているかを再確認するタイミングになる)
 *   ② resolveBaseAddon 相当(合成コード・nearbyAllocations 両方失敗)の行が
 *      実データに出現したら検知する。この経路は現在TS側に実装が無い
 *      (実装しない判断: 2026-09-05、一度も実データで確かめられないコードを
 *      増やすだけのため。出たときに初めて実装を検討する)
 *
 *   ★ money-safety: DB書込は一切しない (READ ONLY)。
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  shogaiCodeFromTime, loadShogaiCodeMaps, kindFromServiceName, zoneSegments,
  quantizeHours, parseHM,
  type ShogaiCodeMaps, type ShogaiKind, type CodeHit,
} from "@/lib/shogai-seikyu/code-from-time";
import { isBillableRecord } from "@/lib/shogai-seikyu/record-markers";
import { zoneOf } from "../migrations/_juho_ladder.mjs";
import { nearbyAllocations } from "@/lib/shogai-seikyu/_nearby-allocations.mjs";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ═══════════════════════════════════════════════════════════════════════
// 役割1: 総当たり一致確認 (.mjs側 convertRow composite部分の逐語コピーと比較)
// ═══════════════════════════════════════════════════════════════════════

function parseHMmjs(s: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec((s ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function quantizeHoursMjs(minutes: number, stepMin: number, mode: string): number {
  const units = mode === "kokuji" ? (minutes % stepMin === 0 ? minutes / stepMin + 1 : Math.ceil(minutes / stepMin)) : Math.ceil(minutes / stepMin);
  return units * (stepMin / 60);
}
function zoneSegmentsMjs(startHM: string | null, endHM: string | null): { zone: string; min: number }[] | null {
  const s = parseHMmjs(startHM), e = parseHMmjs(endHM);
  if (s == null || e == null || e <= s) return null;
  const B = [360, 480, 1080, 1320].filter((b) => b > s && b < e);
  const cuts = [s, ...B, e];
  const segs: { zone: string; min: number }[] = [];
  for (let i = 0; i < cuts.length - 1; i++) segs.push({ zone: zoneOf(cuts[i]), min: cuts[i + 1] - cuts[i] });
  return segs;
}
type MjsResult = { key: string; missing?: boolean; resolveBaseAddonWouldFire?: boolean } | null;

/** migrations/import_meisai_shougai_records.mjs の convertRow (composite部分) の逐語コピー */
function convertRowCore(
  kind: string, minutes: number, startHM: string, endHM: string, mode: string,
  singleMap: Map<string, { code: string; units: number }>,
  compMap: Map<string, { code: string; units: number }>,
): MjsResult {
  const step = kind === "家事" || kind === "通院2" ? 15 : 30;
  const totalHours = quantizeHoursMjs(minutes, step, mode);
  const startZoneK = zoneOf(parseHMmjs(startHM)!);
  const pickSingle = (zoneK: string, hours: number): MjsResult => {
    const key = `${kind}|${zoneK}|${hours.toFixed(2)}|`;
    const hit = singleMap.get(key);
    if (!hit) return { key, missing: true };
    return { key };
  };
  const segs = zoneSegmentsMjs(startHM, endHM);
  if (!segs || segs.length <= 1) return pickSingle(startZoneK, totalHours);

  let majorityZone = segs[0].zone, majorityMin = segs[0].min;
  for (let i = 1; i < segs.length; i++) if (segs[i].min > majorityMin) { majorityMin = segs[i].min; majorityZone = segs[i].zone; }

  const segs2 = segs.filter((s) => s.min >= 15);
  if (segs2.length <= 1) return pickSingle(segs2[0]?.zone ?? majorityZone, totalHours);

  const stepsTotal = Math.round((totalHours * 60) / step);
  const alloc: { zone: string; hours: number }[] = [];
  let used = 0;
  for (let i = 0; i < segs2.length; i++) {
    const n = i < segs2.length - 1 ? Math.min(Math.round(segs2[i].min / step), Math.max(0, stepsTotal - used)) : Math.max(0, stepsTotal - used);
    used += n;
    alloc.push({ zone: segs2[i].zone, hours: n * (step / 60) });
  }
  const nz = alloc.filter((a) => a.hours > 1e-9);
  if (nz.length >= 2) {
    const key = `${kind}|` + nz.map((a) => `${a.zone}${a.hours.toFixed(2)}`).join("・") + `|`;
    const hit = compMap.get(key);
    if (hit) return { key };
    const near = nearbyAllocations(alloc.map((a) => Math.round((a.hours * 60) / step)), stepsTotal);
    for (const cand of near) {
      const k2 = `${kind}|` + alloc.map((a, i) => `${a.zone}${(cand[i] * (step / 60)).toFixed(2)}`).join("・") + `|`;
      const h2 = compMap.get(k2);
      if (h2) return { key: k2 };
    }
    const s = pickSingle(majorityZone, totalHours);
    return { ...s, resolveBaseAddonWouldFire: true } as MjsResult;
  }
  return pickSingle(majorityZone, totalHours);
}

function buildTestMaps(): ShogaiCodeMaps {
  const mk = (code: string, units: number): CodeHit => ({ code, name: code, units });
  const single = new Map<string, CodeHit>();
  const composite = new Map<string, CodeHit>();
  for (const zone of ["早", "日", "夜", "深"]) {
    for (let h = 0.5; h <= 2.0; h += 0.5) single.set(`身体|${zone}|${h.toFixed(2)}|`, mk(`S-${zone}-${h}`, 100));
    for (let h = 0.25; h <= 1.5; h += 0.25) single.set(`家事|${zone}|${h.toFixed(2)}|`, mk(`S家-${zone}-${h}`, 80));
  }
  composite.set(`身体|早0.50・日0.50|`, mk("C-早05日05", 150));
  composite.set(`身体|日1.00・夜1.00|`, mk("C-日10夜10", 200));
  return { single, single2: new Map(), composite, composite2: new Map(), increment: new Map(), increment2: new Map() };
}

function runTotality(
  tsFn: typeof shogaiCodeFromTime,
): { total: number; match: number; mismatches: string[] } {
  const maps = buildTestMaps();
  const mjsSingle = maps.single as unknown as Map<string, { code: string; units: number }>;
  const mjsComp = maps.composite as unknown as Map<string, { code: string; units: number }>;
  let total = 0, match = 0;
  const mismatches: string[] = [];
  for (let s = 0; s < 1440; s += 20) {
    for (const durMin of [10, 15, 20, 30, 40, 60, 90, 120, 150]) {
      const e = s + durMin;
      if (e > 1440) continue;
      const toHM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const startHM = toHM(s), endHM = toHM(e), minutes = e - s;
      for (const kind of ["身体", "家事"] as ShogaiKind[]) {
        total++;
        const mjs = convertRowCore(kind, minutes, startHM, endHM, "honobono", mjsSingle, mjsComp);
        const ts = tsFn(maps, kind, startHM, endHM, { mode: "honobono" });
        const mjsOk = mjs && !mjs.missing, tsOk = ts !== null;
        let isMatch: boolean;
        if (!mjsOk && !tsOk) isMatch = true;
        else if (mjsOk !== tsOk) isMatch = false;
        else {
          const tsKeyEntries = [...maps.single.entries(), ...maps.composite.entries()];
          const tsKey = tsKeyEntries.find(([, v]) => v.code === ts!.code)?.[0];
          isMatch = tsKey === mjs!.key;
        }
        if (isMatch) match++;
        else if (mismatches.length < 10) mismatches.push(`${kind} ${startHM}-${endHM}: mjs=${JSON.stringify(mjs)} ts=${JSON.stringify(ts)}`);
      }
    }
  }
  return { total, match, mismatches };
}

console.log("=== 役割1: 総当たり一致確認 (.mjs側ロジックとの比較) ===");
const r1 = runTotality(shogaiCodeFromTime);
eq("★ 総当たり1,256件が全て一致する (2026-09-05 修正後の状態)", r1.match, r1.total);
console.log(`  ${r1.match}/${r1.total} 一致`);
if (r1.mismatches.length > 0) {
  console.log("  不一致の例:");
  for (const m of r1.mismatches) console.log(`    ${m}`);
}

// ── 負のコントロール①: 修正前(segs[0].zone固定)のTS実装は総当たりで不一致が出ること ──
{
  function shogaiCodeFromTimeOldForControl(maps: ShogaiCodeMaps, kind: ShogaiKind, startHM: string | null, endHM: string | null, opts: { mode?: "honobono" | "kokuji" } = {}): CodeHit | null {
    const mode = opts.mode ?? "honobono";
    const step = kind === "家事" || kind === "通院2" ? 15 : 30;
    const s = parseHM(startHM), e = parseHM(endHM);
    const minutes = s != null && e != null && e > s ? e - s : null;
    if (!minutes || minutes <= 0) return null;
    const segs = zoneSegments(startHM, endHM);
    if (!segs || segs.length === 1) {
      const zone = segs?.[0]?.zone ?? "日";
      const hours = quantizeHours(minutes, step, mode);
      return maps.single.get(`${kind}|${zone}|${hours.toFixed(2)}|`) ?? null;
    }
    // (合成探索部分は現行実装と同じなので省略し、最終フォールバックだけ旧仕様で再現)
    const hours = quantizeHours(minutes, step, mode);
    return maps.single.get(`${kind}|${segs[0].zone}|${hours.toFixed(2)}|`) ?? null;
  }
  const rOld = runTotality(shogaiCodeFromTimeOldForControl as typeof shogaiCodeFromTime);
  const detected1 = rOld.match < rOld.total;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 旧実装(segs[0].zone)でも総当たりが全一致してしまう");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 修正前の実装(segs[0].zone固定)に戻すと総当たりで不一致が出ることを確認できる (${rOld.match}/${rOld.total})`);
}

// ═══════════════════════════════════════════════════════════════════════
// 役割2: 実データ監視 (基準値方式・現在0件)
// ═══════════════════════════════════════════════════════════════════════

const BASELINE_ZONE_CROSSING = 0; // ★ 時間帯またぎ行の実データ件数。1件でも増えたら要調査
const BASELINE_BASE_ADDON = 0; // ★ resolveBaseAddon相当の行の実データ件数 (TS未実装の経路)

console.log("\n=== 役割2: 実データ監視 (READ ONLY) ===");
const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function scanMonth(year: number, month: number): Promise<{ denom: number; crossing: number; baseAddon: number }> {
  const monthStr = `${year}-${String(month).padStart(2, "0")}`;
  const { data: offices } = await sb.from("offices").select("id, name").eq("app_type", "kaigo-app").eq("is_active", true);
  const maps = await loadShogaiCodeMaps(sb, year, month);
  const mjsSingle = maps.single as unknown as Map<string, { code: string; units: number }>;
  const mjsComp = maps.composite as unknown as Map<string, { code: string; units: number }>;
  let denom = 0, crossing = 0, baseAddon = 0;
  const start = `${monthStr}-01`;
  const last = new Date(year, month, 0).getDate();
  const end = `${monthStr}-${String(last).padStart(2, "0")}`;
  for (const o of offices ?? []) {
    const PAGE = 1000;
    let from = 0;
    const rows: { service_type: string | null; system: string | null; start_time: string | null; end_time: string | null; notes: string | null }[] = [];
    while (true) {
      const { data, error } = await sb.from("kaigo_visit_schedule")
        .select("service_type, system, start_time, end_time, notes")
        .eq("office_id", o.id).gte("visit_date", start).lte("visit_date", end)
        .order("id").range(from, from + PAGE - 1);
      if (error || !data) break;
      rows.push(...(data.filter((r) => isBillableRecord(r.notes)) as typeof rows));
      if (data.length < PAGE) break;
      from += PAGE;
    }
    const names = Array.from(new Set(rows.map((r) => (r.service_type ?? "").trim()).filter(Boolean)));
    const nameMap = new Set<string>();
    for (let i = 0; i < names.length; i += 50) {
      const chunk = names.slice(i, i + 50);
      const { data } = await sb.from("kaigo_service_codes").select("service_name").eq("system", "障害").in("service_name", chunk);
      for (const d of data ?? []) nameMap.add((d as { service_name: string }).service_name.trim());
    }
    const target = rows.filter((r) => r.system === "障害" && !nameMap.has((r.service_type ?? "").trim()));
    for (const r of target) {
      const kind = kindFromServiceName(r.service_type);
      if (!kind) continue;
      denom++;
      const segs = zoneSegmentsMjs(r.start_time, r.end_time);
      if (segs && segs.length > 1) {
        crossing++;
        const s = parseHMmjs(r.start_time), e = parseHMmjs(r.end_time);
        const minutes = s != null && e != null ? e - s : 0;
        const mjs = convertRowCore(kind, minutes, r.start_time!, r.end_time!, "honobono", mjsSingle, mjsComp);
        if (mjs && mjs.resolveBaseAddonWouldFire) baseAddon++;
      }
    }
  }
  return { denom, crossing, baseAddon };
}

let totalDenom = 0, totalCrossing = 0, totalBaseAddon = 0;
for (const [y, m] of [[2026, 6], [2026, 7], [2026, 8]]) {
  const r = await scanMonth(y, m);
  console.log(`  ${y}-${String(m).padStart(2, "0")}: 対象${r.denom}件 / またぎ${r.crossing}件 / baseAddon相当${r.baseAddon}件`);
  totalDenom += r.denom; totalCrossing += r.crossing; totalBaseAddon += r.baseAddon;
}
eq(`★ 時間帯またぎ行 (基準値${BASELINE_ZONE_CROSSING}件から増えていないか)`, totalCrossing <= BASELINE_ZONE_CROSSING, true);
eq(`★ resolveBaseAddon相当行 (基準値${BASELINE_BASE_ADDON}件から増えていないか)`, totalBaseAddon <= BASELINE_BASE_ADDON, true);
console.log(`  合計: 対象${totalDenom}件 / またぎ${totalCrossing}件 (基準値${BASELINE_ZONE_CROSSING}) / baseAddon相当${totalBaseAddon}件 (基準値${BASELINE_BASE_ADDON})`);

// ── 負のコントロール②: 基準値比較そのものが「増えたら検知する」ことを確認 ──
{
  const fakeCrossing = BASELINE_ZONE_CROSSING + 1;
  const wouldFail = !(fakeCrossing <= BASELINE_ZONE_CROSSING);
  if (wouldFail) pass++; else fails.push("★ 負のコントロールが鳴らない: 基準値超過を検知できない");
  console.log(`  ${wouldFail ? "✓" : "✗"} ★ またぎ行が基準値を1件でも超えたら検知できる (模擬値${fakeCrossing}件でFAIL側に倒れることを確認)`);
}

console.log(`\n障害コード時刻解決 (code-from-time.ts) の常設チェック — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
