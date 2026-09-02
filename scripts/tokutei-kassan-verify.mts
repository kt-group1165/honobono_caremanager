/**
 * 居宅介護支援 特定事業所加算 (436132) の検証
 *
 * ⚠ DB には書き込まない。§A は純関数/定数、§B は本番 DB の READ ONLY 参照。
 * ⚠ この加算は **居宅介護支援** の加算なので、分母は「居宅の事業所」で取る。
 *   訪問介護の 19 事業所で数えると母数が違う (1-4)。
 *
 * 告示値 (令和6年度・1月につき):
 *   Ⅰ 519 / Ⅱ 421 / Ⅲ 323 / A 114 / なし 0
 *   旧区分 B → 新Ⅱ (421) / 旧 C → 新Ⅲ (323) と同額。
 *   ⚠ 旧 A (505単位) と 新 A (114単位) は同じ文字で額が違う。実装は **新A** として扱う。
 *
 * 使い方: npx tsx scripts/tokutei-kassan-verify.mts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOKUTEI_KASSAN_FALLBACK } from "../src/app/(authenticated)/billing/claims/claims-shared";

let pass = 0, fail = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         期待: ${e}\n         実際: ${a}`); }
};

console.log("\n=== §A-1 区分ごとの単位数が告示値と一致するか ===");
// 令和6年度 居宅介護支援 特定事業所加算 (1月につき)
const KOKUJI: Record<string, number> = { none: 0, "Ⅰ": 519, "Ⅱ": 421, "Ⅲ": 323, A: 114 };
for (const [k, v] of Object.entries(KOKUJI)) {
  check(`${k} = ${v} 単位`, TOKUTEI_KASSAN_FALLBACK[k], v);
}

console.log("\n=== §A-2 旧区分は新区分と同額 (移行しても金額が動かない) ===");
check("旧B = 新Ⅱ (421)", TOKUTEI_KASSAN_FALLBACK.B, TOKUTEI_KASSAN_FALLBACK["Ⅱ"]);
check("旧C = 新Ⅲ (323)", TOKUTEI_KASSAN_FALLBACK.C, TOKUTEI_KASSAN_FALLBACK["Ⅲ"]);
// ⚠ 旧A(505) と 新A(114) は額が違う。実装は新A。旧Aの事業所が残っていると過小になる
check("A は新区分の 114 (旧A の 505 ではない)", TOKUTEI_KASSAN_FALLBACK.A, 114);

console.log("\n=== §A-3 区分の大小関係 (Ⅰ > Ⅱ > Ⅲ > A > なし) ===");
const T = TOKUTEI_KASSAN_FALLBACK;
check("Ⅰ > Ⅱ", T["Ⅰ"] > T["Ⅱ"], true);
check("Ⅱ > Ⅲ", T["Ⅱ"] > T["Ⅲ"], true);
check("Ⅲ > A", T["Ⅲ"] > T.A, true);
check("A > なし", T.A > T.none, true);

console.log("\n=== §B 本番データ (READ ONLY) ===");
const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL("../.env.local", import.meta.url)), "utf8")
    .split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean)
    .map((m) => [m![1], m![2].replace(/^["']|["']$/g, "")]),
);
type Row = Record<string, unknown>;
const rest = async (p: string) => {
  const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`REST 失敗 (${p.slice(0, 70)}): ${JSON.stringify(j).slice(0, 200)}`);
  return j as Row[];
};
const page = async (p: string) => {
  const out: Row[] = [];
  for (let off = 0; ; off += 1000) { const j = await rest(`${p}&order=id&offset=${off}&limit=1000`); out.push(...j); if (j.length < 1000) break; }
  return out;
};
const MONTH = process.env.MONTH ?? "2026-06";

// ① 旧区分 (A/B/C) の移行漏れ
const offices = await rest("offices?select=id,name,service_type,tokutei_kassan_type&limit=200");
const kyotaku = offices.filter((o) => o.service_type === "居宅介護支援");
console.log(`  居宅介護支援の事業所: ${kyotaku.length} 件 (分母)`);
const dist: Record<string, number> = {};
for (const o of kyotaku) {
  const k = o.tokutei_kassan_type === null ? "(null)" : String(o.tokutei_kassan_type);
  dist[k] = (dist[k] ?? 0) + 1;
}
console.log(`  tokutei_kassan_type: ${Object.entries(dist).map(([k, v]) => `${k} ${v}`).join(" / ")}`);
const legacy = kyotaku.filter((o) => ["B", "C"].includes(String(o.tokutei_kassan_type ?? "")));
check("旧区分 B/C が残っていない (2026-07-02 移行済)", legacy.length, 0);
const ambiguousA = kyotaku.filter((o) => String(o.tokutei_kassan_type ?? "") === "A");
if (ambiguousA.length) {
  console.log(`  ⚠ 区分 "A" の事業所 ${ambiguousA.length} 件 — 旧A(505) か 新A(114) か文字では判別できない`);
  for (const o of ambiguousA) console.log(`      ${o.name}`);
}

// ③ レセプトの単位数が区分と整合しているか
const claims = await page(`kaigo_care_support_claims?select=id,tokutei_kassan_type,tokutei_kassan_units&billing_month=eq.${MONTH}`);
console.log(`  ${MONTH} のレセプト: ${claims.length} 件 (分母)`);
if (claims.length === 0) {
  console.log("  ⚠ レセプトが 0 件のため §B の単位数チェックは判定しません");
} else {
  const combos: Record<string, number> = {};
  const mismatched: string[] = [];
  for (const c of claims) {
    const t = c.tokutei_kassan_type === null ? "(null)" : String(c.tokutei_kassan_type);
    const u = Number(c.tokutei_kassan_units ?? 0);
    combos[`${t} → ${u}`] = (combos[`${t} → ${u}`] ?? 0) + 1;
    // null / なし は 0、それ以外は表の値と一致すべき
    const expect = c.tokutei_kassan_type == null ? 0 : TOKUTEI_KASSAN_FALLBACK[String(c.tokutei_kassan_type)];
    if (expect !== undefined && u !== expect) mismatched.push(`${t}/${u}`);
  }
  console.log(`  区分 → 単位数: ${Object.entries(combos).map(([k, v]) => `${k} (${v}件)`).join(" / ")}`);
  check("レセプトの加算単位数が区分の告示値と一致する", mismatched.length, 0);
  // ⑤ 未設定は 0 単位に倒れること (黙って何かが付かない)
  const nullRows = claims.filter((c) => c.tokutei_kassan_type == null);
  const nullNonZero = nullRows.filter((c) => Number(c.tokutei_kassan_units ?? 0) !== 0);
  console.log(`  区分が未設定のレセプト: ${nullRows.length} 件`);
  check("未設定のレセプトは加算 0 単位 (fail-safe)", nullNonZero.length, 0);
}

console.log(`\n=== 結果: PASS ${pass} / FAIL ${fail} ===`);
if (fail > 0) process.exit(1);
