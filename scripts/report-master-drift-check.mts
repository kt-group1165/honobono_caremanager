/**
 * 帳票 (kaigo_report_documents) の保存値とマスタの食い違いを見張る常設チェック (基準値方式)
 *
 *   npx tsx scripts/report-master-drift-check.mts             実行 (READ ONLY)
 *   npx tsx scripts/report-master-drift-check.mts -- --update  基準値を今の値で書き直す
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   src/lib/report-master-fields.ts (2026-09-05実装) は「印刷時にマスタ優先で
 *   引き直す」ことで印字内容は正しくなるが、★保存値そのもののズレは残る。
 *   ズレが想定外に増えていないかを見張る (増える自体は自然。認定更新のたび
 *   ズレは増える。回帰=想定外の増加だけを検知する運用)。
 *
 * ── 利用票 (service-usage) は外部に渡る帳票 ───────────────────────────────
 *   利用者・サービス事業所に渡すため、印字が変わったことを「正しくなった」と
 *   説明できる形にしておく必要がある。★ service-usage の変更前後を
 *   report-master-drift-service-usage-detail.json に全件出力する。
 *
 * ── ついでに測ったもの (直さない・測るだけ) ─────────────────────────────
 *   certification_status='認定済み' なのに certification_end_date が過ぎている
 *   認定の件数。selectCurrentCertForClient (careplan-selection.ts と同じ考え方)
 *   は end_date を見ないため、G さんが発見した「期限切れ計画284名」と同じ構造の
 *   リスクが認定側にもあるかを測る。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { selectCertForReportDoc, selectCurrentCertForClient } from "@/lib/report-master-fields";
import { parseYearMonth, monthRange } from "@/lib/cert-for-month";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.argv.includes("--update");
// ★ 負のコントロール: certification_id の無い帳票に わざと「対象月に有効でない認定」を選ばせる。
//   印刷と同じ選び方 (selectCertForReportDoc) が効いていれば、この時だけ件数が増える。
//   基準値・明細 json は書かない (NEG_CONTROL=1 npx tsx scripts/report-master-drift-check.mts)
const NEG_CONTROL = process.env.NEG_CONTROL === "1";
const BASELINE = join(__dirname, "report-master-drift-baseline.json");
const DETAIL_OUT = join(__dirname, "report-master-drift-service-usage-detail.json");

const env: Record<string, string> = {};
for (const l of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const REPORT_TYPES = ["care-plan-1", "care-plan-3", "yobo-care-plan", "service-usage", "service-usage-detail"];
const PAGE = 1000;

async function fetchAllDocs() {
  const docs: { id: string; user_id: string; report_type: string; certification_id: string | null; report_month: string | null; content: Record<string, unknown> }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("kaigo_report_documents")
      .select("id, user_id, report_type, certification_id, report_month, content")
      .in("report_type", REPORT_TYPES)
      .order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`帳票の取得に失敗: ${error.message}`);
    docs.push(...(data as typeof docs));
    if (data.length < PAGE) break;
  }
  return docs;
}

async function fetchClientNames(userIds: string[]) {
  const names = new Map<string, string>();
  for (let i = 0; i < userIds.length; i += 150) {
    const chunk = userIds.slice(i, i + 150);
    const { data, error } = await sb.from("clients").select("id, name").in("id", chunk);
    if (error) throw new Error(`利用者名の取得に失敗: ${error.message}`);
    for (const c of data as { id: string; name: string }[]) names.set(c.id, c.name);
  }
  return names;
}

async function main() {
  const docs = await fetchAllDocs();
  const userIds = Array.from(new Set(docs.map((d) => d.user_id)));

  // ★ 印刷 (reports-content.tsx の fetchMasterForDoc) と同じ列・同じ選び方 (selectCertForReportDoc)
  type CertRow = {
    id: string; client_id: string; care_level: string | null;
    certification_start_date: string | null; certification_end_date: string | null;
    certification_status: string | null; effective_date: string | null;
    copay_rate: string | null; service_limit_amount: number | null;
  };
  const CERT_COLS = "id, client_id, care_level, certification_start_date, certification_end_date, certification_status, effective_date, copay_rate, service_limit_amount";
  const certByUser = new Map<string, CertRow[]>();
  const certById = new Map<string, CertRow>();
  for (let i = 0; i < userIds.length; i += 150) {
    const chunk = userIds.slice(i, i + 150);
    const { data, error } = await sb.from("client_insurance_records").select(CERT_COLS).in("client_id", chunk);
    if (error) throw new Error(`認定の取得に失敗: ${error.message}`);
    for (const c of data as CertRow[]) {
      if (!certByUser.has(c.client_id)) certByUser.set(c.client_id, []);
      certByUser.get(c.client_id)!.push(c);
      certById.set(c.id, c);
    }
  }
  // certification_id が別の利用者の認定を指す例外も、印刷は id で引くので同じく引く
  const missingLinked = Array.from(new Set(docs.map((d) => d.certification_id).filter((id): id is string => !!id && !certById.has(id))));
  for (let i = 0; i < missingLinked.length; i += 150) {
    const { data, error } = await sb.from("client_insurance_records").select(CERT_COLS).in("id", missingLinked.slice(i, i + 150));
    if (error) throw new Error(`紐づく認定の取得に失敗: ${error.message}`);
    for (const c of data as CertRow[]) certById.set(c.id, c);
  }

  /** 負のコントロール用: 対象月に有効でない認定のうち 開始日が最新のもの (無ければ通常どおり) */
  const pickOutOfMonth = (rows: CertRow[], reportMonth: string | null): CertRow | null => {
    const ym = parseYearMonth(reportMonth);
    if (!ym) return null;
    const { from, to } = monthRange(ym.year, ym.month);
    const outside = rows.filter((r) => r.certification_start_date && (r.certification_start_date > to || (!!r.certification_end_date && r.certification_end_date < from)));
    return selectCurrentCertForClient(outside);
  };

  const byType = new Map<string, { comparable: number; mismatch: number }>();
  const serviceUsageDetail: { doc_id: string; user_id: string; report_month: string | null; saved_care_level: string; current_care_level: string }[] = [];

  for (const d of docs) {
    const rows = certByUser.get(d.user_id) ?? [];
    const linked = d.certification_id ? certById.get(d.certification_id) ?? null : null;
    const cert = (NEG_CONTROL && !d.certification_id ? pickOutOfMonth(rows, d.report_month) : null)
      ?? selectCertForReportDoc(d, linked, rows);
    if (!cert) continue;
    const t = byType.get(d.report_type) ?? { comparable: 0, mismatch: 0 };
    t.comparable++;
    const saved = typeof d.content.care_level === "string" ? d.content.care_level : null;
    const mismatch = !!saved && saved !== "" && saved !== cert.care_level;
    if (mismatch) {
      t.mismatch++;
      if (d.report_type === "service-usage") {
        serviceUsageDetail.push({ doc_id: d.id, user_id: d.user_id, report_month: d.report_month, saved_care_level: saved!, current_care_level: cert.care_level ?? "" });
      }
    }
    byType.set(d.report_type, t);
  }

  // ★ 利用票 (外部に渡る帳票) は氏名付きで全件出力 (後から説明できるように)
  if (serviceUsageDetail.length > 0 && !NEG_CONTROL) {
    const names = await fetchClientNames(Array.from(new Set(serviceUsageDetail.map((r) => r.user_id))));
    const withNames = serviceUsageDetail.map((r) => ({ ...r, client_name: names.get(r.user_id) ?? "(不明)" }));
    writeFileSync(DETAIL_OUT, JSON.stringify({ asOf: new Date().toISOString().slice(0, 10), rows: withNames }, null, 2));
    console.log(`利用票の変更前後一覧 (${withNames.length}件) を書きました → ${DETAIL_OUT}`);
  }

  console.log(`\n=== 帳票別 care_level 食い違い件数 ===`);
  const current: Record<string, { comparable: number; mismatch: number }> = {};
  for (const [t, v] of byType) {
    console.log(`  ${t}: 比較可能${v.comparable}件中 ${v.mismatch}件`);
    current[t] = v;
  }
  const totalMismatch = [...byType.values()].reduce((s, v) => s + v.mismatch, 0);
  console.log(`  合計: ${totalMismatch}件`);

  // ── ついでに測ったもの: 認定済みなのに期限切れの件数 (直さない・報告のみ) ──
  const todayIso = new Date().toISOString().slice(0, 10);
  const { count: totalActive } = await sb.from("client_insurance_records")
    .select("*", { count: "exact", head: true }).eq("certification_status", "認定済み");
  const { count: expiredActive } = await sb.from("client_insurance_records")
    .select("*", { count: "exact", head: true }).eq("certification_status", "認定済み")
    .lt("certification_end_date", todayIso);
  console.log(`\n=== ついでに測定 (直さない): 認定済みなのに期限切れ ===`);
  console.log(`  certification_status='認定済み' 総数: ${totalActive}`);
  console.log(`  うち certification_end_date < 今日: ${expiredActive} 件`);
  console.log(`  ⚠ これは選択ロジック(end_dateを見ない)の理論上の母数。実際に影響するのは`);
  console.log(`    「期限切れの認定済みがstart_date最新のため選ばれてしまい、かつ同じ利用者に`);
  console.log(`    有効な認定済みも別途存在する」場合だけ (2026-09-05実測: 0名。ケアプランの`);
  console.log(`    期限切れ284名問題とは構造が同じだが、現状の実害は無い)。`);

  // ── 基準値比較 ──────────────────────────────────────────────────────────
  if (NEG_CONTROL) console.log(`
★ NEG_CONTROL=1 (わざと月外の認定を選ばせた)。基準値は書かない。FAIL すれば検査は効いている`);
  if (!NEG_CONTROL && (UPDATE || !existsSync(BASELINE))) {
    writeFileSync(BASELINE, JSON.stringify({
      asOf: new Date().toISOString().slice(0, 10),
      byType: current,
      _readme: [
        "npm run check:report-master-fields-drift の基準値。",
        "",
        "■ なぜこの数か (2026-09-05 実測)",
        "  帳票 (kaigo_report_documents) に保存されたcare_levelと、現在有効な認定の",
        "  care_levelが食い違う件数。care-plan-1 122件・service-usage 96件が中心",
        "  (第1表・利用票は認定に紐づく機会が多いため)。",
        "",
        "■ 2026-11-09 FY-R: 印刷と同じ選び方 (selectCertForReportDoc) で比べるよう是正",
        "  旧: certification_id も 対象月も見ず「開始日が最新の認定済み」と比較していた。",
        "  そのため care-plan-1 122 / service-usage 96 の大半は「保存時点では正しかった値」を",
        "  新しい認定と比べた見かけのズレだった。同日 認定更新 (2026-08〜11 開始) の追加で",
        "  145 / 120 に増えて FAIL → 是正後 0 / 1 に下がったので基準値を下げた (厳しくなる方向)。",
        "  ① certification_id があればその認定 ② 無ければ report_month に有効な認定",
        "  (cert-for-month.ts pickCertRowForMonth = 請求と同じ規則) ③ それも無ければ現在の認定。",
        "  残る 1 件: 櫻田 數枝 利用票 2026-06 — 保存 要支援2 / 6月に有効な認定は",
        "  要支援2 (2026-04〜) と 要介護2 (2026-06-01〜) が重なり、開始日が新しい 要介護2 を採る",
        "  (請求と同じ)。利用票は 8/31 04:58 保存、要介護2 の認定行は同日 15:54 登録 = 認定更新による自然な差。",
        "  負のコントロール: NEG_CONTROL=1 で わざと月外の認定を選ばせると service-usage 1175 件で FAIL する。",
        "",
        "■ 0を目指さない",
        "  表示・印刷はsrc/lib/report-master-fields.tsで既にマスタ優先に是正済み",
        "  (2026-09-05・commit 527f98af)。この基準値が見ているのは★保存値そのもの",
        "  のズレで、認定が更新されるたび自然に増える。0にはならない。",
        "",
        "■ 何を検知したいか",
        "  ★ 想定外の増加 (実装バグ等で急増するケース)。認定更新に伴う自然な増加は",
        "  --update で基準値を上げてよい。急増した場合は原因を先に確認すること。",
        "",
        "■ service-usage (利用票) は外部に渡る帳票",
        "  変更前後の一覧を report-master-drift-service-usage-detail.json に",
        "  全件出力している (利用者名付き。後から説明できるように)。",
      ],
    }, null, 2));
    console.log(`\n★ 基準値を書きました: ${BASELINE}`);
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { byType: Record<string, { comparable: number; mismatch: number }> };
  let fail = false;
  console.log(`\n=== 基準値比較 ===`);
  for (const t of REPORT_TYPES) {
    const cur = current[t] ?? { comparable: 0, mismatch: 0 };
    const base = baseline.byType[t] ?? { comparable: 0, mismatch: 0 };
    const status = cur.mismatch > base.mismatch ? "★ FAIL (想定外の増加)" : cur.mismatch < base.mismatch ? "○ 改善" : "= 変化なし";
    console.log(`  ${t}: 基準値${base.mismatch}件 → 現状${cur.mismatch}件  ${status}`);
    if (cur.mismatch > base.mismatch) fail = true;
  }

  if (fail) {
    console.log(`\n★ FAIL — 基準値を超えて食い違いが増えました。原因を確認してから --update してください。`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS — 基準値以下`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
