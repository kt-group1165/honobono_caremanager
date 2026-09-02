/**
 * 給付管理票 (8222) の境界値検証 — buildKyufuKanriFile の純関数テスト
 *
 * ⚠ **DB には一切触らない。**buildKyufuKanriFile は supabase を参照しない純関数
 *   (入力 = KyufuKanriUser[] / 出力 = CSV 文字列) なので、本番DBにテストデータを
 *   入れなくても境界値を検算できる。marker 付きサンプル投入より安全で速い。
 *
 * 検証する境界:
 *   A. 複数のサービス事業所を利用する利用者 (按分ではなく事業所ごとに1明細行)
 *   B. 限度額を超過するケース (項15 限度額 と 項24 合計単位数 の関係)
 *   C. 月途中でサービス事業所が変わるケース (旧/新の2事業所が同月に並ぶ)
 *   D. 予防 (要支援) と 要介護 が混在する月 = 区分変更
 *   E. 明細 98 行上限
 *
 *   npx tsx scripts/verify-kyufu-kanri-boundary.mts
 */
import {
  buildKyufuKanriFile,
  type KyufuKanriUser,
  type KyufuKanriLine,
  type KyotakuDensouOptions,
} from "../src/lib/kokuho-densou/build-kyotaku";

const OPTS: KyotakuDensouOptions = {
  officeNumber: "1234567890",
  year: 2026,
  month: 6,
  unitPrice: 10.7,
};

const line = (officeNumber: string, kind: string, units: number): KyufuKanriLine => ({
  officeNumber,
  serviceKindCode: kind,
  plannedUnits: units,
});

const baseUser = (over: Partial<KyufuKanriUser> = {}): KyufuKanriUser => ({
  userName: "検証 太郎",
  insurerNumber: "122192",
  insuredNumber: "0000000001",
  birthDate: "1940-05-01",
  gender: "男",
  careLevel: "要介護3",
  limitStart: "2026-04-01",
  limitEnd: "2027-03-31",
  limitUnits: 27048,
  lines: [],
  careManagerNumber: "12345678",
  ...over,
});

/**
 * 出力 CSV から 8222 のデータ行だけを取り出す。
 * 各行は `2,<連番>,8222,...` の形なので、先頭2列を落として **項番 = index+1**
 * (項1=8222) に揃えた配列を返す。
 */
function parse8222(content: string): string[][] {
  return content
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split(",").map((s) => s.replace(/^"|"$/g, "")))
    .filter((c) => c[0] === "2" && c[2] === "8222")
    .map((c) => c.slice(2));
}
/** 項番 (1始まり) で引く */
const f = (row: string[], no: number) => row[no - 1];

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n      期待 ${JSON.stringify(expected)}\n      実際 ${JSON.stringify(actual)}`}`);
}

// ── A. 複数のサービス事業所 ─────────────────────────────────────────
console.log("\n【A】複数のサービス事業所を利用する利用者");
{
  const u = baseUser({
    lines: [
      line("2222222222", "15", 8000),  // 通所介護
      line("1111111111", "11", 12000), // 訪問介護
      line("3333333333", "17", 5000),  // 福祉用具貸与
    ],
  });
  const res = buildKyufuKanriFile([u], OPTS);
  const rows = parse8222(res.content);
  const detail = rows.filter((r) => f(r, 8) !== "99");
  const last = rows.find((r) => f(r, 8) === "99")!;

  check("明細行は事業所数ぶん (3行)", detail.length, 3);
  check("行番号が 01,02,03", detail.map((r) => f(r, 8)), ["01", "02", "03"]);
  check("事業所番号の昇順で並ぶ", detail.map((r) => f(r, 17)), ["1111111111", "2222222222", "3333333333"]);
  check("各行の給付計画単位数 (項20)", detail.map((r) => f(r, 20)), ["12000", "8000", "5000"]);
  check("終端行の合計単位数 (項24) = 25000", f(last, 24), "25000");
  check("終端行の限度額 (項15) = 27048", f(last, 15), "27048");
  check("終端行の事業所/区分/種類は 0", [f(last, 17), f(last, 18), f(last, 19)], ["0", "0", "0"]);
  check("介護支援専門員番号 (項25)", f(last, 25), "12345678");
  check("按分はしない (合計は明細の単純和)", Number(f(last, 24)), 12000 + 8000 + 5000);
}

