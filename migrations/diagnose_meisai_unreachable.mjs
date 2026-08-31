// ============================================================================
// MEISAI の「利用者に辿り着けない」を原因別に分ける — READ ONLY (書込なし)
//
//   MONTH=2026-06 node migrations/diagnose_meisai_unreachable.mjs
//   MONTH=2026-06 AREA=山武 node migrations/diagnose_meisai_unreachable.mjs   # 1 拠点だけ全件
//
// `npm run check:billing-gap` が出す「利用者に辿り着けない 154 名」と
// `propose_meisai_client_mapping.mjs` の「該当者が見つからない 151 件」は、
// **どちらも理由を書いていない**ので次の一手が決まらない。ここで分ける。
//
//   A 利用者は居るが **その拠点の割当が無い**
//       → client_office_assignments を足せば解決する。取込の副作用で消えたか、
//         そもそも張られていないか。氏名だけで人を決めているので **人の確認が要る**。
//   B 同姓が複数いて決められない
//       → 生年月日・被保険者番号など別の材料が要る。
//   C 利用者自体が居ない
//       → 利用者マスタの取込が要る (利用者データ/…_登録有/ が手元にある)。
//
// ⚠ **ここでは何も書き換えない。**氏名だけで人を決めると別人に当たる事故が
//   繰り返し起きている (利用者番号は拠点の中でしか一意でない、同姓同名が居る)。
//   このスクリプトは「次に何をすればよいか」を決めるための材料を出すだけ。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { officesForArea } from "./_area_offices.mjs";

const MONTH = process.env.MONTH || "2026-06";
/** AREA=山武 でその拠点だけに絞る (既定は全拠点) */
const AREA = process.env.AREA || "";
const YYYYMM = MONTH.replace("-", "");
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

const PAGE = 1000;
async function fetchAll(table, select) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(select).order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

/** propose_meisai_client_mapping.mjs と同じ正規化 (ズレると結論が変わるので合わせる) */
const ITAIJI = { 髙: "高", 﨑: "崎", 澤: "沢", 眞: "真", 濱: "浜", 邊: "辺", 邉: "辺", 瀨: "瀬", 德: "徳" };
const normName = (v) =>
  String(v ?? "")
    .normalize("NFKC")
    .replace(/[（(].*?[)）]/g, "")
    .replace(/[\s　]/g, "")
    .replace(/./g, (ch) => ITAIJI[ch] ?? ch)
    .trim();
const sameName = (a, b) => {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
};

function walk(dir, fn) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, fn);
    else fn(p);
  }
}

function readMeisai() {
  const rows = new Map();
  const base = path.join(KAIGO, "サービス実績データ");
  walk(base, (p) => {
    if (!/^MEISAI.*\.csv$/i.test(path.basename(p))) return;
    const rel = p.slice(base.length + 1);
    if (!rel.includes(YYYYMM)) return;
    const area = rel.split(path.sep)[0];
    const lines = new TextDecoder("shift_jis").decode(readFileSync(p)).split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return;
    const h = lines[0].split(",").map((x) => x.trim());
    const iNum = h.indexOf("利用者番号"), iName = h.indexOf("利用者名");
    if (iNum < 0 || iName < 0) return;
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      const num = (c[iNum] ?? "").trim(), name = (c[iName] ?? "").trim();
      if (!num || !name) continue;
      const k = `${area}|${num}`;
      if (!rows.has(k)) rows.set(k, { area, num, name, rows: 0 });
      rows.get(k).rows++;
    }
  });
  return [...rows.values()];
}

