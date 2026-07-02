// 総称サービス名 → 正式コード名への変換 (2026-07-02)
// ---------------------------------------------------------------
// パターン登録の旧 5 択 (身体介護 / 生活援助 等の総称) で作られた
// kaigo_visit_schedule / kaigo_visit_patterns の行を、時間数から
// 訪問介護の正式名称 (身体介護3 等) に変換して単位数を引けるようにする。
//
// 変換規則 (令和6年度 訪問介護):
//   身体介護:  <20分 → 身体介護01 / 20-30 → 身体介護1 / 30-60 → 身体介護2
//              60-90 → 身体介護3 / 以降 30 分ごとに +1 (上限 身体介護9)
//   生活援助:  20-45分 → 生活援助2 / 45分以上 → 生活援助3
//   その他の総称 (身体・生活 等) は自動変換できないため report のみ
//
// usage:
//   node migrations/fix_generic_service_names.mjs            # DRY RUN
//   node migrations/fix_generic_service_names.mjs --execute  # 変換実行
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const toHankaku = (s) =>
  (s ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

const mins = (start, end) => {
  if (!start || !end) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const d = (eh * 60 + em) - (sh * 60 + sm);
  return d > 0 ? d : null;
};

// 総称 + 分数 → 正式名称 (半角数字。既存 schedule データの表記に合わせる)
function mapName(generic, m) {
  if (m == null) return null;
  if (generic === "身体介護") {
    if (m < 20) return "身体介護01";
    if (m < 30) return "身体介護1";
    if (m < 60) return "身体介護2";
    const n = Math.min(9, Math.floor(m / 30) + 1); // 60-90→3, 90-120→4, ...
    return `身体介護${n}`;
  }
  if (generic === "生活援助") {
    if (m < 20) return null; // 20 分未満の生活援助は算定不可 → report
    if (m < 45) return "生活援助2";
    return "生活援助3";
  }
  return null; // 身体・生活 / 通院等乗降介助 / その他 は自動変換しない
}

async function pageLoop(table, select, filter) {
  const PAGE = 1000; const rows = []; let from = 0;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} fetch 失敗: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

// 単位数マスタ (基本) — 変換先が本当に引けるか verify 用
const codes = await pageLoop("kaigo_service_codes", "service_name, units", (q) => q.eq("calculation_type", "基本"));
const unitByNorm = new Map();
for (const c of codes) { const k = toHankaku(c.service_name); if (!unitByNorm.has(k)) unitByNorm.set(k, c.units); }

const GENERICS = ["身体介護", "生活援助", "身体・生活", "通院等乗降介助", "その他"];

async function plan(table, timeCols) {
  const rows = await pageLoop(table, `id, service_type, ${timeCols.join(", ")}`,
    (q) => q.in("service_type", GENERICS));
  const updates = []; const skipped = [];
  for (const r of rows) {
    const m = mins(r[timeCols[0]], r[timeCols[1]]);
    const to = mapName(r.service_type, m);
    if (to && unitByNorm.has(toHankaku(to))) {
      updates.push({ id: r.id, from: r.service_type, to, m });
    } else {
      skipped.push({ id: r.id, from: r.service_type, m });
    }
  }
  return { rows, updates, skipped };
}

const sched = await plan("kaigo_visit_schedule", ["start_time", "end_time"]);
const pat = await plan("kaigo_visit_patterns", ["start_time", "end_time"]);

function report(label, p) {
  console.log(`\n${label}: 総称名 ${p.rows.length} 件 → 変換可 ${p.updates.length} / 変換不可 ${p.skipped.length}`);
  const byMap = {};
  for (const u of p.updates) { const k = `${u.from}(${u.m}分) → ${u.to} [${unitByNorm.get(toHankaku(u.to))}単位]`; byMap[k] = (byMap[k] ?? 0) + 1; }
  for (const [k, n] of Object.entries(byMap).sort()) console.log(`  ${k}: ${n} 件`);
  for (const s of p.skipped) console.log(`  !! 変換不可: "${s.from}" (${s.m ?? "?"}分) id=${s.id}`);
}
report("kaigo_visit_schedule", sched);
report("kaigo_visit_patterns", pat);

if (!EXECUTE) { console.log("\n[DRY RUN] 変更していません。--execute で実行。"); process.exit(0); }

const backupPath = fileURLToPath(new URL(`./_backup_generic_name_fix_20260702.json`, import.meta.url));
writeFileSync(backupPath, JSON.stringify({ sched: sched.rows, pat: pat.rows }, null, 1), "utf8");
console.log(`\nbackup 書出し: ${backupPath}`);

async function applyUpdates(table, updates) {
  let done = 0;
  for (const u of updates) {
    const { error } = await sb.from(table).update({ service_type: u.to }).eq("id", u.id);
    if (error) throw new Error(`${table} update 失敗 (id=${u.id}): ${error.message}`);
    done++;
  }
  return done;
}
console.log(`更新完了: schedule ${await applyUpdates("kaigo_visit_schedule", sched.updates)} 件 / patterns ${await applyUpdates("kaigo_visit_patterns", pat.updates)} 件`);

// verify: 単位が引けない schedule の残数
const after = await pageLoop("kaigo_visit_schedule", "id, service_type");
const remain = after.filter((s) => !unitByNorm.has(toHankaku(s.service_type ?? "")));
console.log(`verify: 単位数なし schedule 残 ${remain.length} 件`);
for (const r of remain.slice(0, 10)) console.log(`  - "${r.service_type}" id=${r.id}`);
