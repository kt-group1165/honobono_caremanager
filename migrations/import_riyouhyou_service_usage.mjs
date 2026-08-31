// ============================================================================
// 居宅の「サービス利用票・提供票 (第6表)」PDF → 帳票 service-usage に取り込む。
//
//   MONTH=2026-06 AREA=四街道 node migrations/import_riyouhyou_service_usage.mjs            # DRY RUN
//   MONTH=2026-06 AREA=四街道 node migrations/import_riyouhyou_service_usage.mjs --execute
//   MONTH=2026-06 node migrations/import_riyouhyou_service_usage.mjs                        # 全拠点 DRY RUN
//
//   --force  … 人が手を入れた帳票も上書きする (既定は触らない)
//   --allow-name-mismatch … 番号は一致だが氏名が別人の分も取り込む (既定は skip)
//   --limit N… 先頭 N 名だけ (動作確認用)
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   居宅の利用票・提供票は **ほのぼのが CSV で出せない** (ケアマネ→CSV タブは
//   計画書(1)/(2)/A様式 の 4 つだけ)。そのため当システムには日別の予定・実績が
//   1 件も入っておらず、画面を開くとサービス行だけ出て日別が全部空になる。
//   実体は PDF にしかないので、そこから起こす。
//
// ── 置き場所 ────────────────────────────────────────────────────────────
//   利用者データ/<拠点>/<YYYYMM>/居宅/*.pdf     (提供年月であって出力月ではない)
//   ⚠ ページに印字された提供年月が MONTH と違うページは取り込まない (出力月ズレ対策)。
//
// ── 利用者の引き当て ────────────────────────────────────────────────────
//   **(保険者番号, 被保険者番号) の対**で引く。被保険者番号は保険者の中でしか
//   一意でないため、番号だけで引くと別人に当たる (実例 28 件)。
//   氏名は表記ゆれが多いので判定には使わず、食い違ったら警告だけ出す。
//
// ── 既存帳票の扱い ──────────────────────────────────────────────────────
//   画面を開くと空の器が自動生成される。器は上書きしてよいが、**人が入力した
//   予定・実績は壊さない**。
//     ・この script が作ったもの        → 上書き
//     ・予定/実績が 1 つも入っていない  → 上書き (= 自動生成の空の器)
//     ・それ以外                        → skip (--force で上書き)
//
// ── 取り込めないもの (承知の上) ────────────────────────────────────────
//   ・単位数 … 利用票に印字されない (第7表 別表にある)。単位列は空のまま
//   ・1 日 2 回以上 … content.services[].planned は boolean なので画面上は "1"。
//     回数は planned_counts / actual_counts に別途持たせて捨てないでおく
//   ・印刷は 1 ページ 13 行で改ページする (reports-content.tsx)。データは全行入れる。
//     以前は 9 行固定で 10 行目以降が黙って消えていた (2026-08-31 に是正済)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRiyouhyouPdfs, parseRiyouhyouPages, normRiyouName, LIMIT_TO_CARE_LEVEL } from "./_riyouhyou_pdf.mjs";
import { extractGrid, pickIdentity, toBoolean31, toCount31 } from "./_riyouhyou_grid.mjs";

const EXECUTE = process.argv.includes("--execute");
const FORCE = process.argv.includes("--force");
// 番号一致・氏名不一致を承知で取り込む (既定は skip。他人の帳票を書き込む事故を防ぐ)
const ALLOW_NAME_MISMATCH = process.argv.includes("--allow-name-mismatch");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) : 0;
})();
const MONTH = process.env.MONTH || "2026-06";
const AREA = process.env.AREA || "";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const YYYYMM = MONTH.replace("-", "");
const MARKER = `riyouhyou-pdf-${MONTH}`;

if (!/^\d{4}-\d{2}$/.test(MONTH)) {
  console.error("MONTH は YYYY-MM で指定する (例 MONTH=2026-06)");
  process.exit(1);
}

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

/** 要介護度 → 区分支給限度基準額 (LIMIT_TO_CARE_LEVEL の逆引き) */
const CARE_LEVEL_TO_LIMIT = Object.fromEntries(
  Object.entries(LIMIT_TO_CARE_LEVEL).map(([k, v]) => [v, Number(k)]),
);

