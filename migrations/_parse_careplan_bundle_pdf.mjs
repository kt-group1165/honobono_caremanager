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
// ── 別表(第7表)の数値列 — ★ 未確定・要確認 ────────────────────────────────
//   事業所名・事業所番号・サービス内容・サービスコードの4列は位置が明確で
//   自信を持って取れる。★ 単位数・割引後単位数・回数・サービス単位／金額・
//   費用総額・給付率・保険/事業費請求額 等の数値列は、ヘッダーが2〜3行に
//   折り返されて隣接列と間隔が詰まっており、1サンプル(淺井珠惠、割引なし・
//   全行回数=1)だけでは列境界を確実に決められなかった (合計行との自己検算が
//   一致しなかった)。★ このモジュールでは数値列の抽出を実装していない
//   (務めて推測しない)。行の合計行(「◯◯合計」)を目印にした自己検算ができる
//   別サンプル(割引適用 or 回数>1の行を含むもの)が要る。
// ============================================================================

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
 * 別表(第7表)ページから行明細を取り出す。
 * ★ 事業所名・事業所番号・サービス内容・サービスコードのみ (自信あり)。
 * ★ 単位数等の数値列は未実装 (要確認、モジュール冒頭コメント参照)。
 */
export function extractBetsuhyouRows(words) {
  // サービスコードは6桁の数字で、x が概ね190〜210に出る (実測)
  const codeWords = words.filter((w) => /^\d{6}$/.test(w.t) && w.x >= 185 && w.x <= 215);
  const rows = [];
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
    rows.push({
      service_code: cw.t,
      service_content: content || null,
      provider_name: providerName || null,
      provider_number: providerNumber,
      // 数値列は要確認のため未設定 (呼出側で null 埋めのまま提示する)
    });
  }
  return rows;
}
