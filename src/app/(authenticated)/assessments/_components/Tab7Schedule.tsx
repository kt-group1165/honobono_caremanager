"use client";

import type { DailySchedule, ScheduleEntry } from "../_types";
import { Section } from "../_shared";

interface Props {
  data: DailySchedule;
  onChange: (data: DailySchedule) => void;
}

// 生成: 24時間 × 2（30分刻み）= 48スロット
function ensureEntries(entries: ScheduleEntry[]): ScheduleEntry[] {
  const result: ScheduleEntry[] = [];
  for (let h = 0; h < 24; h++) {
    for (let half = 0 as 0 | 1; half <= 1; half++) {
      const existing = entries.find((e) => e.hour === h && e.half === half);
      if (existing) result.push(existing);
      else result.push({ hour: h, half: half as 0 | 1, life_rhythm: "", user_activities: "", family_support: "", service_support: "", needs_support: "" });
    }
  }
  return result;
}

function timeLabel(hour: number, half: 0 | 1): string {
  if (half === 0) return `${String(hour).padStart(2, "0")}:00`;
  return `${String(hour).padStart(2, "0")}:30`;
}

function periodLabel(hour: number): string {
  if (hour >= 0 && hour < 6) return "深夜";
  if (hour >= 6 && hour < 8) return "早朝";
  if (hour >= 8 && hour < 12) return "午前";
  if (hour >= 12 && hour < 18) return "午後";
  return "夜間";
}

export function Tab7Schedule({ data, onChange }: Props) {
  const entries = ensureEntries(data.entries);

  const updEntry = (idx: number, patch: Partial<ScheduleEntry>) => {
    const next = [...entries];
    next[idx] = { ...next[idx], ...patch };
    onChange({ entries: next });
  };

  return (
    <div>
      <Section title="1日のスケジュール" subtitle="◎排便 / ○排尿 / △食事 / ☆入浴 / □起床 / ■就寝">
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse border">
            <thead className="bg-gray-50">
              <tr>
                <th className="border px-1 py-0.5 w-10">時間帯</th>
                <th className="border px-1 py-0.5 w-12">時刻</th>
                <th className="border px-1 py-0.5">本人の生活リズム</th>
                <th className="border px-1 py-0.5">本人がしていること/したいこと</th>
                <th className="border px-1 py-0.5">家族実施</th>
                <th className="border px-1 py-0.5">サービス実施</th>
                <th className="border px-1 py-0.5">要援助→計画</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const showPeriod = e.half === 0 && (i === 0 || periodLabel(e.hour) !== periodLabel(entries[i - 2]?.hour ?? -1));
                return (
                  <tr key={`${e.hour}-${e.half}`} className={e.half === 0 && e.hour % 2 === 0 ? "bg-gray-50/30" : ""}>
                    {showPeriod && <td className="border px-1 py-0.5 text-center text-[10px] font-semibold" rowSpan={2}>{periodLabel(e.hour)}</td>}
                    {!showPeriod && e.half === 0 && <td className="border" rowSpan={2}></td>}
                    <td className="border px-1 py-0.5 text-center text-[10px]">{timeLabel(e.hour, e.half)}</td>
                    <td className="border p-0"><input type="text" value={e.life_rhythm} onChange={(ev) => updEntry(i, { life_rhythm: ev.target.value })} className="w-full px-1 py-0.5 text-xs border-0 focus:outline-none focus:bg-blue-50" /></td>
                    <td className="border p-0"><input type="text" value={e.user_activities} onChange={(ev) => updEntry(i, { user_activities: ev.target.value })} className="w-full px-1 py-0.5 text-xs border-0 focus:outline-none focus:bg-blue-50" /></td>
                    <td className="border p-0"><input type="text" value={e.family_support} onChange={(ev) => updEntry(i, { family_support: ev.target.value })} className="w-full px-1 py-0.5 text-xs border-0 focus:outline-none focus:bg-blue-50" /></td>
                    <td className="border p-0"><input type="text" value={e.service_support} onChange={(ev) => updEntry(i, { service_support: ev.target.value })} className="w-full px-1 py-0.5 text-xs border-0 focus:outline-none focus:bg-blue-50" /></td>
                    <td className="border p-0"><input type="text" value={e.needs_support} onChange={(ev) => updEntry(i, { needs_support: ev.target.value })} className="w-full px-1 py-0.5 text-xs border-0 focus:outline-none focus:bg-blue-50" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
