// ============================================================================
// 同じ認定が何行も入っているのを 1 行に寄せる (無損失)。
//
//   node migrations/dedupe_insurance_records.mjs             # DRY RUN
//   node migrations/dedupe_insurance_records.mjs --execute
//
// ── 何が起きているか ────────────────────────────────────────────────────
//   `[認定履歴取込 2026-08-04]` が、**最新世代の値を全行に書いていた**。
//   ほのぼのの CSV は認定の世代ごとに 1 行あるのに、当方は同じ内容が N 行:
//
//     CSV   志村 道子  8 世代 (要支援2 → 要介護1 → 2 → 5 → 4 → 3 → 4 と推移)
//     当方  6 行すべて「要介護4 / 30938 / 2026-06-01〜2027-05-31」= 最新世代の複製
//
//   2026-08-31 時点で **86 組 / 余分な行 164 件**。
//
//   ⚠ **過去の認定履歴はすでに失われている。**この script はそれを復元しない。
//     履歴が要るなら `認定履歴取込` を直して入れ直すこと (別作業)。
//     ここでやるのは「同じ行が何個もある」状態の解消だけ。
//
// ── 無損失にするための決まり ────────────────────────────────────────────
//   ① 同じ (利用者, 保険者, 被保番, 認定期間, 要介護度, 限度額) をひとまとめにする
//   ② その中で **値が一番埋まっている行**を残す
//      (MEISAI-STEP1 の行は 適用期間・支援事業所名 まで入っているので普通これが残る)
//   ③ 消す行が残す行の **部分集合であること**を 1 列ずつ確認する。
//      消す行だけが持っている値が 1 つでもあれば、その組は触らずに報告する。
//   ④ 帳票 (kaigo_report_documents.certification_id) が消す行を指していたら、
//      **残す行に付け替えてから**消す。付け替えに失敗したら消さない。
//
//   消した内容は migrations/_deduped_insurance_records.json に残す。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const BACKUP = path.join(KAIGO, "migrations/_deduped_insurance_records.json");

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

/** まとめる単位。ここが同じなら「同じ認定」とみなす */
const KEY_COLS = ["client_id", "insurer_number", "insured_number",
  "certification_start_date", "certification_end_date", "care_level", "service_limit_amount"];
/** 比較から外す列 (行ごとに必ず違う / 意味を持たない) */
const IGNORE = new Set(["id", "created_at", "updated_at", "notes"]);

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

const filled = (r) => Object.entries(r).filter(([k, v]) => !IGNORE.has(k) && v != null && v !== "").length;

