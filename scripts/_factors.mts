/**
 * 因子の定義 — **生成器と計測器の唯一の出どころ** (READ ONLY・DB を触らない)
 *
 *   scripts/sample-matrix.mts    サンプルの組合せを作る (pairwise)
 *   scripts/coverage-check.mts   実データが その組合せを どこまで覆うかを測る
 *
 * ── なぜこのファイルが要るか ─────────────────────────────────────────────
 *   2026-09-04 まで、上の 2 本は **別々に因子を定義していた**。
 *     sample-matrix    9因子 → 474ペア  (所要時間5値 / 公費3値 / 限度額3値)
 *     coverage-check   8因子 → 285ペア  (所要時間なし / 公費2値 / 限度額2値)
 *   分母が違うのに「62.1% の残りを 38 ケースで埋める」と説明していた。
 *   ★ 同じ土俵の数字ではなかった。定義を 1 か所に置いて分母を一致させる。
 *   (VERIFICATION_RULES 3-14「同じ事実を 2 か所に持つ列は必ず食い違う」の同型)
 *
 * ── 因子に入れてよいもの ─────────────────────────────────────────────────
 *   ★ **実装が実際に読んでいる値だけ**。読んでいない値を因子にしても、
 *     サンプルを作った時間が無駄になる (訪問入浴の「号車」= team_id は
 *     集計が select していないので入れていない)。
 *   why には **実装のどこが読むか** を書く。grep で確かめてから足すこと。
 *
 * ── measure (実データからの読み取り) ─────────────────────────────────────
 *   measure を **省略した因子は「未測定」**。coverage-check は
 *   ★ 測れないものを測ったことにしない。分母を 2 つ (全ペア / 測定可能ペア) 出す。
 *   measure は 1 行から **複数の値**を返してよい (string[])。
 *   例: 1 レセプトに 日中 と 夜間 の明細が両方あれば、その行は両方を覆う。
 *
 * ⚠ サービス名は **全角**が混ざる (２人 / １．０)。必ず NFKC 正規化してから判定する。
 *   正規化しないと「2人」は ★ 0 件に見える (2026-09-03 に実際に踏んだ)。
 *
 * ⚠ 制度を混ぜて数えない。深夜・通院は障害側にはあるが介護保険側の実データには無い。
 *   混ぜると網羅率を高く見せてしまうので、制度ごとに因子セットを分けている。
 */

import type { UserSeikyuRow, SeikyuDetailLine } from "@/lib/visit-seikyu/aggregate";
import type { SougouSeikyuRow } from "@/lib/visit-seikyu/aggregate-sougou";
import type { ShogaiSeikyuRow, ShogaiSeikyuDetail } from "@/lib/shogai-seikyu/aggregate";
import {
  AREA_UNIT_PRICE_TABLE,
  parseTeigenFromName,
  parseYoboShienKubun,
} from "@/app/(authenticated)/billing/claims/claims-shared";

/* ── 型 ──────────────────────────────────────────────────────────────── */

/** 1 行から読んだ因子の値。null = ★ その行からは読めなかった (覆えたに数えない) */
export type Measured = string | string[] | null;

export interface Factor<R> {
  name: string;
  /** なぜ因子か = 実装のどこがこの値を読み、何が変わるか */
  why: string;
  values: readonly string[];
  /** 実データ 1 行から値を読む。★ 省略 = 実データからは測れない (未測定) */
  measure?: (row: R) => Measured;
}

/**
 * 負のコントロール (VERIFICATION_RULES 3-9)。
 * ★ 実データに 0 件の値が出たとき、「実データに無い」のか
 *   「measure が壊れている」のかを区別するための合成行。
 */
export interface Probe<R> {
  label: string;
  row: R;
  /** 因子名 → その行で measure が返すべき値 (順不同) */
  expect: Record<string, string[]>;
}

/**
 * ★ 実際には有り得ない組合せ。ここに書いたペアは生成しないし、分母からも外す。
 *
 * ⚠ **根拠が言えるものだけ**書くこと。裏の取れていない組合せを入れると、
 *   ★ 検証すべき組合せを黙って除外することになる。why に根拠を必ず書く。
 * ⚠ 逆に、書かないと有り得ないケースが「出ない値」として残る。
 *   FAIL を見たら「バグ」と決める前に「そもそも成立する組合せか」を先に確かめる。
 */
export interface Constraint {
  /** [因子A, 値A, 因子B, 値B] */
  pair: [string, string, string, string];
  why: string;
}

export interface FactorSet<R> {
  key: string;
  /** 制度名 (表示用) */
  system: string;
  /** 実データをどこから取るか */
  source: string;
  note?: string;
  factors: Factor<R>[];
  /** 有り得ない組合せ (省略 = 無し)。★ 現在どの制度も空 = 未検証 */
  constraints?: Constraint[];
  probes: Probe<R>[];
}

/** sample-matrix 用の型 (measure を持たない = 制度に依存しない view) */
export interface FactorSpecSet {
  key: string;
  system: string;
  source: string;
  note?: string;
  constraints: Constraint[];
  factors: { name: string; why: string; values: readonly string[]; measurable: boolean }[];
}

/* ── 共通ヘルパ ──────────────────────────────────────────────────────── */

/**
 * ★ 全角混在対策 (２人 → 2人 / １．０ → 1.0)。名前で判定する前に必ず通す。
 *
 * ⚠ **ローマ数字には使わない。**NFKC は Ⅰ(U+2160) → "I" / ⅰ(U+2170) → "i" に潰す。
 *   特定事業所加算の種別 (Ⅰ/Ⅱ/Ⅲ) や 逓減段 (ⅰ/ⅱ/ⅲ) を norm してから
 *   値リストと比べると ★ 全件が「読めない」になる。生値で比べること。
 */
