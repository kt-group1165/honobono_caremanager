import { extractPages } from "./_pdf_words.mjs";
import { extractGrid, pickIdentity } from "./_riyouhyou_grid.mjs";
import { parseRiyouhyouPages } from "./_riyouhyou_pdf.mjs";
// ============================================================================
// 「計画書一括印刷（利用者単位）」PDF (第1表→第2表→週間計画→利用票→別表 を
// 1ファイルに束ねたもの) を読む共通パーサ。
//
// 2026-09-14、H から渡された実PDF2本 (淺井珠惠=計画書一括印刷(2).pdf・
// 秋葉法昌=計画書一括印刷(3).pdf、Box「10F内共有/ほのぼのから出力」) で
// 座標を実測して作った。
//
// ── ページ切り分け ──────────────────────────────────────────────────────
//   本文中の表題文字列で判定する。第1・2表はCSV移行済みなので中身は読まない
//   (H指示)。ページ順は 第1表→第2表(1〜2枚)→週間計画→利用票→別表 で固定
//   (2サンプルで確認)。日課計画表が挟まる構成は今回の2サンプルには無かったが、
//   念のため判定だけは用意しておく (中身は読まない＝スコープ外)。
//
// ── 利用票ページは既存パーサをそのまま流用できる (実測で確認済み) ─────────
//   _riyouhyou_grid.mjs の pickIdentity()/extractGrid() を無改造でこの
//   束ねPDFの利用票ページに通したところ、2サンプルとも
//   保険者番号・被保険者番号・氏名が正しく取れ、grid も warn 0 件だった。
//   単独PDFと同じ様式なので当然だが、念のため実測で裏を取った。
//
// ── 週間計画(第3表)の座標 ─────────────────────────────────────────────────
//   曜日ヘッダー行 (y≈109.8): 月/火/水/木/金/土/日 が x=112.1,196.1,280.1,
//   364.1,448.1,532.1,616.1 の等間隔(84.0px)で並ぶ。実測で確認: 内容の語は
//   ヘッダーの x そのものではなく **列の中心 (ヘッダーx±42) の帯**に入る
//   (例: 火の内容が x=244.5 に出る = ヘッダー196.1と次のヘッダー280.1の
//   中間寄り)。よって列境界は「隣接ヘッダーの中点」で切る。
//
//   時刻ラベル (x=48.0): 0:00,2:00,…,22:00,24:00 が y≈30px間隔で並ぶ
//   (最後の 22:00→24:00 だけ 23px と短い)。内容の1行目は時刻ラベルの
//   y から +0〜+8px 程度ずれて出る (実測で -1.4px〜+6.1px の幅を確認)。
//   ★ 1件のサービスが複数行(最大5行)に折り返され、折り返し後の行が
//   **次の時間帯の y 帯にはみ出すことがある** (実測で確認: 秋葉法昌の
//   通所リハビリ、1行目 y=266.2 は 8:00-10:00 帯と 10:00-12:00 帯の
//   境界からわずか1.4px。3〜5行目は 10:00-12:00 帯を超えて
//   12:00-14:00 帯に食い込んでいた)。
//   → 行ごとに y でバケツ分けすると同一サービスが複数の時間帯に
//     分裂するので、**まず列内でブロック化してから、ブロックの先頭行の
//     y だけで時間帯を決める**方式にした (これも本セッションで確立した
//     「ラベル行と本文1行目が同じ行に見える」系の罠と同根)。
//
// ── 別表(第7表)の数値列 (2026-09-14、H から渡された残り5本の実PDFで解決) ──
//   6本 (淺井珠惠・秋葉法昌・有川秀人・新井秀雄・阿部博・浅野修司) の実測で
//   列境界と「行ごとの金額の出方」が確定した。
//
//   ★ 重要な発見: 単位数・回数・サービス単位／金額 は **全行**に印字されるが、
//   単価・費用総額・給付率・保険/事業費請求額・利用者負担 は **行によって
//   出方が2通り**ある:
//     ① 単独で金額が乗る行 (加算行の多く。処遇改善加算はサービス単位／金額すら
//        出ないことがある = 定率計算のため)
//     ② 複数行が「◯◯合計」行に集約され、金額はその合計行にしか出ない
//        (基本サービス＋一部の加算。例: 淺井珠惠の 通所介護Ⅰ３１(基本) と
//        個別機能訓練加算Ⅰ２ → 通所介護合計 1行に集約)
//   ①か②かは実測でも規則性が見い出せなかった (加算の種類では決まらない:
//   同じ「サービス提供体制加算」でも①のことも②に含まれることもある)。
//   よって **金額の直接印字が無い行は、同じ事業所番号の直後の「◯◯合計」行
//   から 単価/給付率 を借りて自行の sサービス単位／金額 に適用**する
//   (単価・給付率は同一事業所・同一カテゴリ内の全行で共通と実測で確認済み)。
//   計算式は EditFormUsageDetail (reports-content.tsx) の updateItem() と
//   **完全に同じ式**を使う (総額=floor(単位×単価)、保険請求=floor(総額×率/100)、
//   利用者負担=総額-保険請求)。★ 自己検算: 集約グループの各行をこの式で
//   計算した総額の合計は、印字された合計行の費用総額と ±(行数-1)円以内で
//   一致する (floor を行ごとに取るか合計後に取るかの丸め差。実測で確認)。
//   一致しなければ warn に積んで呼出側が確認できるようにする。
//
//   ★ 区分支給限度基準を超える単位数・種類支給限度基準を超える単位数は
//   実データ6本すべてで 0 (限度超過なし) だったため未検証。印字された
//   「基準内単位数」の括弧値が sサービス単位／金額と食い違う行があれば
//   warn に積む (limit超過に未対応の合図)。
//
//   ★ 通所リハ送迎減算のような **負の単位数** (-47×2回=-94) も実在する。
//   数値の正規表現は符号つきにしてある。
// ============================================================================
// ── 別表の列の範囲は「出し方 (レイアウト)」ごとに持つ (2026-11-13) ─────────────────────
//   計画書一括印刷 と 利用票別表 (全CM) は同じ様式だが列の位置が違う (コード列 x≈196 / x≈220)。
//   ずれ方は列ごとに違い (コード +24・単位数 +16・回数 +8・サービス単位 +20)、見出しと数字の相対位置も
//   出し方で違う (サービス単位: 一括は見出し+12 / 全CM は+3.6) ので、平行移動や見出しへの写像では直らない。
//   → ページの見出し (ｻｰﾋﾞｽｺｰﾄﾞ の「ｻｰﾋﾞｽ」の x) で出し方を判定し、出し方ごとの範囲を使う。
//   判定できないページは読まない (推測で列を決めない。呼出側には warn で返す)。
//   ikkatsu は以前の固定値そのまま (2026-09-14 に実PDF6本で実測)。
//   zencm は 高品 178 ページ・木更津 177 ページの数字の位置の分布から決めた (2026-11-13)。
const LAYOUTS = {
  ikkatsu: {
    label: "計画書一括印刷", codeHeaderX: [190, 205],
    code: [185, 215], content: [108, 185], providerMaxX: 40, providerNumber: [41, 110], subtotal: [108, 190],
    // 福祉用具貸与だけ: 用具名称 (機種名) x≈223 / TAIS コード x≈271 (★「00170-」「000519」の 2 語・上下 2 段で出る。2026-11-13 いすみで実測)
    model: [215, 262], tais: [262, 295],
    units: [295, 322], count: [360, 385], serviceUnits: [393, 412], serviceUnits2: [414, 442],
    withinLimitBracket: [583, 601], unitPrice: [605, 622], totalCost: [623, 663], benefitRate: [668, 683],
    insuranceClaim: [683, 716], userCopay: [750, 786],
    kohiName: [395, 500], kohiClaim: [495, 545], kohiHonnin: [545, 580],
  },
  zencm: {
    label: "利用票別表 (全CM)", codeHeaderX: [212, 228],
    // 内容は 2 行に折り返すと 2 行目が x≈134 から出る (例「特殊寝台付属品貸」+「与」@134)。128 から取る
    code: [205, 235], content: [128, 205], providerMaxX: 115, providerNumber: [115, 140], subtotal: [140, 210],
    // 全CM は事業所名が 2 行に折り返すと 2 行目が事業所番号とつながって 1 語で x≈123 に出る
    // (例「祉用具　高品1270402124」)。この帯の「末尾が事業所番号の語」も事業所名に入れる
    providerJoinBand: [115, 128],
    units: [313, 345], count: [365, 395], serviceUnits: [405, 440], serviceUnits2: [440, 470],
    withinLimitBracket: [598, 622], unitPrice: [622, 646], totalCost: [646, 676], benefitRate: [676, 693],
    insuranceClaim: [693, 742], userCopay: [762, 805],
    kohiName: [455, 525], kohiClaim: [520, 555], kohiHonnin: [555, 600],
  },
};
/** 見出し「ｻｰﾋﾞｽ」(ｻｰﾋﾞｽｺｰﾄﾞ の上段。y<90) の x で出し方を判定。判定できなければ null */
export function detectBetsuhyouLayout(words) {
  const hits = words.filter((w) => w.t === "ｻｰﾋﾞｽ" && w.y < 90);
  for (const [key, L] of Object.entries(LAYOUTS)) if (hits.some((w) => w.x >= L.codeHeaderX[0] && w.x < L.codeHeaderX[1])) return key;
  return null;
}

