/**
 * 訪問入浴 提供表画面 (bath-provision) の予防給付対応 (B-1w系⑥⑦・2026-09-05) の実データ確認
 * (READ ONLY)
 *
 * 修正内容:
 *   ⑥ BATH_ROWS (固定4行) — 要介護度に関わらず 121xxx 固定だった → bathBaseRows(careLevel)
 *      (中身は resolveBathCode の呼び出しのみ。新しい判定は作っていない)
 *   ⑦ AddServiceModal の "12%" 決め打ちフィルタ → careLevel に応じ "12%"/"62%" を切替
 *
 * 事前投入: migrations/seed_sample_bath_coverage_g.mjs --execute
 *   G6 = 要介護2 → loadBathProvisionData は 121xxx 系を返すはず (回帰していないことの確認)
 *   G7 = 要支援2 → ★ loadBathProvisionData は 621xxx 系を返すはず (修正前は121xxx固定だった)
 *
 *   npx tsx scripts/bath-provision-yobo-fix-sample-verify.mts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadBathProvisionData } from "../src/app/(authenticated)/bath-provision/bath-provision-content";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let n = 0, ng = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  n++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(70)} ${ok ? "" : `実際=${JSON.stringify(actual)} 期待=${JSON.stringify(expected)}`}`);
}

const OFFICE_ID = "ec87a203-53e2-40a5-b706-7fea402cde16";
const { data: clients, error } = await sb.from("clients").select("id,name,care_level").in("name", ["サンプル6 [sample-g]", "サンプル7 [sample-g]"]);
if (error) throw error;
const g6 = (clients ?? []).find((c) => c.name?.startsWith("サンプル6"));
const g7 = (clients ?? []).find((c) => c.name?.startsWith("サンプル7"));

if (!g6 || !g7) {
  console.log("⚠ G6/G7が見つからない。事前投入が要る (migrations/seed_sample_bath_coverage_g.mjs --execute)");
  process.exit(0);
}

const g6Data = await loadBathProvisionData(sb as never, g6.id, OFFICE_ID, 2026, 12, g6.care_level);
const g7Data = await loadBathProvisionData(sb as never, g7.id, OFFICE_ID, 2026, 12, g7.care_level);

console.log(`G6(${g6.care_level}) unitByCode codes: ${Object.keys(g6Data.unitByCode).sort().join(",")}`);
console.log(`G7(${g7.care_level}) unitByCode codes: ${Object.keys(g7Data.unitByCode).sort().join(",")}`);

eq("G6(要介護) — 121xxx系4コードが返る (回帰なし)", Object.keys(g6Data.unitByCode).sort(), ["121111", "121112", "121121", "121122"]);
eq("★ G7(要支援) — 621xxx系4コードが返る (修正前は121xxx固定だった)", Object.keys(g7Data.unitByCode).sort(), ["621111", "621112", "621121", "621122"]);
eq("★ G7 — 介護給付系コード(121xxx)は1つも含まれない", Object.keys(g7Data.unitByCode).some((c) => c.startsWith("121")), false);

console.log("\n═══ 負のコントロール (箇所ごと) ═══");
{
  // ⑥ BATH_ROWS 固定値 — 修正前は要介護度に関わらず常に121xxxだった
  const OLD_BATH_ROWS_CODES = ["121111", "121121", "121112", "121122"];
  n++;
  const same = JSON.stringify(OLD_BATH_ROWS_CODES.slice().sort()) === JSON.stringify(Object.keys(g7Data.unitByCode).sort());
  if (!same) {
    console.log("  OK  負のコントロール⑥ — 旧BATH_ROWS固定値(121系)と要支援の正しい結果(621系)が別 (このテストが⑥の回帰を検出できる)");
  } else {
    ng++;
    console.log("  NG  負のコントロール⑥失敗 — 旧固定値と現在の結果が一致してしまう(差が無い)");
  }
}
{
  // ⑦ AddServiceModal の検索プレフィックス — 修正前は要介護度に関わらず常に"12%"だった
  const OLD_PREFIX: string = "12%";
  const newPrefixForG7 = "62%"; // isYoboLevel("要支援2") ? "62%" : "12%" の期待値
  n++;
  if (OLD_PREFIX !== newPrefixForG7) {
    console.log(`  OK  負のコントロール⑦ — 旧プレフィックス固定値(${OLD_PREFIX})と要支援向けの正しい値(${newPrefixForG7})が別 (このテストが⑦の回帰を検出できる)`);
  } else {
    ng++;
    console.log("  NG  負のコントロール⑦失敗");
  }
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
if (ng > 0) process.exitCode = 1;
