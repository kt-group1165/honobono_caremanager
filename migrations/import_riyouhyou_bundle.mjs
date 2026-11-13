// ============================================================================
// 居宅 1 拠点ぶんの「サービス利用票 (第6表) + 利用票別表 (第7表)」の束 PDF をまとめて取り込む runner
//
//   node migrations/import_riyouhyou_bundle.mjs --month 2026-06 --area いすみ --pdf "<束.pdf>" [--pdf ...]            # DRY RUN
//   node migrations/import_riyouhyou_bundle.mjs --month 2026-06 --area いすみ --pdf "<束.pdf>" [--pdf ...] --execute  # 本番 (H 判断)
//   node migrations/import_riyouhyou_bundle.mjs --month 2026-06 --area いすみ --dir "<フォルダ>" [--match <文字列>]       # フォルダの PDF 全部
//
// ── 2026-11-13 実物: 「利用者毎に印刷」は ★ 1 人 1 ファイル (「利用者毎印刷 _ 氏名.pdf」・第6表 → 別表 の 2 ページ〜) で出る ──
//   1 拠点 300 名なら 300 本。--dir でフォルダごと渡す。同じ内容のファイル (ほのぼのが「(1)」「(2)」を付けて
//   出し直したもの) は ★ 中身のハッシュで 1 本にまとめる (2 回読むと 第7表 を 2 回数えるため)
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
import { existsSync, statSync, readdirSync } from "node:fs";
import { parseBundles } from "./_parse_careplan_bundle_pdf.mjs";
import { extractPages } from "./_pdf_words.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const MONTH = arg("--month");
const AREA = arg("--area") ?? "";
const DIR = arg("--dir");
const MATCH = arg("--match");
const RAW_PDFS = [
  ...argv.flatMap((a, i, arr) => (a === "--pdf" ? [arr[i + 1]] : [])),
  ...(DIR && existsSync(DIR) ? readdirSync(DIR).filter((n) => /\.pdf$/i.test(n) && (!MATCH || n.includes(MATCH))).sort().map((n) => path.join(DIR, n)) : []),
];
if (DIR && !existsSync(DIR)) { console.error(`✗ フォルダが無い: ${DIR}`); process.exit(1); }
if (!MONTH || !/^\d{4}-\d{2}$/.test(MONTH)) { console.error("--month YYYY-MM を指定する (例 --month 2026-06)"); process.exit(1); }
// ── 同じ人の出し直しは 1 本にまとめる ─────────────────────────────────────────────
// ほのぼのは同じ人を出し直すと「(1)」「(2)」を付けて別ファイルにする。中身のハッシュは毎回違う
// (2026-11-13 実測: 和田 和久 の 3 本はサイズまで違う) ので、ハッシュでは除けない。
// ★ 2 回読むと 利用票の行が二重に足される (① は人ごとに行を継ぎ足す) ので、
//   1 人 1 ファイルのものは (保険者, 被保番, 提供年月) ごとに ★ 更新時刻の新しい 1 本だけ残す。
// 人が 2 人以上入っている束・人を読めないファイルはそのまま渡す (各 script が人ごとに扱う)。
// 提供年月が --month と違うファイルは渡さない (件数と名前を出す)。
const dupes = [];
const otherMonth = [];
// ★ 印刷設定の違うファイル (2026-11-13 実測)。いつもの出し方は 利用票の「予定」ラベルが x≈326。
//   x≈342 のファイル (列が右にずれ、長いサービス名が 2 行に折り返して後半しか読めない) が混ざっていた。
//   読み取り (_riyouhyou_grid.mjs) はいつもの出し方の列位置で作ってあるので、ずれたファイルは数えて警告する
//   (利用票取込の --only-new は、そういう人を「警告のある行 / マスタに無い名前」で書かない)
const shiftedLayout = [];
const labelX = (p) => {
  const { words } = extractPages(p);
  for (const w of words) {
    const lab = w.find((x) => x.t === "予定" && x.x > 300 && x.x < 360);
    if (lab) return lab.x;
  }
  return null;
};
const byPerson = new Map();
const passThrough = [];
for (const p of RAW_PDFS) {
  if (!existsSync(p) || statSync(p).size === 0) { passThrough.push(p); continue; } // 下でまとめて止める
  const lx = labelX(p);
  if (lx != null && Math.abs(lx - 326) > 6) shiftedLayout.push(`${path.basename(p)} (予定ラベル x=${lx.toFixed(0)})`);
  const ps = parseBundles(p);
  const id = ps.length === 1 ? ps[0].riyouhyouIdentity : null;
  const month = ps.length === 1 ? (ps[0].riyouhyouMonth ?? ps[0].betsuhyouHeader?.month ?? null) : null;
  if (!id?.insurer || !id?.insured || !month) { passThrough.push(p); continue; }
  if (month !== MONTH) { otherMonth.push(`${path.basename(p)} (${month})`); continue; }
  const key = `${id.insurer}|${id.insured}|${month}`;
  const cur = byPerson.get(key);
  if (!cur) { byPerson.set(key, p); continue; }
  const [keep, drop] = statSync(p).mtimeMs > statSync(cur).mtimeMs ? [p, cur] : [cur, p];
  byPerson.set(key, keep);
  dupes.push(`${path.basename(drop)} → ${path.basename(keep)} を使う (同じ人・同じ月。新しいほう)`);
}
const PDFS = [...passThrough, ...byPerson.values()];

if (!PDFS.length) { console.error("--pdf <束.pdf> か --dir <フォルダ> で PDF を最低 1 つ指定する"); process.exit(1); }
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
if (PDFS.length <= 10) for (const p of PDFS) console.log(`  ${p}`);
else console.log(`  ${path.dirname(PDFS[0])} ほか (${PDFS.length} 本)`);
console.log(`  読んだ PDF ${RAW_PDFS.length} 本 → 渡す ${PDFS.length} 本 (同じ人の出し直し ${dupes.length} 本 / 提供年月が ${MONTH} でない ${otherMonth.length} 本 を除いた)`);
if (dupes.length) { console.log("  同じ人の出し直し (古いほうを使わない):"); for (const d of dupes) console.log(`    ${d}`); }
if (shiftedLayout.length) { console.log(`  ⚠ 印刷設定の違うファイル ${shiftedLayout.length} 本 (列がずれている。利用票の新規取込は怪しい人を書かない。第7表・貸与は別表の自己検算に従う):`); for (const d of shiftedLayout.slice(0, 20)) console.log(`    ${d}`); if (shiftedLayout.length > 20) console.log(`    … 他 ${shiftedLayout.length - 20} 本`); }
if (otherMonth.length) { console.log(`  提供年月が ${MONTH} でない (渡さない):`); for (const d of otherMonth) console.log(`    ${d}`); }

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
