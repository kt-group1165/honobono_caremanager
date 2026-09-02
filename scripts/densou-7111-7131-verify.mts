/**
 * 介護保険 伝送 (7111 請求書 / 7131 明細書) の検証 — **DB を一切触らない**
 *
 *   npx tsx scripts/densou-7111-7131-verify.mts
 *
 * buildKokuhoDensou は純関数 (rows + opts → 文字列) なので、in-memory の
 * fixture を組んで検算する。テストデータの投入・削除が要らないので
 * いつでも回せる = 回帰テストとして常設できる。
 *
 * ── 何を見るか ────────────────────────────────────────────
 * 国保連が突合するのは「請求書と明細書が整合しているか」なので、
 * 個々の金額よりも **レコード間の恒等式** を確かめる。
 *
 *   A. 7111 保険請求分(項7-12) == 明細書の合計 (件数/単位/費用/保険/公費/利用者負担)
 *   B. 7111 公費請求分(法別ごと 項7-8) == その法別の明細書の 件数/公費対象単位
 *      ★ 公費請求額 0 円の利用者も件数・単位に**含まれる** (2026-09-03 の是正。回帰テスト)
 *   C. Σ明細02(項14) == 集計10(項10 限度額管理対象) + (項11 管理対象外)
 *   D. Σ明細02(項15 公費1対象単位) == 集計10(項18 公費対象単位数)
 *   E. 明細行は **サービスコード昇順** (ほのぼの実伝送 1,969 グループすべてこの順)
 *   F. 回数 > 99 は warning が出る (項10 が数字2桁のため桁溢れ)
 *   G. 公費単独 (被保番 H) は 7111 保険請求分の件数に入らない
 *   H. 月途中の保険者変更 (分割レセプト) は別々の明細書として出る
 * ────────────────────────────────────────────────────────
 */
