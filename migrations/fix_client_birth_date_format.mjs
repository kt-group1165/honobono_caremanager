// ============================================================================
// clients.birth_date のスラッシュ形式を ISO (YYYY-MM-DD) に揃える。
//
//   node migrations/fix_client_birth_date_format.mjs             # DRY RUN
//   node migrations/fix_client_birth_date_format.mjs --execute
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   clients.birth_date は **テキスト列**なので、CSV の値をそのまま入れても
//   通ってしまう。2026-04〜05 の取込が "1933/1/17" のまま入れていて、
//   2026-08-31 時点で 342 件がこの形だった (ISO は 5,686 件)。
//
//   同じ人が 2 形式で入ると **同一人物の判定が外れて二重登録になる**。
//   実際、(保険者,被保番) が 2 人に当たる 6 組はすべてこの形だった:
//       河連 ユキ    1933-01-17  と  1933/1/17
//       堤 威        1933/12/16  と  1933-12-16
//   重複統合 (merge_duplicate_clients.mjs) は 保険者+被保番+**生年月日**で
//   判定するので、形式が揃っていないと拾えない。
//
// ── やること ────────────────────────────────────────────────────────────
//   "1933/1/17" → "1933-01-17" の**書式変換だけ**。日付の中身は変えない。
//   変換できない値 (曖昧・不正) は触らずに一覧へ出す。
//
//   ⚠ 生年月日が明らかにおかしい人 (2021〜2026 年など 94 名) は**別問題**。
//     被保険者番号が 5555555555 / 9999999333 のような仮番号で、テスト用か
//     仮登録とみられる。業務判断が要るのでこの script では触らない。
//
//   変更前の値は migrations/_birth_date_format_backup.json に残す。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const BACKUP = path.join(KAIGO, "migrations/_birth_date_format_backup.json");

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** "1933/1/17" → "1933-01-17"。判断できない形は null を返して触らない */
function toIso(s) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s ?? "").trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const Y = Number(y), M = Number(mo), D = Number(d);
  if (M < 1 || M > 12 || D < 1 || D > 31) return null;
  // 実在する日付か (2月30日 のような値を通さない)
  const dt = new Date(Y, M - 1, D);
  if (dt.getFullYear() !== Y || dt.getMonth() !== M - 1 || dt.getDate() !== D) return null;
  return `${y}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
}

async function main() {
  console.log(`=== clients.birth_date の書式を揃える ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const cli = await fetchAll(() => sb.from("clients").select("id, name, birth_date, deleted_at, insurer_number, insured_number"));
  const alive = cli.filter((c) => !c.deleted_at);
  const slash = alive.filter((c) => typeof c.birth_date === "string" && c.birth_date.includes("/"));

  const plan = [], skip = [];
  for (const c of slash) {
    const iso = toIso(c.birth_date);
    if (iso) plan.push({ ...c, iso });
    else skip.push(c);
  }

  console.log(`clients (未削除) ${alive.length} 名`);
  console.log(`  スラッシュ形式  ${slash.length} 件`);
  console.log(`  → 変換できる    ${plan.length} 件`);
  console.log(`  → 変換できない  ${skip.length} 件 (触らない)\n`);

  console.log("― 変換の例 (先頭10) ―");
  for (const p of plan.slice(0, 10)) console.log(`   ${String(p.name).padEnd(12)} ${p.birth_date} → ${p.iso}`);
  if (skip.length) {
    console.log("\n― 変換できなかったもの ―");
    for (const s of skip) console.log(`   ${String(s.name).padEnd(12)} "${s.birth_date}"`);
  }

  // 揃えた結果、同じ (保険者,被保番,生年月日) が 2 人以上になる = 二重登録の候補
  const key = (c, bd) => `${c.insurer_number}|${c.insured_number}|${bd}`;
  const after = new Map();
  for (const c of alive) {
    const bd = plan.find((p) => p.id === c.id)?.iso ?? c.birth_date;
    if (!c.insurer_number || !c.insured_number || !bd) continue;
    const k = key(c, bd);
    if (!after.has(k)) after.set(k, []);
    after.get(k).push(c);
  }
  const dups = [...after.entries()].filter(([, v]) => v.length > 1);
  console.log(`\n書式を揃えたあとに重複が確定する人物: ${dups.length} 組`);
  for (const [k, v] of dups.slice(0, 20)) console.log(`   ${k}  ${v.map((c) => c.name).join(" / ")}`);
  if (dups.length) console.log("   → このあと merge_duplicate_clients.mjs で統合できる");

  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }

  const backup = plan.map((p) => ({ id: p.id, name: p.name, before: p.birth_date, after: p.iso }));
  let ok = 0, ng = 0;
  for (const p of plan) {
    const { error } = await sb.from("clients").update({ birth_date: p.iso }).eq("id", p.id);
    if (error) { console.error(`✗ ${p.name}: ${error.message}`); ng++; continue; }
    ok++;
  }
  writeFileSync(BACKUP, JSON.stringify(backup, null, 2), "utf8");
  console.log(`\n更新 ${ok} 件 / 失敗 ${ng} 件`);
  console.log(`変更前の値を ${path.basename(BACKUP)} に保存しました`);
}

main().catch((e) => { console.error(e); process.exit(1); });
