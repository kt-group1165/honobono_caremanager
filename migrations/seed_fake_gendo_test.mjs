/**
 * 区分支給限度基準額 (限度額) 超過計算の検証用テストデータ投入
 *
 *   node migrations/seed_fake_gendo_test.mjs              # DRY RUN
 *   node migrations/seed_fake_gendo_test.mjs --execute    # 本番投入
 *
 * ⚠ 本番データには一切触らない。
 *   - 専用の事業所 (offices) を 1 つ新設し、そこに全テスト利用者を紐付ける
 *   - 対象月は 2026-11 (実績 0 件を実測で確認済み。office_id NULL の実績も同月に無い)
 *   - すべての行に marker `[fake テスト用-gendo-20260903]` を入れる
 *     (notes 列が無い表は address / service_notes / name に入れる)
 *   - 削除は migrations/delete_fake_gendo_test.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const MARKER = "[fake テスト用-gendo-20260903]";
const TENANT = "kt-group";
const MONTH = "2026-11";
const OFFICE_NAME = `限度額検証事業所 ${MARKER}`;
const EXECUTE = process.argv.includes("--execute");

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** 単位数 (2026-06 改定世代。valid_until IS NULL) */
const UNITS = { 身体介護１: 244, 身体介護２: 387, 身体介護３: 567, 生活援助２: 179, 生活援助３: 220 };

/**
 * 検証ケース。svc = サービス名 → 回数。
 * certs は client_insurance_records に入れる行 (複数 = 月途中の区分変更)。
 */
