// ============================================================================
// 居宅の利用票 PDF と当方の利用者を突合して、取込漏れを洗い出す (READ ONLY)。
//
//   利用票 = 請求と独立した月次の担当者名簿。請求データ由来の当方と突き合わせると
//   「提供したが請求しなかった人 (月遅れ)」が浮く。
//
//   MONTH=2026-06 node migrations/check_riyouhyou_coverage.mjs
//   AREA=四街道 を付けるとその拠点だけ
//
//   ⚠ DB は一切書き換えない。何が足りないかを出すだけ。
//     実際の投入は内容を確認してから別スクリプトで行う。
//
// ── 置き場所 ──────────────────────────────────────────────────────────
//   利用者データ/<拠点>/<提供年月>/居宅/*.pdf     (提供年月であって出力月ではない)
//
// ── 事業所はフォルダ名でなく PDF の中身で決める ────────────────────────
//   「四街道利用票別表全CM.pdf」の中身が KT在宅 だった事故がある (2026-08-20)。
//   ファイル名・フォルダ名は当てにせず、印字された事業所名で振り分ける。
//
// ── ケアマネ単位で出る ────────────────────────────────────────────────
//   利用票は担当ケアマネごとに出力する。1 事業所で 3〜5 ファイルになることがある。
//   ケアマネを 1 人出し忘れるとその担当分が丸ごと欠けるので、担当者名も数える。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRiyouhyouPages, findRiyouhyouPdfs, normRiyouName, normOfficeName,
} from "./_riyouhyou_pdf.mjs";

const MONTH = process.env.MONTH || "2026-06";
const AREA = process.env.AREA || "";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
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

/** PDF のテキスト抽出は PyMuPDF に任せる (Node に PDF パーサを足さない) */
function extractPages(pdfPath) {
  const py = `
import fitz, json, sys
d = fitz.open(sys.argv[1])
texts, words = [], []
for i in range(d.page_count):
    p = d[i]
    texts.append(p.get_text())
    words.append([{"x": w[0], "y": w[1], "t": w[4]} for w in p.get_text("words")])
print(json.dumps({"texts": texts, "words": words}, ensure_ascii=False))
`;
  // ⚠ Windows の python は既定 cp932 出力。UTF-8 を明示しないと氏名が壊れる
  const raw = execFileSync("python", ["-c", py, pdfPath], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw);
}

