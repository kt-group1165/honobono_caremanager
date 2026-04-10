"use client";

import type { DailySchedule, ScheduleEntry } from "../_types";
import { PVFrame, cellBase, cellHead } from "../_preview";

interface Props { data: DailySchedule; userName: string; date: string; }

function buildFull(entries: ScheduleEntry[]): ScheduleEntry[] {
  const result: ScheduleEntry[] = [];
  for (let h = 0; h <= 24; h++) {
    const existing = entries.find((e) => e.hour === h && e.half === 0);
    result.push(existing ?? { hour: h, half: 0, life_rhythm: "", user_activities: "", family_support: "", service_support: "", needs_support: "" });
  }
  return result;
}

function periodLabel(hour: number): string | null {
  if (hour === 0) return "深夜";
  if (hour === 6) return "早朝";
  if (hour === 8) return "午前";
  if (hour === 12) return "午後";
  if (hour === 18) return "夜間";
  if (hour === 22) return "深夜";
  return null;
}

export function PreviewTab7Schedule({ data, userName, date }: Props) {
  const entries = buildFull(data.entries ?? []);
  return (
    <PVFrame userName={userName} date={date}>
      <div className="text-sm font-bold mb-1">■1日のスケジュール</div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7pt" }}>
        <thead>
          <tr>
            <th style={{ ...cellHead, width: "10mm" }} colSpan={2}>時間</th>
            <th style={cellHead}>本人の生活リズム</th>
            <th style={cellHead}>①本人が自分でしていること<br />②したいと思っていること<br />（興味、関心）</th>
            <th style={cellHead} colSpan={2}>援助の現状</th>
            <th style={cellHead}>要援助と判断される場合に／計画</th>
          </tr>
          <tr>
            <th style={cellHead} colSpan={2}></th>
            <th style={cellHead}></th>
            <th style={cellHead}></th>
            <th style={cellHead}>家族実施</th>
            <th style={cellHead}>サービス実施</th>
            <th style={cellHead}></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => {
            const period = periodLabel(e.hour);
            return (
              <tr key={i} style={{ height: "6mm" }}>
                {period && <td style={{ ...cellBase, width: "6mm", textAlign: "center", writingMode: "vertical-rl" }} rowSpan={e.hour === 22 ? 3 : e.hour === 18 ? 4 : e.hour === 12 ? 6 : e.hour === 8 ? 4 : e.hour === 6 ? 2 : 6}>{period}</td>}
                <td style={{ ...cellBase, width: "8mm", textAlign: "center" }}>{e.hour}</td>
                <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{e.life_rhythm}</td>
                <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{e.user_activities}</td>
                <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{e.family_support}</td>
                <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{e.service_support}</td>
                <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{e.needs_support}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-xs mt-1">◎：排便　△：食事　□：起床　○：排尿　☆：入浴　■：就寝</div>
    </PVFrame>
  );
}
