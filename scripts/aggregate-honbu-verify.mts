/**
 * 本部請求 (aggregate-honbu.ts) の純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/aggregate-honbu-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   ★ money-safety: ファイル冒頭コメントの通り、本モジュールは既存の集計関数
 *   (aggregateMonthlyVisitSeikyu等) の値を「整数加算で畳む」だけで金額計算式
 *   には一切触れない。ここで検証するのは畳み込み(sumKaigo/sumShogai)と
 *   法人グルーピング(groupOfficesByCompany)の2つで、どちらも未検証だった。
 *
 *   ★ sumKaigo と sumShogai には非対称性がある (コメントに明記):
 *     kaigo: kohiAmount = kohiAmount + kohi2Amount (公費1+公費2を合算)
 *     shogai: kohiAmount は常に0 (障害は公費を別額で持たないため)
 *   これは意図的な設計だが、うっかり対称にする("直し"のつもりで)と
 *   障害行に存在しないkohi2Amount的な値を誤って加算しかねない。
 *
 *   groupOfficesByCompanyは元々aggregateHonbu (DBを呼ぶ非同期関数)の中に
 *   埋め込まれておりハーネスから呼べなかった (7-1bと同型)。切り出しは
 *   挙動不変 (tsc --noEmit 0エラーで確認済み)。
 */
import {
  emptySummary,
  billedAmount,
  combineAll,
  sumKaigo,
  sumShogai,
  groupOfficesByCompany,
  type HonbuSummary,
  type HonbuOfficeRow,
} from "@/lib/honbu-seikyu/aggregate-honbu";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import type { ShogaiSeikyuRow } from "@/lib/shogai-seikyu/aggregate";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const kaigoRow = (o: Partial<UserSeikyuRow>): UserSeikyuRow => ({ ...o }) as UserSeikyuRow;
const shogaiRow = (o: Partial<ShogaiSeikyuRow>): ShogaiSeikyuRow => ({ ...o }) as ShogaiSeikyuRow;

// ── emptySummary / billedAmount ──────────────────────────────────────────
eq("emptySummary は全項目0", emptySummary(), { count: 0, totalUnits: 0, totalAmount: 0, insuranceAmount: 0, kohiAmount: 0, userAmount: 0 });
eq("billedAmount = insurance + kohi (userAmountは含まない)", billedAmount({ count: 1, totalUnits: 0, totalAmount: 1000, insuranceAmount: 700, kohiAmount: 100, userAmount: 200 }), 800);

// ── sumKaigo ──────────────────────────────────────────────────────────────
{
  const rows = [
    kaigoRow({ totalUnits: 1000, totalAmount: 10000, insuranceAmount: 7000, kohiAmount: 500, kohi2Amount: 300, userAmount: 2200 }),
    kaigoRow({ totalUnits: 500, totalAmount: 5000, insuranceAmount: 3500, kohiAmount: 0, kohi2Amount: 0, userAmount: 1500 }),
  ];
  const s = sumKaigo(rows);
  eq("count は行数", s.count, 2);
  eq("totalUnits は単純加算", s.totalUnits, 1500);
  eq("★ kohiAmount は 公費1+公費2 の合算", s.kohiAmount, 800);
  eq("insuranceAmount は単純加算", s.insuranceAmount, 10500);
  eq("空配列は emptySummary と同じ", sumKaigo([]), emptySummary());
  eq("★ null/undefined の数値項目は0扱い (?? 0)", sumKaigo([kaigoRow({})]), { count: 1, totalUnits: 0, totalAmount: 0, insuranceAmount: 0, kohiAmount: 0, userAmount: 0 });
}

// ── sumShogai ─────────────────────────────────────────────────────────────
{
  const rows = [
    shogaiRow({ totalUnits: 800, totalAmount: 8000, benefitAmount: 7200, userAmount: 800 }),
  ];
  const s = sumShogai(rows);
  eq("count は行数", s.count, 1);
  eq("★ insuranceAmount は benefitAmount (給付費) をそのまま使う", s.insuranceAmount, 7200);
  eq("★ 障害は kohiAmount が常に0 (公費を別額で持たない設計)", s.kohiAmount, 0);
  eq("空配列は emptySummary と同じ", sumShogai([]), emptySummary());
}

// ── combineAll ────────────────────────────────────────────────────────────
{
  const kaigo: HonbuSummary = { count: 1, totalUnits: 100, totalAmount: 1000, insuranceAmount: 700, kohiAmount: 100, userAmount: 200 };
  const sougou: HonbuSummary = { count: 2, totalUnits: 50, totalAmount: 500, insuranceAmount: 350, kohiAmount: 0, userAmount: 150 };
  const shogai: HonbuSummary = { count: 3, totalUnits: 300, totalAmount: 3000, insuranceAmount: 2700, kohiAmount: 0, userAmount: 300 };
  const combined = combineAll({ kaigo, sougou, shogai });
  eq("★ 3制度の count が単純加算される", combined.count, 6);
  eq("★ 3制度の totalAmount が単純加算される (端数処理は挟まない)", combined.totalAmount, 4500);
  eq("combineAll は入力を破壊しない (kaigo自体は変わらない)", kaigo.count, 1);
}

