// ============================================================================
// 高品マスタ取込が別人に付けた 認定 と 事業所割当 を剥がす
//
// ── 何をやってしまったか ──────────────────────────────────────────────
//   `import_kyotaku_clients_from_user_master.mjs` の初版が **利用者番号だけで
//   既存 client を引いていた**。ほのぼのは利用者番号を使い回すので、
//   短い番号 (11 / 674) が当方では別人に付いていた。
//
//     利用者番号 11   ほのぼの=飯塚 光子   当方=御園 政司
//     利用者番号 674  ほのぼの=児嶌 巴     当方=荻野 由紀子
//
//   結果、**ほのぼの側の人の認定を、当方の別人にコピーした**。
//   さらに高品への client_office_assignments も別人に付いた。
//   (2026-08-31 11:18:51 の 1 バッチ)
//
// ── どちらが正しいか ──────────────────────────────────────────────────
//   保険者番号と住所が一致する側が正しい。
//
//     121012 = 千葉市中央区   飯塚 光子   千葉市中央区椿森      ✓
//                             御園 政司   長生郡白子町          ✗ (本来 124248)
//     122069 = 木更津市       児嶌 巴     木更津市菅生          ✓
//                             荻野 由紀子 袖ケ浦市              ✗ (本来 122291)
//
//   ✓ レセプトは両者とも **正しい被保番**で立っている
//     (御園=124248|0000036632 / 荻野=122291|2290117635)。金額の実害は無い。
//
// ── 直す範囲 ──────────────────────────────────────────────────────────
//   誤って付いた側から
//     1. その (保険者, 被保番) の認定だけを削除   ← 本人の認定は残す
//     2. 高品への client_office_assignments を削除
//   正しい側 (飯塚 光子 / 児嶌 巴) には一切触らない。
//
// ⚠ 削除を含む。必ず DRY RUN で件数と対象を見てから --execute すること。
//
//   node migrations/fix_takashina_import_wrong_owner.mjs            # DRY RUN
//   node migrations/fix_takashina_import_wrong_owner.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

/**
 * 誤って認定が付いた側 (wrongUserNumber) から、
 * その (保険者, 被保番) だけを剥がす。
 * 正しい持ち主 (rightUserNumber) は確認のためだけに使う。
 */
const CASES = [
  {
    insurer: "121012", insured: "1000093565",
    wrongUserNumber: "11",     wrongName: "御園 政司",
    rightUserNumber: "HN-11",  rightName: "飯塚 光子",
    reason: "保険者 121012=千葉市中央区。飯塚は千葉市中央区在住、御園は白子町 (本来 124248)",
  },
  {
    insurer: "122069", insured: "0000010568",
    wrongUserNumber: "674",     wrongName: "荻野 由紀子",
    rightUserNumber: "HN-674",  rightName: "児嶌 巴",
    reason: "保険者 122069=木更津市。児嶌は木更津市在住、荻野は袖ケ浦市 (本来 122291)",
  },
];

async function clientByNumber(u) {
  const { data, error } = await sb.from("clients")
    .select("id, name, birth_date, address")
    .eq("tenant_id", TENANT).eq("user_number", u);
  if (error) { console.error(`✗ clients: ${error.message}`); process.exit(1); }
  return data?.[0] ?? null;
}

async function main() {
  console.log(`=== 高品取込が別人に付けた認定・割当を剥がす ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const { data: offs, error: eo } = await sb.from("offices")
    .select("id, name").eq("tenant_id", TENANT)
    .eq("service_type", "居宅介護支援").ilike("name", "%高品%");
  if (eo) { console.error(`✗ ${eo.message}`); process.exit(1); }
  if (offs?.length !== 1) { console.error("✗ 高品居宅が 1 件に絞れない"); process.exit(1); }
  const officeId = offs[0].id;

  const certIds = [], asgIds = [];
  for (const c of CASES) {
    const wrong = await clientByNumber(c.wrongUserNumber);
    const right = await clientByNumber(c.rightUserNumber);
    console.log(`── ${c.insurer}|${c.insured}`);
    console.log(`   正: ${c.rightName}  ${right ? right.address?.slice(0, 26) : "(client 無し)"}`);
    console.log(`   誤: ${c.wrongName}  ${wrong ? wrong.address?.slice(0, 26) : "(client 無し)"}`);
    console.log(`   根拠: ${c.reason}`);
    if (!wrong) { console.log("   → 誤りの側が居ないので何もしない\n"); continue; }
    // ⚠ 正しい側に認定が残っているのを確かめてから消す。
    //   両方消して 0 件になると、その人の認定が丸ごと失われる。
    if (right) {
      const { data: rc } = await sb.from("client_insurance_records")
        .select("id").eq("client_id", right.id)
        .eq("insurer_number", c.insurer).eq("insured_number", c.insured);
      if (!rc?.length) {
        console.log("   ⚠ 正しい側に認定が無い。消すと失われるので飛ばす\n");
        continue;
      }
      console.log(`   正しい側の認定 ${rc.length} 件を確認`);
    }
    const { data: wc } = await sb.from("client_insurance_records")
      .select("id, certification_start_date, care_level")
      .eq("client_id", wrong.id)
      .eq("insurer_number", c.insurer).eq("insured_number", c.insured);
    for (const r of wc ?? []) {
      certIds.push(r.id);
      console.log(`   剥がす認定: ${r.certification_start_date} ${r.care_level}`);
    }
    const { data: wa } = await sb.from("client_office_assignments")
      .select("id, created_at").eq("client_id", wrong.id).eq("office_id", officeId);
    for (const a of wa ?? []) {
      asgIds.push(a.id);
      console.log(`   剥がす高品への割当: ${a.created_at?.slice(0, 19)}`);
    }
    console.log("");
  }

  console.log(`合計: 認定 ${certIds.length} 件 / 高品への割当 ${asgIds.length} 件を削除`);
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で削除します。"); return; }
  if (!certIds.length && !asgIds.length) return;

  if (certIds.length) {
    const { error } = await sb.from("client_insurance_records").delete().in("id", certIds);
    if (error) { console.error(`✗ 認定の削除に失敗: ${error.message}`); process.exit(1); }
  }
  if (asgIds.length) {
    const { error } = await sb.from("client_office_assignments").delete().in("id", asgIds);
    if (error) { console.error(`✗ 割当の削除に失敗: ${error.message}`); process.exit(1); }
  }
  console.log(`\n✓ 認定 ${certIds.length} 件 / 割当 ${asgIds.length} 件を削除しました`);
}

main();
