"use client";

import React from "react";

// ─── 共通定義 ──────────────────────────────────────────────────────────────────

const FONT = '"MS Mincho","ＭＳ 明朝","游明朝","Yu Mincho","Hiragino Mincho ProN",serif';
const B = "1px solid #222";
const B2 = "2px solid #000"; // 外枠・区切り線
const BG = "#f9f9f9"; // ヘッダセル背景

// ─── 1桁マス目 ────────────────────────────────────────────────────────────────

function Digits({
  value,
  len,
  size = 20,
  separator,
}: {
  value: string;
  len: number;
  size?: number;
  separator?: number[]; // マス間にスペースを入れる位置 (0-indexed)
}) {
  const chars = value.replace(/-/g, "").padEnd(len, " ").slice(0, len).split("");
  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      {chars.map((c, i) => (
        <React.Fragment key={i}>
          {separator?.includes(i) && <span style={{ width: 3 }} />}
          <span
            style={{
              display: "inline-block",
              width: size,
              height: size + 2,
              border: B,
              textAlign: "center",
              lineHeight: `${size + 2}px`,
              fontSize: size > 16 ? "10pt" : "8pt",
              fontFamily: "monospace",
              marginRight: -1,
              backgroundColor: "#fff",
            }}
          >
            {c.trim()}
          </span>
        </React.Fragment>
      ))}
    </span>
  );
}

// ─── 元号丸印 ──────────────────────────────────────────────────────────────────

function EraSelect({ era }: { era: number }) {
  const labels = [
    { n: 1, label: "明治" },
    { n: 2, label: "大正" },
    { n: 3, label: "昭和" },
    { n: 4, label: "平成" },
    { n: 5, label: "令和" },
  ];
  return (
    <span style={{ fontSize: "7.5pt", letterSpacing: "0.5px" }}>
      {labels.map(({ n, label }) => (
        <span key={n} style={{ marginRight: 3 }}>
          {n}.
          {era === n ? (
            <span
              style={{
                display: "inline-block",
                border: "1.5px solid #000",
                borderRadius: "50%",
                padding: "0 3px",
                fontWeight: "bold",
                lineHeight: 1.4,
              }}
            >
              {label}
            </span>
          ) : (
            label
          )}
        </span>
      ))}
    </span>
  );
}

function getEra(d: string): { era: number; y: number; m: number; day: number } {
  if (!d) return { era: 5, y: 0, m: 0, day: 0 };
  const dt = new Date(d);
  const yr = dt.getFullYear();
  const m = dt.getMonth() + 1;
  const day = dt.getDate();
  if (yr >= 2019) return { era: 5, y: yr - 2018, m, day };
  if (yr >= 1989) return { era: 4, y: yr - 1988, m, day };
  if (yr >= 1926) return { era: 3, y: yr - 1925, m, day };
  if (yr >= 1912) return { era: 2, y: yr - 1911, m, day };
  return { era: 1, y: yr - 1867, m, day };
}

