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
/**
 * --create-missing: 伝送に居るが当方に居ない利用者を **利用者マスタ CSV から**
 *   作ってから取り込む。月遅れの人は当初請求に居ないので、当方に未登録のことがある。
 *     木更津 2026-06: 岸 敏子 / 小塚 明 (どちらもマスタには居る)
 *   氏名・住所はマスタ、認定と保険者は伝送を正とする。明示フラグにしてあるのは
 *   利用者を勝手に増やさないため。
 */
const CREATE_MISSING = process.argv.includes("--create-missing");
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

/** 利用者データ/ 配下の 介護保険*.CSV と 基本情報*.CSV を読む (被保番 → 氏名・生年・住所) */
function loadClientMaster() {
  const base = path.join(KAIGO, "利用者データ");
  const byInsured = new Map();   // 被保番 → { userNumber, name, careLevel }
  const byUserNo = new Map();    // 利用者番号 → { name, birth, sex, zip, address, phone }
  const walk = (d, depth) => {
    if (depth > 3 || !existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.CSV$/i.test(n) || !st.size) continue;
      const isKaigo = /^介護保険/.test(n);
      const isBase = /^基本情報/.test(n);
      if (!isKaigo && !isBase) continue;
      for (const line of iconv.decode(readFileSync(p), "Shift_JIS").split(/\r?\n/)) {
        const c = splitCsv(line).map((s) => s.trim());
        if (isKaigo && c.length > 14 && /^\d{10}$|^[A-Z]\d{9}$/.test(c[4] ?? "")) {
          // 同じ人が複数行 (更新申請) 出るので上書きで良い (氏名・利用者番号は同じ)
          byInsured.set(c[4], { userNumber: c[0], name: c[1], careLevel: c[11] || null });
        }
        if (isBase && c.length > 14 && c[0] && c[3]) {
          byUserNo.set(c[0], { name: c[3], furigana: c[6] || null, sex: c[8] || null, birth: c[11] || null, zip: c[12] || null, address: c[13] || null, phone: c[14] || null });
        }
      }
    }
  };
  walk(base, 0);
  return { byInsured, byUserNo };
}

/**
 * 退院・退所加算のサービスコード → kaigo_care_support_claims.discharge_type。
 * ⚠ 列にはアプリの内部値 (i_i / i_ro / ii_i / ii_ro / iii) が入る。
 *   サービスコードの名称は「Ⅰ１」形式なので、そのまま入れると
 *   claims-shared.ts の ADDON_CODE_TO_DISCHARGE_TYPE と噛み合わず画面が壊れる。
 *   名称の 1/2 は イ/ロ にあたる。単位数では Ⅰ２ と Ⅱ１ がどちらも 600 で
 *   区別できないため、**コードで引く**。
 */
const DISCHARGE_TYPE_BY_CODE = {
  "436132": "i_i",    // 退院退所加算Ⅰ１ 450
  "436143": "i_ro",   // 退院退所加算Ⅰ２ 600
  "436144": "ii_i",   // 退院退所加算Ⅱ１ 600
  "436145": "ii_ro",  // 退院退所加算Ⅱ２ 750
  "436146": "iii",    // 退院退所加算Ⅲ   900
};

