/**
 * FB 全銀 (預金口座振替) — 境界値・往復整合の検証 (DB 不使用)
 *
 *   npx tsx scripts/fb-zengin-verify.mts
 *
 * ── なぜ要るか (claude-06 割当・2026-09-05) ────────────────────────────────
 *   src/lib/fb-zengin.ts / fb-zengin-result.ts に検証ハーネスが 0 本だった。
 *   国保連通知と違い、こちらは **失敗すると回収不能に直結**する経路 (お金が
 *   「入ってくる」側が壊れる)。実運用は riyou_seikyu_payments 1行のみ (2026-09-05
 *   実測)・payment_method='口座振替' は 0件 = **未運用**。
 *
 * ── ★ この script は実装を直さない。現況の確定と検査の追加までに留める ──
 *   (claude-06 の指示。金額と回収に効くため)
 *
 * ── ★ 仕様の裏付けについて (重要) ─────────────────────────────────────────
 *   国保連 IF (migrations/_if_kyotaku.txt 等) と違い、この repo には
 *   「全国銀行協会 標準フォーマット・預金口座振替」の一次仕様書が **保存されていない**。
 *   fb-zengin.ts の項目長・並びは一般に知られた標準レイアウトを踏襲しているが、
 *   ★ 項番単位で仕様書と突合できる形にはなっていない (kokuho-tsuchi との違い)。
 *   → この script が保証できるのは「実装の内部整合性 (往復・境界値)」までで、
 *     「銀行が受理する実ファイルと一致するか」は **実ファイルでしか確認できない**。
 *
 * ── 見つけた実データの状況 ──────────────────────────────────────────────
 *   riyou_seikyu_payments: 1 行のみ (2026-09-05 実測) / payment_method='口座振替' 0件
 *   → FB 依頼ファイルを実際に銀行へ出した形跡・結果ファイルを取り込んだ形跡は
 *     DB からは確認できない。★ 実ファイルでの検証が要る。
 */
import { buildFbZengin, toHankakuKana, type FbConsignor, type FbTransferTarget } from "@/lib/fb-zengin";
import { parseFbZenginResult, fbResultLabel } from "@/lib/fb-zengin-result";

let fails = 0, checks = 0;
const check = (label: string, cond: boolean, detail = "") => {
  checks++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) fails++;
};
const eq = (label: string, actual: unknown, expected: unknown) => {
  check(label, JSON.stringify(actual) === JSON.stringify(expected),
    `実際=${JSON.stringify(actual)} 期待=${JSON.stringify(expected)}`);
};

console.log("FB 全銀 (口座振替) 境界値・往復整合の検証 — DB 不使用\n");

const CONSIGNOR: FbConsignor = {
  consignorCode: "1234567890",
  consignorNameKana: "カブシキガイシャケイティ",
  transferDay: 27,
  year: 2026,
  month: 12,
};

/* ══════════════════════ ① 往復整合 (build → 同一レイアウトで読める) ══════════ */
console.log("=== ① 依頼ファイルの構造・往復整合 ===");
{
  const targets: FbTransferTarget[] = [
    {
      customerNumber: "0000012345", accountHolderKana: "タナカ　タロウ", // 全角スペース混入
      bankCode: "0001", branchCode: "001", bankName: "ミズホ", branchName: "チバ",
      accountType: "1", accountNumber: "1234567", amount: 12345,
    },
    {
      customerNumber: "0000067890", accountHolderKana: "ヤマダ ハナコ",
      bankCode: "0009", branchCode: "123", bankName: null, branchName: null,
      accountType: "2", accountNumber: "7654321", amount: 999,
    },
  ];
  const r = buildFbZengin(targets, CONSIGNOR);
  const lines = r.content.split("\r\n").filter((l) => l.length > 0);

  check("レコード数 = ヘッダ+データ2+トレーラ+エンド = 5", lines.length === 5, `${lines.length}`);
  for (const [i, l] of lines.entries()) check(`行${i + 1}: 120バイト固定長`, l.length === 120, `${l.length}`);
  eq("行1: データ区分=1 (ヘッダー)", lines[0][0], "1");
  eq("行2: データ区分=2 (データ)", lines[1][0], "2");
  eq("行3: データ区分=2 (データ)", lines[2][0], "2");
  eq("行4: データ区分=8 (トレーラ)", lines[3][0], "8");
  eq("行5: データ区分=9 (エンド)", lines[4][0], "9");
  eq("count = 2", r.count, 2);
  eq("totalAmount = 12345+999", r.totalAmount, 13344);
  eq("委託者側の警告なし (揃っている)", r.warnings.filter((w) => w.includes("委託者")).length, 0);

  // ★ 往復: 同一レイアウトで parseFbZenginResult に通し、値が復元できるか
  const parsed = parseFbZenginResult(r.content);
  check("パース: エラー無し", parsed.errors.length === 0, parsed.errors.join(" / "));
  eq("往復: header.consignorCode", parsed.header?.consignorCode, "1234567890");
  eq("往復: header.transferMMDD = 1227", parsed.header?.transferMMDD, "1227");
  check("往復: 明細2件", parsed.details.length === 2, `${parsed.details.length}`);
  const d0 = parsed.details[0];
  eq("往復: 明細1 bankCode", d0.bankCode, "0001");
  eq("往復: 明細1 branchCode", d0.branchCode, "001");
  eq("往復: 明細1 accountNumber", d0.accountNumber, "1234567");
  eq("往復: 明細1 amount", d0.amount, 12345);
  // ★ 全角スペース (1文字) は半角カナ変換で半角スペース (1文字) に落ちる
  eq("往復: 明細1 かな (全角スペース→半角)", d0.accountHolderKana, "ﾀﾅｶ ﾀﾛｳ");
  eq("往復: 明細2 accountType (当座=2)", parsed.details[1].accountType, "2");
  check("往復: 依頼直後=トレーラ0埋めなので『依頼ファイルの可能性』警告が出る",
    parsed.warnings.some((w) => w.includes("依頼ファイル")));
}

