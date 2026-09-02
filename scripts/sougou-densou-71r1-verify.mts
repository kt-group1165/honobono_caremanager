/**
 * 総合事業 伝送 (7113 請求書 / 71R1 明細書) の**項番ベース**検証 — DB 不使用
 *
 *   npx tsx scripts/sougou-densou-71r1-verify.mts
 *
 * ⚠ 既存の scripts/sougou-verify.mts (G 担当) と役割を分ける:
 *   あちら = splitSougouCode / 保険者別のファイル分割 / 住所地特例 種別14 / 単価マップ網羅性
 *   こちら = **レコード間の恒等式**と**項番位置**の検証 (7111/7131 で使ったのと同じ観点)
 *
 * ⚠ 位置で見る理由: 値の存在だけを見る assertion は誤って通る。
 *   実例 (sougou-verify.mts §5): `rec7113.includes("2")` で「件数2」を確かめているが、
 *   データレコードは **index 0 が必ず "2" (レコード種別)** なので、
 *   件数が何であっても通ってしまう。項番の位置で見れば防げる。
 *
 * ── この検査が証明すること ────────────────────────────────
 *   A. 7113 保険請求分 項7-12 == 明細書の合計 (件数/単位/費用/事業費請求額/公費/利用者負担)
 *   B. 公費: 法別ごとの請求書 件数 == その法別の明細書の件数
 *      ★ 公費請求額 0 円の利用者が請求書から落ちないか (介護 7111 と同じ型の穴)
 *   C. Σ明細(02/14 項14) == 集計10(項10 + 項11)
 *   D. 住所地特例 (種別14) も 02 と同じく合計に含まれる
 *   E. 項番の位置が仕様どおり (7113 は 12 項目)
 * ────────────────────────────────────────────────────────
 */
import { buildSougouDensou, type SougouDensouRow } from "@/lib/kokuho-densou/build-sougou";

const OFFICE = "12A8600011";
const YEAR = 2026;
const MONTH = 6;
const UNIT_PRICE = 10;

const row = (o: {
  name: string; insured: string; units: number;
  /** 保険者 (市町村)。総合事業は**保険者ごとに単価が決まる**ので既定と変えられる */
  insurer?: string;
  /** 単位数単価。保険者スコープなので利用者ごとに違いうる (同一ファイル内で最大4種の実例あり) */
  unitPrice?: number;
  kohiHobetsu?: string | null; kohiAmount?: number | null; kohiTandoku?: boolean;
  jushoTokurei?: boolean; jushoTokureiInsurerNumber?: string;
}): SougouDensouRow => {
  const UP = o.unitPrice ?? UNIT_PRICE;
  const total = Math.floor((o.units * Math.round(UP * 100)) / 100);
  const ins = o.kohiTandoku ? 0 : Math.floor((total * 9) / 10);
  const kohi = o.kohiAmount ?? null;
  return {
    user_id: o.insured, user_name: o.name, user_name_kana: null, user_number: null,
    insurer_number: o.insurer ?? "122184", insurer_name: "市", insured_number: o.insured,
    care_level: "事業対象者", copay_rate: 0.1,
    details: [{ service_type: "訪問型サービス", short_name: null, service_code: "MB_A21111",
      unit_per: o.units, count: 1, units: o.units }],
    grossBaseUnits: o.units, limitUnits: null, planUnits: null, overUnits: 0, overSource: "auto",
    overAmount: 0, selfPayAmount: 0, baseUnits: o.units, addonUnits: 0, kanriTaishougaiUnits: 0,
    addonLabel: null, totalUnits: o.units, unitPrice: UP, totalAmount: total,
    insuranceAmount: ins, userAmount: total - ins - (kohi ?? 0),
    publicExpense: null,
    kohiTandoku: !!o.kohiTandoku, kohiHobetsu: o.kohiHobetsu ?? null,
    kohiFutanshaNumber: o.kohiHobetsu ? `${o.kohiHobetsu}121018` : null,
    kohiJukyushaNumber: o.kohiHobetsu ? "0040980" : null,
    kohiUnits: o.kohiHobetsu ? o.units : null, kohiAmount: kohi,
    addonCode: null, birthDate: "1940-01-01", gender: "女",
    certStart: "2026-04-01", certEnd: "2027-03-31",
    careOfficeNumber: null, careOfficeName: null, planCreatorKubun: null,
    serviceStartDate: null, serviceDays: 1,
    jushoTokurei: o.jushoTokurei, jushoTokureiInsurerNumber: o.jushoTokureiInsurerNumber,
  } as unknown as SougouDensouRow;
};

