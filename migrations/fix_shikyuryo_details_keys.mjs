// ============================================================================
// shougai_certifications.shikyuryo_details のキーを日本語 → ローマ字に移行する。
//
// ── 何が起きていたか ──────────────────────────────────────────────────
//   受給者証 PDF 取込が「身体介護」「重度訪問介護区分６該当」等の**日本語キー**で
//   保存していたのに対し、画面 (SHIKYURYO_ITEMS) と集計 (SHIKYURYO_DEFS) は
//   "shintai" / "juudo_houmon_kubun6" 等の**ローマ字キー**で読んでいた。
//   → 受給者証画面の「支給量」欄が全員空 / 支給量超過の警告が一度も出ない、
//     という状態が続いていた (2026-08-19 発見。574 件が該当)。
//
//   金額には影響しない (請求は実績から計算するため) が、チェック機能が死んでいた。
//
//   node migrations/fix_shikyuryo_details_keys.mjs            # DRY RUN
//   node migrations/fix_shikyuryo_details_keys.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeShikyuryo, SHIKYURYO_KEYS } from "./_shikyuryo_keys.mjs";

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

async function main() {
  console.log(`=== 支給量内訳キーの正規化 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const rows = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from("shougai_certifications")
      .select("id, client_id, beneficiary_number, shikyuryo_details")
      .order("id")
      .range(off, off + 999);
    if (error) { console.error(`✗ 取得失敗: ${error.message}`); process.exit(1); }
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  console.log(`受給者証: ${rows.length} 件`);

  const targets = [];
  const unknownAll = new Map();
  let already = 0, empty = 0;
  for (const r of rows) {
    const q = r.shikyuryo_details;
    if (!q || Object.keys(q).length === 0) { empty++; continue; }
    // 全キーが既に正規キーなら触らない (冪等)
    if (Object.keys(q).every((k) => SHIKYURYO_KEYS.has(k))) { already++; continue; }
    const { details, unknown } = normalizeShikyuryo(q);
    for (const u of unknown) unknownAll.set(u, (unknownAll.get(u) ?? 0) + 1);
    targets.push({ id: r.id, before: q, after: details });
  }

  console.log(`  既に正規キー : ${already} 件`);
  console.log(`  支給量なし   : ${empty} 件`);
  console.log(`  変換対象     : ${targets.length} 件`);

  if (unknownAll.size) {
    // 対応表に無いキーは **握りつぶさず落とす前に必ず知らせる**
    console.log("\n⚠ 対応表に無いキー (変換すると消えます。中止して対応表に足してください):");
    for (const [k, n] of [...unknownAll].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
    console.log("\n✗ 未知のキーがあるため中止します。");
    process.exit(2);
  }

  // 変換内容のサンプル
  console.log("\n--- 変換例 (先頭3件) ---");
  for (const t of targets.slice(0, 3)) {
    console.log(`  ${JSON.stringify(t.before)}`);
    console.log(`   → ${JSON.stringify(t.after)}\n`);
  }
  // キー別の件数
  const kb = new Map();
  for (const t of targets) for (const k of Object.keys(t.before)) kb.set(k, (kb.get(k) ?? 0) + 1);
  console.log("--- 変換されるキー ---");
  for (const [k, n] of [...kb].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

  if (!targets.length) { console.log("\n直すものはありません。"); return; }
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で更新します。"); return; }

  const backup = path.join(KAIGO, "migrations", `_backup_shikyuryo_keys_${Date.now()}.json`);
  writeFileSync(backup, JSON.stringify(targets, null, 2), "utf8");
  console.log(`\nバックアップ: ${backup}`);

  let done = 0;
  for (const t of targets) {
    const { error } = await sb
      .from("shougai_certifications")
      .update({ shikyuryo_details: t.after })
      .eq("id", t.id);
    if (error) { console.error(`✗ 更新失敗 (${t.id}): ${error.message}`); process.exit(1); }
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${targets.length}`);
  }
  console.log(`\n✓ 完了: ${done} 件を正規キーに変換しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
