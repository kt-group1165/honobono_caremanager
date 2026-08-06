// ============================================================================
// 障害の**回/月単位の定額加算**を、ほのぼのの伝送 (KJ) から起こして
// kaigo_visit_addon_lines (system='障害') に投入する。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   初回加算 / 上限額管理加算 / 喀痰吸引等支援体制加算 / 緊急時対応加算 /
//   福祉専門職員等連携加算 は**回数を人が入力する**設計 (提供表の加算エディタ)。
//   稼働データ (MEISAI) には出てこないため、取込だけでは 1 件も立たない。
//   実際 2026-06 の障害加算行は**全拠点で 0 行**で、
//   J121 の「code 116020/126100 等が新に無し」の大半がこれだった。
//
// ── 根拠にするもの ────────────────────────────────────────────────────
//   ⚠ 伝送を**実績の**取込元にしてはいけない (循環) が、これは
//     「その月に何回算定したか」という**入力値**であり、こちらで再計算できない。
//     受給者証にも稼働データにも無いので、ほのぼのの請求実態から起こすしかない。
//     単位数はマスタから引く (伝送の金額は使わない)。
//
// ── 対象コード ────────────────────────────────────────────────────────
//   定額 (units>0 / formula 無し) の加算のみ。%加算 (処遇改善・特地) は
//   aggregate 側が率で計算するのでここでは扱わない。
//
//   AD_OFFICE_ID=<uuid> AD_KJ=<KJファイル> AD_LABEL=<拠点> \
//     node migrations/import_shogai_addon_lines_from_densou.mjs           # DRY RUN
//   … --execute で投入
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import iconv from "encoding-japanese";

const EXECUTE = process.argv.includes("--execute");
const OFFICE_ID = process.env.AD_OFFICE_ID;
const KJ = process.env.AD_KJ;
const LABEL = process.env.AD_LABEL || "";
const MONTH = "2026-06-01";
const TENANT = "kt-group";
const MARK = `[伝送から加算取込 2026-06${LABEL ? " " + LABEL : ""}]`;

if (!OFFICE_ID || !KJ) {
  console.error("✗ AD_OFFICE_ID と AD_KJ を指定してください");
  process.exit(1);
}

function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log(`=== 障害 定額加算を伝送から投入 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ${LABEL} ===\n`);

  // 1) 定額加算のマスタ (units>0 / formula 無し)
  const { data: master, error: e0 } = await sb
    .from("kaigo_service_codes")
    .select("service_code, service_name, units, formula, calculation_type")
    .eq("system", "障害")
    .eq("calculation_type", "加算")
    .eq("valid_from", "2026-06-01");
  if (e0) throw new Error(e0.message);
  const fixed = new Map();
  for (const m of master) {
    if (m.formula) continue;      // %加算 は aggregate が計算する
    if (!(m.units > 0)) continue; // 単位数なしは対象外
    fixed.set(m.service_code, m);
  }
  console.log(`定額加算マスタ: ${fixed.size} コード`);

  // 2) 伝送 (J121 種別03) から 受給者×コード×回数
  const rows = iconv
    .convert(readFileSync(KJ), { to: "UNICODE", from: "SJIS", type: "string" })
    .split(/\r?\n/).filter(Boolean)
    .map((l) => l.split(",").map((s) => s.replace(/"/g, "")));
  const found = new Map(); // 受給者証番号 -> [{code, count}]
  for (const r of rows) {
    if (r[2] !== "J121" || r[3] !== "03") continue;
    const code = (r[8] ?? "").trim();
    if (!fixed.has(code)) continue;
    const cnt = Number(r[10] ?? 0);
    if (!(cnt > 0)) continue;
    if (!found.has(r[7])) found.set(r[7], []);
    found.get(r[7]).push({ code, count: cnt });
  }
  console.log(`伝送に出ている定額加算: ${found.size} 名 / ${[...found.values()].flat().length} 行\n`);
  if (!found.size) { console.log("対象なし。"); return; }

  // 3) 受給者証番号 -> client_id
  const { data: asg, error: e1 } = await sb
    .from("client_office_assignments").select("client_id").eq("office_id", OFFICE_ID);
  if (e1) throw new Error(e1.message);
  const ids = [...new Set(asg.map((r) => r.client_id))];
  const certs = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb
      .from("shougai_certifications")
      .select("client_id, beneficiary_number, clients(name)")
      .in("client_id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    certs.push(...data);
  }
  const byBene = new Map(certs.filter((c) => c.beneficiary_number).map((c) => [c.beneficiary_number, c]));

  const payload = [];
  const unresolved = [];
  for (const [bene, lines] of found) {
    const c = byBene.get(bene);
    if (!c) { unresolved.push(bene); continue; }
    for (const l of lines) {
      payload.push({
        tenant_id: TENANT, office_id: OFFICE_ID, client_id: c.client_id,
        target_month: MONTH, addon_code: l.code, count: l.count,
        system: "障害", notes: MARK,
      });
      console.log(`  ${(c.clients?.name ?? "").padEnd(12)} ${l.code} ${fixed.get(l.code).service_name} ×${l.count}`);
    }
  }
  if (unresolved.length) console.log(`\n⚠ 受給者証が無く紐付かない: ${unresolved.join(", ")}`);
  console.log(`\n投入対象: ${payload.length} 行`);
  if (!EXECUTE) { console.log("※ DRY RUN。--execute で投入します。"); return; }

  const { error: dErr } = await sb
    .from("kaigo_visit_addon_lines").delete()
    .eq("office_id", OFFICE_ID).eq("target_month", MONTH).eq("system", "障害")
    .like("notes", "[伝送から加算取込%");
  if (dErr) { console.error(`✗ 既存削除: ${dErr.message}`); process.exit(1); }

  const { error } = await sb.from("kaigo_visit_addon_lines").insert(payload);
  if (error) { console.error(`✗ 投入失敗: ${error.message}`); process.exit(1); }
  console.log(`✓ 完了: ${payload.length} 行 INSERT`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
