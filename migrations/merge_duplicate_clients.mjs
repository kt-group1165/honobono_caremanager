// ============================================================================
// (保険者番号, 被保険者番号) が同じなのに clients が 2 つある重複を統合する。
//
//   被保険者番号は保険者の中で一意なので、保険者まで一致して別 client なら
//   **同一人物が二重登録されている**。取込経路が違うと利用者番号が変わるため
//   起きた (短い番号の旧取込 と [MEISAI-STEP1] の長い番号)。
//     青木 久雄  11514 と 2113112925 — 生年も認定も同じ
//
//   ⚠ 生年月日か氏名が食い違うペアは **別人** の可能性がある (どちらかの
//     被保番が誤り)。自動では触らず報告だけする。
//     本多 ふじ江 (1935-07-16) と 古川 秀子 (1942-03-13) が該当。
//
//   残す側 = 参照行が多いほう。同数なら利用者番号が短いほう (先に居たほう)。
//   参照は **全部移してから** 相手を消す。移せない衝突があれば止める。
//
//   node migrations/merge_duplicate_clients.mjs            # DRY RUN
//   node migrations/merge_duplicate_clients.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * clients を参照する表と、その列名。
 *
 * ⚠ 列名は表ごとに **client_id と user_id が混在**している。誤って書くと
 *   usableRefs が外してしまい、参照ゼロに見えて統合でデータが消える。
 *   2026-08-31 に全 51 表を実データで確認し、12 表が user_id だったのを是正した
 *   (kaigo_benefit_management は 5,878 行あり、見落とすと給付管理票が消えていた)。
 *   表を足すときは必ず実物で列名を確かめること。
 */
