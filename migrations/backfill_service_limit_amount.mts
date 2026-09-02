// ============================================================================
// 認定の 区分支給限度基準額 (client_insurance_records.service_limit_amount) を
// **告示値で埋める** backfill
//
//   npx tsx migrations/backfill_service_limit_amount.mts             # DRY RUN (既定)
//   npx tsx migrations/backfill_service_limit_amount.mts --detail    # 対象を全部出す
//   npx tsx migrations/backfill_service_limit_amount.mts --execute   # 本番 UPDATE
//
// ── なぜ要るか (2026-09-03 実測) ───────────────────────────────────────────
//   2026-05 の取込が限度額を入れておらず、NULL のまま残っている。
//   以降 (2026-07 / 08 / 09) の取込は入れているので、**2026-05 分だけの取りこぼし**。
//
//     NULL の作成月            2026-05:735 / 2026-07:46 / 2026-08:124
//     入っている側の作成月      2026-05:184 / 2026-07:2,387 / 2026-08:2,381 / 2026-09:1,239
//
//   限度額が決まらないと `visit-seikyu/aggregate.ts` の超過判定が
//   `limitUnits = 計画単位数 ?? 認定の限度額` で **どちらも無い → 判定しない** に落ちる。
//   超過分は全額自費なので、判定されないと**過大請求 (保険に乗せすぎ)** になる。
//
// ── ⚠ 実害は 0 件。予防である ─────────────────────────────────────────────
//   全 22 訪問介護事業所の 2026-06 集計行で `limitUnits=null` は **0 行**。
//   NULL の 876 名は**訪問介護の利用者ではない** (居宅・予防側) ので今は表に出ない。
//   計画単位数がある 1,821 名は全員 認定にも限度額が入っている (NULL 0)。
//   → 「その人が訪問介護を使い始めた月」に初めて誤判定する種類の話。急ぎではない。
//
// ── なぜ「推測で埋める」ではないか ────────────────────────────────────────
//   区分支給限度基準額は **要介護度から一意に決まる告示値**で、
//   `src/lib/kubun-gendo.ts` がその唯一の定義。この表は 2026-09-03 に
//   **2026-06 に有効な認定 7,096 行と突合して「告示値と不一致 0 行」**を確認済み。
//   さらに同じ値が別の 3 か所 (benefits-content / reports-content / aggregate-sougou) に
//   コピーされており、機械照合で全部一致していた。**材料として信頼できる。**
//
//   ⚠ だからこの script は **その表を import する**。値を書き写さない。
//     (2026-09-03 に移動支援で「ハーネスが本番と別の表を検証していた」事故があった)
//
// ── 触らないもの ──────────────────────────────────────────────────────────
//   ★ **要介護度が引けない行は埋めない。**NULL のまま残して件数を出す。
//     (「事業対象者」など告示値が定義されていない区分がある。推測で入れない)
//   ★ 既に値が入っている行は触らない。**告示値と違っていても上書きしない。**
//     区分変更の経過措置など、正当に違う可能性を否定できないため。
//     不一致は `limitAmountMismatchReason` が画面で警告を出す (現在 0 行)。
// ============================================================================
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { standardLimitUnits } from "@/lib/kubun-gendo";

