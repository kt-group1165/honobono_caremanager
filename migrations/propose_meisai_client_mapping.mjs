// ============================================================================
// MEISAI の利用者番号が **DB の別人に当たる**分を、拠点ごとのマッピングに書き足す。
//
//   node migrations/propose_meisai_client_mapping.mjs            # DRY RUN
//   node migrations/propose_meisai_client_mapping.mjs --execute
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   利用者番号は **拠点の中でしか一意でない**。番号だけで clients を引くと
//   別人に当たる。実例 (2026-08-31 に check:billing-gap で検出):
//
//     四街道 MEISAI「232」= 松戸 孝雄   →  DB の user_number 232 は 泉水 さき
//                                          (松戸 孝雄 の user_number は 100232)
//     いすみ MEISAI「2147483647」        →  ゴミ番号に複数人がぶら下がっている
//
//   このままだと ある人の稼働が別人の集計に入る。拠点ごとの対応表
//   `_meisai_num_to_client_<拠点>.json` に正しい対応を書けば解消する
//   (取込もこの表を見る)。
//
// ── 提案の作り方 (推測しない) ──────────────────────────────────────────
//   MEISAI の (拠点, 利用者番号, 利用者名) に対して、**次の両方**を満たす
//   利用者が **ちょうど 1 人**のときだけ提案する。
//     ① 氏名が一致する (異体字・制度の区別記号は吸収)
//     ② その拠点の事業所に client_office_assignments がある
//   どちらかで複数/ゼロになるものは提案しない (一覧には出す)。
//
// ── 触る範囲 ────────────────────────────────────────────────────────────
//   migrations/_meisai_num_to_client_<拠点>.json への **追記のみ**。
//   DB には一切書かない。既存のエントリは上書きしない
//   (人が意図して入れた対応を壊さないため)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const MONTH = process.env.MONTH || "2026-06";
const YYYYMM = MONTH.replace("-", "");

const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** 姓によく出る異体字。字形の異体だけ寄せる (齊藤/斎藤 のような別字は寄せない) */
const ITAIJI = { "髙": "高", "﨑": "崎", "澤": "沢", "眞": "真", "濱": "浜", "邊": "辺", "邉": "辺", "瀨": "瀬", "德": "徳" };
const normName = (v) =>
  String(v ?? "")
    .normalize("NFKC")
    .replace(/[（(].*?[)）]/g, "")
    .replace(/[\s　]/g, "")
    .replace(/./g, (ch) => ITAIJI[ch] ?? ch)
    .trim();
/**
 * MEISAI の氏名には制度の区別記号が付く (「宇野 純一 障」) ので前方一致で見る。
 * **候補を探すときはこちら**を使う。緩めると同姓の別人まで候補に入る。
 */
const sameName = (a, b) => {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
};

/**
 * **番号が一致している 2 人が同一人か**を見るときだけ使う緩い判定。
 * 名がカタカナと漢字で違うだけのことがある (「齊藤ﾕｳｷ」と「齊藤 優希」)。
 * 番号一致という前提があるので、姓が同じなら同一人とみなしてよい。
 * ⚠ 候補探しに使ってはいけない (松戸 孝雄 と 松戸 春次 が混ざる)。
 */
const samePersonByNumber = (a, b) => {
  if (sameName(a, b)) return true;
  const x = normName(a), y = normName(b);
  return !!x && !!y && x.slice(0, 2) === y.slice(0, 2);
};

function walk(dir, hit) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = path.join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, hit);
    else hit(p);
  }
}

async function fetchAll(build) {
  const out = [];
  const STEP = 1000;
  for (let from = 0; ; from += STEP) {
    const { data, error } = await build().range(from, from + STEP - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < STEP) return out;
  }
}

/** サービス実績データ配下の MEISAI_*.csv から (拠点, 番号, 氏名) を集める */
function readMeisai() {
  const rows = new Map();          // `${area}|${num}` -> {area, num, name, rows}
  const base = path.join(KAIGO, "サービス実績データ");
  walk(base, (p) => {
    if (!/^MEISAI.*\.csv$/i.test(path.basename(p))) return;
    const rel = p.slice(base.length + 1);
    if (!rel.includes(YYYYMM)) return;
    const area = rel.split(path.sep)[0];
    const lines = new TextDecoder("shift_jis").decode(readFileSync(p)).split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return;
    const h = lines[0].split(",").map((x) => x.trim());
    const iNum = h.indexOf("利用者番号"), iName = h.indexOf("利用者名");
    if (iNum < 0 || iName < 0) return;
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      const num = (c[iNum] ?? "").trim();
      const name = (c[iName] ?? "").trim();
      if (!num || !name) continue;
      const k = `${area}|${num}`;
      if (!rows.has(k)) rows.set(k, { area, num, name, rows: 0 });
      rows.get(k).rows++;
    }
  });
  return [...rows.values()];
}

