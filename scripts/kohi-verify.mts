/**
 * 介護保険 公費併用の負担計算 検証
 *
 *   npx tsx scripts/kohi-verify.mts
 *
 * migrations/seed_fake_kohi_test.mjs で投入したテスト事業所 (2026-12) を
 * aggregateMonthlyVisitSeikyu で集計し、**手計算した期待値**と突合する。
 *
 * 期待値は下の EXPECTED に literal で書いてある (集計側の式を再実装していない)。
 *
 * ── 手計算の根拠 ────────────────────────────────────────────
 * 全ケース共通: 身体介護３ (567単位) × 20回 = 11340 単位 / 単価 11.05 円
 *   総額     = floor(11340 × 1105 / 100) = floor(125307.0)  = 125307
 *   保険 1割 = floor(125307 × 9 / 10)    = floor(112776.3)  = 112776  → 給付後負担 12531
 *   保険 2割 = floor(125307 × 8 / 10)    = floor(100245.6)  = 100245  → 給付後負担 25062
 *   公費単独 = 保険 0 固定                                            → 給付後負担 125307
 *
 * 公費対象費用 (期間按分ありのケース):
 *   K10 (12/11開始 = 20回中10回)  floor(5670 × 1105/100) = floor(62653.5) = 62653
 *                                 対象保険 floor(62653 × 9/10) = floor(56387.7) = 56387
 *                                 給付後 62653 − 56387 = 6266
 *   K13 (12/08開始 = 20回中13回)  floor(7371 × 1105/100) = floor(81449.55) = 81449
 *                                 対象保険 floor(81449 × 9/10) = floor(73304.1) = 73304
 *                                 給付後 81449 − 73304 = 8145
 *
 * 単独公費:  本人 = min(給付後負担, 本人負担上限) / 公費 = 給付後負担 − 本人
 *            利用者負担 = 総額 − 保険 − 公費
 * 併用:      公費1 は上と同じ。公費2 は
 *            残 = 総額 − 保険 − 公費1請求
 *            base2 = min(max(公費2給付後 − 公費1請求, 0), 残)
 *            公費2 = base2 − min(base2, 公費2上限)
 * 恒等式:    総額 = 保険 + 公費1 + 公費2 + 本人 (全ケースで検算する)
 * ────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateMonthlyVisitSeikyu, type UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import { buildKokuhoDensou } from "@/lib/kokuho-densou/build";

const META = JSON.parse(
  readFileSync(new URL("../migrations/_fake_kohi_test_meta.json", import.meta.url), "utf8"),
) as {
  marker: string; month: string; officeId: string; unitPrice: number; tenantId: string;
  grossUnits: number; visits: number;
  cases: { tag: string; clientId: string; copay: string; kohi: string; tandoku: boolean; memo: string }[];
};

const env: Record<string, string> = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface Exp {
  totalUnits: number;
  totalAmount: number;
  insuranceAmount: number;
  userAmount: number;
  /** 公費1 法別番号 (充当順の検証。null = 公費なし) */
  kohiHobetsu: string | null;
  kohiUnits: number | null;
  kohiTargetCost: number | null;
  kohiHonninFutan: number | null;
  kohiAmount: number | null;
  /** 公費2 (併用ケースのみ。単独は undefined = 未設定であること自体を検証) */
  kohi2Hobetsu?: string | null;
  kohi2Amount?: number | null;
  kohiTandoku?: boolean;
}

const T = 125307;   // 総額
const I1 = 112776;  // 保険 1割
const A1 = 12531;   // 給付後負担 1割

