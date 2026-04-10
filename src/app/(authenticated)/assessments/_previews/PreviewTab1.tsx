"use client";

import type { FaceSheet } from "../_types";
import { PVFrame, PVTitle, PVBar, PVCircle, PVCheck, PVCheckLabel, cellBase, cellHead, cellLabel } from "../_preview";

interface Props {
  data: FaceSheet;
  userName: string;
  date: string;
}

export function PreviewTab1({ data, userName, date }: Props) {
  const c = data;

  return (
    <PVFrame userName={userName} date={date}>
      <div className="flex items-center justify-between">
        <PVTitle number="1">フェースシート</PVTitle>
        <span className="text-xs">初回アセスメント（新規サービス利用の為）</span>
      </div>

      {/* 相談受付行 */}
      <div className="text-xs mb-2 flex items-center gap-2">
        <span>{c.consultation_date || "　　　年　月　日"} 相談受付</span>
        <span>
          <PVCircle on={c.consultation_type === "訪問"}>訪問</PVCircle>・
          <PVCircle on={c.consultation_type === "電話"}>電話</PVCircle>・
          <PVCircle on={c.consultation_type === "来所"}>来所</PVCircle>・
          <PVCircle on={c.consultation_type === "その他"}>その他（</PVCircle>
          <span>{c.consultation_type_other}</span>
          <span>）</span>
        </span>
        <span className="bg-blue-100 px-1">初回相談受付者</span>
        <span className="border-b border-gray-400 px-1 min-w-[6em] inline-block">{c.first_receptionist}</span>
      </div>

      {/* 本人基本情報 */}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          <tr>
            <td style={cellLabel}>本人氏名</td>
            <td style={cellBase} colSpan={2}>
              <span>{userName}</span>
              <span className="ml-8">
                <PVCircle on={false}>男</PVCircle>・<PVCircle on={false}>女</PVCircle>
              </span>
              <span className="ml-4 bg-blue-100 px-1">年齢</span>
              <span className="ml-1">M・T・S</span>
              <span className="ml-2">生まれ（　歳）</span>
            </td>
          </tr>
          <tr>
            <td style={cellLabel} rowSpan={2}>住　所</td>
            <td style={cellBase} colSpan={2}>
              <div>〒</div>
              <div className="mt-1">
                <span className="ml-16">TEL</span>
                <span className="ml-1 border-b border-gray-400 inline-block min-w-[10em]">　</span>
              </div>
              <div>
                <span className="ml-16">携帯</span>
                <span className="ml-1 border-b border-gray-400 inline-block min-w-[10em]">　</span>
              </div>
            </td>
          </tr>
          <tr><td style={cellBase} colSpan={2}>&nbsp;</td></tr>

          {/* 緊急連絡先 */}
          <tr>
            <td style={cellLabel} rowSpan={3}>緊急連絡先</td>
            <td style={cellBase} colSpan={2}>
              <span>氏名 {c.emergency_contact.name}</span>
              <span className="ml-4">
                <PVCircle on={c.emergency_contact.gender === "男"}>男</PVCircle>・
                <PVCircle on={c.emergency_contact.gender === "女"}>女</PVCircle>
              </span>
              <span className="ml-4">年齢（ {c.emergency_contact.age} 歳）</span>
              <span className="ml-4">本人との続柄（ {c.emergency_contact.relationship} ）</span>
            </td>
          </tr>
          <tr><td style={cellBase} colSpan={2}>住所 {c.emergency_contact.address}　<span className="float-right">TEL {c.emergency_contact.tel}</span></td></tr>
          <tr><td style={cellBase} colSpan={2}><span className="float-right">携帯 {c.emergency_contact.mobile}</span>　</td></tr>

          {/* 相談者 */}
          <tr>
            <td style={cellLabel} rowSpan={3}>相　談　者</td>
            <td style={cellBase} colSpan={2}>
              <span>氏名 {c.consultant.name}</span>
              <span className="ml-4">
                <PVCircle on={c.consultant.gender === "男"}>男</PVCircle>・
                <PVCircle on={c.consultant.gender === "女"}>女</PVCircle>
              </span>
              <span className="ml-4">年齢（ {c.consultant.age} 歳）</span>
              <span className="ml-4">本人との続柄（ {c.consultant.relationship} ）</span>
            </td>
          </tr>
          <tr><td style={cellBase} colSpan={2}>住所 {c.consultant.address}　<span className="float-right">TEL {c.consultant.tel}</span></td></tr>
          <tr><td style={cellBase} colSpan={2}><span className="float-right">携帯 {c.consultant.mobile}</span>　</td></tr>

          <tr>
            <td style={cellLabel}>相談経路<br />（紹介者）</td>
            <td style={cellBase} colSpan={2}>{c.referral_route}</td>
          </tr>
          <tr>
            <td style={cellLabel}>居宅サービス計画<br />作成依頼の届出</td>
            <td style={cellBase} colSpan={2}>届出年月日　{c.plan_request_submission_date}</td>
          </tr>
        </tbody>
      </table>

      {/* 相談内容 */}
      <div className="grid grid-cols-2 gap-0 mt-2">
        <div className="border border-black">
          <div className="bg-blue-100 text-xs font-bold px-1">■相談内容 <span className="font-normal">(主訴/本人・家族の希望・困っていることや不安、思い)</span></div>
          <div className="p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "40mm" }}>
            <div>（本人）</div>
            <div>{c.consultation_content_user}</div>
            <div className="mt-2">（介護者・家族）</div>
            <div>{c.consultation_content_family}</div>
          </div>
        </div>
        <div className="border border-black border-l-0">
          <div className="bg-blue-100 text-xs font-bold px-1">■これまでの生活の経過 <span className="font-normal">(主な生活史)</span></div>
          <div className="p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "40mm" }}>{c.life_history}</div>
        </div>
      </div>

      {/* 介護保険 */}
      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "2mm" }}>
        <tbody>
          <tr>
            <td style={cellLabel}>介護保険</td>
            <td style={cellBase}>
              利用者負担割合　<PVCheckLabel on={c.insurance_copay_ratio === "1割"} label="1割" />
              <PVCheckLabel on={c.insurance_copay_ratio === "2割"} label="2割" />
              <PVCheckLabel on={c.insurance_copay_ratio === "3割"} label="3割" />
            </td>
            <td style={cellLabel}>後期高齢者医療<br />保険(75歳以上)</td>
            <td style={cellBase}>
              一部負担金　<PVCheckLabel on={c.elderly_medical_copay_ratio === "1割"} label="1割負担" />
              <PVCheckLabel on={c.elderly_medical_copay_ratio === "2割"} label="2割負担" />
              <PVCheckLabel on={c.elderly_medical_copay_ratio === "3割"} label="3割負担" />
            </td>
          </tr>
          <tr>
            <td style={cellLabel}>高額介護<br />サービス費該当</td>
            <td style={cellBase} colSpan={3}>
              利用者負担　（
              <PVCheckLabel on={c.high_cost_care_stage === "第5段階"} label="第5段階" />
              <PVCheckLabel on={c.high_cost_care_stage === "第4段階"} label="第4段階" />
              <PVCheckLabel on={c.high_cost_care_stage === "第3段階"} label="第3段階" />
              <PVCheckLabel on={c.high_cost_care_stage === "第2段階"} label="第2段階" />
              <PVCheckLabel on={c.high_cost_care_stage === "第1段階"} label="第1段階" />
              ）
            </td>
          </tr>
          <tr>
            <td style={cellLabel} rowSpan={2}>要介護認定</td>
            <td style={cellBase} colSpan={2}>
              <PVCircle on={c.certification_status === "済"}>済</PVCircle>{" →"}
              <span className="ml-2">非該当・要支援 1 ・ 2 ・要介護 <PVCircle on={c.certification_level === "要介護1"}>1</PVCircle>・<PVCircle on={c.certification_level === "要介護2"}>2</PVCircle>・<PVCircle on={c.certification_level === "要介護3"}>3</PVCircle>・<PVCircle on={c.certification_level === "要介護4"}>4</PVCircle>・<PVCircle on={c.certification_level === "要介護5"}>5</PVCircle></span>
            </td>
            <td style={cellBase}>認定日</td>
            <td style={cellBase}>{c.certification_date}</td>
          </tr>
          <tr>
            <td style={cellBase} colSpan={4}>
              <PVCircle on={c.certification_status === "未(見込み)"}>未(見込み)</PVCircle>{" →"}
              <span className="ml-2">非該当・要支援 1 ・ 2 ・要介護 1 ・ 2 ・ 3 ・ 4 ・ 5</span>
            </td>
          </tr>
        </tbody>
      </table>

      {/* 手帳 */}
      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "2mm" }}>
        <tbody>
          <tr>
            <td style={cellLabel}>身体障害者手帳</td>
            <td style={cellBase}>
              <PVCheckLabel on={c.physical_disability_cert.has} label="有" />
              <PVCheckLabel on={!c.physical_disability_cert.has} label="無" />
              　等　級 <span className="border-b inline-block min-w-[3em]">{c.physical_disability_cert.grade}</span>
              　種 <span className="border-b inline-block min-w-[3em]">{c.physical_disability_cert.type}</span>
              <span className="ml-4 border-b inline-block min-w-[8em]">{c.physical_disability_cert.note}</span>
              <span className="ml-4">交付日 {c.physical_disability_cert.issue_date}</span>
            </td>
          </tr>
          <tr>
            <td style={cellLabel}>療育手帳</td>
            <td style={cellBase}>
              <PVCheckLabel on={c.intellectual_disability_cert.has} label="有" />
              <PVCheckLabel on={!c.intellectual_disability_cert.has} label="無" />
              　程　度 <span className="border-b inline-block min-w-[6em]">{c.intellectual_disability_cert.level}</span>
              <span className="ml-4 border-b inline-block min-w-[8em]">{c.intellectual_disability_cert.note}</span>
              <span className="ml-4">交付日 {c.intellectual_disability_cert.issue_date}</span>
            </td>
          </tr>
          <tr>
            <td style={cellLabel}>精神障害者<br />保健福祉手帳</td>
            <td style={cellBase}>
              <PVCheckLabel on={c.mental_disability_cert.has} label="有" />
              <PVCheckLabel on={!c.mental_disability_cert.has} label="無" />
              　等　級 <span className="border-b inline-block min-w-[6em]">{c.mental_disability_cert.grade}</span>
              <span className="ml-4 border-b inline-block min-w-[8em]">{c.mental_disability_cert.note}</span>
              <span className="ml-4">交付日 {c.mental_disability_cert.issue_date}</span>
            </td>
          </tr>
          <tr>
            <td style={cellLabel}>障害福祉サービス<br />受給者証の有無</td>
            <td style={cellBase}>
              <PVCheckLabel on={c.welfare_service_cert === "有"} label="有" />
              <PVCheckLabel on={c.welfare_service_cert === "無"} label="無" />
              <span className="bg-blue-100 px-1 ml-2">自立支援医療<br />受給者証の有無</span>
              <PVCheckLabel on={c.self_support_medical_cert === "有"} label="有" />
              <PVCheckLabel on={c.self_support_medical_cert === "無"} label="無" />
              <span className="ml-4">障害支援区分→ {c.disability_support_level}</span>
            </td>
          </tr>
        </tbody>
      </table>

      {/* 日常生活自立度 */}
      <PVBar>日常生活自立度</PVBar>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          <tr>
            <td style={cellLabel}>障害高齢者</td>
            <td style={cellBase}>
              {["自立", "J1", "J2", "A1", "A2", "B1", "B2", "C1", "C2"].map((x) => (
                <span key={x} className="mr-2">
                  <PVCircle on={c.daily_life_independence.physical === x}>{x}</PVCircle>
                </span>
              ))}
            </td>
            <td style={cellLabel}>判定者</td>
            <td style={cellBase}>
              <div>{c.daily_life_independence.physical_judge_organization}</div>
            </td>
            <td style={cellLabel}>判定日</td>
            <td style={cellBase}>{c.daily_life_independence.physical_judge_date}</td>
          </tr>
          <tr>
            <td style={cellLabel}>認知症</td>
            <td style={cellBase}>
              {["自立", "I", "IIa", "IIb", "IIIa", "IIIb", "IV", "M"].map((x) => (
                <span key={x} className="mr-2">
                  <PVCircle on={c.daily_life_independence.cognitive === x}>{x}</PVCircle>
                </span>
              ))}
            </td>
            <td style={cellLabel}>判定者</td>
            <td style={cellBase}>
              <div>{c.daily_life_independence.cognitive_judge_organization}</div>
            </td>
            <td style={cellLabel}>判定日</td>
            <td style={cellBase}>{c.daily_life_independence.cognitive_judge_date}</td>
          </tr>
        </tbody>
      </table>
      <div className="text-xs mt-1 text-right">
        アセスメント実施日（初回）　{c.first_assessment_date}
      </div>
    </PVFrame>
  );
}
