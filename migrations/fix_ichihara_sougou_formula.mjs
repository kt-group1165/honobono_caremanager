// 市原市 (IH_) 総合事業の %加算コードに formula を backfill する
//
// 背景 (2026-07-15): import_ichihara_sougou_service_codes.mjs は国保連統一 CSV の
// 単位数列しか見ておらず、処遇改善等の %加算 (monthly_aggregate) の formula を
// 設定していない。aggregate-sougou は「事業所の処遇改善率と一致する formula を持つ
// 自治体版コード」を探すため、formula null のままだと市原市 (保険者122192) の
// 利用者に処遇改善が乗らない = 過少請求になる。
//
// 方針: 処遇改善等の率は国基準で市町村共通のため、CB_ (千葉市) の同 suffix コードの
// formula を同世代 (valid_from 一致、無ければ直近の過去世代) から複製する。
// CB 側に formula が無い suffix は対象外 (単位数コードはそのまま)。
//
// 実行:
//   node migrations/fix_ichihara_sougou_formula.mjs            # DRY RUN
//   node migrations/fix_ichihara_sougou_formula.mjs --execute  # 本番
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
const get = (k) => (env.match(new RegExp(k + "=(.+)")) || [])[1]?.trim();
const SB_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const KEY = get("SUPABASE_SERVICE_ROLE_KEY");
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
const EXECUTE = process.argv.includes("--execute");

const fetchAll = async (path) => {
  const out = [];
  for (let ofs = 0; ; ofs += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}&limit=1000&offset=${ofs}`, { headers: H });
    const page = await r.json();
    if (!Array.isArray(page)) throw new Error(JSON.stringify(page));
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
};

const main = async () => {
  // 1) CB_ の formula 持ちコード → suffix ごとに世代リスト
  const cb = await fetchAll(
    "kaigo_service_codes?service_code=like.CB_A2*&formula=not.is.null&select=service_code,valid_from,formula&order=valid_from",
  );
  const bySuffix = new Map(); // 'A26184' -> [{valid_from, formula}] (昇順)
  for (const r of cb) {
    const suffix = r.service_code.slice(3); // CB_A26184 -> A26184
    if (!bySuffix.has(suffix)) bySuffix.set(suffix, []);
    bySuffix.get(suffix).push({ valid_from: r.valid_from, formula: r.formula });
  }
  console.log(`CB_ formula 持ち: ${cb.length} 行 / ${bySuffix.size} suffix`);

  // 2) IH_ の formula null 行のうち、CB に同 suffix formula がある行
  const ih = await fetchAll(
    "kaigo_service_codes?service_code=like.IH_A2*&formula=is.null&select=id,service_code,service_name,valid_from&order=service_code,valid_from",
  );
  const plan = [];
  for (const r of ih) {
    const suffix = r.service_code.slice(3);
    const gens = bySuffix.get(suffix);
    if (!gens) continue; // CB に formula が無い suffix = 単位数コード。対象外
    // 同 valid_from → 無ければ直近の過去世代
    let pick = gens.find((g) => g.valid_from === r.valid_from);
    if (!pick) {
      const past = gens.filter((g) => g.valid_from <= r.valid_from);
      pick = past[past.length - 1] ?? null;
    }
    if (!pick) {
      console.log(`  SKIP ${r.service_code} (${r.valid_from}): CB に過去世代なし`);
      continue;
    }
    plan.push({ ...r, formula: pick.formula, from: pick.valid_from });
  }

  console.log(`\n更新計画: ${plan.length} 行`);
  for (const p of plan) {
    console.log(
      `  ${p.service_code} (${p.valid_from}) ${p.service_name} ← formula ${JSON.stringify(p.formula)} (CB ${p.from} 世代)`,
    );
  }
  if (!EXECUTE) {
    console.log("\nDRY RUN 終了。実行するには --execute");
    return;
  }

  let ok = 0;
  for (const p of plan) {
    const res = await fetch(`${SB_URL}/rest/v1/kaigo_service_codes?id=eq.${p.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ formula: p.formula }),
    });
    if (!res.ok) {
      console.error(`  FAIL ${p.service_code}: ${await res.text()}`);
      continue;
    }
    ok++;
  }
  console.log(`\nPATCH 完了: ${ok}/${plan.length}`);

  // 件数確認 (silent failure 防止)
  const after = await fetchAll(
    "kaigo_service_codes?service_code=like.IH_A2*&formula=not.is.null&select=service_code",
  );
  console.log(`検証: IH_A2* の formula 非 null = ${after.length} 行 (期待 >= ${ok})`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
