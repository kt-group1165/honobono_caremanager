// 限度額適用期間 backfill: 介護保険 全居宅.CSV の「適用期間（居宅ｻｰﾋﾞｽ区分）」を
// client_insurance_records.limit_period_start/end へ投入する。
//   給付管理票 8222 項13/14 は限度額適用期間が正で、区分変更等があると
//   認定有効期間とズレる (おゆみ野2名・いすみ3名で KY 不一致になった)。
//   突合キー = 被保険者番号 + 保険者番号 + 認定有効期間開始日 (既存レコードの認定行を特定)。
//   全事業所横断 (CSV は全居宅ぶんを含む)。要 migration kyotaku_limit_period.sql。
//
//   node migrations/import_kyotaku_limit_period.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const iso = (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s || "").trim()); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
const num = (s) => (s || "").trim();

async function main() {
  console.log(`=== 限度額適用期間 backfill (全居宅) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const rows = sjis.decode(readFileSync(path.join(KAIGO, "利用者データ/全居宅/介護保険 全居宅.CSV"))).split(/\r?\n/).filter((l) => l).map(pl);
  const H = rows[0]; const g = (n) => H.findIndex((h) => h.replace(/^"|"$/g, "") === n);
  const iIns = g("被保険者番号"), iHoken = g("保険者番号"), iCs = g("認定有効期間－開始日"),
    iLs = g("適用期間－開始日（居宅ｻｰﾋﾞｽ区分）"), iLe = g("適用期間－終了日（居宅ｻｰﾋﾞｽ区分）");
  if ([iIns, iHoken, iCs, iLs, iLe].some((i) => i < 0)) { console.error("ヘッダー不一致:", H); process.exit(1); }

  // (被保番|保険者|認定開始) → 適用期間。CSV は認定世代ごとに行があるので全行対象
  const byKey = new Map();
  let diffCount = 0;
  const iCe = g("認定有効期間－終了日");
  for (const c of rows.slice(1)) {
    const ins = num(c[iIns]), hoken = num(c[iHoken]), cs = iso(c[iCs]);
    const ls = iso(c[iLs]), le = iso(c[iLe]);
    if (!ins || !hoken || !cs || !ls || !le) continue;
    byKey.set(`${ins}|${hoken}|${cs}`, { ls, le });
    if (ls !== cs || le !== iso(c[iCe])) diffCount++;
  }
  console.log(`CSV 適用期間あり: ${byKey.size} 行 (認定有効期間とズレあり ${diffCount} 行)`);

  // 既存 insurance records を全件なめて突合
  const updates = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("client_insurance_records")
      .select("id, insured_number, insurer_number, certification_start_date, limit_period_start, limit_period_end")
      .order("id", { ascending: true })
      .range(f, f + 999);
    if (error) { console.error("取得失敗:", error.message); process.exit(1); }
    for (const r of data) {
      const k = `${num(r.insured_number)}|${num(r.insurer_number)}|${r.certification_start_date || ""}`;
      const v = byKey.get(k);
      if (!v) continue;
      if (r.limit_period_start === v.ls && r.limit_period_end === v.le) continue;
      updates.push({ id: r.id, ...v, key: k });
    }
    if (data.length < 1000) break;
  }
  console.log(`更新対象: ${updates.length} 件`);
  for (const u of updates.slice(0, 10)) console.log(`  ${u.key} → ${u.ls}〜${u.le}`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で更新。"); return; }
  let ok = 0;
  for (const u of updates) {
    const { error, count } = await sb.from("client_insurance_records")
      .update({ limit_period_start: u.ls, limit_period_end: u.le }, { count: "exact" }).eq("id", u.id);
    if (error) { console.error(`✗ ${u.key}: ${error.message}`); process.exit(1); }
    ok += count || 0;
  }
  console.log(`更新 ${ok} 件 完了`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
