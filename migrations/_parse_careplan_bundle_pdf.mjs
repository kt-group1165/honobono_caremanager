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
function isSubtotalRow(words, y) {
  return words.some((w) => Math.abs(w.y - y) <= 10 && w.x >= 108 && w.x < 190 && w.t.includes("合計"));
}

/** 1行ぶんの金額列を y から読む。無ければ null 埋めで返す (呼出側が判定に使う) */
function readMoneyAt(words, y, tol = 3) {
  return {
    unitPrice: decAt(words, y, 605, 622, tol),
    totalCost: numAt(words, y, 623, 663, tol),
    benefitRate: numAt(words, y, 668, 683, tol),
    insuranceClaim: numAt(words, y, 683, 716, tol),
    userCopay: numAt(words, y, 750, 786, tol),
    withinLimitBracket: numAt(words, y, 583, 601, tol),
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
  // サービスコードは6桁の数字で、x が概ね190〜210に出る (実測)
  const codeWords = words.filter((w) => /^\d{6}$/.test(w.t) && w.x >= 185 && w.x <= 215)
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
      .filter((w) => nearY(w) && w.x >= 108 && w.x < 185)
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((w) => w.t)
      .join("");
    // 事業所名: x<40。事業所番号 (10桁) は **2通りの出方**がある (実測):
    //   ① 事業所名の末尾に結合して印字される (例 "サービスセンター1271701524")
    //   ② 事業所名とは別の独立した語として x≈83 (ヘッダー「事業所番号」の位置) に出る
    //      (例 フランスベッド: 名前は x<40・番号は x=83.2 で分離)
    //   どちらで出るかは事業所名の折返し方次第らしく、決め打ちできないので両方見る。
    const providerRaw = words
      .filter((w) => nearY(w) && w.x < 40)
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((w) => w.t)
      .join("");
    const suffixMatch = /(\d{10})$/.exec(providerRaw);
    const standaloneNumber = words.find((w) => nearY(w) && w.x >= 41 && w.x <= 110 && /^\d{10}$/.test(w.t));
    const providerNumber = suffixMatch ? suffixMatch[1] : (standaloneNumber ? standaloneNumber.t : null);
    const providerName = suffixMatch ? providerRaw.slice(0, suffixMatch.index) : providerRaw;

    // 単位数・回数・サービス単位／金額は全行に出る (実測6本で確認)
    const units = numAt(words, cw.y, 295, 322, 3);
    const count = numAt(words, cw.y, 360, 385, 3);
    const serviceUnits = numAt(words, cw.y, 393, 412, 3) ?? numAt(words, cw.y, 414, 442, 3)
      ?? (units != null && count != null ? units * count : null);
    // 金額がこの行自身に直接出ているか (①のパターン)。出ていなければ null のまま返し、
    // 呼出側 (groupBetsuhyouItems) が直後の「◯◯合計」行から借りる (②のパターン)。
    const money = readMoneyAt(words, cw.y, 3);

    raw.push({
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
    words.filter((w) => w.x >= 108 && w.x < 190 && w.t.includes("合計")).map((w) => Math.round(w.y * 2) / 2),
  )].sort((a, b) => a - b);

  const warn = [];
  const items = [];
  let pendingGroup = []; // 金額がまだ無い行 (①でない行) を溜めておく
  const flushGroup = (subtotalY) => {
    if (!pendingGroup.length) return;
    const providerNum = pendingGroup[0].provider_number;
    const money = readMoneyAt(words, subtotalY, 8);
    if (money.unitPrice == null || money.benefitRate == null) {
      warn.push(`「◯◯合計」行 (y=${subtotalY}) の単価/給付率が読めない (事業所番号 ${providerNum ?? "不明"}) — 対象 ${pendingGroup.length} 行を規定値のまま出す`);
      for (const r of pendingGroup) items.push(finalizeItem(r, null));
    } else {
      // ⚠ 合計行の総額/保険請求/負担額は**グループ全体の値**であって各行の値ではない。
      //   finalizeItem に totalCost 等をそのまま渡すと「直接印字された値」と区別が
      //   付かず全行が同じ金額になってしまう (実測で発覚)。単価/給付率だけ渡して
      //   各行の service_units から finalizeItem 自身に計算させる。
      const rateOnly = { unitPrice: money.unitPrice, benefitRate: money.benefitRate };
      let sumComputed = 0;
      for (const r of pendingGroup) {
        items.push(finalizeItem(r, rateOnly));
        if (r.service_units != null) sumComputed += Math.floor(r.service_units * money.unitPrice);
      }
      if (money.totalCost != null) {
        const diff = Math.abs(sumComputed - money.totalCost);
        if (diff > Math.max(1, pendingGroup.length)) {
          warn.push(`「◯◯合計」行 (y=${subtotalY}, 事業所番号 ${providerNum ?? "不明"}) の費用総額 ${money.totalCost} と、行ごとの計算値の合計 ${sumComputed} の差が ${diff}円 (丸め許容 ${pendingGroup.length}円 を超過) — 要確認`);
        }
      }
    }
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
    if (nextSubtotalY != null && isSubtotalRow(words, nextSubtotalY)) {
      flushGroup(nextSubtotalY);
    }
  }
  if (pendingGroup.length) {
    warn.push(`最後まで「◯◯合計」行が見つからなかった行が ${pendingGroup.length} 件残った (事業所番号 ${pendingGroup[0].provider_number ?? "不明"})`);
    for (const r of pendingGroup) items.push(finalizeItem(r, null));
  }
  return { items, warn };
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
  };
}
