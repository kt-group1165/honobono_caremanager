// shogai_jogen_kanri_results.office_id の backfill
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   migrations/shogai_jogen_kanri_office_scope.sql で office_id 列を足し、
//   1 利用者 1 か月に **事業所ごとの管理結果**を持てるようにしたが、
//   既存行は NULL のまま残っている (2026-09-03 時点で 13/13 行が NULL)。
//
//   src/lib/shogai-seikyu/aggregate.ts (3.6) は office_id NULL の行を
//   「旧データ」として **どの事業所にもフォールバック適用**する。
//   複数事業所が関わる利用者では 両方の事業所に同じ決定額が効いてしまい、
//   migration が防ごうとした状態がそのまま残る。
//
// ── 事業所の決め方 (根拠の強い順) ────────────────────────────────────
//   ① その利用者・その月に **障害の実績 (kaigo_visit_schedule system='障害')**
//      がある自社事業所が 1 つだけ → それ (実際に請求した事業所)
//   ② ①が 0 or 複数 → 障害事業所番号を持つ割当事業所が 1 つだけならそれ
//   ③ どちらでも決まらない → **NULL のまま残して一覧に出す** (手で確認)
//
//   ⚠ 推測で埋めない。②で決まらないものを機械的に片方へ寄せると、
//     決定額が誤った事業所に効いて過大/過少請求になる。
//
//   node migrations/backfill_shogai_jogen_kanri_office_id.mjs            # DRY RUN
//   node migrations/backfill_shogai_jogen_kanri_office_id.mjs --execute
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

async function pageAll(table, select, apply) {
  const out = [];
  let from = 0;
  for (;;) {
    let q = sb.from(table).select(select).order("id").range(from, from + 999);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function main() {
  console.log(`=== shogai_jogen_kanri_results.office_id backfill ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data: targets, error: tErr } = await sb
    .from("shogai_jogen_kanri_results")
    .select("id, client_id, target_month, kanri_result, kanri_result_amount")
    .is("office_id", null);
  if (tErr) {
    if (tErr.code === "42703") {
      console.error("✗ office_id 列がありません。先に migrations/shogai_jogen_kanri_office_scope.sql を適用してください。");
      process.exit(1);
    }
    console.error(`✗ 取得失敗: ${tErr.message}`);
    process.exit(1);
  }
  console.log(`office_id が NULL の行: ${targets.length}件`);
  if (targets.length === 0) return;

  const clientIds = [...new Set(targets.map((r) => r.client_id))];
  const { data: clients, error: cErr } = await sb.from("clients").select("id, name").in("id", clientIds);
  if (cErr) { console.error(`✗ clients: ${cErr.message}`); process.exit(1); }
  const nameById = new Map(clients.map((c) => [c.id, c.name]));

  // 自社事業所 (障害事業所番号を持つもの = 障害を請求できる事業所)
  const { data: offices, error: oErr } = await sb
    .from("offices")
    .select("id, name, shogai_business_number");
  if (oErr) { console.error(`✗ offices: ${oErr.message}`); process.exit(1); }
  const officeById = new Map(offices.map((o) => [o.id, o]));
  const shogaiOfficeIds = new Set(offices.filter((o) => o.shogai_business_number).map((o) => o.id));

  const { data: assigns, error: aErr } = await sb
    .from("client_office_assignments")
    .select("client_id, office_id")
    .in("client_id", clientIds);
  if (aErr) { console.error(`✗ client_office_assignments: ${aErr.message}`); process.exit(1); }
  const assignedByClient = new Map();
  for (const a of assigns) {
    if (!assignedByClient.has(a.client_id)) assignedByClient.set(a.client_id, new Set());
    assignedByClient.get(a.client_id).add(a.office_id);
  }

  // ① 対象月に障害の実績がある事業所
  const months = [...new Set(targets.map((r) => r.target_month))];
  const visitOfficeByKey = new Map(); // `${client_id}|${YYYY-MM}` -> Set(office_id)
  for (const ym of months) {
    const first = `${ym}-01`;
    const [y, m] = ym.split("-").map(Number);
    const nextFirst = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const visits = await pageAll(
      "kaigo_visit_schedule",
      "user_id, office_id, visit_date, system",
      (q) => q.eq("system", "障害").gte("visit_date", first).lt("visit_date", nextFirst).in("user_id", clientIds),
    );
    for (const v of visits) {
      if (!v.office_id) continue;
      const k = `${v.user_id}|${ym}`;
      if (!visitOfficeByKey.has(k)) visitOfficeByKey.set(k, new Set());
      visitOfficeByKey.get(k).add(v.office_id);
    }
  }

  const updates = [];
  const manual = [];
  for (const r of targets) {
    const label = `${nameById.get(r.client_id) ?? r.client_id} ${r.target_month} (結果${r.kanri_result}/${r.kanri_result_amount}円)`;
    const byVisit = [...(visitOfficeByKey.get(`${r.client_id}|${r.target_month}`) ?? [])].filter((id) => shogaiOfficeIds.has(id));
    if (byVisit.length === 1) {
      updates.push({ id: r.id, officeId: byVisit[0], label, reason: "①当月の障害実績" });
      continue;
    }
    const assigned = [...(assignedByClient.get(r.client_id) ?? [])].filter((id) => shogaiOfficeIds.has(id));
    if (assigned.length === 1) {
      updates.push({ id: r.id, officeId: assigned[0], label, reason: "②障害指定の割当事業所が1件" });
      continue;
    }
    manual.push({
      label,
      visitOffices: byVisit.map((id) => officeById.get(id)?.name ?? id),
      assignedOffices: assigned.map((id) => officeById.get(id)?.name ?? id),
    });
  }

  console.log(`\n── 自動で決まる: ${updates.length}件 ──`);
  for (const u of updates) {
    console.log(`  ${u.label}\n    → ${officeById.get(u.officeId)?.name ?? u.officeId}  [${u.reason}]`);
  }
  if (manual.length > 0) {
    console.log(`\n── ⚠ 決まらない (NULL のまま。画面で保存し直すか手で確認): ${manual.length}件 ──`);
    for (const m of manual) {
      console.log(`  ${m.label}`);
      console.log(`    当月の障害実績がある事業所: ${m.visitOffices.length ? m.visitOffices.join(" / ") : "なし"}`);
      console.log(`    障害指定の割当事業所      : ${m.assignedOffices.join(" / ")}`);
    }
  }

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で更新します。");
    return;
  }

  let ok = 0;
  for (const u of updates) {
    const { error } = await sb
      .from("shogai_jogen_kanri_results")
      .update({ office_id: u.officeId })
      .eq("id", u.id)
      .is("office_id", null); // 競合で既に埋まっていたら触らない
    if (error) { console.error(`✗ ${u.label}: ${error.message}`); continue; }
    ok++;
  }
  console.log(`\n✓ ${ok}/${updates.length} 件を更新しました (残 NULL: ${targets.length - ok}件)`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
