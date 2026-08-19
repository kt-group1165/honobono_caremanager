"use client";

import React from "react";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import { splitSougouCode } from "@/lib/kokuho-densou/build-sougou";

// 総合事業 (様式第二の三) の サービス種類コード → 名称。
// 独自サービス (A2/A3) と現行相当 (A1/A5) を載せる。未知のコードは「訪問型サービス」。
const SOUGOU_KIND_NAMES: Record<string, string> = {
  A1: "訪問型サービス（みなし）",
  A2: "訪問型サービス（独自）",
  A3: "訪問型サービス（独自／定率）",
  A4: "訪問型サービス（独自／定額）",
  A5: "通所型サービス（みなし）",
  A6: "通所型サービス（独自）",
  A7: "通所型サービス（独自／定率）",
  A8: "通所型サービス（独自／定額）",
  A9: "その他の生活支援サービス（配食／定率）",
  AA: "その他の生活支援サービス（配食／定額）",
  AB: "その他の生活支援サービス（見守り／定率）",
  AC: "その他の生活支援サービス（見守り／定額）",
  AD: "その他の生活支援サービス（その他／定率）",
  AE: "その他の生活支援サービス（その他／定額）",
  AF: "介護予防ケアマネジメント",
};

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
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
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
  // ── 公費 (生活保護等)。省略時は公費なし (既存呼出互換) ──
  /** 公費負担者番号 (8桁)。用紙上部の公費負担者番号欄に表示 */
  kohiFutanshaNumber?: string | null;
  /** 公費受給者番号 (7桁) */
  kohiJukyushaNumber?: string | null;
  /**
   * 公費単独 (被保険者番号 H = みなし2号 10割公費)。
   * 保険給付率 空欄・公費給付率 100 で表示する
   */
  kohiTandoku?: boolean;
  /** 公費情報あり (単独 or 併用 = 給付率欄の公費 100 表示) */
  hasKohi?: boolean;
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
          <td style={c}><D v={person.kohiJukyushaNumber ?? ""} n={7} s={11} /></td>
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
            {/* 給付率 (/100): 通常 保険100・公費空欄 / 公費併用 保険100・公費100 /
                公費単独 (H番号) 保険空欄・公費100 */}
            <td style={{ ...c, fontSize: "6.5pt" }} colSpan={5}>
              給付率（/100）　保険{" "}
              <span style={{ fontWeight: "bold", fontFamily: "monospace" }}>
                {person.kohiTandoku ? "　" : "100"}
              </span>
              　公費{" "}
              <span style={{ fontWeight: "bold", fontFamily: "monospace" }}>
                {person.hasKohi || person.kohiTandoku ? "100" : "　"}
              </span>
            </td>
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
            <td style={{ ...c, width: "20%", borderTop: B2 }}>
              {/* 公費 (生活保護等) — person1 優先。併用 (振替 0 円) でも記載する */}
              <D v={person1?.kohiFutanshaNumber ?? person2?.kohiFutanshaNumber ?? ""} n={8} s={14} />
            </td>
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

// ════════════════════════════════════════════════════════════════════════════
// MeisaiPrintSheet — 居宅サービス・地域密着型サービス介護給付費明細書 (様式第二)
// (訪問介護 / 国保連伝送用。利用者 1 名 = 1 枚)
// kokuho-seikyu / kaigo-seikyu の両画面から共有。レイアウトは A4 1枚に収まる既存版のまま。
// ════════════════════════════════════════════════════════════════════════════

// 帳票用の桝目 (1 文字 = 1 マス) — 公式様式の番号欄を再現。
// 右詰めで value を流し込み、余りは空マス。境界は marginLeft -0.5pt で二重線回避。
function DigitCells({
  value,
  cells,
  cw = 5,
  h = 6,
}: {
  value: string | null | undefined;
  cells: number;
  /** 1 マスの幅 (mm) */
  cw?: number;
  /** マスの高さ (mm) */
  h?: number;
}) {
  const chars = (value ?? "").padStart(cells, " ").slice(-cells).split("");
  return (
    <span style={{ display: "inline-flex", verticalAlign: "middle" }}>
      {chars.map((c, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            width: `${cw}mm`,
            height: `${h}mm`,
            border: "0.5pt solid #000",
            marginLeft: i === 0 ? 0 : "-0.5pt",
            textAlign: "center",
            lineHeight: `${h}mm`,
            fontFamily: '"MS Gothic","ＭＳ ゴシック",monospace',
            fontSize: "10pt",
            fontWeight: "bold",
          }}
        >
          {c === " " ? " " : c}
        </span>
      ))}
    </span>
  );
}

