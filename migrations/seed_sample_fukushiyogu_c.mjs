// ============================================================================
// 福祉用具レンタル サンプルデータ (SAMPLE_DATA_PROTOCOL 準拠 / 担当マーカー = c)
//
//   node migrations/seed_sample_fukushiyogu_c.mjs             # DRY RUN
//   node migrations/seed_sample_fukushiyogu_c.mjs --delete    # ★ 撤去
//   node migrations/seed_sample_fukushiyogu_c.mjs --execute   # 投入
//   node migrations/seed_sample_fukushiyogu_c.mjs --terminate # ★ 一部解約を起こす
//
// ── 何を確かめるか (本番では 1 度も通っていない経路) ─────────────────────
//   ① 上限価格の超過      本番の 4,669 行は超過 0 件。**サンプルで初めて超過を通す**
//   ② 書類タスクの発火     本番は 2 か月で 3 行しか発火していない。
//                        rental_started で doc_tasks が 3〜4 件 INSERT されるか
//   ③ 一部解約の検出       本番は rental_end_date が 1 行しか無く発火していない。
//                        ⚠ trigger の条件は「**status が rental_started から外れる**
//                          かつ 同じ client に他の rental_started が残っている」。
//                          **rental_end_date を入れるだけでは発火しない**ことを実証する
//
// ── 前提 ────────────────────────────────────────────────────────────────
//   対象月    2026-12 のみ / マーカー ZC1nn ・ [sample-c] ・ [sample-c-20260903]
//   事業所    実在の 千葉ムツミ福祉用具高品。**offices は 1 バイトも変更しない**
//   ⚠ clients.gender の CHECK は "男"/"女" (members の "男性"/"女性" とは違う)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const TERMINATE = process.argv.includes("--terminate");
const MONTH = "2026-12";
const TENANT = "kt-group";
const MARK = "[sample-c-20260903]";
const NAME_SUFFIX = "[sample-c]";
const NUM_PREFIX = "ZC1"; // 訪問入浴 (ZC001-005) と分ける
/** 実在の福祉用具事業所 (千葉ムツミ福祉用具高品)。**この行は一切変更しない** */
const OFFICE_ID = "ea7d88ea-5373-4054-8b6d-e8a11fbae217";

const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PEOPLE = [
  { no: "ZC101", name: "用具 一郎", kana: "ヨウグ イチロウ", birth: "1939-02-02", gender: "男",
    level: "要介護2", copay: 0.1, insurer: "122192", insured: "ZC10000001" },
  { no: "ZC102", name: "用具 二郎", kana: "ヨウグ ジロウ", birth: "1941-06-06", gender: "男",
    level: "要介護4", copay: 0.2, insurer: "122192", insured: "ZC10000002" },
  { no: "ZC103", name: "用具 三子", kana: "ヨウグ ミツコ", birth: "1936-09-09", gender: "女",
    level: "要介護1", copay: 0.3, insurer: "122192", insured: "ZC10000003" },
];

/**
 * 貸与品。★ ceiling は 2026-12 時点で有効な世代の上限価格 (実測値)。
 *   ZC101-a  上限 4,410 に対し 4,410 = **ちょうど** (境界。超過しない)
 *   ZC101-b  上限 3,790 に対し 3,900 = **超過** (+110) ← 本番に 1 件も無い経路
 *   ZC102-a  上限 3,660 に対し 1,500 = 上限内
 *   ZC102-b  上限 6,600 に対し 6,000 = 上限内 (この人は 2 品 = 一部解約の検証用)
 *   ZC103-a  上限 4,410 に対し 4,411 = **上限 +1** (境界。超過する)
 */
const ITEMS = [
  { who: "ZC101", code: "00221-000624", price: 4410, note: "上限ちょうど (4,410)" },
  { who: "ZC101", code: "00170-001046", price: 3900, note: "★上限超過 (上限3,790 → +110)" },
  { who: "ZC102", code: "00030-000166", price: 1500, note: "上限内" },
  { who: "ZC102", code: "00066-000329", price: 6000, note: "上限内 (一部解約の相手)" },
  { who: "ZC103", code: "00221-000624", price: 4411, note: "★上限 +1 (4,411 > 4,410)" },
];

