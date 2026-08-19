// ============================================================================
// 狩野 佑佳 (茂原) の障害受給者証を ほのぼのの実物に合わせる。
//
// ── 実物 (ほのぼの 障がい福祉利用者管理システム 受給者証画面 2026-08-19 確認) ──
//   受給者証番号 1242313920 / 支給市町村 124230 長生村 / 障害支援区分 6
//   所得区分 低所得1 / 負担割合 10% / 利用者負担上限月額 0円 / 上限額管理事業所 なし
//   支給量 身体介護中心 20時間00分
//     ① R8/ 4/ 1 〜 R8/ 6/30  (交付 R8/4/1)   ← DB にあり
//     ② R8/ 7/ 1 〜 R9/ 3/31  (交付 R8/7/1)   ← DB に **無い** (7月請求で落ちる)
//   ほのぼの側に 1242311080 は **もう存在しない**。
//
// ── 直すこと ──────────────────────────────────────────────────────────
//   1) 古い 1242311080 (2026-07-17 身障PDF取込 / 非該当・上限4600・自事業所上限管理) を削除。
//      6月に有効な受給者証が 2 枚あり、集計が開始日の新しい方を採るため
//      伝送の受給者証番号がほのぼのと食い違っていた (茂原 J121/J611 各 -1)。
//   2) ② の 2026-07-01 〜 2027-03-31 を INSERT。
//   3) shogai_contracts (契約支給量) を新証のものに更新。
//      旧証の伝送から取り込んだ 2025-07-01〜2026-06-30 / 事業者記入欄 3 が残っており、
//      J121-05 レコードだけがズレていた。新証は 2026-04-01〜2027-03-31 / 記入欄 1
//      (ほのぼのの 8/10 再請求 KJ260803 および受給者証画面の事業者記入欄で確認)。
//
//   ⚠ ほのぼのの **6月伝送は古い番号 1242311080・上限4600円** で出ている。
//     実物が上限0円である以上、ほのぼの側の6月請求が過大。過誤申立の要否は業務判断。
//     (この script は当方 DB を実物に合わせるだけで、請求済みデータには触らない)
//
//   node migrations/fix_kano_yuka_shogai_cert.mjs            # DRY RUN
//   node migrations/fix_kano_yuka_shogai_cert.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

const CLIENT_ID = "b29d3c78-80fc-4bf0-a8b4-e7acb9937942"; // 狩野 佑佳
const STALE_ID = "c0125097-938b-46a9-bbdc-dcbadec45f54"; // 1242311080
const NEW_CERT = {
  tenant_id: "kt-group",
  client_id: CLIENT_ID,
  beneficiary_number: "1242313920",
  insurer_municipality: "124230",
  support_level: "区分6",
  certification_start_date: "2026-07-01",
  certification_end_date: "2027-03-31",
  issue_date: "2026-07-01",
  service_types: ["居宅介護"],
  copay_rate: 0.1,
  income_category: "低所得１",
  self_payment_limit: 0,
  jogen_kanri_kubun: "なし",
  // ⚠ キーは **ローマ字**。日本語キーだと画面も集計も読めない
  //   (migrations/_shikyuryo_keys.mjs / fix_shikyuryo_details_keys.mjs)
  shikyuryo_details: { shintai: { hours: 20, minutes: 0 } },
  monthly_allocations: {},
  notes:
    "[受給者証 実物突合 2026-08-19 茂原]\n事業種別: 身体障害者居宅介護【居宅介護】 長生村\n交付日: 2026-07-01 / 所得区分: 低所得１ / 上限月額: 0円\n支給量: 身体介護20時間00分",
};

/** 新証の契約支給量 (J121-05 レコードの元)。20時間00分 = 02000 */
const NEW_CONTRACT = {
  decision_code: "111000",
  amount_x100: 2000,
  amount_unit: "時間",
  entry_number: 1,
  start_date: "2026-04-01",
  end_date: "2027-03-31",
};

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

