// ============================================================================
// 移動支援 (地域生活支援事業) の市町村別 単価表 — **単一の出どころ**
//
// ── なぜ市町村別なのか ──────────────────────────────────────────────────
// 移動支援は地域生活支援事業で、国が単価を決めず**市町村が条例・要綱で定める**。
// だから国保連にも乗らず、市町村へ直接請求する。単価体系そのものが市町村ごとに違う:
//
//   千葉市      単位建て・時間帯ごとに**別コード**を持つ (src/lib/idou-shien-code.ts)
//   茂原市/睦沢町  **円建て**・基本額に時間帯の掛率を乗じる
//   大多喜町     単位建て (1単位=10円)
//
// 千葉市はコード体系が独自で専用モジュールがあるため、ここでは
// **「基本額 + 掛率」で表せる市町村**だけを扱う。
//
// ── なぜ .mjs でここに置いているか (2026-09-03) ─────────────────────────
// 以前は同じ表が **2 か所**にあった。
//     migrations/import_meisai_idou_records.mjs  … 実際に金額を入れているのはこちら
//     src/lib/idou-shien-rates.ts                … 検証ハーネスが見ていたのはこちら
// **ハーネスが検証しているのと本番で使われているのが別の表**で、片方だけ改定しても
// ハーネスは緑のままだった。そこで表を 1 本に切り出し、両方がここを import する。
//
// 置き場所が src/ でなく migrations/ なのは、**取込 script (.mjs) が import できる
// 必要がある**ため。Next.js の app code はこの表を使わない (画面は千葉市専用の
// コード体系しか持たず、他市町村は手動選択に落ちる = fail-closed)。
//
// 出典: サービスコード/移動支援/ 配下の単価表 (市から配布された PDF)
//   移動支援(茂原・睦沢).pdf   … 茂原市・睦沢町 共通
//   移動支援(大多喜).pdf       … 大多喜町 R8
//
// ⚠ 改定したら必ず  npx tsx scripts/idou-shien-rates-check.mts  を回すこと。
//   PDF の全数値 (参考行 21 件を含む) と突合する。
// ============================================================================

/**
 * 茂原市・睦沢町 (共通)。**円建て**。
 *   身体あり 30分未満 2,300 / 〜1h 4,000 / 〜1.5h 5,800 / 〜2h 6,550 / 〜2.5h 7,300 / 〜3h 8,050
 *   3 時間以上は 8,050 円に 30 分増すごとに +700 円
 *   加算: 早朝(6-8)・夜間(18-22) ×1.25 / 深夜(22-6) ×1.5
 */
const MOBARA = {
  label: "茂原市・睦沢町",
  unit: "円",
  body: [2300, 4000, 5800, 6550, 7300, 8050],
  noBody: [800, 1500, 2250, 2950, 3650, 4350],
  stepBody: 700,
  stepNoBody: 700,
  source: "サービスコード/移動支援/移動支援(茂原・睦沢).pdf 別表",
};

/**
 * 大多喜町。**単位建て** (1単位=10円)。
 *
 * ⚠ PDF の読み方に注意。「所要時間3時間以上の場合 916単位に…」の**本文 916 は誤植**で、
 *   表の金額欄 **921 が 3.0h〜3.5h 未満の値**。「3時間以上すべて」の意味ではない。
 *   (PDF 末尾の「※参考」行 3.5h = 1004 と 921+83 で繋がることで確認)
 *   身体なしも同様で、本文 343 に対し **表の 345 が 1.5h〜2.0h 未満の値**。
 *   → brackets の最後を 921 / 345 とし、そこから 30 分ごと +83 / +69 で伸ばすと
 *     参考行 21 件すべてと一致する。
 */
const OTAKI = {
  label: "大多喜町",
  unit: "単位",
  body: [256, 404, 587, 669, 754, 837, 921],
  noBody: [106, 197, 275, 345],
  stepBody: 83,
  stepNoBody: 69,
  source: "サービスコード/移動支援/移動支援(大多喜).pdf R8移動支援 単価表",
};

/** 市町村名 → 単価表。**未登録の市町村は null**。推測で単価を作らない (誤請求になる) */
export const IDOU_RATES = { 茂原市: MOBARA, 睦沢町: MOBARA, 大多喜町: OTAKI };

/** 単価表が登録されている市町村の一覧 */
export function supportedIdouMunicipalities() {
  return Object.keys(IDOU_RATES);
}

export function getIdouRates(municipality) {
  return IDOU_RATES[(municipality ?? "").trim()] ?? null;
}

/** "HH:MM" → 時間帯。深夜は 22:00-24:00 と 0:00-6:00 の両側 */
export function idouBandOfHM(hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec((hm ?? "").trim());
  const mm = m ? Number(m[1]) * 60 + Number(m[2]) : 720;
  if (mm < 360 || mm >= 1320) return "深夜";
  if (mm < 480) return "早朝";
  if (mm < 1080) return "日中";
  return "夜間";
}

/**
 * 移動支援 1 回分の請求額を算定する。未登録の市町村・0 分以下は null。
 *
 * @param {string|null|undefined} municipality 受給者証の市町村名
 * @param {number} minutes  算定時間 (分)。運転中など常時支援でない時間は控除済みの値
 * @param {string|null|undefined} startHM 算定開始時刻 "HH:MM" (時間帯の判定に使う)
 * @param {boolean} withBody 身体介護を伴うか
 *
 * ⚠ 時間帯は**開始時刻**で決める。時間帯をまたぐ場合の按分規定は市町村の要綱に
 *   明記が無く実例も未確認のため、開始時刻の区分を全体に適用している (要確認)。
 */
export function calcIdouAmount(municipality, minutes, startHM, withBody) {
  const r = getIdouRates(municipality);
  if (!r || minutes <= 0) return null;
  const table = withBody ? r.body : r.noBody;
  const step = withBody ? r.stepBody : r.stepNoBody;
  // 区分は「30分未満 / 30分以上1時間未満 / …」= **上限が排他**なので、
  // ちょうど 30 の倍数はその上の段に入る (180分 = 「3時間以上3時間30分未満」)。
  const bracket = Math.max(1, Math.floor(minutes / 30) + 1);
  const base =
    bracket <= table.length
      ? table[bracket - 1]
      : table[table.length - 1] + step * (bracket - table.length);
  const band = idouBandOfHM(startHM);
  const surcharge = band === "深夜" ? 0.5 : band === "日中" ? 0 : 0.25;
  const v = Math.round(base * (1 + surcharge));
  return {
    units: r.unit === "単位" ? v : null,
    yen: r.unit === "単位" ? v * 10 : v,
    baseYen: r.unit === "単位" ? base * 10 : base,
    band,
    surcharge,
    label: `${r.label} 移動支援${withBody ? "(身体あり)" : "(身体なし)"} ${(bracket * 0.5).toFixed(1)}h ${band}`,
  };
}
