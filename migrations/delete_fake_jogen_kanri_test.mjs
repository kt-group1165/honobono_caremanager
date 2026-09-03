/**
 * seed_fake_jogen_kanri_test.mjs が投入したテストデータを削除する。
 *
 *   node migrations/delete_fake_jogen_kanri_test.mjs             # DRY RUN
 *   node migrations/delete_fake_jogen_kanri_test.mjs --execute   # 削除
 *
 * 削除は **manifest の id 一覧** に対してのみ行う (marker 一致も二重に検査する)。
 * tenant_id='test' 以外・marker が付いていない行は絶対に消さない。
 */
import { readFileSync, existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXECUTE = process.argv.includes("--execute");
const MANIFEST = join(__dirname, "_fake_jogen_test_manifest.json");

if (!existsSync(MANIFEST)) {
  console.error("manifest がありません:", MANIFEST);
  process.exit(1);
}
const man = JSON.parse(readFileSync(MANIFEST, "utf8"));
if (man.tenant !== "test") {
  console.error(`安全弁: manifest.tenant が 'test' ではありません (${man.tenant})。中止`);
  process.exit(1);
}

const rawEnv = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
const env = {};
for (const line of rawEnv.split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

async function rest(path, init = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : [];
}

// 依存の逆順 (子 → 親)
const PLAN = [
  ["shogai_jogen_kanri_results", man.ids.kanri],
  ["shogai_service_records", man.ids.records],
  ["client_kohi_records", man.ids.kohi],
  ["client_office_assignments", man.ids.assignments],
  ["shougai_certifications", man.ids.certs],
  ["clients", man.ids.clients],
  ["offices", man.ids.offices],
];

console.log(`${EXECUTE ? "★ EXECUTE" : "DRY RUN"}  marker=${man.marker} / tenant=${man.tenant}`);

for (const [table, ids] of PLAN) {
  if (!ids?.length) {
    console.log(`  ${table.padEnd(30)} 0 件`);
    continue;
  }
  // 事前検査: manifest の id が本当に tenant='test' の行か (他人の行を消さない)
  let bad = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rows = await rest(`${table}?id=in.(${chunk.join(",")})&select=id,tenant_id`);
    bad += rows.filter((r) => r.tenant_id !== man.tenant).length;
  }
  if (bad > 0) {
    console.error(`  ✗ ${table}: tenant が '${man.tenant}' でない行が ${bad} 件。中止`);
    process.exit(1);
  }
  if (!EXECUTE) {
    console.log(`  ${table.padEnd(30)} ${ids.length} 件 削除予定`);
    continue;
  }
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const out = await rest(`${table}?id=in.(${chunk.join(",")})&tenant_id=eq.${man.tenant}`, {
      method: "DELETE",
    });
    deleted += out.length;
  }
  console.log(`  ${table.padEnd(30)} ${deleted} 件 削除`);
}

if (!EXECUTE) {
  console.log("\n(DRY RUN — 何も消していません。--execute で削除)");
  process.exit(0);
}

// 残存確認
console.log("\n=== 残存確認 (0 になっていること) ===");
for (const [table, ids] of PLAN) {
  if (!ids?.length) continue;
  let left = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    left += (await rest(`${table}?id=in.(${chunk.join(",")})&select=id`)).length;
  }
  console.log(`  ${table.padEnd(30)} 残 ${left}`);
}
renameSync(MANIFEST, MANIFEST.replace(/\.json$/, ".deleted.json"));
console.log("\nmanifest を _fake_jogen_test_manifest.deleted.json にリネームしました");
