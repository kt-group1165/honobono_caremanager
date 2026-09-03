/**
 * client_kohi_records の完全重複を 1 行に寄せる
 *
 *   node migrations/dedupe_client_kohi_records.mjs              # DRY RUN
 *   node migrations/dedupe_client_kohi_records.mjs --execute    # 実行
 *
 * ⚠ **実行前にバックアップを取ること** (下の SQL)。
 *
 * ── 何が起きているか (2026-09-03 実測) ────────────────────────────────
 *   利用者 + 法別 + 負担者番号 + 受給者番号 が同一の行が 2 つある組が **102 組**。
 *   片方は 期間 2026-06-01〜2026-06-30 (月スコープ付きの取込由来)、
 *   もう片方は 期間 null (別の取込由来。created_at 2026-09-01 が多い)。
 *
 *   集計 (visit-seikyu/aggregate.ts) は「対象月に有効な公費」を**全件**引いて
 *   上位 2 件を 公費1 / 公費2 としてカスケードするので、
 *   **同じ制度が公費1と公費2の両方に入る**。
 *
 * ── 今のところ請求額は変わっていない (実測で確認済み) ──────────────────
 *   MONTH=2026-06 npx tsx scripts/kohi-duplicate-check.mts
 *     レセプト 1595 件 / 公費1 あり 182 件 / 公費2 が立った 94 件
 *       └ 93 件が重複由来。**全件 公費2 請求額 ¥0**
 *     伝送 (7131) は kohi2Amount > 0 のときだけ公費2欄を出すので **出力に差は無い**
 *
 *   ⚠ **これは「生保 (法別12) が 10 割で公費1 が全額吸う」から 0 円になっているだけ。**
 *     現在の登録は 法別 12 (349 行) と 81 (7 行) しか無い。
 *     部分公費 (21 精神通院 / 54 難病 / 19 被爆者 …) が重複したら
 *     **公費2 に残額が乗って同じ負担者番号が 2 欄に出る = 返戻**になる。
 *   ⚠ 「生活保護が第1公費になっています」の警告が **93 件が重複由来の空振り**で出て、
 *     本物の優先順位ミスを埋めてしまう。
 *
 * ── 残す行の決め方 (期間を狭めない) ──────────────────────────────────
 *   同一キーの中で **期間が最も広い 1 行だけ残す**。
 *     start_date は null (制限なし) が最も広い / 次に古いもの
 *     end_date   は null (制限なし) が最も広い / 次に新しいもの
 *   残す行の期間が **他の行の期間をすべて包含するときだけ**削除する。
 *   包含しない (期間が食い違う) 組は **触らず一覧に出す** — 別の受給者証かもしれないため。
 *
 *   honnin_futan / priority が食い違う組も **触らない**。
 *   本人負担上限が違うなら別の内容なので、人が見るべき。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const EXECUTE = process.argv.includes("--execute");

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function all(table, cols, order) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(order).range(f, f + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

console.log(`=== client_kohi_records の重複整理 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);
console.log(`⚠ 実行前にバックアップを取ること:`);
console.log(`    CREATE TABLE _backup_client_kohi_records_20260903 AS`);
console.log(`    SELECT * FROM client_kohi_records;\n`);

const rows = await all("client_kohi_records", "*", "id");
const ids = [...new Set(rows.map((r) => r.client_id))];
const names = new Map();
for (let i = 0; i < ids.length; i += 150) {
  const { data, error } = await sb.from("clients").select("id, name").in("id", ids.slice(i, i + 150));
  if (error) throw new Error(`clients: ${error.message}`);
  for (const c of data ?? []) names.set(c.id, c.name);
}

const key = (r) => [r.client_id, r.kohi_hobetsu, r.futansha_number ?? "", r.jukyusha_number ?? ""].join("|");
const groups = new Map();
for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);

/** a の期間が b を包含するか (null = 制限なし = 最も広い) */
const covers = (a, b) =>
  (a.start_date == null || (b.start_date != null && a.start_date <= b.start_date)) &&
  (a.end_date == null || (b.end_date != null && a.end_date >= b.end_date));

const toDelete = [];
const skipped = [];
let nDupGroups = 0;

