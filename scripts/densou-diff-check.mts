/**
 * 伝送突合の回帰チェック (npm run check:densou-diff)
 *
 * ■ なぜ要るか
 *   kaigo-densou-diff.mts は「ほのぼのと何件一致したか」を出すが **基準値が無かった**。
 *   そのため「この差は既知のものか、今回のコード変更で壊したのか」を誰も判定できず、
 *   引き継ぎ書の数字 (高品 79/80 等) と手元の実測が合わなくても原因が分からなかった。
 *   smoke と同じ形で「入力の指紋 + 結果」を残し、**回帰だけを FAIL させる**。
 *
 * ■ 判定
 *   指紋 一致 + 結果 悪化 → ★ 回帰。FAIL する。黙らせないこと
 *   指紋 不一致           → データが変わった。--update で更新してよい
 *   指紋 一致 + 結果 改善 → PASS。--update で基準値を上げる (改善を焼き付ける)
 *
 * ■ 2 つの層 (VERIFICATION_RULES 3-8)
 *   person = 人単位 (項目を抜き出して比べる緩い層)。到達点として引用されてきたのはこちら
 *   group  = 全項目 (行単位で比べる厳しい層)。★ 公費欄・要介護度・認定期間まで見る
 *   両方を記録する。**片方だけ良くなって片方が悪化するのを見逃さないため。**
 *
 * ■ 制度は 2 つ見る (2026-09-04 に障害を追加)
 *   介護保険 7 拠点   kaigo-densou-diff.mts   person / group の 2 層
 *   障害     全拠点   shogai-densou-diff-all.mts  J121 明細書 / J611 実績記録票
 *
 *   ★ 障害を足した理由 — 2026-09-04 に実際に困った:
 *     引き継ぎ 2026-09-01   J121 476/505   J611 473/505   完全一致 6 拠点
 *     同日の実測            J121 472/504   J611 474/503   完全一致 4 拠点
 *     ★ **分母まで動いていた**ので「悪化した」と断定できなかった。
 *     基準値に **分母** と **拠点ごとの内訳** を持たせれば、この切り分けができる。
 *
 * ■ 使い方
 *   npm run check:densou-diff
 *   npm run check:densou-diff -- --update    基準値を実測で置き直す (中身を読んでから commit)
 *   npm run check:densou-diff -- --only=kaigo    介護保険だけ (約 1分40秒)
 *   npm run check:densou-diff -- --only=shogai   障害だけ
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(__dirname, "densou-diff-expected.json");
const UPDATE = process.argv.includes("--update");
const ONLY = (process.argv.find((a) => a.startsWith("--only="))?.split("=")[1] ?? "").trim();
if (ONLY && ONLY !== "kaigo" && ONLY !== "shogai") {
  console.error(`★ --only= は kaigo か shogai です (受け取った値: "${ONLY}")`);
  process.exit(1);
}
const RUN_KAIGO = ONLY !== "shogai";
const RUN_SHOGAI = ONLY !== "kaigo";
/**
 * 障害の対象月。★ 変えたら基準値も取り直すこと (--update)。
 * 拠点は固定せず「伝送データ/<拠点>/訪問介護/障害/<月>/ほのぼのから に KJ がある全拠点」。
 * 介護保険側と違って **拠点を選ばない**のは、到達点が全拠点合計で語られているため。
 */
const SHOGAI_MONTH = "202606";

/**
 * 対象。**性質の違う拠点**を選ぶ (全 19 拠点は回さない — 時間がかかると誰も回さなくなる)。
 * 増やすときは --update で足す。
 *
 *   おゆみ野  障害の比率が最も高い (障害 2,391 / 介護 2,236)。公費も最多 19 名
 *   高品      ★ 公費の選択が非決定的な既知ケース (下記 ⚠)
 *   五井      公費の比率が高い (18/98)。障害も多い (648)
 *   四街道    ★ KK_FILE 指定が要る + ★ 実績が最も少ない (割当 63 名 / 介護 403 件)
 *             = 分母が小さいときに検査が壊れないかの確認を兼ねる
 *   袖ケ浦    ★ KK_FILE 指定が要る
 *   いすみ    ★ 総合事業の事業所番号 (12A8600011) を使う 2 拠点のうちの 1 つ
 *   ちはら台  ★ 総合事業 (12A2400103)。障害の実績は 0
 *
 * ⚠ **KK_FILE を指定しないと別の月のファイルを掴むことがある。**
 *   拠点によっては ほのぼのから に KK が 2〜3 本置かれている (当初請求 + 再請求)。
 *   ★ 基準値に指定を焼き込んでおくと、指定忘れの事故が防げる。
 */
