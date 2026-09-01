// ============================================================================
// 居宅介護支援事業所の **介護支援専門員 常勤換算数** (offices.caremane_jokin_kansan)
// を設定する。逓減制 (居宅介護支援費 ⅰ/ⅱ/ⅲ) の判定に要る:
//
//   取扱件数 = (要介護の給付管理数 + 要支援 × 1/3) ÷ 常勤換算数
//     ⅰ 45件未満 / ⅱ 45〜59 / ⅲ 60以上
//     緩和要件 (ケアプランデータ連携 + 事務職員配置) なら ⅰ は 50件未満まで
//
//   未設定だとアプリは判定できず ⅰ 固定にフォールバックする (警告のみ)。
//   59 事業所すべて未設定だったので、まず **全員を常勤 (1.0)** として入れる。
//
// ── 人数の数え方 ──────────────────────────────────────────────────────
//   サービス実績データ/全居宅/<月>/…/全居宅事業所別請求額.CSV の
//   「介護支援専門員名」を事業所ごとに一意カウントする。
//   ⚠ これは **その月に担当を持っていたケアマネ** の数。担当ゼロの管理者や
//     新人は入らないので下限値。実際の常勤換算数が分かったら上書きすること。
//
//   node migrations/set_kyotaku_caremane_fte.mjs            # DRY RUN
//   node migrations/set_kyotaku_caremane_fte.mjs --execute
//   env: MONTH=202606
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const YM = process.env.MONTH || "202606";
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

const splitCsv = (line) => {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};

/** 報告書フォルダの通称ではなく CSV の事業所名 → offices.name の対応 */
const OFFICE_BY_CSV = {
  "ｹｱﾌﾟﾗﾝHana船橋": "ケアプランＨａｎａ船橋",
  "ケアプランＨａｎａ八千代": "ケアプランＨａｎａ八千代",
  "㈱ケイ・ティ・サービス　ケアプランHana": "ケアプランＨａｎａ",
  "Ｈａｎａ居宅支援センター四街道": "Ｈａｎａ居宅支援センター四街道",
  "Hana居宅支援センター高品": "Ｈａｎａ居宅支援センター高品",
  "Hana居宅支援ｾﾝﾀｰおゆみ野": "Ｈａｎａ居宅支援センターおゆみ野",
  "＊ケイ・ティ・グループ居宅支援センターちはら台": "ケイ・ティ・グループ居宅支援センターちはら台",
  "*ｹｲ・ﾃｨ・ｻｰﾋﾞｽ居宅介護支援事業所": "ケイ・ティ・サービス居宅介護支援事業所",
  "KT在宅ｻﾎﾟｰﾄｾﾝﾀｰ": "ＫＴ在宅サポートセンター",
  "株式会社ｻｰﾋﾞｽﾜﾝ　ﾑﾂﾐ居宅介護支援事業所": "ムツミ居宅介護支援事業所",
  "ＫＴ袖ヶ浦ムツミ居宅支援センター": "袖ヶ浦ムツミ居宅支援センター",
  "木更津ムツミ居宅支援センター　ｋ": "木更津ムツミ居宅支援センター",
  "リンクス居宅介護支援事業所大網白里": "リンクス居宅介護支援事業所大網白里",
  "リンクス居宅介護支援事業所": "リンクス居宅介護支援事業所",
  "リンクス居宅介護支援事業所いすみ": "リンクス居宅介護支援事業所いすみ",
};

