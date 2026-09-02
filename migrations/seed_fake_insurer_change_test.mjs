/**
 * 月途中の保険者変更 (転居) によるレセプト分割 の検証用テストデータ投入
 *
 *   node migrations/seed_fake_insurer_change_test.mjs              # DRY RUN
 *   node migrations/seed_fake_insurer_change_test.mjs --execute    # 本番投入
 *
 * ⚠ 本番データには一切触らない。
 *   - 専用の事業所 (offices) を 1 つ新設し、そこに全テスト利用者を紐付ける
 *   - 対象月は 2026-10 (実績 0 件を実測で確認済み)
 *   - すべての行に marker `[fake テスト用-insurer-20260903]` を入れる
 *   - 削除は migrations/delete_fake_insurer_change_test.mjs
 *
 * 背景: 居宅で「転居月は 1 人が 2 レセプトなのに (user_id, billing_month) が一意で、
 * 後から取り込んだほうが**黙って上書き**していた」事故があった (加藤綾子 2026-06)。
 * 訪問介護 (visit-seikyu) と障害 (shogai-seikyu) で同じ型の取りこぼしが無いかを見る。
 *
 * 実績は 身体介護３ (567単位)・1日1回。
 *   前半 10/01〜10/10 = 10 回 (5670 単位) / 後半 10/16〜10/25 = 8 回 (4536 単位)
 * 分割されると floor が 2 回効くので、分割の合計は分割なしより 1 円少なくなる
 * (112775 vs 112776)。これで「本当に分割されたか」を金額で判別できる。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const MARKER = "[fake テスト用-insurer-20260903]";
const TENANT = "kt-group";
const MONTH = "2026-10";
const OFFICE_NAME = `保険者変更検証事業所 ${MARKER}`;
const EXECUTE = process.argv.includes("--execute");

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** 前半 = 10/01〜10/10 (10回) / 後半 = 10/16〜10/25 (8回) */
const FIRST_HALF = Array.from({ length: 10 }, (_, i) => i + 1);
const SECOND_HALF = Array.from({ length: 8 }, (_, i) => i + 16);

/**
 * 検証ケース。
 *   certs = client_insurance_records に入れる行 (2 件 = 月途中変更)
 *   shogai = shougai_certifications に入れる行 (障害ケースのみ)
 */
const CASES = [
  {
    tag: "S01", name: "保険者変更テスト01 転居", system: "介護",
    certs: [
      { insurer: "121012", insurerName: "千葉市", insured: "9930000101", from: "2026-04-01", to: "2026-10-15" },
      { insurer: "122011", insurerName: "船橋市", insured: "9930000102", from: "2026-10-16", to: "2027-03-31" },
    ],
    memo: "★本命: 月途中で保険者が変わる (千葉市→船橋市)。2 レセプトに分割されるべき",
  },
  {
    tag: "S02", name: "保険者変更テスト02 対照", system: "介護",
    certs: [
      { insurer: "121012", insurerName: "千葉市", insured: "9930000201", from: "2026-04-01", to: "2027-03-31" },
    ],
    memo: "対照群: 変更なし。実績は S01 と同じ 18 回 → 1 レセプトで合計額が 1 円多い",
  },
  {
    tag: "S03", name: "保険者変更テスト03 被保番のみ", system: "介護",
    certs: [
      { insurer: "121012", insurerName: "千葉市", insured: "9930000301", from: "2026-04-01", to: "2026-10-15" },
      { insurer: "121012", insurerName: "千葉市", insured: "9930000302", from: "2026-10-16", to: "2027-03-31" },
    ],
    memo: "保険者は同じで被保険者番号だけ変わる → これも分割対象 (判定に被保番が入る)",
  },
  {
    tag: "S04", name: "保険者変更テスト04 境界日不明", system: "介護",
    certs: [
      { insurer: "121012", insurerName: "千葉市", insured: "9930000401", from: "2026-04-01", to: "2026-10-15" },
      // 変更後認定の開始日が月初以前 = 月内の変化点として判定できない
      { insurer: "122011", insurerName: "船橋市", insured: "9930000402", from: "2026-09-20", to: "2027-03-31" },
    ],
    memo: "境界日が月初以前で判定不能 → 分割せず月末時点の保険者 1 本 + warning",
  },
  {
    tag: "S05", name: "保険者変更テスト05 障害市町村変更", system: "障害",
    certs: [
      { insurer: "121012", insurerName: "千葉市", insured: "9930000501", from: "2026-04-01", to: "2027-03-31" },
    ],
    shogai: [
      { muni: "121004", benef: "1210000501", from: "2026-04-01", to: "2026-10-15" },
      { muni: "122011", benef: "1220000502", from: "2026-10-16", to: "2027-03-31" },
    ],
    memo: "障害で月内に市町村が変わる → 分割は未対応の想定。**warning が出て実績が消えないこと**",
  },
];

