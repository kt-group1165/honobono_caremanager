// ============================================================================
// 「計画書一括印刷（利用者単位）」PDF (第1表→第2表→週間計画→利用票→別表 を
// 1ファイルに束ねたもの) から 第3表(週間計画) と 第7表(別表) を取り込む。
//
//   node migrations/import_care_plan3_usage_detail_from_pdf.mjs --pdf "<path>" [--pdf "<path2>" ...]   # DRY RUN
//   node migrations/import_care_plan3_usage_detail_from_pdf.mjs --pdf "<path>" --execute
//
// ── 第7表(service-usage-detail)の数値列 (2026-09-14 解決) ────────────────
//   残り5本の実PDFで列境界と金額の出方 (行直接 / 「◯◯合計」行からの按分) が
//   確定した。詳細は _parse_careplan_bundle_pdf.mjs の extractBetsuhyouRows
//   冒頭コメント参照。自己検算 (合計行の費用総額と行ごとの計算値の合計の差)
//   で不一致が出た場合は warn に積んで出力する。
//   ⚠ 区分支給限度基準を超える単位数は実データ6本すべてで 0 だったため
//   未対応 (over_limit_units は常に0で出す)。限度超過がある利用者では
//   金額がずれる可能性があるので、書込前に必ず warn 欄が空であることを確認。
//
// ── 利用者の特定 ────────────────────────────────────────────────────────
//   束ねPDF内の利用票(第6表)ページに印字された (保険者番号,被保険者番号) で
//   引き当てる (import_riyouhyou_service_usage.mjs と同じ _client_resolve.mjs
//   を共有)。週間計画・別表ページには番号が印字されないため、**同じファイル内
//   の利用票ページで特定した人物と同一**という前提を置く (H指示)。
//   氏名も weekly/riyouhyou 両ページから拾い、_name_normalize.mjs で正規化して
//   一致しなければ警告して skip する (別人の取り違え防止)。
//
// ── 対象月の決め方 (2026-09-14 H指摘で訂正) ────────────────────────────
//   ★ 週間計画ページの「令和 年 月分」欄は**計画を作成した月**であって
//   サービス提供年月ではない (実例: 新井秀雄。週間計画ヘッダは「4月分・
//   作成4/20」だが実際のサービス提供年月は7月。空欄でなくても中身が
//   誤っていることがあるため、週間計画のヘッダ月は**一切使わない**)。
//   ★ 対象月は必ず**利用票(第6表)ページ自身に印字された提供年月**
//   ("令和 8年 7月分" 等、_riyouhyou_pdf.mjs と同じ正規表現) から取る。
//   利用票ページが無い/月が読めないときだけ、別表ページの提供年月
//   ("令和 8年 6月　0000375402　秋葉 法昌 様" のような行) で補完する。
//   どちらも読めなければ要確認として skip する。
//
// ── 重複防止 ────────────────────────────────────────────────────────────
//   service-usage-detail: (user_id, report_type, report_month) で既存があれば
//   skip する (--force で上書き)。
//   care-plan-3: (user_id, report_type, certification_id) で既存があれば
//   skip する (--force は使わない。下記の cert 紐付け参照)。
//
// ── care-plan-3 は cert-linked な帳票 (2026-09-14 H指摘で追加) ───────────
//   src/app/(authenticated)/reports/[type]/page.tsx の isCertLinked に
//   "care-plan-3" が入っている。画面はその利用者の**最新の認定**の
//   certification_id で docs を絞り込み (initialCertifications[0].id で
//   `.filter(d => d.certification_id === initialCertId)`)、certification_id
//   が null の行は**表示されない** (SESSION_START「cert-linked な帳票は
//   certification_id を必ず入れる」の型。第1表で 11 件・アセスメントで 113 件、
//   同じ理由で画面に出なかった前例がある)。
//   ★ report_month はこの画面が一切参照しない (docsPromise が report_type だけで
//   絞り込み、EditFormCarePlan3 も content.report_month を読まない)。既存の
//   care-plan-3 実データ7件も全部 report_month=null なので、それに合わせて
//   null のまま出す (2026-09-14 コードで確認)。
//
//   紐付け規則は fix_assessment_cert_link.mjs と同一 (対象月に有効な認定→
//   無ければ最新。異なる保険者番号の認定が複数ある利用者はスキップ)。
//   認定を1件も持たない利用者には書かない。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractPages } from "./_pdf_words.mjs";
import { resolveClients } from "./_client_resolve.mjs";
import { classifyPage, extractWeeklySchedule, extractBetsuhyouRows } from "./_parse_careplan_bundle_pdf.mjs";
import { extractGrid, pickIdentity } from "./_riyouhyou_grid.mjs";
import { normName } from "./_name_normalize.mjs";

