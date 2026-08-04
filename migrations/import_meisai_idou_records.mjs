// ============================================================================
// ほのぼの「稼働データ」MEISAI CSV → kaigo_idou_shien_records 移動支援 実績取込
//
//   対象 = 内部コード 011001 移動支援(身体を伴う) / 011002 移動支援(身体を伴わない)
//   (010001「同行」は**同行訪問 = ヘルパーの同行手当**で請求対象外。取り込まない)
//
//   ⚠ 移動支援は**地域生活支援事業**で国保連に乗らない。市町村へ直接請求するため
//     単価は市町村ごとに違う (src/lib/idou-shien-rates.ts)。
//     単価表が未登録の市町村は金額を入れずに warning を出す (推測で入れない)。
//
//   使い方:
//     AREA_DIR=リンクス茂原 OFFICE_ID=<uuid> MAP_TAG=茂原 \
//       node migrations/import_meisai_idou_records.mjs            # DRY RUN
//     … --execute                                                # 本番 INSERT
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const TARGET_MONTH = "2026-06";
const AREA_DIR = process.env.AREA_DIR || "リンクス茂原";
const OFFICE_ID = process.env.OFFICE_ID || "e08c3706-ad59-4913-b4e2-67f2675422e9";
const TENANT_ID = "kt-group";
const MAP_TAG = process.env.MAP_TAG || "茂原";
const CSV_DIR = fileURLToPath(new URL(`../サービス実績データ/${AREA_DIR}/202606/`, import.meta.url));
const MARKER = `[MEISAI移動支援取込 ${TARGET_MONTH} ${MAP_TAG}]`;

// 対象コード → 身体介護の有無
const IDOU_CODES = { "011001": true, "011002": false };

