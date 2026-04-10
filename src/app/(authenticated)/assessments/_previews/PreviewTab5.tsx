"use client";

import type { Health, MedicalVisit } from "../_types";
import { PVFrame, PVTitle, PVCheck, PVCheckLabel, cellBase, cellHead, cellLabel } from "../_preview";

interface Props { data: Health; userName: string; date: string; }

export function PreviewTab5({ data, userName, date }: Props) {
  const visits: MedicalVisit[] = [...(data.medical_visits ?? [])];
  while (visits.length < 4) visits.push({ disease_name: "", has_medication: "", onset_date: "", frequency_type: "", frequency_unit: "", frequency_count: "", visit_type: "", facility: "", department: "", doctor: "", tel: "", notes: "" });

  return (
    <PVFrame userName={userName} date={date}>
      <PVTitle number="5">本人の健康状態・受診等の状況</PVTitle>

      <div className="grid grid-cols-[1fr_60mm] gap-2">
        <div>
          <div className="bg-blue-100 text-xs px-1">既往歴・現症（必要に応じ「主治医意見書」を転記）</div>
          <div className="border border-black p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "55mm" }}>
            ※要介護状態に関係がある既往歴および現症
            {"\n"}{data.medical_history}
          </div>
        </div>
        <div>
          <div className="bg-blue-100 text-xs px-1">障害等の部位</div>
          <div className="border border-black p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "55mm" }}>
            △障害部位 ×欠損部位 ●褥瘡部位
            {"\n"}{data.disability_location_notes}
          </div>
        </div>
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "2mm" }}>
        <tbody>
          <tr>
            <td style={cellLabel}>身長</td>
            <td style={cellBase}>{data.height} cm</td>
            <td style={cellLabel}>体重</td>
            <td style={cellBase}>{data.weight} kg</td>
          </tr>
          <tr>
            <td style={cellLabel}>歯の状況</td>
            <td style={cellBase} colSpan={3}>
              {["歯あり", "歯なし", "総入れ歯", "局部義歯"].map((t) => <PVCheckLabel key={t} on={data.teeth.status.includes(t)} label={t} />)}
              　⇒ 6-②生活機能（食事・排泄等）
            </td>
          </tr>
        </tbody>
      </table>

      <div className="bg-blue-100 text-xs px-1 mt-1">【特記事項】（病気やけが、障害等に関わる事項。改善の可能性等）</div>
      <div className="border border-black p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "25mm" }}>{data.special_notes}</div>

      <div className="bg-blue-100 text-xs px-1 mt-1">現在の受診状況（歯科含む）</div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7pt" }}>
        <thead>
          <tr>
            <th style={{ ...cellHead, width: "18mm" }}></th>
            {visits.map((_, i) => <th key={i} style={cellHead}>受診{i + 1}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr><td style={cellLabel}>病名</td>{visits.map((v, i) => <td key={i} style={cellBase}>{v.disease_name}</td>)}</tr>
          <tr><td style={cellLabel}>薬の有無</td>{visits.map((v, i) => <td key={i} style={cellBase}>
            <PVCheckLabel on={v.has_medication === "有"} label="有" /><PVCheckLabel on={v.has_medication === "無"} label="無" />
          </td>)}</tr>
          <tr><td style={cellLabel}>発症時期</td>{visits.map((v, i) => <td key={i} style={cellBase}>{v.onset_date}</td>)}</tr>
          <tr><td style={cellLabel}>受診頻度</td>{visits.map((v, i) => <td key={i} style={cellBase}>
            <PVCheckLabel on={v.frequency_type === "定期"} label={`定期（${v.frequency_unit || "週・月"} ${v.frequency_count || ""}回）`} />
            <PVCheckLabel on={v.frequency_type === "不定期"} label="不定期" />
          </td>)}</tr>
          <tr><td style={cellLabel}>受診状況</td>{visits.map((v, i) => <td key={i} style={cellBase}>
            <PVCheckLabel on={v.visit_type === "通院"} label="通院" /><PVCheckLabel on={v.visit_type === "往診"} label="往診" />
          </td>)}</tr>
          <tr><td style={cellLabel}>医療機関</td>{visits.map((v, i) => <td key={i} style={cellBase}>{v.facility}</td>)}</tr>
          <tr><td style={cellLabel}>診療科</td>{visits.map((v, i) => <td key={i} style={cellBase}>{v.department}</td>)}</tr>
          <tr><td style={cellLabel}>主治医</td>{visits.map((v, i) => <td key={i} style={cellBase}>{v.doctor}</td>)}</tr>
          <tr><td style={cellLabel}>連絡先</td>{visits.map((v, i) => <td key={i} style={cellBase}>{v.tel ? `TEL ${v.tel}` : "TEL"}</td>)}</tr>
          <tr><td style={cellLabel}>受診方法<br />留意点等</td>{visits.map((v, i) => <td key={i} style={cellBase}>{v.notes}</td>)}</tr>
        </tbody>
      </table>

      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "2mm" }}>
        <tbody>
          <tr>
            <td style={cellLabel}>往診可能な医療機関</td>
            <td style={cellBase}>
              <PVCheckLabel on={data.home_visit_available.has === "無"} label="無" />
              <PVCheckLabel on={data.home_visit_available.has === "有"} label="有" />
              （ {data.home_visit_available.facility} ）　TEL {data.home_visit_available.tel}
            </td>
          </tr>
          <tr>
            <td style={cellLabel}>緊急入院できる医療機関</td>
            <td style={cellBase}>
              <PVCheckLabel on={data.emergency_hospital.has === "無"} label="無" />
              <PVCheckLabel on={data.emergency_hospital.has === "有"} label="有" />
              （ {data.emergency_hospital.facility} ）　TEL {data.emergency_hospital.tel}
            </td>
          </tr>
          <tr>
            <td style={cellLabel}>相談、処方を受けている薬局<br />（かかりつけ薬局）</td>
            <td style={cellBase}>
              <PVCheckLabel on={data.pharmacy.has === "無"} label="無" />
              <PVCheckLabel on={data.pharmacy.has === "有"} label="有" />
              （ {data.pharmacy.name} ）　TEL {data.pharmacy.tel}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="bg-blue-100 text-xs px-1 mt-1">【特記、生活上配慮すべき課題など】</div>
      <div className="border border-black p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "20mm" }}>{data.life_considerations}</div>
    </PVFrame>
  );
}