export const norm = (s: unknown): string => String(s ?? "").normalize("NFKC");

/** ローマ数字を壊さない軽い正規化 (空白除去 + 全角英字→半角) */
export const trimWide = (s: unknown): string =>
  String(s ?? "").replace(/\s/g, "").replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

export function toValues(m: Measured): string[] {
  if (m === null || m === undefined) return [];
  return Array.isArray(m) ? m.filter((v) => v) : [m];
}

/** 2 因子間の全ペアキー。生成器・計測器が **同じ関数**で分母を作る */
export function allPairKeys(factors: { values: readonly string[] }[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < factors.length; i++)
    for (let j = i + 1; j < factors.length; j++)
      for (const a of factors[i].values)
        for (const b of factors[j].values) out.push(`${i}:${a}|${j}:${b}`);
  return out;
}

type NamedValues = { name: string; values: readonly string[] };

/** 制約のペアキー。因子名・値の綴り間違いは ★ 黙って無効化されないよう throw する */
function constraintKeysCore(key: string, factors: NamedValues[], constraints: Constraint[]): Set<string> {
  const out = new Set<string>();
  for (const { pair: [fa, va, fb, vb] } of constraints) {
    const ia = factors.findIndex((f) => f.name === fa);
    const ib = factors.findIndex((f) => f.name === fb);
    if (ia < 0 || ib < 0) throw new Error(`${key}: 制約の因子名が factors にありません: ${fa} / ${fb}`);
    if (!factors[ia].values.includes(va) || !factors[ib].values.includes(vb))
      throw new Error(`${key}: 制約の値が values にありません: ${va} / ${vb}`);
    const [i, v, j, w] = ia < ib ? [ia, va, ib, vb] : [ib, vb, ia, va];
    out.add(`${i}:${v}|${j}:${w}`);
  }
  return out;
}

function pairKeysCore(key: string, factors: NamedValues[], constraints: Constraint[]): string[] {
  const ban = constraintKeysCore(key, factors, constraints);
  return allPairKeys(factors).filter((k) => !ban.has(k));
}

/**
 * ★ この制度の 2 因子ペアの分母。**生成器も計測器もこの関数だけを使う。**
 * 別々に数えると分母が食い違う (2026-09-04 まで実際に食い違っていた)。
 */
export function pairKeysFor<R>(set: FactorSet<R>): string[] {
  return pairKeysCore(set.key, set.factors, set.constraints ?? []);
}

/** sample-matrix 側 (制度をまたいで回すので measure を持たない view) */
export function pairKeysForSpec(spec: FactorSpecSet): string[] {
  return pairKeysCore(spec.key, spec.factors, spec.constraints);
}

export function toSpec<R>(s: FactorSet<R>): FactorSpecSet {
  return {
    key: s.key,
    system: s.system,
    source: s.source,
    note: s.note,
    constraints: s.constraints ?? [],
    factors: s.factors.map((f) => ({
      name: f.name,
      why: f.why,
      values: f.values,
      measurable: !!f.measure,
    })),
  };
}

/* ── 明細名からの読み取り (介護保険 / 総合事業 / 障害 で共用) ───────────── */

/** サービス名の並び (NFKC 済み) */
const namesOf = (details: { service_type: string }[]): string[] =>
  details.map((d) => norm(d.service_type));

/**
 * 時間帯。サービス名の 日 / 早 / 夜 / 深 の 1 文字トークンで判定する。
 * 介護 「身体介護１・夜」 障害 「身体日０．５・夜０．５」 重訪 「重訪Ⅱ夜間８．０」。
 * ★ 1 行に複数の時間帯が同居しうるので複数返す。
 *
 * ⚠ 重訪は「深夜」という **2 文字**で持つ。素朴に 夜 を探すと
 *   「深夜」を ★ 夜間 にも数えてしまうので、先に 深 の1文字へ畳んでから見る。
 */
function zonesOf(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const s = n.replace(/深夜/g, "深");
    let hit = false;
    if (s.includes("深")) { out.add("深夜"); hit = true; }
    if (s.includes("夜")) { out.add("夜間"); hit = true; }
    if (s.includes("早")) { out.add("早朝"); hit = true; }
    if (s.includes("日")) { out.add("日中"); hit = true; }
    // 時間帯トークンを持たない名前 (身体介護１ 等) は日中扱い。
    // ⚠ 加算行 (処遇改善等) も名前を持つので、実サービス行だけを見たい場合は
    //   呼び側で details を絞ること。ここでは「日中を含む」までしか言わない。
    if (!hit && /身体|生活|家事|通院|乗降/.test(n)) out.add("日中");
  }
  return [...out];
}

/** ・2人 コード (単位が概ね2倍) */
const twoPersonOf = (names: string[]): string =>
  names.some((n) => n.includes("2人")) ? "2人" : "1人";

/** 公費 (法別番号)。★ 未知の法別は null = 読めなかった扱い */
function kohiOf(hobetsu: string | null | undefined): string | null {
  const h = norm(hobetsu).trim();
  if (!h) return "なし";
  if (h === "12") return "法別12(生保)";
  if (h === "81") return "法別81(原爆)";
  return null;
}

/**
 * 限度額。★ 限度額が引けない行 (認定にも計画単位数にも無い) は null = 未判定。
 * 「範囲内」と断定できないため (VERIFICATION_RULES 1-2)。
 * 「ちょうど」= 限度額管理対象単位数が基準値と一致。管理対象外の実単位加算は
 * 現在該当なし (aggregate.ts の overUnits コメント) なので grossBaseUnits で見る。
 */