const NUM_RE = /^\(?(-?\d+)\)?$/;
const DEC_RE = /^(\d+\.\d+)$/;

/** y±tol・x∈[xMin,xMax) にある数値語を1つ拾う (最も近い y を優先)。丸括弧は外す */
function numAt(words, y, xMin, xMax, tol) {
  const cand = words.filter((w) => Math.abs(w.y - y) <= tol && w.x >= xMin && w.x < xMax && NUM_RE.test(w.t));
  if (!cand.length) return null;
  cand.sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y));
  return Number(NUM_RE.exec(cand[0].t)[1]);
}
/** 単価 (小数点つき) を拾う */
function decAt(words, y, xMin, xMax, tol) {
  const cand = words.filter((w) => Math.abs(w.y - y) <= tol && w.x >= xMin && w.x < xMax && DEC_RE.test(w.t));
  if (!cand.length) return null;
  cand.sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y));
  return Number(cand[0].t);
}

/** その y の行が「◯◯合計」行かどうか (x 108〜185 の内容帯に「合計」を含む語があるか、
 * 2行に折り返す場合もあるので y±10 で見る) */
function isSubtotalRow(words, y, L) {
  return words.some((w) => Math.abs(w.y - y) <= 10 && w.x >= L.subtotal[0] && w.x < L.subtotal[1] && w.t.includes("合計"));
}

/** 1行ぶんの金額列を y から読む。無ければ null 埋めで返す (呼出側が判定に使う) */
function readMoneyAt(words, y, tol, L) {
  return {
    unitPrice: decAt(words, y, ...L.unitPrice, tol),
    totalCost: numAt(words, y, ...L.totalCost, tol),
    benefitRate: numAt(words, y, ...L.benefitRate, tol),
    insuranceClaim: numAt(words, y, ...L.insuranceClaim, tol),
    userCopay: numAt(words, y, ...L.userCopay, tol),
    withinLimitBracket: numAt(words, y, ...L.withinLimitBracket, tol),
  };
}

const DAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"];
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const HOUR_LABELS = ["0:00", "2:00", "4:00", "6:00", "8:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00", "24:00"];
const HOUR_KEYS = ["h00", "h02", "h04", "h06", "h08", "h10", "h12", "h14", "h16", "h18", "h20", "h22"];

/** ページ本文テキストから表の種別を判定する */
export function classifyPage(text) {
  if (text.includes("居宅サービス計画書（１）")) return "careplan1";
  if (text.includes("居宅サービス計画書（２）")) return "careplan2";
  if (text.includes("日課計画表")) return "daily"; // スコープ外 (中身は読まない)
  if (text.includes("週間サービス計画表")) return "weekly";
  if (text.includes("サービス利用票別表")) return "betsuhyou";
  if (text.includes("サービス利用票（兼")) return "riyouhyou";
  return "unknown";
}

/** ラベルと同じ行の右側の値を拾う (行末までの語を連結) */
function valueAfter(words, label, { yTol = 1.5, maxX = Infinity } = {}) {
  const w = words.find((w) => w.t === label);
  if (!w) return null;
  const band = words
    .filter((x) => Math.abs(x.y - w.y) <= yTol && x.x > w.x && x.x < maxX && x !== w)
    .sort((a, b) => a.x - b.x);
  const s = band.map((x) => x.t).join("").trim();
  return s || null;
}

/**
 * 週間計画(第3表)ページからヘッダー情報とスケジュールを取り出す。
 * @param {{x:number,y:number,t:string}[]} words
 */