const EXPECTED: Record<string, Exp> = {
  // ── 単独公費 ──────────────────────────────────────────
  // 法別21 上限0 → 給付後 12531 を全額公費
  K01: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: 0,
    kohiHobetsu: "21", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: 0, kohiAmount: A1 },
  // 法別54 上限2500 → 本人 2500 / 公費 12531−2500 = 10031
  K02: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: 2500,
    kohiHobetsu: "54", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: 2500, kohiAmount: 10031 },
  // 法別19 上限99999 > 給付後12531 → 本人が全部かぶり公費 0 (境界)
  K03: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: A1,
    kohiHobetsu: "19", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: A1, kohiAmount: 0 },
  // 法別12 フル月・上限0 → 全量振替 (本人 0)
  K04: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: 0,
    kohiHobetsu: "12", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: 0, kohiAmount: A1 },
  // 法別12 フル月・上限5000 → 全量振替ブランチでも上限が効く
  K05: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: 5000,
    kohiHobetsu: "12", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: 5000, kohiAmount: 7531 },

  // ── 併用カスケード ────────────────────────────────────
  // 54+12 (priority 同値) → 生保は他法優先で最劣後 = 公費1が54。54で使い切り12は0
  K06: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: 0,
    kohiHobetsu: "54", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: 0, kohiAmount: A1,
    kohi2Hobetsu: "12", kohi2Amount: 0 },
  // ★実務の典型: 54(上限3000)+12 → 54で9531、残3000を生保が引き取り本人 0
  K07: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: 0,
    kohiHobetsu: "54", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: 3000, kohiAmount: 9531,
    kohi2Hobetsu: "12", kohi2Amount: 3000 },
  // 21(上限2000)+54(上限1000) → 優先順位表 21(20) < 54(50)。21で10531、54が1000、本人1000
  K08: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: 1000,
    kohiHobetsu: "21", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: 2000, kohiAmount: 10531,
    kohi2Hobetsu: "54", kohi2Amount: 1000 },
  // priority 手動指定 (12=1 / 54=2) → 優先順位表を上書きして 公費1=12 になる
  // (金額は K06 と同値。検証の本体は kohiHobetsu / kohi2Hobetsu の並び)
  K09: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: 0,
    kohiHobetsu: "12", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: 0, kohiAmount: A1,
    kohi2Hobetsu: "54", kohi2Amount: 0 },

  // ── 期間按分 ──────────────────────────────────────────
  // 法別54 が 12/11 開始 → 20回中10回 = 5670単位。給付後 6266 を公費、残り 6265 が本人
  K10: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: 6265,
    kohiHobetsu: "54", kohiUnits: 5670, kohiTargetCost: 62653, kohiHonninFutan: 0, kohiAmount: 6266 },
  // 法別54 が 12/08 開始 (13回 = 7371単位) + 上限1000 → 公費 8145−1000 = 7145 / 本人 5386
  K13: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: 5386,
    kohiHobetsu: "54", kohiUnits: 7371, kohiTargetCost: 81449, kohiHonninFutan: 1000, kohiAmount: 7145 },
  // 公費1=54 フル月で使い切り → 公費2=12 は 12/11開始 (対象費用62653) でも請求 0
  K14: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: 0,
    kohiHobetsu: "54", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: 0, kohiAmount: A1,
    kohi2Hobetsu: "12", kohi2Amount: 0 },

  // ── 負担割合・公費単独・境界 ──────────────────────────
  // 2割 → 保険 100245 / 給付後 25062 を全額公費
  K11: { totalUnits: 11340, totalAmount: T, insuranceAmount: 100245, userAmount: 0,
    kohiHobetsu: "54", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: 0, kohiAmount: 25062 },
  // 公費単独 (被保番 H) → 保険 0 / 公費 = 総額 125307
  K12: { totalUnits: 11340, totalAmount: T, insuranceAmount: 0, userAmount: 0,
    kohiHobetsu: "12", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: 0, kohiAmount: T,
    kohiTandoku: true },
  // 上限 = 給付後負担ちょうど (12531) → 公費 0 / 本人 12531 (境界)
  K15: { totalUnits: 11340, totalAmount: T, insuranceAmount: I1, userAmount: A1,
    kohiHobetsu: "54", kohiUnits: 11340, kohiTargetCost: T, kohiHonninFutan: A1, kohiAmount: 0 },
};

const num = (v: number | null | undefined) => (v == null ? "—" : String(v));

