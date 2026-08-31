// ============================================================================
// 「100000 + 元番号」でリナンバーされた **同名の残骸 client** を本体に寄せて削除する。
//
// ── なぜできるか ──────────────────────────────────────────────────────
//   障害の受給者証取込 (import_honobono_shougai_oami.mjs) は user_number の
//   unique 衝突時に 100000+n へリナンバーして新規作成する。
//   その後 介護の STEP1 が同じ人を本来の番号で作ると **同名 2 レコード**になり、
//   次に障害を取り込もうとすると「氏名が複数の既存利用者と一致」で中断する
//   (生年月日は受給者証一覧表からは取れないため一意に決められない)。
//   実証: 木更津 髙橋年枝 — 102570 (8/4 障害取込・実績0) と 2570 (8/5 STEP1・6月実績41)。
//
// ── 寄せ方 ────────────────────────────────────────────────────────────
//   残骸 = 100000+X の番号を持ち、X が同名で存在し、**残骸側に実績が無い**もの。
//   実績がある残骸は自動処理しない (統合の判断が要るため一覧に出して中断)。
//   受給者証 / assignment / 認定 は本体へ付け替えてから残骸を削除する。
//
//   node migrations/merge_renumbered_client_leftovers.mjs            # DRY RUN
//   node migrations/merge_renumbered_client_leftovers.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");

function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** 残骸から本体へ付け替える子テーブル (列名は client 参照列) */
const MOVE = [
  ["shougai_certifications", "client_id"],
  ["client_insurance_records", "client_id"],
  ["client_office_assignments", "client_id"],
];

async function count(table, col, id) {
  const { count: c, error } = await sb.from(table).select("id", { count: "exact", head: true }).eq(col, id);
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") return 0;
    throw new Error(`${table}: ${error.message}`);
  }
  return c ?? 0;
}

async function main() {
  console.log(`=== リナンバー残骸 client の統合 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("clients")
      .select("id, name, user_number, birth_date, insured_number, created_at")
      .order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < 1000) break;
  }
  const byNum = new Map(all.map((c) => [String(c.user_number), c]));

  const plan = [];
  const blocked = [];
  for (const c of all) {
    const n = String(c.user_number);
    if (!/^1\d{5}$/.test(n)) continue;
    const orig = byNum.get(String(Number(n) - 100000));
    if (!orig || orig.name !== c.name) continue;

    const visits = await count("kaigo_visit_schedule", "user_id", c.id);
    const row = {
      leftover: c,
      main: orig,
      visits,
      certs: await count("shougai_certifications", "client_id", c.id),
      ins: await count("client_insurance_records", "client_id", c.id),
      asg: await count("client_office_assignments", "client_id", c.id),
    };
    (visits > 0 ? blocked : plan).push(row);
  }

  for (const r of [...plan, ...blocked]) {
    const tag = r.visits > 0 ? "⛔ 実績あり (手動判断)" : "→ 統合";
    console.log(
      `  ${String(r.leftover.user_number).padEnd(7)} → ${String(r.main.user_number).padEnd(7)} ` +
        `${(r.leftover.name + "            ").slice(0, 12)} 実績${r.visits} 障害証${r.certs} 認定${r.ins} 所属${r.asg}  ${tag}`,
    );
  }
  console.log(`\n統合対象: ${plan.length} 件 / 実績があり手動判断: ${blocked.length} 件`);
  if (blocked.length) {
    console.log("⚠ 実績のある残骸は自動で寄せません (どちらが正か業務判断が要るため)");
  }
  if (!plan.length) {
    console.log("\n対象なし。");
    return;
  }
  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で統合します。");
    return;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const bakPath = fileURLToPath(new URL(`./_backup_renumber_leftovers_${stamp}.json`, import.meta.url));
  writeFileSync(bakPath, JSON.stringify(plan.map((p) => p.leftover), null, 1), "utf8");
  console.log(`\nバックアップ: ${bakPath.split(/[\\/]/).pop()}`);

  let moved = 0, deleted = 0;
  for (const p of plan) {
    for (const [table, col] of MOVE) {
      const { error, count: c } = await sb
        .from(table)
        .update({ [col]: p.main.id }, { count: "exact" })
        .eq(col, p.leftover.id);
      if (error) {
        // 一意制約 (同じ人に同じ assignment) にぶつかったら残骸側を捨てる
        if (error.code === "23505") {
          const { error: dErr } = await sb.from(table).delete().eq(col, p.leftover.id);
          if (dErr) { console.error(`✗ ${p.leftover.name} ${table} 削除: ${dErr.message}`); process.exit(1); }
          continue;
        }
        if (error.code === "42P01" || error.code === "PGRST205") continue;
        console.error(`✗ ${p.leftover.name} ${table}: ${error.message}`);
        process.exit(1);
      }
      moved += c ?? 0;
    }
    const { error: delErr } = await sb.from("clients").delete().eq("id", p.leftover.id);
    if (delErr) { console.error(`✗ ${p.leftover.name} clients 削除: ${delErr.message}`); process.exit(1); }
    deleted++;
  }
  console.log(`✓ 完了: 子レコード付け替え ${moved} 行 / 残骸 client 削除 ${deleted} 件`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