export function extractWeeklySchedule(words) {
  const officeWord = words.find((w) => w.t.startsWith("*"));
  const officeName = officeWord ? officeWord.t.slice(1) : null;

  const careLevel = valueAfter(words, "要介護度", { maxX: 300 });
  // ⚠ このページのヘッダー欄は行間が 0.7〜1.4px しかなく (通常10px超の行間の
  //   他ページと違う)、y の許容差だけでは隣の行を巻き込む。x の上限を
  //   フィールドごとに決め打ちして防ぐ (利用者名は「殿」の手前まで、実測 x<230)。
  const userNameWords = (() => {
    const label = words.find((w) => w.t === "利用者名");
    if (!label) return null;
    const band = words
      .filter((w) => Math.abs(w.y - label.y) <= 1.5 && w.x > label.x && w.x < 230)
      .sort((a, b) => a.x - b.x);
    return band.map((w) => w.t).join(" ").trim() || null;
  })();
  const creatorName = (() => {
    const label = words.find((w) => w.t === "作成者");
    if (!label) return null;
    const band = words.filter((w) => Math.abs(w.y - label.y) <= 1.5 && w.x > label.x && w.x < label.x + 150).sort((a, b) => a.x - b.x);
    return band.map((w) => w.t).join(" ").trim() || null;
  })();
  const creationDate = (() => {
    const label = words.find((w) => w.t === "作成年月日");
    if (!label) return null;
    const band = words.filter((w) => Math.abs(w.y - label.y) <= 1.5 && w.x > label.x && w.x < label.x + 150).sort((a, b) => a.x - b.x);
    const s = band.map((w) => w.t).join("").trim();
    return s || null;
  })();

  // 「令和 年 月分」(対象月)。空欄のことがある (H実例: 秋葉法昌)。
  // ⚠ 空欄のときは呼出側 (parseOne) が別表ページの提供年月で埋める。
  // ⚠ ラベル語が無い (欄の左に文字が印字されていない) ので、直後に必ず
  //   出る「より」を右端の目印にして、その左側 (x>250) を値として拾う
  //   (実測: 2サンプルとも「より」が同じ行の右側に出た)。値が入っているときは
  //   「令和」「8年」「6月分」の3語、空欄のときは「令和　年　月分」の1語に
  //   なる (印字上の空白の有無で PDF の語分割が変わる)。
  const targetMonth = (() => {
    const yori = words.find((w) => w.t === "より");
    if (!yori) return null;
    const band = words
      .filter((w) => Math.abs(w.y - yori.y) <= 1.5 && w.x > 250 && w.x < yori.x)
      .sort((a, b) => a.x - b.x);
    const s = band.map((w) => w.t).join("");
    const m = /令和[\s　]*(\d+)[\s　]*年[\s　]*(\d+)[\s　]*月分/.exec(s);
    return m ? `${2018 + Number(m[1])}-${String(Number(m[2])).padStart(2, "0")}` : null;
  })();

  // ── 曜日ヘッダー (列の中心 x) ──────────────────────────────────────────
  const dayHeaderY = (() => {
    const ys = DAY_LABELS.map((d) => words.find((w) => w.t === d)?.y).filter((y) => y != null);
    if (!ys.length) return null;
    return ys.reduce((a, b) => a + b, 0) / ys.length;
  })();
  if (dayHeaderY == null) return { officeName, careLevel, userName: userNameWords, creatorName, creationDate, targetMonth, schedule: null, dailyRoutine: [], irregularServices: null, warn: ["曜日ヘッダーが見つからない"] };

  const dayCenters = DAY_LABELS.map((d) => {
    const w = words.find((ww) => ww.t === d && Math.abs(ww.y - dayHeaderY) <= 2);
    return w ? w.x : null;
  });
  if (dayCenters.some((x) => x == null)) {
    return { officeName, careLevel, userName: userNameWords, creatorName, creationDate, targetMonth, schedule: null, dailyRoutine: [], irregularServices: null, warn: ["曜日ヘッダーの一部が見つからない"] };
  }
  // 列境界: 隣接ヘッダーの中点。両端は半分幅ぶん外側に広げる
  const half = (dayCenters[1] - dayCenters[0]) / 2;
  const dayBounds = [dayCenters[0] - half, ...dayCenters.map((x, i) => (i < dayCenters.length - 1 ? (x + dayCenters[i + 1]) / 2 : x + half))];

  // ── 時刻ラベル (行の開始 y) ────────────────────────────────────────────
  const hourYs = HOUR_LABELS.map((h) => words.find((w) => w.t === h && w.x < 60)?.y ?? null);
  if (hourYs.some((y) => y == null)) {
    return { officeName, careLevel, userName: userNameWords, creatorName, creationDate, targetMonth, schedule: null, dailyRoutine: [], irregularServices: null, warn: ["時刻ラベルの一部が見つからない"] };
  }
  // ⚠ 内容の1行目が時刻ラベルの y からわずかに前後にずれる (実測 -1.4〜+6.1px)。
  //   ラベル y から一律 TOL だけ早めた位置を帯の開始にすることで吸収する。
  const TOL = 3;
  const rowBand = (i) => [hourYs[i] - TOL, hourYs[i + 1] - TOL];

  // ── 曜日ごとに語を集め、y のギャップでブロック化 (1サービス=1ブロック) ──
  //   ブロック内の行間は実測 12px 前後で連続する。18px 以上空いたら別ブロック。
  const BLOCK_GAP = 18;
  const footerY = hourYs[hourYs.length - 1] + 20; // 24:00 のすぐ下 (週単位以外のサービス欄より上)
  const schedule = {};
  for (const k of HOUR_KEYS) schedule[k] = {};
  const dailyRoutineCol = words
    .filter((w) => w.x >= dayBounds[dayBounds.length - 1] && w.x < dayBounds[dayBounds.length - 1] + 120 && w.y > dayHeaderY + 2 && w.y < footerY)
    .sort((a, b) => a.y - b.y)
    .map((w) => w.t);

  for (let d = 0; d < DAY_KEYS.length; d++) {
    const colWords = words
      .filter((w) => w.x >= dayBounds[d] && w.x < dayBounds[d + 1] && w.y > dayHeaderY + 2 && w.y < footerY)
      .sort((a, b) => a.y - b.y);
    if (!colWords.length) continue;

    const blocks = [];
    let cur = [colWords[0]];
    for (let i = 1; i < colWords.length; i++) {
      if (colWords[i].y - colWords[i - 1].y > BLOCK_GAP) { blocks.push(cur); cur = []; }
      cur.push(colWords[i]);
    }
    if (cur.length) blocks.push(cur);

    for (const block of blocks) {
      const topY = block[0].y;
      let rowIdx = -1;
      for (let i = 0; i < HOUR_KEYS.length; i++) {
        const [lo, hi] = rowBand(i);
        if (topY >= lo && topY < hi) { rowIdx = i; break; }
      }
      if (rowIdx < 0) continue; // 帯に入らない (footer側のゴミ等)
      const text = block.map((w) => w.t).join(" ");
      const key = HOUR_KEYS[rowIdx];
      const dayKey = DAY_KEYS[d];
      schedule[key][dayKey] = schedule[key][dayKey] ? `${schedule[key][dayKey]} / ${text}` : text;
    }
  }

  // 「週単位以外のサービス」欄 (訪問診療など、曜日に紐付かないもの)
  const irregularLabel = words.find((w) => w.t === "週単位以外");
  const irregularServices = irregularLabel
    ? words
        .filter((w) => w.x > 60 && w.y > irregularLabel.y - 5 && w.y < irregularLabel.y + 40 && w.t !== "週単位以外" && w.t !== "のサービス")
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((w) => w.t)
        .join("")
        .trim() || null
    : null;

  return {
    officeName, careLevel, userName: userNameWords, creatorName, creationDate, targetMonth,
    schedule, dailyRoutine: dailyRoutineCol, irregularServices,
    warn: [],
  };
}

