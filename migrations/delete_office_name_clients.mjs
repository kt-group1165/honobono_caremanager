// ============================================================================
// **事業所名が利用者として登録されている** ゴミ client を消す。
//
//   node migrations/delete_office_name_clients.mjs             # DRY RUN
//   node migrations/delete_office_name_clients.mjs --execute
//
// ── 何が入っているか ────────────────────────────────────────────────────
//   2026-04-20 の取込が、担当居宅事業所の名前を利用者として作っていた。
//   2026-08-31 時点で clients に本物の利用者に混ざってこれだけある:
//
//     居宅介護支援事業所　アマテラス / ハートケア居宅介護支援センター
//     木更津市中部地域包括支援センター / 社会福祉法人市原市社会福祉協議会
//     ヤックスケアセンター内房 / せせらぎの郷 / 緑祐の郷指定居宅介護支援事業所 …
//
//   生年月日も被保険者番号も無く、参照も 1 件も無い。利用者検索に出てきて
//   邪魔なだけなので消す。
//
// ── 消す条件 (全部に当てはまるものだけ) ────────────────────────────────
//   ① 生年月日が空        本物の利用者はマスタから生年月日が入る
//   ② 被保険者番号が空    請求に使われていない
//   ③ 参照が 1 件も無い   認定・帳票・割当・シフト・実績・レセプト等 全表を見る
//   ④ 氏名が事業所らしい  居宅 / センター / 事業所 / 協議会 / 苑 / ホーム …
//
//   ⚠ **個人名は消さない。** 生年月日も番号も無い個人名が 95 名いるが、
//     過去の利用者かもしれないので判断は人に任せる (この script は触らない)。
//   ⚠ 参照が 1 件でもあれば消さない。実際「メモ 1 件」だけ持つ人がいる。
//
//   消した内容は migrations/_deleted_office_name_clients.json に残す
//   (氏名・利用者番号・作成日。復旧が要るときの手掛かり)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const BACKUP = path.join(KAIGO, "migrations/_deleted_office_name_clients.json");

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

/** clients を参照する表。merge_duplicate_clients.mjs と同じ内容にすること */
const REFS = [
  ["client_insurance_records", "client_id"], ["client_office_assignments", "client_id"],
  ["client_kohi_records", "client_id"], ["client_hospitalizations", "client_id"],
  ["client_memos", "client_id"], ["shougai_certifications", "client_id"],
  ["shogai_contracts", "client_id"], ["shogai_service_records", "client_id"],
  ["shogai_service_start", "client_id"], ["shogai_jogen_kanri_results", "client_id"],
  ["shogai_billing_status", "client_id"], ["chiiki_recipient_certs", "client_id"],
  ["kaigo_visit_records", "user_id"], ["kaigo_visit_schedule", "user_id"],
  ["kaigo_visit_patterns", "user_id"], ["kaigo_visit_addon_lines", "client_id"],
  ["kaigo_visit_month_addons", "client_id"], ["kaigo_care_plans", "user_id"],
  ["kaigo_assessments", "user_id"], ["kaigo_monitoring_sheets", "user_id"],
  ["kaigo_support_records", "user_id"], ["kaigo_care_conferences", "client_id"],
  ["kaigo_adl_records", "user_id"], ["kaigo_health_records", "user_id"],
  ["kaigo_medical_history", "user_id"], ["kaigo_medical_insurance", "user_id"],
  ["kaigo_family_contacts", "user_id"], ["kaigo_emergency_sheets", "user_id"],
  ["kaigo_user_contracts", "user_id"], ["kaigo_riyou_settings", "client_id"],
  ["kaigo_monthly_plan_units", "client_id"], ["kaigo_gendo_allocation", "client_id"],
  ["kaigo_benefit_management", "user_id"], ["kaigo_billing_records", "user_id"],
  ["kaigo_billing_status", "client_id"], ["kaigo_houmon_care_plans", "user_id"],
  ["kaigo_idou_shien_records", "client_id"], ["kaigo_bath_visit_records", "client_id"],
  ["kaigo_bath_schedule", "client_id"], ["kaigo_bath_patterns", "client_id"],
  ["kaigo_service_records", "user_id"], ["kaigo_report_documents", "user_id"],
  ["kaigo_emergency_status", "user_id"], ["riyou_jippi_entries", "client_id"],
  ["riyou_seikyu_payments", "client_id"], ["kaigo_care_support_claims", "user_id"],
];

/** 事業所・施設らしい名前 (第一段。これに当たらなくても下のマスタ照合で拾う) */
const OFFICE_RE = /居宅|センター|事業所|協議会|苑$|苑指定|ホーム|ステーション|法人|ケアプラン|ケアサービス|支援|病院|クリニック|の郷|園$|会$|メディケア|アビタシオン|セントケア|介護相談|相談室|デイサービス|ケアマネ|訪問看護|ヘルパー/;

/** 明らかに利用者でない名前 (テスト登録など)。完全一致で判定する */
const NOT_A_PERSON = new Set(["テスト", "test", "サンプル", "ダミー"]);

