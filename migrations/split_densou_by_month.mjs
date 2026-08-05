// ============================================================================
// 伝送データ/<拠点>/…/<年月>/ほのぼのから/ の中身を **中身の提供年月** で振り分ける。
//
//   ほのぼのは月遅れ請求も同じ回で出すので、1 フォルダに 202604/202605/202606 が混在する。
//   ファイル名 (KK260801 等) は**処理年月**なので当てにならない。
//   照合スクリプトは「フォルダ内に対象月の KK が 1 個」を前提にしているため、
//   混在したままだと FATAL で止まる。
//
//   判定: 各レコードの 項3 (様式番号 7111/7131/7113/71R1/8222/J111/J121/J611…) 行の
//         項5 = 提供年月。複数月が 1 ファイルに入ることはない (実データで確認)。
//
//   使い方:
//     node migrations/split_densou_by_month.mjs                 # 全拠点 DRY RUN
//     node migrations/split_densou_by_month.mjs --execute
//     SITE=東郷 node migrations/split_densou_by_month.mjs --execute
// ============================================================================
import { readdirSync, readFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import iconv from "encoding-japanese";

const EXECUTE = process.argv.includes("--execute");
const SITE = process.env.SITE || "";
const ROOT = fileURLToPath(new URL("../伝送データ/", import.meta.url));

/** 様式番号の行から提供年月を拾う (介護 / 総合事業 / 障害 いずれも 項5) */
function serviceMonths(file) {
  const txt = iconv.convert(readFileSync(file), { to: "UNICODE", from: "SJIS", type: "string" });
  const months = new Set();
  for (const line of txt.split(/\r?\n/)) {
    if (!line) continue;
    const c = line.split(",").map((s) => s.replace(/"/g, ""));
    if (!/^(7111|7131|7113|71R1|8222|J111|J121|J611|J411)$/.test(c[2] ?? "")) continue;
    if (/^\d{6}$/.test(c[4] ?? "")) months.add(c[4]);
  }
  return [...months];
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.CSV$/i.test(e.name)) out.push(p);
  }
  return out;
}

function main() {
  console.log(`=== 伝送データ 提供年月で振り分け ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ${SITE || "全拠点"} ===\n`);
  const sites = readdirSync(ROOT).filter((d) => statSync(path.join(ROOT, d)).isDirectory());
  let moved = 0, skipped = 0, mixed = 0;

  for (const site of sites) {
    if (SITE && site !== SITE) continue;
    for (const file of walk(path.join(ROOT, site))) {
      // 「ほのぼのから」配下だけが対象 (新システム側は自分で出しているので触らない)
      if (!/[\\/]ほのぼのから[\\/]/.test(file)) continue;
      const months = serviceMonths(file);
      if (months.length === 0) { skipped++; continue; }
      if (months.length > 1) {
        console.log(`  ⚠ ${path.relative(ROOT, file)}: 提供年月が複数 (${months.join(",")}) — 手動で確認`);
        mixed++;
        continue;
      }
      const ym = months[0];
      // …/<拠点>/<制度パス>/<年月>/ほのぼのから/<file>
      const honoDir = path.dirname(file);
      const ymDir = path.dirname(honoDir);
      if (path.basename(ymDir) === ym) continue; // 既に正しい
      const dest = path.join(path.dirname(ymDir), ym, path.basename(honoDir));
      console.log(`  ${path.relative(ROOT, file)}  →  ${ym}/`);
      if (EXECUTE) {
        mkdirSync(dest, { recursive: true });
        const to = path.join(dest, path.basename(file));
        if (existsSync(to)) { console.log(`    ✗ 移動先に同名あり — スキップ`); continue; }
        renameSync(file, to);
      }
      moved++;
    }
  }
  console.log(`\n${EXECUTE ? "✓ 完了" : "※ DRY RUN"}: 移動 ${moved} / 対象外 ${skipped} / 複数月混在 ${mixed}`);
  if (!EXECUTE && moved) console.log("  --execute で実行します。");
}

main();