async function main() {
  console.log(`=== 居宅 ケアマネ常勤換算数の設定 ${YM} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===`);
  console.log(`  方針: その月に担当を持っていたケアマネを **全員常勤 (1.0)** として数える\n`);

  const csv = path.join(KAIGO, "サービス実績データ/全居宅", YM, "訪問介護/介護/全居宅事業所別請求額.CSV");
  if (!existsSync(csv)) { console.error(`✗ ${csv} がありません`); process.exit(1); }
  const lines = iconv.decode(readFileSync(csv), "Shift_JIS").split(/\r?\n/);
  const head = splitCsv(lines[0]).map((s) => s.trim());
  const iOff = head.indexOf("事業所名（支援事業所）");
  const iCm = head.indexOf("介護支援専門員名");
  const iIns = head.indexOf("被保険者番号");
  if (iOff < 0 || iCm < 0 || iIns < 0) { console.error("✗ 想定の列が無い"); process.exit(1); }

  const cms = new Map();      // CSV事業所名 → Set(ケアマネ名)
  const users = new Map();    // CSV事業所名 → Set(被保番)
  for (const line of lines.slice(1)) {
    const c = splitCsv(line).map((s) => s.trim());
    if (c.length <= Math.max(iOff, iCm, iIns)) continue;
    const o = c[iOff];
    if (!o) continue;
    if (!cms.has(o)) { cms.set(o, new Set()); users.set(o, new Set()); }
    if (c[iCm]) cms.get(o).add(c[iCm]);
    if (c[iIns]) users.get(o).add(c[iIns]);
  }

  const { data: offices, error } = await sb.from("offices")
    .select("id, name, caremane_jokin_kansan, teigen_kanwa_from").eq("service_type", "居宅介護支援");
  if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
  const byName = new Map((offices ?? []).map((o) => [o.name, o]));

  const plans = [], skipped = [];
  for (const [csvName, set] of cms) {
    const wanted = OFFICE_BY_CSV[csvName];
    const off = wanted ? byName.get(wanted) : null;
    if (!off) { skipped.push(`${csvName}: offices に対応が無い (OFFICE_BY_CSV に足す)`); continue; }
    const fte = set.size;
    const count = users.get(csvName).size;
    const perCm = count / fte;
    // 緩和なし: ⅰ<45 / ⅱ45-59 / ⅲ60-   緩和あり: ⅰ<50 / ⅱ50-59 / ⅲ60-
    const tier = (kanwa) => (perCm >= 60 ? "ⅲ" : perCm >= (kanwa ? 50 : 45) ? "ⅱ" : "ⅰ");
    plans.push({ off, csvName, fte, count, perCm, names: [...set], tier });
  }

  console.log(`  ${"事業所".padEnd(30)}${"CM".padStart(4)}${"件数".padStart(6)}${"件/人".padStart(8)}   緩和なし → 緩和あり`);
  for (const p of plans.sort((a, b) => b.perCm - a.perCm)) {
    const t0 = p.tier(false), t1 = p.tier(true);
    const mark = t0 !== "ⅰ" ? (t1 === "ⅰ" ? "  ★ 緩和要件しだい" : "  ★ 逓減あり") : "";
    console.log(`  ${p.off.name.padEnd(30)}${String(p.fte).padStart(4)}${String(p.count).padStart(6)}` +
      `${p.perCm.toFixed(1).padStart(8)}   ${t0} → ${t1}${mark}`);
  }
  if (skipped.length) {
    console.log(`\n  -- 対応が取れなかったもの ${skipped.length} 件 --`);
    for (const s of skipped) console.log(`     ${s}`);
  }
  const already = plans.filter((p) => p.off.caremane_jokin_kansan != null);
  if (already.length) console.log(`\n  ⚠ 既に値が入っている ${already.length} 件は上書きします`);
  console.log(`\n  設定対象 ${plans.length} 事業所`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }
  for (const p of plans) {
    const { error: e2 } = await sb.from("offices")
      .update({ caremane_jokin_kansan: p.fte }).eq("id", p.off.id);
    if (e2) { console.error(`✗ ${p.off.name}: ${e2.message}`); process.exit(1); }
    console.log(`  ✓ ${p.off.name}  常勤換算 ${p.fte}`);
  }
  console.log(`\n✓ ${plans.length} 事業所に設定しました`);
  console.log("  ※ 緩和要件 (teigen_kanwa_from) は事実確認が要るので触っていません");
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