function limitOf(r: { limitUnits: number | null; overUnits: number; grossBaseUnits: number }): string | null {
  if (r.overUnits > 0) return "超過";
  if (r.limitUnits === null) return null;
  return r.grossBaseUnits === r.limitUnits ? "ちょうど" : "範囲内";
}

const copayOf = (rate: number): string | null =>
  rate === 0.1 ? "1割" : rate === 0.2 ? "2割" : rate === 0.3 ? "3割" : null;

/** 単価 (円/単位) → 地域区分。実装の AREA_UNIT_PRICE_TABLE から逆引きする */
const AREA_LIST = Object.keys(AREA_UNIT_PRICE_TABLE);
function areaOf(unitPrice: number | null | undefined): string | null {
  if (unitPrice === null || unitPrice === undefined) return null;
  const hit = AREA_LIST.find((k) => Math.abs(AREA_UNIT_PRICE_TABLE[k] - Number(unitPrice)) < 0.005);
  return hit ?? null;
}

/* ── fixture (負のコントロール用の合成行) ────────────────────────────── */

function mkDetail(p: Partial<SeikyuDetailLine> & { service_type: string }): SeikyuDetailLine {
  return {
    short_name: null,
    service_code: "111111",
    unit_per: 100,
    count: 1,
    units: 100,
    ...p,
  };
}

function mkKaigoRow(p: Partial<UserSeikyuRow>): UserSeikyuRow {
  return {
    user_id: "u", user_name: "テスト", user_name_kana: null, user_number: null,
    insurer_number: null, insurer_name: null, insured_number: null,
    care_level: "要介護1", copay_rate: 0.1,
    details: [], grossBaseUnits: 0, limitUnits: null, planUnits: null,
    overUnits: 0, overSource: "auto", overAmount: 0, selfPayAmount: 0,
    baseUnits: 0, addonUnits: 0, kanriTaishougaiUnits: 0, addonLabel: null,
    totalUnits: 0, unitPrice: 10, totalAmount: 0, insuranceAmount: 0, userAmount: 0,
    publicExpense: null, kohiTandoku: false, kohiHobetsu: null,
    kohiFutanshaNumber: null, kohiJukyushaNumber: null, kohiUnits: null, kohiAmount: null,
    addonCode: null, birthDate: null, gender: null, certStart: null, certEnd: null,
    careOfficeNumber: null, careOfficeName: null, planCreatorKubun: null,
    serviceStartDate: null, serviceDays: 0,
    ...p,
  };
}

function mkShogaiDetail(p: Partial<ShogaiSeikyuDetail> & { service_type: string }): ShogaiSeikyuDetail {
  return { service_category: null, service_code: null, unit_per: 100, count: 1, units: 100, ...p };
}

function mkShogaiRow(p: Partial<ShogaiSeikyuRow>): ShogaiSeikyuRow {
  return {
    user_id: "u", user_name: "テスト", user_name_kana: null,
    beneficiary_number: null, municipality: null, support_level: null,
    self_payment_limit: null, seiho: false, details: [], addons: [],
    addonUnits: 0, addonLabel: null, addonCode: null, totalUnits: 0,
    unitPrice: 10, totalAmount: 0, userAmount: 0, benefitAmount: 0,
    jogenKanriKubun: "なし", jogenKanriOfficeNumber: null, jogenKanriOfficeName: null,
    kanriResult: null, kanriResultAmount: null, certStart: null, certEnd: null,
    shikyuryoOver: [],
    ...p,
  };
}

/* ══ 介護保険 — 訪問介護 介護給付費 (明細書 7131 / 様式第二) ══════════════ */