/** 担当ケアマネ名 (出し忘れ検出用) */
function pickCareManagers(texts) {
  const s = new Set();
  for (const t of texts) {
    const m = /([一-龥ぁ-んァ-ヶー]{1,6}\s+[一-龥ぁ-んァ-ヶー]{1,6})\s*\(専門員番号/.exec(t);
    if (m) s.add(m[1].replace(/\s+/g, " "));
  }
  return [...s];
}

async function main() {
  console.log(`=== 居宅 利用票 と当方の突合 (${MONTH}) ===\n`);

  const baseDir = path.join(KAIGO, "利用者データ");
  const areas = AREA ? [AREA] : readdirSync(baseDir);

  const { data: offices, error } = await sb.from("offices").select("id, name, service_type");
  if (error) { console.error(`✗ 事業所取得失敗: ${error.message}`); process.exit(1); }
  const kyotakuOffices = (offices ?? []).filter((o) => o.service_type === "居宅介護支援");
  const byOfficeName = new Map(kyotakuOffices.map((o) => [normOfficeName(o.name), o]));

  /**
   * PDF の事業所名から offices を引く。
   * PDF 側には法人名や略称が前置されることがあり完全一致しない:
   *   「株式会社ｻｰﾋﾞｽﾜﾝ　ﾑﾂﾐ居宅介護支援事業所」→ ムツミ居宅介護支援事業所
   *   「ＫＴ袖ヶ浦ムツミ居宅支援センター」        → 袖ヶ浦ムツミ居宅支援センター
   * 完全一致 → DB 名が PDF 名の末尾に一致 (最長優先) の順で当てる。
   */
  const resolveOffice = (printed) => {
    const key = normOfficeName(printed);
    const exact = byOfficeName.get(key);
    if (exact) return exact;
    const tail = kyotakuOffices
      .filter((o) => key.endsWith(normOfficeName(o.name)))
      .sort((a, b) => normOfficeName(b.name).length - normOfficeName(a.name).length);
    return tail[0] ?? null;
  };

  // PDF を全部読んで **印字された事業所名**でまとめる
  const groups = new Map(); // normOfficeName -> { label, rows[], cms:Set, files[] }
  for (const area of areas) {
    const areaDir = path.join(baseDir, area);
    if (!existsSync(areaDir)) continue;
    const dirs = [];
    const findKyotaku = (d, depth) => {
      if (depth > 3) return;
      let ents;
      try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const p2 = path.join(d, e.name);
        if (e.name.includes("居宅")) dirs.push(p2);
        else findKyotaku(p2, depth + 1);
      }
    };
    findKyotaku(areaDir, 0);

    for (const d of dirs) {
      const r = findRiyouhyouPdfs(d);
      if (r.empty.length) {
        // 0 バイト = 出力失敗。担当ケアマネ 1 人分が丸ごと欠けるので必ず知らせる
        console.log(`⚠ ${area}: 0 バイトの PDF が ${r.empty.length} 件 — 出力し直してください`);
        for (const e of r.empty) console.log(`     ${path.basename(e)}`);
      }
      for (const f of r.files) {
        const ex = extractPages(f);
        const all = parseRiyouhyouPages(ex.texts, ex.words);
        // 提供年月が対象月の行だけ採る (月をまたいだ PDF が混ざっても事故らない)
        const parsed = all.filter((x) => !x.month || x.month === MONTH);
        if (!parsed.length) {
          console.log(`  ${path.basename(f)}: ${MONTH} の行が無い (中身は ${all[0]?.month ?? "不明"})`);
          continue;
        }
        const key = normOfficeName(parsed[0].officeName ?? "");
        if (!groups.has(key)) {
          groups.set(key, { label: parsed[0].officeName ?? "(事業所名不明)", rows: [], cms: new Set(), files: [] });
        }
        const g = groups.get(key);
        g.rows.push(...parsed);
        for (const cm of pickCareManagers(ex.texts)) g.cms.add(cm);
        g.files.push(path.relative(baseDir, f));
        // フォルダの拠点名と中身の事業所がずれていたら知らせる (誤配置の検出)
        console.log(`  ${path.relative(baseDir, f)}  → ${parsed.length} 名 / ${parsed[0].officeName}`);
      }
    }
  }
  console.log("");

  let totalMissing = 0;
  for (const [key, g] of groups) {
    const off = resolveOffice(g.label);
    console.log(`── ${g.label}${off && normOfficeName(off.name) !== key ? ` → ${off.name}` : ""} ──`);
    console.log(`   担当ケアマネ ${g.cms.size} 名: ${[...g.cms].join(" / ")}`);
    if (!off) {
      console.log(`   ✗ offices に一致する居宅介護支援事業所が無い — 突合をスキップ\n`);
      continue;
    }
    // 同一人物がケアマネ跨ぎで重複しないよう nameKey で畳む
    const byKey = new Map(g.rows.map((r) => [r.nameKey, r]));

    const asg = await sb
      .from("client_office_assignments").select("client_id").eq("office_id", off.id);
    if (asg.error) { console.error(`✗ ${asg.error.message}`); process.exit(1); }
    const ids = [...new Set((asg.data ?? []).map((a) => a.client_id))];
    const mine = new Map();
    for (let i = 0; i < ids.length; i += 80) {
      const { data, error: e2 } = await sb
        .from("clients").select("id, name").in("id", ids.slice(i, i + 80));
      if (e2) { console.error(`✗ ${e2.message}`); process.exit(1); }
      for (const c of data ?? []) mine.set(normRiyouName(c.name), c);
    }

    const missing = [...byKey.values()].filter((r) => !mine.has(r.nameKey));
    const extra = [...mine.keys()].filter((k) => !byKey.has(k));
    totalMissing += missing.length;
    console.log(`   利用票 ${byKey.size} 名 / 当方 ${mine.size} 名`);
    if (missing.length) {
      console.log(`   ★ 利用票にいるが当方に無い ${missing.length} 名 (取込漏れ / 月遅れ):`);
      for (const m of missing) {
        // 氏名でなく **保険者番号 + 被保険者番号**で DB 全体を引き直す。
        //   ・別事業所には居る → 事業所割当が抜けているだけ (対処が違う)
        //   ・別人の名前で出る → 被保番の取り違え。請求が別人に付くので最優先
        //
        // ⚠ 被保番だけで引いてはいけない。被保番は **保険者ごとに一意**なので、
        //   保険者が違えば同じ番号の別人が普通に居る。被保番だけで引いて
        //   「野口照恵の番号が伊東八重子に付いている」と誤検出した (2026-08-20)。
        let note = "";
        if (m.insured && m.insurer) {
          const { data: ins } = await sb
            .from("client_insurance_records")
            .select("client_id, clients(name)")
            .eq("insurer_number", m.insurer)
            .eq("insured_number", m.insured);
          const names = [...new Set((ins ?? []).map((r) => r.clients?.name).filter(Boolean))];
          if (names.length) {
            note = names.some((n) => normRiyouName(n) === m.nameKey)
              ? "  ← DB に居る (この事業所への割当が無いだけ)"
              : `  ⚠ 同じ被保番が別人 [${names.join(" / ")}]`;
          }
        }
        console.log(`       ${m.name}  ${m.careLevel ?? "要介護度不明"}  ` +
          `保険者${m.insurer ?? "?"} 被保番${m.insured ?? "?"}${note}`);
      }
    }
    if (extra.length) {
      console.log(`   ・当方にいるが利用票に無い ${extra.length} 名 (退所・利用なし 等):`);
      for (const e of extra) console.log(`       ${e}`);
    }
    console.log("");
  }
  console.log(`=== 取込漏れ 合計 ${totalMissing} 名 ===`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