// 項番 N は c[N+1] (行頭に レコード種別・連番 の 2 列)
const F = (c: string[], n: number) => (c[n + 1] ?? "").replace(/"/g, "").trim();
const num = (s: string) => (s === "" ? 0 : Number(s));

const build = (rows: SougouDensouRow[]) => {
  const r = buildSougouDensou(rows, {
    officeNumber: OFFICE, year: YEAR, month: MONTH, unitPrice: UNIT_PRICE,
  } as never);
  const lines = r.content.split(/\r?\n/).filter(Boolean).map((l) => l.split(","));
  return {
    ...r,
    hoken: lines.find((c) => F(c, 1) === "7113" && F(c, 4) === "1") ?? null,
    kohi: new Map(lines.filter((c) => F(c, 1) === "7113" && F(c, 4) === "2").map((c) => [F(c, 5), c])),
    basics: lines.filter((c) => F(c, 1) === "71R1" && F(c, 2) === "01"),
    details: lines.filter((c) => F(c, 1) === "71R1" && (F(c, 2) === "02" || F(c, 2) === "14")),
    totals: lines.filter((c) => F(c, 1) === "71R1" && F(c, 2) === "10"),
  };
};

const fails: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

console.log(`総合事業 伝送 (7113/71R1) の項番ベース検証 — DB 不使用 / 提供月 ${YEAR}-${String(MONTH).padStart(2, "0")}\n`);

// ── A/E: 請求書 == 明細の合計 (項番の位置で見る) ──────────────
console.log("=== A/E. 7113 保険請求分 (項7-12) == 明細書の合計 ===");
{
  const rows = [row({ name: "甲", insured: "0000000030", units: 1000 }),
                row({ name: "乙", insured: "0000000031", units: 2000 })];
  const b = build(rows);
  const expUnits = 3000, expCost = 30000, expIns = 27000, expUser = 3000;
  check(!!b.hoken, "7113 保険請求分が 1 本");
  // ⚠ index ではなく項番で見る。index 0 は常に "2" (レコード種別) なので
  //   includes("2") のような値ベースの判定は件数が何でも通ってしまう
  check(num(F(b.hoken!, 7)) === 2, "項7 件数", `${F(b.hoken!, 7)} (期待 2)`);
  check(num(F(b.hoken!, 8)) === expUnits, "項8 単位数", `${F(b.hoken!, 8)} (期待 ${expUnits})`);
  check(num(F(b.hoken!, 9)) === expCost, "項9 費用合計", `${F(b.hoken!, 9)} (期待 ${expCost})`);
  check(num(F(b.hoken!, 10)) === expIns, "項10 事業費請求額", `${F(b.hoken!, 10)} (期待 ${expIns})`);
  check(num(F(b.hoken!, 12)) === expUser, "項12 利用者負担", `${F(b.hoken!, 12)} (期待 ${expUser})`);
  check(b.hoken!.length === 14, "E: 7113 は 12 項目 (+種別+連番 = 14 列)", `${b.hoken!.length} 列`);
  check(b.basics.length === 2 && b.totals.length === 2, "明細書 基本2 / 集計2",
    `${b.basics.length} / ${b.totals.length}`);
  // ★ index 0 が常に "2" であることを実証 (値ベース判定が誤って通る根拠)
  check(b.hoken![0] === "2", "⚠ index 0 は常に \"2\" (レコード種別) — 値だけの判定は危険", b.hoken![0]);
}

// ── C/D: Σ明細 == 集計 / 住所地特例も含む ────────────────────
console.log("\n=== C/D. Σ明細(02+14 項14) == 集計10(項10+項11) ===");
{
  const rows = [
    row({ name: "通常", insured: "0000000040", units: 1500 }),
    row({ name: "住所地特例", insured: "0000000041", units: 2500,
      jushoTokurei: true, jushoTokureiInsurerNumber: "122192" }),
  ];
  const b = build(rows);
  const kinds = new Set(b.details.map((c) => F(c, 2)));
  check(kinds.has("02") && kinds.has("14"), "D: 種別02 と 種別14 が両方出る", [...kinds].join(","));
  for (const t of b.totals) {
    const insured = F(t, 6);
    const mine = b.details.filter((c) => F(c, 6) === insured);
    const sum14 = mine.reduce((s, c) => s + num(F(c, 14)), 0);
    const kanri = num(F(t, 10)) + num(F(t, 11));
    check(sum14 === kanri, `C: ${insured} Σ明細(項14) == 集計(項10+項11)`, `Σ${sum14} vs ${kanri}`);
  }
  const totalUnits = b.details.reduce((s, c) => s + num(F(c, 14)), 0);
  check(num(F(b.hoken!, 8)) === totalUnits, "D: 住所地特例も 7113 の単位数に含まれる",
    `${F(b.hoken!, 8)} / Σ明細 ${totalUnits}`);
}

// ── B: ★ 公費請求額 0 円の利用者が請求書から落ちないか ────────
console.log("\n=== B. ★ 公費請求額 0 円 (介護 7111 と同じ型の穴がないか) ===");
{
  const rows = [
    row({ name: "公費あり", insured: "0000000050", units: 1000, kohiHobetsu: "12", kohiAmount: 500 }),
    row({ name: "公費0円", insured: "0000000051", units: 1000, kohiHobetsu: "12", kohiAmount: 0 }),
    row({ name: "法別19が0円のみ", insured: "0000000052", units: 1000, kohiHobetsu: "19", kohiAmount: 0 }),
  ];
  const b = build(rows);
  // 明細書 基本01 で公費欄 (項7 公費1負担者番号) が出ている人数を法別ごとに数える
  const meisaiByHobetsu = new Map<string, number>();
  for (const c of b.basics) {
    const futansha = F(c, 7);
    if (!futansha) continue;
    const hb = futansha.slice(0, 2);
    meisaiByHobetsu.set(hb, (meisaiByHobetsu.get(hb) ?? 0) + 1);
  }
  console.log(`     明細書で公費欄あり: ${JSON.stringify([...meisaiByHobetsu])}`);
  console.log(`     請求書の公費請求分: ${JSON.stringify([...b.kohi.keys()])}`);
  for (const [hb, n] of meisaiByHobetsu) {
    const rec = b.kohi.get(hb);
    const seikyusho = rec ? num(F(rec, 7)) : null;
    check(seikyusho === n, `法別${hb}: 請求書の件数 == 明細書の件数`,
      `請求書 ${seikyusho === null ? "**行なし**" : seikyusho} / 明細 ${n}`);
  }
}

// ── F: 保険者ごとに単価が違う利用者が同一ファイルに混在する ──
console.log("\n=== F. 単価は保険者スコープ (同一ファイル内で単価が複数種) ===");
{
  // 実データの裏付け (G/claude-2b 測定): 総合事業の実績 1,624 件のうち
  // 「保険者の単価 ≠ 事業所の単価」が 199 件 (12.3%)。
  // 同一事業所で単価が複数種になる事業所は 7/19 (最大4種)。
  // → 1 ファイルの中に単価の違う利用者が混ざる。項15 は**利用者ごと**でなければならない。
  const rows = [
    row({ name: "甲", insured: "0000000060", units: 1000, insurer: "122184", unitPrice: 10.0 }),
    row({ name: "乙", insured: "0000000061", units: 1000, insurer: "122382", unitPrice: 10.7 }),
  ];
  const b = build(rows);
  const prices = b.totals.map((c) => num(F(c, 15)));
  check(new Set(prices).size === 2, "集計10 項15 単位数単価が利用者ごとに違う", prices.join(" / "));
  check(prices.includes(1000) && prices.includes(1070), "10.00円 → 1000 / 10.70円 → 1070", prices.join(","));
  const expCost = Math.floor((1000 * 1000) / 100) + Math.floor((1000 * 1070) / 100); // 10000 + 10700
  check(num(F(b.hoken!, 9)) === expCost, "7113 項9 費用合計 = 単価別に計算した額の合計",
    `${F(b.hoken!, 9)} (期待 ${expCost})`);
  check(num(F(b.hoken!, 8)) === 2000, "7113 項8 単位数は単価に関係なく単位の合計", F(b.hoken!, 8));
  // ⚠ opts.unitPrice を一律に使う実装だったら両方 1000 になり 費用合計は 20000 になる。
  //   この assertion が「単価が利用者ごとに効いている」ことの見張りになる。
  check(num(F(b.hoken!, 9)) !== 20000, "⚠ opts.unitPrice の一律適用になっていない", F(b.hoken!, 9));
}

console.log(`\n${fails.length === 0 ? "すべて PASS" : `★ ${fails.length} 件 FAIL`}`);
for (const f of fails) console.log(`  - ${f}`);
if (fails.length > 0) process.exit(1);