const TARGETS: {
  office: string; officeId: string; areaDir: string; month: string; kkFile?: string;
}[] = [
  { office: "おゆみ野", officeId: "4f14d50c-76b5-4f44-ac41-ed6d01f53a30", areaDir: "おゆみ野", month: "2026-06" },
  { office: "高品", officeId: "a707b5a2-b21b-4c4e-8dac-298191e90b61", areaDir: "高品", month: "2026-06" },
  { office: "五井", officeId: "3f18eced-5f51-49b8-bfc1-afcfaa919035", areaDir: "五井", month: "2026-06" },
  { office: "四街道", officeId: "0276dadf-bd9b-4c9a-a623-4650284c53b2", areaDir: "四街道", month: "2026-06", kkFile: "KK260802.CSV" },
  { office: "袖ケ浦", officeId: "b9a17be0-7fba-4376-b66e-b1aad414e4b2", areaDir: "袖ケ浦", month: "2026-06", kkFile: "KK260803.CSV" },
  { office: "いすみ", officeId: "4015f747-4f75-4769-a1f2-dca3db6a24fc", areaDir: "いすみ", month: "2026-06" },
  { office: "ちはら台", officeId: "fd0179ae-6a20-4bf2-9ab0-37d61c744f64", areaDir: "ちはら台", month: "2026-06" },
];

type Result = {
  office: string; officeId: string; month: string;
  fingerprint: { newRows: number; honoRows: number; honoHash?: string; newHash?: string };
  person: { match: number; mismatch: number; onlyNew: number; onlyHono: number; total: number };
  group: { newGroups: number; honoGroups: number; match: number; diff: number };
};

/** 障害の 1 層 (J121 / J611)。★ total が分母。-1 は「測れていない」 */
type ShogaiSection = { match: number; mismatch: number; total: number; onlyHono: number; onlyNew: number };
type ShogaiOffice = {
  area: string; officeId: string; bn: string; month: string;
  fingerprint: { honoRows: number; honoHash: string; newRows: number; newHash: string };
  j121: ShogaiSection; j611: ShogaiSection;
};
type ShogaiBaseline = { month: string; skipped: string[]; offices: ShogaiOffice[] };