// 丸数字ラベル (①②③…) — 欄番号の丸囲み表示
function Circle({ n }: { n: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: "5mm",
        height: "5mm",
        lineHeight: "4.6mm",
        borderRadius: "50%",
        border: "0.75pt solid #000",
        textAlign: "center",
        fontSize: "8pt",
        fontWeight: "bold",
        fontFamily: '"MS Gothic","ＭＳ ゴシック",sans-serif',
      }}
    >
      {n}
    </span>
  );
}

// 帳票の見出しセル (ラベル欄)
function Lb({
  children,
  style,
  rowSpan,
  colSpan,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  rowSpan?: number;
  colSpan?: number;
}) {
  return (
    <td
      rowSpan={rowSpan}
      colSpan={colSpan}
      style={{
        border: "0.5pt solid #000",
        padding: "0.8mm 1mm",
        textAlign: "center",
        fontWeight: "normal",
        fontSize: "7.5pt",
        lineHeight: 1.2,
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

// 帳票の値セル
function Vc({
  children,
  style,
  rowSpan,
  colSpan,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  rowSpan?: number;
  colSpan?: number;
}) {
  return (
    <td
      rowSpan={rowSpan}
      colSpan={colSpan}
      style={{
        border: "0.5pt solid #000",
        padding: "0.8mm 1mm",
        fontSize: "8pt",
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

// 和暦 (令和) の YYYY-MM-DD → 元号数値 + 年月日桝 の分解
function warekiParts(iso: string | null | undefined): {
  gengoIndex: number | null; // 1:明治 2:大正 3:昭和 4:平成 5:令和
  y: string;
  m: string;
  d: string;
} {
  if (!iso) return { gengoIndex: null, y: "", m: "", d: "" };
  const mt = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!mt) return { gengoIndex: null, y: "", m: "", d: "" };
  const yy = Number(mt[1]);
  const mm = Number(mt[2]);
  const dd = Number(mt[3]);
  // 元号判定 (境界年の月日簡略化: 年のみで判定)
  let gengoIndex: number;
  let wy: number;
  if (yy >= 2019) {
    gengoIndex = 5;
    wy = yy - 2018;
  } else if (yy >= 1989) {
    gengoIndex = 4;
    wy = yy - 1988;
  } else if (yy >= 1926) {
    gengoIndex = 3;
    wy = yy - 1925;
  } else if (yy >= 1912) {
    gengoIndex = 2;
    wy = yy - 1911;
  } else {
    gengoIndex = 1;
    wy = yy - 1867;
  }
  return {
    gengoIndex,
    y: String(wy).padStart(2, "0"),
    m: String(mm).padStart(2, "0"),
    d: String(dd).padStart(2, "0"),
  };
}

// 認定有効期間の 1 行 (平成/令和 + 年月日桝 + 接尾) — from/to 用
function CertDateRow({
  iso,
  suffix,
}: {
  iso: string | null | undefined;
  suffix: string;
}) {
  const pp = warekiParts(iso);
  const gengoLabel =
    pp.gengoIndex === 5 ? "令和" : pp.gengoIndex === 4 ? "平成" : "";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5mm",
        fontSize: "7.5pt",
      }}
    >
      <span style={{ width: "8mm", textAlign: "center" }}>{gengoLabel}</span>
      <DigitCells value={pp.y} cells={2} cw={4} h={5} />
      <span>年</span>
      <DigitCells value={pp.m} cells={2} cw={4} h={5} />
      <span>月</span>
      <DigitCells value={pp.d} cells={2} cw={4} h={5} />
      <span>日</span>
      <span style={{ marginLeft: "1mm" }}>{suffix}</span>
    </span>
  );
}

const R2: React.CSSProperties = { textAlign: "right" };
const CT: React.CSSProperties = { textAlign: "center" };

// 集計欄の行ラベルセル (左端の項番 + 名称)
function AggLb({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        border: "0.5pt solid #000",
        padding: "0.6mm 1mm",
        fontSize: "7pt",
        lineHeight: 1.15,
        verticalAlign: "middle",
        width: "34%",
      }}
    >
      {children}
    </td>
  );
}

// 集計欄の値セル (訪問介護列)
function AggVc({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <td
      style={{
        border: "0.5pt solid #000",
        padding: "0.6mm 1.5mm",
        fontSize: "8.5pt",
        fontFamily: '"MS Gothic","ＭＳ ゴシック",monospace',
        textAlign: "right",
        verticalAlign: "middle",
        height: "4.7mm",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

export function MeisaiPrintSheet({
  row,
  officeName,
  officeNumber,
  officeAddress,
  officePhone,
  officePostal,
  reiwa,
  month,
  kanriTaishougaiUnits,
  planUnits: planUnitsProp,
  variant = "kaigo",
}: {
  row: UserSeikyuRow;
  officeName: string | null;
  officeNumber: string | null;
  officeAddress: string | null;
  officePhone: string | null;
  officePostal: string | null;
  reiwa: number;
  month: number;
  /**
   * 様式の切替。
   *   "kaigo"  (既定) = 様式第二   居宅サービス・地域密着型サービス介護給付費明細書 (7131)
   *   "sougou"        = 様式第二の三 介護予防・日常生活支援総合事業費請求明細書 (71R1)
   * 桝の構成は共通で、標題・⑤状態区分・⑦計画・⑩請求額の呼称・サービス種類コードが変わる。
   */
  variant?: "kaigo" | "sougou";
  /**
   * ⑥限度額管理対象外単位数 (初回加算・緊急時訪問介護加算等の告示対象外 + 処遇改善)。
   * 指定時は ⑤限度額管理対象単位数 = 総単位数 − この値 で計算する。
   * 未指定時は従来値 (⑤=row.baseUnits / ⑥=row.addonUnits) — 既存呼出互換。
   */
  kanriTaishougaiUnits?: number;
  /** ④計画単位数 (kaigo_monthly_plan_units 等の計画値)。未指定時は従来値 (総単位数) */
  planUnits?: number;
}) {
  const isSougou = variant === "sougou";
  // ①サービス種類コード／②名称。
  //   介護給付 (様式第二) は訪問介護固定 (11)。
  //   総合事業 (様式第二の三) はサービスコード先頭 2 桁 (A2/A3 等) を明細から取る。
  const svcKind = isSougou
    ? (() => {
        for (const d of row.details) {
          const k = d.service_code
            ? splitSougouCode(d.service_code)?.kind
            : null;
          if (k) return k;
        }
        return "A2";
      })()
    : "11";
  const svcKindName = isSougou
    ? SOUGOU_KIND_NAMES[svcKind] ?? "訪問型サービス"
    : "訪問介護";

  // 給付率 = 100 - 利用者負担割合(%)。copay_rate は分数 (0.1/0.2/0.3) で保持されている
  // (aggregate.ts: raw>=1 は /10 済み)。したがって給付率 = round((1 - copay_rate) * 100)。
  // 公費単独 (被保険者番号 H = 生保 10割公費) は保険給付なし → 保険給付率は空欄、
  // 公費給付率 100。集計欄は保険請求額 0 / 公費請求額 = 総費用 10割 (aggregate 済)。
  const kyufuRate = row.kohiTandoku ? null : Math.round((1 - row.copay_rate) * 100);
  const hasKohi = row.kohiTandoku || (!!row.kohiHobetsu && !!(row.kohiAmount ?? 0));
  // 公費2 (複数公費の併用: 保険 → 公費1 → 公費2 → 本人 のカスケード)。
  // 公式の紙様式は公費欄 1 組のため、公費2 は各欄に併記する (公費2なしは従来表示のまま)
  const hasKohi2 = !!row.kohi2Hobetsu && !!(row.kohi2Amount ?? 0);
  // 併記用の小書きスタイル
  const kohi2Note: React.CSSProperties = {
    display: "block",
    fontSize: "5.5pt",
    color: "#000",
    whiteSpace: "nowrap",
  };

  // 生年月日 (元号 + 年月日桝) / 性別
  const birth = warekiParts(row.birthDate);
  const genderIndex = row.gender?.includes("男")
    ? 1
    : row.gender?.includes("女")
      ? 2
      : null;

  // 明細行 (基本サービス + 加算) を 様式第二 の明細情報レコードに対応させる
  const detailLines: {
    name: string;
    code: string | null;
    unit: number | null;
    count: number;
    units: number;
    tekiyo: string;
  }[] = row.details.map((d) => ({
    name: d.service_type,
    code: d.service_code,
    unit: d.unit_per,
    count: d.count,
    units: d.units,
    tekiyo: "",
  }));
  if (row.addonUnits > 0) {
    detailLines.push({
      name: row.addonLabel ?? "処遇改善加算",
      code: row.addonCode,
      unit: null,
      count: 1,
      units: row.addonUnits,
      tekiyo: "",
    });
  }
  // 明細欄は最低 6 行 (空行で枠を埋める) — 公式様式の桝目再現。A4 1枚に収める
  const MIN_ROWS = 6;
  const emptyRows = Math.max(0, MIN_ROWS - detailLines.length);

  // 集計欄の数値 (⑫)
  // ④計画単位数 = props 指定時は計画値、未指定は従来値 (総単位数)
  const planUnits = planUnitsProp ?? row.totalUnits;
  // ⑥限度額管理対象外単位数 = props 指定時は告示対象外加算 (初回・緊急時等) + 処遇改善、
  //   未指定は従来値 (処遇改善のみ)。⑤ = 総単位数 − ⑥。
  const kanriGaiUnits = kanriTaishougaiUnits ?? row.addonUnits;
  const kanriUnits =
    kanriTaishougaiUnits != null ? row.totalUnits - kanriTaishougaiUnits : row.baseUnits;
  const kyufuUnits = row.totalUnits; // ⑦給付単位数 (④⑤の少ない方 + ⑥)

  // 給付費明細欄の共通ヘッダ style
  const th: React.CSSProperties = {
    border: "0.5pt solid #000",
    padding: "0.8mm",
    fontSize: "7pt",
    fontWeight: "normal",
    textAlign: "center",
    lineHeight: 1.15,
    verticalAlign: "middle",
  };

  return (
    <div
      className="meisai-print-sheet"
      style={{
        padding: "4mm 5mm",
        fontFamily: '"MS Mincho","ＭＳ 明朝","游明朝",serif',
        color: "#000",
        fontSize: "8pt",
        lineHeight: 1.3,
        width: "210mm",
        maxWidth: "210mm",
        boxSizing: "border-box",
        breakInside: "avoid",
        pageBreakInside: "avoid",
      }}
    >
      {/* 様式第二の印刷制御: A4 縦・余白 0 (幅は div の 210mm + 内 padding で確保)。
          1 名 = 1 枚。各 sheet の直後で改ページするが、最後の 1 枚の後には
          空白ページを作らない (:last-child は改ページ抑止)。テーブルは途中で
          割れない (break-inside:avoid)。共有コンポーネントなので caller 側の
          印刷ラッパに依存せず、この style を自前で持つ。
          zoom 0.96: 全高が A4 297mm をわずかに超え、末尾の「枚目」ボックスが
          2 ページ目に落ちるため印刷時のみ全体を縮小して 1 枚に収める。 */}
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 0; }
          .meisai-print-sheet { page-break-after: always; break-after: page; zoom: 0.96; }
          .meisai-print-sheet:last-child { page-break-after: auto; break-after: auto; }
          .meisai-print-sheet table { page-break-inside: avoid; break-inside: avoid; }
        }
      `}</style>
      {/* ── 標題行 (様式第二 右上) ── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: "1.5mm",
        }}
      >
        <div style={{ width: "20%" }} />
        <div style={{ textAlign: "center", flex: 1 }}>
          <div
            style={{
              fontSize: "10.5pt",
              fontWeight: "bold",
              letterSpacing: "1pt",
            }}
          >
            {isSougou
              ? "介護予防・日常生活支援総合事業費請求明細書"
              : "居宅サービス・地域密着型サービス介護給付費明細書"}
          </div>
          <div style={{ fontSize: "6.5pt", marginTop: "0.5mm" }}>
            {isSougou ? (
              "（予防サービス費・生活支援サービス費）"
            ) : (
              <>
                （訪問介護・訪問入浴介護・訪問看護・訪問リハ・居宅療養管理指導・通所介護・通所リハ・福祉用具貸与・
                <br />
                夜間対応型訪問介護・認知症対応型通所介護・小規模多機能型居宅介護）
              </>
            )}
          </div>
        </div>
        <div
          style={{
            width: "20%",
            textAlign: "right",
            fontSize: "11pt",
            fontWeight: "bold",
          }}
        >
          {isSougou ? "様式第二の三" : "様式第二"}
        </div>
      </div>

      {/* ── 最上段: ①提供年月 / ③保険者番号 (右上) / ②公費番号 (左) ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
        }}
      >
        <tbody>
          <tr>
            {/* 左: ② 公費番号 */}
            <td
              style={{
                width: "58%",
                border: "0.5pt solid #000",
                padding: "1mm",
                verticalAlign: "top",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "1.5mm" }}
              >
                <Circle n="②" />
                <span style={{ width: "26mm", fontSize: "7.5pt" }}>
                  公費負担者番号
                </span>
                <DigitCells value={row.kohiFutanshaNumber ?? ""} cells={8} cw={5} />
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1.5mm",
                  marginTop: "1.5mm",
                }}
              >
                <span style={{ width: "5mm" }} />
                <span style={{ width: "26mm", fontSize: "7.5pt" }}>
                  公費受給者番号
                </span>
                <DigitCells value={row.kohiJukyushaNumber ?? ""} cells={7} cw={5} />
              </div>
              {hasKohi2 && (
                /* 公費2 (複数公費の併用)。紙様式に公費2欄が無いため小書きで併記 */
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "1.5mm",
                    marginTop: "1.5mm",
                    fontSize: "6.5pt",
                  }}
                >
                  <span style={{ width: "26mm" }}>
                    公費2 負担者／受給者
                  </span>
                  <DigitCells value={row.kohi2FutanshaNumber ?? ""} cells={8} cw={4} />
                  <span>／</span>
                  <DigitCells value={row.kohi2JukyushaNumber ?? ""} cells={7} cw={4} />
                </div>
              )}
            </td>
            {/* 右: ① 提供年月 + ③ 保険者番号 */}
            <td
              style={{
                width: "42%",
                border: "0.5pt solid #000",
                padding: "1mm",
                verticalAlign: "top",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "1.5mm" }}
              >
                <Circle n="①" />
                <span style={{ fontSize: "8pt" }}>令和</span>
                <DigitCells
                  value={String(reiwa).padStart(2, "0")}
                  cells={2}
                  cw={5}
                />
                <span style={{ fontSize: "8pt" }}>年</span>
                <DigitCells
                  value={String(month).padStart(2, "0")}
                  cells={2}
                  cw={5}
                />
                <span style={{ fontSize: "8pt" }}>月分</span>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1.5mm",
                  marginTop: "1.5mm",
                }}
              >
                <Circle n="③" />
                <span style={{ fontSize: "8pt" }}>保険者番号</span>
                <DigitCells value={row.insurer_number ?? ""} cells={6} cw={5} />
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── ④被保険者 (左) / ⑥請求事業者 (右) ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "33%" }} />
          <col style={{ width: "5%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "33%" }} />
        </colgroup>
        <tbody>
          {/* 被保険者番号 / 事業所番号 */}
          <tr>
            <Lb
              rowSpan={5}
              style={{ writingMode: "vertical-rl", letterSpacing: "1pt" }}
            >
              <Circle n="④" />
              <span style={{ marginTop: "1mm" }}>被保険者</span>
            </Lb>
            <Lb>
              被保険者
              <br />
              番号
            </Lb>
            <Vc>
              <DigitCells value={row.insured_number ?? ""} cells={10} cw={6} />
            </Vc>
            <Lb
              rowSpan={5}
              style={{ writingMode: "vertical-rl", letterSpacing: "1pt" }}
            >
              <Circle n="⑥" />
              <span style={{ marginTop: "1mm" }}>請求事業者</span>
            </Lb>
            <Lb>
              事業所
              <br />
              番号
            </Lb>
            <Vc>
              <DigitCells value={officeNumber ?? ""} cells={10} cw={6} />
            </Vc>
          </tr>
          {/* フリガナ / 事業所名称 */}
          <tr>
            <Lb>（フリガナ）</Lb>
            <Vc style={{ fontSize: "7pt", height: "4mm" }}>
              {row.user_name_kana ?? ""}
            </Vc>
            <Lb rowSpan={2}>
              事業所
              <br />
              名称
            </Lb>
            <Vc
              rowSpan={2}
              style={{
                fontWeight: "bold",
                fontSize: "9pt",
                verticalAlign: "middle",
              }}
            >
              {officeName ?? ""}
            </Vc>
          </tr>
          {/* 氏名 / (事業所名称 続き) */}
          <tr>
            <Lb>氏名</Lb>
            <Vc style={{ fontWeight: "bold", fontSize: "10pt" }}>
              {row.user_name}
            </Vc>
          </tr>
          {/* 生年月日・性別 / 所在地 */}
          <tr>
            <Lb>
              生年月日
              <br />
              性別
            </Lb>
            <Vc>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1mm",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: "6.5pt" }}>
                  1.明治 2.大正 3.昭和 4.平成 5.令和
                </span>
                {birth.gengoIndex != null && (
                  <span style={{ fontSize: "7pt", fontWeight: "bold" }}>
                    〔{birth.gengoIndex}〕
                  </span>
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5mm",
                  marginTop: "0.5mm",
                }}
              >
                <DigitCells value={birth.y} cells={2} cw={4} h={5} />
                <span>年</span>
                <DigitCells value={birth.m} cells={2} cw={4} h={5} />
                <span>月</span>
                <DigitCells value={birth.d} cells={2} cw={4} h={5} />
                <span>日</span>
                <span style={{ marginLeft: "1.5mm", fontSize: "7pt" }}>
                  性別 {genderIndex === 1 ? "〔1〕男" : "1.男"}{" "}
                  {genderIndex === 2 ? "〔2〕女" : "2.女"}
                </span>
              </div>
            </Vc>
            <Lb rowSpan={2}>所在地</Lb>
            <Vc
              rowSpan={2}
              style={{ fontSize: "7.5pt", verticalAlign: "top" }}
            >
              <div>〒{officePostal ?? ""}</div>
              <div style={{ marginTop: "0.5mm" }}>{officeAddress ?? ""}</div>
              <div style={{ marginTop: "1mm" }}>
                連絡先　電話番号　{officePhone ?? ""}
              </div>
            </Vc>
          </tr>
          {/* ⑤要介護状態区分 (被保険者ブロック内) */}
          <tr>
            <Lb>
              <Circle n="⑤" />
              <br />
              {isSougou ? (
                <>
                  事業対象者
                  <br />
                  要支援状態区分
                </>
              ) : (
                <>
                  要介護
                  <br />
                  状態区分
                </>
              )}
            </Lb>
            <Vc style={{ fontSize: "7.5pt" }}>
              {isSougou ? "事業対象者・要支援" : "経過的要介護・要介護"}{" "}
              <span style={{ fontWeight: "bold", fontSize: "9pt" }}>
                {row.care_level ?? ""}
              </span>
            </Vc>
          </tr>
          {/* 認定有効期間 (被保険者ブロック直下、全幅) */}
          <tr>
            <Lb colSpan={2}>
              認定有効
              <br />
              期間
            </Lb>
            <Vc colSpan={4} style={{ padding: "1mm" }}>
              <div>
                <CertDateRow iso={row.certStart} suffix="から" />
              </div>
              <div style={{ marginTop: "1mm" }}>
                <CertDateRow iso={row.certEnd} suffix="まで" />
              </div>
            </Vc>
          </tr>
        </tbody>
      </table>

      {/* ── ⑦居宅サービス計画 ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "50%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "21%" }} />
        </colgroup>
        <tbody>
          <tr>
            <Lb
              rowSpan={2}
              style={{ writingMode: "vertical-rl", letterSpacing: "1pt" }}
            >
              <Circle n="⑦" />
              <span style={{ marginTop: "1mm" }}>
                {isSougou ? "介護予防サービス・支援計画" : "居宅サービス計画"}
              </span>
            </Lb>
            <Lb colSpan={4} style={{ textAlign: "left", fontSize: "7.5pt" }}>
              {isSougou
                ? "1. 地域包括支援センター作成　　2. 被保険者自己作成"
                : "1. 居宅介護支援事業者作成　　2. 被保険者自己作成"}
            </Lb>
          </tr>
          <tr>
            <Lb>
              事業所
              <br />
              番号
            </Lb>
            <Vc>
              <DigitCells value={row.careOfficeNumber ?? ""} cells={10} cw={6} />
            </Vc>
            <Lb>
              事業所
              <br />
              名称
            </Lb>
            <Vc></Vc>
          </tr>
        </tbody>
      </table>

      {/* ── ⑧開始・中止年月日 / ⑨中止理由 ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "36%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "35%" }} />
        </colgroup>
        <tbody>
          <tr>
            <Lb>
              <Circle n="⑧" />
            </Lb>
            <Lb>
              開始
              <br />
              年月日
            </Lb>
            <Vc style={{ fontSize: "7pt" }}>
              <CertDateRow iso={null} suffix="" />
            </Vc>
            <Lb>
              <Circle n="⑨" />
              中止
              <br />
              年月日
            </Lb>
            <Vc style={{ fontSize: "7pt" }}>
              <CertDateRow iso={null} suffix="" />
            </Vc>
          </tr>
          <tr>
            <Lb colSpan={2}>
              中止
              <br />
              理由
            </Lb>
            <Vc colSpan={3} style={{ fontSize: "6.5pt" }}>
              1.非該当　3.医療機関入院　4.死亡　5.その他　6.介護老人福祉施設入所　7.介護老人保健施設入所　8.介護療養型医療施設入院
            </Vc>
          </tr>
        </tbody>
      </table>

      {/* ── ⑩給付費明細欄 ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "24%" }} />
          <col style={{ width: "13%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "7%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "10%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...th }} rowSpan={2}>
              <Circle n="⑩" />
              <br />
              給付費明細欄
            </th>
            <th style={{ ...th }}>サービス内容</th>
            <th style={{ ...th }}>サービスコード</th>
            <th style={{ ...th }}>単位数</th>
            <th style={{ ...th }}>回数</th>
            <th style={{ ...th }}>
              サービス
              <br />
              単位数
            </th>
            <th style={{ ...th }}>
              公費分
              <br />
              回数
            </th>
            <th style={{ ...th }}>
              公費対象
              <br />
              単位数
            </th>
            <th style={{ ...th }}>摘要</th>
          </tr>
        </thead>
        <tbody>
          {detailLines.map((d, i) => (
            <tr key={`${d.code ?? d.name}-${i}`}>
              {i === 0 && (
                <td
                  rowSpan={detailLines.length + emptyRows}
                  style={{ border: "0.5pt solid #000" }}
                />
              )}
              <Vc style={{ fontSize: "7.5pt" }}>{d.name}</Vc>
              <Vc style={{ padding: 0 }}>
                <DigitCells value={d.code ?? ""} cells={6} cw={3.5} h={5} />
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {d.unit != null ? d.unit.toLocaleString() : ""}
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {d.count}
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {d.units.toLocaleString()}
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {hasKohi ? d.count : ""}
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {hasKohi ? d.units.toLocaleString() : ""}
              </Vc>
              <Vc style={{ ...CT, fontSize: "7pt" }}>{d.tekiyo}</Vc>
            </tr>
          ))}
          {Array.from({ length: emptyRows }).map((_, i) => (
            <tr key={`empty-${i}`} style={{ height: "4.7mm" }}>
              <Vc></Vc>
              <Vc style={{ padding: 0 }}>
                <DigitCells value="" cells={6} cw={3.5} h={5} />
              </Vc>
              <Vc></Vc>
              <Vc></Vc>
              <Vc></Vc>
              <Vc></Vc>
              <Vc></Vc>
              <Vc></Vc>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── ⑫請求額集計欄 (+ ⑬給付率) ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "29%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "22%" }} />
        </colgroup>
        <tbody>
          {/* ① サービス種類コード / 名称 */}
          <tr>
            <Lb
              rowSpan={13}
              style={{ writingMode: "vertical-rl", letterSpacing: "1pt" }}
            >
              <Circle n="⑫" />
              <span style={{ marginTop: "1mm" }}>請求額集計欄</span>
            </Lb>
            <AggLb>①サービス種類コード／②名称</AggLb>
            <AggVc style={{ textAlign: "left", fontFamily: "inherit" }}>
              <span
                style={{
                  fontFamily: '"MS Gothic",monospace',
                  fontWeight: "bold",
                }}
              >
                {svcKind}
              </span>{" "}
              {svcKindName}
            </AggVc>
            <AggVc style={{ textAlign: "center" }} />
            <AggVc style={{ textAlign: "left", verticalAlign: "bottom" }}>
              <span style={{ fontSize: "7pt" }}>
                <Circle n="⑬" /> 給付率（/100）
              </span>
            </AggVc>
          </tr>
          {/* ③ サービス実日数 */}
          <tr>
            <AggLb>③サービス実日数</AggLb>
            <AggVc>
              {row.serviceDays} <span style={{ fontSize: "7pt" }}>日</span>
            </AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left" }} />
          </tr>
          {/* ④ 計画単位数 */}
          <tr>
            <AggLb>④計画単位数</AggLb>
            <AggVc>{planUnits.toLocaleString()}</AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left" }} />
          </tr>
          {/* ⑤ 限度額管理対象単位数 */}
          <tr>
            <AggLb>⑤限度額管理対象単位数</AggLb>
            <AggVc>{kanriUnits.toLocaleString()}</AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left" }} />
          </tr>
          {/* ⑥ 限度額管理対象外単位数 */}
          <tr>
            <AggLb>⑥限度額管理対象外単位数</AggLb>
            <AggVc>{kanriGaiUnits ? kanriGaiUnits.toLocaleString() : ""}</AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left" }} />
          </tr>
          {/* ⑦ 給付単位数 */}
          <tr>
            <AggLb>⑦給付単位数（④⑤のうち少ない数）＋⑥</AggLb>
            <AggVc>{kyufuUnits.toLocaleString()}</AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left", padding: "0.6mm 1.5mm" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: "7pt" }}>保険</span>
                <span
                  style={{
                    fontFamily: '"MS Gothic",monospace',
                    fontWeight: "bold",
                  }}
                >
                  {kyufuRate ?? ""}
                </span>
              </div>
            </AggVc>
          </tr>
          {/* ⑧ 公費分単位数 (公費2は併記 — 伝送 集計(21) 対応値) */}
          <tr>
            <AggLb>⑧公費分単位数</AggLb>
            <AggVc>
              {hasKohi ? (row.kohiUnits ?? 0).toLocaleString() : ""}
              {hasKohi2 && (
                <span style={kohi2Note}>
                  公費2: {(row.kohi2Units ?? 0).toLocaleString()}
                </span>
              )}
            </AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: "7pt" }}>公費{hasKohi2 ? "1/2" : ""}</span>
                <span
                  style={{
                    fontFamily: '"MS Gothic",monospace',
                    fontWeight: "bold",
                  }}
                >
                  {hasKohi ? (hasKohi2 ? "100/100" : "100") : ""}
                </span>
              </div>
            </AggVc>
          </tr>
          {/* ⑨ 単位数単価 */}
          <tr>
            <AggLb>⑨単位数単価</AggLb>
            <AggVc>
              {row.unitPrice.toFixed(2)}{" "}
              <span style={{ fontSize: "7pt" }}>円/単位</span>
            </AggVc>
            <AggVc />
            <AggVc style={{ textAlign: "left" }}>
              <span style={{ fontSize: "7pt" }}>合計</span>
            </AggVc>
          </tr>
          {/* ⑩ 保険請求額 (総合事業は「事業費請求額」— 7113 の呼称に合わせる) */}
          <tr>
            <AggLb>{isSougou ? "⑩事業費請求額" : "⑩保険請求額"}</AggLb>
            <AggVc style={{ fontWeight: "bold" }}>
              {row.insuranceAmount.toLocaleString()}
            </AggVc>
            <AggVc />
            <AggVc>{row.insuranceAmount.toLocaleString()}</AggVc>
          </tr>
          {/* ⑪ 利用者負担額 */}
          <tr>
            <AggLb>⑪利用者負担額</AggLb>
            <AggVc>{row.userAmount.toLocaleString()}</AggVc>
            <AggVc />
            <AggVc>{row.userAmount.toLocaleString()}</AggVc>
          </tr>
          {/* ⑫ 公費請求額 (公費2は併記 — 伝送 集計(22) 対応値) */}
          <tr>
            <AggLb>⑫公費請求額</AggLb>
            <AggVc>
              {hasKohi ? (row.kohiAmount ?? 0).toLocaleString() : ""}
              {hasKohi2 && (
                <span style={kohi2Note}>
                  公費2: {(row.kohi2Amount ?? 0).toLocaleString()}
                </span>
              )}
            </AggVc>
            <AggVc />
            <AggVc>
              {hasKohi ? (row.kohiAmount ?? 0).toLocaleString() : ""}
              {hasKohi2 && (
                <span style={kohi2Note}>
                  公費2: {(row.kohi2Amount ?? 0).toLocaleString()}
                </span>
              )}
            </AggVc>
          </tr>
          {/* ⑬ 公費分本人負担 (本人負担上限月額の適用分。生保の既定 = 0。公費2は併記) */}
          <tr>
            <AggLb>⑬公費分本人負担</AggLb>
            <AggVc>
              {hasKohi ? (row.kohiHonninFutan ?? 0).toLocaleString() : ""}
              {hasKohi2 && (
                <span style={kohi2Note}>
                  公費2: {(row.kohi2HonninFutan ?? 0).toLocaleString()}
                </span>
              )}
            </AggVc>
            <AggVc />
            <AggVc>
              {hasKohi ? (row.kohiHonninFutan ?? 0).toLocaleString() : ""}
              {hasKohi2 && (
                <span style={kohi2Note}>
                  公費2: {(row.kohi2HonninFutan ?? 0).toLocaleString()}
                </span>
              )}
            </AggVc>
          </tr>
        </tbody>
      </table>

      {/* ── ⑮社会福祉法人等軽減欄 ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "27%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "20%" }} />
        </colgroup>
        <tbody>
          <tr>
            <Lb
              rowSpan={6}
              style={{ writingMode: "vertical-rl", letterSpacing: "0.5pt" }}
            >
              <Circle n="⑮" />
              <span style={{ marginTop: "1mm" }}>社会福祉法人等による軽減欄</span>
            </Lb>
            <Lb colSpan={2}>軽減率</Lb>
            <Vc
              style={{
                textAlign: "right",
                fontFamily: '"MS Gothic",monospace',
              }}
            >
              <span style={{ fontSize: "7pt" }}>％</span>
            </Vc>
            <Lb>軽減額</Lb>
            <Lb>備考</Lb>
          </tr>
          {(isSougou
            ? [
                { code: "A2", label: "訪問型サービス（独自）" },
                { code: "A3", label: "訪問型サービス（独自／定率）" },
                { code: "A6", label: "通所型サービス（独自）" },
                { code: "A7", label: "通所型サービス（独自／定率）" },
                { code: "AF", label: "介護予防ケアマネジメント" },
              ]
            : [
                { code: "11", label: "訪問介護" },
                { code: "15", label: "通所介護" },
                { code: "71", label: "夜間対応型訪問介護" },
                { code: "72", label: "認知症対応型通所介護" },
                { code: "73", label: "小規模多機能型居宅介護" },
              ]
          ).map((s) => (
            <tr key={s.code}>
              <Vc style={{ ...CT, fontFamily: '"MS Gothic",monospace' }}>
                {s.code}
              </Vc>
              <Vc style={{ fontSize: "7.5pt" }}>{s.label}</Vc>
              <Vc />
              <Vc />
              <Vc />
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── 枚数 (右下) ── */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginTop: "1.5mm",
        }}
      >
        <table style={{ borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <Vc
                style={{
                  ...CT,
                  width: "8mm",
                  fontFamily: '"MS Gothic",monospace',
                }}
              >
                1
              </Vc>
              <Vc style={{ ...CT, width: "12mm", fontSize: "7pt" }}>枚目</Vc>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