const REFS = [
  ["client_insurance_records", "client_id"],
  ["client_office_assignments", "client_id"],
  ["client_kohi_records", "client_id"],
  ["client_hospitalizations", "client_id"],
  ["client_memos", "client_id"],
  ["shougai_certifications", "client_id"],
  ["shogai_contracts", "client_id"],
  ["shogai_service_records", "client_id"],
  ["shogai_service_start", "client_id"],
  ["shogai_jogen_kanri_results", "client_id"],
  ["shogai_billing_status", "client_id"],
  ["chiiki_recipient_certs", "client_id"],
  ["kaigo_visit_records", "user_id"],
  ["kaigo_visit_schedule", "user_id"],
  ["kaigo_visit_patterns", "user_id"],
  ["kaigo_visit_addon_lines", "client_id"],
  ["kaigo_visit_month_addons", "client_id"],
  ["kaigo_care_plans", "user_id"],
  // kaigo_care_plan_services は care_plan_id で親 (kaigo_care_plans) にぶら下がる。
  //   利用者列を持たないので、親を移せば付いてくる
  ["kaigo_assessments", "user_id"],
  ["kaigo_monitoring_sheets", "user_id"],
  ["kaigo_support_records", "user_id"],
  ["kaigo_care_conferences", "client_id"],
  ["kaigo_adl_records", "user_id"],
  ["kaigo_health_records", "user_id"],
  ["kaigo_medical_history", "user_id"],
  ["kaigo_medical_insurance", "user_id"],
  ["kaigo_family_contacts", "user_id"],
  ["kaigo_emergency_sheets", "user_id"],
  ["kaigo_user_contracts", "user_id"],
  ["kaigo_riyou_settings", "client_id"],
  ["kaigo_monthly_plan_units", "client_id"],
  ["kaigo_gendo_allocation", "client_id"],
  ["kaigo_benefit_management", "user_id"],
  ["kaigo_billing_records", "user_id"],
  // kaigo_billing_details は billing_record_id で親 (kaigo_billing_records) にぶら下がる。
  //   利用者列を持たないので、親を移せば付いてくる
  // kaigo_billing_addons は office 単位で利用者に紐づかない
  // signatures は DB の表ではなく **Storage のバケット名**。署名画像はバケットに置き、
  //   パスを kaigo_visit_records.signature_image_path に持つ
  ["kaigo_billing_status", "client_id"],
  ["kaigo_houmon_care_plans", "user_id"],
  ["kaigo_idou_shien_records", "client_id"],
  ["kaigo_bath_visit_records", "client_id"],
  ["kaigo_bath_schedule", "client_id"],
  ["kaigo_bath_patterns", "client_id"],
  ["kaigo_service_records", "user_id"],
  // ⚠ この表の列は client_id ではなく **user_id**。誤ったまま置くと usableRefs が
  //   静かに外し、統合しても帳票が移らない (2026-08-31 に発見)
  ["kaigo_report_documents", "user_id"],
  ["kaigo_emergency_status", "user_id"],
  ["riyou_jippi_entries", "client_id"],
  ["riyou_seikyu_payments", "client_id"],
  ["kaigo_care_support_claims", "user_id"],
  // ── 2026-09-03 追加: order-app 側の表。REFS が kaigo-app の表しか見ておらず
  //    **12 表が丸ごと漏れていた** (care_plan_elements 10,098 行 / doc_tasks 4,227 行 等)。
  //    孤立は当時 monitoring_records の 2 行だけだったが、これは統合した 19 組が
  //    たまたま他の表に行を持っていなかっただけ。次の統合で壊れる状態だった。
  ["orders", "client_id"],
  ["care_plan_elements", "client_id"],
  ["doc_tasks", "client_id"],
  ["billing_unit_overrides", "client_id"],
  ["billing_user_invoices", "client_id"],
  ["billing_late_flags", "client_id"],
  ["client_documents", "client_id"],
  ["client_public_expenses", "client_id"],
  ["client_rental_history", "client_id"],
  ["monitoring_records", "client_id"],
  ["renovation_projects", "client_id"],
  ["shared_documents", "client_id"],
  // events は calendar-app の訪問予定。client_id は実利用者を指す (タイトル「〇〇 様」と一致)
  ["events", "client_id"],
  // ── fail-closed 導入時に **空の表 12 個**が追加で見つかった (行が無いので
  //    データ由来の検出では拾えず、列名の規則で初めて出た)。今は 0 行でも
  //    使われ始めた瞬間に統合で孤立するので、先に入れておく。
  ["shogai_seikyu_payments", "client_id"],
  ["billing_rebill_flags", "client_id"],
  ["kaigo_incident_reports", "client_id"],
  ["shogai_service_use_plans", "client_id"],
  ["invoices", "client_id"],
  ["kokuho_shinsa_notice_rows", "client_id"],
  ["shogai_monthly_summaries", "client_id"],
  ["bath_billing_status", "client_id"],
  ["service_meeting_notes", "client_id"],
  ["kaigo_visit_procedure_documents", "client_id"],
  ["kaigo_complaints", "client_id"],
  ["bath_monthly_plan_units", "client_id"],
];

/**
 * **意図的に対象外**にする表と、その理由。
 *   ここに書いていない表が利用者列を持っていたら、下の assertAllClassified が
 *   **実行を止める**。リストを手で更新し続ける運用は必ず古くなるので、
 *   「知らない表があったら止まる」ほうに倒す (fail-closed)。
 */
const EXCLUDED = new Map([
  ["clients", "統合の主体そのもの。付け替え先ではない"],
  ["v_order_margin", "order_items 由来の **ビュー**。実体が無く UPDATE できない (親を移せば追従する)"],
  ["kaigo_care_plan_services", "care_plan_id で親 (kaigo_care_plans) にぶら下がる。利用者列を持たない"],
  ["kaigo_billing_details", "billing_record_id で親 (kaigo_billing_records) にぶら下がる"],
  ["monitoring_items", "monitoring_id で親 (monitoring_records) にぶら下がる"],
  ["order_items", "order_id で親 (orders) にぶら下がる"],
  ["billing_user_invoice_items", "invoice_id で親 (billing_user_invoices) にぶら下がる"],
  ["renovation_project_steps", "project_id で親 (renovation_projects) にぶら下がる"],
  // ── user_id が **認証ユーザー (auth.users)** であって利用者ではない表。
  //    実データで確認済み: clients.id との一致が 0/N (passkey_credentials 4行・
  //    trusted_devices 31行・user_groups 3行・auth_admin_passwords 5行・user_offices 40行)。
  //    利用者統合で触ってはいけない。
  ["passkey_credentials", "user_id は認証ユーザー。実データで clients と 0/4 一致"],
  ["passkey_registration_grants", "同上 (passkey 登録の招待)"],
  ["passkey_challenges", "同上 (認証チャレンジ)"],
  ["trusted_devices", "user_id は認証ユーザー。実データで 0/5 一致"],
  ["auth_admin_passwords", "user_id は認証ユーザー。実データで 0/5 一致"],
  ["user_companies", "user_id は認証ユーザー (所属法人)"],
  ["user_groups", "user_id は認証ユーザー。実データで 0/3 一致"],
  ["user_offices", "user_id は認証ユーザー。実データで 0/5 一致"],
  ["notifications", "user_id は認証ユーザー (通知の宛先)"],
  ["kaigo_ai_usage_logs", "user_id は認証ユーザー (AI 利用ログ)"],
]);

