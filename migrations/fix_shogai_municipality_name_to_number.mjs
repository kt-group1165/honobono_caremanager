// ============================================================================
// 障害の受給者証で、市町村番号の列に **市町村名** が入っているものを番号に直す。
//
//   node migrations/fix_shogai_municipality_name_to_number.mjs            # DRY RUN
//   node migrations/fix_shogai_municipality_name_to_number.mjs --execute
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   shougai_certifications.insurer_municipality は **番号を入れる列**なのに
//   「習志野市」「成田市」のように名前が入っている行が 5 件あった
//   (2026-08-31 に npm run check:densou で検出)。このままだと伝送が壊れる。
//
// ── 番号の決め方 (推測していない) ──────────────────────────────────────
//   市町村番号 = [JIS の市区町村コード 5 桁][modulus10 の検証数字 1 桁]
//
//   JIS コードは **2 つの独立した materials** が一致することを確認して決めた。
//     ① ほのぼの 利用者マスタ由来の 保険者番号マスタ (介護保険)
//        習志野市=122168 / 成田市=122119 / 印西市=122317 / 横芝光町=124107
//     ② **受給者証番号の先頭 5 桁**
//        渡邊 1221612219 → 12216 (習志野市) / 服部 1221609074 → 12216
//        鈴木 1221113051 → 12211 (成田市)   / 久保田 1223127059 → 12231 (印西市)
//
//   ⚠ ①②が一致しない人・②が取れない人は **書き換えない**。
//     土屋 裕代 (横芝光町) は受給者証番号が 0000181030 で先頭に番号が入らない書式
//     なので、①だけになる。受給者証の実物で確認するまで対象にしない。
//
//   ⚠ 介護保険の保険者番号と障害の市町村番号は **別物**。区のある政令市では
//     介護=区ごと (千葉市中央区 121012) / 障害=市ごと (千葉市 121004) で違う。
//     ここで扱うのは区の無い市町なので同じ JIS になるが、
//     **政令市の行は絶対に自動で入れないこと** (feedback_shogai_shichoson_number)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** 市町村名 → JIS 5 桁。**区の無い市町だけ**をここに書く (政令市は入れない) */
const NAME_TO_JIS = {
  習志野市: "12216",
  成田市: "12211",
  印西市: "12231",
};

/** JIS 5 桁 → 検証数字 (modulus10 / 重み 2,1,2,1,2 / 積が 2 桁なら桁を足す) */
function checkDigit(five) {
  const w = [2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 5; i++) {
    let v = Number(five[i]) * w[i];
    if (v > 9) v = Math.floor(v / 10) + (v % 10);
    sum += v;
  }
  const r = 10 - (sum % 10);
  return r === 10 ? 0 : r;
}

async function main() {
  console.log("=== 障害の市町村番号: 名前が入っている行を番号に直す ===");
  console.log(EXECUTE ? "*** 本番実行 ***" : "*** DRY RUN (--execute で反映) ***");

  const { data: rows, error } = await sb
    .from("shougai_certifications")
    .select("id, client_id, insurer_municipality, beneficiary_number");
  if (error) { console.error(error.message); process.exit(1); }

  const targets = (rows ?? []).filter((r) => {
    const v = (r.insurer_municipality ?? "").trim();
    return v && !/^\d{6}$/.test(v);
  });
  console.log(`市町村番号の列が番号でない行: ${targets.length} 件`);

  const plan = [], skipped = [];
  for (const r of targets) {
    const name = (r.insurer_municipality ?? "").trim();
    const { data: cl } = await sb.from("clients").select("name").eq("id", r.client_id).maybeSingle();
    const who = cl?.name ?? "?";

    const jisFromName = NAME_TO_JIS[name];
    const ben = (r.beneficiary_number ?? "").trim();
    const jisFromBeneficiary = /^\d{10}$/.test(ben) ? ben.slice(0, 5) : null;

    if (!jisFromName) {
      skipped.push(`${who} 「${name}」 — 対応表に無い (区のある政令市は自動で入れない)`);
      continue;
    }
    if (!jisFromBeneficiary) {
      skipped.push(`${who} 「${name}」 — 受給者証番号 ${ben || "なし"} から JIS が読めず裏が取れない`);
      continue;
    }
    if (jisFromBeneficiary !== jisFromName) {
      skipped.push(`${who} 「${name}」 — 名前から ${jisFromName} / 受給者証から ${jisFromBeneficiary} で食い違う`);
      continue;
    }
    const num = jisFromName + String(checkDigit(jisFromName));
    plan.push({ id: r.id, who, name, num, ben });
  }

  console.log("");
  console.log(`直す ${plan.length} 件:`);
  plan.forEach((p) => console.log(`   ${p.who.padEnd(12)} 「${p.name}」→ ${p.num}   (受給者証 ${p.ben} の先頭5桁と一致)`));
  if (skipped.length) {
    console.log(`${String.fromCharCode(10)}裏が取れないので直さない ${skipped.length} 件 — 受給者証の実物で確認すること:`);
    skipped.forEach((s) => console.log("   " + s));
  }

  if (!EXECUTE) { console.log("\nDRY RUN。--execute で反映する。"); return; }

  let ok = 0, ng = 0;
  for (const p of plan) {
    const { error: e } = await sb
      .from("shougai_certifications")
      .update({ insurer_municipality: p.num })
      .eq("id", p.id);
    if (e) { ng++; console.error(`  ✗ ${p.who}: ${e.message}`); continue; }
    ok++;
  }
  console.log(`\n反映 ${ok} 件 / 失敗 ${ng} 件`);
  if (ng) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
