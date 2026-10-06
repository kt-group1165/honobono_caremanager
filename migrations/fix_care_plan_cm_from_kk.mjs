#!/usr/bin/env node
/**
 * 居宅のケアプラン (active) の 介護支援専門員番号・計画作成依頼届出年月日 を
 * ほのぼのが実際に請求した明細書 (KK 8124 の 項24 / 項16) の値で直す。
 *
 *   TARGET_MONTH=2026-06 node migrations/fix_care_plan_cm_from_kk.mjs            # DRY RUN
 *   TARGET_MONTH=2026-06 node migrations/fix_care_plan_cm_from_kk.mjs --execute
 *
 * ── なぜ要るか (2026-10-06 実測) ─────────────────────────────────────────
 *   2026-08-30 に CAREPLAN1.CSV から入れたケアプラン 40 件は、取込がこの 2 列を書かない作りで空だった。
 *   2026-09-02 に計画書の「作成者」氏名から番号を推定し、25 件 (作成者 = 佐々木 恵子) に 12030438 を入れたが、
 *   ほのぼのの請求 (KK) ではこの 25 名の担当は全員別人だった (12030438 は花見川の 30 名の担当)。
 *   → 明細書 8124 の 項24 が誤った担当で、項16 (届出日) が空で出ていた。
 *   ほのぼの 2026-06 居宅レセプト 2,808 名のうち、当方の 2 列が KK と食い違うのは この 40 件だけ
 *   (届出日は「空」だけで、値が違うものは 0 件)。
 *
 * ── 書き換えるもの / 触らないもの ───────────────────────────────────────
 *   ・(保険者, 被保番) で利用者が 1 名に決まり、active なケアプランが 1 件の人だけ
 *   ・KK と食い違う列だけ書く (一致している列は触らない)。空の KK 値では上書きしない
 *   ・番号を変えた行の care_manager_name: 他の active ケアプランで その番号の氏名が 1 つに決まれば その氏名、
 *     決まらなければ NULL (誤った氏名を残さない)
 *   ・書き換え前の行は migrations/_backup_care_plan_cm_from_kk_<日時>.json に退避 (利用者 ID を含むので commit しない)
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Encoding from "encoding-japanese";

const EXECUTE = process.argv.includes("--execute");
const TARGET_MONTH = process.env.TARGET_MONTH ?? "2026-06";
const YM = TARGET_MONTH.replace("-", "");
const [Y, M] = TARGET_MONTH.split("-").map(Number);
const NEXT_YM = M === 12 ? `${Y + 1}01` : `${Y}${String(M + 1).padStart(2, "0")}`;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function fetchAll(table, select, f) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(sb.from(table).select(select)).order("id").range(from, from + 999);
    if (error) throw new Error(`${table} 取得失敗: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// 1) KK 8124 (提供年月 = 対象月) の 基本行 (明細番号 1) から 保険者|被保番 → {cm, req}
//    当初分 (提供年月フォルダ) と 月遅れ・出し直し (翌月フォルダ) の両方を読む。後に読んだ方が勝つ
const hono = new Map();
const conflicts = [];
for (const area of readdirSync(path.join(ROOT, "伝送データ"))) {
  for (const ym of [YM, NEXT_YM]) {
    for (const d of [path.join(ROOT, "伝送データ", area, "居宅", ym, "ほのぼのから"), path.join(ROOT, "伝送データ", area, "居宅", ym)]) {
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => /^KK.*\.CSV$/i.test(x)).sort()) {
        const text = Encoding.convert(readFileSync(path.join(d, f)), { to: "UNICODE", from: "SJIS", type: "string" });
        for (const l of text.split(/\r?\n/)) {
          const c = l.replace(/"/g, "").split(",");
          if (c[2] !== "8124" || c[5] !== YM || c[17] !== "1") continue;
          const key = `${c[6].replace(/^0+/, "")}|${c[8]}`;
          const prev = hono.get(key);
          if (prev && (prev.cm !== c[24] || prev.req !== c[16])) conflicts.push(`${area} ${key}: ${prev.cm}/${prev.req} → ${c[24]}/${c[16]}`);
          hono.set(key, { cm: c[24], req: c[16], area });
        }
      }
    }
  }
}

// 2) 当方
const [ymY, ymM] = [Y, M];
const monthFirst = `${ymY}-${String(ymM).padStart(2, "0")}-01`;
const ins = await fetchAll("client_insurance_records", "id,client_id,insurer_number,insured_number", (q) => q.gte("certification_end_date", monthFirst));
const cidByKey = new Map();
for (const r of ins) {
  const k = `${(r.insurer_number ?? "").replace(/^0+/, "")}|${r.insured_number}`;
  (cidByKey.get(k) ?? cidByKey.set(k, new Set()).get(k)).add(r.client_id);
}
const plans = await fetchAll("kaigo_care_plans", "id,user_id,care_manager_number,care_manager_name,plan_request_date", (q) => q.eq("status", "active"));
const plansByUser = new Map();
for (const p of plans) (plansByUser.get(p.user_id) ?? plansByUser.set(p.user_id, []).get(p.user_id)).push(p);
// 番号 → 氏名 (他の active ケアプランで 1 つに決まるもの)
const namesByCm = new Map();
for (const p of plans) if (p.care_manager_number && p.care_manager_name) {
  (namesByCm.get(p.care_manager_number) ?? namesByCm.set(p.care_manager_number, new Set()).get(p.care_manager_number)).add(p.care_manager_name.replace(/\s+/g, " ").trim());
}

const toDate = (s) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null);
const updates = [];
const skipped = { noClient: 0, noPlan: 0, multiPlan: 0 };
for (const [key, h] of hono) {
  const cids = [...(cidByKey.get(key) ?? [])];
  if (cids.length !== 1) { skipped.noClient++; continue; }
  const ps = plansByUser.get(cids[0]) ?? [];
  if (!ps.length) { skipped.noPlan++; continue; }
  if (ps.length > 1) { skipped.multiPlan++; continue; }
  const p = ps[0];
  const patch = {};
  if (h.cm && p.care_manager_number !== h.cm) {
    patch.care_manager_number = h.cm;
    const names = namesByCm.get(h.cm);
    patch.care_manager_name = names && names.size === 1 ? [...names][0] : null;
  }
  const req = toDate(h.req);
  if (req && p.plan_request_date !== req) patch.plan_request_date = req;
  if (Object.keys(patch).length) updates.push({ plan: p, area: h.area, key, patch });
}

console.log(`=== ケアマネ番号・届出日を KK で是正 ${EXECUTE ? "【本番 EXECUTE】" : "【DRY RUN】"} 対象月=${TARGET_MONTH} ===`);
console.log(`KK 居宅レセプト ${hono.size} 名 / 是正対象 ${updates.length} 件 (スキップ: 利用者不定 ${skipped.noClient} / ケアプラン無し ${skipped.noPlan} / 複数 ${skipped.multiPlan})`);
const cnt = (f) => updates.filter((u) => f in u.patch).length;
console.log(`  番号を変える ${cnt("care_manager_number")} / 届出日を入れる ${cnt("plan_request_date")}`);
const before = {};
for (const u of updates.filter((x) => x.patch.care_manager_number)) before[u.plan.care_manager_number ?? "空"] = (before[u.plan.care_manager_number ?? "空"] ?? 0) + 1;
console.log(`  変える前の番号:`, before);
for (const u of updates) {
  const p = u.patch;
  console.log(`  ${u.area.padEnd(6, "　")} ${u.key}  ` +
    (p.care_manager_number ? `CM ${u.plan.care_manager_number ?? "空"}→${p.care_manager_number} (${u.plan.care_manager_name ?? "-"}→${p.care_manager_name ?? "空"})  ` : "") +
    (p.plan_request_date ? `届出 ${u.plan.plan_request_date ?? "空"}→${p.plan_request_date}` : ""));
}
if (conflicts.length) {
  console.log(`\n✗ KK 内で同じ人の値が食い違う ${conflicts.length} 件 (1 行も書かない):`);
  for (const c of conflicts) console.log("  " + c);
  process.exit(2);
}
if (!EXECUTE) { console.log("\n(DRY RUN。書き込むには --execute)"); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
const backup = path.join(ROOT, "migrations", `_backup_care_plan_cm_from_kk_${stamp}.json`);
writeFileSync(backup, JSON.stringify(updates.map((u) => u.plan)));
console.log(`\n退避 ${updates.length} 行 → ${backup}`);
let ok = 0;
for (const u of updates) {
  const { error, count } = await sb.from("kaigo_care_plans").update(u.patch, { count: "exact" }).eq("id", u.plan.id).eq("status", "active");
  if (error) { console.error(`✗ ${u.key} 更新失敗: ${error.message}`); process.exit(1); }
  if (count !== 1) { console.error(`✗ ${u.key} 更新件数 ${count} (1 のはず)`); process.exit(1); }
  ok++;
}
console.log(`✓ ${ok} 件 更新`);
