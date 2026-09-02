/**
 * 居宅 給付管理票 (8222 / K ファイル) の境界値検証 — **DB を一切触らない**
 *
 *   npx tsx scripts/kyufu-kanri-8222-verify.mts
 *
 * buildKyufuKanriFile は純関数 (users + opts → 文字列) なので in-memory の
 * fixture で検算する。テストデータの投入・削除が要らず、他セッションが
 * 測定中でも安全に回せる (VERIFICATION_RULES 6-1 / 7-1)。
 *
 * ── この検査が証明すること (3-1) ────────────────────────────
 *   A. 終端行(99) 項24 給付計画合計単位数 == Σ明細行(01-98) 項20   ← 票の恒等式
 *   B. 明細行は**提供事業所番号の昇順** (当システムの決定的な並び順。⚠ほのぼの一致ではない)
 *   C. 明細は最大 98 行。超えたら切り捨てて warning (行番号99 は終端行のため)
 *   D. 終端行 項15 == 区分支給限度基準額 / 項17-19 は "0" 固定
 *   E. 給付管理票情報作成区分 (項5) に 1=新規 / 2=修正 / 3=取消 が出る
 *   F. 利用者ごとの対象年月 (項2) — 月遅れ分を当月分と 1 ファイルに混在できる
 *   G. 月途中の保険者変更: 保険者別に票が分かれ、**按分の合計は元の計画単位数と一致**
 *   H. 証記載保険者番号 (項3) は数字8桁・前0埋め
 *   I. コントロールレコードの処理対象年月 = **提出月** (サービス提供月ではない)
 *
 * ── この検査が証明しないこと ────────────────────────────────
 *   ・給付計画単位数そのものの正しさ (呼出側が組み立てる値をそのまま出すため)
 *   ・ほのぼの実伝送とのバイト一致 (それは scripts/kyotaku-k-diff.mts の担当)
 *   ・**明細行の並び順がほのぼのと同じであること** — 実伝送 KY 30本/5,732票を実測した結果、
 *     事業所番号昇順 36.6% / 単位数昇順 37.9% / 種類コード昇順 29.9% と、どの規則でも
 *     3〜4割止まりで規則が読めなかった (入力順と思われる)。当方は決定的な順序を選んで
 *     いるだけ。突合側は票内の行を両側ソートしてから比較するので実害はない
 *
 * ── 実データでの裏取り (3-5。2026-09-03 / KY 30本・給付管理票 5,732票) ──
 *   A 恒等式 Σ明細(20)==終端(24)   5,732 / 5,732  ✅ 実伝送でも例外なし
 *   H 保険者番号が数字8桁            5,732 / 5,732  ✅
 *   終端行(99)が無い票               0 票          ✅
 *   C 明細行数の最大                 7 行 (上限98 に対し十分小さい)
 *   E 作成区分(項5) の分布           1(新規) 5,658 / 2(修正) 74 — 3(取消) の実例は無い
 * ────────────────────────────────────────────────────────
 */
import {
  buildKyufuKanriFile,
  type KyufuKanriUser,
  type KyufuKanriLine,
} from "@/lib/kokuho-densou/build-kyotaku";

const OFFICE = "1279999999";
// 8222 は単位数単価を持たないが KyotakuDensouOptions が必須にしているため渡す
const UNIT_PRICE = 11.05;
const YEAR = 2026;
const MONTH = 6;

const line = (officeNumber: string, serviceKindCode: string, plannedUnits: number): KyufuKanriLine => ({
  officeNumber, serviceKindCode, plannedUnits,
});

const user = (o: Partial<KyufuKanriUser> & { userName: string; lines: KyufuKanriLine[] }): KyufuKanriUser => ({
  userName: o.userName,
  insurerNumber: o.insurerNumber ?? "121012",
  insuredNumber: o.insuredNumber ?? "1000000001",
  // ⚠ `o.birthDate ?? 既定` にすると **明示的に渡した null が既定値に化けて**
  //   「生年月日なし」の経路をテストできない (2026-09-03 に実際に踏んだ)。
  //   未指定と「明示的な null」を区別するため in 演算子で見る。
  birthDate: "birthDate" in o ? (o.birthDate ?? null) : "1938-04-04",
  gender: "gender" in o ? (o.gender ?? null) : "女",
  careLevel: "careLevel" in o ? (o.careLevel ?? null) : "要介護3",
  limitStart: o.limitStart ?? "2026-04-01",
  limitEnd: o.limitEnd ?? "2027-03-31",
  limitUnits: o.limitUnits ?? 27048,
  lines: o.lines,
  sakuseiKubun: o.sakuseiKubun,
  splitSegments: o.splitSegments,
  dailyActuals: o.dailyActuals,
  careManagerNumber: o.careManagerNumber ?? "0012345",
  ym: o.ym,
});