const findSamples = async () => {
  const { data, error } = await sb.from("clients").select("id, user_number, name").like("user_number", `${NUM_PREFIX}%`);
  if (error) throw new Error(`clients 取得失敗: ${error.message}`);
  return data ?? [];
};

async function doDelete() {
  console.log(`=== 撤去 (マーカー ${NUM_PREFIX}*) ===`);
  const cl = await findSamples();
  console.log(`  対象 clients: ${cl.length} 名 ${cl.map((c) => c.user_number).join(",")}`);
  if (cl.length === 0) { console.log("  対象なし"); return; }
  const ids = cl.map((c) => c.id);
  // order_items は orders 経由。doc_tasks は trigger が作ったものも消す
  const { data: ords, error: oe } = await sb.from("orders").select("id").in("client_id", ids);
  if (oe) { console.error(`  ✗ orders 取得: ${oe.message}`); process.exitCode = 1; return; }
  const oids = (ords ?? []).map((o) => o.id);
  if (oids.length) {
    const { error, count } = await sb.from("order_items").delete({ count: "exact" }).in("order_id", oids);
    if (error) { console.error(`  ✗ order_items: ${error.message}`); process.exitCode = 1; return; }
    console.log(`  order_items                  ${count ?? 0} 行 削除`);
  }
  for (const [t, c] of [["doc_tasks", "client_id"], ["orders", "client_id"],
    ["client_insurance_records", "client_id"], ["client_office_assignments", "client_id"]]) {
    const { error, count } = await sb.from(t).delete({ count: "exact" }).in(c, ids);
    if (error) { console.error(`  ✗ ${t}: ${error.message}`); process.exitCode = 1; return; }
    console.log(`  ${t.padEnd(28)} ${count ?? 0} 行 削除`);
  }
  const { error: ce, count: cc } = await sb.from("clients").delete({ count: "exact" }).in("id", ids);
  if (ce) { console.error(`  ✗ clients: ${ce.message}`); process.exitCode = 1; return; }
  console.log(`  clients                      ${cc ?? 0} 行 削除`);
  const left = await findSamples();
  console.log(`  ★ 残り ${left.length} 件 ${left.length === 0 ? "✅ 0 件を確認" : "❌ 残っている"}`);
}

/** ③ 一部解約を起こす: status を rental_started から外す (rental_end_date だけでは発火しない) */
async function doTerminate() {
  console.log("=== 一部解約の発火テスト ===");
  const cl = await findSamples();
  const zc102 = cl.find((c) => c.user_number === "ZC102");
  if (!zc102) { console.log("  ZC102 が居ない。先に --execute してください"); return; }
  const { data: ords } = await sb.from("orders").select("id").eq("client_id", zc102.id);
  const oids = (ords ?? []).map((o) => o.id);
  const { data: items, error } = await sb.from("order_items").select("id, product_code, status").in("order_id", oids);
  if (error) { console.error(`  ✗ ${error.message}`); process.exitCode = 1; return; }
  console.log(`  ZC102 の貸与品 ${items.length} 件 (status: ${items.map((i) => i.status).join(",")})`);
  const target = items.find((i) => i.status === "rental_started");
  if (!target) { console.log("  rental_started の品が無い"); return; }

  const before = await countDocTasks(zc102.id);
  console.log(`  現在の doc_tasks: ${JSON.stringify(before)}`);

  // ── (a) rental_end_date だけ入れる → **発火しないはず** ──────────────
  console.log(`\n  (a) rental_end_date だけを入れる (status は rental_started のまま)`);
  const { error: e1 } = await sb.from("order_items")
    .update({ rental_end_date: `${MONTH}-20` }).eq("id", target.id);
  if (e1) { console.error(`  ✗ ${e1.message}`); process.exitCode = 1; return; }
  const afterA = await countDocTasks(zc102.id);
  console.log(`      doc_tasks: ${JSON.stringify(afterA)}`);
  console.log(`      → partial_termination ${(afterA.partial_termination ?? 0) - (before.partial_termination ?? 0)} 件 増えた`);

  // ── (b) status を rental_started から外す → **発火するはず** ─────────
  console.log(`\n  (b) status を 'terminated' に変える`);
  const { error: e2 } = await sb.from("order_items")
    .update({ status: "terminated" }).eq("id", target.id);
  if (e2) { console.error(`  ✗ ${e2.message}`); process.exitCode = 1; return; }
  const afterB = await countDocTasks(zc102.id);
  console.log(`      doc_tasks: ${JSON.stringify(afterB)}`);
  console.log(`      → partial_termination ${(afterB.partial_termination ?? 0) - (afterA.partial_termination ?? 0)} 件 増えた`);
  console.log(`\n  ★ 結論: rental_end_date だけでは発火せず、**status の変更が要る**`);
}