/**
 * 事業所名の正規化。法人格の前置と記号・空白を落とす。
 * 「株式会社ｻｰﾋﾞｽﾜﾝ　ﾑﾂﾐ居宅介護支援事業所」と「ムツミ居宅介護支援事業所」を
 * 同じものとして扱えるようにする。
 */
const normOffice = (s) => (s ?? "").normalize("NFKC")
  .replace(/[\s　･・()（）＊*]/g, "")
  .replace(/^(株式会社|有限会社|医療法人社団|医療法人|社会福祉法人|一般社団法人|合同会社|㈱|㈲)/, "");

/**
 * 事業所マスタ (自社 offices / 他社 care_offices / 提供事業所) の名称を集める。
 * ⚠ 正規表現だけでは「入道雲」「フォレスト」「ココケア」のような
 *   事業所らしくない名前を拾えない。**実在する事業所名と突き合わせる**のが確実。
 */
async function loadOfficeNames() {
  const out = new Set();
  for (const [t, col] of [["offices", "name"], ["care_offices", "name"], ["kaigo_service_providers", "provider_name"]]) {
    const probe = await sb.from(t).select(col).limit(1);
    if (probe.error) { console.log(`  (${t} は見られないので飛ばす)`); continue; }
    for (const r of await fetchAll(() => sb.from(t).select(col))) if (r[col]) out.add(normOffice(r[col]));
  }
  return out;
}

async function fetchAll(build) {
  const out = [];
  // ⚠ order 無しで range を回すと行が重複・欠落する
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== 事業所名の client を消す ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const clients = (await fetchAll(() => sb.from("clients")
    .select("id, name, user_number, birth_date, insured_number, created_at, deleted_at")))
    .filter((c) => !c.deleted_at);

  const officeNames = await loadOfficeNames();
  console.log(`事業所マスタの名称 ${officeNames.size} 種`);
  /** 事業所マスタに載っているか (完全一致 / 4 文字以上の包含) */
  const isKnownOffice = (name) => {
    const n = normOffice(name);
    if (!n) return false;
    for (const o of officeNames) {
      if (!o) continue;
      if (o === n) return true;
      if (n.length >= 4 && o.includes(n)) return true;
      if (o.length >= 4 && n.includes(o)) return true;
    }
    return false;
  };

  // ①②④ を満たすもの (④ は 名前のパターン **または** 事業所マスタに載っている)
  const cand = clients.filter((c) =>
    !c.birth_date && !c.insured_number &&
    (OFFICE_RE.test(String(c.name ?? "")) || isKnownOffice(c.name) ||
     NOT_A_PERSON.has(String(c.name ?? "").trim())));
  console.log(`clients ${clients.length} 名 / 生年月日も被保番も無く事業所と判る名前: ${cand.length} 名`);

  // ③ 参照を全表で数える (1 件でもあれば残す)
  const candIds = new Set(cand.map((c) => c.id));
  const refs = new Map(cand.map((c) => [c.id, []]));
  const missingTables = [];
  for (const [t, col] of REFS) {
    const probe = await sb.from(t).select(col).limit(1);
    if (probe.error) { missingTables.push(`${t}.${col}`); continue; }
    for (const r of await fetchAll(() => sb.from(t).select(col))) {
      const id = r[col];
      if (candIds.has(id)) refs.get(id).push(t);
    }
  }
  if (missingTables.length) {
    // ⚠ 黙って外すと「参照ゼロ」に見えて消してはいけないものを消す
    console.log(`  ⚠ 見られなかった表 ${missingTables.length} 個: ${missingTables.join(", ")}`);
  }

  const toDelete = cand.filter((c) => refs.get(c.id).length === 0);
  const keep = cand.filter((c) => refs.get(c.id).length > 0);

  console.log(`\n― 消す ${toDelete.length} 名 ―`);
  for (const c of toDelete.slice(0, 30)) {
    console.log(`   ${String(c.name).slice(0, 34).padEnd(36)} 利番${String(c.user_number).padEnd(10)} 作成${c.created_at?.slice(0, 10)}`);
  }
  if (toDelete.length > 30) console.log(`   … 他 ${toDelete.length - 30} 名`);
  if (keep.length) {
    console.log(`\n― 参照があるので残す ${keep.length} 名 ―`);
    for (const c of keep) console.log(`   ${String(c.name).slice(0, 34).padEnd(36)} ← ${refs.get(c.id).join(", ")}`);
  }
  console.log(`\n⚠ 生年月日も番号も無い **個人名** はこの script では触らない (判断が要るため)`);

  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }

  writeFileSync(BACKUP, JSON.stringify(toDelete.map((c) => ({
    id: c.id, name: c.name, user_number: c.user_number, created_at: c.created_at,
  })), null, 2), "utf8");

  let ok = 0, ng = 0;
  for (const c of toDelete) {
    const { error } = await sb.from("clients").delete().eq("id", c.id);
    if (error) { console.error(`✗ ${c.name}: ${error.message}`); ng++; continue; }
    ok++;
  }
  console.log(`\n消した ${ok} 名 / 失敗 ${ng} 名`);
  console.log(`消した一覧を ${path.basename(BACKUP)} に残しました`);
}

main().catch((e) => { console.error(e); process.exit(1); });
