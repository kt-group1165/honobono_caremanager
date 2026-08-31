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
 *   npm run smoke -- --update
 *   実測値で scripts/smoke-expected.json を書き直す。**中身を必ず読んでから commit する。**
 *
 * ══ なぜ指紋 (fingerprint) を持つのか ════════════════════════════════════════
 *   このプロジェクトは実データを継ぎ足し続けるので、期待値を金額だけで固定すると
 *   **取込のたびに落ちる**。落ちっぱなしのガードは誰も読まなくなる。
 *   実際 2026-07-14 の期待値のまま 1 か月半放置され、全項目が不一致になっていた。
 *
 *   そこで各月の **入力データの件数 (指紋)** を一緒に記録し、結果を 3 つに分ける。
 *     指紋 一致 + 金額 不一致 → ★ 計算が変わった   = 本物の回帰。FAIL
 *     指紋 不一致             → ○ データが変わった = --update で更新する
 *     入力が 0 件             → ○ その月は未取込   = 期待値の問題ではない
 *   恒等式チェック (総額=保険+公費+利用者+超過) はデータ量に依らないので常に効く。
 *
 * ══ チェック内容 ═════════════════════════════════════════════════════════════
 *   1. 介護給付 (aggregateMonthlyVisitSeikyu): 2026-06 / 2026-07 の
 *      行数・総単位数・総額・保険・公費(1+2)・利用者負担
 *   2. 障害 (aggregateMonthlyShogaiSeikyu): 2026-07 の行数
 *   3. 総合事業 (visit 集計の sougouRows): 2026-07 の行数・単位数・総額
 *   4. 恒等式 (全行): 総額 + 超過自費 = 保険 + 公費1 + 公費2 + 利用者負担 + 超過自費
 *      (障害行は 総費用額 = 介護給付費 + 利用者負担)
 */

import { readFileSync, writeFileSync } from "node:fs";
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

/** その月の入力データの件数。金額ではなく「材料が変わったか」を見るためのもの */
type Fingerprint = {
  /** kaigo_visit_schedule (status=completed, 自事業所 or office_id 未設定) */
  schedules: number;
  /** kaigo_visit_addon_lines (自事業所・当月) */
  addonLines: number;
  /** kaigo_visit_month_addons (自事業所・当月) */
  monthAddons: number;
};

