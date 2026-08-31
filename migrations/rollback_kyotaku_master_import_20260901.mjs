// ============================================================================
// 2026-09-01 の 居宅マスタ取込 (居宅全体_登録有) を巻き戻す。
//
//   node migrations/rollback_kyotaku_master_import_20260901.mjs            DRY RUN
//   node migrations/rollback_kyotaku_master_import_20260901.mjs --execute
//
// ── なぜ巻き戻すか ──────────────────────────────────────────────────────
//   取込が **利用者番号をキー**にしていたが、「居宅全体」CSV では
//   利用者番号が一意でない。
//
//     利番 2147483647 (INT32 の最大値) = ほのぼのの「番号なし」sentinel。
//       この 1 番号を **44 人**が共有していた。
//     ほかに 26 番号が複数人、81 番号が複数の被保険者番号を持つ。
//
//   結果、44 人分の認定が 1 人の client にぶら下がり、
//   `check_cert_owner_mismatch.mjs` が 131 件の「別人の認定」を検出した。
//
// ── 何を消すか ──────────────────────────────────────────────────────────
//   `_backup_kyotaku_master_import_20260901.json` に記録した
//   **取込直前の created_at** より後に作られた行だけ。
//   FK の順に 割当 → 認定 → 利用者 の順で消す。
//
// ⚠ **他セッションが同じ時間帯に作った行も混ざりうる。**
//   件数が取込時の報告 (割当 1619 / 認定 7082 / 利用者 1761) と合うことを
//   確認してから消す。合わなければ中止して人が判断する。
// ============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const EXECUTE = process.argv.includes("--execute");

const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };

const snap = JSON.parse(readFileSync(
  path.join(ROOT, "migrations/_backup_kyotaku_master_import_20260901.json"), "utf8"));

/** 取込時に報告された件数。これと一致しなければ中止する */
const EXPECTED = {
  client_office_assignments: 1619,
  client_insurance_records: 7082,
  clients: 1761,
};

async function countAfter(table) {
  const cut = snap.表[table].最終created_at;
  const r = await fetch(
    `${SB}/rest/v1/${table}?select=id&created_at=gt.${encodeURIComponent(cut)}`,
    { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  if (!r.ok) throw new Error(`${table}: ${r.status} ${(await r.text()).slice(0, 160)}`);
  return Number((r.headers.get("content-range") ?? "").split("/")[1]);
}

async function del(table) {
  const cut = snap.表[table].最終created_at;
  const r = await fetch(
    `${SB}/rest/v1/${table}?created_at=gt.${encodeURIComponent(cut)}`,
    { method: "DELETE", headers: { ...H, Prefer: "return=representation" } });
  const body = await r.text();
  if (!r.ok) { console.error(`✗ ${table}: ${r.status} ${body.slice(0, 200)}`); process.exit(1); }
  return (JSON.parse(body) ?? []).length;
}

async function main() {
  console.log(`=== 居宅マスタ取込の巻き戻し ${EXECUTE ? "【実行】" : "【DRY RUN】"} ===\n`);
  console.log("  取込直前の created_at:");
  for (const [t, v] of Object.entries(snap.表)) console.log(`     ${t.padEnd(30)}${v.最終created_at}`);
  console.log("");

  let ng = false;
  const now = {};
  for (const t of Object.keys(EXPECTED)) {
    now[t] = await countAfter(t);
    const ok = now[t] === EXPECTED[t];
    if (!ok) ng = true;
    console.log(`  ${ok ? "✓" : "🔴"} ${t.padEnd(30)}消す予定 ${String(now[t]).padStart(6)} / 取込時の報告 ${EXPECTED[t]}`);
  }
  if (ng) {
    console.error(`
🔴 件数が取込時の報告と合わない。**他セッションが同じ時間帯に行を作った可能性**がある。
   消すと巻き添えになるので中止する。何が増えたかを人が確認すること。`);
    process.exit(1);
  }
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で削除します。"); return; }

  // FK の順に消す
  console.log("");
  for (const t of ["client_office_assignments", "client_insurance_records", "clients"]) {
    const n = await del(t);
    console.log(`  ${t.padEnd(30)}削除 ${n} 件`);
  }
  console.log("\n✓ 巻き戻し完了。取込 script を直してから入れ直すこと。");
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
