/**
 * 「ヘルパーが働いているのに、どこにも請求されていない利用者」を洗い出す。
 *
 * ══ なぜ要るか ═══════════════════════════════════════════════════════════════
 *   2026-08-31、高品の 加茂 照子 に 28 回の稼働 (身1×21 / 身3×2 / 身2×1 / 同行×4) が
 *   あるのに、**伝送データ全体を探しても 1 行も無い** ことが分かった。
 *   有効な認定 (要介護5) を持っているので資格が無いわけでもない。
 *   1 人の話とは思えないので、同じものを全拠点・全 MEISAI で機械的に出す。
 *
 * ══ 使い方 ═══════════════════════════════════════════════════════════════════
 *   npm run check:billing-gap
 *   MONTH=2026-06 npm run check:billing-gap
 *   npm run check:billing-gap -- --area 高品
 *
 *   出る金額は MEISAI の「金額」= **ヘルパーに払った賃金**。請求額ではない。
 *
 *   DB は読み取りのみ。伝送データも読むだけ (新システム/*.CSV は書かない)。
 *
 * ══ 判定 ═════════════════════════════════════════════════════════════════════
 *   MEISAI に稼働行がある利用者について、その番号が **同じ制度の伝送**に出てくるかを見る。
 *     介護の稼働 → 被保険者番号 が 介護/居宅 の伝送に出てくるか
 *     障害の稼働 → 受給者証番号 が 障害 の伝送に出てくるか
 *
 *   ⚠ 制度をまたいで見てはいけない。両制度を持つ利用者は 59 名いて、
 *     「障害では請求されているが介護は未請求」が実在する
 *     (高品 加茂 照子: 介護 28 回が未請求なのに障害は請求済み)。
 *     一括で見ると請求漏れを見落とす。
 *
 *   ⚠ **MEISAI はヘルパーの勤務実績であって請求実績ではない。**
 *     自費サービス・保険外・他事業所が請求 のケースが正当に有りうるので、
 *     ここに出たものが全部 請求漏れとは限らない。**人が見るための一覧**。
 *     (前例: 姉ム 工藤 孝子 81,999 円は被保番なしで載っていた 2026-08-04)
 *
 *   ⚠ 伝送データが手元に無い拠点は判定できないので「判定不能」として分けて出す。
 *     無いものを「請求漏れ」と言わない。
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KAIGO = join(__dirname, "..");
const MONTH = process.env.MONTH ?? "2026-06";
const YYYYMM = MONTH.replace("-", "");
const AREA = (() => {
  const i = process.argv.indexOf("--area");
  return i >= 0 ? process.argv[i + 1] : "";
})();

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
  console.log("check:billing-gap: スキップ (env 必要)");
  process.exit(0);
}
const supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const decodeSjis = (p: string): string => new TextDecoder("shift_jis").decode(readFileSync(p));

function walk(dir: string, hit: (p: string) => void): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, hit);
    else hit(p);
  }
}

/** MEISAI 1 行ぶん。列はファイルごとに違うので **ヘッダー名で引く** */
interface Worked {
  area: string;
  file: string;
  clientNum: string;
  clientName: string;
  rows: number;
  amount: number;
  codes: Set<string>;
  system: "介護" | "障害" | "?";
}

function readMeisai(): Map<string, Worked> {
  const out = new Map<string, Worked>();
  const base = join(KAIGO, "サービス実績データ");
  walk(base, (p) => {
    if (!/^MEISAI.*\.csv$/i.test(basename(p))) return;
    const rel = p.slice(base.length + 1);
    const parts = rel.split(sep);
    const area = parts[0];
    if (AREA && area !== AREA) return;
    if (!rel.includes(YYYYMM)) return;
    const system = rel.includes(`${sep}障害${sep}`) ? "障害" : rel.includes(`${sep}介護${sep}`) ? "介護" : "?";

    const lines = decodeSjis(p).split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return;
    const header = lines[0].split(",").map((h) => h.trim());
    const gi = (n: string) => header.indexOf(n);
    const iNum = gi("利用者番号"), iName = gi("利用者名"), iCode = gi("サービスコード"), iAmt = gi("金額");
    if (iNum < 0 || iName < 0) return;         // MEISAI ではない (CHINGIN 等)
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      const num = (c[iNum] ?? "").trim();
      if (!num) continue;
      const key = `${area}|${system}|${num}`;
      let w = out.get(key);
      if (!w) {
        w = { area, file: basename(p), clientNum: num, clientName: (c[iName] ?? "").trim(), rows: 0, amount: 0, codes: new Set(), system };
        out.set(key, w);
      }
      w.rows++;
      const amt = Number((c[iAmt] ?? "").replace(/[^0-9.-]/g, ""));
      if (Number.isFinite(amt)) w.amount += amt;
      const code = (c[iCode] ?? "").trim();
      if (code) w.codes.add(code);
    }
  });
  return out;
}

