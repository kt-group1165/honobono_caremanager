// ============================================================================
// 既存の client_insurance_records の benefit_rate を負担割合に合わせて是正する。
//
//   ⚠ **負担割合が正である**ことを ほのぼの伝送 (KK 7131 項29 保険給付率) で
//     1 件ずつ確認したうえで直す。「100−負担割合」を無条件には当てない。
//     手順A の実測: ① 負担割合が正 28 件 / ② 給付率が正 **0 件** / ③ 判定不能 10 件。
//
//   直す対象は 2 種類だけ:
//     (A) 単位混在   給付列が 9/8/7 (= 割) で入っている。90/80/70 に揃えるだけで
//                    **意味は変わらない**ので伝送の裏取り無しでも安全
//     (B) 伝送で確認 伝送の給付率 = 100−負担割合×10 だった行のみ
//
//   直さないもの:
//     ・伝送に出ない行 (③)                     … 材料が無い
//     ・伝送が給付列と一致した行 (②)           … 負担割合のほうが誤り。別途調査
//     ・公費単独 (被保番 H 始まり / 給付率 0)   … 0 が正しい。ほのぼのも 0
//     ・copay_rate が null の行                 … 直す根拠が無い
//
//   使い方:
//     node migrations/fix_benefit_rate_from_copay.mjs              # DRY RUN
//     node migrations/fix_benefit_rate_from_copay.mjs --execute
//
//   ⚠ --execute の前に、出力される スナップショット SQL を Supabase SQL Editor で
//     実行してバックアップを取ること。確認後は **バックアップ表を DROP する**
//     (CREATE TABLE AS は RLS を継承せず anon に丸見えになる)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  loadDensouBenefitRates, densouRatesFor, benefitPct, benefitFromCopay,
} from "./_densou_benefit_rate.mjs";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const num = (v) => (v == null || v === "" ? null : Number(v));

