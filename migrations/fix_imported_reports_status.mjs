// ============================================================================
// ほのぼのから取り込んだ帳票の status を draft → completed に直す
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   import_care_plan_1_from_honobono_csv.mjs が status を 'draft' 固定で
//   入れていた。ほのぼの側で**確定済みの計画書**を写したものなので、
//   画面に「下書き」と出るのは実態と違う (2,954 件すべて下書きになっていた)。
//
//   画面の表示は reports-content.tsx:5247
//     doc.status === "completed" ? "完成" : "下書き"
//
// ── 対象の絞り方 ────────────────────────────────────────────────────────
//   人が画面で作った下書きを巻き込むと**書きかけを勝手に完成にしてしまう**。
//   取込で作ったものだけに絞る:
//
//     report_type   … 取込した種別のみ
//     status        … draft のみ
//     created_at    … 取込を流した日 (--on) のみ
//     created_by    … null (画面から作ると入る)
//
//   node migrations/fix_imported_reports_status.mjs --on 2026-08-31            # DRY RUN
//   node migrations/fix_imported_reports_status.mjs --on 2026-08-31 --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const ON = argOf("--on");
const TYPES = (argOf("--types") ?? "care-plan-1").split(",");

if (!ON) {
  console.error("使い方: --on <YYYY-MM-DD> [--types care-plan-1,...] [--execute]");
  console.error("  --on は取込を流した日 (created_at)。これで人が作った下書きと切り分ける。");
  process.exit(1);
}

const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

async function fetchAll(tweak) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await tweak(
      sb.from("kaigo_report_documents").select("id, report_type, status, created_by, created_at"),
    ).range(from, from + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== 取込帳票の status 是正 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);
  console.log(`  対象種別 ${TYPES.join(" / ")} / 取込日 ${ON}`);

  const rows = await fetchAll((q) => q
    .in("report_type", TYPES)
    .eq("status", "draft")
    .is("created_by", null)
    .gte("created_at", `${ON}T00:00:00Z`)
    .lt("created_at", `${ON}T23:59:59.999Z`));

  console.log(`  直す ${rows.length} 件`);

  // 巻き込んでいないか見えるように、除外されたぶんも数える
  const allDraft = await fetchAll((q) => q.in("report_type", TYPES).eq("status", "draft"));
  const skipped = allDraft.length - rows.length;
  if (skipped > 0) {
    console.log(`  ⚠ 下書きのまま残す ${skipped} 件 (取込日が違う / created_by あり = 人が作ったもの)`);
  }

  if (!rows.length) { console.log("\n✓ 直すものはありません"); return; }
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }

  let n = 0;
  const queue = rows.slice();
  const worker = async () => {
    for (;;) {
      const r = queue.shift();
      if (!r) return;
      const { error } = await sb.from("kaigo_report_documents")
        .update({ status: "completed" }).eq("id", r.id);
      if (error) { console.error(`✗ ${r.id}: ${error.message}`); process.exit(1); }
      if (++n % 500 === 0) console.log(`  ${n}/${rows.length}`);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  console.log(`\n✓ ${n} 件を「完成」にしました`);
}

main();