/**
 * 別表(第7表)ページから行明細を取り出す。EditFormUsageDetail の items[] 形に
 * 直接使える形で返す (事業所名/番号/内容/コードに加え、単位数・回数・金額まで)。
 * @returns {{items: object[], warn: string[]}}
 */
export function extractBetsuhyouRows(words) {
  const layoutKey = detectBetsuhyouLayout(words);
  if (!layoutKey) return { items: [], warn: ["見出しから別表の出し方を判定できない (列の位置が分からないので読まない)"], publicExpenseByProvider: [], layout: null };
  const L = LAYOUTS[layoutKey];
  // サービスコードは6桁の数字で、x が概ね190〜210に出る (実測。全CM は 205〜235)
  // コードは 6 桁。数字だけでなく総合事業は英字で始まる (A61111 / A66311 など。2026-11-13 に全CM で上代 庄二が 0 行になって判明)。
  // 形を数字 6 桁に決め打ちすると、制度が増えた瞬間に黙って読み落とす (SESSION_START ⑱ の型)
  const codeWords = words.filter((w) => /^(\d{6}|[A-Z][0-9A-Z]\d{4})$/.test(w.t) && w.x >= L.code[0] && w.x <= L.code[1])
    .sort((a, b) => a.y - b.y);
  const raw = [];
  for (const cw of codeWords) {
    // ⚠ 1行明細は実際には**2〜3の物理行**にまたがる (実測)。事業所名が長いと
    //   3行に折り返す (例: 「フランスベッドメ/ディカル千葉営業/所」で
    //   コード行の y から最大 +7.4px)。サービス内容・事業所名とも
    //   コード行の**前後**に出るので ±8px の帯で拾う
    //   (次の明細行までの間隔は実測 18.7px あるので安全)。
    const TOL = 8;
    const nearY = (w) => Math.abs(w.y - cw.y) <= TOL;
    const content = words
      .filter((w) => nearY(w) && w.x >= L.content[0] && w.x < L.content[1])
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((w) => w.t)
      .join("");
    // 事業所名: x<40。事業所番号 (10桁) は **2通りの出方**がある (実測):
    //   ① 事業所名の末尾に結合して印字される (例 "サービスセンター1271701524")
    //   ② 事業所名とは別の独立した語として x≈83 (ヘッダー「事業所番号」の位置) に出る
    //      (例 フランスベッド: 名前は x<40・番号は x=83.2 で分離)
    //   どちらで出るかは事業所名の折返し方次第らしく、決め打ちできないので両方見る。
    const providerRaw = words
      .filter((w) => nearY(w) && (w.x < L.providerMaxX
        // 番号とつながった名前の 2 行目だけ (末尾が事業所番号の形)。内容の折り返し (例「与」) は入れない
        || (L.providerJoinBand && w.x >= L.providerJoinBand[0] && w.x < L.providerJoinBand[1] && /\D.*\d{2}[0-9A-Z]\d{7}$/.test(w.t))))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((w) => w.t)
      .join("");
    // 事業所番号は 10 桁。介護医療院などは 3 桁目が英字 (例 12B0100042。全CM で実測 2026-11-13)
    const suffixMatch = /(\d{2}[0-9A-Z]\d{7})$/.exec(providerRaw);
    const standaloneNumber = words.find((w) => nearY(w) && w.x >= L.providerNumber[0] && w.x <= L.providerNumber[1] && /^\d{2}[0-9A-Z]\d{7}$/.test(w.t));
    // 3 行に折り返すと番号が名前の途中に入る (全CM 実測 15 行。例「さかいリハ訪問看千代・四街道支所1260490144護ステーション八」)。
    // 末尾にも単独にも無いときだけ、名前の中の番号を取り出して名前から除く
    const embedded = !suffixMatch && !standaloneNumber ? /(\d{2}[0-9A-Z]\d{7})/.exec(providerRaw) : null;
    const providerNumber = suffixMatch ? suffixMatch[1] : (standaloneNumber ? standaloneNumber.t : (embedded ? embedded[1] : null));
    const providerName = suffixMatch ? providerRaw.slice(0, suffixMatch.index)
      : embedded ? providerRaw.slice(0, embedded.index) + providerRaw.slice(embedded.index + embedded[1].length) : providerRaw;

    // 単位数・回数・サービス単位／金額は全行に出る (実測6本で確認)
    const units = numAt(words, cw.y, ...L.units, 3);
    const count = numAt(words, cw.y, ...L.count, 3);
    const serviceUnits = numAt(words, cw.y, ...L.serviceUnits, 3) ?? numAt(words, cw.y, ...L.serviceUnits2, 3)
      ?? (units != null && count != null ? units * count : null);
    // 金額がこの行自身に直接出ているか (①のパターン)。出ていなければ null のまま返し、
    // 呼出側 (groupBetsuhyouItems) が直後の「◯◯合計」行から借りる (②のパターン)。
    const money = readMoneyAt(words, cw.y, 3, L);
    // 福祉用具貸与の TAIS コードと機種名 (列の位置が分かっている出し方だけ)。TAIS は「5 桁-」「6 桁」の 2 語に分かれて出る。
    //   1 語の「5 桁-6 桁」で探すと 0 件に見える (2026-11-13 に踏んだ)。拾えた件数は呼出側で必ず数えて出す
    let tais = null, model = null;
    if (L.tais && /^(17|67)/.test(cw.t)) {
      const band = words.filter((w) => nearY(w) && w.x >= L.tais[0] && w.x < L.tais[1]);
      const head = band.find((w) => /^\d{5}-$/.test(w.t)), tail = band.find((w) => /^\d{6}$/.test(w.t));
      const whole = band.find((w) => /^\d{5}-\d{6}$/.test(w.t));
      tais = whole ? whole.t : head && tail ? head.t + tail.t : null;
      model = words.filter((w) => nearY(w) && w.x >= L.model[0] && w.x < L.model[1]).sort((a, b) => a.y - b.y || a.x - b.x).map((w) => w.t).join("") || null;
    }

    raw.push({
      tais_code: tais, model_name: model,
      y: cw.y,
      service_code: cw.t,
      service_content: content || null,
      provider_name: providerName || null,
      provider_number: providerNumber,
      units, count, service_units: serviceUnits,
      ...money,
    });
  }

  // 「◯◯合計」行 (コード無し) を集めて、直前の同一事業所番号の無金額行に配る
  const subtotalYs = [...new Set(
    words.filter((w) => w.x >= L.subtotal[0] && w.x < L.subtotal[1] && w.t.includes("合計")).map((w) => Math.round(w.y * 2) / 2),
  )].sort((a, b) => a - b);

  const warn = [];
  const items = [];
  let pendingGroup = []; // 金額がまだ無い行 (①でない行) を溜めておく
  const flushGroup = (subtotalY) => {
    if (!pendingGroup.length) return;
    const providerNum = pendingGroup[0].provider_number;
    const money = readMoneyAt(words, subtotalY, 8, L);
    if (money.unitPrice == null || money.benefitRate == null) {
      warn.push(`「◯◯合計」行 (y=${subtotalY}) の単価/給付率が読めない (事業所番号 ${providerNum ?? "不明"}) — 対象 ${pendingGroup.length} 行を規定値のまま出す`);
      for (const r of pendingGroup) items.push(finalizeItem(r, null));
      pendingGroup = [];
      return;
    }
    // ⚠ 合計行の総額/保険請求/負担額は**グループ全体の値**であって各行の値ではない。
    //   finalizeItem に totalCost 等をそのまま渡すと「直接印字された値」と区別が
    //   付かず全行が同じ金額になってしまう (実測で発覚)。単価/給付率だけ渡して
    //   各行の service_units から finalizeItem 自身に計算させる。
    const rateOnly = { unitPrice: money.unitPrice, benefitRate: money.benefitRate };
    const lineItems = pendingGroup.map((r) => finalizeItem(r, rateOnly));
    // ★ 2026-09-14 H指摘: 「丸め誤差の範囲内で近い」ではなく、印字された合計行と
    //   ★完全一致★させる (最後の行で差額を吸収する)。floor を行ごとに取ると
    //   合計行 (集計後に floor) とは 1円単位でずれることがあるため。
    const last = lineItems[lineItems.length - 1];
    if (money.totalCost != null) {
      const sumCost = lineItems.reduce((s, it) => s + it.total_cost, 0);
      last.total_cost += money.totalCost - sumCost;
    }
    if (money.insuranceClaim != null) {
      const sumClaim = lineItems.reduce((s, it) => s + it.insurance_claim, 0);
      last.insurance_claim += money.insuranceClaim - sumClaim;
    } else {
      // 保険請求額が合計行に無い (実データ6本では常にある) ときは
      // 給付率から計算した値のままにする
    }
    for (const it of lineItems) it.user_copay = it.total_cost - it.insurance_claim;
    for (const it of lineItems) items.push(it);
    pendingGroup = [];
  };

  for (const r of raw) {
    if (r.totalCost != null && r.benefitRate != null) {
      // ① 単独で金額が出ている行 — そのまま確定
      items.push(finalizeItem(r, { unitPrice: r.unitPrice, totalCost: r.totalCost, benefitRate: r.benefitRate, insuranceClaim: r.insuranceClaim, userCopay: r.userCopay }));
      continue;
    }
    // ② 金額なし — 直後の「◯◯合計」行を待つ。合計行が単独の金額付き行の直後に
    //   挟まっていることもあるので、次の subtotalY が現在の y より後ろにあるものを使う
    pendingGroup.push(r);
    // ⚠ 窓を 30px にしてあるのは意図的: 単一スロット離れた合計行 (最大 27px 実測、
    //   2行折返しラベル込み) は拾いつつ、2行以上のグループの**先頭行**からは
    //   届かない距離にする (2行グループの最小間隔は実測 32.8px)。ここを広げすぎると
    //   グループの先頭行だけで早期に flush してしまい、後続行が別グループとして
    //   誤って同じ合計行に群がる事故になる。
    const nextSubtotalY = subtotalYs.find((sy) => sy > r.y && sy < r.y + 30);
    if (nextSubtotalY != null && isSubtotalRow(words, nextSubtotalY, L)) {
      flushGroup(nextSubtotalY);
    }
  }
  if (pendingGroup.length) {
    warn.push(`最後まで「◯◯合計」行が見つからなかった行が ${pendingGroup.length} 件残った (事業所番号 ${pendingGroup[0].provider_number ?? "不明"})`);
    for (const r of pendingGroup) items.push(finalizeItem(r, null));
  }

  // ── 公費適用 (2026-09-14 H指摘で追加) ──────────────────────────────────
  //   法別番号を持つ利用者は「公費適用事業所／公費額／本人負担」の別表が
  //   ページ下部に別途印字される (実測: 生活保護単独の新井秀雄のみ。他5本は
  //   セクションごと印字されない=対象外の人には出ない)。事業所番号までは
  //   印字されず、事業所名の先頭一致で items の事業所番号グループに対応付ける。
  //   本人負担を「合計行と同じ最終行で差額吸収」方式で items[].user_copay に
  //   反映する (介護保険の給付率だけでは公費適用者の利用者負担がわからず、
  //   全額が利用者負担に見えてしまうため)。
  const kohi = extractKohiTable(words, L);
  const publicExpenseByProvider = [];
  if (kohi) {
    for (const row of kohi.rows) {
      const matched = items.filter((it) => it.provider_name && it.provider_name.includes(row.providerNamePrefix));
      if (!matched.length) {
        warn.push(`公費適用事業所「${row.providerNamePrefix}」に対応する items 行が見つからない (公費額 ${row.kohiClaim})`);
        continue;
      }
      // 各行の user_copay を「総額に比例配分、最終行で差額吸収」で置き換える
      let remaining = row.honninFutan;
      const totalCostSum = matched.reduce((s, it) => s + it.total_cost, 0);
      for (let i = 0; i < matched.length; i++) {
        if (i === matched.length - 1) { matched[i].user_copay = remaining; continue; }
        const share = totalCostSum !== 0 ? Math.round(row.honninFutan * (matched[i].total_cost / totalCostSum)) : 0;
        matched[i].user_copay = share;
        remaining -= share;
      }
      publicExpenseByProvider.push({
        provider_name_prefix: row.providerNamePrefix,
        kohi_claim: row.kohiClaim,
        honnin_futan: row.honninFutan,
      });
    }
    if (kohi.total && kohi.total.kohiClaim != null) {
      const sumKohi = publicExpenseByProvider.reduce((s, r) => s + r.kohi_claim, 0);
      if (sumKohi !== kohi.total.kohiClaim) {
        warn.push(`公費額合計の印字値 ${kohi.total.kohiClaim} と行ごとの合計 ${sumKohi} が一致しない — 要確認`);
      }
    }
  }

  return { items, warn, publicExpenseByProvider, layout: layoutKey };
}

