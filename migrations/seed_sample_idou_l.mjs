// ============================================================================
// 移動支援 (千葉市地域生活支援給付) サンプル投入 (担当 L / マーカー `l`)
//
//   SAMPLE_DATA_PROTOCOL.md に従う。対象月 2026-12 / user_number ZM### / [sample-l]
//
//   ⚠ chiiki_recipient_certs (地域生活支援の受給者証) が **本番 0 行**なので、
//     これを作らないとコード解決がブロックされる (= fail-closed が効いている証拠)。
//     サンプルで初めてこの経路を通せる。
//
//   使い方:
//     node migrations/seed_sample_idou_l.mjs            # DRY RUN
//     node migrations/seed_sample_idou_l.mjs --execute
//     node migrations/seed_sample_idou_l.mjs --delete
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const MONTH = "2026-12";
const TENANT = "kt-group";
const MARK = "[sample-l-20260903]";
const OFFICE_NAME = "Ｈａｎａヘルパーステーション高品";

const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

async function removeAll() {
  const { data: cl, error } = await sb.from("clients").select("id,user_number,name").like("user_number", "ZM%");
  if (error) die(`clients: ${error.message}`);
  const ids = (cl ?? []).map((c) => c.id);
  console.log(`撤去対象: ${ids.length} 名`);
  if (!ids.length) return;
  for (const [t, col] of [
    ["kaigo_idou_shien_records", "client_id"],
    ["chiiki_recipient_certs", "client_id"],
    ["client_office_assignments", "client_id"],
  ]) {
    const { error: e, count } = await sb.from(t).delete({ count: "exact" }).in(col, ids);
    if (e) die(`${t}: ${e.message}`);
    console.log(`   ${t}: ${count ?? 0} 行 削除`);
  }
  const { error: e2, count } = await sb.from("clients").delete({ count: "exact" }).in("id", ids);
  if (e2) die(`clients: ${e2.message}`);
  console.log(`   clients: ${count ?? 0} 行 削除`);
}

async function verify() {
  const { data: cl } = await sb.from("clients").select("id").like("user_number", "ZM%");
  const ids = (cl ?? []).map((c) => c.id);
  console.log(`\n=== 件数確認 ===\n  clients (ZM*): ${ids.length} 名`);
  if (!ids.length) return;
  for (const [t, col] of [["chiiki_recipient_certs", "client_id"], ["kaigo_idou_shien_records", "client_id"]]) {
    const { count } = await sb.from(t).select("*", { count: "exact", head: true }).in(col, ids);
    console.log(`  ${t}: ${count} 行`);
  }
}

async function main() {
  if (DELETE) { await removeAll(); return verify(); }
  console.log(`=== 移動支援サンプル ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} 対象月 ${MONTH} ===\n`);

  const { data: exist } = await sb.from("clients").select("id").like("user_number", "ZM%");
  if (exist?.length) die(`sample が既に ${exist.length} 名います。先に --delete してください`);

  const { data: off, error: eO } = await sb.from("offices").select("id,name").eq("name", OFFICE_NAME).maybeSingle();
  if (eO) die(eO.message);
  if (!off) die(`事業所なし: ${OFFICE_NAME}`);

  // 告示の期待値 (migrations/_if_idou_shien_chiba.txt より手で起こす)
  //   基本: 身体あり 〜30分280 / 〜60分441   身体なし 〜30分116 / 〜60分215
  //   加算: 初回218 (月1回) / 緊急時109 (月2回・身体ありのみ)
  const SAMPLES = [
    {
      no: "ZM001", name: "移動 身体あり 初回+緊急3回",
      note: "初回は月1回・緊急時は月2回までに丸められるか (3回付けて2回になるべき)",
      records: [
        { d: "01", s: "10:00", e: "11:00", body: true, shokai: true, kinkyu: true },
        { d: "08", s: "10:00", e: "11:00", body: true, shokai: true, kinkyu: true },
        { d: "15", s: "10:00", e: "11:00", body: true, shokai: false, kinkyu: true },
      ],
      expect: "移動1日中2.0 441×3 = 1323 + 初回218 + 緊急109×2 = **1759**",
    },
    {
      no: "ZM002", name: "移動 身体なし 初回+緊急",
      note: "緊急時は身体介護ありのみ → 身体なしでは **付かない** はず",
      records: [
        { d: "02", s: "10:00", e: "10:30", body: false, shokai: true, kinkyu: true },
        { d: "09", s: "10:00", e: "10:30", body: false, shokai: false, kinkyu: true },
      ],
      expect: "移動2日中1.0 116×2 = 232 + 初回218 (027701) = **450** (緊急は付かない)",
    },
    {
      no: "ZM003", name: "移動 深夜2人派遣",
      note: "深夜×1.5 と 2人目コード (同単位・別行)",
      records: [{ d: "03", s: "23:00", e: "23:30", body: false, shokai: false, kinkyu: false, staff: 2 }],
      expect: "移動2深夜0.5 round(116×1.5)=174 ×2行 (1人目+2人目) = **348**",
    },
  ];

  console.log("=== 手計算した期待値 (告示の単価表より) ===");
  for (const s of SAMPLES) console.log(`  ${s.no} ${s.name}\n     ${s.expect}\n     [${s.note}]`);
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で投入します"); return; }

  for (const s of SAMPLES) {
    const { data: cl, error: e1 } = await sb.from("clients").insert({
      tenant_id: TENANT, user_number: s.no, name: `${s.name}[sample-l]`,
      furigana: "サンプル", birth_date: "1960-01-01", gender: "女",
    }).select("id").single();
    if (e1) die(`clients (${s.no}): ${e1.message}`);
    const cid = cl.id;

    const { error: e2 } = await sb.from("client_office_assignments")
      .insert({ tenant_id: TENANT, client_id: cid, office_id: off.id });
    if (e2) die(`client_office_assignments (${s.no}): ${e2.message}`);

    // ★ これが無いと certMuni が空になり コード解決がブロックされる (本番 0 行の理由)
    const { error: e3 } = await sb.from("chiiki_recipient_certs").insert({
      // ⚠ 列は OpenAPI から確認した (表が空で select("*") では列名が取れないため)。
      //   self_payment_limit / seiho_flag は NOT NULL
      tenant_id: TENANT, client_id: cid, municipality: "千葉市",
      beneficiary_number: `9${s.no.slice(2)}0000`,
      self_payment_limit: 0, seiho_flag: false,
      shikyu_minutes: 25 * 60, // 標準支給量 月25時間
      valid_from: `${MONTH}-01`, valid_until: "2027-11-30",
      notes: `サンプル ${MARK}`,
    });
    if (e3) die(`chiiki_recipient_certs (${s.no}): ${e3.message}`);

    const rows = s.records.map((r) => ({
      tenant_id: TENANT, client_id: cid, office_id: off.id,
      service_date: `${MONTH}-${r.d}`,
      plan_start_time: r.s, plan_end_time: r.e, start_time: r.s, end_time: r.e,
      deduct_minutes: 0, with_body_care: r.body, staff_count: r.staff ?? 1,
      addon_shokai: r.shokai, addon_kinkyu: r.kinkyu,
      status: "confirmed", notes: `サンプル ${MARK}`,
    }));
    const { error: e4 } = await sb.from("kaigo_idou_shien_records").insert(rows);
    if (e4) die(`kaigo_idou_shien_records (${s.no}): ${e4.message}`);
    console.log(`  ✓ ${s.no}: 実績 ${rows.length} 件`);
  }
  await verify();
}

main().catch((e) => die(e.message));
