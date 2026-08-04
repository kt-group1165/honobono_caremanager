// ============================================================================
// ほのぼの授受データのフォルダ構成を**1 種類に揃える**。
//
//   ほのぼのから出すたびに階層がバラバラ (7 通り) になっていて、取込 script の
//   AREA_DIR を毎回合わせる必要があり「0 件取込に気付かない」事故のもとだった。
//
// ── 正規形 ─────────────────────────────────────────────────────────────────
//   サービス実績データ/<拠点>/<YYYYMM>/<事業種別>/ …MEISAI_*.csv, 介護請求(明細付)_一覧.CSV
//   利用者データ/<拠点>/                            …基本情報・介護保険・公費 CSV / 受給者証 PDF (フラット)
//   伝送データ/<拠点>/<事業種別>/<YYYYMM>/ほのぼのから/ …ほのぼのが出した正解
//                                        /新システム/   …こちらが生成したもの
//
//   <事業種別> = 訪問介護 / 居宅 / 障害
//     訪問介護 … 介護保険の訪問介護 + 総合事業 (同じ事業所エントリで出る)
//     居宅     … 居宅介護支援 (ケアプラン・給付管理)
//     障害     … 障害福祉サービス
//   <拠点> は短縮名で統一 (リンクス茂原→茂原 / 姉む→姉ム)
//
//   使い方:
//     node migrations/normalize_data_folders.mjs            # DRY RUN (移動計画のみ)
//     node migrations/normalize_data_folders.mjs --execute
// ============================================================================
import { readdirSync, statSync, mkdirSync, renameSync, rmdirSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

const EXECUTE = process.argv.includes("--execute");
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const ROOTS = ["サービス実績データ", "利用者データ", "伝送データ"];

/** 拠点名の揺れを吸収 */
const SITE_ALIAS = {
  リンクス茂原: "茂原",
  姉む: "姉ム",
};
/** 中身が要らないフォルダ (丸ごと退避) */
const JUNK_SITES = new Set(["コピー元", "コピー元 - コピー"]);

/** 事業種別の判定に使うパス片 */
const KIND_ALIAS = {
  介護: "訪問介護",
  訪問介護: "訪問介護",
  居宅: "居宅",
  障害: "障害",
};
/** ほのぼの/新システム の揺れ */
const SIDE_ALIAS = {
  ほのぼの: "ほのぼのから",
  ほのぼのから: "ほのぼのから",
  新システム: "新システム",
  新システムから: "新システム",
};

const isMonth = (s) => /^20\d{4}$/.test(s);
/** K姉 の 260606 のような和暦風 6 桁 → 202606 */
const wareki6 = (s) => (/^2[0-9]\d{4}$/.test(s) && !isMonth(s) ? `20${s.slice(0, 2)}${s.slice(2, 4)}` : null);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 伝送ファイル名から事業種別を推定 (パスに手掛かりが無いとき用) */
function kindFromFileName(base) {
  const u = base.toUpperCase();
  if (/^(KJ|TJ|JJ)\d/.test(u) || /^J\d{2}\d{4}\.CSV$/.test(u)) return "障害";
  if (/^KY\d/.test(u) || /^[KS]20\d{4}\.CSV$/.test(u)) return "居宅";
  if (/^KK\d/.test(u) || /^(J|SG)20\d{4}\.CSV$/.test(u)) return "訪問介護";
  return null;
}

/** 1 ファイルの正規化先 (ROOT からの相対パス)。決められないときは null */
function destOf(rel) {
  const segs = rel.split(path.sep);
  const root = segs[0];
  let site = segs[1];
  if (!site) return null;
  if (JUNK_SITES.has(site)) return { junk: true };
  site = SITE_ALIAS[site] ?? site;
  const base = segs[segs.length - 1];
  const mid = segs.slice(2, -1);

  // 事業種別: パスの**最も深い**手掛かりを優先 (…/ほのぼのから/障害/ のような入れ子があるため)
  let kind = null;
  for (const s of mid) if (KIND_ALIAS[s]) kind = KIND_ALIAS[s];
  if (!kind) kind = kindFromFileName(base);

  // 対象月
  let month = null;
  for (const s of mid) {
    if (isMonth(s)) month = s;
    else if (wareki6(s)) month = wareki6(s);
  }

  if (root === "利用者データ") {
    // 拠点直下にフラット化 (ファイル名で制度が分かるので階層は要らない)
    return { dest: path.join(root, site, base) };
  }
  if (root === "サービス実績データ") {
    // 月フォルダが無い置き方 (K姉) は CSV の「日付」列から対象月を読む
    if (!month && /^MEISAI_.*\.csv$/i.test(base)) month = monthFromMeisai(path.join(ROOT, rel));
    if (!month) return null;
    // MEISAI は制度混在なので「出力元の事業所エントリ」単位でしか分けられない。
    //   手掛かりが無ければ 訪問介護 とみなす (居宅の稼働データは 居宅 配下に置かれている)
    return { dest: path.join(root, site, month, kind ?? "訪問介護", base) };
  }
  if (root === "伝送データ") {
    // 対象月は**ファイルの中身の提供年月**で決める。
    //   ⚠ ファイル名の年月は「処理年月」なので月遅れ請求だとズレる。
    //     さつきが丘の KK260801/802/803 は処理 202608 だが中身は 202603/202605/202606。
    //     階層のフォルダ名も当てにならない (202606 の下に 3 か月分が混在していた)。
    month = monthFromDensouContent(path.join(ROOT, rel)) ?? month ?? monthFromDensouName(base);
    if (!month || !kind) return null;
    let side = null;
    for (const s of mid) if (SIDE_ALIAS[s]) side = SIDE_ALIAS[s];
    // ほのぼのから/新システム の階層が無い置き方はファイル名で判別する
    if (!side) side = /^(KK|KY|KJ|TJ|JJ)\d{6}\.CSV$/i.test(base) ? "ほのぼのから" : "新システム";
    return { dest: path.join(root, site, kind, month, side, base) };
  }
  return null;
}

/** MEISAI CSV の「日付」列 (yyyy/m/d) から対象月 YYYYMM を読む */
function monthFromMeisai(abs) {
  try {
    const text = new TextDecoder("shift_jis").decode(readFileSync(abs));
    const lines = text.split(SPLIT_RE).filter((l) => l !== "");
    if (lines.length < 2) return null;
    const i = lines[0].split(",").findIndex((h) => h.trim() === "日付");
    if (i < 0) return null;
    const counts = new Map();
    for (const l of lines.slice(1)) {
      const m = /^(\d{4})\/(\d{1,2})\//.exec((l.split(",")[i] || "").trim());
      if (!m) continue;
      const k = `${m[1]}${m[2].padStart(2, "0")}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    return [...counts].sort((a, b) => b[1] - a[1])[0][0]; // 最頻の月
  } catch {
    return null;
  }
}

/** 伝送 CSV のデータレコード 項5 (提供年月) の最頻値。介護・障害とも同じ位置 */
function monthFromDensouContent(abs) {
  try {
    const text = new TextDecoder("shift_jis").decode(readFileSync(abs));
    const counts = new Map();
    for (const line of text.split(SPLIT_RE)) {
      if (!line) continue;
      const v = (line.split(",")[4] || "").replace(/"/g, "").trim();
      if (!/^20\d{4}$/.test(v)) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    if (sorted.length > 1) {
      console.warn(`  ⚠ 提供年月が混在: ${path.basename(abs)} → ${sorted.map(([k, n]) => `${k}(${n})`).join(" ")} … 最頻の ${sorted[0][0]} に置きます`);
    }
    return sorted[0][0];
  } catch {
    return null;
  }
}

/** 伝送ファイル名 → 提供年月 YYYYMM */
function monthFromDensouName(base) {
  // 新システム側: J112606.CSV / J612606.CSV / K202606.CSV / S202606.CSV / SG202606.CSV
  let m = /^(?:J\d{2}|SG|[KSJ])(\d{4})\.CSV$/i.exec(base);
  if (m) {
    const v = m[1];
    // 2606 = 和暦 R8/06、2026 のような西暦は来ない (4 桁は必ず 年2桁+月2桁)
    return `20${v.slice(0, 2)}${v.slice(2)}`;
  }
  // ほのぼの側: KK260701.CSV = 処理年月 R8/07 + 連番01 → 提供年月はその 1 つ前
  m = /^(?:KK|KY|KJ|TJ|JJ)(\d{2})(\d{2})\d{2}\.CSV$/i.exec(base);
  if (m) {
    let y = 2000 + Number(m[1]);
    let mo = Number(m[2]) - 1;
    if (mo === 0) { mo = 12; y -= 1; }
    return `${y}${String(mo).padStart(2, "0")}`;
  }
  return null;
}

const SPLIT_RE = new RegExp("\r?\n");

const sha = (p) => createHash("sha1").update(readFileSync(p)).digest("hex");

function main() {
  console.log(`=== データフォルダ正規化 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const files = [];
  for (const r of ROOTS) files.push(...walk(path.join(ROOT, r)));

  const moves = [];
  const junk = [];
  const unknown = [];
  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    const d = destOf(rel);
    if (!d) { unknown.push(rel); continue; }
    if (d.junk) { junk.push(rel); continue; }
    if (d.dest === rel) continue; // 既に正規形
    moves.push({ rel, dest: d.dest, abs });
  }

  // 衝突検査: 同じ dest に 2 つ以上来るもの
  const byDest = new Map();
  for (const m of moves) {
    if (!byDest.has(m.dest)) byDest.set(m.dest, []);
    byDest.get(m.dest).push(m);
  }
  // 既に正規形の場所にファイルがある場合も衝突
  const dupes = [];
  const staleGenerated = [];
  const dropAsIdentical = [];
  for (const [dest, ms] of byDest) {
    const existsAlready = files.some((f) => path.relative(ROOT, f) === dest);
    const group = ms.slice();
    if (existsAlready) group.unshift({ rel: dest, abs: path.join(ROOT, dest), keep: true });
    if (group.length <= 1) continue;
    const hashes = group.map((g) => sha(g.abs));
    if (new Set(hashes).size === 1) {
      // 中身が同じ → 1 つ残して他は削除
      for (const g of group.slice(1)) dropAsIdentical.push(g);
      // 先頭が keep(既存) でなければ、先頭だけ移動する
      if (group[0].keep) for (const g of group.slice(1)) { /* 全部削除 */ }
    } else if (dest.includes(`${path.sep}新システム${path.sep}`)) {
      // 新システム側は**こちらが生成したもの**なので、内容が違っても最新だけ残せばよい
      //   (過去の生成物が別階層に散らばっているだけ。いつでも再生成できる)
      const sorted = group.slice().sort((a, b) => statSync(b.abs).mtimeMs - statSync(a.abs).mtimeMs);
      for (const g of sorted.slice(1)) dropAsIdentical.push(g);
      staleGenerated.push({ dest, kept: sorted[0].rel, dropped: sorted.slice(1).map((g) => g.rel) });
    } else {
      dupes.push({ dest, group, hashes });
    }
  }
  const dropSet = new Set(dropAsIdentical.map((g) => g.rel));
  const realMoves = moves.filter((m) => !dropSet.has(m.rel));

  console.log(`ファイル総数: ${files.length}`);
  console.log(`  移動        : ${realMoves.length}`);
  console.log(`  同一内容で重複 (削除): ${dropAsIdentical.length}`);
  console.log(`  不要フォルダ (コピー元等): ${junk.length}`);
  console.log(`  判定不能    : ${unknown.length}`);

  if (staleGenerated.length) {
    console.log(`
新システム(生成物)の古い複製を破棄 ${staleGenerated.length} 箇所:`);
    for (const s of staleGenerated) {
      console.log(`  残す: ${s.kept}`);
      for (const d of s.dropped) console.log(`  捨て: ${d}`);
    }
  }
  if (dupes.length) {
    console.error(`\n✗ 中身の違うファイルが同じ場所に来ます (${dupes.length} 件)。手で確認してください:`);
    for (const d of dupes) {
      console.error(`  → ${d.dest}`);
      d.group.forEach((g, i) => console.error(`      ${d.hashes[i].slice(0, 8)}  ${g.rel}`));
    }
    process.exit(1);
  }
  if (unknown.length) {
    console.log(`\n判定不能 (触らずに残します):`);
    for (const u of unknown) console.log(`  ${u}`);
  }
  if (dropAsIdentical.length) {
    console.log(`\n同一内容の重複 (削除):`);
    for (const g of dropAsIdentical.slice(0, 20)) console.log(`  ${g.rel}`);
    if (dropAsIdentical.length > 20) console.log(`  … 他 ${dropAsIdentical.length - 20} 件`);
  }
  console.log(`\n移動計画:`);
  for (const m of realMoves) console.log(`  ${m.rel}\n    → ${m.dest}`);
  if (junk.length) {
    console.log(`\n不要フォルダ (削除):`);
    for (const j of junk.slice(0, 10)) console.log(`  ${j}`);
    if (junk.length > 10) console.log(`  … 他 ${junk.length - 10} 件`);
  }

  if (!EXECUTE) {
    console.log(`\n※ DRY RUN。--execute で実行します。`);
    return;
  }

  for (const g of dropAsIdentical) unlinkSync(g.abs);
  for (const j of junk) unlinkSync(path.join(ROOT, j));
  for (const m of realMoves) {
    const to = path.join(ROOT, m.dest);
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(m.abs, to);
  }
  // 空フォルダを掃除 (深い順)
  const dirs = [];
  const collect = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) { dirs.push(p); collect(p); }
    }
  };
  for (const r of ROOTS) collect(path.join(ROOT, r));
  dirs.sort((a, b) => b.length - a.length);
  let removed = 0;
  for (const d of dirs) {
    try { rmdirSync(d); removed++; } catch { /* 空でなければそのまま */ }
  }
  console.log(`\n✓ 完了: 移動 ${realMoves.length} / 削除 ${dropAsIdentical.length + junk.length} / 空フォルダ ${removed} 件`);
}

main();