export const KAIGO_FACTORS: FactorSet<UserSeikyuRow> = {
  key: "kaigo",
  system: "介護保険 (訪問介護 介護給付費 7131)",
  source: "aggregateMonthlyVisitSeikyu(...).rows — 訪問介護 事業所 × 対象月",
  note:
    "要支援1/2 は 2026-09-03 実測で 介護給付の行に一度も出ない (総合事業へ行くため)。" +
    "★ 値は消していない — 制度上ありえないと裏が取れていないため (CONSTRAINTS に入れるのが本来)。",
  factors: [
    {
      name: "要介護度",
      why: "基本コードと区分支給限度基準額が変わる (aggregate.ts の限度額解決 / reports の CARE_LEVEL_LIMITS)",
      values: ["要支援1", "要支援2", "要介護1", "要介護2", "要介護3", "要介護4", "要介護5"],
      measure: (r) => {
        const v = norm(r.care_level);
        return KAIGO_FACTORS.factors[0].values.includes(v) ? v : null;
      },
    },
    {
      name: "サービス",
      why: "サービス項目コードが変わる。身体+生活は生活の時間で加算部分が決まる",
      values: ["身体", "生活", "身体+生活", "通院"],
      measure: (r) => {
        const out = new Set<string>();
        for (const n of namesOf(r.details)) {
          if (/通院|乗降/.test(n)) { out.add("通院"); continue; }
          const b = /身体/.test(n);
          const s = /生活|家事/.test(n);
          if (b && s) out.add("身体+生活");
          else if (b) out.add("身体");
          else if (s) out.add("生活");
        }
        return [...out];
      },
    },
    {
      name: "時間帯",
      why: "早朝/夜間の 25% ・深夜の 50% 加算が付く (サービスコードが別)",
      values: ["日中", "早朝", "夜間", "深夜"],
      measure: (r) => zonesOf(namesOf(r.details)),
    },
    {
      name: "所要時間",
      why: "コードの段が変わる。★ 境界値をまたぐと単位数が跳ぶ",
      values: ["20分未満", "20-30分", "30-60分", "60-90分", "90分超"],
      // ★ measure なし = 未測定。
      //   集計行 (UserSeikyuRow) は所要時間を持たない。サービス名 (身体介護01/1/2/3…)
      //   は段を表すが、名前→分数 の対応は告示の読み替えで、間違えると
      //   ★ 網羅率を実際より高く見せてしまう。測るなら kaigo_visit_schedule の
      //   duration_minutes を根拠に別途 (集計行には出てこない)。
    },
    {
      name: "2人派遣",
      why: "・2人 コードになり単位が概ね2倍",
      values: ["1人", "2人"],
      measure: (r) => twoPersonOf(namesOf(r.details)),
    },
    {
      name: "負担割合",
      why: "保険請求額 = floor(総額 × 給付率)。copay_rate が 0.1/0.2/0.3 で割り振りが変わる",
      values: ["1割", "2割", "3割"],
      measure: (r) => copayOf(r.copay_rate),
    },
    {
      name: "公費",
      why: "公費請求額が立ち利用者負担が減る。法別で本人負担の扱いが違う (lib/kohi.ts)",
      values: ["なし", "法別12(生保)", "法別81(原爆)"],
      measure: (r) => kohiOf(r.kohiHobetsu),
    },
    {
      name: "限度額",
      why: "超過分は保険請求から外れて全額自費 (selfPayAmount)。★ 恒等式が壊れやすい所",
      values: ["範囲内", "ちょうど", "超過"],
      measure: (r) => limitOf(r),
    },
    {
      name: "初回加算",
      why: "限度額管理対象の実単位加算。明細行として立つ",
      values: ["なし", "あり"],
      measure: (r) => (namesOf(r.details).some((n) => n.includes("初回")) ? "あり" : "なし"),
    },
  ],
  probes: [
    {
      label: "深夜・2人・3割・原爆・超過",
      row: mkKaigoRow({
        care_level: "要介護5",
        copay_rate: 0.3,
        kohiHobetsu: "81",
        limitUnits: 1000,
        grossBaseUnits: 1200,
        overUnits: 200,
        details: [mkDetail({ service_type: "身体介護２・深・２人" }), mkDetail({ service_type: "初回加算" })],
      }),
      expect: {
        要介護度: ["要介護5"], サービス: ["身体"], 時間帯: ["深夜"], "2人派遣": ["2人"],
        負担割合: ["3割"], 公費: ["法別81(原爆)"], 限度額: ["超過"], 初回加算: ["あり"],
      },
    },
    {
      label: "日中+夜間の同居・生保・ちょうど",
      row: mkKaigoRow({
        care_level: "要支援1",
        copay_rate: 0.2,
        kohiHobetsu: "12",
        limitUnits: 500,
        grossBaseUnits: 500,
        details: [
          mkDetail({ service_type: "身体１生活１" }),
          mkDetail({ service_type: "生活援助３・夜" }),
          mkDetail({ service_type: "通院等乗降介助" }),
        ],
      }),
      expect: {
        要介護度: ["要支援1"], サービス: ["身体+生活", "生活", "通院"], 時間帯: ["日中", "夜間"],
        "2人派遣": ["1人"], 負担割合: ["2割"], 公費: ["法別12(生保)"], 限度額: ["ちょうど"], 初回加算: ["なし"],
      },
    },
    {
      label: "限度額が引けない行は ★ 未判定 (範囲内と断定しない)",
      row: mkKaigoRow({ limitUnits: null, overUnits: 0, details: [mkDetail({ service_type: "身体介護１" })] }),
      expect: { 限度額: [], 時間帯: ["日中"], 公費: ["なし"] },
    },
  ],
};

/* ══ 総合事業 — 介護予防・日常生活支援総合事業 (明細書 71R1) ═════════════ */

