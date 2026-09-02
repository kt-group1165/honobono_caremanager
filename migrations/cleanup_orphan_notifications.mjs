// 参照先が消えた通知を掃除する (dry-run 付き)。
//
// ── なぜ要るか (2026-09-03 実測) ──────────────────────────────────────────
//   認定アラート 220 件のうち **30 件は ref_id の指す認定行がもう存在しない**。
//   クリックしても「参照先が見つかりません」で何も起きず、既読にもできないので
//   未読のまま残り続ける。実際 220 件は全件未読・最長 113 日経過で、
//   古い通知が積もると本物のアラートに対応する気が失せる。
//
//   ⚠ 通知が消えても、条件がまだ成立していれば **次のダッシュボード読込で作り直される**
//     (重複防止キーは office_id + type + ref_id なので、行が消えれば再 INSERT される)。
//     つまりこの掃除で「対応すべきものが消える」ことはない。
//
// ── 対象 ──────────────────────────────────────────────────────────────
//   ref_table が実在テーブルで、ref_id がそのテーブルに無い通知。
//   ⚠ ref_table が未知のものは触らない (知らない種別を消さない)。
//
//   node migrations/cleanup_orphan_notifications.mjs            # DRY RUN
//   node migrations/cleanup_orphan_notifications.mjs --execute
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** PostgREST の range ページングは order 必須 (無いと行が抜ける) */
async function pageAll(table, cols, orderCol = "id") {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(orderCol).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.code} ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== 参照先が消えた通知の掃除 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const rows = await pageAll("notifications", "id, type, ref_table, ref_id, read_at, created_at, title");
  console.log(`notifications 総数 ${rows.length} 件  ← 分母`);

  const byTable = new Map();
  let noRef = 0;
  for (const r of rows) {
    if (!r.ref_table || !r.ref_id) { noRef++; continue; }
    if (!byTable.has(r.ref_table)) byTable.set(r.ref_table, []);
    byTable.get(r.ref_table).push(r);
  }
  console.log(`  ref_table / ref_id が無い (掃除対象外) ${noRef} 件`);

  const orphans = [];
  const skipped = [];
  for (const [table, list] of byTable) {
    const ids = [...new Set(list.map((r) => r.ref_id))];
    const alive = new Set();
    let failed = null;
    for (let i = 0; i < ids.length; i += 150) {
      const { data, error } = await sb.from(table).select("id").in("id", ids.slice(i, i + 150));
      if (error) { failed = `${error.code} ${error.message}`; break; }
      for (const d of data) alive.add(d.id);
    }
    if (failed) {
      // ⚠ 引けなかったテーブルは「参照先が無い」と判定しない (消しすぎるため)
      skipped.push([table, list.length, failed]);
      continue;
    }
    const dead = list.filter((r) => !alive.has(r.ref_id));
    console.log(`  ${table.padEnd(28)} 通知 ${String(list.length).padStart(4)} 件 / 参照先が無い ${dead.length} 件`);
    orphans.push(...dead);
  }
  for (const [t, n, e] of skipped) console.log(`  ⚠ ${t}: ${n} 件は判定できず (${e}) → 触らない`);

  console.log(`\n★ 削除対象 ${orphans.length} 件`);
  if (orphans.length === 0) { console.log("掃除するものはありません。"); return; }
  const unread = orphans.filter((r) => !r.read_at).length;
  console.log(`   うち未読 ${unread} 件 (未読のまま消せないので残っていたもの)`);
  for (const r of orphans.slice(0, 12))
    console.log(`     ${String(r.created_at).slice(0, 10)} ${r.type.padEnd(20)} ${String(r.title).slice(0, 38)}`);
  if (orphans.length > 12) console.log(`     … 他 ${orphans.length - 12} 件`);

  console.log(
    `\n⚠ 条件がまだ成立しているものは、次のダッシュボード読込で作り直されます` +
      ` (重複防止キーに ref_id を使っているため)。対応すべきものが消えるわけではありません。`,
  );

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で削除します。"); return; }

  let ok = 0;
  for (let i = 0; i < orphans.length; i += 100) {
    const ids = orphans.slice(i, i + 100).map((r) => r.id);
    const { error } = await sb.from("notifications").delete().in("id", ids);
    if (error) { console.error(`✗ 削除に失敗: ${error.message}`); process.exit(1); }
    ok += ids.length;
  }
  console.log(`\n✓ ${ok} 件を削除しました`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
