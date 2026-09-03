/**
 * 介護予防支援 (46xxxx) サンプル検証 (担当 J / マーカー ZP##)
 *
 *   npx tsx scripts/yobo-sample-verify.mts
 *
 * migrations/seed_sample_yobo_j.mjs で投入した 2026-12 のサンプルを
 * **実アプリと同じローダ** (fetchKyotakuClaimRows) で読み、
 *   段0 委託の除外   … 包括が請求する 委託 が伝送対象から落ちるか
 *   段1 算定・単位数 … 手計算した期待値と突合
 *   段2 伝送様式     … 43/46 のパーティション + 8124 / 7111 の項番・恒等式
 * を確認する。
 *
 * ★ この検査が証明しないこと (ルール 3-1):
 *   - 画面 (_kokuho-seikyu.tsx) の 46 番号解決。office_service_designations は
 *     ★ 表ごと 0 行なので画面からは出せない。ここでは 46 番号を **引数で渡して**
 *     builder 側だけを検証する
 *   - 予防の 委託連携加算 (466132) / 処遇改善加算 (466191・466207-210) —
 *     マスタに在るが実装が無い (下で「未実装」として報告する)
 *   - 逓減制 (介護予防支援は対象外)
 *
 * ── 手計算 (単価 11.05 → ×100 = 1105。介護予防支援も 10割給付) ──
 *   総額 = floor(Σ単位 × 1105 / 100)
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { buildKeikakuhiFile, type KeikakuhiUser } from "@/lib/kokuho-densou/build-kyotaku";
import { fetchKyotakuClaimRows } from "@/app/(authenticated)/billing/seikyu/_seikyu-context";

const MONTH_KEY = "2026-12";
const YEAR = 2026, MONTH = 12;
const OFFICE_NAME = "Ｈａｎａ居宅支援センター高品";
/** ★ 実在しない検証専用の 46 事業所番号 (DB には入れない。引数で渡すだけ) */
const YOBO_OFFICE_NUMBER = "1279999046";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(l);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

/** 段1 期待値 (seed と対応。単価 11.05 で手計算)。ZP03 委託は伝送に出ない */
const EXPECT: Record<string, { units: number; amount: number; codes: string[]; level: string; note: string }> = {
  ZP01: { units: 472, amount: 5215, codes: ["462121"], level: "要支援1", note: "区分Ⅱ 直接指定" },
  ZP02: { units: 442, amount: 4884, codes: ["462111"], level: "要支援2", note: "区分Ⅰ 包括" },
  ZP04: { units: 772, amount: 8530, codes: ["462121", "434001"], level: "要支援1",
    note: "★ 初回加算のコードが 43 系 (434001) で出る — 46 系 (464001) が正のはず" },
  ZP05: { units: 1086, amount: 12000, codes: ["432111"], level: "要介護1", note: "要介護 (43 側)" },
  ZP06: { units: 1086, amount: 12000, codes: ["432111"], level: "要介護2",
    note: "★ 月途中の区分変更 (要支援2→要介護2) = 月末時点で採る" },
};
/** 要介護状態区分コード (8124 項12) */
const CARE_CODE: Record<string, string> = { 要支援1: "12", 要支援2: "13", 要介護1: "21", 要介護2: "22" };

