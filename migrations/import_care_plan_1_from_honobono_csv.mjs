// ============================================================================
// 居宅サービス計画書 **第1表の本文** を ほのぼの CSV から取り込む
//
// ── いま何が入っていて何が無いか ───────────────────────────────────────
//   入っている: kaigo_care_plans           2,803 件 / 2,800 名 (長期・短期目標)
//               kaigo_care_plan_services  14,774 行 (第2表のサービス)
//   無い:       **第1表の本文** = 総合的な援助の方針 / 利用者及び家族の意向
//               (画面は空欄スタートで、AI 生成か手入力の前提になっていた)
//
//   ほのぼのの `ケアプラン/全/CAREPLAN1.CSV` に両方入っている。
//     col 2 保険者番号 / col 3 被保険者番号 / col 7 作成日
//     col 8 総合的な援助の方針 / col 9 利用者及び家族の意向
//     col 10,11 認定の有効期間 / col 12 作成者
//
// ── どこに入れるか ──────────────────────────────────────────────────────
//   第1表は kaigo_care_plans ではなく **kaigo_report_documents** (report_type =
//   "care-plan-1") の content JSON に入る。画面 (reports/[type]) が読む場所。
//     content.overall_policy  = 総合的な援助の方針
//     content.issue_analysis  = 利用者及び家族の意向
//
// ⚠ 人の同定は **(保険者番号, 被保険者番号)**。被保番は保険者の中でしか一意でない。
// ⚠ 同じ人に複数世代の計画がある。**作成日が新しいもの**を採る。
// ⚠ 既にある care-plan-1 は **上書きしない** (手で書いたものを潰さないため)。
//   上書きしたいときは --overwrite。
//
//   node migrations/import_care_plan_1_from_honobono_csv.mjs             # DRY RUN
//   node migrations/import_care_plan_1_from_honobono_csv.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const OVERWRITE = process.argv.includes("--overwrite");
const TENANT = "kt-group";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

/** ダブルクォート内のカンマ・改行に耐える CSV パーサ (本文に「、」も改行も入る) */
function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\r") { /* skip */ }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const toIso = (v) => {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec((v ?? "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};

