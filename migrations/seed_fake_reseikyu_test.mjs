/**
 * 月遅れ請求・過誤申立→再請求 の検証用テストデータ投入
 *
 *   node migrations/seed_fake_reseikyu_test.mjs              # DRY RUN
 *   node migrations/seed_fake_reseikyu_test.mjs --execute    # 本番投入
 *
 * ⚠ 本番データには一切触らない。
 *   - 専用の事業所 (offices) を 1 つ新設し、そこに全テスト利用者を紐付ける
 *   - 対象月は 2026-10 / 2026-11 / 2026-12 (いずれも実績 0 件を実測で確認済み)
 *   - すべての行に marker `[fake テスト用-reseikyu-20260903]` を入れる
 *   - 削除は migrations/delete_fake_reseikyu_test.mjs
 *
 * 検証したいこと:
 *   ① 月遅れ  — 過去月の実績が「元の提供月」で再集計され、伝送の提供年月が
 *              元提供月・処理対象年月 (審査月) が請求月+1 で出るか
 *   ② 二重計上しないこと — フラグ無し / 既に国保対象化済み (kokuho_target=true)
 *              の過去月が再請求に紛れ込まないか (★これが本丸)
 *   ③ 過誤    — 通常過誤 / 同月過誤 / 返戻 が付帯情報つきで合流するか
 *   ④ 同一利用者が「当月分」と「月遅れ分」を両方持つとき、別の提供年月で
 *              2 本立つか (金額が合算・重複しないか)
 *
 * 実績は全ケース 身体介護３ (567単位) のみ・1日1回。月ごとに回数を変えてある:
 *   2026-10 = 10 回 (5670 単位) / 2026-11 = 12 回 (6804) / 2026-12 = 8 回 (4536)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const MARKER = "[fake テスト用-reseikyu-20260903]";
const TENANT = "kt-group";
const OFFICE_NAME = `再請求検証事業所 ${MARKER}`;
/** 請求月 (この月の請求画面を開いた想定)。これより前の月が再請求の対象になる */
const CURRENT_MONTH = "2026-12";
const EXECUTE = process.argv.includes("--execute");

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const UNIT = 567; // 身体介護３ (2026-06 改定世代)
/** 提供月 → 訪問回数 */
const VISITS_PER_MONTH = { "2026-10": 10, "2026-11": 12, "2026-12": 8 };

/**
 * 検証ケース。
 *   months  = 実績を入れる提供月の配列
 *   status  = kaigo_billing_status に入れる行 (省略 = 行を作らない)
 *   expect  = 再請求一覧に出るべきか (検証 script 側で使う覚書)
 */
const CASES = [
  {
    tag: "R01", name: "再請求テスト01 月遅れ",
    months: ["2026-10"],
    status: [{ month: "2026-10", tsukiokure: true, henrei: false, kago: false, kokuhoTarget: false }],
    memo: "月遅れ (7/10 の伝送に載らなかった)。提供年月 202610 で出るべき",
  },
  {
    tag: "R02", name: "再請求テスト02 フラグ無し",
    months: ["2026-10"],
    status: [],
    memo: "★過去月の実績はあるが billing_status 行が無い → 再請求に出てはいけない",
  },
  {
    tag: "R03", name: "再請求テスト03 提出済",
    months: ["2026-10"],
    status: [{ month: "2026-10", tsukiokure: true, henrei: false, kago: false, kokuhoTarget: true }],
    memo: "★月遅れフラグはあるが既に国保対象化済み → 二重計上になるので出てはいけない",
  },
  {
    tag: "R04", name: "再請求テスト04 通常過誤",
    months: ["2026-11"],
    status: [{ month: "2026-11", tsukiokure: false, henrei: false, kago: true, kokuhoTarget: false,
      kagoDate: "2026-11-20", kagoCode: "1002", kagoDougetsu: false }],
    memo: "通常過誤 (支払済を取下げ)。事由コード1002・同月過誤でない",
  },
  {
    tag: "R05", name: "再請求テスト05 同月過誤",
    months: ["2026-11"],
    status: [{ month: "2026-11", tsukiokure: false, henrei: false, kago: true, kokuhoTarget: false,
      kagoDate: "2026-11-25", kagoCode: "1012", kagoDougetsu: true }],
    memo: "同月過誤 (申立と再請求を同月処理)。事由コード1012・dougetsu=true",
  },
  {
    tag: "R06", name: "再請求テスト06 返戻",
    months: ["2026-11"],
    status: [{ month: "2026-11", tsukiokure: false, henrei: true, kago: false, kokuhoTarget: false }],
    memo: "返戻 (支払前に差戻し)。過誤と違い即再請求できる",
  },
  {
    tag: "R07", name: "再請求テスト07 当月+月遅れ",
    months: ["2026-10", "2026-12"],
    status: [{ month: "2026-10", tsukiokure: true, henrei: false, kago: false, kokuhoTarget: false }],
    memo: "★同一利用者が当月分(202612)と月遅れ分(202610)を持つ。別提供月で2本立つべき",
  },
  {
    tag: "R08", name: "再請求テスト08 当月のみ",
    months: ["2026-12"],
    status: [],
    memo: "当月分のみ。再請求には出ず、当月集計にだけ出る (対照群)",
  },
  {
    tag: "R09", name: "再請求テスト09 月遅れ2ヶ月",
    months: ["2026-10", "2026-11"],
    status: [
      { month: "2026-10", tsukiokure: true, henrei: false, kago: false, kokuhoTarget: false },
      { month: "2026-11", tsukiokure: true, henrei: false, kago: false, kokuhoTarget: false },
    ],
    memo: "2 ヶ月ぶん月遅れ。提供月ごとに別ファイル・別金額で出るべき",
  },
  {
    tag: "R10", name: "再請求テスト10 月遅れ+過誤",
    months: ["2026-11"],
    status: [{ month: "2026-11", tsukiokure: true, henrei: false, kago: true, kokuhoTarget: false,
      kagoDate: "2026-11-28", kagoCode: "1002", kagoDougetsu: false }],
    memo: "月遅れと過誤が同時に立つケース (理由は複数同時に立ちうる)",
  },
];

