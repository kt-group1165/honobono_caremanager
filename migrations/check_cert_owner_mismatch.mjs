// ============================================================================
// 認定・レセプトが **別人に付いていないか** を利用者マスタ CSV と突合して検出する。
//
//   node migrations/check_cert_owner_mismatch.mjs
//   AREA=四街道 のような絞り込みは無い (全件を見る)
//
//   ⚠ **DB は一切書き換えない。** 何がおかしいかを出すだけ。
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   ほのぼのの **利用者番号は 1 人を指さない**。未採番の人には 2147483647
//   (int32 の最大値) が入り、それ以外でも番号が使い回される。取込がこれを
//   引き当てキーに使ったため、別人のデータが 1 人に積み上がる事故が繰り返し
//   起きている。2026-08-31 に見つかっただけでこれだけある:
//
//     利用者番号 2147483647  佐藤 喜美子 に 3 人分・レセプト 39,750 円
//     利用者番号 455         石井 洋子 の認定とレセプト 23,300 円が 鈴木 喜代子 に
//     利用者番号 411000325   古川 秀子 の被保番が 本多 ふじ江 に
//     利用者番号 11 / 674    御園政司⇔飯塚光子 / 荻野由紀子⇔児嶌巴
//
//   以前にも同じ形で fix_sato_kimiko_2147483647.mjs を書いている
//   (そのときは 佐藤喜美子 と 山口あき)。**取込を直すまで再発する**ので、
//   取込のたびに回して早く気づけるようにする。
//
// ── 判定 ────────────────────────────────────────────────────────────────
//   利用者マスタ CSV の (保険者番号, 被保険者番号) → 利用者名 を正とする。
//   当方の認定レコードの (保険者, 被保番) を CSV で引き、
//   その client の氏名と食い違えば **別人の認定** とみなす。
//
//   氏名は表記ゆれがあるので NFKC + 空白/括弧除去で正規化して比べる。
//   異体字 (髙/高・﨑/崎・齋/斎) も吸収する。それでも違うものだけ出す。
//
// ── 出すもの ────────────────────────────────────────────────────────────
//   ① 別人の認定を持っている利用者      … レセプト金額も併記する
//   ② 1 人が 2 人以上の認定を抱えている  … 受け皿になっている疑い
//   ③ 複数人が同じ利用者番号を持っている … 事故の温床
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const sjis = new TextDecoder("shift_jis");
function parseLine(line) {
  const out = []; let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(f); f = ""; }
    else f += c;
  }
  out.push(f); return out;
}

/** 氏名の正規化。表記ゆれ・異体字を吸収する */
const VARIANTS = {
  "髙": "高", "﨑": "崎", "齋": "斎", "齊": "斉", "濵": "浜", "邉": "辺", "邊": "辺",
  "冨": "富", "廣": "広", "德": "徳", "惠": "恵", "愼": "慎", "淸": "清", "眞": "真",
  "瀨": "瀬", "栁": "柳", "槗": "橋", "祐": "祐", "曻": "昇",
};
/**
 * 氏名の正規化。実データで踏んだゆれを全部落とす:
 *   末尾の注記      「桐ケ谷 幸子(介）」「野見山 満子(-）」「増田 セツ子(介」
 *                   「太田 綏枝（中央）」「市川 幹子(実)」
 *   異体字          惠/恵・愼/慎・﨑/崎・髙/高 など
 *   空白            全角/半角
 * ⚠ ここを緩めないと表記ゆれが「別人」として大量に出て、本物が埋もれる。
 */
function normNm(s) {
  return (s ?? "").normalize("NFKC")
    .replace(/[（(][^）)]*[）)]?\s*$/g, "")      // 末尾の注記 (閉じ括弧が無いものも)
    .replace(/[\s　()（）]/g, "")
    .replace(/[髙﨑齋齊濵邉邊冨廣德惠愼淸眞瀨栁槗曻]/g, (c) => VARIANTS[c] ?? c);
}

async function fetchAll(build) {
  const out = [];
  // ⚠ order 無しで range を回すと行が重複・欠落する
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function loadCsvPairNames() {
  const base = path.join(KAIGO, "利用者データ");
  const files = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let ents; try { ents = readdirSync(d); } catch { return; }
    for (const n of ents) {
      const p = path.join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/^介護保険.*\.csv$/i.test(n)) files.push(p);
    }
  };
  walk(base, 0);
  const map = new Map();
  for (const f of files) {
    const L = sjis.decode(readFileSync(f)).split(/\r?\n/).filter((x) => x !== "");
    if (!L.length) continue;
    const h = parseLine(L[0]).map((x) => x.trim());
    const ix = {}; h.forEach((x, i) => { if (!(x in ix)) ix[x] = i; });
    if (!("被保険者番号" in ix) || !("保険者番号" in ix) || !("利用者名" in ix)) continue;
    for (const line of L.slice(1)) {
      const r = parseLine(line);
      const g = (k) => (ix[k] != null && ix[k] < r.length ? (r[ix[k]] ?? "").trim() : "");
      const k = `${g("保険者番号")}|${g("被保険者番号")}`;
      const nm = g("利用者名");
      if (nm && !map.has(k)) map.set(k, nm);
    }
  }
  return { map, fileCount: files.length };
}

