// ============================================================================
// 身体９生活１ (訪問介護 身体介護90分以上+生活援助 複合コード) の単位数0 是正
//
// 背景:
//   kaigo_service_codes の 116711〜116716 (身体９生活１ とその夜/深/２人/２人夜/
//   ２人深 変種) は R8-06 マスタ取込元 (WAM 公式 Excel コード表) の時点で
//   units が null のまま取り込まれ、DB上は 0 になっている。
//   「身体N生活M」の N=9 (90分以上) は所要時間で単位数が増え続ける可変区分の
//   ため、公式コード表自体が固定値を持たない (⚠ よく似た名前だが 実際の実績
//   データで使われるのは「介護」の付かない「身体N生活M」表記の方。
//   「身体介護N」(介護あり)は別の名前空間で、2026-06 の実績データでは
//   一件も使われていないことを確認済み。今回はこちらは対象外)。
//
// 算出根拠 (2026-09-01、3通りの方法で相互検証済み):
//   ① 身体１生活１〜身体８生活１ の実系列 (309/452/632/714/796/878/960/1042)
//      は隣接差が一貫して +82 (= 告示の「30分を増すごとに82単位」、
//      WebSearch で独立ソース確認 https://carenote.jp/202404houmonkaigo-tani/ )。
//      → 身体９生活１ = 1042 + 82 = 1124
//   ② 夜/深/２人 の倍率が「身体N生活１(無印)」の値に対して常に一定倍数
//      (夜=×1.25 / 深=×1.5 / ２人=×2 / ２人夜=×2.5 / ２人深=×3) であることを
//      身体１〜身体８の全系列で例外なく確認 (深は 82×1.5=123 の整数倍で
//      端数無し、夜は 82×1.25=102.5 の丸めで交互に102/103になるが
//      「無印値×1.25」を都度計算すると全ケース一致する)。
//      → ①の 1124 に同じ倍率を掛けても、隣接差分の外挿と完全に同じ値になる
//        ことを確認済み (両方式が全6系列で一致)。
//   ③ 2024-06-01 世代と 2026-06-01 世代で身体１〜８生活１の値が完全一致する
//      ことを確認済み → 同じ算出値を両世代に適用してよい。
//
//   実データ影響: 2026-06 の completed 実績で「身体９生活１」(無印) を使う
//   client が実在する (五井/K姉、旧記載の差 4,797円)。夜/深/２人 系の変種は
//   現時点で実データに無いが、将来同一パターンで発生しうるため合わせて是正。
//
//   ⚠ 対象は上記6コード×2世代=12行のみ。同系統でも「身体介護N」(介護あり)
//   ・生活２/生活３・虐防/業未 修飾つきなど他の 身体9系 コードは倍率パターンを
//   個別検証していないため今回は対象外 (実データで使われた時に同じ方法で
//   個別対応する)。
//
// 使い方:
//   node migrations/fix_shintai9_seikatsu1_units.mjs            # DRY RUN
//   node migrations/fix_shintai9_seikatsu1_units.mjs --execute  # 本番
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
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
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const TARGETS = {
  "116711": 1124, // 身体９生活１
  "116712": 1405, // 身体９生活１・夜
  "116713": 1686, // 身体９生活１・深
  "116714": 2248, // 身体９生活１・２人
  "116715": 2810, // 身体９生活１・２人・夜
  "116716": 3372, // 身体９生活１・２人・深
};

async function main() {
  console.log(`=== 身体９生活１系 単位数是正 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data: rows, error } = await sb
    .from("kaigo_service_codes")
    .select("id, service_code, service_name, units, valid_from, system")
    .in("service_code", Object.keys(TARGETS))
    .eq("system", "介護")
    .order("service_code")
    .order("valid_from");
  if (error) { console.error(`✗ 取得失敗: ${error.message}`); process.exit(1); }

  console.log(`対象行: ${rows.length} 件 (期待値 12 = 6コード × 2世代)`);
  if (rows.length !== 12) console.warn(`⚠ 想定と異なる件数。中身を確認してから進めること。`);

  const plans = [];
  for (const r of rows) {
    const newUnits = TARGETS[r.service_code];
    if (r.units !== 0) {
      console.log(`  [SKIP] ${r.service_code} ${r.service_name} (${r.valid_from}) は既に units=${r.units} (0 ではない)`);
      continue;
    }
    plans.push({ id: r.id, code: r.service_code, name: r.service_name, validFrom: r.valid_from, newUnits });
    console.log(`  ${r.service_code} ${r.service_name} (${r.valid_from})  0 -> ${newUnits}`);
  }
  console.log(`\n更新対象: ${plans.length} 件`);

  if (!EXECUTE) { console.log("\nDRY RUN — 変更なし。--execute で本番反映。"); return; }
  if (plans.length === 0) { console.log("更新対象が無いため終了。"); return; }

  // バックアップ (更新前の行をそのまま保存)
  const backupPath = path.join(KAIGO, "migrations", `_backup_kaigo_service_codes_shintai9_seikatsu1_20260901.json`);
  writeFileSync(backupPath, JSON.stringify(rows, null, 2));
  console.log(`\nバックアップ: ${backupPath}`);

  console.log("\n--- PATCH 実行 ---");
  for (const p of plans) {
    const { error: upErr } = await sb.from("kaigo_service_codes").update({ units: p.newUnits }).eq("id", p.id);
    if (upErr) { console.error(`✗ ${p.code} (${p.validFrom}) 更新失敗: ${upErr.message}`); process.exit(1); }
    console.log(`  ✓ ${p.code} ${p.name} (${p.validFrom}) -> ${p.newUnits}`);
  }

  // 件数確認
  const { data: after, error: verErr } = await sb
    .from("kaigo_service_codes")
    .select("service_code, units, valid_from")
    .in("service_code", Object.keys(TARGETS))
    .eq("system", "介護");
  if (verErr) { console.error(`✗ 検証取得失敗: ${verErr.message}`); process.exit(1); }
  const stillZero = after.filter((r) => r.units === 0);
  console.log(`\n検証: 対象12行中 units=0 が残っているもの ${stillZero.length} 件`);
  if (stillZero.length > 0) {
    console.error("⚠ 更新漏れあり — 要確認");
    for (const r of stillZero) console.error(`  ${r.service_code} (${r.valid_from})`);
    process.exit(1);
  }
  console.log("完了");
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