for (const [k, list] of groups) {
  if (list.length < 2) continue;
  nDupGroups++;
  const [clientId, hobetsu] = k.split("|");
  const label = `${names.get(clientId) ?? clientId} 法別${hobetsu}`;

  // 本人負担上限 / priority が食い違う組は触らない
  const futanSet = new Set(list.map((r) => Number(r.honnin_futan ?? 0)));
  const priSet = new Set(list.map((r) => Number(r.priority ?? 1)));
  if (futanSet.size > 1 || priSet.size > 1) {
    skipped.push(`${label}: 本人負担上限 or priority が食い違う (${[...futanSet].join("/")} · pri ${[...priSet].join("/")}) — 人が確認`);
    continue;
  }

  // 期間が最も広い 1 行を選ぶ
  const sorted = [...list].sort((a, b) => {
    const sa = a.start_date ?? "0000-00-00";
    const sb2 = b.start_date ?? "0000-00-00";
    if (sa !== sb2) return sa.localeCompare(sb2);
    const ea = a.end_date ?? "9999-99-99";
    const eb = b.end_date ?? "9999-99-99";
    return eb.localeCompare(ea);
  });
  const keep = sorted[0];
  const rest = sorted.slice(1);
  if (!rest.every((r) => covers(keep, r))) {
    skipped.push(`${label}: 期間が包含関係にない (${list.map((r) => `${r.start_date ?? "~"}〜${r.end_date ?? "~"}`).join(" / ")}) — 別の受給者証の可能性。人が確認`);
    continue;
  }
  toDelete.push(...rest.map((r) => ({ id: r.id, label, keep: `${keep.start_date ?? "~"}〜${keep.end_date ?? "~"}`, drop: `${r.start_date ?? "~"}〜${r.end_date ?? "~"}` })));
}

console.log(`【分母】client_kohi_records ${rows.length} 行 / ${ids.length} 名`);
console.log(`  完全重複の組            ${nDupGroups} 組`);
console.log(`  ★ 削除する行            ${toDelete.length} 行`);
console.log(`  ⚠ 触らない (人が確認)    ${skipped.length} 組\n`);

for (const s of skipped) console.log(`  ⚠ ${s}`);
if (skipped.length) console.log();

for (const d of toDelete.slice(0, 20)) {
  console.log(`  削除 ${d.label}  残す期間 ${d.keep} / 消す期間 ${d.drop}`);
}
if (toDelete.length > 20) console.log(`  … 他 ${toDelete.length - 20} 行`);

if (!EXECUTE) {
  console.log(`\n【DRY RUN】書き込んでいません。--execute で実行`);
  console.log(`⚠ 実行後は必ず件数を確認すること:`);
  console.log(`    MONTH=2026-06 npx tsx scripts/kohi-duplicate-check.mts`);
  console.log(`    → 「完全重複 0 組」「公費2 が立った 1 件 (本来の併用のみ)」になるはず`);
  process.exit(0);
}

let deleted = 0;
for (let i = 0; i < toDelete.length; i += 100) {
  const chunk = toDelete.slice(i, i + 100).map((d) => d.id);
  const { error, count } = await sb
    .from("client_kohi_records")
    .delete({ count: "exact" })
    .in("id", chunk);
  if (error) throw new Error(`削除に失敗: ${error.message}`);
  deleted += count ?? 0;
}
console.log(`\n  ${deleted} 行 削除`);

// ★ 件数確認 (実際に消えたかを DB に聞き直す)
const after = await all("client_kohi_records", "id, client_id, kohi_hobetsu, futansha_number, jukyusha_number", "id");
const g2 = new Map();
for (const r of after) g2.set(key(r), [...(g2.get(key(r)) ?? []), r]);
const left = [...g2.values()].filter((v) => v.length > 1).length;
console.log(`  ★ 件数確認: 残り ${after.length} 行 / 完全重複 ${left} 組 ${left === skipped.length ? "✅ 触らないと決めた組だけ" : "⚠ 想定と違う"}`);

/*
 * ── ⚠ 根本原因: 1 つの表に **4 つの取込が別マーカーで書いている** ──────────
 *   import_meisai_kohi.mjs        `[MEISAI公費 <月> <拠点>]`   期間 null で insert
 *   import_kohi_master.mjs        `[公費マスタ <月>] 併用/単独`  期間あり
 *   import_kyotaku_kohi_office.mjs / STEP1  `[居宅STEP1 <月> <拠点>]`
 *
 *   どれも冪等なのは **自分のマーカーの中だけ** (`.eq("notes", MARK)` で消して入れ直す)。
 *   同じ利用者が 2 つの取込に載ると **2 行になる**。実測の組合せ:
 *     MEISAI × 公費マスタ           40 組
 *     MEISAI × 居宅STEP1            32 組
 *     ★ MEISAI 2026-06 × 2026-07   16 組  ← **同じ script の別月**
 *     拠点違い (K姉 × 市原 など)      数組  ← 1 利用者が 2 拠点で稼働
 *
 *   ⚠ ★ **この script は 1 回きりの掃除にしかならない。**
 *     公費は期間 null で入るので、月を取り込むたびに **1 行ずつ積み上がる**。
 *     構造的に止めるには次のどれかが要る (**user 判断**):
 *       a. (client_id, kohi_hobetsu, futansha_number, jukyusha_number) に
 *          UNIQUE 制約 + upsert に変える  ← 一番強い
 *       b. 取込の削除スコープを「マーカー」から「利用者 + 法別 + 番号」に広げる
 *       c. 掃除をこの script で定期的に回す (対症療法)
 */