/**
 * 「公費適用事業所／公費額／本人負担」表 (公費併用者にだけ印字される) を読む。
 * 印字が無い (対象外の人) ときは null を返す。
 */
function extractKohiTable(words, L) {
  const header = words.find((w) => w.t === "公費適用事業所");
  if (!header) return null;
  const totalLabel = words.find((w) => w.t === "公費額合計");
  const rowYs = [...new Set(
    words
      .filter((w) => w.x > L.kohiName[0] && w.x < L.kohiName[1] && w.y > header.y + 5 && (!totalLabel || w.y < totalLabel.y - 2))
      .map((w) => Math.round(w.y * 2) / 2),
  )].sort((a, b) => a - b);
  const rows = [];
  for (const y of rowYs) {
    const nameWord = words.find((w) => Math.abs(w.y - y) <= 2 && w.x > L.kohiName[0] && w.x < L.kohiName[1]);
    if (!nameWord) continue;
    const kohiClaim = numAt(words, y, ...L.kohiClaim, 2);
    const honninFutan = numAt(words, y, ...L.kohiHonnin, 2);
    if (kohiClaim == null) continue;
    const m = /^(.*?)\((\d+)\)$/.exec(nameWord.t);
    rows.push({ providerNamePrefix: m ? m[1] : nameWord.t, kohiClaim, honninFutan: honninFutan ?? 0 });
  }
  const total = totalLabel
    ? { kohiClaim: numAt(words, totalLabel.y, ...L.kohiClaim, 3), honninFutan: numAt(words, totalLabel.y, ...L.kohiHonnin, 3) }
    : null;
  return { rows, total };
}

