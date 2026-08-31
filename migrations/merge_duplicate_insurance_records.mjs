// ============================================================================
// client_insurance_records の**同一認定の重複**をマージして 1 本に畳む。
//
// ── なぜ重複するか ────────────────────────────────────────────────────
//   同じ利用者を複数の取込経路が別々に登録するため。実際に見つかった経路:
//     [居宅STEP1 2026-06 <拠点>]     居宅介護支援の取込
//     [MEISAI-STEP1 2026-06 <拠点>]  訪問介護の稼働データ取込
//     [認定履歴取込 2026-08-04]
//     (marker 無し)                   手入力 / 旧取込
//   居宅と訪問介護の両方を使う利用者は 2 本できる。各 importer は自分の marker
//   でしか消さないので、何度回しても解消しない。
//
// ── 何が壊れるか ──────────────────────────────────────────────────────
//   請求は「対象月に有効な認定」を 1 本引く。どちらが引かれるかで
//   **負担割合 (= 給付率) が変わる**。
//   実証: 五井 村上正幸 — (marker 無し copay=null) と (五井 copay=2) の 2 本があり、
//   null 側が引かれて給付率 90 で出力。ほのぼのは 80 (2 割)。
//
// ── 畳み方 ────────────────────────────────────────────────────────────
//   キー = client_id + 認定開始日 + 認定終了日。
//   **情報量の多い行を残し、捨てる行の非 null 値で残す行の null を埋める**
//   (どちらか一方にしか入っていない列を落とさないため)。
//   値が食い違う列は残す行を優先し、DIFF として出力する (要目視)。
//
//   使い方:
//     OFFICE_ID=<uuid> node migrations/merge_duplicate_insurance_records.mjs
//     OFFICE_ID=<uuid> node migrations/merge_duplicate_insurance_records.mjs --execute
//     OFFICE_ID 省略で全事業所 (影響が大きいので dry-run で件数を見てから)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const OFFICE_ID = process.env.OFFICE_ID || "";

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

/** マージ対象外 (行の同一性そのもの / 監査情報) */
const SKIP_COLS = new Set(["id", "client_id", "created_at", "updated_at", "notes", "tenant_id"]);

async function fetchAllIn(table, cols, col, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from(table).select(cols).in(col, ids.slice(i, i + 100));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
  }
  return out;
}

async function main() {
  console.log(`=== 認定の重複マージ ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ${OFFICE_ID || "全事業所"} ===\n`);

  let ids;
  if (OFFICE_ID) {
    const { data, error } = await sb
      .from("client_office_assignments")
      .select("client_id")
      .eq("office_id", OFFICE_ID);
    if (error) throw new Error(error.message);
    ids = [...new Set(data.map((r) => r.client_id))];
  } else {
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("clients").select("id").order("id").range(from, from + 999);
      if (error) throw new Error(error.message);
      all.push(...data);
      if (data.length < 1000) break;
    }
    ids = all.map((r) => r.id);
  }
  console.log(`対象利用者: ${ids.length} 名`);

  const rec = await fetchAllIn(
    "client_insurance_records",
    "*, clients(name)",
    "client_id",
    ids,
  );
  console.log(`認定レコード: ${rec.length} 件\n`);

  const groups = new Map();
  for (const r of rec) {
    const k = `${r.client_id}|${r.certification_start_date}|${r.certification_end_date}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const filled = (r) => Object.entries(r).filter(([k, v]) => !SKIP_COLS.has(k) && v != null && v !== "").length;
  const plan = [];
  const conflicts = [];

  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    // 情報量が多い順。同数なら新しい方 (後から取り込んだ方が実データに近い)
    const sorted = [...rows].sort(
      (a, b) => filled(b) - filled(a) || String(b.created_at).localeCompare(String(a.created_at)),
    );
    const keep = sorted[0];
    const drop = sorted.slice(1);
    const patch = {};
    for (const d of drop) {
      for (const [col, v] of Object.entries(d)) {
        if (SKIP_COLS.has(col) || col === "clients") continue;
        if (v == null || v === "") continue;
        const cur = patch[col] ?? keep[col];
        if (cur == null || cur === "") patch[col] = v;
        else if (String(cur) !== String(v)) {
          conflicts.push(
            `${keep.clients?.name ?? keep.client_id} ${keep.certification_start_date}: ${col} 残=${cur} 捨=${v}`,
          );
        }
      }
    }
    plan.push({ keep, drop, patch, name: keep.clients?.name ?? keep.client_id });
  }

  console.log(`重複グループ: ${plan.length} 件 (削除対象 ${plan.reduce((a, p) => a + p.drop.length, 0)} 行)`);
  for (const p of plan.slice(0, 40)) {
    const cols = Object.keys(p.patch);
    console.log(
      `  ${(p.name + "              ").slice(0, 14)} ${p.keep.certification_start_date}〜${p.keep.certification_end_date}` +
        ` 残1/${p.drop.length + 1}${cols.length ? ` 補完: ${cols.join(",")}` : ""}`,
    );
  }
  if (plan.length > 40) console.log(`  … 他 ${plan.length - 40} 件`);

  if (conflicts.length) {
    console.log(`\n⚠ 値が食い違う列 ${conflicts.length} 件 (残す側を採用。要目視):`);
    for (const c of conflicts.slice(0, 30)) console.log(`   ${c}`);
    if (conflicts.length > 30) console.log(`   … 他 ${conflicts.length - 30} 件`);
  }

  if (!plan.length) {
    console.log("\n重複なし。");
    return;
  }
  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute でマージします。");
    return;
  }

  // バックアップ (削除する行を丸ごと)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const bak = fileURLToPath(new URL(`./_backup_insurance_dup_${stamp}.json`, import.meta.url));
  writeFileSync(bak, JSON.stringify(plan.flatMap((p) => p.drop), null, 1), "utf8");
  console.log(`\nバックアップ: ${bak.split(/[\\/]/).pop()}`);

  let upd = 0, del = 0;
  for (const p of plan) {
    if (Object.keys(p.patch).length) {
      const { error } = await sb.from("client_insurance_records").update(p.patch).eq("id", p.keep.id);
      if (error) { console.error(`✗ ${p.name} 補完: ${error.message}`); process.exit(1); }
      upd++;
    }
    const { error } = await sb
      .from("client_insurance_records")
      .delete()
      .in("id", p.drop.map((d) => d.id));
    if (error) { console.error(`✗ ${p.name} 削除: ${error.message}`); process.exit(1); }
    del += p.drop.length;
  }
  console.log(`✓ 完了: 補完 ${upd} 行 / 削除 ${del} 行`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