async function main() {
  console.log(`=== 狩野 佑佳 受給者証 是正 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data: before, error: e1 } = await sb
    .from("shougai_certifications")
    .select("*")
    .eq("client_id", CLIENT_ID)
    .order("certification_start_date");
  if (e1) { console.error(`✗ 取得失敗: ${e1.message}`); process.exit(1); }

  console.log("現在:");
  for (const r of before) {
    console.log(
      `  ${r.beneficiary_number} ${r.certification_start_date}〜${r.certification_end_date} ` +
      `${r.support_level} 上限${r.self_payment_limit} ${r.jogen_kanri_kubun}`,
    );
  }

  const { data: contracts, error: e3 } = await sb
    .from("shogai_contracts")
    .select("*")
    .eq("client_id", CLIENT_ID)
    .eq("decision_code", NEW_CONTRACT.decision_code);
  if (e3) { console.error(`✗ 契約取得失敗: ${e3.message}`); process.exit(1); }
  console.log("\n現在の契約支給量:");
  for (const c of contracts) {
    console.log(
      `  ${c.decision_code} ${c.amount_x100 / 100}${c.amount_unit} ` +
      `${c.start_date}〜${c.end_date} 記入欄${c.entry_number}`,
    );
  }
  const staleContract = contracts.find(
    (c) => c.start_date !== NEW_CONTRACT.start_date || c.entry_number !== NEW_CONTRACT.entry_number,
  );

  const stale = before.find((r) => r.id === STALE_ID);
  const dupJuly = before.find(
    (r) =>
      r.beneficiary_number === NEW_CERT.beneficiary_number &&
      r.certification_start_date === NEW_CERT.certification_start_date,
  );

  console.log("\n計画:");
  console.log(stale ? "  - 削除: 1242311080 (2025-07-01〜2026-06-30)" : "  - 削除: 対象なし (既に無い)");
  console.log(dupJuly ? "  - 追加: 既にあるためスキップ" : "  - 追加: 1242313920 (2026-07-01〜2027-03-31)");
  console.log(
    staleContract
      ? `  - 契約更新: ${staleContract.start_date}〜${staleContract.end_date} 記入欄${staleContract.entry_number}` +
        ` → ${NEW_CONTRACT.start_date}〜${NEW_CONTRACT.end_date} 記入欄${NEW_CONTRACT.entry_number}`
      : "  - 契約更新: 対象なし (既に新証の契約)",
  );

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で適用します。"); return; }

  // 削除前に必ずバックアップ (戻せるようにしてから消す)
  const backup = path.join(KAIGO, "migrations", `_backup_shougai_cert_kano_${Date.now()}.json`);
  writeFileSync(backup, JSON.stringify({ certs: before, contracts }, null, 2), "utf8");
  console.log(`\nバックアップ: ${backup}`);

  if (stale) {
    const { error } = await sb.from("shougai_certifications").delete().eq("id", STALE_ID);
    if (error) { console.error(`✗ 削除失敗: ${error.message}`); process.exit(1); }
    console.log("✓ 1242311080 を削除");
  }
  if (!dupJuly) {
    const { error } = await sb.from("shougai_certifications").insert(NEW_CERT);
    if (error) { console.error(`✗ 追加失敗: ${error.message}`); process.exit(1); }
    console.log("✓ 2026-07-01〜2027-03-31 を追加");
  }
  if (staleContract) {
    const { error } = await sb
      .from("shogai_contracts")
      .update({
        ...NEW_CONTRACT,
        notes: "[受給者証 実物突合 2026-08-19 茂原] 18歳到達に伴う新証の契約に更新",
      })
      .eq("id", staleContract.id);
    if (error) { console.error(`✗ 契約更新失敗: ${error.message}`); process.exit(1); }
    console.log("✓ 契約支給量を 2026-04-01〜2027-03-31 / 記入欄1 に更新");
  }

  const { data: after, error: e2 } = await sb
    .from("shougai_certifications")
    .select("beneficiary_number, certification_start_date, certification_end_date, support_level, self_payment_limit, jogen_kanri_kubun")
    .eq("client_id", CLIENT_ID)
    .order("certification_start_date");
  if (e2) { console.error(`✗ 確認失敗: ${e2.message}`); process.exit(1); }
  console.log("\n結果:");
  for (const r of after) {
    console.log(
      `  ${r.beneficiary_number} ${r.certification_start_date}〜${r.certification_end_date} ` +
      `${r.support_level} 上限${r.self_payment_limit} ${r.jogen_kanri_kubun}`,
    );
  }
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