export const SOUGOU_FACTORS: FactorSet<SougouSeikyuRow> = {
  key: "sougou",
  system: "総合事業 (訪問型サービス 71R1)",
  source: "aggregateMonthlyVisitSeikyu(...).sougouRows — 訪問介護 事業所 × 対象月",
  note:
    "★ 自治体コード体系 (CB_/K_/IH_… の prefix) は因子にしていない。" +
    "値リストが aggregate-sougou.ts の private map と二重管理になり、必ず食い違うため " +
    "(VERIFICATION_RULES 3-14)。単価に効く「地域区分」で代替している。",
  factors: [
    {
      name: "認定区分",
      why: "限度額の補完値が変わる (SOUGOU_CARE_LEVEL_LIMITS)。事業対象者・要支援・要介護が混在する",
      values: ["事業対象者", "要支援1", "要支援2", "要介護1", "要介護2", "要介護3", "要介護4", "要介護5"],
      measure: (r) => {
        const v = norm(r.care_level);
        return SOUGOU_FACTORS.factors[0].values.includes(v) ? v : null;
      },
    },
    {
      name: "サービス",
      why: "基本コードの体系が違う (相当サービス / 独自サービス / 訪問型サービスA)",
      values: ["訪問介護相当", "訪問型独自サービス", "訪問型サービスA"],
      measure: (r) => {
        const out = new Set<string>();
        for (const n of namesOf(r.details)) {
          if (n.includes("相当")) out.add("訪問介護相当");
          else if (n.includes("独自")) out.add("訪問型独自サービス");
          else if (n.includes("訪問型サービス")) out.add("訪問型サービスA");
        }
        return [...out];
      },
    },
    {
      name: "単位種別",
      why: "unit_type='1月につき' は回数を掛けない (月額包括)。伝送 71R1 の単位数欄も 0 で出す",
      values: ["回数", "月額包括"],
      measure: (r) => {
        const out = new Set<string>();
        for (const d of r.details) out.add(d.is_monthly ? "月額包括" : "回数");
        return [...out];
      },
    },
    {
      name: "負担割合",
      why: "給付率 90/80/70%。総合事業も認定の負担割合に従う",
      values: ["1割", "2割", "3割"],
      measure: (r) => copayOf(r.copay_rate),
    },
    {
      name: "公費",
      why: "介護給付と同じ公費カスケード (lib/kohi.ts) を通る",
      values: ["なし", "法別12(生保)", "法別81(原爆)"],
      measure: (r) => kohiOf(r.kohiHobetsu),
    },
    {
      name: "限度額",
      why: "超過分は保険請求から外れて全額自費。予防給付との合算管理はケアマネ側",
      values: ["範囲内", "ちょうど", "超過"],
      measure: (r) => limitOf(r),
    },
    {
      name: "処遇改善加算",
      why: "総合事業の処遇改善コード (CB_A26184 等) を率で計算。限度額管理対象外に入る",
      values: ["なし", "あり"],
      measure: (r) => (r.addonUnits > 0 ? "あり" : "なし"),
    },
    {
      name: "地域区分",
      why:
        "★ 総合は 利用者の保険者(市町村)の級地で単価が決まる (SOUGOU_UNITPRICE_BY_INSURER)。" +
        "事業所所在地の単価を使うと他市の利用者が誤単価になる (2026-08-07 に4名の過大請求)",
      values: AREA_LIST,
      measure: (r) => areaOf(r.unitPrice),
    },
    {
      name: "住所地特例",
      why: "71R1 で明細を 種別02 ではなく 種別14 (施設所在保険者番号つき) で出す",
      values: ["なし", "あり"],
      measure: (r) => (r.jushoTokurei ? "あり" : "なし"),
    },
  ],
  probes: [
    {
      label: "事業対象者・月額包括・住所地特例・処遇改善あり",
      row: {
        ...mkKaigoRow({
          care_level: "事業対象者",
          copay_rate: 0.1,
          addonUnits: 50,
          unitPrice: 11.05,
          limitUnits: 5032,
          grossBaseUnits: 5032,
          details: [
            mkDetail({ service_type: "訪問介護相当サービス（１月当たりの回数）（標準的内容）", is_monthly: true }),
          ],
        }),
        jushoTokurei: true,
      },
      expect: {
        認定区分: ["事業対象者"], サービス: ["訪問介護相当"], 単位種別: ["月額包括"],
        負担割合: ["1割"], 公費: ["なし"], 限度額: ["ちょうど"], 処遇改善加算: ["あり"],
        地域区分: ["3級地"], 住所地特例: ["あり"],
      },
    },
    {
      label: "独自サービス + 訪問型サービスA の同居・超過・3割",
      row: {
        ...mkKaigoRow({
          care_level: "要支援2",
          copay_rate: 0.3,
          unitPrice: 10,
          limitUnits: 10531,
          grossBaseUnits: 12000,
          overUnits: 1469,
          details: [
            mkDetail({ service_type: "訪問型独自サービス１２" }),
            mkDetail({ service_type: "訪問型サービスA・３（60分まで）" }),
          ],
        }),
      },
      expect: {
        認定区分: ["要支援2"], サービス: ["訪問型独自サービス", "訪問型サービスA"],
        単位種別: ["回数"], 負担割合: ["3割"], 限度額: ["超過"], 処遇改善加算: ["なし"],
        地域区分: ["その他"], 住所地特例: ["なし"],
      },
    },
  ],
};

/* ══ 障害福祉 — 介護給付費 (明細書 J121 / 請求書 J611) ═══════════════════ */

/** サービスコードの先頭2桁 (種類コード) → サービス種別 */
const SHOGAI_TYPE_BY_CODE: Record<string, string> = {
  "11": "居宅介護",
  "12": "重度訪問介護",
  "13": "行動援護",
  // ⚠ master では 同行援護 が 14 と 15 の両方に居る (14=身体介護あり系 / 15=独自命名)。
  //   aggregate.ts の SERVICE_TYPE_CODES は 14 を同行援護に割り当てている。
  "14": "同行援護",
  "15": "同行援護",
};

function shogaiTypesOf(details: ShogaiSeikyuDetail[]): string[] {
  const out = new Set<string>();
  for (const d of details) {
    const byCode = d.service_code ? SHOGAI_TYPE_BY_CODE[d.service_code.slice(0, 2)] : undefined;
    if (byCode) { out.add(byCode); continue; }
    const n = norm(d.service_type) + norm(d.service_category);
    if (/重訪|重度訪問/.test(n)) out.add("重度訪問介護");
    else if (/同援|同行/.test(n)) out.add("同行援護");
    else if (/行動/.test(n)) out.add("行動援護");
    else if (/身体|家事|通院|乗降|居宅介護/.test(n)) out.add("居宅介護");
  }
  return [...out];
}

