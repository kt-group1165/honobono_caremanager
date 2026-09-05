/**
 * ⚠ 調査用・常設でない (2026-09-05 分類)。migrations/seed_fake_reseikyu_test.mjs --execute で
 *   投入したサンプルが無いと動かない (撤去済でENOENT)。再度回すには
 *   seed → このscript → delete_fake_reseikyu_test.mjs の順。npm alias は付けない。
 *
 * 月遅れ請求・過誤申立→再請求 の検証
 *
 *   npx tsx scripts/reseikyu-verify.mts
 *
 * migrations/seed_fake_reseikyu_test.mjs で投入したテスト事業所を
 *   ① loadReSeikyuRows (再請求の合流)
 *   ② aggregateMonthlyVisitSeikyu (当月分)
 *   ③ buildKokuhoDensou (提供月ごとの伝送ファイル)
 * に通し、**手計算した期待値**と突合する。
 *
 * ── 手計算の根拠 ────────────────────────────────────────────
 * 実績は全ケース 身体介護３ (567単位) のみ・1日1回。単価 11.05 円 / 1割負担。
 *   2026-10  10回 = 5670 単位  総額 floor(62653.5) = 62653  保険 floor(56387.7) = 56387  本人 6266
 *   2026-11  12回 = 6804 単位  総額 floor(75184.2) = 75184  保険 floor(67665.6) = 67665  本人 7519
 *   2026-12   8回 = 4536 単位  総額 floor(50122.8) = 50122  保険 floor(45109.8) = 45109  本人 5013
 *
 * 伝送は提供月ごとに 1 ファイル。請求月 = 2026-12 なので
 *   処理対象年月 (審査月) = 請求月の翌月 = **202701** (全ファイル共通)
 *   提供年月 = ファイルごとに 202610 / 202611 / 202612
 * ────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateMonthlyVisitSeikyu } from "@/lib/visit-seikyu/aggregate";
import { loadReSeikyuRows } from "@/lib/visit-seikyu/re-seikyu";
import { buildKokuhoDensou, type DensouRow } from "@/lib/kokuho-densou/build";

const META = JSON.parse(
  readFileSync(new URL("../migrations/_fake_reseikyu_test_meta.json", import.meta.url), "utf8"),
) as {
  marker: string; currentMonth: string; officeId: string; unitPrice: number; tenantId: string;
  unit: number; visitsPerMonth: Record<string, number>;
  cases: { tag: string; clientId: string; months: string; status: string; memo: string }[];
};

const env: Record<string, string> = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** 提供月ごとの手計算値 */
const MONTH_AMOUNT: Record<string, { units: number; total: number; insurance: number; user: number }> = {
  "2026-10": { units: 5670, total: 62653, insurance: 56387, user: 6266 },
  "2026-11": { units: 6804, total: 75184, insurance: 67665, user: 7519 },
  "2026-12": { units: 4536, total: 50122, insurance: 45109, user: 5013 },
};

/** 再請求一覧に出るべき行 (tag → 元提供月 → 理由) */
const EXPECT_RESEIKYU: Record<string, { month: string; tsukiokure: boolean; henrei: boolean; kago: boolean; kagoCode?: string | null; kagoDougetsu?: boolean }[]> = {
  R01: [{ month: "2026-10", tsukiokure: true, henrei: false, kago: false }],
  R02: [], // ★ billing_status 行が無い → 出てはいけない
  R03: [], // ★ 既に国保対象化済み → 二重計上になるので出てはいけない
  R04: [{ month: "2026-11", tsukiokure: false, henrei: false, kago: true, kagoCode: "1002", kagoDougetsu: false }],
  R05: [{ month: "2026-11", tsukiokure: false, henrei: false, kago: true, kagoCode: "1012", kagoDougetsu: true }],
  R06: [{ month: "2026-11", tsukiokure: false, henrei: true, kago: false }],
  R07: [{ month: "2026-10", tsukiokure: true, henrei: false, kago: false }],
  R08: [],
  R09: [
    { month: "2026-10", tsukiokure: true, henrei: false, kago: false },
    { month: "2026-11", tsukiokure: true, henrei: false, kago: false },
  ],
  R10: [{ month: "2026-11", tsukiokure: true, henrei: false, kago: true, kagoCode: "1002", kagoDougetsu: false }],
};

/** 当月 (2026-12) の通常集計に出るべき利用者 */
const EXPECT_CURRENT = ["R07", "R08"];

