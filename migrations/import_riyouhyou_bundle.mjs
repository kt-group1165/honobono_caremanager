// ============================================================================
// 居宅 1 拠点ぶんの「サービス利用票 (第6表) + 利用票別表 (第7表)」の束 PDF をまとめて取り込む runner
//
//   node migrations/import_riyouhyou_bundle.mjs --month 2026-06 --area いすみ --pdf "<束.pdf>" [--pdf ...]            # DRY RUN
//   node migrations/import_riyouhyou_bundle.mjs --month 2026-06 --area いすみ --pdf "<束.pdf>" [--pdf ...] --execute  # 本番 (H 判断)
//
// ── 出し方 (2026-11-13 H 確定) ────────────────────────────────────────────
//   ほのぼの ケアマネ → 利用・提供票 → 印刷 → 「利用者毎に印刷する帳票」で
//   ☑ サービス利用票 (第6表) ☑ 利用票別表 (第7表) / 右パネルで事業所・提供年月・全選択
//   → 1 拠点 1 回の操作で、第6表と別表が人ごとに並んだ 1 本の PDF になる。
//   置き場: 利用者データ/<拠点>/<YYYYMM>/別表/
//   ⚠ 「利用票別表 全CM」(別表だけ・人の印字なし) とは別物。最初の 1 拠点で並び方を確かめること
//
// ── やること (順に。どれかが exit 0 以外で終わったら、そこで止めて後ろは回さない) ──────
//   ① 利用票 (service-usage)       import_riyouhyou_service_usage.mjs --pdf ... --only-new
//      ★ 既に同じ月の利用票がある人は 由来を問わず触らない。新規の人だけ入れる (判断と理由は下)
//   ② 第7表 (service-usage-detail)  import_care_plan3_usage_detail_from_pdf.mjs --pdf ...
//      (既存があれば skip / 行 0 なら書かない / 自己検算の警告で書かない / 利用票と別表の被保番が違えば書かない)
//   ③ 貸与の実額 (rental_month_actual_units)  fill_rental_units_from_betsuhyou.mjs --pdf ...
//      (既に単位がある行は触らない / 事業所・品目で 1 対 1 に決まらないものは埋めない)
//   ★ 安全装置は 3 本の既存のものをそのまま使う。この runner は何も緩めない (引数を足すだけ)
//
// ── 既存の利用票をどうするか (★ 2026-11-13 の判断: 既存は触らない) ─────────────────
//   ・2026-06 の利用票は既に 2,852 件ある (伝送・別経路・以前の PDF 取込)
//   ・① の script は上書きのとき services を丸ごと作り直す。既存の利用票には
//     単位数が後から入っている (manual_units 1,205 行 / rental_month_actual_units 286 行 / backfill の units)。
//     上書きするとそれが消え、由来も混ざる
//   ・日別の印が今の PDF と違っていても、どちらが正かはこの runner では決められない
//   → 新規の人だけ入れる。既存の人は ② ③ だけ (第7表と貸与の実額) を通す。件数は「既に利用票あり」で出る
//
// ── DRY RUN で数えられないもの ──────────────────────────────────────────────
//   ③ は利用票があることが前提。① で新規に入る人は DRY RUN の時点では利用票が無いので、
//   ③ では「利用票なし」に数えられる。--execute では ① の後に ③ を回すので埋まる
// ============================================================================
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const MONTH = arg("--month");
const AREA = arg("--area") ?? "";
const PDFS = argv.flatMap((a, i, arr) => (a === "--pdf" ? [arr[i + 1]] : []));

if (!MONTH || !/^\d{4}-\d{2}$/.test(MONTH)) { console.error("--month YYYY-MM を指定する (例 --month 2026-06)"); process.exit(1); }
if (!PDFS.length) { console.error("--pdf <束.pdf> を最低 1 つ指定する"); process.exit(1); }
for (const p of PDFS) {
  if (!existsSync(p)) { console.error(`✗ PDF が無い: ${p}`); process.exit(1); }
  if (statSync(p).size === 0) { console.error(`✗ PDF が 0 バイト (出力失敗): ${p}`); process.exit(1); }
}

const pdfArgs = PDFS.flatMap((p) => ["--pdf", p]);
const exe = EXECUTE ? ["--execute"] : [];
const STEPS = [
  { key: "利用票", script: "import_riyouhyou_service_usage.mjs", args: [...pdfArgs, "--only-new", ...exe], env: { MONTH, AREA } },
  { key: "第7表", script: "import_care_plan3_usage_detail_from_pdf.mjs", args: [...pdfArgs, ...exe], env: {} },
  { key: "貸与", script: "fill_rental_units_from_betsuhyou.mjs", args: [...pdfArgs, ...exe], env: {} },
];

// 各 script の「まとめ」から拾う行 (見出しの文字で引く。数字の位置は決め打ちしない)
const PICK = {
  利用票: [/PDF の利用者/, /引き当て成功/, /引き当て失敗/, /複数該当/, /合計が合わない行/, /氏名が食い違う/, /読めずに落ちたページ/, /INSERT/, /UPDATE/, /skip \(/, /✗ 失敗/],
  第7表: [/人数 \(ファイル内/, /利用者引き当て成功/, /引き当て失敗/, /氏名不一致/, /対象月不明/, /第7表 (書込|書かない)/],
  貸与: [/^\s*\{"人"/, /A 一意/, /B 多重/, /C 多重/, /D 行数違い/, /既に単位あり/, /食い違う/, /埋める帳票/],
};

console.log(`=== 居宅 束 PDF 取込 runner ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"}  ${AREA || "(拠点名なし)"} ${MONTH} / PDF ${PDFS.length} 本 ===`);
for (const p of PDFS) console.log(`  ${p}`);

const summary = [];
for (const st of STEPS) {
  console.log(`\n${"─".repeat(70)}\n■ ${st.key}  (${st.script})\n${"─".repeat(70)}`);
  const r = spawnSync(process.execPath, [path.join(HERE, st.script), ...st.args], {
    cwd: path.join(HERE, ".."), env: { ...process.env, ...st.env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout ?? "") + (r.stderr ? `\n${r.stderr}` : "");
  process.stdout.write(out);
  const lines = out.split(/\r?\n/);
  const picked = lines.filter((l) => PICK[st.key].some((re) => re.test(l))).map((l) => l.trim());
  summary.push({ key: st.key, status: r.status, picked });
  if (r.status !== 0) {
    console.error(`\n✗ ${st.key} が exit ${r.status} で終わった。後ろの手順は回さない`);
    break;
  }
}

console.log(`\n${"═".repeat(70)}\n■ まとめ (${EXECUTE ? "EXECUTE" : "DRY RUN"})  ${AREA} ${MONTH}\n${"═".repeat(70)}`);
for (const s of summary) {
  console.log(`[${s.key}] exit ${s.status}`);
  for (const l of s.picked) console.log(`    ${l}`);
}
const ran = summary.length;
if (ran < STEPS.length) console.log(`⚠ ${STEPS.length - ran} 手順を回していない (前の手順が失敗)`);
if (!EXECUTE) console.log("\n※ DRY RUN。③ の「利用票なし」には ① で新規に入る人も含まれる (--execute では ① の後に ③ を回すので埋まる)");
process.exit(summary.every((s) => s.status === 0) && ran === STEPS.length ? 0 : 1);