async function main() {
  console.log(`=== benefit_rate 是正 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { map, files, records } = loadDensouBenefitRates(path.join(KAIGO, "伝送データ"));
  console.log(`伝送 (KK 7131): ${files} ファイル / ${records} 明細 / キー ${map.size} 件`);
  if (map.size === 0) die("伝送を 1 件も読めていない。パスを確認すること");

  const all = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from("client_insurance_records")
      .select("id,client_id,insurer_number,insured_number,certification_start_date,certification_end_date,copay_rate,benefit_rate,notes")
      .order("id", { ascending: true }) // order 無しページングは行が抜ける
      .range(off, off + 999);
    if (error) die(error.message);
    all.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  console.log(`認定行: ${all.length} 行\n`);

  const unitFix = [];   // (A) 単位混在
  const densouFix = []; // (B) 伝送で確認
  const skipNoData = [];
  const skipReverse = [];
  const skipKohi = [];

  const skipFake = [];
  for (const r of all) {
    const c = num(r.copay_rate), b = num(r.benefit_rate);
    if (c == null || b == null || c < 1 || c > 3) continue; // copay null は対象外
    const want = benefitFromCopay(c);
    if (b === want) continue;                    // 既に整合
    // ⚠ 偽データ・サンプルは触らない。単位混在 46 行は **全部**
    //   [fake テスト用-kyotaku-enrich] で、本番の利用者ではなかった (2026-09-03 実測)。
    //   直す価値が無いうえ、他セッションのサンプル検証を乱す恐れがある。
    //   出どころは enrich_fake_kyotaku_sample_data.mjs (同日 "9"→"90" に是正済)。
    if (/\[(fake|sample)/i.test(String(r.notes ?? ""))) { skipFake.push(r); continue; }
    if (String(r.insured_number ?? "").startsWith("H")) { skipKohi.push(r); continue; }
    if (benefitPct(b) === want) { unitFix.push({ r, want }); continue; } // (A)

    const rates = [...densouRatesFor(map, r)];
    if (rates.length !== 1) { skipNoData.push(r); continue; }
    const d = Number(rates[0]);
    if (d === want) densouFix.push({ r, want, densou: d });
    else if (d === benefitPct(b)) skipReverse.push({ r, densou: d });
    else skipNoData.push(r);
  }

  console.log(`(A) 単位混在 (9→90 等。意味は変わらない): ${unitFix.length} 行`);
  console.log(`(B) 伝送で「負担割合が正」を確認        : ${densouFix.length} 行`);
  console.log(`--- 直さないもの ---`);
  console.log(`  伝送に材料が無い                     : ${skipNoData.length} 行`);
  console.log(`  ★ 伝送が給付率列と一致 (逆向き)      : ${skipReverse.length} 行`);
  console.log(`  公費単独 (被保番 H 始まり)           : ${skipKohi.length} 行`);
  console.log(`  偽データ・サンプル                   : ${skipFake.length} 行`);

  if (skipReverse.length > 0) {
    console.error(`\n🔴 逆向きが ${skipReverse.length} 行ある。前提が崩れるので止める。`);
    for (const { r, densou } of skipReverse.slice(0, 10)) {
      console.error(`   client=${r.client_id} 負担${r.copay_rate}割 / 給付列${r.benefit_rate} / 伝送${densou}`);
    }
    process.exit(2);
  }

  const targets = [...unitFix, ...densouFix];
  if (targets.length === 0) { console.log("\n対象なし。"); return; }

  // 氏名を出して人が読めるようにする
  const ids = [...new Set(targets.map((t) => t.r.client_id))];
  const nm = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await sb.from("clients").select("id,name").in("id", ids.slice(i, i + 150));
    for (const c of data ?? []) nm.set(c.id, c.name);
  }
  console.log(`\n=== 変更内容 (${targets.length} 行) ===`);
  for (const t of targets.slice(0, 60)) {
    const tag = t.densou ? `伝送${t.densou}` : "単位";
    console.log(`  ${(nm.get(t.r.client_id) ?? t.r.client_id).padEnd(14)} 負担${t.r.copay_rate}割  給付 ${t.r.benefit_rate} → ${t.want}   [${tag}]`);
  }
  if (targets.length > 60) console.log(`  … 他 ${targets.length - 60} 行`);

  console.log(`\n=== 先に取るスナップショット (Supabase SQL Editor) ===`);
  console.log(`BEGIN;`);
  console.log(`CREATE TABLE _backup_cir_benefit_20260903 AS`);
  console.log(`SELECT id, client_id, copay_rate, benefit_rate FROM client_insurance_records`);
  // ⚠ 省略せず全件出す。貼って実行できないスナップショットは無意味
  console.log(`WHERE id IN (\n  ${targets.map((t) => `'${t.r.id}'`).join(",\n  ")}\n);`);
  console.log(`COMMIT;   -- ⚠ COMMIT を忘れると終了時に rollback される`);
  console.log(`-- 確認後は DROP TABLE _backup_cir_benefit_20260903;  (RLS 非継承で anon に見える)`);

  if (!EXECUTE) { console.log(`\n※ DRY RUN。--execute で更新します。`); return; }

  let ok = 0;
  for (const t of targets) {
    const { error } = await sb
      .from("client_insurance_records")
      .update({ benefit_rate: String(t.want) })
      .eq("id", t.r.id);
    if (error) die(`id=${t.r.id}: ${error.message}`);
    ok += 1;
  }
  console.log(`\n✓ ${ok} 行を更新しました。`);

  // 件数確認 (実際に入ったか)
  const { count, error: e2 } = await sb
    .from("client_insurance_records")
    .select("*", { count: "exact", head: true })
    .in("id", targets.map((t) => t.r.id).slice(0, 150));
  if (e2) die(e2.message);
  console.log(`  確認: 対象 ${Math.min(targets.length, 150)} 行のうち ${count} 行が存在`);
}

main().catch((e) => die(e.message));
