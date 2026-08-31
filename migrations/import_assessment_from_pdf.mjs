// ============================================================================
// ほのぼの「生活アセスメント (1)〜(5)」PDF を kaigo_assessments に取り込む
//
// ── なぜ PDF か ────────────────────────────────────────────────────────
//   アセスメントは ほのぼの が CSV で出せない (ケアマネ → CSV タブは計画書系
//   の 4 つだけ)。印刷 → CubePDF で出す。出し方は docs/HONOBONO_PDF_EXPORT.md。
//
//   node migrations/import_assessment_from_pdf.mjs --pdf <file...> --office 高品
//   node migrations/import_assessment_from_pdf.mjs --pdf <file...> --office 高品 --execute
//
// ── 何を入れるか ────────────────────────────────────────────────────────
//   1 人につき 4 帳票が別々の PDF で出るので、**氏名 + 作成日で 1 件にまとめて**
//   kaigo_assessments の 1 行にする。form_data は画面が使う構造に合わせる:
//
//     form_data.face_sheet.life_history        これまでの生活の経過
//     form_data.face_sheet.consultation_user   相談内容 (本人)
//     form_data.face_sheet.consultation_family 相談内容 (介護者・家族)
//     form_data.face_sheet.referral_route      相談経路
//     form_data.housing.notes                  周辺環境・立地環境の特記
//     form_data.health.medical_history         既往歴・現症
//     form_data.health.special_notes           特記事項
//     form_data.health.life_considerations     生活上配慮すべき課題
//     form_data.family_support.*               家族状況・インフォーマル支援
//
//   ⚠ 選択肢のチェックは項目名との対応づけが帳票ごとに違うので、いまは
//     **form_data._honobono.checks に生のまま**入れる。画面から見えるのは
//     記述式のほうなので、まずそちらを確実に入れる。捨てはしない。
//
// ⚠ 利用者の同定は **事業所 + 氏名**。PDF に利用者番号が無いので、
//   1 回の実行に複数拠点を混ぜてはいけない。同姓同名は取り込まず一覧に出す。
// ⚠ 同じ人・同じ作成日が既にあれば **UPDATE せず飛ばす** (人が直した内容を
//   上書きしないため)。入れ直したいときは先に消すこと。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const argsAfter = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith("--"); j++) out.push(process.argv[j]);
  return out;
};
// ⚠ ファイル数が増えると `--pdf a.pdf b.pdf ...` はコマンドライン長の上限に
//   当たる ("Argument list too long")。--dir でフォルダを渡せるようにする。
const DIR = argsAfter("--dir")[0] ?? null;
const PDFS = DIR
  ? readdirSync(DIR).filter((f) => f.startsWith("生活アセスメント") && f.toLowerCase().endsWith(".pdf"))
      .map((f) => path.join(DIR, f))
  : argsAfter("--pdf");
const OFFICE_NAME = argsAfter("--office")[0] ?? null;
const TENANT = "kt-group";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const normName = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");

