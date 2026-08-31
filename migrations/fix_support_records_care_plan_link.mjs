// ============================================================================
// 支援経過を **計画書 (care_plan_id)** に紐付ける
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   画面 (support-records) は「対応する計画期間を選択」で絞ってから記録を出す。
//
//     query.eq("care_plan_id", selectedCarePlanId)
//
//   PDF から取り込んだ記録は care_plan_id が null だったので、**画面から
//   まったく見えず**「記録がありません」になっていた (DB には 917 件あるのに)。
//
//   → 記録日が入る計画期間に紐付ける。期間に入るものが無ければ
//     その利用者の一番新しい計画に寄せる (見えなくなるよりよい)。
//
//   node migrations/fix_support_records_care_plan_link.mjs             # DRY RUN
//   node migrations/fix_support_records_care_plan_link.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

async function fetchAll(table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order("id").order("id").range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== 支援経過を計画書に紐付ける ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const recs = await fetchAll("kaigo_support_records", "id, user_id, record_date, care_plan_id");
  const orphans = recs.filter((r) => !r.care_plan_id);
  console.log(`  支援経過 ${recs.length} 件 / 計画書に紐付いていない ${orphans.length} 件`);
  if (!orphans.length) { console.log("\n✓ 直すものはありません"); return; }

  const ids = [...new Set(orphans.map((r) => r.user_id))];
  const plansByUser = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from("kaigo_care_plans")
      .select("id, user_id, start_date, end_date").in("user_id", ids.slice(i, i + 100));
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    for (const r of data ?? []) {
      if (!plansByUser.has(r.user_id)) plansByUser.set(r.user_id, []);
      plansByUser.get(r.user_id).push(r);
    }
  }

  const planFor = (uid, day) => {
    const list = plansByUser.get(uid) ?? [];
    if (!list.length) return null;
    const hit = list.find((p) =>
      (!p.start_date || p.start_date <= day) && (!p.end_date || p.end_date >= day));
    if (hit) return hit.id;
    return list.slice().sort((a, b) =>
      String(b.start_date ?? "").localeCompare(String(a.start_date ?? "")))[0].id;
  };

  const plan = [];
  let noPlan = 0;
  for (const r of orphans) {
    const pid = planFor(r.user_id, r.record_date);
    if (!pid) { noPlan++; continue; }
    plan.push({ id: r.id, care_plan_id: pid });
  }
  console.log(`  紐付ける ${plan.length} 件 / 計画書が無くて紐付けられない ${noPlan} 件`);
  if (noPlan) {
    console.log(`  ⚠ 計画書が無い利用者は画面から見えないままになる。`);
    console.log(`     import_care_plans_from_honobono_csv.mjs で計画書を入れること。`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }

  // 1 件ずつ往復すると遅いので 10 本ずつ並べる
  let n = 0;
  const queue = plan.slice();
  const worker = async () => {
    for (;;) {
      const u = queue.shift();
      if (!u) return;
      const { error } = await sb.from("kaigo_support_records")
        .update({ care_plan_id: u.care_plan_id }).eq("id", u.id);
      if (error) { console.error(`✗ ${u.id}: ${error.message}`); process.exit(1); }
      if (++n % 200 === 0) console.log(`  ${n}/${plan.length}`);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  console.log(`\n✓ ${n} 件を計画書に紐付けました`);
}

main();
