// ============================================================================
// 取り込んだ第1表を **認定 (certification_id)** に紐付け、空の重複を消す
//
// ── 何が起きていたか ────────────────────────────────────────────────────
//   第1表 (care-plan-1) は cert-linked な帳票で、画面は
//     .eq("certification_id", 選択中の認定)
//   で探す。ほのぼのから取り込んだ 2,953 件は certification_id が null だったので
//   **画面から見えず**、開くたびに「帳票が無い」と判断されて空の第1表が
//   自動生成されていた (赤澤弘美で 3 件)。
//
//   → 取り込んだ第1表を対象月に有効な認定に紐付ける。
//   → そのうえで、中身が空で重複している自動生成ぶんを消す。
//
// ⚠ 消すのは **方針も意向も空で、かつ同じ利用者に中身のある第1表がある**もの
//   だけ。手で書いたものを消さないため。
//
//   node migrations/fix_care_plan_1_certification_link.mjs             # DRY RUN
//   node migrations/fix_care_plan_1_certification_link.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

async function fetchAll(table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const hasText = (d) =>
  !!String(d.content?.overall_policy ?? "").trim() || !!String(d.content?.issue_analysis ?? "").trim();

async function main() {
  console.log(`=== 第1表を認定に紐付け + 空の重複を掃除 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const docs = await fetchAll("kaigo_report_documents",
    "id, user_id, certification_id, content, created_at, report_month",
    (q) => q.eq("report_type", "care-plan-1").order("created_at"));
  console.log(`  第1表 ${docs.length} 件`);

  const userIds = [...new Set(docs.map((d) => d.user_id))];
  const certsByUser = new Map();
  for (let i = 0; i < userIds.length; i += 200) {
    const { data, error } = await sb.from("client_insurance_records")
      .select("id, client_id, certification_start_date, certification_end_date")
      .in("client_id", userIds.slice(i, i + 200));
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    for (const c of data ?? []) {
      if (!certsByUser.has(c.client_id)) certsByUser.set(c.client_id, []);
      certsByUser.get(c.client_id).push(c);
    }
  }

  /** 帳票の作成月 (無ければ更新日) に有効な認定。無ければ一番新しい認定 */
  function pickCert(doc) {
    const list = certsByUser.get(doc.user_id) ?? [];
    if (!list.length) return null;
    const day = (doc.report_month ? `${doc.report_month}-15` : String(doc.created_at ?? "").slice(0, 10)) || "";
    const valid = list.filter((c) =>
      (!c.certification_start_date || c.certification_start_date <= day) &&
      (!c.certification_end_date || c.certification_end_date >= day));
    const pool = valid.length ? valid : list;
    return pool.slice().sort((a, b) =>
      String(b.certification_start_date ?? "").localeCompare(String(a.certification_start_date ?? "")))[0];
  }

  const links = [];
  for (const d of docs) {
    if (d.certification_id) continue;
    const c = pickCert(d);
    if (!c) continue;
    links.push({ doc: d, certId: c.id });
  }

  // 空の重複: 同じ利用者に中身のある第1表があるのに、中身が空の第1表が別にある
  const byUser = new Map();
  for (const d of docs) {
    if (!byUser.has(d.user_id)) byUser.set(d.user_id, []);
    byUser.get(d.user_id).push(d);
  }
  const drops = [];
  for (const [, list] of byUser) {
    if (list.length < 2) continue;
    if (!list.some(hasText)) continue;          // 全部空なら消さない (元から空の人)
    for (const d of list) if (!hasText(d)) drops.push(d);
  }

  console.log(`  認定に紐付ける ${links.length} 件`);
  console.log(`  空の重複を消す ${drops.length} 件 (${new Set(drops.map((d) => d.user_id)).size} 名)`);
  console.log(`  紐付ける認定が引けない ${docs.filter((d) => !d.certification_id && !pickCert(d)).length} 件`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }

  // 先に消してから紐付ける (消す対象を紐付けても意味が無い)
  for (const d of drops) {
    const { error } = await sb.from("kaigo_report_documents").delete().eq("id", d.id);
    if (error) { console.error(`✗ 削除失敗 ${d.id}: ${error.message}`); process.exit(1); }
  }
  console.log(`  ✓ 空の重複 ${drops.length} 件を削除`);

  const dropped = new Set(drops.map((d) => d.id));
  let n = 0;
  const queue = links.filter((l) => !dropped.has(l.doc.id));
  const LANES = 10;
  const worker = async () => {
    for (;;) {
      const l = queue.shift();
      if (!l) return;
      const { error } = await sb.from("kaigo_report_documents")
        .update({ certification_id: l.certId }).eq("id", l.doc.id);
      if (error) { console.error(`✗ 紐付け失敗 ${l.doc.id}: ${error.message}`); process.exit(1); }
      if (++n % 500 === 0) console.log(`  ${n}/${queue.length + n}`);
    }
  };
  await Promise.all(Array.from({ length: LANES }, worker));
  console.log(`\n✓ ${n} 件を認定に紐付けました`);
}

main();
