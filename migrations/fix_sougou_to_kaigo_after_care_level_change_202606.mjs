// ============================================================================
// 要支援 → 要介護 に変わった後の訪問が「総合事業」のまま入っている 7 行を「介護」に直す (2026-06)
//
//   node migrations/fix_sougou_to_kaigo_after_care_level_change_202606.mjs            # DRY RUN
//   node migrations/fix_sougou_to_kaigo_after_care_level_change_202606.mjs --execute  # 本番 (H が実行)
//
// ── なぜ ──────────────────────────────────────────────────────────────────
// 取込元 MEISAI のサービス名が区分変更前 (訪問型独自サービス) のままで、
// import_meisai_sougou_records.mjs が総合事業として入れていた。要介護の人を総合事業で出すと返戻。
// 見つけたのは check:teikyohyo-diff (ほのぼの 提供票一覧 CSV との突合)。全社・全月でこの 7 行だけ
// (2026-11-12。check:densou の [7] で見張っている)。
//
// ── 何をするか (7 行それぞれ、提供票の実績のコードを個別に確認して決めた) ─────────────
//   system: 総合事業 → 介護
//   service_type: 提供票のコードの名前 (下の TARGETS。3 名まとめて同じコードに倒していない)
//   notes: 先頭を [区分変更是正 ...] にし、元の notes を後ろに残す
//     ★ 先頭を変えるのは、総合事業の取込 (notes が "[MEISAI総合取込" で始まる行を消して入れ直す) と
//       介護の取込 ("[MEISAI取込" で始まる行) の どちらの削除条件にも当たらないようにするため。
//       当たると是正が黙って巻き戻る (SESSION_START ⑲ の型)
//   時刻・職員・事業所・billable は触らない。★ ほのぼのの出力に合わせて時刻を書き換えない
//     (市川 博義 は 提供票 13:00-14:00 / 当方 13:00-13:45 だが、当方の入力を正とする。循環を作らない)
//
// ── 触らないもの ───────────────────────────────────────────────────────────
//   ・市川 博義 6/10・6/11 は要支援２ の期間 (要介護２ は 6/17〜) なので総合事業のまま (正しい)
//   ・訪問介護初回加算 (114001): ほのぼのは 市川 博義 6/25 / 荻野 秀之 6/24 に付けている。
//     当方の加算行 (kaigo_visit_addon_lines) には無い。★ この script では入れない (別途判断)
//
// ── 安全装置 ───────────────────────────────────────────────────────────────
//   ・各行が ちょうど 1 行見つかり、今の値が想定どおり (system=総合事業 / service_type / 時刻) でなければ止める
//   ・訪問日に有効な認定が 要介護 であることを実行時にも確かめる (1 件でも違えば止める)
//   ・付け替え先の service_type が 2026-06 に有効な介護のマスタにそのコードで実在することを確かめる
//   ・--execute の前に対象行を JSON に退避 (migrations/_backup_fix_sougou_to_kaigo_202606_<時刻>.json・commit しない)
//   ・更新は 1 行ずつ id 指定で、更新件数が 1 であることを確かめる。最後に読み直して検算
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error("✗ .env.local に Supabase の設定が無い"); process.exit(1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MONTH_FIRST = "2026-06-01";
const MARK = "[区分変更是正 2026-06 総合→介護";
// 提供票一覧 (KSG0261・2026-06・実績・介護保険) で 1 行ずつ確認したコード
const TARGETS = [
  { name: "東城 宏三", date: "2026-06-04", start: "10:30", oldType: "訪問型独自サービス２３", code: "117311", newType: "生活援助３" },
  { name: "東城 宏三", date: "2026-06-11", start: "10:30", oldType: "訪問型独自サービス２３", code: "117311", newType: "生活援助３" },
  { name: "東城 宏三", date: "2026-06-18", start: "10:30", oldType: "訪問型独自サービス２３", code: "117311", newType: "生活援助３" },
  { name: "東城 宏三", date: "2026-06-25", start: "10:30", oldType: "訪問型独自サービス２３", code: "117311", newType: "生活援助３" },
  { name: "市川 博義", date: "2026-06-24", start: "13:00", oldType: "訪問型独自サービス２３", code: "117311", newType: "生活援助３" },
  { name: "市川 博義", date: "2026-06-25", start: "13:00", oldType: "訪問型独自サービス２３", code: "117311", newType: "生活援助３" },
  { name: "荻野 秀之", date: "2026-06-24", start: "09:00", oldType: "訪問型独自サービス２１", code: "114111", newType: "身体１生活１" },
];

async function main() {
  console.log(`=== 区分変更後の総合事業 → 介護 (2026-06) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const problems = [];

  // 付け替え先のコードが 2026-06 に有効な介護マスタに実在するか
  const codes = [...new Set(TARGETS.map((t) => t.code))];
  const { data: master, error: mErr } = await sb.from("kaigo_service_codes")
    .select("service_code, service_name, units, valid_from, valid_until").eq("system", "介護").in("service_code", codes);
  if (mErr) { console.error(`✗ マスタ取得失敗: ${mErr.message}`); process.exit(1); }
  for (const t of TARGETS) {
    const hit = (master ?? []).filter((m) => m.service_code === t.code && m.valid_from <= MONTH_FIRST && (!m.valid_until || m.valid_until >= MONTH_FIRST));
    if (hit.length !== 1 || hit[0].service_name !== t.newType) problems.push(`マスタ ${t.code} が「${t.newType}」として 1 行で引けない (${JSON.stringify(hit)})`);
  }

  const plans = [];
  for (const t of TARGETS) {
    const { data: cs, error: cErr } = await sb.from("clients").select("id, name").eq("name", t.name);
    if (cErr) { console.error(`✗ clients 取得失敗: ${cErr.message}`); process.exit(1); }
    if ((cs ?? []).length !== 1) { problems.push(`${t.name}: clients が ${cs?.length ?? 0} 人 (1 人に決まらない)`); continue; }
    const cid = cs[0].id;
    const { data: rows, error: sErr } = await sb.from("kaigo_visit_schedule")
      .select("id, user_id, visit_date, start_time, end_time, service_type, system, status, notes, office_id")
      .eq("user_id", cid).eq("visit_date", t.date).eq("system", "総合事業");
    if (sErr) { console.error(`✗ 実績取得失敗: ${sErr.message}`); process.exit(1); }
    const hit = (rows ?? []).filter((r) => (r.start_time ?? "").slice(0, 5) === t.start);
    if (hit.length !== 1) { problems.push(`${t.name} ${t.date} ${t.start}: 総合事業の行が ${hit.length} 行 (1 行でない)`); continue; }
    const r = hit[0];
    if (r.service_type !== t.oldType || r.status !== "completed") problems.push(`${t.name} ${t.date}: 今の値が想定と違う (${r.service_type} / ${r.status})`);
    if ((r.notes ?? "").startsWith(MARK)) problems.push(`${t.name} ${t.date}: 既に是正済みの印がある`);
    const { data: certs, error: ceErr } = await sb.from("client_insurance_records")
      .select("care_level, certification_start_date, certification_end_date").eq("client_id", cid);
    if (ceErr) { console.error(`✗ 認定取得失敗: ${ceErr.message}`); process.exit(1); }
    const valid = (certs ?? []).filter((c) => c.certification_start_date && c.certification_start_date <= t.date && (!c.certification_end_date || c.certification_end_date >= t.date));
    const levels = [...new Set(valid.map((c) => c.care_level))];
    if (valid.length === 0 || !levels.every((l) => /^要介護/.test(l ?? ""))) problems.push(`${t.name} ${t.date}: 訪問日の認定が要介護で一意でない (${levels.join(",") || "なし"})`);
    plans.push({ t, row: r, levels });
  }

  for (const p of plans)
    console.log(`  ${p.t.name} ${p.t.date} ${(p.row.start_time ?? "").slice(0, 5)}-${(p.row.end_time ?? "").slice(0, 5)}  総合事業「${p.row.service_type}」→ 介護「${p.t.newType}」(${p.t.code})  認定 ${p.levels.join(",")}`);
  console.log(`\n対象 ${plans.length} / ${TARGETS.length} 行`);
  if (problems.length) {
    console.error(`\n✗ 止める理由が ${problems.length} 件:`);
    for (const x of problems) console.error(`  ${x}`);
    process.exit(2);
  }
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で 退避 → 1 行ずつ更新 → 読み直して検算。"); return; }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const backup = path.join(KAIGO, "migrations", `_backup_fix_sougou_to_kaigo_202606_${stamp}.json`);
  writeFileSync(backup, JSON.stringify(plans.map((p) => p.row), null, 2));
  console.log(`退避: ${backup}`);

  for (const p of plans) {
    const notes = `${MARK} 提供票=${p.t.code}] 元: ${p.row.notes ?? ""}`;
    const { data, error } = await sb.from("kaigo_visit_schedule")
      .update({ system: "介護", service_type: p.t.newType, notes }).eq("id", p.row.id).eq("system", "総合事業").select("id");
    if (error) { console.error(`✗ 更新失敗 ${p.t.name} ${p.t.date}: ${error.message} (ここまでの更新は退避ファイルから戻せる)`); process.exit(1); }
    if ((data ?? []).length !== 1) { console.error(`✗ 更新件数が 1 でない ${p.t.name} ${p.t.date}: ${(data ?? []).length}`); process.exit(1); }
  }
  const { data: after, error: aErr } = await sb.from("kaigo_visit_schedule").select("id, system, service_type, notes").in("id", plans.map((p) => p.row.id));
  if (aErr) { console.error(`✗ 検算の読み直し失敗: ${aErr.message}`); process.exit(1); }
  const ok = (after ?? []).filter((a) => a.system === "介護" && (a.notes ?? "").startsWith(MARK)).length;
  console.log(`検算: 介護 + 是正の印 ${ok} / ${plans.length} 行`);
  if (ok !== plans.length) process.exit(1);
  console.log("完了。MONTH=2026-06 npm run check:densou の [7] が 0 になることを確かめ、SYSTEM_CARE_LEVEL_KNOWN を 0 に下げること");
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
