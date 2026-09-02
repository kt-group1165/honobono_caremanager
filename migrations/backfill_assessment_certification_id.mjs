// █████████████████████████████████████████████████████████████████████████
// ██  ⛔ 使用禁止。実行しないでください。                                  ██
// ██  代わりに migrations/fix_assessment_cert_link.mjs を使うこと。        ██
// █████████████████████████████████████████████████████████████████████████
//
// ── なぜ使ってはいけないか (2026-09-03 実測) ──────────────────────────────
//   この script は「その user の **最新** の認定」を埋める。
//   しかし生活アセスメントは **実施日が 88 日に分散**しているため、
//   最新の認定を採ると **実施日と乖離した別の認定**に紐付く。
//
//   実測: 対象 113 件のうち **30 件 (27%)** で
//         「最新の認定」と「実施日に有効な認定」の結果が食い違った。
//         要介護度まで違う例がある:
//           実施日 2026-04-28 → 最新=要介護5 (2026-05-01〜) / 正=要介護4 (2025-04-04〜)
//           実施日 2026-01-26 → 最新=要介護3 (2026-03-01〜) / 正=要介護2 (2025-02-10〜)
//
//   正しい規則は fix_care_plan_cert_link.mjs と同じ「その日に有効な認定」。
//   それを実装したのが **migrations/fix_assessment_cert_link.mjs**。
//
//   ⚠ ファイル名が素直なので「これを実行すればいい」と誤解されやすい。
//     経緯を残すために削除せず、実行だけを止めてある。
//
// (以下は当初の説明。参考のため残す)
// 既存 kaigo_assessments で certification_id = NULL の行に、
// その user の最新 client_insurance_records.id を埋める。
//
// 経緯: 旧 enrich_houmonkaigo_sample_data.mjs が certification_id を未設定で投入していて、
//       UI の /assessments page が cert filter で除外してしまっていた。

console.error(
  [
    "",
    "⛔ この script は使用禁止です (実行を中止しました)。",
    "",
    "   理由: 「その user の最新の認定」を埋める方式のため、実施日が分散している",
    "         生活アセスメントでは実施日と乖離した認定に紐付きます。",
    "         実測で 113 件中 30 件 (27%) が誤りでした。",
    "",
    "   代わりに次を使ってください:",
    "     node migrations/fix_assessment_cert_link.mjs            # DRY RUN",
    "     node migrations/fix_assessment_cert_link.mjs --execute",
    "",
  ].join("\n"),
);
process.exit(1);

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter(l => l && !l.startsWith("#") && l.includes("=")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const EXECUTE = process.argv.includes("--execute");
console.log(`[mode] ${EXECUTE ? "EXECUTE" : "DRY-RUN"}\n`);

// certification_id = NULL の assessments を全件取得 (page-loop)
const PAGE = 1000;
const targets = [];
let from = 0;
while (true) {
  const { data, error } = await sb.from("kaigo_assessments")
    .select("id, user_id")
    .is("certification_id", null)
    .range(from, from + PAGE - 1);
  if (error) { console.error("fetch:", error.message); process.exit(1); }
  if (!data || data.length === 0) break;
  targets.push(...data);
  if (data.length < PAGE) break;
  from += PAGE;
}
console.log(`[1] certification_id = NULL の assess: ${targets.length} 件`);

// user 別にグルーピング
const byUser = new Map();
for (const t of targets) {
  if (!byUser.has(t.user_id)) byUser.set(t.user_id, []);
  byUser.get(t.user_id).push(t.id);
}
console.log(`[2] 対象 user: ${byUser.size} 名`);

// 各 user の最新 cert を取得 + UPDATE
let updated = 0;
let skipped = 0;
for (const [userId, assessIds] of byUser) {
  const { data: certs } = await sb.from("client_insurance_records")
    .select("id, certification_start_date")
    .eq("client_id", userId)
    .order("certification_start_date", { ascending: false, nullsFirst: false })
    .limit(1);
  const certId = certs?.[0]?.id;
  if (!certId) {
    skipped += assessIds.length;
    console.log(`  skip: user ${userId.slice(0, 8)}.. (cert なし、${assessIds.length} 件)`);
    continue;
  }
  if (EXECUTE) {
    const { error } = await sb.from("kaigo_assessments")
      .update({ certification_id: certId })
      .in("id", assessIds);
    if (error) { console.error(`  ${userId.slice(0,8)} UPDATE:`, error.message); continue; }
  }
  updated += assessIds.length;
}

console.log(`\n[3] 結果: ${updated} 件 ${EXECUTE ? "UPDATE 完了" : "(dry-run 想定)"}、skip ${skipped} 件`);
if (!EXECUTE) console.log("\n--execute で本番。");
