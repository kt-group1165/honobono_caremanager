/**
 * 逓減制 ⅱ/ⅲ + 特定事業所加算Ⅰ/Ⅲ/A + 減算3種 サンプル (担当 J / マーカー ZT##)
 *
 *   node migrations/seed_sample_teigen_j.mjs             # DRY RUN (既定)
 *   node migrations/seed_sample_teigen_j.mjs --delete    # 撤去 (★先に確認すること)
 *   node migrations/seed_sample_teigen_j.mjs --execute   # 投入
 *
 * ── なぜ入れるか (2026-09-04 H の実測) ──────────────────────────────────
 *   居宅介護支援の実データ 5,597 行のうち:
 *     逓減制        ⅱ/ⅲ が ★ 0 件 (全部 ⅰ)
 *     特定事業所加算 Ⅰ/Ⅲ/A が ★ 0 件 (5,596行 全部Ⅱ)
 *     運営基準減算/BCP未策定/虐待防止未実施 ★ すべて 0 件
 *   → 5,597行あっても、実際に通っているのは「Ⅱ・ⅰ・減算なし」の1パターンだけ。
 *   下流 (集計→伝送 8124/7111) がこれらの値を正しく扱えるかは ★ 一度も検証されていない。
 *
 * ⚠ 予防(46) は対象外 — 本日 9678c7e/d2ab274 で既に別セットとして全PASS済み。
 *   重複を避けるためここには含めない。
 *
 * ⚠ 逓減 ⅱ/ⅲ を実データの事業所 (常勤換算4〜8) で発火させるには 45〜60名要り非現実的。
 *   ★ 隔離したテスト事業所を1件新規作成し、常勤換算数を小さく (0.2) 設定することで
 *   少人数で境界を越えさせる。offices は ★ 実在事業所を1バイトも変更しない
 *   (新規作成のみ。撤去時に丸ごと削除する)。
 *
 * 取り決め:
 *   対象月    2026-12 固定 (2026-06/07 は突合に使うので触らない)
 *   マーカー  clients.user_number = "ZT##" / name 末尾 "[sample-j]" /
 *            notes 末尾 "[sample-j-teigen-20260904]"
 *   事業所    ★ 新規1件のみ (offices.name に同マーカーを付け、撤去で丸ごと削除)
 *
 * ── 逓減 tier の割付け (常勤換算=0.2, 緩和なし → 閾値45/60) ──
 *   per = cumCount × 5 (cumCount = user_number 昇順の累積人数)
 *   ZT01-08 (cumCount 1-8,  per 5-40)  → ⅰ (パディング。要介護1 432111/1086)
 *   ZT09    (cumCount 9,  per45=境界) → ⅱ light 要介護2 433111/544
 *   ZT10    (cumCount10,  per50)      → ⅱ heavy 要介護4 433211/704
 *   ZT11    (cumCount11,  per55)      → ⅱ light 要介護1 433111/544 (追加点)
 *   ZT12    (cumCount12,  per60=境界) → ⅲ light 要介護2 434111/326
 *   ZT13    (cumCount13,  per65)      → ⅲ heavy 要介護5 434211/422
 *   ★ ここは claims-content.tsx の tier 判定アルゴリズムを再実行するのではなく、
 *     「tier が ⅱ/ⅲ の claim が既にある状態」を直接作り、下流 (集計/伝送) が
 *     正しく扱えるかを見る。tier 判定そのものは kyotaku-teigen-verify.mts /
 *     verify_teigen_logic.mts で別途検証済み。
 *
 * ── 特定事業所加算 Ⅰ/Ⅲ/A (基本コードは全員 ⅰ 要介護1 = 432111/1086 に固定) ──
 *   ZT14 Ⅰ 519単位 (434002) / ZT15 Ⅲ 323単位 (434004) / ZT16 A 114単位 (434006)
 *
 * ── 減算3種 (基本コードは全員 ⅰ 要介護1 = 432111/1086 に固定) ──
 *   ZT17 BCP未策定 1% → reductionUnitsOf(1086,1)=11単位減
 *   ZT18 虐待防止未実施 1% → 同上11単位減
 *   ZT19 運営基準減算 50% → reductionUnitsOf(1086,50)=543単位減
 *
 * ── 手計算した期待値 (単価 11.05 → ×100 = 1105。居宅介護支援費は10割給付) ──
 *   node で calcTotals/reductionUnitsOf を独立実装し二重検算済み (§検証は verify script 側)。
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const MARK = "[sample-j]";
const NOTE = "[sample-j-teigen-20260904]";
const OFFICE_NAME_MARK = "テスト逓減・加算事業所 [sample-j-teigen-20260904]";
const TENANT = "kt-group";
const MONTH = "2026-12";
const PREFIX = "ZT";
const OFFICE_BUSINESS_NUMBER = "9999900001";
const DELETE = process.argv.includes("--delete");
const EXECUTE = process.argv.includes("--execute");

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const UNIT_PRICE = 11.05; // 3級地

// calcTotals / reductionUnitsOf の写し (claims-shared.ts と式は同一。挙動検証は verify script 側)
function reductionUnitsOf(baseUnits, pct) {
  if (pct <= 0) return 0;
  return baseUnits - Math.round((baseUnits * (100 - pct)) / 100);
}
function calcTotals(baseUnits, addUnits, reductionUnits, unitPrice, shoguuPermil = 0) {
  const subtotal = baseUnits + addUnits - reductionUnits;
  const shoguu_units = shoguuPermil > 0 ? Math.round((subtotal * shoguuPermil) / 1000) : 0;
  const total_units = subtotal + shoguu_units;
  const total_amount = Math.floor(total_units * unitPrice);
  return { total_units, total_amount, shoguu_units };
}

// ───────────────────────── 撤去 (★ 先に用意する) ─────────────────────────
async function removeAll() {
  const { data: cs, error: e0 } = await sb
    .from("clients").select("id, name, user_number").like("user_number", `${PREFIX}%`);
  if (e0) throw new Error(`利用者の取得に失敗: ${e0.message}`);
  const ids = (cs ?? []).map((c) => c.id);
  console.log(`対象利用者: ${ids.length} 名 (user_number ${PREFIX}%)`);

  const { data: offs, error: eo } = await sb
    .from("offices").select("id, name").eq("name", OFFICE_NAME_MARK);
  if (eo) throw new Error(`事業所の取得に失敗: ${eo.message}`);
  const officeIds = (offs ?? []).map((o) => o.id);
  console.log(`対象事業所: ${officeIds.length} 件`);

  if (ids.length === 0 && officeIds.length === 0) { console.log("撤去対象なし"); return; }

  const clientScoped = [
    ["kaigo_care_support_claims", "user_id"],
    ["kaigo_care_plans", "user_id"],
    ["client_insurance_records", "client_id"],
    ["client_office_assignments", "client_id"],
  ];
  const counts = {};
  for (const [t, col] of clientScoped) {
    if (ids.length === 0) { counts[t] = 0; continue; }
    const { count, error } = await sb.from(t).select("id", { count: "exact", head: true }).in(col, ids);
    if (error) throw new Error(`${t} の件数取得に失敗: ${error.message}`);
    counts[t] = count ?? 0;
  }
  console.log("撤去対象:");
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(28)} ${n} 件`);
  console.log(`  ${"clients".padEnd(28)} ${ids.length} 件`);
  console.log(`  ${"offices".padEnd(28)} ${officeIds.length} 件`);

  if (!DELETE) { console.log("\n(--delete 指定時に実際に消します)"); return; }

  for (const [t, col] of clientScoped) {
    if (ids.length === 0) continue;
    const { error } = await sb.from(t).delete().in(col, ids);
    if (error) throw new Error(`${t} DELETE 失敗: ${error.message}`);
    console.log(`  ${t}: 削除`);
  }
  if (ids.length > 0) {
    const { error: ec } = await sb.from("clients").delete().in("id", ids);
    if (ec) throw new Error(`clients DELETE 失敗: ${ec.message}`);
    console.log("  clients: 削除");
  }
  if (officeIds.length > 0) {
    const { error: eod } = await sb.from("offices").delete().in("id", officeIds);
    if (eod) throw new Error(`offices DELETE 失敗: ${eod.message}`);
    console.log("  offices: 削除 (★ 新規作成したテスト事業所のみ。実在事業所は無関係)");
  }

  // 残存確認 (★ 分母つき。ルール 1-1)
  const { count: left, error: el } = await sb
    .from("clients").select("id", { count: "exact", head: true }).like("user_number", `${PREFIX}%`);
  if (el) throw new Error(`残存確認に失敗: ${el.message}`);
  const { count: leftAll, error: el1 } = await sb
    .from("clients").select("id", { count: "exact", head: true });
  if (el1) throw new Error(`残存確認に失敗: ${el1.message}`);
  const { count: leftOffice, error: el2 } = await sb
    .from("offices").select("id", { count: "exact", head: true }).eq("name", OFFICE_NAME_MARK);
  if (el2) throw new Error(`残存確認に失敗: ${el2.message}`);
  const { count: leftClaims, error: el3 } = await sb
    .from("kaigo_care_support_claims").select("id", { count: "exact", head: true })
    .eq("billing_month", MONTH).like("notes", `%${NOTE}%`);
  if (el3) throw new Error(`残存確認に失敗: ${el3.message}`);
  console.log(`\n残存: 利用者 ${left}/${leftAll} 名 / テスト事業所 ${leftOffice} 件 / 当サンプルのレセプト ${leftClaims} 件`);
  if (left !== 0 || leftOffice !== 0 || leftClaims !== 0) throw new Error("撤去しきれていません");
}

// ───────────────────────── ケース定義 ─────────────────────────
const TEIGEN = {
  "ⅰ_light": ["432111", 1086, "居宅介護支援Ⅰⅰ１"],
  "ⅱ_light": ["433111", 544, "居宅介護支援Ⅰⅱ１"],
  "ⅱ_heavy": ["433211", 704, "居宅介護支援Ⅰⅱ２"],
  "ⅲ_light": ["434111", 326, "居宅介護支援Ⅰⅲ１"],
  "ⅲ_heavy": ["434211", 422, "居宅介護支援Ⅰⅲ２"],
};

const CASES = [];
// ZT01-08: パディング ⅰ (cumCount 1-8, per 5-40)
for (let i = 1; i <= 8; i++) {
  CASES.push({ tag: `ZT${String(i).padStart(2, "0")}`, level: "要介護1", teigen: "ⅰ_light",
    memo: `逓減パディング (累積${i}名 = 45件/常勤換算0.2 中 per=${i * 5})` });
}
CASES.push({ tag: "ZT09", level: "要介護2", teigen: "ⅱ_light",
  memo: "★ 逓減ⅱ境界 (累積9名 = per=45 ちょうど。light)" });
CASES.push({ tag: "ZT10", level: "要介護4", teigen: "ⅱ_heavy",
  memo: "逓減ⅱ (累積10名 = per=50。heavy)" });
CASES.push({ tag: "ZT11", level: "要介護1", teigen: "ⅱ_light",
  memo: "逓減ⅱ追加点 (累積11名 = per=55。light)" });
CASES.push({ tag: "ZT12", level: "要介護2", teigen: "ⅲ_light",
  memo: "★ 逓減ⅲ境界 (累積12名 = per=60 ちょうど。light)" });
CASES.push({ tag: "ZT13", level: "要介護5", teigen: "ⅲ_heavy",
  memo: "逓減ⅲ (累積13名 = per=65。heavy)" });

// ZT14-16: 特定事業所加算 Ⅰ/Ⅲ/A (基本コードは全員ⅰ要介護1 に固定)
CASES.push({ tag: "ZT14", level: "要介護1", teigen: "ⅰ_light",
  tokutei: { type: "Ⅰ", units: 519, code: "434002" }, memo: "★ 特定事業所加算Ⅰ 519単位" });
CASES.push({ tag: "ZT15", level: "要介護1", teigen: "ⅰ_light",
  tokutei: { type: "Ⅲ", units: 323, code: "434004" }, memo: "★ 特定事業所加算Ⅲ 323単位" });
CASES.push({ tag: "ZT16", level: "要介護1", teigen: "ⅰ_light",
  tokutei: { type: "A", units: 114, code: "434006" }, memo: "★ 特定事業所加算A 114単位" });

// ZT17-19: 減算3種 (基本コードは全員ⅰ要介護1 に固定)
CASES.push({ tag: "ZT17", level: "要介護1", teigen: "ⅰ_light",
  bcp: { pct: 1 }, memo: "★ BCP未策定減算1% → 11単位減" });
CASES.push({ tag: "ZT18", level: "要介護1", teigen: "ⅰ_light",
  abuse: { pct: 1 }, memo: "★ 虐待防止未実施減算1% → 11単位減" });
CASES.push({ tag: "ZT19", level: "要介護1", teigen: "ⅰ_light",
  unei: true, memo: "★ 運営基準減算50% → 543単位減" });

const LIMIT = { 要介護1: 16765, 要介護2: 19705, 要介護3: 27048, 要介護4: 30938, 要介護5: 36217 };

async function main() {
  console.log(`${DELETE ? "=== 撤去 ===" : EXECUTE ? "=== 投入 ===" : "=== DRY RUN (--execute で投入 / --delete で撤去) ==="}`);
  console.log(`マーカー ${PREFIX}## ${MARK} / 対象月 ${MONTH} / 事業所 ${OFFICE_NAME_MARK}\n`);

  if (DELETE) { await removeAll(); return; }

  await removeAll(); // 既に自分のぶんが残っていれば件数を表示 (DELETE でないので消さない)

  const { count: existingOffice, error: eoc } = await sb
    .from("offices").select("id", { count: "exact", head: true }).eq("business_number", OFFICE_BUSINESS_NUMBER);
  if (eoc) throw new Error(`事業所番号の衝突確認に失敗: ${eoc.message}`);
  console.log(`事業所番号 ${OFFICE_BUSINESS_NUMBER} の既存件数: ${existingOffice} ${existingOffice === 0 ? "(OK)" : "(⚠ 衝突あり)"}`);

  const office = {
    id: randomUUID(),
    tenant_id: TENANT,
    name: OFFICE_NAME_MARK,
    designation_type: "介護保険",
    applied_formula_codes: [],
    auto_scope_no_expand: false,
    visit_procedure_mode: "standalone",
    care_support_shoguu_permil: 0, // 処遇改善は今回のテスト対象外。0で単純化
    business_number: OFFICE_BUSINESS_NUMBER,
    service_type: "居宅介護支援",
    area_category: "3級地",
    unit_price: UNIT_PRICE,
    is_active: true,
    caremane_jokin_kansan: 0.2, // ★ 小さく設定して少人数で逓減境界を越えさせる
    notes: NOTE,
  };

  const clients = [], certs = [], assigns = [], plans = [], claims = [];
  const summary = [];

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const clientId = randomUUID();
    const insured = `77${String(i + 1).padStart(8, "0")}`;
    const [code, baseUnits, codeName] = TEIGEN[c.teigen];

    clients.push({
      id: clientId, tenant_id: TENANT, user_number: c.tag,
      name: `逓減加算サンプル${c.tag} ${MARK}`, furigana: `テイゲンサンプル${c.tag}`,
      address: `千葉市若葉区サンプル町${i + 1} ${NOTE}`,
      birth_date: "1940-06-06", gender: i % 2 === 0 ? "女" : "男",
      insured_number: insured, insurer_number: "121012",
      care_level: c.level, copay_rate: "10", status: "active",
      office_id: null, is_facility: false, is_provisional: false,
    });
    assigns.push({ tenant_id: TENANT, client_id: clientId, office_id: office.id, start_date: "2026-04-01", service_notes: NOTE });
    certs.push({
      tenant_id: TENANT, client_id: clientId, effective_date: "2026-04-01",
      insured_number: insured, care_level: c.level,
      certification_start_date: "2026-04-01", certification_end_date: "2027-03-31",
      insurer_number: "121012", insurer_name: "千葉市", copay_rate: "1",
      service_limit_amount: LIMIT[c.level],
      certification_status: "認定済み", record_status: "認定済み", notes: NOTE,
    });
    plans.push({
      tenant_id: TENANT, user_id: clientId, status: "active",
      plan_type: "居宅サービス計画",
      start_date: "2026-04-01", end_date: "2027-03-31",
      plan_request_date: "2026-04-01", care_manager_number: "2812345678",
      care_manager_name: `サンプル担当 ${NOTE}`,
    });

    const addUnits = c.tokutei ? c.tokutei.units : 0;
    const reductionUnits = c.bcp ? reductionUnitsOf(baseUnits, c.bcp.pct)
      : c.abuse ? reductionUnitsOf(baseUnits, c.abuse.pct)
      : c.unei ? reductionUnitsOf(baseUnits, 50)
      : 0;
    const { total_amount, shoguu_units } = calcTotals(baseUnits, addUnits, reductionUnits, UNIT_PRICE, 0);

    claims.push({
      tenant_id: TENANT, user_id: clientId, billing_month: MONTH,
      care_support_code: code, care_support_name: codeName,
      units: baseUnits, unit_price: UNIT_PRICE, total_amount, insurance_amount: total_amount,
      initial_addition: false, initial_addition_units: 0,
      hospital_coordination: false, hospital_coordination_units: 0,
      discharge_addition: false, discharge_addition_units: 0, discharge_type: null,
      tokutei_kassan_type: c.tokutei ? c.tokutei.type : null,
      tokutei_kassan_units: c.tokutei ? c.tokutei.units : 0,
      terminal_care: false, terminal_care_units: 0,
      emergency_conference: false, emergency_conference_units: 0,
      medical_coordination: false, medical_coordination_units: 0,
      medical_coop_kassan: false, medical_coop_kassan_units: 0,
      bcp_not_prepared: !!c.bcp, bcp_reduction_pct: c.bcp ? c.bcp.pct : 0,
      abuse_prevention_not_implemented: !!c.abuse, abuse_reduction_pct: c.abuse ? c.abuse.pct : 0,
      unei_kijun_gensan: !!c.unei, unei_kijun_gensan_units: c.unei ? reductionUnits : 0,
      shoguu_kaizen_units: shoguu_units, shoguu_kaizen_code: null,
      status: "confirmed", insurer_number: "121012", insured_number: insured,
      notes: NOTE,
    });

    summary.push({
      tag: c.tag, 要介護度: c.level, 逓減: c.teigen, コード: code,
      基本: baseUnits, 加算: addUnits, 減算: reductionUnits, 総額: total_amount, memo: c.memo,
    });
  }

  console.log("\n投入予定 (期待値は手計算・node二重検算済み):");
  console.table(summary);
  console.log(`\n  offices                   1 (新規テスト事業所。実在事業所は無変更)`);
  console.log(`  clients                   ${clients.length}`);
  console.log(`  client_insurance_records  ${certs.length}`);
  console.log(`  client_office_assignments ${assigns.length}`);
  console.log(`  kaigo_care_plans          ${plans.length}`);
  console.log(`  kaigo_care_support_claims ${claims.length}`);

  if (!EXECUTE) { console.log("\nDRY RUN のため何も書き込んでいません。"); return; }

  const ins = async (table, rows) => {
    if (rows.length === 0) return;
    const { error } = await sb.from(table).insert(rows);
    if (error) throw new Error(`${table} INSERT 失敗: ${error.message}`);
    console.log(`  ${table}: ${rows.length} 件 INSERT`);
  };
  await ins("offices", [office]);
  await ins("clients", clients);
  await ins("client_insurance_records", certs);
  await ins("client_office_assignments", assigns);
  await ins("kaigo_care_plans", plans);
  await ins("kaigo_care_support_claims", claims);

  const { count: n1, error: v1 } = await sb.from("clients").select("id", { count: "exact", head: true }).like("user_number", `${PREFIX}%`);
  if (v1) throw new Error(`件数確認に失敗: ${v1.message}`);
  const { count: n2, error: v2 } = await sb.from("kaigo_care_support_claims")
    .select("id", { count: "exact", head: true }).eq("billing_month", MONTH).like("notes", `%${NOTE}%`);
  if (v2) throw new Error(`件数確認に失敗: ${v2.message}`);
  console.log(`\n件数確認: 利用者 ${n1} 名 / 当サンプルのレセプト ${n2} 件`);
  if (n1 !== clients.length || n2 !== claims.length) throw new Error("投入件数が想定と一致しません");
  console.log(`\n事業所 ${office.id} — 検証は scripts/teigen-sample-verify.mts`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
