// ============================================================================
// ケアプラン系テキストの **前後の空白・タブ** を落とす (既存データの掃除)
//
//   node migrations/trim_careplan_text_whitespace.mjs             # DRY RUN (既定・書込なし)
//   node migrations/trim_careplan_text_whitespace.mjs --execute   # 本番 UPDATE
//   node migrations/trim_careplan_text_whitespace.mjs --detail    # 変わる値を全部出す
//
// 【なぜ要るか】2026-09-03 の帳票検証で判明
//   ほのぼの KAIGO1_H31.CSV は課題・目標のフィールド末尾にタブを入れてくることがある。
//   取込が囲みクォートを外すだけで trim していなかったため、そのまま流れて
//   **訪問介護計画書の印刷に届いていた** (帳票は whitespace-pre-wrap なのでタブを描く)。
//
//     KAIGO1_H31.CSV
//      → backfill_care_plan_service_goals.mjs   ★起点 (2026-09-03 に .trim() を追加済)
//      → kaigo_care_plan_services               27 行
//      → generate_care_plan_2_documents.mjs     (同日 trim を追加済)
//      → kaigo_report_documents (care-plan-2)   20 件
//      → generate_houmon_care_plans.mjs
//      → kaigo_houmon_care_plans.goals          4 件 / 5 値
//
//   上流 2 本は直したので**今後は入らない**。この script は**既に入ってしまった分**を掃除する。
//
// ══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ 文中のタブ・空白は**絶対に触らない** ⚠⚠
//
//   落とすのは String.prototype.trim() が落とす範囲 = **前後だけ**。
//   文中のタブは ほのぼの側が意図して入れた区切りで、消すと文章が繋がってしまう。
//
//     care-plan-1 の overall_policy 20 件が実際にこれ:
//       "…認知症を予測し、身体機能を維持していき[TAB]…"
//     取込 (import_care_plan_1_from_honobono_csv.mjs) は元々 trim していたので
//     **前後は既にきれい**。残っているのは文中だけ = この script の対象外。
//
//   だから replace(/\t/g, "") のような置換を**足してはいけない**。trim のみ。
// ══════════════════════════════════════════════════════════════════════════════
//
// 【対象】印刷される文字列だけ。ID・日付・UUID・数値は触らない。
//   kaigo_care_plan_services    needs / long_term_goal / short_term_goal /
//                               service_content / provider / frequency / notes
//   kaigo_report_documents      content (jsonb) の中の文字列を再帰的に
//   kaigo_houmon_care_plans     goals[] / weekly_services[] の中の文字列 +
//                               basic_policy 等の本文列
//
// 【安全性】
//   - 既定は DRY RUN。--execute を付けたときだけ書く
//   - **値が実際に変わる行だけ** UPDATE する (空振り UPDATE を出さない)
//   - trim 後に空文字になる値は **null にせず "" のまま**にする。
//     null にすると「未入力」と「空白だけ入力」の区別が消え、
//     `needs || null` のような下流の判定が変わるため
//   - 1 行ずつ UPDATE し、error は必ず check して失敗件数を最後に出す
// ============================================================================
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const EXECUTE = process.argv.includes("--execute");
const DETAIL = process.argv.includes("--detail");
const TENANT = "kt-group";

const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("✗ .env.local に NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY がありません");
  process.exit(1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PAGE = 1000;
/** PostgREST の 1000 行上限を order 付きで越える (order 無しはページ間で行が抜ける) */
async function fetchAll(table, select) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(select).order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} の取得に失敗: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

/** 前後の空白のみ落とす。文中は絶対に触らない (trim の定義そのまま) */
const trimmed = (v) => (typeof v === "string" ? v.trim() : v);

/** jsonb を再帰的に trim。変化があったかも返す */
function deepTrim(v) {
  if (typeof v === "string") {
    const t = v.trim();
    return { value: t, changed: t !== v };
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const r = deepTrim(x);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: out, changed };
  }
  if (v && typeof v === "object") {
    let changed = false;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const r = deepTrim(x);
      if (r.changed) changed = true;
      out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value: v, changed: false };
}