/** 令和 8年 6月20日 → 2026-06-20 */
function jaDate(s) {
  const m = /令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/.exec(s ?? "");
  if (!m) return null;
  const y = 2018 + Number(m[1]);
  return `${y}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

async function fetchAll(table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order("id").range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

function parsePdfs(files) {
  const script = path.join(ROOT, "migrations", "_parse_seikatsu_assessment_pdf.py");
  const CHUNK = 60;   // 引数が長すぎるとコマンドラインが溢れる
  const all = [];
  for (let i = 0; i < files.length; i += CHUNK) {
    const raw = execFileSync("python", [script, ...files.slice(i, i + CHUNK)], {
      encoding: "utf8", maxBuffer: 1 << 28,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    all.push(...JSON.parse(raw));
  }
  return all;
}

/** 本文ブロックのうち一番長いものを返す (枠内の折り返しは結合済み) */
const longest = (blocks, pred = () => true) => {
  const c = blocks.filter((b) => pred(b)).sort((a, b) => b.text.length - a.text.length);
  return c.length ? c[0].text : null;
};

/**
 * 帳票 1 枚ぶんを form_data の断片にする。
 * ⚠ 断定できない項目は入れない。空欄を空文字で埋めると「入力済み」に見える。
 */
function fragmentOf(page) {
  const B = page.blocks ?? [];
  const checks = (page.checks ?? []).map((c) => c.value);
  if (page.kind === "face_sheet") {
    // 生活史は右カラム (x≈309)。相談内容は **左端カラム (x≈49)**。
    // ⚠ x<200 で拾うと 住所(x≈143) や 相談経路(x≈114) を巻き込む。実際に踏んだ。
    const history = longest(B, (b) => b.x > 280 && b.x < 400 && b.text.length > 30);
    const left = B.filter((b) => b.x < 60 && b.text.length > 20)
      .sort((a, b) => b.y - a.y);
    // 交互に描かれた 2 枠。y が大きいほうが「介護者・家族」、小さいほうが「本人」
    // (阿部代始子の計画書(1) の記載と突き合わせて確認済み 2026-08-31)
    const family = left[0]?.text ?? null;
    const user = left[1]?.text ?? null;
    // 相談経路 (紹介者) は x≈114 の 1 行
    const route = longest(B, (b) => b.x > 100 && b.x < 140 && b.text.length > 10);
    return {
      face_sheet: {
        ...(history ? { life_history: history } : {}),
        ...(user ? { consultation_user: user } : {}),
        ...(family ? { consultation_family: family } : {}),
        ...(route ? { referral_route: route } : {}),
      },
      _checks_face: checks,
      // アセスメント実施日は右下 (x>460, y<150) の日付ブロックの最終行。
      // ⚠ 右上 (y>800) は **印刷日** なので使ってはいけない。
      _date: (() => {
        const b = B.filter((b) => b.x > 460 && b.y < 150)
          .sort((a, b) => a.y - b.y)[0];
        if (!b) return null;
        const lines = b.text.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const d = jaDate(lines[i]);
          if (d) return d;
        }
        return null;
      })(),
    };
  }
  if (page.kind === "family_service") {
    const note = longest(B, (b) => b.text.length > 25);
    return {
      family_support: { ...(note ? { family_care_situation: note } : {}) },
      _checks_family: checks,
    };
  }
  if (page.kind === "housing") {
    const note = longest(B, (b) => b.x < 200 && b.text.length > 25);
    return {
      housing: { ...(note ? { notes: note } : {}) },
      _checks_housing: checks,
    };
  }
  if (page.kind === "health") {
    const texts = B.filter((b) => b.text.length > 25).sort((a, b) => b.y - a.y);
    return {
      health: {
        ...(texts[0] ? { medical_history: texts[0].text } : {}),
        ...(texts[1] ? { special_notes: texts[1].text } : {}),
        ...(texts[2] ? { life_considerations: texts[2].text } : {}),
      },
      _checks_health: checks,
    };
  }
  return {};
}

function mergeDeep(a, b) {
  for (const k of Object.keys(b)) {
    if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) {
      a[k] = mergeDeep(a[k] ?? {}, b[k]);
    } else if (Array.isArray(b[k])) {
      a[k] = [...(a[k] ?? []), ...b[k]];
    } else if (b[k] != null && b[k] !== "") {
      a[k] = b[k];
    }
  }
  return a;
}

async function main() {
  if (!PDFS.length) {
    console.error("使い方: --dir <フォルダ> | --pdf <file...> [--office <名前>] [--execute]");
    process.exit(1);
  }
  for (const f of PDFS) if (!existsSync(f)) { console.error(`✗ ${f} が無い`); process.exit(1); }
  console.log(`=== 生活アセスメント PDF 取込 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);
  console.log(`  PDF ${PDFS.length} ファイル`);

  const files = parsePdfs(PDFS);
  const bad = files.filter((f) => f.error);
  for (const f of bad) console.error(`  ✗ 読めない: ${f.file} — ${f.error}`);

  // 氏名でまとめる。1 人が 4 帳票ぶん (+ 履歴が複数ある人は同名で複数枚)
  const byName = new Map();
  let emptyPages = 0;
  for (const f of files) {
    for (const p of f.pages ?? []) {
      if (!p.name || p.kind === "unknown") { emptyPages++; continue; }
      const key = normName(p.name);
      if (!byName.has(key)) byName.set(key, { name: p.name, pages: [] });
      byName.get(key).pages.push(p);
    }
  }
  console.log(`  解析できたページ ${files.reduce((s, f) => s + (f.pages?.length ?? 0), 0) - emptyPages} / 空・判別不能 ${emptyPages}`);
  console.log(`  利用者 ${byName.size} 名`);

  // 事業所を絞って clients に引き当てる
  let clients = [];
  if (OFFICE_NAME) {
    const { data: offs, error } = await sb.from("offices")
      .select("id, name").eq("tenant_id", TENANT)
      .eq("service_type", "居宅介護支援").ilike("name", `%${OFFICE_NAME}%`);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    if (!offs?.length) { console.error(`✗ 居宅事業所「${OFFICE_NAME}」が offices に無い`); process.exit(1); }
    console.log(`  事業所: ${offs.map((o) => o.name).join(" / ")}`);
    const asg = await fetchAll("client_office_assignments", "client_id",
      (q) => q.in("office_id", offs.map((o) => o.id)));
    const ids = [...new Set(asg.map((a) => a.client_id))];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await sb.from("clients").select("id, name").in("id", ids.slice(i, i + 200));
      clients.push(...(data ?? []));
    }
  } else {
    clients = await fetchAll("clients", "id, name", (q) => q.eq("tenant_id", TENANT));
  }
  const nameIdx = new Map();
  for (const c of clients) {
    const k = normName(c.name);
    if (!nameIdx.has(k)) nameIdx.set(k, []);
    nameIdx.get(k).push(c);
  }

  const problems = [];
  const resolved = [];
  for (const [key, v] of byName) {
    const hits = nameIdx.get(key) ?? [];
    if (hits.length === 1) resolved.push({ ...v, clientId: hits[0].id });
    else problems.push(`${v.name}: 当方の利用者が ${hits.length} 名`);
  }
  console.log(`  引き当て ${resolved.length} / ${byName.size} 名`);
  if (problems.length) {
    console.log(`\n  -- 引き当てられない ${problems.length} 名 --`);
    for (const q of problems) console.log(`     ${q}`);
  }

  // 既にあるアセスメント (同じ人・同じ実施日) は入れない
  const existing = new Set();
  {
    const ids = resolved.map((r) => r.clientId);
    for (let i = 0; i < ids.length; i += 100) {
      const rows = await fetchAll("kaigo_assessments", "user_id, assessment_date",
        (q) => q.in("user_id", ids.slice(i, i + 100)));
      for (const r of rows) existing.add(`${r.user_id}|${r.assessment_date}`);
    }
  }

  const rows = [];
  const noDate = [];   // ⚠ ここを黙って捨てると「入れた件数」が減った理由が分からなくなる
  let dup = 0, noContent = 0;
  for (const r of resolved) {
    const form = {};
    const checks = { face: [], family: [], housing: [], health: [] };
    let date = null;
    for (const p of r.pages) {
      const frag = fragmentOf(p);
      for (const [k, arr] of [["_checks_face", "face"], ["_checks_family", "family"],
                              ["_checks_housing", "housing"], ["_checks_health", "health"]]) {
        if (frag[k]) { checks[arr].push(...frag[k]); delete frag[k]; }
      }
      // アセスメント実施日はフェースシートからしか取らない。
      // ⚠ ページ中の日付を「最大」で拾うと **右上の印刷日** を掴む。実際に踏んだ。
      if (frag._date) { if (!date || frag._date > date) date = frag._date; }
      delete frag._date;
      mergeDeep(form, frag);
    }
    const hasText = JSON.stringify(form).length > 40;
    if (!hasText) { noContent++; continue; }
    // ⚠ 実施日が拾えないと画面の並びが壊れるので、拾えたものだけ入れる
    if (!date) { noDate.push(r.name); continue; }
    if (existing.has(`${r.clientId}|${date}`)) { dup++; continue; }

    form._honobono = {
      source: "生活アセスメント PDF (ほのぼの)",
      imported_at: new Date().toISOString().slice(0, 10),
      checks,
    };
    rows.push({
      tenant_id: TENANT,
      user_id: r.clientId,
      assessment_date: date,
      status: "completed",
      assessment_type: "kaigo",
      form_data: form,
    });
  }

  console.log(`\n  入れる ${rows.length} 件 / 既にある ${dup} 件 / 中身が空 ${noContent} 件`);
  if (noDate.length) {
    console.log(`  ⚠ アセスメント実施日が読めず入れられない ${noDate.length} 名`);
    console.log(`     ${noDate.slice(0, 25).join(" / ")}${noDate.length > 25 ? " …" : ""}`);
    console.log(`     (フェースシートが出ていない人。生活(2)〜(5) だけでは日付が特定できない)`);
  }
  if (rows.length) {
    const r = rows[0];
    console.log(`\n  例) ${r.assessment_date}`);
    const fs2 = r.form_data.face_sheet ?? {};
    for (const [k, v] of Object.entries(fs2)) {
      console.log(`     ${k}: ${String(v).replace(/\n/g, " ").slice(0, 70)}`);
    }
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }
  if (!rows.length) return;

  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb.from("kaigo_assessments").insert(rows.slice(i, i + CHUNK));
    if (error) { console.error(`✗ 保存失敗: ${error.message}`); process.exit(1); }
    console.log(`  ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }
  console.log(`\n✓ ${rows.length} 件を保存しました`);
}

main();
