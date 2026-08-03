/**
 * 障害福祉サービス 「提供時刻 → 公式6桁サービスコード」解決エンジン
 *
 * ─── なぜ共通モジュールなのか ─────────────────────────────────────────────
 * 現場が記録するのは「7:20〜9:30 に身体介護」だけで、国保連へ送るのは
 * `111131 身体早０．５・日２．０` のような6桁コード。この翻訳は
 *   ① ほのぼの稼働データ (MEISAI) の取込     … 移行期だけ
 *   ② 新システムの実績入力からの算定          … **本番で毎月使う**
 * の両方で必要になる。②が無いと新システム単独で請求できないので、
 * ほのぼの移行が終わっても捨てられない中核部品。
 * (捨てるのは MEISAI の CSV 読み取り = 列位置・021xxx というほのぼの独自コードの解釈だけ)
 *
 * ─── 時間帯 ───────────────────────────────────────────────────────────
 * 深夜 22:00-6:00 / 早朝 6:00-8:00 / 日中 8:00-18:00 / 夜間 18:00-22:00
 * 単価が時間帯で変わる (深夜1.5倍・早朝夜間1.25倍) ため、提供時刻を時間帯ごとに
 * 分解して「合成コード」を引く。マスタ名がその文法になっている。
 *
 * ─── マスタ名の文法 (2026-06 実データで確認) ────────────────────────────
 *   居宅介護   身体日０．５・夜１．０          種別=身体/家事
 *   同行援護   同援日０．５・基礎・２人・区４   種別=同援 + 修飾子
 *   重度訪問   重訪Ⅱ日中８．０・２人           ※時間帯が2文字 + 積み上げ型 (別扱い)
 *
 * 修飾子 (同行援護。件数は 2026-06 時点の基本コード1000件中):
 *   ・２人   625  同時2人派遣 (単位は1人分と同額)
 *   ・基礎   445  基礎研修修了者が提供 (減額)
 *   ・盲ろう 376  盲ろう者向け支援
 *   ・区３   289  障害支援区分3
 *   ・区４   282  障害支援区分**4以上** (区分6でも区４のコードを使う。実データで確認)
 *   ・通訳    87  盲ろう者向け通訳・介助
 *   ・(補正)      令和6年報酬改定の経過措置
 */

// ─── 時間帯 ──────────────────────────────────────────────────────────────────

/** 時間帯の 1 文字表記 (居宅介護・同行援護のマスタ名で使われる) */
export type Zone = "日" | "夜" | "深" | "早";

/** 分 (0-1439) → 時間帯。深夜は 22:00-24:00 と 0:00-6:00 の両側 */
export function zoneOfMinute(min: number): Zone {
  if (min < 6 * 60 || min >= 22 * 60) return "深";
  if (min < 8 * 60) return "早";
  if (min < 18 * 60) return "日";
  return "夜";
}

