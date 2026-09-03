/**
 * 訪問入浴 サンプルの検証 — 段1 (算定・単位数) と 段2 (伝送様式) の両方
 *
 *   npx tsx scripts/bath-sample-check.mts
 *
 * ⚠ 期待値は **手計算で独立に導出**したもの。集計結果をコピーして期待値にしない
 *   (VERIFICATION_RULES 3-2: 現状維持を成功指標にしない)。
 *
 * 対象は seed_sample_bath_c.mjs が入れた 2026-12 のサンプルのみ (マーカー ZC*)。
 * サンプルが未投入なら **分母 0 と明記してスキップ** (0 件を合格と言わない)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateBathVisitSeikyu } from "@/lib/bath-seikyu/aggregate";
import { buildKokuhoDensou } from "@/lib/kokuho-densou/build";

const env: Record<string, string> = {};
for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const OFFICE_ID = "ec87a203-53e2-40a5-b706-7fea402cde16"; // ムツミ訪問入浴 (実在)
const OFFICE_NUMBER = "1272401058";
const UNIT_PRICE = 10.7;
const Y = 2026, M = 12;
const CRLF = "\r\n";

/**
 * ── 手計算した期待値 ──────────────────────────────────────────────────
 * 単位: 121111 全身浴 1266 / 121112 部分浴 1139 / 121121 職員のみ 1203 /
 *       121122 職員のみ部分浴 1083 / 124113 初回 200(月1) / 126134 認知症Ⅱ 4(回)
 * 金額: 費用額 = floor(総単位 × 単価) / 保険 = floor(費用額 × (10−負担)/10)
 */
const EXPECT: Record<string, { name: string; level: string; copay: number; limit: number; over: number; base: number }> = {
  ZC001: { name: "見本 太郎", level: "要介護3", copay: 1, limit: 27048, over: 0, base: 1266 * 4 + 200 },
  ZC002: { name: "見本 花子", level: "要介護1", copay: 2, limit: 16765, over: 0, base: 1266 + 1139 + 1203 + 1083 },
  ZC003: { name: "見本 次郎", level: "要介護1", copay: 3, limit: 16765, over: 1266 * 14 - 16765, base: 16765 },
  ZC004: { name: "見本 三郎", level: "要介護5", copay: 1, limit: 36217, over: 0, base: 1266 * 3 + 4 * 3 },
  ZC005: { name: "見本 四郎", level: "要支援2", copay: 1, limit: 10531, over: 0, base: 1266 },
};

let ng = 0, checked = 0;
const eq = (label: string, a: unknown, b: unknown) => {
  checked++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) ng++;
  console.log(`    ${ok ? "OK " : "NG "} ${label.padEnd(32)} 実際=${JSON.stringify(a)} 期待=${JSON.stringify(b)}`);
};
let g = 0, gng = 0;
const chk = (label: string, cond: boolean, detail = "") => {
  g++; if (!cond) gng++;
  console.log(`    ${cond ? "OK " : "NG "} ${label}${detail ? "  " + detail : ""}`);
};

