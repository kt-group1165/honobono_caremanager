// ============================================================================
// 四街道 居宅: 利用票にいて当方に無い 2 名 (月遅れ) を投入する。
//
// ── なぜ抜けていたか ──────────────────────────────────────────────────
//   居宅の取込元 全居宅居宅サービス計.CSV は 1 列目が「国保提出区分」の
//   **請求明細**で、7/10 に請求できなかった人は載らない。
//   伝送 (KK) にも載らないので、どちらから取り込んでも捕捉できなかった。
//   利用票 PDF は請求と独立して月ごとに作られるので、そこから起こす。
//
//   北原 武夫    要介護1  保険者132118 被保番1300712385  (中込CM)
//   小池 美乃里  要介護2  保険者122283 被保番0000114850  (服部CM)
//
// ── 金額の根拠 ────────────────────────────────────────────────────────
//   同事業所の既存レセプトと同じ構成にする (推測しない):
//     基本 1086 (居宅介護支援Ⅰⅰ１ = 要介護1・2)
//     + 特定事業所加算Ⅱ 421      ← offices.tokutei_kassan_type = Ⅱ
//     + 処遇改善 38              ← (1086+421) × 21/1000 = 31.6 … だが実データは 38。
//                                  **既存 2 件と同じ 38 を採る** (同月・同型の実績値)
//     = 1545 単位 × 11.05 円 = 20,387 円
//   20,387 × 2 = 40,774 円 = 事業所報告の「月遅れ 2 件」と一致。
//
// ── 伝送には出さない ──────────────────────────────────────────────────
//   7/10 の伝送に載っていない人なので、kaigo_billing_status に
//   kokuho_target=false / tsukiokure=true を立てる。
//   → 6 月の伝送は 135 名のままバイト一致を維持し、売上にだけ 2 名が乗る。
//
//   node migrations/add_kyotaku_tsukiokure_yotsukaido.mjs            # DRY RUN
//   node migrations/add_kyotaku_tsukiokure_yotsukaido.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const TENANT = "kt-group";
const MONTH = "2026-06";
const OFFICE_ID = "36542370-378b-4f75-b514-080f49b16225"; // Ｈａｎａ居宅支援センター四街道
const MARK = "[利用票取込 2026-06 四街道 月遅れ]";

/** 利用票 PDF から起こした値。要介護度は区分支給限度基準額から確定済 */
const TARGETS = [
  {
    name: "北原 武夫",
    careLevel: "要介護1",
    insurer: "132118",
    insured: "1300712385",
    limitUnits: 16765,
  },
  {
    name: "小池 美乃里",
    careLevel: "要介護2",
    insurer: "122283",
    insured: "0000114850",
    limitUnits: 19705,
  },
];