const CASES = [
  {
    tag: "G01", name: "限度額テスト01 手前", level: "要介護1", copay: "1",
    certs: [{ level: "要介護1", limit: 16765, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護１: 1, 身体介護２: 5, 身体介護３: 24, 生活援助２: 3, 生活援助３: 2 }, // 16764
    memo: "要介護1 限度額-1単位",
  },
  {
    tag: "G02", name: "限度額テスト02 ちょうど", level: "要介護1", copay: "1",
    certs: [{ level: "要介護1", limit: 16765, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護１: 1, 身体介護２: 4, 身体介護３: 25, 生活援助２: 2, 生活援助３: 2 }, // 16765
    memo: "要介護1 限度額ちょうど (境界)",
  },
  {
    tag: "G03", name: "限度額テスト03 超過1", level: "要介護1", copay: "1",
    certs: [{ level: "要介護1", limit: 16765, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護１: 1, 身体介護２: 3, 身体介護３: 26, 生活援助２: 1, 生活援助３: 2 }, // 16766
    memo: "要介護1 限度額+1単位 (境界)",
  },
  {
    tag: "G04", name: "限度額テスト04 要2ちょうど", level: "要介護2", copay: "1",
    certs: [{ level: "要介護2", limit: 19705, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護２: 2, 身体介護３: 33, 生活援助３: 1 }, // 19705
    memo: "要介護2 限度額ちょうど (境界)",
  },
  {
    tag: "G05", name: "限度額テスト05 要3超過1", level: "要介護3", copay: "1",
    certs: [{ level: "要介護3", limit: 27048, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護１: 2, 身体介護２: 2, 身体介護３: 44, 生活援助２: 1, 生活援助３: 3 }, // 27049
    memo: "要介護3 限度額+1単位 (境界)",
  },
  {
    tag: "G06", name: "限度額テスト06 要4大幅超過", level: "要介護4", copay: "1",
    certs: [{ level: "要介護4", limit: 30938, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護１: 4, 身体介護２: 4, 身体介護３: 54, 生活援助２: 2 }, // 33500
    memo: "要介護4 大幅超過 (2562単位)",
  },
  {
    tag: "G07", name: "限度額テスト07 要5ちょうど", level: "要介護5", copay: "1",
    certs: [{ level: "要介護5", limit: 36217, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護１: 2, 身体介護２: 3, 身体介護３: 59, 生活援助２: 5, 生活援助３: 1 }, // 36217
    memo: "要介護5 限度額ちょうど (境界)",
  },
  {
    tag: "G08", name: "限度額テスト08 区分変更", level: "要介護3", copay: "1",
    certs: [
      { level: "要介護1", limit: 16765, from: "2026-05-01", to: "2026-11-14" },
      { level: "要介護3", limit: 27048, from: "2026-11-15", to: "2027-11-14" },
    ],
    svc: { 身体介護３: 43, 生活援助２: 1, 生活援助３: 2 }, // 25000
    memo: "月途中の区分変更 (要介護1→3)。限度額は重い方 27048",
  },
  {
    tag: "G09", name: "限度額テスト09 生保超過", level: "要介護2", copay: "1",
    certs: [{ level: "要介護2", limit: 19705, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護１: 2, 身体介護２: 5, 身体介護３: 31 }, // 20000
    kohi: { hobetsu: "12", futansha: "12121014", jukyusha: "9900001", honnin: 0, from: "2026-01-01", to: null },
    memo: "生活保護 (法別12) + 限度額超過295単位",
  },
  {
    tag: "G10", name: "限度額テスト10 難病超過", level: "要介護2", copay: "1",
    certs: [{ level: "要介護2", limit: 19705, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護１: 2, 身体介護２: 5, 身体介護３: 31 }, // 20000
    kohi: { hobetsu: "54", futansha: "54121010", jukyusha: "9900002", honnin: 5000, from: "2026-01-01", to: null },
    memo: "難病 (法別54, 本人負担上限5000円) + 限度額超過295単位",
  },
  {
    tag: "G11", name: "限度額テスト11 計画単位数", level: "要介護3", copay: "1",
    certs: [{ level: "要介護3", limit: 27048, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護３: 20, 生活援助３: 3 }, // 12000
    plannedUnits: 10500,
    memo: "計画単位数 10500 が認定限度額 27048 より優先",
  },
  {
    tag: "G12", name: "限度額テスト12 限度額未登録", level: "要介護3", copay: "1",
    certs: [{ level: "要介護3", limit: null, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護３: 20, 生活援助３: 3 }, // 12000
    memo: "service_limit_amount 未登録 = 限度額管理なし",
  },
  {
    tag: "G13", name: "限度額テスト13 限度額誤登録", level: "要介護4", copay: "1",
    certs: [{ level: "要介護4", limit: 16765, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護１: 4, 身体介護２: 4, 身体介護３: 54, 生活援助２: 2 }, // 33500
    memo: "要介護4 なのに限度額 16765 (告示は30938) で登録されている",
  },
  {
    tag: "G14", name: "限度額テスト14 2割超過", level: "要介護4", copay: "2",
    certs: [{ level: "要介護4", limit: 30938, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護１: 4, 身体介護２: 4, 身体介護３: 54, 生活援助２: 2 }, // 33500
    memo: "G06 と同一実績で負担割合 2割 (超過自費は10割のまま = 不変)",
  },
  {
    tag: "G15", name: "限度額テスト15 計画過大", level: "要介護1", copay: "1",
    certs: [{ level: "要介護1", limit: 16765, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護１: 2, 身体介護２: 5, 身体介護３: 31 }, // 20000
    plannedUnits: 30000,
    memo: "⚠ 計画単位数 30000 > 認定限度額 16765 (誤入力想定)。超過を検出できるか",
  },
  {
    tag: "G16", name: "限度額テスト16 手割振り", level: "要介護3", copay: "1",
    certs: [{ level: "要介護3", limit: 27048, from: "2026-04-01", to: "2027-03-31" }],
    svc: { 身体介護３: 20, 生活援助３: 3 }, // 12000 (機械判定なら超過0)
    manualOverUnits: 1000,
    memo: "ケアマネ手割振り (利用票別表) 1000単位 が機械判定より優先",
  },
  {
    tag: "G17", name: "限度額テスト17 公費単独", level: "要介護2", copay: "1",
    certs: [{ level: "要介護2", limit: 19705, from: "2026-04-01", to: "2027-03-31", insuredPrefix: "H" }],
    svc: { 身体介護１: 2, 身体介護２: 5, 身体介護３: 31 }, // 20000
    kohi: { hobetsu: "12", futansha: "12121014", jukyusha: "9900017", honnin: 0, from: "2026-01-01", to: null },
    memo: "公費単独 (被保番 H 始まり = 10割公費) + 限度額超過295単位",
  },
];

/** 訪問日を月内に割り当てる (1日1件、日を跨いで回す) */
function assignDates(svc) {
  const days = 30; // 2026-11
  const out = [];
  let i = 0;
  for (const [name, count] of Object.entries(svc)) {
    for (let k = 0; k < count; k++) {
      const day = (i % days) + 1;
      out.push({ service_type: name, visit_date: `${MONTH}-${String(day).padStart(2, "0")}` });
      i++;
    }
  }
  return out;
}

const grossOf = (svc) =>
  Object.entries(svc).reduce((s, [n, c]) => s + UNITS[n] * c, 0);

async function main() {
  console.log(`${EXECUTE ? "=== 本番投入 ===" : "=== DRY RUN (--execute で投入) ==="}`);
  console.log(`marker: ${MARKER} / 対象月: ${MONTH} / tenant: ${TENANT}\n`);

  // 0) 安全確認: 対象月に既存実績が無いこと
  const { count: existing, error: exErr } = await sb
    .from("kaigo_visit_schedule")
    .select("id", { count: "exact", head: true })
    .gte("visit_date", `${MONTH}-01`)
    .lte("visit_date", `${MONTH}-30`);
  if (exErr) throw new Error(`既存実績の確認に失敗: ${exErr.message}`);
  console.log(`対象月の既存実績: ${existing} 件 ${existing === 0 ? "(OK)" : "(⚠ 0 件でない)"}`);
  if (existing !== 0 && EXECUTE) {
    throw new Error(`対象月 ${MONTH} に既存実績が ${existing} 件あります。中止します`);
  }

  // 1) テスト事業所
  const { data: exOffice, error: ofErr } = await sb
    .from("offices").select("id, name").eq("name", OFFICE_NAME).maybeSingle();
  if (ofErr) throw new Error(`事業所の確認に失敗: ${ofErr.message}`);
  let officeId = exOffice?.id ?? randomUUID();
  if (exOffice) console.log(`事業所: 既存を再利用 ${officeId}`);
  else console.log(`事業所: 新規作成 ${officeId} (${OFFICE_NAME}) unit_price=11.05`);

  const officeRow = {
    id: officeId, tenant_id: TENANT, name: OFFICE_NAME, service_type: "訪問介護",
    unit_price: 11.05, area_category: "3級地", applied_formula_codes: [],
    business_number: "9999999901", is_active: false,
    notes: `${MARKER} 限度額超過計算の検証用。検証後に削除する`,
  };

  // 2) 各ケースの行を組み立て
  const clients = [], certs = [], kohis = [], assigns = [], scheds = [], plans = [], allocs = [];
  const summary = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const clientId = randomUUID();
    const prefix = c.certs.some((x) => x.insuredPrefix) ? "H" : "";
    const insured = `${prefix}99000000${String(i + 1).padStart(2, "0")}`;
    clients.push({
      id: clientId, tenant_id: TENANT, user_number: `FAKEGENDO-${c.tag}`,
      name: c.name, furigana: `ｹﾞﾝﾄﾞﾃｽﾄ${c.tag}`,
      address: `千葉市中央区テスト町1-${i + 1} ${MARKER}`,
      birth_date: "1940-01-01", gender: i % 2 === 0 ? "男" : "女",
      insured_number: insured, insurer_number: "121012",
      care_level: c.level, copay_rate: c.copay, status: "active",
      office_id: null, is_facility: false, is_provisional: false,
    });
    assigns.push({
      tenant_id: TENANT, client_id: clientId, office_id: officeId,
      start_date: "2026-04-01", service_notes: MARKER,
    });
    for (const ct of c.certs) {
      certs.push({
        tenant_id: TENANT, client_id: clientId, effective_date: ct.from,
        insured_number: insured, care_level: ct.level,
        certification_start_date: ct.from, certification_end_date: ct.to,
        insurer_number: "121012", insurer_name: "千葉市", copay_rate: c.copay,
        service_limit_amount: ct.limit, certification_status: "認定済み",
        record_status: "認定済み", notes: MARKER,
      });
    }
    if (c.kohi) {
      kohis.push({
        tenant_id: TENANT, client_id: clientId, kohi_hobetsu: c.kohi.hobetsu,
        futansha_number: c.kohi.futansha, jukyusha_number: c.kohi.jukyusha,
        start_date: c.kohi.from, end_date: c.kohi.to, priority: 1,
        honnin_futan: c.kohi.honnin, notes: MARKER,
      });
    }
    if (c.manualOverUnits != null) {
      allocs.push({
        tenant_id: TENANT, client_id: clientId, target_month: MONTH,
        line_key: officeId, office_id: officeId, service_category: "11",
        service_label: "訪問介護", total_units: grossOf(c.svc),
        over_units: c.manualOverUnits, source: "manual", notes: MARKER,
      });
    }
    if (c.plannedUnits) {
      plans.push({
        tenant_id: TENANT, client_id: clientId, target_month: `${MONTH}-01`,
        planned_units: c.plannedUnits, office_id: officeId,
        source: "manual", notes: MARKER,
      });
    }
    for (const v of assignDates(c.svc)) {
      scheds.push({
        tenant_id: TENANT, user_id: clientId, office_id: officeId,
        visit_date: v.visit_date, service_type: v.service_type,
        start_time: "09:00:00", end_time: "10:00:00",
        status: "completed", system: "介護", billable: true,
        kinkyu_houmon: false, notes: MARKER,
      });
    }
    summary.push({ tag: c.tag, clientId, level: c.level, copay: c.copay,
      limit: c.certs.map((x) => x.limit).join("/"), gross: grossOf(c.svc),
      visits: Object.values(c.svc).reduce((a, b) => a + b, 0), memo: c.memo });
  }

  console.log("\n投入予定:");
  console.table(summary.map((s) => ({ tag: s.tag, 要介護度: s.level, 負担: s.copay,
    限度額: s.limit, 明細単位: s.gross, 訪問回数: s.visits })));
  console.log(`\n  offices                  ${exOffice ? 0 : 1} 件`);
  console.log(`  clients                  ${clients.length} 件`);
  console.log(`  client_insurance_records ${certs.length} 件`);
  console.log(`  client_kohi_records      ${kohis.length} 件`);
  console.log(`  client_office_assignments ${assigns.length} 件`);
  console.log(`  kaigo_monthly_plan_units ${plans.length} 件`);
  console.log(`  kaigo_gendo_allocation   ${allocs.length} 件`);
  console.log(`  kaigo_visit_schedule     ${scheds.length} 件`);

  if (!EXECUTE) {
    console.log("\nDRY RUN のため何も書き込んでいません。");
    return;
  }

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
  await ins("client_kohi_records", kohis);
  await ins("client_office_assignments", assigns);
  await ins("kaigo_monthly_plan_units", plans);
  await ins("kaigo_gendo_allocation", allocs);
  await ins("kaigo_visit_schedule", scheds);

  // 件数確認 (CLAUDE.md 6.1: --execute 後に必ず verify)
  const { count: schedCount } = await sb.from("kaigo_visit_schedule")
    .select("id", { count: "exact", head: true }).eq("office_id", officeId);
  const { count: cliCount } = await sb.from("clients")
    .select("id", { count: "exact", head: true }).like("user_number", "FAKEGENDO-%");
  console.log(`\n件数確認: 実績 ${schedCount} 件 / 利用者 ${cliCount} 名`);

  const meta = { marker: MARKER, month: MONTH, officeId, unitPrice: 11.05,
    tenantId: TENANT, cases: summary };
  writeFileSync(new URL("./_fake_gendo_test_meta.json", import.meta.url),
    JSON.stringify(meta, null, 2) + "\n");
  console.log("メタ情報を migrations/_fake_gendo_test_meta.json に書き出しました");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
