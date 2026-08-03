// ケアプランＨａｎａ船橋 に居宅介護支援の処遇改善加算を設定する。
//
// 背景 (2026-08-03 判明):
//   2026-06 の実伝送を全事業所で照合したところ、**船橋だけ 436191 (処遇改善加算) が
//   0 件**だった。他 14 事業所はすべて 21.0〜21.6‰ で算定済み。
//
//     事業所      総単位    処遇改善単位   率
//     他14事業所   —        あり          21.0〜21.6‰
//     船橋        398,847   0            0.0‰
//
//   影響額: 398,847 × 21.2‰ × 10.839 円 ≒ 月 91,492 円 (年間 約110万円)。
//   ⚠ **ほのぼの側で付け忘れていた** = 実請求の漏れであって新システムのバグではない
//   (2026-08-03 利用者確認済。船橋の体制届自体は出ている前提)。
//
// この修正の意味:
//   新システムは「正しい請求」を出すべきなので設定を入れる。結果として
//   **船橋の明細書 (8124) はほのぼの 2026-06 分と一致しなくなる** — それが正しい状態。
//   照合で船橋だけ差が出ても回帰ではないので注意 (差 = 処遇改善加算 1 行 / 利用者)。
//
//   node migrations/fix_funabashi_shoguu_kaizen.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const OFFICE_ID = "255681a4-baf2-4daa-b489-1ea87e082670"; // ケアプランＨａｎａ船橋
const OFFICE_NAME = "ケアプランＨａｎａ船橋";
const CODE = "436191";
const PERMIL = 21;

async function main() {
  console.log(`=== 船橋 処遇改善加算 設定 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 1) 対象事業所
  const { data: off, error: e0 } = await sb
    .from("offices")
    .select("id, name, service_type, care_support_shoguu_code, care_support_shoguu_permil")
    .eq("id", OFFICE_ID)
    .maybeSingle();
  if (e0) { console.error("事業所の取得に失敗:", e0.message); process.exit(1); }
  if (!off) { console.error("事業所が見つかりません"); process.exit(1); }
  if (off.name !== OFFICE_NAME) {
    console.error(`✗ 事業所名が想定と違います (想定 ${OFFICE_NAME} / 実際 ${off.name}) → 中止`);
    process.exit(1);
  }

  // 2) 他の居宅介護支援事業所の設定を根拠として表示 (全社同一区分であることの確認)
  const { data: peers, error: e1 } = await sb
    .from("offices")
    .select("name, care_support_shoguu_code, care_support_shoguu_permil")
    .eq("service_type", "居宅介護支援")
    .neq("id", OFFICE_ID);
  if (e1) { console.error("他事業所の取得に失敗:", e1.message); process.exit(1); }

  const set = peers.filter((p) => p.care_support_shoguu_code);
  const codes = [...new Set(set.map((p) => p.care_support_shoguu_code))];
  const permils = [...new Set(set.map((p) => p.care_support_shoguu_permil))];
  console.log(`他の居宅介護支援事業所 ${set.length} 件の設定: code=${codes.join("/")} permil=${permils.join("/")}`);
  if (codes.length !== 1 || permils.length !== 1) {
    console.error("✗ 他事業所の設定が一様ではありません → 手で確認してください");
    process.exit(1);
  }
  if (codes[0] !== CODE || permils[0] !== PERMIL) {
    console.error(`✗ 他事業所の設定 (${codes[0]}/${permils[0]}) がこのスクリプトの想定 (${CODE}/${PERMIL}) と違います → 中止`);
    process.exit(1);
  }

  console.log(`\n${off.name}`);
  console.log(`  現在: code=${off.care_support_shoguu_code ?? "(未設定)"} permil=${off.care_support_shoguu_permil}`);
  console.log(`  設定: code=${CODE} permil=${PERMIL}`);

  if (off.care_support_shoguu_code === CODE && off.care_support_shoguu_permil === PERMIL) {
    console.log("\n既に設定済み → 何もしません");
    return;
  }

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で UPDATE します。");
    console.log("※ 適用後は船橋の明細書がほのぼの 2026-06 分と一致しなくなります (ほのぼの側の付け忘れのため)。");
    return;
  }

  const { error } = await sb
    .from("offices")
    .update({ care_support_shoguu_code: CODE, care_support_shoguu_permil: PERMIL })
    .eq("id", OFFICE_ID);
  if (error) { console.error("UPDATE 失敗:", error.message); process.exit(1); }

  const { data: after } = await sb
    .from("offices")
    .select("care_support_shoguu_code, care_support_shoguu_permil")
    .eq("id", OFFICE_ID)
    .maybeSingle();
  console.log(`\n✓ 完了: code=${after?.care_support_shoguu_code} permil=${after?.care_support_shoguu_permil}`);
  console.log("  → 以後 船橋の請求に処遇改善加算が乗ります (月 約91,000円)。");
  console.log("  → 2026-06 分をほのぼのと照合すると差が出ますが回帰ではありません。");
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
