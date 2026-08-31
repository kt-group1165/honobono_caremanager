// ============================================================================
// 居宅「サービス利用票・提供票 (第6表)」PDF から **日別の予定/実績グリッド**を読む。
//
//   _riyouhyou_pdf.mjs は「誰が載っているか」(名簿) を読む。こちらは「その人の
//   何のサービスが何日に何回あるか」を読む。役割が違うので別ファイルにしてある。
//
// ── 座標の実測値 (2026-08-31 / 四街道 202606 の 149 ページで確認) ──────────
//   ページ = A4 横 841.92 x 595.32
//
//     y=190  日付ヘッダー   x=348.8(1日) 363.1(2) … 14.2px 間隔
//     y=200  曜日
//     y=214  予定行 ┐ この 2 本で 1 サービス。左側の文字は 2 行に折り返すので
//     y=223  実績行 ┘ 両方の y から拾って連結する
//     y=234 / 244 …  以降 約 20.3px 間隔で最大 17 サービス
//
//   左側の列 (語の開始 x で判定。実データの分布から境界を決めた)
//     x <  75        提供時間帯      「11:30」「～」「12:30」
//     x  75〜149     サービス内容    「生活３・Ⅱ」「訪問看護サービス提」+「供体制加算Ⅰ１」
//     x 150〜214     事業所名        「ニチイケアセン」+「ター鎌取」
//     x 215〜284     用具名称        福祉用具貸与の行のみ
//     x 285〜319     TAIS・届出コード 同上
//     x 320〜345     「予定」「実績」ラベル
//     x 340〜        日別セル
//     x maxDay+12〜  合計
//
// ── セルは boolean ではない ──────────────────────────────────────────────
//   1 日に 2 回・3 回のサービスが実在する (訪看Ⅰ５・２超 で 3)。
//   四街道 202606 実測: 1 が 12,567 / 3 が 153 / 2 が 140。
//   よって **回数 (number) で返す**。呼出側が boolean に落とすかを決める。
//
// ── 自己検算 ────────────────────────────────────────────────────────────
//   PDF は行末に「合計」を印字している。日別セルの合計と突き合わせられるので、
//   パーサが列をずらしていれば必ず検出できる。ズレたら warn に積んで返す。
// ============================================================================

/** 左側の列境界 (語の開始 x)。実データの x 分布から決めた */
const COL = {
  TIME_MAX: 75,
  CONTENT_MAX: 150,
  PROVIDER_MAX: 215,
  EQUIP_MAX: 285,
  TAIS_MAX: 320,
};

/** 予定/実績ラベルが載る x 帯 */
const LABEL_X_MIN = 310;
const LABEL_X_MAX = 345;

/** 同じ視覚行とみなす y の許容差 (px) */
const Y_TOL = 2.5;

/** 日別セルを日付ヘッダーに割り当てる x の許容差 (px)。列間隔 14.2 の半分弱 */
const DAY_X_TOL = 7;

const isDigits = (s) => /^\d+$/.test(s);

/**
 * 日付ヘッダー行を探す。
 * 1〜31 の数字が 20 個以上、日別グリッドの x 帯 (>320) に並ぶ y を採用する。
 * @returns {{y:number, days:{day:number,x:number}[]}|null}
 */
function findDayHeader(words) {
  const byY = new Map();
  for (const w of words) {
    if (!isDigits(w.t)) continue;
    const n = Number(w.t);
    if (n < 1 || n > 31) continue;
    if (w.x <= LABEL_X_MAX) continue;
    const k = Math.round(w.y);
    if (!byY.has(k)) byY.set(k, []);
    byY.get(k).push({ day: n, x: w.x });
  }
  for (const [y, ds] of [...byY.entries()].sort((a, b) => a[0] - b[0])) {
    if (ds.length < 20) continue;
    const sorted = [...ds].sort((a, b) => a.x - b.x);
    // 1 から始まり 1 ずつ増えること (ヘッダーであることの確認)
    const ok = sorted.every((d, i) => d.day === i + 1);
    if (!ok) continue;
    return { y, days: sorted };
  }
  return null;
}

/** 「予定」「実績」ラベルの y を拾う */
function labelYs(words, label) {
  const ys = [];
  for (const w of words) {
    if (w.t !== label) continue;
    if (w.x < LABEL_X_MIN || w.x > LABEL_X_MAX) continue;
    ys.push(w.y);
  }
  return ys.sort((a, b) => a - b);
}

/**
 * 予定行と実績行をペアにする。
 * 通常は同数で上から順に対応するが、片方が欠けるページがあり得るので
 * 「予定の直下で一番近い実績」を取る方式にしてある。
 */