// ══ 段1 ═══════════════════════════════════════════════════════════════
console.log("══ 段1: 算定・単位数 (手計算した期待値と突合) ══");
const res = await aggregateBathVisitSeikyu(sb, {
  officeId: OFFICE_ID, tenantId: "kt-group", year: Y, month: M, unitPrice: UNIT_PRICE,
});
const rows = res.rows as unknown as Array<Record<string, unknown>>;
console.log(`  【分母】集計行 ${rows.length} 件 (期待 ${Object.keys(EXPECT).length} 件)`);
if (rows.length === 0) {
  console.log("  ⚠ 分母 0 — サンプル未投入。**合格とは言わない**。");
  console.log("     node migrations/seed_sample_bath_c.mjs --execute で投入してください");
  process.exit(0);
}
for (const [no, e] of Object.entries(EXPECT)) {
  const r = rows.find((x) => String(x.user_name ?? "").startsWith(e.name)) as Record<string, number> | undefined;
  console.log(`\n  ── ${no} ${e.name} (${e.level} / ${e.copay}割 / 限度 ${e.limit.toLocaleString()}) ──`);
  if (!r) { ng++; checked++; console.log("    NG  集計行が見つからない"); continue; }
  eq("総単位 (保険給付対象)", Number(r.totalUnits), e.base);
  eq("限度額超過の単位", Number(r.overUnits ?? 0), e.over);
  eq("限度額 (認定から)", Number(r.limitUnits), e.limit);
  const expCost = Math.floor((e.base * Math.round(UNIT_PRICE * 100)) / 100);
  eq("費用額 = floor(単位×単価)", Number(r.totalAmount), expCost);
  eq(`保険 = floor(費用×${10 - e.copay}/10)`, Number(r.insuranceAmount), Math.floor((expCost * (10 - e.copay)) / 10));
  eq("恒等式 費用 = 保険+公費+本人", Number(r.totalAmount),
    Number(r.insuranceAmount) + Number(r.kohiAmount ?? 0) + Number(r.kohi2Amount ?? 0) + Number(r.userAmount));
  if (e.over > 0) eq("超過の全額自費 = floor(超過×単価)", Number(r.selfPayAmount ?? 0), Math.floor((e.over * Math.round(UNIT_PRICE * 100)) / 100));
  else eq("超過なしなら自費 0", Number(r.selfPayAmount ?? 0), 0);
}
console.log(`\n  段1: 検査 ${checked} 件 / NG ${ng} 件`);
if (res.warnings?.length) {
  console.log(`  集計 warning ${res.warnings.length} 件:`);
  for (const w of res.warnings.slice(0, 10)) console.log(`     - ${w}`);
}

// ══ 段2 ═══════════════════════════════════════════════════════════════
console.log("\n══ 段2: 伝送様式 ══");
const built = buildKokuhoDensou(rows as never[], {
  officeNumber: OFFICE_NUMBER, year: Y, month: M, unitPrice: UNIT_PRICE,
  seikyuYear: 2027, seikyuMonth: 1,
});
const lines = built.content.split(CRLF).filter((l) => l.length > 0);
console.log(`  ファイル名 ${built.fileName} / ${lines.length} 行`);
if (built.warnings.length) {
  console.log(`  warnings ${built.warnings.length} 件:`);
  built.warnings.forEach((w) => console.log(`     - ${w}`));
}
const kind: Record<string, number> = {};
for (const l of lines) { const k = l.split(",")[0]; kind[k] = (kind[k] ?? 0) + 1; }
console.log(`  レコード種別 (1列目): ${JSON.stringify(kind)}`);