/** raw行 + 金額(直接 or 合計行由来) → EditFormUsageDetail の items[] 1行分 */
function finalizeItem(r, money) {
  const units = r.units ?? 0;
  const count = r.count ?? 0;
  const serviceUnits = r.service_units ?? (units * count);
  const unitPrice = money?.unitPrice ?? 10.0;
  const benefitRate = money?.benefitRate ?? 90;
  // 金額を直接読めた行はそれを優先し、合計行由来のときは呼出側と同じ式で計算する
  const hasDirect = money?.totalCost != null;
  const withinLimitUnits = serviceUnits; // ⚠ 限度超過は実データ6本に無く未対応 (モジュール冒頭コメント参照)
  const totalCost = hasDirect ? money.totalCost : Math.floor(withinLimitUnits * unitPrice);
  const insuranceClaim = hasDirect && money.insuranceClaim != null ? money.insuranceClaim : Math.floor(totalCost * benefitRate / 100);
  const userCopay = hasDirect && money.userCopay != null ? money.userCopay : totalCost - insuranceClaim;
  return {
    provider_name: r.provider_name ?? "",
    provider_number: r.provider_number ?? "",
    service_content: r.service_content ?? "",
    service_code: r.service_code ?? "",
    units, discount_units: units, count,
    service_units: serviceUnits,
    over_type_units: 0, over_limit_units: 0, within_limit_units: withinLimitUnits,
    unit_price: unitPrice, total_cost: totalCost, benefit_rate: benefitRate, insurance_claim: insuranceClaim,
    fixed_copay: 0, user_copay: userCopay, user_full_pay: 0,
    _money_source: money ? (hasDirect ? "direct" : "group-total") : "default",
    // 福祉用具貸与だけ (読めた出し方のとき)。それ以外は付けない (第7表の content を以前と同じ形に保つ)
    ...(r.tais_code ? { tais_code: r.tais_code } : {}),
    ...(r.model_name ? { model_name: r.model_name } : {}),
  };
}

// ── 束ね PDF を人ごとに切る (2026-11-13。import_care_plan3_usage_detail_from_pdf.mjs から移した。
//    別表から利用票の manual_units を埋める手順でも同じ切り方を使うため) ──
/** 別表ページ先頭のヘッダ「令和 8年 6月   0000375402   秋葉 法昌 様」→ {month, insured, name}。読めなければ null。
 *  ★ 計画書一括印刷・利用票別表(全CM) の出し方では全ページに印字される (2026-11-13 実測: 高品 178/178・
 *  木更津 177/177・計画書一括印刷 7/7)。CM 別に出した高品の 5 本 (例: 高品利用票別表佐藤CM.pdf) では 0/40 で読めない */
export function parseBetsuhyouHeader(text) {
  const m = /令和[\s　]*(\d+)[\s　]*年[\s　]*(\d+)[\s　]*月[\s　]+(\S{10})[\s　]+(.+?)[\s　]*様/.exec(text);
  if (!m) return null;
  return { month: `${2018 + Number(m[1])}-${String(Number(m[2])).padStart(2, "0")}`, insured: m[3], name: m[4].trim() };
}

/** 別表ページ上部の「居宅介護支援事業者番号：1278600406」→ "1278600406"。読めなければ null。
 *  ★ 2026-11-13 実測: 本文の文言は「居宅**介護**支援事業者番号」(pdfplumber の切れ目では「居宅支援事業者番号」に見える)。両方受ける。
 *  人の切れ目には使わない (hKey は変えない)。引き当てで同姓同名を絞るのと、割当の欠落を warn に出すのに使う */
export function parseBetsuhyouOfficeNumber(text) {
  const m = /居宅(?:介護)?支援事業者番号[\s　]*[：:][\s　]*(\d{10})/.exec(text);
  return m ? m[1] : null;
}