export const SHOGAI_FACTORS: FactorSet<ShogaiSeikyuRow> = {
  key: "shogai",
  system: "障害福祉 (居宅介護等 介護給付費 J121/J611)",
  source: "aggregateMonthlyShogaiSeikyu(...).rows — 訪問介護 事業所 × 対象月",
  note:
    "所要時間 (0.5/1.0/1.5…) はサービス名に出るが、1 行に複数の時間帯・段が同居するため " +
    "★ 因子にしていない (重訪の段は juho-tier.ts の別ハーネス scripts/tj-juho-analyze.mjs で見る)。",
  factors: [
    {
      name: "サービス種別",
      why: "サービス種類コード (11/12/13/14) ごとに 総費用額を floor する。処遇改善も種類ごと",
      values: ["居宅介護", "重度訪問介護", "行動援護", "同行援護"],
      measure: (r) => shogaiTypesOf(r.details),
    },
    {
      name: "サービス内容",
      why: "居宅介護のコードが変わる (身体介護 / 家事援助 / 通院介助 / 通院乗降介助)",
      values: ["身体介護", "家事援助", "通院介助", "乗降介助"],
      measure: (r) => {
        const out = new Set<string>();
        for (const d of r.details) {
          const n = norm(d.service_type) + norm(d.service_category);
          if (/乗降/.test(n)) out.add("乗降介助");
          else if (/通院/.test(n)) out.add("通院介助");
          if (/身体/.test(n)) out.add("身体介護");
          if (/家事|生活/.test(n)) out.add("家事援助");
        }
        return [...out];
      },
    },
    {
      name: "時間帯",
      why: "早朝/夜間 25%・深夜 50% でコードが別 (code-from-time.ts も同じ区切り)",
      values: ["日中", "早朝", "夜間", "深夜"],
      measure: (r) => zonesOf(namesOf(r.details)),
    },
    {
      name: "2人派遣",
      why: "・2人 コード (121272/121282 等)。単位が概ね2倍",
      values: ["1人", "2人"],
      measure: (r) => twoPersonOf(namesOf(r.details)),
    },
    {
      name: "障害支援区分",
      why:
        "★ 同行援護は区分でコードが変わる (同援日0.5 191単位 → ・区3 229単位 = +20%)。" +
        "aggregate.ts の doukouKubunByClient が support_level を読む",
      values: ["非該当", "区分1", "区分2", "区分3", "区分4", "区分5", "区分6"],
      measure: (r) => {
        const v = norm(r.support_level).replace(/\s/g, "");
        return SHOGAI_FACTORS.factors[4].values.includes(v) ? v : null;
      },
    },
    {
      name: "負担上限月額",
      why: "userAmount = min(1割相当, 上限)。上限の段で利用者負担が変わる",
      values: ["未設定", "0円", "4,600円", "9,300円", "37,200円"],
      measure: (r) => {
        if (r.self_payment_limit === null) return "未設定";
        const m: Record<number, string> = { 0: "0円", 4600: "4,600円", 9300: "9,300円", 37200: "37,200円" };
        return m[r.self_payment_limit] ?? null;
      },
    },
    {
      name: "生保",
      why: "seiho_flag が立つと負担上限を 0 円に正規化する (aggregate.ts)",
      values: ["なし", "あり"],
      measure: (r) => (r.seiho ? "あり" : "なし"),
    },
    {
      name: "上限管理区分",
      why: "他事業所なら当方は上限を掛けず管理結果に従う。未入力だと ★ 過大請求になる",
      values: ["なし", "自事業所", "他事業所"],
      measure: (r) => {
        const v = norm(r.jogenKanriKubun).trim() || "なし";
        return SHOGAI_FACTORS.factors[7].values.includes(v) ? v : null;
      },
    },
    {
      name: "管理結果区分",
      why: "区分1/3 は kanri_result_amount で利用者負担を置き換える。2 はそのまま",
      values: ["未入力", "1", "2", "3"],
      measure: (r) => (r.kanriResult === null ? "未入力" : String(r.kanriResult)),
    },
    {
      name: "処遇改善加算",
      why: "サービス種類ごとに 月1回 round(所定単位 × 率) で立つ",
      values: ["なし", "あり"],
      measure: (r) => (r.addons.length > 0 ? "あり" : "なし"),
    },
    {
      name: "支給量超過",
      why:
        "受給者証の支給決定量を超えた種別を警告する (金額には効かない・目視用)。" +
        "shikyuryo_details 列が未適用の環境では常に空になる経路がある",
      values: ["なし", "あり"],
      measure: (r) => (r.shikyuryoOver.length > 0 ? "あり" : "なし"),
    },
  ],
  probes: [
    {
      label: "重訪+同行の同居・深夜・2人・区分6・他事業所管理3",
      row: mkShogaiRow({
        support_level: "区分６",
        self_payment_limit: 37200,
        seiho: false,
        jogenKanriKubun: "他事業所",
        kanriResult: 3,
        addons: [{ service_code: "121121", service_name: "重度訪問介護処遇改善加算Ⅰ", units: 10 }],
        shikyuryoOver: ["重度訪問介護"],
        details: [
          mkShogaiDetail({ service_type: "重訪Ⅱ深夜８．０・２人", service_code: "121281" }),
          mkShogaiDetail({ service_type: "同援日０．５・区４", service_code: "151011" }),
        ],
      }),
      expect: {
        // ★ 重訪の「深夜」を 夜間 にも数えないこと (2026-09-04 に probe が私の期待値の誤りを捕まえた)
        サービス種別: ["重度訪問介護", "同行援護"], 時間帯: ["深夜", "日中"],
        "2人派遣": ["2人"], 障害支援区分: ["区分6"], 負担上限月額: ["37,200円"],
        生保: ["なし"], 上限管理区分: ["他事業所"], 管理結果区分: ["3"],
        処遇改善加算: ["あり"], 支給量超過: ["あり"],
      },
    },
    {
      label: "居宅介護 身体+家事+通院・早朝・生保・上限0円",
      row: mkShogaiRow({
        support_level: "非該当",
        self_payment_limit: 0,
        seiho: true,
        jogenKanriKubun: "自事業所",
        kanriResult: 1,
        details: [
          mkShogaiDetail({ service_type: "身体早０．５", service_code: "111211" }),
          mkShogaiDetail({ service_type: "家事日１．０", service_code: "112111" }),
          mkShogaiDetail({ service_type: "通院２身体１．０", service_code: "113111" }),
        ],
      }),
      expect: {
        サービス種別: ["居宅介護"], サービス内容: ["身体介護", "家事援助", "通院介助"],
        時間帯: ["早朝", "日中"], "2人派遣": ["1人"], 障害支援区分: ["非該当"],
        負担上限月額: ["0円"], 生保: ["あり"], 上限管理区分: ["自事業所"], 管理結果区分: ["1"],
        処遇改善加算: ["なし"], 支給量超過: ["なし"],
      },
    },
  ],
};

