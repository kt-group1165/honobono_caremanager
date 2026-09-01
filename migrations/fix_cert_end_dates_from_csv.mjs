// ============================================================================
// client_insurance_records の 認定有効期間終了日 / 限度額適用期間終了日 を、
// 最新の「介護保険1.CSV」の値で是正する。
//
// 背景 (2026-09-01): 総合事業 71R1 明細書の項18 (認定有効期間終了) が
// 大網・おゆみ野・山武で実伝送と食い違っていた。深掘りしたところ、原因は
// 「限度額適用期間を見るべき」という設計問題ではなく、**当方DBの
// certification_end_date 自体が古いスナップショットのまま**だった
// (import_cert_history.mjs の DRY RUN で「既存行と値が違う」に出ていたのに、
// その script は INSERT-only の安全設計のため書き換えていなかった)。
//
// 対象は `migrations/_import_cert_history_dryrun.json` の realConflicts のうち:
//   - certification_start_date >= 2025-01-01 (古い失効済み認定=令和元年改定前の
//     限度額差は無関係な過去分なので対象外。793件中419件がこれで、対象外)
//   - diffs に「認定終了」または「限度額適用終了」を含む
//   - diffs に「要介護度」を含まない (要介護度そのものが違うのは日付の単純ズレ
//     ではなく別人の可能性もあるため、人が確認してから直す。4件のみ・対象外)
//
// 使い方:
//   1. node migrations/import_cert_history.mjs を先に実行し
//      _import_cert_history_dryrun.json を最新化しておく
//   2. node migrations/fix_cert_end_dates_from_csv.mjs            # DRY RUN
//   3. node migrations/fix_cert_end_dates_from_csv.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

const dryRunPath = path.join(KAIGO, "migrations/_import_cert_history_dryrun.json");
const { realConflicts } = JSON.parse(readFileSync(dryRunPath, "utf8"));

function parseDiff(diffs, label) {
  const d = diffs.find((x) => x.startsWith(label));
  if (!d) return null;
  const m = /DB=(\S*) CSV=(\S+)/.exec(d);
  if (!m) return null;
  return { db: m[1] === "null" ? null : m[1], csv: m[2] };
}

// ⚠ 2026-09-01 修正: 当初は certification_start_date >= 2025-01-01 で絞っていたが、
//   2023年開始で2027年まで続く現行認定 (おゆみ野 垣谷重子等) を取りこぼした。
//   「今も関係あるか」は開始日ではなく**終了日**で判定する
//   (DB/CSV いずれかの終了日が 2025-01-01 以降なら対象)。
const eligible = realConflicts.filter((c) => {
  if (!c.diffs.some((d) => d.startsWith("認定終了") || d.startsWith("限度額適用終了"))) return false;
  if (c.diffs.some((d) => d.startsWith("要介護度"))) return false;
  const certEnd = parseDiff(c.diffs, "認定終了");
  const limEnd = parseDiff(c.diffs, "限度額適用終了");
  const dates = [certEnd?.db, certEnd?.csv, limEnd?.db, limEnd?.csv].filter(Boolean);
  return dates.some((d) => d >= "2025-01-01");
});

// 同じ行 (id) が複数の CSV から重複して出てくるので id で1本化
const byId = new Map();
for (const c of eligible) byId.set(c.id, c);

console.log(`=== 認定終了日/限度額適用終了日の是正 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
console.log(`対象 (2026-06-06 なら現行認定になり得るもの): ${byId.size} 件\n`);

const updates = [];
for (const c of byId.values()) {
  const certEnd = parseDiff(c.diffs, "認定終了");
  const limEnd = parseDiff(c.diffs, "限度額適用終了");
  const patch = {};
  if (certEnd) patch.certification_end_date = certEnd.csv;
  if (limEnd) patch.limit_period_end = limEnd.csv;
  updates.push({ id: c.id, area: c.area, name: c.name, insured: c.insured, patch, diffs: c.diffs });
  console.log(`  ${c.area.padEnd(6)} ${c.name.padEnd(10)} (${c.insured})  ${c.diffs.join(" / ")}`);
}

if (!EXECUTE) {
  console.log(`\n※ DRY RUN。--execute で ${updates.length} 件を更新します。`);
  process.exit(0);
}

// 実行前バックアップ (対象行のみ)
const { data: before, error: beforeErr } = await sb
  .from("client_insurance_records")
  .select("*")
  .in("id", updates.map((u) => u.id));
if (beforeErr) {
  console.error(`✗ バックアップ取得失敗: ${beforeErr.message}`);
  process.exit(1);
}
const backupPath = path.join(KAIGO, "migrations/_backup_cert_end_dates_20260901.json");
writeFileSync(backupPath, JSON.stringify(before, null, 2));
console.log(`\nバックアップ: ${backupPath} (${before.length} 件)`);

let n = 0;
for (const u of updates) {
  const { error } = await sb.from("client_insurance_records").update(u.patch).eq("id", u.id);
  if (error) {
    console.error(`✗ 更新失敗 (${n} 件済) id=${u.id}: ${error.message}`);
    process.exit(1);
  }
  n += 1;
}
console.log(`\n✓ ${n} 件を更新しました。`);
