// 生活アセスメント (kaigo_assessments) の certification_id を **実施日** で紐付ける。
//
// ── なぜ要るか ────────────────────────────────────────────────────────────
//   PDF 取込で入った 113 件は certification_id が全件 NULL。
//   /assessments 画面は server (page.tsx) / client (assessments-content.tsx) の
//   両方で `.eq("certification_id", selectedCertId)` を掛け、既定の選択は
//   `initialCertifications[0]`(最新の認定) なので、**NULL の行は 1 件も表示されない**。
//   (帳票 第1表で 2026-08-31 に起きたのと同じ型。ただしアセスメント画面には
//    自動生成の経路が無いので「空レコードが増殖する」二次被害は起きない)
//
// ── 既存の backfill_assessment_certification_id.mjs との違い ──────────────
//   あちらは「その user の **最新** の認定」を埋める。アセスメントは実施日が
//   88 日に分散しているため、最新で埋めると **当時とは別の認定** に紐付く。
//   実測 (2026-09-03): 113 件中 **30 件 (27%)** で両方式の結果が食い違い、
//   要介護度まで違う例があった (実施日2026-04-28: 最新=要介護5 / 実施日対応=要介護4)。
//   → 本 script は fix_care_plan_cert_link.mjs と同じ「その日に有効な認定」規則を使う。
//
// ── 紐付け規則 (fix_care_plan_cert_link.mjs と同一) ───────────────────────
//   ① assessment_date に有効な認定 (start <= 実施日 <= end)。複数あれば開始が新しい方
//   ② ①が無ければ 認定のうち一番新しいもの (画面の既定と同じ挙動に寄せる)
//   ③ 認定を 1 件も持たない利用者は **NULL のまま**
//      (画面側は selectedCertId が無い状態なので filter が効かず、そのまま表示される)
//   ④ ⚠ 2026-09-05追加: 同一利用者に★異なる(保険者番号,被保険者番号)の認定が
//      2件以上ある利用者は**スキップ**する (別人の認定が紛れ込んでいる疑い。
//      実例: 金綱伸 — 121046|1004866628 と 122291|1004012089。転居か誤結合か
//      当方データだけでは判定できないため、機械的な開始日順の自動選択はしない)。
//
//   node migrations/fix_assessment_cert_link.mjs            # DRY RUN
//   node migrations/fix_assessment_cert_link.mjs --execute
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

