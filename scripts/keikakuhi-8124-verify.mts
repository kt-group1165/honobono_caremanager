/**
 * 居宅介護支援費 請求 (7111 + 8124 / S ファイル) の境界値検証 — **DB を一切触らない**
 *
 *   npx tsx scripts/keikakuhi-8124-verify.mts
 *
 * buildKeikakuhiFile は純関数なので in-memory fixture で検算する (VERIFICATION_RULES 7-1)。
 *
 * ── この検査が証明すること (3-1) ────────────────────────────
 *   A. 行99 項21 合計単位数 == Σ(項20 サービス単位数)
 *   B. 行99 項22 請求金額 == floor(単位数 × 単価×100 / 100) — 円未満切り捨て
 *   C. 明細行番号は 1..n-1 + 最終行 99 (ほのぼの様式: 最終明細が合計行を兼ねる)
 *   D. 公費単独 (被保番 H) は 7111 保険請求分の件数に入らず、公費請求分に10割
 *   E. 公費併用は 8124 項8/9 (公費負担者/受給者番号) が**空** (ほのぼの実出力準拠)
 *   F. 8124 の証記載保険者番号 (項5) は **6桁** (8222 項3 の8桁前0埋めとは別)
 *   G. 単位数単価 (項6) は 単価×100
 *   H. 処理対象年月 = 提出月 / ファイル名 S<提供年月>.CSV
 *   I. 基本コードが無いレセプト (加算のみ) も組み立てられる — 実在ケース
 *      (月途中で亡くなると給付管理をしないため居宅介護支援費が立たず、
 *       ターミナルケアマネジメント加算 400単位だけを請求する)
 *   J. ★ u.units と Σlines が食い違うとき、項21 と 項22 の基準がズレないか
 *
 * ── この検査が証明しないこと ────────────────────────────────
 *   ・単位数・加算の算定そのものの正しさ (呼出側が組み立てた値を出すだけ)
 *   ・ほのぼの実伝送とのバイト一致 (それは scripts/kyotaku-s-diff.mts の担当)
 *
 * ── 実データでの裏取り (3-5。2026-09-03 / 8124 17,179行・レセプト 5,697件) ──
 *   A 項21 == Σ項20                    5,697 / 5,697  ✅ 例外なし
 *   B 項22 == floor(項21 × 単価)        5,697 / 5,697  ✅ **項21 が基準**であることの裏取り
 *   C 最終行が行番号99                   5,697 / 5,697  ✅
 *   I 基本コード(432/433)が無いレセプト     1 件        ✅ 実在する (ターミナルのみ)
 *   E 項8/9 に公費番号があるレセプト        31 件
 *     → **31/31 すべて被保番が H 始まり (公費単独)**。併用で番号が入る実例は 0 件
 *        = 「公費併用は項8/9 が空」というコードの前提は実データでも正しい
 *   単位数単価の実例                     1000/1021/1042/1070/1084/1105
 * ────────────────────────────────────────────────────────
 */
import {
  buildKeikakuhiFile,
  type KeikakuhiUser,
  type KeikakuhiMeisaiLine,
} from "@/lib/kokuho-densou/build-kyotaku";

const OFFICE = "1279999999";
const YEAR = 2026;
const MONTH = 6;
const UNIT_PRICE = 10.84; // 居宅介護支援費の地域単価 (例)
const P100 = Math.round(UNIT_PRICE * 100); // 1084

const ml = (code: string, units: number, count = 1): KeikakuhiMeisaiLine => ({ code, units, count });

const user = (o: Partial<KeikakuhiUser> & { userName: string }): KeikakuhiUser => ({
  userName: o.userName,
  insurerNumber: o.insurerNumber ?? "121012",
  insuredNumber: o.insuredNumber ?? "1000000001",
  // ⚠ `?? 既定値` にすると明示的な null が既定値に化けて経路を通せない (2章⑥)
  birthDate: "birthDate" in o ? (o.birthDate ?? null) : "1938-04-04",
  gender: "gender" in o ? (o.gender ?? null) : "女",
  careLevel: "careLevel" in o ? (o.careLevel ?? null) : "要介護3",
  certStart: o.certStart ?? "2026-04-01",
  certEnd: o.certEnd ?? "2027-03-31",
  requestDate: "requestDate" in o ? (o.requestDate ?? null) : "2026-04-01",
  serviceCode: o.serviceCode ?? "432211",
  units: o.units ?? 1411,
  lines: o.lines,
  careManagerNumber: o.careManagerNumber ?? "0012345",
  kohiTandoku: o.kohiTandoku,
  kohiHobetsu: o.kohiHobetsu,
  kohiFutanshaNumber: o.kohiFutanshaNumber,
  kohiJukyushaNumber: o.kohiJukyushaNumber,
  midMonthInsurerChange: o.midMonthInsurerChange,
});