/** PDF のテキスト・語 (座標つき) を PyMuPDF で取り出す */
function extractPages(pdfPath) {
  const py = [
    "import fitz, json, sys",
    "d = fitz.open(sys.argv[1])",
    "texts, words = [], []",
    "for i in range(d.page_count):",
    "    p = d[i]",
    "    texts.append(p.get_text())",
    '    words.append([{"x": w[0], "y": w[1], "t": w[4]} for w in p.get_text("words")])',
    'print(json.dumps({"texts": texts, "words": words}, ensure_ascii=False))',
  ].join("\n");
  // ⚠ Windows の python は既定 cp932 出力。UTF-8 を明示しないと氏名が壊れる
  const raw = execFileSync("python", ["-c", py, pdfPath], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw);
}

/** PostgREST の 1000 行上限を超えて全件取る */
async function fetchAll(build) {
  const out = [];
  const STEP = 1000;
  for (let from = 0; ; from += STEP) {
    const { data, error } = await build().range(from, from + STEP - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < STEP) break;
  }
  return out;
}

const fmtReiwa = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `令和${y - 2018}年${m}月${d ?? 1}日`;
};

/** 対象拠点のフォルダを決める */
function targetAreas() {
  const base = path.join(KAIGO, "利用者データ");
  const areas = AREA ? [AREA] : readdirSync(base);
  return areas
    .map((a) => ({ area: a, dir: path.join(base, a, YYYYMM, "居宅") }))
    .filter((x) => existsSync(x.dir));
}

// ── 1. PDF を読む ───────────────────────────────────────────────────────────
/**
 * @returns Map<string, {name, insurer, insured, careLevel, officeName, rows, sources}>
 *          キーは 保険者番号|被保険者番号
 */
function readArea(dir) {
  const people = new Map();
  const skipped = { monthMismatch: 0, notRiyouhyou: 0 };
  const dropped = [];        // 取りこぼしたページは黙って捨てず必ず出す
  const { files, empty } = findRiyouhyouPdfs(dir);
  for (const f of empty) console.log(`  ⚠ 0 バイト (出力失敗): ${path.basename(f)}`);

  for (const f of files) {
    const { texts, words } = extractPages(f);
    for (let i = 0; i < words.length; i++) {
      const grid = extractGrid(words[i]);
      if (!grid) { skipped.notRiyouhyou++; continue; }   // 別表など日付グリッドが無いページ

      // 氏名・番号は座標で読む (正規表現版は氏名の区別記号・英字始まりの番号で落ちる)
      const id = pickIdentity(words[i]);
      // 提供年月・要介護度・事業所名は既存パーサに任せる (本文テキストから拾うもの)
      const who = parseRiyouhyouPages([texts[i]], [words[i]])[0] ?? null;

      const month = who?.month ?? null;
      if (month && month !== MONTH) { skipped.monthMismatch++; continue; }

      const insurer = id.insurer ?? who?.insurer ?? null;
      const insured = id.insured ?? who?.insured ?? null;
      const name = id.name ?? who?.name ?? null;
      if (!insurer || !insured) {
        dropped.push(`${path.basename(f)} p${i + 1}  氏名「${name ?? "?"}」 保険者=${insurer ?? "読めず"} 被保番=${insured ?? "読めず"}  行数 ${grid.rows.length}`);
        continue;
      }

      const key = `${insurer}|${insured}`;
      if (!people.has(key)) {
        people.set(key, {
          name: name ?? "", nameKey: name ? normRiyouName(name) : "",
          nameSuffix: id.nameSuffix ?? null,
          insurer, insured,
          careLevel: who?.careLevel ?? null, officeName: who?.officeName ?? null,
          rows: [], sources: [],
        });
      }
      const p = people.get(key);
      p.rows.push(...grid.rows);                       // 2 ページ目以降は行を継ぎ足す
      p.sources.push(`${path.basename(f)}#p${i + 1}`);
    }
  }
  return { people, skipped, dropped, fileCount: files.length };
}

