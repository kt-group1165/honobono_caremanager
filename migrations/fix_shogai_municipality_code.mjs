// 障害受給者証の insurer_municipality に市町村「名」が入っている行を、公的な6桁の
// 市町村番号に直す。
//
//   伝送 (J121 項6) の突合キーは市町村番号なので、名前のままだと請求書が市町村別に
//   まとまらず、国保連側でも突合できない。
//   コードは全国地方公共団体コード (都道府県2桁 + 市区町村3桁 + チェックデジット1桁)。
//   大網の実伝送で 5 市町村すべて矛盾なく裏取り済 (2026-07-31)。
//
//   node migrations/fix_shogai_municipality_code.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// 千葉県の市町村番号 (全国地方公共団体コード)。「千葉県」接頭辞や空白の揺れは正規化して引く
const MUNI_CODE = {
  千葉市中央区: "121004", 千葉市花見川区: "121012", 千葉市稲毛区: "121021",
  千葉市若葉区: "121039", 千葉市緑区: "121047", 千葉市美浜区: "121055",
  銚子市: "122024", 市川市: "122033", 船橋市: "122045", 館山市: "122053",
  木更津市: "122061", 松戸市: "122070", 野田市: "122088", 茂原市: "122101",
  成田市: "122114", 佐倉市: "122122", 東金市: "122135", 旭市: "122151",
  習志野市: "122161", 柏市: "122178", 勝浦市: "122186", 市原市: "122192",
  流山市: "122203", 八千代市: "122211", 我孫子市: "122220", 鴨川市: "122238",
  鎌ケ谷市: "122246", 君津市: "122254", 富津市: "122262", 浦安市: "122271",
  四街道市: "122289", 袖ケ浦市: "122297", 八街市: "122309", 印西市: "122313",
  白井市: "122321", 富里市: "122335", 南房総市: "122343", 匝瑳市: "122351",
  香取市: "122360", 山武市: "122374", いすみ市: "122386", 大網白里市: "122390",
  酒々井町: "123226", 栄町: "123293", 神崎町: "123421", 多古町: "123471",
  東庄町: "123498", 九十九里町: "124032", 芝山町: "124036", 横芝光町: "124095",
  一宮町: "124214", 睦沢町: "124222", 長生村: "124231", 白子町: "124249",
  長柄町: "124265", 長南町: "124273", 大多喜町: "124419", 御宿町: "124435",
  鋸南町: "124630",
};
const normalize = (s) => (s || "").normalize("NFKC").replace(/\s/g, "").replace(/^千葉県/, "");

async function main() {
  console.log(`=== 障害受給者証 市町村番号の是正 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const all = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("shougai_certifications")
      .select("id, client_id, beneficiary_number, insurer_municipality")
      .order("id").range(f, f + 999);
    if (error) { console.error(error.message); process.exit(1); }
    all.push(...data);
    if (data.length < 1000) break;
  }
  const bad = all.filter((r) => r.insurer_municipality && !/^\d{6}$/.test(String(r.insurer_municipality).trim()));
  console.log(`受給者証 ${all.length} 件 / 市町村番号が6桁でない ${bad.length} 件`);

  const fixes = [], unknown = new Map();
  for (const r of bad) {
    const code = MUNI_CODE[normalize(r.insurer_municipality)];
    if (!code) { unknown.set(r.insurer_municipality, (unknown.get(r.insurer_municipality) || 0) + 1); continue; }
    fixes.push({ id: r.id, from: r.insurer_municipality, to: code });
  }
  const byName = {};
  for (const f of fixes) byName[`${f.from} → ${f.to}`] = (byName[`${f.from} → ${f.to}`] || 0) + 1;
  console.log("\n変換内訳:");
  for (const [k, v] of Object.entries(byName).sort()) console.log(`  ${k} (${v}件)`);
  if (unknown.size) {
    console.log("\n⚠ 対応表に無い市町村 (手当て要):");
    for (const [k, v] of unknown) console.log(`  「${k}」 ${v}件`);
  }

  if (!EXECUTE) { console.log(`\n※ DRY RUN。--execute で ${fixes.length} 件を更新。`); return; }
  let ok = 0;
  for (const f of fixes) {
    const { error, count } = await sb.from("shougai_certifications")
      .update({ insurer_municipality: f.to }, { count: "exact" }).eq("id", f.id);
    if (error) { console.error(`✗ ${f.id}: ${error.message}`); process.exit(1); }
    ok += count || 0;
  }
  console.log(`\n更新 ${ok} 件 完了`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