/**
 * 伝送データに出てくる番号を **制度ごとに** 集める。
 * 制度はフォルダで決まる: …/訪問介護/障害/… は障害、それ以外 (介護・居宅・訪問入浴) は介護。
 */
function readDensouNumbers(): { kaigo: Set<string>; shogai: Set<string>; areas: Set<string>; files: number } {
  const kaigo = new Set<string>();
  const shogai = new Set<string>();
  const areas = new Set<string>();
  let files = 0;
  const base = join(KAIGO, "伝送データ");
  if (!existsSync(base)) return { kaigo, shogai, areas, files };
  walk(base, (p) => {
    const name = basename(p);
    if (!/\.csv$/i.test(name)) return;
    if (/解説/.test(name)) return;
    // 当方が書き出したものは「ほのぼのが請求したか」の判定材料にならない
    if (p.includes(`${sep}新システム${sep}`)) return;
    if (!p.includes(YYYYMM)) return;
    files++;
    const rel = p.slice(base.length + 1);
    areas.add(rel.split(sep)[0]);
    const text = decodeSjis(p);
    const into = rel.includes(`${sep}障害${sep}`) ? shogai : kaigo;
    // 引用符つき/なし どちらでも拾えるように 10 桁の英数字を機械的に集める
    for (const m of text.matchAll(/[0-9A-Za-z]{10}/g)) into.add(m[0]);
  });
  return { kaigo, shogai, areas, files };
}

async function fetchAll<T>(build: () => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await build();
  if (error) throw new Error(String((error as { message?: string }).message ?? error));
  return data ?? [];
}

