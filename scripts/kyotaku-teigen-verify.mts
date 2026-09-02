/**
 * 居宅介護支援費 逓減制 (令和6年度〜) の検証
 *
 * ⚠ DB には書き込まない。§A は純関数の境界値、§B は本番 DB の READ ONLY 参照。
 *
 * ── なぜ作ったか ────────────────────────────────────────────────────────
 *   SESSION_START.md に「**逓減制の業務判断が未了**」「設定と請求が食い違っている」
 *   と長く残っていた。2026-09-03 に実測したところ **食い違っていなかった**ので、
 *   同じ疑いが再燃しないよう検査として固定する。
 *
 *   誤解の元は 2 つ:
 *     ① `teigen_kanwa` が全事業所 false = 「未設定」ではない。
 *        これは **緩和要件 (体制Ⅱ)** の項目で、逓減判定に要る
 *        **常勤換算数 (caremane_jokin_kansan)** とは別。後者は 15/16 事業所で設定済み。
 *     ② 「担当45件の CM が3名いる」は逓減の判定基準ではない。
 *        逓減は **事業所の取扱件数 ÷ 介護支援専門員の常勤換算数** で見る
 *        (介護支援専門員 1 人あたりの取扱件数)。個々の CM の担当数ではない。
 *
 * 使い方: npx tsx scripts/kyotaku-teigen-verify.mts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  teigenTierForIndex,
  resolveTeigenBase,
  parseTeigenFromName,
  KYOTAKU_TEIGEN_FALLBACK,
} from "../src/app/(authenticated)/billing/claims/claims-shared";

let pass = 0, fail = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         期待: ${e}\n         実際: ${a}`); }
};

console.log("\n=== §A-1 体制Ⅰ (緩和なし) の段の境界: 〜44 / 45〜59 / 60〜 ===");
for (const [n, want] of [[1, "ⅰ"], [44, "ⅰ"], [45, "ⅱ"], [59, "ⅱ"], [60, "ⅲ"], [200, "ⅲ"]] as const) {
  check(`${n} 件目 (常勤換算1.0)`, teigenTierForIndex(n, 1, false), want);
}

console.log("\n=== §A-2 体制Ⅱ (ICT・事務職員配置) は 50 件から ===");
for (const [n, want] of [[44, "ⅰ"], [45, "ⅰ"], [49, "ⅰ"], [50, "ⅱ"], [59, "ⅱ"], [60, "ⅲ"]] as const) {
  check(`${n} 件目 (緩和あり・常勤換算1.0)`, teigenTierForIndex(n, 1, true), want);
}

console.log("\n=== §A-3 常勤換算で割る (1人あたりの件数で判定) ===");
check("90 件 / 常勤2.0 = 45 → ⅱ", teigenTierForIndex(90, 2, false), "ⅱ");
check("89 件 / 常勤2.0 = 44.5 → ⅰ", teigenTierForIndex(89, 2, false), "ⅰ");
check("120 件 / 常勤2.0 = 60 → ⅲ", teigenTierForIndex(120, 2, false), "ⅲ");
check("67 件 / 常勤1.5 = 44.67 → ⅰ", teigenTierForIndex(67, 1.5, false), "ⅰ");
check("68 件 / 常勤1.5 = 45.33 → ⅱ", teigenTierForIndex(68, 1.5, false), "ⅱ");
// 常勤換算が 0/未設定なら判定しない (呼出側で null になる想定の保険)
check("常勤換算 0 は ⅰ に倒す (過大請求側に倒さない)", teigenTierForIndex(999, 0, false), "ⅰ");

console.log("\n=== §A-4 要介護度から基本コードを引く ===");
const base = KYOTAKU_TEIGEN_FALLBACK;
check("Ⅰⅰ 要介護1 → 432111 / 1086", resolveTeigenBase(base, "Ⅰ", "ⅰ", "要介護1"), { units: 1086, code: "432111", name: "居宅介護支援Ⅰⅰ１" });
check("Ⅰⅰ 要介護3 → 432211 / 1411", resolveTeigenBase(base, "Ⅰ", "ⅰ", "要介護3"), { units: 1411, code: "432211", name: "居宅介護支援Ⅰⅰ２" });
check("Ⅰⅱ 要介護2 → 433111 / 544", resolveTeigenBase(base, "Ⅰ", "ⅱ", "要介護2"), { units: 544, code: "433111", name: "居宅介護支援Ⅰⅱ１" });
check("Ⅰⅲ 要介護5 → 434211 / 422", resolveTeigenBase(base, "Ⅰ", "ⅲ", "要介護5"), { units: 422, code: "434211", name: "居宅介護支援Ⅰⅲ２" });
check("Ⅱⅱ 要介護1 → 435311 / 527", resolveTeigenBase(base, "Ⅱ", "ⅱ", "要介護1"), { units: 527, code: "435311", name: "居宅介護支援Ⅱⅱ１" });
// 要支援・申請中は居宅介護支援費の対象外 (介護予防支援費で請求する)
check("要支援1 は null", resolveTeigenBase(base, "Ⅰ", "ⅰ", "要支援1"), null);
check("事業対象者 は null", resolveTeigenBase(base, "Ⅰ", "ⅰ", "事業対象者"), null);

console.log("\n=== §A-5 逓減が下げる単位数 (段が上がるほど下がること) ===");
for (const taisei of ["Ⅰ", "Ⅱ"] as const) {
  const i = base[taisei]["ⅰ"], ii = base[taisei]["ⅱ"], iii = base[taisei]["ⅲ"];
  check(`${taisei}: 軽 ⅰ>ⅱ>ⅲ`, i.light.units > ii.light.units && ii.light.units > iii.light.units, true);
  check(`${taisei}: 重 ⅰ>ⅱ>ⅲ`, i.heavy.units > ii.heavy.units && ii.heavy.units > iii.heavy.units, true);
  check(`${taisei}: 各段とも 軽 < 重`, i.light.units < i.heavy.units && ii.light.units < ii.heavy.units && iii.light.units < iii.heavy.units, true);
}
check("コード名から段を読み戻せる", parseTeigenFromName("居宅介護支援Ⅰⅱ１"), { taisei: "Ⅰ", tier: "ⅱ" });
check("加算名は段ではない", parseTeigenFromName("初回加算"), null);

console.log("\n=== §B 本番データ: 逓減に入る事業所があるか (READ ONLY) ===");
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
  for (let off = 0; ; off += 1000) {
    const j = await rest(`${p}&order=id&offset=${off}&limit=1000`);
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
};

const MONTH = process.env.MONTH ?? "2026-06";
const claims = await page(`kaigo_care_support_claims?select=user_id,care_support_code&billing_month=eq.${MONTH}`);
console.log(`  ${MONTH} の居宅レセプト: ${claims.length} 件 (分母)`);
if (claims.length === 0) {
  console.log("  ⚠ レセプトが 0 件のため §B は判定しません (未取込)");
} else {
  const offices = await rest("offices?select=id,name,caremane_jokin_kansan,service_type");
  const kyotaku = new Set(offices.filter((o) => o.service_type === "居宅介護支援").map((o) => String(o.id)));
  const fteSet = offices.filter((o) => kyotaku.has(String(o.id)) && Number(o.caremane_jokin_kansan) > 0).length;
  console.log(`  常勤換算数が設定済みの居宅事業所: ${fteSet} / ${kyotaku.size} (分母)`);

  const uids = [...new Set(claims.map((c) => String(c.user_id)))];
  const asg: Row[] = [];
  for (let i = 0; i < uids.length; i += 80) {
    asg.push(...await rest(
      `client_office_assignments?select=client_id,office_id,start_date,end_date&client_id=in.(${uids.slice(i, i + 80).join(",")})`,
    ));
  }
  const from = `${MONTH}-01`, to = `${MONTH}-31`;
  const byOffice = new Map<string, Set<string>>();
  for (const u of uids) {
    for (const a of asg) {
      if (String(a.client_id) !== u) continue;
      const oid = String(a.office_id);
      if (!kyotaku.has(oid)) continue;
      const st = String(a.start_date ?? ""), en = String(a.end_date ?? "");
      if ((st && st > to) || (en && en < from)) continue;
      if (!byOffice.has(oid)) byOffice.set(oid, new Set());
      byOffice.get(oid)!.add(u);
    }
  }
  // 予防 (要支援) は国保連を通らないのでレセプトに出ない。事業所の売上報告書
  // (kaigo_office_reported_revenue category='予防プラン' の件数) から補う。
  // 取扱件数 = 要介護 + 予防 × 1/3 (R6.4 の取扱い)。
  const yoboRows = await rest(
    `kaigo_office_reported_revenue?select=office_id,count&month=eq.${MONTH}&category=eq.${encodeURIComponent("予防プラン")}`,
  );
  const yoboByOffice = new Map<string, number>();
  for (const y of yoboRows) {
    const k = String(y.office_id);
    yoboByOffice.set(k, (yoboByOffice.get(k) ?? 0) + Number(y.count ?? 0));
  }
  const yoboTotal = [...yoboByOffice.values()].reduce((a, b) => a + b, 0);
  console.log(`  予防 (報告書の件数列): 全社 ${yoboTotal} 名 / ${yoboByOffice.size} 事業所`);
  if (yoboTotal === 0) {
    console.log("  ⚠ 予防が 0 名 — 報告書が未取込の可能性。要介護だけで判定します (過小評価に注意)");
  }

  let over = 0, judged = 0, maxPer = 0;
  console.log("  事業所ごとの (要介護 + 予防×1/3) ÷ 常勤換算:");
  const rows = [...byOffice.entries()].map(([oid, set]) => {
    const o = offices.find((x) => String(x.id) === oid);
    const fte = Number(o?.caremane_jokin_kansan ?? 0);
    const yobo = yoboByOffice.get(oid) ?? 0;
    const total = set.size + yobo / 3;
    return { name: String(o?.name ?? oid), n: set.size, yobo, total, fte, per: fte > 0 ? total / fte : null };
  }).sort((a, b) => (b.per ?? -1) - (a.per ?? -1));
  for (const r of rows) {
    if (r.per == null) { console.log(`    ${r.name}: ${r.n} 件 / 常勤換算 未設定 → 逓減判定なし`); continue; }
    judged++;
    maxPer = Math.max(maxPer, r.per);
    const tier = teigenTierForIndex(Math.ceil(r.per), 1, false);
    if (tier !== "ⅰ") over++;
    console.log(
      `    ${r.name}: 要介護${r.n} + 予防${r.yobo}/3 = ${r.total.toFixed(1)} / 常勤${r.fte} = ${r.per.toFixed(1)} 件/人 → ${tier}`,
    );
  }
  console.log(`  判定できた事業所: ${judged} (分母) / うち逓減 (ⅱ以上) に入る: ${over}`);
  console.log(`  最大 ${maxPer.toFixed(1)} 件/人 (45 未満なら全件 ⅰ が正しい)`);
  const codes = new Set(claims.map((c) => String(c.care_support_code ?? "")).filter(Boolean));
  const teigenCodes = [...codes].filter((c) => !/^4321/.test(c) && !/^4322/.test(c));
  console.log(`  レセプトの基本コード: ${[...codes].join(", ")}`);
  check(
    "逓減に入る事業所が無いので、レセプトに ⅱ/ⅲ のコードが出ていない",
    over === 0 ? teigenCodes.length : -1,
    0,
  );
}

console.log(`\n=== 結果: PASS ${pass} / FAIL ${fail} ===`);
if (fail > 0) process.exit(1);
