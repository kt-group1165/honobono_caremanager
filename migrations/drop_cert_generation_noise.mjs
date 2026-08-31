// ============================================================================
// 「認定期間は最新世代・適用期間だけ過去世代」という **ノイズ行**を片付ける。
//
//   node migrations/drop_cert_generation_noise.mjs             # DRY RUN
//   node migrations/drop_cert_generation_noise.mjs --execute
//
// ── 何が起きていたか ────────────────────────────────────────────────────
//   旧「認定履歴取込」は、**世代ごとの認定期間を limit_period_* に書き、
//   certification_* には最新世代の値を複製**していた。結果、松村 娃都子 は
//
//     認定2026-06-01〜2030-05-31 要介護2  適用[2017-06-01〜2018-05-31]
//     認定2026-06-01〜2030-05-31 要介護2  適用[2018-06-01〜2021-06-30]
//     …                                     ← 6 行すべて「2026-06 の認定」に見える
//
//   のようになり、**対象月の認定を引くと候補が 6 件**あって定まらない。
//
//   2026-09-01 に import_cert_history.mjs を (保険者,被保番) キーへ直して
//   3,297 行を入れ直し、**世代ごとの正しい認定行が別に入った**。
//   よってノイズ行が持っていた適用期間の情報は、もう本物の行が持っている。
//
// ── 消してよい条件 (1 行ずつ判定する) ───────────────────────────────────
//   ① 同じ (利用者, 保険者, 被保番, 認定期間, 要介護度, 限度額) の行が 2 行以上ある
//   ② その組に「適用期間が空 or 認定開始日と同じ」= 素直な行が 1 行あり、それを残す
//   ③ 消す行の 適用期間 が、**別の認定行の認定期間として実在する**
//        (終了日が一致 かつ 開始が同じ年月。認定開始日は月中・適用開始は月初のことがある)
//   ③ を満たさない行は **消さずに残して報告する**。組ごと諦めるのではなく 1 行ずつ。
//
//   ・帳票 (kaigo_report_documents.certification_id) が消す行を指していたら、
//     残す行へ付け替えてから消す。付け替えに失敗したら消さない。
//   ・消した内容は migrations/_dropped_cert_generation_noise.json に残す。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const BACKUP = path.join(KAIGO, "migrations/_dropped_cert_generation_noise.json");

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const KEY = ["client_id", "insurer_number", "insured_number",
  "certification_start_date", "certification_end_date", "care_level", "service_limit_amount"];

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
const ym = (d) => (d ?? "").slice(0, 7);
const filled = (r) => Object.values(r).filter((v) => v != null && v !== "").length;

async function main() {
  console.log(`=== 認定の世代ノイズ行を片付ける ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const recs = await fetchAll(() => sb.from("client_insurance_records").select("*"));
  const clients = new Map((await fetchAll(() => sb.from("clients").select("id, name"))).map((c) => [c.id, c.name]));
  const docs = await fetchAll(() => sb.from("kaigo_report_documents")
    .select("id, certification_id").not("certification_id", "is", null));
  const docsByCert = new Map();
  for (const d of docs) {
    if (!docsByCert.has(d.certification_id)) docsByCert.set(d.certification_id, []);
    docsByCert.get(d.certification_id).push(d.id);
  }

  const byClient = new Map();
  for (const r of recs) {
    if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
    byClient.get(r.client_id).push(r);
  }
  const groups = new Map();
  for (const r of recs) {
    const k = KEY.map((c) => String(r[c] ?? "")).join("|");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const dups = [...groups.values()].filter((v) => v.length > 1);
  console.log(`認定 ${recs.length} 件 / 同じ内容が 2 行以上ある組 ${dups.length}`);

  const plan = [], kept = [];
  for (const rows of dups) {
    const cid = rows[0].client_id;
    // ② 素直な行 (適用期間が空 or 認定開始日と同じ) を残す。複数あれば値が埋まっているほう
    const cands = rows.filter((r) => !r.limit_period_start || r.limit_period_start === r.certification_start_date);
    if (!cands.length) { kept.push(`${clients.get(cid)}: 残す行を決められない`); continue; }
    const keep = cands.sort((a, b) => filled(b) - filled(a))[0];
    for (const r of rows) {
      if (r.id === keep.id) continue;
      const ls = r.limit_period_start, le = r.limit_period_end;
      // ③ その適用期間が別の認定行の認定期間として実在するか
      const covered = ls && (byClient.get(cid) ?? []).some((o) =>
        o.id !== r.id && o.certification_end_date === le && ym(o.certification_start_date) === ym(ls) &&
        o.certification_start_date !== r.certification_start_date);
      if (!covered) { kept.push(`${clients.get(cid)}: 適用[${ls}〜${le}] に対応する認定行が無い → 残す`); continue; }
      plan.push({ keep: keep.id, row: r, name: clients.get(cid) });
    }
  }

  const docMoves = plan.flatMap((p) => (docsByCert.get(p.row.id) ?? []).map((d) => ({ doc: d, to: p.keep })));
  console.log(`   消せる行 ${plan.length} 件 (対象 ${new Set(plan.map((p) => p.name)).size} 名)`);
  console.log(`   帳票の付け替え ${docMoves.length} 件`);
  console.log(`   消さずに残す ${kept.length} 件`);
  for (const k of kept.slice(0, 12)) console.log(`      ${k}`);

  console.log("\n― 例 (先頭6行) ―");
  for (const p of plan.slice(0, 6)) {
    console.log(`   ${String(p.name).padEnd(12)} 認定${p.row.certification_start_date}〜${p.row.certification_end_date}` +
      ` ${p.row.care_level} 適用[${p.row.limit_period_start}〜${p.row.limit_period_end}] → 消す`);
  }

  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }

  writeFileSync(BACKUP, JSON.stringify(plan.map((p) => ({ name: p.name, keep: p.keep, dropped: p.row })), null, 2), "utf8");
  const failed = new Set();
  for (const m of docMoves) {
    const { error } = await sb.from("kaigo_report_documents").update({ certification_id: m.to }).eq("id", m.doc);
    if (error) { console.error(`✗ 帳票 ${m.doc.slice(0, 8)} の付け替えに失敗: ${error.message}`); failed.add(m.to); }
  }
  let ok = 0, ng = 0;
  for (const p of plan) {
    if (failed.has(p.keep)) { console.log(`  = ${p.name}: 帳票の付け替えに失敗したので消さない`); continue; }
    const { error } = await sb.from("client_insurance_records").delete().eq("id", p.row.id);
    if (error) { console.error(`✗ ${p.name}: ${error.message}`); ng++; continue; }
    ok++;
  }
  console.log(`\n消した ${ok} 件 / 失敗 ${ng} 件 / 帳票の付け替え ${docMoves.length} 件`);
  console.log(`内容を ${path.basename(BACKUP)} に残しました`);
}

main().catch((e) => { console.error(e); process.exit(1); });
