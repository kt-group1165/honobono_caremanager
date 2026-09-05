// ============================================================================
// kaigo_assessments.certification_id を埋める (画面でアセスメントが1件も出ない不具合の是正)
//
//   node migrations/fix_assessment_certification_id.mjs            # DRY RUN (既定)
//   node migrations/fix_assessment_certification_id.mjs --execute  # 本番 UPDATE
//
// ── なぜ要るか (2026-09-05 user報告・最優先) ─────────────────────────────
//   kaigo_assessments (assessment_type='kaigo', status='completed') 113件が
//   ★全件 certification_id=null。画面 (assessments-content.tsx:161-162) は
//     .eq("user_id",…).eq("assessment_type","kaigo")
//     if (selectedCertId) query = query.eq("certification_id", selectedCertId)
//   なので、認定期間タブが選ばれている限り1件も表示されない。
//   SESSION_START が警告している型 (cert-linked帳票はcertification_idを必ず
//   入れる。入っていないと画面から見えず、開くたびに空の帳票が自動生成される)
//   そのもの。
//
// ── 何を根拠に埋めるか ──────────────────────────────────────────────────
//   assessment_date が client_insurance_records の認定期間
//   (certification_start_date <= assessment_date <= certification_end_date)
//   に収まるものを一意に決める。★一意に決まったものだけ埋める。
//
// ── 実測 (2026-09-05、113件中) ───────────────────────────────────────────
//   一意に決まる 102件 → ★このscriptで埋める
//   複数該当     9件  → ★触らない。全件が「同一(保険者,被保番,期間)の完全重複行」
//                        が3件ずつ存在するケースだった (期間の重なりではなく
//                        認定データそのものの重複INSERT)。どれを採用しても
//                        内容は同じだが、重複行の整理が先に必要なため保留。
//   該当なし     1件  → ★触らない。認定はあるがassessment_dateが期間外
//   認定が無い   1件  → ★触らない。client_insurance_records自体が0件
//   計11件は一覧で出力する (下記 UNRESOLVED)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL("../.env.local", import.meta.url)), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

console.log(`=== kaigo_assessments.certification_id バックフィル ${EXECUTE ? "【本番 EXECUTE】" : "【DRY RUN】"} ===\n`);

const { data: targets, error: e1 } = await sb
  .from("kaigo_assessments")
  .select("id, user_id, assessment_date")
  .eq("assessment_type", "kaigo")
  .eq("status", "completed")
  .is("certification_id", null);
if (e1) throw new Error(`対象取得失敗: ${e1.message}`);
console.log(`対象 (certification_id=null): ${targets.length}件\n`);

let filled = 0;
const unresolved = { none: [], multi: [], noCert: [] };

for (const t of targets) {
  const { data: certs, error: e2 } = await sb
    .from("client_insurance_records")
    .select("id, certification_start_date, certification_end_date")
    .eq("client_id", t.user_id);
  if (e2) throw new Error(`認定取得失敗 (${t.id}): ${e2.message}`);

  if (certs.length === 0) {
    unresolved.noCert.push(t);
    continue;
  }
  const matching = certs.filter(
    (c) => c.certification_start_date <= t.assessment_date && c.certification_end_date >= t.assessment_date,
  );
  if (matching.length === 0) {
    unresolved.none.push({ ...t, certs });
    continue;
  }
  if (matching.length > 1) {
    unresolved.multi.push({ ...t, matching });
    continue;
  }

  const certId = matching[0].id;
  console.log(`  assessment ${t.id.slice(0, 8)}… (user ${t.user_id.slice(0, 8)}…, date ${t.assessment_date}) → certification_id=${certId.slice(0, 8)}… (期間 ${matching[0].certification_start_date}〜${matching[0].certification_end_date})`);
  if (EXECUTE) {
    const { error: e3 } = await sb.from("kaigo_assessments").update({ certification_id: certId }).eq("id", t.id);
    if (e3) {
      console.error(`    ✗ UPDATE失敗: ${e3.message}`);
      continue;
    }
  }
  filled++;
}

console.log(`\n${EXECUTE ? "本番反映しました" : "DRY RUN"}: ${filled}件 ${EXECUTE ? "更新" : "更新予定"}`);

console.log(`\n=== 触らずに残す ${unresolved.multi.length + unresolved.none.length + unresolved.noCert.length}件 ===`);
console.log(`\n[複数該当 ${unresolved.multi.length}件]`);
for (const u of unresolved.multi) {
  console.log(`  ${u.id.slice(0, 8)}… user=${u.user_id.slice(0, 8)}… date=${u.assessment_date} 候補=${u.matching.length}件`);
  for (const m of u.matching) console.log(`     - ${m.id.slice(0, 8)}… ${m.certification_start_date}〜${m.certification_end_date}`);
}
console.log(`\n[該当なし(認定はあるが期間外) ${unresolved.none.length}件]`);
for (const u of unresolved.none) {
  console.log(`  ${u.id.slice(0, 8)}… user=${u.user_id.slice(0, 8)}… date=${u.assessment_date} (認定${u.certs.length}件あるが期間に収まらない)`);
}
console.log(`\n[認定が無い ${unresolved.noCert.length}件]`);
for (const u of unresolved.noCert) {
  console.log(`  ${u.id.slice(0, 8)}… user=${u.user_id.slice(0, 8)}… date=${u.assessment_date} (client_insurance_records 0件)`);
}
