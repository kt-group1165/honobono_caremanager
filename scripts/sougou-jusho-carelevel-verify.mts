/**
 * 総合事業 (71R1/7113) — 住所地特例(種別14) と 要介護3-5併用 の実データ検証
 *
 *   node migrations/seed_sample_sougou_m.mjs --execute   # 先に投入 (このscriptはREAD ONLY)
 *   npx tsx scripts/sougou-jusho-carelevel-verify.mts
 *   node migrations/seed_sample_sougou_m.mjs --delete --execute   # 撤去
 *
 * ── なぜ要るか (claude-06 割当。2026-09-04) ──────────────────────────────
 *   coverage-check.mts (別セッション) の実測で、総合事業の実データに以下が
 *   1 件も無いと判明した:
 *     住所地特例 (種別14 レコード) / 要介護3-5 と総合事業の併用
 *   限度額 ちょうど/超過 は既に G が別途サンプルで検証済み (71b3011)。
 *   ★ ここではその2つを重複させず、上記の未検証2点だけを踏ませる。
 *
 * ── 何を確認するか ────────────────────────────────────────────────────
 *   ZM001 (要支援1・住所地特例あり)  → aggregateSougouSeikyu の返り値で
 *     jushoTokurei=true / jushoTokureiInsurerNumber="123456" が付くか
 *     → buildSougouDensou の出力で 71R1 明細が 種別14・項18=123456 になるか
 *   ZM004 (要支援1・住所地特例なし。ZM001 の負のコントロール) → 種別02 のままか
 *     (「常に14で出る」実装ミスでないことの証明。値だけでなく分岐が効いているか見る)
 *   ZM002 (要介護3・認定に限度額あり)   → limitUnits が認定の値と一致するか (cert優先経路)
 *   ZM003 (要介護5・認定の限度額を空)   → limitUnits が内蔵 SOUGOU_CARE_LEVEL_LIMITS[要介護5]
 *     =36217 にフォールバックするか (aggregate-sougou.ts の定数マップの実測)
 *   ZM002/ZM003 共通 → 「要介護度で総合事業の実績があります」警告が出るか
 *   ZM001/ZM004 (要支援) → 上記の警告が出ない (要支援は対象外の負のコントロール)
 *
 * ⚠ 実データ (DB) を読む。--execute 後・--delete 前に実行すること。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateSougouSeikyu } from "@/lib/visit-seikyu/aggregate-sougou";
import { buildSougouDensou } from "@/lib/kokuho-densou/build-sougou";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ");
  process.exit(0);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const TAG = "M";
const OFFICE_ID = "4015f747-4f75-4769-a1f2-dca3db6a24fc";
const OFFICE_NUMBER_712382 = "12A8600011"; // office_sougou_numbers (保険者122382)
const YEAR = 2026, MONTH_NUM = 12;
const UNIT_PRICE = 10;

const F = (c: string[], n: number) => (c[n + 1] ?? "").replace(/"/g, "").trim();

let fails = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails++;
};

async function main() {
  console.log(`総合事業 住所地特例・要介護3-5併用 実データ検証 (marker Z${TAG}*)\n`);

  const { data: clients, error: cErr } = await sb
    .from("clients").select("id, user_number, care_level")
    .like("user_number", `Z${TAG}%`).order("user_number");
  if (cErr) throw new Error(`clients 取得失敗: ${cErr.message}`);
  if (!clients || clients.length === 0) {
    console.log("⚠ 分母 0 — サンプル未投入。**合格でも不合格でもありません**。");
    console.log("   node migrations/seed_sample_sougou_m.mjs --execute で投入してください");
    process.exit(0);
  }
  if (clients.length !== 4) {
    console.error(`✗ サンプルが揃っていません (${clients.length}/4)。` +
      `--delete --execute で撤去してから node migrations/seed_sample_sougou_m.mjs --execute を実行してください`);
    process.exit(1);
  }
  const byUn = new Map(clients.map((c) => [c.user_number, c]));
  const zm001 = byUn.get("ZM001")!, zm002 = byUn.get("ZM002")!, zm003 = byUn.get("ZM003")!, zm004 = byUn.get("ZM004")!;
  console.log(`【分母】clients ${clients.length} 件 (ZM001-004)\n`);

  const { data: sched, error: sErr } = await sb
    .from("kaigo_visit_schedule")
    .select("user_id, service_type, visit_date")
    .in("user_id", clients.map((c) => c.id))
    .eq("system", "総合事業").eq("status", "completed");
  if (sErr) throw new Error(`kaigo_visit_schedule 取得失敗: ${sErr.message}`);
  check((sched ?? []).length === 4, "実績シフト 4 件揃っている", `${(sched ?? []).length} 件`);

  // ── ① aggregateSougouSeikyu (実DBに対する本物の集計パイプライン) ──
  console.log("\n=== ① aggregateSougouSeikyu の返り値 ===");
  const { rows, warnings } = await aggregateSougouSeikyu(sb, sched ?? [], {
    officeId: OFFICE_ID, year: YEAR, month: MONTH_NUM, unitPrice: UNIT_PRICE, effectiveFormulaCodes: [],
  });
  check(rows.length === 4, "集計行 4 件", `${rows.length} 件`);
  const byId = new Map(rows.map((r) => [r.user_id, r]));
  const r1 = byId.get(zm001.id), r2 = byId.get(zm002.id), r3 = byId.get(zm003.id), r4 = byId.get(zm004.id);

  check(r1?.jushoTokurei === true, "ZM001: jushoTokurei=true", String(r1?.jushoTokurei));
  check(r1?.jushoTokureiInsurerNumber === "123456", "ZM001: jushoTokureiInsurerNumber=123456", String(r1?.jushoTokureiInsurerNumber));
  check(r4?.jushoTokurei === false, "★ ZM004(負のコントロール): jushoTokurei=false", String(r4?.jushoTokurei));

  check(r2?.limitUnits === 27048, "ZM002(要介護3・cert優先): limitUnits=27048", String(r2?.limitUnits));
  check(r3?.limitUnits === 36217, "ZM003(要介護5・内蔵マップfallback): limitUnits=36217", String(r3?.limitUnits));

  // user_name に seq を埋め込んでいないため、warningsByClient 相当を自前で組む代わりに
  // 「要介護度」文言の有無を件数で数える (要支援1名×2/要介護1名×2 の構成なので数で判定可能)
  const careLevelWarnCount = warnings.filter((w) => w.includes("区分変更月または継続利用要介護者")).length;
  check(careLevelWarnCount === 2, "「要介護度で総合事業の実績」警告が要介護3/5の2件で発火", `${careLevelWarnCount} 件`);

  console.log("\n  [参考] aggregateSougouSeikyu の全warning:");
  for (const w of warnings) console.log(`    - ${w}`);

  // ── ② buildSougouDensou (伝送様式まで) ──
  console.log("\n=== ② buildSougouDensou の出力 (71R1 種別02/14) ===");
  const target = rows.filter((r) => r.insurer_number === "122382");
  const result = buildSougouDensou(target, {
    officeNumber: OFFICE_NUMBER_712382, year: YEAR, month: MONTH_NUM, unitPrice: UNIT_PRICE,
  } as never);
  const lines = result.content.split(/\r?\n/).filter(Boolean).map((l: string) => l.split(","));
  const details = lines.filter((c) => F(c, 1) === "71R1" && (F(c, 2) === "02" || F(c, 2) === "14"));
  check(details.length === 4, "71R1 明細行 4 件", `${details.length} 件`);
  const jushoWarnCount = result.warnings.filter((w: string) => w.includes("種別14")).length;
  check(jushoWarnCount === 1, "「種別14で出力します」警告が住所地特例1件だけで発火", `${jushoWarnCount} 件`);
  console.log("\n  [参考] buildSougouDensou の全warning:");
  for (const w of result.warnings) console.log(`    - ${w}`);

  const detailByInsured = new Map(details.map((c) => [F(c, 6), c]));
  const d1 = detailByInsured.get(r1?.insured_number ?? "");
  const d4 = detailByInsured.get(r4?.insured_number ?? "");
  check(!!d1 && F(d1, 2) === "14", "ZM001: 71R1 明細が種別14で出力される", d1 ? F(d1, 2) : "行なし");
  check(!!d1 && F(d1, 18) === "123456", "ZM001: 項18(施設所在保険者番号)=123456", d1 ? F(d1, 18) : "行なし");
  check(!!d4 && F(d4, 2) === "02", "★ ZM004(負のコントロール): 71R1 明細が種別02のまま", d4 ? F(d4, 2) : "行なし");
  check(!!d4 && F(d4, 18) === "", "★ ZM004: 項18は空 (住所地特例フラグが無ければ埋まらない)", d4 ? `"${F(d4, 18)}"` : "行なし");

  console.log(`\n${fails === 0 ? "すべて PASS" : `★ ${fails} 件 FAIL`}`);
  if (fails > 0) process.exit(1);
}

main().catch((e) => { console.error("エラー:", e); process.exit(1); });