function p2(n: number): string {
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

// ─── 明細書 本体 ──────────────────────────────────────────────────────────────

export function MeisaiForm(props: MeisaiProps) {
  const {
    providerNumber, officeName, officeAddress, officePhone, postalCode,
    insurerNumber, insuredNumber, userName, userKana,
    birthDate, gender, careLevel, certStart, certEnd,
    billingMonth, unitPrice,
    lines, totalUnits, totalAmount, insuranceAmount,
  } = props;

  // styles
  const hd: React.CSSProperties = {
    border: B, padding: "2px 4px", fontSize: "7.5pt", verticalAlign: "middle",
    fontFamily: FONT, backgroundColor: BG, fontWeight: "normal",
  };
  const td: React.CSSProperties = {
    border: B, padding: "2px 5px", fontSize: "8.5pt", verticalAlign: "middle",
    fontFamily: FONT, backgroundColor: "#fff",
  };
  const tdR: React.CSSProperties = { ...td, textAlign: "right" };
  const tdC: React.CSSProperties = { ...td, textAlign: "center" };
  const ROW = "24px";

  const birth = getEra(birthDate);
  const cs = getEra(certStart);
  const ce = getEra(certEnd);
  const bm = getEra(billingMonth + "-01");

  const careLevelNum = careLevel.match(/\d/)?.[0] ?? "";
  const isKaigo = careLevel.includes("要介護");

  // サービス明細行（最低8行）
  const svcRows = [...lines];
  while (svcRows.length < 8) svcRows.push({ name: "", code: "", units: 0, count: 0 });

  return (
    <div style={{ fontFamily: FONT, fontSize: "8.5pt", color: "#000", width: "195mm" }}>
      {/* ──── タイトル ──── */}
      <div style={{ textAlign: "center", fontWeight: "bold", fontSize: "11pt", marginBottom: "1.5mm", letterSpacing: "0.15em" }}>
        居宅サービス・地域密着型サービス介護給付費明細書
      </div>
      <div style={{ fontSize: "5pt", textAlign: "center", marginBottom: "2mm", color: "#555", lineHeight: 1.3 }}>
        （訪問介護・訪問入浴介護・訪問看護・訪問リハ・居宅療養管理指導・通所介護・通所リハ・福祉用具貸与・定期巡回・夜間対応型訪問介護・
        認知症対応型通所介護・小規模多機能・看多機・居宅介護支援・介護予防支援）
      </div>

      {/* ──── 公費番号 + 年月 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1.5mm" }}>
        <tbody>
          <tr style={{ height: ROW }}>
            <td style={{ ...hd, width: "14%", borderTop: B2, borderLeft: B2 }}>公費負担者番号</td>
            <td style={{ ...td, width: "36%", borderTop: B2 }}><Digits value="" len={8} /></td>
            <td style={{ ...td, width: "50%", borderTop: B2, borderRight: B2, textAlign: "right", verticalAlign: "middle" }} rowSpan={2}>
              <span style={{ fontSize: "9pt" }}>
                {bm.era === 5 ? "令和" : "平成"}
                <Digits value={p2(bm.y)} len={2} size={16} />年
                <Digits value={p2(bm.m)} len={2} size={16} />月分
              </span>
            </td>
          </tr>
          <tr style={{ height: ROW }}>
            <td style={{ ...hd, borderLeft: B2, borderBottom: B2 }}>公費受給者番号</td>
            <td style={{ ...td, borderBottom: B2 }}><Digits value="" len={7} /></td>
          </tr>
        </tbody>
      </table>

      {/* ──── 被保険者 + 事業所 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "1.5mm" }}>
        <tbody>
          {/* 被保険者番号 / 事業所番号 */}
          <tr style={{ height: ROW }}>
            <td style={{ ...hd, width: "11%" }}>被保険者<br />番号</td>
            <td style={{ ...td, width: "29%" }}><Digits value={insuredNumber} len={10} /></td>
            <td style={{ ...hd, width: "9%", borderLeft: B2 }}>事業所<br />番号</td>
            <td style={{ ...td, width: "31%" }}><Digits value={providerNumber} len={10} /></td>
          </tr>
          {/* フリガナ */}
          <tr style={{ height: "18px" }}>
            <td style={{ ...hd, fontSize: "6pt" }}>（フリガナ）</td>
            <td style={{ ...td, fontSize: "7.5pt" }}>{userKana}</td>
            <td style={{ ...hd, borderLeft: B2 }} rowSpan={3}>
              <span style={{ fontSize: "6.5pt" }}>請求<br />事業所</span>
            </td>
            <td style={{ ...td, fontSize: "7pt", lineHeight: 1.4 }} rowSpan={3}>
              <div style={{ fontWeight: "bold", fontSize: "8.5pt" }}>{officeName}</div>
              <div>〒{postalCode}</div>
              <div>{officeAddress}</div>
              <div>TEL {officePhone}</div>
            </td>
          </tr>
          {/* 氏名 */}
          <tr style={{ height: "28px" }}>
            <td style={hd}>氏名</td>
            <td style={{ ...td, fontWeight: "bold", fontSize: "12pt" }}>{userName}</td>
          </tr>
          {/* 生年月日・性別 */}
          <tr style={{ height: "28px" }}>
            <td style={{ ...hd, fontSize: "6pt" }}>
              <span style={{ writingMode: "vertical-rl", letterSpacing: "0.1em" }}>被保険者</span>
            </td>
            <td style={td}>
              <div style={{ fontSize: "6.5pt", marginBottom: "1px" }}>生年月日</div>
              <div>
                <EraSelect era={birth.era} />
                <Digits value={p2(birth.y)} len={2} size={14} />年
                <Digits value={p2(birth.m)} len={2} size={14} />月
                <Digits value={p2(birth.day)} len={2} size={14} />日
              </div>
              <div style={{ marginTop: "2px", fontSize: "8pt" }}>
                性別
                {gender === "男" ? (
                  <span style={{ border: "1.5px solid #000", borderRadius: "50%", padding: "0 3px", fontWeight: "bold" }}>1.男</span>
                ) : "1.男"}

                {gender === "女" ? (
                  <span style={{ border: "1.5px solid #000", borderRadius: "50%", padding: "0 3px", fontWeight: "bold" }}>2.女</span>
                ) : "2.女"}
              </div>
            </td>
          </tr>
          {/* 要介護度 + 保険者番号 */}
          <tr style={{ height: ROW }}>
            <td style={hd}>要介護<br />状態区分</td>
            <td style={td}>
              <span style={{ fontSize: "8pt" }}>
                要介護・
                {["1", "2", "3", "4", "5"].map((n) => (
                  <React.Fragment key={n}>
                    {isKaigo && careLevelNum === n ? (
                      <span style={{ border: "1.5px solid #000", borderRadius: "50%", padding: "0 3px", fontWeight: "bold" }}>{n}</span>
                    ) : n}
                    {n !== "5" && "・"}
                  </React.Fragment>
                ))}
              </span>
            </td>
            <td style={{ ...hd, borderLeft: B2 }}>保険者番号</td>
            <td style={td}><Digits value={insurerNumber} len={6} /></td>
          </tr>
          {/* 認定有効期間 + 居宅サービス計画 */}
          <tr style={{ height: "32px" }}>
            <td style={hd}>認定有効<br />期間</td>
            <td style={{ ...td, fontSize: "7.5pt", lineHeight: 1.6 }}>
              {cs.era === 5 ? "令和" : "平成"}
              <Digits value={p2(cs.y)} len={2} size={14} />年
              <Digits value={p2(cs.m)} len={2} size={14} />月
              <Digits value={p2(cs.day)} len={2} size={14} />日　から
              <br />
              {ce.era === 5 ? "令和" : "平成"}
              <Digits value={p2(ce.y)} len={2} size={14} />年
              <Digits value={p2(ce.m)} len={2} size={14} />月
              <Digits value={p2(ce.day)} len={2} size={14} />日　まで
            </td>
            <td style={{ ...hd, borderLeft: B2, fontSize: "6pt" }}>居宅<br />サービス<br />計画</td>
            <td style={{ ...td, fontSize: "6.5pt" }}>
              ①　居宅介護支援事業者作成<br />
              事業所番号　<Digits value={providerNumber} len={10} size={12} />
            </td>
          </tr>
        </tbody>
      </table>

      {/* ──── サービス明細テーブル ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "1.5mm" }}>
        <thead>
          <tr>
            <th style={{ ...hd, width: "24%", textAlign: "center", borderTop: B2 }}>サービス内容</th>
            <th style={{ ...hd, width: "13%", textAlign: "center" }}>サービスコード</th>
            <th style={{ ...hd, width: "10%", textAlign: "center" }}>単位数</th>
            <th style={{ ...hd, width: "7%", textAlign: "center" }}>回数</th>
            <th style={{ ...hd, width: "12%", textAlign: "center" }}>サービス単位数</th>
            <th style={{ ...hd, width: "5%", textAlign: "center", fontSize: "6pt" }}>公費</th>
            <th style={{ ...hd, width: "12%", textAlign: "center" }}>公費対象単位数</th>
            <th style={{ ...hd, width: "17%", textAlign: "center" }}>摘要</th>
          </tr>
        </thead>
        <tbody>
          {svcRows.map((line, i) => (
            <tr key={i} style={{ height: "20px" }}>
              <td style={{ ...td, fontSize: "8pt" }}>{line.name}</td>
              <td style={{ ...tdC, fontFamily: "monospace", letterSpacing: "1px" }}>{line.code}</td>
              <td style={tdR}>{line.units > 0 ? line.units.toLocaleString() : ""}</td>
              <td style={tdR}>{line.count > 0 ? line.count : ""}</td>
              <td style={tdR}>{line.units > 0 ? (line.units * line.count).toLocaleString() : ""}</td>
              <td style={tdC}></td>
              <td style={tdR}></td>
              <td style={td}></td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ──── 給付費明細欄 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "1.5mm" }}>
        <tbody>
          <tr style={{ height: ROW }}>
            <td style={{ ...hd, width: "5%", textAlign: "center", borderRight: B2 }} rowSpan={7}>
              <span style={{ writingMode: "vertical-rl", letterSpacing: "0.15em", fontSize: "7pt", fontWeight: "bold" }}>
                給付費明細欄
              </span>
            </td>
            <td style={{ ...hd, width: "5%", borderRight: B }} rowSpan={2}></td>
            <td style={{ ...hd, width: "15%" }}>①サービス種類<br />　コード/名称</td>
            <td style={{ ...tdC, width: "6%" }}>43</td>
            <td style={{ ...td, width: "14%" }}>居宅介護支援</td>
            <td style={{ ...td, width: "55%", borderLeft: B2 }} rowSpan={7}></td>
          </tr>
          <tr style={{ height: ROW }}>
            <td style={hd}>③サービス実日数</td>
            <td style={tdR} colSpan={2}>
              <Digits value={p2(lines.filter((l) => l.units > 0).length > 0 ? 1 : 0)} len={2} size={14} />日
            </td>
          </tr>
          <tr style={{ height: ROW }}>
            <td style={{ ...hd, width: "5%", borderRight: B }} rowSpan={5}>
              <span style={{ writingMode: "vertical-rl", letterSpacing: "0.05em", fontSize: "6pt" }}>
                請求額集計欄
              </span>
            </td>
            <td style={hd}>④計画単位数</td>
            <td style={tdR} colSpan={2}>{totalUnits.toLocaleString()}</td>
          </tr>
          <tr style={{ height: ROW }}>
            <td style={hd}>⑤限度額管理対象<br />　単位数</td>
            <td style={tdR} colSpan={2}>
              0
              <span style={{ float: "right", fontSize: "6.5pt", color: "#555" }}>
                給付率(/100)　保険　<b>100</b>
              </span>
            </td>
          </tr>
          <tr style={{ height: ROW }}>
            <td style={hd}>⑥限度額管理対象外<br />　単位数</td>
            <td style={tdR} colSpan={2}>{totalUnits.toLocaleString()}</td>
          </tr>
          <tr style={{ height: ROW }}>
            <td style={hd}>⑨単位数単価</td>
            <td style={tdR} colSpan={2}>{unitPrice.toFixed(2)}　円/単位</td>
          </tr>
          <tr style={{ height: ROW }}>
            <td style={hd}>⑧費用合計(⑦×⑨)</td>
            <td style={{ ...tdR, fontWeight: "bold" }} colSpan={2}>{totalAmount.toLocaleString()}　円</td>
          </tr>
        </tbody>
      </table>

      {/* ──── 請求額 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2 }}>
        <tbody>
          <tr style={{ height: ROW }}>
            <td style={{ ...hd, width: "22%" }}>⑦給付単位数(⑤+⑥)</td>
            <td style={{ ...tdR, width: "18%" }}>{totalUnits.toLocaleString()}</td>
            <td style={{ ...hd, width: "22%", borderLeft: B2 }}>⑩保険請求額</td>
            <td style={{ ...tdR, width: "18%", fontWeight: "bold", fontSize: "11pt", color: "#000" }}>
              {insuranceAmount.toLocaleString()}
            </td>
          </tr>
          <tr style={{ height: ROW }}>
            <td style={hd}></td>
            <td style={td}></td>
            <td style={{ ...hd, borderLeft: B2 }}>⑪利用者負担額</td>
            <td style={tdR}>0</td>
          </tr>
          <tr style={{ height: ROW }}>
            <td style={hd}></td>
            <td style={td}></td>
            <td style={{ ...hd, borderLeft: B2 }}>⑫公費請求額</td>
            <td style={tdR}>0</td>
          </tr>
          <tr style={{ height: ROW }}>
            <td style={hd}></td>
            <td style={td}></td>
            <td style={{ ...hd, borderLeft: B2 }}>⑬公費分本人負担</td>
            <td style={tdR}>0</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
