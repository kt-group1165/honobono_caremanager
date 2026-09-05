/**
 * 訪問入浴 — 要支援(予防給付)なのに介護給付コード(12xxxx)が付いている件数を監視
 * (B-1w 再発防止・0件維持・READ ONLY)
 *
 *   npx tsx scripts/bath-yobo-code-check.mts
 *
 * ── 背景 ────────────────────────────────────────────────────────────────
 *   2026-09-03 サンプル検証で発見、2026-09-05 に系統的に洗い出して一括修正
 *   (H指示「個別に直すのをやめて洗い出してから直す」):
 *     ① 基本コード (121xxx→621xxx) — src/lib/bath-seikyu/resolve-code.ts の resolveBathCode
 *     ② 加算コード (初回/認知症/中山間 124113/126133/126134/128110→624001/626133/626134/628110)
 *        — 同ファイルの bathAddonCodesFor
 *     ③ 中山間加算の母数 (serviceBaseUnits) — isBathBaseCode を使わず"121"決め打ちだった
 *     ④ 虐防/業未 減算の合成コード差し替え (aggregate.ts の gensanSwap) —
 *        予防給付側は対象外になっており、減算未適用=満額請求のまま残っていた
 *        (見落とすと返還リスクの方向。621131等の予防側合成コードがマスタに
 *        実在することを実データで確認してから resolveGensanVariant の
 *        serviceCategory を "62" に振り分けるよう修正)
 *     ⑤ 売上見込 (includeScheduled) の SCHED_CODE — 未記録のシフト予定に
 *        121111/121112 を仮置きしていた。resolveBathCode に置換
 *     ⑥⑦ bath-provision (提供表) 画面の BATH_ROWS 固定4行 / AddServiceModal の
 *        "12%" 決め打ちフィルタ — 記録作成画面 (bath-records/bath-shift) は
 *        既に直っていたが、この画面だけ要介護度を見ていなかった
 *   ★ 洗い出しは「集計・請求・伝送」の全体を対象に機械的に行い (grepで訪問入浴関連
 *   18ファイルを全数確認)、上記7箇所以外に "121"/"12"始まり決め打ちの該当は無かった
 *   (aggregate-sougou.ts の "121012" 等は総合事業の市町村番号で無関係・除外)。
 *   ★ DB に直接書き込む別経路 (import script・過去データ・手動修正) があれば
 *   同じ不整合が再発しうるので、稼働開始前の「出たら気づける」網として維持する。
 *
 * ── 見ているもの (3段) ────────────────────────────────────────────────────
 *   ① raw scan: kaigo_bath_visit_records.service_code に直接 12xxxx (基本・加算とも)
 *      が入っている行 (サービス追加経由での手動入力を含む、稀な経路。
 *      bath-provision画面からの書込みもこのテーブルに落ちるのでここでカバーされる)
 *   ② 集計 scan (実績): aggregateBathVisitSeikyu() を実際に回し、出力される明細
 *      (加算・虐防/業未の合成コードは都度合成されるため raw scan には出ない)
 *      に 12xxxx が混じっていないかを見る。★ こちらが本命 (実際に請求へ出る形を見る)。
 *   ③ 集計 scan (売上見込・includeScheduled): ②と同じだが includeScheduled:true で
 *      回す。未記録のシフト予定 (SCHED_CODE) はこのオプション無しでは合成されず
 *      ②では検出できないため、別途 kaigo_bath_schedule がある(事業所×年月)ごとに回す。
 *
 * ── 0件を目指す検査 ────────────────────────────────────────────────────────
 *   本来ゼロであるべきデータ (資格と種類の不一致は返戻になる) なので、
 *   0件を基準値として増えたら即FAILにする。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { isYoboLevel } from "../src/lib/yobo-kubun";
import { aggregateBathVisitSeikyu } from "../src/lib/bath-seikyu/aggregate";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY が無い。分母が作れないので中止する");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function pageAll<T>(table: string, select: string, orderCol = "id"): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(select).order(orderCol).range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

console.log("══ 訪問入浴 — 要支援なのに介護給付コード(12xxxx) 常設監視 (READ ONLY) ══\n");

// ── ① raw scan ──
type BathRow = { id: string; client_id: string; office_id: string | null; visit_date: string; service_code: string | null };
const bathRows = await pageAll<BathRow>("kaigo_bath_visit_records", "id,client_id,office_id,visit_date,service_code");
console.log(`【分母①】kaigo_bath_visit_records 全件: ${bathRows.length} 行`);

const clientIds = [...new Set(bathRows.map((r) => r.client_id))];
type CertRow = { client_id: string; care_level: string | null; certification_start_date: string | null; certification_end_date: string | null };
const certs: CertRow[] = [];
for (let i = 0; i < clientIds.length; i += 200) {
  const chunk = clientIds.slice(i, i + 200);
  const { data, error } = await sb.from("client_insurance_records")
    .select("client_id,care_level,certification_start_date,certification_end_date")
    .in("client_id", chunk);
  if (error) throw error;
  certs.push(...((data ?? []) as CertRow[]));
}
function careLevelAt(clientId: string, visitDate: string): string | null {
  const own = certs.filter((c) => c.client_id === clientId);
  const active = own.find((c) =>
    (!c.certification_start_date || c.certification_start_date <= visitDate) &&
    (!c.certification_end_date || c.certification_end_date >= visitDate),
  );
  if (active) return active.care_level;
  return own[0]?.care_level ?? null;
}

const rawMismatches = bathRows.filter((r) => {
  if (!r.service_code || !/^12/.test(r.service_code)) return false;
  return isYoboLevel(careLevelAt(r.client_id, r.visit_date));
});
console.log(`★ ① raw: 要支援/事業対象者なのに12xxxxが付いている行: ${rawMismatches.length} 件`);
for (const m of rawMismatches.slice(0, 5)) console.log(`     ${m.id} client=${m.client_id} visit_date=${m.visit_date} code=${m.service_code}`);

// ── ② 集計 scan (実績ベース) ── 訪問記録がある (office, year-month) の組合せごとに集計を回す
//    ★ ここで見ている「12xxxx混入」は 基本コード(121xxx)・加算コード(124/126/128xxx)・
//    虐防/業未の合成コード(121131等)を全部含む (aggregate.ts の出力=最終明細を見るため。
//    2026-09-05: 虐防/業未の予防側スワップ漏れ (B-1w系④) もこの scan で検出できることを
//    負のコントロールで確認済み)。
const officeMonths = new Set(bathRows.map((r) => `${r.office_id}|${r.visit_date.slice(0, 7)}`));
console.log(`\n【分母②】実データがある (事業所×年月) の組合せ: ${officeMonths.size} 件`);
let aggMismatchCount = 0;
const aggMismatchDetail: string[] = [];
for (const key of officeMonths) {
  const [officeId, ym] = key.split("|");
  if (!officeId || officeId === "null") continue;
  const [y, m] = ym.split("-").map(Number);
  const result = await aggregateBathVisitSeikyu(sb, { officeId, tenantId: "kt-group", year: y, month: m });
  for (const row of result.rows) {
    if (!isYoboLevel(row.care_level)) continue;
    const kaigoCodes = row.details.filter((d) => /^12/.test(String(d.service_code ?? "")));
    if (kaigoCodes.length > 0) {
      aggMismatchCount += kaigoCodes.length;
      aggMismatchDetail.push(`${ym} ${row.user_name}(${row.care_level}): ${kaigoCodes.map((d) => d.service_code).join(",")}`);
    }
  }
}
console.log(`★ ② 集計(実績): 要支援/事業対象者の明細に12xxxxが混じっている件数: ${aggMismatchCount} 件`);
for (const d of aggMismatchDetail.slice(0, 5)) console.log(`     ${d}`);

// ── ③ 集計 scan (売上見込 / includeScheduled) ── 2026-09-05 追加。
//    まだ実績記録に落ちていない kaigo_bath_schedule (status=scheduled) の予定分は
//    aggregate.ts が SCHED_CODE で仮のコードを合成する (B-1w系⑤)。①②は raw の
//    kaigo_bath_visit_records しか見ないため、この経路の不整合は①②では検出できない。
type SchedRow = { office_id: string | null; visit_date: string };
const schedRows = await pageAll<SchedRow>(
  "kaigo_bath_schedule",
  "office_id,visit_date",
).catch(() => [] as SchedRow[]); // テーブル未作成 (シフト機能未適用) は空扱い
const schedOfficeMonths = new Set(
  schedRows.filter((r) => r.office_id).map((r) => `${r.office_id}|${r.visit_date.slice(0, 7)}`),
);
console.log(`\n【分母③】売上見込予定 (kaigo_bath_schedule) がある (事業所×年月) の組合せ: ${schedOfficeMonths.size} 件`);
let schedMismatchCount = 0;
const schedMismatchDetail: string[] = [];
for (const key of schedOfficeMonths) {
  const [officeId, ym] = key.split("|");
  const [y, m] = ym.split("-").map(Number);
  const result = await aggregateBathVisitSeikyu(sb, { officeId, tenantId: "kt-group", year: y, month: m, includeScheduled: true });
  for (const row of result.rows) {
    if (!isYoboLevel(row.care_level)) continue;
    const kaigoCodes = row.details.filter((d) => /^12/.test(String(d.service_code ?? "")));
    if (kaigoCodes.length > 0) {
      schedMismatchCount += kaigoCodes.length;
      schedMismatchDetail.push(`${ym} ${row.user_name}(${row.care_level}): ${kaigoCodes.map((d) => d.service_code).join(",")}`);
    }
  }
}
console.log(`★ ③ 集計(売上見込): 要支援/事業対象者の明細に12xxxxが混じっている件数: ${schedMismatchCount} 件`);
for (const d of schedMismatchDetail.slice(0, 5)) console.log(`     ${d}`);

const total = rawMismatches.length + aggMismatchCount + schedMismatchCount;
if (total > 0) {
  console.log(`\n❌ FAIL — B-1wの不整合データが合計 ${total} 件あります (①${rawMismatches.length}+②${aggMismatchCount}+③${schedMismatchCount})。`);
  process.exitCode = 1;
} else {
  console.log(`\n✅ PASS — 不整合データはありません。`);
}