// 項番 N は c[N+1] (行頭に レコード種別・連番 の 2 列が付くため)
const F = (c: string[], n: number) => (c[n + 1] ?? "").replace(/"/g, "").trim();
const num = (s: string) => (s === "" ? 0 : Number(s));

function parse(content: string) {
  const rows = content.split(/\r?\n/).filter(Boolean).map((l) => l.split(","));
  const ctrl = rows[0];
  const hoken = rows.find((c) => F(c, 1) === "7111" && F(c, 4) === "1") ?? null;
  const kohi = new Map<string, string[]>();
  for (const c of rows) if (F(c, 1) === "7111" && F(c, 4) === "2") kohi.set(F(c, 5), c);
  const byUser = new Map<string, string[][]>();
  for (const c of rows) {
    if (F(c, 1) !== "8124") continue;
    const k = F(c, 7); // 被保険者番号
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k)!.push(c);
  }
  return { ctrl, hoken, kohi, byUser };
}

const fails: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const build = (users: KeikakuhiUser[], opts: Partial<{ shoriYear: number; shoriMonth: number }> = {}) => {
  const r = buildKeikakuhiFile(users, { officeNumber: OFFICE, year: YEAR, month: MONTH, unitPrice: UNIT_PRICE, ...opts });
  return { ...r, p: parse(r.content) };
};

console.log(`居宅介護支援費 (7111/8124) の境界値検証 — DB 不使用 / 提供月 ${YEAR}-${String(MONTH).padStart(2, "0")} / 単価 ${UNIT_PRICE}\n`);

// ── A/B/C/F/G: 基本形 (基本 + 加算 3行) ──────────────────────
console.log("=== A/B/C/F/G. 基本形 (基本コード + 加算2つ) ===");
{
  const lines = [ml("432211", 1411), ml("433001", 300), ml("436101", 154)];
  const total = lines.reduce((s, l) => s + l.units * l.count, 0); // 1865
  const u = user({ userName: "基本", units: total, lines });
  const { p } = build([u]);
  const rows = p.byUser.get("1000000001")!;
  check(rows.length === 3, "明細 3 行", `${rows.length}`);
  const nos = rows.map((c) => F(c, 16));
  check(JSON.stringify(nos) === JSON.stringify(["1", "2", "99"]), "C: 行番号 1,2,99 (最終行が合計行)", nos.join(","));
  const last = rows[rows.length - 1];
  const sum20 = rows.reduce((s, c) => s + num(F(c, 20)), 0);
  check(num(F(last, 21)) === sum20, "A: 項21 合計単位数 == Σ項20", `${F(last, 21)} / Σ${sum20}`);
  const expAmount = Math.floor((total * P100) / 100);
  check(num(F(last, 22)) === expAmount, "B: 項22 請求金額 == floor(単位×単価)", `${F(last, 22)} (期待 ${expAmount})`);
  check(rows.slice(0, -1).every((c) => F(c, 21) === "" && F(c, 22) === ""), "行99 以外は 項21/22 が空");
  check(F(rows[0], 5) === "121012" && F(rows[0], 5).length === 6, "F: 項5 保険者番号は6桁", F(rows[0], 5));
  check(num(F(rows[0], 6)) === P100, "G: 項6 単位数単価 = 単価×100", F(rows[0], 6));
  check(rows.every((c) => F(c, 23) === "0012345"), "項23 ケアマネ番号が全行に入る");
  // 7111 保険請求分
  check(p.hoken !== null && num(F(p.hoken!, 7)) === 1, "7111 保険請求分 件数 1", p.hoken ? F(p.hoken, 7) : "なし");
  check(num(F(p.hoken!, 8)) === total, "7111 単位数 == 合計単位数", F(p.hoken!, 8));
  check(num(F(p.hoken!, 9)) === expAmount, "7111 費用合計 == 請求金額", F(p.hoken!, 9));
}

// ── I: 基本コードが無いレセプト (加算のみ) ────────────────────
console.log("\n=== I. 基本コードなし・加算だけのレセプト (月途中の死亡でターミナルのみ) ===");
{
  // 実在ケース: 給付管理をしないので居宅介護支援費 (432xxx) が立たず、
  // ターミナルケアマネジメント加算 400単位 (+処遇改善 8単位) だけを請求する
  const lines = [ml("436104", 400), ml("436199", 8)];
  const total = 408;
  const u = user({ userName: "ターミナルのみ", insuredNumber: "1000000002", serviceCode: "436104", units: total, lines });
  const { p, warnings } = build([u]);
  const rows = p.byUser.get("1000000002")!;
  const last = rows[rows.length - 1];
  check(rows.length === 2, "明細 2 行 (基本コード無し)", `${rows.length}`);
  check(num(F(last, 21)) === total, "合計単位数 408", F(last, 21));
  const exp = Math.floor((total * P100) / 100); // 4422
  check(num(F(last, 22)) === exp, "請求金額 = floor(408 × 10.84) ", `${F(last, 22)} (期待 ${exp})`);
  check(!warnings.some((w) => w.includes("サービスコードが年度別単位数マスタ")), "基本コード無しでも「コード未登録」warning は出ない");
}

