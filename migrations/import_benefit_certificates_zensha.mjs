/**
 * ほのぼの (介護 NEXT・全社) の「負担割合証等」CSV → client_benefit_certificates (期間ごとの負担割合証)。
 * 2026-11-09 FY-H (user 合意: 負担割合は履歴で持つ)。
 *
 *   node migrations/import_benefit_certificates_zensha.mjs                          # DRY RUN (既定)
 *   node migrations/import_benefit_certificates_zensha.mjs --execute
 *   node migrations/import_benefit_certificates_zensha.mjs --revert <batch_id> [--execute]
 *     [--csv <負担割合証等1.CSV>] [--ins-csv <介護保険1.CSV>] [--out <明細.json>]
 *
 * 既定の入力: 利用者データ/全社_R8-08/負担割合証等1.CSV + 同じ回の 介護保険1.CSV (2026-08-30 出力)
 * 前提: migrations/client_benefit_certificates.sql (ルート) を適用済み。未適用でも DRY RUN は回る。
 *
 * ★ 認定行 (client_insurance_records) は上書きしない
 *   (旧 import_futan_wariai_from_honobono.mjs は MONTH 1 つで認定行の copay_rate を上書きする作りだった。
 *    それだと認定期間途中の 8/1 で割合が変わる人の片方の月が必ず誤る → この表に期間ごとに持つ)。
 *
 * 事業所 (DESIGN_INSURANCE_PER_OFFICE.md §5.2 と同じ考え方。介護側の事業所だけを候補にする):
 *   候補 = client_office_assignments のうち offices.app_type = 'kaigo-app' の事業所
 *          (福祉用具 (order-app) の事業所は候補にしない — ケアサポは自分の取込
 *           apps/order-app/migrations/import_benefit_certificates_caresapo.mjs で持つ)
 *   現割当 (end_date が無い/今日以降) が 1 事業所   → その事業所   office_source = 'assignment_single'
 *   現割当が 0 で 終了した割当がある                 → 最後に終了した事業所 'ended_assignment'
 *   現割当が 2 事業所以上 / 割当なし                  → NULL (事業所未定。今の解決関数は全行を見るので請求には効く)
 * 取込エンジン: apps/order-app/scripts/_benefit-cert-import.mts (ケアサポの取込と共用)。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
if (!process.env.BENEFIT_CERT_UNDER_TSX) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const r = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, BENEFIT_CERT_UNDER_TSX: "1" },
  });
  process.exit(r.status ?? 1);
}
const engine = await import(pathToFileURL(join(HERE, "../../order-app/scripts/_benefit-cert-import.mts")).href);
const { runBenefitCertImport, selectAll, selectIn, TENANT } = engine;

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const DIR = join(HERE, "../利用者データ/全社_R8-08");
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

async function decideOffices(sb, clientIds) {
  const offices = await selectAll(sb, "offices", "id,app_type");
  const kaigoOffice = new Set(offices.filter((o) => o.app_type === "kaigo-app").map((o) => o.id));
  const asg = await selectIn(sb, "client_office_assignments", "id,client_id,office_id,end_date", "client_id", clientIds, (q) => q.eq("tenant_id", TENANT));
  const by = new Map();
  for (const a of asg) {
    if (!kaigoOffice.has(a.office_id)) continue;
    if (!by.has(a.client_id)) by.set(a.client_id, []);
    by.get(a.client_id).push(a);
  }
  const out = new Map();
  for (const cid of clientIds) {
    const list = by.get(cid) ?? [];
    const current = [...new Set(list.filter((a) => !a.end_date || a.end_date >= today).map((a) => a.office_id))];
    if (current.length === 1) { out.set(cid, { officeId: current[0], officeSource: "assignment_single" }); continue; }
    if (current.length === 0) {
      const ended = list.filter((a) => a.end_date).sort((a, b) => (a.end_date < b.end_date ? 1 : -1));
      if (ended[0]) { out.set(cid, { officeId: ended[0].office_id, officeSource: "ended_assignment" }); continue; }
    }
    out.set(cid, { officeId: null, officeSource: null });
  }
  return out;
}

await runBenefitCertImport({
  label: "全社 (ほのぼの介護 NEXT 2026-08-30)",
  scriptRel: "apps/kaigo-app/migrations/import_benefit_certificates_zensha.mjs",
  sourceSystem: "honobono-kaigo",
  marker: "[benefit-cert 全社 20260830]",
  futanCsv: resolve(opt("--csv") ?? join(DIR, "負担割合証等1.CSV")),
  kaigoInsCsvs: [resolve(opt("--ins-csv") ?? join(DIR, "介護保険1.CSV"))],
  decideOffices,
  argv,
});
