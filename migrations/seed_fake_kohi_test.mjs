/**
 * 介護保険 公費併用の負担計算 検証用テストデータ投入
 *
 *   node migrations/seed_fake_kohi_test.mjs              # DRY RUN
 *   node migrations/seed_fake_kohi_test.mjs --execute    # 本番投入
 *
 * ⚠ 本番データには一切触らない。
 *   - 専用の事業所 (offices) を 1 つ新設し、そこに全テスト利用者を紐付ける
 *   - 対象月は 2026-12 (実績 0 件を実測で確認済み)
 *   - すべての行に marker `[fake テスト用-kohi-20260903]` を入れる
 *   - 削除は migrations/delete_fake_kohi_test.mjs
 *
 * 検証範囲 (限度額超過は別途 seed_fake_gendo_test.mjs で検証済みのため対象外。
 * 全ケースで限度額 36217 に対し 11340 単位 = 超過なし):
 *   - 法別番号ごとの部分公費 (21 精神通院 / 54 難病 / 19 被爆者) と 生保 (12) 全量振替
 *   - 本人負担上限月額 (honnin_futan) の境界: 0 / 中間 / 給付後負担ちょうど / 給付後負担超
 *   - 複数公費の併用カスケード (保険 → 公費1 → 公費2 → 本人) と充当順
 *   - 充当順の決定: 制度優先順位表 (KOHI_HOBETSU_RANK) と priority 手動指定の優先関係
 *   - 公費適用期間が月の一部の場合の期間按分 (月途中開始)
 *   - 2割負担 / 公費単独 (被保番 H 始まり = 10割公費)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const MARKER = "[fake テスト用-kohi-20260903]";
const TENANT = "kt-group";
const MONTH = "2026-12";
const DAYS_IN_MONTH = 31;
const OFFICE_NAME = `公費併用検証事業所 ${MARKER}`;
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
const UNITS = { 身体介護３: 567 };

/**
 * 全ケース共通の実績: 身体介護３ を 12/01〜12/20 に 1 日 1 回 = 20 回 (11340 単位)。
 * 公費の適用期間を月途中にしたケースだけ、期間内の訪問回数が変わる。
 * 単一サービス・1日1回に固定してあるのは、期間按分の期待値を目視で追えるようにするため。
 */
const VISIT_DAYS = Array.from({ length: 20 }, (_, i) => i + 1);

/**
 * 検証ケース。kohis は client_kohi_records に入れる行 (最大 2 = 併用)。
 * honnin = 本人負担上限月額 (介護券・受給者証の本人支払額)。
 */