/** 介護 = 身体介護３ (567) / 障害 = 居宅介護 身体介護 30分未満 (254) */
const SERVICE = { 介護: "身体介護３", 障害: "居宅介護 身体介護 30分未満" };

async function main() {
  console.log(`${EXECUTE ? "=== 本番投入 ===" : "=== DRY RUN (--execute で投入) ==="}`);
  console.log(`marker: ${MARKER} / 対象月: ${MONTH} / tenant: ${TENANT}`);
  console.log(`実績: 前半 ${FIRST_HALF.length} 回 (10/01〜10/10) + 後半 ${SECOND_HALF.length} 回 (10/16〜10/25)\n`);

  // 0) 安全確認
  const { count: existing, error: exErr } = await sb
    .from("kaigo_visit_schedule").select("id", { count: "exact", head: true })
    .gte("visit_date", `${MONTH}-01`).lte("visit_date", `${MONTH}-31`);
  if (exErr) throw new Error(`既存実績の確認に失敗: ${exErr.message}`);
  console.log(`対象月の既存実績: ${existing} 件 ${existing === 0 ? "(OK)" : "(⚠ 0 件でない)"}`);
  if (existing !== 0 && EXECUTE) throw new Error(`${MONTH} に既存実績が ${existing} 件あります。中止します`);

  // 1) テスト事業所
  const { data: exOffice, error: ofErr } = await sb
    .from("offices").select("id, name").eq("name", OFFICE_NAME).maybeSingle();
  if (ofErr) throw new Error(`事業所の確認に失敗: ${ofErr.message}`);
  const officeId = exOffice?.id ?? randomUUID();
  console.log(exOffice ? `事業所: 既存を再利用 ${officeId}` : `事業所: 新規作成 ${officeId} (unit_price=11.05)`);

  const officeRow = {
    id: officeId, tenant_id: TENANT, name: OFFICE_NAME, service_type: "訪問介護",
    unit_price: 11.05, area_category: "3級地", applied_formula_codes: [],
    business_number: "9999999904", shogai_business_number: "1299999904", is_active: false,
    notes: `${MARKER} 月途中の保険者変更の検証用。検証後に削除する`,
  };

  const clients = [], certs = [], shogaiCerts = [], assigns = [], scheds = [];
  const summary = [];
  for (const c of CASES) {
    const clientId = randomUUID();
    // 月末時点の認定 (= 最後の cert) を clients に載せる
    const last = c.certs[c.certs.length - 1];
    clients.push({
      id: clientId, tenant_id: TENANT, user_number: `FAKEINS-${c.tag}`,
      name: c.name, furigana: `ﾎｹﾝｼｬ${c.tag}`,
      address: `千葉市中央区テスト町4-${c.tag} ${MARKER}`,
      birth_date: "1936-06-06", gender: "女",
      insured_number: last.insured, insurer_number: last.insurer,
      care_level: "要介護5", copay_rate: "1", status: "active",
      office_id: null, is_facility: false, is_provisional: false,
    });
    assigns.push({
      tenant_id: TENANT, client_id: clientId, office_id: officeId,
      start_date: "2026-04-01", service_notes: MARKER,
    });
    for (const ct of c.certs) {
      certs.push({
        tenant_id: TENANT, client_id: clientId, effective_date: ct.from,
        insured_number: ct.insured, care_level: "要介護5",
        certification_start_date: ct.from, certification_end_date: ct.to,
        insurer_number: ct.insurer, insurer_name: ct.insurerName, copay_rate: "1",
        service_limit_amount: 36217, certification_status: "認定済み",
        record_status: "認定済み", notes: MARKER,
      });
    }
    for (const sc of c.shogai ?? []) {
      shogaiCerts.push({
        tenant_id: TENANT, client_id: clientId,
        beneficiary_number: sc.benef, insurer_municipality: sc.muni,
        support_level: "区分4", self_payment_limit: 0, seiho_flag: false,
        certification_start_date: sc.from, certification_end_date: sc.to,
        contract_start_date: sc.from, copay_rate: "0.1",
        jogen_kanri_kubun: "なし", notes: MARKER,
      });
    }
    for (const day of [...FIRST_HALF, ...SECOND_HALF]) {
      scheds.push({
        tenant_id: TENANT, user_id: clientId, office_id: officeId,
        visit_date: `${MONTH}-${String(day).padStart(2, "0")}`,
        service_type: SERVICE[c.system],
        start_time: "09:00:00", end_time: "10:30:00",
        status: "completed", system: c.system, billable: true,
        kinkyu_houmon: false, notes: MARKER,
      });
    }
    summary.push({
      tag: c.tag, clientId, system: c.system,
      certs: c.certs.map((x) => `${x.insurer}/${x.insured}(${x.from}〜${x.to})`).join(" → "),
      shogai: (c.shogai ?? []).map((x) => `${x.muni}(${x.from}〜)`).join(" → ") || null,
      memo: c.memo,
    });
  }

  console.log("\n投入予定:");
  console.table(summary.map((s) => ({ tag: s.tag, 制度: s.system, 認定: s.certs, 障害受給者証: s.shogai ?? "" })));
  console.log(`\n  offices                   ${exOffice ? 0 : 1} 件`);
  console.log(`  clients                   ${clients.length} 件`);
  console.log(`  client_insurance_records  ${certs.length} 件`);
  console.log(`  shougai_certifications    ${shogaiCerts.length} 件`);
  console.log(`  client_office_assignments ${assigns.length} 件`);
  console.log(`  kaigo_visit_schedule      ${scheds.length} 件`);

  if (!EXECUTE) { console.log("\nDRY RUN のため何も書き込んでいません。"); return; }

  const ins = async (table, rows) => {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from(table).insert(rows.slice(i, i + 500));
      if (error) throw new Error(`${table} INSERT 失敗: ${error.message}`);
    }
    console.log(`  ${table}: ${rows.length} 件 INSERT`);
  };

  if (!exOffice) {
    const { error } = await sb.from("offices").insert(officeRow);
    if (error) throw new Error(`offices INSERT 失敗: ${error.message}`);
    console.log(`  offices: 1 件 INSERT`);
  }
  await ins("clients", clients);
  await ins("client_insurance_records", certs);
  await ins("shougai_certifications", shogaiCerts);
  await ins("client_office_assignments", assigns);
  await ins("kaigo_visit_schedule", scheds);

  const { count: sc, error: e1 } = await sb.from("kaigo_visit_schedule")
    .select("id", { count: "exact", head: true }).eq("office_id", officeId);
  if (e1) throw new Error(`件数確認に失敗: ${e1.message}`);
  const { count: cc, error: e2 } = await sb.from("client_insurance_records")
    .select("id", { count: "exact", head: true }).eq("notes", MARKER);
  if (e2) throw new Error(`件数確認に失敗: ${e2.message}`);
  console.log(`\n件数確認: 実績 ${sc} 件 / 認定 ${cc} 件`);
  if (sc !== scheds.length || cc !== certs.length) throw new Error("投入件数が想定と一致しません");

  const meta = { marker: MARKER, month: MONTH, officeId, unitPrice: 11.05, tenantId: TENANT,
    firstHalf: FIRST_HALF, secondHalf: SECOND_HALF, cases: summary };
  writeFileSync(new URL("./_fake_insurer_change_test_meta.json", import.meta.url),
    JSON.stringify(meta, null, 2) + "\n");
  console.log("メタ情報を migrations/_fake_insurer_change_test_meta.json に書き出しました");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