async function main() {
  const fails: string[] = [];
  const tagOf = new Map(META.cases.map((c) => [c.clientId, c.tag]));
  const idOf = new Map(META.cases.map((c) => [c.tag, c.clientId]));
  const [cy, cm] = META.currentMonth.split("-").map(Number);

  // ── ① 再請求の合流 ────────────────────────────────────────
  const re = await loadReSeikyuRows(sb, {
    officeId: META.officeId, tenantId: META.tenantId,
    unitPrice: META.unitPrice, appliedFormulaCodes: [],
    currentMonthKey: META.currentMonth,
  });
  console.log(`請求月 ${META.currentMonth} / 事業所 ${META.officeId}`);
  console.log(`\n=== ① 再請求の合流: ${re.rows.length} 行 ===`);
  const gotRe = new Map<string, { month: string; tsukiokure: boolean; henrei: boolean; kago: boolean; kagoCode: string | null; kagoDougetsu: boolean; total: number; insurance: number; user: number }[]>();
  for (const r of re.rows) {
    const tag = tagOf.get(r.user_id) ?? "?";
    const list = gotRe.get(tag) ?? [];
    list.push({
      month: r.__origMonthKey,
      tsukiokure: r.__reasons.tsukiokure, henrei: r.__reasons.henrei, kago: r.__reasons.kago,
      kagoCode: r.__kago?.jiyuCode ?? null, kagoDougetsu: r.__kago?.dougetsu ?? false,
      total: r.totalAmount, insurance: r.insuranceAmount, user: r.userAmount,
    });
    gotRe.set(tag, list);
  }

  for (const c of META.cases) {
    const exp = EXPECT_RESEIKYU[c.tag] ?? [];
    const got = (gotRe.get(c.tag) ?? []).sort((a, b) => a.month.localeCompare(b.month));
    const diffs: string[] = [];
    if (got.length !== exp.length) {
      diffs.push(`行数 実測 ${got.length} ≠ 期待 ${exp.length}${exp.length === 0 ? " (★出てはいけない行が出ている = 二重計上)" : ""}`);
    } else {
      for (let i = 0; i < exp.length; i++) {
        const e = exp[i], g = got[i];
        if (g.month !== e.month) diffs.push(`[${i}] 元提供月 ${g.month} ≠ ${e.month}`);
        if (g.tsukiokure !== e.tsukiokure) diffs.push(`[${i}] 月遅れ ${g.tsukiokure} ≠ ${e.tsukiokure}`);
        if (g.henrei !== e.henrei) diffs.push(`[${i}] 返戻 ${g.henrei} ≠ ${e.henrei}`);
        if (g.kago !== e.kago) diffs.push(`[${i}] 過誤 ${g.kago} ≠ ${e.kago}`);
        if (e.kagoCode !== undefined && g.kagoCode !== e.kagoCode) diffs.push(`[${i}] 事由コード ${g.kagoCode} ≠ ${e.kagoCode}`);
        if (e.kagoDougetsu !== undefined && g.kagoDougetsu !== e.kagoDougetsu) diffs.push(`[${i}] 同月過誤 ${g.kagoDougetsu} ≠ ${e.kagoDougetsu}`);
        const a = MONTH_AMOUNT[e.month];
        if (g.total !== a.total) diffs.push(`[${i}] 総額 ${g.total} ≠ ${a.total}`);
        if (g.insurance !== a.insurance) diffs.push(`[${i}] 保険 ${g.insurance} ≠ ${a.insurance}`);
        if (g.user !== a.user) diffs.push(`[${i}] 本人 ${g.user} ≠ ${a.user}`);
      }
    }
    const label = got.length === 0 ? "(出ない)" : got.map((g) => `${g.month}:${[g.tsukiokure && "月遅", g.henrei && "返戻", g.kago && "過誤"].filter(Boolean).join("+")}:¥${g.total}`).join(" ");
    if (diffs.length === 0) console.log(`  ✓ ${c.tag}  ${label}`);
    else { console.log(`  ✗ ${c.tag}  ${c.memo}`); for (const d of diffs) console.log(`       ${d}`); fails.push(`${c.tag}: ${diffs.join(" / ")}`); }
  }

  // ── ② 当月分の集計 ────────────────────────────────────────
  const cur = await aggregateMonthlyVisitSeikyu(sb, {
    officeId: META.officeId, tenantId: META.tenantId, year: cy, month: cm,
    unitPrice: META.unitPrice, appliedFormulaCodes: [],
  });
  const curTags = cur.rows.map((r) => tagOf.get(r.user_id) ?? "?").sort();
  console.log(`\n=== ② 当月 (${META.currentMonth}) の通常集計: ${cur.rows.length} 行 ===`);
  console.log(`  実測 ${JSON.stringify(curTags)} / 期待 ${JSON.stringify(EXPECT_CURRENT)}`);
  if (JSON.stringify(curTags) !== JSON.stringify([...EXPECT_CURRENT].sort())) {
    fails.push(`当月集計の顔ぶれが違う: ${curTags.join(",")} ≠ ${EXPECT_CURRENT.join(",")}`);
  }
  for (const r of cur.rows) {
    const a = MONTH_AMOUNT[META.currentMonth];
    if (r.totalAmount !== a.total) fails.push(`当月 ${tagOf.get(r.user_id)}: 総額 ${r.totalAmount} ≠ ${a.total}`);
  }
  // ★ R07 は当月と月遅れの両方に出る。金額が合算されず別々であること
  const r07Cur = cur.rows.find((r) => r.user_id === idOf.get("R07"));
  const r07Re = (gotRe.get("R07") ?? [])[0];
  if (r07Cur && r07Re) {
    const ok = r07Cur.totalAmount === MONTH_AMOUNT["2026-12"].total && r07Re.total === MONTH_AMOUNT["2026-10"].total;
    console.log(`  ${ok ? "✓" : "✗"} R07 当月 ¥${r07Cur.totalAmount} (202612) と 月遅れ ¥${r07Re.total} (202610) が別建て`);
    if (!ok) fails.push(`R07: 当月と月遅れの金額が想定外 (${r07Cur.totalAmount} / ${r07Re.total})`);
  } else fails.push("R07 が当月と月遅れの両方に出ていない");

  // ── ③ 伝送 (提供月ごとに 1 ファイル) ──────────────────────
  console.log(`\n=== ③ 伝送: 提供月ごとのファイル ===`);
  const byMonth = new Map<string, DensouRow[]>();
  for (const r of re.rows) {
    if (!byMonth.has(r.__origMonthKey)) byMonth.set(r.__origMonthKey, []);
    byMonth.get(r.__origMonthKey)!.push(r as DensouRow);
  }
  byMonth.set(META.currentMonth, cur.rows as DensouRow[]);

  for (const [mKey, rows] of [...byMonth.entries()].sort()) {
    const [oy, om] = mKey.split("-").map(Number);
    const built = buildKokuhoDensou(rows, {
      officeNumber: "9999999903", year: oy, month: om, unitPrice: META.unitPrice,
      seikyuYear: cy, seikyuMonth: cm, // 請求月 = 2026-12 → 審査月 202701
    });
    const lines = built.content.split(/\r?\n/).filter(Boolean);
    const ctrl = lines[0].split(",");
    const shinsaYm = ctrl[10];
    // 項番 N は c[N+1] (行頭に レコード種別・連番 の 2 列が付くため)
    const F = (c: string[], n: number) => (c[n + 1] ?? "").replace(/"/g, "").trim();
    const teikyoYms = new Set<string>();
    let meisaiCount = 0;
    for (const l of lines) {
      const c = l.split(",");
      if (F(c, 1) === "7131" && F(c, 2) === "01") { meisaiCount++; teikyoYms.add(F(c, 3)); }
    }
    const expYm = `${oy}${String(om).padStart(2, "0")}`;
    const okYm = teikyoYms.size === 1 && teikyoYms.has(expYm);
    const okShinsa = shinsaYm === "202701";
    const okCount = meisaiCount === rows.length;
    console.log(`  ${okYm && okShinsa && okCount ? "✓" : "✗"} ${mKey} ${built.fileName}  明細 ${meisaiCount}件 (期待 ${rows.length})  提供年月 ${[...teikyoYms].join("/")} (期待 ${expYm})  処理対象年月 ${shinsaYm} (期待 202701)`);
    if (!okYm) fails.push(`伝送 ${mKey}: 提供年月が ${[...teikyoYms].join("/")} (期待 ${expYm})`);
    if (!okShinsa) fails.push(`伝送 ${mKey}: 処理対象年月が ${shinsaYm} (期待 202701 = 請求月の翌月)`);
    if (!okCount) fails.push(`伝送 ${mKey}: 明細 ${meisaiCount} 件 ≠ 対象 ${rows.length} 行`);
  }

  // ── 二重計上の総額チェック ────────────────────────────────
  const reSum = re.rows.reduce((s, r) => s + r.totalAmount, 0);
  const curSum = cur.rows.reduce((s, r) => s + r.totalAmount, 0);
  // 期待: 再請求 = R01,R07(10月) + R09(10月,11月) + R04,R05,R06,R10(11月)
  const expRe = MONTH_AMOUNT["2026-10"].total * 3 + MONTH_AMOUNT["2026-11"].total * 5;
  const expCur = MONTH_AMOUNT["2026-12"].total * 2;
  console.log(`\n=== 総額 ===`);
  console.log(`  ${reSum === expRe ? "✓" : "✗"} 再請求 合計 ¥${reSum} (期待 ¥${expRe} = 10月分×3 + 11月分×5)`);
  console.log(`  ${curSum === expCur ? "✓" : "✗"} 当月   合計 ¥${curSum} (期待 ¥${expCur} = 12月分×2)`);
  if (reSum !== expRe) fails.push(`再請求 合計 ${reSum} ≠ ${expRe}`);
  if (curSum !== expCur) fails.push(`当月 合計 ${curSum} ≠ ${expCur}`);

  // ── ④ 同一提供月を 2 回出すサイクル (月遅れ → 提出 → 過誤申立 → 再請求) ──
  // R01 (2026-10 月遅れ) の状態を遷移させ、各段階で再請求一覧に出るかを見る。
  // ⚠ 触るのは marker 付きテスト行のみ (notes で必ず絞る)。
  console.log(`\n=== ④ 同一提供月を 2 回出すサイクル (R01 / 2026-10) ===`);
  const r01Id = idOf.get("R01")!;
  const countR01 = async () => {
    const r = await loadReSeikyuRows(sb, {
      officeId: META.officeId, tenantId: META.tenantId,
      unitPrice: META.unitPrice, appliedFormulaCodes: [],
      currentMonthKey: META.currentMonth,
    });
    const hits = r.rows.filter((x) => x.user_id === r01Id);
    return { n: hits.length, total: hits[0]?.totalAmount ?? null, kago: hits[0]?.__reasons.kago ?? null };
  };
  const setStatus = async (patch: Record<string, unknown>, label: string) => {
    const { error } = await sb
      .from("kaigo_billing_status")
      .update(patch)
      .eq("client_id", r01Id)
      .eq("target_month", "2026-10")
      .eq("notes", META.marker); // ★ marker 付きテスト行だけ
    if (error) throw new Error(`${label} の状態更新に失敗: ${error.message}`);
  };

  const phases: { label: string; patch: Record<string, unknown> | null; expN: number; expKago?: boolean }[] = [
    { label: "1. 月遅れ (未提出)", patch: null, expN: 1 },
    { label: "2. 国保対象化 = 提出済", patch: { kokuho_target: true }, expN: 0 },
    { label: "3. 過誤申立 = 取下げ", patch: { kokuho_target: false, kago: true, kago_moushitate_date: "2026-12-05", kago_jiyu_code: "1002", kago_dougetsu: false }, expN: 1, expKago: true },
    { label: "4. 再請求も提出済に", patch: { kokuho_target: true }, expN: 0 },
  ];
  for (const p of phases) {
    if (p.patch) await setStatus(p.patch, p.label);
    const got = await countR01();
    const ok = got.n === p.expN && (p.expKago === undefined || got.kago === p.expKago);
    const amountOk = got.n === 0 || got.total === MONTH_AMOUNT["2026-10"].total;
    console.log(`  ${ok && amountOk ? "✓" : "✗"} ${p.label.padEnd(22)} 再請求に ${got.n} 行 (期待 ${p.expN})${got.total != null ? ` ¥${got.total}` : ""}${p.expKago !== undefined ? ` 過誤=${got.kago}` : ""}`);
    if (!ok) fails.push(`サイクル ${p.label}: ${got.n} 行 (期待 ${p.expN})${p.expKago !== undefined ? ` / 過誤 ${got.kago} (期待 ${p.expKago})` : ""}`);
    if (!amountOk) fails.push(`サイクル ${p.label}: 金額 ${got.total} ≠ ${MONTH_AMOUNT["2026-10"].total}`);
  }
  // 状態を元に戻す (他の検証を繰り返し回せるように)
  await setStatus({ kokuho_target: false, kago: false, kago_moushitate_date: null, kago_jiyu_code: null, kago_dougetsu: false }, "復元");
  const restored = await countR01();
  console.log(`  ${restored.n === 1 ? "✓" : "✗"} (復元) 月遅れ状態に戻した → 再請求に ${restored.n} 行`);
  if (restored.n !== 1) fails.push("サイクル後の状態復元に失敗");

  if (re.warnings.length > 0) {
    console.log(`\n再集計 warning ${re.warnings.length} 件:`);
    for (const w of re.warnings.slice(0, 5)) console.log(`  - ${w}`);
  }
  if (fails.length > 0) { console.log(`\n★ ${fails.length} 件 FAIL`); process.exit(1); }
  console.log(`\nすべて PASS`);
}

main().catch((e) => { console.error(e); process.exit(1); });
