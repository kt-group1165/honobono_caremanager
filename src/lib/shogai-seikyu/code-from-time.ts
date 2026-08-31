/**
 * 訪問の「時刻」から障害福祉サービスの 6 桁コードを引く。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────
 *   障害のコードは **所要時間 × 時間帯**で機械的に決まる。
 *     19:00〜20:00 = 1.0 時間・夜間 → 111219 身体夜１．０
 *   一方、介護保険は「身体介護1/2/3」という区分で、体系がまったく違う。
 *   同じ訪問でもコードが変わる:
 *     介護 111212 身体介護２・夜 484単位 / 障害 111219 身体夜１．０ 505単位
 *   さらに **同じ 6 桁が両制度にあって中身が別物** (障害の 111212 は
 *   「身体早２．５・２人」943単位)。コードの流用は不可。
 *
 *   シフト (kaigo_visit_schedule) はサービス「名」しか持たないため、
 *   両制度を使う利用者 (59 名) が介護の名前のまま障害で請求するケース
 *   (秋山久子: 11 回すべて「身体介護２・夜」なのに 4 回は障害請求) を
 *   名前引きでは解決できない。時刻から引き直す必要がある。
 *
 * ── どこから来たロジックか ────────────────────────────────────────────
 *   migrations/import_meisai_shougai_records.mjs で実装し、ほのぼの実伝送との
 *   突合で検算済み (茂原 J611 33/33 バイト一致ほか)。
 *   取込スクリプト内にしか無くアプリから呼べなかったので、ここへ切り出した。
 *   **両者で同じ結果になること**が前提なので、片方だけ直さないこと。
 *
 * ── 対象外 ────────────────────────────────────────────────────────────
 *   重度訪問介護 (021003) は「所要時間までの段を全部出す積み上げ型」で請求モデルが
 *   違うため、この行単位の変換器では扱わない (日次でまとめて解決する別実装)。
 *   行動援護 (021005) も未対応。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** 時間帯の境界。深夜 <6:00 / 早朝 6-8 / 日中 8-18 / 夜間 18-22 / 深夜 22- */
export type Zone = "日" | "夜" | "深" | "早";

/** 障害の請求で使うサービス種別 (マスタ名の先頭) */
export type ShogaiKind = "身体" | "家事" | "通院1" | "通院2" | "同援";

/**
 * 量子化モード。
 *   honobono: 境界は下位区分に含める (60分 → 1.0 =「1時間まで」)
 *   kokuji  : 境界は上位区分 (60分 → 1.5)
 * 既定は honobono (実伝送に一致するのはこちら)。
 */
export type BracketMode = "honobono" | "kokuji";

export interface CodeHit {
  code: string;
  name: string;
  units: number;
}

/** 種別ごとの量子化の刻み (分)。家事・通院2 は 15 分、他は 30 分 */
export function stepMinutesOf(kind: ShogaiKind): number {
  return kind === "家事" || kind === "通院2" ? 15 : 30;
}

