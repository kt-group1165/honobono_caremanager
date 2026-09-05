/**
 * 訪問入浴 — 要支援(予防給付)なのに介護給付コード(121xxx)が付いている件数を監視
 * (B-1w 再発防止・0件維持・READ ONLY)
 *
 *   npx tsx scripts/bath-yobo-code-check.mts
 *
 * ── 背景 ────────────────────────────────────────────────────────────────
 *   2026-09-03 サンプル検証で発見、2026-09-05 修正 (src/lib/bath-seikyu/resolve-code.ts)。
 *   記録作成画面 (bath-records / bath-shift) の resolveBathCode を修正したが、
 *   ★ DB に直接書き込む別経路 (import script・過去データ・手動修正) があれば
 *   同じ不整合が再発しうる。稼働開始前の「出たら気づける」網。
 *
 * ── 0件を目指す検査 ────────────────────────────────────────────────────────
 *   本来ゼロであるべきデータ (資格と種類の不一致は返戻になる) なので、
 *   0件を基準値として増えたら即FAILにする。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { isYoboLevel } from "../src/lib/yobo-kubun";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY が無い。分母が作れないので中止する");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function pageAll<T>(table: string, select: string, orderCol = "id"): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(select).order(orderCol).range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

console.log("══ 訪問入浴 — 要支援なのに介護給付コード(121xxx) 常設監視 (READ ONLY) ══\n");

type BathRow = { id: string; client_id: string; visit_date: string; service_code: string | null };
const bathRows = await pageAll<BathRow>("kaigo_bath_visit_records", "id,client_id,visit_date,service_code");
console.log(`【分母】kaigo_bath_visit_records 全件: ${bathRows.length} 行`);

const clientIds = [...new Set(bathRows.map((r) => r.client_id))];
type CertRow = { client_id: string; care_level: string | null; certification_start_date: string | null; certification_end_date: string | null };
const certs: CertRow[] = [];
for (let i = 0; i < clientIds.length; i += 200) {
  const chunk = clientIds.slice(i, i + 200);
  const { data, error } = await sb.from("client_insurance_records")
    .select("client_id,care_level,certification_start_date,certification_end_date")
    .in("client_id", chunk);
  if (error) throw error;
  certs.push(...((data ?? []) as CertRow[]));
}
console.log(`【分母】対象クライアントの認定レコード: ${certs.length} 件 (${clientIds.length} 名分)\n`);

// 訪問日時点で有効な認定を1件選ぶ (無ければ最新)
function careLevelAt(clientId: string, visitDate: string): string | null {
  const own = certs.filter((c) => c.client_id === clientId);
  const active = own.find((c) =>
    (!c.certification_start_date || c.certification_start_date <= visitDate) &&
    (!c.certification_end_date || c.certification_end_date >= visitDate),
  );
  if (active) return active.care_level;
  return own[0]?.care_level ?? null;
}

const mismatches = bathRows.filter((r) => {
  if (!r.service_code || !/^121/.test(r.service_code)) return false;
  const cl = careLevelAt(r.client_id, r.visit_date);
  return isYoboLevel(cl);
});
console.log(`★ 要支援/事業対象者なのに121xxx(介護給付)が付いている行: ${mismatches.length} 件`);
for (const m of mismatches.slice(0, 10)) {
  console.log(`   ${m.id} client=${m.client_id} visit_date=${m.visit_date} code=${m.service_code}`);
}

if (mismatches.length > 0) {
  console.log(`\n❌ FAIL — B-1wの不整合データが ${mismatches.length} 件あります。`);
  process.exitCode = 1;
} else {
  console.log(`\n✅ PASS — 不整合データはありません。`);
}