/* ══════════════════════ ② 境界値: 金額 ══════════════════════════════════ */
console.log("\n=== ② 金額の境界値 ===");
{
  const base = (amount: number): FbTransferTarget => ({
    customerNumber: "1", accountHolderKana: "ﾃｽﾄ", bankCode: "0001", branchCode: "001",
    bankName: null, branchName: null, accountType: "1", accountNumber: "1111111", amount,
  });
  const r0 = buildFbZengin([base(0)], CONSIGNOR);
  check("金額0円は除外される", r0.count === 0, `count=${r0.count}`);
  check("金額0円は警告が出る", r0.warnings.some((w) => w.includes("0 円")), r0.warnings.join(" / "));

  const rNeg = buildFbZengin([base(-500)], CONSIGNOR);
  check("★ 金額マイナスも除外される (0円と同じ扱い。マイナスのまま出力されない)", rNeg.count === 0, `count=${rNeg.count}`);

  // ★ 10桁を超える金額 (99,999,999,999円) → 上位桁が黙って落ちる境界を明示する
  const rBig = buildFbZengin([base(99_999_999_999)], CONSIGNOR);
  const bigLine = rBig.content.split("\r\n")[1];
  const bigAmountField = bigLine.slice(80, 90);
  check(
    "★ 金額が10桁(99億)を超えると上位桁が無警告で切り捨てられる (既知の設計限界。実運用では起きない額だが明示しておく)",
    bigAmountField === "9999999999",
    `10桁欄="${bigAmountField}" (本来は 99999999999 = 11桁)`,
  );
}

/* ══════════════════════ ③ 境界値: 未設定項目・かな変換 ══════════════════════ */
console.log("\n=== ③ 未設定項目・かな変換の境界値 ===");
{
  const missing: FbTransferTarget = {
    customerNumber: null, accountHolderKana: null, bankCode: null, branchCode: null,
    bankName: null, branchName: null, accountType: null, accountNumber: null, amount: 1000,
  };
  const r = buildFbZengin([missing], CONSIGNOR);
  check("銀行番号未設定の警告", r.warnings.some((w) => w.includes("銀行番号")), r.warnings.join(" / "));
  check("支店番号未設定の警告", r.warnings.some((w) => w.includes("支店番号")), r.warnings.join(" / "));
  check("口座番号未設定の警告", r.warnings.some((w) => w.includes("口座番号")), r.warnings.join(" / "));
  check("預金者名未設定の警告", r.warnings.some((w) => w.includes("預金者名"))
    , r.warnings.join(" / "));
  const line = r.content.split("\r\n")[1];
  eq("銀行番号 0埋め", line.slice(1, 5), "0000");
  eq("口座番号 0埋め", line.slice(43, 50), "0000000");

  // ★ かなに漢字が混じった場合 (入力ミスの再現) — 空白に落ちるが「未設定」扱いにならず
  //   警告が出ない、という穴を明示する
  const kanjiInKana: FbTransferTarget = {
    ...missing, accountHolderKana: "田中タロウ", bankCode: "0001", branchCode: "001", accountNumber: "1234567",
  };
  const r2 = buildFbZengin([kanjiInKana], CONSIGNOR);
  const converted = toHankakuKana("田中タロウ");
  check(
    "★ 漢字混入のかなは空白に置換されるだけで、変換後が非空なら『未設定』警告は出ない (黙ってデータが欠ける穴)",
    !r2.warnings.some((w) => w.includes("預金者名")),
    `変換結果="${converted}" (漢字2文字が半角スペースに化けている) / 警告=${JSON.stringify(r2.warnings)}`,
  );
  check("かな変換: 漢字は半角スペースに落ちる (文字は消えない=桁はズレない)",
    converted.startsWith("  ") && converted.trim() === "ﾀﾛｳ", `"${converted}"`);
}