import { buildKokuhoDensou, type DensouRow } from "@/lib/kokuho-densou/build";
import type { SeikyuDetailLine, UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";

const UNIT_PRICE = 11.05;
const OFFICE = "9999999911";
const YEAR = 2026;
const MONTH = 6; // 実データ突合 (7131 で 1,565/1,608) と同じ提供月に揃える

/** 明細行を 1 本作る */
const line = (
  code: string,
  unitPer: number,
  count: number,
  extra: Partial<SeikyuDetailLine> = {},
): SeikyuDetailLine => ({
  service_type: `svc-${code}`,
  short_name: null,
  service_code: code,
  unit_per: unitPer,
  count,
  units: unitPer * count,
  ...extra,
});

/**
 * UserSeikyuRow の fixture。金額系は呼出側が明示的に渡す
 * (集計ロジックの再実装をしないため。ここで見たいのは伝送の組み立てだけ)。
 */
const row = (o: Partial<UserSeikyuRow> & { user_id: string; details: SeikyuDetailLine[] }): DensouRow => {
  const baseUnits = o.baseUnits ?? o.details.reduce((s, d) => s + d.units, 0);
  const addonUnits = o.addonUnits ?? 0;
  const totalUnits = o.totalUnits ?? baseUnits + addonUnits;
  const totalAmount = o.totalAmount ?? Math.floor((totalUnits * Math.round(UNIT_PRICE * 100)) / 100);
  const copay = o.copay_rate ?? 0.1;
  const insuranceAmount =
    o.insuranceAmount ?? (o.kohiTandoku ? 0 : Math.floor((totalAmount * (10 - Math.round(copay * 10))) / 10));
  return {
    user_id: o.user_id,
    user_name: o.user_name ?? `利用者${o.user_id}`,
    user_name_kana: null,
    user_number: null,
    insurer_number: o.insurer_number ?? "121012",
    insurer_name: "千葉市",
    insured_number: o.insured_number ?? `900000000${o.user_id}`,
    care_level: o.care_level ?? "要介護5",
    copay_rate: copay,
    details: o.details,
    grossBaseUnits: o.grossBaseUnits ?? baseUnits + (o.overUnits ?? 0),
    limitUnits: o.limitUnits ?? null,
    planUnits: o.planUnits ?? null,
    overUnits: o.overUnits ?? 0,
    overSource: "auto",
    overAmount: o.overAmount ?? 0,
    selfPayAmount: o.selfPayAmount ?? 0,
    baseUnits,
    addonUnits,
    kanriTaishougaiUnits: o.kanriTaishougaiUnits ?? addonUnits,
    addonLabel: o.addonLabel ?? null,
    totalUnits,
    unitPrice: UNIT_PRICE,
    totalAmount,
    insuranceAmount,
    userAmount: o.userAmount ?? totalAmount - insuranceAmount - (o.kohiAmount ?? 0) - (o.kohi2Amount ?? 0),
    publicExpense: o.publicExpense ?? null,
    kohiTandoku: o.kohiTandoku ?? false,
    kohiHobetsu: o.kohiHobetsu ?? null,
    kohiFutanshaNumber: o.kohiFutanshaNumber ?? null,
    kohiJukyushaNumber: o.kohiJukyushaNumber ?? null,
    kohiUnits: o.kohiUnits ?? null,
    kohiAmount: o.kohiAmount ?? null,
    kohiTargetCost: o.kohiTargetCost,
    kohiTargetInsurance: o.kohiTargetInsurance,
    kohiHonninFutan: o.kohiHonninFutan,
    kohi2Hobetsu: o.kohi2Hobetsu,
    kohi2FutanshaNumber: o.kohi2FutanshaNumber,
    kohi2JukyushaNumber: o.kohi2JukyushaNumber,
    kohi2Units: o.kohi2Units,
    kohi2Amount: o.kohi2Amount,
    kohi2TargetCost: o.kohi2TargetCost,
    kohi2TargetInsurance: o.kohi2TargetInsurance,
    kohi2HonninFutan: o.kohi2HonninFutan,
    addonCode: o.addonCode ?? null,
    birthDate: "1938-01-01",
    gender: "女",
    certStart: "2026-04-01",
    certEnd: "2027-03-31",
    careOfficeNumber: "1279999999",
    careOfficeName: "テスト居宅",
    planCreatorKubun: o.planCreatorKubun ?? "1",
    serviceStartDate: null,
    serviceDays: o.serviceDays ?? 10,
    segmentIndex: o.segmentIndex,
    segmentCount: o.segmentCount,
    periodFrom: o.periodFrom,
    periodTo: o.periodTo,
  } as DensouRow;
};

// 項番 N は行の c[N+1] (行頭に レコード種別・連番 の 2 列が付くため)
const F = (c: string[], n: number) => (c[n + 1] ?? "").replace(/"/g, "").trim();
const num = (s: string) => (s === "" ? 0 : Number(s));

interface Parsed {
  hoken: string[] | null;
  kohi: Map<string, string[]>;
  basics: string[][];
  details: string[][];
  totals: string[][];
}
function parse(content: string): Parsed {
  const out: Parsed = { hoken: null, kohi: new Map(), basics: [], details: [], totals: [] };
  for (const l of content.split(/\r?\n/).filter(Boolean)) {
    const c = l.split(",");
    const kind = F(c, 1);
    if (kind === "7111") {
      if (F(c, 4) === "1") out.hoken = c;
      else out.kohi.set(F(c, 5), c);
    } else if (kind === "7131") {
      const t = F(c, 2);
      if (t === "01") out.basics.push(c);
      else if (t === "02") out.details.push(c);
      else if (t === "10") out.totals.push(c);
    }
  }
  return out;
}

const fails: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

function build(rows: DensouRow[]) {
  const r = buildKokuhoDensou(rows, { officeNumber: OFFICE, year: YEAR, month: MONTH, unitPrice: UNIT_PRICE });
  return { ...r, p: parse(r.content) };
}

// ══════════════════════════════════════════════════════════════
console.log(`介護保険 伝送 (7111/7131) の検証 — DB 不使用 / 提供月 ${YEAR}-${String(MONTH).padStart(2, "0")}\n`);

// ── A. 請求書(保険請求分) == 明細書の合計 ──────────────────────
console.log("=== A. 7111 保険請求分 == 明細書の合計 ===");
{
  const rows = [
    row({ user_id: "1", details: [line("111311", 567, 10)], serviceDays: 10 }),
    row({ user_id: "2", details: [line("111211", 387, 8), line("112097", 179, 4)], serviceDays: 12 }),
    row({ user_id: "3", details: [line("111111", 244, 5)], addonUnits: 200, addonCode: "116275", serviceDays: 5 }),
  ];
  const { p } = build(rows);
  const expUnits = rows.reduce((s, r) => s + r.totalUnits, 0);
  const expCost = rows.reduce((s, r) => s + r.totalAmount, 0);
  const expIns = rows.reduce((s, r) => s + r.insuranceAmount, 0);
  const expUser = rows.reduce((s, r) => s + r.userAmount, 0);
  check(p.hoken !== null, "保険請求分レコードが 1 本ある");
  check(num(F(p.hoken!, 7)) === rows.length, "項7 件数", `${F(p.hoken!, 7)} (期待 ${rows.length})`);
  check(num(F(p.hoken!, 8)) === expUnits, "項8 単位数", `${F(p.hoken!, 8)} (期待 ${expUnits})`);
  check(num(F(p.hoken!, 9)) === expCost, "項9 費用合計", `${F(p.hoken!, 9)} (期待 ${expCost})`);
  check(num(F(p.hoken!, 10)) === expIns, "項10 保険請求額", `${F(p.hoken!, 10)} (期待 ${expIns})`);
  check(num(F(p.hoken!, 12)) === expUser, "項12 利用者負担", `${F(p.hoken!, 12)} (期待 ${expUser})`);
  check(p.basics.length === rows.length, "明細書(基本01) の数", `${p.basics.length} (期待 ${rows.length})`);
  check(p.totals.length === rows.length, "明細書(集計10) の数", `${p.totals.length} (期待 ${rows.length})`);
}

// ── B. 公費: 請求額 0 円でも請求書に載る (2026-09-03 是正の回帰テスト) ──
console.log("\n=== B. 公費請求額 0 円の利用者が請求書から落ちないか (回帰テスト) ===");
{
  const rows = [
    // 法別54: 通常 (請求額あり)
    row({ user_id: "1", details: [line("111311", 567, 10)], kohiHobetsu: "54",
      kohiFutanshaNumber: "54121010", kohiJukyushaNumber: "9900001",
      kohiUnits: 5670, kohiTargetCost: 62653, kohiTargetInsurance: 56387,
      kohiHonninFutan: 0, kohiAmount: 6266 }),
    // 法別54: 本人負担上限 = 給付後負担 → 公費請求額 0 円 (★これが落ちていた)
    row({ user_id: "2", details: [line("111311", 567, 10)], kohiHobetsu: "54",
      kohiFutanshaNumber: "54121010", kohiJukyushaNumber: "9900002",
      kohiUnits: 5670, kohiTargetCost: 62653, kohiTargetInsurance: 56387,
      kohiHonninFutan: 6266, kohiAmount: 0 }),
    // 法別19: その法別で唯一の利用者が 0 円 → 法別行ごと消えていた
    row({ user_id: "3", details: [line("111311", 567, 10)], kohiHobetsu: "19",
      kohiFutanshaNumber: "19121016", kohiJukyushaNumber: "9900003",
      kohiUnits: 5670, kohiTargetCost: 62653, kohiTargetInsurance: 56387,
      kohiHonninFutan: 6266, kohiAmount: 0 }),
  ];
  const { p } = build(rows);
  const k54 = p.kohi.get("54");
  const k19 = p.kohi.get("19");
  check(!!k54, "法別54 の公費請求分レコードがある");
  check(!!k19, "法別19 の公費請求分レコードがある (★0円のみの法別。以前は行ごと欠落)");
  if (k54) check(num(F(k54, 7)) === 2, "法別54 件数", `${F(k54, 7)} (期待 2 = 0円の1件を含む)`);
  if (k54) check(num(F(k54, 8)) === 11340, "法別54 単位数", `${F(k54, 8)} (期待 11340 = 5670×2)`);
  if (k54) check(num(F(k54, 11)) === 6266, "法別54 公費請求額", `${F(k54, 11)} (期待 6266 = 0円は寄与しない)`);
  if (k19) check(num(F(k19, 7)) === 1 && num(F(k19, 11)) === 0, "法別19 件数1 / 請求額0", `件数${F(k19, 7)} 請求額${F(k19, 11)}`);
  // 明細書の件数と一致するか (国保連の突合軸)
  for (const [hb, rec] of p.kohi) {
    const meisai = p.basics.filter((c) => F(c, 7).slice(0, 2) === hb || F(c, 9).slice(0, 2) === hb).length;
    check(num(F(rec, 7)) === meisai, `法別${hb} 請求書の件数 == 明細書の件数`, `請求書 ${F(rec, 7)} / 明細 ${meisai}`);
  }
}

// ── C/D. 明細 02 と 集計 10 の恒等式 ──────────────────────────
console.log("\n=== C/D. 明細02 と 集計10 の恒等式 ===");
{
  // 限度額超過あり + 処遇改善加算あり + 部分公費 (期間按分) の複合
  const details = [line("111311", 567, 20, { kohi_count: 10, kohi_units: 5670 })];
  const rows = [
    row({
      user_id: "1", details,
      baseUnits: 11340, overUnits: 0, addonUnits: 800, addonCode: "116275",
      kanriTaishougaiUnits: 800, totalUnits: 12140, serviceDays: 20,
      kohiHobetsu: "54", kohiFutanshaNumber: "54121010", kohiJukyushaNumber: "9900001",
      kohiUnits: 6070, kohiTargetCost: 67073, kohiTargetInsurance: 60365,
      kohiHonninFutan: 0, kohiAmount: 6708,
    }),
  ];
  const { p } = build(rows);
  const sum14 = p.details.reduce((s, c) => s + num(F(c, 14)), 0);
  const t = p.totals[0];
  const kanriIn = num(F(t, 10));
  const kanriGai = num(F(t, 11));
  check(sum14 === kanriIn + kanriGai, "C: Σ明細02(項14) == 集計10(項10 + 項11)",
    `Σ${sum14} vs ${kanriIn}+${kanriGai}=${kanriIn + kanriGai}`);
  const sum15 = p.details.reduce((s, c) => s + num(F(c, 15)), 0);
  check(sum15 === num(F(t, 18)), "D: Σ明細02(項15 公費1対象単位) == 集計10(項18)",
    `Σ${sum15} vs ${F(t, 18)}`);
  check(num(F(t, 14)) === 12140, "集計10(項14 保険単位数合計) == totalUnits", `${F(t, 14)}`);
  check(num(F(t, 15)) === 1105, "集計10(項15 単位数単価) == 単価×100", `${F(t, 15)}`);
}

// ── C'. 限度額超過があるとき ──────────────────────────────────
console.log("\n=== C'. 限度額超過あり (超過分は保険請求外) ===");
{
  // 実績 20,000 単位 / 限度額 19,705 → 超過 295。基準内 19,705 が保険対象
  const rows = [
    row({
      user_id: "1", details: [line("111311", 500, 40)], // 20,000
      grossBaseUnits: 20000, baseUnits: 19705, overUnits: 295, limitUnits: 19705,
      addonUnits: 0, kanriTaishougaiUnits: 0, totalUnits: 19705,
      selfPayAmount: 3259, serviceDays: 20,
    }),
  ];
  const { p } = build(rows);
  const t = p.totals[0];
  const sum14 = p.details.reduce((s, c) => s + num(F(c, 14)), 0);
  check(sum14 === 20000, "明細02 は実績全量 (20,000単位) で出る", `Σ${sum14}`);
  check(num(F(t, 10)) === 20000, "集計10(項10 限度額管理対象) = 実績全量", `${F(t, 10)}`);
  check(num(F(t, 14)) === 19705, "集計10(項14 保険単位数合計) = 基準内のみ", `${F(t, 14)}`);
  check(num(F(t, 9)) === 19705, "集計10(項9 計画単位数) = 限度額", `${F(t, 9)}`);
  check(sum14 === num(F(t, 10)) + num(F(t, 11)), "C: Σ明細02(14) == 項10 + 項11",
    `${sum14} vs ${num(F(t, 10))}+${num(F(t, 11))}`);
}

// ── E. 明細行はサービスコード昇順 ─────────────────────────────
console.log("\n=== E. 明細行の並び (サービスコード昇順) ===");
{
  const rows = [row({ user_id: "1",
    details: [line("112097", 179, 4), line("111311", 567, 10), line("111211", 387, 8)],
    addonUnits: 300, addonCode: "116275" })];
  const { p } = build(rows);
  const codes = p.details.map((c) => F(c, 7) + F(c, 8));
  const sorted = [...codes].sort((a, b) => a.localeCompare(b));
  check(JSON.stringify(codes) === JSON.stringify(sorted), "サービスコード昇順", codes.join(" < "));
}

// ── F. 回数 99 超の warning ───────────────────────────────────
console.log("\n=== F. 回数が 99 を超えたら warning (項10 は数字2桁) ===");
{
  const okRows = [row({ user_id: "1", details: [line("111311", 567, 99)] })];
  const ngRows = [row({ user_id: "1", details: [line("111311", 567, 100)] })];
  const okW = build(okRows).warnings.filter((w) => w.includes("上限99"));
  const ngW = build(ngRows).warnings.filter((w) => w.includes("上限99"));
  check(okW.length === 0, "99 回は warning なし", `${okW.length} 件`);
  check(ngW.length === 1, "100 回は warning あり", `${ngW.length} 件`);
}

// ── G. 公費単独は保険請求分に入らない ─────────────────────────
console.log("\n=== G. 公費単独 (被保番 H) は 7111 保険請求分に入らない ===");
{
  const rows = [
    row({ user_id: "1", details: [line("111311", 567, 10)] }),
    row({ user_id: "2", insured_number: "H900000002", details: [line("111311", 567, 10)],
      kohiTandoku: true, kohiHobetsu: "12", kohiFutanshaNumber: "12121014",
      kohiJukyushaNumber: "9900002", kohiUnits: 5670, kohiTargetCost: 62653,
      kohiTargetInsurance: 0, kohiHonninFutan: 0, kohiAmount: 62653 }),
  ];
  const { p } = build(rows);
  check(num(F(p.hoken!, 7)) === 1, "保険請求分 件数 = 1 (公費単独を除く)", `${F(p.hoken!, 7)}`);
  check(p.basics.length === 2, "明細書は 2 件 (公費単独も明細は出る)", `${p.basics.length}`);
  const k12 = p.kohi.get("12");
  check(!!k12 && num(F(k12, 11)) === 62653, "法別12 に 10割公費が乗る", k12 ? F(k12, 11) : "行なし");
}

// ── H. 月途中の保険者変更 (分割レセプト) ──────────────────────
console.log("\n=== H. 分割レセプト (月途中の保険者変更) は別々の明細書になる ===");
{
  const rows = [
    row({ user_id: "1", insurer_number: "121012", insured_number: "9900000101",
      details: [line("111311", 567, 10)], segmentIndex: 0, segmentCount: 2,
      periodFrom: "2026-06-01", periodTo: "2026-06-15", serviceDays: 10 }),
    row({ user_id: "1", insurer_number: "122011", insured_number: "9900000102",
      details: [line("111311", 567, 8)], segmentIndex: 1, segmentCount: 2,
      periodFrom: "2026-06-16", periodTo: "2026-06-30", serviceDays: 8 }),
  ];
  const { p } = build(rows);
  check(p.basics.length === 2, "明細書が 2 件", `${p.basics.length}`);
  const insurers = p.basics.map((c) => F(c, 5));
  const insureds = p.basics.map((c) => F(c, 6));
  check(new Set(insurers).size === 2, "保険者番号が 2 種類", insurers.join(","));
  check(new Set(insureds).size === 2, "被保険者番号が 2 種類", insureds.join(","));
  check(num(F(p.hoken!, 7)) === 2, "請求書の件数も 2 (片方が消えない)", `${F(p.hoken!, 7)}`);
}

// ── I. サービス種別の混在 ─────────────────────────────────────
console.log("\n=== I. 1 利用者の明細にサービス種別 (先頭2桁) が混在した場合 ===");
{
  const rows = [row({ user_id: "1", details: [line("111311", 567, 10), line("121311", 500, 5)] })];
  const { p } = build(rows);
  const kinds = new Set(p.details.map((c) => F(c, 7)));
  const totalKind = F(p.totals[0], 7);
  console.log(`  明細のサービス種類コード: ${[...kinds].join(",")} / 集計10(項7): ${totalKind}`);
  console.log(`  集計10 は 1 本のみ (${p.totals.length} 本)`);
  if (kinds.size > 1 && p.totals.length === 1) {
    console.log(`  ⚠ 種別が混在しても集計10 は 1 本で、種類コードは先頭行の ${totalKind} になる。`);
    console.log(`     様式第二の集計情報レコードは**サービス種類ごと**なので、混在すると仕様違反。`);
    console.log(`     → 実データで混在が起きるかを別途測る (訪問介護1事業所なら通常 11 のみ)`);
  }
}

console.log(`\n${fails.length === 0 ? "すべて PASS" : `★ ${fails.length} 件 FAIL`}`);
for (const f of fails) console.log(`  - ${f}`);
if (fails.length > 0) process.exit(1);