// ── 2. 利用者を引き当てる ──────────────────────────────────────────────────
async function resolveClients(people) {
  const insureds = [...new Set([...people.values()].map((p) => p.insured))];
  const CH = 200;

  const recs = [];
  for (let i = 0; i < insureds.length; i += CH) {
    const chunk = insureds.slice(i, i + CH);
    recs.push(...await fetchAll(() => sb
      .from("client_insurance_records")
      .select("client_id, insurer_number, insured_number")
      .in("insured_number", chunk)));
  }
  const byPair = new Map();
  for (const r of recs) {
    if (!r.insurer_number || !r.insured_number) continue;
    const k = `${r.insurer_number}|${r.insured_number}`;
    if (!byPair.has(k)) byPair.set(k, new Set());
    byPair.get(k).add(r.client_id);
  }

  // clients 側にも番号があるので保険で見る
  const cli = [];
  for (let i = 0; i < insureds.length; i += CH) {
    const chunk = insureds.slice(i, i + CH);
    cli.push(...await fetchAll(() => sb
      .from("clients")
      .select("id, name, insurer_number, insured_number, deleted_at")
      .in("insured_number", chunk)));
  }
  for (const c of cli) {
    if (c.deleted_at) continue;
    const k = `${c.insurer_number}|${c.insured_number}`;
    if (!byPair.has(k)) byPair.set(k, new Set());
    byPair.get(k).add(c.id);
  }

  // 氏名は全 client_id ぶん要る (認定側でしか当たらない人もいる)
  const ids = [...new Set([...byPair.values()].flatMap((s) => [...s]))];
  const nameById = new Map();
  for (let i = 0; i < ids.length; i += CH) {
    const chunk = ids.slice(i, i + CH);
    const rows = await fetchAll(() => sb.from("clients").select("id, name, deleted_at").in("id", chunk));
    for (const c of rows) nameById.set(c.id, { name: c.name, deleted: !!c.deleted_at });
  }
  return { byPair, nameById };
}

/** 対象月に有効な認定 (帳票ヘッダー用) */
async function fetchCerts(clientIds) {
  const last = new Date(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0);
  const monthEnd = `${MONTH}-${String(last.getDate()).padStart(2, "0")}`;
  const out = new Map();
  const CH = 150;
  for (let i = 0; i < clientIds.length; i += CH) {
    const chunk = clientIds.slice(i, i + CH);
    const rows = await fetchAll(() => sb
      .from("client_insurance_records")
      .select("client_id, insurer_number, insured_number, insurer_name, care_level, service_limit_amount, certification_start_date, certification_end_date")
      .in("client_id", chunk)
      .lte("certification_start_date", monthEnd)
      .order("certification_start_date", { ascending: false }));
    for (const r of rows) {
      if (r.certification_end_date && r.certification_end_date < `${MONTH}-01`) continue;
      if (!out.has(r.client_id)) out.set(r.client_id, r);   // 開始日の新しい順なので先勝ち
    }
  }
  return out;
}

// ── 3. content を組む ──────────────────────────────────────────────────────
function buildServices(rows) {
  return rows.map((r) => {
    const svc = {
      time: r.time,
      content: r.content,
      provider: r.provider,
      planned: toBoolean31(r.planned),
      actual: toBoolean31(r.actual),
      // 1 日 2 回以上を boolean で捨てないための保持先 (画面は未使用)
      planned_counts: toCount31(r.planned),
      actual_counts: toCount31(r.actual),
    };
    if (r.equipment_name) svc.equipment_name = r.equipment_name;
    if (r.tais_code) svc.tais_code = r.tais_code;
    return svc;
  });
}

function buildContent(prev, person, cert) {
  const careLevel = cert?.care_level ?? person.careLevel ?? "";
  const limit = cert?.service_limit_amount ?? CARE_LEVEL_TO_LIMIT[careLevel] ?? "";
  return {
    ...(prev ?? {}),
    report_month: MONTH,                       // 印刷ビューの曜日計算がこれを見る
    user_name: prev?.user_name || person.name,
    insurer_number: prev?.insurer_number || cert?.insurer_number || person.insurer || "",
    insured_number: prev?.insured_number || cert?.insured_number || person.insured || "",
    insurer_name: prev?.insurer_name || cert?.insurer_name || "",
    care_level: careLevel,
    limit_amount: limit,
    limit_period: prev?.limit_period
      || (cert ? `${fmtReiwa(cert.certification_start_date)}〜${fmtReiwa(cert.certification_end_date)}` : ""),
    support_office_name: prev?.support_office_name || person.officeName || "",
    creation_date: prev?.creation_date || "",
    submission_date: prev?.submission_date || "",
    services: buildServices(person.rows),
    _import_source: { kind: "riyouhyou-pdf", marker: MARKER, month: MONTH, files: person.sources },
  };
}

