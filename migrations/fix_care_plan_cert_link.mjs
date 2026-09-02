// ============================================================================
// cert-linked なケアプラン帳票 (第1〜3表・予防・主治医意見書) を認定に紐付ける
//
// ── 何が起きるか ────────────────────────────────────────────────────────
//   care-plan-1/2/3 等は cert-linked な帳票で、reports 画面は
//     certification_id === 選択中の認定
//   で絞り込む。**certification_id が NULL の帳票は画面に出ない**ので、
//   開くたびに「帳票が無い」と判断されて空の帳票が自動生成される。
//   (2026-07-14 に第1表で発生。既存の fix_care_plan_1_certification_link.mjs は
//    **第1表のみ**が対象だったため、第2/3表の取りこぼしが残っていた)
//
// ⚠ **認定を 1 件も持たない利用者は対象外**。その場合 画面側も
//   certification_id で絞らない (initialCertId が null なら全件表示) ので、
//   NULL のままで正しく表示される。件数だけ見て「NULL = 不具合」としないこと。
//   (2026-09-03 実測: NULL 11 件のうち 10 件はこのケースで実害なし)
//
// ⚠ この script は **紐付けのみ**。空帳票の削除はしない。
//   「中身が空か」の判定は帳票種別ごとに違い、手書きを消す事故になりうるため
//   (第1表ぶんの削除は既存の fix_care_plan_1_certification_link.mjs にある)。
//
//   node migrations/fix_care_plan_cert_link.mjs             # DRY RUN
//   node migrations/fix_care_plan_cert_link.mjs --execute   # 本番
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
/** reports/[type]/page.tsx の isCertLinked と同じ集合にすること */
const CERT_LINKED = ["care-plan-1", "care-plan-2", "care-plan-3", "yobo-care-plan", "shujii-iken"];

const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function fetchAll(table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order("id").range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) {
      console.error(`✗ ${table}: ${error.message}`);
      process.exit(1);
    }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== cert-linked 帳票を認定に紐付け ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const docs = await fetchAll(
    "kaigo_report_documents",
    "id, user_id, report_type, certification_id, created_at, report_month",
    (q) => q.in("report_type", CERT_LINKED),
  );
  console.log(`  cert-linked 帳票: ${docs.length} 件 (分母)`);
  const nulls = docs.filter((d) => !d.certification_id);
  console.log(`  うち certification_id が NULL: ${nulls.length} 件`);
  if (nulls.length === 0) {
    console.log("\n  紐付けが必要な帳票はありません。");
    return;
  }

  // 対象利用者の認定をまとめて引く
  const userIds = [...new Set(nulls.map((d) => d.user_id))];
  const certsByUser = new Map();
  for (let i = 0; i < userIds.length; i += 200) {
    const { data, error } = await sb
      .from("client_insurance_records")
      .select("id, client_id, certification_start_date, certification_end_date")
      .in("client_id", userIds.slice(i, i + 200));
    if (error) {
      console.error(`✗ client_insurance_records: ${error.message}`);
      process.exit(1);
    }
    for (const c of data ?? []) {
      if (!certsByUser.has(c.client_id)) certsByUser.set(c.client_id, []);
      certsByUser.get(c.client_id).push(c);
    }
  }
  // 氏名 (ログ用)
  const nameById = new Map();
  for (let i = 0; i < userIds.length; i += 200) {
    const { data } = await sb.from("clients").select("id, name").in("id", userIds.slice(i, i + 200));
    for (const c of data ?? []) nameById.set(c.id, c.name);
  }

  /** 帳票の月 (無ければ作成日) に有効な認定。無ければ一番新しい認定 (画面の既定と同じ) */
  function pickCert(doc) {
    const list = certsByUser.get(doc.user_id) ?? [];
    if (!list.length) return null;
    const day =
      (doc.report_month ? `${doc.report_month}-15` : String(doc.created_at ?? "").slice(0, 10)) || "";
    const valid = list.filter(
      (c) =>
        (!c.certification_start_date || c.certification_start_date <= day) &&
        (!c.certification_end_date || c.certification_end_date >= day),
    );
    const pool = valid.length ? valid : list;
    return pool
      .slice()
      .sort((a, b) =>
        String(b.certification_start_date ?? "").localeCompare(String(a.certification_start_date ?? "")),
      )[0];
  }

  const links = [];
  const noCert = [];
  for (const d of nulls) (pickCert(d) ? links : noCert).push(d);

  console.log(`\n  紐付ける: ${links.length} 件 (${new Set(links.map((d) => d.user_id)).size} 名)`);
  for (const d of links) {
    console.log(
      `    ${nameById.get(d.user_id) ?? d.user_id} / ${d.report_type} / ${String(d.created_at).slice(0, 10)} → cert ${pickCert(d).id.slice(0, 8)}`,
    );
  }
  console.log(
    `\n  対象外 (認定を 1 件も持たない利用者 = 画面には出るので実害なし): ${noCert.length} 件 (${new Set(noCert.map((d) => d.user_id)).size} 名)`,
  );
  for (const u of new Set(noCert.map((d) => d.user_id))) {
    console.log(`    ${nameById.get(u) ?? u}: ${noCert.filter((d) => d.user_id === u).length} 件`);
  }

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で保存します。");
    return;
  }

  let ok = 0;
  for (const d of links) {
    const { error } = await sb
      .from("kaigo_report_documents")
      .update({ certification_id: pickCert(d).id })
      .eq("id", d.id);
    if (error) console.error(`  ✗ ${d.id}: ${error.message}`);
    else ok++;
  }
  console.log(`\n✓ 紐付け完了: ${ok} / ${links.length} 件`);
}

main();