function emptyPerson() {
  return {
    weekly: null, riyouhyouIdentity: null, riyouhyouGrid: null, riyouhyouMonth: null,
    betsuhyouItems: null, betsuhyouWarn: [], betsuhyouPublicExpense: [], betsuhyouMonth: null, betsuhyouName: null,
    betsuhyouLimitAmount: null, betsuhyouHeader: null, betsuhyouOfficeNumber: null, betsuhyouHasEnd: false, betsuhyouPages: 0, pages: [],
  };
}

/**
 * 束ねPDF 1件を読み、**人ごと**の {weekly, riyouhyou, betsuhyou} の配列を返す (2026-11-13 に複数人対応)。
 *
 * 以前は 1 ファイル = 1 人の前提で、利用票・別表のページが複数あると最後のページで上書きしていた。
 * そのため (a) 別表が 2 ページにまたがる人は 1 ページ目の行が消え、(b) 複数人を 1 本に出すと最後の 1 人しか入らなかった。
 *
 * 人の切れ目 (ページは人ごとに連続して並ぶ前提。計画書(1) → 計画書(2) → 週間計画 → 利用票 → 別表 の順):
 *   ・計画書(1) が来たら新しい人 (それまでに何かページがあれば)
 *   ・週間計画: 今の人に 週間計画 / 利用票 / 別表 が既にあれば新しい人
 *   ・利用票: 今の人の利用票と (保険者番号, 被保番) が違う、または今の人に別表が既にあれば新しい人。同じなら続きのページ
 *   ・別表: ヘッダの (年月, 被保番, 氏名) が今の人の別表と違えば新しい人。同じなら続きのページとして **行を連結**する。
 *          今の人の利用票と被保番が違うときも新しい人 (利用票の無い人の別表)
 * 1 人だけのファイルは以前と同じ結果になる (既存 9 本で前後一致を確認)。
 * 自己検算 (印字の合計 = 行の合計) はページごとに行い、警告は人ごとに積む (ページをつないで 1 回で読んでも
 * 警告の件数は同じだった: 高品 2 ページ以上 35 人中 1 / 木更津 27 人中 2。どれも 2 ページ目の公費欄)。
 */
export function parseBundles(pdfPath) {
  const { texts, words } = extractPages(pdfPath);
  const persons = [];
  let cur = emptyPerson();
  // 人を閉じるとき: 別表があるのに最終ページの欄 (種類別支給限度管理) が無ければ、ページ境界で割れたかけら。
  // 事業所ごとの小計は合うので、行の検算だけでは気づけない (2026-11-13 いすみを 4/5 ページで割って実証: 1 ページ目だけで「完全」に見えた)。
  // 既存の束 26 本・336 人では 0 人 (割ったファイルだけが当たる)
  const finishPerson = (p) => {
    if (p.betsuhyouItems != null && !p.betsuhyouHasEnd)
      p.betsuhyouWarn = [...p.betsuhyouWarn, "別表の最終ページ (種類別支給限度管理の欄) が無い — ページ境界で割れたかけらの疑い"];
    return p;
  };
  const startNew = () => { if (cur.pages.length) persons.push(finishPerson(cur)); cur = emptyPerson(); };
  const idKey = (id) => `${id?.insurer ?? ""}|${id?.insured ?? ""}`;
  const hKey = (h) => (h ? `${h.month}|${h.insured}|${h.name}` : "");
  for (let i = 0; i < texts.length; i++) {
    const kind = classifyPage(texts[i]);
    if (kind === "careplan1" && cur.pages.length) startNew();
    if (kind === "weekly" && (cur.weekly || cur.riyouhyouIdentity || cur.betsuhyouItems)) startNew();
    let riyouId = null;
    if (kind === "riyouhyou") {
      riyouId = pickIdentity(words[i]);
      // ★ 座標読みで番号が取れないページは 本文テキストから読む (import_riyouhyou_service_usage.mjs の
      //   `id.insurer ?? who?.insurer` と同じ補い方。2026-11-13: 保険者が千葉市中央区の 太田 一恵・和田 和久 などで
      //   pickIdentity が null を返し、第7表・貸与の取込で「人を特定できない」になっていた)
      if (!riyouId?.insured) {
        const w = parseRiyouhyouPages([texts[i]], [words[i]])[0];
        if (w?.insurer && w?.insured) riyouId = { ...(riyouId ?? {}), insurer: w.insurer, insured: w.insured, name: riyouId?.name ?? w.name ?? null };
      }
      // 番号の無い利用票ページ (2 ページ目以降) は 前のページと同じ人として扱う (番号無しを別人と見なさない)
      if ((cur.riyouhyouIdentity && riyouId?.insured && idKey(cur.riyouhyouIdentity) !== idKey(riyouId)) || cur.betsuhyouItems) startNew();
    }
    let header = null;
    if (kind === "betsuhyou") {
      header = parseBetsuhyouHeader(texts[i]);
      if (cur.betsuhyouItems && hKey(cur.betsuhyouHeader) !== hKey(header)) startNew();
      else if (!cur.betsuhyouItems && header && cur.riyouhyouIdentity?.insured && cur.riyouhyouIdentity.insured !== header.insured) startNew();
    }
    const out = cur;
    out.pages.push(kind);
    if (kind === "weekly") out.weekly = extractWeeklySchedule(words[i]);
    if (kind === "riyouhyou") {
      // 2 ページ目以降で番号が読めないときに、1 ページ目で読めた人を null で上書きしない
      if (riyouId?.insured || !out.riyouhyouIdentity) out.riyouhyouIdentity = riyouId;
      out.riyouhyouGrid = extractGrid(words[i]);
      // ★ 対象月の唯一の正しいソース (2026-09-14 H指摘)。週間計画のヘッダ月は
      // 「計画作成月」であって提供月ではないため使わない。
      const mm = /令和[\s　]*(\d+)[\s　]*年[\s　]*(\d+)[\s　]*月分/.exec(texts[i]);
      if (mm) out.riyouhyouMonth = `${2018 + Number(mm[1])}-${String(Number(mm[2])).padStart(2, "0")}`;
    }
    if (kind === "betsuhyou") {
      const { items, warn, publicExpenseByProvider } = extractBetsuhyouRows(words[i]);
      const cont = out.betsuhyouItems != null; // 同じ人の 2 ページ目以降
      out.betsuhyouPages++;
      out.betsuhyouHeader ??= header;
      out.betsuhyouOfficeNumber ??= parseBetsuhyouOfficeNumber(texts[i]);
      // 人の最終ページにだけ「種類別支給限度管理」の欄が出る (1 ページの人にも出る。2026-11-13 いすみで実測)。
      // これが無いまま人が終わったら ページ境界で割れたかけら (下の finishPerson で警告にする)
      if (texts[i].includes("種類別支給限度管理")) out.betsuhyouHasEnd = true;
      out.betsuhyouItems = cont ? [...out.betsuhyouItems, ...items] : items;
      out.betsuhyouWarn = cont ? [...out.betsuhyouWarn, ...warn.map((w) => `(${out.betsuhyouPages} ページ目) ${w}`)] : warn;
      out.betsuhyouPublicExpense = cont ? [...out.betsuhyouPublicExpense, ...(publicExpenseByProvider ?? [])] : (publicExpenseByProvider ?? []);
      if (cont) continue; // 限度額・年月・氏名は 1 ページ目のものを使う
      // 「区分支給限度基準額(単位)」の直後に出る数字 (要介護度から機械的に決まる値。
      // _riyouhyou_pdf.mjs の LIMIT_TO_CARE_LEVEL と同じ値だが、印字を直接読むほうが
      // 要介護度の読み取り誤りに影響されず確実)
      // ⚠ ラベル「区分支給限度基準額(単位)」の**右**に値が出る (実測で左と誤認して
      //   一度 null になった。値は同じ行のラベルの右、次の「合計」ラベルより手前)
      const limitLabel = words[i].find((w) => w.t.includes("区分支給限度基準額"));
      if (limitLabel) {
        const near = words[i].find((w) => Math.abs(w.y - limitLabel.y) <= 3
          && w.x > limitLabel.x && w.x < limitLabel.x + 200 && /^\d{4,6}$/.test(w.t));
        if (near) out.betsuhyouLimitAmount = Number(near.t);
      }
      // 別表ヘッダー「令和 8年 6月   0000375402   秋葉 法昌 様」から提供年月と氏名を拾う
      // (週間計画の対象月欄が空欄のときのフォールバック用)
      const m = /令和[\s　]*(\d+)[\s　]*年[\s　]*(\d+)[\s　]*月/.exec(texts[i]);
      if (m) out.betsuhyouMonth = `${2018 + Number(m[1])}-${String(Number(m[2])).padStart(2, "0")}`;
      const nm = /様/.exec(texts[i]);
      if (nm) {
        const before = texts[i].slice(0, nm.index).trimEnd();
        const lastLine = before.split("\n").filter((l) => l.trim()).pop();
        if (lastLine) out.betsuhyouName = lastLine.trim();
      }
    }
  }
  startNew();
  return persons;
}

