/**
 * repo のファイルに 利用者の被保険者番号らしい数字が 新しく書き込まれていないか (2026-11-13 H 依頼・DB 不使用)
 *
 *   npm run check:no-pii              # 基準値と比べる (ファイルごとに増えたら exit 1)
 *   npm run check:no-pii -- --update  # 基準値を書き直す (★ 増えたまま更新しない。先に消す)
 *
 * なぜ: 2026-11-13 に 手順書・基準値 JSON・コードのコメント・commit メッセージに 実在の氏名と被保険者番号を書いていた
 *   (push が止められて気づいた)。止血はしたが、文書に書く癖は残るので 新規の追加を検査で止める。
 *   ★ 履歴には残っている。これは「新しく増やさない」ための検査で、過去の掃除ではない。
 *
 * 見るもの (git が追跡しているテキスト: .json .mjs .mts .ts .tsx .js .md .sql):
 *   ① 10 桁の数字 (英字 1 文字を含む事業所番号の形も) のうち ★ 既知の事業所番号でないもの = 被保険者番号・受給者証番号の形
 *      事業所番号の一覧は 実行のたびに リポジトリ直下の _dump_parts/ (offices / care_offices / care_offices_opendata /
 *      kaigo_service_providers / office_sougou_numbers / facilities / facility_designations) から作る (repo に焼くと古くなる)
 *   ② 「被保番」「被保険者番号」「受給者証番号」「insured_number」の 同じ行にある 6〜10 桁の数字リテラル
 * ★ 氏名は機械的に拾えない。①② だけで割り切っている。「全部拾える」検査ではない
 *   電話番号 (10 桁) や 仮番号 (1111111111 など) も ① に入るので、件数は基準値方式で見る (今ある件数を許し、増えたら落ちる)
 * 負のコントロール: 架空の 10 桁 (被保番の形) を 1 つ足した中身で数え直すと ① が 1 増えること
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DUMP = join(ROOT, "..", "..", "_dump_parts");
const BASELINE = join(HERE, "no-pii-baseline.json");
const UPDATE = process.argv.includes("--update");

// ── 事業所番号の許可リスト (_dump_parts から) ──
const OFFICE_RE = /\b\d{2}[0-9A-Z]\d{7}\b/g;
const DUMP_FILES = ["019_offices.sql", "031_care_offices.sql", "044_care_offices_opendata.sql", "133_kaigo_service_providers.sql", "163_office_sougou_numbers.sql", "030_facilities.sql", "074_facility_designations.sql", "021_payroll_offices.sql"];
if (!existsSync(DUMP)) { console.error(`✗ ${DUMP} が無い (事業所番号の許可リストが作れない)`); process.exit(1); }
const allowed = new Set<string>();
for (const f of DUMP_FILES) {
  const p = join(DUMP, f);
  if (!existsSync(p)) { console.error(`✗ ${p} が無い`); process.exit(1); }
  for (const m of readFileSync(p, "utf8").matchAll(OFFICE_RE)) allowed.add(m[0]);
}
if (allowed.size < 100) { console.error(`✗ 事業所番号が ${allowed.size} 件しか取れない (ダンプの形が変わった疑い)`); process.exit(1); }

// ── 対象ファイル ──
const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split(/\r?\n/)
  .filter((f) => /\.(json|mjs|mts|ts|tsx|js|md|sql)$/.test(f) && !f.endsWith("no-pii-baseline.json") && !f.endsWith("no-pii-check.mts") && !f.endsWith("package-lock.json")); // 検査自身 (負のコントロールの架空の番号を持つ) は数えない

const NEAR_RE = /被保番|被保険者番号|受給者証番号|insured_number/;
type Count = { ten: number; near: number };
function countText(text: string): Count {
  let ten = 0, near = 0;
  for (const line of text.split(/\r?\n/)) {
    for (const m of line.matchAll(/(?<![0-9A-Za-z])(\d{10}|\d{2}[A-Z]\d{7})(?![0-9A-Za-z])/g)) if (!allowed.has(m[1])) ten++;
    if (NEAR_RE.test(line)) for (const m of line.matchAll(/(?<![0-9A-Za-z])\d{6,10}(?![0-9A-Za-z])/g)) if (!allowed.has(m[0])) near++;
  }
  return { ten, near };
}
const cur: Record<string, Count> = {};
let totTen = 0, totNear = 0;
for (const f of files) {
  const p = join(ROOT, f);
  if (!existsSync(p)) continue;
  const c = countText(readFileSync(p, "utf8"));
  if (c.ten || c.near) { cur[f] = c; totTen += c.ten; totNear += c.near; }
}
console.log(`対象 ${files.length} ファイル / 事業所番号の許可リスト ${allowed.size} 件 (_dump_parts)`);
console.log(`① 事業所番号でない 10 桁: ${totTen} 件 (${Object.values(cur).filter((c) => c.ten).length} ファイル) / ② 被保番などの行の 6〜10 桁: ${totNear} 件`);

// ── 負のコントロール ──
const probe = countText("// 例 被保番 0009876543 の人");
const negOk = probe.ten === 1 && probe.near === 1;
console.log(`■ 負のコントロール: 架空の被保番を 1 つ書いた行 → ① ${probe.ten} / ② ${probe.near} ${negOk ? "✓ 鳴る" : "✗ 鳴らない"}`);

// ── ③ JSON のキーに入った氏名の形の値 (2026-11-14 H 依頼) ──
//   キー名に name を含む / 「氏名」「利用者名」 で、値が「姓 + 空白 + 名」(漢字・かな 1〜6 字 + 半角/全角空白 + 1〜8 字) のもの。
//   ★ 用具名・事業所名・サービス名は空白が入らないものが大半なので、この形の判定でほぼ落ちる (name キーをそのまま数えると誤検出だらけ)。
//   ⚠ 人名でない値も少し当たる (pattern_name「田中 様パターン」・care_office_name の「○○ 居宅」など。2026-11-14 時点で中身は未確認)。
//   ファイルごと・キーごとに数える (合計だけだと、1 本消して 1 本足したときに通ってしまう)。新しいファイルに 1 件でもあれば落ちる
const NAME_KEY_RE = /"([A-Za-z_]*name[A-Za-z_]*|氏名|利用者名)"\s*:\s*"([^"]*)"/g;
const PERSON_RE = /^[぀-ヿ一-鿿々〆ヶ]{1,6}[ 　][぀-ヿ一-鿿々〆ヶ]{1,8}$/;
function countNames(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(NAME_KEY_RE)) if (PERSON_RE.test(m[2].trim())) out[m[1]] = (out[m[1]] ?? 0) + 1;
  return out;
}
const jsonFiles = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split(/\r?\n/)
  .filter((f) => /\.(json|jsonl)$/.test(f) && !f.endsWith("no-pii-baseline.json") && !f.endsWith("package-lock.json"));
const curNames: Record<string, Record<string, number>> = {};
let totNames = 0;
for (const f of jsonFiles) {
  const p = join(ROOT, f);
  if (!existsSync(p)) continue;
  const c = countNames(readFileSync(p, "utf8"));
  const n = Object.values(c).reduce((s, v) => s + v, 0);
  if (n) { curNames[f] = c; totNames += n; }
}
console.log(`③ JSON のキーに入った氏名の形の値: ${totNames} 件 (${Object.keys(curNames).length} ファイル / 対象 JSON ${jsonFiles.length} ファイル)`);
const probeNames = countNames(`{"client_name": "山田 太郎", "service_name": "福祉用具貸与", "office_name": "Ｈａｎａ居宅支援センター高品"}`);
const negNamesOk = probeNames.client_name === 1 && Object.keys(probeNames).length === 1;
console.log(`■ 負のコントロール ③: client_name に「山田 太郎」を 1 つ (用具名・事業所名と一緒に) → ${JSON.stringify(probeNames)} ${negNamesOk ? "✓ 鳴る (用具名・事業所名は数えない)" : "✗"}`);
console.log("★ この検査が見ていないもの: 本文中の氏名 (JSON のキー以外・md やコードの中) / 空白の無い氏名・カタカナの外国人名 / git の履歴 (過去の commit) / repo の外のファイル (HANDOVER・SESSION_START はルートで git の外)");

const NAMES_README = [
  "③ (2026-11-14 追加) JSON のキーに入った 氏名の形の値。ファイルごと・キーごとに 増えたら落ちる / 新しいファイルに 1 件でもあれば落ちる",
  "  なぜこの件数か: 過去に「バックアップ JSON は commit しない」が守られておらず、migrations/ のバックアップと取込の出力 (49 ファイル) に実名が入っている",
  "  いつ 0 になるはずか: その 49 ファイルを git から外せたとき (取込 script が読むファイルも混ざるので 1 本ずつ参照を確かめてから。user 判断待ち)",
  "  見ていないもの: 本文中の氏名 / 空白の無い氏名・外国人名 / git の履歴 / repo の外",
];
if (UPDATE) {
  const readme0 = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as { _readme: string[] })._readme : [
    "基準値方式。ファイルごとに ① 事業所番号でない 10 桁 / ② 被保番などの行の数字 が増えたら落ちる。0 を目指す検査ではない",
    "★ 履歴 (過去の commit) には残っている。これは 新しく書き込むのを止める検査。repo の文書に 実在の氏名・被保険者番号を書かない (その場で DB から引く)",
    "今ある件数には 電話番号・仮番号 (1111111111 など)・サンプルの番号 も入っている。増えたときは --update の前に 中身を見て消す",
  ];
  const readme = readme0.some((l) => l.startsWith("③")) ? readme0 : [...readme0, ...NAMES_README];
  writeFileSync(BASELINE, JSON.stringify({ _readme: readme, total: { ten: totTen, near: totNear, names: totNames }, files: cur, names: curNames }, null, 2) + "\n");
  console.log(`基準値を書き直した: ${BASELINE}`);
  process.exit(negOk && negNamesOk ? 0 : 1);
}
if (!existsSync(BASELINE)) { console.error("✗ 基準値ファイルが無い。--update で作る"); process.exit(1); }
const base = JSON.parse(readFileSync(BASELINE, "utf8")) as { files: Record<string, Count>; names?: Record<string, Record<string, number>> };
const fails: string[] = [];
if (!negOk) fails.push("負のコントロールが鳴らない");
if (!negNamesOk) fails.push("負のコントロール ③ (氏名の形) が鳴らない");
if (!base.names) fails.push("基準値に ③ (names) が無い。--update で作る");
for (const [f, c] of Object.entries(curNames)) for (const [k, n] of Object.entries(c)) {
  const b = base.names?.[f]?.[k] ?? 0;
  if (n > b) fails.push(`${f}: ③ キー "${k}" の氏名の形 ${b} → ${n}${base.names?.[f] ? "" : " (新しいファイル)"}`);
}
for (const [f, c] of Object.entries(cur)) {
  const b = base.files[f] ?? { ten: 0, near: 0 };
  if (c.ten > b.ten) fails.push(`${f}: ① 事業所番号でない 10 桁 ${b.ten} → ${c.ten}`);
  if (c.near > b.near) fails.push(`${f}: ② 被保番などの行の数字 ${b.near} → ${c.near}`);
}
if (fails.length) { console.log("✗ FAIL (増えた。--update の前に 中身を見て 実在の番号なら消す)"); for (const x of fails) console.log("  " + x); process.exit(1); }
console.log("✓ PASS (基準値より増えていない・負のコントロール確認済み)");
