// ============================================================================
// 居宅レセプトを伝送 (KK / 8124) と事業所ごとに突合する
//
//   伝送が「正」。当方のレセプト表 (kaigo_care_support_claims) が
//   **事業所ごとに 1 円まで一致するか**を見る。
//
//   MONTH=2026-06 node migrations/verify_kyotaku_claims_vs_kk.mjs
//   MONTH=2026-06 node migrations/verify_kyotaku_claims_vs_kk.mjs --detail
//
//   差が出たら --detail で利用者ごとの内訳を出す。
//
// ⚠ 人の識別は **(保険者番号, 被保険者番号)**。被保番は保険者の中でしか一意でない。
// ⚠ 転居月は 1 人が保険者ごとに 2 枚。だから突合も (保険者, 被保番) 単位で行う。
// ⚠ _densou_intentional_diff.json に載っている人は **一致しないのが正しい**
//   (ほのぼの側の算定漏れが確定したもの)。◇ で別枠に出し、判定には数えない。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";

const MONTH = process.env.MONTH ?? "2026-06";            // 2026-06
const YM = MONTH.replace("-", "");                        // 202606
const DETAIL = process.argv.includes("--detail");
const TENANT = "kt-group";

const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

// 8124 の列 (import_kyotaku_claims_from_kk.mjs と同じ)
const F = { office: 3, provideYm: 5, insurer: 6, insured: 8,
            lineNo: 17, code: 18, units: 19, count: 20, amount: 23 };

/**
 * 8124 のサービスコード → 当方 kaigo_care_support_claims のどの列に入っているか。
 * import_kyotaku_claims_from_kk.mjs の振り分けと同じ対応にする。
 * 合計だけでなく **内訳の単位数**まで突き合わせるために要る。
 */
function claimUnitsByCode(claim, code, name) {
  const n = String(name ?? "");
  if (n.startsWith("居宅介護支援")) return claim.units;
  if (n.includes("初回加算")) return claim.initial_addition_units;
  if (n.includes("特定事業所医療介護連携加算")) return claim.medical_coop_kassan_units;
  if (n.includes("特定事業所加算")) return claim.tokutei_kassan_units;
  if (n.includes("処遇改善加算")) return claim.shoguu_kaizen_units;
  if (n.includes("入院時情報連携加算")) return claim.hospital_coordination_units;
  if (n.includes("退院退所加算")) return claim.discharge_addition_units;
  if (n.includes("通院時情報連携加算")) return claim.medical_coordination_units;
  if (n.includes("ターミナルケアマネジメント加算")) return claim.terminal_care_units;
  if (n.includes("緊急時カンファレンス加算")) return claim.emergency_conference_units;
  return undefined;   // 対応する列が無い = 未対応の加算
}

function walkKk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walkKk(p, out);
    else if (/^KK.*\.CSV$/i.test(e)) out.push(p);
  }
  return out;
}

// ── 伝送を読む ──────────────────────────────────────────────────────────
//   1 レセプト = (事業所, 保険者, 被保番)。合計額は明細番号 99 の行にある。
function readDensou() {
  const byKey = new Map();
  for (const f of walkKk(path.join(process.cwd(), "伝送データ"))) {
    const txt = iconv.decode(readFileSync(f), "Shift_JIS");
    for (const line of txt.split(/\r?\n/)) {
      const c = line.split(",").map((s) => s.replace(/^"|"$/g, "").trim());
      if (c[2] !== "8124" || c[F.provideYm] !== YM) continue;
      const key = `${c[F.office]}|${c[F.insurer]}|${c[F.insured]}`;
      // 同じレセプトが当初請求と再請求の両方に出ることがある。**後勝ち**でよい
      // (再請求は当初を取り下げたうえで出し直したもの)。ファイルが変わったら明細を作り直す。
      const src = path.basename(f);
      let cur = byKey.get(key);
      if (!cur || cur.src !== src) {
        cur = { office: c[F.office], insurer: c[F.insurer], insured: c[F.insured],
                amount: 0, lines: new Map(), src };
        byKey.set(key, cur);
      }
      if (c[F.lineNo] === "99") cur.amount = Number(c[F.amount] || 0);
      else if (/^\d{6}$/.test(c[F.code] ?? "")) {
        // 同じコードが複数行に出ることがあるので足す
        cur.lines.set(c[F.code], (cur.lines.get(c[F.code]) ?? 0) + Number(c[F.units] || 0));
      }
    }
  }
  return byKey;
}

