/**
 * 移動支援 (地域生活支援事業) の市町村別 単価表
 *
 * ─── なぜ市町村別なのか ──────────────────────────────────────────────────
 * 移動支援は**地域生活支援事業**で、国が単価を決めず**市町村が条例・要綱で定める**。
 * だから国保連にも乗らず、市町村へ直接請求する。単価体系そのものが市町村ごとに違う:
 *
 *   千葉市     単位建て・時間帯ごとに**別コード**を持つ (src/lib/idou-shien-code.ts)
 *   茂原市/睦沢町  **円建て**・基本額に時間帯の掛率を乗じる (早朝夜間+25% / 深夜+50%)
 *   大多喜町    単位建て (1単位=10円)・身体なしは1.5hで刻みが終わり以降は定額加算
 *
 * 千葉市はコード体系が独自で既に専用モジュールがあるため、ここでは
 * **「基本額 + 掛率」で表せる市町村**を扱う。
 *
 * 出典: サービスコード/移動支援/ 配下の単価表 (市から配布された PDF)
 *   移動支援(茂原・睦沢).pdf   … 茂原市・睦沢町 共通
 *   移動支援(大多喜).pdf       … 大多喜町 R8
 */

/** 時間帯 (移動支援の加算区分)。境界は障害福祉サービスと同じ */
export type IdouBand = "日中" | "早朝" | "夜間" | "深夜";

/** 分 (0-1439) → 時間帯。深夜は 22:00-24:00 と 0:00-6:00 の両側 */
export function idouBandOf(minOfDay: number): IdouBand {
  if (minOfDay < 6 * 60) return "深夜";
  if (minOfDay < 8 * 60) return "早朝";
  if (minOfDay < 18 * 60) return "日中";
  if (minOfDay < 22 * 60) return "夜間";
  return "深夜";
}

/** 単価表 1 本 (身体介護あり / なし のいずれか) */
interface RateTable {
  /** 30分刻みの基本額。index 0 = 〜30分, 1 = 〜1時間, … */
  brackets: number[];
  /** brackets を超えた分の 30分ごとの加算額 (null = 加算なし) */
  stepBeyond: number | null;
}

export interface MunicipalityIdouRates {
  /** 表示名 */
  label: string;
  /** 単位建てか円建てか。単位建ては 1単位=10円 で金額換算する */
  unit: "円" | "単位";
  /** 早朝・夜間の割増率 (0.25 = +25%)。0 なら割増なし */
  earlyNightRate: number;
  /** 深夜の割増率 */
  midnightRate: number;
  body: RateTable;
  noBody: RateTable;
  /** 出典 (監査用) */
  source: string;
}

/**
 * 茂原市・睦沢町 (共通)。**円建て**。
 *   30分未満 2,300 / 〜1h 4,000 / 〜1.5h 5,800 / 〜2h 6,550 / 〜2.5h 7,300 / 〜3h 8,050
 *   3時間以上は 8,050 円に 30分増すごとに 700 円を加算
 *   加算: 早朝(6-8)・夜間(18-22) ×25% / 深夜(22-6) ×50%
 */
const MOBARA: MunicipalityIdouRates = {
  label: "茂原市・睦沢町",
  unit: "円",
  earlyNightRate: 0.25,
  midnightRate: 0.5,
  body: { brackets: [2300, 4000, 5800, 6550, 7300, 8050], stepBeyond: 700 },
  noBody: { brackets: [800, 1500, 2250, 2950, 3650, 4350], stepBeyond: 700 },
  source: "サービスコード/移動支援/移動支援(茂原・睦沢).pdf 別表",
};

/**
 * 大多喜町。**単位建て** (1単位=10円)。
 *   身体伴う  : 256 / 404 / 587 / 669 / 754 / 837 / **921**、以降 30分ごと +83
 *   身体伴わず: 106 / 197 / 275 / **345**、以降 30分ごと +69
 *
 * ⚠ 表の読み方に注意。「所要時間3時間以上の場合 916単位に…」の行の金額欄 **921 は
 *   3.0h〜3.5h未満の値**であって「3時間以上すべて」ではない。本文の 916 は誤植
 *   (921 が正。PDF末尾の「※参考」行 3.5h=1004 から 921+83 で繋がる)。
 *   身体なしも同様で、本文 343 に対し表の 345 が 1.5h〜2.0h未満の値。
 *   → brackets の最後を 921 / 345 とし、そこから 30分ごと +83 / +69 で伸ばすと
 *     参考行 21 件すべてと一致する。
 */