// ── groupOfficesByCompany ─────────────────────────────────────────────────
{
  const mkOffice = (o: Partial<HonbuOfficeRow> & { officeId: string; companyId: string | null }): HonbuOfficeRow => ({
    officeName: "テスト事業所",
    serviceType: "訪問介護",
    kaigo: emptySummary(),
    sougou: emptySummary(),
    shogai: emptySummary(),
    ...o,
  });
  const withAmount = (amount: number): HonbuSummary => ({ ...emptySummary(), count: 1, totalAmount: amount, insuranceAmount: amount });

  const officeRows: HonbuOfficeRow[] = [
    mkOffice({ officeId: "o1", companyId: "co-b", kaigo: withAmount(1000) }),
    mkOffice({ officeId: "o2", companyId: "co-a", kaigo: withAmount(2000) }),
    mkOffice({ officeId: "o3", companyId: null, kaigo: withAmount(300) }), // 法人未設定
    mkOffice({ officeId: "o4", companyId: "co-a", kaigo: withAmount(500) }), // co-a の2件目
  ];
  const companyNames = new Map([
    ["co-a", "株式会社エー"],
    ["co-b", "株式会社ビー"],
    // co-c は意図的に登録しない (companyId はあるが名前が引けないケース用、後段で使う)
  ]);
  const { groups, grand } = groupOfficesByCompany(officeRows, companyNames);

  eq("★ 法人ごとに正しくグループ化される (3法人 + 法人未設定)", groups.length, 3);
  eq("★ 法人未設定 (companyId=null) は末尾に来る", groups[groups.length - 1].companyId, null);
  eq("法人未設定の表示名は「(法人未設定)」", groups[groups.length - 1].companyName, "(法人未設定)");
  eq("★ 五十音順ソート (エー→ビー、Unicode順ではなく ja ロケール)", groups.slice(0, 2).map((g) => g.companyId), ["co-a", "co-b"]);
  eq("★ 同じ法人の事業所は同じグループにまとまる (co-aに2件)", groups.find((g) => g.companyId === "co-a")?.offices.length, 2);
  eq("★ 法人小計は所属事業所の合算 (co-a: 2000+500)", groups.find((g) => g.companyId === "co-a")?.subtotal.all.totalAmount, 2500);
  eq("★ 全社総計は全事業所の合算 (1000+2000+300+500)", grand.all.totalAmount, 3800);

  const nameless = groupOfficesByCompany(
    [mkOffice({ officeId: "o5", companyId: "co-c", kaigo: withAmount(100) })],
    companyNames,
  );
  eq("★ companyId はあるが companyNames に無い場合は「(法人名不明)」(companyId自体は保持)", [nameless.groups[0].companyId, nameless.groups[0].companyName], ["co-c", "(法人名不明)"]);

  eq("事業所0件なら groups も grand も空/ゼロ", groupOfficesByCompany([], companyNames), { groups: [], grand: { kaigo: emptySummary(), sougou: emptySummary(), shogai: emptySummary(), all: emptySummary() } });
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 障害の公費を kaigo と同じように合算してしまう壊れた実装
  const rows = [shogaiRow({ totalUnits: 100, totalAmount: 1000, benefitAmount: 900, userAmount: 100 })];
  const correct = sumShogai(rows);
  // ★ ShogaiSeikyuRow には kohiAmount フィールドが無いが、壊れた実装は kaigo と同じ式を流用してしまう想定
  const broken = { ...correct, kohiAmount: (rows[0] as unknown as { kohiAmount?: number }).kohiAmount ?? 999 };
  const detected1 = correct.kohiAmount === 0 && broken.kohiAmount !== 0;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 障害のkohiAmount=0固定を検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 障害のkohiAmountを誤って非0にするバグを検出できる (正=${correct.kohiAmount} / 壊れた版=${broken.kohiAmount})`);

  // ② 法人未設定を末尾ではなく先頭に置く壊れた実装
  const mkOffice = (companyId: string | null): HonbuOfficeRow => ({
    officeId: "x", officeName: "x", serviceType: "訪問介護", companyId,
    kaigo: emptySummary(), sougou: emptySummary(), shogai: emptySummary(),
  });
  const rows2 = [mkOffice("co-a"), mkOffice(null)];
  const names = new Map([["co-a", "エー"]]);
  const correctOrder = groupOfficesByCompany(rows2, names).groups.map((g) => g.companyId);
  const brokenSort = [...groupOfficesByCompany(rows2, names).groups].sort((a, b) => {
    // ★ null優先(先頭)にする壊れた比較関数
    if (a.companyId === null) return -1;
    if (b.companyId === null) return 1;
    return a.companyName.localeCompare(b.companyName, "ja");
  }).map((g) => g.companyId);
  const detected2 = JSON.stringify(correctOrder) !== JSON.stringify(brokenSort);
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: 法人未設定の並び順(末尾/先頭)を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 法人未設定を先頭に置く(正は末尾)並び順バグを検出できる (正=${JSON.stringify(correctOrder)} / 壊れた版=${JSON.stringify(brokenSort)})`);
}

console.log(`\n本部請求 横断集計 (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