const F = (c: string[], n: number) => (c[n + 1] ?? "").replace(/"/g, "").trim();
const num = (s: string) => (s === "" ? 0 : Number(s));
const fails: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const notes: string[] = [];
const note = (s: string) => { console.log(`  ⚠ ${s}`); notes.push(s); };

async function main() {
  const { data: office, error: oe } = await sb.from("offices")
    .select("id, name, business_number, unit_price").eq("name", OFFICE_NAME).maybeSingle();
  if (oe) throw new Error(`事業所取得失敗: ${oe.message}`);
  if (!office) throw new Error(`事業所が無い: ${OFFICE_NAME}`);
  const P100 = Math.round(office.unit_price * 100);
  console.log(`=== 介護予防支援 サンプル検証 ${MONTH_KEY} / ${office.name} 単価 ${office.unit_price} ===`);
  console.log(`   43 (要介護) ${office.business_number} / 46 (要支援) ${YOBO_OFFICE_NUMBER} ★検証用の仮番号\n`);

  const { data: cs, error: ce } = await sb.from("clients")
    .select("id, user_number, name").like("user_number", "ZP%");
  if (ce) throw new Error(`利用者取得失敗: ${ce.message}`);
  const tagById = new Map((cs ?? []).map((c) => [c.id, c.user_number as string]));
  console.log(`サンプル利用者: ${tagById.size} 名`);

  // ── 段0: 委託の除外 ────────────────────────────────────
  console.log("\n=== 段0. 委託 (包括が請求) の除外 ===");
  const { count: dbCount, error: dce } = await sb.from("kaigo_care_support_claims")
    .select("id", { count: "exact", head: true })
    .eq("billing_month", MONTH_KEY).in("user_id", [...tagById.keys()]);
  if (dce) throw new Error(`件数取得失敗: ${dce.message}`);
  const rows = (await fetchKyotakuClaimRows(sb as never, MONTH_KEY, office.id, { excludeNonKokuho: true }))
    .filter((r) => tagById.has(r.user_id));
  // ★ 「0件でした」の前に、拾えるはずの条件で動くことを確かめる (規律 2章)
  if (rows.length === 0) throw new Error(`ローダが 0 件。DB には ${dbCount} 件ある → ローダの条件を確認すること`);
  check(dbCount === 6, "DB のサンプルレセプト", `${dbCount} 件 (6 件のはず)`);
  check(rows.length === 5, "ローダが返した件数", `${rows.length} 件 — 委託 1 件が除外されて 5 件のはず`);
  const gotTags = new Set(rows.map((r) => tagById.get(r.user_id)));
  check(!gotTags.has("ZP03"), "ZP03 (委託) が伝送対象に入っていない",
    gotTags.has("ZP03") ? "★ 包括が請求する分を二重請求する" : "");
  const zp03 = rows.find((r) => tagById.get(r.user_id) === "ZP03");
  void zp03;

  // ── 段1: 算定・単位数 ────────────────────────────────────
  console.log("\n=== 段1. 算定・単位数 (手計算と突合) ===");
  const byTag = new Map<string, (typeof rows)[number]>();
  for (const r of rows) byTag.set(tagById.get(r.user_id) ?? "?", r);
  for (const [tag, exp] of Object.entries(EXPECT)) {
    const r = byTag.get(tag);
    if (!r) { check(false, `${tag} レセプトが取れない`, exp.note); continue; }
    const diffs: string[] = [];
    if (r.totalUnits !== exp.units) diffs.push(`単位 ${r.totalUnits} ≠ ${exp.units}`);
    const amount = Math.floor((r.totalUnits * P100) / 100);
    if (amount !== exp.amount) diffs.push(`総額 ${amount} ≠ ${exp.amount}`);
    if (r.care_level !== exp.level) diffs.push(`要介護度 "${r.care_level}" ≠ "${exp.level}"`);
    const codes = r.lines.map((l) => l.code);
    if (codes.join(",") !== exp.codes.join(",")) diffs.push(`コード [${codes}] ≠ [${exp.codes}]`);
    check(diffs.length === 0, `${tag} ${exp.note}`,
      diffs.length ? diffs.join(" / ") : `${r.totalUnits}単位 ${amount}円 [${codes}]`);
  }
  // ★ 初回加算のコード体系 — 期待値ではなく事実として報告する
  const zp04 = byTag.get("ZP04");
  const addon = zp04?.lines.find((l) => l.name === "初回加算");
  if (addon) {
    if (addon.code.startsWith("43")) {
      note(`介護予防支援の初回加算に **居宅の 434001** が出ている (46 系は 464001 が実在)。` +
        `buildClaimLines (_seikyu-context.tsx:275) が制度を見ずに 43 系を固定している`);
    } else {
      check(addon.code === "464001", "初回加算が 46 系", addon.code);
    }
  }

  // ── 段2: 伝送様式 ────────────────────────────────────
  console.log("\n=== 段2. 伝送様式 (43/46 パーティション + 8124/7111) ===");
  const isYobo = (r: (typeof rows)[number]) => (r.care_level ?? "").startsWith("要支援");
  const yoboRows = rows.filter(isYobo);
  const kaigoRows = rows.filter((r) => !isYobo(r));
  check(yoboRows.length === 3 && kaigoRows.length === 2,
    "43/46 のパーティション", `要支援 ${yoboRows.length} 名 / 要介護 ${kaigoRows.length} 名 (3/2 のはず)`);
  // ★ 月途中の区分変更 (要支援2→要介護2) が 46 ではなく 43 に行くこと。
  //   居宅介護支援費・介護予防支援費は月額なので月末時点の区分で 1 本だけ請求する。
  const zp06 = byTag.get("ZP06");
  check(!!zp06 && !isYobo(zp06) && zp06.care_level === "要介護2",
    "ZP06 月途中の区分変更は月末時点 (要介護2) で 43 側",
    zp06 ? `要介護度 "${zp06.care_level}" / ${isYobo(zp06) ? "46側" : "43側"}` : "レセプトが無い");
  const zp06Claims = rows.filter((r) => tagById.get(r.user_id) === "ZP06");
  check(zp06Claims.length === 1, "ZP06 は 1 レセプト", `${zp06Claims.length} 件 (区分変更は転居と違い 1 本)`);

  const toUser = (r: (typeof rows)[number]): KeikakuhiUser => ({
    userName: r.user_name, insurerNumber: r.insurer_number ?? "", insuredNumber: r.insured_number ?? "",
    birthDate: r.birth_date, gender: r.gender, careLevel: r.care_level,
    certStart: r.certStart, certEnd: r.certEnd, requestDate: r.requestDate ?? null,
    serviceCode: r.serviceCode, units: r.totalUnits,
    lines: r.lines.map((l) => ({ code: l.code, units: l.units, count: l.count })),
    careManagerNumber: r.careManagerNumber,
    kohiTandoku: r.kohiTandoku, kohiHobetsu: r.kohiHobetsu,
    kohiFutanshaNumber: r.kohiFutansha, kohiJukyushaNumber: r.kohiJukyusha,
    midMonthInsurerChange: r.midMonthInsurerChange,
  });
  const opts = { officeNumber: YOBO_OFFICE_NUMBER, year: YEAR, month: MONTH,
    unitPrice: office.unit_price, shoriYear: YEAR + 1, shoriMonth: 1 };
  const built = buildKeikakuhiFile(yoboRows.map(toUser), opts);
  const lines = built.content.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => l.split(","));
  const rec8124 = lines.filter((c) => F(c, 1) === "8124");
  const rec7111 = lines.filter((c) => F(c, 1) === "7111");
  console.log(`  生成: 8124 ${rec8124.length} 行 / 7111 ${rec7111.length} 行 / ファイル名 ${built.fileName}`);
  // ★ 長さの検査を先に置く (空配列に every は必ず通る — 規律 2章⑪)
  if (rec8124.length === 0 || rec7111.length === 0) throw new Error("★ 明細/請求書が 0 行。以降の検査は意味を持たない");
  check(built.fileName.startsWith("S"), "計画費のファイル名", built.fileName +
    " (画面側で 予防は Y 接頭辞を付ける = _kokuho-seikyu.tsx:404)");

  // 8124: 利用者ごとに 要介護度コード・サービスコード・単位・金額
  for (const r of yoboRows) {
    const tag = tagById.get(r.user_id) ?? "?";
    const exp = EXPECT[tag];
    if (!exp) continue;
    const mine = rec8124.filter((c) => F(c, 7) === (r.insured_number ?? ""));
    if (mine.length === 0) { check(false, `${tag} 8124 が出ていない`); continue; }
    const last = mine[mine.length - 1];
    const diffs: string[] = [];
    if (F(last, 16) !== "99") diffs.push(`最終行の行番号 ${F(last, 16)} ≠ 99`);
    if (F(last, 12) !== CARE_CODE[exp.level]) diffs.push(`要介護度コード ${F(last, 12)} ≠ ${CARE_CODE[exp.level]}`);
    if (num(F(last, 21)) !== exp.units) diffs.push(`項21 合計単位 ${F(last, 21)} ≠ ${exp.units}`);
    if (num(F(last, 22)) !== exp.amount) diffs.push(`項22 請求金額 ${F(last, 22)} ≠ ${exp.amount}`);
    const sum = mine.reduce((s, c) => s + num(F(c, 18)) * num(F(c, 19)), 0);
    if (sum !== num(F(last, 21))) diffs.push(`Σ(項18×項19)=${sum} ≠ 項21 ${F(last, 21)}`);
    if (F(last, 2) !== YOBO_OFFICE_NUMBER) diffs.push(`項2 事業所番号 ${F(last, 2)} ≠ ${YOBO_OFFICE_NUMBER}`);
    check(diffs.length === 0, `${tag} 8124 (${mine.length}行)`,
      diffs.length ? diffs.join(" / ") : `要介護度${F(last, 12)} ${F(last, 21)}単位 ${F(last, 22)}円`);
  }

  // 7111: 件数・単位・金額の恒等式
  const hoken = rec7111.filter((c) => F(c, 4) === "1");
  check(hoken.length === 1, "7111 保険請求分", `${hoken.length} 行 (1 行のはず)`);
  if (hoken.length === 1) {
    const h = hoken[0];
    const expCount = yoboRows.length;
    const expUnits = yoboRows.reduce((s, r) => s + r.totalUnits, 0);
    const expAmt = yoboRows.reduce((s, r) => s + Math.floor((r.totalUnits * P100) / 100), 0);
    const diffs: string[] = [];
    if (num(F(h, 7)) !== expCount) diffs.push(`件数 ${F(h, 7)} ≠ ${expCount}`);
    if (num(F(h, 8)) !== expUnits) diffs.push(`単位数 ${F(h, 8)} ≠ ${expUnits}`);
    if (num(F(h, 9)) !== expAmt) diffs.push(`費用合計 ${F(h, 9)} ≠ ${expAmt}`);
    if (num(F(h, 10)) !== expAmt) diffs.push(`保険請求額 ${F(h, 10)} ≠ ${expAmt} (10割給付)`);
    if (num(F(h, 12)) !== 0) diffs.push(`利用者負担 ${F(h, 12)} ≠ 0`);
    if (F(h, 6) !== "02") diffs.push(`請求情報区分 ${F(h, 6)} ≠ 02 (居宅介護支援・介護予防支援)`);
    check(diffs.length === 0, "7111 の恒等式", diffs.length ? diffs.join(" / ")
      : `${expCount}件 ${expUnits}単位 ${expAmt}円`);
  }

  console.log(`\n  builder の警告 ${built.warnings.length} 件`);
  for (const w of built.warnings) console.log(`    - ${w}`);

  // ── 負のコントロール (ルール 3-9): 期待値をわざと外して落ちることを見る ──
  console.log("\n=== 負のコントロール (検査が動いていることの確認) ===");
  const probe = buildKeikakuhiFile([{ ...toUser(yoboRows[0]), careLevel: "要介護1" }], opts);
  const pl = probe.content.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(","))
    .filter((c) => F(c, 1) === "8124");
  const moved = F(pl[pl.length - 1], 12) !== CARE_CODE[EXPECT[tagById.get(yoboRows[0].user_id)!].level];
  console.log(`  要介護度を 要支援→要介護1 に変えると 項12 が ${F(pl[pl.length - 1], 12)} に動く: ${moved ? "✓ 検査は生きている" : "✗ 動かない = 検査を疑うこと"}`);
  if (!moved) fails.push("負のコントロールが動かない");

  // ── 結果 ────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  if (fails.length === 0) console.log(`✅ 全 PASS`);
  else { console.log(`✗ ${fails.length} 件 FAIL`); for (const f of fails) console.log(`   - ${f}`); }
  if (notes.length) {
    console.log(`\n★ 実装の欠落として報告するもの (${notes.length} 件):`);
    for (const n of notes) console.log(`   - ${n}`);
  }
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
