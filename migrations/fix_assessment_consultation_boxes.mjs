// ============================================================================
// アセスメント (kaigo_assessments) の 相談内容 本人/家族 2枠 を、
// 現在の _parse_seikatsu_assessment_pdf.py (dd7a41fb で「印字ラベルのy区間で
// 切る」方式に是正済み) で元PDFを再抽出し、DBの値と食い違う行だけ更新する。
//
// ── 背景 (2026-09-14 H割当・G調査) ────────────────────────────────────────
//   commit dd7a41fb (2026-09-03 05:33) で consultation_boxes() の話者取り違え
//   バグは既に修正済みだった。取込 (b2d09608, 2026-08-31) はそれより前なので、
//   DB には旧ロジックの値がそのまま残っている。
//   → 新しい分離ロジックは書かない。既に正しい _parse_seikatsu_assessment_pdf.py
//   で再抽出し、DBの値と比較して食い違う行だけ更新する「差分適用」script。
//
// ── 「未編集」の判定は 旧ロジックの再現 で行う (2026-09-14 H指摘で全面改訂) ──
//   updated_at は certification_id backfill (fix_assessment_cert_link.mjs) の
//   巻き添えで 110/113 件が書き換わっており、編集有無の判定には使えない。
//   → 「DBの現在値が旧ロジックの出力と一致するか」だけを判定に使う。
//     一致すれば「取込時のまま (旧バグの影響を受けているだけ)」= 更新対象。
//     一致しなければ「取込後に誰かが人力で書き換えた」= 対象外・一覧に出す。
//   旧ロジックの正体 (dd7a41fb の diff で確認): text_blocks()/chunks_of() 等の
//   汎用ブロック抽出は dd7a41fb で変更されていない。変わったのは
//   consultation_boxes() の追加だけ。よって★現行 .py の blocks 出力から
//   旧 import_assessment_from_pdf.mjs (dd7a41fb^) の fragmentOf() と同じ式
//     left = blocks.filter(x<60 かつ 20文字超).sort(y降順)
//     family = left[0] / user = left[1]
//   を適用すれば、旧.py を別途実行しなくても旧ロジックの出力を再現できる。
//   ★ ただし「本当にそうか」を実行時に必ず確認する: git show dd7a41fb^:...py を
//   scratch に一時展開して実際に実行し、上の式で求めた値と一致することを
//   1ファイルで検証してから (一致しなければ即中止)、本題の全件比較に入る。
//   (リポジトリに旧版ファイルは残さない — 使用後に削除する)
//
// ⚠ 「家族：」「娘：」「妻：」等の接頭辞がfamily欄に残るのはバグではない。
//   raw PDFで実物突合済み: 記入者が「介護者・家族」欄の中で続柄を自分で
//   書き添えている (2026-09-14 小松知惠子「娘：」/小川昭江「家族：」で確認)。
//   誤って2枠が混ざったものではないため、この接頭辞は削らずそのまま保存する。
//
// ── PDF ↔ DB行 の照合 (2026-09-14 H指摘で全面改訂) ─────────────────────────
//   旧実装は「PDF氏名の生文字列」でグルーピングし、同姓同名を一律対象外に
//   していた (113件中33名。多すぎるとH指摘)。原因は ① 異体字を畳んでいない
//   (髙/高 等) ② 氏名だけで照合し実施日を見ていない、の2つ。
//   → 各 kaigo_assessments 行は user_id (→clients.name) と assessment_date を
//   既に持っているので、PDF側も氏名(異体字畳み込み後。migrations/
//   _name_normalize.mjs の normName を使用。L作成のモジュールをそのまま使う)
//   + 実施日 (import_assessment_from_pdf.mjs と同じ抽出式で blocks から取る:
//   x>460&&y<150 の日付ブロック最終行) の組で照合する。これで真の同姓同名
//   (氏名も実施日も一致してしまう別人) 以外は正しく1対1に決まるはず。
//
//   ★ それでも (氏名+実施日) が重複するキーが 33件残った (2026-09-14)。
//   原因は同姓同名ではなく、★ 同一PDFの重複印刷/再取得だった (scratch_dup_check_all.mjs
//   で 33件全部を検証: 各グループの blocks 出力が group内で完全に byte-identical。
//   異体字や日付の取り違えではなく、内容そのものが同じファイルが複数存在するだけ)。
//   → 「氏名+実施日」が重複しても、★ 抽出結果 (oldUser/oldFamily/newUser/newFamily)
//   が group 内で完全一致するなら「重複印刷」として1件に畳んで通常どおり処理する。
//   1件でも値が食い違う場合だけ「真の同姓同名+同日」として対象外・一覧に残す。
//
//   node migrations/fix_assessment_consultation_boxes.mjs --dir "<PDFフォルダ>"
//   node migrations/fix_assessment_consultation_boxes.mjs --dir "<PDFフォルダ>" --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normName } from "./_name_normalize.mjs";