function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const normBase = (s) => (s || "").normalize("NFKC").replace(/[\s　]/g, "");
const normClientName = (s) => normBase(s).replace(/[（(][^）)]*[）)]\s*$/, "").replace(/様$/, "");
const sjis = new TextDecoder("shift_jis");
function readCsv(file) {
  const text = sjis.decode(readFileSync(file));
  const lines = text.split(/\r?\n/).filter((l) => l !== "");
  const idx = {};
  lines[0].split(",").forEach((h, i) => (idx[h.trim()] = i));
  return { idx, rows: lines.slice(1).map((l) => l.split(",")) };
}
function santeiToMinutes(s) {
  const m = /^(\d+):(\d{2})$/.exec((s || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
async function fetchAll(table, cols, filter) {
  const out = []; const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function main() {
  console.log(`=== MEISAI 移動支援取込 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} 対象月=${TARGET_MONTH} 事業所=${AREA_DIR} ===\n`);

  // 1) CSV から 011001/011002 を集める
  const files = readdirSync(CSV_DIR).filter((f) => /^MEISAI_.*\.csv$/i.test(f));
  const rows = [];
  for (const f of files) {
    const { idx, rows: rs } = readCsv(path.join(CSV_DIR, f));
    const g = (c, name) => (idx[name] != null ? (c[idx[name]] || "").trim() : "");
    for (const c of rs) {
      const code = g(c, "サービスコード");
      if (!(code in IDOU_CODES)) continue;
      rows.push({
        file: f,
        clientName: g(c, "利用者名"),
        clientNum: g(c, "利用者番号"),
        date: g(c, "日付").replace(/\//g, "-"),
        start: g(c, "算定開始時刻") || g(c, "派遣開始時間"),
        end: g(c, "算定終了時刻") || g(c, "派遣終了時間"),
        planStart: g(c, "派遣開始時間"),
        planEnd: g(c, "派遣終了時間"),
        santei: g(c, "算定時間"),
        svcName: g(c, "サービス"),
        code,
        withBody: IDOU_CODES[code],
      });
    }
  }
  console.log(`CSV: ${files.length}ファイル / 移動支援 ${rows.length}行 / ${new Set(rows.map((r) => normClientName(r.clientName))).size}名`);
  if (rows.length === 0) { console.log("対象行なし。"); return; }

  // 2) 利用者を氏名で解決 (利用者番号は事業者エントリごとに別番号なので使わない)
  const asg = await fetchAll("client_office_assignments", "client_id",
    (q) => q.eq("office_id", OFFICE_ID).order("client_id"));
  const ids = [...new Set(asg.map((a) => a.client_id))];
  const byName = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("clients").select("id,name").in("id", ids.slice(i, i + 200));
    for (const c of data ?? []) {
      const k = normClientName(c.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(c.id);
    }
  }

  // 3) 市町村 = 地域生活支援受給者証。無ければ障害受給者証の市町村で代替
  const chiiki = await fetchAll("chiiki_recipient_certs", "client_id, municipality",
    (q) => q.order("client_id")).catch(() => []);
  const muniByClient = new Map((chiiki ?? []).map((c) => [c.client_id, c.municipality]));
  const certs = await fetchAll("shougai_certifications", "client_id, insurer_municipality",
    (q) => q.order("client_id"));
  const MUNI_CODE_TO_NAME = { 122192: "市原市", 122101: "茂原市", 124222: "睦沢町", 124419: "大多喜町" };
  for (const c of certs) {
    if (muniByClient.has(c.client_id)) continue;
    const v = (c.insurer_municipality || "").trim();
    if (!v) continue;
    muniByClient.set(c.client_id, MUNI_CODE_TO_NAME[v] ?? v);
  }

  // 4) 単価解決 (TS 側と同じ表を持つ。変更時は src/lib/idou-shien-rates.ts と揃えること)
  const MOBARA = { unit: "円", body: [2300, 4000, 5800, 6550, 7300, 8050], noBody: [800, 1500, 2250, 2950, 3650, 4350], stepBody: 700, stepNoBody: 700 };
  const OTAKI = { unit: "単位", body: [256, 404, 587, 669, 754, 837, 921], noBody: [106, 197, 275, 345], stepBody: 83, stepNoBody: 69 };
  const RATES = { 茂原市: MOBARA, 睦沢町: MOBARA, 大多喜町: OTAKI };
  const bandOf = (hm) => {
    const m = /^(\d{1,2}):(\d{2})/.exec((hm || "").trim());
    const mm = m ? Number(m[1]) * 60 + Number(m[2]) : 720;
    if (mm < 360 || mm >= 1320) return "深夜";
    if (mm < 480) return "早朝";
    if (mm < 1080) return "日中";
    return "夜間";
  };
  const calc = (muni, minutes, startHM, withBody) => {
    const r = RATES[(muni || "").trim()];
    if (!r || minutes <= 0) return null;
    const table = withBody ? r.body : r.noBody;
    const step = withBody ? r.stepBody : r.stepNoBody;
    const bracket = Math.max(1, Math.floor(minutes / 30) + 1);
    const base = bracket <= table.length ? table[bracket - 1] : table[table.length - 1] + step * (bracket - table.length);
    const band = bandOf(startHM);
    const sur = band === "深夜" ? 0.5 : band === "日中" ? 0 : 0.25;
    const v = Math.round(base * (1 + sur));
    return { units: r.unit === "単位" ? v : null, yen: r.unit === "単位" ? v * 10 : v, band, sur };
  };

  // 5) plan 構築
  const payloads = [];
  const unresolved = [], noMuni = [], noRate = new Map();
  for (const r of rows) {
    const hits = byName.get(normClientName(r.clientName)) ?? [];
    if (hits.length !== 1) { unresolved.push(`${r.clientName} (一致${hits.length})`); continue; }
    const cid = hits[0];
    const muni = muniByClient.get(cid);
    if (!muni) { noMuni.push(r.clientName); continue; }
    const minutes = santeiToMinutes(r.santei) ?? 0;
    const amt = calc(muni, minutes, r.start, r.withBody);
    if (!amt) { noRate.set(muni, (noRate.get(muni) ?? 0) + 1); }
    payloads.push({
      tenant_id: TENANT_ID, office_id: OFFICE_ID, client_id: cid,
      service_date: r.date,
      plan_start_time: r.planStart || null, plan_end_time: r.planEnd || null,
      start_time: r.start || null, end_time: r.end || null,
      calc_minutes: minutes,
      with_body_care: r.withBody,
      staff_count: 1,
      // 千葉市は独自コード体系だが茂原市・睦沢町・大多喜町はコードが無く金額で請求する。
      //   単位建ての市町村のみ units を入れ、円建ては notes の「NNNN円」を売上集計が読む。
      service_code: null,
      units: amt?.units ?? null,
      status: "draft",
      notes: `${MARKER} ${r.svcName} ${muni}${amt ? ` ${amt.yen}円 (${amt.band})` : " ⚠単価表未登録"}`,
    });
  }

  console.log(`\n=== 取込可否 ===`);
  console.log(`  取込可能: ${payloads.length} 行`);
  console.log(`  利用者未解決: ${unresolved.length}${unresolved.length ? " → " + [...new Set(unresolved)].join(", ") : ""}`);
  console.log(`  市町村不明: ${noMuni.length}${noMuni.length ? " → " + [...new Set(noMuni)].join(", ") : ""}`);
  if (noRate.size) {
    console.log(`  ⚠ 単価表 未登録の市町村 (金額なしで取込): ${[...noRate].map(([k, v]) => `${k} ${v}件`).join(", ")}`);
    console.log(`     → src/lib/idou-shien-rates.ts に単価表を追加してから再実行すると金額が入ります`);
  }
  const totalYen = payloads.reduce((s, p) => {
    const m = /(\d+)円/.exec(p.notes ?? ""); return s + (m ? Number(m[1]) : 0);
  }, 0);
  console.log(`  算定できた請求額 合計: ${totalYen.toLocaleString()} 円`);
  if (payloads[0]) console.log(`\nサンプル:\n`, JSON.stringify(payloads[0], null, 2));

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で INSERT します。"); return; }

  // 冪等: 同事業所・同月の取込行を削除してから入れ直す
  const { error: delErr } = await sb.from("kaigo_idou_shien_records").delete()
    .eq("office_id", OFFICE_ID).like("notes", `${MARKER.slice(0, 20)}%`);
  if (delErr) { console.error("✗ 既存削除失敗:", delErr.message); process.exit(1); }
  let done = 0;
  for (let i = 0; i < payloads.length; i += 200) {
    const chunk = payloads.slice(i, i + 200);
    const { error } = await sb.from("kaigo_idou_shien_records").insert(chunk);
    if (error) { console.error(`✗ INSERT失敗 (${done}件済): ${error.message}`); process.exit(1); }
    done += chunk.length;
  }
  console.log(`\n✓ 完了: ${done} 行 INSERT`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
