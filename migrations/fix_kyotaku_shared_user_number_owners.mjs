// ============================================================================
// ほのぼのの「利用者番号の使い回し」で、別人に付いてしまった
// 認定 / レセプト / 被保険者番号 を正しい持ち主に戻す。
//
//   node migrations/fix_kyotaku_shared_user_number_owners.mjs             # DRY RUN
//   node migrations/fix_kyotaku_shared_user_number_owners.mjs --execute
//
// ── 何が起きていたか ────────────────────────────────────────────────────
//   ほのぼのは **同じ利用者番号を複数人が持つ**ことがある (使い回し / 事業者
//   エントリ違い)。取込が利用者番号で引き当てたため、別人のデータが付いた。
//
//   ① いすみ  利用者番号 455 を 石井 洋子 と 鈴木 喜代子 が共有
//        当方: 鈴木 喜代子 (生1927-05-05) に
//                認定    124222|0000015495 要介護3 2026-05-22〜2027-05-31
//                レセプト 2026-07 23,300円
//              が付いていた。石井 洋子 の clients は被保番が仮番号 9999999222 /
//              生年月日が "2022/7/1" というゴミで、参照ゼロ。
//        正:   利用者マスタ CSV に 石井 洋子 (利番455 / 生1931-09-06) →
//                124222|0000015495 要介護3 2026/05/22〜2027/05/31 が**完全一致**で載る。
//              鈴木 喜代子 (利番455) の認定は 122192|1000013702 の 2003〜2006 のみ。
//        → 認定・レセプト・事業所割当を 石井 洋子 に移し、clients も直す。
//          ⚠ 鈴木 喜代子 の 第1表 (2026-07) は content の氏名が「鈴木 喜代子」なので
//            本人のもの。**触らない**。
//
//   ② K姉  利用者番号 411000325 を 古川 秀子 と 本多 ふじ江 が共有
//        当方: 本多 ふじ江 (生1935-07-16) の **clients 行**の被保番が
//              1000064315 (= 古川さんのもの) / 要介護度も古川さんの 要介護2。
//              認定レコードのほうは 122192|1000037393 要介護3 で正しい。
//        正:   CSV は 本多 ふじ江 → 1000037393 要介護3、古川 秀子 → 1000064315 要介護2。
//        → 本多さんの clients 行だけ自分の値に直す。
//
// ── なぜ危ないか ────────────────────────────────────────────────────────
//   (保険者, 被保番) が 2 人に当たると **伝送取込がどちらか判らずレセプトを落とす**。
//   また利用票の取込も「氏名が別人」として止まる。金額に直結するので放置できない。
//
// ── 安全策 ──────────────────────────────────────────────────────────────
//   ・対象は下の FIXES に**明示した 2 件だけ**。走査して自動判定はしない
//   ・実行前に現在値が想定どおりか確認し、違えば触らずに中止する
//   ・変更前の値を migrations/_shared_user_number_fix_backup.json に残す
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const BACKUP = path.join(KAIGO, "migrations/_shared_user_number_fix_backup.json");

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const ISHII = "3d451a20-dccd-426f-ae16-6382b6faa40c";   // 石井 洋子
const SUZUKI = "e43d3f00-ea9e-42d5-ac15-0ee3dd0aeb64";  // 鈴木 喜代子

