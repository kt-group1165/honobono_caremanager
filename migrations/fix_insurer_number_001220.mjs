// ============================================================================
// 保険者番号 "001220" を 木更津市の正しい番号 "122069" に直す。
//
//   node migrations/fix_insurer_number_001220.mjs            # DRY RUN
//   node migrations/fix_insurer_number_001220.mjs --execute
//
// ── 何が起きていたか ────────────────────────────────────────────────────
//   当方の認定 3 件が保険者番号 "001220" を持っていた。001220 は
//   modulus10 の検証数字を通らず、先頭 5 桁 "00122" は都道府県コードとして
//   存在しない = **保険者番号として成立していない**。
//   この値は 8/10 送信の伝送 (KK260803) から取り込んだもの。
//
// ── ほのぼのを実際に見て確認した (2026-09-01 / リモート) ────────────────
//   ほのぼの NEXT 利用者管理 → 介護保険タブ で 3 名とも **122069 木更津市**。
//
//     鈴木 幸枝(茅野) 0000020147  保険者番号 122069  交付 R8/ 6/12  要介護2
//     日野 義治       0000041528  保険者番号 122069                 要介護1
//     岩堀 満         0000055002  保険者番号 122069  交付 R8/ 7/17  要介護4
//
//   つまり **ほのぼののマスタは正しく、当方だけが古い伝送の値のまま**。
//
// ── 触る範囲 ────────────────────────────────────────────────────────────
//   client_insurance_records.insurer_number が "001220" の行のみ。
//   被保険者番号・認定期間・要介護度には触らない。
//
// ⚠ 8/10 送信ぶん (2026-07 提供) が国保連で返戻になっていないかは **人が確認**する。
//   ここで直すのは当方のマスタだけで、提出済みの請求は直らない。
//
// ⚠ 伝送 KK を取り込み直すと 001220 に戻る可能性がある。戻っていないか
//   `MONTH=2026-06 npm run check:densou` で見張ること。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const WRONG = "001220";
const RIGHT = "122069";           // 木更津市 (JIS 12206 + modulus10 の検証数字 9)

const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** ほのぼので実際に確認した被保険者番号。ここに無いものは直さない */
const CONFIRMED = new Set(["0000020147", "0000041528", "0000055002"]);

async function main() {
  console.log(`=== 保険者番号 ${WRONG} → ${RIGHT} (木更津市) ===`);
  console.log(EXECUTE ? "*** 本番実行 ***" : "*** DRY RUN (--execute で反映) ***");

  const { data: rows, error } = await sb
    .from("client_insurance_records")
    .select("id, client_id, insurer_number, insured_number, insurer_name, certification_start_date")
    .eq("insurer_number", WRONG);
  if (error) { console.error(error.message); process.exit(1); }

  const plan = [], skipped = [];
  for (const r of rows ?? []) {
    const { data: cl } = await sb.from("clients").select("name").eq("id", r.client_id).maybeSingle();
    const who = cl?.name ?? "?";
    const line = `${who} 被保番${r.insured_number} 開始${r.certification_start_date}`;
    // ほのぼので実物を見て確認した人だけ直す。推測で広げない
    if (!CONFIRMED.has((r.insured_number ?? "").trim())) { skipped.push(line + " — 未確認"); continue; }
    plan.push({ id: r.id, line });
  }

  console.log(`\n${WRONG} を持つ認定 ${(rows ?? []).length} 件 / 直す ${plan.length} 件`);
  plan.forEach((p) => console.log("   " + p.line));
  if (skipped.length) {
    console.log(`  ほのぼので確認していないので直さない ${skipped.length} 件:`);
    skipped.forEach((s) => console.log("     " + s));
  }
  if (!plan.length) { console.log("対象なし"); return; }

  if (!EXECUTE) { console.log("\nDRY RUN。--execute で反映する。"); return; }

  let ok = 0, ng = 0;
  for (const p of plan) {
    const { error: e } = await sb
      .from("client_insurance_records")
      .update({ insurer_number: RIGHT, insurer_name: "木更津市" })
      .eq("id", p.id);
    if (e) { ng++; console.error(`  ✗ ${p.line}: ${e.message}`); continue; }
    ok++;
  }
  console.log(`\n反映 ${ok} 件 / 失敗 ${ng} 件`);
  if (ng) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
