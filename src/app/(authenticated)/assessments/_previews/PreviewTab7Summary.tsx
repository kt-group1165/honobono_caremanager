"use client";

import type { SummarySection } from "../_types";
import { PVFrame, PVTitle, PVCheckLabel, cellBase, cellLabel } from "../_preview";

interface Props { data: SummarySection; userName: string; date: string; }

export function PreviewTab7Summary({ data, userName, date }: Props) {
  const c = data;
  return (
    <PVFrame userName={userName} date={date}>
      <PVTitle number="7">全体のまとめ</PVTitle>

      <div className="border border-black p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "120mm" }}>
        {c.notes}
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "3mm", fontSize: "8pt" }}>
        <tbody>
          <tr>
            <td style={{ ...cellLabel, width: "50mm" }}>災害時の対応の必要性について<br />⇒有の場合</td>
            <td style={cellBase}>
              <span className="bg-blue-100 px-1">必要性の有無</span>
              <PVCheckLabel on={c.disaster_response?.needed === "有"} label="有" />
              <PVCheckLabel on={c.disaster_response?.needed === "無"} label="無" />
              <span className="bg-blue-100 px-1 ml-2">個別避難計画策定の有無</span>
              <PVCheckLabel on={c.disaster_response?.individual_plan === "有"} label="有" />
              <PVCheckLabel on={c.disaster_response?.individual_plan === "策定中"} label="策定中" />
              <PVCheckLabel on={c.disaster_response?.individual_plan === "無"} label="無" />
            </td>
          </tr>
          <tr>
            <td style={cellLabel}>災害時の連絡先<br />（家族以外/民生委員等）</td>
            <td style={cellBase}>
              <div>（氏名）{c.disaster_response?.contact?.name}　（本人との関係）{c.disaster_response?.contact?.relationship}</div>
              <div>TEL. {c.disaster_response?.contact?.tel}　FAX. {c.disaster_response?.contact?.fax}</div>
              <div>メール {c.disaster_response?.contact?.email}</div>
            </td>
          </tr>
          <tr>
            <td style={cellLabel}>備考</td>
            <td style={{ ...cellBase, whiteSpace: "pre-wrap", minHeight: "15mm" }}>{c.disaster_response?.notes}</td>
          </tr>
          <tr>
            <td style={cellLabel}>権利擁護に関する対応の必要性について<br />⇒有の場合</td>
            <td style={cellBase}>
              <span className="bg-blue-100 px-1">必要性の有無</span>
              <PVCheckLabel on={c.rights_protection?.needed === "有"} label="有" />
              <PVCheckLabel on={c.rights_protection?.needed === "無"} label="無" />
            </td>
          </tr>
          <tr>
            <td style={cellLabel}>備考</td>
            <td style={{ ...cellBase, whiteSpace: "pre-wrap", minHeight: "15mm" }}>{c.rights_protection?.notes}</td>
          </tr>
        </tbody>
      </table>
    </PVFrame>
  );
}
