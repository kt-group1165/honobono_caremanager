/**
 * キャンセル料 → 利用実費 (riyou_jippi_entries) 連動の検証
 *
 *   node migrations/seed_sample_jippi_c.mjs --execute   # 先にサンプル投入
 *   npx tsx scripts/jippi-cancel-check.mts
 *   node migrations/seed_sample_jippi_c.mjs --delete    # 撤去
 *
 * ⚠ **本番の関数 (`src/lib/visit-cancel.ts`) をそのまま呼ぶ。**逐語コピーしない。
 *
 * ── なぜ要るか ──────────────────────────────────────────────────────────
 *   本番で一度も動いていない (status='cancelled' 0 件 / riyou_jippi_entries 0 行)。
 *   ★ 「schedule_id が UNIQUE なので二重計上しない」は **設計の主張**。
 *     実際に 2 回キャンセルして 1 行しか増えないことを確かめる (3-9)。
 *
 * ⚠ この script は **サンプル利用者 (ZC2*) の行しか触らない**。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  syncCancelFeeJippi, removeCancelFeeJippi, cancelFeeItemName,
  type CancelFeeSchedule,
} from "@/lib/visit-cancel";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let n = 0, ng = 0;
const eq = (label: string, a: unknown, b: unknown) => {
  n++;
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(50)} ${ok ? "" : `実際=${JSON.stringify(a)} 期待=${JSON.stringify(b)}`}`);
};

// ── 名目の組み立て (純関数) ────────────────────────────────────────────
console.log("══ 名目の組み立て ══");
eq("キャンセル料 12/7 身体介護2", cancelFeeItemName("2026-12-07", "身体介護2"), "キャンセル料 12/7 身体介護2");
eq("0 埋めしない (12/7 であって 12/07 でない)", cancelFeeItemName("2026-12-07", "x").includes("12/07"), false);
eq("★ 日付が壊れていても名目は作る (サービス名だけ)", cancelFeeItemName("こわれ", "身体介護1"), "キャンセル料 身体介護1");

// ── サンプルを引く ──────────────────────────────────────────────────────
const { data: cl, error: e0 } = await sb.from("clients").select("id, name, user_number").like("user_number", "ZC2%");
if (e0) throw new Error(`clients: ${e0.message}`);
if (!cl?.length) {
  console.log("\n⚠ サンプル未投入。**合格とは言わない**");
  console.log("   node migrations/seed_sample_jippi_c.mjs --execute");
  process.exit(0);
}
const clientId = cl[0].id;
const { data: sched, error: e1 } = await sb.from("kaigo_visit_schedule")
  .select("id, user_id, visit_date, service_type, status, cancel_fee")
  .eq("user_id", clientId).order("visit_date");
if (e1) throw new Error(`kaigo_visit_schedule: ${e1.message}`);
console.log(`\n【分母】サンプル利用者 ${cl[0].name} / 予定 ${sched.length} 件`);
if (sched.length < 3) { console.log("⚠ 予定が 3 件未満。seed をやり直すこと"); process.exit(1); }

const S = (i: number): CancelFeeSchedule => ({
  id: sched[i].id, user_id: sched[i].user_id,
  visit_date: sched[i].visit_date, service_type: sched[i].service_type,
});
const jippi = async () => {
  const { data, error } = await sb.from("riyou_jippi_entries")
    .select("id, client_id, target_month, item_name, unit_price, quantity, amount, provide_date, notes, schedule_id")
    .eq("client_id", clientId).order("provide_date");
  if (error) throw new Error(`riyou_jippi_entries: ${error.message}`);
  return data ?? [];
};

// 前の実行が残っていたら消す (この利用者ぶんだけ)
for (const s of sched) await removeCancelFeeJippi(sb, s.id);
eq("開始時点の実費行は 0", (await jippi()).length, 0);

console.log("\n══ ① キャンセル料が実費として乗るか ══");
const r1 = await syncCancelFeeJippi(sb, S(0), 2500, "利用者都合");
eq("★ エラーなし (tenant_id を渡していないが NOT NULL 違反にならない)", [r1.error, r1.warning], [null, null]);
let rows = await jippi();
eq("実費行が 1 行できる", rows.length, 1);
eq("★ 金額 (単価 × 数量 = 金額)", [rows[0].unit_price, rows[0].quantity, rows[0].amount], [2500, 1, 2500]);
eq("対象月は訪問日の月", rows[0].target_month, "2026-12");
eq("提供日は訪問日", rows[0].provide_date, "2026-12-07");
eq("名目", rows[0].item_name, cancelFeeItemName("2026-12-07", sched[0].service_type));
eq("★ 理由が notes に入る", rows[0].notes, "キャンセル理由: 利用者都合");
eq("schedule_id が紐づく", rows[0].schedule_id, sched[0].id);

console.log("\n══ ★ ③ 二重計上 — 同じ予定を 2 回キャンセルする (本命) ══");
const r2 = await syncCancelFeeJippi(sb, S(0), 2500, "利用者都合");
eq("2 回目もエラーなし", [r2.error, r2.warning], [null, null]);
rows = await jippi();
eq("★ 行は増えない (1 行のまま)", rows.length, 1);
eq("★ 金額も二重にならない", rows[0].amount, 2500);

console.log("\n══ 金額の更新 (upsert で上書き) ══");
await syncCancelFeeJippi(sb, S(0), 4000, "事業所都合");
rows = await jippi();
eq("★ 行数は 1 のまま", rows.length, 1);
eq("★ 金額が上書きされる (2500 → 4000)", [rows[0].unit_price, rows[0].amount], [4000, 4000]);
eq("理由も上書きされる", rows[0].notes, "キャンセル理由: 事業所都合");

console.log("\n══ ② 0 円化・解除で実費行が消えるか ══");
await syncCancelFeeJippi(sb, S(0), 0, null);
eq("★ 料金 0 にすると実費行が消える (記録だけのキャンセル)", (await jippi()).length, 0);
await syncCancelFeeJippi(sb, S(0), 3000, null);
eq("再度 3000 円で復活", (await jippi()).length, 1);
await removeCancelFeeJippi(sb, sched[0].id);
eq("★ キャンセル解除 (remove) で消える", (await jippi()).length, 0);
eq("★ 存在しない予定を remove してもエラーにならない (冪等)",
  (await removeCancelFeeJippi(sb, "00000000-0000-0000-0000-000000000000")).error, null);

console.log("\n══ 境界 ══");
eq("★ 負の金額は 0 以下として扱い 行を作らない", (await syncCancelFeeJippi(sb, S(1), -100, null)).error, null);
eq("   → 行数 0", (await jippi()).length, 0);
await syncCancelFeeJippi(sb, S(1), 1, null);
eq("1 円でも行はできる", (await jippi()).length, 1);
await removeCancelFeeJippi(sb, sched[1].id);

console.log("\n══ ★ ④ 保険請求に混ざらないこと ══");
await syncCancelFeeJippi(sb, S(0), 5000, "確認用");
const { data: sch2, error: e3 } = await sb.from("kaigo_visit_schedule")
  .select("id, status, cancel_fee").eq("user_id", clientId);
if (e3) throw new Error(e3.message);
eq("★ 実費を作っても 予定の status は変わらない (連動は一方向)",
  sch2.every((s) => s.status === "completed"), true);
eq("★ 実費を作っても cancel_fee 列は書き換えられない (画面の責務)",
  sch2.every((s) => Number(s.cancel_fee ?? 0) === 0), true);
console.log("  ⚠ 保険請求 (visit-seikyu/aggregate) は `kaigo_visit_schedule` の");
console.log("     status='completed' の行だけを集計し、`riyou_jippi_entries` を **読まない**。");
console.log("     → 実費が保険の単位数に混ざる経路は **構造上ない** (grep で 0 件)。");

console.log("\n══ 後始末 ══");
for (const s of sched) await removeCancelFeeJippi(sb, s.id);
eq("★ 検査で作った実費行を残さない", (await jippi()).length, 0);

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
console.log(`⚠ サンプル利用者は残っている。撤去: node migrations/seed_sample_jippi_c.mjs --delete`);