async function fetchAll(table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order("id").range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== 第1表 (総合的な援助の方針 / 意向) 取込 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const csv = path.join(ROOT, "ケアプラン/全/CAREPLAN1.CSV");
  if (!existsSync(csv)) { console.error(`✗ ${csv} が無い`); process.exit(1); }
  const rows = parseCsv(iconv.decode(readFileSync(csv), "Shift_JIS"));
  const hdr = rows[0].map((s) => s.trim());
  const col = (name) => { const i = hdr.indexOf(name); if (i < 0) { console.error(`✗ 列「${name}」が無い`); process.exit(1); } return i; };
  const cHo = col("保険者番号"), cIns = col("被保険者番号"), cMade = col("作成日"),
        cPol = col("総合的な援助の方針"), cInt = col("利用者及び家族の意向");
  console.log(`  CAREPLAN1.CSV ${rows.length - 1} 行`);

  // (保険者, 被保番) → **作成日が一番新しい** 1 件
  const latest = new Map();
  for (const c of rows.slice(1)) {
    const ho = (c[cHo] ?? "").trim(), ins = (c[cIns] ?? "").trim();
    if (!ho || !ins) continue;
    const policy = (c[cPol] ?? "").trim(), intent = (c[cInt] ?? "").trim();
    if (!policy && !intent) continue;
    const made = toIso(c[cMade]) ?? "";
    const k = `${ho}|${ins}`;
    const prev = latest.get(k);
    if (!prev || made > prev.made) latest.set(k, { ho, ins, made, policy, intent });
  }
  console.log(`  本文がある利用者 ${latest.size} 名 (作成日が新しいもの 1 件ずつ)`);

  // (保険者, 被保番) → client_id
  const certs = await fetchAll("client_insurance_records", "client_id, insurer_number, insured_number");
  const clientByKey = new Map();
  const ambiguous = new Set();
  for (const r of certs) {
    if (!r.insurer_number || !r.insured_number) continue;
    const k = `${r.insurer_number}|${r.insured_number}`;
    const cur = clientByKey.get(k);
    if (cur && cur !== r.client_id) ambiguous.add(k);
    clientByKey.set(k, r.client_id);
  }

  // ⚠ 第1表は **cert-linked**。certification_id を入れないと画面が見つけられず、
  //   開くたびに空の第1表が自動生成される (実際に 11 件できていた)。
  const certs2 = await fetchAll("client_insurance_records",
    "id, client_id, certification_start_date, certification_end_date");
  const certsByUser = new Map();
  for (const c of certs2) {
    if (!certsByUser.has(c.client_id)) certsByUser.set(c.client_id, []);
    certsByUser.get(c.client_id).push(c);
  }
  const pickCert = (uid, day) => {
    const list = certsByUser.get(uid) ?? [];
    if (!list.length) return null;
    const valid = list.filter((c) =>
      (!c.certification_start_date || c.certification_start_date <= day) &&
      (!c.certification_end_date || c.certification_end_date >= day));
    const pool = valid.length ? valid : list;
    return pool.slice().sort((a, b) =>
      String(b.certification_start_date ?? "").localeCompare(String(a.certification_start_date ?? "")))[0]?.id ?? null;
  };

  const plans = await fetchAll("kaigo_care_plans", "id, user_id, start_date");
  const planByUser = new Map();
  for (const p of plans) {
    const cur = planByUser.get(p.user_id);
    if (!cur || String(p.start_date ?? "") > String(cur.start_date ?? "")) planByUser.set(p.user_id, p);
  }

  const docs = await fetchAll("kaigo_report_documents", "id, user_id, content, report_type",
    (q) => q.eq("report_type", "care-plan-1"));
  const docByUser = new Map(docs.map((d) => [d.user_id, d]));

  const clients = await fetchAll("clients", "id, name", (q) => q.eq("tenant_id", TENANT));
  const nameById = new Map(clients.map((c) => [c.id, c.name]));

  const adds = [], upds = [], skips = [], misses = [];
  for (const v of latest.values()) {
    const k = `${v.ho}|${v.ins}`;
    if (ambiguous.has(k)) { misses.push(`${k}: 当方の利用者が複数 (重複解消が必要)`); continue; }
    const uid = clientByKey.get(k);
    if (!uid) { misses.push(`${k}: 当方に居ない`); continue; }
    const name = nameById.get(uid) ?? "(不明)";
    const doc = docByUser.get(uid);
    if (doc && !OVERWRITE) {
      const c = doc.content ?? {};
      // 既にある帳票でも **本文が空なら埋める** (画面は空欄スタートなので大半が空)
      if ((c.overall_policy ?? "") || (c.issue_analysis ?? "")) { skips.push(name); continue; }
      upds.push({ doc, v, name, uid });
      continue;
    }
    if (doc) { upds.push({ doc, v, name, uid }); continue; }
    adds.push({ v, name, uid, plan: planByUser.get(uid) ?? null });
  }

  console.log(`\n  新規 ${adds.length} 名 / 追記 ${upds.length} 名 / 既に本文あり ${skips.length} 名 / 引けない ${misses.length} 名`);
  for (const a of adds.slice(0, 3)) {
    console.log(`\n  例) ${a.name}`);
    console.log(`     方針: ${a.v.policy.slice(0, 80)}…`);
    console.log(`     意向: ${a.v.intent.slice(0, 80)}…`);
  }
  if (misses.length) {
    console.log(`\n  -- 引けないもの ${misses.length} 件 (先頭 10) --`);
    for (const m of misses.slice(0, 10)) console.log(`     ${m}`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }

  let n = 0;
  for (const u of upds) {
    const content = { ...(u.doc.content ?? {}) };
    content.overall_policy = u.v.policy;
    content.issue_analysis = u.v.intent;
    const { error } = await sb.from("kaigo_report_documents")
      .update({ content, updated_at: new Date().toISOString() }).eq("id", u.doc.id);
    if (error) { console.error(`✗ ${u.name}: ${error.message}`); process.exit(1); }
    n++;
  }
  const CHUNK = 200;
  for (let i = 0; i < adds.length; i += CHUNK) {
    const payload = adds.slice(i, i + CHUNK).map((a) => ({
      tenant_id: TENANT, user_id: a.uid, report_type: "care-plan-1",
      title: `居宅サービス計画書(1)${a.v.made ? `（${a.v.made}）` : ""}`,
      report_month: a.v.made ? a.v.made.slice(0, 7) : null,
      care_plan_id: a.plan?.id ?? null,
      certification_id: pickCert(a.uid, a.v.made || "9999-12-31"),
      status: "draft",
      content: {
        user_name: a.name,
        creation_date: a.v.made || "",
        overall_policy: a.v.policy,
        issue_analysis: a.v.intent,
        review_opinion: "",
        living_support_reason: "",
        // ほのぼのから移した本文であることを残す (後で棚卸しできるように)
        _source: "honobono CAREPLAN1.CSV",
      },
    }));
    const { error } = await sb.from("kaigo_report_documents").insert(payload);
    if (error) { console.error(`✗ 一括 INSERT 失敗: ${error.message}`); process.exit(1); }
    n += payload.length;
    console.log(`  ${Math.min(i + CHUNK, adds.length)}/${adds.length}`);
  }
  console.log(`\n✓ ${n} 名ぶんの第1表を保存しました`);
}

main();
