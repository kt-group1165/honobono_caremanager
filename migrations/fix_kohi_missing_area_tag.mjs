// ============================================================================
// 拠点タグの無い公費行にタグを付け直す。**notes 列だけ**を触る。
//
//   node migrations/fix_kohi_missing_area_tag.mjs             # DRY RUN
//   node migrations/fix_kohi_missing_area_tag.mjs --execute
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   import_meisai_kohi.mjs は冪等削除に `notes` のマーカーを使う。
//   TAG が空のまま流された回があり、`[MEISAI公費 2026-06]` (拠点なし) が
//   8 行残っている。2026-08-31 監査で TAG は --execute 必須になったので、
//   **この 8 行はもうどのマーカーにも一致しない**。
//   = 取込を流し直すと同じ人の公費が 2 行になる (保険/公費/本人負担の分割が壊れる)。
//
// ── どの拠点か ──────────────────────────────────────────────────────────
//   推測しない。次の 2 つが一致することを **実行時に確認**してから直す:
//     ① 対象 8 名の client_office_assignments が 1 事業所に揃っている
//     ② その拠点のマーカーが 1 行も存在しない (= 未実行だった拠点)
//   どちらか崩れたら中止する。
//
//   変更前の値は migrations/_kohi_area_tag_backup.json に残す。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.TARGET_MONTH ?? "2026-06";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const BACKUP = path.join(KAIGO, "migrations/_kohi_area_tag_backup.json");

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

/** 事業所名 → 取込 TAG。伝送データのフォルダ名に合わせる */
const OFFICE_TO_TAG = {
  "リンクスヘルパーステーション": "茂原",
};

async function fetchAll(build) {
  const out = [];
  // ⚠ order 無しで range を回すと行が重複・欠落する
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== 拠点タグの無い公費行を直す (${MONTH}) ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);
  const NO_TAG = `[MEISAI公費 ${MONTH}]`;

  const kohi = await fetchAll(() => sb.from("client_kohi_records").select("id, client_id, notes"));
  const target = kohi.filter((r) => r.notes === NO_TAG);
  console.log(`公費 ${kohi.length} 行 / 拠点タグ無し "${NO_TAG}" ${target.length} 行`);
  if (!target.length) { console.log("対象なし"); return; }

  const names = new Map((await fetchAll(() => sb.from("clients").select("id, name"))).map((c) => [c.id, c.name]));
  const offices = new Map((await fetchAll(() => sb.from("offices").select("id, name"))).map((o) => [o.id, o.name]));
  const asg = new Map();
  for (const a of await fetchAll(() => sb.from("client_office_assignments").select("client_id, office_id"))) {
    if (!asg.has(a.client_id)) asg.set(a.client_id, new Set());
    asg.get(a.client_id).add(a.office_id);
  }

  // ① 8 名が 1 事業所に揃っているか
  const offNames = new Set();
  for (const r of target) {
    const os = [...(asg.get(r.client_id) ?? [])].map((id) => offices.get(id) ?? id);
    if (os.length !== 1) {
      console.error(`✗ ${names.get(r.client_id)} の割当が ${os.length} 件 (${os.join("/")}) → 1 事業所に決まらないので中止`);
      process.exit(1);
    }
    offNames.add(os[0]);
  }
  if (offNames.size !== 1) {
    console.error(`✗ 対象が複数事業所にまたがる (${[...offNames].join(" / ")}) → 中止`);
    process.exit(1);
  }
  const officeName = [...offNames][0];
  const tag = OFFICE_TO_TAG[officeName];
  if (!tag) {
    console.error(`✗ 事業所「${officeName}」に対応する TAG が対応表に無い → 中止`);
    console.error("  推測で付けると冪等削除の相手が変わるので、対応表に書いてから流すこと");
    process.exit(1);
  }

  // ② その拠点のマーカーが既に存在しないか
  const newNotes = `[MEISAI公費 ${MONTH} ${tag}]`;
  const already = kohi.filter((r) => r.notes === newNotes);
  if (already.length) {
    console.error(`✗ "${newNotes}" が既に ${already.length} 行ある → 取込済み。重複を作るので中止`);
    console.error("  この 8 行は取込済み分と重複している可能性がある。中身を見てから消すこと");
    process.exit(1);
  }

  console.log(`\n事業所「${officeName}」→ TAG "${tag}"`);
  console.log(`"${NO_TAG}"  →  "${newNotes}"  ${target.length} 行\n`);
  for (const r of target) console.log(`   ${names.get(r.client_id) ?? r.client_id.slice(0, 8)}`);

  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }
  writeFileSync(BACKUP, JSON.stringify(target.map((r) => ({ id: r.id, name: names.get(r.client_id), before: r.notes, after: newNotes })), null, 2), "utf8");
  let ok = 0;
  for (const r of target) {
    const { error } = await sb.from("client_kohi_records").update({ notes: newNotes }).eq("id", r.id).eq("notes", NO_TAG);
    if (error) { console.error(`✗ ${names.get(r.client_id)}: ${error.message}`); continue; }
    ok++;
  }
  console.log(`\n直した ${ok} 行 / 変更前の値を ${path.basename(BACKUP)} に保存`);
}

main().catch((e) => { console.error(e); process.exit(1); });