/** 同事業所の既存レセプトと同一構成 (要介護1・2 = 居宅介護支援Ⅰⅰ１) */
const CLAIM = {
  care_support_code: "432111",
  care_support_name: "居宅介護支援Ⅰⅰ１",
  units: 1086,
  unit_price: 11.05,
  tokutei_kassan_type: "Ⅱ",
  tokutei_kassan_units: 421,
  shoguu_kaizen_code: "436191",
  shoguu_kaizen_units: 38,
  total_amount: 20387,
  insurance_amount: 20387,
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
  console.log(`=== 四街道 居宅 月遅れ 2 名の投入 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 既存確認 (被保番+保険者で。氏名は表記ゆれがあるためキーにしない)
  const plan = [];
  for (const t of TARGETS) {
    const { data: ex, error } = await sb
      .from("client_insurance_records")
      .select("client_id, clients(name)")
      .eq("insured_number", t.insured)
      .eq("insurer_number", t.insurer);
    if (error) { console.error(`✗ 既存確認失敗: ${error.message}`); process.exit(1); }
    const hit = (ex ?? [])[0];
    plan.push({ ...t, existingClientId: hit?.client_id ?? null, existingName: hit?.clients?.name ?? null });
  }

  for (const p of plan) {
    console.log(`  ${p.name}  ${p.careLevel}  保険者${p.insurer} 被保番${p.insured}`);
    console.log(
      p.existingClientId
        ? `     → 既存 client あり (${p.existingName}) — 事業所割当と認定・レセプトのみ補う`
        : `     → clients から新規作成`,
    );
  }
  console.log(`\n  レセプト: ${CLAIM.care_support_name} ${CLAIM.units}単位 + 特定${CLAIM.tokutei_kassan_units} + 処遇${CLAIM.shoguu_kaizen_units} = ${CLAIM.total_amount.toLocaleString()}円 × ${plan.length}名`);
  console.log(`  合計 ${(CLAIM.total_amount * plan.length).toLocaleString()}円  (事業所報告の月遅れ 40,774円)`);
  console.log(`  伝送には出さない (kokuho_target=false / tsukiokure=true)`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で投入します。"); return; }

  for (const p of plan) {
    let clientId = p.existingClientId;
    if (!clientId) {
      clientId = randomUUID();
      // ⚠ clients に notes 列は無い。出所は認定側の notes に残す。
      //   user_number は NOT NULL だが **利用票に利用者番号が印字されていない**。
      //   ほのぼのの番号 (627xxxxxx) と衝突しない仮番号を被保険者番号から作る。
      //   本番の番号が分かったら差し替える (取込の突合キーは被保番+保険者なので実害なし)。
      const { error } = await sb.from("clients").insert({
        id: clientId, tenant_id: TENANT, name: p.name,
        user_number: `TMP${p.insured}`,
        insurer_number: p.insurer, insured_number: p.insured, care_level: p.careLevel,
      });
      if (error) { console.error(`✗ clients 作成失敗 (${p.name}): ${error.message}`); process.exit(1); }
      console.log(`  ✓ clients 作成: ${p.name}`);
    }

    // 事業所割当 (既にあれば無視)
    const { error: aErr } = await sb.from("client_office_assignments").insert({
      tenant_id: TENANT, client_id: clientId, office_id: OFFICE_ID,
    });
    if (aErr && !/duplicate|unique/i.test(aErr.message)) {
      console.error(`✗ 事業所割当失敗 (${p.name}): ${aErr.message}`); process.exit(1);
    }

    // 認定
    const { data: hasCert } = await sb
      .from("client_insurance_records").select("id")
      .eq("client_id", clientId).eq("insured_number", p.insured);
    if (!(hasCert ?? []).length) {
      const { error: cErr } = await sb.from("client_insurance_records").insert({
        tenant_id: TENANT, client_id: clientId,
        insurer_number: p.insurer, insured_number: p.insured,
        care_level: p.careLevel, service_limit_amount: p.limitUnits, notes: MARK,
      });
      if (cErr) { console.error(`✗ 認定作成失敗 (${p.name}): ${cErr.message}`); process.exit(1); }
    }

    // レセプト (同月に既にあれば作らない)
    const { data: hasClaim } = await sb
      .from("kaigo_care_support_claims").select("id")
      .eq("user_id", clientId).eq("billing_month", MONTH);
    if (!(hasClaim ?? []).length) {
      const { error: rErr } = await sb.from("kaigo_care_support_claims").insert({
        tenant_id: TENANT, user_id: clientId, billing_month: MONTH,
        ...CLAIM, status: "confirmed",
        notes: `${MARK} 利用票から起票。7/10 の伝送に無いため月遅れ扱い`,
      });
      if (rErr) { console.error(`✗ レセプト作成失敗 (${p.name}): ${rErr.message}`); process.exit(1); }
    }

    // 月遅れフラグ (伝送から除外し、翌月以降の再請求に回す)
    const { error: sErr } = await sb.from("kaigo_billing_status").insert({
      tenant_id: TENANT, client_id: clientId, office_id: OFFICE_ID,
      target_month: MONTH, kokuho_target: false, tsukiokure: true,
      notes: `${MARK} 7/10 の伝送に載っていない`,
    });
    if (sErr && !/duplicate|unique/i.test(sErr.message)) {
      console.error(`✗ 月遅れフラグ失敗 (${p.name}): ${sErr.message}`); process.exit(1);
    }
    console.log(`  ✓ ${p.name}: 割当・認定・レセプト・月遅れフラグ を投入`);
  }
  console.log(`\n✓ 完了`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
