// ============================================================================
// 訪問介護事業所の地域区分(級地)・単価を正しい値に修正
// ============================================================================
// 2026-07-08。おゆみ野以外ほぼ全事業所が area_category='その他'/unit_price=10.00 に
// なっていた (=介護請求が過小)。厚労省 令和6〜8年度の地域区分 (千葉県) に基づき、
// 各事業所の所在市町村の級地・単価 (人件費割合70% = 訪問介護) に修正する。
//
//   node migrations/fix_office_area_price.mjs            # DRY RUN
//   node migrations/fix_office_area_price.mjs --execute  # 本番 (要 .env.local)
//
// 出典: 厚労省 地域区分 令和6〜8年度 / ほのぼの総合事業サービス費適用で
//       千葉市=11.05(3級地)・木更津=10.42(6級地) を実画面で確認済み。
// ============================================================================
import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const SB_URL = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)[1].trim();
const SB_KEY = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)[1].trim();
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const EXECUTE = process.argv.includes("--execute");

// 級地 → 単価 (人件費割合70% = 訪問介護・居宅介護支援)。office-content.tsx の p70 と一致
const PRICE = {
  "1級地": 11.40, "2級地": 11.12, "3級地": 11.05, "4級地": 10.84,
  "5級地": 10.70, "6級地": 10.42, "7級地": 10.21, "その他": 10.00,
};

// 事業所名 → 級地 (所在市町村。ユーザー確認済み 2026-07-08)
const OFFICE_AREA = {
  "Ｈａｎａヘルパーステーションおゆみ野": "3級地",      // 千葉市
  "Ｈａｎａヘルパーステーションさつきが丘": "3級地",    // 千葉市
  "Ｈａｎａヘルパーステーション中央": "3級地",          // 千葉市
  "Ｈａｎａヘルパーステーション花見川": "3級地",        // 千葉市
  "Ｈａｎａヘルパーステーション高品": "3級地",          // 千葉市
  "Ｈａｎａ船橋ヘルパーステーション": "4級地",          // 船橋市
  "Ｈａｎａヘルパーステーション四街道": "5級地",        // 四街道市
  "Ｈａｎａ八千代ヘルパーステーション": "5級地",        // 八千代市
  "ＫＴやわたヘルパーステーション": "5級地",            // 市川市
  "ＫＴ五井ヘルパーステーション": "5級地",              // 市原市
  "ＫＴ姉崎ヘルパーステーション": "5級地",              // 市原市
  "ケイ・ティ・グループヘルパーステーションＨａｎａちはら台": "5級地", // 市原市
  "ムツミヘルパーステーション": "5級地",                // 市原市
  "市原ムツミヘルパーステーション": "5級地",            // 市原市
  "袖ヶ浦ムツミヘルパーステーション": "5級地",          // 袖ケ浦市
  "木更津ムツミヘルパーステーション": "6級地",          // 木更津市
  "リンクスヘルパーステーション": "6級地",              // 茂原市
  "リンクスヘルパーステーション東郷": "6級地",          // 茂原市
  "君津ムツミヘルパーステーション": "7級地",            // 君津市
  "リンクスヘルパーステーション大網白里": "7級地",      // 大網白里市
  "リンクスヘルパーステーション山武": "7級地",          // 山武市
  "リンクスヘルパーステーションいすみ": "その他",       // いすみ市
};

async function main() {
  const res = await fetch(
    `${SB_URL}/rest/v1/offices?service_type=eq.${encodeURIComponent("訪問介護")}&select=id,name,area_category,unit_price`,
    { headers: H },
  );
  if (!res.ok) throw new Error(`offices取得失敗: ${res.status} ${await res.text()}`);
  const offices = await res.json();

  const changes = [];
  const unmapped = [];
  for (const o of offices) {
    const area = OFFICE_AREA[o.name];
    if (!area) { unmapped.push(o.name); continue; }
    const price = PRICE[area];
    const cur = Number(o.unit_price);
    if (o.area_category === area && Math.abs(cur - price) < 0.001) continue; // 変更不要
    changes.push({ id: o.id, name: o.name, fromArea: o.area_category, fromPrice: cur, toArea: area, toPrice: price });
  }

  console.log(`=== 事業所 単価修正 (${EXECUTE ? "本番実行" : "DRY RUN"}) ===`);
  console.log(`対象 訪問介護事業所: ${offices.length} / 変更あり: ${changes.length}`);
  for (const c of changes) {
    console.log(`  ${c.name}`);
    console.log(`     ${c.fromArea ?? "(空)"}/${c.fromPrice} → ${c.toArea}/${c.toPrice}`);
  }
  if (unmapped.length) console.log(`⚠ マッピング外 (スキップ): ${unmapped.join(", ")}`);

  if (!EXECUTE) {
    console.log("\n本番実行は --execute を付けてください。");
    return;
  }

  // バックアップ (変更前の値)
  const backup = changes.map((c) => ({ id: c.id, name: c.name, area_category: c.fromArea, unit_price: c.fromPrice }));
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const backupPath = new URL(`./_backup_office_area_${stamp}.json`, import.meta.url);
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nバックアップ: ${backupPath.pathname}`);

  let ok = 0;
  for (const c of changes) {
    const r = await fetch(`${SB_URL}/rest/v1/offices?id=eq.${c.id}`, {
      method: "PATCH",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({ area_category: c.toArea, unit_price: c.toPrice }),
    });
    if (!r.ok) { console.error(`  更新失敗 ${c.name}: ${r.status} ${await r.text()}`); continue; }
    ok++;
  }
  console.log(`更新完了: ${ok}/${changes.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
