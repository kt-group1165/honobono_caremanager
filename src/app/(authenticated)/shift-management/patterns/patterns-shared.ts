/**
 * shift-management/patterns の Server Component / Client Component 共通モジュール
 *
 * Server Component (page.tsx) が client component (patterns-content.tsx) の named export を
 * import すると、Next 16 の RSC bundling で server bundle に含まれず undefined になる罠。
 * (memory: feedback_use_client_const_export.md)
 *
 * → 純粋 helper + type は "use client" 無しの独立モジュールに切り出す。
 */

// 共通マスタ members の subset
export interface KaigoStaff {
  id: string;
  name: string;
  furigana: string | null;
}

export interface PatternDay {
  id?: string;
  tempId: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  service_type: string;
  staff_id: string | null;
  /**
   * 制度区分 (介護 / 障害 / 総合事業)。展開して作る予定に引き継ぐ。
   * ⚠ サービス名では決まらないものがある (「身体介護１」等は介護と障害の両方に
   *   存在し、実データで全シフトの 33%)。未設定のまま展開すると、その予定は
   *   制度別の集計・実績記録票から漏れる。
   */
  system?: string | null;
}

export interface VisitPattern {
  id: string;
  tempId: string;
  pattern_name: string;
  days: PatternDay[];
}

export interface VisitPatternRow {
  id: string;
  user_id: string;
  pattern_name: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  service_type: string;
  staff_id: string | null;
  system?: string | null;
}

function genId(): string {
  return Math.random().toString(36).slice(2);
}

export function rowsToPatterns(rows: VisitPatternRow[]): VisitPattern[] {
  const grouped = new Map<string, VisitPattern>();
  for (const row of rows) {
    const key = row.pattern_name;
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: key,
        tempId: genId(),
        pattern_name: key,
        days: [],
      });
    }
    grouped.get(key)!.days.push({
      id: row.id,
      tempId: genId(),
      day_of_week: row.day_of_week,
      start_time: row.start_time,
      end_time: row.end_time,
      service_type: row.service_type,
      staff_id: row.staff_id,
      system: row.system ?? null,
    });
  }
  return [...grouped.values()];
}
