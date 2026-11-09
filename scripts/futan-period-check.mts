/**
 * check:futan-period (kaigo-app・訪問介護/総合事業) — 負担割合証の期間と、月ごとに採る割合の食い違い (★ READ ONLY・基準値方式)
 *
 *   npm run check:futan-period                     # 既定 MONTHS=2026-06,2026-07
 *   npm run check:futan-period -- --update         # 基準値を書く (中身を確認してから)
 *
 * 母数: その月に実績 (kaigo_visit_schedule status='completed') があり、制度が障害でない利用者。
 *       居宅介護支援は 10 割給付で負担割合を使わないので母数に入れない。
 * 認定行の割合: copay_rate (割) — kaigo の請求 (visit-seikyu/aggregate.ts) が従来使っていた値。
 *   ★ src/lib/cert-for-month.ts は「その月に負担割合証がある」ときだけ copay_rate を置き換える。
 *     ③ (食い違い) の人数 = 表を適用・取込すると請求の負担割合が変わる人数。
 * 数えるもの・基準値・負のコントロールは order-app/scripts/_futan-period-core.mts の冒頭を参照 (order-app と共用)。
 */
import { join } from "node:path";
import { runFutanPeriod, serviceClient, selectAll, loadCertRows, loadBenefitCertsDbOrCsv } from "../../order-app/scripts/_futan-period-core.mjs";
import { benefitRateFromCopay } from "../src/lib/insurance/cert-month";

const sb = await serviceClient([".env.local"]);
if (!sb) { console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ (exit 0・★ 合格ではない)"); process.exit(0); }
const MONTHS = (process.env.MONTHS ?? "2026-06,2026-07").split(",").map((s) => s.trim()).filter(Boolean);
const CSV_SETS = [
  { label: "全社 20260830", futan: "利用者データ/全社_R8-08/負担割合証等1.CSV", ins: ["利用者データ/全社_R8-08/介護保険1.CSV"] },
  { label: "ケアサポ 20261109", futan: join("伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109/負担割合証等_全件.CSV"), ins: [join("伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109/介護保険_全件_保険と認定.CSV")] },
];
const clients = await selectAll<{ id: string; name: string }>(sb, "clients", "id,name");
const nameOf = new Map(clients.map((c) => [c.id, c.name]));

await runFutanPeriod({
  app: "kaigo-app 訪問介護/総合事業",
  months: MONTHS,
  baselinePath: "scripts/futan-period-baseline.json",
  update: process.argv.includes("--update"),
  targets: async (ym) => {
    const [y, m] = ym.split("-").map(Number);
    const MS = `${ym}-01`, ME = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
    const rows = await selectAll<{ user_id: string | null; system: string | null }>(sb, "kaigo_visit_schedule", "id,user_id,system",
      (q) => q.eq("status", "completed").gte("visit_date", MS).lte("visit_date", ME));
    const out = new Map<string, string>();
    for (const r of rows) {
      if (!r.user_id || r.system === "障害" || r.system === "地域生活支援") continue;
      out.set(r.user_id, nameOf.get(r.user_id) ?? r.user_id);
    }
    return out;
  },
  certRows: (ids) => loadCertRows(sb, ids),
  benefitCerts: (ids) => loadBenefitCertsDbOrCsv(sb, ids, CSV_SETS),
  certRowRate: (row) => benefitRateFromCopay(row?.copay_rate),
});
