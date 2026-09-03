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

/** 対象。smoke と同じ 2 事業所から始める。増やすときは --update で足す */
const TARGETS = [
  { office: "おゆみ野", officeId: "4f14d50c-76b5-4f44-ac41-ed6d01f53a30", areaDir: "おゆみ野", month: "2026-06" },
  { office: "高品", officeId: "a707b5a2-b21b-4c4e-8dac-298191e90b61", areaDir: "高品", month: "2026-06" },
];

type Result = {
  office: string; officeId: string; month: string;
  fingerprint: { newRows: number; honoRows: number };
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
  "  突合の「材料」= 当方とほのぼのの行数。金額ではなく材料を見る。",
  "  指紋 一致 + 結果 悪化 → ★ 計算が変わった = 回帰。FAIL。黙らせないこと",
  "  指紋 不一致           → データが変わった = --update でよい",
  "",
  "■ person と group の違い (VERIFICATION_RULES 3-8)",
  "  person 人単位。項目を抜き出して比べる緩い層。到達点として引用されてきたのはこちら",
  "  group  全項目。行単位。★ 公費欄・要介護度・認定有効期間・担当居宅事業所番号まで見る",
  "  両方を記録するのは、片方だけ良くなって片方が悪化するのを見逃さないため。",
  "",
  "■ 現在の差の中身 (2026-09-03 時点。回帰ではなく既知)",
  "  ・担当居宅介護支援事業所番号が未登録 (check:densou が報告している穴)",
  "  ・負担割合と給付率が矛盾する認定 36件 (DECISIONS_PENDING B-1u)",
];

const tmp = mkdtempSync(join(tmpdir(), "densou-diff-"));
const actual: Result[] = [];
try {
  for (const t of TARGETS) {
    const out = join(tmp, `${t.officeId}.json`);
    process.stdout.write(`  ${t.office} ${t.month} を突合中… `);
    try {
      execFileSync("npx", ["tsx", join(__dirname, "kaigo-densou-diff.mts")], {
        env: { ...process.env, OFFICE_ID: t.officeId, AREA_DIR: t.areaDir, TARGET_MONTH: t.month, DIFF_JSON: out },
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
  const fpSame = a.fingerprint.newRows === b.fingerprint.newRows && a.fingerprint.honoRows === b.fingerprint.honoRows;
  if (!fpSame) {
    console.log(`  ○ ${a.office} ${a.month}: データが変わった (行数 新 ${b.fingerprint.newRows}→${a.fingerprint.newRows} / ほ ${b.fingerprint.honoRows}→${a.fingerprint.honoRows})`);
    dataChanged++; continue;
  }
  // 指紋が同じなのに結果が悪化 = 計算が変わった = 回帰
  const worse: string[] = [];
  if (a.person.match < b.person.match) worse.push(`人単位 一致 ${b.person.match}→${a.person.match}`);
  if (a.person.mismatch > b.person.mismatch) worse.push(`人単位 不一致 ${b.person.mismatch}→${a.person.mismatch}`);
  if (a.group.match < b.group.match) worse.push(`全項目 一致 ${b.group.match}→${a.group.match}`);
  if (a.group.diff > b.group.diff) worse.push(`全項目 差 ${b.group.diff}→${a.group.diff}`);
  if (worse.length) { console.log(`  ★ ${a.office} ${a.month}: 悪化 — ${worse.join(" / ")}`); fail++; }
  else {
    const better = a.person.match > b.person.match || a.group.match > b.group.match;
    console.log(`  ${better ? "○ 改善" : "一致"} ${a.office} ${a.month}: 人単位 ${a.person.match}/${a.person.total} / 全項目 ${a.group.match}(差 ${a.group.diff})`);
    ok++;
  }
}

console.log("");
if (fail) {
  console.log(`FAIL — ★ 指紋が同じなのに突合が悪化した事業所 ${fail} 件。**計算が変わっています。**`);
  console.log("       --update で黙らせないこと。先に原因を潰してください。");
  process.exit(1);
}
console.log(`PASS — 一致/改善 ${ok} / データが変わった ${dataChanged}`);
