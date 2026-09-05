/**
 * 訪問入浴介護 請求ロジックの網羅率を測る (READ ONLY・H割当)
 *
 *   MONTH=2026-12 npx tsx scripts/bath-coverage-check.mts
 *
 * fukuyogu-coverage-check.mts (order-app) と同じ考え方。実装
 * (src/lib/bath-seikyu/aggregate.ts) を読んで因子を列挙し、
 * aggregateBathVisitSeikyu() の実出力からペア網羅率を測る。
 *
 * ── 因子から外したもの (理由あり) ────────────────────────────────────────
 *   「号車」(kaigo_bath_schedule.team_id 相当)   scripts/_factors.mts に既に
 *     「集計がselectしていないので入れていない」と明記されている。実装未読取。
 *   scheme (介護保険 / 千葉市移動支援等)         集計は `.eq("scheme","介護保険")`
 *     で最初から絞っており、他schemeは意図的な除外 (2026-08-31監査で確定)。
 *     値が1種類しか通らない設計なので因子化しない。
 *   処遇改善 (appliedFormulaCodes)               DBの行ではなく呼出側のopts引数
 *     (offices.applied_formula_codesを渡す想定)。行ベースのペア網羅率には
 *     馴染まないため、別途 直接呼び出しで経路の生存だけ確認する (下記④)。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateBathVisitSeikyu } from "../src/lib/bath-seikyu/aggregate";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY が無い");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MONTH = process.env.MONTH ?? "2026-12";
const [y, m] = MONTH.split("-").map(Number);
const OFFICE_ID = "ec87a203-53e2-40a5-b706-7fea402cde16"; // ムツミ訪問入浴 (既存サンプルの事業所)

console.log(`══ 訪問入浴 請求ロジック 網羅率測定 (${MONTH}・READ ONLY) ══\n`);

const result = await aggregateBathVisitSeikyu(sb as never, { officeId: OFFICE_ID, tenantId: "kt-group", year: y, month: m });
console.log(`【分母】集計対象クライアント: ${result.rows.length} 名 / 訪問記録: ${result.recordCount} 件\n`);

interface Factor { name: string; why: string; values: readonly string[]; measure: (r: (typeof result.rows)[number]) => string[]; }
const isYobo = (careLevel: string | null) => careLevel === "要支援1" || careLevel === "要支援2" || careLevel === "事業対象者";

const FACTORS: Factor[] = [
  {
    name: "サービス区分",
    why: "details[].service_code — 全身浴/部分浴 × 看護職員あり/職員のみ (121111/112/121/122)",
    values: ["全身浴看護あり", "部分浴看護あり", "全身浴職員のみ", "部分浴職員のみ"],
    measure: (r) => r.details.filter((d) => /^121/.test(String(d.service_code ?? ""))).map((d): string | null => {
      const c = d.service_code;
      if (c === "121111") return "全身浴看護あり";
      if (c === "121112") return "部分浴看護あり";
      if (c === "121121") return "全身浴職員のみ";
      if (c === "121122") return "部分浴職員のみ";
      return null;
    }).filter((v): v is string => v !== null),
  },
  {
    name: "要介護度区分",
    why: "isYoboLevel(cert.care_level) — 介護給付(種類12)か予防給付相当かでコード体系が変わる (B-1w)",
    values: ["介護給付", "予防給付相当"],
    measure: (r) => [isYobo(r.care_level) ? "予防給付相当" : "介護給付"],
  },
  {
    name: "初回加算",
    why: "addon_shokai (CODE_SHOKAI=124113)",
    values: ["あり", "なし"],
    measure: (r) => [r.details.some((d) => d.service_code === "124113") ? "あり" : "なし"],
  },
  {
    name: "認知症専門ケア加算",
    why: "addon_ninchi — CODE_NINCHI.I=126133 / II=126134",
    values: ["なし", "Ⅰ", "Ⅱ"],
    measure: (r) => {
      const hasI = r.details.some((d) => d.service_code === "126133");
      const hasII = r.details.some((d) => d.service_code === "126134");
      const vals: string[] = [];
      if (hasI) vals.push("Ⅰ");
      if (hasII) vals.push("Ⅱ");
      if (vals.length === 0) vals.push("なし");
      return vals;
    },
  },
  {
    name: "中山間地域等提供加算",
    why: "addon_chuusankan (CODE_CHUUSANKAN=128110)",
    values: ["あり", "なし"],
    measure: (r) => [r.details.some((d) => d.service_code === "128110") ? "あり" : "なし"],
  },
  {
    name: "限度額",
    why: "overUnits (grossBaseUnits - limitUnits) — 内側/ちょうど/超過",
    values: ["内側", "ちょうど", "超過"],
    measure: (r) => [r.overUnits > 0 ? "超過" : (r.limitUnits != null && r.grossBaseUnits === r.limitUnits ? "ちょうど" : "内側")],
  },
  {
    name: "公費",
    why: "kohiHobetsu/kohiTandoku — なし/生保単独(全額振替)/部分公費(振替なし)",
    values: ["なし", "生保単独", "部分公費"],
    measure: (r) => [r.kohiHobetsu == null ? "なし" : (r.publicExpense != null ? "生保単独" : "部分公費")],
  },
];

const seenValue = FACTORS.map(() => new Set<string>());
const seenPair = new Set<string>();
for (const r of result.rows) {
  const vals = FACTORS.map((f) => f.measure(r));
  for (let i = 0; i < FACTORS.length; i++) for (const v of vals[i]) seenValue[i].add(v);
  for (let i = 0; i < FACTORS.length; i++) for (let j = i + 1; j < FACTORS.length; j++)
    for (const a of vals[i]) for (const b of vals[j]) seenPair.add(`${i}:${a}|${j}:${b}`);
}

let theoreticalPairs = 0;
for (let i = 0; i < FACTORS.length; i++) for (let j = i + 1; j < FACTORS.length; j++) theoreticalPairs += FACTORS[i].values.length * FACTORS[j].values.length;

console.log("── 因子ごとの値カバレッジ ──");
for (let i = 0; i < FACTORS.length; i++) {
  const f = FACTORS[i];
  const missing = f.values.filter((v) => !seenValue[i].has(v));
  console.log(`  ${f.name.padEnd(14)} ${seenValue[i].size}/${f.values.length}` + (missing.length ? `   *0件: ${missing.join(" / ")}` : ""));
}

const rate = (100 * seenPair.size) / theoreticalPairs;
console.log(`\n══ 結論 ══`);
console.log(`測定可能ペア ${seenPair.size} / 理論ペア ${theoreticalPairs} = ${rate.toFixed(1)}%`);
console.log(`(理論ペア = ${FACTORS.length}因子 ${FACTORS.map((f) => f.values.length).join("×")} の総組合せ数をC(${FACTORS.length},2)=${(FACTORS.length * (FACTORS.length - 1)) / 2}因子対ぶん積算)`);

console.log(`\n── 別枠 (行ベースのペア網羅率には含めない) ──`);
console.log(`  月内の要介護度変更 (detectMidMonthChange): warnings配列に"区分変更"の文言があるか実データで確認`);
const hasMidMonthWarn = result.warnings.some((w) => w.includes("区分変更"));
console.log(`    → ${hasMidMonthWarn ? "確認できた(1件以上)" : "0件"}`);
console.log(`  虐防/業未減算 (kaigo_office_gensan_periods, office+月単位のフラグ)`);
console.log(`    → 行ベースの因子ではなく事業所×月の状態。別途 seed_sample_bath_coverage_g.mjs G6 で`);
console.log(`      一時的に適用し、コードが合成コード(例:121131)へ差し替わることを確認済み(このscript実行時点では未適用)`);
console.log(`  処遇改善 (opts.appliedFormulaCodes)`);
console.log(`    → DBの行ではなく引数。offices.applied_formula_codesが全5事業所で空(B-1y)なので実データでは常に0円`);

console.log(`\n── 実装自体に既知の問題があるもの ──`);
console.log(`  warningsByClient は常に {} (2026-09-05実測)。per-client警告の絞り込みが使えず、flatなwarningsを見るしかない`);
