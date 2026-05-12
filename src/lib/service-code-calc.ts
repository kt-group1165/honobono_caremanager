// ===========================================================================
// kaigo_service_codes.formula を実単位値に変換するヘルパー
// ===========================================================================
// 使い方:
//   const units = calculateUnits(codeRecord, allCodesById, { minutes: 270 });
//   minutes 等のパラメータは利用実績に依存 (時間加算式の場合)
//
// formula 仕様: migration 054 参照
// ===========================================================================

export type ServiceCodeFormula =
  | {
      type: "time_increment";
      /** ベース行の service_code (cumulative の起点) */
      base_code?: string;
      /** ベース単位 (base_code を別途引かなくて済むようキャッシュ) */
      base_units?: number;
      /** 30分ごとの加算単位 (例: 82) */
      increment_unit: number;
      /** 加算刻み (分単位、通常 30) */
      increment_minutes: number;
      /** 加算が始まる最小利用分 (例: 240=4時間以上) */
      min_minutes: number;
    }
  | {
      type: "multiplier";
      /** 適用元 service_code */
      base_code: string;
      /** 乗数 (1.25 = 25%加算、0.99 = 1%減算、2.0 = 2人介助 等) */
      factor: number;
      rounding?: "round" | "floor" | "ceil" | "none";
    }
  | {
      type: "chain";
      steps: Array<
        | { base_code: string; factor?: number; rounding?: "round" | "floor" | "ceil" | "none" }
        | { factor: number; rounding?: "round" | "floor" | "ceil" | "none" }
      >;
    }
  | {
      // 処遇改善加算 等: 月の所定単位数の合計 × 加算率
      // 計算には params.monthly_total_units (集計済の月内所定単位合計) が必要
      type: "monthly_aggregate";
      /** 集計対象スコープ (省略可、UI 表示用) */
      service_category?: string;
      /** 加算率 numerator (例 245 = 24.5%) */
      numerator: number;
      /** 加算率 denominator (通常 1000) */
      denominator: number;
      /** 計算式の元 PDF 表記 (例 "所定単位×245/1000 加算") */
      label?: string;
      rounding?: "round" | "floor" | "ceil" | "none";
    };

export interface MinimalServiceCode {
  service_code: string;
  units: number;
  formula: ServiceCodeFormula | null;
}

export interface CalcParams {
  /** 実利用時間 (分)。time_increment 系で使用 */
  minutes?: number;
  /** 月の所定単位数の合計 (処遇改善加算等の monthly_aggregate で使用) */
  monthly_total_units?: number;
}

function applyRounding(value: number, mode: "round" | "floor" | "ceil" | "none" = "round"): number {
  if (mode === "floor") return Math.floor(value);
  if (mode === "ceil") return Math.ceil(value);
  if (mode === "none") return value;
  return Math.round(value);
}

/**
 * formula を解釈して実単位数を返す。formula が NULL なら record.units をそのまま返す。
 * 循環/深すぎる依存は depth ガードで防ぐ (最大 8 段)。
 */
export function calculateUnits(
  record: MinimalServiceCode | undefined,
  index: Record<string, MinimalServiceCode>,
  params: CalcParams = {},
  depth = 0,
): number | null {
  if (!record) return null;
  if (depth > 8) {
    console.warn("calculateUnits: formula chain too deep");
    return null;
  }
  if (!record.formula) {
    return record.units;
  }
  const f = record.formula;

  if (f.type === "time_increment") {
    // base_units 優先、なければ base_code から引く
    let base = f.base_units;
    if (base == null && f.base_code) {
      base = calculateUnits(index[f.base_code], index, params, depth + 1) ?? undefined;
    }
    if (base == null) return null;

    const minutes = params.minutes ?? f.min_minutes;
    // increment 回数: 利用分が min_minutes 以上の場合に発生
    if (minutes < f.min_minutes - f.increment_minutes) {
      return base; // 加算前
    }
    const over = Math.max(0, minutes - (f.min_minutes - f.increment_minutes));
    const increments = Math.ceil(over / f.increment_minutes);
    return base + increments * f.increment_unit;
  }

  if (f.type === "multiplier") {
    const baseValue = calculateUnits(index[f.base_code], index, params, depth + 1);
    if (baseValue == null) return null;
    return applyRounding(baseValue * f.factor, f.rounding);
  }

  if (f.type === "monthly_aggregate") {
    // 月の所定単位合計 × (numerator / denominator)
    // 集計値が未指定なら計算不可 (= null)、UI 上は「要月集計」表示
    const total = params.monthly_total_units;
    if (total == null) return null;
    return applyRounding((total * f.numerator) / f.denominator, f.rounding ?? "round");
  }

  if (f.type === "chain") {
    let current: number | null = null;
    for (const step of f.steps) {
      const s = step as { base_code?: string; factor?: number; rounding?: "round" | "floor" | "ceil" | "none" };
      if (s.base_code) {
        current = calculateUnits(index[s.base_code], index, params, depth + 1);
        if (current == null) return null;
        if (s.factor != null) {
          current = applyRounding(current * s.factor, s.rounding);
        }
      } else if (s.factor != null) {
        if (current == null) return null;
        current = applyRounding(current * s.factor, s.rounding);
      }
    }
    return current;
  }

  return record.units;
}

/**
 * 複数 service_code の集合を index (= service_code → record) に変換するユーティリティ
 */
export function indexByServiceCode<T extends MinimalServiceCode>(records: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const r of records) {
    out[r.service_code] = r;
  }
  return out;
}

/**
 * formula を読みやすい日本語に変換 (UI 表示用)
 */
export function formulaToDescription(formula: ServiceCodeFormula | null): string {
  if (!formula) return "";
  if (formula.type === "time_increment") {
    const minHr = (formula.min_minutes / 60).toFixed(1).replace(/\.0$/, "");
    const incMin = formula.increment_minutes;
    return `${minHr}時間以上、${incMin}分ごとに +${formula.increment_unit}単位 (base: ${formula.base_code ?? "—"})`;
  }
  if (formula.type === "multiplier") {
    const pct = Math.round((formula.factor - 1) * 100);
    const sign = pct >= 0 ? "+" : "";
    if (formula.factor === 2.0) return `${formula.base_code} × 2 (2人介助)`;
    return `${formula.base_code} × ${formula.factor} (${sign}${pct}%)`;
  }
  if (formula.type === "chain") {
    return `chain × ${formula.steps.length} 段`;
  }
  if (formula.type === "monthly_aggregate") {
    const pct = ((formula.numerator / formula.denominator) * 100).toFixed(1).replace(/\.0$/, "");
    return formula.label ?? `月所定単位合計 × ${formula.numerator}/${formula.denominator} (${pct}%)`;
  }
  return "";
}
