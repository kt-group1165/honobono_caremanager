// ============================================================================
// ほのぼの more【障がい福祉利用者管理】→ CSV から受給者証・契約支給量を取り込む。
//
//   利用者データ/全社_R8-08/障害_受給者証.CSV       124列 (SRD18)
//   利用者データ/全社_R8-08/障害_事業者記入欄.CSV     83列 (SRD25)
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   これまで受給者証は **PDF を parse** していた (parse_shougai_certs.py)。
//   CSV で出せることが分かった (2026-08-30) ので、そちらを正にする。
//   事業者記入欄には **契約支給量**が入っている。手入力していた項目。
//
// ── 出し方 ────────────────────────────────────────────────────────────
//   障がい福祉サービス費等請求システム → ツールバー【利用者管理】→【CSV出力】
//   ⚠ 先に左パネルの「絞込み有効」→ **○全員** にする。
//     既定の「施設利用」だと今開いている事業所ぶんしか出ない (34件 → 6,189件)。
//   期間は「その期間に有効な受給者証」。H31/1/1〜R8/8/31 で全期間ぶん。
//
//   node migrations/import_shougai_certs_from_honobono_csv.mjs            # DRY RUN
//   node migrations/import_shougai_certs_from_honobono_csv.mjs --execute
//   env: MONTH=2026-06 (この月に有効な受給者証だけを対象にする)
//        ALL=1        (期間で絞らず全世代を対象にする)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const ALL = process.env.ALL === "1";
/** 当方にあってほのぼのに無い支給量キーを消してよいか (既定は消さない) */
const REPLACE = process.env.REPLACE === "1";
const MONTH = process.env.MONTH || "2026-06";
const MONTH_START = `${MONTH}-01`;
const MONTH_END = new Date(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)
  .toISOString().slice(0, 10);
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const SRC = path.join(KAIGO, "利用者データ/全社_R8-08");

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
const readCsv = (file) => {
  const p = path.join(SRC, file);
  if (!existsSync(p)) { console.error(`✗ ${p} がありません`); process.exit(1); }
  const rows = iconv.decode(readFileSync(p), "Shift_JIS")
    .split(/\r?\n/).filter((l) => l.trim()).map((l) => splitCsv(l).map((s) => s.trim()));
  return { head: rows[0], rows: rows.slice(1) };
};
const iso = (s) => {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s ?? "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};
const num = (s) => {
  const n = Number(String(s ?? "").trim());
  return Number.isFinite(n) ? n : null;
};
/** 「20.00」(時間) → { hours, minutes }。0 は入れない */
const toHM = (s) => {
  const n = num(s);
  if (n == null || n === 0) return null;
  const hours = Math.floor(n);
  const minutes = Math.round((n - hours) * 60);
  return { hours, minutes };
};
/** 利用者でないテスト登録 (「八千代１ テスト１」等) */
const isDummy = (name) =>
  /テスト/.test(name ?? "") || /^[★◆◎●■☆〇○◇▲△▼▽※＊*]/.test((name ?? "").trim());

/**
 * SRD18 の支給量列 → shikyuryo_details のローマ字キー。
 * ⚠ 正は _shikyuryo_keys.mjs / shougai-cert-content.tsx の SHIKYURYO_ITEMS。
 *   日本語キーのまま入れると画面の支給量欄が空になり超過警告も出ない。
 */
/**
 * 単位が「回」の支給量。それ以外は時間。
 * ⚠ 乗降介助だけ回数で持つ (当方の既存データも {count} で入っている)。
 *   ここを間違えると {hours:40} と {count:40} で毎回差分が出続ける。
 */
const COUNT_KEYS = new Set(["jouko"]);

const SHIKYURYO_COLS = {
  25: "shintai",                  // 身体介護
  26: "kaji",                     // 家事援助
  27: "tsuuin",                   // 通院介助(移動介護)
  28: "tsuuin_shintai",           // 通院介助(移動)・身体
  50: "jouko",                    // 乗降介助
  51: "koudou",                   // 行動援護
  52: "idou",                     // 外出介護
  67: "juudo_houmon_houkatsu",    // 重度訪問介護重度包括
  68: "juudo_houmon_kubun6",      // 重度訪問介護区分６
  69: "juudo_houmon_sonota",      // 重度訪問介護その他
  93: "doukou",                   // 同行援護
  94: "doukou_shintai",           // 同行援護・身体
};

const C = {
  no: 0, name: 1, kana: 2, birth: 3,
  kind: 17, facility: 18, jukyu: 19, issue: 20, city: 21, from: 22, to: 23, level: 24,
  rate: 55, income: 56, limit: 57, reducedLimit: 58, shafuku: 59,
  jogenOffice: 64, kyoukaisou: 66, householdMulti: 89,
  monitoring: 99, cityAmount: 101, applying: 107, h30: 108,
};

async function fetchAll(table, select, tweak) {
  let out = [], from = 0;
  for (;;) {
    let q = sb.from(table).select(select).range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function main() {
  console.log(`=== 障害 受給者証取込 ${ALL ? "(全世代)" : MONTH} ` +
    `${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const cert = readCsv("障害_受給者証_H31-R8.CSV");
  const keiyaku = readCsv("障害_事業者記入欄.CSV");
  console.log(`  受給者証 ${cert.rows.length} 行 / 事業者記入欄 ${keiyaku.rows.length} 行`);

  // 対象の受給者証行を選ぶ
  const target = [];
  let dummies = 0, outOfMonth = 0;
  for (const r of cert.rows) {
    if (r.length <= C.h30) continue;
    if (isDummy(r[C.name])) { dummies++; continue; }
    const from = iso(r[C.from]), to = iso(r[C.to]);
    if (!from) continue;
    if (!ALL && (from > MONTH_END || (to && to < MONTH_START))) { outOfMonth++; continue; }
    target.push(r);
  }
  console.log(`  対象 ${target.length} 行 (テスト登録 ${dummies} / 期間外 ${outOfMonth})\n`);

  // 事業者記入欄を (受給者証番号, 契約日) で束ねる
  const K = { jukyu: 19, jigyo: 42, entryNo: 43, date: 44, kubun: 45, svc: 46,
    qtyH: 47, qtyD: 48, endDate: 51, endKubun: 52, jogenOffice: 70 };
  const contracts = new Map();
  for (const r of keiyaku.rows) {
    if (r.length <= K.jogenOffice) continue;
    if (!r[K.jukyu] || !r[K.svc]) continue;
    if (!contracts.has(r[K.jukyu])) contracts.set(r[K.jukyu], []);
    contracts.get(r[K.jukyu]).push({
      office: r[K.jigyo], entryNo: r[K.entryNo], date: iso(r[K.date]), kubun: r[K.kubun],
      svc: r[K.svc], qtyH: r[K.qtyH], qtyD: r[K.qtyD],
      endDate: iso(r[K.endDate]), endKubun: r[K.endKubun], jogenOffice: r[K.jogenOffice],
    });
  }
  console.log(`  契約のある受給者証番号 ${contracts.size} 件\n`);

  // 当方の受給者証
  const mine = await fetchAll("shougai_certifications",
    "id, client_id, beneficiary_number, certification_start_date, certification_end_date," +
    " support_level, income_category, self_payment_limit, jogen_kanri_kubun," +
    " jogen_kanri_office_name, shikyuryo_details, contract_amount_text," +
    " contract_start_date, contract_entry_number, issue_date, insurer_municipality," +
    " clients(name)");
  const byKey = new Map();          // 受給者証番号|開始日
  const byJukyu = new Map();        // 受給者証番号 → 行
  for (const r of mine) {
    if (!r.beneficiary_number) continue;
    byKey.set(`${r.beneficiary_number}|${r.certification_start_date}`, r);
    if (!byJukyu.has(r.beneficiary_number)) byJukyu.set(r.beneficiary_number, []);
    byJukyu.get(r.beneficiary_number).push(r);
  }
  console.log(`  当方の受給者証 ${mine.length} 件 / 受給者証番号 ${byJukyu.size} 種\n`);

  // ── CSV 行 → 当方の受給者証 の対応づけ ──────────────────────────────
  //   ⚠ ほのぼの側は世代ごとに行があるので、素直に回すと **同じ 1 行に複数世代が
  //     当たって最後の世代で上書き**してしまう (新井健讓で発覚)。
  //     当方 1 行につき **対象月に最も近い 1 世代だけ**を採る。
  //   さらに、ほのぼのは **サービス種別ごとに行が分かれる** (施設種別 列18)。
  //   同じ受給者証番号で「居宅介護」と「同行援護」が別行になるので、
  //   1 行だけ採ると片方の支給量が消える。**当方 1 行に対して支給量はマージ**する。
  const group = new Map();     // 当方の cert.id → { row, rows[] }
  const onlyHono = [], ambiguous = [];
  for (const r of target) {
    const jukyu = r[C.jukyu], from = iso(r[C.from]);
    let row = byKey.get(`${jukyu}|${from}`);
    if (!row) {
      // 開始日が違うだけ (当方が古い/新しい世代を持っている) ケースを拾う
      const cands = byJukyu.get(jukyu) ?? [];
      if (cands.length === 1) row = cands[0];
      else if (cands.length > 1) { ambiguous.push({ jukyu, name: r[C.name] }); continue; }
    }
    if (!row) { onlyHono.push({ jukyu, name: r[C.name], from, to: iso(r[C.to]) }); continue; }
    if (!group.has(row.id)) group.set(row.id, { row, rows: [] });
    group.get(row.id).rows.push(r);
  }

  const updates = [], kept = [];
  for (const { row, rows } of group.values()) {
    // 日付・区分・所得区分などは **最も新しい世代**を採る
    rows.sort((a, b) => String(iso(a[C.from])).localeCompare(String(iso(b[C.from]))));
    const r = rows[rows.length - 1];
    const jukyu = r[C.jukyu], to = iso(r[C.to]);

    // 支給量
    // 支給量は同じ受給者証の **全サービス種別行をマージ**する (同じキーは大きいほう)
    const shikyuryo = {};
    for (const rr of rows) {
      for (const [col, key] of Object.entries(SHIKYURYO_COLS)) {
        if (COUNT_KEYS.has(key)) {
          const n = num(rr[Number(col)]);
          if (n && (shikyuryo[key]?.count ?? 0) < n) shikyuryo[key] = { count: n };
          continue;
        }
        const hm = toHM(rr[Number(col)]);
        if (!hm) continue;
        const cur = shikyuryo[key];
        const mins = hm.hours * 60 + hm.minutes;
        if (!cur || (cur.hours * 60 + cur.minutes) < mins) shikyuryo[key] = hm;
      }
    }
    // ⚠ 列27「通院介助(移動介護)支給量」は 通院介助 と 移動介護 のどちらにも読める。
    //   当方は受給者証 PDF から起こして idou (移動介護) で持っている人がいるので、
    //   **同じ量なら当方の区分を優先**する (勝手に付け替えない)。
    if (shikyuryo.tsuuin && row.shikyuryo_details?.idou && !row.shikyuryo_details?.tsuuin) {
      const a = shikyuryo.tsuuin, b = row.shikyuryo_details.idou;
      if (a.hours === b.hours && (a.minutes ?? 0) === (b.minutes ?? 0)) {
        shikyuryo.idou = shikyuryo.tsuuin;
        delete shikyuryo.tsuuin;
      }
    }
    // 契約 (対象月に有効なもの)
    const cs = (contracts.get(jukyu) ?? []).filter((c) =>
      c.date && (ALL || (c.date <= MONTH_END && (!c.endDate || c.endDate >= MONTH_START))));
    // 同じサービスでも事業所ごとに 1 行ある。事業所名を付けないと重複に見える
    const contractText = cs.map((c) => {
      const qty = c.qtyH || c.qtyD || "";
      const office = c.office ? ` (${c.office})` : "";
      return `${c.svc} ${qty}${office}`.trim();
    }).filter(Boolean).join(" / ") || null;

    const patch = {};
    const d = [];
    const setIf = (col, val, label) => {
      if (val == null || val === "") return;
      const cur = row[col];
      if (String(cur ?? "") === String(val)) return;
      patch[col] = val;
      d.push(`${label}: ${cur ?? "(空)"} → ${val}`);
    };
    setIf("certification_end_date", to, "終了日");
    setIf("support_level", r[C.level] ? `区分${r[C.level].normalize("NFKC")}` : null, "区分");
    setIf("income_category", r[C.income], "所得区分");
    setIf("issue_date", iso(r[C.issue]), "交付日");
    const lim = num(r[C.limit]);
    if (lim != null && Number(row.self_payment_limit ?? -1) !== lim) {
      patch.self_payment_limit = lim;
      d.push(`上限月額: ${row.self_payment_limit} → ${lim}`);
    }
    if (r[C.jogenOffice]) {
      setIf("jogen_kanri_office_name", r[C.jogenOffice], "上限管理事業者");
    }
    // ⚠ 当方にあってほのぼのに無いキーは **既定では消さない**。
    //   受給者証の世代・サービス種別の取り違えで支給量が減ると、超過警告が
    //   出なくなって過大請求に直結する。消したいときだけ REPLACE=1。
    const dropped = Object.keys(row.shikyuryo_details ?? {}).filter((k) => !(k in shikyuryo));
    if (dropped.length && !REPLACE) {
      for (const k of dropped) shikyuryo[k] = row.shikyuryo_details[k];
      kept.push({ name: row.clients?.name ?? r[C.name], jukyu, dropped });
    }

    if (Object.keys(shikyuryo).length) {
      // ⚠ JSON.stringify をそのまま比べるとキーの並び順だけで差分に見える。
      //   キーをソートして正規化してから比べる。
      const canon = (o) => JSON.stringify(Object.fromEntries(
        Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b))));
      const cur = canon(row.shikyuryo_details);
      if (cur !== canon(shikyuryo)) {
        patch.shikyuryo_details = shikyuryo;
        d.push(`支給量: ${cur} → ${canon(shikyuryo)}`);
      }
    }
    if (contractText) setIf("contract_amount_text", contractText, "契約支給量");
    if (cs.length) {
      setIf("contract_start_date", cs[0].date, "契約日");
      setIf("contract_entry_number", cs[0].entryNo, "事業者記入欄番号");
    }
    if (d.length) updates.push({ id: row.id, name: row.clients?.name ?? r[C.name], jukyu, d, patch });
  }

  console.log(`  更新する受給者証 ${updates.length} 件`);
  const withContract = updates.filter((u) => "contract_amount_text" in u.patch).length;
  const withShikyu = updates.filter((u) => "shikyuryo_details" in u.patch).length;
  console.log(`     うち 契約支給量が入る ${withContract} 件 / 支給量が入る ${withShikyu} 件`);
  for (const u of updates.slice(0, 20)) {
    console.log(`     ${u.name.padEnd(14)} [${u.jukyu}]`);
    for (const y of u.d.slice(0, 4)) console.log(`         ${y}`);
  }
  if (updates.length > 20) console.log(`     … 他 ${updates.length - 20} 件`);

  // 支給量は請求の上限判定に直結するので全件出す
  const shikyuChanges = updates.filter((u) => "shikyuryo_details" in u.patch);
  if (shikyuChanges.length) {
    console.log(`\n  -- 支給量が変わるもの ${shikyuChanges.length} 件 --`);
    for (const u of shikyuChanges) {
      console.log(`     ${u.name.padEnd(14)} [${u.jukyu}]`);
      console.log(`         ${u.d.find((x) => x.startsWith("支給量:"))}`);
    }
  }
  if (kept.length) {
    console.log(`\n  -- 当方にあってほのぼのに無い支給量 ${kept.length} 件 (消さずに残す) --`);
    for (const k of kept) {
      console.log(`     ${k.name.padEnd(14)} [${k.jukyu}]  ${k.dropped.join(", ")}`);
    }
    console.log(`     ※ 消してよいと判断できたら REPLACE=1 で実行する`);
  }

  console.log(`\n  ほのぼのにあり当方に無い ${onlyHono.length} 件`);
  for (const x of onlyHono.slice(0, 10)) console.log(`     ${x.name} [${x.jukyu}] ${x.from}〜${x.to}`);
  if (onlyHono.length > 10) console.log(`     … 他 ${onlyHono.length - 10} 件`);
  if (ambiguous.length) {
    console.log(`\n  受給者証番号が当方で複数世代あり特定できない ${ambiguous.length} 件`);
    for (const x of ambiguous.slice(0, 5)) console.log(`     ${x.name} [${x.jukyu}]`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で反映します。"); return; }

  let n = 0;
  for (const u of updates) {
    const { error } = await sb.from("shougai_certifications")
      .update({ ...u.patch, updated_at: new Date().toISOString() }).eq("id", u.id);
    if (error) { console.error(`✗ ${u.name}: ${error.message}`); process.exit(1); }
    n++;
    if (n % 100 === 0) console.log(`  … ${n}/${updates.length}`);
  }
  console.log(`\n✓ ${n} 件を更新しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
