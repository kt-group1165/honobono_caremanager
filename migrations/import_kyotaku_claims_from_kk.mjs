// ============================================================================
// 居宅介護支援費のレセプトを **ほのぼのの伝送 (KK / 8124)** から取り込む。
//
// ── なぜ伝送から取るか ────────────────────────────────────────────────
//   居宅介護支援費には 初回加算・特定事業所加算・医療介護連携加算・処遇改善 と
//   **利用者ごとに違う加算**が乗る。利用票には加算が印字されないので、
//   要介護度から金額を組み立てても当たらない。
//     四街道 2026-06 の月遅れ 2 名を利用票から起票したときの実害:
//       小池 美乃里 20,387円 (初回加算あり)  → 額は合っていたが内訳に初回が無い
//       北原 武夫   17,005円 (初回加算なし)  → 20,387 で入れており +3,382 の過大
//   伝送には 誰が・どのコードで・何単位・いくら が全部入っている。
//
// ── 月遅れは「翌月送信」に入っている ──────────────────────────────────
//   1 回の送信の中で **提供年月ごとに KK ファイルが分かれる**。
//     四街道 8月10日送信: KK260801 = 提供年月202606 (= 6月提供の月遅れ 2名)
//                         KK260802 = 提供年月202607 (= 当月分 129名)
//   なので「提供年月 == MONTH の 8124」を全ファイルから拾えば、当初請求も
//   月遅れも同じ土俵に乗る。
//
//   node migrations/import_kyotaku_claims_from_kk.mjs             # DRY RUN
//   node migrations/import_kyotaku_claims_from_kk.mjs --execute
//   env: MONTH=2026-06 / AREA=四街道 (省略時は全拠点)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || "2026-06";
const YM = MONTH.replace("-", "");
const AREA = process.env.AREA || null;
const TENANT = "kt-group";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

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

/**
 * 伝送と **意図的に一致させない** ケース (_densou_intentional_diff.json)。
 * ほのぼの側の算定漏れが確認できた利用者は当方を正しい値にしてあるので、
 * 取込で伝送の値に戻してしまわないよう skip する。理由は必ず出力する。
 */
const INTENTIONAL = (() => {
  const p = path.join(KAIGO, "migrations", "_densou_intentional_diff.json");
  if (!existsSync(p)) return new Map();
  const j = JSON.parse(readFileSync(p, "utf8"));
  return new Map(
    (j.entries ?? [])
      .filter((x) => x.system === "居宅" && x.month === MONTH)
      .map((x) => [x.insured_number, x]),
  );
})();

/** 伝送データ/<拠点>/居宅/ 配下を再帰して KK*.CSV を集める */
function findKkFiles() {
  const base = path.join(KAIGO, "伝送データ");
  const out = [];
  const walk = (d, depth) => {
    if (depth > 5 || !existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/^KK\d+\.CSV$/i.test(n)) out.push(p);
    }
  };
  for (const area of readdirSync(base)) {
    if (AREA && area !== AREA) continue;
    const kyotaku = path.join(base, area, "居宅");
    if (existsSync(kyotaku)) walk(kyotaku, 0);
  }
  return out;
}

const splitCsv = (line) => {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};

/**
 * 8124 明細レコードのレイアウト (居宅介護支援費 / 様式第七)
 *   [2]=レコード種別 8124  [3]=事業所番号  [5]=提供年月  [6]=保険者番号
 *   [8]=被保険者番号  [17]=明細行番号 (99 = 集計行)  [18]=サービスコード
 *   [19]=単位数  [20]=回数  [21]=小計  [22]=合計単位数 (99行のみ)
 *   [23]=保険請求額 (99行のみ / 居宅介護支援は10割給付で利用者負担なし)
 */
const F = { office: 3, provideYm: 5, insurer: 6, insured: 8, lineNo: 17, code: 18, units: 19, count: 20, sub: 21, totalUnits: 22, amount: 23 };

