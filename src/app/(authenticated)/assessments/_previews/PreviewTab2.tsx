"use client";

import type { FamilySupport } from "../_types";
import { PVFrame, PVTitle, PVBar, PVCircle, cellBase, cellHead, cellLabel } from "../_preview";
import { Genogram } from "../_components/Genogram";

interface Props { data: FamilySupport; userName: string; userGender?: string | null; date: string; }

export function PreviewTab2({ data, userName, userGender, date }: Props) {
  const members = [...(data.family_members ?? [])];
  while (members.length < 5) members.push({ name: "", is_primary_caregiver: false, relationship: "", living: "", employment: "", health_status: "", notes: "" });

  return (
    <PVFrame userName={userName} date={date}>
      <PVTitle number="2">家族状況とインフォーマルな支援の状況</PVTitle>
      <PVBar>■家族構成と介護状況</PVBar>

      <div className="grid grid-cols-2 gap-0">
        <div className="border border-black">
          <div style={cellHead as React.CSSProperties}>家族構成図</div>
          <div className="p-1" style={{ minHeight: "40mm" }}>
            <Genogram
              userName={userName}
              userGender={userGender ?? null}
              members={data.family_members ?? []}
            />
            {data.family_composition_diagram && (
              <div className="mt-1 text-[10px] whitespace-pre-wrap text-gray-700">
                {data.family_composition_diagram}
              </div>
            )}
          </div>
        </div>
        <div className="border border-black border-l-0">
          <div style={cellHead as React.CSSProperties}>家族の介護の状況・課題</div>
          <div className="p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "40mm" }}>{data.family_care_situation}</div>
        </div>
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "2mm" }}>
        <thead>
          <tr>
            <th style={cellHead}>氏名(主たる介護者には※)</th>
            <th style={cellHead}>続柄</th>
            <th style={cellHead}>同別居</th>
            <th style={cellHead}>就労の状況</th>
            <th style={cellHead}>健康状態等</th>
            <th style={cellHead}>特記事項(自治会、ボランティア等社会的活動)</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m, i) => (
            <tr key={i} style={{ height: "10mm" }}>
              <td style={cellBase}>{m.is_primary_caregiver && "※ "}{m.name}</td>
              <td style={cellBase}>{m.relationship}</td>
              <td style={{ ...cellBase, textAlign: "center" }}>
                <PVCircle on={m.living === "同"}>同</PVCircle>・<PVCircle on={m.living === "別"}>別</PVCircle>
              </td>
              <td style={{ ...cellBase, textAlign: "center" }}>
                <PVCircle on={m.employment === "有"}>有</PVCircle>・<PVCircle on={m.employment === "無"}>無</PVCircle>
              </td>
              <td style={cellBase}>{m.health_status}</td>
              <td style={cellBase}>{m.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <PVBar>■インフォーマルな支援活用状況<span className="font-normal">（親戚、近隣、友人、同僚、ボランティア、民生委員、自治会等の地域の団体等）</span></PVBar>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ ...cellHead, width: "25%" }}>支援提供者</th>
            <th style={cellHead}>活用している支援内容</th>
            <th style={{ ...cellHead, width: "25%" }}>特記事項</th>
          </tr>
        </thead>
        <tbody>
          {(data.informal_support?.length ? data.informal_support : [{ provider: "", content: "", notes: "" }]).map((s, i) => (
            <tr key={i} style={{ height: "12mm" }}>
              <td style={cellBase}>{s.provider}</td>
              <td style={cellBase}>{s.content}</td>
              <td style={cellBase}>{s.notes}</td>
            </tr>
          ))}
        </tbody>
        <thead>
          <tr>
            <th style={cellHead} colSpan={2}>本人が受けたい支援/今後必要になると思われる支援</th>
            <th style={cellHead}>支援提供者</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: "12mm" }}>
            <td style={cellBase} colSpan={2}>{data.needed_support?.content}</td>
            <td style={cellBase}>{data.needed_support?.provider}</td>
          </tr>
        </tbody>
      </table>
    </PVFrame>
  );
}
