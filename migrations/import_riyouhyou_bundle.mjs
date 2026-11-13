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
// ── 60 ページずつに割って出したとき (2026-11-13 H: リモート PC が 351 ページで落ちるため) ────────────
//   ・同じ人が複数ファイルに出たら 第7表・貸与の取込が ★ 人単位で 1 つに決める (_parse_careplan_bundle_pdf.mjs の parseBundlesMany)
//     完全 (自己検算 OK) で中身が同じ → 1 つ / 完全で中身が違う → どれも書かない / 割れて不完全 → 完全な方を使う
//     (下の「新しい方を残す」は 1 人 1 ファイルの「利用者毎印刷」の出し直し用。束どうしには使わない)
//   ・最後に「★ 取り込めなかった人」を 氏名・被保番・理由で必ず出す (第7表の取込が出す ★未取込 行を拾う)。その人だけ出し直す
//   ・最後に 拠点の進捗 (その月の利用票の人数 / 第7表がある人数 / 今回の書込予定) を出す
//
// ── DRY RUN で数えられないもの ──────────────────────────────────────────────
//   ③ は利用票があることが前提。① で新規に入る人は DRY RUN の時点では利用票が無いので、
//   ③ では「利用票なし」に数えられる。--execute では ① の後に ③ を回すので埋まる
// ============================================================================
import { spawnSync } from "node:child_process";
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AREA_OFFICES } from "./_area_offices.mjs";
import { parseBundles, classifyPage, parseBetsuhyouHeader } from "./_parse_careplan_bundle_pdf.mjs";
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
// ★ ページ単位の検品 (2026-11-13 H 依頼)。人として認識されなかったページは「取り込めなかった人」に出ないので、
//   別表のページごとに ヘッダ (提供年月・被保番・氏名) が読めたかを数える。被保番は英字で始まることがある (四街道 H551079091 新井 秀雄 ほか。
//   この 2 名はヘッダの行だけ 110 ほど左にずれ、末尾に空欄の「: 令和 年 月 日」が付く。明細の列は通常どおり)
const pageAudit = { betsuhyouPages: 0, noHeader: [], labelXs: new Map() };
const labelX = (p) => {
  const { words, texts } = extractPages(p);
  for (const [i, t] of texts.entries()) {
    if (classifyPage(t) !== "betsuhyou") continue;
    pageAudit.betsuhyouPages++;
    if (!parseBetsuhyouHeader(t)) pageAudit.noHeader.push(`${path.basename(p)} p${i + 1}`);
    const lab = words[i].find((x) => x.t === "サービス利用票別表");
    if (lab) { const k = Math.round(lab.x); pageAudit.labelXs.set(k, (pageAudit.labelXs.get(k) ?? 0) + 1); }
  }
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
  第7表: [/同じ人が複数ファイルに出た/, /人数 \(ファイル内/, /利用者引き当て成功/, /引き当て失敗/, /氏名不一致/, /対象月不明/, /第7表 (書込|書かない)/],
  貸与: [/同じ人が複数ファイル/, /^\s*\{"人"/, /A 一意/, /B 多重/, /C1 /, /うち KY 検算/, /C2 /, /D 行数違い/, /既に単位あり/, /TAIS で当てた/, /TAIS で確定/, /割り切れず/, /KY 単独.*上書き/, /食い違う/, /埋める帳票/],
};

console.log(`=== 居宅 束 PDF 取込 runner ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"}  ${AREA || "(拠点名なし)"} ${MONTH} / PDF ${PDFS.length} 本 ===`);
if (PDFS.length <= 10) for (const p of PDFS) console.log(`  ${p}`);
else console.log(`  ${path.dirname(PDFS[0])} ほか (${PDFS.length} 本)`);
console.log(`  読んだ PDF ${RAW_PDFS.length} 本 → 渡す ${PDFS.length} 本 (同じ人の出し直し ${dupes.length} 本 / 提供年月が ${MONTH} でない ${otherMonth.length} 本 を除いた)`);
if (dupes.length) { console.log("  同じ人の出し直し (古いほうを使わない):"); for (const d of dupes) console.log(`    ${d}`); }
if (shiftedLayout.length) { console.log(`  ⚠ 印刷設定の違うファイル ${shiftedLayout.length} 本 (列がずれている。利用票の新規取込は怪しい人を書かない。第7表・貸与は別表の自己検算に従う):`); for (const d of shiftedLayout.slice(0, 20)) console.log(`    ${d}`); if (shiftedLayout.length > 20) console.log(`    … 他 ${shiftedLayout.length - 20} 本`); }
if (otherMonth.length) { console.log(`  提供年月が ${MONTH} でない (渡さない):`); for (const d of otherMonth) console.log(`    ${d}`); }
console.log(`  ★ ページ単位の検品: 別表のページ ${pageAudit.betsuhyouPages} / ヘッダの番号が読めなかったページ ${pageAudit.noHeader.length}` +
  ` / 「サービス利用票別表」ラベルの x ${[...pageAudit.labelXs].map(([x, n]) => `${x}:${n}`).join(" ") || "なし"}${pageAudit.labelXs.size > 1 ? " ← ★ 2 種類以上 = 印刷設定の違うページが混ざっている" : ""}`);
for (const d of pageAudit.noHeader.slice(0, 20)) console.log(`    ヘッダが読めない: ${d}`);

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
  summary.push({ key: st.key, status: r.status, picked, out });
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

// ── ★ 取り込めなかった人 (第7表の取込が出す「★未取込<TAB>氏名<TAB>被保番<TAB>理由」) ──
const notIn = new Map();
for (const s of summary) for (const l of s.out.split(/\r?\n/)) {
  if (!l.startsWith("★未取込\t")) continue;
  const [, name, insured, reason] = l.split("\t");
  notIn.set(`${name}|${insured}|${reason}`, { name, insured, reason });
}
console.log(`\n★ 取り込めなかった人 ${notIn.size} 名${notIn.size ? " (この人だけ出し直す)" : ""}`);
for (const r of [...notIn.values()].sort((a, b) => a.reason.localeCompare(b.reason) || a.name.localeCompare(b.name)))
  console.log(`    ${r.name || "(氏名不明)"}  被保番 ${r.insured || "-"}  ${r.reason}`);

// ── 拠点の進捗: その月の利用票がある人のうち 第7表がある人 ──
await (async () => {
  if (!AREA || !Array.isArray(AREA_OFFICES[AREA])) { console.log(`\n(拠点の進捗: --area ${AREA || "なし"} から居宅を引けないので出さない)`); return; }
  const env = Object.fromEntries(readFileSync(path.join(HERE, "..", ".env.local"), "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const all = async (build) => { const o = []; for (let f = 0; ; f += 1000) { const { data, error } = await build().range(f, f + 999); if (error) throw new Error(error.message); o.push(...data); if (data.length < 1000) break; } return o; };
  const norm = (v) => String(v ?? "").normalize("NFKC").replace(/[\s　]/g, "");
  const kyo = (await all(() => sb.from("offices").select("id, name").eq("service_type", "居宅介護支援").order("id")))
    .filter((o) => AREA_OFFICES[AREA].some((w) => norm(o.name) === norm(w)));
  if (!kyo.length) { console.log(`\n(拠点の進捗: ${AREA} の居宅介護支援事業所が offices に無い)`); return; }
  const [y, m] = MONTH.split("-").map(Number);
  const first = `${MONTH}-01`, last = `${MONTH}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const users = new Set((await all(() => sb.from("client_office_assignments").select("id, client_id, start_date, end_date").in("office_id", kyo.map((o) => o.id)).order("id")))
    .filter((r) => (!r.start_date || r.start_date <= last) && (!r.end_date || r.end_date >= first)).map((r) => r.client_id));
  const su = new Set((await all(() => sb.from("kaigo_report_documents").select("id, user_id").eq("report_type", "service-usage").eq("report_month", MONTH).order("id"))).map((d) => d.user_id).filter((u) => users.has(u)));
  const sud = new Set((await all(() => sb.from("kaigo_report_documents").select("id, user_id").eq("report_type", "service-usage-detail").eq("report_month", MONTH).order("id"))).map((d) => d.user_id).filter((u) => su.has(u)));
  const plan = Number((summary.find((s) => s.key === "第7表")?.out.match(/第7表 書込予定\s+(\d+)/) ?? [])[1] ?? 0);
  console.log(`\n■ 拠点の進捗  ${AREA} (${kyo.map((o) => o.name).join(" / ")})  ${MONTH}`);
  console.log(`    利用票がある人 ${su.size} 名 (この居宅に割当があり その月の利用票がある人) / 第7表あり ${sud.size} 名${EXECUTE ? "" : ` / 今回の書込予定 ${plan} 件`}`);
  console.log(`    → まだ第7表が無い ${Math.max(su.size - sud.size - (EXECUTE ? 0 : plan), 0)} 名${EXECUTE ? "" : " (DRY RUN なので書込予定を引いた見込み。他拠点の人が混ざると少なく見える)"}`);
})();
const ran = summary.length;
if (ran < STEPS.length) console.log(`⚠ ${STEPS.length - ran} 手順を回していない (前の手順が失敗)`);
if (!EXECUTE) console.log("\n※ DRY RUN。③ の「利用票なし」には ① で新規に入る人も含まれる (--execute では ① の後に ③ を回すので埋まる)");
process.exit(summary.every((s) => s.status === 0) && ran === STEPS.length ? 0 : 1);
