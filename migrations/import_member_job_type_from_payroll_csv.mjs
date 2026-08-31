// ============================================================================
// 給与管理システムの従業員データ CSV から members.role (職種) を埋める。
//
//   node migrations/import_member_job_type_from_payroll_csv.mjs             # DRY RUN
//   node migrations/import_member_job_type_from_payroll_csv.mjs --execute
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   members 在籍 658 名のうち **role が空 576 名 (88%)**。職種が無いと
//   勤務形態一覧表 (運営指導で出す) が作れず、シフト画面の並びも職種で切れない。
//
//   private-data/payroll-data/従業員/*.csv (22 拠点 / 1,231 行) に「職種」列がある。
//   氏名で 92% 当たるので、これを写す。
//
// ── 語彙は既存 members.role に合わせる ──────────────────────────────────
//   CSV は「ヘルパー / 事務員 / ケアマネージャー」の 3 値。
//   既存 DB は 訪問介護員 64 / 事務 10 なので、そこへ寄せる。
//
// ── 触らないもの ────────────────────────────────────────────────────────
//   ・role が既に入っている人 (上書きしない)
//   ・退職者 / 削除済み
//   ・**同姓同名** — DB 側でも CSV 側でも重複したら、どちらか判らないので飛ばす
//   ・CSV で職種が食い違う人 (拠点をまたいで別の職種で登録されている)
//
//   ⚠ この CSV に **資格 (介護福祉士 / 初任者研修 等) は入っていない**。
//     qualifications は埋まらない。勤務形態一覧表には資格欄があるので、
//     そこはほのぼの側の職員マスタから別途取る必要がある。
//
//   変更前の値は migrations/_member_job_type_backup.json に残す。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const CSV_DIR = path.join(KAIGO, "../../private-data/payroll-data/従業員");
const BACKUP = path.join(KAIGO, "migrations/_member_job_type_backup.json");

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

/** CSV の職種 → members.role の既存語彙 */
const ROLE_MAP = {
  "ヘルパー": "訪問介護員",
  "事務員": "事務",
  "ケアマネージャー": "介護支援専門員",
};

const norm = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "").trim();

/** ダブルクォート対応の 1 行パーサ */
function parseLine(line) {
  const out = []; let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(f); f = ""; }
    else f += c;
  }
  out.push(f);
  return out.map((v) => v.trim());
}

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

function loadCsv() {
  const byName = new Map();   // 氏名 → { role, sources:[], conflict:bool }
  let rows = 0;
  for (const f of readdirSync(CSV_DIR).filter((n) => n.toLowerCase().endsWith(".csv"))) {
    const area = f.replace(/_?従業員データ.*$/, "").replace(/_給与管理システム$/, "");
    const text = new TextDecoder("shift_jis").decode(readFileSync(path.join(CSV_DIR, f)));
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) continue;
    const head = parseLine(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
    const ix = Object.fromEntries(head.map((h, i) => [h, i]));
    if (ix["氏名"] == null || ix["職種"] == null) {
      console.error(`✗ ${f}: 氏名 / 職種 列が無い → 飛ばす`);
      continue;
    }
    for (const ln of lines.slice(1)) {
      const r = parseLine(ln);
      const nm = norm(r[ix["氏名"]]);
      const job = (r[ix["職種"]] ?? "").trim();
      if (!nm || !job) continue;
      rows++;
      const role = ROLE_MAP[job];
      const cur = byName.get(nm);
      if (!cur) byName.set(nm, { job, role, sources: [area], conflict: !role });
      else {
        cur.sources.push(area);
        if (cur.job !== job) cur.conflict = true;   // 拠点で職種が違う → 判らない
      }
    }
  }
  return { byName, rows };
}

async function main() {
  console.log(`=== 従業員 CSV から members.role (職種) を埋める ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const { byName, rows } = loadCsv();
  console.log(`CSV: ${rows} 行 / 氏名ユニーク ${byName.size} 名`);
  const unmapped = new Set();
  for (const v of byName.values()) if (!v.role) unmapped.add(v.job);
  if (unmapped.size) console.log(`   ⚠ 対応表に無い職種: ${[...unmapped].join(" / ")} → 飛ばす`);

  const members = await fetchAll(() => sb.from("members")
    .select("id, name, role, status, deleted_at, employment_type"));
  const active = members.filter((m) => !m.deleted_at && m.status === "active");
  console.log(`members: 取得 ${members.length} / 在籍 ${active.length}`);

  // DB 側の同姓同名は判別できない
  const dbCount = new Map();
  for (const m of active) dbCount.set(norm(m.name), (dbCount.get(norm(m.name)) ?? 0) + 1);

  const plan = [], skip = { hasRole: 0, noCsv: 0, dbDup: [], csvConflict: [] };
  for (const m of active) {
    if (m.role) { skip.hasRole++; continue; }
    const nm = norm(m.name);
    const hit = byName.get(nm);
    if (!hit) { skip.noCsv++; continue; }
    if (dbCount.get(nm) > 1) { skip.dbDup.push(m.name); continue; }
    if (hit.conflict) { skip.csvConflict.push(`${m.name} (${hit.job})`); continue; }
    plan.push({ id: m.id, name: m.name, role: hit.role, from: hit.job, area: hit.sources.join(",") });
  }

  const byRole = {};
  for (const p of plan) byRole[p.role] = (byRole[p.role] ?? 0) + 1;
  console.log(`\n埋める ${plan.length} 名   ${Object.entries(byRole).map(([k, v]) => `${k} ${v}`).join(" / ")}`);
  console.log(`触らない: role が既にある ${skip.hasRole} / CSV に居ない ${skip.noCsv}` +
    ` / DB 同姓同名 ${skip.dbDup.length} / CSV で職種が食い違う ${skip.csvConflict.length}`);
  if (skip.dbDup.length) console.log(`   同姓同名: ${[...new Set(skip.dbDup)].slice(0, 12).join(" / ")}`);
  if (skip.csvConflict.length) console.log(`   食い違い: ${skip.csvConflict.slice(0, 12).join(" / ")}`);

  console.log("\n― 例 (先頭8名) ―");
  for (const p of plan.slice(0, 8)) {
    console.log(`   ${p.name.padEnd(14)} (空) → ${p.role}   [CSV: ${p.from} / ${p.area}]`);
  }

  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }

  writeFileSync(BACKUP, JSON.stringify(plan.map((p) => ({ id: p.id, name: p.name, before: null, after: p.role })), null, 2), "utf8");
  let ok = 0, ng = 0;
  for (const p of plan) {
    // role が空のままの人だけを対象にする (並行セッションが入れていたら触らない)
    const { data, error } = await sb.from("members").update({ role: p.role })
      .eq("id", p.id).is("role", null).select("id");
    if (error) { console.error(`✗ ${p.name}: ${error.message}`); ng++; continue; }
    if (!data?.length) { console.log(`  = ${p.name}: 既に role が入っていた → 触らない`); continue; }
    ok++;
  }
  console.log(`\n埋めた ${ok} 名 / 失敗 ${ng} 名`);
  console.log(`変更内容を ${path.basename(BACKUP)} に残しました`);
  console.log("⚠ 資格 (qualifications) はこの CSV に無いので空のままです");
}

main().catch((e) => { console.error(e); process.exit(1); });