// ── D/E: 公費 ───────────────────────────────────────────────
console.log("\n=== D/E. 公費 ===");
{
  const lines = [ml("432211", 1411)];
  const heiyou = user({ userName: "公費併用", insuredNumber: "1000000003", units: 1411, lines,
    kohiHobetsu: "12", kohiFutanshaNumber: "12121018", kohiJukyushaNumber: "0040980" });
  const tandoku = user({ userName: "公費単独", insuredNumber: "H000000004", units: 1411, lines,
    kohiTandoku: true, kohiHobetsu: "12", kohiFutanshaNumber: "12121018", kohiJukyushaNumber: "0040981",
    requestDate: null });
  const { p } = build([heiyou, tandoku]);
  const hRows = p.byUser.get("1000000003")!;
  check(F(hRows[0], 8) === "" && F(hRows[0], 9) === "", "E: 公費併用は 項8/9 が空 (居宅介護支援費は10割保険給付)",
    `[${F(hRows[0], 8)}][${F(hRows[0], 9)}]`);
  const tRows = p.byUser.get("H000000004")!;
  check(F(tRows[0], 8) === "12121018" && F(tRows[0], 9) === "0040981", "公費単独は 項8/9 に番号が入る",
    `[${F(tRows[0], 8)}][${F(tRows[0], 9)}]`);
  check(num(F(p.hoken!, 7)) === 1, "D: 7111 保険請求分は 1 件 (公費単独を除く)", F(p.hoken!, 7));
  const k12 = p.kohi.get("12");
  const expAmount = Math.floor((1411 * P100) / 100);
  check(!!k12, "法別12 の公費請求分レコードがある");
  if (k12) check(num(F(k12, 7)) === 1 && num(F(k12, 11)) === expAmount, "D: 公費請求分は 件数1・10割",
    `件数${F(k12, 7)} 公費請求${F(k12, 11)} (期待 ${expAmount})`);
}

// ── H: 処理対象年月とファイル名 ──────────────────────────────
console.log("\n=== H. 処理対象年月 = 提出月 / ファイル名 ===");
{
  const u = [user({ userName: "通常", lines: [ml("432211", 1411)] })];
  const a = build(u);
  check(a.p.ctrl[10] === "202607", "既定: 提供月の翌月", a.p.ctrl[10]);
  const b = build(u, { shoriYear: 2026, shoriMonth: 8 });
  check(b.p.ctrl[10] === "202608", "再請求: shoriYear/Month が効く", b.p.ctrl[10]);
  check(a.fileName === "S202606.CSV", "ファイル名 S202606.CSV", a.fileName);
}

// ── J: ★ units と Σlines の食い違い ─────────────────────────
console.log("\n=== J. ★ u.units と Σlines が食い違うとき ===");
{
  // 合計単位数 (項21) は Σlines、請求金額 (項22) は u.units から計算される。
  // 呼出側が両方を組み立てるので、食い違うと**票の中で基準がズレる**。
  const lines = [ml("432211", 1411), ml("433001", 300)]; // Σ = 1711
  const u = user({ userName: "不整合", insuredNumber: "1000000005", units: 1411, lines }); // units は基本のみ
  const { p, warnings } = build([u]);
  const rows = p.byUser.get("1000000005")!;
  const last = rows[rows.length - 1];
  const sum20 = rows.reduce((s, c) => s + num(F(c, 20)), 0);
  const t21 = num(F(last, 21));
  const t22 = num(F(last, 22));
  const fromUnits = Math.floor((1411 * P100) / 100);
  const fromLines = Math.floor((1711 * P100) / 100);
  console.log(`     Σ項20 = ${sum20} / 項21 = ${t21} / 項22 = ${t22}`);
  console.log(`     (u.units 1411 基準なら ${fromUnits} / Σlines 1711 基準なら ${fromLines})`);
  check(t21 === sum20, "項21 は Σ項20 と一致する", `${t21} / ${sum20}`);
  const consistent = t22 === Math.floor((t21 * P100) / 100);
  const warned = warnings.some((w) => w.includes("単位") && (w.includes("合計") || w.includes("一致")));
  if (!consistent && !warned) {
    console.log(`  ⚠ **項22 が 項21 と別基準で計算され、warning も出ない**`);
    console.log(`     項21 ${t21} 単位 なのに 項22 は ${t22} 円 (= ${fromUnits === t22 ? "u.units" : "?"} 基準)`);
    console.log(`     → 呼出側が u.units と lines を別々に組み立てるため、食い違うと静かに不整合になる`);
  }
  check(consistent || warned, "項22 が 項21 と同じ基準 か、食い違いに warning が出る",
    consistent ? "一致" : (warned ? "warning あり" : "★ どちらでもない"));
}

console.log(`\n${fails.length === 0 ? "すべて PASS" : `★ ${fails.length} 件 FAIL`}`);
for (const f of fails) console.log(`  - ${f}`);
if (fails.length > 0) process.exit(1);