const README = [
  "伝送突合 (npm run check:densou-diff) の基準値。",
  "",
  "■ 更新のしかた",
  "  npm run check:densou-diff -- --update   … 実測値で書き直す。中身を読んでから commit する。",
  "",
  "■ 指紋は何か",
  "  honoRows / honoHash … ほのぼの側の行数と中身 (★ 真の外部入力)",
  "  newRows  / newHash  … 当方の出力の行数と中身",
  "  ⚠ 行数だけでは **UPDATE 系のデータ是正が透明になる**。",
  "     2026-09-03 に認定を 28 行 UPDATE したとき行数が変わらず、",
  "     「計算が変わった」と誤って断定した。それでハッシュを追加した。",
  "",
  "■ 切り分け",
  "  ほのぼの側が変わった      → ファイルを出し直した。--update でよい",
  "  当方の出力が変わった    → git log でコード変更を見る。無ければ DB のデータ是正",
  "  当方の出力も同じなのに悪化 → ★ 突合そのものが非決定的",
  "",
  "■ person と group の違い (VERIFICATION_RULES 3-8)",
  "  person 人単位。項目を抜き出して比べる緩い層。到達点として引用されてきたのはこちら",
  "  group  全項目。行単位。★ 公費欄・要介護度・認定有効期間・担当居宅事業所番号まで見る",
  "  両方を記録するのは、片方だけ良くなって片方が悪化するのを見逃さないため。",
  "",
  "■ 現在の差の中身 — ★ 拠点ごとに 1 行ずつ (2026-09-03 実測。回帰ではなく既知)",
  "  ⚠ 「差 N 件」だけを焼くと、中身が既知か回帰かが後から分からなくなる。",
  "     拠点を足したら **必ずここに書く**。",
  "",
  "  おゆみ野 差13 : 担当居宅介護支援事業所番号が未登録 (check:densou が報告している穴)",
  "                  + 人単位 ほのみ 3 名",
  "  高品     差 4 : 同上 + ほのぼのが請求し当方に無い 1 名",
  "  五井     差 7 : ★ 2 名。金額に効く",
  "                  ・1000138221 … 116711 (身体９生活１) が当方に無い。",
  "                    ★ 身体９系 168 コードの単位数 0 の既知案件 (井口恵子)。差 -1,206単位",
  "                  ・0002476776 … 115311/116123 の回数配分が違う (5:4 ↔ 4:5)。差 -145単位",
  "  四街道   差 0 : ★ 完全一致 (人単位 47/47・全項目 143/143)。",
  "                  ⚠ KK_FILE=KK260802.CSV の指定が要る。指定を外すと別の月を掴む",
  "  袖ケ浦   差 5 : ・2290134465 大塚昇 … ★ **月遅れ請求**。過大請求ではない",
  "                    一覧CSV: 提供2026/06 / ★請求2026/07 / 月遅 / 35,467円",
  "                    7111 の差 4,184,123−4,148,656 = ★35,467 と 1 円まで一致",
  "                    当方は 6 月に出し、ほのぼのは 7 月に回している = 提出タイミングの違い",
  "                  ・2290089560 … 認定有効期間の終了日だけ違う (金額は同じ)",
  "                  ⚠ KK_FILE=KK260803.CSV の指定が要る",
  "  いすみ   差 8 : ・0001006307 … ほのぼのにあり当方に無い (欠落)",
  "                  ・0000626195 / 0000362455 … ★ **金額は完全一致**。過大請求ではない",
  "                    7131 種別10 で違うのは ★ 限度額管理対象単位数 の 1 フィールドだけ",
  "                      新 …,25231, 32542 ,6711,,,31942,1000,287478,31942",
  "                      ほ …,25231, 25231 ,6711,,,31942,1000,287478,31942",
  "                    ほのぼのは **計画単位数**を入れ、当方は **実績の合計**を入れている",
  "                    ⚠ 当初「+6,579単位 ≒ 7万円」と報告したのは **誤り**。",
  "                       明細行の合計差を金額差と読んでいた (規律 3-12)",
  "  ちはら台 差 5 : ★ 5 件すべて **認定有効期間の終了日だけ**の違い。金額は完全に一致。",
  "                  DECISIONS_PENDING_densou.md の 3 (証記載 か 適用期間 か) の対象",
  "",
  "⚠ 高品は **非決定的** (公費 3 件が全部 priority=1 で、どれを公費1 にするかが不定)。",
  "  2026-09-03 に 6 回回した実測: 238/差4 が 5 回・237/差5 が 1 回。",
  "  ★ 基準値には **悪い側 (237/差5)** を入れてある。多数側 (238) を基準にすると",
  "    揺れるたびに FAIL し、FAIL が常態化して --update で黙らせたくなるため (規律 3-7)。",
  "  ⚠ そのため 高品が「○ 改善 238/差4」と出ることがあるが、**それは改善ではなく揺れ**。",
  "    ★ 高品だけを見て --update しないこと。公費の選択が決定的になったら取り直す。",
  "    (DECISIONS_PENDING B-1s / 公費 3 件の priority 重複)",
  "",
  "⚠ 拠点の選び方 — 全 19 拠点は回さない (時間がかかると誰も回さなくなる)。",
  "  性質の違うものを選んである: 障害が多い / 公費が多い / 総合事業 (12A) を使う /",
  "  KK_FILE の指定が要る / 実績が少ない (分母が小さいとき検査が壊れないか)。",
  "  7 拠点で **実行 約1分40秒**。",
];

