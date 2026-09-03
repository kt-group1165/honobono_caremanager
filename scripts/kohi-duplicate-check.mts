/**
 * 公費の重複登録が請求・伝送に影響しているかを実データで測る (READ ONLY)
 *
 *   MONTH=2026-06 npx tsx scripts/kohi-duplicate-check.mts
 *
 * ⚠ **client_kohi_records に完全重複が大量にある** (2026-09-03 実測 102 組 / 余分 104 行)。
 *   利用者 + 法別 + 負担者番号 + 受給者番号 が同一なのに 2 行あり、
 *   片方は期間指定あり (取込由来) / 片方は期間 null (別の取込由来) という形。
 *
 * 重複が請求に効くのは、集計が「対象月に有効な公費」を **全件・優先順で** 引き、
 * 上位 2 件を 公費1 / 公費2 としてカスケードするため。
 * 重複していると **同じ制度が 公費1 と 公費2 の両方に入る**。
 *
 *   → 伝送 (7131) は `kohi2Amount > 0` のときだけ公費2欄を出すので、
 *     生保 (10割) のように公費1で全部吸われる制度なら **公費2 は 0 円 = 出力されない**。
 *     本当に影響が無いのかを **実データで確かめる**のがこの script。
 *
 * 出すもの:
 *   ① 重複の分母 (全社 / 対象月に有効なものだけ)
 *   ② ★ 本番の集計を回して 公費2 が立つ利用者が何名いるか
 *   ③ ★ そのうち 公費1 と 負担者番号・受給者番号が同一 (= 重複由来) は何名か
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateMonthlyVisitSeikyu } from "@/lib/visit-seikyu/aggregate";

const MONTH = process.env.MONTH ?? "2026-06";
const [Y, M] = MONTH.split("-").map(Number);

const env: Record<string, string> = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function all<T>(table: string, cols: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(order).range(f, f + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

type KohiRow = {
  client_id: string; kohi_hobetsu: string | null;
  futansha_number: string | null; jukyusha_number: string | null;
  start_date: string | null; end_date: string | null;
  priority: number | null; honnin_futan: number | null;
};

// ── ① 重複の分母 ───────────────────────────────────────────────────────
const rows = await all<KohiRow>("client_kohi_records", "*", "id");
const monthStart = `${MONTH}-01`;
const monthEnd = `${MONTH}-${String(new Date(Y, M, 0).getDate()).padStart(2, "0")}`;
const validInMonth = (r: KohiRow) =>
  (r.kohi_hobetsu ?? "").trim() !== "" &&
  (r.start_date == null || r.start_date <= monthEnd) &&
  (r.end_date == null || r.end_date >= monthStart);

const dupKey = (r: KohiRow) =>
  [r.client_id, r.kohi_hobetsu, r.futansha_number ?? "", r.jukyusha_number ?? ""].join("|");
const groupBy = (list: KohiRow[]) => {
  const g = new Map<string, KohiRow[]>();
  for (const r of list) { const k = dupKey(r); g.set(k, [...(g.get(k) ?? []), r]); }
  return g;
};
const allDup = [...groupBy(rows).values()].filter((v) => v.length > 1);
const monthRows = rows.filter(validInMonth);
const monthDup = [...groupBy(monthRows).values()].filter((v) => v.length > 1);

console.log(`══ ① 重複の分母 (${MONTH}) ══`);
console.log(`  client_kohi_records 全 ${rows.length} 行 / ${new Set(rows.map((r) => r.client_id)).size} 名`);
console.log(`  ★ 完全重複 (利用者+法別+負担者+受給者)  全社 ${allDup.length} 組 / 余分 ${allDup.reduce((s, v) => s + v.length - 1, 0)} 行`);
console.log(`  ★ うち ${MONTH} に両方とも有効        ${monthDup.length} 組 / ${new Set(monthDup.map((v) => v[0].client_id)).size} 名`);
const perClient = new Map<string, number>();
for (const r of monthRows) perClient.set(r.client_id, (perClient.get(r.client_id) ?? 0) + 1);
const dist: Record<number, number> = {};
for (const v of perClient.values()) dist[v] = (dist[v] ?? 0) + 1;
console.log(`  ${MONTH} に有効な公費の件数分布 ${JSON.stringify(dist)}  (2 件以上 = 公費2 が立つ候補)`);

// ── ②③ 本番の集計を回す ───────────────────────────────────────────────
const offices = await all<{ id: string; name: string; unit_price: number | null; applied_formula_codes: string[] | null; tenant_id: string | null }>(
  "offices", "id, name, unit_price, applied_formula_codes, tenant_id", "id");

console.log(`\n══ ②③ 本番の集計 (aggregateMonthlyVisitSeikyu) を全事業所で回す ══`);
let nRows = 0, nKohi1 = 0, nKohi2 = 0;
const kohi2Same: string[] = [];
const kohi2Diff: string[] = [];
for (const o of offices) {
  let res;
  try {
    res = await aggregateMonthlyVisitSeikyu(sb, {
      officeId: o.id, tenantId: o.tenant_id ?? "kt-group", year: Y, month: M,
      unitPrice: Number(o.unit_price ?? 10), appliedFormulaCodes: o.applied_formula_codes ?? [],
    });
  } catch (e) {
    console.log(`  ⚠ ${o.name}: 集計に失敗 — ${(e as Error).message}`);
    continue;
  }
  for (const r of res.rows) {
    nRows++;
    if (r.kohiHobetsu) nKohi1++;
    if (!r.kohi2Hobetsu) continue;
    nKohi2++;
    const same = r.kohiFutanshaNumber === r.kohi2FutanshaNumber
      && r.kohiJukyushaNumber === r.kohi2JukyushaNumber;
    const label = `${r.user_name} (${o.name}) 公費1 法別${r.kohiHobetsu} ¥${r.kohiAmount ?? 0} / 公費2 法別${r.kohi2Hobetsu} ¥${r.kohi2Amount ?? 0}`;
    (same ? kohi2Same : kohi2Diff).push(label);
  }
}
console.log(`  【分母】レセプト ${nRows} 件 / 公費1 あり ${nKohi1} 件`);
console.log(`  ★ 公費2 が立った                     ${nKohi2} 件`);
console.log(`    ├ 負担者・受給者が公費1と同一 (重複由来) ${kohi2Same.length} 件`);
console.log(`    └ 別制度 (本来の併用)                  ${kohi2Diff.length} 件`);
for (const l of kohi2Same.slice(0, 15)) console.log(`       [重複] ${l}`);
for (const l of kohi2Diff.slice(0, 15)) console.log(`       [併用] ${l}`);

// ── 伝送に載るか (公費2欄は kohi2Amount > 0 のときだけ出る) ──────────────
const emitted = kohi2Same.filter((l) => !/公費2 法別\d+ ¥0$/.test(l)).length;
console.log(`\n══ 伝送 (7131) に公費2欄が出るか ══`);
console.log(`  build.ts は kohi2Amount > 0 のときだけ 公費2 欄 (項 9/10/31/45-50) を出す`);
console.log(`  ★ 重複由来で 公費2 請求額 > 0 = **同じ負担者番号が 2 欄に出て返戻の元** : ${emitted} 件`);
if (emitted === 0) {
  console.log(`  ✅ 0 件 — 重複は **伝送には出ていない**。ただしデータとしては誤りなので消すこと。`);
  console.log(`     ⚠ 生保 (10割) は公費1 で全額吸うので公費2 が 0 円になるだけ。`);
  console.log(`       **部分公費 (21/54/19 等) が重複したら 0 円にならず出る。**今は法別 12/81 しか無いのが理由。`);
}