async function main(): Promise<void> {
  console.log(`稼働はあるのに請求されていない利用者を探す (${MONTH})${AREA ? ` — 拠点=${AREA}` : ""}`);

  const worked = readMeisai();
  console.log(`MEISAI: 利用者 ${worked.size} 件ぶん (拠点×制度×利用者番号)`);

  const densou = readDensouNumbers();
  console.log(`伝送データ: ${densou.files} 本 / 拠点 ${densou.areas.size} / 番号 介護 ${densou.kaigo.size} 種類・障害 ${densou.shogai.size} 種類`);
  if (densou.files === 0) {
    console.log("伝送データが 1 本も無いので判定できません。");
    process.exit(0);
  }

  // 利用者番号 → client_id (取込と同じマッピングファイルを使う)
  const mapCache = new Map<string, Record<string, string>>();
  const loadMap = (area: string): Record<string, string> | null => {
    if (mapCache.has(area)) return mapCache.get(area)!;
    const p = join(KAIGO, "migrations", `_meisai_num_to_client_${area}.json`);
    if (!existsSync(p)) return null;
    const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
    mapCache.set(area, m);
    return m;
  };

  const clientIds = new Set<string>();
  const resolved = new Map<string, string>();     // key -> client_id
  const unmapped: Worked[] = [];                  // ファイルはあるが番号が載っていない
  const noMapFile: Worked[] = [];                 // その拠点のマッピングファイル自体が無い
  for (const [key, w] of worked) {
    const m = loadMap(w.area);
    if (!m) { noMapFile.push(w); continue; }       // 拠点ごと未着手 or ファイル名がフォルダ名と違う
    const cid = m[w.clientNum];
    if (!cid) { unmapped.push(w); continue; }
    resolved.set(key, cid);
    clientIds.add(cid);
  }

  // client_id → 番号。介護 (被保険者番号) と 障害 (受給者証番号) を分けて持つ
  const kaigoNo = new Map<string, string[]>();
  const shogaiNo = new Map<string, string[]>();
  const ids = [...clientIds];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const certs = await fetchAll<{ client_id: string; insured_number: string | null }>(() =>
      supabase.from("client_insurance_records").select("client_id, insured_number").in("client_id", chunk));
    for (const c of certs) {
      if (!c.insured_number) continue;
      if (!kaigoNo.has(c.client_id)) kaigoNo.set(c.client_id, []);
      kaigoNo.get(c.client_id)!.push(c.insured_number.trim());
    }
    const sho = await fetchAll<{ client_id: string; beneficiary_number: string | null }>(() =>
      supabase.from("shougai_certifications").select("client_id, beneficiary_number").in("client_id", chunk));
    for (const c of sho) {
      if (!c.beneficiary_number) continue;
      if (!shogaiNo.has(c.client_id)) shogaiNo.set(c.client_id, []);
      shogaiNo.get(c.client_id)!.push(c.beneficiary_number.trim());
    }
  }

  const notBilled: (Worked & { why: string })[] = [];
  const noNumber: Worked[] = [];
  let billed = 0;
  for (const [key, w] of worked) {
    const cid = resolved.get(key);
    if (!cid) continue;                                   // unmapped は別枠
    // 制度ごとに、その制度の番号を その制度の伝送 と突き合わせる
    const isShogai = w.system === "障害";
    const nums = (isShogai ? shogaiNo.get(cid) : kaigoNo.get(cid)) ?? [];
    const pool = isShogai ? densou.shogai : densou.kaigo;
    if (nums.length === 0) { noNumber.push(w); continue; }
    if (nums.some((n) => pool.has(n))) { billed++; continue; }
    if (!densou.areas.has(w.area)) continue;              // その拠点の伝送が手元に無い → 判定不能
    notBilled.push({ ...w, why: `番号 ${nums.join("/")} が伝送に無い` });
  }

  // ⚠ MEISAI の「金額」は **ヘルパーに払った賃金** (出どころが NEXT の賃金集計)。
  //   請求額ではないので、そのつもりで表示する。桁の大きさを掴むための目安。
  const yen = (n: number) => n.toLocaleString() + "円";
  console.log("");
  console.log(`請求されている ${billed} / 請求が見当たらない ${notBilled.length} / 番号未登録 ${noNumber.length}`);
  console.log(`取込に載っていない: 番号がマッピングに無い ${unmapped.length} / 拠点ごとマッピング未整備 ${noMapFile.length}`);

  if (notBilled.length) {
    console.log(`${EOL_}★ 稼働はあるのに伝送に 1 行も無い (${notBilled.length} 名) — 人が見て 自費/保険外/他事業所請求 でないか確かめること
   (金額は **ヘルパーに払った賃金**。請求額ではない)`);
    notBilled.sort((a, b) => b.amount - a.amount);
    for (const w of notBilled) {
      console.log(`   ${w.area.padEnd(8)} ${w.system.padEnd(2)} ${w.clientName.padEnd(16)} ${String(w.rows).padStart(3)}回 ${yen(w.amount).padStart(12)}  コード ${[...w.codes].join(",")}`);
    }
  }
  if (noNumber.length) {
    console.log(`${EOL_}被保険者番号 / 受給者証番号が当方に無い (${noNumber.length} 名) — 登録漏れの疑い`);
    noNumber.slice(0, 20).forEach((w) => console.log(`   ${w.area.padEnd(8)} ${w.system.padEnd(2)} ${w.clientName.padEnd(16)} ${String(w.rows).padStart(3)}回 ${yen(w.amount).padStart(12)}`));
    if (noNumber.length > 20) console.log(`   … 他 ${noNumber.length - 20} 名`);
  }
  if (noMapFile.length) {
    const byArea = new Map<string, { n: number; amount: number }>();
    for (const w of noMapFile) {
      const a = byArea.get(w.area) ?? { n: 0, amount: 0 };
      a.n++; a.amount += w.amount; byArea.set(w.area, a);
    }
    console.log(`${EOL_}拠点ごとマッピングが無い (${noMapFile.length} 名) — migrations/_meisai_num_to_client_<拠点>.json が無い`);
    console.log("   ⚠ フォルダ名とファイル名が違うだけのこともある (例 さつきが丘 ↔ さつき)");
    [...byArea].sort((a, b) => b[1].amount - a[1].amount)
      .forEach(([a, v]) => console.log(`   ${a.padEnd(10)} ${String(v.n).padStart(4)} 名  ${yen(v.amount)}`));
  }
  if (unmapped.length) {
    console.log(`${EOL_}番号がマッピングに無い (${unmapped.length} 名) — 実績がそもそも DB に入らない`);
    unmapped.sort((a, b) => b.amount - a.amount);
    unmapped.slice(0, 20).forEach((w) => console.log(`   ${w.area.padEnd(8)} ${w.system.padEnd(2)} ${w.clientName.padEnd(16)} 番号${w.clientNum} ${String(w.rows).padStart(3)}回 ${yen(w.amount).padStart(12)}`));
    if (unmapped.length > 20) console.log(`   … 他 ${unmapped.length - 20} 名`);
  }
  console.log(`${EOL_}(この一覧は判断材料。MEISAI は勤務実績であって請求実績ではない)`);
}

const EOL_ = String.fromCharCode(10);

main().catch((e: unknown) => {
  console.error("check:billing-gap 実行エラー:", e instanceof Error ? e.message : e);
  process.exit(1);
});