// 項番 N は c[N+1] (行頭に レコード種別・連番 の 2 列が付くため)
const F = (c: string[], n: number) => (c[n + 1] ?? "").replace(/"/g, "").trim();
const num = (s: string) => (s === "" ? 0 : Number(s));

interface Ticket { insurer: string; insured: string; ym: string; kubun: string; detail: string[][]; end: string[] | null }
function parse(content: string): { ctrl: string[]; tickets: Ticket[] } {
  const lines = content.split(/\r?\n/).filter(Boolean).map((l) => l.split(","));
  const ctrl = lines[0];
  const map = new Map<string, Ticket>();
  for (const c of lines) {
    if (F(c, 1) !== "8222") continue;
    const key = `${F(c, 2)}|${F(c, 9)}|${F(c, 2)}`; // 保険者|被保番 (対象年月は票内共通)
    const k = `${F(c, 2)}|${F(c, 9)}`;
    if (!map.has(k)) map.set(k, { insurer: F(c, 3), insured: F(c, 9), ym: F(c, 2), kubun: F(c, 5), detail: [], end: null });
    void key;
    const t = map.get(k)!;
    if (F(c, 8) === "99") t.end = c;
    else t.detail.push(c);
  }
  return { ctrl, tickets: [...map.values()] };
}

const fails: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const build = (users: KyufuKanriUser[], opts: Partial<{ shoriYear: number; shoriMonth: number }> = {}) => {
  const r = buildKyufuKanriFile(users, { officeNumber: OFFICE, year: YEAR, month: MONTH, unitPrice: UNIT_PRICE, ...opts });
  return { ...r, p: parse(r.content) };
};
/** 全ケース共通で必ず成り立つ恒等式 (A) */
const assertIdentity = (p: { tickets: Ticket[] }, tag: string) => {
  for (const t of p.tickets) {
    const sum = t.detail.reduce((s, c) => s + num(F(c, 20)), 0);
    const end = t.end ? num(F(t.end, 24)) : NaN;
    if (sum !== end) fails.push(`${tag} 恒等式: 票(${t.insurer}|${t.insured}) Σ明細 ${sum} ≠ 終端 ${end}`);
  }
};

console.log(`居宅 給付管理票 (8222) の境界値検証 — DB 不使用 / 対象月 ${YEAR}-${String(MONTH).padStart(2, "0")}\n`);

// ── A/B/D: 基本形 ────────────────────────────────────────────
console.log("=== A/B/D. 基本形 (1利用者・3事業所) ===");
{
  const u = user({ userName: "基本", lines: [
    line("1279999003", "15", 5000), // 通所介護
    line("1279999001", "11", 12000), // 訪問介護
    line("1279999002", "13", 3000), // 訪問看護
  ]});
  const { p } = build([u]);
  const t = p.tickets[0];
  check(p.tickets.length === 1, "票は 1 つ", `${p.tickets.length}`);
  check(t.detail.length === 3, "明細 3 行", `${t.detail.length}`);
  const nos = t.detail.map((c) => F(c, 8));
  check(JSON.stringify(nos) === JSON.stringify(["01", "02", "03"]), "行番号 01,02,03", nos.join(","));
  const offs = t.detail.map((c) => F(c, 17));
  check(JSON.stringify(offs) === JSON.stringify([...offs].sort()), "B: 事業所番号の昇順", offs.join(" < "));
  const sum = t.detail.reduce((s, c) => s + num(F(c, 20)), 0);
  check(sum === 20000 && num(F(t.end!, 24)) === 20000, "A: Σ明細(項20) == 終端(項24)", `Σ${sum} / 終端${num(F(t.end!, 24))}`);
  check(num(F(t.end!, 15)) === 27048, "D: 終端 項15 = 区分支給限度基準額", F(t.end!, 15));
  check(F(t.end!, 17) === "0" && F(t.end!, 18) === "0" && F(t.end!, 19) === "0", "D: 終端 項17-19 は 0 固定",
    `${F(t.end!, 17)}/${F(t.end!, 18)}/${F(t.end!, 19)}`);
  check(F(t.end!, 25) === "0012345", "終端 項25 = ケアマネ番号", F(t.end!, 25));
  check(t.detail.every((c) => F(c, 15) === ""), "明細の 項15 (限度額) は空");
  assertIdentity(p, "A");
}

// ── C: 明細 98 行の上限 ──────────────────────────────────────
console.log("\n=== C. 明細行の上限 98 行 (行番号99 は終端行) ===");
{
  const mk = (n: number) => Array.from({ length: n }, (_, i) =>
    line(`12799${String(i).padStart(5, "0")}`, "11", 100));
  for (const [n, expDetail, expWarn] of [[98, 98, 0], [99, 98, 1], [120, 98, 1]] as const) {
    const { p, warnings } = build([user({ userName: `上限${n}`, lines: mk(n) })]);
    const t = p.tickets[0];
    const w = warnings.filter((x) => x.includes("98 行"));
    check(t.detail.length === expDetail && w.length === expWarn,
      `${n} 行 → 明細 ${t.detail.length} 行 / warning ${w.length} 件`, `期待 ${expDetail} 行 / ${expWarn} 件`);
    // ⚠ 切り捨てが起きると 終端の合計は「出力された98行」の合計になる (恒等式は保たれる)
    assertIdentity(p, `C:${n}`);
  }
}

// ── E: 作成区分 (新規/修正/取消) ──────────────────────────────
console.log("\n=== E. 給付管理票情報作成区分 (項5) ===");
{
  for (const [k, label] of [["1", "新規"], ["2", "修正"], ["3", "取消"]] as const) {
    const { p } = build([user({ userName: label, sakuseiKubun: k, lines: [line("1279999001", "11", 1000)] })]);
    check(p.tickets[0].kubun === k, `${label} → 項5 = ${k}`, p.tickets[0].kubun);
  }
  const { p } = build([user({ userName: "既定", lines: [line("1279999001", "11", 1000)] })]);
  check(p.tickets[0].kubun === "1", "省略時は 1 (新規)", p.tickets[0].kubun);
}

// ── F: 利用者ごとの対象年月 (月遅れを同一ファイルに) ──────────
console.log("\n=== F. 月遅れ分を当月分と 1 ファイルに混在 ===");
{
  const { p } = build([
    user({ userName: "当月", insuredNumber: "1000000001", lines: [line("1279999001", "11", 1000)] }),
    user({ userName: "月遅れ", insuredNumber: "1000000002", ym: "202605", sakuseiKubun: "2",
      lines: [line("1279999001", "11", 2000)] }),
  ]);
  const byIns = new Map(p.tickets.map((t) => [t.insured, t]));
  check(byIns.get("1000000001")?.ym === "202606", "当月の利用者 → 項2 = 202606", byIns.get("1000000001")?.ym ?? "—");
  check(byIns.get("1000000002")?.ym === "202605", "月遅れの利用者 → 項2 = 202605", byIns.get("1000000002")?.ym ?? "—");
  check(byIns.get("1000000002")?.kubun === "2", "月遅れは 修正(2) を指定できる", byIns.get("1000000002")?.kubun ?? "—");
  assertIdentity(p, "F");
}

// ── G: 月途中の保険者変更 (転居) の分割と按分 ─────────────────
console.log("\n=== G. 月途中の保険者変更 — 票の分割と按分 ===");
{
  // 6/1〜6/15 = 千葉市 / 6/16〜6/30 = 船橋市。訪問介護の実績を 前半 6,000 / 後半 4,000 単位
  const u = user({
    userName: "転居", insurerNumber: "122011", insuredNumber: "9900000102",
    lines: [line("1279999001", "11", 10000)],
    splitSegments: [
      { from: "2026-06-01", to: "2026-06-15", insurerNumber: "121012", insuredNumber: "9900000101",
        careLevel: "要介護3", limitStart: "2026-04-01", limitEnd: "2026-06-15", limitUnits: 27048 },
      { from: "2026-06-16", to: "2026-06-30", insurerNumber: "122011", insuredNumber: "9900000102",
        careLevel: "要介護3", limitStart: "2026-06-16", limitEnd: "2027-03-31", limitUnits: 27048 },
    ],
    dailyActuals: [
      { date: "2026-06-05", serviceKindCode: "11", officeNumber: "1279999001", units: 6000 },
      { date: "2026-06-20", serviceKindCode: "11", officeNumber: "1279999001", units: 4000 },
    ] as KyufuKanriUser["dailyActuals"],
  });
  const { p } = build([u]);
  check(p.tickets.length === 2, "票が 2 つに分かれる", `${p.tickets.length}`);
  const insurers = p.tickets.map((t) => t.insurer).sort();
  check(JSON.stringify(insurers) === JSON.stringify(["00121012", "00122011"]), "H: 保険者番号は8桁前0埋めで 2 種類", insurers.join(","));
  const insureds = p.tickets.map((t) => t.insured).sort();
  check(JSON.stringify(insureds) === JSON.stringify(["9900000101", "9900000102"]), "被保険者番号も票ごとに違う", insureds.join(","));
  const totals = p.tickets.map((t) => num(F(t.end!, 24)));
  const grand = totals.reduce((a, b) => a + b, 0);
  check(grand === 10000, "★ 按分の合計 == 元の給付計画単位数", `${totals.join(" + ")} = ${grand} (期待 10000)`);
  check(totals.includes(6000) && totals.includes(4000), "実績比 6000:4000 で按分", totals.join(","));
  assertIdentity(p, "G");
}

// ── G': 按分に端数が出るケース (累積 round で合計が保たれるか) ──
console.log("\n=== G'. 按分の端数 (合計が崩れないか) ===");
{
  // 実績 1:2 で計画 1,001 単位 → 割り切れない
  for (const [a, b, planned] of [[1, 2, 1001], [7, 13, 999], [1, 1, 333]] as const) {
    const u = user({
      userName: `端数${a}:${b}`, insuredNumber: "9900000202",
      lines: [line("1279999001", "11", planned)],
      splitSegments: [
        { from: "2026-06-01", to: "2026-06-15", insurerNumber: "121012", insuredNumber: "9900000201",
          careLevel: "要介護3", limitStart: "2026-04-01", limitEnd: "2026-06-15", limitUnits: 27048 },
        { from: "2026-06-16", to: "2026-06-30", insurerNumber: "122011", insuredNumber: "9900000202",
          careLevel: "要介護3", limitStart: "2026-06-16", limitEnd: "2027-03-31", limitUnits: 27048 },
      ],
      dailyActuals: [
        { date: "2026-06-05", serviceKindCode: "11", officeNumber: "1279999001", units: a },
        { date: "2026-06-20", serviceKindCode: "11", officeNumber: "1279999001", units: b },
      ] as KyufuKanriUser["dailyActuals"],
    });
    const { p } = build([u]);
    const totals = p.tickets.map((t) => num(F(t.end!, 24)));
    const grand = totals.reduce((x, y) => x + y, 0);
    check(grand === planned, `実績${a}:${b} 計画${planned} → 合計が一致`, `${totals.join(" + ")} = ${grand}`);
    assertIdentity(p, `G':${a}:${b}`);
  }
}

// ── I: コントロールレコードの処理対象年月 = 提出月 ────────────
console.log("\n=== I. 処理対象年月 (コントロール項11) = 提出月 ===");
{
  const u = [user({ userName: "通常", lines: [line("1279999001", "11", 1000)] })];
  const a = build(u);
  check(a.p.ctrl[10] === "202607", "既定: サービス提供月の翌月", a.p.ctrl[10]);
  const b = build(u, { shoriYear: 2026, shoriMonth: 8 });
  check(b.p.ctrl[10] === "202608", "再請求: shoriYear/Month の指定が効く", b.p.ctrl[10]);
  check(a.fileName === "K202606.CSV", "ファイル名は提供月", a.fileName);
}

// ── 異常系の warning ─────────────────────────────────────────
console.log("\n=== 異常系: warning が出るか ===");
{
  const cases: [string, KyufuKanriUser, string][] = [
    ["限度額 0", user({ userName: "限度0", limitUnits: 0, lines: [line("1279999001", "11", 1000)] }), "区分支給限度基準額が未登録"],
    ["生年月日なし", user({ userName: "生年月日なし", birthDate: null, lines: [line("1279999001", "11", 1000)] }), "生年月日が未登録"],
    ["保険者なし", user({ userName: "保険者なし", insurerNumber: "", lines: [line("1279999001", "11", 1000)] }), "保険者番号が未登録"],
    ["要介護度不明", user({ userName: "要介護度不明", careLevel: "不明", lines: [line("1279999001", "11", 1000)] }), "コードに変換できません"],
    ["種類コードなし", user({ userName: "種類コードなし", lines: [line("1279999001", "", 1000)] }), "サービス種類コード未設定"],
    ["事業所番号なし", user({ userName: "事業所番号なし", lines: [line("", "11", 1000)] }), "サービス事業所番号が未設定"],
  ];
  for (const [label, u, expect] of cases) {
    const { warnings } = build([u]);
    const hit = warnings.filter((w) => w.includes(expect));
    check(hit.length >= 1, `${label} → warning`, hit.length ? "出た" : `出ない (全${warnings.length}件)`);
  }
  // 事業所番号が 10 桁でない
  const r = buildKyufuKanriFile([user({ userName: "桁", lines: [line("1279999001", "11", 1000)] })],
    { officeNumber: "12799", year: YEAR, month: MONTH, unitPrice: UNIT_PRICE });
  check(r.warnings.some((w) => w.includes("10 桁")), "居宅事業所番号が10桁でない → warning");
}

console.log(`\n${fails.length === 0 ? "すべて PASS" : `★ ${fails.length} 件 FAIL`}`);
for (const f of fails) console.log(`  - ${f}`);
if (fails.length > 0) process.exit(1);