/** PostgREST の range ページングは order 必須 (無いと行が抜ける) */
async function pageAll(table, cols, apply, orderCol = "id") {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).order(orderCol).range(from, from + 999);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== アセスメントの certification_id 紐付け ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const nulls = await pageAll("kaigo_assessments", "id, user_id, assessment_date, assessment_type",
    (q) => q.is("certification_id", null));
  console.log(`certification_id が NULL: ${nulls.length} 件`);
  if (nulls.length === 0) return;

  const userIds = [...new Set(nulls.map((r) => r.user_id))];
  const certs = [];
  for (let i = 0; i < userIds.length; i += 200) {
    const { data, error } = await sb
      .from("client_insurance_records")
      .select("id, client_id, insurer_number, insured_number, care_level, certification_start_date, certification_end_date")
      .in("client_id", userIds.slice(i, i + 200));
    if (error) { console.error(`✗ 認定の取得に失敗: ${error.message}`); process.exit(1); }
    certs.push(...data);
  }
  const certsByUser = new Map();
  for (const c of certs) {
    if (!certsByUser.has(c.client_id)) certsByUser.set(c.client_id, []);
    certsByUser.get(c.client_id).push(c);
  }
  const clients = [];
  for (let i = 0; i < userIds.length; i += 200) {
    const { data } = await sb.from("clients").select("id, name").in("id", userIds.slice(i, i + 200));
    clients.push(...(data ?? []));
  }
  const nameById = new Map(clients.map((c) => [c.id, c.name]));

  // ⚠ 2026-09-05 H指摘で追加: 同一 client に★異なる (保険者番号, 被保険者番号) の
  //   認定が2つ以上あるとき、その利用者は別人の認定が紛れ込んでいる疑いがある
  //   (実例: 金綱伸 — 121046|1004866628 と 122291|1004012089 の2件。転居か誤結合か
  //   当方データだけでは判定できない。fix_insurance_record_wrong_owner.mjsは検出方向が
  //   逆 (1被保番→複数client) のためこのケースを拾えない)。
  //   ★名前では判定しない — (保険者,被保番) の異なり数で機械的に検出する。
  const multiIdentityUsers = new Set();
  for (const [uid, list] of certsByUser) {
    const pairs = new Set(list.map((c) => `${c.insurer_number ?? ""}|${c.insured_number ?? ""}`));
    if (pairs.size > 1) multiIdentityUsers.add(uid);
  }

  /** 実施日に有効な認定。無ければ一番新しい認定 (fix_care_plan_cert_link.mjs と同一規則) */
  function pickCert(a) {
    const list = certsByUser.get(a.user_id) ?? [];
    if (!list.length) return null;
    const day = String(a.assessment_date ?? "").slice(0, 10);
    const valid = day
      ? list.filter(
          (c) =>
            (!c.certification_start_date || c.certification_start_date <= day) &&
            (!c.certification_end_date || c.certification_end_date >= day),
        )
      : [];
    const pool = valid.length ? valid : list;
    return pool
      .slice()
      .sort((x, y) =>
        String(y.certification_start_date ?? "").localeCompare(String(x.certification_start_date ?? "")),
      )[0];
  }

  const links = [];
  const noCert = [];
  const multiIdentity = [];
  let fallback = 0;
  for (const a of nulls) {
    if (multiIdentityUsers.has(a.user_id)) { multiIdentity.push(a); continue; }
    const c = pickCert(a);
    if (!c) { noCert.push(a); continue; }
    const day = String(a.assessment_date ?? "").slice(0, 10);
    const covered =
      (!c.certification_start_date || c.certification_start_date <= day) &&
      (!c.certification_end_date || c.certification_end_date >= day);
    if (!covered) fallback++;
    links.push({ a, c, covered });
  }

  console.log(`\n紐付ける: ${links.length} 件 (${new Set(links.map((x) => x.a.user_id)).size} 名)`);
  console.log(`  うち ①実施日に有効な認定: ${links.length - fallback} 件`);
  console.log(`  うち ②該当が無く「一番新しい認定」で代替: ${fallback} 件  ← 実施日が初回認定より前 等`);
  for (const { a, c, covered } of links.slice(0, 15)) {
    console.log(
      `    ${(nameById.get(a.user_id) ?? a.user_id).padEnd(12)} 実施日 ${a.assessment_date} → ${c.care_level} (${c.certification_start_date}〜${c.certification_end_date ?? ""})${covered ? "" : "  ※代替"}`,
    );
  }
  if (links.length > 15) console.log(`    … 他 ${links.length - 15} 件`);

  console.log(`\n対象外 (認定を 1 件も持たない = NULL のままで画面には出る): ${noCert.length} 件`);
  for (const a of noCert) console.log(`    ${nameById.get(a.user_id) ?? a.user_id} (実施日 ${a.assessment_date})`);

  console.log(`\n要確認・スキップ (同一利用者に異なる(保険者,被保番)の認定が複数=別人混入の疑い): ${multiIdentity.length} 件`);
  for (const a of multiIdentity) {
    const pairs = [...new Set((certsByUser.get(a.user_id) ?? []).map((c) => `${c.insurer_number ?? ""}|${c.insured_number ?? ""}`))];
    console.log(`    ${nameById.get(a.user_id) ?? a.user_id} (実施日 ${a.assessment_date}) — 保有する(保険者,被保番): ${pairs.join(" / ")}`);
  }

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で更新します。");
    return;
  }

  let ok = 0;
  for (const { a, c } of links) {
    const { error } = await sb
      .from("kaigo_assessments")
      .update({ certification_id: c.id })
      .eq("id", a.id)
      .is("certification_id", null); // 競合で既に埋まっていたら触らない
    if (error) { console.error(`✗ ${nameById.get(a.user_id) ?? a.user_id}: ${error.message}`); continue; }
    ok++;
  }
  console.log(`\n✓ ${ok}/${links.length} 件を更新しました`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
