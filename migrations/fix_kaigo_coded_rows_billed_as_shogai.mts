// ============================================================================
// 介護コードで記録された稼働を、ほのぼのが障害で請求している分を 障害の実績として補う
//
//   TARGET_MONTH=2026-06 npx tsx migrations/fix_kaigo_coded_rows_billed_as_shogai.mts            # DRY RUN
//   TARGET_MONTH=2026-06 npx tsx migrations/fix_kaigo_coded_rows_billed_as_shogai.mts --execute  # 本番 INSERT
//   AREAS=高品,袖ケ浦 で拠点を絞れる
//
// ── なぜ要るか (2026-10-06 実測) ──────────────────────────────────────────
//   両制度を持つ利用者の訪問が、MEISAI では **介護のコード** (111111 身体介護1 等) で
//   記録されているのに、ほのぼのは **障害で請求**している行がある。
//   この行は 2 つの取込の隙間に落ちて、当方では **どちらの制度でも 1 行も入らない**。
//
//     介護の取込  import_meisai_visit_records.mjs   … 介護請求(明細付)_一覧 に載る行だけ入れる
//                                                    (ほのぼのは障害で請求したので載らない)
//     障害の取込  import_meisai_shougai_records.mjs … 021xxx / 010xxx のコードの行だけ読む
//                                                    (介護コードの行は読まない)
//
//   202606 全拠点で 5 名 32 回 (高品 加茂照子 23 / 佐藤枝梨子 4 / 吉田千里 2 /
//   袖ケ浦 友寄大 2 / ちはら台 郡司桜 1 (2人派遣))。
//   加茂照子は SESSION_START「④まるごと欠落している 6 名」の 1 人で、原因はこれだった。
//   ⚠ 逆向き (障害コードの行を ほのぼのが介護で請求) は fix_shogai_rows_billed_as_kaigo.mjs。
//
// ── 何を根拠に補うか (推測しない) ─────────────────────────────────────────
//   ① ほのぼのの TJ (障害 実績記録票 J611) に その (受給者, 日, 開始時刻) の提供がある
//   ② 当方にはその (利用者, 日, 開始時刻) の実績が **どの制度でも 1 行も無い**
//   ③ MEISAI に その (利用者名, 日, 派遣開始) の行があり、コードが 021xxx/010xxx ではない
//   制度の決定に TJ (ほのぼのの出力) を使うのは set_schedule_system_from_densou.mjs と同じ
//   移行期の足場。★ コード・時刻・算定時間は MEISAI (入力側) から引く。TJ は照合にだけ使う。
//
// ── 止める条件 (1 行も書かない) ───────────────────────────────────────────
//   ・受給者証番号から利用者が 1 名に決まらない
//   ・同じ枠に MEISAI 行が 3 行以上 / TJ は 2 人なのに MEISAI が 1 行
//   ・コードが引けない、または MEISAI の算定時間が TJ の算定時間と食い違う
//
// ── 冪等 ─────────────────────────────────────────────────────────────────
//   notes に `[MEISAI障害補完 <月> <拠点> code=<6桁>]` を付け、--execute は
//   その事業所・その月の同じマーカー行を消してから入れる。
//   取込 2 本の削除条件 ("[MEISAI障害取込%" / "[MEISAI取込%") には当たらないので、
//   取込を回し直しても消えない。★ ただし取込を回し直したら、この script も回し直して
//   DRY RUN が「補う行 0」になることを確認すること (取込側が拾うようになったら二重になる)。
// ============================================================================
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Encoding from "encoding-japanese";
import {
  loadShogaiCodeMaps,
  shogaiCodeFromTime,
  kindFromServiceName,
  quantizeHours,
  stepMinutesOf,
} from "@/lib/shogai-seikyu/code-from-time";