/** 国保連の要介護状態区分コード (11=要支援 / 12,13=要支援1,2 / 21..25=要介護1..5) */
const CARE_LEVEL_BY_CODE = { "11": "要支援", "12": "要支援1", "13": "要支援2", "21": "要介護1", "22": "要介護2", "23": "要介護3", "24": "要介護4", "25": "要介護5" };
const isoFromYmd = (s) => (/^\d{8}$/.test(s ?? "") ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);
const isoFromSlash = (s) => {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s ?? "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};

async function main() {
  console.log(`=== 居宅レセプトを伝送から取込 ${MONTH} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"}` +
    `${CREATE_MISSING ? " + 未登録利用者を作成" : ""} ===\n`);

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
      // ⚠ 同じ (事業所, 被保番, 提供年月) が **複数の送信に出る**ことがある。
      //   過誤取下げ → 再請求 で出し直した場合で、後の送信が当初請求を置き換える。
      //     船橋 林八重子: KK260704 (7/10) 1832単位 19,858円 = 処遇改善なし
      //                    KK260802 (8/10) 1870単位 20,270円 = 処遇改善を付けて再請求
      //   行を寄せ集めると混ざるので、**新しいファイルのものだけ**を残す。
      //   ファイル名 KK<YYMM><連番> は送信順に並ぶので辞書順で比較できる。
      const key = `${c[F.office]}|${c[F.insured]}`;
      const src = path.basename(f);
      const cur = bundle.get(key);
      if (!cur) { bundle.set(key, { office: c[F.office], insured: c[F.insured], insurer: c[F.insurer], lines: [c], src, replaced: null }); continue; }
      if (src === cur.src) { cur.lines.push(c); continue; }
      if (src > cur.src) { cur.lines = [c]; cur.replaced = cur.src; cur.src = src; }
      // src < cur.src は古い送信なので捨てる
    }
  }
  console.log(`  KK ${files.length} ファイルから 提供年月 ${YM} の利用者 ${bundle.size} 名を検出\n`);
  if (!bundle.size) { console.log("※ 該当なし"); return; }

  const master = loadClientMaster();
  console.log(`  利用者マスタ CSV: 被保番 ${master.byInsured.size} 件 / 基本情報 ${master.byUserNo.size} 件`);

  const plans = [];
  const problems = [];
  const kept = [];
  const creates = [];
  const resolved = [];   // 割当チェック用: 伝送で解決できた全員 (一致した人も含む)
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
      hospital_coordination: false, hospital_coordination_units: 0,
      discharge_addition: false, discharge_addition_units: 0, discharge_type: "",
      medical_coordination: false, medical_coordination_units: 0,
      terminal_care: false, terminal_care_units: 0,
      emergency_conference: false, emergency_conference_units: 0,
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
      } else if (name.includes("入院時情報連携加算")) {
        claim.hospital_coordination = true; claim.hospital_coordination_units = units;
      } else if (name.includes("退院退所加算")) {
        const t = DISCHARGE_TYPE_BY_CODE[code];
        if (!t) { unknown = `${code} ${name} (DISCHARGE_TYPE_BY_CODE に無い)`; break; }
        claim.discharge_addition = true; claim.discharge_addition_units = units;
        claim.discharge_type = t;
      } else if (name.includes("通院時情報連携加算")) {
        claim.medical_coordination = true; claim.medical_coordination_units = units;
      } else if (name.includes("ターミナルケアマネジメント加算")) {
        claim.terminal_care = true; claim.terminal_care_units = units;
      } else if (name.includes("緊急時カンファレンス加算")) {
        claim.emergency_conference = true; claim.emergency_conference_units = units;
      } else if (name.includes("特定事業所集中減算")) {
        // 単位数がマイナス。基本部分とは別枠で保持する列が無いので、当面は止める
        unknown = `${code} ${name} (減算に対応する列が無い)`; break;
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
    if (cids.length > 1) {
      problems.push(`${off.name} 保険者${b.insurer} 被保番 ${b.insured}: 当方の利用者が ${cids.length} 名 (重複レコードの解消が必要)`);
      continue;
    }
    let clientId = cids[0] ?? null;
    let name = ins?.[0]?.clients?.name ?? null;
    if (!clientId) {
      const m = master.byInsured.get(b.insured);
      if (!m) { problems.push(`${off.name} 保険者${b.insurer} 被保番 ${b.insured}: 当方にも利用者マスタ CSV にも居ない`); continue; }
      const base = master.byUserNo.get(m.userNumber) ?? {};
      const head = b.lines[0];
      creates.push({
        off, insured: b.insured, insurer: b.insurer,
        userNumber: m.userNumber,
        name: base.name || m.name,
        birth_date: isoFromSlash(base.birth) ?? isoFromYmd(head[11]),
        address: base.address || null, phone: base.phone || null,
        // ⚠ フリガナを入れ忘れると利用者一覧であいうえお順に並ばず「他」に落ちる
        //   (船橋 坂田茂 が居宅サービス計画書の一覧で見つからない、で発覚)
        furigana: base.furigana || null, gender: base.sex || null, postal_code: base.zip || null,
        care_level: CARE_LEVEL_BY_CODE[head[13]] ?? m.careLevel,
        cert_start: isoFromYmd(head[14]), cert_end: isoFromYmd(head[15]),
      });
      if (!CREATE_MISSING) {
        problems.push(`${off.name} 被保番 ${b.insured} (${base.name || m.name}): 当方に居ない — --create-missing で作成できます`);
        continue;
      }
      clientId = null;                       // EXECUTE 時に作ってから claim を入れる
      name = base.name || m.name;
    }

    let existing = null;
    if (clientId) {
      const { data: cur, error: e3 } = await sb.from("kaigo_care_support_claims")
        .select("*").eq("user_id", clientId).eq("billing_month", MONTH);
      if (e3) { console.error(`✗ ${e3.message}`); process.exit(1); }
      existing = (cur ?? [])[0] ?? null;
    }

    const diffs = [];
    for (const [k, v] of Object.entries(claim)) {
      const was = existing ? existing[k] : undefined;
      if (existing && String(was ?? "") !== String(v ?? "")) diffs.push(`${k}: ${was ?? "(空)"} → ${v ?? "(空)"}`);
    }
    if (clientId) resolved.push({ off, name, clientId });
    if (existing && !diffs.length) continue;                      // 一致 = 何もしない
    plans.push({ off, name, clientId, insured: b.insured, insurer: b.insurer, claim, existing, diffs, src: b.src, replaced: b.replaced });
  }

  const adds = plans.filter((p) => !p.existing);
  const upds = plans.filter((p) => p.existing);
  console.log(`  新規 ${adds.length} 名 / 是正 ${upds.length} 名 / ` +
    `一致 ${bundle.size - plans.length - problems.length - kept.length} 名 / 意図的に据置 ${kept.length} 名\n`);
  for (const p of adds) {
    console.log(`  [新規] ${p.off.name} ${p.name}  ${p.claim.care_support_name} ` +
      `${p.claim.units}${p.claim.initial_addition ? `+初回${p.claim.initial_addition_units}` : ""}` +
      `+特定${p.claim.tokutei_kassan_units}+処遇${p.claim.shoguu_kaizen_units} = ${p.claim.total_amount.toLocaleString()}円  [${p.src}${p.replaced ? ` — ${p.replaced} を置き換え` : ""}]`);
  }
  for (const p of upds) {
    console.log(`  [是正] ${p.off.name} ${p.name}  [${p.src}${p.replaced ? ` — ${p.replaced} を置き換え (再請求)` : ""}]`);
    for (const d of p.diffs) console.log(`           ${d}`);
  }
  if (creates.length) {
    console.log(`
  -- 当方に居ない利用者 ${creates.length} 名${CREATE_MISSING ? " (作成します)" : " (--create-missing で作成)"} --`);
    for (const c of creates) {
      console.log(`     ${c.name} (${c.userNumber})  ${c.care_level}  保険者${c.insurer} 被保番${c.insured}`);
      console.log(`       生年 ${c.birth_date ?? "?"} / 認定 ${c.cert_start}〜${c.cert_end} / ${c.address ?? "住所なし"}`);
    }
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

  for (const c of creates) {
    // 利用者番号で既に居ることがある (認定レコードが無い / 保険者・被保番が違うだけ)。
    // その場合は新規作成せず、認定レコードと事業所割当だけ足す。
    const { data: exist, error: eE } = await sb.from("clients")
      .select("id, name").eq("tenant_id", TENANT).eq("user_number", c.userNumber);
    if (eE) { console.error(`✗ ${c.name} の照会失敗: ${eE.message}`); process.exit(1); }
    let made = (exist ?? [])[0] ?? null;
    if (made) {
      console.log(`  = ${c.name} は利用者番号 ${c.userNumber} で既に居る (${made.name}) — 認定と割当だけ足す`);
    } else {
      const ins0 = await sb.from("clients")
        .insert({ tenant_id: TENANT, name: c.name, user_number: c.userNumber,
          birth_date: c.birth_date, address: c.address, phone: c.phone,
          furigana: c.furigana, gender: c.gender, postal_code: c.postal_code,
          care_level: c.care_level })
        .select("id").single();
      if (ins0.error) { console.error(`✗ ${c.name} の作成失敗: ${ins0.error.message}`); process.exit(1); }
      made = ins0.data;
    }
    const ins = await sb.from("client_insurance_records").insert({
      tenant_id: TENANT, client_id: made.id, insured_number: c.insured, insurer_number: c.insurer,
      care_level: c.care_level, certification_start_date: c.cert_start, certification_end_date: c.cert_end,
      certification_status: "認定済み", record_status: "認定済み",
      notes: `[伝送取込 ${MONTH}] 月遅れで当初請求に居らず未登録だった`,
    });
    if (ins.error) { console.error(`✗ ${c.name} の認定作成失敗: ${ins.error.message}`); process.exit(1); }
    const has = await sb.from("client_office_assignments")
      .select("id").eq("client_id", made.id).eq("office_id", c.off.id);
    if (has.error) { console.error(`✗ ${c.name} の割当照会失敗: ${has.error.message}`); process.exit(1); }
    if (!(has.data ?? []).length) {
      const asg = await sb.from("client_office_assignments")
        .insert({ tenant_id: TENANT, client_id: made.id, office_id: c.off.id });
      if (asg.error) { console.error(`✗ ${c.name} の事業所割当失敗: ${asg.error.message}`); process.exit(1); }
    }
    console.log(`  + ${c.name} (${c.off.name})`);
    for (const p of plans) if (!p.clientId && p.insured === c.insured && p.insurer === c.insurer) p.clientId = made.id;
  }

  // 伝送でその事業所が請求している以上、その事業所の利用者である。
  // client は居るのに **その事業所への割当が無い**ことがあり、レセプトだけ入れても
  // 事業所別の集計から漏れる (高品 菊地滉・前嶋明 / ムツミ 4名 など計 12 名)。
  // 1 利用者が複数 office に紐づくのは設計どおりなので、足りなければ足す。
  for (const p of resolved) {
    const { data: has, error: eA } = await sb.from("client_office_assignments")
      .select("id").eq("client_id", p.clientId).eq("office_id", p.off.id);
    if (eA) { console.error(`✗ ${p.name} の割当照会失敗: ${eA.message}`); process.exit(1); }
    if ((has ?? []).length) continue;
    const { error: eI } = await sb.from("client_office_assignments")
      .insert({ tenant_id: TENANT, client_id: p.clientId, office_id: p.off.id });
    if (eI) { console.error(`✗ ${p.name} の割当追加失敗: ${eI.message}`); process.exit(1); }
    console.log(`  ⊕ ${p.name} を ${p.off.name} に割当 (伝送で請求されているため)`);
  }

  for (const p of plans) {
    const row = { ...p.claim, user_id: p.clientId, billing_month: MONTH, tenant_id: TENANT, status: "confirmed",
      notes: `[伝送取込 ${MONTH}] ${p.src} の 8124 から取込` };
    // 利用者を作らず既存を再利用したときは、その人に既にレセプトがあることがある
    // (認定レコードの保険者・被保番が違って引けなかっただけ)。(user_id, billing_month)
    // に UNIQUE があるので upsert で当てる。
    const q = p.existing
      ? await sb.from("kaigo_care_support_claims").update({ ...row, updated_at: new Date().toISOString() }).eq("id", p.existing.id)
      : await sb.from("kaigo_care_support_claims")
          .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "user_id,billing_month" });
    if (q.error) { console.error(`✗ ${p.name}: ${q.error.message}`); process.exit(1); }
    console.log(`  ✓ ${p.name}`);
  }
  console.log(`\n✓ 新規 ${adds.length} / 是正 ${upds.length} を保存しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