async function main() {
  console.log(`=== 居宅レセプト 伝送突合 ${MONTH} ===\n`);

  // ほのぼの側の算定漏れが確定していて、**一致しないのが正しい**人
  const INTENTIONAL = new Map();
  {
    const j = JSON.parse(readFileSync(path.join(process.cwd(), "migrations/_densou_intentional_diff.json"), "utf8"));
    for (const e of j.entries ?? []) {
      if (e.system !== "居宅" || e.month !== MONTH) continue;
      INTENTIONAL.set(`${e.insurer_number}|${e.insured_number}`, e);
    }
  }

  // 当初請求の被保険者番号が誤っていて出し直されたもの。当初分は取り下げ済み。
  const SUPERSEDED = new Set();
  {
    const f = path.join(process.cwd(), "migrations/_kyotaku_superseded.json");
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, "utf8"));
      for (const e of j.entries ?? []) {
        if (e.month !== MONTH) continue;
        SUPERSEDED.add(`${e.insurer_number}|${e.withdrawn_insured}`);
      }
    }
  }

  const densou = readDensou();
  if (!densou.size) { console.error(`✗ 提供年月 ${YM} の 8124 が伝送データに見つかりません`); process.exit(1); }

  const { data: offices, error: eO } = await sb.from("offices")
    .select("id, name, business_number").eq("tenant_id", TENANT);
  if (eO) { console.error(`✗ ${eO.message}`); process.exit(1); }
  const offByBn = new Map((offices ?? []).filter((o) => o.business_number).map((o) => [o.business_number, o]));

  // 当方のレセプト (1000 行の壁があるので必ずページング)
  const ours = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("kaigo_care_support_claims")
      .select("user_id, insurer_number, insured_number, total_amount, units, "
        + "care_support_code, initial_addition_units, tokutei_kassan_units, "
        + "medical_coop_kassan_units, shoguu_kaizen_units, hospital_coordination_units, "
        + "discharge_addition_units, medical_coordination_units, terminal_care_units, "
        + "emergency_conference_units, clients(name)")
      .eq("billing_month", MONTH).order("id").range(from, from + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    ours.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const ourByKey = new Map();
  for (const r of ours) ourByKey.set(`${r.insurer_number}|${r.insured_number}`,
    { amount: Number(r.total_amount || 0), name: r.clients?.name ?? "(名前不明)", row: r });

  // サービスコード → 名称 (内訳の突合に要る)
  const codeName = new Map();
  {
    const want = [...new Set([...densou.values()].flatMap((d) => [...d.lines.keys()]))];
    for (let i = 0; i < want.length; i += 200) {
      const { data, error } = await sb.from("kaigo_service_codes")
        .select("service_code, service_name").in("service_code", want.slice(i, i + 200)).eq("system", "介護");
      if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
      for (const r of data ?? []) if (!codeName.has(r.service_code)) codeName.set(r.service_code, r.service_name);
    }
  }

  // 事業所ごとに集計
  const perOffice = new Map();
  let superseded = 0;
  for (const d of densou.values()) {
    // 取り下げ済みの当初請求は集計に入れない
    if (SUPERSEDED.has(`${d.insurer}|${d.insured}`)) { superseded++; continue; }
    const off = offByBn.get(d.office);
    const label = off ? off.name : `事業所番号 ${d.office} (offices に無い)`;
    if (!perOffice.has(label)) perOffice.set(label, { densou: 0, ours: 0, n: 0, miss: [], diff: [], intent: [], inner: [] });
    const g = perOffice.get(label);
    g.n++; g.densou += d.amount;
    const mine = ourByKey.get(`${d.insurer}|${d.insured}`);
    if (!mine) { g.miss.push(d); continue; }
    g.ours += mine.amount;
    const ent = INTENTIONAL.get(`${d.insurer}|${d.insured}`);
    if (ent) { g.intent.push({ ...d, name: mine.name, mine: mine.amount, reason: ent.reason }); continue; }
    if (mine.amount !== d.amount) { g.diff.push({ ...d, name: mine.name, mine: mine.amount }); continue; }
    // 合計が合っていても内訳が違うことがある。**単位数まで**突き合わせる。
    const bad = [];
    for (const [code, units] of d.lines) {
      const nm = codeName.get(code);
      const ours2 = claimUnitsByCode(mine.row, code, nm);
      if (ours2 === undefined) { bad.push(`${code} ${nm ?? "(マスタに無い)"} は当方に持ち場が無い`); continue; }
      if (Number(ours2 || 0) !== units) bad.push(`${code} ${nm ?? ""} 伝送${units} ≠ 当方${Number(ours2 || 0)}`);
    }
    if (bad.length) g.inner.push({ ...d, name: mine.name, bad });
  }

  const rows = [...perOffice.entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"));
  let okN = 0, lostYen = 0, missN = 0, diffN = 0, intentN = 0, innerN = 0;
  console.log("事業所".padEnd(34) + "件数   伝送額        当方額        判定");
  for (const [name, g] of rows) {
    const ok = !g.miss.length && !g.diff.length && !g.inner.length;
    if (ok) okN++;
    missN += g.miss.length; diffN += g.diff.length; intentN += g.intent.length; innerN += g.inner.length;
    lostYen += g.densou - g.ours;
    const mark = ok
      ? (g.intent.length ? `✓ 一致 (◇意図的差異 ${g.intent.length}名)` : "✓ 一致")
      : `★ レセプト無し${g.miss.length} / 金額差${g.diff.length} / 内訳差${g.inner.length}`;
    console.log(name.padEnd(34, "　").slice(0, 34)
      + String(g.n).padStart(5)
      + String(g.densou.toLocaleString()).padStart(12)
      + String(g.ours.toLocaleString()).padStart(14) + "  " + mark);
  }

  console.log(`\n  ${okN} / ${rows.length} 事業所が完全一致`);
  console.log(`  レセプト無し ${missN} 名 / 金額差 ${diffN} 名 / **内訳差 ${innerN} 名** / 差額合計 ${lostYen.toLocaleString()} 円`);
  if (superseded) console.log(`  ◇ 取り下げ済み ${superseded} 件 (当初請求の被保番が誤りで出し直されたもの)`);
  if (intentN) console.log(`  ◇ 意図的差異 ${intentN} 名 (ほのぼの側の算定漏れが確定したもの。判定には数えない)`);

  if (DETAIL) {
    for (const [name, g] of rows) {
      if (!g.miss.length && !g.diff.length && !g.intent.length && !g.inner.length) continue;
      console.log(`\n-- ${name} --`);
      for (const t of g.intent)
        console.log(`   [◇意図的差異] ${t.name}  伝送 ${t.amount.toLocaleString()} / 当方 ${t.mine.toLocaleString()}  ${t.reason}`);
      for (const m of g.miss)
        console.log(`   [レセプト無し] 保険者${m.insurer} 被保番${m.insured}  ${m.amount.toLocaleString()}円  (${m.src})`);
      for (const d of g.diff)
        console.log(`   [金額差] ${d.name}  伝送 ${d.amount.toLocaleString()} ≠ 当方 ${d.mine.toLocaleString()}  (差 ${(d.amount - d.mine).toLocaleString()}円)`);
      for (const d of g.inner)
        console.log(`   [内訳差] ${d.name}  ${d.bad.join(" / ")}`);
    }
  } else if (missN || diffN || innerN) {
    console.log("\n  ※ --detail で利用者ごとの内訳を出します。");
  }
}

main();
