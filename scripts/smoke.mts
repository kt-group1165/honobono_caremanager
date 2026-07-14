/**
 * 実データ回帰スモーク — 請求集計 (介護 / 障害 / 総合事業) の既知月を実 DB で再集計し、
 * scripts/smoke-expected.json の期待値と突合する。
 *
 * ══ いつ回すか ═══════════════════════════════════════════════════════════════
 *   集計・伝送系 (src/lib/visit-seikyu / shogai-seikyu / kohi / cert-for-month /
 *   gendo-allocation / service-code-valid 等) を触った commit の「前」に必ず 1 回。
 *
 * ══ 使い方 ═══════════════════════════════════════════════════════════════════
 *   npm run smoke
 *   - .env.local の NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY を使う
 *     (無ければ「スキップ」で exit 0。キーはコードに置かない)
 *   - DB は読み取りのみ (書込は一切しない)
 *   - 全一致 → PASS / exit 0、不一致 → got/expected の差分を表示して FAIL / exit 1
 *
 * ══ 期待値の更新 ═════════════════════════════════════════════════════════════
 *   改修で金額が「意図的に」変わった場合の手順は scripts/smoke-expected.json の
 *   _readme を参照 (got を確認 → 期待値を書き換え → 再実行で PASS 確認 → commit)。
 *
 * ══ チェック内容 ═════════════════════════════════════════════════════════════
 *   1. 介護給付 (aggregateMonthlyVisitSeikyu): 2026-06 / 2026-07 の
 *      行数・総単位数・総額・保険・公費(1+2)・利用者負担
 *   2. 障害 (aggregateMonthlyShogaiSeikyu): 2026-07 の行数
 *   3. 総合事業 (visit 集計の sougouRows): 2026-07 の行数・単位数・総額
 *   4. 恒等式 (全行): 総額 + 超過自費 = 保険 + 公費1 + 公費2 + 利用者負担 + 超過自費
 *      (障害行は 総費用額 = 介護給付費 + 利用者負担)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  aggregateMonthlyVisitSeikyu,
  type UserSeikyuRow,
} from "@/lib/visit-seikyu/aggregate";
import { aggregateMonthlyShogaiSeikyu } from "@/lib/shogai-seikyu/aggregate";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 期待値 (scripts/smoke-expected.json) ────────────────────────────────────

type KaigoExpected = {
  rows: number;
  totalUnits: number;
  totalAmount: number;
  insuranceAmount: number;
  /** 公費1 + 公費2 の合算 */
  kohiAmount: number;
  userAmount: number;
};
type ShogaiExpected = {
  rows: number;
};
type SougouExpected = {
  rows: number;
  totalUnits: number;
  totalAmount: number;
};
interface ExpectedFile {
  _readme: string[];
  officeId: string;
  officeLabel: string;
  tenantId: string;
  kaigo: Record<string, KaigoExpected>;
  shogai: Record<string, ShogaiExpected>;
  sougou: Record<string, SougouExpected>;
}

const expected = JSON.parse(
  readFileSync(join(__dirname, "smoke-expected.json"), "utf8"),
) as ExpectedFile;

// ─── env (.env.local。キーはコードに置かない) ────────────────────────────────

function loadEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
    const vars: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envFile = loadEnvLocal();
const SB_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? envFile.NEXT_PUBLIC_SUPABASE_URL;
const SB_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? envFile.SUPABASE_SERVICE_ROLE_KEY;

if (!SB_URL || !SB_SERVICE_KEY) {
  console.log(
    "smoke: スキップ (env 必要) — .env.local の NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が見つかりません",
  );
  process.exit(0);
}