async function main() {
  console.log("=== 認定が別人に付いていないかを調べる (READ ONLY) ===\n");

  const { map: csvName, fileCount } = loadCsvPairNames();
  console.log(`利用者マスタ CSV ${fileCount} 本 / (保険者,被保番) ${csvName.size} 組\n`);

  const clients = (await fetchAll(() => sb.from("clients")
    .select("id, name, user_number, birth_date, insurer_number, insured_number, deleted_at")))
    .filter((c) => !c.deleted_at);
  const byId = new Map(clients.map((c) => [c.id, c]));
  const certs = await fetchAll(() => sb.from("client_insurance_records")
    .select("id, client_id, insurer_number, insured_number, care_level, notes"));
  const claims = await fetchAll(() => sb.from("kaigo_care_support_claims")
    .select("id, user_id, billing_month, insurer_number, insured_number, total_amount"));

  const claimByKey = new Map();
  for (const c of claims) {
    const k = `${c.user_id}|${c.insurer_number}|${c.insured_number}`;
    if (!claimByKey.has(k)) claimByKey.set(k, []);
    claimByKey.get(k).push(c);
  }

  // ① 別人の認定
  const mismatch = [];
  const namesPerClient = new Map();
  for (const r of certs) {
    const c = byId.get(r.client_id);
    if (!c || !r.insurer_number || !r.insured_number) continue;
    const key = `${r.insurer_number}|${r.insured_number}`;
    const owner = csvName.get(key);
    if (!owner) continue;                                  // CSV に無い番号は判定できない
    if (!namesPerClient.has(c.id)) namesPerClient.set(c.id, new Set());
    namesPerClient.get(c.id).add(normNm(owner));
    if (normNm(owner) === normNm(c.name)) continue;
    const cl = claimByKey.get(`${c.id}|${r.insurer_number}|${r.insured_number}`) ?? [];
    mismatch.push({ client: c, key, owner, careLevel: r.care_level, notes: r.notes, claims: cl });
  }

  console.log(`① 別人の認定を持っている利用者: ${mismatch.length} 件`);
  let money = 0;
  for (const m of mismatch) {
    const amt = m.claims.reduce((s, x) => s + (x.total_amount ?? 0), 0);
    money += amt;
    console.log(`   当方「${m.client.name}」(利番${m.client.user_number}) に  ${m.key} ${m.careLevel ?? ""}`);
    console.log(`      CSV では「${m.owner}」のもの` +
      (m.claims.length ? `  レセプト ${m.claims.map((x) => `${x.billing_month} ${x.total_amount}円`).join(" / ")}` : "") +
      (m.notes ? `  [${m.notes}]` : ""));
  }
  if (money) console.log(`   → 別人に付いているレセプト合計 ${money.toLocaleString()} 円`);

  // ② 受け皿になっている利用者
  const hosts = [...namesPerClient.entries()].filter(([, s]) => s.size > 1);
  console.log(`\n② 2 人以上の認定を抱えている利用者: ${hosts.length} 件`);
  for (const [id, s] of hosts) {
    const c = byId.get(id);
    console.log(`   ${c.name} (利番${c.user_number})  → ${[...s].join(" / ")}`);
  }

  // ③ 同じ利用者番号を複数人が持っている
  const byNum = new Map();
  for (const c of clients) {
    const n = String(c.user_number ?? "");
    if (!n) continue;
    if (!byNum.has(n)) byNum.set(n, []);
    byNum.get(n).push(c);
  }
  const shared = [...byNum.entries()].filter(([, v]) => v.length > 1);
  console.log(`\n③ 同じ利用者番号を複数人が持っている: ${shared.length} 件`);
  for (const [n, v] of shared.slice(0, 20)) {
    console.log(`   利番${n}  ${v.map((c) => `${c.name}(生${c.birth_date ?? "?"})`).join(" / ")}`);
  }
  if (shared.length > 20) console.log(`   … 他 ${shared.length - 20} 件`);

  console.log("\n─────────────────────────────────────────");
  if (!mismatch.length && !hosts.length) {
    console.log("別人の認定は見つかりませんでした。");
  } else {
    console.log("⚠ 取込が利用者番号で引き当てている限り再発します。");
    console.log("  引き当ては必ず (保険者番号, 被保険者番号) の対で行うこと。");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
