"use client";

import React from "react";

// ─── Style constants ──────────────────────────────────────────────────────────

const F = '"MS Mincho","ＭＳ 明朝","游明朝","Yu Mincho","Hiragino Mincho ProN",serif';
const B = "1px solid #333";
const B2 = "1.5px solid #000";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function D({ v, n, s = 18 }: { v: string; n: number; s?: number }) {
  const cs = v.padEnd(n, " ").slice(0, n).split("");
  return (
    <span style={{ display: "inline-flex" }}>
      {cs.map((c, i) => (
        <span key={i} style={{
          display: "inline-block", width: s, height: s + 1,
          border: B, textAlign: "center", lineHeight: `${s + 1}px`,
          fontSize: s > 14 ? "9pt" : "7.5pt", fontFamily: "monospace",
          marginRight: -1, background: "#fff",
        }}>
          {c.trim()}
        </span>
      ))}
    </span>
  );
}

function era(d: string) {
  if (!d) return { e: 5, y: 0, m: 0, day: 0 };
  const dt = new Date(d);
  const yr = dt.getFullYear(), m = dt.getMonth() + 1, day = dt.getDate();
  if (yr >= 2019) return { e: 5, y: yr - 2018, m, day };
  if (yr >= 1989) return { e: 4, y: yr - 1988, m, day };
  if (yr >= 1926) return { e: 3, y: yr - 1925, m, day };
  return { e: 2, y: yr - 1911, m, day };
}

function p(n: number, l = 2) { return String(n).padStart(l, "0"); }