/**
 * ★ fail-closed: **利用者を指す列を持つ表が REFS にも EXCLUDED にも無ければ実行を止める。**
 *
 *   判定は 2 系統の OR で、片方だけでは漏れる:
 *     (A) 列名が client_id / user_id     … 全行が孤立している表でも拾える
 *     (B) 実データが clients.id に当たる … 変わった列名でも拾える
 *   実際 (B) だけだと client_public_expenses (1 行しか無く、その 1 行が孤立) を
 *   取りこぼした。両方要る。
 *
 *   表の一覧は information_schema が REST から見えないので **PostgREST の OpenAPI**
 *   (GET /rest/v1/) から取る。
 */
async function assertAllClassified(clientIds) {
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    console.error(`✗ 表一覧 (OpenAPI) を取得できません: ${res.status} — 分類を確認できないので中止します`);
    process.exit(1);
  }
  const spec = await res.json();
  const defs = spec.definitions ?? spec.components?.schemas ?? {};
  const tables = Object.entries(defs).map(([t, d]) => ({ t, cols: Object.keys(d.properties ?? {}) }));

  const unclassified = [];
  for (const { t, cols } of tables) {
    if (/^_backup/.test(t)) continue;          // 退避表は対象外 (名前で判別できる)
    if (REFS.some(([rt]) => rt === t) || EXCLUDED.has(t)) continue;
    // (A) 名前で判定
    let hit = cols.find((c) => c === "client_id" || c === "user_id") ?? null;
    // (B) 実データで判定
    if (!hit) {
      for (const c of cols.filter((c) => /_id$/.test(c) && !/^(id|tenant_id)$/.test(c))) {
        const { data, error } = await sb.from(t).select(c).not(c, "is", null).limit(30);
        if (error || !data?.length) continue;
        const vals = data.map((r) => r[c]).filter(Boolean);
        if (vals.length && vals.filter((v) => clientIds.has(v)).length / vals.length >= 0.5) { hit = c; break; }
      }
    }
    if (hit) unclassified.push(`${t}.${hit}`);
  }
  if (unclassified.length) {
    console.error(`
✗ 未分類の表が ${unclassified.length} 個あります。REFS か EXCLUDED に分類してください:`);
    for (const u of unclassified) console.error(`     ${u}`);
    console.error("  (放置すると統合で参照が孤立します。EXCLUDED に入れるときは理由も書くこと)");
    process.exit(1);
  }
  console.log(`  ✓ 利用者を指す表はすべて分類済み (REFS ${REFS.length} / EXCLUDED ${EXCLUDED.size} / 走査 ${tables.length} 表)`);
}

/** その表が存在し、その列を持つか (無ければ静かに外す) */
async function usableRefs() {
  const ok = [];
  const dropped = [];
  for (const [table, col] of REFS) {
    const { error } = await sb.from(table).select(col).limit(1);
    if (!error) ok.push([table, col]);
    else if (/does not exist|Could not find/i.test(error.message)) {
      // ⚠ 黙って外すと「参照ゼロ」に見えて統合の判断を誤る。必ず出す
      dropped.push(`${table}.${col}`);
    } else {
      console.error(`✗ ${table}.${col}: ${error.message}`); process.exit(1);
    }
  }
  if (dropped.length) {
    console.log(`  ⚠ 表または列が無いので参照を見られない: ${dropped.length} 個`);
    for (const d of dropped) console.log(`     ${d}`);
    console.log("    (列名の誤りだと参照を見落として統合事故になる。中身を確認すること)");
  }
  return ok;
}

