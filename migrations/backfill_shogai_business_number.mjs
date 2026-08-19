// ============================================================================
// offices.shogai_business_number を伝送データから埋める。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   障害の事業所番号は介護と **別番号**。18 拠点のうち 4 拠点しか入っておらず、
//   拠点単位の一括突合が事業所を解決できずスキップされていた。
//
// ── どう決めるか (推測しない) ──────────────────────────────────────────
//   拠点フォルダは介護と障害の伝送を両方持っている:
//     伝送データ/<拠点>/訪問介護/介護/<月>/ほのぼのから/KK*.CSV  → 介護事業所番号
//     伝送データ/<拠点>/訪問介護/障害/<月>/ほのぼのから/KJ*.CSV  → 障害事業所番号
//   両方ともコントロールレコード (1 行目) の項7 が事業所番号。
//   **介護番号で offices を引いて** その office に 障害番号を入れる。
//   → 拠点名の表記ゆれ (袖ケ浦/袖ヶ浦、茂原=リンクスヘルパーステーション) に
//     依存しないので取り違えない。
//
//   node migrations/backfill_shogai_business_number.mjs            # DRY RUN
//   node migrations/backfill_shogai_business_number.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "encoding-japanese";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const DENSOU = path.join(KAIGO, "伝送データ");

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

/**
 * コントロールレコード (1 行目) の事業所番号。
 * ⚠ 介護 (KK) と障害 (KJ) で **桁位置が違う** (介護は項目が 1 つ多く index 7、障害は 6)。
 *   固定 index で読むと介護側が "0" になり 1 件も当たらない。
 *   コントロールに 10 桁の数値は事業所番号しか出ないので、最初の 10 桁数値を採る。
 */
function controlBn(file) {
  const text = iconv.convert(readFileSync(file), { to: "UNICODE", from: "SJIS", type: "string" });
  const first = (text.split(/\r?\n/).find(Boolean) ?? "")
    .split(",")
    .map((s) => s.replace(/^"|"$/g, "").trim());
  return first.find((v) => /^\d{10}$/.test(v)) ?? "";
}

/** 拠点/訪問介護/制度/提供年月/ほのぼのから/ から prefix にマッチする最初のファイル */
function findDensou(area, seido, prefix) {
  const base = path.join(DENSOU, area, "訪問介護", seido);
  if (!existsSync(base)) return null;
  for (const ym of readdirSync(base).sort()) {
    const dir = path.join(base, ym, "ほのぼのから");
    if (!existsSync(dir)) continue;
    const f = readdirSync(dir).find((x) => new RegExp(`^${prefix}.*\\.CSV$`, "i").test(x));
    if (f) return path.join(dir, f);
  }
  return null;
}

async function main() {
  console.log(`=== 障害 事業所番号 backfill ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data: offices, error } = await sb
    .from("offices")
    .select("id, name, business_number, shogai_business_number");
  if (error) { console.error(`✗ 事業所取得失敗: ${error.message}`); process.exit(1); }
  const byKaigoBn = new Map(offices.filter((o) => o.business_number).map((o) => [o.business_number, o]));

  const updates = [];
  const skips = [];
  for (const area of readdirSync(DENSOU)) {
    if (!existsSync(path.join(DENSOU, area, "訪問介護"))) continue;
    const kk = findDensou(area, "介護", "KK");
    const kj = findDensou(area, "障害", "KJ");
    if (!kj) { skips.push(`${area}: 障害の KJ が無い`); continue; }
    if (!kk) { skips.push(`${area}: 介護の KK が無い (事業所を特定できない)`); continue; }
    const kaigoBn = controlBn(kk);
    const shogaiBn = controlBn(kj);
    const off = byKaigoBn.get(kaigoBn);
    if (!off) { skips.push(`${area}: 介護事業所番号 ${kaigoBn} が offices に無い`); continue; }
    if (off.shogai_business_number === shogaiBn) {
      console.log(`  ${area.padEnd(8)} ${off.name.padEnd(30)} ${shogaiBn}  (設定済 一致)`);
      continue;
    }
    if (off.shogai_business_number) {
      // 既存値と食い違う = どちらかが誤り。上書きせず知らせる
      skips.push(
        `${area}: ${off.name} の既存値 ${off.shogai_business_number} と伝送 ${shogaiBn} が不一致 — 手で確認`,
      );
      continue;
    }
    console.log(`  ${area.padEnd(8)} ${off.name.padEnd(30)} ${shogaiBn}  ← 新規`);
    updates.push({ id: off.id, name: off.name, bn: shogaiBn });
  }

  console.log(`\n更新対象: ${updates.length} 事業所`);
  if (skips.length) {
    console.log("\n--- スキップ ---");
    for (const s of skips) console.log("  " + s);
  }
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で更新します。"); return; }

  for (const u of updates) {
    const { error } = await sb
      .from("offices").update({ shogai_business_number: u.bn }).eq("id", u.id);
    if (error) { console.error(`✗ ${u.name}: ${error.message}`); process.exit(1); }
  }
  console.log(`\n✓ 完了: ${updates.length} 事業所を更新`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