async function main() {
  const [y, m] = META.month.split("-").map(Number);
  const res = await aggregateMonthlyVisitSeikyu(sb, {
    officeId: META.officeId,
    tenantId: META.tenantId,
    year: y,
    month: m,
    unitPrice: META.unitPrice,
    appliedFormulaCodes: [],
  });

  const byClient = new Map<string, UserSeikyuRow>();
  for (const r of res.rows) byClient.set(r.user_id, r);

  console.log(`対象月 ${META.month} / 事業所 ${META.officeId}`);
  console.log(`集計行 ${res.rows.length} 件 (テストケース ${META.cases.length} 件)\n`);

  let pass = 0;
  const fails: string[] = [];

  for (const c of META.cases) {
    const exp = EXPECTED[c.tag];
    if (!exp) { fails.push(`${c.tag}: 期待値が未定義`); continue; }
    const row = byClient.get(c.clientId);
    if (!row) { fails.push(`${c.tag}: 集計結果に行が無い (client ${c.clientId})`); continue; }

    const diffs: string[] = [];
    const chk = (label: string, got: unknown, want: unknown) => {
      if (got !== want) diffs.push(`${label} 実測 ${num(got as number)} ≠ 期待 ${num(want as number)}`);
    };
    chk("総単位数", row.totalUnits, exp.totalUnits);
    chk("総額", row.totalAmount, exp.totalAmount);
    chk("保険請求", row.insuranceAmount, exp.insuranceAmount);
    chk("利用者負担", row.userAmount, exp.userAmount);
    chk("公費1法別", row.kohiHobetsu, exp.kohiHobetsu);
    chk("公費1対象単位", row.kohiUnits, exp.kohiUnits);
    chk("公費1対象費用", row.kohiTargetCost ?? null, exp.kohiTargetCost);
    chk("公費1本人負担", row.kohiHonninFutan ?? null, exp.kohiHonninFutan);
    chk("公費1請求", row.kohiAmount, exp.kohiAmount);
    // 公費2: 併用ケースのみ期待値あり。単独ケースは「未設定であること」を検証する
    chk("公費2法別", row.kohi2Hobetsu ?? null, exp.kohi2Hobetsu ?? null);
    chk("公費2請求", row.kohi2Amount ?? null, exp.kohi2Amount ?? null);
    if (exp.kohiTandoku != null) chk("公費単独", row.kohiTandoku, exp.kohiTandoku);

    // 恒等式: 総額 = 保険 + 公費1 + 公費2 + 本人 (限度額超過なしのため selfPay は 0)
    const sum = row.insuranceAmount + (row.kohiAmount ?? 0) + (row.kohi2Amount ?? 0) + row.userAmount;
    if (sum !== row.totalAmount) {
      diffs.push(`恒等式が破れている: 保険${row.insuranceAmount} + 公費1${row.kohiAmount ?? 0} + 公費2${row.kohi2Amount ?? 0} + 本人${row.userAmount} = ${sum} ≠ 総額${row.totalAmount}`);
    }
    if ((row.selfPayAmount ?? 0) !== 0) {
      diffs.push(`限度額超過の自費が発生している (${row.selfPayAmount}) — 全ケース超過なしの想定`);
    }

    if (diffs.length === 0) {
      pass++;
      console.log(`✓ ${c.tag}  ${c.kohi.padEnd(34)} 保険 ${String(row.insuranceAmount).padStart(6)} / 公費1 ${String(row.kohiAmount ?? 0).padStart(6)} / 公費2 ${String(row.kohi2Amount ?? 0).padStart(5)} / 本人 ${String(row.userAmount).padStart(5)}`);
    } else {
      console.log(`✗ ${c.tag}  ${c.memo}`);
      for (const d of diffs) console.log(`     ${d}`);
      fails.push(`${c.tag}: ${diffs.join(" / ")}`);
    }
  }

  // ── 伝送 (7111 請求書 ↔ 7131 明細書) の突合 ──────────────────
  // 公費請求額が 0 円でも明細書には公費欄が出るため、請求書の件数から漏れると
  // 「明細の件数 > 請求書の件数」になり国保連で返戻になる。
  // 実伝送 (姉ム KK260704.CSV 法別12) は 0 円の 1 件も件数・単位に含めている。
  const built = buildKokuhoDensou(res.rows, {
    officeNumber: "9999999902", year: y, month: m, unitPrice: META.unitPrice,
  });
  const lines = built.content.split(/\r?\n/).filter(Boolean);
  // 項番 N は行の c[N+1] (行頭に レコード種別・連番 の 2 列が付くため)
  const F = (c: string[], n: number) => (c[n + 1] ?? "").replace(/"/g, "").trim();
  const seikyusho = new Map<string, { ken: number; units: number }>();
  const meisai = new Map<string, { ken: number; units: number }>();
  for (const l of lines) {
    const c = l.split(",");
    if (F(c, 1) === "7111" && F(c, 4) === "2") {
      seikyusho.set(F(c, 5), { ken: Number(F(c, 7)), units: Number(F(c, 8)) });
    }
    if (F(c, 1) === "7131" && F(c, 2) === "01") {
      // 請求書は公費1・公費2 を法別ごとに合算するので、明細側も両方数える
      // (負担者番号の先頭 2 桁 = 法別番号)。公費1 だけ数えると併用ぶんが落ちて
      // 「請求書のほうが多い」と誤検出する。
      for (const [futanshaCol, unitCol] of [[7, 39], [9, 45]] as const) {
        const futansha = F(c, futanshaCol);
        if (!futansha) continue;
        const hb = futansha.slice(0, 2);
        const cur = meisai.get(hb) ?? { ken: 0, units: 0 };
        meisai.set(hb, { ken: cur.ken + 1, units: cur.units + Number(F(c, unitCol) || 0) });
      }
    }
  }
  console.log("\n=== 伝送 突合 (法別ごと 明細書 ↔ 請求書) ===");
  const hobetsuAll = new Set([...seikyusho.keys(), ...meisai.keys()]);
  for (const hb of [...hobetsuAll].sort()) {
    const s = seikyusho.get(hb), d = meisai.get(hb);
    const ok = s && d && s.ken === d.ken && s.units === d.units;
    console.log(`  ${ok ? "✓" : "✗"} 法別${hb}  明細 ${d ? `${d.ken}件/${d.units}単位` : "なし"}  ↔  請求書 ${s ? `${s.ken}件/${s.units}単位` : "**行なし**"}`);
    if (!ok) fails.push(`伝送 法別${hb}: 明細 ${d?.ken ?? 0}件/${d?.units ?? 0}単位 ≠ 請求書 ${s?.ken ?? "行なし"}件/${s?.units ?? 0}単位 — 国保連で返戻になる`);
  }

  console.log(`\n${pass}/${META.cases.length} PASS`);
  if (res.warnings.length > 0) {
    console.log(`\n集計 warning ${res.warnings.length} 件:`);
    for (const w of res.warnings) console.log(`  - ${w}`);
  }
  if (fails.length > 0) {
    console.log(`\n★ ${fails.length} 件 FAIL`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