async function countDocTasks(clientId) {
  const { data, error } = await sb.from("doc_tasks").select("trigger_type, expected_doc_type").eq("client_id", clientId);
  if (error) throw new Error(`doc_tasks: ${error.message}`);
  const m = {};
  for (const r of data ?? []) m[r.trigger_type] = (m[r.trigger_type] ?? 0) + 1;
  return m;
}

async function doSeed() {
  console.log(`=== 福祉用具 サンプル投入 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===`);
  console.log(`    対象月 ${MONTH} / マーカー ${NUM_PREFIX}* ・ ${NAME_SUFFIX} ・ ${MARK}\n`);

  const { data: off, error: oe } = await sb.from("offices")
    .select("id, name, service_type").eq("id", OFFICE_ID).maybeSingle();
  if (oe) throw new Error(`offices: ${oe.message}`);
  if (!off) throw new Error(`事業所 ${OFFICE_ID} が実在しない`);
  console.log(`  事業所: ${off.name} (${off.service_type}) — **変更しない**`);

  // 用具マスタと上限価格を確認 (期待値の根拠)
  const codes = [...new Set(ITEMS.map((i) => i.code))];
  const { data: eq, error: ee } = await sb.from("equipment_master")
    .select("product_code, tais_code, name").in("product_code", codes);
  if (ee) throw new Error(`equipment_master: ${ee.message}`);
  const eqBy = new Map((eq ?? []).map((e) => [e.product_code, e]));
  const missing = codes.filter((c) => !eqBy.has(c));
  if (missing.length) throw new Error(`用具マスタに無い product_code: ${missing.join(",")}`);
  const { data: ce, error: cee } = await sb.from("equipment_price_ceilings")
    .select("tais_code, effective_from, ceiling_price")
    .in("tais_code", (eq ?? []).map((e) => e.tais_code)).lte("effective_from", `${MONTH}-01`);
  if (cee) throw new Error(`equipment_price_ceilings: ${cee.message}`);
  const ceilBy = new Map();
  for (const c of ce ?? []) {
    const k = String(c.tais_code).trim();
    const cur = ceilBy.get(k);
    if (!cur || String(c.effective_from) > String(cur.effective_from)) ceilBy.set(k, c);
  }

  console.log(`\n  投入予定: clients ${PEOPLE.length} 名 / orders ${PEOPLE.length} 件 / order_items ${ITEMS.length} 件`);
  for (const it of ITEMS) {
    const e = eqBy.get(it.code);
    const c = ceilBy.get(String(e.tais_code).trim());
    const over = c && it.price > Number(c.ceiling_price);
    console.log(`     ${it.who} ${String(e.name).slice(0, 18).padEnd(20)} 貸与 ${String(it.price).padStart(5)} / 上限 ${String(c?.ceiling_price ?? "—").padStart(5)}  ${over ? "★超過" : "内"}  ${it.note}`);
  }

  const existing = await findSamples();
  if (existing.length > 0) { console.log(`\n  ⚠ 既に ${existing.length} 件あります。先に --delete してください`); return; }
  if (!EXECUTE) { console.log(`\n【DRY RUN】書き込んでいません。--execute で投入`); return; }

  // clients
  const { data: ins, error: ie } = await sb.from("clients").insert(
    PEOPLE.map((p) => ({
      tenant_id: TENANT, user_number: p.no, name: `${p.name}${NAME_SUFFIX}`, furigana: p.kana,
      birth_date: p.birth, gender: p.gender, care_level: p.level,
      insurer_number: p.insurer, insured_number: p.insured, copay_rate: p.copay,
      address: `千葉県サンプル市 ${MARK}`, office_id: OFFICE_ID, status: "active",
    })),
  ).select("id, user_number");
  if (ie) { console.error(`✗ clients: ${ie.message}`); process.exit(1); }
  const idBy = new Map(ins.map((r) => [r.user_number, r.id]));
  console.log(`  clients                      ${ins.length} 行`);

  const { error: ae } = await sb.from("client_office_assignments").insert(
    PEOPLE.map((p) => ({ tenant_id: TENANT, client_id: idBy.get(p.no), office_id: OFFICE_ID,
      start_date: `${MONTH}-01`, service_notes: MARK })));
  if (ae) { console.error(`✗ client_office_assignments: ${ae.message}`); process.exit(1); }
  console.log(`  client_office_assignments    ${PEOPLE.length} 行`);

  const { error: cre } = await sb.from("client_insurance_records").insert(
    PEOPLE.map((p) => ({
      tenant_id: TENANT, client_id: idBy.get(p.no), effective_date: `${MONTH}-01`,
      insurer_number: p.insurer, insured_number: p.insured, care_level: p.level,
      certification_start_date: "2026-04-01", certification_end_date: "2027-03-31",
      copay_rate: p.copay, notes: MARK,
    })));
  if (cre) { console.error(`✗ client_insurance_records: ${cre.message}`); process.exit(1); }
  console.log(`  client_insurance_records     ${PEOPLE.length} 行`);

  // orders (利用者ごとに 1 件)
  const { data: ords, error: ooe } = await sb.from("orders").insert(
    PEOPLE.map((p) => ({
      tenant_id: TENANT, client_id: idBy.get(p.no), office_id: OFFICE_ID,
      ordered_at: `${MONTH}-01`, delivery_date: `${MONTH}-01`, delivery_type: "直納",
      payment_type: "介護", status: "ordered", notes: MARK,
    })),
  ).select("id, client_id");
  if (ooe) { console.error(`✗ orders: ${ooe.message}`); process.exit(1); }
  const ordBy = new Map(ords.map((o) => [o.client_id, o.id]));
  console.log(`  orders                       ${ords.length} 行`);

  // order_items — ★ status='rental_started' で INSERT → trigger が doc_tasks を作るはず
  const { error: oie } = await sb.from("order_items").insert(
    ITEMS.map((it) => ({
      tenant_id: TENANT, order_id: ordBy.get(idBy.get(it.who)),
      product_code: it.code, rental_price: it.price, quantity: 1,
      status: "rental_started", rental_start_date: `${MONTH}-01`,
      payment_type: "介護", notes: `${it.note} ${MARK}`,
    })),
  );
  if (oie) { console.error(`✗ order_items: ${oie.message}`); process.exit(1); }
  console.log(`  order_items                  ${ITEMS.length} 行 (status=rental_started)`);

  // ② trigger が doc_tasks を作ったか
  const ids = PEOPLE.map((p) => idBy.get(p.no));
  const { data: dt, error: de } = await sb.from("doc_tasks")
    .select("client_id, trigger_type, expected_doc_type, trigger_label, due_date").in("client_id", ids);
  if (de) { console.error(`✗ doc_tasks 確認: ${de.message}`); process.exit(1); }
  console.log(`\n  ★ trigger が作った doc_tasks: ${(dt ?? []).length} 件`);
  const byType = {};
  for (const r of dt ?? []) {
    const k = `${r.trigger_type}/${r.expected_doc_type}`;
    byType[k] = (byType[k] ?? 0) + 1;
  }
  console.log(`     ${JSON.stringify(byType)}`);
  console.log(`     期待: rental_started × 3〜4 種 × ${ITEMS.length} 品`);
}

const run = DELETE ? doDelete : TERMINATE ? doTerminate : doSeed;
run().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
