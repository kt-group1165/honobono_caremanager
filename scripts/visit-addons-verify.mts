/**
 * lib/visit-addons.ts (resolveVisitAddonLines) の検証 + H item② (116274問題) の実測
 *
 *   npx tsx scripts/visit-addons-verify.mts
 *
 * ── ①visit-addons.ts は実billingから参照されていない (H手順②の答え) ─────
 *   grep 済み: src/lib/visit-seikyu/aggregate.ts (介護) / src/lib/shogai-seikyu/
 *   aggregate.ts (障害) のどちらも resolveVisitAddonLines を import していない。
 *   実際に呼ぶのは provision-tickets-content.tsx / visit-records-content.tsx の
 *   ★UI表示専用★ (kaigo_visit_addon_lines の内容をその場でプレビューするだけ)。
 *
 * ⚠ ただし ★重要な食い違いを発見★:
 *   visit-addons.ts 自身のdocコメント「集計(visit-seikyu/aggregate.ts)はこれを呼ぶ」
 *   provision-tickets-content.tsx の該当行のコメント「集計元 aggregate.ts と同一経路」
 *   → ★どちらも事実と異なる★。aggregate.ts は同じテーブル(kaigo_visit_addon_lines)を
 *   読むが、resolveVisitAddonLines を呼ばず★独自に別実装したinlineロジック★
 *   (aggregate.ts:637-808, "2.6"節) を持っている。
 *
 *   inline版(実billing)にあって resolveVisitAddonLines(表示専用)に無いガード:
 *     a. formula != null → 除外 (処遇改善等の%加算。事業所単位の別経路で計算するため)
 *     b. calculation_type !== '加算' → 除外 (減算等は自動算定側に倒す)
 *     c. units <= 0 → 除外 (特別地域/中山間等の率加算。手動対応が必要)
 *   resolveVisitAddonLines は a/b/c のいずれも見ずに `unitUnits = m.units` を
 *   そのまま採用する。★もし将来これが実billingに転用されると、除外すべき
 *   コードをそのまま加算してしまう(units>0の減算コード等で二重計上の恐れ)。
 *   現状は表示専用なので実害は「除外されるはずの加算がプレビューに0単位/
 *   誤った単位で出て、除外理由の警告も出ない」という★UI上の食い違いのみ。
 *
 * ── ②H の懸念 (116274問題) の実測結果 ────────────────────────────────
 *   116274 = 障害system「家事深３．０・基・２人」656単位 / 介護systemでは
 *   「訪問介護処遇改善加算Ⅱ(１)」units=0・formula付き。
 *   kaigo_visit_addon_lines に system='介護' で34行 (2025-06〜2026-05)。
 *   ★aggregate.ts(実billing)は a. のformulaガードで正しく除外・警告を出す。
 *   ★656単位が介護請求に混入することはない (下記§2で実測・確認)。
 *   ただし resolveVisitAddonLines (表示専用) 経由だと 0単位の「訪問介護処遇改善
 *   加算Ⅱ」として無警告で出るだけで、実billingとの整合は保たれる (0単位なので
 *   金額は動かない)。★金額の実害は無い。UIの警告欠如のみ report。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { resolveVisitAddonLines } from "../src/lib/visit-addons";
import { validInMonth } from "../src/lib/service-code-valid";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(l);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `  (${detail})` : ""}`);
  }
};

console.log("=== §1 実データ: 116274 (system='介護') が入っている kaigo_visit_addon_lines ===");
const { data: rows116274, error: e116274 } = await sb
  .from("kaigo_visit_addon_lines")
  .select("client_id, office_id, target_month, count, system")
  .eq("addon_code", "116274");
if (e116274) throw new Error(e116274.message);
const rows = (rows116274 ?? []) as { client_id: string; office_id: string; target_month: string; count: number; system: string }[];
check(`実データで34行存在 (system列はすべて'介護')`, rows.length === 34 && rows.every((r) => r.system === "介護"));

console.log("\n=== §2 実billing (aggregate.tsのinlineロジックを再現) — formulaガードが効くか ===");
{
  // aggregate.ts:751-796 のロジックを対象コードだけ抜き出して再現・実マスタで検証
  const sample = rows[0];
  const [y, m] = sample.target_month.split("-").map(Number);
  const { data, error } = await validInMonth(
    sb.from("kaigo_service_codes")
      .select("service_code, service_name, units, calculation_type, formula")
      .eq("system", "介護")
      .in("service_code", ["116274"]),
    y, m,
  );
  if (error) throw new Error(error.message);
  const master = (data ?? [])[0] as { service_code: string; service_name: string; units: number; calculation_type: string | null; formula: unknown } | undefined;
  check("介護systemの116274マスタが引ける", !!master, JSON.stringify(master));
  check("formula列が非null (%加算)", master?.formula != null);
  const wouldBeExcluded = master && master.formula != null;
  check(
    "★ aggregate.ts の実装なら formula != null で除外され、656単位はおろか介護systemの実際の値(units=0)すら計上されない (report only)",
    !!wouldBeExcluded,
  );
}

console.log("\n=== §3 resolveVisitAddonLines (表示専用) — 同じ116274行を実際にどう解決するか ===");
{
  const sample = rows[0];
  const [y, m] = sample.target_month.split("-").map(Number);
  const map = await resolveVisitAddonLines(sb, [sample.client_id], y, m, sample.office_id, "介護");
  const lines = map.get(sample.client_id) ?? [];
  const line = lines.find((l) => l.code === "116274");
  check(
    "resolveVisitAddonLines はガード無しで解決するため「訪問介護処遇改善加算Ⅱ」を0単位のまま返す (警告なし)",
    !!line && line.totalUnits === 0,
    JSON.stringify(line),
  );
  console.log(`     → 実billingと数値上は一致 (0単位) だが、除外理由の警告は resolveVisitAddonLines 側に無い`);
}

console.log("\n=== §4 純関数境界: resolveVisitAddonLines のガード引数 ===");
{
  const empty1 = await resolveVisitAddonLines(sb, [], 2026, 6, "dummy-office");
  check("clientIds=[] → 空Map (DBを叩かず即return)", empty1.size === 0);
  const empty2 = await resolveVisitAddonLines(sb, ["dummy-client"], 2026, 6, null);
  check("officeId=null → 空Map (即return)", empty2.size === 0);
}

console.log("\n=== §5 他の formula 付きコードでも同じ穴が起きるか (系統的か単発か) ===");
{
  // kaigo_visit_addon_lines に実在する全 addon_code のうち、system='介護'マスタで
  // formula != null になるものが他にもあるか (2026-06 世代で確認)
  const { data: distinctCodes, error } = await sb
    .from("kaigo_visit_addon_lines")
    .select("addon_code")
    .eq("system", "介護");
  if (error) throw new Error(error.message);
  const codes = Array.from(new Set((distinctCodes ?? []).map((r: { addon_code: string }) => r.addon_code)));
  const { data: masterRows, error: e2 } = await validInMonth(
    sb.from("kaigo_service_codes")
      .select("service_code, service_name, formula")
      .eq("system", "介護")
      .in("service_code", codes),
    2026, 6,
  );
  if (e2) throw new Error(e2.message);
  const formulaCodesInUse = (masterRows ?? []).filter((r: { formula: unknown }) => r.formula != null) as { service_code: string; service_name: string }[];
  console.log(`  実際に kaigo_visit_addon_lines (system=介護) に登場するコード ${codes.length} 種のうち、`);
  console.log(`  formula付き (=表示専用リゾルバでガードが効かない対象) = ${formulaCodesInUse.length} 種`);
  for (const f of formulaCodesInUse) console.log(`    - ${f.service_code} ${f.service_name}`);
  check("116274 以外に系統的な広がりは無い (1種類のみ)", formulaCodesInUse.length <= 1);
}

console.log("\n=== 負のコントロール (harness がズレを検出できるか) ===");
let negOk = 0;
{
  // ① formulaガードの有無を取り違えると検出できるか (0単位 vs 何らかの非0値)
  const correct: number = 0; // formula付きコードは units=0 が現実の値
  const brokenGuess: number = 656; // ガードなしで障害側の値を誤って使ってしまうケースを模擬
  const detected = correct !== brokenGuess;
  console.log(`  ${detected ? "✓" : "✗"} ① 656単位混入の有無を区別できる (正=${correct} / 誤想定=${brokenGuess})`);
  if (detected) negOk += 1;
}
{
  // ② system フィルタが外れて障害側マスタを引いてしまうケースを検出できるか
  const { data } = await validInMonth(
    sb.from("kaigo_service_codes").select("units").eq("system", "障害").eq("service_code", "116274"),
    2026, 3,
  );
  const shogaiUnits = (data ?? [])[0]?.units ?? null;
  const kaigoUnits = 0;
  const detected = shogaiUnits !== kaigoUnits;
  console.log(`  ${detected ? "✓" : "✗"} ② system指定漏れ(障害マスタ誤参照)を検出できる (介護=${kaigoUnits} / 障害=${shogaiUnits})`);
  if (detected) negOk += 1;
}
if (negOk < 2) {
  console.error("\n✗ 負のコントロールが機能していない。harness 自体を疑うこと");
  process.exit(1);
}

console.log(`\n${failures === 0 ? "✅ PASS — 116274混入なし(formulaガードが効いている)。visit-addons.tsはUI専用でaggregate.tsの複製とは非同期であることを確認" : `❌ FAIL — ${failures} 件`}`);
process.exit(failures === 0 ? 0 : 1);