/* ══ 居宅介護支援 — 居宅介護支援費 (明細書 8124) ═════════════════════════ */

/** kaigo_care_support_claims の 1 行 (因子が読む列だけ) */
export interface KyotakuClaimRow {
  billing_month: string | null;
  care_support_code: string | null;
  care_support_name: string | null;
  tokutei_kassan_type: string | null;
  unit_price: number | null;
  initial_addition: boolean | null;
  hospital_coordination: boolean | null;
  discharge_addition: boolean | null;
  discharge_type: string | null;
  medical_coordination: boolean | null;
  medical_coop_kassan: boolean | null;
  terminal_care: boolean | null;
  emergency_conference: boolean | null;
  unei_kijun_gensan: boolean | null;
  bcp_not_prepared: boolean | null;
  abuse_prevention_not_implemented: boolean | null;
  shoguu_kaizen_code: string | null;
  notes: string | null;
}

const yesNo = (v: boolean | null | undefined): string => (v === true ? "あり" : "なし");

/** discharge_type 列値 → 表示ラベル。★ 実装 (ADDON_CODE_TO_DISCHARGE_TYPE) の逆 */
const DISCHARGE_LABEL: Record<string, string> = {
  i_i: "Ⅰイ", i_ro: "Ⅰロ", ii_i: "Ⅱイ", ii_ro: "Ⅱロ", iii: "Ⅲ",
};

function mkKyotakuRow(p: Partial<KyotakuClaimRow>): KyotakuClaimRow {
  return {
    billing_month: "2026-06", care_support_code: "432111",
    care_support_name: "居宅介護支援Ⅰⅰ１", tokutei_kassan_type: null, unit_price: 10.7,
    initial_addition: false, hospital_coordination: false, discharge_addition: false,
    discharge_type: "", medical_coordination: false, medical_coop_kassan: false,
    terminal_care: false, emergency_conference: false, unei_kijun_gensan: false,
    bcp_not_prepared: false, abuse_prevention_not_implemented: false,
    shoguu_kaizen_code: null, notes: null,
    ...p,
  };
}

