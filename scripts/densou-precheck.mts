/**
 * 伝送する前の事前点検。**返戻・過大請求の元をデータ側で先に潰す**ためのもの。
 *
 * ══ なぜ要るか ═══════════════════════════════════════════════════════════════
 *   番号や設定の不備は、伝送を作る画面まで行かないと warnings に出ない。
 *   しかも画面は 1 事業所ずつなので、全社を見渡した人はいなかった。
 *   実際 2026-08-31 に「保険者番号 001220」(検証数字が合わない = 返戻になる番号) で
 *   3 名・61,132 円が請求されていたのを、伝送ファイルを読んで初めて見つけた。
 *
 * ══ 使い方 ═══════════════════════════════════════════════════════════════════
 *   npm run check:densou
 *   MONTH=2026-06 npm run check:densou
 *
 *   DB は読み取りのみ。何も書かない。
 *   ⚠ ここが通っても請求が正しいとは限らない。**明らかに落ちるものを先に見つける**だけ。
 *
 * ══ 見るもの ═════════════════════════════════════════════════════════════════
 *   1. 介護保険の保険者番号が検証数字を通るか   (通らないと返戻)
 *   2. 被保険者番号の書式 (英数 10 桁)
 *   3. 障害の市町村番号が検証数字を通るか
 *   4. 上限管理が他事業所なのに管理結果が未入力  (自事業所で 1 割を算定 = 過大請求)
 *   5. 対象月に実績があるのに、その月に有効な認定が無い  (返戻)
 *   6. 事業所番号が 10 桁でない
 *   7. 訪問日の認定の区分と、実績の制度 (介護 / 総合事業) が食い違う  (返戻)  ★ この項目だけ基準値で落とす
 *
 *   ⚠ 検証数字は 介護保険の保険者番号も 障害の市町村番号も **JIS5桁 + modulus10**。
 *     地方公共団体コードの modulus11 とは別物 (feedback_shogai_shichoson_number)。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { isValidInsurerNumber } from "../src/lib/insurer-number";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KAIGO = join(__dirname, "..");
const MONTH = process.env.MONTH ?? "2026-06";
const EOL = String.fromCharCode(10);

function loadEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(join(KAIGO, ".env.local"), "utf8");
    const vars: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const env = loadEnvLocal();
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.log("check:densou: スキップ (env 必要)");
  process.exit(0);
}
const supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** PostgREST は 1 回 1000 行しか返さない。必ず range() で回しきる */
async function fetchAll<T>(table: string, select: string, tweak: (q: never) => unknown = (q) => q): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(select).order("id").range(from, from + PAGE - 1);
    q = tweak(q as never) as typeof q;
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

/** 市町村番号の検証数字 (JIS5桁 + modulus10)。保険者番号と同じ作り */
function mod10CheckDigit(five: string): number | null {
  if (!/^\d{5}$/.test(five)) return null;
  const w = [2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 5; i++) {
    let v = Number(five[i]) * w[i];
    if (v > 9) v = Math.floor(v / 10) + (v % 10);
    sum += v;
  }
  const r = 10 - (sum % 10);
  return r === 10 ? 0 : r;
}
const validMod10Six = (n: string): boolean =>
  /^\d{6}$/.test(n) && String(mod10CheckDigit(n.slice(0, 5))) === n[5];

let problems = 0;
function section(title: string, lines: string[], note?: string): void {
  if (lines.length === 0) {
    console.log(`  OK  ${title}`);
    return;
  }
  problems += lines.length;
  console.log(`${EOL}★ ${title} — ${lines.length} 件`);
  if (note) console.log(`   ${note}`);
  lines.slice(0, 25).forEach((l) => console.log("   " + l));
  if (lines.length > 25) console.log(`   … 他 ${lines.length - 25} 件`);
}