export const parseHM = (s: string | null | undefined): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec((s ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function zoneOf(minOfDay: number): Zone {
  if (minOfDay < 360 || minOfDay >= 1320) return "深";
  if (minOfDay < 480) return "早";
  if (minOfDay < 1080) return "日";
  return "夜";
}

/** 算定時間(分) → 官報時間 (身体=0.5刻み / 家事=0.25刻み) */
export function quantizeHours(minutes: number, stepMin: number, mode: BracketMode): number {
  const units =
    mode === "kokuji"
      ? minutes % stepMin === 0
        ? minutes / stepMin + 1
        : Math.ceil(minutes / stepMin)
      : Math.ceil(minutes / stepMin);
  return units * (stepMin / 60);
}

/** 開始〜終了 を時間帯ごとの滞在(分)に分解。0時またぎ・解釈不能は null */
export function zoneSegments(
  startHM: string | null,
  endHM: string | null,
): { zone: Zone; min: number }[] | null {
  const s = parseHM(startHM);
  const e = parseHM(endHM);
  if (s == null || e == null || e <= s) return null;
  const bounds = [360, 480, 1080, 1320].filter((b) => b > s && b < e);
  const cuts = [s, ...bounds, e];
  const out: { zone: Zone; min: number }[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    out.push({ zone: zoneOf(cuts[i]), min: cuts[i + 1] - cuts[i] });
  }
  return out;
}

/**
 * コード表。マスタの service_name をパースして作る。
 *   single    単一時間帯      `${種別}|${帯}|${時間.toFixed(2)}|${修飾}`
 *   composite 時間帯またぎ    `${種別}|${帯}${時間}・${帯}${時間}…|${修飾}`
 *   increment 「増」区分      single と同じキー形
 * それぞれ ・2人 版を別に持つ (単位は 1 人版と同一)。
 */
export interface ShogaiCodeMaps {
  single: Map<string, CodeHit>;
  single2: Map<string, CodeHit>;
  composite: Map<string, CodeHit>;
  composite2: Map<string, CodeHit>;
  increment: Map<string, CodeHit>;
  increment2: Map<string, CodeHit>;
}

const SEG_RE = /^(日|夜|深|早)(\d+\.\d+)$/;
const INC_RE = /^(日|夜|深|早)増(\d+\.\d+)$/;

/**
 * 対象月に有効な障害コードから lookup を構築する。
 * ⚠ service_name は NFKC 正規化してから判定する (全角数字・「Ⅱ」対策)。
 */
export async function loadShogaiCodeMaps(
  supabase: SupabaseClient,
  year: number,
  month: number,
): Promise<ShogaiCodeMaps> {
  const monthFirst = `${year}-${String(month).padStart(2, "0")}-01`;
  const maps: ShogaiCodeMaps = {
    single: new Map(), single2: new Map(),
    composite: new Map(), composite2: new Map(),
    increment: new Map(), increment2: new Map(),
  };

  const rows: { service_code: string; service_name: string; units: number; valid_from: string | null; valid_until: string | null }[] = [];
  // service_name の LIKE で取る (コード prefix の OR + 広い range は statement timeout を踏む)
  for (const pat of ["身体%", "家事%", "同援%", "通院１%", "通院２%"]) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("kaigo_service_codes")
        .select("service_code, service_name, units, valid_from, valid_until")
        .eq("system", "障害")
        .eq("calculation_type", "基本")
        .like("service_name", pat)
        .order("service_code")
        .range(from, from + 999);
      if (error) break;
      rows.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
  }

  const inMonth = (r: { valid_from: string | null; valid_until: string | null }) =>
    (!r.valid_from || r.valid_from <= monthFirst) && (!r.valid_until || r.valid_until >= monthFirst);

  for (const r of rows.filter(inMonth)) {
    const raw = r.service_name ?? "";
    const nm = raw.normalize("NFKC");
    // ⚠ 「通院１」「通院２」を先に判定する (「通院」だけだと後続の数字を時間と誤認する)
    const km = /^(身体|家事|同援|通院[12])/.exec(nm);
    if (!km) continue;
    const kind = km[1];
    const parts = nm.slice(kind.length).split("・");
    let two = false, skip = false, isIncrement = false;
    const mods: string[] = [];
    const segs: { zone: string; hours: number }[] = [];
    for (const p of parts) {
      if (p === "2人") { two = true; continue; }
      if (p === "基") { skip = true; break; } // 基準該当(減額) は未算定
      if (kind === "同援" && /^区[0-9]$/.test(p)) { mods.push(p); continue; }
      if (kind === "同援" && (p === "基礎" || p === "盲ろう" || p === "通訳" || p.includes("補正"))) { skip = true; break; }
      const im = INC_RE.exec(p);
      if (im && segs.length === 0 && !isIncrement) {
        isIncrement = true;
        segs.push({ zone: im[1], hours: Number(im[2]) });
        continue;
      }
      const sm = SEG_RE.exec(p);
      if (!sm) { skip = true; break; } // 日跨増深 等の特殊増分形は対象外
      segs.push({ zone: sm[1], hours: Number(sm[2]) });
    }
    if (skip || segs.length === 0) continue;
    const val: CodeHit = { code: r.service_code, name: raw, units: r.units };
    const mk = [...mods].sort().join("・");
    if (isIncrement && segs.length === 1) {
      const key = `${kind}|${segs[0].zone}|${segs[0].hours.toFixed(2)}|${mk}`;
      const map = two ? maps.increment2 : maps.increment;
      if (!map.has(key)) map.set(key, val);
    } else if (segs.length === 1) {
      const key = `${kind}|${segs[0].zone}|${segs[0].hours.toFixed(2)}|${mk}`;
      const map = two ? maps.single2 : maps.single;
      if (!map.has(key)) map.set(key, val);
    } else {
      const key = `${kind}|` + segs.map((s) => `${s.zone}${s.hours.toFixed(2)}`).join("・") + `|${mk}`;
      const map = two ? maps.composite2 : maps.composite;
      if (!map.has(key)) map.set(key, val);
    }
  }
  return maps;
}

/**
 * `natural` と同じ合計 step 数を保ったまま、各要素 1 以上・ずれ 2 step 以内の配分を
 * ずれの小さい順に列挙する (natural 自身は含めない)。
 * 時間帯は最大 4 つなので素朴な全探索でよい。
 */
export function nearbyAllocations(natural: number[], totalUnits: number): number[][] {
  const n = natural.length;
  if (n < 2 || totalUnits < n) return [];
  const out: { a: number[]; d: number }[] = [];
  const cur: number[] = [];
  const walk = (i: number, left: number) => {
    if (i === n - 1) {
      if (left < 1 || Math.abs(left - natural[i]) > 2) return;
      const a = [...cur, left];
      const d = a.reduce((s, v, k) => s + Math.abs(v - natural[k]), 0);
      if (d > 0) out.push({ a, d });
      return;
    }
    const lo = Math.max(1, natural[i] - 2);
    const hi = Math.min(natural[i] + 2, left - (n - 1 - i));
    for (let v = lo; v <= hi; v++) {
      cur.push(v);
      walk(i + 1, left - v);
      cur.pop();
    }
  };
  walk(0, totalUnits);
  out.sort((x, y) => x.d - y.d);
  return out.map((x) => x.a);
}

/**
 * 1 訪問 → 障害コード。
 *
 * @param kind      サービス種別 (身体 / 家事 / 通院1 / 通院2 / 同援)
 * @param startHM   開始 "HH:MM"
 * @param endHM     終了 "HH:MM"
 * @param minutes   算定時間 (分)。省略時は開始〜終了から求める
 * @param twoPerson 同時 2 人派遣なら true (・2人 コードへ)
 * @param mods      同援の 区3/区4 等。身体・家事では空
 * @returns 引けなければ null (呼出側は warning を出して請求から外すこと)
 */
export function shogaiCodeFromTime(
  maps: ShogaiCodeMaps,
  kind: ShogaiKind,
  startHM: string | null,
  endHM: string | null,
  opts: { minutes?: number; mode?: BracketMode; twoPerson?: boolean; mods?: string[] } = {},
): CodeHit | null {
  const mode = opts.mode ?? "honobono";
  const twoPerson = opts.twoPerson ?? false;
  const mk = [...(opts.mods ?? [])].sort().join("・");
  const step = stepMinutesOf(kind);

  const s = parseHM(startHM);
  const e = parseHM(endHM);
  const minutes = opts.minutes ?? (s != null && e != null && e > s ? e - s : null);
  if (!minutes || minutes <= 0) return null;

  const segs = zoneSegments(startHM, endHM);

  // ① 単一時間帯 (またぎ無し) — 一番多い経路
  if (!segs || segs.length === 1) {
    const zone = segs?.[0]?.zone ?? (s != null ? zoneOf(s) : "日");
    const hours = quantizeHours(minutes, step, mode);
    const map = twoPerson ? maps.single2 : maps.single;
    return map.get(`${kind}|${zone}|${hours.toFixed(2)}|${mk}`) ?? null;
  }

  // ② 時間帯またぎ — 各帯に量子化配分して合成コードを引く
  //    先行する帯は **四捨五入**、末尾に残りを寄せる (clock 順)。
  //    ⚠ floor にすると step 未満の先頭区分が消える (姉ム 森田汐音 07:40-08:40 の
  //      早20分が消えて 身体日１．０ になっていた)。取込 script 側と同じ規則。
  const totalUnits = Math.round(quantizeHours(minutes, step, mode) / (step / 60));
  const alloc: number[] = [];
  let used = 0;
  for (let i = 0; i < segs.length - 1; i++) {
    const u = Math.min(Math.round(segs[i].min / step), Math.max(0, totalUnits - used));
    alloc.push(u);
    used += u;
  }
  alloc.push(Math.max(totalUnits - used, 0));
  const compMap = twoPerson ? maps.composite2 : maps.composite;
  const keyOf = (a: number[]) =>
    `${kind}|` +
    segs.map((sg, i) => `${sg.zone}${(a[i] * (step / 60)).toFixed(2)}`).join("・") +
    `|${mk}`;
  const comp = compMap.get(keyOf(alloc));
  if (comp) return comp;

  // ②-b 合成が **実在しない配分**になったときは、合計を保ったまま近い配分を探す。
  //   マスタの合成は下限が 0.5h で `家事日０．２５・夜…` が存在しない。素直に配分すると
  //   引けず単一コードへ落ちて金額がずれていた。
  //     いすみ 田中康夫 17:45-18:45  日15/夜45 → 日0.25・夜0.75 (無い)
  //                                  → **日0.5・夜0.5** (116327) が ほのぼのと一致
  //     やわた 柳澤玲子 17:40-19:10  日20/夜70 → 日0.25・夜1.25 (無い)
  //                                  → **日0.5・夜1.0** (116331) が ほのぼのと一致
  //   ⚠ 探すのは **各帯 1 step 以上・ずれ 2 step 以内**だけ。遠くまで探すと
  //     「合成が本当に無いので base+増 の 2 行で請求する」ケース (茂原 1221008558
  //     家事日3.0 + 家事夜増2.0) を壊す。既に引けている行はここへ来ない。
  const near = nearbyAllocations(alloc, totalUnits);
  for (const cand of near) {
    const hit = compMap.get(keyOf(cand));
    if (hit) return hit;
  }

  // ③ 合成コードが無いときは **算定開始の時間帯**の単一コードへ落とす
  //    (家事 0.25 セグメントや夜増などは合成が存在しない)
  const hours = quantizeHours(minutes, step, mode);
  const map = twoPerson ? maps.single2 : maps.single;
  return map.get(`${kind}|${segs[0].zone}|${hours.toFixed(2)}|${mk}`) ?? null;
}

/** サービス名 (介護・障害どちらでも) から種別を推測する。判定できなければ null */
export function kindFromServiceName(name: string | null | undefined): ShogaiKind | null {
  const n = (name ?? "").normalize("NFKC");
  if (!n) return null;
  // ⚠ 「通院」は「通院1/2」を先に見る。身体を伴うかで別種別
  if (/通院.*乗降|乗降/.test(n)) return null; // 通院等乗降介助はコード体系が別 (回数制)
  if (/通院/.test(n)) return /身体|伴う|1|１/.test(n) ? "通院1" : "通院2";
  if (/同行|同援/.test(n)) return "同援";
  if (/家事|生活援助|生活/.test(n)) return "家事";
  if (/身体/.test(n)) return "身体";
  return null;
}