async function main() {
  console.log(`=== 同じ認定が何行も入っているのを 1 行に寄せる ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const certs = await fetchAll(() => sb.from("client_insurance_records").select("*"));
  const clients = new Map((await fetchAll(() => sb.from("clients").select("id, name"))).map((c) => [c.id, c.name]));
  const docs = await fetchAll(() => sb.from("kaigo_report_documents")
    .select("id, certification_id").not("certification_id", "is", null));
  const docsByCert = new Map();
  for (const d of docs) {
    if (!docsByCert.has(d.certification_id)) docsByCert.set(d.certification_id, []);
    docsByCert.get(d.certification_id).push(d.id);
  }

  const groups = new Map();
  for (const r of certs) {
    const k = KEY_COLS.map((c) => String(r[c] ?? "")).join("|");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const dups = [...groups.values()].filter((v) => v.length > 1);
  console.log(`認定 ${certs.length} 件 / 同じ内容が 2 行以上ある組 ${dups.length}`);

  const plan = [], skipped = [];
  for (const rows of dups) {
    const sorted = [...rows].sort((a, b) => filled(b) - filled(a));
    const keep = sorted[0];
    const drop = [];
    const merge = {};        // 残す行に足りない値。消す前に移す
    let bad = null;
    for (const r of sorted.slice(1)) {
      // ③ 消す行だけが持つ値は **捨てずに残す行へ移す**。
      //   実データでは 認定履歴取込 の行が limit_period_start/end を持ち、
      //   MEISAI-STEP1 の行が service_limit_period_start/end を持っていた。
      //   どちらか片方を消すと、その列の値が失われる。
      //   ⚠ 消す行どうしで値が食い違う場合は判断できないので触らない。
      const extra = Object.keys(r).filter((c) =>
        !IGNORE.has(c) && r[c] != null && r[c] !== "" &&
        (keep[c] == null || keep[c] === "") );
      let conflict = null;
      for (const c of extra) {
        if (merge[c] != null && String(merge[c]) !== String(r[c])) { conflict = c; break; }
        merge[c] = r[c];
      }
      if (conflict) { bad = `${clients.get(r.client_id)}: 消す行どうしで ${conflict} が食い違う`; break; }
      drop.push(r);
    }
    if (bad) { skipped.push(bad); continue; }
    plan.push({ keep, drop, merge });
  }

  const dropTotal = plan.reduce((s, p) => s + p.drop.length, 0);
  const mergeTotal = plan.filter((p) => Object.keys(p.merge).length).length;
  const docMoves = plan.flatMap((p) => p.drop.flatMap((r) => (docsByCert.get(r.id) ?? []).map((d) => ({ doc: d, to: p.keep.id }))));
  console.log(`   1 行に寄せられる ${plan.length} 組 / 消す行 ${dropTotal} 件`);
  console.log(`   残す行へ値を移す ${mergeTotal} 組 (消す行だけが持っていた列)`);
  console.log(`   帳票の付け替え   ${docMoves.length} 件`);
  if (skipped.length) {
    console.log(`   触らない ${skipped.length} 組 (消す側だけが持つ値がある)`);
    for (const s of skipped.slice(0, 10)) console.log(`      ${s}`);
  }

  console.log("\n― 例 (先頭5組) ―");
  for (const p of plan.slice(0, 5)) {
    console.log(`   ${String(clients.get(p.keep.client_id)).padEnd(12)} ${p.keep.care_level} ${p.keep.certification_start_date}〜${p.keep.certification_end_date}` +
      `  ${p.drop.length + 1} 行 → 1 行  (残す: ${(p.keep.notes ?? "").slice(0, 24)})`);
  }

  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }

  const backup = plan.map((p) => ({
    keep: p.keep.id, client: clients.get(p.keep.client_id),
    care_level: p.keep.care_level, period: `${p.keep.certification_start_date}〜${p.keep.certification_end_date}`,
    merged: p.merge, dropped: p.drop.map((r) => ({ id: r.id, notes: r.notes })),
  }));

  // ④ 先に帳票を付け替える。失敗したらその組は消さない
  const failedGroups = new Set();
  for (const m of docMoves) {
    const { error } = await sb.from("kaigo_report_documents").update({ certification_id: m.to }).eq("id", m.doc);
    if (error) { console.error(`✗ 帳票 ${m.doc.slice(0, 8)} の付け替えに失敗: ${error.message}`); failedGroups.add(m.to); }
  }

  let ok = 0, ng = 0, merged = 0;
  for (const p of plan) {
    if (failedGroups.has(p.keep.id)) { console.log(`  = ${clients.get(p.keep.client_id)}: 帳票の付け替えに失敗したので消さない`); continue; }
    // 消す前に、消す行だけが持っていた値を残す行へ移す
    if (Object.keys(p.merge).length) {
      const { error } = await sb.from("client_insurance_records").update(p.merge).eq("id", p.keep.id);
      if (error) { console.error(`✗ ${clients.get(p.keep.client_id)} の値の移動に失敗: ${error.message}`); continue; }
      merged++;
    }
    for (const r of p.drop) {
      const { error } = await sb.from("client_insurance_records").delete().eq("id", r.id);
      if (error) { console.error(`✗ ${clients.get(r.client_id)}: ${error.message}`); ng++; continue; }
      ok++;
    }
  }
  writeFileSync(BACKUP, JSON.stringify(backup, null, 2), "utf8");
  console.log(`\n消した ${ok} 件 / 失敗 ${ng} 件 / 値を移した ${merged} 組 / 帳票の付け替え ${docMoves.length} 件`);
  console.log(`内容を ${path.basename(BACKUP)} に残しました`);
}

main().catch((e) => { console.error(e); process.exit(1); });
