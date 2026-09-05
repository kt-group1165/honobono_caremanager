/**
 * 居宅介護支援 — billing/forms (明細書印刷画面) の加算サービスコード誤りの修正
 * (2026-09-05) の検証。claims-shared.ts に一本化したコード定数を、
 * ① マスタの単位数フィンガープリントと突合 ② 実データの claim 行に当てはめて確認
 * ③ 旧(誤)実装との負のコントロール。READ ONLY。
 *
 * 背景: billing/forms/billing-forms-content.tsx の meisaiDetail が独自にハードコード
 * していた加算コードが billing/seikyu/_seikyu-context.tsx (buildClaimLines、正しい実装)
 * と全く別の値で、8種類中8種類とも用途が食い違っていた
 * (初回加算=434000→実際は特定事業所集中減算、特定事業所加算=436132→実際は退院退所加算Ⅰ１、等)。
 * 実伝送(KK/8124)の単位数フィンガープリントで正しいコードを確認し、claims-shared.ts に
 * 一本化した。単位数・金額計算自体は別経路 (DB確定値) のため印刷コード表示のみの不具合。
 *
 *   npx tsx scripts/kyotaku-addon-code-fix-verify.mts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  TOKUTEI_KASSAN_CODES,
  DISCHARGE_TYPE_CODES,
  SHOKAI_ADDITION_CODE,
  MEDICAL_COORDINATION_CODE,
  TERMINAL_CARE_CODE,
  HOSPITAL_COORDINATION_CODE_I,
} from "../src/app/(authenticated)/billing/claims/claims-shared";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let n = 0, ng = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  n++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(70)} ${ok ? "" : `実際=${JSON.stringify(actual)} 期待=${JSON.stringify(expected)}`}`);
}

console.log("═══ ① マスタの単位数フィンガープリントと突合 ═══");
const codes = [
  SHOKAI_ADDITION_CODE, MEDICAL_COORDINATION_CODE, TERMINAL_CARE_CODE, HOSPITAL_COORDINATION_CODE_I,
  ...Object.values(TOKUTEI_KASSAN_CODES), ...Object.values(DISCHARGE_TYPE_CODES),
];
const { data: master, error: mErr } = await sb.from("kaigo_service_codes").select("service_code,service_name,units").in("service_code", [...new Set(codes)]).eq("system", "介護").gte("valid_from", "2026-01-01");
if (mErr) throw mErr;
const masterByCode = new Map((master ?? []).map((m) => [m.service_code, m]));
eq("434001(初回加算) の名称に「初回加算」を含む", masterByCode.get(SHOKAI_ADDITION_CODE)?.service_name.includes("初回加算"), true);
eq("436135(通院時情報連携) の名称に「通院時情報連携」を含む", masterByCode.get(MEDICAL_COORDINATION_CODE)?.service_name.includes("通院時情報連携"), true);
eq("436100(ターミナル) の名称に「ターミナル」を含む", masterByCode.get(TERMINAL_CARE_CODE)?.service_name.includes("ターミナル"), true);
eq("436125(入院時情報連携Ⅰ) の単位数=250", masterByCode.get(HOSPITAL_COORDINATION_CODE_I)?.units, 250);
eq("TOKUTEI_KASSAN_CODES[Ⅱ]=434003 の単位数=421", masterByCode.get(TOKUTEI_KASSAN_CODES["Ⅱ"])?.units, 421);
eq("DISCHARGE_TYPE_CODES[i_i]=436132 の単位数=450", masterByCode.get(DISCHARGE_TYPE_CODES["i_i"])?.units, 450);

console.log("\n═══ ② 実データの claim 行に当てはめる ═══");
const real = await sb.from("kaigo_care_support_claims").select("id,tokutei_kassan_type,tokutei_kassan_units").eq("tokutei_kassan_type", "Ⅱ").gt("tokutei_kassan_units", 0).limit(1);
if (real.error) throw real.error;
if (real.data && real.data.length > 0) {
  const r = real.data[0];
  const code = TOKUTEI_KASSAN_CODES[r.tokutei_kassan_type ?? ""] ?? "";
  eq(`実claim(特定事業所加算Ⅱ・${r.tokutei_kassan_units}単位) → コード434003`, code, "434003");
  eq(`  かつマスタの434003単位数(${masterByCode.get("434003")?.units}) = claimの単位数(${r.tokutei_kassan_units})`, masterByCode.get("434003")?.units, r.tokutei_kassan_units);
} else {
  console.log("  ⚠ 実データに特定事業所加算Ⅱのclaimが見つからない");
}

console.log("\n═══ 負のコントロール (修正前の実装との差分確認) ═══");
{
  // billing-forms-content.tsx の修正前ハードコード (誤り)
  const OLD_CODE_TOKUTEI: string = "436132"; // 実際は退院退所加算Ⅰ１
  const OLD_CODE_SHOKAI: string = "434000"; // 実際は特定事業所集中減算
  const OLD_CODE_HOSPITAL: string = "434001"; // 実際は初回加算
  n++;
  if (TOKUTEI_KASSAN_CODES["Ⅱ"] !== OLD_CODE_TOKUTEI) {
    console.log(`  OK  負のコントロール① — 特定事業所加算Ⅱ: 現行(${TOKUTEI_KASSAN_CODES["Ⅱ"]})と旧実装(${OLD_CODE_TOKUTEI})が別の値`);
  } else { ng++; console.log("  NG  負のコントロール①失敗"); }
  n++;
  if (SHOKAI_ADDITION_CODE !== OLD_CODE_SHOKAI) {
    console.log(`  OK  負のコントロール② — 初回加算: 現行(${SHOKAI_ADDITION_CODE})と旧実装(${OLD_CODE_SHOKAI})が別の値`);
  } else { ng++; console.log("  NG  負のコントロール②失敗"); }
  n++;
  if (HOSPITAL_COORDINATION_CODE_I !== OLD_CODE_HOSPITAL) {
    console.log(`  OK  負のコントロール③ — 入院時情報連携加算Ⅰ: 現行(${HOSPITAL_COORDINATION_CODE_I})と旧実装(${OLD_CODE_HOSPITAL})が別の値`);
  } else { ng++; console.log("  NG  負のコントロール③失敗"); }
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
if (ng > 0) process.exitCode = 1;