function pairRows(ysPlan, ysActual) {
  const used = new Set();
  const pairs = [];
  for (const yp of ysPlan) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < ysActual.length; i++) {
      if (used.has(i)) continue;
      const d = ysActual[i] - yp;
      if (d < 0 || d > 18) continue;       // 実績は予定の 9px ほど下。18px を超えたら別行
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { used.add(best); pairs.push({ yPlan: yp, yActual: ysActual[best] }); }
    else pairs.push({ yPlan: yp, yActual: null });
  }
  return pairs;
}

/** y 帯に載る語を x 昇順で返す */
function wordsAtY(words, ys) {
  return words
    .filter((w) => ys.some((y) => y != null && Math.abs(w.y - y) <= Y_TOL))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/** 日別セルを読む。ヘッダー x に最近接で割り当てる */
function readCells(words, y, days, nDays) {
  const cells = new Array(nDays).fill(0);
  const warn = [];
  if (y == null) return { cells, warn };
  for (const w of words) {
    if (Math.abs(w.y - y) > Y_TOL) continue;
    if (!isDigits(w.t)) continue;
    if (w.x < days[0].x - DAY_X_TOL) continue;
    let best = null, bestD = Infinity;
    for (const d of days) {
      const dist = Math.abs(w.x - d.x);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    if (best && bestD <= DAY_X_TOL) cells[best.day - 1] = Number(w.t);
    // 合計列は days の右外なので、ここでは拾わない (別途 readTotal)
  }
  return { cells, warn };
}

/** 行末の「合計」を読む (自己検算用) */
function readTotal(words, y, maxDayX) {
  if (y == null) return null;
  const cand = words
    .filter((w) => Math.abs(w.y - y) <= Y_TOL && isDigits(w.t) && w.x > maxDayX + 12)
    .sort((a, b) => a.x - b.x);
  return cand.length ? Number(cand[0].t) : null;
}

/**
 * 利用票 1 ページから日別グリッドを取り出す。
 *
 * @param {{x:number,y:number,t:string}[]} words PyMuPDF の get_text("words") 相当
 * @returns {{
 *   days: number,
 *   rows: {
 *     time: string, content: string, provider: string,
 *     equipment_name: string, tais_code: string,
 *     planned: number[], actual: number[],
 *     planned_total: number|null, actual_total: number|null,
 *     warn: string[],
 *   }[],
 * } | null}  利用票のページでなければ null
 */
export function extractGrid(words) {
  const hdr = findDayHeader(words);
  if (!hdr) return null;
  const nDays = hdr.days.length;
  const maxDayX = hdr.days[nDays - 1].x;

  const pairs = pairRows(labelYs(words, "予定"), labelYs(words, "実績"));
  const rows = [];

  for (const { yPlan, yActual } of pairs) {
    const left = wordsAtY(words, [yPlan, yActual]).filter(
      (w) => w.x < COL.TAIS_MAX && w.t !== "予定" && w.t !== "実績",
    );
    const pick = (lo, hi) =>
      left.filter((w) => w.x >= lo && w.x < hi).map((w) => w.t).join("").trim();

    const time = pick(0, COL.TIME_MAX);
    const content = pick(COL.TIME_MAX, COL.CONTENT_MAX);
    const provider = pick(COL.CONTENT_MAX, COL.PROVIDER_MAX);
    const equipment_name = pick(COL.PROVIDER_MAX, COL.EQUIP_MAX);
    const tais_code = pick(COL.EQUIP_MAX, COL.TAIS_MAX);

    const p = readCells(words, yPlan, hdr.days, nDays);
    const a = readCells(words, yActual, hdr.days, nDays);
    const planned_total = readTotal(words, yPlan, maxDayX);
    const actual_total = readTotal(words, yActual, maxDayX);

    // 空行 (様式の余り枠) は落とす
    const empty =
      !time && !content && !provider && !equipment_name &&
      p.cells.every((v) => !v) && a.cells.every((v) => !v);
    if (empty) continue;

    const warn = [];
    const sumP = p.cells.reduce((s, v) => s + v, 0);
    const sumA = a.cells.reduce((s, v) => s + v, 0);
    // PDF が印字した合計と日別セルの合計が合わなければ列ズレを疑う
    if (planned_total != null && sumP !== planned_total) {
      warn.push(`予定の合計不一致 (セル計 ${sumP} / 印字 ${planned_total})`);
    }
    if (actual_total != null && sumA !== actual_total) {
      warn.push(`実績の合計不一致 (セル計 ${sumA} / 印字 ${actual_total})`);
    }
    if (!content) warn.push("サービス内容が空");

    rows.push({
      time, content, provider, equipment_name, tais_code,
      planned: p.cells, actual: a.cells,
      planned_total, actual_total, warn,
    });
  }

  return { days: nDays, rows };
}

// ── 氏名・番号を「座標」で読む ──────────────────────────────────────────────
//   _riyouhyou_pdf.mjs の parseRiyouhyouPages は本文テキストの正規表現で拾うので、
//   四街道 202606 の 149 ページ中 6 ページを取りこぼした。原因は 2 つとも実データ:
//
//     ① 氏名に同姓同名の区別記号が付く
//          「大久保 良子　1」  (ﾌﾘｶﾞﾅ ｵｵｸﾎﾞ ﾘｮｳｺ ｲﾁ)
//          「中村 光子　〇」   (〇 = U+3007。氏名の文字種に入っていない)
//     ② 被保険者番号が英字で始まる
//          「H551079091」「H334006 9…」  ← 数字だけを 10 桁探す方式では拾えない
//
//   様式の座標は固定なのでラベルから拾うほうが確実。
//     y=80.0  x=41.9   「保険者」        → y+3.6 / x 130〜230 に 6 桁
//     y=111.4 x=41.9   「被保険」        → y+4.0 / x  75〜230 に 10 桁
//     y=122.3 x=229.7  「被保険者氏名」  → 同じ y 帯 / x>285 に氏名、その右に「様」

/** ラベル語を x 上限つきで探す */
function findLabel(words, text, xMax) {
  return words.find((w) => w.t === text && (xMax == null || w.x < xMax)) ?? null;
}

/** ラベルの下 (dy 以内) の x 帯にある語を x 順に連結する */
function joinBelow(words, label, dyMax, xMin, xMax) {
  if (!label) return null;
  const s = words
    .filter((w) => w.y >= label.y - 1 && w.y <= label.y + dyMax && w.x >= xMin && w.x < xMax)
    .sort((a, b) => a.x - b.x)
    .map((w) => w.t)
    .join("")
    .trim();
  return s || null;
}

/**
 * 保険者番号・被保険者番号・氏名を座標で読む。
 * @returns {{insurer:string|null, insured:string|null, name:string|null, nameSuffix:string|null}}
 */
export function pickIdentity(words) {
  // ⚠ x 上限は 228。230 にすると右隣の「ﾌﾘｶﾞﾅ」(x=229.7) / 「保険者名」(x=234.1) を
  //   巻き込んで被保番が "1001160553ﾌﾘｶﾞﾅ" になる (実際に踏んだ)。
  const insurer = joinBelow(words, findLabel(words, "保険者", 60), 8, 130, 228);
  const insured = joinBelow(words, findLabel(words, "被保険", 60), 8, 75, 228);

  let name = null, nameSuffix = null;
  const nameLabel = findLabel(words, "被保険者氏名", 260);
  if (nameLabel) {
    const band = words
      .filter((w) => Math.abs(w.y - nameLabel.y) <= 3 && w.x > nameLabel.x + 40)
      .sort((a, b) => a.x - b.x);
    const parts = [];
    for (const w of band) {
      if (w.t === "様") break;
      parts.push(w.t);
    }
    const raw = parts.join(" ").replace(/\s+/g, " ").trim();
    // 同姓同名の区別記号は氏名の末尾に全角空白で付く (「大久保 良子　1」)
    const m = /^(.*?)[　]([^　]{1,2})$/.exec(raw);
    if (m) { name = m[1].trim(); nameSuffix = m[2]; } else { name = raw || null; }
  }
  // 書式を満たさないものは採用しない (拾い過ぎたゴミを黙って通さないため)
  return {
    insurer: /^\d{6}$/.test(insurer ?? "") ? insurer : null,
    insured: /^[0-9A-Za-z]{10}$/.test(insured ?? "") ? insured : null,
    name,
    nameSuffix,
  };
}

/** 回数配列 → 帳票 content が持つ boolean 配列 (31 個固定)。回数>1 は true に潰れる */
export function toBoolean31(counts) {
  const out = new Array(31).fill(false);
  for (let i = 0; i < Math.min(counts.length, 31); i++) out[i] = counts[i] > 0;
  return out;
}

/** 回数配列 → 31 個固定の number 配列 (回数をそのまま保持する用) */
export function toCount31(counts) {
  const out = new Array(31).fill(0);
  for (let i = 0; i < Math.min(counts.length, 31); i++) out[i] = counts[i] || 0;
  return out;
}
