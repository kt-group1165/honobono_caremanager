/**
 * 介護予防支援 (46xxxx) サンプルデータ (担当 J / マーカー ZP##) — SAMPLE_DATA_PROTOCOL.md 準拠
 *
 *   node migrations/seed_sample_yobo_j.mjs             # DRY RUN (既定)
 *   node migrations/seed_sample_yobo_j.mjs --delete    # 撤去
 *   node migrations/seed_sample_yobo_j.mjs --execute   # 投入
 *
 * 取り決め:
 *   対象月    2026-12 固定 (2026-06/07 は突合に使うので触らない)
 *   マーカー  clients.user_number = "ZP##" / name 末尾 "[sample-j]" / notes 末尾 "[sample-j-yobo-20260903]"
 *   事業所    ★ 実在の Ｈａｎａ居宅支援センター高品 を **読むだけ**。
 *            ★ offices / office_service_designations は 1 バイトも変更しない
 *            (46 の事業所番号は純関数 buildKeikakuhiFile の引数で渡して検証する)
 *   prefix    居宅サンプル (ZJ##) と混ざらないよう ZP## を使う。削除も ZP% だけ
 *
 * ── なぜこれを入れるか (2026-09-03 実測) ──
 *   要支援の認定は 2,968 行あるが、**有効ケアプランを持つ要支援者は 15 事業所すべて 0 名**。
 *   予防マーカー付きレセプト 0 件 / office_service_designations は ★ 表ごと 0 行。
 *   → 介護予防支援の経路は **一度も通っていない**。サンプルで初めて通す。
 *
 * ── 手計算した期待値 (単価 11.05 → ×100 = 1105。介護予防支援も 10割給付) ──
 *   総額 = floor(Σ単位 × 1105 / 100)
 *   ZP01 要支援1 Ⅱ 472        → 5,215     ZP02 要支援2 Ⅰ 442        → 4,884
 *   ZP03 要支援2 委託 0        → ★ 伝送から除外されるべき (0 円)
 *   ZP04 要支援1 Ⅱ+初回300 772 → 8,530    ★ 加算コードが 46 系か 43 系かを見る
 *   ZP05 要介護1 1086          → 12,000    (同月に 43 と 46 が混在することの確認)
 *
 * ⚠ この seed が検証しないこと: 逓減制 (予防は対象外) / 委託連携加算 / 予防の処遇改善加算
 *   (後 2 者はコードがマスタに在るが実装が無い — verify 側で「未実装」として報告する)
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const MARK = "[sample-j]";
const NOTE = "[sample-j-yobo-20260903]";
const TENANT = "kt-group";
const MONTH = "2026-12";
const PREFIX = "ZP";
const OFFICE_NAME = "Ｈａｎａ居宅支援センター高品";
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

// 予防区分マーカー (claims-shared.ts YOBO_SHIEN_MARKER と同じ文字列)
const YOBO_MARKER = { I: "[予防支援:Ⅰ]", II: "[予防支援:Ⅱ]", itaku: "[予防支援:委託]" };

// ───────────────────────── 撤去 (★ 先に用意する) ─────────────────────────
async function removeAll() {
  const { data: cs, error: e0 } = await sb
    .from("clients").select("id, name, user_number").like("user_number", `${PREFIX}%`);
  if (e0) throw new Error(`利用者の取得に失敗: ${e0.message}`);
  const ids = (cs ?? []).map((c) => c.id);
  console.log(`対象利用者: ${ids.length} 名 (user_number ${PREFIX}%)`);
  if (ids.length === 0) { console.log("撤去対象なし"); return; }

  const targets = [
    ["kaigo_care_support_claims", "user_id"],
    ["kaigo_benefit_management", "user_id"],
    ["kaigo_care_plans", "user_id"],
    ["client_insurance_records", "client_id"],
    ["client_office_assignments", "client_id"],
  ];
  const counts = {};
  for (const [t, col] of targets) {
    const { count, error } = await sb.from(t).select("id", { count: "exact", head: true }).in(col, ids);
    if (error) throw new Error(`${t} の件数取得に失敗: ${error.message}`);
    counts[t] = count ?? 0;
  }
  console.log("撤去対象:");
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(28)} ${n} 件`);
  console.log(`  ${"clients".padEnd(28)} ${ids.length} 件`);

  if (!DELETE) { console.log("\n(--delete 指定時に実際に消します)"); return; }
  for (const [t, col] of targets) {
    const { error } = await sb.from(t).delete().in(col, ids);
    if (error) throw new Error(`${t} DELETE 失敗: ${error.message}`);
    console.log(`  ${t}: 削除`);
  }
  const { error: ec } = await sb.from("clients").delete().in("id", ids);
  if (ec) throw new Error(`clients DELETE 失敗: ${ec.message}`);
  console.log("  clients: 削除");

  // 残存確認 (★ 分母つき。ルール 1-1)
  const { count: left, error: el } = await sb
    .from("clients").select("id", { count: "exact", head: true }).like("user_number", `${PREFIX}%`);
  if (el) throw new Error(`残存確認に失敗: ${el.message}`);
  const { count: leftAll, error: el1 } = await sb
    .from("clients").select("id", { count: "exact", head: true });
  if (el1) throw new Error(`残存確認に失敗: ${el1.message}`);
  const { count: leftClaims, error: el2 } = await sb
    .from("kaigo_care_support_claims").select("id", { count: "exact", head: true })
    .eq("billing_month", MONTH).like("notes", `%${NOTE}%`);
  if (el2) throw new Error(`残存確認に失敗: ${el2.message}`);
  console.log(`\n残存: 利用者 ${left}/${leftAll} 名 / ${MONTH} の当サンプルのレセプト ${leftClaims} 件`);
  if (left !== 0 || leftClaims !== 0) throw new Error("撤去しきれていません");
}

// ───────────────────────── ケース定義 ─────────────────────────
// R8.6〜 世代 (2026-12 に有効): 462111 介護予防支援Ⅰ 442 / 462121 介護予防支援Ⅱ 472
const YOBO = { I: ["462111", 442, "介護予防支援Ⅰ"], II: ["462121", 472, "介護予防支援Ⅱ"] };
const KAIGO_BASE = { 要介護1: ["432111", 1086], 要介護2: ["432111", 1086] };

const CASES = [
  { tag: "ZP01", name: "予防サンプル01 要支援1 区分Ⅱ", level: "要支援1", kubun: "II",
    // 給付管理票 (8222) も予防で組めるかを見る。予防のサービス種類コードは 6x 系
    kyufu: [
      { name: "介護予防通所リハビリテーション", number: "1279999066", kind: "66", units: 2268 },
      { name: "介護予防福祉用具貸与", number: "1279999067", kind: "67", units: 300 },
    ],
    memo: "居宅介護支援事業所が直接指定 (最多ケース) + 給付管理2行" },
  { tag: "ZP02", name: "予防サンプル02 要支援2 区分Ⅰ", level: "要支援2", kubun: "I",
    kyufu: [{ name: "介護予防訪問看護", number: "1279999063", kind: "63", units: 4500 }],
    memo: "地域包括支援センターとして請求 (442単位) + 給付管理1行" },
  { tag: "ZP03", name: "予防サンプル03 要支援2 委託", level: "要支援2", kubun: "itaku", zero: true,
    memo: "★ 包括が請求 = 伝送から除外されるべき 0 単位行" },
  { tag: "ZP04", name: "予防サンプル04 要支援1 初回加算", level: "要支援1", kubun: "II",
    initial: 300, memo: "★ 加算コードが 46 系 (464001) か 43 系 (434001) かを見る" },
  { tag: "ZP05", name: "予防サンプル05 要介護1 混在", level: "要介護1", kubun: null,
    memo: "同月に 43 と 46 が混ざる (パーティションの確認)" },
  // ★ 月途中の区分変更。居宅介護支援費/介護予防支援費 は **月額** なので月末時点の
  //   区分で 1 本だけ請求する = 46 ではなく 43 に出るのが正。
  //   (保険者変更 (転居) は 1人2レセプトになるが、区分変更は 1 本。別物)
  { tag: "ZP06", name: "予防サンプル06 要支援2→要介護2", level: "要介護2", kubun: null,
    midChange: { from: "要支援2", boundary: "2026-12-16" },
    memo: "★ 月途中の区分変更 = 月末時点 (要介護2) で 43 側に 1 本" },
];

const LIMIT = { 要支援1: 5032, 要支援2: 10531, 要介護1: 16765, 要介護2: 19705 };

async function main() {
  console.log(`${DELETE ? "=== 撤去 ===" : EXECUTE ? "=== 投入 ===" : "=== DRY RUN (--execute で投入 / --delete で撤去) ==="}`);
  console.log(`マーカー ${PREFIX}## ${MARK} / 対象月 ${MONTH} / 事業所 ${OFFICE_NAME}\n`);

  if (DELETE) { await removeAll(); return; }

  const { data: office, error: oe } = await sb
    .from("offices").select("id, name, business_number, unit_price, area_category")
    .eq("name", OFFICE_NAME).maybeSingle();
  if (oe) throw new Error(`事業所の取得に失敗: ${oe.message}`);
  if (!office) throw new Error(`事業所 "${OFFICE_NAME}" が見つかりません`);
  console.log(`事業所: ${office.name} / ${office.business_number} / 単価 ${office.unit_price} / ${office.area_category}`);

  // ★ 46 の事業所番号が本当に無いことを確認 (verify の前提)
  const { count: desig, error: de } = await sb
    .from("office_service_designations").select("id", { count: "exact", head: true });
  if (de) throw new Error(`office_service_designations の確認に失敗: ${de.message}`);
  console.log(`office_service_designations: 全 ${desig} 行 ${desig === 0 ? "(★ 46番号は画面から出せない = 既知)" : ""}`);

  const { count: existing, error: ee } = await sb
    .from("kaigo_care_support_claims").select("id", { count: "exact", head: true }).eq("billing_month", MONTH);
  if (ee) throw new Error(`既存レセプトの確認に失敗: ${ee.message}`);
  console.log(`${MONTH} の既存レセプト: ${existing} 件 (他セッションのサンプルが居ることがある)`);

  await removeAll();

  const P100 = Math.round(office.unit_price * 100);
  const clients = [], certs = [], assigns = [], plans = [], claims = [], kyufu = [];
  const summary = [];

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const clientId = randomUUID();
    const insured = `77${String(i + 1).padStart(8, "0")}`;
    const isYobo = c.level.startsWith("要支援");
    const [code, baseUnits, codeName] = isYobo ? YOBO[c.kubun === "itaku" ? "II" : c.kubun] : [...KAIGO_BASE[c.level], `居宅介護支援費(${c.level})`];
    const units = c.zero ? 0 : baseUnits;
    const sum = units + (c.initial ?? 0);
    const total = Math.floor((sum * P100) / 100);

    clients.push({
      id: clientId, tenant_id: TENANT, user_number: c.tag,
      name: `${c.name} ${MARK}`, furigana: `ﾖﾎﾞｳｻﾝﾌﾟﾙ${c.tag}`,
      address: `千葉市若葉区サンプル町${i + 1} ${NOTE}`,
      birth_date: "1944-04-04", gender: i % 2 === 0 ? "女" : "男",
      insured_number: insured, insurer_number: "121012",
      care_level: c.level,
      // ⚠ clients は "10"/"20"/"30" (percent)、認定は "1"/"2"/"3" (割) と規約が違う
      //   (memory: feedback_... / 2026-09-03 に共通 seed でも同じ取り違えが出た)
      copay_rate: "10", status: "active",
      office_id: null, is_facility: false, is_provisional: false,
    });
    assigns.push({ tenant_id: TENANT, client_id: clientId, office_id: office.id, start_date: "2026-04-01", service_notes: NOTE });
    const mkCert = (level, start, end) => ({
      tenant_id: TENANT, client_id: clientId, effective_date: start,
      insured_number: insured, care_level: level,
      certification_start_date: start, certification_end_date: end,
      insurer_number: "121012", insurer_name: "千葉市", copay_rate: "1",
      service_limit_amount: LIMIT[level],
      certification_status: "認定済み", record_status: "認定済み", notes: NOTE,
    });
    if (c.midChange) {
      // 月途中の区分変更: 前半 要支援2 / 後半 要介護2。月末時点 = 要介護2 が採られるはず
      const b = c.midChange.boundary;
      const prevEnd = new Date(Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10) - 1))
        .toISOString().slice(0, 10);
      certs.push(mkCert(c.midChange.from, "2026-04-01", prevEnd));
      certs.push(mkCert(c.level, b, "2027-03-31"));
    } else {
      certs.push(mkCert(c.level, "2026-04-01", "2027-03-31"));
    }
    // 8124 項15 計画作成依頼届出年月日 / 介護支援専門員番号 は kaigo_care_plans から
    // ⚠ kaigo_care_plans に notes 列は無い。マーカーは care_manager_name に入れる
    //   (撤去は user_id で引くので、識別用の印は付けなくても消せる)
    plans.push({
      tenant_id: TENANT, user_id: clientId, status: "active",
      plan_type: isYobo ? "介護予防サービス計画" : "居宅サービス計画",
      start_date: "2026-04-01", end_date: "2027-03-31",
      plan_request_date: "2026-04-01", care_manager_number: "2812345678",
      care_manager_name: `サンプル担当 ${NOTE}`,
    });

    const noteParts = [NOTE];
    if (c.kubun) noteParts.push(YOBO_MARKER[c.kubun]);
    claims.push({
      tenant_id: TENANT, user_id: clientId, billing_month: MONTH,
      care_support_code: code, care_support_name: codeName,
      units, unit_price: office.unit_price, total_amount: total, insurance_amount: total,
      initial_addition: !!c.initial, initial_addition_units: c.initial ?? 0,
      hospital_coordination: false, hospital_coordination_units: 0,
      discharge_addition: false, discharge_addition_units: 0, discharge_type: null,
      tokutei_kassan_type: null, tokutei_kassan_units: 0,
      terminal_care: false, terminal_care_units: 0,
      unei_kijun_gensan: false, unei_kijun_gensan_units: 0,
      shoguu_kaizen_units: 0, shoguu_kaizen_code: null,
      status: "confirmed", insurer_number: "121012", insured_number: insured,
      notes: noteParts.join("\n"),
    });

    for (const k of c.kyufu ?? []) {
      kyufu.push({ tenant_id: TENANT, user_id: clientId, billing_month: MONTH,
        service_type: k.name, provider_name: k.name, provider_number: k.number,
        service_kind_code: k.kind, planned_units: k.units, actual_units: k.units,
        over_limit_units: 0, status: "confirmed" });
    }

    summary.push({
      tag: c.tag, 要介護度: c.level, 区分: c.kubun ?? "(要介護)",
      コード: code, Σ単位: sum, 期待総額: total, memo: c.memo,
    });
  }

  console.log("\n投入予定 (期待値は手計算):");
  console.table(summary);
  console.log(`\n  clients                   ${clients.length}`);
  console.log(`  client_insurance_records  ${certs.length}`);
  console.log(`  client_office_assignments ${assigns.length}`);
  console.log(`  kaigo_care_plans          ${plans.length}`);
  console.log(`  kaigo_care_support_claims ${claims.length}`);
  console.log(`  kaigo_benefit_management  ${kyufu.length}  (★ key は user_id)`);

  if (!EXECUTE) { console.log("\nDRY RUN のため何も書き込んでいません。"); return; }

  const ins = async (table, rows) => {
    if (rows.length === 0) return;
    const { error } = await sb.from(table).insert(rows);
    if (error) throw new Error(`${table} INSERT 失敗: ${error.message}`);
    console.log(`  ${table}: ${rows.length} 件 INSERT`);
  };
  await ins("clients", clients);
  await ins("client_insurance_records", certs);
  await ins("client_office_assignments", assigns);
  await ins("kaigo_care_plans", plans);
  await ins("kaigo_care_support_claims", claims);
  await ins("kaigo_benefit_management", kyufu);

  const { count: n1, error: v1 } = await sb.from("clients").select("id", { count: "exact", head: true }).like("user_number", `${PREFIX}%`);
  if (v1) throw new Error(`件数確認に失敗: ${v1.message}`);
  const { count: n2, error: v2 } = await sb.from("kaigo_care_support_claims")
    .select("id", { count: "exact", head: true }).eq("billing_month", MONTH).like("notes", `%${NOTE}%`);
  if (v2) throw new Error(`件数確認に失敗: ${v2.message}`);
  console.log(`\n件数確認: 利用者 ${n1} 名 / 当サンプルのレセプト ${n2} 件`);
  if (n1 !== clients.length || n2 !== claims.length) throw new Error("投入件数が想定と一致しません");
  console.log(`\n事業所 ${office.id} — 検証は scripts/yobo-sample-verify.mts`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