const EXECUTE = process.argv.includes("--execute");
const DETAIL = process.argv.includes("--detail");

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("✗ .env.local に NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY がありません");
  process.exit(1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PAGE = 1000;
/** PostgREST の 1000 行上限を order 付きで越える (order 無しはページ間で行が抜ける) */
async function all<T>(table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += PAGE) {
    const { data, error } = await sb.from(table).select(select).order("id").range(f, f + PAGE - 1);
    if (error) throw new Error(`${table} の取得に失敗: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < PAGE) return out;
  }
}

type Cert = {
  id: string;
  client_id: string;
  care_level: string | null;
  service_limit_amount: number | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  created_at: string | null;
};

async function main() {
  console.log(`=== 区分支給限度基準額の backfill ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===`);
  console.log("    告示値は src/lib/kubun-gendo.ts を import している (書き写していない)\n");

  const certs = await all<Cert>(
    "client_insurance_records",
    "id, client_id, care_level, service_limit_amount, certification_start_date, certification_end_date, created_at",
  );
  console.log(`【分母】client_insurance_records ${certs.length} 行`);

  const nulls = certs.filter((c) => c.service_limit_amount == null);
  console.log(`   service_limit_amount が NULL : ${nulls.length} 行`);
  console.log(`   値が入っている                : ${certs.length - nulls.length} 行 (**触らない**)\n`);

  const fillable = nulls.filter((c) => standardLimitUnits(c.care_level) != null);
  const unknown = nulls.filter((c) => standardLimitUnits(c.care_level) == null);

  console.log("── 埋める / 埋めない ──");
  console.log(`   ★ 埋める (要介護度から告示値が引ける): ${fillable.length} 行`);
  console.log(`   ★ 埋めない (要介護度が引けない)      : ${unknown.length} 行  ← NULL のまま残す`);
  const unknownLevels: Record<string, number> = {};
  for (const c of unknown) {
    const k = c.care_level == null ? "(care_level が NULL)" : `"${c.care_level}"`;
    unknownLevels[k] = (unknownLevels[k] ?? 0) + 1;
  }
  if (unknown.length) console.log(`      内訳: ${JSON.stringify(unknownLevels)}`);

  console.log("\n── 埋める内容 (要介護度別) ──");
  const byLevel: Record<string, { n: number; units: number }> = {};
  for (const c of fillable) {
    const k = String(c.care_level).normalize("NFKC").replace(/\s/g, "");
    const u = standardLimitUnits(c.care_level)!;
    if (!byLevel[k]) byLevel[k] = { n: 0, units: u };
    byLevel[k].n++;
  }
  for (const [k, v] of Object.entries(byLevel).sort()) {
    console.log(`   ${k.padEnd(8)} ${String(v.n).padStart(4)} 行 → ${v.units.toLocaleString()} 単位`);
  }

  // 2026-06 に有効なものが何行あるか (影響の目安)
  const S = "2026-06-01", E = "2026-06-30";
  const activeNow = fillable.filter(
    (c) => (c.certification_start_date ?? "9999") <= E && (c.certification_end_date ?? "0000") >= S,
  );
  console.log(`\n   参考: このうち 2026-06 に有効な認定は ${activeNow.length} 行 / 利用者 ${new Set(activeNow.map((c) => c.client_id)).size} 名`);
  const byCreated: Record<string, number> = {};
  for (const c of fillable) {
    const k = String(c.created_at).slice(0, 7);
    byCreated[k] = (byCreated[k] ?? 0) + 1;
  }
  console.log(`   参考: 作成月の分布 ${Object.keys(byCreated).sort().map((k) => `${k}:${byCreated[k]}`).join(" ")}`);

  if (DETAIL) {
    const cl = await all<{ id: string; name: string }>("clients", "id, name");
    const nm = new Map(cl.map((c) => [c.id, c.name]));
    console.log("\n── 対象の全行 (--detail) ──");
    for (const c of fillable) {
      console.log(`   ${String(nm.get(c.client_id) ?? c.client_id).padEnd(16)} ${c.care_level} → ${standardLimitUnits(c.care_level)!.toLocaleString()}  (${c.certification_start_date}〜${c.certification_end_date})`);
    }
  }

  if (!EXECUTE) {
    console.log(`\n【DRY RUN】書き込んでいません。実行するなら --execute`);
    console.log(`  ⚠ 実行前に必ずスナップショットを取ること:`);
    console.log(`     CREATE TABLE _backup_cir_limit_20260903 AS`);
    console.log(`       SELECT id, client_id, care_level, service_limit_amount`);
    console.log(`       FROM client_insurance_records WHERE service_limit_amount IS NULL;`);
    console.log(`  ⚠ backup 表は RLS を継承しない (anon に見える) ので、確認後に DROP すること`);
    console.log(`  ⚠ 戻すとき:`);
    console.log(`     UPDATE client_insurance_records c SET service_limit_amount = NULL`);
    console.log(`       FROM _backup_cir_limit_20260903 b WHERE c.id = b.id;`);
    return;
  }

  console.log(`\n=== 本番 UPDATE 開始 (${fillable.length} 行) ===`);
  let ok = 0;
  const failed: string[] = [];
  for (const c of fillable) {
    const units = standardLimitUnits(c.care_level)!;
    // ⚠ 競合防止: 走らせている間に誰かが値を入れた行は上書きしない
    const { error } = await sb
      .from("client_insurance_records")
      .update({ service_limit_amount: units })
      .eq("id", c.id)
      .is("service_limit_amount", null);
    if (error) { failed.push(`${c.id}: ${error.message}`); continue; }
    ok++;
  }
  console.log(`  成功 ${ok} 行 / 失敗 ${failed.length} 行`);
  for (const f of failed.slice(0, 20)) console.log(`    ✗ ${f}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error("✗ " + (e as Error).message); process.exit(1); });
