/**
 * 居宅介護支援 サンプルデータ (担当 J / マーカー j) — SAMPLE_DATA_PROTOCOL.md 準拠
 *
 *   node migrations/seed_sample_kyotaku_j.mjs             # DRY RUN (既定)
 *   node migrations/seed_sample_kyotaku_j.mjs --delete    # 撤去 (★先に確認すること)
 *   node migrations/seed_sample_kyotaku_j.mjs --execute   # 投入
 *
 * 取り決め:
 *   対象月    2026-12 固定 (2026-06/07 は突合に使うので触らない)
 *   マーカー  clients.user_number = "ZJ###" / name 末尾 "[sample-j]" / notes 末尾 "[sample-j-20260903]"
 *   事業所    ★ 実在の Ｈａｎａ居宅支援センター高品 (1270404229 / 単価11.05 / 3級地) を使う。
 *            offices は 1 バイトも変更しない (読むだけ)
 *
 * 検証は scripts/kyotaku-sample-verify.mts (段1 算定・段2 様式) で行う。
 *
 * ── 手計算した期待値 (単価 11.05 → ×100 = 1105。居宅介護支援費は10割給付) ──
 *   総額 = floor(Σ単位 × 1105 / 100)   保険請求額 = 総額 (利用者負担なし)
 *   ZJ001 要介護1 1086        → 12,000    ZJ002 要介護3 1411        → 15,591
 *   ZJ003 +初回300 1386       → 15,315    ZJ004 +特定Ⅱ421+処遇38 1870 → 20,663
 *   ZJ005 +入院連携Ⅰ250 1661  → 18,354    ZJ006 +退院退所450 1536    → 16,972
 *   ZJ007 ★ターミナルのみ 408  →  4,508    ZJ008 公費併用 1086        → 12,000
 *   ZJ009 公費単独 1411       → 15,591    ZJ010 ★転居 (1人2レセプト)
 *   ZJ011 運営基準減算50% 543  →  6,000    ZJ012 給付管理 複数事業所
 *
 * ⚠ 負担割合 (1/2/3割) は居宅介護支援費が **10割給付** のため金額に影響しない。
 *   様式には 項29 保険給付率として出るので 1割/2割/3割 の利用者を混ぜてある。
 * ⚠ 要支援1・2 は 介護予防支援 (46xxxx) で別サービス・国保連を通らないため対象外
 *   (担当 32 のスコープ)。
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const MARK = "[sample-j]";
const NOTE = "[sample-j-20260903]";
const TENANT = "kt-group";
const MONTH = "2026-12";
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

// ───────────────────────── 撤去 (★ 先に用意する) ─────────────────────────
async function removeAll() {
  const { data: cs, error: e0 } = await sb
    .from("clients").select("id, name, user_number").like("user_number", "ZJ%");
  if (e0) throw new Error(`利用者の取得に失敗: ${e0.message}`);
  const ids = (cs ?? []).map((c) => c.id);
  console.log(`対象利用者: ${ids.length} 名 (user_number ZJ%)`);
  if (ids.length === 0) { console.log("撤去対象なし"); return; }

  const targets = [
    ["kaigo_care_support_claims", "user_id"],
    ["kaigo_benefit_management", "user_id"],
    ["client_kohi_records", "client_id"],
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

  // 残存確認 (分母つき)
  const { count: left, error: el } = await sb
    .from("clients").select("id", { count: "exact", head: true }).like("user_number", "ZJ%");
  if (el) throw new Error(`残存確認に失敗: ${el.message}`);
  const { count: leftClaims, error: el2 } = await sb
    .from("kaigo_care_support_claims").select("id", { count: "exact", head: true }).eq("billing_month", MONTH);
  if (el2) throw new Error(`残存確認に失敗: ${el2.message}`);
  console.log(`\n残存: 利用者 ${left} 名 / ${MONTH} のレセプト ${leftClaims} 件`);
  if (left !== 0) throw new Error("撤去しきれていません");
}

// ───────────────────────── ケース定義 ─────────────────────────
/** 基本コード: 432111 = 要介護1・2 (1086) / 432211 = 要介護3-5 (1411) */
const BASE = { 要介護1: ["432111", 1086], 要介護2: ["432111", 1086], 要介護3: ["432211", 1411], 要介護4: ["432211", 1411], 要介護5: ["432211", 1411] };

