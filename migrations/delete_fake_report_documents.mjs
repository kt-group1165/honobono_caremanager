/**
 * seed_fake_report_documents.mjs で投入した fake 帳票を全削除する cleanup script。
 *
 * 識別: content._sample_marker = "fake-reports-2026-06" を持つ行のみ DELETE。
 *
 * Usage:
 *   node migrations/delete_fake_report_documents.mjs              # DRY RUN
 *   node migrations/delete_fake_report_documents.mjs --execute    # 本番削除
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(p) {
  try {
    const e = readFileSync(p, "utf8");
    const v = {};
    for (const l of e.split("\n")) {
      const m = l.match(/^([^=]+)=(.+)$/);
      if (m) v[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return v;
  } catch { return {}; }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL =
  envKaigo.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY =
  envKaigo.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}

const EXECUTE = process.argv.includes("--execute");
const FAKE_MARKER = "fake-reports-2026-06";

async function main() {
  console.log(`\n[fake-reports DELETE]`);
  console.log(`  marker = ${FAKE_MARKER}`);
  console.log(`  mode   = ${EXECUTE ? "EXECUTE (本番削除)" : "DRY RUN"}`);
  console.log(``);

  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  // jsonb path で絞り込み (= content->>_sample_marker)
  const { data: targets, error } = await sb.from("kaigo_report_documents")
    .select("id, user_id, report_type, title, content")
    .eq("content->>_sample_marker", FAKE_MARKER);
  if (error) {
    console.error("fetch error:", error.message);
    process.exit(1);
  }

  console.log(`対象 ${targets?.length ?? 0} 件`);
  const byType = {};
  for (const r of targets ?? []) {
    byType[r.report_type] = (byType[r.report_type] ?? 0) + 1;
  }
  for (const [t, c] of Object.entries(byType)) {
    console.log(`  ${t.padEnd(22)} ${c} 件`);
  }

  if (!EXECUTE) {
    console.log("\nDRY RUN 完了。`--execute` で削除実行。");
    return;
  }

  if (!targets || targets.length === 0) {
    console.log("削除対象なし。");
    return;
  }

  const ids = targets.map((r) => r.id);
  // chunk delete
  let ok = 0, ng = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { error: dErr } = await sb.from("kaigo_report_documents")
      .delete()
      .in("id", chunk);
    if (dErr) {
      ng += chunk.length;
      console.error(`DELETE chunk ${i}: ${dErr.message}`);
    } else {
      ok += chunk.length;
      console.log(`  deleted chunk ${i}: -${chunk.length}`);
    }
  }
  console.log(`\n削除結果: 成功 ${ok} 件 / 失敗 ${ng} 件`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
