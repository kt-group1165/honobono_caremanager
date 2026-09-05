/**
 * 介護保険 7131 伝送突合の回帰チェック — 残り12拠点 (npm run check:densou-diff-extra)
 *
 * ■ なぜ別ファイルか
 *   check:densou-diff (densou-diff-check.mts, H担当・触らない) は性質の異なる代表7拠点
 *   (おゆみ野/高品/五井/四街道/袖ケ浦/いすみ/ちはら台) だけを回している。
 *   H から割り当てられた「介護保険7131の残差を型に分けて常設検査にする」を、
 *   残る12拠点 (K姉/さつきが丘/やわた/花見川/山武/姉ム/市原/大網/中央/東郷/茂原/木更津)
 *   に対して同じ方式 (kaigo-densou-diff.mts の DIFF_JSON を叩き、指紋+person/group結果を
 *   基準値と比較) で追加したもの。19拠点フルカバーにするための★増分。
 *
 * ■ 判定 (check:densou-diff と同じ)
 *   指紋 (ほのぼの側) 一致 + 結果 悪化 → ★ 回帰。FAIL する
 *   指紋 不一致                       → データが変わった。--update でよい
 *   指紋 一致 + 結果 改善             → PASS (--update で基準値を上げてよい)
 *
 * ■ 使い方
 *   npm run check:densou-diff-extra
 *   npm run check:densou-diff-extra -- --update
 *
 * ■ 現在の差の中身 — 2026-09-05 実測・型分類 (H の「A〜Fと同じ形」の指示に沿って分類)
 *   ⚠ 「型が分かれば十分」— 0 を目指さない。数字の悪化だけを検出する。
 *
 *   【型G】利用者負担額のみが乖離 (保険給付・合計単位は一致) — 上限管理/負担割合系の疑い
 *     K姉   00122192|1000053781: 利用者負担 新=2683 ほ=0
 *           ★ これが SESSION_START の「過大1名 ¥2,683」と一致する金額。要確認候補の筆頭。
 *     K姉   00122192|1000016784: 利用者負担 新=0 ほ=2384 (逆方向)
 *     やわた 00122192|1000127511: 利用者負担 新=0 ほ=5353
 *     ⚠ 3件とも保険者番号 00122192 で共通。同一制度パラメータ (負担割合 or 上限管理) の
 *       疑いがあるが、対象者3名の個別事情 (負担割合証・上限管理事業所) の確認が必要。
 *       ★ データ側の確認が必要な項目であり、コードのバグとは断定していない。
 *
 *   【型H】実績回数が系統的に新<ほ (当方の実績記録が不足している可能性)
 *     市原  00122192|1000096999 / 1000144672: 実日数・117311回数が新<ほ
 *     中央  00121012|1003944806 / 00122168|0000614057: 同様の新<ほパターン
 *     東郷  4名すべてが新<ほ (合計単位差の合計 ≒ ¥17,511 の主要な内訳候補)
 *     ⚠ 東郷は1拠点に集中しており、他拠点と違う原因 (実績取込の範囲漏れ等) の可能性。
 *
 *   【型J】既知の「身体9系0単位」問題 (SESSION_START既出。五井・K姉の井口恵子、差4,797円)
 *     K姉  00122192|1000151812: code 116711 の単位が 1124→1206 で乖離
 *     (check:densou-diff 側の五井 1000138221 と対になる既知案件)
 *
 *   【型K】新のみ (DB余剰実績疑い)
 *     K姉   00122192|1000037393
 *     ⚠ 袖ケ浦の新のみ (2290134465) は check:densou-diff 側で「月遅れ請求で金額は
 *       1円まで一致」と既に解明済み。同じ型が他にもないか確認要。
 *
 *   【型L】まるごと欠落 (ほのみ)。複数拠点で同一被保番が重複するのは兼務/複数事業所利用者
 *     おゆみ野/中央で同一被保番2名が重複 (00121012|1004149827, 00121046|1003418405)
 *     → ★ 1名の欠落が2拠点分としてカウントされている可能性。実質欠落者数は集計より少ない。
 *     さつきが丘/花見川/やわた/高品/市原/東郷 各1名ずつ (check:densou-diff-extra 対象分)
 *
 *   【完全一致】大網・姉ム・茂原・木更津・山武(person層)・四街道・ちはら台
 *     ★ 6/12拠点が person 層で完全一致。差が出るのは兼務・上限管理絡みの一部拠点に集中。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(__dirname, "kaigo-densou-diff-extra-expected.json");
const UPDATE = process.argv.includes("--update");

const TARGETS: { office: string; officeId: string; areaDir: string; month: string }[] = [
  { office: "K姉", officeId: "e7c3c270-3310-4e83-9d6a-79761070a2c3", areaDir: "K姉", month: "2026-06" },
  { office: "さつきが丘", officeId: "be3218e6-9b47-4093-ab7e-46f388242fcc", areaDir: "さつきが丘", month: "2026-06" },
  { office: "やわた", officeId: "bdeaa7d7-f267-4d80-abe2-f6b61217a34a", areaDir: "やわた", month: "2026-06" },
  { office: "花見川", officeId: "39ab7760-e23c-49ce-b17f-c5ccfa776d9c", areaDir: "花見川", month: "2026-06" },
  { office: "山武", officeId: "c6e45cbf-e587-41b8-af38-128e04363c0a", areaDir: "山武", month: "2026-06" },
  { office: "姉ム", officeId: "c212da55-7ac3-46ac-8e58-386ee65e7129", areaDir: "姉ム", month: "2026-06" },
  { office: "市原", officeId: "c0bf0c6a-c3a7-4e66-8dfd-6c6085050066", areaDir: "市原", month: "2026-06" },
  { office: "大網", officeId: "269d77bc-5b61-4114-a2ea-e8dc2f220823", areaDir: "大網", month: "2026-06" },
  { office: "中央", officeId: "0237ed1e-bf80-412e-955d-1102fb06e078", areaDir: "中央", month: "2026-06" },
  { office: "東郷", officeId: "66c8a6a4-857e-48bf-a718-6f0f521db8f3", areaDir: "東郷", month: "2026-06" },
  { office: "茂原", officeId: "e08c3706-ad59-4913-b4e2-67f2675422e9", areaDir: "茂原", month: "2026-06" },
  { office: "木更津", officeId: "24596958-b434-466e-800b-842f66f84a8e", areaDir: "木更津", month: "2026-06" },
];

type Result = {
  office: string; officeId: string; month: string;
  fingerprint: { newRows: number; honoRows: number; honoHash?: string; newHash?: string };
  person: { match: number; mismatch: number; onlyNew: number; onlyHono: number; total: number };
  group: { newGroups: number; honoGroups: number; match: number; diff: number };
};

const tmp = mkdtempSync(join(tmpdir(), "densou-diff-extra-"));
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
      process.exit(1);
    }
    if (!existsSync(out)) { console.log("✗"); console.error(`★ ${t.office}: DIFF_JSON が書かれていない。測れていないので中止`); process.exit(1); }
    const r = JSON.parse(readFileSync(out, "utf8")) as Result;
    actual.push(r);
    console.log(`人単位 ${r.person.match}/${r.person.total} / 全項目 ${r.group.match}(差 ${r.group.diff})`);
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }

if (UPDATE) {
  writeFileSync(BASELINE, JSON.stringify({ results: actual }, null, 2) + "\n", "utf8");
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
console.log("\n─── 介護保険 (残り12拠点) ───");
for (const a of actual) {
  const b = baseMap.get(key(a));
  if (!b) { console.log(`  ○ ${a.office} ${a.month}: 基準値に無い (新規)。--update で足してください`); dataChanged++; continue; }
  const honoSame =
    a.fingerprint.honoRows === b.fingerprint.honoRows &&
    (a.fingerprint.honoHash ?? "") === (b.fingerprint.honoHash ?? "");
  if (!honoSame) {
    console.log(`  ○ ${a.office} ${a.month}: ★ ほのぼの側のファイルが変わった (行 ${b.fingerprint.honoRows}→${a.fingerprint.honoRows})`);
    dataChanged++; continue;
  }
  const ourSame = (a.fingerprint.newHash ?? "") === (b.fingerprint.newHash ?? "");
  const worse: string[] = [];
  if (a.person.match < b.person.match) worse.push(`人単位 一致 ${b.person.match}→${a.person.match}`);
  if (a.person.mismatch > b.person.mismatch) worse.push(`人単位 不一致 ${b.person.mismatch}→${a.person.mismatch}`);
  if (a.group.match < b.group.match) worse.push(`全項目 一致 ${b.group.match}→${a.group.match}`);
  if (a.group.diff > b.group.diff) worse.push(`全項目 差 ${b.group.diff}→${a.group.diff}`);
  if (worse.length) {
    console.log(`  ★ ${a.office} ${a.month}: 悪化 — ${worse.join(" / ")}`);
    console.log(`     当方の出力: ${ourSame ? "変わっていない (= 突合そのものが非決定的な可能性)" : "★ 変わった (コード変更 か DB のデータ是正)"}`);
    fail++;
  } else {
    const better = a.person.match > b.person.match || a.group.match > b.group.match;
    console.log(`  ${better ? "○ 改善" : "一致"} ${a.office} ${a.month}: 人単位 ${a.person.match}/${a.person.total} / 全項目 ${a.group.match}(差 ${a.group.diff})`);
    ok++;
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} PASS ${ok} / データ変化 ${dataChanged} / ★悪化 ${fail} (計${actual.length}拠点)`);
process.exit(fail === 0 ? 0 : 1);