const CASES = [
  { tag: "ZJ001", name: "居宅サンプル01 基本のみ要1", level: "要介護1", copay: "1", memo: "最小構成" },
  { tag: "ZJ002", name: "居宅サンプル02 基本のみ要3", level: "要介護3", copay: "1", memo: "基本コードが 432211 に切り替わる境界" },
  { tag: "ZJ003", name: "居宅サンプル03 初回加算", level: "要介護2", copay: "2", claim: { initial_addition: true, initial_addition_units: 300 }, memo: "初回加算300 / 2割" },
  { tag: "ZJ004", name: "居宅サンプル04 特定Ⅱ+処遇", level: "要介護4", copay: "3", claim: { tokutei_kassan_type: "Ⅱ", tokutei_kassan_units: 421, shoguu_kaizen_units: 38, shoguu_kaizen_code: "436191" }, memo: "特定事業所Ⅱ + 処遇改善 / 3割" },
  { tag: "ZJ005", name: "居宅サンプル05 入院時情報連携", level: "要介護5", copay: "1", claim: { hospital_coordination: true, hospital_coordination_units: 250 }, memo: "入院時情報連携Ⅰ (250以上→436125)" },
  { tag: "ZJ006", name: "居宅サンプル06 退院退所", level: "要介護1", copay: "1", claim: { discharge_addition: true, discharge_addition_units: 450, discharge_type: "i_i" }, memo: "退院・退所加算" },
  { tag: "ZJ007", name: "居宅サンプル07 ターミナルのみ", level: "要介護3", copay: "1", noBase: true, claim: { terminal_care: true, terminal_care_units: 400, shoguu_kaizen_units: 8, shoguu_kaizen_code: "436191" }, memo: "★基本コード無し (月途中の死亡で給付管理をしない)" },
  { tag: "ZJ008", name: "居宅サンプル08 公費併用", level: "要介護2", copay: "1", kohi: { hobetsu: "12", futansha: "12121018", jukyusha: "0040980", honnin: 0 }, memo: "生保併用 (8124 項8/9 は空が正)" },
  { tag: "ZJ009", name: "居宅サンプル09 公費単独", level: "要介護3", copay: "1", hNumber: true, kohi: { hobetsu: "12", futansha: "12121018", jukyusha: "0040981", honnin: 0 }, memo: "公費単独 (被保番H・10割公費)" },
  { tag: "ZJ010", name: "居宅サンプル10 転居", level: "要介護2", copay: "1", tenkyo: true, memo: "★月途中の保険者変更 = 1人2レセプト" },
  { tag: "ZJ011", name: "居宅サンプル11 運営基準減算", level: "要介護1", copay: "1", claim: { unei_kijun_gensan: true, unei_kijun_gensan_units: 543 }, memo: "運営基準減算 50% (1086→543)" },
  { tag: "ZJ012", name: "居宅サンプル12 給付管理3事業所", level: "要介護4", copay: "1", kyufu: [
      { name: "訪問介護A", number: "1279999001", kind: "11", units: 12000 },
      { name: "通所介護B", number: "1279999003", kind: "15", units: 8000 },
      { name: "福祉用具C", number: "1279999002", kind: "17", units: 3000 },
    ], memo: "給付管理票 8222 の明細3行 + 終端行" },
];

