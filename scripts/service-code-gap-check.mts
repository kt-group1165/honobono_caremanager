/**
 * kaigo_service_codes の欠損 (単位数0 / 処遇改善formula未設定) — 規模と発火条件の常設チェック
 *
 *   npx tsx scripts/service-code-gap-check.mts
 *
 * ── なぜ要るか (claude-06 割当・2026-09-05) ────────────────────────────────
 *   kaigo_service_codes は 118k行超で全制度の金額の源。既知の欠損2系統:
 *     ① 訪問介護の units=0 コード (身体９系ほか。所要時間で増える可変扱いと
 *        思われてきたが、実際は WAM Excel 取込元に値が無かった単純な欠損
 *        だったことが「身体９生活１」で判明済み — migrations/fix_shintai9_seikatsu1_units.mjs)
 *     ② 障害の処遇改善加算 formula が Ⅰイ/Ⅱイ/Ⅰロ/Ⅱロ で欠落 (Ⅲ・Ⅳ は入っている)
 *
 * ── ★ この script は埋めない。規模と「今は無害/いつ有害になるか」の分類までに留める ──
 *   告示の値を推測で入れると誤請求になるため (claude-06 の指示)。
 *
 * ── 判定方針: 0件を目指さない。「実際に発火しうる」ものが増えたら落ちる ──
 *   ★ NG = 実際に使われた実績(全期間) or 事業所が選択済みの加算コード が
 *          units=0 / formula未設定 のまま現行世代にある場合
 *   ⚠ (警告のみ) = 理論上のみ (対象サービス自体を提供する事業所が0)
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ");
  process.exit(0);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TODAY = new Date().toISOString().slice(0, 10);

type CodeRow = {
  service_code: string; service_name: string; units: number; calculation_type: string;
  formula: string | null; valid_from: string | null; valid_until: string | null;
  system: string; service_category: string; service_category_name: string | null;
};

async function fetchAll(system: string): Promise<CodeRow[]> {
  const out: CodeRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("kaigo_service_codes")
      .select("service_code,service_name,units,calculation_type,formula,valid_from,valid_until,system,service_category,service_category_name")
      .eq("system", system)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`kaigo_service_codes(${system}) 取得失敗: ${error.message}`);
    out.push(...((data ?? []) as CodeRow[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const validNow = (r: { valid_from: string | null; valid_until: string | null }) =>
  (!r.valid_from || r.valid_from <= TODAY) && (!r.valid_until || r.valid_until >= TODAY);

let ng = 0, warn = 0;

async function main() {
  console.log(`kaigo_service_codes 欠損チェック (現行世代基準日 ${TODAY})\n`);

  // ── ① 訪問介護 (system=介護 / service_category=11) の units=0 基本コード ──
  console.log("=== ① 訪問介護 units=0 基本コード ===");
  const kaigoAll = await fetchAll("介護");
  const kaigoNow = kaigoAll.filter(validNow);
  const zeroHoumon = kaigoNow.filter(
    (r) => r.service_category === "11" && r.calculation_type === "基本" && Number(r.units) === 0,
  );
  console.log(`  【分母】訪問介護(11) 現行世代 units=0 基本コード: ${zeroHoumon.length} 件`);
  const gyakubou = zeroHoumon.filter((r) => r.service_name.includes("虐防"));
  const gyoumi = zeroHoumon.filter((r) => r.service_name.includes("業未"));
  const plain = zeroHoumon.filter((r) => !r.service_name.includes("虐防") && !r.service_name.includes("業未"));
  console.log(`    虐防修飾: ${gyakubou.length} / 業未修飾: ${gyoumi.length} / それ以外(身体９系の素の変種など): ${plain.length}`);

  // 実際に使われた service_type 名 (介護・全期間・completed) と突合
  const usedNames = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("kaigo_visit_schedule").select("service_type")
      .eq("system", "介護").eq("status", "completed").range(from, from + 999);
    if (error) throw new Error(`kaigo_visit_schedule 取得失敗: ${error.message}`);
    for (const r of (data ?? []) as { service_type: string | null }[]) if (r.service_type) usedNames.add(r.service_type.trim());
    if (!data || data.length < 1000) break;
  }
  const hitByUsage = zeroHoumon.filter((r) => usedNames.has(r.service_name.trim()));
  if (hitByUsage.length > 0) {
    ng += hitByUsage.length;
    console.log(`  ★★ NG: 実際に使われた実績があるのに units=0 のコード ${hitByUsage.length} 件 (¥0請求が起きている可能性)`);
    for (const r of hitByUsage) console.log(`      ${r.service_code} ${r.service_name}`);
  } else {
    console.log(`  ✓ 実績で使われた service_type 名との一致は無し (現時点で発火した形跡なし)`);
  }
  warn += zeroHoumon.length - hitByUsage.length;
  console.log(
    `  ⚠ 発火条件 (理論上): 虐防/業未 修飾コード (${gyakubou.length + gyoumi.length}件) は、いずれかの` +
      `訪問介護事業所で虐待防止未実施減算/業務継続計画未策定減算のフラグが立った月から対象になる` +
      `(2026-09-04時点 J実測で該当事業所0件)。それ以外の身体９系変種 (${plain.length}件) は` +
      `90分以上の身体介護がその組合せ(生活援助レベル・2人・夜・深夜・地域区分Ⅰ〜Ⅲ)で実施された` +
      `時点で対象になる (身体９生活１は既に実例あり=是正済。同系列の他パターンは実例待ち)`,
  );

  // ── ② 障害 処遇改善加算 formula 未設定 (Ⅰイ/Ⅱイ/Ⅰロ/Ⅱロ 系) ──
  console.log("\n=== ② 障害 処遇改善加算 formula 未設定 ===");
  const shogaiAll = await fetchAll("障害");
  const shogaiNow = shogaiAll.filter(validNow);
  const shoguu = shogaiNow.filter((r) => r.service_name.includes("処遇改善"));
  const missingFormula = shoguu.filter((r) => !r.formula);
  console.log(`  【分母】処遇改善名を含むコード: ${shoguu.length} 件 / formula未設定: ${missingFormula.length} 件`);

  // このorgが実際に提供しているサービス (kaigo_visit_schedule.system=障害 の service_type から
  // 大分類名を粗く抽出。誤検出を避けるため「事業所が実績を持つ大分類」の有無だけ見る)
  const shogaiServiceTypes = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("kaigo_visit_schedule").select("service_type")
      .eq("system", "障害").eq("status", "completed").range(from, from + 999);
    if (error) throw new Error(`kaigo_visit_schedule(障害) 取得失敗: ${error.message}`);
    for (const r of (data ?? []) as { service_type: string | null }[]) if (r.service_type) shogaiServiceTypes.add(r.service_type.trim());
    if (!data || data.length < 1000) break;
  }
  // applied_formula_codes に missingFormula のコードを含む事業所
  const { data: offs, error: offErr } = await sb
    .from("offices").select("id,name,applied_formula_codes").not("applied_formula_codes", "is", null);
  if (offErr) throw new Error(`offices 取得失敗: ${offErr.message}`);
  const missingCodes = new Set(missingFormula.map((r) => r.service_code));
  const selectedByOffice = (offs ?? []).filter((o) =>
    ((o as { applied_formula_codes: string[] | null }).applied_formula_codes ?? []).some((c) => missingCodes.has(c)),
  );

  // グループ (先頭のサービス略称) ごとに集計し、実績有無で仕分ける
  const byPrefix = new Map<string, CodeRow[]>();
  for (const r of missingFormula) {
    const m = r.service_name.match(/^(.+?)処遇改善加算/);
    const key = m ? m[1] : r.service_name;
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key)!.push(r);
  }
  console.log(`  サービス種別ごとの内訳 (formula未設定のみ):`);
  for (const [prefix, rows] of [...byPrefix.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${prefix}: ${rows.length}件  ${rows.map((r) => r.service_name).join(" / ")}`);
  }
  if (selectedByOffice.length > 0) {
    ng += selectedByOffice.length;
    console.log(`\n  ★★ NG: formula未設定コードを applied_formula_codes に選んでいる事業所あり: ${selectedByOffice.map((o) => o.name).join("、")}`);
  } else {
    console.log(`\n  ✓ formula未設定コードを選んでいる事業所は無し`);
  }
  warn += missingFormula.length - selectedByOffice.length;
  console.log(
    `  ⚠ 発火条件 (理論上): 上記コードに対応するサービス種別を提供する事業所が現れ、` +
      `かつその事業所が該当tier(Ⅰイ/Ⅱイ/Ⅰロ/Ⅱロ)の処遇改善を選んだ月から対象になる。` +
      `2026-09-05時点で実績のある障害 service_type は ${shogaiServiceTypes.size} 種` +
        ` (同援/家事/身体/通院/重訪Ⅱ 系が中心。同行援護・重度訪問介護は既に稼働中なので、` +
        `該当事業所が Ⅰイ/Ⅱイ/Ⅰロ/Ⅱロ tier の処遇改善に切り替えた瞬間が最短の発火条件)`,
  );

  console.log(`\n══ 合計: ★NG(実発火の可能性) ${ng} 件 / ⚠理論上のみ ${warn} 件 ══`);
  console.log(`  ★ この script は埋めない。実発火が0のうちは exit 0。増えたら (使用実績や事業所選択が付いたら) 落とす。`);
  if (ng > 0) process.exit(1);
}

main().catch((e) => { console.error("エラー:", e); process.exit(1); });