async function countRefs(refs, clientId) {
  const per = {};
  let total = 0;
  for (const [table, col] of refs) {
    const { count, error } = await sb.from(table).select("*", { count: "exact", head: true }).eq(col, clientId);
    if (error) { console.error(`✗ ${table} の集計失敗: ${error.message}`); process.exit(1); }
    if (count) { per[table] = count; total += count; }
  }
  return { per, total };
}

const norm = (s) => (s ?? "").normalize("NFKC").replace(/[\s　()（）]|\(実\)/g, "");

// ── 利用者マスタ CSV (Shift_JIS)。番号が食い違うペアの同定に使う ──────────
const sjis = new TextDecoder("shift_jis");
function parseLine(line) {
  const out = []; let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(f); f = ""; }
    else f += c;
  }
  out.push(f); return out;
}
/** (保険者|被保番) -> 利用者名。ほのぼのの利用者マスタから作る */
function loadCsvPairNames() {
  const base = path.join(KAIGO, "利用者データ");
  const files = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let ents; try { ents = readdirSync(d); } catch { return; }
    for (const n of ents) {
      const p2 = path.join(d, n);
      let st; try { st = statSync(p2); } catch { continue; }
      if (st.isDirectory()) walk(p2, depth + 1);
      else if (/^介護保険.*\.csv$/i.test(n)) files.push(p2);
    }
  };
  walk(base, 0);
  const map = new Map();
  for (const f of files) {
    const L = sjis.decode(readFileSync(f)).split(/\r?\n/).filter((x) => x !== "");
    if (!L.length) continue;
    const h = parseLine(L[0]).map((x) => x.trim());
    const ix = {}; h.forEach((x, i) => { if (!(x in ix)) ix[x] = i; });
    if (!("被保険者番号" in ix) || !("保険者番号" in ix) || !("利用者名" in ix)) continue;
    for (const line of L.slice(1)) {
      const r = parseLine(line);
      const g2 = (k) => (ix[k] != null && ix[k] < r.length ? (r[ix[k]] ?? "").trim() : "");
      const k = `${g2("保険者番号")}|${g2("被保険者番号")}`;
      const nm = g2("利用者名");
      if (nm && !map.has(k)) map.set(k, nm);
    }
  }
  return map;
}

