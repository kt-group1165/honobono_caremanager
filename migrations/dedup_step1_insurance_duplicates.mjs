// ============================================================================
// client_insurance_records の重複除去 (import_meisai_step1_clients.mjs の再実行事故)。
//
// ── 原因 ──────────────────────────────────────────────────────────────
//   STEP1 (import_meisai_step1_clients.mjs:448) の削除→再投入は
//   `.eq("client_id", r.id).eq("notes", IMPORT_MARK)` で **自分の TARGET_MONTH の
//   マーカーの行だけ**を対象にする。同じ利用者を別月(TARGET_MONTH違い)で
//   複数回 STEP1 実行すると、認定の実体(保険者/被保番/認定期間/要介護度)が
//   同じでも別行として積み上がる。2026-09-02 発見 (高品居宅 青木春夫で最初に発覚)。
//
// ── 重要な注意 (2026-09-02 実データ確認済み) ──────────────────────────
//   重複行は完全に同一内容ではない。STEP3(link_caremanager_office)は
//   `notes=その月のSTEP1マーカー` の行だけを対象に care_office_id を設定し、
//   STEP9(fix_copay_rate)も同様に copay_rate を設定するため、
//   **その月のSTEP2〜9をどこまで実行したかによって、行ごとに埋まっている
//   列が違う** (実例: 06月行と07月行は care_office_id/copay_rate が入って
//   いるが、STEP2〜9未実行の08月行はどちらも null)。
//   → 単純に「最新1件を残して削除」すると、その回だけSTEP3/9が未実行なら
//     既に他行に入っている care_office_id/copay_rate を失う恐れがある。
//   → このscriptは削除ではなく **非NULLの列を全重複行からCOALESCEして
//     1行にマージ**した上で、残りを削除する設計にする。
//
//   node migrations/dedup_step1_insurance_duplicates.mjs            # DRY RUN (既定)
//   node migrations/dedup_step1_insurance_duplicates.mjs --execute
// ============================================================================
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

// 重複判定キー: 「同じ利用者の同じ認定」とみなす列
const KEY_COLS = [
  "client_id", "insurer_number", "insured_number",
  "certification_start_date", "certification_end_date", "care_level",
];
// 列そのものはこのscript内で固定せず、実データの全列からKEY_COLS+管理用列を除いた
// ものを「マージ対象列」とする (将来列が増えても追従できるように)。
const SKIP_COLS = new Set([...KEY_COLS, "id", "created_at", "updated_at", "notes"]);

async function main() {
  console.log(`=== STEP1由来 client_insurance_records 重複マージ ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  let all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("client_insurance_records")
      .select("*")
      .like("notes", "[MEISAI-STEP1%")
      .range(from, from + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
  }
  console.log(`STEP1由来レコード総数: ${all.length}`);

  const groups = new Map();
  for (const r of all) {
    const key = KEY_COLS.map((c) => r[c]).join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const dupGroups = [...groups.values()].filter((rows) => rows.length > 1);
  console.log(`重複グループ数: ${dupGroups.length} / 対象行合計: ${dupGroups.reduce((s, r) => s + r.length, 0)}\n`);

  let mergedCount = 0, deletedCount = 0, conflictCount = 0;
  for (const rows of dupGroups) {
    // created_at 昇順 (古い→新しい)。最後 (最新) を土台にし、古い行から非NULLを補う。
    rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const survivor = { ...rows[rows.length - 1] };
    const conflicts = [];
    const allCols = Object.keys(survivor).filter((c) => !SKIP_COLS.has(c));
    for (const col of allCols) {
      const values = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== "");
      const uniqueValues = [...new Set(values.map((v) => JSON.stringify(v)))];
      if (uniqueValues.length > 1) {
        conflicts.push(`${col}: ${values.map((v) => JSON.stringify(v)).join(" vs ")}`);
      }
      if ((survivor[col] === null || survivor[col] === undefined || survivor[col] === "") && values.length > 0) {
        survivor[col] = rows.find((r) => r[col] !== null && r[col] !== undefined && r[col] !== "")[col];
      }
    }

    const toDelete = rows.filter((r) => r.id !== rows[rows.length - 1].id).map((r) => r.id);
    console.log(`client=${survivor.client_id.slice(0, 8)} 保険者${survivor.insurer_number} 被保番${survivor.insured_number} ${survivor.certification_start_date}〜${survivor.certification_end_date}`);
    console.log(`  行数=${rows.length} (${rows.map((r) => r.notes).join(" / ")})`);
    if (conflicts.length) {
      console.log(`  ⚠ 値の食い違いあり (自動マージしない・要目視確認): ${conflicts.join(", ")}`);
      conflictCount++;
      continue;
    }
    console.log(`  → 生存行に更新: ${survivor.id.slice(0, 8)} / 削除対象: ${toDelete.map((d) => d.slice(0, 8)).join(",")}`);
    mergedCount++;
    deletedCount += toDelete.length;

    if (EXECUTE) {
      const patch = { ...survivor };
      delete patch.id; delete patch.created_at;
      const { error: uErr } = await sb.from("client_insurance_records").update(patch).eq("id", survivor.id);
      if (uErr) { console.error(`  ✗ update失敗: ${uErr.message}`); continue; }
      const { error: dErr } = await sb.from("client_insurance_records").delete().in("id", toDelete);
      if (dErr) console.error(`  ✗ delete失敗: ${dErr.message}`);
    }
  }

  console.log(`\nマージ対象: ${mergedCount}組 (削除行 ${deletedCount}件) / 値の食い違いで要目視確認: ${conflictCount}組`);
  if (!EXECUTE) console.log("※ DRY RUN。--execute で生存行を更新(非NULL列マージ)→残りを削除。");
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