async function main() {
  console.log(`${DELETE ? "=== 撤去 ===" : EXECUTE ? "=== 投入 ===" : "=== DRY RUN (--execute で投入 / --delete で撤去) ==="}`);
  console.log(`マーカー ${MARK} / 対象月 ${MONTH} / 事業所 ${OFFICE_NAME}\n`);

  if (DELETE) { await removeAll(); return; }

  // 事業所は読むだけ (1 バイトも変更しない)
  const { data: office, error: oe } = await sb
    .from("offices").select("id, name, business_number, unit_price, area_category")
    .eq("name", OFFICE_NAME).maybeSingle();
  if (oe) throw new Error(`事業所の取得に失敗: ${oe.message}`);
  if (!office) throw new Error(`事業所 "${OFFICE_NAME}" が見つかりません`);
  console.log(`事業所: ${office.name} / ${office.business_number} / 単価 ${office.unit_price} / ${office.area_category}`);

  // 対象月が空であることを確認
  const { count: existing, error: ee } = await sb
    .from("kaigo_care_support_claims").select("id", { count: "exact", head: true }).eq("billing_month", MONTH);
  if (ee) throw new Error(`既存レセプトの確認に失敗: ${ee.message}`);
  console.log(`${MONTH} の既存レセプト: ${existing} 件 ${existing === 0 ? "(OK)" : "(⚠ 0 件でない)"}`);

  await removeAll(); // 既に自分のぶんが残っていれば件数を表示 (DELETE でないので消さない)

  const P100 = Math.round(office.unit_price * 100);
  const clients = [], certs = [], kohis = [], assigns = [], claims = [], kyufu = [];
  const summary = [];

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const clientId = randomUUID();
    const insured = `${c.hNumber ? "H" : ""}88${String(i + 1).padStart(8, "0")}`;
    const [code, baseUnits] = BASE[c.level];
    clients.push({
      id: clientId, tenant_id: TENANT, user_number: c.tag,
      name: `${c.name} ${MARK}`, furigana: `ｷｮﾀｸｻﾝﾌﾟﾙ${c.tag}`,
      address: `千葉市若葉区サンプル町${i + 1} ${NOTE}`,
      birth_date: "1939-09-09", gender: i % 2 === 0 ? "女" : "男",
      insured_number: insured, insurer_number: c.tenkyo ? "122011" : "121012",
      care_level: c.level, copay_rate: c.copay, status: "active",
      office_id: null, is_facility: false, is_provisional: false,
    });
    assigns.push({ tenant_id: TENANT, client_id: clientId, office_id: office.id, start_date: "2026-04-01", service_notes: NOTE });

    // 認定: 転居ケースは月途中で保険者が変わる 2 本
    if (c.tenkyo) {
      certs.push({ tenant_id: TENANT, client_id: clientId, effective_date: "2026-04-01",
        insured_number: `8800000010A`, care_level: c.level,
        certification_start_date: "2026-04-01", certification_end_date: "2026-12-15",
        insurer_number: "121012", insurer_name: "千葉市", copay_rate: c.copay,
        service_limit_amount: 19705, certification_status: "認定済み", record_status: "認定済み", notes: NOTE });
      certs.push({ tenant_id: TENANT, client_id: clientId, effective_date: "2026-12-16",
        insured_number: insured, care_level: c.level,
        certification_start_date: "2026-12-16", certification_end_date: "2027-03-31",
        insurer_number: "122011", insurer_name: "船橋市", copay_rate: c.copay,
        service_limit_amount: 19705, certification_status: "認定済み", record_status: "認定済み", notes: NOTE });
    } else {
      certs.push({ tenant_id: TENANT, client_id: clientId, effective_date: "2026-04-01",
        insured_number: insured, care_level: c.level,
        certification_start_date: "2026-04-01", certification_end_date: "2027-03-31",
        insurer_number: "121012", insurer_name: "千葉市", copay_rate: c.copay,
        service_limit_amount: c.level === "要介護1" ? 16765 : c.level === "要介護2" ? 19705 : c.level === "要介護3" ? 27048 : c.level === "要介護4" ? 30938 : 36217,
        certification_status: "認定済み", record_status: "認定済み", notes: NOTE });
    }

    if (c.kohi) {
      kohis.push({ tenant_id: TENANT, client_id: clientId, kohi_hobetsu: c.kohi.hobetsu,
        futansha_number: c.kohi.futansha, jukyusha_number: c.kohi.jukyusha,
        start_date: "2026-01-01", end_date: null, priority: 1, honnin_futan: c.kohi.honnin, notes: NOTE });
    }

    // レセプト
    const ex = c.claim ?? {};
    const mkClaim = (insurerNumber, insuredNumber) => {
      const units = c.noBase ? 0 : baseUnits;
      const sum = (c.noBase ? 0 : baseUnits)
        + (ex.initial_addition_units ?? 0) + (ex.tokutei_kassan_units ?? 0)
        + (ex.hospital_coordination_units ?? 0) + (ex.discharge_addition_units ?? 0)
        + (ex.terminal_care_units ?? 0) + (ex.shoguu_kaizen_units ?? 0)
        - (ex.unei_kijun_gensan_units ?? 0);
      const total = Math.floor((sum * P100) / 100);
      return {
        tenant_id: TENANT, user_id: clientId, billing_month: MONTH,
        care_support_code: c.noBase ? null : code,
        care_support_name: c.noBase ? null : `居宅介護支援費(${c.level})`,
        units, unit_price: office.unit_price, total_amount: total, insurance_amount: total,
        initial_addition: !!ex.initial_addition, initial_addition_units: ex.initial_addition_units ?? 0,
        hospital_coordination: !!ex.hospital_coordination, hospital_coordination_units: ex.hospital_coordination_units ?? 0,
        discharge_addition: !!ex.discharge_addition, discharge_addition_units: ex.discharge_addition_units ?? 0,
        discharge_type: ex.discharge_type ?? null,
        tokutei_kassan_type: ex.tokutei_kassan_type ?? null, tokutei_kassan_units: ex.tokutei_kassan_units ?? 0,
        terminal_care: !!ex.terminal_care, terminal_care_units: ex.terminal_care_units ?? 0,
        unei_kijun_gensan: !!ex.unei_kijun_gensan, unei_kijun_gensan_units: ex.unei_kijun_gensan_units ?? 0,
        shoguu_kaizen_units: ex.shoguu_kaizen_units ?? 0, shoguu_kaizen_code: ex.shoguu_kaizen_code ?? null,
        status: "confirmed", insurer_number: insurerNumber, insured_number: insuredNumber,
        notes: NOTE,
      };
    };
    if (c.tenkyo) {
      // ★ 転居月は保険者ごとに 2 レセプト (care_support_claims_insurer.sql 適用済)
      claims.push(mkClaim("121012", "8800000010A"));
      claims.push(mkClaim("122011", insured));
    } else {
      claims.push(mkClaim("121012", insured));
    }

    for (const k of c.kyufu ?? []) {
      kyufu.push({ tenant_id: TENANT, user_id: clientId, billing_month: MONTH,
        service_type: k.name, provider_name: k.name, provider_number: k.number,
        service_kind_code: k.kind, planned_units: k.units, actual_units: k.units,
        over_limit_units: 0, status: "confirmed" });
    }

    const sumUnits = claims[claims.length - 1].units
      + (ex.initial_addition_units ?? 0) + (ex.tokutei_kassan_units ?? 0)
      + (ex.hospital_coordination_units ?? 0) + (ex.discharge_addition_units ?? 0)
      + (ex.terminal_care_units ?? 0) + (ex.shoguu_kaizen_units ?? 0)
      - (ex.unei_kijun_gensan_units ?? 0);
    summary.push({ tag: c.tag, 要介護度: c.level, 負担: c.copay + "割",
      Σ単位: sumUnits, 期待総額: Math.floor((sumUnits * P100) / 100), memo: c.memo });
  }

  console.log("\n投入予定 (期待値は手計算):");
  console.table(summary);
  console.log(`\n  clients                   ${clients.length}`);
  console.log(`  client_insurance_records  ${certs.length}`);
  console.log(`  client_kohi_records       ${kohis.length}`);
  console.log(`  client_office_assignments ${assigns.length}`);
  console.log(`  kaigo_care_support_claims ${claims.length}  (転居は 1 人 2 レセプト)`);
  console.log(`  kaigo_benefit_management  ${kyufu.length}`);

  if (!EXECUTE) { console.log("\nDRY RUN のため何も書き込んでいません。"); return; }

  const ins = async (table, rows) => {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from(table).insert(rows.slice(i, i + 500));
      if (error) throw new Error(`${table} INSERT 失敗: ${error.message}`);
    }
    console.log(`  ${table}: ${rows.length} 件 INSERT`);
  };
  await ins("clients", clients);
  await ins("client_insurance_records", certs);
  await ins("client_kohi_records", kohis);
  await ins("client_office_assignments", assigns);
  await ins("kaigo_care_support_claims", claims);
  await ins("kaigo_benefit_management", kyufu);

  const { count: n1, error: v1 } = await sb.from("clients").select("id", { count: "exact", head: true }).like("user_number", "ZJ%");
  if (v1) throw new Error(`件数確認に失敗: ${v1.message}`);
  const { count: n2, error: v2 } = await sb.from("kaigo_care_support_claims").select("id", { count: "exact", head: true }).eq("billing_month", MONTH);
  if (v2) throw new Error(`件数確認に失敗: ${v2.message}`);
  console.log(`\n件数確認: 利用者 ${n1} 名 / ${MONTH} レセプト ${n2} 件`);
  if (n1 !== clients.length || n2 !== claims.length) throw new Error("投入件数が想定と一致しません");
  console.log(`\n事業所 ${office.id} (${office.name}) — 検証は scripts/kyotaku-sample-verify.mts`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
