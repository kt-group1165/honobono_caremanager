// ============================================================================
// 別人の認定レコードが紛れ込んでいるのを剥がす
//
// ── 何が起きているか ────────────────────────────────────────────────────
//   (保険者番号, 被保険者番号) は 1 人を指すはずなのに、**2 人以上の利用者**に
//   同じ組が付いていることがある。伝送取込は (保険者, 被保番) で利用者を引くので、
//   2 人当たると **どちらか判らず取り込めない** (= レセプトが丸ごと落ちる)。
//
//   実例: ＫＴ在宅サポートセンター 122192|1000064315
//     本多 ふじ江 (生1935-07-16)  … 自分の 1000037393 に加えて 1000064315 も持つ
//     古川 秀子   (生1942-03-13)  … 1000064315 だけ
//   → 2026-08-05 の取込が 利用者番号 411000325 で引き当てて、
//      古川さんの認定を本多さんにも付けてしまった。
//
// ── どう直すか ──────────────────────────────────────────────────────────
//   ある (保険者, 被保番) を持つ利用者が複数いるとき、
//   **その番号しか持たない利用者が 1 人だけ**なら、その人が本来の持ち主。
//   他の利用者 (= 自分の別の被保番も持っている人) から、その行だけ剥がす。
//
//   それ以外の形 (全員がその番号しか持たない = 本当の重複人物 等) は
//   **触らず一覧に出すだけ**にする。人物の同定は merge_duplicate_clients.mjs の
//   担当 (保険者 + 被保番 + 生年月日 で判定)。
//
//   node migrations/fix_insurance_record_wrong_owner.mjs             # DRY RUN
//   node migrations/fix_insurance_record_wrong_owner.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

async function main() {
  console.log(`=== 別人の認定レコードを剥がす ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  // 1000 行の壁があるので必ずページングする
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("client_insurance_records")
      .select("id, client_id, insurer_number, insured_number, care_level, certification_start_date, certification_end_date")
      .range(from, from + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    all.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  console.log(`  認定レコード ${all.length} 件を読込`);

  // (保険者, 被保番) → 利用者の集合
  const byKey = new Map();
  // 利用者 → その人が持つ (保険者, 被保番) の集合
  const numsOf = new Map();
  for (const r of all) {
    if (!r.insurer_number || !r.insured_number) continue;
    const k = `${r.insurer_number}|${r.insured_number}`;
    if (!byKey.has(k)) byKey.set(k, new Map());
    if (!byKey.get(k).has(r.client_id)) byKey.get(k).set(r.client_id, []);
    byKey.get(k).get(r.client_id).push(r);
    if (!numsOf.has(r.client_id)) numsOf.set(r.client_id, new Set());
    numsOf.get(r.client_id).add(k);
  }

  const conflicts = [...byKey.entries()].filter(([, m]) => m.size > 1);
  if (!conflicts.length) { console.log("\n✓ 1 つの被保番が複数人に付いている箇所はありません"); return; }

  const ids = [...new Set(conflicts.flatMap(([, m]) => [...m.keys()]))];
  const names = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("clients")
      .select("id, name, birth_date, user_number").in("id", ids.slice(i, i + 200));
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    for (const c of data ?? []) names.set(c.id, c);
  }

  const strip = [];    // 剥がす認定レコード
  const manual = [];   // 判定できないので人が見るもの
  for (const [k, m] of conflicts) {
    // その番号しか持たない利用者 = 本来の持ち主の候補
    const owners = [...m.keys()].filter((cid) => numsOf.get(cid).size === 1);
    const others = [...m.keys()].filter((cid) => numsOf.get(cid).size > 1);
    const desc = [...m.keys()].map((cid) => {
      const c = names.get(cid) ?? {};
      return `${c.name ?? "?"} (生${c.birth_date ?? "不明"} / 番号${c.user_number ?? "?"} / 被保番${numsOf.get(cid).size}件)`;
    }).join("  ×  ");
    if (owners.length === 1 && others.length) {
      for (const cid of others) for (const r of m.get(cid)) strip.push({ key: k, r, cid, owner: owners[0], desc });
    } else {
      manual.push(`${k}: ${desc}`);
    }
  }

  if (strip.length) {
    console.log(`\n  -- 剥がす ${strip.length} 件 --`);
    for (const s of strip) {
      const from = names.get(s.cid) ?? {};
      const to = names.get(s.owner) ?? {};
      console.log(`     ${s.key}  ${from.name} から剥がす → 本来の持ち主は ${to.name}`);
      console.log(`        ${s.r.care_level} ${s.r.certification_start_date}〜${s.r.certification_end_date}`);
    }
  }
  if (manual.length) {
    console.log(`\n  -- 判定できないので触らない ${manual.length} 件 (人が確認) --`);
    for (const q of manual) console.log(`     ${q}`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で削除します。"); return; }
  if (!strip.length) return;

  for (const s of strip) {
    const { error } = await sb.from("client_insurance_records").delete().eq("id", s.r.id);
    if (error) { console.error(`✗ ${s.key} の削除失敗: ${error.message}`); process.exit(1); }
    console.log(`  ✓ ${s.key} を ${names.get(s.cid)?.name} から剥がしました`);
  }
  console.log(`\n✓ ${strip.length} 件を剥がしました`);
}

main();