async function main() {
  console.log(`=== 利用者番号の使い回しで別人に付いたデータを戻す ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);
  const backup = [];
  let changes = 0;

  // ── ① いすみ 石井 洋子 / 鈴木 喜代子 ──────────────────────────────────
  console.log("① いすみ  利用者番号455 (石井 洋子 / 鈴木 喜代子)");
  const { data: ishii, error: e1 } = await sb.from("clients").select("*").eq("id", ISHII).maybeSingle();
  const { data: suzuki, error: e2 } = await sb.from("clients").select("*").eq("id", SUZUKI).maybeSingle();
  if (e1 || e2) { console.error(`✗ 取得失敗: ${e1?.message ?? e2?.message}`); process.exit(1); }
  if (!ishii || !suzuki) { console.error("✗ 対象 client が見つからない"); process.exit(1); }

  const { data: cert, error: e3 } = await sb.from("client_insurance_records")
    .select("*").eq("client_id", SUZUKI).eq("insured_number", "0000015495").maybeSingle();
  if (e3) { console.error(`✗ 認定取得失敗: ${e3.message}`); process.exit(1); }

  if (!cert) {
    console.log("   認定 124222|0000015495 は鈴木さんに付いていない → 是正済みとみなす");
  } else {
    console.log(`   認定 ${cert.id.slice(0, 8)} ${cert.insurer_number}|${cert.insured_number} ${cert.care_level} → 石井 洋子 へ移す`);
    const { data: claims } = await sb.from("kaigo_care_support_claims")
      .select("id, billing_month, total_amount").eq("user_id", SUZUKI).eq("insured_number", "0000015495");
    for (const c of claims ?? []) console.log(`   レセプト ${c.billing_month} ${c.total_amount}円 → 石井 洋子 へ移す`);
    console.log(`   clients(石井) 被保番 ${ishii.insured_number} → 0000015495 / 生 ${ishii.birth_date} → 1931-09-06`);
    console.log(`   clients(鈴木) 要介護度 ${suzuki.care_level} → null (根拠の認定が無くなるため)`);

    if (EXECUTE) {
      backup.push({ table: "client_insurance_records", id: cert.id, before: { client_id: cert.client_id } });
      backup.push({ table: "clients", id: ishii.id, before: ishii });
      backup.push({ table: "clients", id: suzuki.id, before: { care_level: suzuki.care_level } });

      const { error: u1 } = await sb.from("client_insurance_records").update({ client_id: ISHII }).eq("id", cert.id);
      if (u1) { console.error(`✗ 認定の付け替え失敗: ${u1.message}`); process.exit(1); }

      for (const c of claims ?? []) {
        backup.push({ table: "kaigo_care_support_claims", id: c.id, before: { user_id: SUZUKI } });
        const { error } = await sb.from("kaigo_care_support_claims").update({ user_id: ISHII }).eq("id", c.id);
        if (error) console.error(`✗ レセプト付け替え失敗 ${c.billing_month}: ${error.message}`);
      }

      const { error: u2 } = await sb.from("clients").update({
        insurer_number: "124222", insured_number: "0000015495",
        birth_date: "1931-09-06", user_number: "455-ishii",
        care_level: cert.care_level,
        certification_start_date: cert.certification_start_date,
        certification_end_date: cert.certification_end_date,
      }).eq("id", ISHII);
      if (u2) console.error(`✗ 石井さんの更新失敗: ${u2.message}`);

      const { error: u3 } = await sb.from("clients").update({ care_level: null }).eq("id", SUZUKI);
      if (u3) console.error(`✗ 鈴木さんの更新失敗: ${u3.message}`);

      // 石井さんに いすみ の事業所割当が無いと画面・集計から漏れる
      const { data: asg } = await sb.from("client_office_assignments").select("office_id").eq("client_id", ISHII);
      if (!asg?.length) {
        const { data: sAsg } = await sb.from("client_office_assignments").select("office_id, tenant_id").eq("client_id", SUZUKI).limit(1).maybeSingle();
        if (sAsg) {
          const { error } = await sb.from("client_office_assignments").insert({
            tenant_id: sAsg.tenant_id, client_id: ISHII, office_id: sAsg.office_id,
            start_date: "2026-06-01", home_care_categories: [],
          });
          if (error) console.error(`✗ 事業所割当の作成失敗: ${error.message}`);
          else console.log("   石井さんに いすみ の事業所割当を作成");
        }
      }
    }
    changes++;
  }

  // ── ② K姉 本多 ふじ江 の clients 行 ───────────────────────────────────
  console.log("\n② K姉  利用者番号411000325 (古川 秀子 / 本多 ふじ江)");
  const { data: hondas, error: e4 } = await sb.from("clients")
    .select("*").eq("name", "本多 ふじ江").eq("insured_number", "1000064315");
  if (e4) { console.error(`✗ 取得失敗: ${e4.message}`); process.exit(1); }
  if (!hondas?.length) {
    console.log("   本多さんの被保番は既に 1000064315 ではない → 是正済みとみなす");
  } else {
    for (const h of hondas) {
      const { data: own } = await sb.from("client_insurance_records")
        .select("*").eq("client_id", h.id).eq("insured_number", "1000037393").maybeSingle();
      if (!own) { console.log(`   ⚠ ${h.name}: 自分の認定 1000037393 が見つからない → 触らない`); continue; }
      console.log(`   clients(本多) 被保番 ${h.insured_number} → 1000037393 / 要介護度 ${h.care_level} → ${own.care_level}`);
      console.log(`                 認定期間 ${h.certification_start_date}〜${h.certification_end_date} → ${own.certification_start_date}〜${own.certification_end_date}`);
      if (EXECUTE) {
        backup.push({ table: "clients", id: h.id, before: h });
        const { error } = await sb.from("clients").update({
          insured_number: own.insured_number, insurer_number: own.insurer_number,
          care_level: own.care_level,
          certification_start_date: own.certification_start_date,
          certification_end_date: own.certification_end_date,
        }).eq("id", h.id);
        if (error) console.error(`✗ 本多さんの更新失敗: ${error.message}`);
      }
      changes++;
    }
  }

  console.log(`\n是正対象 ${changes} 件`);
  if (!EXECUTE) { console.log("(--execute で反映)"); return; }
  writeFileSync(BACKUP, JSON.stringify(backup, null, 2), "utf8");
  console.log(`変更前の値を ${path.basename(BACKUP)} に保存しました`);
  console.log("→ このあと利用票の取込を流し直すと、石井 洋子 の帳票が入ります:");
  console.log("   MONTH=2026-06 node migrations/import_riyouhyou_service_usage.mjs --execute");
}

main().catch((e) => { console.error(e); process.exit(1); });
