"use client";

import type { YoboFormData } from "./_types";
import { BASIC_CHECKLIST_QUESTIONS, YOBO_DOMAINS } from "./_types";
import { PVFrame, PVTitle, PVCheck, cellBase, cellHead, cellLabel } from "../_preview";

interface Props {
  data: YoboFormData;
  userName: string;
  date: string;
}

const box: React.CSSProperties = {
  border: "0.5pt solid #000",
  padding: "1mm 1.5mm",
  fontSize: "8.5pt",
  whiteSpace: "pre-wrap",
  minHeight: "10mm",
};

export function YoboPreview({ data, userName, date }: Props) {
  const riskCount = BASIC_CHECKLIST_QUESTIONS.reduce(
    (acc, q) => acc + (data.basic_checklist[String(q.no)] === q.riskAnswer ? 1 : 0),
    0
  );

  return (
    <PVFrame userName={userName} date={date}>
      <PVTitle>介護予防のためのアセスメント</PVTitle>

      {/* 基本情報 */}
      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "1mm" }}>
        <tbody>
          <tr>
            <td style={cellLabel}>相談・委託の経路等</td>
            <td style={{ ...cellBase, whiteSpace: "pre-wrap" }} colSpan={3}>{data.basic_info.referral_route}</td>
          </tr>
          <tr>
            <td style={cellLabel}>本人の希望・意向</td>
            <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{data.basic_info.user_intention}</td>
            <td style={cellLabel}>家族の希望・意向</td>
            <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{data.basic_info.family_intention}</td>
          </tr>
          <tr>
            <td style={cellLabel}>利用中サービス（保険）</td>
            <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{data.basic_info.current_services_insurance}</td>
            <td style={cellLabel}>利用中サービス（保険外）</td>
            <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{data.basic_info.current_services_other}</td>
          </tr>
          <tr>
            <td style={cellLabel}>住居環境</td>
            <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{data.basic_info.housing_situation}</td>
            <td style={cellLabel}>経済状況</td>
            <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{data.basic_info.economic_situation}</td>
          </tr>
        </tbody>
      </table>

      {/* 4 領域 */}
      <div className="bg-blue-100 text-xs px-1 mt-2 font-bold">アセスメント領域（4領域）</div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ ...cellHead, width: "38mm" }}>領域</th>
            <th style={cellHead}>現状</th>
            <th style={cellHead}>課題の分析</th>
            <th style={{ ...cellHead, width: "45mm" }}>本人の意欲・意向</th>
          </tr>
        </thead>
        <tbody>
          {YOBO_DOMAINS.map((d) => {
            const dom = data[d.key];
            return (
              <tr key={d.key}>
                <td style={{ ...cellLabel, width: "38mm" }}>{`${d.number}. ${d.title}`}</td>
                <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{dom.current_state}</td>
                <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{dom.issue_analysis}</td>
                <td style={{ ...cellBase, whiteSpace: "pre-wrap" }}>{dom.motivation}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* 基本チェックリスト */}
      {data.checklist_done && (
        <>
          <div className="bg-blue-100 text-xs px-1 mt-2 font-bold">
            基本チェックリスト（25項目）　該当項目数：{riskCount} / 25
          </div>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7pt" }}>
            <tbody>
              {BASIC_CHECKLIST_QUESTIONS.map((q) => {
                const ans = data.basic_checklist[String(q.no)] ?? "";
                return (
                  <tr key={q.no}>
                    <td style={{ ...cellBase, width: "6mm", textAlign: "center" }}>{q.no}</td>
                    <td style={cellBase}>{q.text}</td>
                    <td style={{ ...cellBase, width: "28mm" }}>
                      <span className="inline-flex items-center mr-2">
                        <PVCheck on={ans === "はい"} />はい
                      </span>
                      <span className="inline-flex items-center">
                        <PVCheck on={ans === "いいえ"} />いいえ
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {/* 総合的な課題 */}
      <div className="bg-blue-100 text-xs px-1 mt-2 font-bold">総合的な課題・方針</div>
      <div className="text-xs mt-1">総合的な課題（生活課題・背景・要因）</div>
      <div style={{ ...box, minHeight: "18mm" }}>{data.summary.overall_issues}</div>
      <div className="grid grid-cols-2 gap-1 mt-1">
        <div>
          <div className="text-xs">目標とする生活（6ヶ月後・1年後）</div>
          <div style={{ ...box, minHeight: "16mm" }}>{data.summary.target_life}</div>
        </div>
        <div>
          <div className="text-xs">具体的な支援の方針</div>
          <div style={{ ...box, minHeight: "16mm" }}>{data.summary.support_policy}</div>
        </div>
      </div>
      <div className="text-xs mt-1">特記事項</div>
      <div style={{ ...box, minHeight: "12mm" }}>{data.summary.special_notes}</div>
    </PVFrame>
  );
}