function Cir({ on, text }: { on: boolean; text: string }) {
  return on ? (
    <span style={{ border: "1.5px solid #000", borderRadius: "50%", padding: "0 2px", fontWeight: "bold" }}>{text}</span>
  ) : <span>{text}</span>;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  providerNumber: string; officeName: string; officeAddress: string;
  officePhone: string; postalCode: string;
  insurerNumber: string; insuredNumber: string;
  userName: string; userKana: string; birthDate: string; gender: string;
  careLevel: string; certStart: string; certEnd: string;
  billingMonth: string; unitPrice: number;
  lines: { name: string; code: string; units: number; count: number }[];
  totalUnits: number; totalAmount: number; insuranceAmount: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MeisaiForm(props: Props) {
  const {
    providerNumber, officeName, officeAddress, officePhone, postalCode,
    insurerNumber, insuredNumber, userName, userKana,
    birthDate, gender, careLevel, certStart, certEnd,
    billingMonth, unitPrice, lines, totalUnits, totalAmount, insuranceAmount,
  } = props;

  const h: React.CSSProperties = { border: B, padding: "1px 3px", fontSize: "6.5pt", verticalAlign: "middle", fontFamily: F, background: "#f5f5f5" };
  const c: React.CSSProperties = { border: B, padding: "1px 4px", fontSize: "8pt", verticalAlign: "middle", fontFamily: F, background: "#fff" };
  const cR: React.CSSProperties = { ...c, textAlign: "right" };
  const cC: React.CSSProperties = { ...c, textAlign: "center" };

  const b = era(birthDate), cs = era(certStart), ce = era(certEnd), bm = era(billingMonth + "-01");
  const clNum = careLevel.match(/\d/)?.[0] ?? "";
  const isK = careLevel.includes("要介護");

  const svc = [...lines];
  while (svc.length < 6) svc.push({ name: "", code: "", units: 0, count: 0 });

  return (
    <div style={{ fontFamily: F, fontSize: "7.5pt", color: "#000", width: "195mm" }}>
      {/* ──── タイトル ──── */}
      <div style={{ textAlign: "center", fontWeight: "bold", fontSize: "10pt", marginBottom: "1mm", letterSpacing: "0.1em" }}>
        居宅サービス・地域密着型サービス介護給付費明細書
      </div>
      <div style={{ fontSize: "4.5pt", textAlign: "center", marginBottom: "1.5mm", color: "#555" }}>
        （訪問介護・訪問入浴介護・訪問看護・訪問リハ・居宅療養管理指導・通所介護・通所リハ・福祉用具貸与・定期巡回・夜間対応型訪問介護・認知症対応型通所介護・小規模多機能・看多機・居宅介護支援・介護予防支援）
      </div>

      {/* ──── 上段: 公費 + 年月 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.5mm" }}>
        <tbody>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, width: "13%", borderTop: B2, borderLeft: B2 }}>公費負担者番号</td>
            <td style={{ ...c, width: "25%", borderTop: B2 }}><D v="" n={8} /></td>
            <td style={{ ...c, borderTop: B2, borderRight: B2, textAlign: "right" }} rowSpan={2}>
              {bm.e === 5 ? "令和" : "平成"}<D v={p(bm.y)} n={2} s={14} />年<D v={p(bm.m)} n={2} s={14} />月分
            </td>
          </tr>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, borderLeft: B2, borderBottom: B2 }}>公費受給者番号</td>
            <td style={{ ...c, borderBottom: B2 }}><D v="" n={7} /></td>
          </tr>
        </tbody>
      </table>

      {/* ──── 被保険者 + 事業所 (公式様式の2列レイアウト) ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "0.5mm" }}>
        <tbody>
          <tr style={{ height: 22 }}>
            <td style={{ ...h, width: "10%", fontSize: "6pt" }}>被保険者<br />番号</td>
            <td style={{ ...c, width: "28%" }}><D v={insuredNumber} n={10} /></td>
            <td style={{ ...h, width: "8%", borderLeft: B2, fontSize: "6pt" }}>事業所<br />番号</td>
            <td style={{ ...c, width: "28%" }}><D v={providerNumber} n={10} /></td>
          </tr>
          <tr style={{ height: 18 }}>
            <td style={{ ...h, fontSize: "5.5pt" }}>（フリガナ）</td>
            <td style={{ ...c, fontSize: "7pt" }}>{userKana}</td>
            <td style={{ ...h, borderLeft: B2, fontSize: "6pt" }} rowSpan={2}>請求<br />事業所</td>
            <td style={{ ...c, fontSize: "7pt", lineHeight: 1.3 }} rowSpan={2}>
              <div style={{ fontWeight: "bold", fontSize: "8pt" }}>{officeName}</div>
              <div>〒{postalCode}</div>
              <div>{officeAddress}</div>
            </td>
          </tr>
          <tr style={{ height: 26 }}>
            <td style={h}>氏名</td>
            <td style={{ ...c, fontWeight: "bold", fontSize: "11pt" }}>{userName}</td>
          </tr>
          <tr style={{ height: 32 }}>
            <td style={{ ...h, fontSize: "5.5pt" }}>
              <div>生年月日</div>
            </td>
            <td style={c}>
              <div style={{ fontSize: "6.5pt" }}>
                <Cir on={b.e===1} text="1.明治" /> <Cir on={b.e===2} text="2.大正" /> <Cir on={b.e===3} text="3.昭和" /> <Cir on={b.e===4} text="4.平成" /> <Cir on={b.e===5} text="5.令和" />
              </div>
              <div style={{ marginTop: 2 }}>
                <D v={p(b.y)} n={2} s={13} />年<D v={p(b.m)} n={2} s={13} />月<D v={p(b.day)} n={2} s={13} />日
                <span style={{ marginLeft: 8 }}>
                  性別 <Cir on={gender==="男"} text="1.男" /> <Cir on={gender==="女"} text="2.女" />
                </span>
              </div>
            </td>
            <td style={{ ...h, borderLeft: B2, fontSize: "6pt" }}>保険者番号</td>
            <td style={c}><D v={insurerNumber} n={6} /></td>
          </tr>
          <tr style={{ height: 22 }}>
            <td style={{ ...h, fontSize: "6pt" }}>要介護<br />状態区分</td>
            <td style={c}>
              <span style={{ fontSize: "7.5pt" }}>
                要介護・
                {["1","2","3","4","5"].map((n,i) => (
                  <React.Fragment key={n}>
                    <Cir on={isK && clNum===n} text={n} />
                    {i < 4 && "・"}
                  </React.Fragment>
                ))}
              </span>
            </td>
            <td style={{ ...h, borderLeft: B2, fontSize: "5.5pt" }}>連絡先</td>
            <td style={{ ...c, fontSize: "7.5pt" }}>電話番号　{officePhone}</td>
          </tr>
          <tr style={{ height: 30 }}>
            <td style={{ ...h, fontSize: "6pt" }}>認定有効<br />期間</td>
            <td style={{ ...c, fontSize: "7pt", lineHeight: 1.5 }}>
              {cs.e===5?"令和":"平成"}<D v={p(cs.y)} n={2} s={12} />年<D v={p(cs.m)} n={2} s={12} />月<D v={p(cs.day)} n={2} s={12} />日　から<br />
              {ce.e===5?"令和":"平成"}<D v={p(ce.y)} n={2} s={12} />年<D v={p(ce.m)} n={2} s={12} />月<D v={p(ce.day)} n={2} s={12} />日　まで
            </td>
            <td style={{ ...h, borderLeft: B2, fontSize: "5.5pt" }}>居宅<br />サービス<br />計画</td>
            <td style={{ ...c, fontSize: "6pt" }}>
              ①　居宅介護支援事業者作成<br />
              事業所番号 <D v={providerNumber} n={10} s={11} />
            </td>
          </tr>
        </tbody>
      </table>

      {/* ──── サービス明細（保険分） ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "0.5mm" }}>
        <thead>
          <tr>
            <th style={{ ...h, width: "24%", textAlign: "center" }}>サービス内容</th>
            <th style={{ ...h, width: "13%", textAlign: "center" }}>サービスコード</th>
            <th style={{ ...h, width: "9%", textAlign: "center" }}>単位数</th>
            <th style={{ ...h, width: "7%", textAlign: "center" }}>回数</th>
            <th style={{ ...h, width: "11%", textAlign: "center" }}>サービス単位数</th>
            <th style={{ ...h, width: "5%", textAlign: "center", fontSize: "5pt" }}>公費<br />分</th>
            <th style={{ ...h, width: "11%", textAlign: "center" }}>公費対象単位数</th>
            <th style={{ ...h, width: "20%", textAlign: "center" }}>摘要</th>
          </tr>
        </thead>
        <tbody>
          {svc.map((l, i) => (
            <tr key={i} style={{ height: 18 }}>
              <td style={{ ...c, fontSize: "7.5pt" }}>{l.name}</td>
              <td style={{ ...cC, fontFamily: "monospace", letterSpacing: 1 }}>{l.code}</td>
              <td style={cR}>{l.units > 0 ? l.units.toLocaleString() : ""}</td>
              <td style={cR}>{l.count > 0 ? l.count : ""}</td>
              <td style={cR}>{l.units > 0 ? (l.units * l.count).toLocaleString() : ""}</td>
              <td style={cC}></td>
              <td style={cR}></td>
              <td style={c}></td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ──── サービス明細（公費分）空テーブル ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "0.5mm" }}>
        <thead>
          <tr>
            <th style={{ ...h, width: "24%", textAlign: "center", fontSize: "5.5pt" }}>サービス内容</th>
            <th style={{ ...h, width: "13%", textAlign: "center", fontSize: "5.5pt" }}>サービスコード</th>
            <th style={{ ...h, width: "9%", textAlign: "center", fontSize: "5.5pt" }}>単位数</th>
            <th style={{ ...h, width: "7%", textAlign: "center", fontSize: "5.5pt" }}>回数</th>
            <th style={{ ...h, width: "11%", textAlign: "center", fontSize: "5.5pt" }}>サービス単位数</th>
            <th style={{ ...h, width: "11%", textAlign: "center", fontSize: "5.5pt" }}>公費対象単位数</th>
            <th style={{ ...h, width: "25%", textAlign: "center", fontSize: "5.5pt" }}>摘要</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: 16 }}><td style={c} colSpan={7}></td></tr>
        </tbody>
      </table>

      {/* ──── 給付費明細欄 ──── */}
      <table style={{ width: "60%", borderCollapse: "collapse", border: B2, marginBottom: "0.5mm" }}>
        <tbody>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, width: "4%", textAlign: "center", borderRight: B2 }} rowSpan={8}>
              <span style={{ writingMode: "vertical-rl", fontSize: "6pt", fontWeight: "bold", letterSpacing: "0.1em" }}>給付費明細欄</span>
            </td>
            <td style={{ ...h, width: "4%" }} rowSpan={2}></td>
            <td style={{ ...h, width: "20%", fontSize: "5.5pt" }}>①サービス種類<br />　コード/名称</td>
            <td style={{ ...cC, width: "8%" }}>43</td>
            <td style={{ ...c, width: "24%" }}>居宅介護支援</td>
          </tr>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, fontSize: "5.5pt" }}>③サービス実日数</td>
            <td style={cR} colSpan={2}><D v="01" n={2} s={12} />日</td>
          </tr>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, width: "4%", borderRight: B }} rowSpan={6}>
              <span style={{ writingMode: "vertical-rl", fontSize: "5pt", letterSpacing: "0.05em" }}>請求額集計欄</span>
            </td>
            <td style={{ ...h, fontSize: "5.5pt" }}>④計画単位数</td>
            <td style={cR} colSpan={2}>{totalUnits.toLocaleString()}</td>
          </tr>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, fontSize: "5.5pt" }}>⑤限度額管理対象<br />　単位数</td>
            <td style={cR} colSpan={2}>0</td>
          </tr>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, fontSize: "5.5pt" }}>⑥限度額管理対象外<br />　単位数</td>
            <td style={cR} colSpan={2}>{totalUnits.toLocaleString()}</td>
          </tr>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, fontSize: "5.5pt" }}>⑨単位数単価</td>
            <td style={cR} colSpan={2}>{unitPrice.toFixed(2)} 円/単位</td>
          </tr>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, fontSize: "5.5pt" }}>⑧費用合計(⑦×⑨)</td>
            <td style={{ ...cR, fontWeight: "bold" }} colSpan={2}>{totalAmount.toLocaleString()} 円</td>
          </tr>
          <tr style={{ height: 20 }}>
            <td colSpan={4} style={{ ...c, textAlign: "right", fontSize: "6pt" }}>
              給付率(/100)　保険 <b>100</b>　公費
            </td>
          </tr>
        </tbody>
      </table>

      {/* ──── 請求額 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2 }}>
        <tbody>
          <tr style={{ height: 22 }}>
            <td style={{ ...h, width: "20%", fontSize: "6.5pt" }}>⑦給付単位数(⑤+⑥)</td>
            <td style={{ ...cR, width: "13%" }}>{totalUnits.toLocaleString()}</td>
            <td style={{ ...h, width: "16%", borderLeft: B2, fontSize: "6.5pt" }}>⑩保険請求額</td>
            <td style={{ ...cR, width: "15%", fontWeight: "bold", fontSize: "10pt" }}>{insuranceAmount.toLocaleString()}</td>
          </tr>
          <tr style={{ height: 20 }}>
            <td style={h}></td><td style={c}></td>
            <td style={{ ...h, borderLeft: B2, fontSize: "6.5pt" }}>⑪利用者負担額</td>
            <td style={cR}>0</td>
          </tr>
          <tr style={{ height: 20 }}>
            <td style={h}></td><td style={c}></td>
            <td style={{ ...h, borderLeft: B2, fontSize: "6.5pt" }}>⑫公費請求額</td>
            <td style={cR}>0</td>
          </tr>
          <tr style={{ height: 20 }}>
            <td style={h}></td><td style={c}></td>
            <td style={{ ...h, borderLeft: B2, fontSize: "6.5pt" }}>⑬公費分本人負担</td>
            <td style={cR}>0</td>
          </tr>
        </tbody>
      </table>

      {/* ──── 社会福祉法人等による軽減 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginTop: "0.5mm" }}>
        <tbody>
          <tr style={{ height: 28 }}>
            <td style={{ ...h, width: "8%", fontSize: "5pt", textAlign: "center" }}>
              社会福祉<br />法人等に<br />よる軽減
            </td>
            <td style={{ ...h, width: "8%", fontSize: "5.5pt" }}>軽減率</td>
            <td style={{ ...c, width: "8%" }}>%</td>
            <td style={{ ...h, width: "14%", fontSize: "5pt" }}>受領すべき利用者<br />負担の総額（円）</td>
            <td style={{ ...c, width: "12%" }}></td>
            <td style={{ ...h, width: "10%", fontSize: "5.5pt" }}>軽減額（円）</td>
            <td style={{ ...c, width: "12%" }}></td>
            <td style={{ ...h, width: "12%", fontSize: "5pt" }}>軽減後利用者<br />負担額（円）</td>
            <td style={{ ...c, width: "10%" }}></td>
            <td style={{ ...h, width: "6%", fontSize: "5.5pt" }}>備考</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