/* ══════════════════════ ④ 半角カナ変換の境界値 ══════════════════════════════ */
console.log("\n=== ④ 半角カナ変換 ===");
{
  eq("濁点 (ガ→ｶﾞ)", toHankakuKana("ガギグゲゴ"), "ｶﾞｷﾞｸﾞｹﾞｺﾞ");
  eq("半濁点 (パ→ﾊﾟ)", toHankakuKana("パピプペポ"), "ﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟ");
  eq("ひらがな→カナ経由で変換される", toHankakuKana("たなか"), "ﾀﾅｶ");
  eq("長音符", toHankakuKana("ラーメン"), "ﾗｰﾒﾝ");
  eq("全角英数字→半角", toHankakuKana("ＡＢ１２"), "AB12");
  eq("既に半角カナはそのまま", toHankakuKana("ﾀﾅｶ"), "ﾀﾅｶ");
  eq("空/undefined/nullは空文字", toHankakuKana(null), "");
}

/* ══════════════════════ ⑤ 振替結果コードの分類 (★ 一番重要) ═══════════════════ */
console.log("\n=== ⑤ 振替結果コード → transferred の分類 (fail-closed か) ===");
{
  const mkLine = (resultCode: string, amount = "0000012345"): string => {
    // buildDataRecord と同じ並びで手組みする (パーサの桁位置が正しいかも同時に検算)
    let rec = "2";
    rec += "0001".padEnd(4); // 銀行番号
    rec += "".padEnd(15); // 銀行名
    rec += "001"; // 支店番号
    rec += "".padEnd(15); // 支店名
    rec += "".padEnd(4); // 手形交換所
    rec += "1"; // 預金種目
    rec += "1234567"; // 口座番号
    rec += "ﾃｽﾄ".padEnd(30); // 預金者名
    rec += amount; // 引落金額 (10)
    rec += "0"; // 新規コード
    rec += "CUST001".padEnd(20); // 顧客番号
    rec += resultCode.padEnd(1); // 振替結果コード (1バイト)
    return rec.padEnd(120);
  };

  // ★ 定義済みコード全部: "0" だけが transferred=true
  const CODES: [string, string, boolean][] = [
    ["0", "振替済", true],
    ["1", "資金不足", false],
    ["2", "取引なし", false],
    ["3", "預金者都合による振替停止", false],
    ["4", "依頼書なし", false],
    ["8", "委託者都合による振替停止", false],
    ["9", "その他", false],
  ];
  for (const [code, label] of CODES) {
    eq(`コード"${code}" ラベル`, fbResultLabel(code), label);
  }

  // 単一の依頼ファイルにまとめて、明細ごとに transferred を検算
  // (トレーラは合計整合のため件数・金額を合わせて手組み)
  const lines = ["1" + "".padEnd(119)]; // ダミーヘッダー (テスト対象外)
  lines[0] = "1" + "91" + "0" + "1234567890".padEnd(10) + "".padEnd(40) + "1227" + "".padEnd(120 - 1 - 2 - 1 - 10 - 40 - 4);
  for (const [code] of CODES) lines.push(mkLine(code));
  // ★ 未定義コード (5/6/7) と 空欄 も混ぜる — fail-closed の負のコントロール
  lines.push(mkLine("5"));
  lines.push(mkLine(""));
  const doneCount = 1, failCount = CODES.length - 1 + 2; // "0" だけ済み、残り全部不能扱い
  const totalAmount = 12345 * (CODES.length + 2);
  let trailer = "8";
  trailer += String(CODES.length + 2).padStart(6, "0");
  trailer += String(totalAmount).padStart(12, "0");
  trailer += String(doneCount).padStart(6, "0");
  trailer += String(12345).padStart(12, "0");
  trailer += String(failCount).padStart(6, "0");
  trailer += String(totalAmount - 12345).padStart(12, "0");
  trailer = trailer.padEnd(120);
  lines.push(trailer);
  lines.push("9" + "".padEnd(119));

  const parsed = parseFbZenginResult(lines.join("\r\n"));
  check("パース: エラー無し", parsed.errors.length === 0, parsed.errors.join(" / "));
  check("明細件数 = 定義7 + 未定義1 + 空欄1 = 9", parsed.details.length === CODES.length + 2,
    `${parsed.details.length}`);

  for (let i = 0; i < CODES.length; i++) {
    const [code, , expectTransferred] = CODES[i];
    eq(`コード"${code}": transferred`, parsed.details[i].transferred, expectTransferred);
  }
  // ★ 負のコントロール: 未定義コード "5" は transferred=false (fail-closed)
  eq("★ 未定義コード\"5\": transferred=false (fail-closedで振替不能側に倒れる)",
    parsed.details[CODES.length].transferred, false);
  eq("★ 未定義コード\"5\": ラベルは『不明』", parsed.details[CODES.length].resultLabel, "不明 (コード 5)");
  // ★ 負のコントロール: 空欄コードも transferred=false + 専用warning
  eq("★ 空欄コード: transferred=false (未処理を振替済み扱いにしない)",
    parsed.details[CODES.length + 1].transferred, false);
  check("★ 空欄コードの専用warningが出る (未処理扱い=振替不能側)",
    parsed.warnings.some((w) => w.includes("空欄") && w.includes("振替不能側")),
    parsed.warnings.join(" / "));
  check("トレーラの振替済/不能件数とdetailの実カウントが一致 (整合警告が出ない)",
    !parsed.warnings.some((w) => w.includes("振替済件数") || w.includes("振替不能件数")),
    parsed.warnings.join(" / "));
}

