// ============================================================================
// 利用者データ/<拠点>/ の CSV が **本当にその拠点のものか** を検査する。
//
//   node migrations/check_user_master_csv.mjs              全拠点
//   node migrations/check_user_master_csv.mjs --office 高品 1 拠点だけ
//   node migrations/check_user_master_csv.mjs --detail     食い違いの氏名も出す
//
// **READ ONLY**。CSV と DB を読むだけで、書き込みは一切しない。
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   2026-08-31 に 高品 で「フォルダ名は拠点名なのに **中身は別の事業所**」
//   という事故が見つかった。「きいろG」「中抜け」「初任者研修講習」といった
//   スタッフ用ダミーが並び、その拠点の利用者は青木春夫すら入っていなかった。
//
//   件数だけ見ていると気づけない (それらしい行数が入っているため)。
//   **中身で判定する**必要がある。
//
// ── 何で判定するか ──────────────────────────────────────────────────────
//   介護保険 CSV の **「支援事業所（正式名称）」列**を使う。
//   居宅の利用者はその事業所が担当しているので、拠点のフォルダなら
//   その拠点名が最頻値になるはず。
//
//   ⚠ 訪問介護だけの拠点では 支援事業所は **他社のケアマネ**になるので、
//     最頻値が拠点名にならないのが正常。だから機械的に ✗ とは判定せず、
//     **DB 側の割当との重なり**も併せて出して人が判断できるようにする。
//
//   ⚠ 「一致率が低い = 必ず誤り」ではない。逆に「高い = 正しい」も言えない
//     (古い出力かもしれない)。この script は **怪しい拠点を絞り込むだけ**。
// ============================================================================
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const DATA = path.join(ROOT, "利用者データ");
const DETAIL = process.argv.includes("--detail");
const ONLY = (() => {
  const i = process.argv.indexOf("--office");
  return i >= 0 ? process.argv[i + 1] : null;
})();

// 拠点フォルダではないもの (全社まとめ出力など)
const NOT_OFFICE = new Set(["全居宅", "全社_R8-08", "障害全事業所"]);

// ── 拠点フォルダ → offices.name ────────────────────────────────────────────
//   ⚠ 名前の部分一致では引けない。「K姉」→「ＫＴ在宅サポートセンター」のように
//     フォルダ名と事業所名が字面で繋がらないものが多いため明示する。
//   ⚠ 「ケイ・ティ・サービス居宅介護支援事業所」は やわた と 五井 の**両方**を
//     担当する 1 事業所。どちらのフォルダにも出るのが正しい。
const AREA_OFFICES = {
  "K姉":       ["ＫＴ在宅サポートセンター", "ＫＴ姉崎ヘルパーステーション"],
  "いすみ":     ["リンクス居宅介護支援事業所いすみ", "リンクスヘルパーステーションいすみ"],
  "おゆみ野":   ["Ｈａｎａ居宅支援センターおゆみ野", "Ｈａｎａヘルパーステーションおゆみ野"],
  "さつきが丘": ["Ｈａｎａヘルパーステーションさつきが丘"],
  "ちはら台":   ["ケイ・ティ・グループ居宅支援センターちはら台", "ケイ・ティ・グループヘルパーステーションＨａｎａちはら台"],
  "やわた":     ["ケイ・ティ・サービス居宅介護支援事業所", "ＫＴやわたヘルパーステーション"],
  "花見川":     ["ケアプランＨａｎａ", "Ｈａｎａヘルパーステーション花見川", "Ｈａｎａ訪問入浴花見川", "Ｈａｎａ福祉用具花見川"],
  "五井":       ["ケイ・ティ・サービス居宅介護支援事業所", "ＫＴ五井ヘルパーステーション"],
  "高品":       ["Ｈａｎａ居宅支援センター高品", "Ｈａｎａヘルパーステーション高品", "千葉ムツミ福祉用具高品"],
  "山武":       ["リンクスヘルパーステーション山武"],
  "四街道":     ["Ｈａｎａ居宅支援センター四街道", "Ｈａｎａヘルパーステーション四街道"],
  "姉ム":       ["ムツミ居宅介護支援事業所", "ムツミヘルパーステーション", "ムツミ訪問入浴"],
  "市原":       ["市原ムツミヘルパーステーション"],
  "袖ケ浦":     ["袖ヶ浦ムツミ居宅支援センター", "袖ヶ浦ムツミヘルパーステーション"],
  "大網":       ["リンクス居宅介護支援事業所大網白里", "リンクスヘルパーステーション大網白里"],
  "中央":       ["Ｈａｎａヘルパーステーション中央"],
  "東郷":       ["リンクスヘルパーステーション東郷"],
  "茂原":       ["リンクス居宅介護支援事業所", "リンクスヘルパーステーション", "リンクス訪問入浴茂原"],
  "木更津":     ["木更津ムツミ居宅支援センター", "木更津ムツミヘルパーステーション"],
  "八千代":     ["ケアプランＨａｎａ八千代", "Ｈａｎａ八千代ヘルパーステーション"],
  "君津":       ["君津ムツミヘルパーステーション"],
  "船橋":       ["ケアプランＨａｎａ船橋", "Ｈａｎａ船橋ヘルパーステーション"],
};