// ── B. 限度額超過 ───────────────────────────────────────────────────
console.log("\n【B】限度額を超過するケース (限度額 27048 に対し計画 30000)");
{
  const u = baseUser({
    userName: "超過 花子",
    lines: [line("1111111111", "11", 20000), line("2222222222", "15", 10000)],
  });
  const res = buildKyufuKanriFile([u], OPTS);
  const rows = parse8222(res.content);
  const last = rows.find((r) => f(r, 8) === "99")!;
  check("項24 は計画どおり 30000 (限度額で切り詰めない)", f(last, 24), "30000");
  check("項15 は限度額 27048 のまま", f(last, 15), "27048");
  console.log(`  ・警告: ${res.warnings.length === 0 ? "なし" : res.warnings.join(" / ")}`);
  console.log("  ※ 給付管理票は「計画した単位数」を載せる帳票。超過分の自己負担は");
  console.log("    明細書(サービス事業所側)で処理されるため、ここで丸めないのが正。");
}

// ── C. 月途中でサービス事業所が変わる ───────────────────────────────
console.log("\n【C】月途中でサービス事業所が変わる (訪問介護を旧→新に乗換)");
{
  const u = baseUser({
    userName: "乗換 次郎",
    lines: [
      line("1111111111", "11", 6000), // 前半: 旧事業所
      line("9999999999", "11", 5000), // 後半: 新事業所 (同じ種類コード11)
    ],
  });
  const res = buildKyufuKanriFile([u], OPTS);
  const rows = parse8222(res.content);
  const detail = rows.filter((r) => f(r, 8) !== "99");
  const last = rows.find((r) => f(r, 8) === "99")!;
  check("同一サービス種類でも事業所ごとに別行 (2行)", detail.length, 2);
  check("事業所番号", detail.map((r) => f(r, 17)), ["1111111111", "9999999999"]);
  check("種類コードは両方 11", detail.map((r) => f(r, 19)), ["11", "11"]);
  check("合計 = 11000", f(last, 24), "11000");
}

// ── D. 予防 (要支援) と 要介護 の混在 = 区分変更 ─────────────────────
console.log("\n【D】区分変更 (要支援2 → 要介護1) の月");
{
  const yobo = baseUser({
    userName: "予防 三郎",
    careLevel: "要支援2",
    limitUnits: 10531,
    lines: [line("1111111111", "11", 3000)],
  });
  const kaigo = baseUser({
    userName: "介護 四郎",
    careLevel: "要介護1",
    limitUnits: 16765,
    lines: [line("1111111111", "11", 9000)],
  });
  const res = buildKyufuKanriFile([yobo, kaigo], OPTS);
  const rows = parse8222(res.content);
  const yoboLast = rows.filter((r) => f(r, 9) === yobo.insuredNumber && f(r, 8) === "99")[0];
  check("要支援2 の要介護状態区分コード (項12) = 13", f(yoboLast, 12), "13");
  check("要支援2 の限度額 (項15)", f(yoboLast, 15), "10531");
  const kaigoRows = rows.filter((r) => f(r, 8) === "99");
  check("2 利用者ぶんの終端行が出る", kaigoRows.length, 2);
  console.log("  ⚠ 月途中の区分変更 (要支援→要介護) は splitSegments が保険者変更専用のため");
  console.log("    分割されず、渡された careLevel 1 つで 1 票になる。呼出側が月末時点の");
  console.log("    認定を渡す設計 (cert-for-month) なので、月末時点の区分で 1 票が出る。");
}

// ── E. 明細 98 行上限 ───────────────────────────────────────────────
console.log("\n【E】明細 98 行の上限 (99 は終端行)");
{
  const many = Array.from({ length: 100 }, (_, i) =>
    line(String(1000000000 + i), "11", 100),
  );
  const u = baseUser({ userName: "多数 五郎", lines: many });
  const res = buildKyufuKanriFile([u], OPTS);
  const rows = parse8222(res.content);
  const detail = rows.filter((r) => f(r, 8) !== "99");
  check("明細は 98 行で打ち切り", detail.length, 98);
  check("合計は出力した 98 行ぶん (9800)", f(rows.find((r) => f(r, 8) === "99")!, 24), "9800");
  const warned = res.warnings.some((w) => w.includes("98"));
  check("上限超過を警告する", warned, true);
  console.log("  ⚠ 打ち切られた 2 行は伝送に載らない = その事業所の給付管理が欠落する。");
  console.log("    警告は出るので気づけるが、実運用で 98 事業所は考えにくい (現状最大は要確認)。");
}

console.log(`\n${failures === 0 ? "✅ 全ての検算が一致しました" : `❌ ${failures} 件の不一致`}`);
process.exit(failures === 0 ? 0 : 1);
