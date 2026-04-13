"use client";

import React from "react";

// ─── 共通スタイル ──────────────────────────────────────────────────────────────

const B = "1px solid #000";
const FONT = '"MS Mincho","游明朝","Hiragino Mincho ProN",serif';

// 1桁ずつのマス目を描画
function DigitBoxes({ value, length, small }: { value: string; length: number; small?: boolean }) {
  const digits = value.padEnd(length, " ").slice(0, length).split("");
  const size = small ? 14 : 18;
  return (
    <span style={{ display: "inline-flex" }}>
      {digits.map((d, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            width: size,
            height: size,
            border: B,
            textAlign: "center",
            lineHeight: `${size}px`,
            fontSize: small ? "7pt" : "9pt",
            fontFamily: "monospace",
            marginRight: i < length - 1 ? -1 : 0,
          }}
        >
          {d.trim()}
        </span>
      ))}
    </span>
  );
}

// 和暦の丸印
function EraCircle({ era }: { era: number }) {
  // 1=明治, 2=大正, 3=昭和, 4=平成, 5=令和
  const labels = ["明治", "大正", "昭和", "平成", "令和"];
  return (
    <span style={{ fontSize: "7pt" }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} style={{ marginRight: "2px" }}>
          {n}.{era === n ? <span style={{ border: "1px solid #000", borderRadius: "50%", padding: "0 2px" }}>{labels[n - 1]}</span> : labels[n - 1]}
        </span>
      ))}
    </span>
  );
}