async function main() {
  console.log(`=== MEISAI の「辿り着けない」を原因別に分ける (${MONTH}) — READ ONLY ===\n`);

  const meisai = readMeisai();
  const [clients, offices, assigns] = await Promise.all([
    fetchAll("clients", "id, name, user_number, birth_date"),
    fetchAll("offices", "id, name, service_type"),
    fetchAll("client_office_assignments", "client_id, office_id"),
  ]);
  console.log(`MEISAI (拠点 × 利用者番号) ${meisai.length} 件 / clients ${clients.length} 名`);

  const byNumber = new Map();
  for (const c of clients) {
    const n = (c.user_number ?? "").trim();
    if (!n) continue;
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(c);
  }
  const officeClients = new Map();
  const officeOf = new Map(offices.map((o) => [o.id, o.name]));
  const clientOffices = new Map(); // client_id -> Set(office 名)
  for (const a of assigns) {
    if (!officeClients.has(a.office_id)) officeClients.set(a.office_id, new Set());
    officeClients.get(a.office_id).add(a.client_id);
    if (!clientOffices.has(a.client_id)) clientOffices.set(a.client_id, new Set());
    clientOffices.get(a.client_id).add(officeOf.get(a.office_id) ?? a.office_id);
  }
  const areaCache = new Map();
  const areaClients = (area) => {
    if (areaCache.has(area)) return areaCache.get(area);
    const set = new Set();
    // ⚠ 部分一致では K姉 / 姉ム / 袖ケ浦 / 茂原 が 1 件も当たらない。表で引く
    let hit = officesForArea(area, offices);
    if (hit.length === 0) {
      const key = normName(area);
      hit = offices.filter((o) => normName(o.name).includes(key));
    }
    for (const o of hit) for (const cid of officeClients.get(o.id) ?? []) set.add(cid);
    areaCache.set(area, set);
    return set;
  };

  // 既に対応表に入っている番号は対象外 (取込は引けている)
  const mapped = new Set();
  for (const f of readdirSync(path.join(KAIGO, "migrations"))) {
    if (!/^_meisai_num_to_client_.*\.json$/.test(f)) continue;
    const j = JSON.parse(readFileSync(path.join(KAIGO, "migrations", f), "utf8"));
    for (const k of Object.keys(j)) mapped.add(k);
  }

  const A = [], B = [], C = [];
  for (const m of meisai) {
    if (AREA && m.area !== AREA) continue;
    if (mapped.has(m.num)) continue;
    const sameNum = byNumber.get(m.num) ?? [];
    const numberOk = sameNum.some((c) => sameName(c.name, m.name));
    if (numberOk) continue; // 番号で正しく引ける
    const inArea = areaClients(m.area);
    if (clients.some((c) => sameName(c.name, m.name) && inArea.has(c.id))) continue; // 拠点内で引ける

    // 拠点を外して全社で探す
    const global = clients.filter((c) => sameName(c.name, m.name));
    if (global.length === 1) {
      A.push({ ...m, c: global[0], where: [...(clientOffices.get(global[0].id) ?? [])] });
    } else if (global.length > 1) {
      B.push({ ...m, cands: global });
    } else {
      C.push(m);
    }
  }

  const byArea = (list) => {
    const c = new Map();
    for (const x of list) c.set(x.area, (c.get(x.area) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} ${n}`).join(" / ");
  };

  console.log(`\n★ A 利用者は居るが その拠点の割当が無い   ${A.length} 件`);
  console.log(`   → client_office_assignments を足せば解決する。ただし氏名だけで人を`);
  console.log(`     決めているので **人が確認してから**。`);
  if (A.length) console.log(`   拠点別: ${byArea(A)}`);
  for (const x of A.slice(0, AREA ? 999 : 25)) {
    console.log(
      `     ${x.area} 番号${x.num}「${x.name}」(${x.rows}行)\n` +
        `        → 当方「${x.c.name}」(番号 ${x.c.user_number ?? "—"} / 生年月日 ${x.c.birth_date ?? "—"})` +
        `  いま所属: ${x.where.length ? x.where.join("・") : "(割当なし)"}`,
    );
  }
  if (A.length > (AREA ? 999 : 25)) console.log(`     … 他 ${A.length - 25} 件`);

  console.log(`\n△ B 同姓が複数いて決められない            ${B.length} 件`);
  if (B.length) console.log(`   拠点別: ${byArea(B)}`);
  for (const x of B.slice(0, 12)) {
    console.log(
      `     ${x.area} 番号${x.num}「${x.name}」→ ${x.cands.length} 人: ` +
        x.cands.map((c) => `${c.name}(${c.user_number ?? "—"}/${c.birth_date ?? "—"})`).join(", "),
    );
  }

  console.log(`\n⬜ C 利用者自体が居ない                    ${C.length} 件`);
  console.log(`   → 利用者マスタの取込が要る。利用者データ/…_登録有/ が手元にある。`);
  if (C.length) console.log(`   拠点別: ${byArea(C)}`);
  for (const x of C.slice(0, AREA ? 999 : 20)) console.log(`     ${x.area} 番号${x.num}「${x.name}」(${x.rows}行)`);
  if (C.length > (AREA ? 999 : 20)) console.log(`     … 他 ${C.length - 20} 件`);

  // ── C の人が 手元の利用者マスタ CSV に載っているか ───────────────────────
  //   載っているなら **取込を回せば解決する**。載っていないなら ほのぼのから
  //   出し直すしかない。ここを分けないと「取込すればよい」と誤解する。
  const csvNames = new Map(); // 正規化した氏名 -> Set(フォルダ名)
  walk(path.join(KAIGO, "利用者データ"), (fp) => {
    const b = path.basename(fp);
    if (!/\.csv$/i.test(b) || !b.includes("基本")) return;
    const folder = path.relative(path.join(KAIGO, "利用者データ"), fp).split(path.sep)[0];
    let text;
    try {
      text = new TextDecoder("shift_jis").decode(readFileSync(fp));
    } catch {
      return;
    }
    const lines2 = text.split(/\r?\n/).filter(Boolean);
    if (lines2.length < 2) return;
    const h = lines2[0].split(",").map((x) => x.replace(/^"|"$/g, "").trim());
    const iName = h.indexOf("利用者名");
    const iBirth = h.indexOf("生年月日");
    if (iName < 0) return;
    for (const line of lines2.slice(1)) {
      const cols = line.split(",");
      const nm = (cols[iName] ?? "").replace(/^"|"$/g, "").trim();
      const k = normName(nm);
      if (!k) continue;
      if (!csvNames.has(k)) csvNames.set(k, { folders: new Set(), birth: "" });
      const rec = csvNames.get(k);
      rec.folders.add(folder);
      // ⚠ **生年月日ではダミーを見分けられない。**「☆ＨＲＤ 研修」2017/03/29、
      //   「中抜け」2025/03/01 のように、ほのぼののダミー登録にも日付が入っている。
      //   見分けるなら 利用者番号 2147483647 や記号始まりの氏名で判定すること。
      const b = iBirth >= 0 ? (cols[iBirth] ?? "").replace(/^"|"$/g, "").trim() : "";
      if (b && !rec.birth) rec.birth = b;
    }
  });

  const inCsv = [], notInCsv = [];
  for (const x of C) {
    const hit = csvNames.get(normName(x.name));
    if (!hit) { notInCsv.push({ ...x, folders: [] }); continue; }
    inCsv.push({ ...x, folders: [...hit.folders] });
  }
  console.log(`   ── C の内訳: 手元の利用者マスタ CSV に載っているか ──`);
  console.log(`      OK 載っている ${inCsv.length} 件 → **取込を回せば解決する**`);
  if (inCsv.length) console.log(`         拠点別: ${byArea(inCsv)}`);
  for (const x of inCsv.slice(0, AREA ? 999 : 15)) {
    console.log(`         ${x.area} 「${x.name}」(${x.rows}行) → CSV: ${x.folders.join(" / ")}`);
  }
  if (inCsv.length > (AREA ? 999 : 15)) console.log(`         … 他 ${inCsv.length - 15} 件`);
  console.log(`         ⚠ ほのぼのは 研修・面談・中抜け・有給 等も **利用者として登録している**。`);
  console.log(`            生年月日は入っているので日付では見分けられない。取り込む前に氏名を見ること`);
  console.log(`            (利用者番号 2147483647 や記号始まりの氏名がダミー)`);
  console.log(`      ⬜ どの CSV にも無い ${notInCsv.length} 件 → **ほのぼのから出し直すしかない**`);
  if (notInCsv.length) console.log(`         拠点別: ${byArea(notInCsv)}`);
  for (const x of notInCsv.slice(0, AREA ? 999 : 15)) console.log(`         ${x.area} 「${x.name}」(${x.rows}行)`);
  if (notInCsv.length > (AREA ? 999 : 15)) console.log(`         … 他 ${notInCsv.length - 15} 件`);

  console.log(`\n合計 ${A.length + B.length + C.length} 件。**このスクリプトは何も書き換えていません。**`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