const supabase = createClient(SB_URL, SB_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── 突合ヘルパ ───────────────────────────────────────────────────────────────

let failCount = 0;

function compare(
  label: string,
  got: Record<string, number>,
  exp: Record<string, number>,
): void {
  const diffs: string[] = [];
  for (const key of Object.keys(exp)) {
    if (got[key] !== exp[key]) {
      diffs.push(`${key}: got=${got[key]} expected=${exp[key]} (差 ${got[key] - exp[key]})`);
    }
  }
  if (diffs.length === 0) {
    console.log(`  一致 [OK] ${label}`);
  } else {
    failCount++;
    console.log(`  不一致 [NG] ${label}`);
    for (const d of diffs) console.log(`      ${d}`);
  }
}

/** 恒等式: 総額 + 超過自費 = 保険 + 公費1 + 公費2 + 利用者負担 + 超過自費 */
function checkKaigoIdentity(label: string, rows: UserSeikyuRow[]): void {
  const bad: string[] = [];
  for (const r of rows) {
    const lhs = r.totalAmount + r.selfPayAmount;
    const rhs =
      r.insuranceAmount +
      (r.kohiAmount ?? 0) +
      (r.kohi2Amount ?? 0) +
      r.userAmount +
      r.selfPayAmount;
    if (lhs !== rhs) {
      bad.push(
        `${r.user_name}: 総額${r.totalAmount}+超過${r.selfPayAmount} != 保険${r.insuranceAmount}+公費${r.kohiAmount ?? 0}+公費2${r.kohi2Amount ?? 0}+利用者${r.userAmount}+超過${r.selfPayAmount}`,
      );
    }
  }
  if (bad.length === 0) {
    console.log(`  一致 [OK] ${label} 恒等式 (総額=保険+公費+利用者+超過) ${rows.length} 行`);
  } else {
    failCount++;
    console.log(`  不一致 [NG] ${label} 恒等式`);
    for (const b of bad) console.log(`      ${b}`);
  }
}

function sumKaigo(rows: UserSeikyuRow[]): Record<string, number> {
  const s = {
    rows: rows.length,
    totalUnits: 0,
    totalAmount: 0,
    insuranceAmount: 0,
    kohiAmount: 0,
    userAmount: 0,
  };
  for (const r of rows) {
    s.totalUnits += r.totalUnits;
    s.totalAmount += r.totalAmount;
    s.insuranceAmount += r.insuranceAmount;
    s.kohiAmount += (r.kohiAmount ?? 0) + (r.kohi2Amount ?? 0);
    s.userAmount += r.userAmount;
  }
  return s;
}

const parseMonth = (m: string): { year: number; month: number } => {
  const [y, mo] = m.split("-").map(Number);
  return { year: y, month: mo };
};

// ─── 本体 ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(
    `実データ回帰スモーク — office=${expected.officeLabel} (${expected.officeId}) tenant=${expected.tenantId}`,
  );

  // 事業所の地域単価・処遇改善 (UI = use-seikyu-data と同じ入力で集計する)
  const { data: officeRow, error: officeError } = await supabase
    .from("offices")
    .select("unit_price, applied_formula_codes")
    .eq("id", expected.officeId)
    .maybeSingle();
  if (officeError) {
    console.error(`事業所情報の取得に失敗: ${officeError.message}`);
    process.exit(1);
  }
  const office = officeRow as {
    unit_price?: number | null;
    applied_formula_codes?: string[] | null;
  } | null;
  if (!office) {
    console.error(`事業所が見つかりません: ${expected.officeId}`);
    process.exit(1);
  }
  const unitPrice = office.unit_price ?? undefined;
  const appliedFormulaCodes = office.applied_formula_codes ?? [];

  // 総合事業チェック月の集計を使い回すためキャッシュ
  const visitResults = new Map<
    string,
    Awaited<ReturnType<typeof aggregateMonthlyVisitSeikyu>>
  >();
  const getVisitResult = async (monthStr: string) => {
    let r = visitResults.get(monthStr);
    if (!r) {
      const { year, month } = parseMonth(monthStr);
      r = await aggregateMonthlyVisitSeikyu(supabase, {
        officeId: expected.officeId,
        tenantId: expected.tenantId,
        year,
        month,
        unitPrice,
        appliedFormulaCodes,
      });
      visitResults.set(monthStr, r);
    }
    return r;
  };

  // 1) 介護給付
  for (const [monthStr, exp] of Object.entries(expected.kaigo)) {
    console.log(`\n[介護 ${monthStr}]`);
    const result = await getVisitResult(monthStr);
    compare("集計値", sumKaigo(result.rows), { ...exp });
    checkKaigoIdentity("介護", result.rows);
    if (result.warnings.length > 0) {
      console.log(`  (集計 warning ${result.warnings.length} 件 — 集計値には反映済)`);
    }
  }

  // 2) 障害
  for (const [monthStr, exp] of Object.entries(expected.shogai)) {
    console.log(`\n[障害 ${monthStr}]`);
    const { year, month } = parseMonth(monthStr);
    const result = await aggregateMonthlyShogaiSeikyu(supabase, {
      officeId: expected.officeId,
      year,
      month,
      unitPrice,
    });
    compare("集計値", { rows: result.rows.length }, { ...exp });
    // 恒等式 (障害): 総費用額 = 介護給付費 + 利用者負担
    const bad = result.rows.filter(
      (r) => r.totalAmount !== r.benefitAmount + r.userAmount,
    );
    if (bad.length === 0) {
      console.log(
        `  一致 [OK] 障害 恒等式 (総額=給付費+利用者) ${result.rows.length} 行`,
      );
    } else {
      failCount++;
      console.log("  不一致 [NG] 障害 恒等式");
      for (const r of bad) {
        console.log(
          `      ${r.user_name}: 総額${r.totalAmount} != 給付費${r.benefitAmount}+利用者${r.userAmount}`,
        );
      }
    }
  }

  // 3) 総合事業 (visit 集計の sougouRows)
  for (const [monthStr, exp] of Object.entries(expected.sougou)) {
    console.log(`\n[総合事業 ${monthStr}]`);
    const result = await getVisitResult(monthStr);
    const rows = result.sougouRows ?? [];
    const got = sumKaigo(rows);
    compare(
      "集計値",
      { rows: got.rows, totalUnits: got.totalUnits, totalAmount: got.totalAmount },
      { ...exp },
    );
    checkKaigoIdentity("総合事業", rows);
  }

  console.log("");
  if (failCount > 0) {
    console.log(`FAIL — ${failCount} 件の不一致。意図した変更なら scripts/smoke-expected.json を更新 (_readme 参照)`);
    process.exit(1);
  }
  console.log("PASS — 全チェック一致");
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error("smoke 実行エラー:", e instanceof Error ? e.message : e);
  process.exit(1);
});
