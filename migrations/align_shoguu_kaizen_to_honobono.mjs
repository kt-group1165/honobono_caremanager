// ============================================================================
// 処遇改善加算の区分を **ほのぼのの伝送どおり** に合わせる。
//
// ── 方針 (2026-08-30 user 指示) ───────────────────────────────────────
//   「ほのぼのの設定自体が間違っていると思われる場合でも、**その旨をメモした上で
//     設定はほのぼの通りにして、同じ処理ができるかをまず確認する**」
//
//   検証の目的は「新ソフトがほのぼのと同じ伝送を作れること」。
//   算定の是非 (どちらが正しいか) はその後の業務判断として切り離す。
//
// ── 対象 ──────────────────────────────────────────────────────────────
//   17 拠点の 2026-06 伝送を種類別に集計した結果、**Ⅱイ (旧区分 121) を使っているのは
//   2 拠点だけ**だった。
//
//     さつきが丘  居宅介護 Ⅱイ / 同行援護 Ⅱイ   ← 事業所まるごと旧区分
//     花見川      居宅介護 Ⅱロ / 同行援護 **Ⅱイ** ← 同行援護だけ旧区分
//
//   他 15 拠点はすべて Ⅱロ (175)。
//
// ── ⚠ メモ: ほのぼの側の設定漏れと考えられる ────────────────────────────
//   処遇改善加算は **事業所単位**の区分なので、同一事業所でサービス種類ごとに
//   区分が違うのは通常ない。花見川が「居宅介護 Ⅱロ / 同行援護 Ⅱイ」なのは
//   同行援護の区分更新漏れの疑いが濃い。
//   さつきが丘は 2026-08-05 に user が「Ⅱロ が正でほのぼのが Ⅱイ の設定漏れ」と確認済。
//
//   → **正しい値は Ⅱロ**。ここで Ⅱイ に合わせるのは伝送再現の検証のためであり、
//     実際の請求をどうするか (過誤申立するか) は別途の業務判断。
//
//   node migrations/align_shoguu_kaizen_to_honobono.mjs            # DRY RUN
//   node migrations/align_shoguu_kaizen_to_honobono.mjs --execute
//   node migrations/align_shoguu_kaizen_to_honobono.mjs --revert   # Ⅱロ に戻す
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const REVERT = process.argv.includes("--revert");
const TENANT = "kt-group";
const MONTH = process.env.MONTH || "2026-06";

/** ほのぼのが Ⅱイ (121) を使っている事業所 × サービス種類 */
const ALIGN = [
  { office: "Ｈａｎａヘルパーステーション花見川", kind: "同行援護", old: "155121", cur: "155175" },
  // さつきが丘は 居宅介護・同行援護 とも Ⅱイ
  { office: "Ｈａｎａヘルパーステーションさつきが丘", kind: "居宅介護", old: "115121", cur: "115175" },
  { office: "Ｈａｎａヘルパーステーションさつきが丘", kind: "同行援護", old: "155121", cur: "155175" },
];

function loadEnv() {
  const t = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
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

async function main() {
  console.log(`=== 処遇改善区分を ${REVERT ? "Ⅱロ に戻す" : "ほのぼのに合わせる"} ` +
    `${MONTH} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data: offices, error: oErr } = await sb.from("offices").select("id, name");
  if (oErr) { console.error(`✗ ${oErr.message}`); process.exit(1); }
  const byName = new Map(offices.map((o) => [o.name, o.id]));

  const { data: rows, error } = await sb.from("kaigo_office_addon_periods").select("*");
  if (error) { console.error(`✗ ${error.message}`); process.exit(1); }

  const plan = [];
  for (const a of ALIGN) {
    const oid = byName.get(a.office);
    if (!oid) { console.error(`✗ 事業所が見つからない: ${a.office}`); process.exit(1); }
    const curRow = rows.find((r) => r.office_id === oid && r.formula_code === a.cur);
    const oldRow = rows.find((r) => r.office_id === oid && r.formula_code === a.old);
    if (REVERT) {
      // Ⅱロ を 2026-06〜 に戻し、Ⅱイ を 2026-05 までに戻す
      if (curRow && curRow.start_month !== MONTH) {
        plan.push({ id: curRow.id, office: a.office, kind: a.kind, code: a.cur,
          patch: { start_month: MONTH, end_month: null, notes: `${a.kind} 処遇改善Ⅱロ (R8/6から)` } });
      }
      if (oldRow && oldRow.end_month !== "2026-05") {
        plan.push({ id: oldRow.id, office: a.office, kind: a.kind, code: a.old,
          patch: { start_month: null, end_month: "2026-05", notes: `${a.kind} 処遇改善Ⅱ (R8/5まで)` } });
      }
    } else {
      // Ⅱイ を 2026-06 以降も有効にし、Ⅱロ を止める
      const note = `⚠ ほのぼのの伝送が Ⅱイ のため合わせている。**正しくは Ⅱロ** (2026-08-30)`;
      if (oldRow && oldRow.end_month !== null) {
        plan.push({ id: oldRow.id, office: a.office, kind: a.kind, code: a.old,
          patch: { end_month: null, notes: `${a.kind} 処遇改善Ⅱイ。${note}` } });
      }
      if (curRow && curRow.start_month !== "2099-12") {
        plan.push({ id: curRow.id, office: a.office, kind: a.kind, code: a.cur,
          patch: { start_month: "2099-12", notes: `${a.kind} 処遇改善Ⅱロ (伝送再現のため休止)。${note}` } });
      }
    }
  }

  if (!plan.length) { console.log("  変更なし (既にその状態)"); return; }
  for (const p of plan) {
    console.log(`  ${p.office.padEnd(26)} ${p.kind.padEnd(6)} ${p.code}  → ` +
      `${JSON.stringify({ start_month: p.patch.start_month, end_month: p.patch.end_month })}`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で反映します。"); return; }

  for (const p of plan) {
    const { error: e } = await sb.from("kaigo_office_addon_periods")
      .update({ ...p.patch, updated_at: new Date().toISOString() }).eq("id", p.id);
    if (e) { console.error(`✗ ${p.office} ${p.code}: ${e.message}`); process.exit(1); }
  }
  console.log(`\n✓ ${plan.length} 行を更新しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
