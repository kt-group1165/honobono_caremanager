/**
 * 障害受給者証の jogen_kanri_kubun (上限管理区分) backfill。
 *   取込スクリプト(import_honobono_shougai_*.mjs)が jogen_kanri_office_name(上限管理事業所名)は
 *   入れるのに jogen_kanri_kubun を設定していなかった不整合を埋める。
 *   区分は「上限管理事業所名 vs 自事業所名」の機械照合で導出 (判断不要):
 *     空          → なし
 *     自事業所と一致 → 自事業所 (+ 事業所番号 = 自 障害番号)
 *     それ以外      → 他事業所
 *   対象 = 取込マーカー([ほのぼの取込 ... 身障])かつ jogen_kanri_office_name あり。
 * Usage: node migrations/backfill_shogai_jogen_kubun.mjs [--execute]
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
const __d = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(__d, "..", ".env.local"), "utf8").split("\n").map(l => l.match(/^([^=]+)=(.+)$/)).filter(Boolean).map(m => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const EXECUTE = process.argv.includes("--execute");

// マーカーlabel → 自事業所 office_id
const OFFICE_BY_LABEL = {
  "茂原": "e08c3706-ad59-4913-b4e2-67f2675422e9",
  "大網": "269d77bc-5b61-4114-a2ea-e8dc2f220823",
  "花見川": "39ab7760-e23c-49ce-b17f-c5ccfa776d9c",
};
const norm = (s) => (s || "").normalize("NFKC").replace(/[\s　]/g, "");

// 自事業所名・障害番号を引く
const offRows = {};
for (const [label, id] of Object.entries(OFFICE_BY_LABEL)) {
  const { data } = await sb.from("offices").select("name, business_number, shogai_business_number").eq("id", id).maybeSingle();
  offRows[label] = { name: data?.name ?? "", num: data?.shogai_business_number ?? data?.business_number ?? null };
}
console.log("自事業所:", Object.entries(offRows).map(([k, v]) => `${k}=${v.name}(${v.num})`).join(" / "), "\n");

const { data: certs } = await sb.from("shougai_certifications")
  .select("id, beneficiary_number, jogen_kanri_kubun, jogen_kanri_office_name, jogen_kanri_office_number, notes, self_payment_limit");

let plan = [];
for (const c of certs || []) {
  const marker = (c.notes || "").split("\n")[0];
  if (!/身障/.test(marker)) continue;
  const label = Object.keys(OFFICE_BY_LABEL).find(l => marker.includes(l));
  if (!label) continue;
  if (!c.jogen_kanri_office_name) continue; // 上限管理事業所名なし = 区分なし が正 (触らない)
  const self = offRows[label];
  const a = norm(c.jogen_kanri_office_name), b = norm(self.name);
  const isSelf = b && (a === b || a.includes(b) || b.includes(a));
  const kubun = isSelf ? "自事業所" : "他事業所";
  const num = isSelf ? self.num : null;
  const changed = c.jogen_kanri_kubun !== kubun || (isSelf && c.jogen_kanri_office_number !== num);
  plan.push({ id: c.id, cert: c.beneficiary_number, label, name: c.jogen_kanri_office_name, limit: c.self_payment_limit, from: c.jogen_kanri_kubun, kubun, num, changed });
}

console.log(`=== 上限管理事業所名あり ${plan.length}件 の区分導出 ===`);
for (const p of plan) {
  console.log(`  [${p.label}] ${p.cert} 上限${p.limit}円 事業所名"${p.name}" → ${p.kubun}${p.num ? `(番号${p.num})` : ""}  ${p.changed ? (p.from === "なし" ? "★埋める" : `⚠${p.from}→${p.kubun}`) : "(変更なし)"}`);
}
const todo = plan.filter(p => p.changed);
console.log(`\n更新対象: ${todo.length}件`);
if (!EXECUTE) { console.log("🔍 DRY RUN (--execute で更新)"); process.exit(0); }
let ok = 0, ng = 0;
for (const p of todo) {
  const upd = { jogen_kanri_kubun: p.kubun };
  if (p.kubun === "自事業所") upd.jogen_kanri_office_number = p.num;
  const { error } = await sb.from("shougai_certifications").update(upd).eq("id", p.id);
  if (error) { console.error(`  ✗ ${p.cert}: ${error.message}`); ng++; } else ok++;
}
console.log(`\n✅ 更新 ${ok} / 失敗 ${ng}`);
