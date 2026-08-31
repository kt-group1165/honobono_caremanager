// ============================================================================
// 同行援護の処遇改善加算 (155121 / 155175) を事業所設定に追加する。
//
//   処遇改善加算は**サービス種類ごとに別コード・別計算**なので、事業所設定にも
//   種類ごとの formula_code を持たせている。ところが 居宅介護 (115121/115175) と
//   重度訪問介護 (125121/125175) は入っていたのに **同行援護 (155121/155175) が
//   全事業所で抜けていた**。
//
//   茂原・大網には同行援護の利用者がいないため表に出なかったが、姉ム (2026-06) の
//   伝送突合で「155175 が新システムに無い」として顕在化した。五井にも 50 行あるので
//   同じ取りこぼしが起きている。
//
//   115121 → 115175 と同じ世代分け:
//     155121 同援処遇改善加算Ⅱ    〜2026-05  (402/1000)
//     155175 同援処遇改善加算Ⅱロ  2026-06〜  (441/1000)
//
//   使い方:
//     node migrations/add_doukou_shoguu_kaizen_addon.mjs            # DRY RUN
//     node migrations/add_doukou_shoguu_kaizen_addon.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const TENANT_ID = "kt-group";

/** 同行援護の実績がある事業所 (kaigo_visit_schedule の service_type が 同援* で始まる) を対象にする */
const DOUKOU_SERVICE_PREFIX = "同援";

const ROWS = [
  { formula_code: "155121", end_month: "2026-05", notes: "同援 処遇改善Ⅱ (R8/5まで)" },
  { formula_code: "155175", start_month: "2026-06", notes: "同援 処遇改善Ⅱロ (R8/6から)" },
];

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

async function fetchAll(table, cols, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).order("id").order("id").range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== 同行援護 処遇改善加算の設定追加 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 1) 同行援護の実績を持つ事業所を洗い出す (月を限定せず全期間)
  const sched = await fetchAll("kaigo_visit_schedule", "office_id, service_type", (q) =>
    q.eq("status", "completed"),
  );
  const officeIds = [
    ...new Set(
      sched
        .filter((r) => (r.service_type ?? "").startsWith(DOUKOU_SERVICE_PREFIX))
        .map((r) => r.office_id)
        .filter(Boolean),
    ),
  ];
  if (officeIds.length === 0) {
    console.log("同行援護の実績を持つ事業所がありません。何もしません。");
    return;
  }
  const { data: offices, error: oErr } = await sb
    .from("offices")
    .select("id, name")
    .in("id", officeIds);
  if (oErr) throw new Error(`offices: ${oErr.message}`);
  console.log(`対象事業所 ${offices.length} 件:`);
  for (const o of offices) console.log(`  ${o.name}`);

  // 2) 既存設定と突き合わせて不足分だけ INSERT
  const { data: existing, error: eErr } = await sb
    .from("kaigo_office_addon_periods")
    .select("office_id, formula_code")
    .in("office_id", officeIds);
  if (eErr) throw new Error(`kaigo_office_addon_periods: ${eErr.message}`);
  const have = new Set((existing ?? []).map((r) => `${r.office_id}|${r.formula_code}`));

  const payloads = [];
  for (const o of offices) {
    for (const r of ROWS) {
      if (have.has(`${o.id}|${r.formula_code}`)) {
        console.log(`  (既存) ${o.name} ${r.formula_code}`);
        continue;
      }
      payloads.push({ tenant_id: TENANT_ID, office_id: o.id, ...r });
    }
  }

  console.log(`\n追加する行 ${payloads.length} 件:`);
  for (const p of payloads) {
    const name = offices.find((o) => o.id === p.office_id)?.name;
    console.log(`  ${name} ← ${p.formula_code} ${p.notes}`);
  }
  if (payloads.length === 0) {
    console.log("追加なし。");
    return;
  }

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で INSERT します。");
    return;
  }
  const { error } = await sb.from("kaigo_office_addon_periods").insert(payloads);
  if (error) {
    console.error(`✗ INSERT 失敗: ${error.message}`);
    process.exit(1);
  }
  console.log(`\n✓ 完了: ${payloads.length} 行 INSERT`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