const CASES = [
  {
    tag: "K01", name: "公費テスト01 精神通院", copay: "1",
    kohis: [{ hobetsu: "21", futansha: "21121012", jukyusha: "9910001", honnin: 0, from: "2026-01-01", to: null, priority: 1 }],
    memo: "法別21 (精神通院) 単独・本人負担上限0 → 給付後負担を全額公費",
  },
  {
    tag: "K02", name: "公費テスト02 難病2500", copay: "1",
    kohis: [{ hobetsu: "54", futansha: "54121010", jukyusha: "9910002", honnin: 2500, from: "2026-01-01", to: null, priority: 1 }],
    memo: "法別54 (難病) 単独・本人負担上限2500 → 2500 を本人、残りを公費",
  },
  {
    tag: "K03", name: "公費テスト03 被爆者上限超", copay: "1",
    kohis: [{ hobetsu: "19", futansha: "19121016", jukyusha: "9910003", honnin: 99999, from: "2026-01-01", to: null, priority: 1 }],
    memo: "法別19 (被爆者)・本人負担上限が給付後負担より大 → 公費請求 0 円 (境界)",
  },
  {
    tag: "K04", name: "公費テスト04 生保全量", copay: "1",
    kohis: [{ hobetsu: "12", futansha: "12121014", jukyusha: "9910004", honnin: 0, from: "2026-01-01", to: null, priority: 1 }],
    memo: "法別12 (生活保護) フル月・上限0 → 全量振替 (本人負担 0)",
  },
  {
    tag: "K05", name: "公費テスト05 生保5000", copay: "1",
    kohis: [{ hobetsu: "12", futansha: "12121014", jukyusha: "9910005", honnin: 5000, from: "2026-01-01", to: null, priority: 1 }],
    memo: "法別12 フル月・本人支払額5000 → 全量振替ブランチでも上限が効くか",
  },
  {
    tag: "K06", name: "公費テスト06 併用54+12", copay: "1",
    kohis: [
      { hobetsu: "12", futansha: "12121014", jukyusha: "9910006", honnin: 0, from: "2026-01-01", to: null, priority: 1 },
      { hobetsu: "54", futansha: "54121010", jukyusha: "9910006", honnin: 0, from: "2026-01-01", to: null, priority: 1 },
    ],
    memo: "併用 54+12 (priority 同値)。生保は他法優先で最劣後 → 公費1=54 / 公費2=12",
  },
  {
    tag: "K07", name: "公費テスト07 併用54上限+12", copay: "1",
    kohis: [
      { hobetsu: "12", futansha: "12121014", jukyusha: "9910007", honnin: 0, from: "2026-01-01", to: null, priority: 1 },
      { hobetsu: "54", futansha: "54121010", jukyusha: "9910007", honnin: 3000, from: "2026-01-01", to: null, priority: 1 },
    ],
    memo: "★実務の典型: 難病(上限3000)+生保。54 で残った本人負担3000を生保が引き取る → 本人 0",
  },
  {
    tag: "K08", name: "公費テスト08 併用21+54", copay: "1",
    kohis: [
      { hobetsu: "54", futansha: "54121010", jukyusha: "9910008", honnin: 1000, from: "2026-01-01", to: null, priority: 1 },
      { hobetsu: "21", futansha: "21121012", jukyusha: "9910008", honnin: 2000, from: "2026-01-01", to: null, priority: 1 },
    ],
    memo: "併用 21+54 (どちらも生保でない)。優先順位表で 21(20) < 54(50) → 公費1=21。本人 1000 残る",
  },
  {
    tag: "K09", name: "公費テスト09 priority上書き", copay: "1",
    kohis: [
      { hobetsu: "12", futansha: "12121014", jukyusha: "9910009", honnin: 0, from: "2026-01-01", to: null, priority: 1 },
      { hobetsu: "54", futansha: "54121010", jukyusha: "9910009", honnin: 0, from: "2026-01-01", to: null, priority: 2 },
    ],
    memo: "priority を手動指定 (12=1 / 54=2) → 優先順位表を上書きして 公費1=12 になるか",
  },
  {
    tag: "K10", name: "公費テスト10 期間按分", copay: "1",
    kohis: [{ hobetsu: "54", futansha: "54121010", jukyusha: "9910010", honnin: 0, from: "2026-12-11", to: null, priority: 1 }],
    memo: "法別54 が 12/11 開始 → 20回中10回 (12/11〜12/20) だけ公費対象。按分",
  },
  {
    tag: "K11", name: "公費テスト11 2割負担", copay: "2",
    kohis: [{ hobetsu: "54", futansha: "54121010", jukyusha: "9910011", honnin: 0, from: "2026-01-01", to: null, priority: 1 }],
    memo: "2割負担 + 法別54・上限0 → 給付後負担が倍になり全額公費",
  },
  {
    tag: "K12", name: "公費テスト12 公費単独", copay: "1", insuredPrefix: "H",
    kohis: [{ hobetsu: "12", futansha: "12121014", jukyusha: "9910012", honnin: 0, from: "2026-01-01", to: null, priority: 1 }],
    memo: "被保番 H 始まり = 公費単独 (10割公費)。保険請求 0 / 公費 = 総額",
  },
  {
    tag: "K13", name: "公費テスト13 按分+上限", copay: "1",
    kohis: [{ hobetsu: "54", futansha: "54121010", jukyusha: "9910013", honnin: 1000, from: "2026-12-08", to: null, priority: 1 }],
    memo: "法別54 が 12/08 開始 (13回) + 本人負担上限1000。按分と上限の複合",
  },
  {
    tag: "K14", name: "公費テスト14 併用+公費2按分", copay: "1",
    kohis: [
      { hobetsu: "12", futansha: "12121014", jukyusha: "9910014", honnin: 0, from: "2026-12-11", to: null, priority: 1 },
      { hobetsu: "54", futansha: "54121010", jukyusha: "9910014", honnin: 0, from: "2026-01-01", to: null, priority: 1 },
    ],
    memo: "公費1=54 フル月 / 公費2=12 が 12/11 開始。公費1で使い切り 公費2=0 (恒等式が壊れないか)",
  },
  {
    tag: "K15", name: "公費テスト15 上限ちょうど", copay: "1",
    kohis: [{ hobetsu: "54", futansha: "54121010", jukyusha: "9910015", honnin: 12531, from: "2026-01-01", to: null, priority: 1 }],
    memo: "本人負担上限 = 給付後負担 12531 ちょうど (境界) → 公費 0 / 本人 12531",
  },
];