function getEraCode(dateStr: string): { era: number; year: number; month: number; day: number } {
  if (!dateStr) return { era: 5, year: 0, month: 0, day: 0 };
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if (y >= 2019) return { era: 5, year: y - 2018, month: m, day };
  if (y >= 1989) return { era: 4, year: y - 1988, month: m, day };
  if (y >= 1926) return { era: 3, year: y - 1925, month: m, day };
  if (y >= 1912) return { era: 2, year: y - 1911, month: m, day };
  return { era: 1, year: y - 1867, month: m, day };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MeisaiProps {
  providerNumber: string;
  officeName: string;
  officeAddress: string;
  officePhone: string;
  postalCode: string;
  insurerNumber: string;
  insuredNumber: string;
  userName: string;
  userKana: string;
  birthDate: string;
  gender: string;
  careLevel: string;
  certStart: string;
  certEnd: string;
  billingMonth: string;
  unitPrice: number;
  lines: { name: string; code: string; units: number; count: number }[];
  totalUnits: number;
  totalAmount: number;
  insuranceAmount: number;
}

// ─── 介護給付費明細書（様式第七）完全再現 ──────────────────────────────────────

export function MeisaiForm(props: MeisaiProps) {
  const {
    providerNumber, officeName, officeAddress, officePhone, postalCode,
    insurerNumber, insuredNumber, userName, userKana,
    birthDate, gender, careLevel, certStart, certEnd,
    billingMonth, unitPrice,
    lines, totalUnits, totalAmount, insuranceAmount,
  } = props;

  const cell: React.CSSProperties = {
    border: B, padding: "1px 3px", fontSize: "8pt", verticalAlign: "middle",
    fontFamily: FONT,
  };
  const th: React.CSSProperties = {
    ...cell, fontWeight: "normal", backgroundColor: "#f8f8f8", textAlign: "left",
    fontSize: "7pt",
  };
  const thC: React.CSSProperties = { ...th, textAlign: "center" };
  const tdR: React.CSSProperties = { ...cell, textAlign: "right" };
  const tdC: React.CSSProperties = { ...cell, textAlign: "center" };
  const lineH = "20px";

  const birth = getEraCode(birthDate);
  const cs = getEraCode(certStart);
  const ce = getEraCode(certEnd);
  const bm = getEraCode(billingMonth + "-01");

  // 要介護度から数字を抽出
  const careLevelNum = careLevel.match(/\d/)?.[0] ?? "";
  const isYokaigo = careLevel.includes("要介護");
  const isYoshien = careLevel.includes("要支援");

  // サービス明細行（最低8行に）
  const svcLines = [...lines];
  while (svcLines.length < 8) {
    svcLines.push({ name: "", code: "", units: 0, count: 0 });
  }

  return (
    <div style={{ fontFamily: FONT, fontSize: "8pt", color: "#000", width: "190mm", position: "relative" }}>
      {/* タイトル */}
      <div style={{ textAlign: "center", fontSize: "10pt", fontWeight: "bold", marginBottom: "2mm", letterSpacing: "0.15em" }}>
        居宅サービス・地域密着型サービス介護給付費明細書
      </div>
      <div style={{ fontSize: "5pt", textAlign: "center", marginBottom: "2mm", color: "#666" }}>
        (訪問介護・訪問入浴介護・訪問看護・訪問リハ・居宅療養管理指導・通所介護・通所リハ・福祉用具貸与・定期巡回・夜間対応型訪問介護・
        認知症対応型通所介護・小規模多機能・看多機・居宅介護支援・介護予防支援)
      </div>

      {/* ──── 上段: 公費＋被保険者＋事業所 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1mm" }}>
        <tbody>
          {/* 公費負担者番号 */}
          <tr style={{ height: lineH }}>
            <td style={{ ...th, width: "16%" }}>公費負担者番号</td>
            <td style={{ ...cell, width: "34%" }}><DigitBoxes value="" length={8} /></td>
            <td style={{ ...cell, width: "50%", textAlign: "right" }} rowSpan={2}>
              <span style={{ fontSize: "7pt" }}>
                {bm.era === 5 ? "令和" : "平成"}
                <DigitBoxes value={pad2(bm.year)} length={2} small />年
                <DigitBoxes value={pad2(bm.month)} length={2} small />月分
              </span>
            </td>
          </tr>
          {/* 公費受給者番号 */}
          <tr style={{ height: lineH }}>
            <td style={th}>公費受給者番号</td>
            <td style={cell}><DigitBoxes value="" length={7} /></td>
          </tr>
        </tbody>
      </table>

      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1mm" }}>
        <tbody>
          {/* 被保険者番号 / 事業所番号 */}
          <tr style={{ height: lineH }}>
            <td style={{ ...th, width: "12%" }}>被保険者<br />番号</td>
            <td style={{ ...cell, width: "24%" }}><DigitBoxes value={insuredNumber} length={10} /></td>
            <td style={{ ...th, width: "12%" }}>事業所<br />番号</td>
            <td style={{ ...cell, width: "24%" }}><DigitBoxes value={providerNumber} length={10} /></td>
          </tr>
          {/* フリガナ / 事業所名称 */}
          <tr style={{ height: lineH }}>
            <td style={{ ...th, fontSize: "6pt" }}>（フリガナ）</td>
            <td style={cell}><span style={{ fontSize: "7pt" }}>{userKana}</span></td>
            <td style={th} rowSpan={2}>請求<br />事業所</td>
            <td style={cell} rowSpan={2}>
              <div style={{ fontSize: "7pt" }}>{officeName}</div>
              <div style={{ fontSize: "6pt", marginTop: "1px" }}>〒{postalCode}</div>
              <div style={{ fontSize: "6pt" }}>{officeAddress}</div>
              <div style={{ fontSize: "6pt" }}>TEL: {officePhone}</div>
            </td>
          </tr>
          {/* 氏名 */}
          <tr style={{ height: lineH }}>
            <td style={th}>氏名</td>
            <td style={{ ...cell, fontWeight: "bold", fontSize: "10pt" }}>{userName}</td>
          </tr>
          {/* 生年月日 / 性別 */}
          <tr style={{ height: lineH }}>
            <td style={th}>
              <span style={{ fontSize: "6pt" }}>被<br />保<br />険<br />者</span>
            </td>
            <td style={cell}>
              <div style={{ fontSize: "6pt", marginBottom: "1px" }}>生年月日</div>
              <EraCircle era={birth.era} />
              <DigitBoxes value={pad2(birth.year)} length={2} small />年
              <DigitBoxes value={pad2(birth.month)} length={2} small />月
              <DigitBoxes value={pad2(birth.day)} length={2} small />日
              <span style={{ marginLeft: "8px", fontSize: "7pt" }}>
                性別
                {gender === "男" ? <span style={{ border: B, borderRadius: "50%", padding: "0 2px" }}>1.男</span> : "1.男"}

                {gender === "女" ? <span style={{ border: B, borderRadius: "50%", padding: "0 2px" }}>2.女</span> : "2.女"}
              </span>
            </td>
            <td style={th}>保険者番号</td>
            <td style={cell}><DigitBoxes value={insurerNumber} length={6} /></td>
          </tr>
          {/* 要介護状態区分 */}
          <tr style={{ height: lineH }}>
            <td style={th}>要介護<br />状態区分</td>
            <td style={cell}>
              <span style={{ fontSize: "7pt" }}>
                要介護
                {["1", "2", "3", "4", "5"].map((n) => (
                  <span key={n}>
                    ・{isYokaigo && careLevelNum === n ? <span style={{ border: B, borderRadius: "50%", padding: "0 2px", fontWeight: "bold" }}>{n}</span> : n}
                  </span>
                ))}
              </span>
            </td>
            <td style={th} rowSpan={2}>
              居宅<br />サービス<br />計画
            </td>
            <td style={cell} rowSpan={2}>
              <div style={{ fontSize: "6pt" }}>
                ① 居宅介護支援事業者作成<br />
                事業所番号 <DigitBoxes value={providerNumber} length={10} small />
              </div>
            </td>
          </tr>
          {/* 認定有効期間 */}
          <tr style={{ height: lineH }}>
            <td style={th}>認定有効<br />期間</td>
            <td style={cell}>
              <span style={{ fontSize: "7pt" }}>
                {cs.era === 5 ? "令和" : "平成"}
                <DigitBoxes value={pad2(cs.year)} length={2} small />年
                <DigitBoxes value={pad2(cs.month)} length={2} small />月
                <DigitBoxes value={pad2(cs.day)} length={2} small />日 から
                <br />
                {ce.era === 5 ? "令和" : "平成"}
                <DigitBoxes value={pad2(ce.year)} length={2} small />年
                <DigitBoxes value={pad2(ce.month)} length={2} small />月
                <DigitBoxes value={pad2(ce.day)} length={2} small />日 まで
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ──── サービス明細 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1mm" }}>
        <thead>
          <tr>
            <th style={{ ...thC, width: "25%" }}>サービス内容</th>
            <th style={{ ...thC, width: "14%" }}>サービスコード</th>
            <th style={{ ...thC, width: "10%" }}>単位数</th>
            <th style={{ ...thC, width: "8%" }}>回数</th>
            <th style={{ ...thC, width: "12%" }}>サービス単位数</th>
            <th style={{ ...thC, width: "6%" }}>公費</th>
            <th style={{ ...thC, width: "12%" }}>公費対象単位数</th>
            <th style={{ ...thC, width: "13%" }}>摘要</th>
          </tr>
        </thead>
        <tbody>
          {svcLines.map((line, i) => (
            <tr key={i} style={{ height: lineH }}>
              <td style={cell}>{line.name}</td>
              <td style={{ ...cell, fontFamily: "monospace", textAlign: "center", letterSpacing: "1px" }}>
                {line.code}
              </td>
              <td style={tdR}>{line.units > 0 ? line.units.toLocaleString() : ""}</td>
              <td style={tdR}>{line.count > 0 ? line.count : ""}</td>
              <td style={tdR}>{line.units > 0 ? (line.units * line.count).toLocaleString() : ""}</td>
              <td style={tdC}></td>
              <td style={tdR}></td>
              <td style={cell}></td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ──── 給付費明細（下段） ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1mm" }}>
        <tbody>
          <tr style={{ height: lineH }}>
            <td style={{ ...th, width: "6%" }} rowSpan={7}>
              <span style={{ writingMode: "vertical-rl", letterSpacing: "0.1em", fontSize: "7pt" }}>
                給付費明細欄
              </span>
            </td>
            <td style={{ ...th, width: "5%" }} rowSpan={2}></td>
            <td style={{ ...th, width: "15%" }}>①サービス種類<br />コード/名称</td>
            <td style={{ ...cell, width: "10%" }}>43</td>
            <td style={{ ...cell, width: "14%" }}>居宅介護支援</td>
            <td style={{ ...th, width: "10%", borderLeft: "2px solid #000" }} rowSpan={7}></td>
            <td style={{ ...th, width: "10%" }} rowSpan={7}></td>
            <td style={{ ...th, width: "10%" }} rowSpan={7}></td>
          </tr>
          <tr style={{ height: lineH }}>
            <td style={th}>③サービス実日数</td>
            <td style={tdR}>
              <DigitBoxes value={pad2(lines.filter((l) => l.units > 0).length > 0 ? 1 : 0)} length={2} small />日
            </td>
            <td style={cell}></td>
          </tr>
          <tr style={{ height: lineH }}>
            <td style={{ ...th, fontSize: "6pt" }} rowSpan={5}>
              <span style={{ writingMode: "vertical-rl", letterSpacing: "0.05em" }}>
                請求額集計欄
              </span>
            </td>
            <td style={th}>④計画単位数</td>
            <td style={tdR}>{totalUnits.toLocaleString()}</td>
            <td style={cell}></td>
          </tr>
          <tr style={{ height: lineH }}>
            <td style={th}>⑤限度額管理対象<br />単位数</td>
            <td style={tdR}>0</td>
            <td style={cell}>
              <span style={{ fontSize: "6pt" }}>
                給付率(/100)　保険　<b>100</b>
              </span>
            </td>
          </tr>
          <tr style={{ height: lineH }}>
            <td style={th}>⑥限度額管理対象外<br />単位数</td>
            <td style={tdR}>{totalUnits.toLocaleString()}</td>
            <td style={cell}></td>
          </tr>
          <tr style={{ height: lineH }}>
            <td style={th}>⑨単位数単価</td>
            <td style={tdR}>{unitPrice.toFixed(2)} 円/単位</td>
            <td style={cell}></td>
          </tr>
          <tr style={{ height: lineH }}>
            <td style={th}>⑧費用合計(⑦×⑨)</td>
            <td style={{ ...tdR, fontWeight: "bold" }}>{totalAmount.toLocaleString()} 円</td>
            <td style={cell}></td>
          </tr>
        </tbody>
      </table>

      {/* ──── 請求額 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <tr style={{ height: lineH }}>
            <td style={{ ...th, width: "20%" }}>⑦給付単位数(⑤+⑥)</td>
            <td style={{ ...tdR, width: "15%" }}>{totalUnits.toLocaleString()}</td>
            <td style={{ ...th, width: "20%" }}>⑩保険請求額</td>
            <td style={{ ...tdR, width: "15%", fontWeight: "bold", color: "#1d4ed8", fontSize: "10pt" }}>
              {insuranceAmount.toLocaleString()}
            </td>
          </tr>
          <tr style={{ height: lineH }}>
            <td style={th}></td>
            <td style={cell}></td>
            <td style={th}>⑪利用者負担額</td>
            <td style={tdR}>0</td>
          </tr>
          <tr style={{ height: lineH }}>
            <td style={th}></td>
            <td style={cell}></td>
            <td style={th}>⑫公費請求額</td>
            <td style={tdR}>0</td>
          </tr>
          <tr style={{ height: lineH }}>
            <td style={th}></td>
            <td style={cell}></td>
            <td style={th}>⑬公費分本人負担</td>
            <td style={tdR}>0</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