const EXECUTE = process.argv.includes("--execute");
const argAfter = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
};
const DIR = argAfter("--dir") ?? "C:\\Users\\domen-PC\\Box\\10F内共有\\ほのぼのから出力";
const PYTHON = argAfter("--python") ?? "python";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const NEGCTRL_FILE = "生活アセスメント(1)フェースシート(100).pdf"; // 川本いね (検証用参照ファイル)

function loadEnv() {
  const t = readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function pageAll(table, cols, apply, orderCol = "id") {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).order(orderCol).range(from, from + 999);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

/** 令和 8年 6月20日 → 2026-06-20 (import_assessment_from_pdf.mjs の jaDate と同一) */
function jaDate(s) {
  const m = /令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/.exec(s ?? "");
  if (!m) return null;
  const y = 2018 + Number(m[1]);
  return `${y}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

/** アセスメント実施日 (右下の日付ブロック最終行)。import_assessment_from_pdf.mjs の
 * _date と同一式。右上 (印刷日) を拾わないよう x>460&&y<150 に絞る。 */
function dateFromBlocks(blocks) {
  const b = (blocks ?? []).filter((b) => b.x > 460 && b.y < 150).sort((a, b) => a.y - b.y)[0];
  if (!b) return null;
  const lines = b.text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = jaDate(lines[i]);
    if (d) return d;
  }
  return null;
}

/** 旧ロジック (dd7a41fb^ の import_assessment_from_pdf.mjs fragmentOf() と同じ式)。
 * text_blocks()/chunks_of() は dd7a41fb で変更されていないため、現行 .py の
 * blocks 出力にこの式を適用すれば旧ロジックの出力を再現できる (起動時に検証する)。 */
function oldLogicConsultation(blocks) {
  const left = (blocks ?? []).filter((b) => b.x < 60 && b.text.length > 20).sort((a, b) => b.y - a.y);
  return { family: left[0]?.text ?? "", user: left[1]?.text ?? "" };
}

/** 「blocksから旧ロジックを再現できる」という前提そのものを検証する。
 * git show で dd7a41fb^ 時点の .py を scratch に一時展開して実際に実行し、
 * oldLogicConsultation(現行.pyのblocks) と一致するか確認する。
 * リポジトリに旧版ファイルを残さない (使用後に削除)。 */
async function verifyOldLogicAssumption(currentParsed) {
  console.log("=== 前提検証: 現行.pyのblocksから旧ロジックを再現できるか ===");
  const target = currentParsed.find((r) => r.file.endsWith(NEGCTRL_FILE));
  if (!target) { console.log(`  ⚠ 参照ファイル(${NEGCTRL_FILE})が見つからない。前提検証をスキップ`); return; }
  const page = (target.pages ?? []).find((p) => p.kind === "face_sheet");
  const derivedFromNew = oldLogicConsultation(page?.blocks);

  const oldPyPath = path.join(ROOT, "migrations", "_negctrl_old_parser_tmp.py");
  const oldPySrc = execFileSync("git", ["show", "dd7a41fb^:migrations/_parse_seikatsu_assessment_pdf.py"], {
    cwd: ROOT, encoding: "utf8",
  });
  writeFileSync(oldPyPath, oldPySrc, "utf8");
  try {
    const raw = execFileSync(PYTHON, [oldPyPath, path.join(DIR, NEGCTRL_FILE)], { maxBuffer: 1 << 26, encoding: "utf8" });
    const parsedOld = JSON.parse(raw);
    const pageOld = (parsedOld[0]?.pages ?? []).find((p) => p.kind === "face_sheet");
    const left = (pageOld?.blocks ?? []).filter((b) => b.x < 60 && b.text.length > 20).sort((a, b) => b.y - a.y);
    const actualOld = { family: left[0]?.text ?? "", user: left[1]?.text ?? "" };
    const ok = actualOld.family === derivedFromNew.family && actualOld.user === derivedFromNew.user;
    console.log(`  現行.pyのblocksから導出: 本人=${JSON.stringify(derivedFromNew.user.slice(0, 30))} 家族=${JSON.stringify(derivedFromNew.family.slice(0, 30))}`);
    console.log(`  実際に旧.pyを実行     : 本人=${JSON.stringify(actualOld.user.slice(0, 30))} 家族=${JSON.stringify(actualOld.family.slice(0, 30))}`);
    if (!ok) {
      console.error("  ✗ 前提が崩れている (現行.pyのblocksから旧ロジックを再現できない)。中止します。");
      process.exit(1);
    }
    console.log("  ✓ 前提成立: 以降は現行.pyの1回の実行だけで旧ロジックの出力も同時に求める\n");

    // ここまでの副産物として「負のコントロール」も同時に示せる: 旧ロジックが
    // DBの現在の誤りをそのまま再現すること (H が最初に求めた検証)。
    const negCtrlRow = await negCtrlDbLookup();
    if (negCtrlRow) {
      const dbFace = (negCtrlRow.form_data ?? {}).face_sheet ?? {};
      const dbUser = (dbFace.consultation_user ?? "").trim();
      const dbFamily = (dbFace.consultation_family ?? "").trim();
      const matches = dbUser === actualOld.user.trim() && dbFamily === actualOld.family.trim();
      console.log(`=== 負のコントロール: 旧ロジックはDBの現在の誤りを再現するか ===`);
      console.log(`  DB本人: ${JSON.stringify(dbUser.slice(0, 30))} ${dbUser === actualOld.user.trim() ? "= 旧ロジック" : "≠ 旧ロジック"}`);
      console.log(`  DB家族: ${JSON.stringify(dbFamily.slice(0, 40))} ${dbFamily === actualOld.family.trim() ? "= 旧ロジック" : "≠ 旧ロジック"}`);
      console.log(`  ${matches ? "✓ 一致 (原因が確定した: DBは旧ロジックの出力そのもの)" : "✗ 不一致 (別の経路の可能性)"}\n`);
    }
  } finally {
    try { unlinkSync(oldPyPath); } catch { /* 消せなくても致命的ではない */ }
  }
}

/** (氏名+実施日) が重複するグループのうち、抽出結果が全メンバーで完全一致するものは
 * 「同一内容の重複印刷/再取得」とみなして1件に畳む。1件でも食い違えば畳まず
 * そのまま返す (= 真の同姓同名+同日の可能性として呼び出し側で対象外にする)。 */
function dedupeIdenticalCandidates(cand) {
  if (cand.length <= 1) return cand;
  const sig = (c) => `${c.oldUser} ${c.oldFamily} ${c.newUser} ${c.newFamily}`;
  const sig0 = sig(cand[0]);
  const allSame = cand.every((c) => sig(c) === sig0);
  return allSame ? [cand[0]] : cand;
}

let _cachedClients = null;
async function negCtrlDbLookup() {
  // NEGCTRL_FILE の氏名 (川本いね) の行を name 一致で探す (簡易。本編の照合とは別)
  if (!_cachedClients) _cachedClients = await sb.from("clients").select("id, name").ilike("name", "%川本%いね%").then((r) => r.data ?? []);
  if (!_cachedClients.length) return null;
  const { data } = await sb.from("kaigo_assessments").select("form_data").eq("user_id", _cachedClients[0].id).limit(1);
  return data?.[0] ?? null;
}

async function main() {
  console.log(`=== アセスメント相談内容(本人/家族) 差分適用 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 1) 元PDFを現行 _parse_seikatsu_assessment_pdf.py で1回だけ再抽出
  //    (新値も旧ロジック値もこの1回の出力から導出する。前提はverifyOldLogicAssumptionで検証)
  const files = readdirSync(DIR)
    .filter((f) => f.startsWith("生活アセスメント(1)フェースシート") && f.toLowerCase().endsWith(".pdf"))
    .map((f) => path.join(DIR, f));
  console.log(`元PDF (フェースシート): ${files.length} 枚`);
  if (files.length === 0) { console.error(`✗ ${DIR} に該当PDFが無い`); process.exit(1); }

  const scriptPath = path.join(ROOT, "migrations", "_parse_seikatsu_assessment_pdf.py");
  const raw = execFileSync(PYTHON, [scriptPath, ...files], { maxBuffer: 1024 * 1024 * 64, encoding: "utf8" });
  const parsed = JSON.parse(raw);

  await verifyOldLogicAssumption(parsed);

  // (氏名, 実施日) → 抽出結果 (真の同姓同名+同日は複数入るので配列で持つ)
  const byKey = new Map();
  for (const rec of parsed) {
    if (rec.error) { console.log(`⚠ 読込失敗: ${rec.file} — ${rec.error}`); continue; }
    const page = (rec.pages ?? []).find((p) => p.kind === "face_sheet");
    if (!page || !page.name) continue;
    const date = dateFromBlocks(page.blocks);
    const key = `${normName(page.name)}|${date ?? "?"}`;
    const old = oldLogicConsultation(page.blocks);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({
      file: rec.file,
      newUser: (page.consultation_user ?? "").trim(),
      newFamily: (page.consultation_family ?? "").trim(),
      oldUser: old.user.trim(),
      oldFamily: old.family.trim(),
    });
  }
  console.log(`(氏名+実施日) の組合せ: ${byKey.size} 件`);

  // 2) DB側 (kaigo_assessments 全件 + clients名)
  const rows = await pageAll("kaigo_assessments", "id, user_id, assessment_date, form_data, created_at, updated_at");
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const clients = [];
  for (let i = 0; i < userIds.length; i += 200) {
    const { data } = await sb.from("clients").select("id, name").in("id", userIds.slice(i, i + 200));
    clients.push(...(data ?? []));
  }
  const nameById = new Map(clients.map((c) => [c.id, c.name]));

  const fs2 = (r) => (r.form_data ?? {}).face_sheet ?? {};
  const u = (r) => (fs2(r).consultation_user ?? "").trim();
  const f = (r) => (fs2(r).consultation_family ?? "").trim();
  const classify = (hasUser, hasFamily) => {
    if (hasUser && hasFamily) return "両方あり";
    if (!hasUser && hasFamily) return "本人空・家族のみ";
    if (hasUser && !hasFamily) return "家族空・本人のみ";
    return "両方空";
  };

  let noPdf = 0, ambiguous = 0, dedupedDupPrint = 0, editedAfterImport = 0, unchanged = 0;
  const changes = [];
  const editedList = [];
  const noPdfList = [];
  const ambiguousList = [];
  for (const row of rows) {
    const name = nameById.get(row.user_id);
    if (!name) { noPdf++; noPdfList.push({ row, name: "(氏名不明)" }); continue; }
    const key = `${normName(name)}|${row.assessment_date}`;
    const candRaw = byKey.get(key);
    if (!candRaw || candRaw.length === 0) { noPdf++; noPdfList.push({ row, name }); continue; }
    const cand = dedupeIdenticalCandidates(candRaw);
    if (cand.length > 1) { ambiguous++; ambiguousList.push({ row, name, count: cand.length }); continue; }
    if (candRaw.length > 1) dedupedDupPrint++;

    const c = cand[0];
    const dbUser = u(row);
    const dbFamily = f(row);
    // ★ 「未編集」の判定: DBの現在値 == 旧ロジックの出力 のときだけ更新対象にする
    if (dbUser !== c.oldUser || dbFamily !== c.oldFamily) {
      editedAfterImport++;
      editedList.push({ row, name, dbUser, dbFamily, oldUser: c.oldUser, oldFamily: c.oldFamily });
      continue;
    }
    if (c.newUser === dbUser && c.newFamily === dbFamily) { unchanged++; continue; }
    const oldBucket = classify(!!dbUser, !!dbFamily);
    const newBucket = classify(!!c.newUser, !!c.newFamily);
    const swapped = !!dbUser && !!dbFamily && dbUser === c.newFamily && dbFamily === c.newUser;
    changes.push({ row, name, oldUser: dbUser, oldFamily: dbFamily, newUser: c.newUser, newFamily: c.newFamily, oldBucket, newBucket, swapped });
  }

  console.log(`\n照合できた行 (氏名+実施日が唯一に決まった): ${rows.length - noPdf - ambiguous} 件`);
  console.log(`  対応PDF無し: ${noPdf} 件 / (氏名+実施日)重複で照合不能 (内容も食い違う真の同姓同名疑い): ${ambiguous} 件`);
  console.log(`  うち 重複印刷を1件に畳んで照合できた (内容が完全一致。同一PDFの再取得): ${dedupedDupPrint} 件`);
  console.log(`  うち 取込後に編集された疑い (DB現在値≠旧ロジック出力。対象外): ${editedAfterImport} 件`);
  console.log(`  うち 変化なし (DB現在値=旧ロジック出力=新ロジック出力): ${unchanged} 件`);
  console.log(`  うち ★ 更新対象 (DB現在値=旧ロジック出力 ≠ 新ロジック出力): ${changes.length} 件\n`);

  if (noPdfList.length) {
    console.log(`対応PDF無し (${noPdfList.length}件。氏名+実施日で一致するPDFが無い):`);
    for (const x of noPdfList.slice(0, 20)) console.log(`    ${x.name} (実施日 ${x.row.assessment_date})`);
    if (noPdfList.length > 20) console.log(`    … 他 ${noPdfList.length - 20} 件`);
    console.log("");
  }
  if (ambiguousList.length) {
    console.log(`(氏名+実施日)重複で照合不能 (${ambiguousList.length}件。内容も食い違う=真の同姓同名+同日の疑い。単純な重複印刷は既に畳み済み):`);
    for (const x of ambiguousList) console.log(`    ${x.name} (実施日 ${x.row.assessment_date}) — 該当PDF ${x.count} 枚`);
    console.log("");
  }
  if (editedList.length) {
    console.log(`⚠ 取込後に編集された疑いで対象外にした行 (${editedList.length}件):`);
    for (const x of editedList) {
      console.log(`    ${x.name} (実施日 ${x.row.assessment_date})`);
      console.log(`      DB本人=${JSON.stringify(x.dbUser.slice(0, 30))} / 旧ロジック本人=${JSON.stringify(x.oldUser.slice(0, 30))}`);
      console.log(`      DB家族=${JSON.stringify(x.dbFamily.slice(0, 30))} / 旧ロジック家族=${JSON.stringify(x.oldFamily.slice(0, 30))}`);
    }
    console.log("");
  }

  for (const c of changes) {
    const tag = c.swapped ? " ★入替(本人/家族が丸ごと逆)" : c.oldBucket === "両方あり" ? " ★元々両方ありだったのに内容が変化" : "";
    console.log(`── ${c.name} (id=${c.row.id.slice(0, 8)}…) [${c.oldBucket} → ${c.newBucket}]${tag} ──`);
    console.log(`   本人 旧: ${JSON.stringify(c.oldUser.slice(0, 60))}`);
    console.log(`   本人 新: ${JSON.stringify(c.newUser.slice(0, 60))}`);
    console.log(`   家族 旧: ${JSON.stringify(c.oldFamily.slice(0, 60))}`);
    console.log(`   家族 新: ${JSON.stringify(c.newFamily.slice(0, 60))}`);
  }

  // 3) 予測値: assessment-support-check.mts と同じ分類を「更新適用後」で出す
  const changedIds = new Set(changes.map((c) => c.row.id));
  const changeById = new Map(changes.map((c) => [c.row.id, c]));
  const bucketKey = { "両方あり": "both", "本人空・家族のみ": "userEmpty", "家族空・本人のみ": "famEmpty", "両方空": "neither" };
  const counts = { both: 0, userEmpty: 0, famEmpty: 0, neither: 0 };
  for (const row of rows) {
    let hasUser, hasFamily;
    if (changedIds.has(row.id)) {
      const c = changeById.get(row.id);
      hasUser = !!c.newUser; hasFamily = !!c.newFamily;
    } else {
      hasUser = !!u(row); hasFamily = !!f(row);
    }
    counts[bucketKey[classify(hasUser, hasFamily)]]++;
  }
  console.log(`\n=== 更新適用後の予測値 (現在: 両方あり58/本人空・家族のみ37/家族空・本人のみ0/両方空18) ===`);
  console.log(`  両方あり: ${counts.both} / 本人が空・家族のみ: ${counts.userEmpty} / 家族が空・本人のみ: ${counts.famEmpty} / 両方空: ${counts.neither}`);

  // 4) form_data の他キーが保持されることの確認 (dry-runでも1件分を表示)
  if (changes.length > 0) {
    const sample = changes[0];
    const before = sample.row.form_data ?? {};
    const after = {
      ...before,
      face_sheet: {
        ...fs2(sample.row),
        ...(sample.newUser ? { consultation_user: sample.newUser } : {}),
        ...(sample.newFamily ? { consultation_family: sample.newFamily } : {}),
      },
    };
    if (!sample.newUser) delete after.face_sheet.consultation_user;
    if (!sample.newFamily) delete after.face_sheet.consultation_family;
    const beforeKeys = Object.keys(before).sort();
    const afterKeys = Object.keys(after).sort();
    const beforeFsKeys = Object.keys(before.face_sheet ?? {}).filter((k) => !["consultation_user", "consultation_family"].includes(k)).sort();
    const afterFsKeys = Object.keys(after.face_sheet ?? {}).filter((k) => !["consultation_user", "consultation_family"].includes(k)).sort();
    console.log(`\n=== form_data の他キー保持確認 (サンプル1件: ${sample.name}) ===`);
    console.log(`  form_data トップレベルキー 更新前: [${beforeKeys.join(", ")}]`);
    console.log(`  form_data トップレベルキー 更新後: [${afterKeys.join(", ")}]`);
    console.log(`  一致: ${JSON.stringify(beforeKeys) === JSON.stringify(afterKeys) ? "✓ 完全一致" : "✗ 差異あり"}`);
    console.log(`  face_sheet の他キー(consultation_*以外) 更新前: [${beforeFsKeys.join(", ")}]`);
    console.log(`  face_sheet の他キー(consultation_*以外) 更新後: [${afterFsKeys.join(", ")}]`);
    console.log(`  一致: ${JSON.stringify(beforeFsKeys) === JSON.stringify(afterFsKeys) ? "✓ 完全一致 (他キーは触っていない)" : "✗ 差異あり"}`);
  }

  if (!EXECUTE) {
    console.log(`\n※ DRY RUN。${changes.length} 件を更新するには --execute を付けて実行してください。`);
    return;
  }

  let ok = 0;
  for (const c of changes) {
    const newFormData = {
      ...c.row.form_data,
      face_sheet: {
        ...fs2(c.row),
        ...(c.newUser ? { consultation_user: c.newUser } : {}),
        ...(c.newFamily ? { consultation_family: c.newFamily } : {}),
      },
    };
    if (!c.newUser) delete newFormData.face_sheet.consultation_user;
    if (!c.newFamily) delete newFormData.face_sheet.consultation_family;
    const { error } = await sb
      .from("kaigo_assessments")
      .update({ form_data: newFormData })
      .eq("id", c.row.id);
    if (error) { console.error(`✗ ${c.name}: ${error.message}`); continue; }
    ok++;
  }
  console.log(`\n✓ ${ok}/${changes.length} 件を更新しました`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
