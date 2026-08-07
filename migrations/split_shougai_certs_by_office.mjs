// ============================================================================
// 「全事業所」の障害受給者証 JSON を **伝送 (KJ) を使って事業所ごとに切り分ける**。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   ほのぼのの受給者証一覧表は事業者エントリごとに出すのが基本だが、
//   全事業所分をまとめて 1 本 (858 ページ / 1,542 名 / 6,865 entry) で出すこともできる。
//   ただし**ヘッダーの事業所名は選択中の 1 つに固定**されるため
//   (今回は全ページ「Hanaヘルパーステーション四街道」)、PDF からは所属が分からない。
//
//   → その月の伝送 (KJ) に出ている受給者証番号でフィルタする。
//     「この事業所が請求した人 = この事業所の利用者」なので確実。
//     2026-06 の 17 拠点 501 名すべてが解決した。
//
//   ⚠ 伝送を実績の取込元にはしない。ここで使うのは**所属の判定**だけで、
//     取り込む中身 (支給量・区分・上限額) はすべて受給者証 PDF 由来。
//
//   node migrations/split_shougai_certs_by_office.mjs            # DRY RUN
//   node migrations/split_shougai_certs_by_office.mjs --execute  # 拠点別 JSON を書く
//
//   出力: migrations/shougai_import_<拠点>.json (既存を上書きするので注意)
// ============================================================================
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import iconv from "encoding-japanese";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const SRC = process.env.SRC_JSON || "shougai_import_全事業所.json";
const MONTH = process.env.TARGET_MONTH || "2026-06";
const YM = MONTH.replace("-", "");
const ONLY = process.env.AREA_DIR || "";

const src = JSON.parse(readFileSync(path.join(KAIGO, "migrations", SRC), "utf8"));
console.log(`=== 全事業所 受給者証を拠点別に分割 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===`);
console.log(`   元: ${SRC} — 利用者 ${src.clients.length} 名 / entry ${src.clients.reduce((a, c) => a + (c.certs?.length ?? 0), 0)}\n`);

// 受給者証番号 -> client (同じ番号が複数 client に出ることは無い想定)
const byCert = new Map();
for (const c of src.clients) {
  for (const e of c.certs ?? []) {
    if (e.cert_number) byCert.set(e.cert_number, c);
  }
}

const sites = readdirSync(path.join(KAIGO, "伝送データ")).sort();
let totalHit = 0, totalMiss = 0;
for (const site of sites) {
  if (ONLY && site !== ONLY) continue;
  const dir = path.join(KAIGO, "伝送データ", site, "訪問介護", "障害", YM, "ほのぼのから");
  if (!existsSync(dir)) continue;
  const kj = readdirSync(dir).find((f) => /^KJ.*\.CSV$/i.test(f));
  if (!kj) continue;

  const rows = iconv
    .convert(readFileSync(path.join(dir, kj)), { to: "UNICODE", from: "SJIS", type: "string" })
    .split(/\r?\n/).filter(Boolean)
    .map((l) => l.split(",").map((s) => s.replace(/"/g, "")));
  const recipients = new Set();
  for (const r of rows) {
    if (r[2] === "J121" && r[3] === "01") recipients.add(r[7]);
  }
  if (!recipients.size) continue;

  const picked = new Map(); // client -> それ自身 (重複排除)
  const miss = [];
  for (const n of recipients) {
    const c = byCert.get(n);
    if (!c) { miss.push(n); continue; }
    picked.set(c, c);
  }
  totalHit += picked.size; totalMiss += miss.length;
  console.log(
    `  ${site.padEnd(10)} 伝送 ${String(recipients.size).padStart(3)} 名 → PDF で解決 ${String(picked.size).padStart(3)}` +
      (miss.length ? `  ⚠ 未解決 ${miss.length}: ${miss.slice(0, 5).join(",")}` : ""),
  );

  if (!EXECUTE) continue;
  const out = {
    office: site,
    area: site,
    source: `${SRC} から ${kj} の受給者で抽出`,
    stats: { total_cert_entries: [...picked.keys()].reduce((a, c) => a + (c.certs?.length ?? 0), 0) },
    warnings: src.warnings ?? [],
    clients: [...picked.keys()],
  };
  const dest = path.join(KAIGO, "migrations", `shougai_import_${site}.json`);
  writeFileSync(dest, JSON.stringify(out, null, 1), "utf8");
}
console.log(`\n合計: 解決 ${totalHit} / 未解決 ${totalMiss}`);
if (!EXECUTE) console.log("※ DRY RUN。--execute で拠点別 JSON を書き出します (既存を上書き)。");