/** 変化の中身を人が読める形にする */
const show = (before, after) =>
  `${JSON.stringify(before).slice(0, 60)}  →  ${JSON.stringify(after).slice(0, 60)}`;

/** 何が落ちたかの分類 (タブ / 空白 / 全角空白) */
function kindOf(before, after) {
  const removed = before.slice(0, before.length - before.trimStart().length) +
    before.slice(before.trimEnd().length);
  const k = [];
  if (removed.includes(String.fromCharCode(9))) k.push("タブ");
  if (/ /.test(removed)) k.push("半角空白");
  if (/　/.test(removed)) k.push("全角空白");
  if (/[\r\n]/.test(removed)) k.push("改行");
  void after;
  return k.length ? k.join("+") : "その他";
}

async function main() {
  console.log(`=== ケアプラン系テキストの前後空白を落とす ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===`);
  console.log(`    ⚠ 落とすのは前後だけ。文中のタブ・空白は触らない\n`);

  const plan = [];   // { table, id, patch, changes: [[列, before, after]] }
  const kinds = {};
  const bump = (b, a) => { const k = kindOf(b, a); kinds[k] = (kinds[k] ?? 0) + 1; };

  // ── ① kaigo_care_plan_services (平坦な text 列) ────────────────────────
  const SVC_COLS = ["needs", "long_term_goal", "short_term_goal", "service_content", "provider", "frequency", "notes"];
  const svcs = await fetchAll("kaigo_care_plan_services", `id, ${SVC_COLS.join(", ")}`);
  console.log(`── ① kaigo_care_plan_services`);
  console.log(`   【分母】${svcs.length} 行`);
  for (const r of svcs) {
    const patch = {}, changes = [];
    for (const c of SVC_COLS) {
      const t = trimmed(r[c]);
      if (typeof r[c] === "string" && t !== r[c]) { patch[c] = t; changes.push([c, r[c], t]); bump(r[c], t); }
    }
    if (changes.length) plan.push({ table: "kaigo_care_plan_services", id: r.id, patch, changes });
  }
  console.log(`   → 変わる行 ${plan.filter((p) => p.table === "kaigo_care_plan_services").length} 行\n`);

  // ── ② kaigo_report_documents (content jsonb を再帰) ───────────────────
  const docs = await fetchAll("kaigo_report_documents", "id, report_type, content");
  const before2 = plan.length;
  console.log(`── ② kaigo_report_documents (content jsonb)`);
  console.log(`   【分母】${docs.length} 件`);
  const byType = {};
  for (const d of docs) {
    const r = deepTrim(d.content);
    if (!r.changed) continue;
    byType[d.report_type] = (byType[d.report_type] ?? 0) + 1;
    // 何が変わったか (先頭 3 件だけ拾う)
    const changes = [];
    const walk = (b, a, path) => {
      if (typeof b === "string") { if (b !== a && changes.length < 3) { changes.push([path, b, a]); bump(b, a); } return; }
      if (Array.isArray(b)) { b.forEach((x, i) => walk(x, a[i], `${path}[${i}]`)); return; }
      if (b && typeof b === "object") for (const [k, x] of Object.entries(b)) walk(x, a[k], `${path}.${k}`);
    };
    walk(d.content, r.value, "content");
    plan.push({ table: "kaigo_report_documents", id: d.id, patch: { content: r.value }, changes });
  }
  console.log(`   → 変わる件数 ${plan.length - before2} 件  ${JSON.stringify(byType)}\n`);

  // ── ③ kaigo_houmon_care_plans (jsonb + 本文列) ────────────────────────
  const HCP_COLS = ["basic_policy", "user_intention", "family_intention", "user_situation",
    "family_situation", "precautions", "emergency_response", "special_notes",
    "author_name", "creator_name", "user_consent_name", "consent_proxy_name", "consent_proxy_relation"];
  const hcps = await fetchAll("kaigo_houmon_care_plans", `id, goals, weekly_services, ${HCP_COLS.join(", ")}`);
  const before3 = plan.length;
  console.log(`── ③ kaigo_houmon_care_plans`);
  console.log(`   【分母】${hcps.length} 件`);
  for (const p of hcps) {
    const patch = {}, changes = [];
    for (const c of HCP_COLS) {
      const t = trimmed(p[c]);
      if (typeof p[c] === "string" && t !== p[c]) { patch[c] = t; changes.push([c, p[c], t]); bump(p[c], t); }
    }
    for (const c of ["goals", "weekly_services"]) {
      const r = deepTrim(p[c]);
      if (r.changed) {
        patch[c] = r.value;
        const walk = (b, a, path) => {
          if (typeof b === "string") { if (b !== a && changes.length < 5) { changes.push([path, b, a]); bump(b, a); } return; }
          if (Array.isArray(b)) { b.forEach((x, i) => walk(x, a[i], `${path}[${i}]`)); return; }
          if (b && typeof b === "object") for (const [k, x] of Object.entries(b)) walk(x, a[k], `${path}.${k}`);
        };
        walk(p[c], r.value, c);
      }
    }
    if (Object.keys(patch).length) plan.push({ table: "kaigo_houmon_care_plans", id: p.id, patch, changes });
  }
  console.log(`   → 変わる件数 ${plan.length - before3} 件\n`);

  // ── まとめ ─────────────────────────────────────────────────────────────
  console.log("── 落ちる文字の内訳 (値の数) ──");
  for (const [k, v] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(20)} ${v}`);
  console.log(`\n★ 更新対象  合計 ${plan.length} 行`);
  for (const t of ["kaigo_care_plan_services", "kaigo_report_documents", "kaigo_houmon_care_plans"]) {
    console.log(`   ${t.padEnd(28)} ${plan.filter((p) => p.table === t).length} 行`);
  }

  if (DETAIL) {
    console.log("\n── 変わる値 (--detail) ──");
    for (const p of plan) {
      console.log(`  [${p.table}] ${p.id}`);
      for (const [c, b, a] of p.changes) console.log(`      ${c}: ${show(b, a)}`);
    }
  } else if (plan.length) {
    console.log("\n── 変わる値 (先頭 10 行。全部見るなら --detail) ──");
    for (const p of plan.slice(0, 10)) {
      console.log(`  [${p.table}] ${p.id}`);
      for (const [c, b, a] of p.changes.slice(0, 2)) console.log(`      ${c}: ${show(b, a)}`);
    }
  }

  if (!EXECUTE) {
    console.log(`\n【DRY RUN】書き込んでいません。実行するなら --execute`);
    console.log(`  ⚠ 実行前に backup を取ること:`);
    console.log(`     CREATE TABLE _backup_care_plan_services_20260903 AS SELECT * FROM kaigo_care_plan_services;`);
    console.log(`     CREATE TABLE _backup_report_documents_20260903  AS SELECT * FROM kaigo_report_documents;`);
    console.log(`     CREATE TABLE _backup_houmon_care_plans_20260903 AS SELECT * FROM kaigo_houmon_care_plans;`);
    console.log(`  ⚠ backup 表は RLS を継承しないので、確認後に DROP すること`);
    return;
  }

  console.log(`\n=== 本番 UPDATE 開始 (${plan.length} 行) ===`);
  let ok = 0;
  const failed = [];
  for (const p of plan) {
    const { error } = await sb.from(p.table).update(p.patch).eq("id", p.id).eq("tenant_id", TENANT);
    if (error) { failed.push(`${p.table}/${p.id}: ${error.message}`); continue; }
    ok++;
  }
  console.log(`  成功 ${ok} 行 / 失敗 ${failed.length} 行`);
  for (const f of failed.slice(0, 20)) console.log(`    ✗ ${f}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
