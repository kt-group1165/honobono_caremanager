// ============================================================================
// 全事業所分の授受データフォルダを**正規形で作る** (ファイルがまだ無い拠点も含む)。
//
//   置き場所が用意されていないと、ほのぼのから出したファイルの行き先を毎回考えることになり
//   拠点名や階層がブレる。先に空の受け皿を作っておく。
//
//   作る形 (伝送データ/README.md と同じ):
//     利用者データ/<拠点>/
//     サービス実績データ/<拠点>/<YYYYMM>/訪問介護/{介護,障害}/
//     サービス実績データ/<拠点>/<YYYYMM>/{居宅,訪問入浴}/
//     伝送データ/<拠点>/訪問介護/{介護,障害}/<YYYYMM>/ほのぼのから|新システム/
//     伝送データ/<拠点>/{居宅,訪問入浴}/<YYYYMM>/ほのぼのから|新システム/
//
//   **訪問介護事業所は同じ事業所で介護保険と障害福祉の両方を請求する**ので、
//   訪問介護/ の下に 介護 / 障害 を置く (障害は別の事業所番号を持つ)。
//   居宅・訪問入浴は制度が 1 つなので直下に月。
//
//   空フォルダは git に残らないので各末端に .gitkeep を置く
//   (normalize_data_folders.mjs の空フォルダ掃除に消されないためでもある)。
//
//   使い方:
//     node migrations/scaffold_data_folders.mjs            # 作成計画のみ
//     node migrations/scaffold_data_folders.mjs --execute
//     MONTH=202607 node migrations/scaffold_data_folders.mjs --execute   # 翌月分を足す
// ============================================================================
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || "202606";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * 事業所番号 → 拠点。**伝送ファイルの制御レコードで実証した対応**を正とする
 * (事業所名から機械的に導くと ムツミヘルパーステーション=姉ム のようなケースを外す)。
 *
 * ⚠ 2026-08-04 の事故: 「姉ム」を ＫＴ姉崎ヘルパーステーション (1272400142) と誤認して
 *   障害データを入れてしまった。正しくは ムツミヘルパーステーション (1272400829)。
 *   ＫＴ姉崎 は別拠点「K姉」。名前が似ている拠点は必ず事業所番号で確認すること。
 */
const SITE_BY_BN = {
  // 茂原 (リンクス)
  "1271500942": "茂原", "1271500934": "茂原", "1271502625": "茂原",
  // 大網 (リンクス大網白里)
  "1275800892": "大網", "1279200081": "大網", "1279200024": "大網",
  // いすみ / 山武 / 東郷 (リンクス)
  "1278600398": "いすみ", "1278600406": "いすみ",
  "1279000366": "山武",
  "1271502518": "東郷",
  // 姉ム (ムツミ) / K姉 (ＫＴ姉崎)  ← 紛らわしいので注意
  "1272400829": "姉ム", "1272400837": "姉ム", "1272401058": "姉ム",
  "1272400142": "K姉", "1272401876": "K姉",
  // 五井 (ＫＴ五井 / ケイ・ティ・サービス)
  "1272401967": "五井", "1272400506": "五井",
  // 市原 / やわた / ちはら台
  "1272401561": "市原",
  "1272404508": "やわた",
  "1272403534": "ちはら台", "1272403492": "ちはら台",
  // 木更津 / 君津 / 袖ケ浦 (ムツミ)
  "1271101295": "木更津", "1271101287": "木更津",
  "1273001626": "君津",
  "1273400844": "袖ケ浦", "1273400851": "袖ケ浦",
  // 千葉市内 (Ｈａｎａ)
  "1270201930": "花見川", "1270201922": "花見川", "1270202755": "花見川",
  "1270203191": "さつきが丘",
  "1270501180": "おゆみ野", "1270501172": "おゆみ野", "1270501198": "おゆみ野",
  "1270402116": "高品", "1270404229": "高品",
  "1270105271": "中央",
  // 千葉市外 (Ｈａｎａ)
  "1270303173": "四街道", "1270303272": "四街道",
  "1270906546": "船橋", "1270907411": "船橋",
  "1272603851": "八千代", "1272603844": "八千代",
};

/** offices.service_type → 事業種別フォルダ名 */
const KIND_BY_SERVICE = {
  訪問介護: "訪問介護",
  居宅介護支援: "居宅",
  訪問入浴: "訪問入浴",
};

function loadEnv() {
  const { readFileSync } = require("node:fs");
  const txt = readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const GITKEEP = [
  "# このフォルダはほのぼのから出したファイルの置き場所です。",
  "# 構成の説明は 伝送データ/README.md を参照。",
  "",
].join("\n");

async function main() {
  console.log(`=== 授受データフォルダ作成 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} 対象月=${MONTH} ===\n`);

  const { data: offices, error } = await sb
    .from("offices")
    .select("name, service_type, business_number")
    .in("service_type", Object.keys(KIND_BY_SERVICE));
  if (error) throw new Error(`offices: ${error.message}`);

  /** 拠点 → Set<事業種別> */
  const sites = new Map();
  const unmapped = [];
  for (const o of offices) {
    const kind = KIND_BY_SERVICE[o.service_type];
    if (!o.business_number) continue; // デモ事業所等
    const site = SITE_BY_BN[o.business_number];
    if (!site) { unmapped.push(`${o.business_number} ${o.name} (${o.service_type})`); continue; }
    if (!sites.has(site)) sites.set(site, new Set());
    sites.get(site).add(kind);
    // 障害は訪問介護事業所が別の事業所番号で持つ (MEISAI では 9999999999 のことも)
    // 障害は 訪問介護/障害 として作るので事業種別としては足さない
  }

  if (unmapped.length) {
    console.log(`⚠ 拠点が未定義の事業所 ${unmapped.length} 件 (SITE_BY_BN に追記してください):`);
    for (const u of unmapped) console.log(`   ${u}`);
    console.log("");
  }

  const dirs = [];
  for (const [site, kinds] of [...sites].sort()) {
    dirs.push(path.join("利用者データ", site));
    for (const kind of [...kinds].sort()) {
      // 訪問介護だけ 介護 / 障害 の 2 制度に分ける
      const schemes = kind === "訪問介護" ? ["介護", "障害"] : [null];
      for (const sch of schemes) {
        const seg = sch ? [kind, sch] : [kind];
        dirs.push(path.join("サービス実績データ", site, MONTH, ...seg));
        dirs.push(path.join("伝送データ", site, ...seg, MONTH, "ほのぼのから"));
        dirs.push(path.join("伝送データ", site, ...seg, MONTH, "新システム"));
      }
    }
  }

  const missing = dirs.filter((d) => !existsSync(path.join(ROOT, d)));
  console.log(`拠点 ${sites.size} / フォルダ ${dirs.length} (未作成 ${missing.length})\n`);
  for (const [site, kinds] of [...sites].sort()) {
    console.log(`  ${site.padEnd(10)} ${[...kinds].sort().join(" / ")}`);
  }
  if (missing.length) {
    console.log(`\n作成するフォルダ:`);
    for (const d of missing) console.log(`  ${d}`);
  }

  if (!EXECUTE) {
    console.log(`\n※ DRY RUN。--execute で作成します。`);
    return;
  }
  let made = 0;
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!existsSync(abs)) { mkdirSync(abs, { recursive: true }); made++; }
    const keep = path.join(abs, ".gitkeep");
    if (!existsSync(keep)) writeFileSync(keep, GITKEEP, "utf8");
  }
  console.log(`\n✓ 完了: フォルダ ${made} 個作成 / .gitkeep を ${dirs.length} 箇所に配置`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
