/**
 * ほのぼのから移した 支援経過 / 生活アセスメント の整合を点検する (READ ONLY)
 *
 *   npx tsx scripts/assessment-support-check.mts
 *
 * PDF から起こしたデータなので、**取り込めていない欄**と
 * **画面から見えない行**が出やすい。伝送に乗らないぶん誰も気づかない。
 *
 * ── ★ 一番重い問題: cert-linked な帳票なのに certification_id が空 ────────
 *   `assessments/page.tsx:49` と `assessments-content.tsx:162` は
 *     if (selectedCertId) query = query.eq("certification_id", selectedCertId)
 *   で絞る。既定の `selectedCertId` は **最新の認定** (`page.tsx:41`)。
 *   → `certification_id` が null の行は **どの認定を選んでも一覧に出ない**。
 *   SESSION_START の「cert-linked な帳票は certification_id を必ず入れる。
 *   入っていないと画面から見えず、開くたびに空の帳票が自動生成される」がそのまま当たる。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ (anon だと RLS で 0 行になり誤判定する)");
  process.exit(0);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function all<T>(table: string, cols: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(order).range(f, f + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

type SR = {
  id: string; user_id: string; record_date: string | null; record_time: string | null;
  category: string | null; content: string | null; staff_name: string | null; care_plan_id: string | null;
};
type AS = {
  id: string; user_id: string; assessment_date: string | null; assessor_name: string | null;
  status: string | null; certification_id: string | null; assessment_type: string | null;
};
type Cert = {
  id: string; client_id: string;
  certification_start_date: string | null; certification_end_date: string | null; effective_date: string | null;
};

const sr = await all<SR>("kaigo_support_records", "id, user_id, record_date, record_time, category, content, staff_name, care_plan_id", "id");
const as = await all<AS>("kaigo_assessments", "id, user_id, assessment_date, assessor_name, status, certification_id, assessment_type, form_data", "id");
const clients = await all<{ id: string; name: string }>("clients", "id, name", "id");
const nm = new Map(clients.map((c) => [c.id, c.name]));

let ng = 0;
const flag = (label: string, n: number, note?: string) => {
  const bad = n > 0;
  if (bad) ng++;
  console.log(`  ${bad ? "★ " : "OK "}${label.padEnd(46)} ${n}`);
  if (bad && note) console.log(`     ${note}`);
};

// ══ 支援経過 ═════════════════════════════════════════════════════════════
console.log(`══ 支援経過 (kaigo_support_records) ══`);
console.log(`  【分母】${sr.length} 行 / 利用者 ${new Set(sr.map((r) => r.user_id)).size} 名`);
const CAT_OK = ["電話", "訪問", "来所", "メール", "FAX", "カンファレンス", "サービス担当者会議", "モニタリング", "その他"];
const catDist: Record<string, number> = {};
for (const r of sr) catDist[r.category ?? "(null)"] = (catDist[r.category ?? "(null)"] ?? 0) + 1;
console.log(`  category: ${JSON.stringify(catDist)}`);
flag("CHECK 制約に無い category", sr.filter((r) => r.category != null && !CAT_OK.includes(r.category)).length,
  `許可値: ${CAT_OK.join(" / ")}`);
flag("category が null", sr.filter((r) => r.category == null).length);
flag("record_date が null", sr.filter((r) => !r.record_date).length);
const today = new Date().toISOString().slice(0, 10);
flag("★ 記録日が未来", sr.filter((r) => r.record_date && r.record_date > today).length);
flag("content が空", sr.filter((r) => !(r.content ?? "").trim()).length);
flag("content が 10 文字未満 (抽出漏れの疑い)", sr.filter((r) => (r.content ?? "").trim().length < 10).length);
// ⚠ staff_name / record_time が全行空なのは **取込漏れではない**。
//   ほのぼのの「居宅介護支援経過」PDF を 12 ファイル / 47 ページ走査して確認した
//   (2026-09-03): 明細の列は **年月日 / 項目 / 内容 の 3 つだけ**で、
//   担当者欄も時刻欄も **そもそも存在しない**。
//   ヘッダーの「居宅サービス計画作成者氏名」は全ページ "ほのぼの 管理者" という
//   既定値で、記録者ではない。
//   ★ 最初「ほのぼのには担当者が印字されている」と書いたが **誤り**だった。
//     PDF を見ずに「あるはず」と決めつけていた。
console.log(`  (staff_name 空 ${sr.filter((r) => !(r.staff_name ?? "").trim()).length} / record_time 空 ${sr.filter((r) => !r.record_time).length}`
  + ` — ★ PDF に欄が無いので欠落ではない)`);
flag("存在しない利用者を指している", sr.filter((r) => !nm.has(r.user_id)).length);
// 完全重複 (同一利用者・同日・同内容)
const dupKey = (r: SR) => `${r.user_id}|${r.record_date}|${(r.content ?? "").trim()}`;
const seen = new Map<string, number>();
for (const r of sr) seen.set(dupKey(r), (seen.get(dupKey(r)) ?? 0) + 1);
flag("★ 完全重複 (利用者+日付+本文が同一)", [...seen.values()].filter((v) => v > 1).reduce((s, v) => s + v - 1, 0));

// ══ 生活アセスメント ══════════════════════════════════════════════════════
console.log(`\n══ 生活アセスメント (kaigo_assessments) ══`);
console.log(`  【分母】${as.length} 行 / 利用者 ${new Set(as.map((r) => r.user_id)).size} 名`);
flag("assessment_date が null", as.filter((r) => !r.assessment_date).length);
flag("★ 実施日が未来", as.filter((r) => r.assessment_date && r.assessment_date > today).length);
flag("assessor_name が空", as.filter((r) => !(r.assessor_name ?? "").trim()).length);
flag("status が completed / draft 以外", as.filter((r) => !["completed", "draft"].includes(r.status ?? "")).length);
flag("存在しない利用者を指している", as.filter((r) => !nm.has(r.user_id)).length);
flag("★★ certification_id が空 (= 画面に出ない)", as.filter((r) => !r.certification_id).length,
  "assessments/page.tsx は既定で最新の認定に絞る。null の行は **どの認定を選んでも出ない**");

// ── ★ 相談内容の 2 欄 (本人 / 介護者・家族) が正しく分かれているか ──────────
//   フェースシートは 相談内容の枠が **上下 2 段** (本人 / 介護者・家族) で、
//   PDF ではこの 2 枠の行が **交互に描かれる**。周期で分けているが、
//   実データで **片側に寄っている**ことを確認した (2026-09-03)。
//
//   ★ PDF と突き合わせた 3 名の結果:
//     太田 ミツ    完全一致 (本人 2 行 / 家族 3 行 / 生活歴 4 行)
//     阿部 代始子  ★ 本人の **最終行「ない。」が欠落** (「…申し訳」で切れる)
//     川本 いね    ★ **本人の記述が家族欄に入り、本人欄が空**
//
//   ⚠ 「家族が空・本人のみ」が **0 件**なのに逆が 37 件、という非対称が根拠。
//     2 枠を独立に読めていれば、本人だけの人も出るはず。
{
  type FD = { face_sheet?: { consultation_user?: string; consultation_family?: string } };
  const fs = (a: AS & { form_data?: FD }) => a.form_data?.face_sheet ?? {};
  const asF = as as (AS & { form_data?: FD })[];
  const u = (a: AS & { form_data?: FD }) => (fs(a).consultation_user ?? "").trim();
  const f = (a: AS & { form_data?: FD }) => (fs(a).consultation_family ?? "").trim();
  console.log(`
  ── 相談内容 (本人 / 介護者・家族) ──`);
  console.log(`     両方あり ${asF.filter((a) => u(a) && f(a)).length}`
    + ` / ★ 本人が空・家族のみ ${asF.filter((a) => !u(a) && f(a)).length}`
    + ` / 家族が空・本人のみ ${asF.filter((a) => u(a) && !f(a)).length}`
    + ` / 両方空 ${asF.filter((a) => !u(a) && !f(a)).length}`);
  console.log(`     ⚠ 「家族が空・本人のみ」が 0 なのに逆だけ多いなら **2 枠が 1 つに寄っている**`);
  flag("★ 家族欄の途中に「家族：」が現れる (2 枠が混ざった証跡)",
    asF.filter((a) => /家族[：:]/.test(f(a).slice(2))).length);
  flag("★ 家族欄が「本人：」で始まる", asF.filter((a) => /^本人[：:]/.test(f(a))).length);
}

// ── ★ 動作確認用のダミー利用者が混ざっていないか ──────────────────────────
flag("★ 「見本」を含む利用者のアセスメント",
  as.filter((a) => (nm.get(a.user_id) ?? "").includes("見本")).length,
  "ほのぼのの PDF に動作確認用の利用者が混ざっている");
flag("★ 「見本」を含む利用者の支援経過",
  sr.filter((r) => (nm.get(r.user_id) ?? "").includes("見本")).length);

// ── certification_id を実施日から決められるか ──
const ids = [...new Set(as.map((r) => r.user_id))];
const certs: Cert[] = [];
for (let i = 0; i < ids.length; i += 150) {
  const { data, error } = await sb.from("client_insurance_records")
    .select("id, client_id, certification_start_date, certification_end_date, effective_date")
    .in("client_id", ids.slice(i, i + 150));
  if (error) throw new Error(`client_insurance_records: ${error.message}`);
  certs.push(...((data ?? []) as Cert[]));
}
const certBy = new Map<string, Cert[]>();
for (const c of certs) certBy.set(c.client_id, [...(certBy.get(c.client_id) ?? []), c]);
let one = 0, none = 0, many = 0, noCert = 0;
const noneEx: string[] = [];
for (const a of as) {
  if (a.certification_id) continue;
  const list = certBy.get(a.user_id) ?? [];
  if (!list.length) { noCert++; continue; }
  const hit = list.filter((c) => {
    const s = c.certification_start_date ?? c.effective_date;
    const e = c.certification_end_date;
    return (s == null || s <= (a.assessment_date ?? "")) && (e == null || e >= (a.assessment_date ?? ""));
  });
  if (hit.length === 1) one++;
  else if (hit.length === 0) { none++; if (noneEx.length < 5) noneEx.push(`${nm.get(a.user_id) ?? a.user_id} 実施日 ${a.assessment_date}`); }
  else many++;
}
console.log(`\n  ── 実施日から認定を決められるか ──`);
console.log(`     ★ 1 件に決まる (埋められる)     ${one} 行`);
console.log(`     ★ 認定が複数当たる (重複)       ${many} 行  ← 決め手が要る (認定の同着と同じ問題)`);
console.log(`     実施日に有効な認定が無い        ${none} 行`);
for (const e of noneEx) console.log(`        ${e}`);
console.log(`     認定が 1 件も無い              ${noCert} 行`);
console.log(`\n  是正: node migrations/fix_assessment_cert_link.mjs  (DRY RUN)
         ⚠ backfill_assessment_certification_id.mjs は **使用禁止** (最新の認定を埋めてしまう)`);

console.log(`\n══ ★ が付いた項目 ${ng} 件 ══`);
console.log(`⚠ この点検は **伝送にも金額にも出ない**ので、誰も見ていないと気づけない。`);
console.log(`⚠ 支援経過の staff_name / record_time は **PDF に欄が無い**ので欠落ではない`);
console.log(`  (12 ファイル / 47 ページを走査して確認済)。`);
console.log(`⚠ 相談内容の 2 枠は **PDF と 3 名突き合わせた**: 1 名 完全一致 / 1 名 末尾 1 行欠落 /`);
console.log(`  1 名 本人の記述が家族欄に入っていた。★ 読み取りの精度は 3 分の 1 では足りない。`);