async function main() {
  console.log(`=== 利用者の重複統合 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  // ★ 分類漏れがあれば **ここで止まる** (fail-closed)。clients.id は判定に使うので先に取る
  {
    const idsForCheck = new Set();
    for (let f = 0; ; f += 1000) {
      const { data, error } = await sb.from("clients").select("id").order("id").range(f, f + 999);
      if (error) { console.error(`✗ clients の取得に失敗: ${error.message}`); process.exit(1); }
      for (const r of data) idsForCheck.add(r.id);
      if (data.length < 1000) break;
    }
    await assertAllClassified(idsForCheck);
  }
  const refs = await usableRefs();
  console.log(`  参照を調べる表 ${refs.length} 個\n`);

  let all = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from("client_insurance_records")
      .select("client_id, insurer_number, insured_number").order("id").range(from, from + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const groups = new Map();
  const addPair = (insurer, insured, clientId) => {
    if (!insured || !insurer) return;
    const k = `${insurer}|${insured}`;
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k).add(clientId);
  };
  for (const r of all) addPair(r.insurer_number, r.insured_number, r.client_id);

  // ⚠ 認定レコードだけを見ると、**認定を持たない重複が拾えない**。
  //   古い取込で作られて参照ゼロのまま残っている client がこれに当たり、
  //   2026-08-31 時点で 6 組が検出漏れになっていた (河連ユキ・堤威 等)。
  //   clients 側の (保険者, 被保番) も突き合わせる。
  let cAll = [], cFrom = 0;
  for (;;) {
    const { data, error } = await sb.from("clients")
      .select("id, name, birth_date, insurer_number, insured_number, deleted_at").order("id").range(cFrom, cFrom + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    cAll = cAll.concat(data);
    if (data.length < 1000) break;
    cFrom += 1000;
  }
  for (const c of cAll) { if (!c.deleted_at) addPair(c.insurer_number, c.insured_number, c.id); }

  // ⚠ (保険者, 被保番) が一致しないと同じキーにならないので、**番号が割れている
  //   同一人物**は上のやり方では拾えない。2026-08-31 に実データで確認した割れ方:
  //     ・被保番の桁落ち   "22717" と "0000022717" (木更津市で 4 組)
  //     ・片方が null      古い取込が番号を入れずに作った (2 組)
  //     ・仮番号と実番号   "8844225599" と "1000142636" 等 (3 組)
  //   氏名 + 生年月日 でも束ねる。ただし **番号が矛盾しないものだけ**:
  //     片方が空 / ゼロ埋めすると一致 … 同一人物とみて束ねる
  //     どちらも実在の別番号           … 人が確かめる話なので束ねず一覧に出す
  const csvPairNames = loadCsvPairNames();
  const padNum = (s) => (/^\d+$/.test(String(s ?? "")) ? String(s).padStart(10, "0") : (s ?? null));
  const nameBirth = new Map();
  for (const c of cAll) {
    if (c.deleted_at || !c.birth_date || !c.name) continue;
    const k = `${norm(c.name)}|${c.birth_date}`;
    if (!nameBirth.has(k)) nameBirth.set(k, []);
    nameBirth.get(k).push(c);
  }
  const numberConflicts = [];
  for (const [k, cs] of nameBirth) {
    if (cs.length !== 2) continue;                       // 3 件以上は手当てが必要
    const [a, b] = cs;
    const ka = a.insurer_number && a.insured_number ? `${a.insurer_number}|${padNum(a.insured_number)}` : null;
    const kb = b.insurer_number && b.insured_number ? `${b.insurer_number}|${padNum(b.insured_number)}` : null;
    if (ka && kb && ka !== kb) {
      // 番号が違っても **CSV で同じ氏名に紐づく**なら同一人物。実データの内訳:
      //   ・番号が途中で変わった  内海 淳 H333010211 (〜2026/04/21) → 1000304436 (2026/04/22〜)
      //   ・片方が当方だけの偽番号 山田 隆一 8844225599 / 鈴木 清子 4488822211 は CSV に無い
      const na = csvPairNames.get(`${a.insurer_number}|${a.insured_number}`);
      const nb2 = csvPairNames.get(`${b.insurer_number}|${b.insured_number}`);
      const nmA = na ? norm(na) : null, nmB = nb2 ? norm(nb2) : null;
      const target = norm(a.name);
      const bothSame = nmA && nmB && nmA === nmB && nmA === target;   // 番号が変わっただけ
      const oneFake = ((nmA === target && !nmB) || (nmB === target && !nmA)); // 片方が CSV に無い偽番号
      if (!bothSame && !oneFake) {
        numberConflicts.push(`${k} … ${a.insurer_number}|${a.insured_number} と ${b.insurer_number}|${b.insured_number} (CSV で同定できない。人が確かめる)`);
        continue;
      }
      // CSV に載っているほうの番号をキーにする (偽番号や旧番号ではなく実番号に寄せる)
      const realKey = nmB === target && !nmA ? `${b.insurer_number}|${padNum(b.insured_number)}`
        : nmA === target && !nmB ? `${a.insurer_number}|${padNum(a.insured_number)}`
        : ka;
      if (!groups.has(realKey)) groups.set(realKey, new Set());
      groups.get(realKey).add(a.id); groups.get(realKey).add(b.id);
      console.log(`  ↔ ${k}: ${bothSame ? "番号が変わっただけ" : "片方が CSV に無い偽番号"} → 同一人物として統合する`);
      continue;
    }
    const key = ka ?? kb ?? `name-birth:${k}`;
    if (groups.get(key)?.has(a.id) && groups.get(key)?.has(b.id)) continue;   // 既に束ねている
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(a.id); groups.get(key).add(b.id);
  }
  if (numberConflicts.length) {
    console.log(`  ⚠ 氏名+生年月日は同じだが被保険者番号が食い違う: ${numberConflicts.length} 組 (触らない)`);
    for (const s of numberConflicts) console.log(`     ${s}`);
    console.log("");
  }

  const dups = [...groups.entries()].filter(([, s]) => s.size > 1);
  const ids = [...new Set(dups.flatMap(([, s]) => [...s]))];
  const cl = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const { data } = await sb.from("clients").select("id, name, user_number, birth_date").in("id", ids.slice(i, i + 50));
    for (const c of data ?? []) cl.set(c.id, c);
  }

  const plans = [], manual = [];
  for (const [key, set] of dups) {
    const cs = [...set].map((id) => cl.get(id)).filter(Boolean);
    if (cs.length !== 2) { manual.push(`${key}: client が ${cs.length} 件 — 手当てが必要`); continue; }
    const [a, b] = cs;
    // 保険者+被保番が一致していて **生年月日も同じ**なら同一人物とみなす。
    // 氏名は表記ゆれが多く判定に使えない (「市川 幹子」と「市川 幹子(実)」、
    // 「井出 ヒサ子」と「井手 ヒサ子」= 誤字)。生年が違うときだけ別人を疑う。
    if (!a.birth_date || !b.birth_date) {
      manual.push(`${key}: 生年月日が空で判定できない — ${a.name} / ${b.name}`);
      continue;
    }
    if (a.birth_date !== b.birth_date) {
      manual.push(`${key}: 別人 — ${a.name}(${a.birth_date}) と ${b.name}(${b.birth_date})。どちらかの被保番が誤り`);
      continue;
    }
    const ra = await countRefs(refs, a.id), rb = await countRefs(refs, b.id);
    // 参照が多いほうを残す。同数なら利用者番号が短いほう (先に居たほう)
    let keep = a, drop = b, kr = ra, dr = rb;
    if (rb.total > ra.total || (rb.total === ra.total && (b.user_number ?? "").length < (a.user_number ?? "").length)) {
      keep = b; drop = a; kr = rb; dr = ra;
    }
    plans.push({ key, keep, drop, kr, dr });
  }

  for (const p of plans) {
    const nameNote = norm(p.keep.name) !== norm(p.drop.name) ? `  ⚠ 氏名が違う: 「${p.keep.name}」を残し「${p.drop.name}」を消す` : "";
    console.log(`  ${p.keep.name}  [${p.key}]${nameNote}`);
    console.log(`     残す ${p.keep.user_number} (参照 ${p.kr.total}) ← 消す ${p.drop.user_number} (参照 ${p.dr.total})`);
    const moved = Object.entries(p.dr.per).map(([t, n]) => `${t}:${n}`).join(" ");
    if (moved) console.log(`     移す: ${moved}`);
  }
  if (manual.length) {
    console.log(`\n  -- 自動で触らないもの ${manual.length} 件 --`);
    for (const m of manual) console.log(`     ${m}`);
  }
  console.log(`\n  統合対象 ${plans.length} 組`);
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で統合します。"); return; }

  for (const p of plans) {
    for (const [table, col] of refs) {
      const n = p.dr.per[table];
      if (!n) continue;
      const { error } = await sb.from(table).update({ [col]: p.keep.id }).eq(col, p.drop.id);
      if (error) {
        // UNIQUE 衝突 = 両方に同じ行がある。消す側の行を落として残す側を活かす
        if (/duplicate key|unique constraint/i.test(error.message)) {
          const del = await sb.from(table).delete().eq(col, p.drop.id);
          if (del.error) { console.error(`✗ ${p.keep.name} ${table}: ${del.error.message}`); process.exit(1); }
          console.log(`     ${table}: ${n} 行は残す側にも有るので消す側を削除`);
          continue;
        }
        console.error(`✗ ${p.keep.name} ${table}: ${error.message}`); process.exit(1);
      }
    }
    const del = await sb.from("clients").delete().eq("id", p.drop.id);
    if (del.error) { console.error(`✗ ${p.keep.name} の削除失敗: ${del.error.message}`); process.exit(1); }
    console.log(`  ✓ ${p.keep.name} (${p.drop.user_number} を ${p.keep.user_number} に統合)`);
  }
  console.log(`\n✓ ${plans.length} 組を統合しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