// ── env ────────────────────────────────────────────────────────────────────
function loadEnv() {
  const e = {};
  const p = path.join(ROOT, ".env.local");
  if (!existsSync(p)) return e;
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("✗ .env.local に NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が無い");
  process.exit(1);
}
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

/** PostgREST は 1000 行で切られるので必ずページングする */
async function sbAll(pathAndQuery) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
      headers: { ...H, Range: `${from}-${from + 999}` },
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// ── CSV ────────────────────────────────────────────────────────────────────
/** Shift_JIS の CSV を 2 次元配列に。引用符内の , と "" に対応する */
function parseSjisCsv(file) {
  const s = new TextDecoder("shift_jis").decode(readFileSync(file));
  const rows = [];
  let cur = [], fld = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { fld += '"'; i++; } else q = false; }
      else fld += c;
    } else if (c === '"') q = true;
    else if (c === ",") { cur.push(fld); fld = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { cur.push(fld); rows.push(cur); cur = []; fld = ""; }
    else fld += c;
  }
  if (fld || cur.length) { cur.push(fld); rows.push(cur); }
  return rows;
}

/** ヘッダー名で列番号を引く。⚠ 列位置は出力設定で変わるので決め打ちしない */
function colIndex(header, ...names) {
  for (const n of names) {
    const i = header.findIndex((h) => h.trim() === n);
    if (i >= 0) return i;
  }
  return -1;
}

function findCsv(dir, prefix) {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find(
    (n) => n.startsWith(prefix) && /\.csv$/i.test(n) && !n.startsWith("_"));
  return f ? path.join(dir, f) : null;
}

// ── ダミー判定 (高品で実際に混ざっていたもの) ──────────────────────────────
const SYMBOL_HEAD = /^[★◆◎●■□▲△☆※・\s]/;
// ⚠ 「G$」だけで見ると LI ZHIQIANG のような実在の氏名を誤検出する。
//   高品にあったダミーは「きいろG」なので、**日本語 + G** に限定する。
const STAFF_WORDS = /(会議|ミーティング|研修|講習|私用|健康診断|中抜け|休憩|直行|直帰|待機|グループ)|[ぁ-んァ-ヶ一-龯]G$/;
const TEST_NAME = /^ケイテ[ィイ]|^テスト|^てすと/;
/** 1111111111 のようなゾロ目・連番は動作確認用 */
const TEST_NUMBER = /^(\d)\1{6,}$|^1234567890$/;

function classify(name, num) {
  if (SYMBOL_HEAD.test(name)) return "記号始まり";
  if (TEST_NAME.test(name)) return "テスト名";
  if (TEST_NUMBER.test(num)) return "テスト番号";
  if (STAFF_WORDS.test(name)) return "スタッフ用";
  return null;
}

