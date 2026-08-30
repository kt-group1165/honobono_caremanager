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
const F = { office: 3, provideYm: 5, insurer: 6, insured: 8, lineNo: 17, amount: 23 };

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
      if (c[2] !== "8124" || c[F.provideYm] !== YM || c[F.lineNo] !== "99") continue;
      const key = `${c[F.office]}|${c[F.insurer]}|${c[F.insured]}`;
      // 同じレセプトが当初請求と再請求の両方に出ることがある。**後勝ち**でよい
      // (再請求は当初を取り下げたうえで出し直したもの)。
      byKey.set(key, { office: c[F.office], insurer: c[F.insurer], insured: c[F.insured],
                       amount: Number(c[F.amount] || 0), src: path.basename(f) });
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
      .select("user_id, insurer_number, insured_number, total_amount, clients(name)")
      .eq("billing_month", MONTH).range(from, from + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    ours.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const ourByKey = new Map();
  for (const r of ours) ourByKey.set(`${r.insurer_number}|${r.insured_number}`,
    { amount: Number(r.total_amount || 0), name: r.clients?.name ?? "(名前不明)" });

  // 事業所ごとに集計
  const perOffice = new Map();
  for (const d of densou.values()) {
    const off = offByBn.get(d.office);
    const label = off ? off.name : `事業所番号 ${d.office} (offices に無い)`;
    if (!perOffice.has(label)) perOffice.set(label, { densou: 0, ours: 0, n: 0, miss: [], diff: [], intent: [] });
    const g = perOffice.get(label);
    g.n++; g.densou += d.amount;
    const mine = ourByKey.get(`${d.insurer}|${d.insured}`);
    if (!mine) { g.miss.push(d); continue; }
    g.ours += mine.amount;
    const ent = INTENTIONAL.get(`${d.insurer}|${d.insured}`);
    if (ent) { g.intent.push({ ...d, name: mine.name, mine: mine.amount, reason: ent.reason }); continue; }
    if (mine.amount !== d.amount) g.diff.push({ ...d, name: mine.name, mine: mine.amount });
  }

  const rows = [...perOffice.entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"));
  let okN = 0, lostYen = 0, missN = 0, diffN = 0, intentN = 0;
  console.log("事業所".padEnd(34) + "件数   伝送額        当方額        判定");
  for (const [name, g] of rows) {
    const ok = !g.miss.length && !g.diff.length;
    if (ok) okN++;
    missN += g.miss.length; diffN += g.diff.length; intentN += g.intent.length;
    lostYen += g.densou - g.ours;
    const mark = ok
      ? (g.intent.length ? `✓ 一致 (◇意図的差異 ${g.intent.length}名)` : "✓ 一致")
      : `★ レセプト無し${g.miss.length} / 金額差${g.diff.length}`;
    console.log(name.padEnd(34, "　").slice(0, 34)
      + String(g.n).padStart(5)
      + String(g.densou.toLocaleString()).padStart(12)
      + String(g.ours.toLocaleString()).padStart(14) + "  " + mark);
  }

  console.log(`\n  ${okN} / ${rows.length} 事業所が完全一致`);
  console.log(`  レセプト無し ${missN} 名 / 金額差 ${diffN} 名 / 差額合計 ${lostYen.toLocaleString()} 円`);
  if (intentN) console.log(`  ◇ 意図的差異 ${intentN} 名 (ほのぼの側の算定漏れが確定したもの。判定には数えない)`);

  if (DETAIL) {
    for (const [name, g] of rows) {
      if (!g.miss.length && !g.diff.length && !g.intent.length) continue;
      console.log(`\n-- ${name} --`);
      for (const t of g.intent)
        console.log(`   [◇意図的差異] ${t.name}  伝送 ${t.amount.toLocaleString()} / 当方 ${t.mine.toLocaleString()}  ${t.reason}`);
      for (const m of g.miss)
        console.log(`   [レセプト無し] 保険者${m.insurer} 被保番${m.insured}  ${m.amount.toLocaleString()}円  (${m.src})`);
      for (const d of g.diff)
        console.log(`   [金額差] ${d.name}  伝送 ${d.amount.toLocaleString()} ≠ 当方 ${d.mine.toLocaleString()}  (差 ${(d.amount - d.mine).toLocaleString()}円)`);
    }
  } else if (missN || diffN) {
    console.log("\n  ※ --detail で利用者ごとの内訳を出します。");
  }
}

main();