async function main() {
  console.log(`=== MEISAI 利用者番号 → client の対応を提案する (${MONTH}) ===`);
  console.log(EXECUTE ? "*** 本番実行 (JSON に追記) ***" : "*** DRY RUN (--execute で追記) ***");

  const meisai = readMeisai();
  console.log(`MEISAI: (拠点 × 利用者番号) ${meisai.length} 件`);

  const clients = await fetchAll(() => sb.from("clients").select("id, name, user_number").order("id"));
  const byNumber = new Map();
  for (const c of clients) {
    const n = (c.user_number ?? "").trim();
    if (!n) continue;
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(c);
  }

  // 拠点名 → その拠点の事業所に割り当てられている client_id
  const offices = await fetchAll(() => sb.from("offices").select("id, name").order("id"));
  const assigns = await fetchAll(() => sb.from("client_office_assignments").select("client_id, office_id").order("id"));
  const officeClients = new Map();     // office_id -> Set(client_id)
  for (const a of assigns) {
    if (!officeClients.has(a.office_id)) officeClients.set(a.office_id, new Set());
    officeClients.get(a.office_id).add(a.client_id);
  }
  /** 拠点フォルダ名 → その名前を含む事業所の client 集合 */
  const clientsInArea = (area) => {
    const set = new Set();
    const key = normName(area);
    for (const o of offices) {
      if (!normName(o.name).includes(key)) continue;
      for (const cid of officeClients.get(o.id) ?? []) set.add(cid);
    }
    return set;
  };
  const areaCache = new Map();
  const areaClients = (area) => {
    if (!areaCache.has(area)) areaCache.set(area, clientsInArea(area));
    return areaCache.get(area);
  };

  // ⚠ 対応表のファイル名は **フォルダ名と一致しない**ことがある。
  //   取込は TAG で読むので (さつきが丘 は TAG=さつき)、フォルダ名で新規ファイルを
  //   作ると **誰も読まないファイル**ができる。既存ファイルを名前の前方一致で探す。
  const existingTags = readdirSync(path.join(KAIGO, "migrations"))
    .filter((f) => /^_meisai_num_to_client_.*\.json$/.test(f))
    .map((f) => f.replace("_meisai_num_to_client_", "").replace(".json", ""));
  const maps = new Map();       // area -> {path, json, tag}
  const loadMap = (area) => {
    if (maps.has(area)) return maps.get(area);
    let tag = existingTags.includes(area) ? area : null;
    if (!tag) {
      // 「さつきが丘」→「さつき」のように、フォルダ名の頭に一致する既存 tag を使う
      const cands = existingTags.filter((t) => area.startsWith(t) && t.length >= 2);
      cands.sort((a, b) => b.length - a.length);
      tag = cands[0] ?? area;
    }
    const p = path.join(KAIGO, "migrations", `_meisai_num_to_client_${tag}.json`);
    const entry = { path: p, tag, json: existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}, exists: existsSync(p) };
    maps.set(area, entry);
    return entry;
  };

  const proposals = [], ambiguous = [], noMatch = [], needsReview = [];
  for (const m of meisai) {
    const map = loadMap(m.area);
    if (map.json[m.num]) continue;                     // 既に対応が入っている → 触らない

    const sameNum = byNumber.get(m.num) ?? [];
    // ① 番号が **別人** に当たる → 放置すると稼働が別人の集計に入る
    const numberHitsOther = sameNum.length > 0 && !sameNum.some((c) => samePersonByNumber(c.name, m.name));
    // ② 番号が **誰にも当たらない** → 取込がその人を引けず、実績が丸ごと入らない
    //    (MEISAI の番号が DB の user_number と違うだけのことが多い。
    //     氏名には「(同行)」「(身)」「(有)」のような区分の注記が付く)
    const numberHitsNobody = sameNum.length === 0;
    if (!numberHitsOther && !numberHitsNobody) continue;   // 番号で正しく引ける → 対応表は要らない

    const inArea = areaClients(m.area);
    const cands = clients.filter((c) => sameName(c.name, m.name) && inArea.has(c.id));
    if (cands.length === 1) {
      // ⚠ **当方側の氏名に括弧注記が付いているものは自動で足さない。**
      //   ほのぼのが同じ人を用途別に別レコードで持っていることがあり
      //   (「鈴木 雅代（実）」と「鈴木 雅代（移）」)、寄せてよいか機械では決められない。
      if (/[（(].*[)）]/.test(cands[0].name)) {
        needsReview.push(`${m.area} 番号${m.num}「${m.name}」(${m.rows}行) → 当方「${cands[0].name}」(${cands[0].user_number})`);
        continue;
      }
      proposals.push({ area: m.area, num: m.num, name: m.name, rows: m.rows, cid: cands[0].id,
        cname: cands[0].name, cnum: cands[0].user_number,
        kind: numberHitsOther ? "別人に当たっていた" : "誰にも当たらなかった",
        wrong: sameNum.map((c) => c.name).join("/") });
    } else if (cands.length > 1) {
      ambiguous.push(`${m.area} 番号${m.num}「${m.name}」→ 同名が ${cands.length} 人: ${cands.map((c) => `${c.name}(${c.user_number})`).join(", ")}`);
    } else {
      noMatch.push(`${m.area} 番号${m.num}「${m.name}」(${m.rows}行) → `
        + (sameNum.length > 0
          ? `番号は「${sameNum.map((c) => c.name).join("/")}」に当たるが、同名でその拠点の利用者が見つからない`
          : "番号も氏名も当方に無い (未登録の疑い)"));
    }
  }

  console.log("");
  console.log(`提案 ${proposals.length} 件 / 同名が複数で決められない ${ambiguous.length} / 該当者が見つからない ${noMatch.length}`);
  proposals.forEach((p) => console.log(
    `   ${p.area.padEnd(8)} 番号${String(p.num).padEnd(11)}「${p.name}」${String(p.rows).padStart(3)}行` +
    `  → ${p.cname} (user_number ${p.cnum})   ※番号は${p.kind === "別人に当たっていた" ? `別人「${p.wrong}」に当たっていた` : "当方の誰にも当たらなかった"}`));
  if (ambiguous.length) { console.log("  決められない:"); ambiguous.forEach((a) => console.log("     " + a)); }
  if (needsReview.length) {
    console.log(`  ⚠ 当方側の氏名に括弧注記があるので自動では足さない ${needsReview.length} 件 — 同じ人か人が確かめること:`);
    needsReview.forEach((a) => console.log("     " + a));
  }
  if (noMatch.length) { console.log("  該当者なし:"); noMatch.slice(0, 10).forEach((a) => console.log("     " + a)); }

  if (!EXECUTE) { console.log("\nDRY RUN。--execute で JSON に追記する。"); return; }

  const byArea = new Map();
  for (const p of proposals) {
    if (!byArea.has(p.area)) byArea.set(p.area, []);
    byArea.get(p.area).push(p);
  }
  for (const [area, list] of byArea) {
    const map = loadMap(area);
    // ⚠ JSON.parse → JSON.stringify で書き戻してはいけない。
    //   JavaScript のオブジェクトは **数字に見えるキーを数値順に並べ替える**ので、
    //   10 件足すだけで数百行が動き、何を足したのか diff から読めなくなる。
    //   元のテキストの末尾の } の直前に **行を差し込むだけ**にする。
    let text = readFileSync(map.path, "utf8");
    const close = text.lastIndexOf("}");
    if (close < 0) { console.error(`  ✗ ${map.path} が JSON に見えない`); continue; }
    const head = text.slice(0, close).replace(/\s+$/, "");
    const needComma = /[^{]$/.test(head);        // 既存エントリがあるならカンマが要る
    const added = list.map((q) => `  ${JSON.stringify(q.num)}: ${JSON.stringify(q.cid)}`).join(",\n");
    writeFileSync(map.path, `${head}${needComma ? "," : ""}\n${added}\n}\n`, "utf8");
    const via = map.tag !== area ? ` (tag=${map.tag})` : "";
    console.log(`  ${path.relative(KAIGO, map.path)}${via} に ${list.length} 件追記`);
  }
  console.log(`\n追記 ${proposals.length} 件。取込を回す前に diff を読むこと。`);
}

main().catch((e) => { console.error(e); process.exit(1); });
