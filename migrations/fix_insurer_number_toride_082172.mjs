// ============================================================================
// 保険者番号 "82172" (5 桁) を 取手市の "082172" に直す — 先頭 0 の欠落
//
//   node migrations/fix_insurer_number_toride_082172.mjs             # DRY RUN
//   node migrations/fix_insurer_number_toride_082172.mjs --execute
//
// ── 何が起きていたか ────────────────────────────────────────────────────
//   保険者番号は 6 桁 ([JIS 市区町村コード 5 桁][modulus10 の検証数字 1 桁])。
//   佐藤 ますみ (#13651) だけが **5 桁の "82172"** を持っていた。
//
// ── 根拠 (推測ではない) ──────────────────────────────────────────────────
//   ① 取込元の CSV に **保険者名がそのまま入っている**。
//        apps/order-app/保険.csv  1 行だけ該当
//          13651,佐藤,ますみ,… ,被保険者番号 92601,… ,保険者 **取手市**,… ,保険者番号 **82172**
//        → 取込は CSV の値を忠実に写しているだけで、**元データが既に 5 桁**。
//
//   ② 取手市 (茨城県) の JIS 市区町村コードは **08217**。
//      これに modulus10 の検証数字を付けると
//          0*2=0 → 0   8*1=8 → 8   2*2=4 → 4   1*1=1 → 1   7*2=14 → 5
//          合計 18   検証数字 = (10 - 18 mod 10) mod 10 = **2**
//        ⇒ **082172**。CSV の "82172" は **先頭の 0 が落ちただけ**で、
//          残り 5 桁は 082172 と完全に一致する。
//
//   つまり「82172 の先頭に 0 を足す」以外の解釈が成り立たない。
//   検証数字も通るので、この 1 名に限り**根拠のある是正**として扱える。
//
// ── ⚠ 被保険者番号 92601 は直さない ─────────────────────────────────────
//   被保険者番号は 10 桁だが、この人は 5 桁の "92601"。CSV も同じ値。
//   **被保番には検証数字が無い**ので、先頭に 0 を 5 つ足して "0000092601" に
//   するのが正しいという根拠が取れない (0 埋めの桁数を確かめる材料が無い)。
//   → **触らない**。ほのぼので実物を見て確認してから直すこと。
//
// ── 触る範囲 ────────────────────────────────────────────────────────────
//   clients.insurer_number が "82172" の行のみ (1 名)。
//   この利用者は client_insurance_records 0 行 / 事業所割当なし / 実績 0 件。
//   ⚠ 所属は office_id = 介護ショップケア・サポート千葉 (福祉用具 = order-app)。
//      clients.insurer_number は order-app の伝送 builder
//      (lib/kokuho-densou/build.ts) が読むので、レンタルが始まると伝送に乗る。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const WRONG = "82172";
const RIGHT = "082172";           // 取手市 (JIS 08217 + modulus10 の検証数字 2)
/** CSV で保険者名まで確認できた被保険者番号だけ直す。推測で広げない */
const CONFIRMED_INSURED = new Set(["92601"]);

const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** 保険者番号の検証数字 (modulus10 / 重み 2,1,2,1,2) */
function checkDigitOk(n) {
  if (!/^\d{6}$/.test(n)) return false;
  const d = n.split("").map(Number);
  let s = 0;
  for (let i = 0; i < 5; i++) { const p = d[i] * (i % 2 === 0 ? 2 : 1); s += p > 9 ? p - 9 : p; }
  return (10 - (s % 10)) % 10 === d[5];
}

async function main() {
  console.log(`=== 保険者番号 ${WRONG} → ${RIGHT} (取手市) ===`);
  console.log(EXECUTE ? "*** 本番実行 ***" : "*** DRY RUN (--execute で反映) ***");

  // 自分の前提を毎回検算する。ここが false になったら是正の根拠が崩れている
  if (!checkDigitOk(RIGHT)) {
    console.error(`✗ ${RIGHT} が検証数字を通らない。是正の根拠が崩れているので中止する`);
    process.exit(1);
  }
  console.log(`  ${RIGHT} は modulus10 の検証数字を通る ✅`);

  for (const table of ["clients", "client_insurance_records"]) {
    const { data, error } = await sb
      .from(table)
      .select("id, insurer_number, insured_number")
      .eq("insurer_number", WRONG);
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    console.log(`\n── ${table}: ${WRONG} を持つ ${(data ?? []).length} 行`);

    const plan = [], skipped = [];
    for (const r of data ?? []) {
      let who = r.id;
      if (table === "clients") who = r.id;
      else {
        const { data: cl } = await sb.from("clients").select("name").eq("id", r.client_id ?? "").maybeSingle();
        who = cl?.name ?? r.id;
      }
      const line = `${who} 被保番${r.insured_number}`;
      if (!CONFIRMED_INSURED.has((r.insured_number ?? "").trim())) { skipped.push(line + " — CSV で確認できていない"); continue; }
      plan.push({ id: r.id, line });
    }
    if (table === "clients") {
      for (const p of plan) {
        const { data: cl } = await sb.from("clients").select("name, birth_date, address").eq("id", p.id).maybeSingle();
        console.log(`   直す: ${cl?.name} [${cl?.birth_date}] ${cl?.address}`);
      }
    } else plan.forEach((p) => console.log(`   直す: ${p.line}`));
    skipped.forEach((s) => console.log(`   直さない: ${s}`));

    if (EXECUTE) {
      let ok = 0, ng = 0;
      for (const p of plan) {
        const { error: e } = await sb.from(table).update({ insurer_number: RIGHT }).eq("id", p.id);
        if (e) { ng++; console.error(`   ✗ ${p.line}: ${e.message}`); continue; }
        ok++;
      }
      console.log(`   反映 ${ok} 行 / 失敗 ${ng} 行`);
      if (ng) process.exitCode = 1;
    }
  }

  if (!EXECUTE) {
    console.log("\nDRY RUN。--execute で反映する。");
    console.log("  ⚠ 実行前に backup:");
    console.log(`     CREATE TABLE _backup_clients_82172_20260903 AS SELECT * FROM clients WHERE insurer_number = '${WRONG}';`);
    console.log("  ⚠ 被保険者番号 92601 (5 桁) は**直さない**。根拠が取れないため。");
    console.log("     ほのぼの 利用者管理 → 介護保険タブ で実物を確認すること。");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