const daysIn = (mKey) => new Date(+mKey.slice(0, 4), +mKey.slice(5, 7), 0).getDate();

async function main() {
  console.log(`${EXECUTE ? "=== 本番投入 ===" : "=== DRY RUN (--execute で投入) ==="}`);
  console.log(`marker: ${MARKER} / 請求月: ${CURRENT_MONTH} / tenant: ${TENANT}`);
  console.log(`実績: 身体介護３ ${UNIT}単位 × ${JSON.stringify(VISITS_PER_MONTH)}\n`);

  // 0) 安全確認: 対象 3 ヶ月に既存実績が無いこと
  for (const mKey of Object.keys(VISITS_PER_MONTH)) {
    const { count, error } = await sb
      .from("kaigo_visit_schedule")
      .select("id", { count: "exact", head: true })
      .gte("visit_date", `${mKey}-01`)
      .lte("visit_date", `${mKey}-${daysIn(mKey)}`);
    if (error) throw new Error(`既存実績の確認に失敗 (${mKey}): ${error.message}`);
    console.log(`  ${mKey} の既存実績: ${count} 件 ${count === 0 ? "(OK)" : "(⚠ 0 件でない)"}`);
    if (count !== 0 && EXECUTE) throw new Error(`${mKey} に既存実績が ${count} 件あります。中止します`);
  }

  // 1) テスト事業所
  const { data: exOffice, error: ofErr } = await sb
    .from("offices").select("id, name").eq("name", OFFICE_NAME).maybeSingle();
  if (ofErr) throw new Error(`事業所の確認に失敗: ${ofErr.message}`);
  const officeId = exOffice?.id ?? randomUUID();
  console.log(exOffice ? `\n事業所: 既存を再利用 ${officeId}` : `\n事業所: 新規作成 ${officeId} (unit_price=11.05)`);

  const officeRow = {
    id: officeId, tenant_id: TENANT, name: OFFICE_NAME, service_type: "訪問介護",
    unit_price: 11.05, area_category: "3級地", applied_formula_codes: [],
    business_number: "9999999903", is_active: false,
    notes: `${MARKER} 月遅れ・過誤再請求の検証用。検証後に削除する`,
  };

  // 2) 各ケースの行を組み立て
  const clients = [], certs = [], assigns = [], scheds = [], statuses = [];
  const summary = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const clientId = randomUUID();
    const insured = `99200000${String(i + 1).padStart(2, "0")}`;
    clients.push({
      id: clientId, tenant_id: TENANT, user_number: `FAKERESEI-${c.tag}`,
      name: c.name, furigana: `ｻｲｾｲｷｭｳ${c.tag}`,
      address: `千葉市中央区テスト町3-${i + 1} ${MARKER}`,
      birth_date: "1937-03-03", gender: i % 2 === 0 ? "男" : "女",
      insured_number: insured, insurer_number: "121012",
      care_level: "要介護5", copay_rate: "1", status: "active",
      office_id: null, is_facility: false, is_provisional: false,
    });
    assigns.push({
      tenant_id: TENANT, client_id: clientId, office_id: officeId,
      start_date: "2026-04-01", service_notes: MARKER,
    });
    certs.push({
      tenant_id: TENANT, client_id: clientId, effective_date: "2026-04-01",
      insured_number: insured, care_level: "要介護5",
      certification_start_date: "2026-04-01", certification_end_date: "2027-03-31",
      insurer_number: "121012", insurer_name: "千葉市", copay_rate: "1",
      service_limit_amount: 36217, certification_status: "認定済み",
      record_status: "認定済み", notes: MARKER,
    });
    for (const mKey of c.months) {
      for (let d = 1; d <= VISITS_PER_MONTH[mKey]; d++) {
        scheds.push({
          tenant_id: TENANT, user_id: clientId, office_id: officeId,
          visit_date: `${mKey}-${String(d).padStart(2, "0")}`,
          service_type: "身体介護３",
          start_time: "09:00:00", end_time: "10:30:00",
          status: "completed", system: "介護", billable: true,
          kinkyu_houmon: false, notes: MARKER,
        });
      }
    }
    for (const s of c.status) {
      statuses.push({
        tenant_id: TENANT, office_id: officeId, client_id: clientId,
        target_month: s.month, issued_at: null,
        kokuho_target: s.kokuhoTarget, tsukiokure: s.tsukiokure,
        henrei: s.henrei, kago: s.kago,
        kago_moushitate_date: s.kagoDate ?? null,
        kago_jiyu_code: s.kagoCode ?? null,
        kago_dougetsu: s.kagoDougetsu ?? false,
        notes: MARKER,
      });
    }
    summary.push({
      tag: c.tag, clientId,
      months: c.months.join(","),
      status: c.status.map((s) => `${s.month}:${[s.tsukiokure && "月遅", s.henrei && "返戻", s.kago && "過誤"].filter(Boolean).join("+") || "なし"}${s.kokuhoTarget ? "/提出済" : ""}`).join(" "),
      memo: c.memo,
    });
  }

  console.log("\n投入予定:");
  console.table(summary.map((s) => ({ tag: s.tag, 実績月: s.months, フラグ: s.status || "(行なし)" })));
  console.log(`\n  offices                   ${exOffice ? 0 : 1} 件`);
  console.log(`  clients                   ${clients.length} 件`);
  console.log(`  client_insurance_records  ${certs.length} 件`);
  console.log(`  client_office_assignments ${assigns.length} 件`);
  console.log(`  kaigo_visit_schedule      ${scheds.length} 件`);
  console.log(`  kaigo_billing_status      ${statuses.length} 件`);

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
  await ins("client_office_assignments", assigns);
  await ins("kaigo_visit_schedule", scheds);
  await ins("kaigo_billing_status", statuses);

  // 件数確認 (CLAUDE.md 6.1: --execute 後に必ず verify)
  const { count: sc, error: e1 } = await sb.from("kaigo_visit_schedule")
    .select("id", { count: "exact", head: true }).eq("office_id", officeId);
  if (e1) throw new Error(`件数確認に失敗: ${e1.message}`);
  const { count: bc, error: e2 } = await sb.from("kaigo_billing_status")
    .select("id", { count: "exact", head: true }).eq("office_id", officeId);
  if (e2) throw new Error(`件数確認に失敗: ${e2.message}`);
  console.log(`\n件数確認: 実績 ${sc} 件 / billing_status ${bc} 件`);
  if (sc !== scheds.length || bc !== statuses.length) {
    throw new Error("投入件数が想定と一致しません");
  }

  const meta = { marker: MARKER, currentMonth: CURRENT_MONTH, officeId, unitPrice: 11.05,
    tenantId: TENANT, unit: UNIT, visitsPerMonth: VISITS_PER_MONTH, cases: summary };
  writeFileSync(new URL("./_fake_reseikyu_test_meta.json", import.meta.url),
    JSON.stringify(meta, null, 2) + "\n");
  console.log("メタ情報を migrations/_fake_reseikyu_test_meta.json に書き出しました");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
