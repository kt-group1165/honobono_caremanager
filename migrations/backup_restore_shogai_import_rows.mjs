#!/usr/bin/env node
/**
 * 障害取込 (import_meisai_shougai_records.mjs) の行を 事業所×月 単位で退避 / 復元する。
 *
 *   取込は「その拠点の当月ぶんを消して入れ直す」ので、取込ロジックが変わったあとに
 *   回し直すと結果が良くも悪くも変わる。回し直す前に退避し、突合が悪化したら戻す。
 *
 *   OFFICE_ID=<uuid> TARGET_MONTH=2026-06 node migrations/backup_restore_shogai_import_rows.mjs backup
 *     → migrations/_backup_shogai_import_<office先頭8桁>_<YYYYMM>_<日時>.json (READ ONLY)
 *   BACKUP=<json> node migrations/backup_restore_shogai_import_rows.mjs restore             # DRY RUN
 *   BACKUP=<json> node migrations/backup_restore_shogai_import_rows.mjs restore --execute   # 戻す
 *
 * 対象は notes が "[MEISAI障害取込" で始まる行だけ (取込の削除条件と同じ)。
 * restore は 同じ条件の現在行を消してから 退避した行を id ごと入れ直し、件数を確かめる。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PREFIX = "[MEISAI障害取込%";
const mode = process.argv[2];
const EXECUTE = process.argv.includes("--execute");

const range = (month) => {
  const [y, m] = month.split("-").map(Number);
  return [`${month}-01`, m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`];
};

async function fetchRows(officeId, month) {
  const [from, to] = range(month);
  const out = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await sb.from("kaigo_visit_schedule").select("*")
      .eq("office_id", officeId).like("notes", PREFIX).gte("visit_date", from).lt("visit_date", to)
      .order("id").range(o, o + 999);
    if (error) throw new Error(`取得失敗: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

if (mode === "backup") {
  const officeId = process.env.OFFICE_ID, month = process.env.TARGET_MONTH;
  if (!officeId || !month) { console.error("OFFICE_ID と TARGET_MONTH が要ります"); process.exit(1); }
  const rows = await fetchRows(officeId, month);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const file = path.join(ROOT, "migrations", `_backup_shogai_import_${officeId.slice(0, 8)}_${month.replace("-", "")}_${stamp}.json`);
  writeFileSync(file, JSON.stringify({ officeId, month, count: rows.length, rows }, null, 0));
  console.log(`退避 ${rows.length} 行 → ${file}`);
} else if (mode === "restore") {
  const b = JSON.parse(readFileSync(process.env.BACKUP, "utf8"));
  const cur = await fetchRows(b.officeId, b.month);
  console.log(`${EXECUTE ? "【本番】" : "【DRY RUN】"} 現在 ${cur.length} 行を消して 退避の ${b.count} 行に戻す`);
  if (!EXECUTE) process.exit(0);
  const [from, to] = range(b.month);
  const { error: delErr } = await sb.from("kaigo_visit_schedule").delete()
    .eq("office_id", b.officeId).like("notes", PREFIX).gte("visit_date", from).lt("visit_date", to);
  if (delErr) { console.error(`✗ 削除失敗: ${delErr.message}`); process.exit(1); }
  for (let i = 0; i < b.rows.length; i += 500) {
    const { error } = await sb.from("kaigo_visit_schedule").insert(b.rows.slice(i, i + 500));
    if (error) { console.error(`✗ INSERT 失敗 (${i}〜): ${error.message}`); process.exit(1); }
  }
  const after = await fetchRows(b.officeId, b.month);
  console.log(`✓ 復元後 ${after.length} 行 (退避 ${b.count})`);
  if (after.length !== b.count) { console.error("✗ 件数が合わない"); process.exit(1); }
} else {
  console.error("使い方: backup | restore [--execute]");
  process.exit(1);
}