// ── 複数ファイルの束を人単位で突き合わせる (2026-11-13 H 依頼: 別表を 60 ページずつに割って出すため) ──
// 範囲を 1 ページ重ねて出す (1-60 / 60-120) ので、同じ人が 2 ファイルに出る。重ね忘れると 1 人が 2 ファイルに割れる。
// 人の同一性 = 別表ヘッダの (提供年月, 被保番, 氏名)。別表の無い人 (利用票だけ) は突き合わせない (そのまま渡す)。
// 「完全」 = 別表の行が 1 行以上読めて、自己検算 (印字の合計行 = 行の合計) の警告が無い。割れた別表は合計行が欠けて警告になる。
//   同じ人が複数ファイルに出たとき:
//     完全なものが 1 つ以上・行の中身が全部同じ → 最初の 1 つを使う (静かに。件数だけ数える)
//     完全なものが 2 つ以上・行の中身が違う     → ★ どれも使わない (印刷設定の違いなどで読みがずれた疑い)。conflicts に出す
//     完全なものが 1 つも無い                  → 最初の 1 つを渡す (各 script が自己検算の警告で書かない = 取り込めなかった人に出る)
//     不完全なものは、完全なものがあれば捨てる
// 1 ファイルだけ渡したときは parseBundles と同じ結果 (path の付け方も同じ)。
const bundleKey = (b) => (b.betsuhyouHeader ? `${b.betsuhyouHeader.month}|${b.betsuhyouHeader.insured}|${String(b.betsuhyouHeader.name).replace(/[\s　]/g, "")}` : null);
const isComplete = (b) => (b.betsuhyouItems ?? []).length > 0 && (b.betsuhyouWarn ?? []).length === 0;
const itemsSig = (b) => JSON.stringify((b.betsuhyouItems ?? []).map((it) => [it.service_code, it.provider_number, it.service_units, it.count, it.total_cost, it.insurance_claim]));

/**
 * @param {string[]} pdfPaths
 * @returns {{persons: Array<object>, sameDropped: number, partialDropped: Array<{name: string, insured: string, files: string[]}>, conflicts: Array<{name: string, insured: string, month: string, files: string[]}>}}
 *   persons の各要素は parseBundles の人に path (1 人のファイルは そのファイル、複数人は「ファイル#何人目」) と file / idx を足したもの
 */
export function parseBundlesMany(pdfPaths) {
  return selectBundlePersons(pdfPaths.flatMap((p) => {
    const ps = parseBundles(p);
    return ps.map((b, i) => ({ ...b, path: ps.length > 1 ? `${p}#${i + 1}` : p, file: p.split(/[\\/]/).pop(), idx: i + 1 }));
  }));
}

/** parseBundlesMany の突き合わせ部分 (純関数。検査 check:riyouhyou-units が合成データで境界を見る)
 * @param {Array<object>} all  path / file / idx を持つ人の配列 (ファイル順)
 */
export function selectBundlePersons(all) {
  const groups = new Map();
  for (const b of all) { const k = bundleKey(b); if (k) (groups.get(k) ?? groups.set(k, []).get(k)).push(b); }
  const drop = new Set();
  let sameDropped = 0;
  const partialDropped = [], conflicts = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const h = g[0].betsuhyouHeader;
    const complete = g.filter(isComplete);
    if (complete.length === 0) { for (const b of g.slice(1)) drop.add(b); continue; }
    if (new Set(complete.map(itemsSig)).size > 1) {
      for (const b of g) drop.add(b);
      conflicts.push({ name: h.name, insured: h.insured, month: h.month, files: g.map((b) => b.file) });
      continue;
    }
    const keep = complete[0];
    for (const b of g) {
      if (b === keep) continue;
      drop.add(b);
      if (isComplete(b)) sameDropped++;
      else partialDropped.push({ name: h.name, insured: h.insured, files: [b.file] });
    }
  }
  return { persons: all.filter((b) => !drop.has(b)), sameDropped, partialDropped, conflicts };
}