/* ══════════════════════ ⑥ 構造異常の検知 ══════════════════════════════════ */
console.log("\n=== ⑥ 構造異常 (順序崩れ・件数不一致・依頼ファイル誤取込) ===");
{
  // トレーラの後にデータレコードが来る (順序異常)
  const bad = [
    "1" + "".padEnd(119),
    "8" + "".padEnd(119),
    "2" + "".padEnd(119),
    "9" + "".padEnd(119),
  ].join("\r\n");
  const p1 = parseFbZenginResult(bad);
  check("トレーラ後のデータレコードはエラー", p1.errors.some((e) => e.includes("トレーラ/エンドの後")), p1.errors.join(" / "));

  // レコード長が120でない (ズレ検知)
  const short = ["1" + "".padEnd(50), "2" + "".padEnd(119), "9" + "".padEnd(119)].join("\r\n");
  const p2 = parseFbZenginResult(short);
  check("120バイトでない行は警告", p2.warnings.some((w) => w.includes("120 バイトではありません")), p2.warnings.join(" / "));

  // ★ 依頼ファイル (振替済/不能とも0) を結果ファイルとして誤取込しようとしたケース
  const targets: FbTransferTarget[] = [{
    customerNumber: "1", accountHolderKana: "ﾃｽﾄ", bankCode: "0001", branchCode: "001",
    bankName: null, branchName: null, accountType: "1", accountNumber: "1111111", amount: 1000,
  }];
  const built = buildFbZengin(targets, CONSIGNOR);
  const p3 = parseFbZenginResult(built.content);
  check("★ 依頼ファイルをそのまま読むと『依頼ファイルの可能性』警告が出る (結果ファイルと取り違えない)",
    p3.warnings.some((w) => w.includes("依頼ファイル")), p3.warnings.join(" / "));
  // このとき明細の結果コードは "0" (未処理の初期値) になっている点に注意
  eq("依頼ファイルの明細は resultCode=\"0\" (振替結果コード欄の初期値と同じ桁)", p3.details[0].resultCode, "0");
  check(
    "★★ 依頼ファイルの明細は resultCode=\"0\"=transferredになる (結果ファイルと誤認して確定すると全額『振替済』誤登録の危険)",
    p3.details[0].transferred === true,
    `transferred=${p3.details[0].transferred} — 呼出側は上の『依頼ファイルの可能性』警告を無視してはいけない`,
  );
}

console.log(`\n══ 合計 検査 ${checks} 件 / NG ${fails} 件 ══`);
console.log("\n⚠ この script は fb-zengin.ts / fb-zengin-result.ts を DB 不使用・自己検算のみで検証したもの。");
console.log("  実際に金融機関へ提出した/受け取ったファイルでの検証は未実施 (実ファイルが要る)。");
if (fails > 0) process.exit(1);
