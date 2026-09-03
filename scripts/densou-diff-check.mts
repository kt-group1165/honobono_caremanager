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
 * ■ 使い方
 *   npm run check:densou-diff
 *   npm run check:densou-diff -- --update    基準値を実測で置き直す (中身を読んでから commit)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(__dirname, "densou-diff-expected.json");
const UPDATE = process.argv.includes("--update");

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

const tmp = mkdtempSync(join(tmpdir(), "densou-diff-"));
const actual: Result[] = [];
try {
  for (const t of TARGETS) {
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
} finally { rmSync(tmp, { recursive: true, force: true }); }

if (UPDATE) {
  writeFileSync(BASELINE, JSON.stringify({ _readme: README, results: actual }, null, 2) + "\n", "utf8");
  console.log(`\n基準値を更新しました → ${BASELINE}\n★ 中身を読んでから commit すること。悪化したまま --update すると穴を焼き付けます。`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error("★ 基準値がありません。初回は --update で作ってください。");
  process.exit(1);
}
const base = (JSON.parse(readFileSync(BASELINE, "utf8")) as { results: Result[] }).results;
const key = (r: Result) => `${r.officeId}|${r.month}`;
const baseMap = new Map(base.map((r) => [key(r), r]));

let fail = 0, dataChanged = 0, ok = 0;
console.log("");
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

console.log("");
if (fail) {
  console.log(`FAIL — ★ ほのぼの側は同じなのに突合が悪化した事業所 ${fail} 件。`);
  console.log("       切り分け:");
  console.log("         当方の出力が変わった  → git log でコード変更を見る。無ければ DB のデータ是正");
  console.log("         当方の出力も同じ      → ★ 突合そのものが非決定的 (同着で選択が不定 等)");
  console.log("       --update で黙らせないこと。先に原因を潰してください。");
  process.exit(1);
}
console.log(`PASS — 一致/改善 ${ok} / データが変わった ${dataChanged}`);