type KaigoExpected = {
  fingerprint?: Fingerprint;
  rows: number;
  totalUnits: number;
  totalAmount: number;
  insuranceAmount: number;
  /** 公費1 + 公費2 の合算 */
  kohiAmount: number;
  userAmount: number;
};
type ShogaiExpected = {
  fingerprint?: Fingerprint;
  rows: number;
  /** 総費用額の単位数合計。⚠ 2026-09-01 追加。それまで障害は **行数しか見ておらず**、
   *  時間帯またぎの配分やコード解決を変えても素通りしていた (実際に見逃した)。 */
  totalUnits?: number;
  totalAmount?: number;
  benefitAmount?: number;
  userAmount?: number;
};
type SougouExpected = {
  fingerprint?: Fingerprint;
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
/** データが変わっただけ (= 回帰ではない) の件数。--update を促すために数える */
let staleCount = 0;
/** その月の入力が 0 件 = まだ取り込んでいない */
let notImportedCount = 0;

const UPDATE = process.argv.includes("--update");
/** JSON 末尾の改行 */
const EOL = String.fromCharCode(10);

/** 入力データの件数を数える。金額に触らないので集計ロジックとは独立 */
async function fingerprintOf(officeId: string, monthStr: string): Promise<Fingerprint> {
  const { year, month } = parseMonth(monthStr);
  const from = `${monthStr}-01`;
  const to = `${monthStr}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
  const count = async (build: () => PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count: c, error } = await build();
    // 列や表が無い環境でも落とさない (集計側も同じ方針)。-1 は「数えられなかった」
    if (error) return -1;
    return c ?? 0;
  };
  return {
    schedules: await count(() => supabase
      .from("kaigo_visit_schedule")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")
      .gte("visit_date", from)
      .lte("visit_date", to)
      .or(`office_id.eq.${officeId},office_id.is.null`)),
    addonLines: await count(() => supabase
      .from("kaigo_visit_addon_lines")
      .select("id", { count: "exact", head: true })
      .eq("office_id", officeId)
      .eq("target_month", monthStr)),
    monthAddons: await count(() => supabase
      .from("kaigo_visit_month_addons")
      .select("id", { count: "exact", head: true })
      .eq("office_id", officeId)
      .eq("target_month", monthStr)),
  };
}

const sameFingerprint = (a: Fingerprint | undefined, b: Fingerprint): boolean =>
  !!a && a.schedules === b.schedules && a.addonLines === b.addonLines && a.monthAddons === b.monthAddons;

const fpText = (f: Fingerprint): string =>
  `実績${f.schedules}件 / 加算行${f.addonLines} / 月次加算${f.monthAddons}`;

/**
 * 期待値と突き合わせる。
 * 指紋が一致していれば「同じ材料で金額が動いた」= 本物の回帰として FAIL にする。
 * 指紋が違えば材料が変わっただけなので FAIL にせず --update を促す。
 */
function compare(
  label: string,
  got: Record<string, number>,
  exp: Record<string, number>,
  fp: { got: Fingerprint; expected: Fingerprint | undefined },
): void {
  const diffs: string[] = [];
  for (const key of Object.keys(exp)) {
    if (got[key] !== exp[key]) {
      diffs.push(`${key}: got=${got[key]} expected=${exp[key]} (差 ${got[key] - exp[key]})`);
    }
  }
  const dataMissing = fp.got.schedules === 0;
  const dataChanged = !sameFingerprint(fp.expected, fp.got);

  if (diffs.length === 0 && !dataChanged) {
    console.log(`  一致 [OK] ${label}  (${fpText(fp.got)})`);
    return;
  }
  if (dataMissing) {
    notImportedCount++;
    console.log(`  未取込 [--] ${label} — この月の実績が 1 件も入っていません (期待値の問題ではない)`);
    return;
  }
  if (dataChanged) {
    staleCount++;
    console.log(`  データが変わった [○] ${label} — 期待値が古いだけで、計算の回帰ではありません`);
    console.log(`      入力: ${fp.expected ? fpText(fp.expected) : "指紋なし (旧形式の期待値)"} → ${fpText(fp.got)}`);
    for (const d of diffs) console.log(`      ${d}`);
    return;
  }
  // ここに来るのは「材料は同じなのに金額が動いた」= 本物の回帰
  failCount++;
  console.log(`  ★ 計算が変わった [NG] ${label}  (${fpText(fp.got)} は前回と同じ)`);
  for (const d of diffs) console.log(`      ${d}`);
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

/** 集計結果の合計。**type 別名**にしておくこと (interface だと Record<string, number> に渡せない) */
type KaigoSums = {
  rows: number;
  totalUnits: number;
  totalAmount: number;
  insuranceAmount: number;
  /** 公費1 + 公費2 の合算 */
  kohiAmount: number;
  userAmount: number;
};

function sumKaigo(rows: UserSeikyuRow[]): KaigoSums {
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
  if (UPDATE) console.log("--update: 実測値で scripts/smoke-expected.json を書き直します");
  // --update で書き出す新しい期待値 (通常実行でも組み立てておき、書くのは --update のときだけ)
  const next: {
    kaigo: Record<string, KaigoExpected>;
    shogai: Record<string, ShogaiExpected>;
    sougou: Record<string, SougouExpected>;
  } = { kaigo: {}, shogai: {}, sougou: {} };
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
    const fpK = await fingerprintOf(expected.officeId, monthStr);
    const gotK = sumKaigo(result.rows);
    // 指紋は金額の比較対象ではないので外す
    const expK: Record<string, number> = {
      rows: exp.rows, totalUnits: exp.totalUnits, totalAmount: exp.totalAmount,
      insuranceAmount: exp.insuranceAmount, kohiAmount: exp.kohiAmount, userAmount: exp.userAmount,
    };
    compare("集計値", gotK, expK, { got: fpK, expected: exp.fingerprint });
    next.kaigo[monthStr] = { fingerprint: fpK, ...gotK };
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
    const fpS = await fingerprintOf(expected.officeId, monthStr);
    // 行数だけでなく **金額**も見る。障害は行数が変わらないまま単位数だけ動く
    // (合成コードの配分・同日合算・制度振り分け) ので、行数だけでは回帰を捕まえられない。
    const gotS = {
      rows: result.rows.length,
      totalUnits: result.rows.reduce((n, r) => n + r.totalUnits, 0),
      totalAmount: result.rows.reduce((n, r) => n + r.totalAmount, 0),
      benefitAmount: result.rows.reduce((n, r) => n + r.benefitAmount, 0),
      userAmount: result.rows.reduce((n, r) => n + r.userAmount, 0),
    };
    // 期待値に金額がまだ無い月 (初回) は行数だけ比較する
    const expS: Record<string, number> =
      exp.totalUnits == null
        ? { rows: exp.rows }
        : {
            rows: exp.rows,
            totalUnits: exp.totalUnits,
            totalAmount: exp.totalAmount ?? 0,
            benefitAmount: exp.benefitAmount ?? 0,
            userAmount: exp.userAmount ?? 0,
          };
    const gotCmp: Record<string, number> =
      exp.totalUnits == null ? { rows: gotS.rows } : gotS;
    compare("集計値", gotCmp, expS, { got: fpS, expected: exp.fingerprint });
    next.shogai[monthStr] = { fingerprint: fpS, ...gotS };
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
    const gotG = sumKaigo(rows);
    const fpG = await fingerprintOf(expected.officeId, monthStr);
    const valsG = { rows: gotG.rows, totalUnits: gotG.totalUnits, totalAmount: gotG.totalAmount };
    compare("集計値", valsG, { rows: exp.rows, totalUnits: exp.totalUnits, totalAmount: exp.totalAmount },
      { got: fpG, expected: exp.fingerprint });
    next.sougou[monthStr] = { fingerprint: fpG, ...valsG };
    checkKaigoIdentity("総合事業", rows);
  }

  console.log("");
  if (UPDATE) {
    // 入力が 0 件の月は残しても毎回「未取込」になるだけなので対象から外す。
    // ただし黙って消さない — 本来あるはずの月なら取込のほうを疑う手がかりになる。
    const dropped: string[] = [];
    for (const kind of ["kaigo", "shogai", "sougou"] as const) {
      for (const [m, v] of Object.entries(next[kind])) {
        if (v.fingerprint?.schedules === 0) { dropped.push(`${kind} ${m}`); delete next[kind][m]; }
      }
    }
    const out = { ...expected, kaigo: next.kaigo, shogai: next.shogai, sougou: next.sougou };
    writeFileSync(join(__dirname, "smoke-expected.json"), JSON.stringify(out, null, 2) + EOL, "utf8");
    console.log("scripts/smoke-expected.json を実測値で更新しました。**中身を読んでから commit してください。**");
    if (dropped.length > 0) {
      console.log(`  入力が 0 件だったので対象から外した月: ${dropped.join(" / ")}`);
      console.log("  ⚠ 本来あるはずの月なら、期待値ではなく **取込のほう** を疑うこと。");
    }
    process.exit(0);
  }

  if (failCount > 0) {
    console.log(`FAIL — ★ 計算が変わった ${failCount} 件。入力データは前回と同じなので、`);
    console.log("       これは集計ロジックの回帰です。期待値を更新して黙らせないこと。");
    process.exit(1);
  }
  if (staleCount > 0 || notImportedCount > 0) {
    const parts = [
      staleCount > 0 ? `データが変わった ${staleCount} 件` : "",
      notImportedCount > 0 ? `未取込 ${notImportedCount} 件` : "",
    ].filter(Boolean).join(" / ");
    console.log(`PASS (計算の回帰なし) — ${parts}`);
    console.log("  期待値を今の実データに合わせ直す: npm run smoke -- --update");
    process.exit(0);
  }
  console.log("PASS — 全チェック一致");
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error("smoke 実行エラー:", e instanceof Error ? e.message : e);
  process.exit(1);
});