async function main(): Promise<void> {
  console.log(`伝送の事前点検 (${MONTH}) — 返戻・過大請求の元を先に探す`);

  const [y, m] = MONTH.split("-").map(Number);
  const monthStart = `${MONTH}-01`;
  const monthEnd = `${MONTH}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;

  /** その証が対象月にかかっているか。**節をまたいで使うのでここで定義する** */
  const covers = (c: { certification_start_date: string | null; certification_end_date: string | null }): boolean => {
    if (c.certification_start_date && c.certification_start_date > monthEnd) return false;
    if (c.certification_end_date && c.certification_end_date < monthStart) return false;
    return true;
  };

  const clients = await fetchAll<{ id: string; name: string }>("clients", "id, name");
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));

  // ── 1〜2. 介護保険の番号 ─────────────────────────────────────────────
  const certs = await fetchAll<{
    client_id: string; insurer_number: string | null; insured_number: string | null;
    certification_start_date: string | null; certification_end_date: string | null;
    certification_status: string | null; care_level: string | null;
    copay_rate: string | null; service_limit_amount: number | null; effective_date: string | null;
  }>("client_insurance_records",
    "id, client_id, insurer_number, insured_number, certification_start_date, certification_end_date, " +
    "certification_status, care_level, copay_rate, service_limit_amount, effective_date");

  const badInsurer = new Map<string, number>();
  const badInsured: string[] = [];
  for (const c of certs) {
    const ins = (c.insurer_number ?? "").trim();
    if (ins && !isValidInsurerNumber(ins)) {
      const k = `保険者番号 "${ins}" — ${nameOf.get(c.client_id) ?? "?"}`;
      badInsurer.set(k, (badInsurer.get(k) ?? 0) + 1);
    }
    const hi = (c.insured_number ?? "").trim();
    // 被保険者番号は英数 10 桁 (生保の H 始まりなど英字がある)
    if (hi && !/^[0-9A-Za-z]{10}$/.test(hi)) {
      badInsured.push(`被保険者番号 "${hi}" — ${nameOf.get(c.client_id) ?? "?"}`);
    }
  }
  section("介護保険の保険者番号が検証数字を通らない", [...badInsurer.keys()],
    "そのまま伝送すると返戻になる。被保険者証を見て直すこと");
  section("被保険者番号が英数 10 桁でない", [...new Set(badInsured)]);

  // ── 3. 障害の市町村番号 ──────────────────────────────────────────────
  // ⚠ 使う列は必ず select に書くこと。書き忘れると値が undefined になり、
  //   条件分岐が素通りして **チェックが黙って OK を返す**。実際 jogen_kanri_kubun を
  //   select し忘れて「上限管理 OK」と出ていた (2026-08-31)。
  const sho = await fetchAll<{
    client_id: string; insurer_municipality: string | null; beneficiary_number: string | null;
    certification_start_date: string | null; certification_end_date: string | null;
    jogen_kanri_kubun: string | null; jogen_kanri_office_name: string | null;
    jogen_kanri_office_number: string | null;
  }>("shougai_certifications",
    "id, client_id, insurer_municipality, beneficiary_number, certification_start_date, certification_end_date, jogen_kanri_kubun, jogen_kanri_office_name, jogen_kanri_office_number");
  const badCity = new Set<string>();
  for (const s of sho) {
    const n = (s.insurer_municipality ?? "").trim();
    if (n && !validMod10Six(n)) badCity.add(`市町村番号 "${n}" — ${nameOf.get(s.client_id) ?? "?"}`);
  }
  section("障害の市町村番号が検証数字を通らない", [...badCity],
    "1 桁ずれていると返戻になる (地方公共団体コードと混同しやすい)");

  // ── 4. 上限管理が他事業所なのに管理結果が未入力 ───────────────────────
  // 未入力だと自事業所で 1 割 / 負担上限額をそのまま請求してしまう = 過大請求
  const results = await fetchAll<{ client_id: string; target_month: string }>(
    "shogai_jogen_kanri_results", "id, client_id, target_month",
    (q) => (q as unknown as { eq: (a: string, b: string) => unknown }).eq("target_month", MONTH));
  const haveResult = new Set(results.map((r) => r.client_id));
  // ⚠ 判定は **区分が「他事業所」** の行。最初は「区分が入っていれば」で見ていたが、
  //   区分は 534 件が「なし」で、入っているのは 自事業所 17 / 他事業所 25 しかない。
  //   過大請求になるのは **他事業所が管理者なのに結果が無い**ケースなので、そこを見る。
  const missingKanri: string[] = [];
  const missingOwn: string[] = [];
  for (const s of sho) {
    const kubun = (s.jogen_kanri_kubun ?? "").trim();
    if (kubun !== "他事業所" && kubun !== "自事業所") continue;
    if (haveResult.has(s.client_id)) continue;
    const line = `${nameOf.get(s.client_id) ?? "?"} — 管理事業所 ${s.jogen_kanri_office_name ?? "(名称なし)"}`;
    if (kubun === "他事業所") missingKanri.push(line); else missingOwn.push(line);
  }
  section("上限管理が他事業所なのに当月の管理結果が未入力", [...new Set(missingKanri)],
    "未入力だと自事業所で 1 割/上限額をそのまま請求する = 過大請求。管理結果票のとおり入力すること");
  section("自事業所が上限管理者なのに当月の管理結果が未入力", [...new Set(missingOwn)],
    "自社で作る書類なので、作り忘れていないか確認すること");

  // 伝送に載るのは **番号** のほう。名前だけ入っていても項目は空で出る
  const noKanriNumber = sho
    .filter((s2) => (s2.jogen_kanri_kubun ?? "").trim() === "他事業所")
    .filter((s2) => covers(s2))
    .filter((s2) => !(s2.jogen_kanri_office_number ?? "").trim())
    .map((s2) => `${nameOf.get(s2.client_id) ?? "?"} — 管理事業所 ${s2.jogen_kanri_office_name ?? "(名称も未設定)"}`);
  section("上限管理が他事業所なのに 事業所番号 が未設定", [...new Set(noKanriNumber)],
    "伝送に載るのは番号のほう。名前だけでは項目が空で出て返戻になる");

  // ── 5. 実績があるのに対象月に有効な認定が無い ─────────────────────────
  const certOk = new Set(certs.filter(covers).map((c) => c.client_id));
  const shoOk = new Set(sho.filter((s) => covers(s)).map((s) => s.client_id));

  const worked = new Map<string, { kaigo: number; shogai: number; unknown: number }>();
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("kaigo_visit_schedule")
        .select("user_id, system")
        .eq("status", "completed")
        .gte("visit_date", monthStart).lte("visit_date", monthEnd)
        .order("id").range(from, from + PAGE - 1);
      if (error) throw new Error(`kaigo_visit_schedule: ${error.message}`);
      for (const r of (data ?? []) as { user_id: string; system: string | null }[]) {
        const w = worked.get(r.user_id) ?? { kaigo: 0, shogai: 0, unknown: 0 };
        // ⚠ system が未設定の行が実在する (重訪 3,624 件を後から障害に是正した経緯あり)。
        //   未設定を「介護」に倒すと障害の利用者が「認定なし」に化ける。
        //   分からないものは分からないまま数え、判定を緩める。
        if (r.system === "障害") w.shogai++;
        else if (r.system === "介護") w.kaigo++;
        else w.unknown++;
        worked.set(r.user_id, w);
      }
      if (!data || data.length < PAGE) break;
    }
  }
  const noCert: string[] = [];
  for (const [cid, w] of worked) {
    const nm = nameOf.get(cid) ?? "?";
    if (w.kaigo > 0 && !certOk.has(cid)) noCert.push(`${nm} 介護 ${w.kaigo} 件 — 対象月に有効な認定なし`);
    if (w.shogai > 0 && !shoOk.has(cid)) noCert.push(`${nm} 障害 ${w.shogai} 件 — 対象月に有効な受給者証なし`);
    // 制度が分からない行は、どちらの資格も無いときだけ挙げる
    if (w.unknown > 0 && !certOk.has(cid) && !shoOk.has(cid)) {
      noCert.push(`${nm} 制度未設定 ${w.unknown} 件 — 介護・障害どちらの資格も対象月に無い`);
    }
  }
  section("実績があるのに対象月に有効な認定・受給者証が無い", noCert,
    "資格が切れているか、認定の取込が古い。そのまま請求すると返戻になる");

  // ── 5.5 認定が申請中のため当月の請求を保留した利用者 (2026-09-05 追加) ──
  // ⚠ これは aggregate.ts / aggregate-sougou.ts が「ほのぼの準拠」で意図的に行っている
  //   保留 (バグではない)。ただし当方の certification_status は取込CSVスナップショットの
  //   ままで自動更新されないため、ほのぼの側で既に認定が確定していても当方だけ保留し続け、
  //   気づかないまま請求が漏れ続けるリスクがある (B-6f)。月をまたぐたび対象が変わるので
  //   ★基準値方式にはしない (①②とは性質が違う)。実績が0件の人はノイズになるため
  //   一覧には出さず、件数だけ集計する。
  {
    const certCompleteness = (c: { copay_rate: string | null; care_level: string | null; service_limit_amount: number | null }): number =>
      (c.copay_rate == null || c.copay_rate === "" ? 0 : 4) +
      (c.care_level == null || c.care_level === "" ? 0 : 2) +
      (c.service_limit_amount == null ? 0 : 1);

    const byClientCert = new Map<string, typeof certs>();
    for (const c of certs) { if (!byClientCert.has(c.client_id)) byClientCert.set(c.client_id, []); byClientCert.get(c.client_id)!.push(c); }

    const pendingHeld: { client_id: string; cert: (typeof certs)[number] }[] = [];
    for (const [cid, list] of byClientCert) {
      const inMonth = list.filter(covers);
      if (inMonth.length === 0) continue;
      // cert-for-month.ts と同じ並び (start DESC, effective DESC) + 同着は completeness で決定
      inMonth.sort((a, b) => {
        const s = (b.certification_start_date ?? "").localeCompare(a.certification_start_date ?? "");
        if (s !== 0) return s;
        return (b.effective_date ?? "").localeCompare(a.effective_date ?? "");
      });
      const head = inMonth[0];
      let best = head, bestScore = certCompleteness(head);
      for (const r of inMonth) {
        if (r.certification_start_date !== head.certification_start_date || r.effective_date !== head.effective_date) break;
        const s = certCompleteness(r);
        if (s > bestScore) { best = r; bestScore = s; }
      }
      if (best.certification_status === "申請中") pendingHeld.push({ client_id: cid, cert: best });
    }

    const withVisit = pendingHeld.filter((p) => (worked.get(p.client_id)?.kaigo ?? 0) > 0);

    if (pendingHeld.length === 0) {
      console.log(`${EOL}  OK  認定が申請中のため当月の請求を保留した利用者 — 0 件`);
    } else {
      console.log(`${EOL}★ 認定が申請中のため当月の請求を保留した利用者 — 保留 ${pendingHeld.length} 名 / うち当月実績あり ${withVisit.length} 名`);
      console.log(`   ⚠ これは仕様どおりの保留 (バグではない)。ただし当方のstatusは取込CSV`);
      console.log(`     スナップショットのままなので、ほのぼの側で既に確定していても気づけない。`);
      console.log(`     実績が無い人は一覧に出していない (0件はノイズになるため)。`);
      if (withVisit.length > 0) {
        // 事業所 (現在有効な割当のみ)
        const officeAssigns = await fetchAll<{ client_id: string; office_id: string; start_date: string | null; end_date: string | null }>(
          "client_office_assignments", "id, client_id, office_id, start_date, end_date",
          (q) => (q as unknown as { in: (a: string, b: string[]) => unknown }).in("client_id", withVisit.map((p) => p.client_id)));
        const officeIds = [...new Set(officeAssigns.map((a) => a.office_id))];
        const officeRows = await fetchAll<{ id: string; name: string; short_name: string | null }>(
          "offices", "id, name, short_name", (q) => (q as unknown as { in: (a: string, b: string[]) => unknown }).in("id", officeIds));
        const officeName = new Map(officeRows.map((o) => [o.id, o.short_name || o.name]));
        const officeOf = new Map<string, string>();
        for (const a of officeAssigns) {
          if (a.end_date && a.end_date < monthStart) continue;
          if (a.start_date && a.start_date > monthEnd) continue;
          if (!officeOf.has(a.client_id)) officeOf.set(a.client_id, officeName.get(a.office_id) ?? a.office_id);
        }
        for (const p of withVisit.slice(0, 25)) {
          const nm = nameOf.get(p.client_id) ?? "?";
          const off = officeOf.get(p.client_id) ?? "(割当不明)";
          const c = p.cert;
          console.log(`   ${nm}  事業所:${off}  保険者${c.insurer_number ?? "?"} 被保番${c.insured_number ?? "?"}` +
            `  申請中の認定期間 ${c.certification_start_date ?? "?"}〜${c.certification_end_date ?? "?"}` +
            `  当月実績 ${worked.get(p.client_id)?.kaigo ?? 0} 件`);
        }
        if (withVisit.length > 25) console.log(`   … 他 ${withVisit.length - 25} 名`);
      }
    }
  }

  // ── 6. 事業所番号 ────────────────────────────────────────────────────
  const offices = await fetchAll<{ name: string; business_number: string | null; shogai_business_number: string | null; is_active: boolean | null }>(
    "offices", "id, name, business_number, shogai_business_number, is_active");
  const badOffice: string[] = [];
  for (const o of offices) {
    if (o.is_active === false) continue;
    const bn = (o.business_number ?? "").trim();
    if (bn && !/^\d{10}$/.test(bn)) badOffice.push(`${o.name}: 事業所番号 "${bn}"`);
    const sbn = (o.shogai_business_number ?? "").trim();
    if (sbn && !/^\d{10}$/.test(sbn)) badOffice.push(`${o.name}: 障害事業所番号 "${sbn}"`);
  }
  section("事業所番号が 10 桁でない", badOffice);

  // ── 7. 訪問日の認定の区分 と 実績の制度 (介護 / 総合事業) の食い違い (2026-11-12 追加) ──
  // 要介護の人を総合事業で出すと返戻、要支援の人を介護で出しても返戻。
  // 2026-11-12 に提供票一覧 (check:teikyohyo-diff) で見つかった: 要支援 → 要介護 に変わった後も、
  // 取込元 MEISAI のサービス名が区分変更前 (訪問型独自サービス) のままで、総合事業として入っていた。
  // ★ この項目だけ 月ごとの既知件数 を超えたら exit 1 にする (他の項目は従来どおり一覧のみ)。
  //   既知件数は「直すまでの間の現状」。直したら 0 に下げること。悪化したまま上げないこと。
  //   判定不能 (その日に有効な認定が 0 件 / 区分の違う認定が 2 件以上) も見張る。増えたら判定そのものが怪しい
  const SYSTEM_CARE_LEVEL_KNOWN: Record<string, { sougouButKaigo: number; kaigoButShien: number; undecidable: number }> = {
    // 東城 宏三 4 回 / 市川 博義 2 回 / 荻野 秀之 1 回 (全社・全月で数えてこの 7 回だけ。2026-11-12)
    "2026-06": { sougouButKaigo: 7, kaigoButShien: 0, undecidable: 0 },
  };
  const gateFails: string[] = [];
  {
    const visits: { user_id: string; visit_date: string; system: string }[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("kaigo_visit_schedule")
        .select("user_id, visit_date, system")
        .eq("status", "completed").in("system", ["介護", "総合事業"])
        .gte("visit_date", monthStart).lte("visit_date", monthEnd)
        .order("id").range(from, from + PAGE - 1);
      if (error) throw new Error(`kaigo_visit_schedule (制度と認定): ${error.message}`);
      visits.push(...((data ?? []) as { user_id: string; visit_date: string; system: string }[]));
      if (!data || data.length < PAGE) break;
    }
    const certsByClient = new Map<string, typeof certs>();
    for (const c of certs) { if (!certsByClient.has(c.client_id)) certsByClient.set(c.client_id, []); certsByClient.get(c.client_id)!.push(c); }
    const group = (lv: string | null): string | null =>
      !lv ? null : /^要介護/.test(lv) ? "要介護" : /^要支援|事業対象/.test(lv) ? "要支援" : null;
    const sougouButKaigo = new Map<string, number>(), kaigoButShien = new Map<string, number>(), undecidable = new Map<string, number>();
    const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const v of visits) {
      const valid = (certsByClient.get(v.user_id) ?? []).filter((c) =>
        c.certification_start_date && c.certification_start_date <= v.visit_date &&
        (!c.certification_end_date || c.certification_end_date >= v.visit_date));
      const groups = new Set(valid.map((c) => group(c.care_level)));
      const nm = nameOf.get(v.user_id) ?? "?";
      if (valid.length === 0 || groups.size !== 1 || groups.has(null)) { add(undecidable, `${nm} (${v.system}) — ${valid.length === 0 ? "その日に有効な認定なし" : "区分の違う認定が重複 / 区分が読めない"}`); continue; }
      const g = [...groups][0];
      if (v.system === "総合事業" && g === "要介護") add(sougouButKaigo, `${nm} — 総合事業の実績だが その日は要介護`);
      if (v.system === "介護" && g === "要支援") add(kaigoButShien, `${nm} — 介護の実績だが その日は要支援`);
    }
    const fmt = (m: Map<string, number>) => [...m].map(([k, n]) => `${k} ${n} 回`);
    const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    console.log(`${EOL}  [7] 母数: ${MONTH} の 介護/総合事業 の実績 ${visits.length} 回`);
    section("総合事業の実績なのに その日の認定が要介護 (返戻)", fmt(sougouButKaigo),
      "取込元 MEISAI のサービス名が区分変更前のままのことがある。system とサービス名を介護に直す (取込も直さないと巻き戻る)");
    section("介護の実績なのに その日の認定が要支援 (返戻)", fmt(kaigoButShien));
    section("制度と認定を突き合わせられない (その日に有効な認定が無い / 区分の違う認定が重複)", fmt(undecidable),
      "判定不能。増えたら この点検の判定そのものを疑うこと");
    const known = SYSTEM_CARE_LEVEL_KNOWN[MONTH] ?? { sougouButKaigo: 0, kaigoButShien: 0, undecidable: 0 };
    const now = { sougouButKaigo: total(sougouButKaigo), kaigoButShien: total(kaigoButShien), undecidable: total(undecidable) };
    for (const k of Object.keys(now) as (keyof typeof now)[]) {
      if (now[k] > known[k]) gateFails.push(`[7] ${k}: 既知 ${known[k]} 回 → ${now[k]} 回 (増えた)`);
      else if (now[k] < known[k]) console.log(`   ○ [7] ${k}: 既知 ${known[k]} 回 → ${now[k]} 回 (減った。SYSTEM_CARE_LEVEL_KNOWN を下げてよい)`);
    }
  }

  console.log("");
  if (gateFails.length > 0) {
    console.log("✗ FAIL (基準値で見張っている項目が悪化した)");
    for (const f of gateFails) console.log("  " + f);
    process.exit(1);
  }
  if (problems === 0) {
    console.log("PASS — 事前点検で引っかかるものはありません");
    process.exit(0);
  }
  console.log(`${problems} 件が引っかかりました。★ の項目を上から潰してください。`);
  console.log("(この点検が通っても請求が正しいとは限りません。明らかに落ちるものを先に見つけるだけです)");
  // 見つけること自体が目的なので、落ちても exit 1 にはしない
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error("check:densou 実行エラー:", e instanceof Error ? e.message : e);
  process.exit(1);
});