const SHOGAI_README = [
  "障害 (J121 明細書 / J611 実績記録票) の基準値。★ 2026-09-04 追加。",
  "",
  "■ なぜ足したか",
  "  回帰網が介護保険 7 拠点しか見ておらず、**障害が悪化しても検出できなかった**。",
  "  2026-09-04 に引き継ぎ (SESSION_START) の数字と実測が食い違った:",
  "      引き継ぎ 2026-09-01   J121 476/505   J611 473/505   完全一致 6 拠点",
  "      同日の実測            J121 472/504   J611 474/503   完全一致 4 拠点",
  "  ★ 分母 (505 → 504/503) まで動いていたので **悪化と断定できなかった**。",
  "     この切り分けができないこと自体が問題で、拠点ごとの内訳を焼けば防げる。",
  "",
  "■ 判定 (★ ここが本体)",
  "  分母 (total) が違う          → ○ データが変わった。--update でよい",
  "  分母 同じ + 一致数 減った     → ★ 回帰。FAIL する。--update で黙らせないこと",
  "  分母 同じ + 一致数 増えた     → ○ 改善",
  "  分母 -1 / 拠点が消えた        → ★ 測れていない。FAIL する (VERIFICATION_RULES 1-2)",
  "",
  "  ⚠ 合計 (472/504 等) だけを見ない。**合計は分母が動くと意味を失う**。",
  "     判定は必ず拠点ごとに行い、合計は参考表示に留める。",
  "",
  "■ 指紋",
  "  honoRows / honoHash … ほのぼのから/ + ほのぼのから_再請求/ の KJ・TJ・JJ (★ 真の外部入力)",
  "  newRows  / newHash  … 新システム/ に書き出した J11・J61・J41 (当方の出力)",
  "  ⚠ …_解説.csv (densou-explain.mts の注釈) は指紋に入れない。伝送ファイルではないうえ",
  "     更新が止まるので嘘の「変わっていない」を作る。",
  "",
  "■ 対象",
  "  伝送データ/<拠点>/訪問介護/障害/202606/ほのぼのから に KJ がある **全拠点** (17)。",
  "  介護保険側と違って拠点を選ばないのは、到達点が全拠点合計で語られているため。",
  "  スキップ (KJ が無い) = 八千代 / 君津 / 山武 / 市原 / 船橋 の 5 拠点。",
  "  ⚠ 山武・市原は障害の指定が無い (SESSION_START)。八千代・君津・船橋は未着手。",
  "  実行 **約 2 分** (17 拠点)。介護保険 7 拠点と合わせて 約 4 分。",
  "",
  "■ この基準値が証明していないこと (VERIFICATION_RULES 3-1)",
  "  ・「ほのぼのと一致している = 正しい」ではない。ほのぼの側の算定漏れは",
  "    _densou_intentional_diff.json 側の管轄 (規律 3-2)",
  "  ・J121 は受給者単位のサマリ + サービスコード別の単位数/回数まで見るが、",
  "    ★ J411 (上限管理結果票) は見ていない",
  "  ・J611 は既定で **提供時刻を比較しない** (J611_TIME=1 のときだけ)",
];

