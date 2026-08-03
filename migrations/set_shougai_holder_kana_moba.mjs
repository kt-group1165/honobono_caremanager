// 障害児2名に「支給決定者(保護者)氏名カナ」を設定する (茂原)。
//
//   J121 明細書 基本情報は 項8 支給決定者氏名カナ / 項9 支給決定児童氏名カナ。
//   成人は 項8=本人・項9=空 だが **障害児は 項8=保護者・項9=児童**。
//   ほのぼの KJ260701 (茂原 2026-06) の実値:
//     狩野 1242311080 (H20/3/26生 = 障害児): 項8 ｶﾉﾖｼﾕｷ / 項9 ｶﾉﾕｳｶ
//     鈴木 1242241337 (H29/9/27生 = 障害児): 項8 ｽｽﾞｷﾏﾘ / 項9 ｽｽﾞｷｱｵｲ
//   保護者名は受給者証の記載事項で新システム側に元データが無いため、
//   ここで受給者証 (shougai_certifications.holder_name_kana) に投入する。
//   以後は受給者証ページで入力できる。
//
//   ⚠ 全角カナで保存する (伝送側で半角化する。densou-kana.ts)。
//
//   node migrations/set_shougai_holder_kana_moba.mjs [--execute]
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

// 受給者番号 → { 本人名(確認用), 保護者カナ }
const TARGETS = [
  { bn: "1242311080", name: "狩野 佑佳", holder: "カノヨシユキ" },
  { bn: "1242241337", name: "鈴木 葵", holder: "スズキマリ" },
];

async function main() {
  console.log(`=== 障害児 保護者カナ 投入 (茂原) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { error: probe } = await sb.from("shougai_certifications").select("holder_name_kana").limit(1);
  if (probe) {
    console.error("✗ holder_name_kana 列がありません → migrations/shougai_cert_holder_kana.sql を先に適用してください");
    process.exit(1);
  }

  const plan = [];
  for (const t of TARGETS) {
    const { data: cert, error } = await sb
      .from("shougai_certifications")
      .select("id, client_id, holder_name_kana, certification_start_date, certification_end_date")
      .eq("beneficiary_number", t.bn)
      .maybeSingle();
    if (error) { console.error(`受給者証 ${t.bn} の取得に失敗:`, error.message); process.exit(1); }
    if (!cert) { console.error(`✗ 受給者証 ${t.bn} が見つかりません → 中止`); process.exit(1); }

    const { data: cl } = await sb
      .from("clients")
      .select("name, furigana, birth_date")
      .eq("id", cert.client_id)
      .maybeSingle();
    if (!cl) { console.error(`✗ 利用者が見つかりません (${t.bn}) → 中止`); process.exit(1); }

    // 本人名が想定と違う = 受給者証の紐付けがずれている可能性 → 中止
    if (cl.name.replace(/[\s　]/g, "") !== t.name.replace(/[\s　]/g, "")) {
      console.error(`✗ ${t.bn} の氏名が想定と違います (想定 ${t.name} / 実際 ${cl.name}) → 中止`);
      process.exit(1);
    }
    // 障害児であることの裏取り。
    //   判定は **受給者証の開始日時点で18歳未満か** で行う。支給決定者 (保護者) は
    //   受給者証の記載事項なので、有効期間の途中で18歳になっても その証の間は保護者のまま
    //   (狩野: 証 2025-07-01〜2026-06-30 / 18歳到達 2026-03-25 → 2026-06 分も保護者名義)。
    //   提供月時点の年齢で判定すると この境界ケースを取りこぼす。
    const bd = cl.birth_date ? new Date(cl.birth_date) : null;
    const age18 = bd ? new Date(bd.getFullYear() + 18, bd.getMonth(), bd.getDate()) : null;
    const certStart = new Date(cert.certification_start_date);
    const minorAtStart = age18 ? certStart < age18 : null;
    console.log(`${t.bn} ${cl.name} (${cl.furigana}) 生 ${cl.birth_date}`);
    console.log(`  受給者証 ${cert.certification_start_date}〜${cert.certification_end_date} / 18歳到達 ${age18 ? age18.toISOString().slice(0, 10) : "?"}`);
    console.log(`  → 証開始時点: ${minorAtStart === null ? "生年月日不明" : minorAtStart ? "17歳以下 (障害児)" : "18歳以上"}`);
    console.log(`  現在の保護者カナ: ${cert.holder_name_kana ?? "(未設定)"}`);
    console.log(`  設定             : ${t.holder}`);
    if (minorAtStart === false) {
      console.error(`  ✗ 受給者証の開始時点で18歳以上です。障害児ではない可能性 → 中止`);
      process.exit(1);
    }
    if (cert.holder_name_kana === t.holder) { console.log("  → 既に設定済み (スキップ)\n"); continue; }
    plan.push({ id: cert.id, bn: t.bn, holder: t.holder });
    console.log("");
  }

  if (plan.length === 0) { console.log("更新対象なし。"); return; }
  if (!EXECUTE) { console.log(`※ DRY RUN。--execute で ${plan.length} 件 UPDATE します。`); return; }

  for (const p of plan) {
    const { error } = await sb
      .from("shougai_certifications")
      .update({ holder_name_kana: p.holder })
      .eq("id", p.id);
    if (error) { console.error(`UPDATE 失敗 (${p.bn}):`, error.message); process.exit(1); }
    console.log(`  ✓ ${p.bn} → ${p.holder}`);
  }
  console.log(`\n完了: ${plan.length} 件`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