/** 予定/実績が 1 つでも入っているか (= 人が入力した可能性) */
function hasAnyMark(content) {
  const svcs = Array.isArray(content?.services) ? content.services : [];
  return svcs.some((s) =>
    (Array.isArray(s.planned) && s.planned.some(Boolean)) ||
    (Array.isArray(s.actual) && s.actual.some(Boolean)));
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== 居宅 利用票 PDF → 帳票 service-usage 取込 (${MONTH}) ===`);
  console.log(EXECUTE ? "*** 本番実行 ***" : "*** DRY RUN (--execute で反映) ***");
  if (FORCE) console.log("*** --force: 人が入力した帳票も上書きする ***");
  console.log("");

  const areas = targetAreas();
  if (!areas.length) {
    console.error(`✗ 利用者データ/<拠点>/${YYYYMM}/居宅/ が見つからない (AREA=${AREA || "全拠点"})`);
    process.exit(1);
  }

  const total = { people: 0, resolved: 0, unresolved: 0, ambiguous: 0, rows: 0, warnRows: 0,
                  inserted: 0, updated: 0, skipped: 0, over9: 0, nameMismatch: 0, failed: 0,
                  droppedPages: 0 };
  const unresolvedList = [];
  const nameMismatchList = [];
  const warnList = [];

  for (const { area, dir } of areas) {
    const { people, skipped, dropped, fileCount } = readArea(dir);
    console.log(`── ${area}  PDF ${fileCount} 本 / 利用者 ${people.size} 名`);
    if (skipped.monthMismatch) console.log(`   提供年月が ${MONTH} でないページ: ${skipped.monthMismatch} (取り込まない)`);
    for (const d of dropped) {
      total.droppedPages++;
      console.log(`   ⚠ 読めずに落としたページ: ${d}`);
    }
    if (!people.size) { console.log(""); continue; }

    const { byPair, nameById } = await resolveClients(people);

    const resolved = [];
    for (const [key, p] of people.entries()) {
      const ids = byPair.get(key);
      if (!ids || ids.size === 0) {
        total.unresolved++;
        unresolvedList.push(`${area}  ${p.name}  保険者${p.insurer} 被保番${p.insured}  (当方に該当なし)`);
        continue;
      }
      if (ids.size > 1) {
        total.ambiguous++;
        unresolvedList.push(`${area}  ${p.name}  保険者${p.insurer} 被保番${p.insured}  (当方で ${ids.size} 名に当たる → 要統合)`);
        continue;
      }
      const clientId = [...ids][0];
      const db = nameById.get(clientId);
      // 番号は一致しているのに氏名が別人 = **当方の認定レコードの持ち主が違う**。
      // 実例: いすみ PDF「石井 洋子」の (122192?/124222|0000015495) が
      //       当方では「鈴木 喜代子」に付いていた (石井側の被保番は仮番号 9999999222)。
      // このまま入れると **他人の利用票を別人に書き込む**ので既定では止める。
      if (db?.name && normRiyouName(db.name) !== p.nameKey) {
        total.nameMismatch++;
        nameMismatchList.push(
          `${area}  PDF「${p.name}」(保険者${p.insurer} 被保番${p.insured}) vs 当方「${db.name}」` +
          (ALLOW_NAME_MISMATCH ? "  → --allow-name-mismatch で取り込む" : "  → skip (要調査)"),
        );
        if (!ALLOW_NAME_MISMATCH) continue;
      }
      resolved.push({ key, p, clientId });
    }
    total.people += people.size;
    total.resolved += resolved.length;

    const targets = LIMIT ? resolved.slice(0, LIMIT) : resolved;
    const certs = await fetchCerts(targets.map((t) => t.clientId));

    // 既存帳票をまとめて取る
    const existing = new Map();
    const CH = 150;
    for (let i = 0; i < targets.length; i += CH) {
      const chunk = targets.slice(i, i + CH).map((t) => t.clientId);
      const rows = await fetchAll(() => sb
        .from("kaigo_report_documents")
        .select("id, user_id, content, status, created_by, updated_at")
        .eq("report_type", "service-usage")
        .eq("report_month", MONTH)
        .in("user_id", chunk));
      for (const r of rows) {
        const cur = existing.get(r.user_id);
        if (!cur || (r.updated_at ?? "") > (cur.updated_at ?? "")) existing.set(r.user_id, r);
      }
    }

    for (const { p, clientId } of targets) {
      total.rows += p.rows.length;
      const w = p.rows.filter((r) => r.warn.length);
      if (w.length) {
        total.warnRows += w.length;
        if (warnList.length < 20) warnList.push(`${area} ${p.name}: ${w[0].content} — ${w[0].warn.join(" / ")}`);
      }
      if (p.rows.length > 9) total.over9++;

      const prev = existing.get(clientId);
      const prevContent = prev?.content ?? null;
      const mine = prevContent?._import_source?.kind === "riyouhyou-pdf";
      if (prev && !mine && hasAnyMark(prevContent) && !FORCE) {
        total.skipped++;
        continue;
      }

      const content = buildContent(prevContent, p, certs.get(clientId));
      if (!EXECUTE) { prev ? total.updated++ : total.inserted++; continue; }

      if (prev) {
        const { error } = await sb.from("kaigo_report_documents")
          .update({ content, status: "completed", updated_at: new Date().toISOString() })
          .eq("id", prev.id);
        if (error) { console.error(`  ✗ UPDATE 失敗 ${p.name}: ${error.message}`); total.failed++; continue; }
        total.updated++;
      } else {
        const { error } = await sb.from("kaigo_report_documents").insert({
          user_id: clientId,
          report_type: "service-usage",
          title: `利用票・提供票（${MONTH.slice(0, 4)}年${Number(MONTH.slice(5, 7))}月）`,
          report_month: MONTH,
          content,
          status: "completed",
          tenant_id: "kt-group",
        });
        if (error) { console.error(`  ✗ INSERT 失敗 ${p.name}: ${error.message}`); total.failed++; continue; }
        total.inserted++;
      }
    }
    console.log("");
  }

  console.log("=== まとめ ===");
  console.log(`  PDF の利用者          ${total.people} 名`);
  console.log(`  引き当て成功          ${total.resolved} 名`);
  console.log(`  引き当て失敗          ${total.unresolved} 名 (当方に該当なし)`);
  console.log(`  複数該当              ${total.ambiguous} 名 (要統合)`);
  console.log(`  サービス行            ${total.rows} 行`);
  console.log(`  合計が合わない行      ${total.warnRows} 行  ← 0 でないとパーサを直す`);
  console.log(`  氏名が食い違う        ${total.nameMismatch} 名 ${ALLOW_NAME_MISMATCH ? "(取り込む)" : "(skip した。当方の認定の持ち主違いを疑う)"}`);
  console.log(`  9 行を超える利用者    ${total.over9} 名 (印刷は 13 行/ページで改ページ)`);
  console.log(`  読めずに落ちたページ  ${total.droppedPages} ページ ← 0 でないと取りこぼし`);
  console.log("");
  console.log(`  ${EXECUTE ? "INSERT" : "INSERT 予定"}          ${total.inserted} 件`);
  console.log(`  ${EXECUTE ? "UPDATE" : "UPDATE 予定"}          ${total.updated} 件`);
  console.log(`  skip (人が入力済)     ${total.skipped} 件  ← --force で上書き`);
  if (total.failed) console.log(`  ✗ 失敗                ${total.failed} 件`);

  if (unresolvedList.length) {
    console.log("\n--- 引き当てできなかった利用者 ---");
    for (const l of unresolvedList.slice(0, 40)) console.log("  " + l);
    if (unresolvedList.length > 40) console.log(`  … 他 ${unresolvedList.length - 40} 名`);
  }
  if (nameMismatchList.length) {
    console.log("\n--- 氏名の食い違い (番号は一致) ---");
    for (const l of nameMismatchList.slice(0, 20)) console.log("  " + l);
    if (nameMismatchList.length > 20) console.log(`  … 他 ${nameMismatchList.length - 20} 名`);
  }
  if (warnList.length) {
    console.log("\n--- 合計が合わない行 ---");
    for (const l of warnList) console.log("  " + l);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