const EXECUTE = process.argv.includes("--execute");
const TARGET_MONTH = process.env.TARGET_MONTH ?? "2026-06";
const YM = TARGET_MONTH.replace("-", "");
const [Y, M] = TARGET_MONTH.split("-").map(Number);
const MONTH_FIRST = `${TARGET_MONTH}-01`;
const NEXT_FIRST = M === 12 ? `${Y + 1}-01-01` : `${Y}-${String(M + 1).padStart(2, "0")}-01`;
const ONLY = (process.env.AREAS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const MARK = "[MEISAI障害補完";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const env: Record<string, string> = {};
for (const l of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("✗ .env.local に NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY がありません");
  process.exit(1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const sjisLines = (f: string) =>
  (Encoding.convert(readFileSync(f), { to: "UNICODE", from: "SJIS", type: "string" }) as unknown as string)
    .split(/\r?\n/);
const hhmm = (s: string | null | undefined) => (s ?? "").replace(":", "").slice(0, 4);
const toHM = (s: string) => (/^\d{4}$/.test(s) ? `${s.slice(0, 2)}:${s.slice(2)}` : s);
const normName = (n: string | null | undefined) => (n ?? "").replace(/[\s　]/g, "").replace(/[（(].*$/, "");
const normStaff = (n: string | null | undefined) => (n ?? "").replace(/[\s　]/g, "").replace(/様$/, "");
/** MEISAI の算定時間 "001:30" → 90 分 */
const santeiMin = (s: string) => {
  const m = /^(\d+):(\d{2})$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
/** TJ の算定時間 c[17] は 10進時間 ×100 ("0150" = 1.5h) */
const tjMin = (s: string) => (/^\d{4}$/.test(s) ? Math.round((Number(s) / 100) * 60) : null);

type SelectQuery = ReturnType<ReturnType<typeof sb.from>["select"]>;
async function fetchAll<T>(table: string, select: string, f: (q: SelectQuery) => SelectQuery): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(sb.from(table).select(select)).order("id").range(from, from + 999);
    if (error) throw new Error(`${table} 取得失敗: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) return out;
  }
}

type Office = { id: string; tenant_id: string; shogai_business_number: string | null };
type MeisaiRow = {
  file: string; staff: string; client: string; date: string; start: string; end: string;
  santeiStart: string; santeiEnd: string; santei: string; svc: string; svcType: string; code: string;
};

async function main() {
  console.log(`=== 介護コード行の障害補完 ${EXECUTE ? "【本番 EXECUTE】" : "【DRY RUN】"} 対象月=${TARGET_MONTH} ===\n`);

  const offices = await fetchAll<Office>("offices", "id,tenant_id,shogai_business_number", (q) => q.not("shogai_business_number", "is", null));
  const officeByBn = new Map(offices.map((o) => [o.shogai_business_number!, o]));
  const certs = await fetchAll<{ id: string; client_id: string; beneficiary_number: string }>(
    "shougai_certifications", "id,client_id,beneficiary_number", (q) => q);
  const clientsByBn = new Map<string, Set<string>>();
  for (const c of certs) {
    if (!clientsByBn.has(c.beneficiary_number)) clientsByBn.set(c.beneficiary_number, new Set());
    clientsByBn.get(c.beneficiary_number)!.add(c.client_id);
  }
  const sched = await fetchAll<{ id: string; user_id: string; visit_date: string; start_time: string | null }>(
    "kaigo_visit_schedule", "id,user_id,visit_date,start_time",
    (q) => q.gte("visit_date", MONTH_FIRST).lt("visit_date", NEXT_FIRST));
  const haveSlot = new Set(sched.map((s) => `${s.user_id}|${s.visit_date}|${hhmm(s.start_time)}`));
  const members = await fetchAll<{ id: string; name: string }>("members", "id,name", (q) => q);
  const memberByName = new Map<string, string[]>();
  for (const m of members) {
    const k = normStaff(m.name);
    if (!memberByName.has(k)) memberByName.set(k, []);
    memberByName.get(k)!.push(m.id);
  }
  const maps = await loadShogaiCodeMaps(sb, Y, M);

  const stops: string[] = [];
  const plans: { area: string; office: Office; rows: Record<string, unknown>[]; label: string[] }[] = [];

  for (const area of readdirSync(join(ROOT, "伝送データ"))) {
    if (ONLY.length && !ONLY.includes(area)) continue;
    const tjDir = join(ROOT, "伝送データ", area, "訪問介護", "障害", YM, "ほのぼのから");
    if (!existsSync(tjDir)) continue;
    const kj = readdirSync(tjDir).find((f) => /^KJ.*\.CSV$/i.test(f));
    if (!kj) continue;
    const bnOffice = (sjisLines(join(tjDir, kj))[0] ?? "").split(",")[6]?.replace(/"/g, "").trim() ?? "";
    const office = officeByBn.get(bnOffice);
    if (!office) { stops.push(`${area}: 障害事業所番号 ${bnOffice} が offices に無い`); continue; }

    const tj = readdirSync(tjDir).filter((f) => /^TJ.*\.CSV$/i.test(f))
      .flatMap((f) => sjisLines(join(tjDir, f)))
      .map((l) => l.replace(/"/g, "").split(","))
      .filter((c) => c[0] === "2" && c[2] === "J611" && c[3] === "02");

    const mDir = join(ROOT, "サービス実績データ", area, YM, "訪問介護");
    const meisai: MeisaiRow[] = [];
    for (const sub of ["介護", "障害"]) {
      const d = join(mDir, sub);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => /MEISAI/i.test(x))) {
        const lines = sjisLines(join(d, f));
        const head = (lines[0] ?? "").split(",");
        const ix = (n: string) => head.indexOf(n);
        for (const l of lines.slice(1)) {
          if (!l) continue;
          const c = l.split(",");
          const g = (n: string) => (ix(n) >= 0 ? (c[ix(n)] ?? "").trim() : "");
          meisai.push({
            file: `${sub}/${f}`, staff: g("職員名"), client: g("利用者名"),
            date: g("日付").replace(/\//g, "-"), start: g("派遣開始時間"), end: g("派遣終了時間"),
            santeiStart: g("算定開始時刻") || g("派遣開始時間"), santeiEnd: g("算定終了時刻") || g("派遣終了時間"),
            santei: g("算定時間"), svc: g("サービス"), svcType: g("サービス型"), code: g("サービスコード"),
          });
        }
      }
    }

    const names = new Map<string, string>();
    const rows: Record<string, unknown>[] = [];
    const label: string[] = [];
    for (const c of tj) {
      const bn = c[7], day = c[10].padStart(2, "0"), tjStart = c[15], tjEnd = c[16];
      const date = `${TARGET_MONTH}-${day}`;
      const cl = [...(clientsByBn.get(bn) ?? [])];
      if (cl.some((u) => haveSlot.has(`${u}|${date}|${tjStart}`))) continue; // ② 当方に既にある
      if (cl.length !== 1) { if (cl.length > 1) stops.push(`${area} ${bn} ${date}: 受給者証から利用者が ${cl.length} 名`); continue; }
      const uid = cl[0];
      if (!names.has(uid)) {
        const { data, error } = await sb.from("clients").select("name").eq("id", uid).single();
        if (error) throw new Error(`clients 取得失敗: ${error.message}`);
        names.set(uid, normName(data?.name));
      }
      const nm = names.get(uid)!;
      // ③ MEISAI の同じ枠。021xxx/010xxx は障害の取込が読む行なので対象外 (読み落としではない)
      const hits = meisai.filter((r) => normName(r.client).startsWith(nm) && r.date === date && hhmm(r.start) === tjStart);
      const kaigoCoded = hits.filter((r) => !/^0[12]\d{4}$/.test(r.code));
      if (!kaigoCoded.length) continue; // 介護コード行ではない欠落 (別の型。ここでは扱わない)
      const who = `${area} ${bn} ${nm} ${date} ${toHM(tjStart)}-${toHM(tjEnd)}`;
      const tjTwo = c[20] === "2";
      if (kaigoCoded.length > 2) { stops.push(`${who}: MEISAI 行が ${kaigoCoded.length} 行`); continue; }
      if (tjTwo && kaigoCoded.length !== 2) { stops.push(`${who}: TJ は 2 人だが MEISAI は ${kaigoCoded.length} 行`); continue; }
      if (!tjTwo && kaigoCoded.length !== 1) { stops.push(`${who}: TJ は 1 人だが MEISAI は ${kaigoCoded.length} 行`); continue; }
      // ほのぼのは 同じ利用者の **切れ目なく続く訪問** (職員が交代しても) を 1 本にまとめて請求する。
      //   高品 加茂照子 6/8: MEISAI 08:30-09:00 身1 + 09:00-10:00 身2 → TJ 08:30-10:00 算定 1.5h
      //   TJ の終了まで MEISAI の介護コード行が隙間なく続き、種別も同じときだけ 1 本に束ねる。
      let units: MeisaiRow[] = kaigoCoded;
      if (!tjTwo && hhmm(kaigoCoded[0].end) !== tjEnd) {
        const chain = [kaigoCoded[0]];
        while (hhmm(chain[chain.length - 1].end) < tjEnd) {
          const last = chain[chain.length - 1];
          const next = meisai.filter((r) => normName(r.client).startsWith(nm) && r.date === date &&
            !/^0[12]\d{4}$/.test(r.code) && hhmm(r.start) === hhmm(last.end));
          if (next.length !== 1) break;
          chain.push(next[0]);
        }
        const kinds = new Set(chain.map((r) => kindFromServiceName(r.svcType) ?? kindFromServiceName(r.svc)));
        const mins = chain.map((r) => santeiMin(r.santei));
        if (chain.length > 1 && hhmm(chain[chain.length - 1].end) === tjEnd && kinds.size === 1 && mins.every((m) => m != null)) {
          const sum = mins.reduce((a, b) => a! + b!, 0)!;
          units = [{
            ...chain[0],
            end: chain[chain.length - 1].end, santeiEnd: chain[chain.length - 1].santeiEnd,
            santei: `${String(Math.floor(sum / 60)).padStart(3, "0")}:${String(sum % 60).padStart(2, "0")}`,
            code: chain.map((r) => r.code).join("+"), svc: chain.map((r) => r.svc).join("+"),
          }];
        }
      }
      units.forEach((r, i) => {
        // 「サービス」欄は「身1」等の略称で種別が判定できない。「サービス型」(身体介護 / 生活援助) で決める
        const kind = kindFromServiceName(r.svcType) ?? kindFromServiceName(r.svc.split("+")[0]);
        const min = santeiMin(r.santei);
        const tm = tjMin(c[17]);
        // TJ の算定時間は区分に丸めた後の値 (40 分 → 1.0h)。MEISAI も同じ規則で丸めてから比べる
        const qMin = kind && min != null ? Math.round(quantizeHours(min, stepMinutesOf(kind), "honobono") * 60) : null;
        if (qMin == null || tm == null || qMin !== tm) {
          stops.push(`${who}: 算定時間 MEISAI ${r.santei} / TJ ${c[17]} が一致しない`);
          return;
        }
        const hit = kind ? shogaiCodeFromTime(maps, kind, r.santeiStart, r.santeiEnd, { minutes: min ?? undefined, twoPerson: i === 1 }) : null;
        if (!hit) { stops.push(`${who}: コードが引けない (サービス「${r.svc}」型「${r.svcType}」${r.code})`); return; }
        const sid = (memberByName.get(normStaff(r.staff)) ?? []).length === 1 ? memberByName.get(normStaff(r.staff))![0] : null;
        rows.push({
          user_id: uid, staff_id: sid, visit_date: date,
          start_time: r.start || null, end_time: r.end || null,
          service_type: hit.name, system: "障害", status: "completed",
          office_id: office.id, tenant_id: office.tenant_id,
          notes: `${MARK} ${TARGET_MONTH} ${area} code=${hit.code}] (MEISAI ${r.file} 介護コード ${r.code})`,
        });
        label.push(`  ${who}  ${r.code} ${r.svc}(${r.svcType}) → ${hit.code} ${hit.name} ${hit.units}単位${sid ? "" : " (職員未一致)"}`);
      });
    }
    if (rows.length) plans.push({ area, office, rows, label });
  }

  let total = 0;
  for (const p of plans) {
    console.log(`■ ${p.area}  補う行 ${p.rows.length}`);
    for (const l of p.label) console.log(l);
    total += p.rows.length;
  }
  console.log(`\n補う行 合計 ${total}`);
  if (stops.length) {
    console.log(`\n✗ 止める条件に当たった ${stops.length} 件 (1 行も書かない):`);
    for (const s of stops) console.log(`  ${s}`);
    process.exit(2);
  }
  if (!EXECUTE) { console.log("\n(DRY RUN。書き込むには --execute)"); return; }

  for (const p of plans) {
    const { error: delErr } = await sb.from("kaigo_visit_schedule").delete()
      .eq("office_id", p.office.id).like("notes", `${MARK} ${TARGET_MONTH} %`)
      .gte("visit_date", MONTH_FIRST).lt("visit_date", NEXT_FIRST);
    if (delErr) { console.error(`✗ ${p.area} 既存補完行の削除失敗: ${delErr.message}`); process.exit(1); }
    const { error } = await sb.from("kaigo_visit_schedule").insert(p.rows);
    if (error) { console.error(`✗ ${p.area} INSERT 失敗: ${error.message}`); process.exit(1); }
    const { count, error: cErr } = await sb.from("kaigo_visit_schedule").select("id", { count: "exact", head: true })
      .eq("office_id", p.office.id).like("notes", `${MARK} ${TARGET_MONTH} %`);
    if (cErr) { console.error(`✗ ${p.area} 件数確認失敗: ${cErr.message}`); process.exit(1); }
    console.log(`✓ ${p.area}: ${p.rows.length} 行 INSERT / DB 上の補完行 ${count}`);
    if (count !== p.rows.length) { console.error(`✗ ${p.area}: 件数が合わない`); process.exit(1); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