export const KYOTAKU_FACTORS: FactorSet<KyotakuClaimRow> = {
  key: "kyotaku",
  system: "居宅介護支援 (居宅介護支援費 8124)",
  source: "kaigo_care_support_claims (table を直接読む) — billing_month が対象月",
  note:
    "レセプトは伝送 KK/8124 から取り込んだ写し。★ 単位数の算定ロジック (層3) は " +
    "検証スコープ外なので、ここで測るのは「どの組合せが実データに出るか」だけ。",
  factors: [
    {
      name: "制度",
      why: "基本コードの系統。43=居宅介護支援 / 46=介護予防支援。混在は返戻要因 (yoboAddonCode)",
      values: ["居宅介護支援(43)", "介護予防支援(46)"],
      measure: (r) => {
        const c = norm(r.care_support_code).slice(0, 2);
        // ★ 基本コードが無い行は正常 (ターミナルのみの請求)。null = 未判定
        if (c === "43") return "居宅介護支援(43)";
        if (c === "46") return "介護予防支援(46)";
        return null;
      },
    },
    {
      name: "逓減体制",
      why: "Ⅰ=通常 / Ⅱ=緩和 (ICT等)。段の閾値が 45件 → 50件 に変わる (teigenTierForIndex)",
      values: ["Ⅰ", "Ⅱ"],
      measure: (r) => parseTeigenFromName(r.care_support_name)?.taisei ?? null,
    },
    {
      name: "逓減段",
      why: "取扱件数で基本単位が 1086 → 544 → 326 と落ちる (KYOTAKU_TEIGEN_FALLBACK)",
      values: ["ⅰ", "ⅱ", "ⅲ"],
      measure: (r) => parseTeigenFromName(r.care_support_name)?.tier ?? null,
    },
    {
      name: "要介護度区分",
      why: "基本コード末尾 1=要介護1・2 (1086単位) / 2=要介護3〜5 (1411単位)",
      values: ["要介護1・2", "要介護3〜5"],
      measure: (r) => {
        // ⚠ ローマ数字を壊すので NFKC は掛けない。末尾の数字だけ全角/半角を許す
        const m = /^居宅介護支援[ⅠⅡ][ⅰⅱⅲ]([１２12])/.exec(String(r.care_support_name ?? ""));
        if (!m) return null;
        return m[1] === "1" || m[1] === "１" ? "要介護1・2" : "要介護3〜5";
      },
    },
    {
      name: "特定事業所加算",
      why: "TOKUTEI_KASSAN_FALLBACK で単位が変わる (Ⅰ/Ⅱ/Ⅲ/A)",
      values: ["なし", "Ⅰ", "Ⅱ", "Ⅲ", "A"],
      measure: (r) => {
        const v = trimWide(r.tokutei_kassan_type);
        if (!v || v === "none") return "なし";
        return KYOTAKU_FACTORS.factors[4].values.includes(v) ? v : null;
      },
    },
    { name: "初回加算", why: "300単位。K3 フラグ⇔単位数 の対で持つ", values: ["なし", "あり"], measure: (r) => yesNo(r.initial_addition) },
    { name: "入院時情報連携", why: "Ⅰ=250 / Ⅱ=200 単位 (HOSPITAL_COORD_UNITS)", values: ["なし", "あり"], measure: (r) => yesNo(r.hospital_coordination) },
    {
      name: "退院・退所加算",
      why: "Ⅰイ450 / Ⅰロ600 / Ⅱイ600 / Ⅱロ750 / Ⅲ900 単位 (DISCHARGE_UNITS)",
      values: ["なし", "Ⅰイ", "Ⅰロ", "Ⅱイ", "Ⅱロ", "Ⅲ"],
      measure: (r) => {
        const t = norm(r.discharge_type).trim();
        if (!t || t === "none") return r.discharge_addition ? null : "なし";
        return DISCHARGE_LABEL[t] ?? null;
      },
    },
    { name: "通院時情報連携", why: "医療連携加算 50単位", values: ["なし", "あり"], measure: (r) => yesNo(r.medical_coordination) },
    { name: "特定事業所医療介護連携", why: "125単位", values: ["なし", "あり"], measure: (r) => yesNo(r.medical_coop_kassan) },
    { name: "ターミナル", why: "400単位。★ 基本コードなしで これだけ請求する行が実在する", values: ["なし", "あり"], measure: (r) => yesNo(r.terminal_care) },
    { name: "緊急時カンファ", why: "緊急時等居宅カンファレンス加算 200単位", values: ["なし", "あり"], measure: (r) => yesNo(r.emergency_conference) },
    { name: "運営基準減算", why: "基本単位から減算する (reductionUnitsOf)", values: ["なし", "あり"], measure: (r) => yesNo(r.unei_kijun_gensan) },
    { name: "BCP未策定減算", why: "bcp_reduction_pct で率減算", values: ["なし", "あり"], measure: (r) => yesNo(r.bcp_not_prepared) },
    { name: "虐待防止未実施減算", why: "abuse_reduction_pct で率減算", values: ["なし", "あり"], measure: (r) => yesNo(r.abuse_prevention_not_implemented) },
    {
      name: "処遇改善加算",
      why: "436191 等。★ 船橋は未算定で 0 のまま (既知の意図的差異)",
      values: ["なし", "あり"],
      measure: (r) => (norm(r.shoguu_kaizen_code).trim() ? "あり" : "なし"),
    },
    {
      name: "予防支援区分",
      why: "notes のマーカーで Ⅰ/Ⅱ/委託 を持つ。委託は請求対象外 (parseYoboShienKubun)",
      values: ["未設定", "Ⅰ", "Ⅱ", "委託"],
      measure: (r) => {
        const k = parseYoboShienKubun(r.notes);
        return k === null ? "未設定" : k === "I" ? "Ⅰ" : k === "II" ? "Ⅱ" : "委託";
      },
    },
    {
      name: "地域区分",
      why: "AREA_UNIT_PRICE_TABLE の単価で総額が変わる",
      values: AREA_LIST,
      measure: (r) => areaOf(r.unit_price),
    },
  ],
  probes: [
    {
      label: "予防46・ⅲ段・体制Ⅱ・特定A・退院Ⅱロ・全加算あり",
      row: mkKyotakuRow({
        care_support_code: "465611",
        care_support_name: "居宅介護支援Ⅱⅲ２",
        tokutei_kassan_type: "A",
        unit_price: 11.4,
        initial_addition: true, hospital_coordination: true, discharge_addition: true,
        discharge_type: "ii_ro", medical_coordination: true, medical_coop_kassan: true,
        terminal_care: true, emergency_conference: true, unei_kijun_gensan: true,
        bcp_not_prepared: true, abuse_prevention_not_implemented: true,
        shoguu_kaizen_code: "466191", notes: "取込\n[予防支援:委託]",
      }),
      expect: {
        制度: ["介護予防支援(46)"], 逓減体制: ["Ⅱ"], 逓減段: ["ⅲ"], 要介護度区分: ["要介護3〜5"],
        特定事業所加算: ["A"], 初回加算: ["あり"], 入院時情報連携: ["あり"], "退院・退所加算": ["Ⅱロ"],
        通院時情報連携: ["あり"], 特定事業所医療介護連携: ["あり"], ターミナル: ["あり"],
        緊急時カンファ: ["あり"], 運営基準減算: ["あり"], BCP未策定減算: ["あり"],
        虐待防止未実施減算: ["あり"], 処遇改善加算: ["あり"], 予防支援区分: ["委託"], 地域区分: ["1級地"],
      },
    },
    {
      label: "★ 基本コードなし (ターミナルのみ) は 制度・逓減を 未判定にする",
      row: mkKyotakuRow({
        care_support_code: null, care_support_name: null, terminal_care: true, unit_price: 10,
      }),
      expect: { 制度: [], 逓減体制: [], 逓減段: [], 要介護度区分: [], ターミナル: ["あり"], 地域区分: ["その他"], 予防支援区分: ["未設定"] },
    },
  ],
};

/* ── 登録 ────────────────────────────────────────────────────────────── */

export const FACTOR_SPEC_SETS: FactorSpecSet[] = [
  toSpec(KAIGO_FACTORS),
  toSpec(SOUGOU_FACTORS),
  toSpec(SHOGAI_FACTORS),
  toSpec(KYOTAKU_FACTORS),
];
