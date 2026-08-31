// ============================================================================
// 既にある第2表のサービス行に **課題・長期目標・短期目標・期間** を埋め戻す
//
//   取り込んだときは列が無かったので、サービス内容・種別・事業者・頻度 だけが
//   入っている (14,774 行)。課題は notes に「課題: …」と文字で入っているだけで、
//   長期・短期目標は kaigo_care_plans 側に全部つなげた 1 本のテキストになっていた。
//
//   ほのぼのの ケアプラン/全/KAIGO1_H31.CSV から同じ世代の行を引き直して当てる。
//
// ⚠ **消して入れ直さない**。行を消すと手で直したものまで飛ぶので UPDATE で当てる。
//   突き合わせは 1 プランの中で (サービス種別, サービス内容, 事業者) が
//   **1 対 1 に対応するとき**だけ。ひとつでも曖昧なプランは丸ごと飛ばして一覧に出す。
//
//   node migrations/backfill_care_plan_service_goals.mjs             # DRY RUN
//   node migrations/backfill_care_plan_service_goals.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const iso = (v) => {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec((v ?? "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};

async function fetchAll(table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order("id").order("id").range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** 突合キー。取込時の組み立て方に合わせる (service_type は空なら内容で補われていた) */
const rowKey = (type, content, provider) =>
  [String(type ?? "").trim(), String(content ?? "").trim(), String(provider ?? "").trim()].join("");

async function main() {
  console.log(`=== 第2表に課題・目標を埋め戻す ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const probe = await sb.from("kaigo_care_plan_services").select("needs").limit(1);
  if (probe.error) {
    console.error(`✗ 課題・目標の列がありません。migrations/care_plan_services_goals.sql を先に適用してください。`);
    console.error(`  (${probe.error.message})`);
    process.exit(1);
  }

  const csv = path.join(ROOT, "ケアプラン/全/KAIGO1_H31.CSV");
  if (!existsSync(csv)) { console.error(`✗ ${csv} が無い`); process.exit(1); }
  const lines = iconv.decode(readFileSync(csv), "Shift_JIS").split(/\r?\n/);
  console.log(`  KAIGO1_H31.CSV ${lines.length - 1} 行`);

  // (保険者|被保番) → 作成日 → 行[]
  const byKeyGen = new Map();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const r = line.split(",").map((x) => x.replace(/^"|"$/g, ""));
    const key = `${r[0]}|${r[1]}`;
    const made = iso(r[3]) ?? iso(r[2]) ?? "";
    if (!byKeyGen.has(key)) byKeyGen.set(key, new Map());
    const g = byKeyGen.get(key);
    if (!g.has(made)) g.set(made, []);
    g.get(made).push({
      order: Number(r[4] || 0), issue: r[5], longGoal: r[6], shortGoal: r[7],
      content: r[8], kind: r[10], provider: r[14],
      longStart: iso(r[22]), longEnd: iso(r[23]),
      shortStart: iso(r[24]), shortEnd: iso(r[25]),
      svcStart: iso(r[26]), svcEnd: iso(r[27]),
    });
  }

  // client → (保険者, 被保番)
  const certs = await fetchAll("client_insurance_records", "client_id, insurer_number, insured_number");
  const keysByClient = new Map();
  for (const c of certs) {
    if (!c.insurer_number || !c.insured_number) continue;
    if (!keysByClient.has(c.client_id)) keysByClient.set(c.client_id, new Set());
    keysByClient.get(c.client_id).add(`${c.insurer_number}|${c.insured_number}`);
  }

  const plans = await fetchAll("kaigo_care_plans", "id, user_id, start_date", (q) => q.eq("tenant_id", TENANT));
  const planById = new Map(plans.map((p) => [p.id, p]));
  const svcRows = await fetchAll("kaigo_care_plan_services",
    "id, care_plan_id, service_type, service_content, provider, needs", (q) => q.eq("tenant_id", TENANT));
  console.log(`  当方: 計画書 ${plans.length} / サービス行 ${svcRows.length}`);

  const byPlan = new Map();
  for (const r of svcRows) {
    if (!byPlan.has(r.care_plan_id)) byPlan.set(r.care_plan_id, []);
    byPlan.get(r.care_plan_id).push(r);
  }

  const updates = [];
  const skipped = { already: 0, noKey: 0, noGen: 0, mismatch: 0 };
  const mismatchEg = [];
  for (const [planId, rows] of byPlan) {
    if (rows.every((r) => r.needs != null)) { skipped.already++; continue; }
    const plan = planById.get(planId);
    if (!plan) { skipped.noKey++; continue; }
    const keys = keysByClient.get(plan.user_id);
    if (!keys) { skipped.noKey++; continue; }

    // その利用者の世代のうち、**プランの開始日と同じ作成日**の行を使う。
    // 無ければ「開始日以前で最も新しい世代」に落とす。
    let cand = null;
    for (const k of keys) {
      const gens = byKeyGen.get(k);
      if (!gens) continue;
      const exact = gens.get(String(plan.start_date ?? ""));
      if (exact) { cand = exact; break; }
      const older = [...gens.keys()].filter((g) => g && g <= String(plan.start_date ?? "9999")).sort().pop();
      if (older && !cand) cand = gens.get(older);
      // 開始日以前の世代が無い人もいる (計画の登録が後から入った等)。
      // その場合は一番新しい世代に落とす。
      if (!cand) {
        const newest = [...gens.keys()].filter(Boolean).sort().pop();
        if (newest) cand = gens.get(newest);
      }
    }
    if (!cand) { skipped.noGen++; continue; }

    // 1 対 1 に対応するときだけ当てる
    const csvByKey = new Map();
    for (const c of cand) {
      const k = rowKey(c.kind || c.content || "その他", c.content || c.kind || "（記載なし）", c.provider || "");
      if (!csvByKey.has(k)) csvByKey.set(k, []);
      csvByKey.get(k).push(c);
    }
    // ⚠ プラン単位で「全部そろわないと当てない」にすると、サンプル投入された行が
    //   混ざっているプランが丸ごと落ちる。**行単位**で、CSV に同じ
    //   (種別, 内容, 事業者) が居るものだけ当てる。当たらない行は触らない。
    const pairs = [];
    const used = new Map();
    let unmatched = 0;
    for (const r of rows) {
      const k = rowKey(r.service_type, r.service_content, r.provider ?? "");
      const list = csvByKey.get(k);
      const i = used.get(k) ?? 0;
      if (!list || i >= list.length) { unmatched++; continue; }
      used.set(k, i + 1);
      pairs.push({ row: r, csv: list[i] });
    }
    if (unmatched) {
      skipped.mismatch += unmatched;
      if (mismatchEg.length < 5)
        mismatchEg.push(`計画 ${planId}: ${pairs.length} 行は当たり ${unmatched} 行は CSV に無い (当方 ${rows.length} / CSV ${cand.length})`);
    }
    updates.push(...pairs);
  }

  console.log(`\n  当てられる ${updates.length} 行`);
  console.log(`  飛ばす: 既に入っている ${skipped.already} プラン / 引けない ${skipped.noKey} / ` +
    `該当世代なし ${skipped.noGen} プラン / CSV に無い行 ${skipped.mismatch} 行`);
  for (const e of mismatchEg) console.log(`     ${e}`);
  if (updates.length) {
    const u = updates[0];
    console.log(`\n  例) ${u.row.service_content}`);
    console.log(`     課題: ${(u.csv.issue || "").slice(0, 60)}`);
    console.log(`     長期: ${(u.csv.longGoal || "").slice(0, 60)}  (${u.csv.longStart}〜${u.csv.longEnd})`);
    console.log(`     短期: ${(u.csv.shortGoal || "").slice(0, 60)}  (${u.csv.shortStart}〜${u.csv.shortEnd})`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }

  // 1 行ずつ往復すると 1 万行で 10 分かかる。10 本ずつ並べる。
  let n = 0;
  const LANES = 10;
  const queue = updates.slice();
  const worker = async () => {
    for (;;) {
      const u = queue.shift();
      if (!u) return;
      const { error } = await sb.from("kaigo_care_plan_services").update({
        needs: u.csv.issue || null,
        long_term_goal: u.csv.longGoal || null,
        long_term_start: u.csv.longStart, long_term_end: u.csv.longEnd,
        short_term_goal: u.csv.shortGoal || null,
        short_term_start: u.csv.shortStart, short_term_end: u.csv.shortEnd,
        service_start: u.csv.svcStart, service_end: u.csv.svcEnd,
        display_order: Number.isFinite(u.csv.order) ? u.csv.order : null,
      }).eq("id", u.row.id);
      if (error) { console.error(`✗ ${u.row.id}: ${error.message}`); process.exit(1); }
      if (++n % 1000 === 0) console.log(`  ${n}/${updates.length}`);
    }
  };
  await Promise.all(Array.from({ length: LANES }, worker));
  console.log(`\n✓ ${n} 行に課題・目標を入れました`);
}

main();