async function main() {
  console.log(`=== 居宅レセプトを伝送から取込 ${MONTH} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // サービスコード辞書 (名称で種別を判定するので推測が入らない)
  const codeName = new Map();
  {
    let from = 0;
    for (;;) {
      const { data, error } = await sb.from("kaigo_service_codes")
        .select("service_code, service_name, valid_from")
        .eq("system", "介護").eq("service_category", "43")
        .lte("valid_from", `${MONTH}-01`)
        .order("valid_from", { ascending: false })
        .range(from, from + 999);
      if (error) { console.error(`✗ コード取得失敗: ${error.message}`); process.exit(1); }
      for (const r of data) if (!codeName.has(r.service_code)) codeName.set(r.service_code, r.service_name);
      if (data.length < 1000) break;
      from += 1000;
    }
  }
  console.log(`  居宅のサービスコード ${codeName.size} 件を読込`);

  const { data: offices, error: e1 } = await sb.from("offices")
    .select("id, name, business_number").eq("service_type", "居宅介護支援");
  if (e1) { console.error(`✗ ${e1.message}`); process.exit(1); }
  const officeByBn = new Map((offices ?? []).filter((o) => o.business_number).map((o) => [o.business_number, o]));

  // 伝送を読む: (事業所番号, 被保番) → 明細行
  const files = findKkFiles();
  const bundle = new Map();
  for (const f of files) {
    for (const line of iconv.decode(readFileSync(f), "Shift_JIS").split(/\r?\n/)) {
      const c = splitCsv(line);
      if (c[0] !== "2" || c[2] !== "8124") continue;
      if (c[F.provideYm] !== YM) continue;
      const key = `${c[F.office]}|${c[F.insured]}`;
      if (!bundle.has(key)) bundle.set(key, { office: c[F.office], insured: c[F.insured], insurer: c[F.insurer], lines: [], src: path.basename(f) });
      bundle.get(key).lines.push(c);
    }
  }
  console.log(`  KK ${files.length} ファイルから 提供年月 ${YM} の利用者 ${bundle.size} 名を検出\n`);
  if (!bundle.size) { console.log("※ 該当なし"); return; }

  const plans = [];
  const problems = [];
  const kept = [];
  for (const b of bundle.values()) {
    const keep = INTENTIONAL.get(b.insured);
    if (keep) { kept.push(keep); continue; }
    const off = officeByBn.get(b.office);
    if (!off) { problems.push(`事業所番号 ${b.office}: offices に無い (被保番 ${b.insured})`); continue; }

    const claim = {
      units: 0, unit_price: null, total_amount: 0, insurance_amount: 0,
      care_support_code: null, care_support_name: null,
      initial_addition: false, initial_addition_units: 0,
      tokutei_kassan_type: null, tokutei_kassan_units: 0,
      medical_coop_kassan: false, medical_coop_kassan_units: 0,
      shoguu_kaizen_code: null, shoguu_kaizen_units: 0,
    };
    let unknown = null;
    for (const c of b.lines) {
      const code = c[F.code];
      const units = Number(c[F.units] || 0);
      const name = codeName.get(code);
      if (!name) { unknown = `${code} (マスタに無い)`; break; }
      if (name.startsWith("居宅介護支援")) {            // 基本部分
        claim.care_support_code = code; claim.care_support_name = name; claim.units = units;
      } else if (name.includes("初回加算")) {
        claim.initial_addition = true; claim.initial_addition_units = units;
      } else if (name.includes("特定事業所医療介護連携加算")) {
        claim.medical_coop_kassan = true; claim.medical_coop_kassan_units = units;
      } else if (name.includes("特定事業所加算")) {
        claim.tokutei_kassan_type = name.replace(/^.*特定事業所加算/, "").trim() || null;
        claim.tokutei_kassan_units = units;
      } else if (name.includes("処遇改善加算")) {
        claim.shoguu_kaizen_code = code; claim.shoguu_kaizen_units = units;
      } else {
        unknown = `${code} ${name} (対応する列が未定義)`; break;
      }
      if (c[F.lineNo] === "99") {
        claim.total_amount = Number(c[F.amount] || 0);
        claim.insurance_amount = claim.total_amount;
        const tu = Number(c[F.totalUnits] || 0);
        if (tu > 0) claim.unit_price = Math.round((claim.total_amount / tu) * 100) / 100;
      }
    }
    if (unknown) { problems.push(`${off.name} 被保番 ${b.insured}: 未知のサービスコード ${unknown}`); continue; }
    if (!claim.care_support_code || !claim.total_amount) {
      problems.push(`${off.name} 被保番 ${b.insured}: 基本コードか請求額が読めない`); continue;
    }

    // (保険者番号, 被保険者番号) → client
    // ⚠ 被保険者番号は **保険者の中でしか一意でない**。番号だけで引くと別人に当たる。
    //   例) 0000273649 = 遠山 弘美 (122283 八街市) と 加藤 三千代 (122259 市原市)
    //   当方の実データで、番号だけだと 28 件が衝突し、保険者を足すと 20 件に減る。
    const { data: ins, error: e2 } = await sb.from("client_insurance_records")
      .select("client_id, clients(name)")
      .eq("insured_number", b.insured).eq("insurer_number", b.insurer);
    if (e2) { console.error(`✗ ${e2.message}`); process.exit(1); }
    const cids = [...new Set((ins ?? []).map((r) => r.client_id))];
    if (cids.length !== 1) {
      problems.push(
        `${off.name} 保険者${b.insurer} 被保番 ${b.insured}: 当方の利用者が ${cids.length} 名 ` +
          (cids.length ? "(重複レコードの解消が必要)" : "(当方に居ない)"),
      );
      continue;
    }
    const clientId = cids[0];
    const name = ins[0].clients?.name ?? "?";

    const { data: cur, error: e3 } = await sb.from("kaigo_care_support_claims")
      .select("*").eq("user_id", clientId).eq("billing_month", MONTH);
    if (e3) { console.error(`✗ ${e3.message}`); process.exit(1); }
    const existing = (cur ?? [])[0] ?? null;

    const diffs = [];
    for (const [k, v] of Object.entries(claim)) {
      const was = existing ? existing[k] : undefined;
      if (existing && String(was ?? "") !== String(v ?? "")) diffs.push(`${k}: ${was ?? "(空)"} → ${v ?? "(空)"}`);
    }
    if (existing && !diffs.length) continue;                      // 一致 = 何もしない
    plans.push({ off, name, clientId, claim, existing, diffs, src: b.src });
  }

  const adds = plans.filter((p) => !p.existing);
  const upds = plans.filter((p) => p.existing);
  console.log(`  新規 ${adds.length} 名 / 是正 ${upds.length} 名 / ` +
    `一致 ${bundle.size - plans.length - problems.length - kept.length} 名 / 意図的に据置 ${kept.length} 名\n`);
  for (const p of adds) {
    console.log(`  [新規] ${p.off.name} ${p.name}  ${p.claim.care_support_name} ` +
      `${p.claim.units}${p.claim.initial_addition ? `+初回${p.claim.initial_addition_units}` : ""}` +
      `+特定${p.claim.tokutei_kassan_units}+処遇${p.claim.shoguu_kaizen_units} = ${p.claim.total_amount.toLocaleString()}円  [${p.src}]`);
  }
  for (const p of upds) {
    console.log(`  [是正] ${p.off.name} ${p.name}  [${p.src}]`);
    for (const d of p.diffs) console.log(`           ${d}`);
  }
  if (kept.length) {
    console.log(`\n  -- 意図的に伝送と揃えないもの ${kept.length} 件 (当方の値を保持) --`);
    for (const k of kept) {
      console.log(`     ${k.name} (${k.office}) 差 ${k.diff_amount?.toLocaleString() ?? "?"}円`);
      console.log(`       ${k.reason}`);
      if (k.action) console.log(`       → ${k.action}`);
    }
  }
  if (problems.length) {
    console.log(`\n  -- 取り込めないもの ${problems.length} 件 --`);
    for (const q of problems) console.log(`     ${q}`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }

  for (const p of plans) {
    const row = { ...p.claim, user_id: p.clientId, billing_month: MONTH, tenant_id: TENANT, status: "confirmed",
      notes: `[伝送取込 ${MONTH}] ${p.src} の 8124 から取込` };
    const q = p.existing
      ? await sb.from("kaigo_care_support_claims").update({ ...row, updated_at: new Date().toISOString() }).eq("id", p.existing.id)
      : await sb.from("kaigo_care_support_claims").insert(row);
    if (q.error) { console.error(`✗ ${p.name}: ${q.error.message}`); process.exit(1); }
    console.log(`  ✓ ${p.name}`);
  }
  console.log(`\n✓ 新規 ${adds.length} / 是正 ${upds.length} を保存しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