const OTAKI: MunicipalityIdouRates = {
  label: "大多喜町",
  unit: "単位",
  earlyNightRate: 0.25,
  midnightRate: 0.5,
  body: { brackets: [256, 404, 587, 669, 754, 837, 921], stepBeyond: 83 },
  noBody: { brackets: [106, 197, 275, 345], stepBeyond: 69 },
  source: "サービスコード/移動支援/移動支援(大多喜).pdf R8移動支援 単価表",
};

/**
 * 市町村名 → 単価表。**未登録の市町村は null を返し、呼出側で警告する**
 * (推測で単価を作らない。誤請求になる)。
 */
const RATES: Record<string, MunicipalityIdouRates> = {
  茂原市: MOBARA,
  睦沢町: MOBARA,
  大多喜町: OTAKI,
};

export function getIdouRates(municipality: string | null | undefined): MunicipalityIdouRates | null {
  const key = (municipality ?? "").trim();
  return RATES[key] ?? null;
}

/** 単価表が登録されている市町村の一覧 (UI の説明用) */
export function supportedIdouMunicipalities(): string[] {
  return Object.keys(RATES);
}

export interface IdouAmountResult {
  /** 請求額 (円)。時間帯割増込み */
  yen: number;
  /** 単位建ての市町村のみ設定 (円建ては null) */
  units: number | null;
  band: IdouBand;
  /** 割増前の基本額 (円換算) */
  baseYen: number;
  /** 適用した割増率 (0 / 0.25 / 0.5) */
  surcharge: number;
  label: string;
}

/**
 * 移動支援 1 回分の請求額を算定する。
 *
 * @param municipality 受給者証の市町村名
 * @param minutes      算定時間 (分)。運転中など常時支援でない時間は控除済みの値を渡す
 * @param startHM      算定開始時刻 "HH:MM" (時間帯の判定に使う)
 * @param withBody     身体介護を伴うか
 *
 * ⚠ 時間帯は**開始時刻**で決める。時間帯をまたぐ場合の按分規定は市町村の要綱に
 *   明記が無く実例も未確認のため、開始時刻の区分を全体に適用している (要確認)。
 */
export function calcIdouAmount(
  municipality: string | null | undefined,
  minutes: number,
  startHM: string | null | undefined,
  withBody: boolean,
): IdouAmountResult | null {
  const rates = getIdouRates(municipality);
  if (!rates || minutes <= 0) return null;

  const table = withBody ? rates.body : rates.noBody;
  // 30分刻みで何段目か。区分は「30分未満 / 30分以上1時間未満 / …」= **上限が排他**なので、
  //   ちょうど 30 の倍数はその上の段に入る (180分 = 「3時間以上3時間30分未満」)。
  //   floor(minutes/30)+1 で表す (0-29分→1段目, 30-59分→2段目, 180-209分→7段目)。
  const bracket = Math.max(1, Math.floor(minutes / 30) + 1);
  let base: number;
  if (bracket <= table.brackets.length) {
    base = table.brackets[bracket - 1];
  } else {
    const last = table.brackets[table.brackets.length - 1];
    if (table.stepBeyond == null) return null;
    base = last + table.stepBeyond * (bracket - table.brackets.length);
  }

  const m = /^(\d{1,2}):(\d{2})/.exec((startHM ?? "").trim());
  const band = idouBandOf(m ? Number(m[1]) * 60 + Number(m[2]) : 12 * 60);
  const surcharge =
    band === "深夜" ? rates.midnightRate : band === "日中" ? 0 : rates.earlyNightRate;

  const baseYen = rates.unit === "単位" ? base * 10 : base;
  // 割増は基本額に対して掛ける。円建ては円のまま、単位建ては単位に掛けてから ×10
  const yen =
    rates.unit === "単位"
      ? Math.round(base * (1 + surcharge)) * 10
      : Math.round(base * (1 + surcharge));

  return {
    yen,
    units: rates.unit === "単位" ? Math.round(base * (1 + surcharge)) : null,
    band,
    baseYen,
    surcharge,
    label: `${rates.label} 移動支援${withBody ? "(身体あり)" : "(身体なし)"} ${(bracket * 0.5).toFixed(1)}h ${band}`,
  };
}