// ⚠ **実際の様式を見てから検査を書き直した。**
//   最初は「1 列目が 7131」と思い込んで NG 4 件を出したが、
//   **実装ではなく私の期待値が誤っていた** (3-9: 赤いテストは期待値も疑う)。
//     1 列目 = レコード種別 (1=コントロール / 2=データ / 3=エンド)
//     3 列目 = 様式番号 "7111"(請求書) / "7131"(明細書)
//     7131 の 4 列目 = 01 明細ヘッダ / 02 明細行
//     提供年月は **西暦** (202612)。和暦ではない
const col = (l: string, i: number) => (l.split(",")[i] ?? "").replace(/"/g, "");
const ctrl = lines.filter((l) => col(l, 0) === "1");
const endRec = lines.filter((l) => col(l, 0) === "3");
const dataRec = lines.filter((l) => col(l, 0) === "2");
chk("コントロールレコードが 1 行", ctrl.length === 1, `${ctrl.length} 行`);
chk("エンドレコードが 1 行", endRec.length === 1, `${endRec.length} 行`);
if (ctrl.length === 1) {
  chk("事業所番号が入っている", ctrl[0].split(",").includes(OFFICE_NUMBER));
  chk("処理対象年月 = 請求月の翌月 (202702)", ctrl[0].split(",").includes("202702"), ctrl[0]);
  chk("データ件数 (項4) = データ行数", col(ctrl[0], 3) === String(dataRec.length),
    `${col(ctrl[0], 3)} vs ${dataRec.length}`);
}
const seikyusho = lines.filter((l) => col(l, 2) === "7111");
const meisaiHead = lines.filter((l) => col(l, 2) === "7131" && col(l, 3) === "01");
const meisaiLine = lines.filter((l) => col(l, 2) === "7131" && col(l, 3) === "02");
console.log(`  請求書 7111 ${seikyusho.length} 行 / 明細ヘッダ 7131-01 ${meisaiHead.length} 行 / 明細 7131-02 ${meisaiLine.length} 行`);
chk("明細ヘッダが利用者数ぶん", meisaiHead.length === rows.length, `${meisaiHead.length} vs ${rows.length}`);
chk("請求書は 保険分 + 公費分 の 2 行", seikyusho.length === 2, `${seikyusho.length} 行`);
console.log("     ⚠ 請求書 7111 は保険分と公費分で 2 本出る。**足すと二重計上**になる");
chk("明細行がある", meisaiLine.length > 0, `${meisaiLine.length} 行`);
chk("提供年月が西暦 202612", meisaiHead.length > 0 && meisaiHead.every((l) => col(l, 4) === "202612"),
  `${meisaiHead.filter((l) => col(l, 4) === "202612").length}/${meisaiHead.length}`);
chk("全角の数字・英字が混ざっていない", !lines.some((l) => /[０-９Ａ-Ｚａ-ｚ]/.test(l)));
chk("CRLF で区切られている", built.content.includes(CRLF));
chk("末尾に空行が重なっていない", !built.content.endsWith(CRLF + CRLF));

// ── 金額の恒等式: 請求書 (保険分) の合計 = 明細の合計 ────────────────────
const hoken = seikyusho.find((l) => col(l, 6) === "0"); // 公費法別が 0 = 保険分
chk("保険分の請求書がある", !!hoken);
if (hoken) {
  const f = hoken.split(",");
  const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  chk("請求書 件数 = 利用者数", f[8] === String(rows.length), `${f[8]} vs ${rows.length}`);
  chk("請求書 単位合計 = 明細の合計", f[9] === String(sum("totalUnits")), `${f[9]} vs ${sum("totalUnits")}`);
  chk("請求書 費用額 = 明細の合計", f[10] === String(sum("totalAmount")), `${f[10]} vs ${sum("totalAmount")}`);
  chk("請求書 保険請求額 = 明細の合計", f[11] === String(sum("insuranceAmount")), `${f[11]} vs ${sum("insuranceAmount")}`);
  chk("請求書 公費請求額 = 明細の合計", f[12] === String(sum("kohiAmount")), `${f[12]} vs ${sum("kohiAmount")}`);
  chk("請求書 利用者負担 = 明細の合計", f[13] === String(sum("userAmount")), `${f[13]} vs ${sum("userAmount")}`);
}

// ── ★ 要支援の利用者が 種類12 (介護給付) のまま伝送に乗るか ────────────
const YOBO_INSURED = "ZC00000005"; // 見本 四郎 (要支援2)
const yoboLines = meisaiLine.filter((l) => col(l, 7) === YOBO_INSURED);
console.log(`\n  ★ 要支援2 の利用者が伝送に乗るか: 明細 ${yoboLines.length} 行`);
for (const l of yoboLines) console.log(`     サービス種類 ${col(l, 8)} / コード ${col(l, 9)} / 単位 ${col(l, 10)} / 回数 ${col(l, 11)}`);
chk("★ 要支援でも様式としては通ってしまう (伝送の検査では捕まらない)",
  yoboLines.length > 0 && yoboLines.every((l) => col(l, 8) === "12"),
  yoboLines.length === 0 ? "乗らなかった" : `種類 ${[...new Set(yoboLines.map((l) => col(l, 8)))].join(",")}`);

console.log(`\n  段2: 検査 ${g} 件 / NG ${gng} 件`);
const out = `${process.env.TEMP ?? "."}/bath_sample_${built.fileName}`;
try { writeFileSync(out, built.content, "utf8"); console.log(`  出力: ${out} (★ scratch。伝送データ/ には置かない)`); }
catch (e) { console.log(`  ⚠ 出力できない: ${(e as Error).message}`); }
console.log(`\n══ 合計 検査 ${checked + g} 件 / NG ${ng + gng} 件 ══`);
