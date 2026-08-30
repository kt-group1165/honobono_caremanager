// ============================================================================
// 障害の稼働データ (MEISAI) 取込を **全拠点まとめて**回す。
//
//   拠点の解決は scripts/shogai-densou-diff-all.mts と同じ:
//     伝送データ/<拠点>/訪問介護/障害/<提供年月>/ほのぼのから/KJ*.CSV の
//     コントロールレコード 項7 = 障害の事業所番号 → offices.shogai_business_number
//
//   介護の事業所番号 (OFFICE_BN) と 稼働データの置き場 (AREA_DIR) と
//   利用者番号マップ (MAP_TAG) は拠点名から引く。取れない拠点は理由を出して飛ばす。
//
//   TARGET_MONTH=2026-06 node migrations/import_meisai_shougai_all.mjs           # DRY RUN
//   TARGET_MONTH=2026-06 node migrations/import_meisai_shougai_all.mjs --execute
//   AREAS=おゆみ野,中央 で拠点を絞れる
//
// ⚠ 単体の import_meisai_shougai_records.mjs は「その拠点の当月ぶんを消して入れ直す」
//   ので、途中で失敗しても他拠点には影響しない。_fk_guard が INSERT 前に
//   参照先を確認するので「消したのに入らない」は起きない。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import iconv from "iconv-lite";

const MONTH = process.env.TARGET_MONTH ?? "2026-06";      // 2026-06
const YM = MONTH.replace("-", "");                         // 202606
const EXECUTE = process.argv.includes("--execute");
const ONLY = (process.env.AREAS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const { data: offices, error } = await sb.from("offices")
  .select("id, name, business_number, shogai_business_number");
if (error) { console.error(`✗ 事業所取得失敗: ${error.message}`); process.exit(1); }
const byShogaiBn = new Map((offices ?? [])
  .filter((o) => o.shogai_business_number)
  .map((o) => [String(o.shogai_business_number), o]));

// 稼働データ (MEISAI) の置き場と利用者番号マップは拠点名で決まる。
// 名前が揺れている拠点だけ明示する (それ以外は拠点名そのまま)。
const MAP_TAG_ALIAS = { さつきが丘: "さつき障害" };

const jobs = [];
const skipped = [];
for (const area of readdirSync(path.join(ROOT, "伝送データ"))) {
  if (ONLY.length && !ONLY.includes(area)) continue;
  const dir = path.join(ROOT, "伝送データ", area, "訪問介護", "障害", YM, "ほのぼのから");
  if (!existsSync(dir)) continue;
  const kj = readdirSync(dir).find((f) => /^KJ.*\.CSV$/i.test(f));
  if (!kj) { skipped.push(`${area}: KJ ファイル無し`); continue; }
  const first = iconv.decode(readFileSync(path.join(dir, kj)), "Shift_JIS")
    .split(/\r?\n/).find(Boolean) ?? "";
  const bn = (first.split(",")[6] ?? "").replace(/^"|"$/g, "").trim();
  const off = byShogaiBn.get(bn);
  if (!off) { skipped.push(`${area}: 障害の事業所番号 ${bn} が offices に無い`); continue; }
  if (!off.business_number) { skipped.push(`${area}: ${off.name} に介護の事業所番号が無い`); continue; }
  const mapTag = MAP_TAG_ALIAS[area] ?? area;
  if (!existsSync(path.join(ROOT, "migrations", `_meisai_num_to_client_${mapTag}.json`))) {
    skipped.push(`${area}: 利用者番号マップ _meisai_num_to_client_${mapTag}.json が無い`); continue;
  }
  jobs.push({ area, officeId: off.id, officeName: off.name, bn: off.business_number, mapTag });
}

console.log(`=== 障害 稼働データ取込 ${MONTH} ${EXECUTE ? "【本番】" : "【DRY RUN】"} (${jobs.length} 拠点) ===\n`);

const results = [];
for (const j of jobs) {
  process.stdout.write(`  ${j.area.padEnd(8)} ${j.officeName} … `);
  let out = "";
  try {
    out = execFileSync("node", ["migrations/import_meisai_shougai_records.mjs", ...(EXECUTE ? ["--execute"] : [])], {
      cwd: ROOT, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TARGET_MONTH: MONTH, AREA_DIR: j.area,
             OFFICE_ID: j.officeId, OFFICE_BN: j.bn, MAP_TAG: j.mapTag },
    });
  } catch (e) {
    const msg = String(e.stdout ?? "").split("\n").filter(Boolean).slice(-2).join(" / ")
      || e.message.split("\n")[0];
    console.log("✗ 失敗");
    results.push(`${j.area.padEnd(8)} ✗ ${msg}`);
    continue;
  }
  const juho = /重訪 日次通算: .*?\(TJ の請求区間を使用 (\d+) \/ MEISAI の時刻 (\d+)\)/.exec(out);
  const ins = /✓ 完了: (\d+)行 INSERT/.exec(out) ?? /(\d+)行を INSERT/.exec(out);
  const miss = /TJ で引けなかった利用者: (.*)/.exec(out);
  console.log(`${ins ? ins[1] + "行" : "—"}${juho ? `  重訪 TJ ${juho[1]} / MEISAI ${juho[2]}日` : ""}`);
  results.push(`${j.area.padEnd(8)} ${(ins ? ins[1] + "行" : "—").padStart(7)}`
    + (juho ? `  重訪 TJ ${juho[1].padStart(3)}日 / MEISAI の時刻 ${juho[2].padStart(3)}日` : "")
    + (miss ? `\n           ⚠ TJ で引けなかった: ${miss[1]}` : ""));
}

console.log(`\n===== まとめ ${MONTH} =====`);
for (const r of results) console.log("  " + r);
if (skipped.length) {
  console.log("\n--- スキップ ---");
  for (const s of skipped) console.log("  " + s);
}
if (!EXECUTE) console.log("\n※ DRY RUN。--execute で保存します。");
