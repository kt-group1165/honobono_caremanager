// ============================================================================
// kaigo_service_codes.calculation_type の誤分類を全件是正する (介護 種類11)。
//
// ── 何が壊れていたか ────────────────────────────────────────────────────
//   訪問介護の基本サービスの**時間帯・人数バリアント**が、規則性なく「加算」に
//   分類されていた。官報のコード表を取り込んだ際に分類を推測で付けたためと思われる。
//
//     111111 身体介護１          244 基本
//     111112 身体介護１・夜      305 基本   ← 正しい
//     111113 身体介護１・深      366 加算   ← 誤り
//     111121 身体介護１・２人    488 基本   ← 正しい
//     111122 身体介護１・２人・夜 610 加算  ← 誤り
//     114111 身体１生活１        309 基本
//     114112 身体１生活１・夜    386 加算   ← 誤り (111112 と矛盾)
//
//   aggregate.ts はサービス名から単価を引くとき `calculation_type='基本'` で
//   絞るため、誤分類のコードは基本サービスとして解決されず
//   **限度額管理対象単位数から外れる**。
//   高品 関口統博: サービス単位 5,245 のうち 身体１生活１・夜 1,930 が対象外になり、
//   保険請求額 41,738 (正 66,034) と 24,296 円ずれていた。
//
// ── 判定ルール ──────────────────────────────────────────────────────
//   種類11 のコードのうち **名称に「加算」「減算」を含むものだけが真の加算/減算**
//   (訪問介護初回加算・処遇改善加算・特定事業所加算 等の 20 コード。全て正しく分類済)。
//   残りは全て訪問介護費そのもののバリアントなので **基本**。
//
//   ⚠ 「・虐防」「・業未」等の **減算** 区分は触らない。
//     これらは所定単位数自体が減じられたコードで、減算という分類は妥当。
//     (6 月実績では 1 件も使われていないため実害も無い)
//
//   使い方:
//     node migrations/fix_service_code_calculation_type.mjs            # DRY RUN
//     node migrations/fix_service_code_calculation_type.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");

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

async function fetchAll(table, cols, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).order("id").order("id").range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== calculation_type 是正 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const rows = await fetchAll(
    "kaigo_service_codes",
    "id, service_code, service_name, units, unit_type, calculation_type, valid_from, valid_until",
    (q) => q.eq("system", "介護").eq("service_category", "11"),
  );
  console.log(`種類11 の行: ${rows.length} (世代込み)`);

  const isRealAddon = (name) => /加算|減算/.test(name ?? "");
  const targets = rows.filter((r) => r.calculation_type === "加算" && !isRealAddon(r.service_name));

  const byCode = new Map();
  for (const r of targets) if (!byCode.has(r.service_code)) byCode.set(r.service_code, r);
  console.log(`\n是正対象 (加算 → 基本): ${targets.length} 行 / ${byCode.size} コード`);
  console.log(`  サンプル:`);
  for (const r of [...byCode.values()].slice(0, 10)) {
    console.log(`    ${r.service_code} ${(r.service_name + "                    ").slice(0, 22)} ${String(r.units).padStart(5)}単位`);
  }

  // 触らないもの (確認用)
  const keepAddon = rows.filter((r) => r.calculation_type === "加算" && isRealAddon(r.service_name));
  const keepGensan = rows.filter((r) => r.calculation_type === "減算");
  console.log(`\n触らない:`);
  console.log(`  真の加算 (名称に「加算」): ${new Set(keepAddon.map((r) => r.service_code)).size} コード`);
  console.log(`  減算 (・虐防/・業未 等)  : ${new Set(keepGensan.map((r) => r.service_code)).size} コード`);

  if (!EXECUTE) {
    console.log(`\n※ DRY RUN。--execute で UPDATE します。`);
    return;
  }

  // バックアップ (id → 元の値)
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const backupPath = new URL(`./_backup_calculation_type_${stamp}.json`, import.meta.url);
  writeFileSync(
    decodeURIComponent(backupPath.pathname.replace(/^\/([A-Za-z]:)/, "$1")),
    JSON.stringify(targets.map((r) => ({ id: r.id, service_code: r.service_code, calculation_type: r.calculation_type })), null, 1),
    "utf8",
  );
  console.log(`\nバックアップ: _backup_calculation_type_${stamp}.json (${targets.length} 行)`);

  let done = 0;
  const ids = targets.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { error } = await sb
      .from("kaigo_service_codes")
      .update({ calculation_type: "基本" })
      .in("id", chunk);
    if (error) {
      console.error(`✗ UPDATE 失敗 (${done} 件済): ${error.message}`);
      process.exit(1);
    }
    done += chunk.length;
  }
  console.log(`✓ 完了: ${done} 行を 基本 に是正`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