function top(counter, n) {
  return [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const offices = await sbAll("offices?select=id,name,short_name,service_type");
  const assigns = await sbAll(
    "client_office_assignments?select=office_id,clients(name,birth_date)");

  // office_id → その事業所に割り当たっている利用者の 氏名(空白除去) の集合
  const byOffice = new Map();
  for (const a of assigns) {
    const nm = a.clients?.name;
    if (!nm) continue;
    if (!byOffice.has(a.office_id)) byOffice.set(a.office_id, new Set());
    byOffice.get(a.office_id).add(nm.replace(/[\s　]/g, ""));
  }

  const dirs = readdirSync(DATA).filter((d) => {
    if (NOT_OFFICE.has(d) || d.startsWith("_")) return false;
    if (ONLY && d !== ONLY) return false;
    return true;
  });

  const report = [];
  for (const area of dirs) {
    const dir = path.join(DATA, area);
    const basic = findCsv(dir, "基本情報");
    const hoken = findCsv(dir, "介護保険");

    if (!basic) { report.push({ area, note: "基本情報CSV なし" }); continue; }

    // ── 基本情報: 人数とダミー ──
    const rows = parseSjisCsv(basic);
    const bh = rows[0];
    const iNum = colIndex(bh, "利用者番号");
    const iName = colIndex(bh, "利用者名");
    if (iNum < 0 || iName < 0) {
      report.push({ area, note: `基本情報の列が読めない (利用者番号=${iNum} 利用者名=${iName})` });
      continue;
    }
    const people = [];
    const dummies = [];
    for (const r of rows.slice(1)) {
      const name = (r[iName] ?? "").trim();
      const num = (r[iNum] ?? "").trim();
      if (!name && !num) continue;
      const kind = classify(name, num);
      if (kind) dummies.push({ name, num, kind });
      else people.push({ name, num });
    }

    // ── 介護保険: 支援事業所の最頻値 ──
    let jigyosho = [];
    let hokensha = [];
    let hokenRows = 0;
    if (hoken) {
      const hr = parseSjisCsv(hoken);
      const hh = hr[0];
      const iJ = colIndex(hh, "支援事業所（正式名称）", "支援事業所");
      const iH = colIndex(hh, "保険者");
      const cj = new Map(), ch = new Map();
      for (const r of hr.slice(1)) {
        if (!r.some((c) => c && c.trim())) continue;
        hokenRows++;
        if (iJ >= 0) { const v = (r[iJ] ?? "").trim(); if (v) cj.set(v, (cj.get(v) ?? 0) + 1); }
        if (iH >= 0) { const v = (r[iH] ?? "").trim(); if (v) ch.set(v, (ch.get(v) ?? 0) + 1); }
      }
      jigyosho = top(cj, 3);
      hokensha = top(ch, 2);
    }

    // ── DB との重なり (事業所ごとに出す) ──
    //   まとめて 1 つの率にすると「居宅は揃っているが訪問介護が丸ごと無い」を
    //   見逃す。**事業所ごと**に「DB に居る人が CSV に載っているか」を見る。
    const csvNames = new Set(people.map((p) => p.name.replace(/[\s　]/g, "")));
    const wantNames = AREA_OFFICES[area];
    const perOffice = [];
    const missingAll = new Set();
    let unresolved = [];
    for (const nm of wantNames ?? []) {
      const o = offices.find((x) => x.name === nm);
      if (!o) { unresolved.push(nm); continue; }
      const names = [...(byOffice.get(o.id) ?? [])];
      const miss = names.filter((n) => !csvNames.has(n));
      // 福祉用具・訪問入浴・訪問看護 の利用者は 居宅/訪問介護 のマスタ出力には
      // 元々入らないことがあるので、判定からは外して参考表示にする
      const judged = o.service_type === "居宅介護支援" || o.service_type === "訪問介護";
      if (judged) for (const n of miss) missingAll.add(n);
      perOffice.push({
        id: o.id, name: o.name, type: o.service_type ?? "-", db: names.length,
        hit: names.length - miss.length, miss, judged,
      });
    }

    report.push({
      area, people: people.length, dummies, hokenRows, jigyosho, hokensha,
      perOffice, unresolved, missing: [...missingAll],
      noMap: !wantNames, csvNames,
    });
  }

  // ── 出力 ──
  console.log("=== 利用者データ CSV の中身検査 (READ ONLY) ===\n");
  const suspicious = [];
  for (const r of report.sort((a, b) => a.area.localeCompare(b.area, "ja"))) {
    if (r.note) { console.log(`■ ${r.area}\n   ${r.note}\n`); continue; }

    // 支援事業所の最頻値が何 % を占めるか (その拠点のものらしいかの目安)
    // ⚠ 訪問介護だけの拠点では他社のケアマネが担当するので低くて当然。
    //   判定には使わず、人が中身を見るための材料として出すだけ。
    const jShare = r.jigyosho[0] ? Math.round((r.jigyosho[0][1] / Math.max(1, r.hokenRows)) * 100) : 0;
    // ⚠ にするのは **本当に手を打つ必要があるものだけ**。
    //   ・ダミー (中抜け・担当者会議 等) は ほのぼのに常時あるので警告にしない
    //   ・「支援事業所が拠点名と不一致」は 訪問介護だけの拠点では正常なので
    //     警告にしない (他社のケアマネが担当するため)
    const flags = [];
    if (r.noMap) flags.push("拠点→事業所のマップ未登録");
    if (r.unresolved.length) flags.push(`offices に無い名前: ${r.unresolved.join(", ")}`);
    // 判定対象 (居宅・訪問介護) の事業所で 被覆 80% 未満 = その事業所ぶんの
    // マスタ出力が無い可能性が高い
    const low = r.perOffice.filter((o) => o.judged && o.db > 0 && o.hit / o.db < 0.8);
    for (const o of low) {
      flags.push(`${o.name} 被覆 ${Math.round((o.hit / o.db) * 100)}% (${o.db - o.hit} 名不足)`);
    }
    if (flags.length) suspicious.push({ area: r.area, low });

    console.log(`■ ${r.area}   ${flags.length ? "⚠ " + flags.join(" / ") : "✓"}`);
    console.log(`   基本情報 ${r.people} 名 (ダミー除く) / 介護保険 ${r.hokenRows} 行`);
    if (r.jigyosho.length) {
      console.log(`   支援事業所: ${r.jigyosho.map(([k, v]) => `${k} ${v}`).join(" | ")}  (最頻 ${jShare}%)`);
    }
    if (r.hokensha.length) console.log(`   保険者    : ${r.hokensha.map(([k, v]) => `${k} ${v}`).join(" | ")}`);
    for (const o of r.perOffice) {
      const pct = o.db ? Math.round((o.hit / o.db) * 100) : 0;
      const mark = !o.judged ? "  (参考)" : pct >= 80 ? "" : "  ←";
      console.log(`   ${o.type.padEnd(6, "　")} ${o.name}`);
      console.log(`       DB ${String(o.db).padStart(4)} 名 → CSV に ${String(o.hit).padStart(4)} 名 = ${String(pct).padStart(3)}%${mark}`);
    }
    if (r.dummies.length) {
      const s = r.dummies.slice(0, 6).map((d) => `${d.name}[${d.kind}]`).join(" / ");
      console.log(`   ダミー    : ${s}${r.dummies.length > 6 ? ` …他 ${r.dummies.length - 6}` : ""}`);
    }
    if (DETAIL && r.missing.length) {
      console.log(`   CSV に無い DB 利用者 ${r.missing.length} 名: ${r.missing.slice(0, 20).join(" / ")}`);
    }
    console.log();
  }

  console.log("─".repeat(70));

  // ── まとめ ────────────────────────────────────────────────────────────
  //   ⚠ 拠点ごとの率をそのまま足すと **二重計上**になる。
  //     「ケイ・ティ・サービス居宅介護支援事業所」は やわた と 五井 の両方を
  //     担当する 1 事業所で、利用者が 2 つのフォルダに分かれて出るため。
  //   そこで **全フォルダの CSV を合わせた集合**に対して、事業所ごとに
  //   「どの CSV にも載っていない利用者」を数える。これなら重複しない。
  const allCsvNames = new Set();
  for (const r of report) for (const n of r.csvNames ?? []) allCsvNames.add(n);

  // 全社まとめ出力 (利用登録＝無) にいるか。
  // ⚠ これは代用にならない。**制度で中身が偏っている**ことを 2026-09-01 に実測した:
  //     訪問介護の利用者 42〜95% が入る / 居宅の利用者 1〜10% しか入らない
  //   (34 事業所すべてで同じ傾向。理由はほのぼの側の運用なので断定しないが、
  //    「利用登録」が実質 居宅=ケアマネ 側の概念として使われているように見える)
  const zensha = new Set();
  {
    const f = findCsv(path.join(DATA, "全社_R8-08"), "基本情報");
    if (f) {
      const rr = parseSjisCsv(f);
      const j = colIndex(rr[0], "利用者名");
      if (j >= 0) {
        for (const x of rr.slice(1)) {
          const v = (x[j] ?? "").replace(/[\s　]/g, "");
          if (v) zensha.add(v);
        }
      }
    }
  }

  const seen = new Set();
  const short = [];
  for (const r of report) {
    for (const o of r.perOffice ?? []) {
      if (!o.judged || seen.has(o.id) || o.db === 0) continue;
      seen.add(o.id);
      const names = [...(byOffice.get(o.id) ?? [])];
      const miss = names.filter((n) => !allCsvNames.has(n));
      if (miss.length / names.length >= 0.2) {
        short.push({
          area: r.area, name: o.name, type: o.type, db: names.length, miss,
          inZensha: miss.filter((n) => zensha.has(n)).length,
        });
      }
    }
  }

  if (!short.length) { console.log("✓ どの事業所も 8 割以上が CSV に載っている"); return; }

  console.log(`⚠ **全フォルダの CSV を合わせても** 載っていない利用者がいる事業所
`);
  console.log("   事業所                                  制度      DB   未収載  全社CSVで拾える");
  let total = 0;
  let rescued = 0;
  for (const o of short.sort((a, b) => b.miss.length - a.miss.length)) {
    total += o.miss.length;
    rescued += o.inZensha;
    const pct = Math.round((o.inZensha / Math.max(1, o.miss.length)) * 100);
    console.log(`   ${o.name.padEnd(38, " ")}${o.type.padEnd(8, "　")}`
      + `${String(o.db).padStart(4)}  ${String(o.miss.length).padStart(5)}  `
      + `${String(o.inZensha).padStart(9)} = ${String(pct).padStart(3)}%`);
  }
  console.log(`
   実人数 ${total} 名 (事業所は重複排除済み)`);
  console.log(`   うち 全社_R8-08 で拾えるのは ${rescued} 名 `
    + `(${Math.round((rescued / Math.max(1, total)) * 100)}%) — **代用にならない**`);
  console.log(`
   ⚠ 全社_R8-08 は 利用登録＝無 で出したもので、中身が制度で偏っている。
     訪問介護の利用者は 42〜95% 入るが、**居宅の利用者は 1〜10% しか入らない**。`);
  console.log(`
   ⚠ ほのぼのの利用者マスタ CSV は **事業所エントリごと**に出る。
     1 拠点に 居宅 と ヘルパーステーション があると、片方だけ出したときに
     もう片方の利用者が丸ごと落ちる。**拠点の数ではなく事業所の数だけ出す**こと。
     (MEISAI を「エントリごとに出す」のと同じ理由)

   ⚠ これは「データが消えている」という意味ではない。DB には居る
     (実績や伝送から入っている)。**マスタ CSV での同期ができない**という意味。

   --detail を付けると氏名が出る。`);
  if (DETAIL) {
    for (const o of short) {
      console.log(`
   ── ${o.name} (${o.miss.length} 名)`);
      console.log(`      ${o.miss.slice(0, 40).join(" / ")}${o.miss.length > 40 ? " …" : ""}`);
    }
  }
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
