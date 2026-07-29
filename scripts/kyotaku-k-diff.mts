/**
 * 居宅 給付管理票 (K ファイル / 8222) 突合ハーネス (READ ONLY — DB 書込なし)
 *
 * 実DB から kyufuUsers を組み立て (_kokuho-seikyu.tsx と同じ解決順: 事業所割当 →
 * claims → resolveCertForMonth → kaigo_benefit_management → care_plans)、
 * 実 builder (buildKyufuKanriFile) で K ファイルをヘッドレス生成し、ほのぼのの
 * 正解伝送 KY260701 と (保険者, 被保番) 単位で内容突合する。
 *
 * 正規化 (既知の家風差): クォート / 連番 / 作成年月日 / 票内明細行順。
 * ほのぼの側は対象年月 = 対象月のみ (KY は月遅れを含むため)。
 *
 * 実行:  npx tsx scripts/kyotaku-k-diff.mts
 *   env: OFFICE_ID / AREA_DIR (伝送データ/<AREA>/居宅/202606)。既定 = おゆみ野
 *   出力: 伝送データ/<AREA>/居宅/202606/新システム/K202606.CSV (SJIS 上書き) + diff レポート
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Encoding from "encoding-japanese";
import { buildKyufuKanriFile, SERVICE_KIND_CODE, type KyufuKanriUser } from "@/lib/kokuho-densou/build-kyotaku";
import { resolveCertForMonth } from "@/lib/cert-for-month";
import { parseYoboShienKubun } from "@/app/(authenticated)/billing/claims/claims-shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

const YEAR = 2026;
const MONTH = 6;
const MONTH_KEY = `${YEAR}-${String(MONTH).padStart(2, "0")}`;
const YM = `${YEAR}${String(MONTH).padStart(2, "0")}`;
const OFFICE_ID = process.env.OFFICE_ID || "1b22d425-2ec4-4c2f-a002-c1c994e94507"; // おゆみ野
const AREA_DIR = process.env.AREA_DIR || "おゆみ野";
const BASE = join(__dirname, "..", "伝送データ", AREA_DIR, "居宅", YM);
const KY_FILE = process.env.KY_FILE || "KY260701.CSV";

function loadEnvLocal(): Record<string, string> {
  const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
    if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}
const envFile = loadEnvLocal();
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? envFile.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? envFile.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const CHUNK = 50;
const chunk = <T,>(a: T[], n: number): T[][] => {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
};

async function main() {
  // 0) 事業所 (番号)
  const { data: office, error: oe } = await sb
    .from("offices").select("name, business_number").eq("id", OFFICE_ID).single();
  if (oe || !office?.business_number) throw new Error(`office 取得失敗: ${oe?.message}`);
  console.log(`=== 居宅 K突合 ${AREA_DIR} (${office.name} ${office.business_number}) ${MONTH_KEY} ===`);

  // 1) 事業所割当の利用者
  const clientIds: string[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("client_office_assignments").select("client_id")
      .eq("office_id", OFFICE_ID).order("client_id").range(f, f + 999);
    if (error) throw error;
    clientIds.push(...(data ?? []).map((r) => r.client_id as string));
    if (!data || data.length < 1000) break;
  }

  // 2) 当月 claims (請求対象 = 予防委託以外)
  type Claim = { user_id: string; notes: string | null; clients: { name: string | null } | null };
  const claims: Claim[] = [];
  for (const ids of chunk(clientIds, CHUNK)) {
    const { data, error } = await sb.from("kaigo_care_support_claims")
      .select("user_id, notes, clients(name)").eq("billing_month", MONTH_KEY).in("user_id", ids);
    if (error) throw error;
    claims.push(...((data ?? []) as unknown as Claim[]));
  }
  const billable = claims.filter((c) => parseYoboShienKubun(c.notes) !== "itaku");
  const userIds = [...new Set(billable.map((c) => c.user_id))];
  const nameByUser = new Map(billable.map((c) => [c.user_id, c.clients?.name ?? "(名前未取得)"]));
  console.log(`claims 利用者: ${userIds.length}名`);

  // 3) 認定 (対象月有効) — 実アプリと同じ共有リゾルバ
  const certRes = await resolveCertForMonth(sb, userIds, YEAR, MONTH);

  // 4) 給付管理 (kaigo_benefit_management)
  type Ben = { user_id: string; service_type: string; service_kind_code: string | null; shitei_kubun: string | null; provider_number: string | null; planned_units: number | null };
  const benRows: Ben[] = [];
  for (const ids of chunk(userIds, CHUNK)) {
    const { data, error } = await sb.from("kaigo_benefit_management")
      .select("user_id, service_type, service_kind_code, shitei_kubun, provider_number, planned_units")
      .eq("billing_month", MONTH_KEY).in("user_id", ids);
    if (error) throw error;
    benRows.push(...((data ?? []) as Ben[]));
  }
  const byUser = new Map<string, Ben[]>();
  for (const r of benRows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id)!.push(r);
  }

  // 5) ケアマネ番号 (kaigo_care_plans active)
  const cmByUser = new Map<string, string | null>();
  for (const ids of chunk(userIds, 300)) {
    const { data } = await sb.from("kaigo_care_plans").select("user_id, care_manager_number")
      .in("user_id", ids).eq("status", "active");
    for (const p of (data ?? []) as { user_id: string; care_manager_number: string | null }[])
      if (!cmByUser.has(p.user_id)) cmByUser.set(p.user_id, p.care_manager_number ?? null);
  }

  // 6) kyufuUsers (要支援は Y ファイル側なので除外し件数のみ表示)
  let yobo = 0;
  const users: KyufuKanriUser[] = [];
  for (const uid of userIds) {
    const cert = certRes.get(uid);
    const rows = byUser.get(uid);
    if (!rows || rows.length === 0) continue;
    if ((cert?.care_level ?? "").startsWith("要支援")) { yobo++; continue; }
    users.push({
      userName: nameByUser.get(uid) ?? "",
      insurerNumber: cert?.insurer_number ?? "",
      insuredNumber: cert?.insured_number ?? "",
      birthDate: null, // clients から下で補完
      gender: null,
      careLevel: cert?.care_level ?? null,
      limitStart: cert?.limit_period_start ?? cert?.certification_start_date ?? null,
      limitEnd: cert?.limit_period_end ?? cert?.certification_end_date ?? null,
      limitUnits: cert?.service_limit_amount ?? 0,
      careManagerNumber: cmByUser.get(uid) ?? null,
      lines: rows.map((r) => ({
        officeNumber: (r.provider_number ?? "").trim(),
        serviceKindCode: (r.service_kind_code ?? "").trim() || SERVICE_KIND_CODE[r.service_type] || "",
        shiteiKubun: r.shitei_kubun ?? null,
        plannedUnits: r.planned_units ?? 0,
      })),
      _uid: uid,
    } as KyufuKanriUser & { _uid: string });
  }
  if (yobo) console.log(`要支援 (Yファイル側): ${yobo}名 を除外`);

  // 生年月日/性別を clients から補完 (_kokuho-seikyu は claims join の clients を使う)
  const uids = users.map((u) => (u as unknown as { _uid: string })._uid);
  const demo = new Map<string, { birth_date: string | null; gender: string | null }>();
  for (const ids of chunk(uids, CHUNK)) {
    const { data } = await sb.from("clients").select("id, birth_date, gender").in("id", ids);
    for (const c of (data ?? []) as { id: string; birth_date: string | null; gender: string | null }[])
      demo.set(c.id, c);
  }
  for (const u of users) {
    const d = demo.get((u as unknown as { _uid: string })._uid);
    u.birthDate = d?.birth_date ?? null;
    u.gender = d?.gender ?? null;
  }

  // 7) build + 出力
  const f = buildKyufuKanriFile(users, {
    officeNumber: office.business_number, year: YEAR, month: MONTH, unitPrice: 10,
  });
  for (const w of f.warnings) console.log("  ⚠", w);
  const outDir = join(BASE, "新システム");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const sjis = Encoding.convert(Encoding.stringToCode(f.content), { to: "SJIS", from: "UNICODE" });
  writeFileSync(join(outDir, f.fileName), Buffer.from(sjis));
  console.log(`出力: 新システム/${f.fileName} (${f.dataRecordCount} レコード)`);

  // 8) KY と突合 (正規化: クォート / 連番 / 作成年月日 / 明細行番号)
  const norm = (p: string, filterYm: string | null) => {
    const groups = new Map<string, string[]>();
    for (const l of readFileSync(p, "latin1").split(/\r?\n/)) {
      if (!l.trim()) continue;
      const r = l.split(",").map((x) => x.replace(/^"(.*)"$/, "$1"));
      if (r[0] !== "2" || r[2] !== "8222") continue;
      if (filterYm && r[3] !== filterYm) continue;
      r[1] = "*"; r[7] = "*";
      if (r[9] !== "99") r[9] = "*";
      const k = `${r[4]}|${r[10]}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r.join(","));
    }
    for (const v of groups.values()) v.sort();
    return groups;
  };
  const N = norm(join(outDir, f.fileName), null);
  const H = norm(join(BASE, "ほのぼのから", KY_FILE), YM);
  let match = 0; const diffs: string[] = [];
  for (const [k, nv] of N) {
    const hv = H.get(k);
    if (!hv) { diffs.push(`ONLY-NEW ${k}`); continue; }
    if (nv.join("\n") === hv.join("\n")) match++;
    else {
      diffs.push(`DIFF ${k}`);
      for (let i = 0; i < Math.max(nv.length, hv.length); i++)
        if (nv[i] !== hv[i]) diffs.push(`  new : ${nv[i] ?? "(なし)"}\n  hono: ${hv[i] ?? "(なし)"}`);
    }
  }
  for (const k of H.keys()) if (!N.has(k)) diffs.push(`ONLY-HONO ${k}`);
  console.log(`\n突合: new ${N.size} 票 / hono ${H.size} 票 → 一致 ${match} / 差 ${diffs.filter((d) => !d.startsWith("  ")).length}`);
  for (const d of diffs.slice(0, 40)) console.log(d);
  if (diffs.length === 0) console.log("✅ 完全一致");
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
