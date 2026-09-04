/**
 * 重度訪問介護「熟練従業者による同行支援」(lib/shogai-doukou.ts) の検証
 *
 *   npx tsx scripts/shogai-doukou-verify.mts
 *
 * ── H の割当と実際の対象が違った (13回目) ─────────────────────────────
 *   ファイル名 shogai-doukou.ts (障害・同行) から「同行援護」(155xxx、
 *   支援区分による報酬体系。今日 I が formula 未設定を指摘した領域) を
 *   連想する割当だったが、★中身は完全に別の制度: 重度訪問介護 (124xxx等) の
 *   「熟練従業者が新任職員(採用6ヶ月以内)に同行して2人で提供する場合の
 *   90%相当算定」機能。同行援護 (155xxx) とは無関係。
 *   git log 1コミットのみ (6cd7eb7f「重度訪問介護『熟練同行』機能を実装」)
 *   — コミットメッセージ自体が正しい名称で、ファイル名だけが紛らわしい。
 *
 * ── 参照状況 (H 指示の手順②) ──────────────────────────────────────────
 *   provision-tickets / shift-management (3画面) から呼ばれており、
 *   ★shogai-time-bracket.ts と違って実billingに直結する:
 *   「service_type をマスタ駆動で同行名に差し替えるだけで、集計 (障害請求は
 *   service_type の名前解決で単位数を引く) にそのまま反映される」
 *   (ファイル自身のdocコメントより)。UI専用ではなく実データ書き込み側。
 *   ⚠ 実データ: kaigo_visit_schedule に「同行」を含む service_type は
 *   ★0件 (2026-09-05 REST確認)。機能自体は一度も実運用されていない。
 *   → same-building.ts と同型 (参照はされているが実データ0件)。
 *   H の「参照されていないなら結論」はここでは不成立、通常の境界値検証を行う。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  isJudoHoumonService,
  isDoukouService,
  stripDoukou,
  resolveDoukouVariant,
} from "../src/lib/shogai-doukou";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(l);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

const YEAR = 2026, MONTH = 6; // 実データがある確定済月 (対象月に依存しない静的マスタなのでどの月でも良いが実績のある月に合わせる)

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `  (${detail})` : ""}`);
  }
};

console.log("=== §1 純関数: isJudoHoumonService / isDoukouService / stripDoukou ===");
check("「重訪Ⅰ日中１．０」→ 重訪サービス", isJudoHoumonService("重訪Ⅰ日中１．０"));
check("「重度訪問介護◯◯」(別表記) → 重訪サービス", isJudoHoumonService("重度訪問介護標準型"));
check("「身体介護２」→ 重訪ではない", !isJudoHoumonService("身体介護２"));
check("null → 重訪ではない", !isJudoHoumonService(null));
check("空文字 → 重訪ではない", !isJudoHoumonService(""));

check("「重訪Ⅰ日中１．０・２人・同行２」→ 同行バリアント", isDoukouService("重訪Ⅰ日中１．０・２人・同行２"));
check("「重訪Ⅰ日中１．０・２人」(同行なし) → 同行バリアントではない", !isDoukouService("重訪Ⅰ日中１．０・２人"));
check("「重訪Ⅰ日中１．０」(base) → 同行バリアントではない", !isDoukouService("重訪Ⅰ日中１．０"));

check(
  "stripDoukou(「重訪Ⅰ日中１．０・２人・同行２」) → 「重訪Ⅰ日中１．０・２人」(２人は残す)",
  stripDoukou("重訪Ⅰ日中１．０・２人・同行２") === "重訪Ⅰ日中１．０・２人",
);
check(
  "stripDoukou(90日減はさむ「重訪Ⅰ入院等夜間１．０・２人・９０日減・同行１」) → 同行だけ落ちる",
  stripDoukou("重訪Ⅰ入院等夜間１．０・２人・９０日減・同行１") === "重訪Ⅰ入院等夜間１．０・２人・９０日減",
);
check(
  "stripDoukou(同行なし) → そのまま (no-op)",
  stripDoukou("重訪Ⅰ日中１．０・２人") === "重訪Ⅰ日中１．０・２人",
);

console.log("\n=== §2 resolveDoukouVariant — 実マスタ (2026-06 世代) との突合 ===");
{
  const r = await resolveDoukouVariant(sb, "重訪Ⅰ日中１．０", YEAR, MONTH);
  check(
    "「重訪Ⅰ日中１．０」→ 同行２優先で解決 (124542, units=193)",
    r?.code === "124542" && r?.units === 193,
    `実際: ${JSON.stringify(r)}`,
  );
}
{
  // doc コメント自身の例: 「一部のbaseでは同行２が存在せず同行１のみ (例: 重訪Ⅱ深夜２．０)」
  const r = await resolveDoukouVariant(sb, "重訪Ⅱ深夜２．０", YEAR, MONTH);
  check(
    "「重訪Ⅱ深夜２．０」→ 同行２が無いので同行１にfall back (127258, units=135)",
    r?.code === "127258" && r?.units === 135,
    `実際: ${JSON.stringify(r)}`,
  );
}
{
  // 90日減 interleave の例 (doc コメント記載パターン)
  const r = await resolveDoukouVariant(sb, "重訪Ⅰ入院等夜間１．０・２人・９０日減", YEAR, MONTH);
  check(
    "「重訪Ⅰ入院等夜間１．０・２人・９０日減」→ 装飾を保った同行２ (125492, units=193)",
    r?.code === "125492" && r?.units === 193,
    `実際: ${JSON.stringify(r)}`,
  );
}
{
  // 冪等性: 既に同行名 (同行１) を渡しても二重付与せず同じ結果に解決する
  const fromBase = await resolveDoukouVariant(sb, "重訪Ⅰ日中１．０", YEAR, MONTH);
  const fromDoukou = await resolveDoukouVariant(sb, "重訪Ⅰ日中１．０・２人・同行１", YEAR, MONTH);
  check(
    "既に「・同行１」付きの名前を渡しても base に戻してから解決 (二重付与しない)",
    fromBase?.code === fromDoukou?.code,
    `base経由=${fromBase?.code} / 同行1経由=${fromDoukou?.code}`,
  );
}
{
  // ガード: 重訪でないサービス名は DB を叩かず null
  const r = await resolveDoukouVariant(sb, "身体介護２", YEAR, MONTH);
  check("「身体介護２」(重訪でない) → null (ガードで早期リターン)", r === null);
}
{
  // 存在しない架空のbase名 → 完全一致もLIKEも無くnull (warningで元コードのまま、が呼出側の設計)
  const r = await resolveDoukouVariant(sb, "重訪Ｚ架空区分９９．９", YEAR, MONTH);
  check("実在しないbase名 → null (呼出側でbaseのまま+warningの設計どおり)", r === null);
}

console.log("\n=== §3 実データの利用状況 (2026-09-05 REST確認) ===");
console.log("  kaigo_visit_schedule.service_type に「同行」を含む行 = 0件 (機能は未実運用)");
console.log("  → 参照はされている(billing直結)が、same-building.tierと同型で実データ0件");

console.log("\n=== 負のコントロール (harness がズレを検出できるか) ===");
let negOk = 0;
{
  // ① 同行１/同行２の優先順位を取り違えると検出できるか
  const r = await resolveDoukouVariant(sb, "重訪Ⅰ日中１．０", YEAR, MONTH);
  const wrongCode = "127002"; // 同行1版のコード (本来の正解=124542 同行2版)
  const detected = r?.code !== wrongCode;
  console.log(`  ${detected ? "✓" : "✗"} ① 同行1/同行2優先順位の取り違えを検出できる (正=${r?.code} / 誤=${wrongCode})`);
  if (detected) negOk += 1;
}
{
  // ② stripDoukou が ２人 まで誤って消してしまうバグを模擬
  const correct = stripDoukou("重訪Ⅰ日中１．０・２人・同行２");
  const broken = "重訪Ⅰ日中１．０"; // わざと２人まで消したケース
  const detected = correct !== broken;
  console.log(`  ${detected ? "✓" : "✗"} ② stripDoukouが２人まで誤って消すバグを検出できる (正=${correct} / 誤=${broken})`);
  if (detected) negOk += 1;
}
if (negOk < 2) {
  console.error("\n✗ 負のコントロールが機能していない。harness 自体を疑うこと");
  process.exit(1);
}

console.log(`\n${failures === 0 ? "✅ PASS — 熟練同行の解決ロジック(純関数+実マスタ突合)はすべて一致" : `❌ FAIL — ${failures} 件`}`);
process.exit(failures === 0 ? 0 : 1);
