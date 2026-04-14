"use client";

import React from "react";

const F = '"MS Mincho","ＭＳ 明朝","游明朝",serif';
const B = "1px solid #333";
const B2 = "1.5px solid #000";
const BG = "#f5f5f5";

function D({ v, n, s = 16 }: { v: string; n: number; s?: number }) {
  const cs = v.padEnd(n, " ").slice(0, n).split("");
  return (
    <span style={{ display: "inline-flex" }}>
      {cs.map((c, i) => (
        <span key={i} style={{
          display: "inline-block", width: s, height: s + 1,
          border: B, textAlign: "center", lineHeight: `${s + 1}px`,
          fontSize: s > 14 ? "9pt" : "7pt", fontFamily: "monospace",
          marginRight: -1, background: "#fff",
        }}>{c.trim()}</span>
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
  return { e: 3, y: yr - 1925, m, day };
}

function p(n: number) { return String(n).padStart(2, "0"); }

function Cir({ on, text }: { on: boolean; text: string }) {
  return on ? (
    <span style={{ border: "1.5px solid #000", borderRadius: "50%", padding: "0 2px", fontWeight: "bold" }}>{text}</span>
  ) : <span>{text}</span>;
}

// 斜線セル
const SLASH: React.CSSProperties = {
  border: B, background: "repeating-linear-gradient(135deg, transparent, transparent 2px, #bbb 2px, #bbb 3px)",
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface PersonData {
  insuredNumber: string;
  userName: string;
  userKana: string;
  birthDate: string;
  gender: string;
  careLevel: string;
  certStart: string;
  certEnd: string;
  lines: { name: string; code: string; units: number; count: number; serviceUnits: number }[];
  totalServiceUnits: number;
  claimAmount: number;
}

interface Props {
  providerNumber: string;
  officeName: string;
  officeAddress: string;
  officePhone: string;
  postalCode: string;
  insurerNumber: string;
  unitPrice: number;
  billingMonth: string;
  person1: PersonData | null;
  person2: PersonData | null;
}

// ─── 1人分の被保険者ブロック ──────────────────────────────────────────────────

function PersonBlock({
  num,
  person,
  providerNumber,
  billingMonth,
}: {
  num: 1 | 2;
  person: PersonData | null;
  providerNumber: string;
  billingMonth: string;
}) {
  const h: React.CSSProperties = { border: B, padding: "1px 3px", fontSize: "6pt", verticalAlign: "middle", fontFamily: F, background: BG };
  const c: React.CSSProperties = { border: B, padding: "1px 3px", fontSize: "7.5pt", verticalAlign: "middle", fontFamily: F, background: "#fff" };
  const cR: React.CSSProperties = { ...c, textAlign: "right" };

  if (!person) {
    // 空の被保険者ブロック
    return (
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "1mm" }}>
        <tbody>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, width: "3%", textAlign: "center", borderRight: B2 }} rowSpan={6}>
              <span style={{ fontSize: "10pt", fontWeight: "bold" }}>{num}</span>
            </td>
            <td style={{ ...h, width: "10%" }}>被保険者番号</td>
            <td style={{ ...c, width: "22%" }}><D v="" n={10} /></td>
            <td style={{ ...h, width: "6%", fontSize: "5pt" }}>(ﾌﾘｶﾞﾅ)</td>
            <td style={{ ...c, width: "20%" }}></td>
            <td style={{ ...c, width: "10%", textAlign: "center" }}>性別 1.男 2.女</td>
          </tr>
          <tr style={{ height: 18 }}>
            <td style={h}>公費受給者番号</td>
            <td style={c}></td>
            <td style={h}>氏名</td>
            <td style={c} colSpan={2}></td>
          </tr>
          <tr style={{ height: 24 }}>
            <td style={{ ...h, fontSize: "5pt" }}>生年<br />月日</td>
            <td style={c} colSpan={2}>
              <span style={{ fontSize: "6pt" }}>1.明治 2.大正 3.昭和</span>
              <br />
              <span style={{ fontSize: "7pt" }}>　年　月　日</span>
            </td>
            <td style={{ ...c, fontSize: "6pt" }}>
              要介護<br />状態区分　1・2・3・4・5
            </td>
            <td style={{ ...c, fontSize: "6pt" }}>
              認定<br />有効期間　年　月　日から<br />　　　　　年　月　日まで
            </td>
          </tr>
          <tr style={{ height: 18 }}>
            <td style={{ ...h, fontSize: "5pt" }}>居宅介護支援<br />事業所番号</td>
            <td style={c}><D v="" n={10} s={11} /></td>
            <td style={{ ...h, fontSize: "5pt" }}>サービス計<br />画作成依頼<br />届出年月日</td>
            <td style={c} colSpan={2}>令和　年　月　日</td>
          </tr>
          {/* サービス明細ヘッダー */}
          <tr style={{ height: 16 }}>
            <td style={{ ...h, textAlign: "center" }} colSpan={2}>サービス内容</td>
            <td style={{ ...h, textAlign: "center" }}>サービスコード</td>
            <td style={{ ...h, textAlign: "center" }}>単位数</td>
            <td style={{ ...h, textAlign: "center", fontSize: "5pt" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>回数</span><span>サービス単位数</span><span>摘要</span><span>サービス単位数合計</span>
              </div>
            </td>
          </tr>
          {/* 空の明細行 */}
          <tr style={{ height: 40 }}>
            <td style={c} colSpan={5}>
              <div style={{ height: 40, display: "flex", alignItems: "flex-end", justifyContent: "flex-end", fontSize: "6pt", color: "#999" }}>
                請求額合計
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    );
  }

  const b = era(person.birthDate);
  const cs = era(person.certStart);
  const ce = era(person.certEnd);
  const clNum = person.careLevel.match(/\d/)?.[0] ?? "";
  const isK = person.careLevel.includes("要介護");

  // サービス明細行（最低3行）
  const svc = [...person.lines];
  while (svc.length < 3) svc.push({ name: "", code: "", units: 0, count: 0, serviceUnits: 0 });

  const bm = era(billingMonth + "-01");

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "1mm" }}>
      <tbody>
        {/* 被保険者番号 + フリガナ + 性別 */}
        <tr style={{ height: 20 }}>
          <td style={{ ...h, width: "3%", textAlign: "center", borderRight: B2 }} rowSpan={4}>
            <span style={{ fontSize: "10pt", fontWeight: "bold" }}>{num}</span>
          </td>
          <td style={{ ...h, width: "10%", fontSize: "5.5pt" }}>被保険者番号</td>
          <td style={{ ...c, width: "22%" }}><D v={person.insuredNumber} n={10} /></td>
          <td style={{ ...h, width: "6%", fontSize: "5pt" }}>(ﾌﾘｶﾞﾅ)</td>
          <td style={{ ...c, width: "15%", fontSize: "7pt" }}>{person.userKana}</td>
          <td style={{ ...c, width: "15%", textAlign: "center", fontSize: "7pt" }}>
            性別 <Cir on={person.gender==="男"} text="1.男" /> <Cir on={person.gender==="女"} text="2.女" />
          </td>
        </tr>
        {/* 公費 + 氏名 */}
        <tr style={{ height: 18 }}>
          <td style={{ ...h, fontSize: "5.5pt" }}>公費受給者番号</td>
          <td style={c}></td>
          <td style={{ ...h, fontSize: "5.5pt" }}>氏名</td>
          <td style={{ ...c, fontWeight: "bold", fontSize: "10pt" }} colSpan={2}>{person.userName}</td>
        </tr>
        {/* 生年月日 + 要介護度 + 認定有効期間 */}
        <tr style={{ height: 26 }}>
          <td style={{ ...h, fontSize: "5pt" }}>
            <span style={{ writingMode: "vertical-rl" }}>被保険者</span>
          </td>
          <td style={{ ...c, fontSize: "6.5pt" }}>
            <div style={{ fontSize: "6pt" }}>生年月日</div>
            <Cir on={b.e===1} text="1.明治" /> <Cir on={b.e===2} text="2.大正" /> <Cir on={b.e===3} text="3.昭和" />
            <br />
            <D v={p(b.y)} n={2} s={11} />年<D v={p(b.m)} n={2} s={11} />月<D v={p(b.day)} n={2} s={11} />日
          </td>
          <td style={{ ...c, fontSize: "6.5pt" }} colSpan={2}>
            <div style={{ fontSize: "5.5pt" }}>要介護　　　　認定</div>
            <div>
              状態区分
              {["1","2","3","4","5"].map((n,i) => (
                <React.Fragment key={n}><Cir on={isK && clNum===n} text={n} />{i<4 && "・"}</React.Fragment>
              ))}
            </div>
          </td>
          <td style={{ ...c, fontSize: "6.5pt" }}>
            <div style={{ fontSize: "5pt" }}>認定<br />有効期間</div>
            <D v={p(cs.y)} n={2} s={10} />年<D v={p(cs.m)} n={2} s={10} />月<D v={p(cs.day)} n={2} s={10} />日から
            <br />
            <D v={p(ce.y)} n={2} s={10} />年<D v={p(ce.m)} n={2} s={10} />月<D v={p(ce.day)} n={2} s={10} />日まで
          </td>
        </tr>
        {/* 居宅介護支援事業所番号 + 届出年月日 */}
        <tr style={{ height: 18 }}>
          <td style={{ ...h, fontSize: "5pt" }}>居宅介護支援<br />事業所番号</td>
          <td style={c}><D v={providerNumber} n={10} s={11} /></td>
          <td style={{ ...h, fontSize: "5pt" }}>サービス計画<br />作成依頼届出<br />年月日</td>
          <td style={{ ...c, fontSize: "7pt" }} colSpan={2}>
            令和<D v={p(bm.y)} n={2} s={10} />年<D v={p(bm.m)} n={2} s={10} />月<D v="" n={2} s={10} />日
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// ─── メイン: 居宅介護支援介護給付費明細書 ──────────────────────────────────────

export function MeisaiForm(props: Props) {
  const {
    providerNumber, officeName, officeAddress, officePhone, postalCode,
    insurerNumber, unitPrice, billingMonth, person1, person2,
  } = props;

  const h: React.CSSProperties = { border: B, padding: "1px 3px", fontSize: "6pt", verticalAlign: "middle", fontFamily: F, background: BG };
  const c: React.CSSProperties = { border: B, padding: "1px 3px", fontSize: "7.5pt", verticalAlign: "middle", fontFamily: F, background: "#fff" };
  const cR: React.CSSProperties = { ...c, textAlign: "right" };

  const bm = era(billingMonth + "-01");

  // サービス明細テーブルを描画する関数
  const renderServiceTable = (person: PersonData | null) => {
    if (!person) {
      return (
        <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "1mm" }}>
          <thead>
            <tr>
              <th style={{ ...h, width: "3%", textAlign: "center" }} rowSpan={2}>
                <span style={{ writingMode: "vertical-rl", fontSize: "6pt" }}>給付費明細欄</span>
              </th>
              <th style={{ ...h, width: "20%", textAlign: "center" }}>サービス内容</th>
              <th style={{ ...h, width: "14%", textAlign: "center" }}>サービスコード</th>
              <th style={{ ...h, width: "8%", textAlign: "center" }}>単位数</th>
              <th style={{ ...h, width: "7%", textAlign: "center" }}>回数</th>
              <th style={{ ...h, width: "12%", textAlign: "center" }}>サービス単位数</th>
              <th style={{ ...h, width: "15%", textAlign: "center" }}>摘要</th>
              <th style={{ ...h, width: "14%", textAlign: "center" }}>サービス単位数合計</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 3 }).map((_, i) => (
              <tr key={i} style={{ height: 18 }}>
                {i === 0 && <td style={c} rowSpan={4}></td>}
                <td style={c}></td><td style={c}></td><td style={c}></td><td style={c}></td><td style={c}></td><td style={c}></td>
                {i === 0 && <td style={cR} rowSpan={3}></td>}
              </tr>
            ))}
            <tr style={{ height: 18 }}>
              <td style={c} colSpan={5} />
              <td style={{ ...cR, fontWeight: "bold", fontSize: "6pt" }}>請求額合計</td>
              <td style={cR}></td>
            </tr>
          </tbody>
        </table>
      );
    }

    const svc = [...person.lines];
    while (svc.length < 3) svc.push({ name: "", code: "", units: 0, count: 0, serviceUnits: 0 });

    return (
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "1mm" }}>
        <thead>
          <tr>
            <th style={{ ...h, width: "3%", textAlign: "center" }} rowSpan={svc.length + 2}>
              <span style={{ writingMode: "vertical-rl", fontSize: "6pt" }}>給付費明細欄</span>
            </th>
            <th style={{ ...h, width: "20%", textAlign: "center" }}>サービス内容</th>
            <th style={{ ...h, width: "14%", textAlign: "center" }}>サービスコード</th>
            <th style={{ ...h, width: "8%", textAlign: "center" }}>単位数</th>
            <th style={{ ...h, width: "7%", textAlign: "center" }}>回数</th>
            <th style={{ ...h, width: "12%", textAlign: "center" }}>サービス単位数</th>
            <th style={{ ...h, width: "15%", textAlign: "center" }}>摘要</th>
            <th style={{ ...h, width: "14%", textAlign: "center" }}>サービス単位数合計</th>
          </tr>
        </thead>
        <tbody>
          {svc.map((l, i) => (
            <tr key={i} style={{ height: 18 }}>
              <td style={{ ...c, fontSize: "7pt" }}>{l.name}</td>
              <td style={{ ...c, fontFamily: "monospace", textAlign: "center", letterSpacing: 1 }}>{l.code}</td>
              <td style={cR}>{l.units > 0 ? l.units.toLocaleString() : ""}</td>
              <td style={cR}>{l.count > 0 ? l.count : ""}</td>
              <td style={cR}>{l.serviceUnits > 0 ? l.serviceUnits.toLocaleString() : ""}</td>
              <td style={c}></td>
              {i === 0 && (
                <td style={{ ...cR, fontWeight: "bold" }} rowSpan={svc.length}>
                  {person.totalServiceUnits > 0 ? person.totalServiceUnits.toLocaleString() : ""}
                </td>
              )}
            </tr>
          ))}
          <tr style={{ height: 18 }}>
            <td style={c} colSpan={5} />
            <td style={{ ...cR, fontWeight: "bold", fontSize: "6pt" }}>請求額合計</td>
            <td style={{ ...cR, fontWeight: "bold", fontSize: "9pt" }}>
              {person.claimAmount > 0 ? person.claimAmount.toLocaleString() : ""}
            </td>
          </tr>
        </tbody>
      </table>
    );
  };

  return (
    <div style={{ fontFamily: F, fontSize: "7.5pt", color: "#000", width: "195mm" }}>
      {/* ──── タイトル + 年月 ──── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "2mm" }}>
        <div style={{ textAlign: "center", flex: 1, fontWeight: "bold", fontSize: "11pt", letterSpacing: "0.1em" }}>
          居宅介護支援介護給付費明細書
        </div>
        <div style={{ border: B2, padding: "2px 4px", fontSize: "8pt" }}>
          令和<D v={p(bm.y)} n={2} s={14} />年<D v={p(bm.m)} n={2} s={14} />月分
        </div>
      </div>

      {/* ──── 公費負担者番号 + 保険者番号 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1mm" }}>
        <tbody>
          <tr style={{ height: 18 }}>
            <td style={{ ...h, width: "12%", borderTop: B2, borderLeft: B2 }}>公費負担者番号</td>
            <td style={{ ...c, width: "20%", borderTop: B2 }}><D v="" n={8} s={14} /></td>
            <td style={{ ...c, width: "5%", borderTop: B2 }} />
            <td style={{ ...h, width: "10%", borderTop: B2 }}>保険者番号</td>
            <td style={{ ...c, borderTop: B2, borderRight: B2 }}><D v={insurerNumber} n={6} s={14} /></td>
          </tr>
        </tbody>
      </table>

      {/* ──── 事業所情報 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "1mm" }}>
        <tbody>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, width: "10%", fontSize: "5.5pt" }}>居宅介護<br />支援事業者</td>
            <td style={{ ...h, width: "8%", fontSize: "5.5pt" }}>事業所<br />番号</td>
            <td style={{ ...c, width: "22%" }}><D v={providerNumber} n={10} /></td>
            <td style={{ ...h, width: "8%", fontSize: "5.5pt" }}>所在地</td>
            <td style={{ ...c, width: "22%" }} rowSpan={2}>
              〒{postalCode}<br />{officeAddress}
            </td>
          </tr>
          <tr style={{ height: 18 }}>
            <td style={h}></td>
            <td style={{ ...h, fontSize: "5.5pt" }}>事業所<br />名称</td>
            <td style={{ ...c, fontWeight: "bold" }}>{officeName}</td>
            <td style={h}></td>
          </tr>
          <tr style={{ height: 18 }}>
            <td style={h} colSpan={2}></td>
            <td style={c}></td>
            <td style={{ ...h, fontSize: "5.5pt" }}>連絡先</td>
            <td style={c}>電話番号　{officePhone}</td>
          </tr>
          <tr style={{ height: 18 }}>
            <td style={h} colSpan={2}></td>
            <td style={c} colSpan={2}></td>
            <td style={c}>
              単位数単価　<D v={unitPrice.toFixed(2).replace(".", "")} n={4} s={12} />（円/単位）
            </td>
          </tr>
        </tbody>
      </table>

      {/* ──── 被保険者1 ──── */}
      <PersonBlock num={1} person={person1} providerNumber={providerNumber} billingMonth={billingMonth} />
      {renderServiceTable(person1)}

      {/* ──── 被保険者2 ──── */}
      <PersonBlock num={2} person={person2} providerNumber={providerNumber} billingMonth={billingMonth} />
      {renderServiceTable(person2)}
    </div>
  );
}