const tmp = mkdtempSync(join(tmpdir(), "densou-diff-"));
const actual: Result[] = [];
let shogaiActual: ShogaiBaseline | null = null;
try {
  for (const t of RUN_KAIGO ? TARGETS : []) {
    const out = join(tmp, `${t.officeId}.json`);
    process.stdout.write(`  ${t.office} ${t.month} を突合中… `);
    try {
      execFileSync("npx", ["tsx", join(__dirname, "kaigo-densou-diff.mts")], {
        env: {
          ...process.env,
          OFFICE_ID: t.officeId, AREA_DIR: t.areaDir, TARGET_MONTH: t.month, DIFF_JSON: out,
          // ★ 指定が要る拠点だけ。空文字を渡すと自動検出に戻る
          ...(t.kkFile ? { KK_FILE: t.kkFile } : {}),
        },
        stdio: ["ignore", "ignore", "pipe"], timeout: 600_000, shell: process.platform === "win32",
      });
    } catch (e) {
      console.log("✗");
      console.error(`★ 突合の実行に失敗: ${t.office}`, (e as { stderr?: Buffer }).stderr?.toString().slice(0, 400) ?? e);
      process.exit(1);   // 1-2: 測れていないのに合格判定を出さない
    }
    if (!existsSync(out)) { console.log("✗"); console.error(`★ ${t.office}: DIFF_JSON が書かれていない。測れていないので中止`); process.exit(1); }
    const r = JSON.parse(readFileSync(out, "utf8")) as Result;
    actual.push(r);
    console.log(`人単位 ${r.person.match}/${r.person.total} / 全項目 ${r.group.match}(差 ${r.group.diff})`);
  }

  if (RUN_SHOGAI) {
    const out = join(tmp, "shogai.json");
    process.stdout.write(`  障害 ${SHOGAI_MONTH} 全拠点を突合中… `);
    try {
      execFileSync("npx", ["tsx", join(__dirname, "shogai-densou-diff-all.mts")], {
        env: { ...process.env, MONTH: SHOGAI_MONTH, SHOGAI_DIFF_JSON: out },
        stdio: ["ignore", "ignore", "pipe"], timeout: 1_800_000, shell: process.platform === "win32",
      });
    } catch (e) {
      console.log("✗");
      console.error("★ 障害の突合の実行に失敗", (e as { stderr?: Buffer }).stderr?.toString().slice(0, 600) ?? e);
      process.exit(1);   // 1-2: 測れていないのに合格判定を出さない
    }
    if (!existsSync(out)) { console.log("✗"); console.error("★ 障害: SHOGAI_DIFF_JSON が書かれていない。測れていないので中止"); process.exit(1); }
    shogaiActual = JSON.parse(readFileSync(out, "utf8")) as ShogaiBaseline;
    // 1-2: 分母 0 (= 1 拠点も回っていない) で合格判定を出さない
    if (shogaiActual.offices.length === 0) {
      console.log("✗");
      console.error(`★ 障害: 突合できた拠点が 0 件 (伝送データ/*/訪問介護/障害/${SHOGAI_MONTH}/ を確認)。測れていないので中止`);
      process.exit(1);
    }
    const s = (k: "j121" | "j611") =>
      shogaiActual!.offices.reduce((a, o) => a + Math.max(o[k].match, 0), 0) + "/" +
      shogaiActual!.offices.reduce((a, o) => a + Math.max(o[k].total, 0), 0);
    console.log(`${shogaiActual.offices.length} 拠点 J121 ${s("j121")} / J611 ${s("j611")}`);
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }

if (UPDATE) {
  // --only で片方だけ回したときは、**回していない側の基準値をそのまま残す**。
  // 上書きすると「見ていない制度の基準が消える」= 回帰網に穴が開く
  const prev = existsSync(BASELINE)
    ? (JSON.parse(readFileSync(BASELINE, "utf8")) as { results?: Result[]; shogai?: ShogaiBaseline })
    : {};
  writeFileSync(BASELINE, JSON.stringify({
    _readme: README,
    results: RUN_KAIGO ? actual : (prev.results ?? []),
    _shogai_readme: SHOGAI_README,
    shogai: RUN_SHOGAI ? shogaiActual : (prev.shogai ?? null),
  }, null, 2) + "\n", "utf8");
  console.log(`\n基準値を更新しました → ${BASELINE}\n★ 中身を読んでから commit すること。悪化したまま --update すると穴を焼き付けます。`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error("★ 基準値がありません。初回は --update で作ってください。");
  process.exit(1);
}
const baseFile = JSON.parse(readFileSync(BASELINE, "utf8")) as { results: Result[]; shogai?: ShogaiBaseline | null };
const base = baseFile.results;
const key = (r: Result) => `${r.officeId}|${r.month}`;
const baseMap = new Map(base.map((r) => [key(r), r]));

let fail = 0, dataChanged = 0, ok = 0;
if (RUN_KAIGO) console.log("\n─── 介護保険 ───");
for (const a of actual) {
  const b = baseMap.get(key(a));
  if (!b) { console.log(`  ○ ${a.office} ${a.month}: 基準値に無い (新規)。--update で足してください`); dataChanged++; continue; }
  // ⚠ 行数だけでは **UPDATE 系のデータ是正が透明になる** (2026-09-03 に実際に踏んだ)。
  //   認定を 28 行 UPDATE しても行数は変わらず、「計算が変わった」と誤って断定した。
  //   → ほのぼの側 (真の外部入力) と当方の出力の **中身のハッシュ**も見る。
  const honoSame =
    a.fingerprint.honoRows === b.fingerprint.honoRows &&
    (a.fingerprint.honoHash ?? "") === (b.fingerprint.honoHash ?? "");
  if (!honoSame) {
    console.log(`  ○ ${a.office} ${a.month}: ★ ほのぼの側のファイルが変わった (行 ${b.fingerprint.honoRows}→${a.fingerprint.honoRows})`);
    dataChanged++; continue;
  }
  const ourSame = (a.fingerprint.newHash ?? "") === (b.fingerprint.newHash ?? "");
  // ほのぼの側が同じなのに結果が悪化 = 当方の出力が変わった
  const worse: string[] = [];
  if (a.person.match < b.person.match) worse.push(`人単位 一致 ${b.person.match}→${a.person.match}`);
  if (a.person.mismatch > b.person.mismatch) worse.push(`人単位 不一致 ${b.person.mismatch}→${a.person.mismatch}`);
  if (a.group.match < b.group.match) worse.push(`全項目 一致 ${b.group.match}→${a.group.match}`);
  if (a.group.diff > b.group.diff) worse.push(`全項目 差 ${b.group.diff}→${a.group.diff}`);
  if (worse.length) {
    console.log(`  ★ ${a.office} ${a.month}: 悪化 — ${worse.join(" / ")}`);
    console.log(`     当方の出力: ${ourSame ? "変わっていない (= 突合そのものが非決定的な可能性)" : "★ 変わった (コード変更 か DB のデータ是正)"}`);
    fail++;
  }
  else {
    const better = a.person.match > b.person.match || a.group.match > b.group.match;
    console.log(`  ${better ? "○ 改善" : "一致"} ${a.office} ${a.month}: 人単位 ${a.person.match}/${a.person.total} / 全項目 ${a.group.match}(差 ${a.group.diff})`);
    ok++;
  }
}

// ═══ 障害 ═══════════════════════════════════════════════════════════════════
// ★ ここが 2026-09-04 の宿題そのもの。「分母が変わった」と「一致数が下がった」を分ける。
if (RUN_SHOGAI && shogaiActual) {
  console.log("\n─── 障害 ───");
  const sBase = baseFile.shogai;
  if (!sBase) {
    console.log("  ○ 障害の基準値がまだありません。--update で作ってください");
    dataChanged++;
  } else if (sBase.month !== shogaiActual.month) {
    console.log(`  ○ 対象月が違う (基準 ${sBase.month} → 実測 ${shogaiActual.month})。--update で取り直してください`);
    dataChanged++;
  } else {
    const bMap = new Map(sBase.offices.map((o) => [o.area, o]));
    const aMap = new Map(shogaiActual.offices.map((o) => [o.area, o]));

    // 1-2 / 2章⑧: 基準値にあった拠点が消えたのは「該当なし」ではなく **測れていない**
    for (const o of sBase.offices) {
      if (aMap.has(o.area)) continue;
      console.log(`  ★ ${o.area}: 基準値にあるのに今回は突合できていない (伝送の置き場所 か 事業所番号を確認)`);
      fail++;
    }

    /** 1 層ぶんの判定。★ 分母 (total) を先に見る */
    const judge = (area: string, layer: "J121" | "J611", a: ShogaiSection, b: ShogaiSection): "fail" | "data" | "ok" => {
      if (a.total < 0) { console.log(`  ★ ${area} ${layer}: 測れていない (突合が最後まで走っていない)`); return "fail"; }
      if (a.total !== b.total) {
        // ここに来るのは ほのぼの側の指紋が同じとき = **当方の受給者が増減した**
        // (取込・是正・受給者証の追加)。★ 一致数の増減だけでは回帰と区別できない
        console.log(`  ○ ${area} ${layer}: データが変わった — ★ 分母 ${b.total}→${a.total} (一致 ${b.match}→${a.match})`);
        console.log(`      ほのぼの側は同じなので、当方の受給者が増減した (取込・是正)。悪化とは判定しない`);
        return "data";
      }
      if (a.match < b.match) {
        console.log(`  ★ ${area} ${layer}: ★ 回帰 — 分母は ${a.total} のまま 一致 ${b.match}→${a.match}`);
        return "fail";
      }
      if (a.match > b.match) { console.log(`  ○ ${area} ${layer}: 改善 — 一致 ${b.match}→${a.match} / ${a.total}`); return "ok"; }
      return "ok";
    };

    for (const a of shogaiActual.offices) {
      const b = bMap.get(a.area);
      if (!b) { console.log(`  ○ ${a.area}: 基準値に無い (新規)。--update で足してください`); dataChanged++; continue; }
      // ほのぼの側 (真の外部入力) が変わっていれば、以降の増減は「データが変わった」
      const honoSame = a.fingerprint.honoRows === b.fingerprint.honoRows && a.fingerprint.honoHash === b.fingerprint.honoHash;
      if (!honoSame) {
        console.log(`  ○ ${a.area}: ★ ほのぼの側のファイルが変わった (行 ${b.fingerprint.honoRows}→${a.fingerprint.honoRows}) — J121 ${a.j121.match}/${a.j121.total} J611 ${a.j611.match}/${a.j611.total}`);
        dataChanged++; continue;
      }
      const v = [judge(a.area, "J121", a.j121, b.j121), judge(a.area, "J611", a.j611, b.j611)];
      if (v.includes("fail")) {
        const ourSame = a.fingerprint.newHash === b.fingerprint.newHash;
        console.log(`     当方の出力: ${ourSame ? "変わっていない (= 突合そのものが非決定的な可能性)" : "★ 変わった (コード変更 か DB のデータ是正)"}`);
        fail++;
      } else if (v.includes("data")) dataChanged++;
      else ok++;
    }

    // 合計は **参考**。分母が動くと意味を失うので、判定には使わない (上の拠点ごとが判定)
    const sum = (os: ShogaiOffice[], k: "j121" | "j611", f: "match" | "total") =>
      os.reduce((n, o) => n + Math.max(o[k][f], 0), 0);
    const perfect = (os: ShogaiOffice[]) => os.filter((o) => o.j121.mismatch === 0 && o.j611.mismatch === 0 && o.j121.total > 0).length;
    console.log(
      `  (参考) J121 ${sum(shogaiActual.offices, "j121", "match")}/${sum(shogaiActual.offices, "j121", "total")}` +
      `  J611 ${sum(shogaiActual.offices, "j611", "match")}/${sum(shogaiActual.offices, "j611", "total")}` +
      `  完全一致 ${perfect(shogaiActual.offices)} 拠点  (基準 ` +
      `J121 ${sum(sBase.offices, "j121", "match")}/${sum(sBase.offices, "j121", "total")}` +
      ` J611 ${sum(sBase.offices, "j611", "match")}/${sum(sBase.offices, "j611", "total")}` +
      ` 完全一致 ${perfect(sBase.offices)} 拠点)`,
    );
    console.log("  ⚠ 合計は分母が動くと意味を失う。判定は上の拠点ごとの行を見ること");
  }
}

console.log("");
if (fail) {
  console.log(`FAIL — ★ 悪化 または 測れていない ${fail} 件 (ほのぼの側は同じ / 分母も同じ)。`);
  console.log("       切り分け:");
  console.log("         当方の出力が変わった  → git log でコード変更を見る。無ければ DB のデータ是正");
  console.log("         当方の出力も同じ      → ★ 突合そのものが非決定的 (同着で選択が不定 等)");
  console.log("       --update で黙らせないこと。先に原因を潰してください。");
  process.exit(1);
}
console.log(`PASS — 一致/改善 ${ok} / データが変わった ${dataChanged}`);
