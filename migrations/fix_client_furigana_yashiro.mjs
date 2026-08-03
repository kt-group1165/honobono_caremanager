// 利用者ふりがなの誤りを是正: 矢代 勝夫 (受給者番号 1242601135)
//
//   現状: clients.furigana = "ヤシロマサオ"
//   正  : "ヤシロカツオ"
//
//   根拠: ①「勝夫」の読みは カツオ (マサオ は 正夫/雅夫 の読み)
//         ② ほのぼの KJ260701 の J121 明細書 項8 支給決定者氏名カナ = ｶﾂｵ
//   ほのぼの受給者PDFからの名前ベース取込時の誤りと思われる
//   ([[project_honobono_shougai_import]] の弱点)。
//
//   氏名カナは J121 明細書 項8 に出るので、誤ったままだと伝送内容が実態と異なる。
//
//   node migrations/fix_client_furigana_yashiro.mjs [--execute]
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

const BENEFICIARY = "1242601135";
const EXPECT_NAME = "矢代 勝夫";
const WRONG = "ヤシロマサオ";
const RIGHT = "ヤシロカツオ";

async function main() {
  console.log(`=== ふりがな是正 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data: cert, error: e0 } = await sb
    .from("shougai_certifications")
    .select("client_id")
    .eq("beneficiary_number", BENEFICIARY)
    .maybeSingle();
  if (e0) { console.error("受給者証の取得に失敗:", e0.message); process.exit(1); }
  if (!cert) { console.error(`受給者証 ${BENEFICIARY} が見つかりません`); process.exit(1); }

  const { data: cl, error: e1 } = await sb
    .from("clients")
    .select("id, name, furigana")
    .eq("id", cert.client_id)
    .maybeSingle();
  if (e1) { console.error("利用者の取得に失敗:", e1.message); process.exit(1); }
  if (!cl) { console.error("利用者が見つかりません"); process.exit(1); }

  console.log(`受給者 ${BENEFICIARY} → ${cl.name} (${cl.id})`);
  console.log(`  現在のふりがな: ${cl.furigana}`);
  console.log(`  是正後        : ${RIGHT}`);

  if (cl.name.replace(/[\s　]/g, "") !== EXPECT_NAME.replace(/[\s　]/g, "")) {
    console.error(`\n✗ 氏名が想定と違います (想定 ${EXPECT_NAME} / 実際 ${cl.name}) → 中止`);
    process.exit(1);
  }
  if (cl.furigana === RIGHT) { console.log("\n既に是正済み → 何もしません"); return; }
  if (cl.furigana !== WRONG) {
    console.error(`\n✗ ふりがなが想定の誤り値 (${WRONG}) と違います → 中止 (手で確認してください)`);
    process.exit(1);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で UPDATE します。"); return; }

  const { error } = await sb.from("clients").update({ furigana: RIGHT }).eq("id", cl.id);
  if (error) { console.error("UPDATE 失敗:", error.message); process.exit(1); }

  const { data: after } = await sb.from("clients").select("furigana").eq("id", cl.id).maybeSingle();
  console.log(`\n✓ 完了: ふりがな = ${after?.furigana}`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