/** "HH:MM" → 分。解釈不能は null */
export function parseHM(s: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec((s ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 時間帯ごとの滞在(分) */
export interface ZoneSegment {
  zone: Zone;
  minutes: number;
}

/**
 * 開始〜終了 を時間帯ごとに clock 順で分解する。
 * 0 時またぎ (end <= start) と解釈不能は null (呼出側で単一時間帯へ fallback)。
 */
export function splitByZone(
  startHM: string | null | undefined,
  endHM: string | null | undefined,
): ZoneSegment[] | null {
  const s = parseHM(startHM);
  const e = parseHM(endHM);
  if (s == null || e == null || e <= s) return null;
  const boundaries = [360, 480, 1080, 1320].filter((b) => b > s && b < e);
  const cuts = [s, ...boundaries, e];
  const segs: ZoneSegment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    segs.push({ zone: zoneOfMinute(cuts[i]), minutes: cuts[i + 1] - cuts[i] });
  }
  return segs;
}

// ─── 時間の量子化 ────────────────────────────────────────────────────────────

/** 量子化モード。honobono = 境界を下位区分に含める (60分→1.0) / kokuji = 上位 (60分→1.5) */
export type BracketMode = "honobono" | "kokuji";

/**
 * 算定時間(分) → 官報上の時間数。
 *   stepMin: 身体・同行 = 30 (0.5h刻み) / 家事 = 15 (0.25h刻み)
 */
export function quantizeHours(minutes: number, stepMin: number, mode: BracketMode): number {
  const units =
    mode === "kokuji" && minutes % stepMin === 0
      ? minutes / stepMin + 1
      : Math.ceil(minutes / stepMin);
  return (units * stepMin) / 60;
}

// ─── マスタ名の解析 ──────────────────────────────────────────────────────────

/** マスタ名から読み取ったコードの素性 */
export interface ParsedCodeName {
  /** 種別 (身体 / 家事 / 同援 …) */
  kind: string;
  /** 時間帯セグメント (clock 順)。合成コードは 2 つ以上 */
  segments: { zone: Zone; hours: number }[];
  /** 「増」コード = 時間帯単独の増分 (例 家事夜増２．０) */
  isIncrement: boolean;
  /** 修飾子 (２人 / 基礎 / 盲ろう / 区３ / 通訳 / 補正 …) */
  modifiers: string[];
}

const ZONE_CHARS = "日夜深早";
const SEG_RE = new RegExp(`^([${ZONE_CHARS}])(増?)([0-9]+\\.[0-9]+)$`);

/**
 * マスタの service_name を解析する。想定外の形 (日跨増深 等の特殊複合) は null。
 *
 * ⚠ 全角数字・全角ピリオドが混ざるので NFKC 正規化してから解析する。
 */
export function parseCodeName(rawName: string, kinds: readonly string[]): ParsedCodeName | null {
  const nm = (rawName ?? "").normalize("NFKC");
  const kind = kinds.find((k) => nm.startsWith(k));
  if (!kind) return null;

  const parts = nm.slice(kind.length).split("・");
  const segments: { zone: Zone; hours: number }[] = [];
  const modifiers: string[] = [];
  let isIncrement = false;

  for (const p of parts) {
    const m = SEG_RE.exec(p);
    if (m) {
      if (m[2] === "増") {
        // 「増」は先頭にしか来ない (先頭以外は合成の一部ではなく想定外)
        if (segments.length > 0) return null;
        isIncrement = true;
      }
      segments.push({ zone: m[1] as Zone, hours: Number(m[3]) });
      continue;
    }
    if (p === "") continue;
    // 時間帯セグメントでないものは修飾子。ただし先頭が時間帯文字で数値が続かない
    // (日跨増深 等) は特殊複合形なので対象外にする
    if (segments.length === 0 && ZONE_CHARS.includes(p[0])) return null;
    modifiers.push(p);
  }
  if (segments.length === 0) return null;
  return { kind, segments, isIncrement, modifiers };
}

// ─── lookup キー ─────────────────────────────────────────────────────────────

/**
 * 修飾子を正規化してキー化する。順序に依存しないよう並べ替える。
 * 「区３」「区3」の全半角ゆれは NFKC 済み前提。
 */
export function modifierKey(modifiers: readonly string[]): string {
  return [...modifiers].sort().join("・");
}

/** 単一時間帯 / 増 のキー */
export function singleKey(kind: string, zone: Zone, hours: number, modifiers: readonly string[]): string {
  return `${kind}|${zone}|${hours.toFixed(2)}|${modifierKey(modifiers)}`;
}

/** 時間帯またぎ合成のキー (clock 順) */
export function compositeKey(
  kind: string,
  segments: readonly { zone: Zone; hours: number }[],
  modifiers: readonly string[],
): string {
  return `${kind}|${segments.map((s) => `${s.zone}${s.hours.toFixed(2)}`).join("・")}|${modifierKey(modifiers)}`;
}

// ─── 障害支援区分 → 同行援護の修飾子 ─────────────────────────────────────────

/**
 * 同行援護は障害支援区分でコードが変わる。
 * ⚠ **「区４」は区分4以上**を意味する (実データ: 稲生大輝=区分6 に 157703「同援日０．５・区４」)。
 *   区分1-2 は修飾子なし、区分3 は「区３」、区分4以上は「区４」。
 */
export function doukouKubunModifier(supportLevel: string | null | undefined): string | null {
  const m = /区分\s*([1-6１-６])/.exec((supportLevel ?? "").normalize("NFKC"));
  if (!m) return null;
  const n = Number(m[1].normalize("NFKC"));
  if (n >= 4) return "区4";
  if (n === 3) return "区3";
  return null;
}