const grossUnits = UNITS.身体介護３ * VISIT_DAYS.length;

async function main() {
  console.log(`${EXECUTE ? "=== 本番投入 ===" : "=== DRY RUN (--execute で投入) ==="}`);
  console.log(`marker: ${MARKER} / 対象月: ${MONTH} / tenant: ${TENANT}`);
  console.log(`共通実績: 身体介護３ ${VISIT_DAYS.length} 回 (12/01〜12/20) = ${grossUnits} 単位\n`);

  // 0) 安全確認: 対象月に既存実績が無いこと
  const { count: existing, error: exErr } = await sb
    .from("kaigo_visit_schedule")
    .select("id", { count: "exact", head: true })
    .gte("visit_date", `${MONTH}-01`)
    .lte("visit_date", `${MONTH}-${DAYS_IN_MONTH}`);
  if (exErr) throw new Error(`既存実績の確認に失敗: ${exErr.message}`);
  console.log(`対象月の既存実績: ${existing} 件 ${existing === 0 ? "(OK)" : "(⚠ 0 件でない)"}`);
  if (existing !== 0 && EXECUTE) {
    throw new Error(`対象月 ${MONTH} に既存実績が ${existing} 件あります。中止します`);
  }

  // 1) テスト事業所
  const { data: exOffice, error: ofErr } = await sb
    .from("offices").select("id, name").eq("name", OFFICE_NAME).maybeSingle();
  if (ofErr) throw new Error(`事業所の確認に失敗: ${ofErr.message}`);
  const officeId = exOffice?.id ?? randomUUID();
  console.log(exOffice ? `事業所: 既存を再利用 ${officeId}` : `事業所: 新規作成 ${officeId} (unit_price=11.05)`);

  const officeRow = {
    id: officeId, tenant_id: TENANT, name: OFFICE_NAME, service_type: "訪問介護",
    unit_price: 11.05, area_category: "3級地", applied_formula_codes: [],
    business_number: "9999999902", is_active: false,
    notes: `${MARKER} 公費併用の負担計算 検証用。検証後に削除する`,
  };

  // 2) 各ケースの行を組み立て
  const clients = [], certs = [], kohis = [], assigns = [], scheds = [];
  const summary = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const clientId = randomUUID();
    const insured = `${c.insuredPrefix ?? ""}99100000${String(i + 1).padStart(2, "0")}`;
    clients.push({
      id: clientId, tenant_id: TENANT, user_number: `FAKEKOHI-${c.tag}`,
      name: c.name, furigana: `ｺｳﾋﾃｽﾄ${c.tag}`,
      address: `千葉市中央区テスト町2-${i + 1} ${MARKER}`,
      birth_date: "1938-05-05", gender: i % 2 === 0 ? "女" : "男",
      insured_number: insured, insurer_number: "121012",
      care_level: "要介護5", copay_rate: c.copay, status: "active",
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
      insurer_number: "121012", insurer_name: "千葉市", copay_rate: c.copay,
      // 限度額 36217 (要介護5) — 11340 単位なので全ケース超過なし
      service_limit_amount: 36217, certification_status: "認定済み",
      record_status: "認定済み", notes: MARKER,
    });
    for (const k of c.kohis) {
      kohis.push({
        tenant_id: TENANT, client_id: clientId, kohi_hobetsu: k.hobetsu,
        futansha_number: k.futansha, jukyusha_number: k.jukyusha,
        start_date: k.from, end_date: k.to, priority: k.priority,
        honnin_futan: k.honnin, notes: MARKER,
      });
    }
    for (const day of VISIT_DAYS) {
      scheds.push({
        tenant_id: TENANT, user_id: clientId, office_id: officeId,
        visit_date: `${MONTH}-${String(day).padStart(2, "0")}`,
        service_type: "身体介護３",
        start_time: "09:00:00", end_time: "10:30:00",
        status: "completed", system: "介護", billable: true,
        kinkyu_houmon: false, notes: MARKER,
      });
    }
    summary.push({
      tag: c.tag, clientId, copay: c.copay,
      kohi: c.kohis.map((k) => `${k.hobetsu}(上限${k.honnin}${k.from > `${MONTH}-01` ? `/${k.from}〜` : ""}${k.priority !== 1 ? `/pri${k.priority}` : ""})`).join(" + "),
      tandoku: !!c.insuredPrefix, memo: c.memo,
    });
  }

  console.log("\n投入予定:");
  console.table(summary.map((s) => ({ tag: s.tag, 負担: s.copay, 公費: s.kohi, 公費単独: s.tandoku ? "○" : "" })));
  console.log(`\n  offices                   ${exOffice ? 0 : 1} 件`);
  console.log(`  clients                   ${clients.length} 件`);
  console.log(`  client_insurance_records  ${certs.length} 件`);
  console.log(`  client_kohi_records       ${kohis.length} 件`);
  console.log(`  client_office_assignments ${assigns.length} 件`);
  console.log(`  kaigo_visit_schedule      ${scheds.length} 件`);

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
  await ins("kaigo_visit_schedule", scheds);

  // 件数確認 (CLAUDE.md 6.1: --execute 後に必ず verify)
  const { count: schedCount, error: e1 } = await sb.from("kaigo_visit_schedule")
    .select("id", { count: "exact", head: true }).eq("office_id", officeId);
  if (e1) throw new Error(`件数確認に失敗: ${e1.message}`);
  const { count: cliCount, error: e2 } = await sb.from("clients")
    .select("id", { count: "exact", head: true }).like("user_number", "FAKEKOHI-%");
  if (e2) throw new Error(`件数確認に失敗: ${e2.message}`);
  const { count: kohiCount, error: e3 } = await sb.from("client_kohi_records")
    .select("id", { count: "exact", head: true }).eq("notes", MARKER);
  if (e3) throw new Error(`件数確認に失敗: ${e3.message}`);
  console.log(`\n件数確認: 実績 ${schedCount} 件 / 利用者 ${cliCount} 名 / 公費 ${kohiCount} 件`);
  if (schedCount !== scheds.length || cliCount !== clients.length || kohiCount !== kohis.length) {
    throw new Error("投入件数が想定と一致しません。データを確認してください");
  }

  const meta = { marker: MARKER, month: MONTH, officeId, unitPrice: 11.05, tenantId: TENANT,
    grossUnits, visits: VISIT_DAYS.length, cases: summary };
  writeFileSync(new URL("./_fake_kohi_test_meta.json", import.meta.url),
    JSON.stringify(meta, null, 2) + "\n");
  console.log("メタ情報を migrations/_fake_kohi_test_meta.json に書き出しました");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
