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
import { readFileSync } from "node:fs";
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

/** clients を参照する表と、その列名 */
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
  ["kaigo_visit_records", "client_id"],
  ["kaigo_visit_schedule", "client_id"],
  ["kaigo_visit_patterns", "client_id"],
  ["kaigo_visit_addon_lines", "client_id"],
  ["kaigo_visit_month_addons", "client_id"],
  ["kaigo_care_plans", "client_id"],
  ["kaigo_care_plan_services", "client_id"],
  ["kaigo_assessments", "client_id"],
  ["kaigo_monitoring_sheets", "client_id"],
  ["kaigo_support_records", "client_id"],
  ["kaigo_care_conferences", "client_id"],
  ["kaigo_adl_records", "client_id"],
  ["kaigo_health_records", "client_id"],
  ["kaigo_medical_history", "client_id"],
  ["kaigo_medical_insurance", "client_id"],
  ["kaigo_family_contacts", "client_id"],
  ["kaigo_emergency_sheets", "client_id"],
  ["kaigo_user_contracts", "client_id"],
  ["kaigo_riyou_settings", "client_id"],
  ["kaigo_monthly_plan_units", "client_id"],
  ["kaigo_gendo_allocation", "client_id"],
  ["kaigo_benefit_management", "client_id"],
  ["kaigo_billing_records", "client_id"],
  ["kaigo_billing_details", "client_id"],
  ["kaigo_billing_addons", "client_id"],
  ["kaigo_billing_status", "client_id"],
  ["kaigo_houmon_care_plans", "client_id"],
  ["kaigo_idou_shien_records", "client_id"],
  ["kaigo_bath_visit_records", "client_id"],
  ["kaigo_bath_schedule", "client_id"],
  ["kaigo_bath_patterns", "client_id"],
  ["kaigo_service_records", "client_id"],
  // ⚠ この表の列は client_id ではなく **user_id**。誤ったまま置くと usableRefs が
  //   静かに外し、統合しても帳票が移らない (2026-08-31 に発見)
  ["kaigo_report_documents", "user_id"],
  ["kaigo_emergency_status", "client_id"],
  ["riyou_jippi_entries", "client_id"],
  ["riyou_seikyu_payments", "client_id"],
  ["kaigo_care_support_claims", "user_id"],
  ["signatures", "client_id"],
];

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

async function main() {
  console.log(`=== 利用者の重複統合 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const refs = await usableRefs();
  console.log(`  参照を調べる表 ${refs.length} 個\n`);

  let all = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from("client_insurance_records")
      .select("client_id, insurer_number, insured_number").range(from, from + 999);
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
      .select("id, insurer_number, insured_number, deleted_at").range(cFrom, cFrom + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    cAll = cAll.concat(data);
    if (data.length < 1000) break;
    cFrom += 1000;
  }
  for (const c of cAll) { if (!c.deleted_at) addPair(c.insurer_number, c.insured_number, c.id); }
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
