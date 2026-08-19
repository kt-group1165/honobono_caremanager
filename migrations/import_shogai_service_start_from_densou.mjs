// ============================================================================
// 障害の「サービス利用開始年月日」(shogai_service_start) を実伝送 (KJ) から起こす。
//
// ── なぜ伝送から取るしかないか ────────────────────────────────────────
//   原典 (サービス事業所編 P.18):
//     「一連とみなされる利用契約の下で **最初にサービスを提供した日付** を記載する」
//   ⚠ 契約日でも当月の初回訪問日でもない。契約支給量を変更しても動かない。
//     実データ (四街道): 松戸孝雄 開始日 20250201 固定 / 契約日は 20260601 に変更済
//   当システムには 2026-06 以降の実績しか無く 2025-02 まで遡れないため算出不能。
//   受給者証にも契約情報にも無い。移行時の初期投入としてここから起こす。
//
//   ⚠ **これは検証にはならない** (伝送由来)。照合では J121-02 項8 を
//     「検証対象外」として扱うこと。運用開始後は画面入力/自動保持に切り替わる。
//
//   SS_OFFICE_ID=<uuid> SS_KJ=<KJファイル> SS_LABEL=<拠点> \
//     node migrations/import_shogai_service_start_from_densou.mjs            # DRY RUN
//   … --execute で投入
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "encoding-japanese";

const EXECUTE = process.argv.includes("--execute");
const OFFICE_ID = process.env.SS_OFFICE_ID;
const KJ = process.env.SS_KJ;
const LABEL = process.env.SS_LABEL || "";
const TENANT = "kt-group";
const MARK = `[伝送から開始日取込${LABEL ? " " + LABEL.split(" ")[0] : ""}]`;
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

if (!OFFICE_ID || !KJ) {
  console.error("✗ SS_OFFICE_ID と SS_KJ を指定してください");
  process.exit(1);
}

function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const toDate = (s) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null);

async function main() {
  console.log(`=== 障害 サービス利用開始年月日 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ${LABEL} ===\n`);

  const rows = iconv
    .convert(readFileSync(KJ), { to: "UNICODE", from: "SJIS", type: "string" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split(",").map((s) => s.replace(/^"|"$/g, "")));

  // J121-02 (日数情報) 項7 サービス種類コード / 項8 開始年月日
  const found = new Map(); // 受給者証番号 -> [{type, date}]
  for (const r of rows) {
    if (r[2] !== "J121" || r[3] !== "02") continue;
    const type = (r[8] ?? "").trim();
    const date = toDate(r[9] ?? "");
    if (!/^\d{2}$/.test(type) || !date) continue;
    if (!found.has(r[7])) found.set(r[7], []);
    found.get(r[7]).push({ type, date });
  }
  console.log(`伝送の開始年月日: ${found.size} 名 / ${[...found.values()].flat().length} 件`);
  if (!found.size) { console.log("対象なし。"); return; }

  const { data: asg, error: e1 } = await sb
    .from("client_office_assignments").select("client_id").eq("office_id", OFFICE_ID);
  if (e1) { console.error(`✗ ${e1.message}`); process.exit(1); }
  const ids = [...new Set(asg.map((r) => r.client_id))];
  const certs = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb
      .from("shougai_certifications")
      .select("client_id, beneficiary_number, clients(name)")
      .in("client_id", ids.slice(i, i + 100));
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    certs.push(...data);
  }
  const byNum = new Map(certs.filter((c) => c.beneficiary_number).map((c) => [c.beneficiary_number, c]));

  const payload = [];
  const unresolved = [];
  for (const [bene, lines] of found) {
    const c = byNum.get(bene);
    if (!c) { unresolved.push(bene); continue; }
    for (const l of lines) {
      payload.push({
        tenant_id: TENANT, office_id: OFFICE_ID, client_id: c.client_id,
        service_type_code: l.type, start_date: l.date, notes: MARK,
      });
    }
    console.log(`  ${(c.clients?.name ?? "").padEnd(12)} ${lines.map((l) => `種類${l.type} ${l.date}`).join(" / ")}`);
  }
  if (unresolved.length) console.log(`\n⚠ 受給者証が無く紐付かない: ${unresolved.join(", ")}`);
  console.log(`\n投入対象: ${payload.length} 件`);
  if (!EXECUTE) { console.log("※ DRY RUN。--execute で投入します。"); return; }
  if (!payload.length) return;

  // 同じ利用者×種類が複数月の伝送に出るので upsert (削除はしない。理由は契約取込と同じ)
  for (let i = 0; i < payload.length; i += 200) {
    const { error } = await sb
      .from("shogai_service_start")
      .upsert(payload.slice(i, i + 200), { onConflict: "client_id,office_id,service_type_code" });
    if (error) { console.error(`✗ 投入失敗: ${error.message}`); process.exit(1); }
  }
  console.log(`✓ 完了: ${payload.length} 件`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
