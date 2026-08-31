// ============================================================================
// ほのぼの 利用者管理 → CSV の「介護保険」帳票を読む共通部品。
//
//   利用者データ/<拠点>/介護保険*.CSV   (Shift_JIS)
//
// ── 列は必ずヘッダー名で引く ────────────────────────────────────────────
//   列位置は出力設定で変わる。「全社_R8-08」は被保険者番号が col 4 でなく col 18
//   だった前例があり、決め打ちで読んで 17 名が落ちた。
//
// ── キーの取り方 ────────────────────────────────────────────────────────
//   認定は世代ごとに 1 行なので、**(保険者番号, 被保険者番号, 認定有効期間開始日)**
//   で 1 世代を指す。被保険者番号は保険者の中でしか一意でないため対で持つ。
//   保険者名だけは世代に依らないので 保険者番号 単独でも引けるようにしてある。
//
// ── 値が割れたら採らない ────────────────────────────────────────────────
//   同じキーが複数の CSV に出て値が食い違うことがある (古い出力が混ざる)。
//   どちらが正か機械では決められないので **候補を全部持って返し**、
//   呼出側が「1 つに定まったものだけ使う」と判断できるようにする。
// ============================================================================
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Shift_JIS の CSV を 2 次元配列に。引用符内の , と "" に対応する */
export function parseSjisCsv(file) {
  const s = new TextDecoder("shift_jis").decode(readFileSync(file));
  const rows = [];
  let cur = [], fld = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { fld += '"'; i++; } else q = false; }
      else fld += c;
    } else if (c === '"') q = true;
    else if (c === ",") { cur.push(fld); fld = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { cur.push(fld); rows.push(cur); cur = []; fld = ""; }
    else fld += c;
  }
  if (fld || cur.length) { cur.push(fld); rows.push(cur); }
  return rows;
}

/** 利用者データ/ 配下の 介護保険*.CSV を集める */
export function findKaigoHokenCsvs(kaigoRoot) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const p = path.join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/^介護保険.*\.csv$/i.test(name) && st.size > 0) out.push(p);
    }
  };
  walk(path.join(kaigoRoot, "利用者データ"));
  return out.sort();
}

/** ほのぼのの日付 (20260601 / 2026/6/1 / 2026-06-01) を ISO に。読めなければ "" */
export function normDate(v) {
  const t = (v ?? "").trim();
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}`;
  const m = /^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$/.exec(t);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
}

/**
 * 介護保険 CSV を全部読んで、認定世代ごとの値を集める。
 *
 * @returns {{
 *   files: string[], rowCount: number,
 *   byCert: Map<string, {certDate:Set<string>, careManager:Set<string>, supportOffice:Set<string>}>,
 *   byInsurerNumber: Map<string, Set<string>>,
 *   skipped: string[],
 * }}  byCert のキーは `保険者番号|被保険者番号|認定有効期間開始日`
 */
export function readHonobonoMaster(kaigoRoot) {
  const files = findKaigoHokenCsvs(kaigoRoot);
  const byCert = new Map();
  const byInsurerNumber = new Map();
  const skipped = [];
  let rowCount = 0;

  const add = (map, key, field, value) => {
    if (!value) return;
    if (!map.has(key)) map.set(key, { certDate: new Set(), careManager: new Set(), supportOffice: new Set() });
    map.get(key)[field].add(value);
  };

  for (const f of files) {
    const rows = parseSjisCsv(f);
    if (!rows.length) continue;
    const h = rows[0].map((x) => x.trim());
    const col = (name) => h.indexOf(name);
    const iInsurerNo = col("保険者番号");
    const iInsurerNm = col("保険者");
    const iInsured = col("被保険者番号");
    const iStart = col("認定有効期間－開始日");
    const iCertDate = col("認定年月日");
    const iCareMgr = col("担当ケアマネジャー");
    const iOffice = col("支援事業所（正式名称）");
    if (iInsurerNo < 0 || iInsured < 0) {
      skipped.push(`${path.basename(f)} (保険者番号=${iInsurerNo} 被保険者番号=${iInsured})`);
      continue;
    }
    for (const r of rows.slice(1)) {
      const insurerNo = (r[iInsurerNo] ?? "").trim();
      const insured = (r[iInsured] ?? "").trim();
      if (!/^\d{6}$/.test(insurerNo) || !insured) continue;
      rowCount++;

      // 保険者名 (世代に依らない)
      if (iInsurerNm >= 0) {
        const nm = (r[iInsurerNm] ?? "").trim();
        // 数字混じりは名称ではない (実データに "293" や番号そのものが入っている行がある)
        if (nm && !/[0-9０-９]/.test(nm)) {
          if (!byInsurerNumber.has(insurerNo)) byInsurerNumber.set(insurerNo, new Set());
          byInsurerNumber.get(insurerNo).add(nm);
        }
      }

      // 認定世代ごとの値
      if (iStart < 0) continue;
      const start = normDate(r[iStart]);
      if (!start) continue;
      const key = `${insurerNo}|${insured}|${start}`;
      if (iCertDate >= 0) add(byCert, key, "certDate", normDate(r[iCertDate]));
      if (iCareMgr >= 0) add(byCert, key, "careManager", (r[iCareMgr] ?? "").trim());
      if (iOffice >= 0) add(byCert, key, "supportOffice", (r[iOffice] ?? "").trim());
    }
  }
  return { files, rowCount, byCert, byInsurerNumber, skipped };
}

/** Set が 1 つに定まっていればその値、割れている/空なら null */
export const onlyValue = (set) => (set && set.size === 1 ? [...set][0] : null);

/** 認定 1 件を指すキーを作る */
export const certKey = (insurerNumber, insuredNumber, startDate) =>
  `${(insurerNumber ?? "").trim()}|${(insuredNumber ?? "").trim()}|${(startDate ?? "").trim()}`;
