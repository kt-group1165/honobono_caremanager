/**
 * 第7表 → 訪問介護の計画単位数 (planUnitsFromBeppyo) の境界と負のコントロール (2026-11-13 H 依頼・DB 不使用)
 *
 *   npm run check:beppyo-plan-units
 *
 * 守ること (src/lib/beppyo-plan-units.ts):
 *   ・自事業所の行だけ足す (番号 or 名前) / 他事業所の行は足さない
 *   ・同じ人に 自事業所の行を持つ第7表が 2 件 → 書かない (multi)。★ 旧実装は「最新の 1 件」を黙って採用していた
 *   ・第7表で 限度額対象の単位の合計 > 限度額 → 書かない (overLimit)。★ 旧実装は within_limit_units (超過を読まず = サービス単位) をそのまま入れていた
 *   ・限度額ちょうど / 限度額が空欄 → 書く
 * 負のコントロール: 旧実装 (最新 1 件 + 限度を見ない) を同じ境界に通すと ★ 落ちること
 */
import { planUnitsFromBeppyo, type BeppyoDoc, type BeppyoPlanResult } from "@/lib/beppyo-plan-units";

const OFFICE = { number: "1270000001", name: "自事業所ヘルパー" };
const it = (provider: string, units: number, content = "身体介護１") => ({
  provider_number: provider === "own" ? OFFICE.number : "1279999999",
  provider_name: provider === "own" ? OFFICE.name : "他事業所",
  service_content: content, service_units: units, within_limit_units: units,
});
const doc = (user: string, items: ReturnType<typeof it>[], limit: number | string = 16765, name = user): BeppyoDoc => ({ user_id: user, content: { items, limit_amount: limit, user_name: name } });

type Case = { label: string; docs: BeppyoDoc[]; want: { units?: [string, number][]; multi?: string[]; overLimit?: string[] } };
const cases: Case[] = [
  { label: "自事業所の行だけ足す (他事業所の行は足さない)", docs: [doc("A", [it("own", 3000), it("own", 1200), it("other", 5000)])], want: { units: [["A", 4200]] } },
  { label: "自事業所の行が無い人は対象外", docs: [doc("B", [it("other", 5000)])], want: { units: [] } },
  { label: "★ 同じ人に 2 件 (転居月の 2 保険者) → 書かない", docs: [doc("C", [it("own", 3000)]), doc("C", [it("own", 2000)])], want: { units: [], multi: ["C"] } },
  { label: "★ 限度額を超えた人 → 書かない (処遇改善は限度額の対象外なので数えない)", docs: [doc("D", [it("own", 15000), it("other", 2000), it("own", 1500, "訪問介護処遇改善加算Ⅰ１")], 16765)], want: { units: [], overLimit: ["D"] } },
  { label: "限度額ちょうど → 書く", docs: [doc("E", [it("own", 10000), it("other", 6765)], 16765)], want: { units: [["E", 10000]] } },
  { label: "限度額が空欄 → 書く (判定できないので従来どおり)", docs: [doc("F", [it("own", 99999)], "")], want: { units: [["F", 99999]] } },
];

function check(fn: (docs: BeppyoDoc[]) => BeppyoPlanResult): string[] {
  const bad: string[] = [];
  for (const c of cases) {
    const r = fn(c.docs);
    const units = JSON.stringify([...r.units].sort());
    const wantUnits = JSON.stringify([...(c.want.units ?? [])].sort());
    const multi = JSON.stringify(r.multi.map((x) => x.userId).sort()), wantMulti = JSON.stringify([...(c.want.multi ?? [])].sort());
    const over = JSON.stringify(r.overLimit.map((x) => x.userId).sort()), wantOver = JSON.stringify([...(c.want.overLimit ?? [])].sort());
    if (units !== wantUnits || multi !== wantMulti || over !== wantOver) bad.push(`${c.label}: 書く ${units} (期待 ${wantUnits}) / 2 件 ${multi} (期待 ${wantMulti}) / 限度超過 ${over} (期待 ${wantOver})`);
  }
  return bad;
}

const bad = check((docs) => planUnitsFromBeppyo(docs, OFFICE));
for (const b of bad) console.error(`✗ ${b}`);
if (bad.length) { console.error("✗ FAIL: 第7表 → 計画単位数 の境界が崩れている"); process.exit(1); }

// 負のコントロール: 直す前の実装 (monthly-info-content.tsx の旧コード: 人ごとに最初に見つかった 1 件・限度を見ない)
const legacy = (docs: BeppyoDoc[]): BeppyoPlanResult => {
  const units = new Map<string, number>();
  for (const d of docs) {
    if (units.has(d.user_id)) continue;
    const own = (d.content?.items ?? []).filter((x) => x.provider_number === OFFICE.number || x.provider_name === OFFICE.name);
    if (!own.length) continue;
    units.set(d.user_id, own.reduce((s, x) => s + (Number(x.within_limit_units) || 0), 0));
  }
  return { units, multi: [], overLimit: [] };
};
const negBad = check(legacy);
if (negBad.length < 2) { console.error(`✗ FAIL: 負のコントロールが鳴らない (旧実装で落ちた境界 ${negBad.length} 件)`); process.exit(1); }
console.log(`第7表 → 計画単位数 planUnitsFromBeppyo: 境界 ${cases.length} 件 OK / 負のコントロール 旧実装 (最新 1 件・限度を見ない) → ${negBad.length} 件 落ちる ✓`);
for (const b of negBad) console.log(`    (旧実装) ${b}`);
console.log("★ この検査が見ていないもの: 画面が第7表を全件読むか (ページ読みは monthly-info-content.tsx) / 限度超過の人の正しい計画単位数 (第7表画面で人が割り振る)");