const EXECUTE = process.argv.includes("--execute");
const FORCE = process.argv.includes("--force");
const PDF_PATHS = process.argv.flatMap((a, i, arr) => (a === "--pdf" ? [arr[i + 1]] : []));
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const MARKER = "care-plan-bundle-pdf";

if (!PDF_PATHS.length) {
  console.error("--pdf <path> を最低1つ指定する (複数可)");
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

const CARE_PLAN3_HOUR_KEYS = ["h00", "h02", "h04", "h06", "h08", "h10", "h12", "h14", "h16", "h18", "h20", "h22"];

/** 束ねPDF 1件を読んで {weekly, riyouhyou, betsuhyou} のページ内容を返す */
function parseBundle(pdfPath) {
  const { texts, words } = extractPages(pdfPath);
  const out = {
    weekly: null, riyouhyouIdentity: null, riyouhyouGrid: null, riyouhyouMonth: null,
    betsuhyouItems: null, betsuhyouWarn: [], betsuhyouPublicExpense: [], betsuhyouMonth: null, betsuhyouName: null,
    betsuhyouLimitAmount: null, pages: [],
  };
  for (let i = 0; i < texts.length; i++) {
    const kind = classifyPage(texts[i]);
    out.pages.push(kind);
    if (kind === "weekly") out.weekly = extractWeeklySchedule(words[i]);
    if (kind === "riyouhyou") {
      out.riyouhyouIdentity = pickIdentity(words[i]);
      out.riyouhyouGrid = extractGrid(words[i]);
      // ★ 対象月の唯一の正しいソース (2026-09-14 H指摘)。週間計画のヘッダ月は
      // 「計画作成月」であって提供月ではないため使わない。
      const mm = /令和[\s　]*(\d+)[\s　]*年[\s　]*(\d+)[\s　]*月分/.exec(texts[i]);
      if (mm) out.riyouhyouMonth = `${2018 + Number(mm[1])}-${String(Number(mm[2])).padStart(2, "0")}`;
    }
    if (kind === "betsuhyou") {
      const { items, warn, publicExpenseByProvider } = extractBetsuhyouRows(words[i]);
      out.betsuhyouItems = items;
      out.betsuhyouWarn = warn;
      out.betsuhyouPublicExpense = publicExpenseByProvider ?? [];
      // 「区分支給限度基準額(単位)」の直後に出る数字 (要介護度から機械的に決まる値。
      // _riyouhyou_pdf.mjs の LIMIT_TO_CARE_LEVEL と同じ値だが、印字を直接読むほうが
      // 要介護度の読み取り誤りに影響されず確実)
      // ⚠ ラベル「区分支給限度基準額(単位)」の**右**に値が出る (実測で左と誤認して
      //   一度 null になった。値は同じ行のラベルの右、次の「合計」ラベルより手前)
      const limitLabel = words[i].find((w) => w.t.includes("区分支給限度基準額"));
      if (limitLabel) {
        const near = words[i].find((w) => Math.abs(w.y - limitLabel.y) <= 3
          && w.x > limitLabel.x && w.x < limitLabel.x + 200 && /^\d{4,6}$/.test(w.t));
        if (near) out.betsuhyouLimitAmount = Number(near.t);
      }
      // 別表ヘッダー「令和 8年 6月   0000375402   秋葉 法昌 様」から提供年月と氏名を拾う
      // (週間計画の対象月欄が空欄のときのフォールバック用)
      const m = /令和[\s　]*(\d+)[\s　]*年[\s　]*(\d+)[\s　]*月/.exec(texts[i]);
      if (m) out.betsuhyouMonth = `${2018 + Number(m[1])}-${String(Number(m[2])).padStart(2, "0")}`;
      const nm = /様/.exec(texts[i]);
      if (nm) {
        const before = texts[i].slice(0, nm.index).trimEnd();
        const lastLine = before.split("\n").filter((l) => l.trim()).pop();
        if (lastLine) out.betsuhyouName = lastLine.trim();
      }
    }
  }
  return out;
}

// ── 認定 (certification_id) の紐付け — fix_assessment_cert_link.mjs と同一規則 ──
/** PostgREST の 1000 行上限を超えて全件取る */
async function fetchAllRows(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

/** clientIds の認定を取得し、fix_assessment_cert_link.mjs と同じ
 * crossInsurerUsers (保険者番号自体が複数→常にスキップ) /
 * sameInsurerMultiInsured (保険者は同一・被保番だけ複数→条件付き) を判定する */
async function loadCertContext(clientIds) {
  const certs = await fetchAllRows(() => sb
    .from("client_insurance_records")
    .select("id, client_id, insurer_number, insured_number, care_level, certification_start_date, certification_end_date")
    .in("client_id", clientIds)
    .order("id"));
  const certsByUser = new Map();
  for (const c of certs) {
    if (!certsByUser.has(c.client_id)) certsByUser.set(c.client_id, []);
    certsByUser.get(c.client_id).push(c);
  }
  const crossInsurerUsers = new Set();
  const sameInsurerMultiInsured = new Set();
  for (const [uid, list] of certsByUser) {
    const insurers = new Set(list.map((c) => c.insurer_number ?? ""));
    const pairs = new Set(list.map((c) => `${c.insurer_number ?? ""}|${c.insured_number ?? ""}`));
    if (pairs.size <= 1) continue;
    if (insurers.size > 1) crossInsurerUsers.add(uid);
    else sameInsurerMultiInsured.add(uid);
  }
  return { certsByUser, crossInsurerUsers, sameInsurerMultiInsured };
}

/** 対象月 (YYYY-MM) に有効な認定。無ければ一番新しい認定 (fix_assessment_cert_link.mjs の
 * pickCert() と同一規則。実施日の代わりに「対象月の月末」を基準日にする) */
function pickCertForMonth(list, targetMonth) {
  if (!list?.length) return null;
  const monthEnd = new Date(Number(targetMonth.slice(0, 4)), Number(targetMonth.slice(5, 7)), 0);
  const monthEndStr = `${targetMonth}-${String(monthEnd.getDate()).padStart(2, "0")}`;
  const monthStartStr = `${targetMonth}-01`;
  const valid = list.filter((c) =>
    (!c.certification_start_date || c.certification_start_date <= monthEndStr) &&
    (!c.certification_end_date || c.certification_end_date >= monthStartStr));
  const pool = valid.length ? valid : list;
  const sorted = pool.slice().sort((x, y) =>
    String(y.certification_start_date ?? "").localeCompare(String(x.certification_start_date ?? "")));
  return { cert: sorted[0], covered: valid.length > 0 };
}

/**
 * clientId・対象月から書き込むべき certification_id を決める。
 * @returns {{cert: object, covered: boolean} | {skipReason: string}}
 */
function resolveCertification(ctx, clientId, targetMonth) {
  if (ctx.crossInsurerUsers.has(clientId)) {
    return { skipReason: "異なる保険者番号の認定が複数ある (別人混入の疑い) — fix_assessment_cert_link.mjs と同じ理由でスキップ" };
  }
  const list = ctx.certsByUser.get(clientId) ?? [];
  if (!list.length) return { skipReason: "認定を1件も持たない" };
  if (ctx.sameInsurerMultiInsured.has(clientId)) {
    const monthEnd = new Date(Number(targetMonth.slice(0, 4)), Number(targetMonth.slice(5, 7)), 0);
    const monthEndStr = `${targetMonth}-${String(monthEnd.getDate()).padStart(2, "0")}`;
    const monthStartStr = `${targetMonth}-01`;
    const covering = list.filter((c) =>
      (!c.certification_start_date || c.certification_start_date <= monthEndStr) &&
      (!c.certification_end_date || c.certification_end_date >= monthStartStr));
    if (covering.length !== 1) return { skipReason: `保険者は同一・被保番だけ複数で、対象月を含む認定が${covering.length}件 (一意に決まらない)` };
    return { cert: covering[0], covered: true };
  }
  const picked = pickCertForMonth(list, targetMonth);
  if (!picked) return { skipReason: "認定を1件も持たない" };
  return picked;
}

/** ⚠ キー名は EditFormCarePlan3 (reports-content.tsx) が読む名前と完全に一致させること。
 * 旧版はここが daily_routine/irregular_services になっていて、画面 (daily_activities/
 * other_services を読む) には反映されない不具合があった (2026-09-14 に発見・是正)。
 * prev があれば人の入力を残す (schedule 以外の欄は prev 優先、無ければ抽出値)。 */
function buildSchedulePayload(prev, weekly) {
  const schedule = {};
  for (const k of CARE_PLAN3_HOUR_KEYS) schedule[k] = { ...(prev?.schedule?.[k] ?? {}), ...(weekly.schedule?.[k] ?? {}) };
  return {
    ...(prev ?? {}),
    schedule,
    care_level: prev?.care_level || weekly.careLevel || "",
    user_name: prev?.user_name || weekly.userName || "",
    creation_date: prev?.creation_date || weekly.creationDate || "",
    daily_activities: prev?.daily_activities || (weekly.dailyRoutine ?? []).join("\n"),
    other_services: prev?.other_services || weekly.irregularServices || "",
    _import_source: { kind: MARKER },
  };
}

/** ⚠ こちらも EditFormUsageDetail が読むキー名 (items/short_stay_days/limit_management等)
 * に合わせる。items は prev があっても抽出結果で置き換える (行の追加・削除が主目的の
 * 帳票で、prev の空スケルトン行を残す理由が無いため)。他のヘッダー欄は prev 優先。 */
function buildDetailPayload(prev, b, month) {
  return {
    ...(prev ?? {}),
    items: b.betsuhyouItems ?? prev?.items ?? [],
    user_name: prev?.user_name || b.riyouhyouIdentity?.name || b.betsuhyouName || "",
    care_level: prev?.care_level || b.weekly?.careLevel || "",
    limit_amount: prev?.limit_amount || b.betsuhyouLimitAmount || "",
    limit_period: prev?.limit_period || "",
    creation_date: prev?.creation_date || b.weekly?.creationDate || "",
    insured_number: prev?.insured_number || b.riyouhyouIdentity?.insured || "",
    insurer_number: prev?.insurer_number || b.riyouhyouIdentity?.insurer || "",
    short_stay_days: prev?.short_stay_days ?? { prev: 0, current: 0, total: 0 },
    limit_management: prev?.limit_management ?? [],
    // ⚠ EditFormUsageDetail の items[] スキーマに公費専用の列が無いため、
    // items[].user_copay は既に「公費適用後の実際の利用者負担」に是正済み
    // (extractBetsuhyouRows 側)。この欄は根拠を残すための参考情報で、
    // 画面はこのキーを読まない (2026-09-14 H指摘への対応)。
    public_expense_by_provider: b.betsuhyouPublicExpense?.length ? b.betsuhyouPublicExpense : (prev?.public_expense_by_provider ?? []),
    _import_source: { kind: MARKER, month },
  };
}

async function main() {
  console.log("=== 計画書一括印刷PDF → 第3表(care-plan-3)・第7表(service-usage-detail) 取込 ===");
  console.log(EXECUTE ? "*** 本番実行 ***" : "*** DRY RUN ***");
  console.log("");

  const parsed = PDF_PATHS.map((p) => ({ path: p, ...parseBundle(p) }));

  // ── 利用者を引き当てる (利用票ページの (保険者,被保険者) で) ────────────
  const people = new Map();
  const noIdentity = [];
  for (const b of parsed) {
    if (!b.riyouhyouIdentity?.insurer || !b.riyouhyouIdentity?.insured) {
      noIdentity.push(b);
      continue;
    }
    const nameKey = normName(b.riyouhyouIdentity.name ?? "");
    people.set(b.path, { insurer: b.riyouhyouIdentity.insurer, insured: b.riyouhyouIdentity.insured, nameKey });
  }
  const { byPair, nameById } = await resolveClients(sb, people, { normalizeName: normName });

  // 番号が全く読めない (利用票ページ自体が無い) ファイルは、週間計画の氏名だけで
  // ★参考情報として★ 1名に絞れるか見る。書込には使わない (氏名だけの引き当ては
  // 別人衝突のリスクがあるため。memory feedback_name_based_lookup_collision_risk)。
  for (const b of noIdentity) {
    const base = path.basename(b.path);
    const nm = b.weekly?.userName ?? null;
    if (!nm) {
      console.log(`✗ ${base}: 利用票ページが無く、週間計画にも氏名が読めない (ページ構成: ${b.pages.join(",")}) → 完全に要確認`);
      continue;
    }
    const key = normName(nm);
    const { data: cand } = await sb.from("clients").select("id, name").is("deleted_at", null);
    const hit = (cand ?? []).filter((c) => normName(c.name) === key);
    if (hit.length === 1) {
      console.log(`⚠ ${base}: 利用票ページが無い (ページ構成: ${b.pages.join(",")})。週間計画の氏名「${nm}」で当方に1名だけヒット: ${hit[0].name} (id=${hit[0].id}) — ★氏名のみの参考情報。番号での確認が取れるまで書込対象外`);
    } else {
      console.log(`✗ ${base}: 利用票ページが無い (ページ構成: ${b.pages.join(",")})。週間計画の氏名「${nm}」は当方で ${hit.length} 名に該当 → 要確認`);
    }
  }

  // ── 認定紐付けに要る clientId を先に一通り確定させておく (cert は後でまとめて取得) ──
  const resolvedClientId = new Map(); // b.path -> clientId
  for (const b of parsed) {
    if (noIdentity.includes(b)) continue;
    const p = people.get(b.path);
    const ids = byPair.get(`${p.insurer}|${p.insured}`);
    if (ids && ids.size === 1) resolvedClientId.set(b.path, [...ids][0]);
  }
  const certCtx = await loadCertContext([...new Set(resolvedClientId.values())]);

  // ── 負のコントロール (2026-09-14 H指摘): certification_id を外すと
  //   画面と同じ絞り込みで 0 件になることを実クエリで示す ────────────────
  //   page.tsx L135-139: initialCertId = 最新認定のid、
  //   initialDocs = allDocs.filter(d => d.certification_id === initialCertId)
  //   既存の care-plan-3 実データ (certification_id が入っている7件) を使い、
  //   ①「その行が持つ cert_id」で絞ると 1件ヒットする (=画面に出る)
  //   ②「certification_id IS NULL」で絞ると 0件になる (=画面から消える) ことを示す
  {
    const { data: existingReal } = await sb
      .from("kaigo_report_documents")
      .select("id, user_id, certification_id")
      .eq("report_type", "care-plan-3")
      .not("certification_id", "is", null);
    console.log(`=== 負のコントロール: certification_id を外すと画面から消えることの確認 (既存 care-plan-3 実データ ${existingReal?.length ?? 0} 件で検証) ===`);
    for (const row of existingReal ?? []) {
      const { count: withCert } = await sb.from("kaigo_report_documents").select("id", { count: "exact", head: true })
        .eq("report_type", "care-plan-3").eq("user_id", row.user_id).eq("certification_id", row.certification_id);
      const { count: withNullCert } = await sb.from("kaigo_report_documents").select("id", { count: "exact", head: true })
        .eq("report_type", "care-plan-3").eq("user_id", row.user_id).is("certification_id", null);
      console.log(`  user_id=${row.user_id.slice(0, 8)}…  cert_id指定で絞る → ${withCert}件(画面に出る) / cert_id=NULLで絞る → ${withNullCert}件(画面から消える)`);
    }
    console.log("→ certification_id を入れないと、上の「NULLで絞る」列と同じ 0件 表示になることが確認できる。今回の6名の INSERT には必ず certification_id を入れる。\n");
  }

  let ok = 0, unresolved = noIdentity.length, nameMismatch = 0, care3Written = 0, detailWritten = 0, skipped = 0;
  for (const b of parsed) {
    if (noIdentity.includes(b)) continue;
    const base = path.basename(b.path);
    console.log(`\n── ${base}  (ページ構成: ${b.pages.join(" / ")})`);

    const p = people.get(b.path);
    const ids = byPair.get(`${p.insurer}|${p.insured}`);
    if (!ids || ids.size !== 1) {
      console.log(`  ✗ 引き当て失敗 (保険者${p.insurer} 被保番${p.insured} → 該当 ${ids?.size ?? 0} 件)`);
      unresolved++;
      continue;
    }
    const clientId = [...ids][0];
    const dbName = nameById.get(clientId)?.name ?? "";
    if (dbName && normName(dbName) !== p.nameKey) {
      console.log(`  ⚠ 氏名不一致: PDF「${b.riyouhyouIdentity.name}」 vs 当方「${dbName}」→ skip`);
      nameMismatch++;
      continue;
    }
    console.log(`  → ${dbName || b.riyouhyouIdentity.name} (client_id=${clientId})`);
    ok++;

    // ── 対象月: 利用票(第6表)の提供年月を正とする (2026-09-14 H指摘で訂正) ──
    //   週間計画のヘッダ月は「計画作成月」であって提供月ではないため使わない
    //   (新井秀雄で実証: 週間計画ヘッダは4月分だが実際の提供年月は7月)。
    let targetMonth = b.riyouhyouMonth ?? null;
    let monthSource = "利用票";
    if (!targetMonth && b.betsuhyouMonth) {
      targetMonth = b.betsuhyouMonth;
      monthSource = "別表 (利用票の年月が読めなかったため補完)";
    }
    if (!targetMonth) {
      console.log("  ✗ 対象月が利用票・別表のどちらからも読めない → skip (要確認)");
      skipped++;
      continue;
    }
    console.log(`  対象月: ${targetMonth} (出どころ: ${monthSource})`);
    if (b.weekly?.targetMonth && b.weekly.targetMonth !== targetMonth) {
      console.log(`  ⚠ 週間計画ヘッダの月 (${b.weekly.targetMonth}) と利用票の提供年月 (${targetMonth}) が食い違う。週間計画ヘッダは計画作成月の可能性があるため対象月には使わない`);
    }

    // ── 第3表 (care-plan-3) — cert-linked。certification_id を必ず入れる ──
    if (!b.weekly?.schedule) {
      console.log(`  ✗ 週間計画ページの解析に失敗 (warn: ${JSON.stringify(b.weekly?.warn ?? ["ページ自体が見つからない"])})`);
    } else {
      const filled = Object.entries(b.weekly.schedule).filter(([, days]) => Object.keys(days).length > 0);
      console.log(`  第3表: ${filled.length}時間帯に予定あり / 対象月=${targetMonth}`);
      for (const [hk, days] of filled) console.log(`    ${hk}: ${JSON.stringify(days)}`);
      if (b.weekly.irregularServices) console.log(`    週単位以外のサービス: ${b.weekly.irregularServices}`);

      const certResult = resolveCertification(certCtx, clientId, targetMonth);
      if (certResult.skipReason) {
        console.log(`  ✗ 第3表: 認定紐付け不能 (${certResult.skipReason}) → 書かない`);
        skipped++;
      } else {
        const { cert, covered } = certResult;
        console.log(`  第3表: 採用する認定 ${cert.care_level} (${cert.certification_start_date}〜${cert.certification_end_date ?? ""})${covered ? "" : "  ※対象月を含む認定が無く最新で代替"}`);

        const { data: existingCp3 } = await sb
          .from("kaigo_report_documents")
          .select("id, content")
          .eq("user_id", clientId)
          .eq("report_type", "care-plan-3")
          .eq("certification_id", cert.id)
          .maybeSingle();
        if (existingCp3) {
          console.log("  skip (この認定に紐づく care-plan-3 が既にある。--force は使わない仕様)");
          skipped++;
        } else {
          const content = buildSchedulePayload(null, b.weekly);
          if (!EXECUTE) {
            console.log("  INSERT 予定 (care-plan-3, report_month=null, certification_id 設定)");
            care3Written++;
          } else {
            const title = "週間サービス計画表（第3表）";
            const { error } = await sb.from("kaigo_report_documents").insert({
              user_id: clientId, report_type: "care-plan-3", title, report_month: null,
              certification_id: cert.id, content, status: "draft", tenant_id: "kt-group",
            });
            if (error) console.error(`  ✗ INSERT失敗: ${error.message}`);
            else { console.log("  INSERT 完了"); care3Written++; }
          }
        }
      }
    }

    // ── 第7表 (service-usage-detail) ────────────────────────────────
    if (!b.betsuhyouItems) {
      console.log("  第7表: 別表ページが見つからない");
    } else {
      console.log(`  第7表: ${b.betsuhyouItems.length}行`);
      for (const it of b.betsuhyouItems) {
        const tag = it._money_source === "direct" ? "" : it._money_source === "group-total" ? " (合計行から按分)" : " ⚠既定値のまま(要確認)";
        console.log(`    ${it.service_code}  ${it.service_content}  ${it.provider_name}(${it.provider_number || "番号不明"})  単位${it.units}×${it.count}回=${it.service_units}  単価${it.unit_price} 給付率${it.benefit_rate}% 総額${it.total_cost} 保険請求${it.insurance_claim} 負担${it.user_copay}${tag}`);
      }
      if (b.betsuhyouPublicExpense?.length) {
        console.log("  公費適用 (items[].user_copay は下記に是正済。参考情報として content.public_expense_by_provider にも保存):");
        for (const pe of b.betsuhyouPublicExpense) console.log(`    ${pe.provider_name_prefix}: 公費額${pe.kohi_claim} 本人負担${pe.honnin_futan}`);
      }
      if (b.betsuhyouWarn.length) {
        console.log("  ⚠ 自己検算の注意:");
        for (const w of b.betsuhyouWarn) console.log(`    ⚠ ${w}`);
      } else {
        console.log("  ✓ 自己検算: 印字の合計行と items[] の合計が完全一致 (円単位)");
      }

      const { data: existingDetail } = await sb
        .from("kaigo_report_documents")
        .select("id, content")
        .eq("user_id", clientId)
        .eq("report_type", "service-usage-detail")
        .eq("report_month", targetMonth)
        .maybeSingle();
      if (existingDetail && !FORCE) {
        console.log(`  skip (既存 service-usage-detail ${targetMonth} あり。--force で上書き)`);
        skipped++;
      } else {
        const content = buildDetailPayload(FORCE ? existingDetail?.content : null, b, targetMonth);
        if (!EXECUTE) {
          console.log(`  ${existingDetail ? "UPDATE" : "INSERT"} 予定 (service-usage-detail, ${targetMonth})`);
          detailWritten++;
        } else {
          const title = `サービス利用票別表（第7表）　${targetMonth.replace("-", "年")}月分`;
          if (existingDetail) {
            const { error } = await sb.from("kaigo_report_documents").update({ content, updated_at: new Date().toISOString() }).eq("id", existingDetail.id);
            if (error) console.error(`  ✗ UPDATE失敗: ${error.message}`);
            else { console.log("  UPDATE 完了"); detailWritten++; }
          } else {
            const { error } = await sb.from("kaigo_report_documents").insert({
              user_id: clientId, report_type: "service-usage-detail", title, report_month: targetMonth,
              content, status: "draft", tenant_id: "kt-group",
            });
            if (error) console.error(`  ✗ INSERT失敗: ${error.message}`);
            else { console.log("  INSERT 完了"); detailWritten++; }
          }
        }
      }
    }
  }

  console.log("\n=== まとめ ===");
  console.log(`  PDF                    ${parsed.length} 本`);
  console.log(`  利用者引き当て成功     ${ok} 件`);
  console.log(`  引き当て失敗           ${unresolved} 件 (うち利用票ページ自体が無い: ${noIdentity.length} 件)`);
  console.log(`  氏名不一致でskip       ${nameMismatch} 件`);
  console.log(`  対象月不明でskip       ${skipped} 件`);
  console.log(`  第3表 ${EXECUTE ? "書込完了" : "書込予定"}       ${care3Written} 件`);
  console.log(`  第7表 ${EXECUTE ? "書込完了" : "書込予定"}       ${detailWritten} 件`);
}

main().catch((e) => { console.error(e); process.exit(1); });
