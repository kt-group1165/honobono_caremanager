/**
 * 障害 — 実データ0件のサービス種別サンプル (担当 J / マーカー ZS##)
 *   行動援護 / 通院等乗降介助 / 同行援護の障害支援区分による単価切替
 *
 *   node migrations/seed_sample_shogai_koudou_j.mjs             # DRY RUN (既定)
 *   node migrations/seed_sample_shogai_koudou_j.mjs --delete --execute  # 撤去
 *   node migrations/seed_sample_shogai_koudou_j.mjs --execute   # 投入
 *
 * ── なぜ入れるか (2026-09-04 H の実測) ──────────────────────────────────
 *   障害の網羅率は59.2%。実データに1件も無いサービス種別が複数あり、うち
 *   生保・上限管理結果区分2 は H が98fab85で通した。★ 残るのが行動援護・乗降介助。
 *   加えて 同行援護は障害支援区分(区分3/区分4)でコードが変わる仕組みがあるが、
 *   実データに同行援護の確定実績が0件のため一度も通っていない。
 *
 * ── 実装状況を先に確認した (2026-09-04) ────────────────────────────────
 *   ★ shogai_service_records は本番 ★0行 — ドキュメント上の「主経路」だが実際は
 *     使われていない。本番の実質的な唯一の経路は kaigo_visit_schedule
 *     (aggregate.ts 「1.5) シフト/提供表の統合」)。★ このサンプルもそちらを使う
 *     (production と同じ経路を通すため)。
 *   ★ 行動援護・乗降介助 とも aggregate.ts の SHIKYURYO_DEFS / 初回加算 /
 *     特別地域加算 に既にサービス種類コード対応がある = 集計は実装済み。
 *     「未対応」なのは 障害の実績記録票 様式0201(行動援護)/1901(同行援護) — J611の
 *     ★ 別ファイルの話 (shogai-densou/build.ts L18-21)。J121 (請求本体) には無関係。
 *     → J611 はこのサンプルの対象外 (KT Group が未提供の様式のため元々出ない)。
 *   ★ code-from-time.ts の「行動援護(021005)も未対応」は ★ 旧7桁コードの
 *     名前→コード ★ 時刻フォールバック の話で、CLAUDE.md の残件にある
 *     「旧7桁体系」の legacy コードの話。現行マスタ (system=障害, category=13,
 *     例 1311021 行動援護30分〜1時間 407単位, 2024-04-01〜) には該当しない。
 *     ★ シフトの service_type をマスタの service_name と完全一致させれば
 *     (nameMap 直接ヒット)、時刻フォールブックを経由せず解決できる。
 *   ★ 乗降介助も同様 (通院乗降日 = 118111, 102単位, nameMap 直接ヒット)。
 *   ★ 同行援護のみ、あえて時刻フォールバックを通す (これが支援区分で
 *     コードが変わる唯一の実装箇所 — aggregate.ts:306-365)。
 *     service_type="同行援護" はマスタの service_name と完全一致しない
 *     (マスタは「同援日０．５」等の合成名) ため、確実に時刻+区分の
 *     フォールバック経路に落ちる。
 *
 * ケース (対象月 2026-12 / 13:00-13:30 は 0.5h・日中帯 = 「同援日０．５」系列):
 *   ZS01 行動援護   30分〜1時間   → 1311021 / 407単位 (nameMap直接)
 *   ZS02 乗降介助   通院乗降日    → 118111  / 102単位 (nameMap直接)
 *   ZS03 同行援護   支援区分3     → 157695  / 229単位 (時刻+区分フォールバック)
 *   ZS04 同行援護   支援区分4     → 157703  / 267単位 (同上)
 *   ZS05 同行援護   支援区分2(無修飾) → 157687 / 191単位 (区分3/4未満は無修飾)
 *
 * 事業所は ★ 実在の Ｈａｎａヘルパーステーションおゆみ野 を **読むだけ** (offices は無変更)。
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const MARK = "[sample-j]";
const NOTE = "[sample-j-koudou-20260905]";
const TENANT = "kt-group";
const MONTH = "2026-12";
const PREFIX = "ZS";
const OFFICE_NAME = "Ｈａｎａヘルパーステーションおゆみ野";
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
    .from("clients").select("id, name, user_number").like("user_number", `${PREFIX}%`);
  if (e0) throw new Error(`利用者の取得に失敗: ${e0.message}`);
  const ids = (cs ?? []).map((c) => c.id);
  console.log(`対象利用者: ${ids.length} 名 (user_number ${PREFIX}%)`);
  if (ids.length === 0) { console.log("撤去対象なし"); return; }

  const targets = [
    ["kaigo_visit_schedule", "user_id"],
    ["shougai_certifications", "client_id"],
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

  // ⚠ 2026-09-04 是正パターンを踏襲: --delete 単体で即削除しない。
  //   必ず --delete --execute を両方要求する (dry-run プレビューを必ず経由させる)。
  if (!EXECUTE) { console.log("\n【DRY RUN】--delete --execute で実際に削除します"); return; }

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
  const { count: leftSched, error: el2 } = await sb
    .from("kaigo_visit_schedule").select("id", { count: "exact", head: true })
    .gte("visit_date", `${MONTH}-01`).lte("visit_date", `${MONTH}-31`)
    .like("notes", `%${NOTE}%`);
  if (el2) throw new Error(`残存確認に失敗: ${el2.message}`);
  console.log(`\n残存: 利用者 ${left}/${leftAll} 名 / ${MONTH} の当サンプルのシフト ${leftSched} 件`);
  if (left !== 0 || leftSched !== 0) throw new Error("撤去しきれていません");
}

// ───────────────────────── ケース定義 ─────────────────────────
const CASES = [
  { tag: "ZS01", serviceType: "行動援護 30分〜1時間", supportLevel: "区分6",
    start: "10:00", end: "10:45", expCode: "1311021", expUnits: 407,
    memo: "行動援護 (nameMap直接ヒット) — 実データ0件" },
  { tag: "ZS02", serviceType: "通院乗降日", supportLevel: "区分3",
    start: "09:00", end: "09:15", expCode: "118111", expUnits: 102,
    memo: "乗降介助 (nameMap直接ヒット) — 実データ0件" },
  { tag: "ZS03", serviceType: "同行援護", supportLevel: "区分3",
    start: "13:00", end: "13:30", expCode: "157695", expUnits: 229,
    memo: "★ 同行援護 支援区分3 (時刻+区分フォールバック) — 191→229 +20%" },
  { tag: "ZS04", serviceType: "同行援護", supportLevel: "区分4",
    start: "13:00", end: "13:30", expCode: "157703", expUnits: 267,
    memo: "★ 同行援護 支援区分4 (時刻+区分フォールバック) — 191→267 +40%" },
  { tag: "ZS05", serviceType: "同行援護", supportLevel: "区分2",
    start: "13:00", end: "13:30", expCode: "157687", expUnits: 191,
    memo: "同行援護 支援区分2 (区分3/4未満=無修飾。対照群)" },
];

async function main() {
  console.log(`${DELETE ? "=== 撤去 ===" : EXECUTE ? "=== 投入 ===" : "=== DRY RUN (--execute で投入 / --delete --execute で撤去) ==="}`);
  console.log(`マーカー ${PREFIX}## ${MARK} / 対象月 ${MONTH} / 事業所 ${OFFICE_NAME} (読むだけ)\n`);

  if (DELETE) { await removeAll(); return; }

  const { data: office, error: oe } = await sb
    .from("offices").select("id, name, shogai_business_number, unit_price, area_category")
    .eq("name", OFFICE_NAME).maybeSingle();
  if (oe) throw new Error(`事業所の取得に失敗: ${oe.message}`);
  if (!office) throw new Error(`事業所 "${OFFICE_NAME}" が見つかりません`);
  console.log(`事業所: ${office.name} / 障害番号 ${office.shogai_business_number} / 単価 ${office.unit_price} / ${office.area_category}`);

  // ★ 現行マスタで期待コードが実在することを事前確認 (期待値の裏取り)
  for (const c of CASES) {
    const { data: mrow, error: me } = await sb
      .from("kaigo_service_codes").select("service_code, service_name, units")
      .eq("system", "障害").eq("service_code", c.expCode)
      .lte("valid_from", `${MONTH}-01`).or(`valid_until.is.null,valid_until.gte.${MONTH}-01`)
      .maybeSingle();
    if (me) throw new Error(`マスタ確認失敗 (${c.tag}): ${me.message}`);
    if (!mrow) throw new Error(`★ ${c.tag}: コード ${c.expCode} が対象月のマスタに無い。期待値を見直すこと`);
    if (mrow.units !== c.expUnits) throw new Error(`★ ${c.tag}: マスタの単位数 ${mrow.units} が期待値 ${c.expUnits} と不一致`);
  }
  console.log("★ 期待コード・単位数はすべて対象月のマスタで裏取り済み\n");

  await removeAll();

  const clients = [], certs = [], scheds = [];
  const summary = [];

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const clientId = randomUUID();
    const beneficiary = `88${String(i + 1).padStart(8, "0")}`;

    clients.push({
      id: clientId, tenant_id: TENANT, user_number: c.tag,
      name: `障害サンプル${c.tag} ${MARK}`, furigana: `ショウガイサンプル${c.tag}`,
      address: `千葉市若葉区サンプル町${i + 1} ${NOTE}`,
      birth_date: "1970-03-03", gender: i % 2 === 0 ? "女" : "男",
      status: "active", office_id: null, is_facility: false, is_provisional: false,
    });
    certs.push({
      tenant_id: TENANT, client_id: clientId,
      support_level: c.supportLevel,
      certification_start_date: "2026-01-01", certification_end_date: "2027-03-31",
      beneficiary_number: beneficiary, insurer_municipality: "121004",
      self_payment_limit: 37200, copay_rate: 0.1,
      seiho_flag: false, monthly_allocations: {}, jogen_kanri_kubun: "なし",
      is_applying: false, shafuku_genmen: false, household_multi_jogen: false,
      flag_rousha: false, flag_h30_after: false, flag_severe: false,
      flag_short_multi: false, flag_special_area: false,
      contract_start_date: "2026-04-01", notes: NOTE,
    });
    scheds.push({
      id: randomUUID(), tenant_id: TENANT, user_id: clientId, office_id: office.id,
      visit_date: `${MONTH}-05`, start_time: c.start, end_time: c.end,
      service_type: c.serviceType, status: "completed", system: "障害",
      billable: true, kinkyu_houmon: false, cancel_fee: 0,
      notes: NOTE,
    });

    summary.push({
      tag: c.tag, サービス: c.serviceType, 支援区分: c.supportLevel,
      期待コード: c.expCode, 期待単位: c.expUnits, memo: c.memo,
    });
  }

  console.log("投入予定:");
  console.table(summary);
  console.log(`\n  clients                  ${clients.length}`);
  console.log(`  shougai_certifications   ${certs.length}`);
  console.log(`  kaigo_visit_schedule     ${scheds.length}`);

  if (!EXECUTE) { console.log("\nDRY RUN のため何も書き込んでいません。"); return; }

  const ins = async (table, rows) => {
    if (rows.length === 0) return;
    const { error } = await sb.from(table).insert(rows);
    if (error) throw new Error(`${table} INSERT 失敗: ${error.message}`);
    console.log(`  ${table}: ${rows.length} 件 INSERT`);
  };
  await ins("clients", clients);
  await ins("shougai_certifications", certs);
  await ins("kaigo_visit_schedule", scheds);

  const { count: n1, error: v1 } = await sb.from("clients").select("id", { count: "exact", head: true }).like("user_number", `${PREFIX}%`);
  if (v1) throw new Error(`件数確認に失敗: ${v1.message}`);
  console.log(`\n件数確認: 利用者 ${n1} 名`);
  if (n1 !== clients.length) throw new Error("投入件数が想定と一致しません");
  console.log(`\n事業所 ${office.id} — 検証は scripts/shogai-koudou-sample-verify.mts`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
