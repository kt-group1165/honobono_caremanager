"use client";

/**
 * 主治医意見書 (全国共通様式)
 *
 *   ほのぼの NEXT の ケアマネ → 主治医意見書 と同じものを入力・印刷できるようにする。
 *   医師が書いた意見書をケアマネが転記して保管する使い方 (実際に使っている人がいる)。
 *
 * ⚠ 帳票は kaigo_report_documents (report_type = "shujii-iken") の content JSON に入る。
 *   他の帳票と同じ入れ物なので、保存・印刷・版管理はそのまま使える。
 *
 * ⚠ 様式は **国が定めた固定様式**。項目を勝手に足したり並べ替えたりしない。
 *   ほのぼのは「意見書①/②」の 2 画面に分けているが、様式としては 1 枚なので
 *   こちらは節ごとに折りたたむ形にする。
 */

import React from "react";

// ─── 選択肢 (様式どおり) ────────────────────────────────────────────────

const SHINRYOUKA = [
  "内科", "精神科", "外科", "整形外科",
  "脳神経外科", "皮膚科", "泌尿器科", "婦人科",
  "眼科", "耳鼻咽喉科", "リハビリテーション科", "歯科",
] as const;

/** 2. 特別な医療 (過去14日間以内に受けた医療のすべて) */
const TOKUBETSU_IRYOU = {
  処置内容: ["点滴の管理", "中心静脈栄養", "透析", "ストーマの処置", "酸素療法",
    "レスピレーター", "気管切開の処置", "疼痛の看護", "経管栄養"],
  特別な対応: ["モニター測定（血圧、心拍、酸素飽和度等）", "褥瘡の処置"],
  失禁への対応: ["カテーテル（コンドームカテーテル、留置カテーテル等）"],
} as const;

const SHOUGAI_JIRITSUDO = ["自立", "J1", "J2", "A1", "A2", "B1", "B2", "C1", "C2"] as const;
const NINCHI_JIRITSUDO = ["自立", "Ⅰ", "Ⅱa", "Ⅱb", "Ⅲa", "Ⅲb", "Ⅳ", "M"] as const;

/** 3-(3) 認知症の周辺症状 */
const SHUUHEN = ["幻視・幻聴", "妄想", "昼夜逆転", "暴言", "暴行", "介護への抵抗",
  "徘徊", "火の不始末", "不潔行為", "異食行動", "性的問題行動", "その他"] as const;

/** 3-(5) 身体の状態 */
const MAHI = ["右上肢", "左上肢", "右下肢", "左下肢", "その他"] as const;
const MAHI_DEGREE = ["軽", "中", "重"] as const;
const SHINTAI_ETC = ["筋力の低下", "関節の拘縮", "関節の痛み", "失調・不随意運動",
  "褥瘡", "その他の皮膚疾患"] as const;

/** 4-(3) 現在あるか今後発生の可能性の高い状態 */
const RISK = ["尿失禁", "転倒・骨折", "移動能力の低下", "褥瘡", "心肺機能の低下",
  "閉じこもり", "意欲低下", "徘徊", "低栄養", "摂食・嚥下機能低下", "脱水",
  "易感染性", "がん等による疼痛", "その他"] as const;

/** 4-(5) 医学的管理の必要性 */
const IGAKU_KANRI = ["訪問診療", "訪問看護", "看護職員の訪問による相談・支援",
  "訪問歯科診療", "訪問薬剤管理指導", "訪問リハビリテーション",
  "短期入所療養介護", "訪問歯科衛生指導", "訪問栄養食事指導",
  "通所リハビリテーション", "その他の医療系サービス"] as const;

/** 4-(6) サービス提供時の医学的観点からの留意事項 */
const RYUUI = ["血圧", "摂食", "嚥下", "移動", "運動", "その他"] as const;


// ⚠ 内部でコンポーネントを定義すると毎レンダーで別物になって state が飛ぶ
//   (react-hooks/static-components)。モジュール直下に置く。

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] items-start gap-2 py-1">
      <label className="pt-1.5 text-xs font-medium text-gray-600">{label}</label>
      <div>{children}</div>
    </div>
  );
}

function Sec({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details open className="rounded-lg border bg-white">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-gray-800">{title}</summary>
      <div className="border-t px-3 py-2">{children}</div>
    </details>
  );
}

const FIELD = "w-full rounded-lg border px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

function T({ v, onChange, ph }: { v: string; onChange: (s: string) => void; ph?: string }) {
  return <input value={v} onChange={(e) => onChange(e.target.value)} placeholder={ph} className={FIELD} />;
}

function TA({ v, onChange, rows = 3 }: { v: string; onChange: (s: string) => void; rows?: number }) {
  return <textarea value={v} onChange={(e) => onChange(e.target.value)} rows={rows} className={FIELD} />;
}

function Radio({ v, onChange, opts }: { v: string; onChange: (s: string) => void; opts: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-3">
      {opts.map((o) => (
        <label key={o} className="flex items-center gap-1 text-sm text-gray-700">
          <input type="radio" checked={v === o} onChange={() => onChange(o)} />
          {o}
        </label>
      ))}
    </div>
  );
}

function Checks({ picked, onToggle, opts }: {
  picked: string[]; onToggle: (s: string) => void; opts: readonly string[];
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {opts.map((o) => (
        <label key={o} className="flex items-center gap-1 text-sm text-gray-700">
          <input type="checkbox" checked={picked.includes(o)} onChange={() => onToggle(o)} />
          {o}
        </label>
      ))}
    </div>
  );
}

// ─── 入力フォーム ────────────────────────────────────────────────────────

type C = Record<string, unknown>;

export function EditFormShujiiIken({ content, onChange }: {
  content: C; onChange: (c: C) => void;
}) {
  const s = (k: string) => String(content[k] ?? "");
  const set = (k: string, v: unknown) => onChange({ ...content, [k]: v });
  const arr = (k: string): string[] => (Array.isArray(content[k]) ? (content[k] as string[]) : []);
  const toggle = (k: string, v: string) => {
    const cur = arr(k);
    set(k, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  };

  return (
    <div className="space-y-2 p-4">
      <Sec title="主治医・基本">
        <Row label="同意">
          <Radio v={s("consent")} onChange={(x) => set("consent", x)} opts={["同意する", "同意しない"]} />
        </Row>
        <Row label="医師氏名"><T v={s("doctor_name")} onChange={(x) => set("doctor_name", x)} /></Row>
        <Row label="医療機関名"><T v={s("clinic_name")} onChange={(x) => set("clinic_name", x)} /></Row>
        <Row label="医療機関所在地"><T v={s("clinic_address")} onChange={(x) => set("clinic_address", x)} /></Row>
        <Row label="電話 / FAX">
          <div className="flex gap-2"><T v={s("clinic_tel")} onChange={(x) => set("clinic_tel", x)} ph="電話" /><T v={s("clinic_fax")} onChange={(x) => set("clinic_fax", x)} ph="FAX" /></div>
        </Row>
        <Row label="(1) 最終診察日"><T v={s("last_exam_date")} onChange={(x) => set("last_exam_date", x)} ph="R 8/ 1/31" /></Row>
        <Row label="(2) 意見書作成回数"><Radio v={s("write_count")} onChange={(x) => set("write_count", x)} opts={["初回", "2回目以上"]} /></Row>
        <Row label="(3) 他科受診の有無"><Radio v={s("other_dept")} onChange={(x) => set("other_dept", x)} opts={["有", "無"]} /></Row>
        {s("other_dept") === "有" && (
          <>
            <Row label="　受診科"><Checks picked={arr("other_dept_list")} onToggle={(x) => toggle("other_dept_list", x)} opts={SHINRYOUKA} /></Row>
            <Row label="　その他"><T v={s("other_dept_other")} onChange={(x) => set("other_dept_other", x)} /></Row>
          </>
        )}
      </Sec>

      <Sec title="1. 傷病に関する意見">
        <Row label="(1) 診断名 1"><div className="flex gap-2"><T v={s("dx1")} onChange={(x) => set("dx1", x)} /><T v={s("dx1_date")} onChange={(x) => set("dx1_date", x)} ph="発症年月日" /></div></Row>
        <Row label="　　　　　 2"><div className="flex gap-2"><T v={s("dx2")} onChange={(x) => set("dx2", x)} /><T v={s("dx2_date")} onChange={(x) => set("dx2_date", x)} ph="発症年月日" /></div></Row>
        <Row label="　　　　　 3"><div className="flex gap-2"><T v={s("dx3")} onChange={(x) => set("dx3", x)} /><T v={s("dx3_date")} onChange={(x) => set("dx3_date", x)} ph="発症年月日" /></div></Row>
        <Row label="(2) 症状の安定性"><Radio v={s("stability")} onChange={(x) => set("stability", x)} opts={["安定", "不安定", "不明"]} /></Row>
        <Row label="　不安定の場合"><TA v={s("stability_note")} onChange={(x) => set("stability_note", x)} rows={2} /></Row>
        <Row label="(3) 経過・治療内容"><TA v={s("course_treatment")} onChange={(x) => set("course_treatment", x)} rows={4} /></Row>
      </Sec>

      <Sec title="2. 特別な医療 (過去14日間以内に受けた医療のすべて)">
        {Object.entries(TOKUBETSU_IRYOU).map(([g, opts]) => (
          <Row key={g} label={g}><Checks picked={arr("special_care")} onToggle={(x) => toggle("special_care", x)} opts={opts} /></Row>
        ))}
      </Sec>

      <Sec title="3. 心身の状態に関する意見">
        <Row label="障害高齢者の自立度"><Radio v={s("adl_level")} onChange={(x) => set("adl_level", x)} opts={SHOUGAI_JIRITSUDO} /></Row>
        <Row label="認知症高齢者の自立度"><Radio v={s("dementia_level")} onChange={(x) => set("dementia_level", x)} opts={NINCHI_JIRITSUDO} /></Row>
        <Row label="短期記憶"><Radio v={s("short_memory")} onChange={(x) => set("short_memory", x)} opts={["問題なし", "問題あり"]} /></Row>
        <Row label="意思決定の認知能力"><Radio v={s("decision")} onChange={(x) => set("decision", x)} opts={["自立", "いくらか困難", "見守りが必要", "判断できない"]} /></Row>
        <Row label="意思の伝達能力"><Radio v={s("communication")} onChange={(x) => set("communication", x)} opts={["伝えられる", "いくらか困難", "具体的要求に限られる", "伝えられない"]} /></Row>
        <Row label="(3) 周辺症状"><Radio v={s("bpsd")} onChange={(x) => set("bpsd", x)} opts={["無", "有"]} /></Row>
        {s("bpsd") === "有" && <Row label="　症状"><Checks picked={arr("bpsd_list")} onToggle={(x) => toggle("bpsd_list", x)} opts={SHUUHEN} /></Row>}
        <Row label="(4) その他の精神・神経症状"><Radio v={s("neuro")} onChange={(x) => set("neuro", x)} opts={["無", "有"]} /></Row>
        {s("neuro") === "有" && (
          <>
            <Row label="　症状名"><T v={s("neuro_name")} onChange={(x) => set("neuro_name", x)} /></Row>
            <Row label="　専門医受診"><Radio v={s("neuro_specialist")} onChange={(x) => set("neuro_specialist", x)} opts={["有", "無"]} /></Row>
          </>
        )}
        <Row label="(5) 利き腕 / 身長 / 体重">
          <div className="flex gap-2">
            <select value={s("dominant_hand")} onChange={(e) => set("dominant_hand", e.target.value)}
              className="rounded-lg border px-2 py-1.5 text-sm">
              <option value="">—</option><option value="右">右</option><option value="左">左</option>
            </select>
            <T v={s("height_cm")} onChange={(x) => set("height_cm", x)} ph="身長 cm" /><T v={s("weight_kg")} onChange={(x) => set("weight_kg", x)} ph="体重 kg" />
          </div>
        </Row>
        <Row label="　過去6ヶ月の体重"><Radio v={s("weight_change")} onChange={(x) => set("weight_change", x)} opts={["増加", "維持", "減少"]} /></Row>
        <Row label="　四肢欠損"><Radio v={s("limb_loss")} onChange={(x) => set("limb_loss", x)} opts={["無", "有"]} /></Row>
        <Row label="　麻痺"><Checks picked={arr("paralysis")} onToggle={(x) => toggle("paralysis", x)} opts={MAHI} /></Row>
        <Row label="　麻痺の程度"><Radio v={s("paralysis_degree")} onChange={(x) => set("paralysis_degree", x)} opts={MAHI_DEGREE} /></Row>
        <Row label="　その他の身体状態"><Checks picked={arr("physical_other")} onToggle={(x) => toggle("physical_other", x)} opts={SHINTAI_ETC} /></Row>
      </Sec>

      <Sec title="4. 生活機能とサービスに関する意見">
        <Row label="(1) 屋外歩行"><Radio v={s("walk_outdoor")} onChange={(x) => set("walk_outdoor", x)} opts={["自立", "介助があればしている", "していない"]} /></Row>
        <Row label="　車椅子"><Radio v={s("wheelchair")} onChange={(x) => set("wheelchair", x)} opts={["用いていない", "主に自分で操作している", "主に他人が操作している"]} /></Row>
        <Row label="　歩行補助具・装具"><Radio v={s("walk_aid")} onChange={(x) => set("walk_aid", x)} opts={["用いていない", "屋外で使用", "屋内で使用"]} /></Row>
        <Row label="(2) 食事行為"><Radio v={s("eating")} onChange={(x) => set("eating", x)} opts={["自立ないし何とか自分で食べられる", "全面介助"]} /></Row>
        <Row label="　現在の栄養状態"><Radio v={s("nutrition")} onChange={(x) => set("nutrition", x)} opts={["良好", "不良"]} /></Row>
        <Row label="　栄養・食生活の留意点"><TA v={s("nutrition_note")} onChange={(x) => set("nutrition_note", x)} rows={2} /></Row>
        <Row label="(3) 起こりうる状態"><Checks picked={arr("risks")} onToggle={(x) => toggle("risks", x)} opts={RISK} /></Row>
        <Row label="　対処方針"><TA v={s("risk_plan")} onChange={(x) => set("risk_plan", x)} rows={3} /></Row>
        <Row label="(4) 改善の見通し"><Radio v={s("prognosis")} onChange={(x) => set("prognosis", x)} opts={["期待できる", "期待できない", "不明"]} /></Row>
        <Row label="(5) 医学的管理の必要性"><Checks picked={arr("medical_services")} onToggle={(x) => toggle("medical_services", x)} opts={IGAKU_KANRI} /></Row>
        <Row label="　その他"><T v={s("medical_services_other")} onChange={(x) => set("medical_services_other", x)} /></Row>
        <Row label="(6) 留意事項"><Checks picked={arr("cautions")} onToggle={(x) => toggle("cautions", x)} opts={RYUUI} /></Row>
        <Row label="　具体的な留意事項"><TA v={s("cautions_note")} onChange={(x) => set("cautions_note", x)} rows={3} /></Row>
        <Row label="(7) 感染症の有無"><Radio v={s("infection")} onChange={(x) => set("infection", x)} opts={["無", "有", "不明"]} /></Row>
        <Row label="　感染症名"><T v={s("infection_name")} onChange={(x) => set("infection_name", x)} /></Row>
      </Sec>

      <Sec title="5. 特記すべき事項">
        <TA v={s("remarks")} onChange={(x) => set("remarks", x)} rows={6} />
      </Sec>
    </div>
  );
}

// ─── 印刷ビュー ──────────────────────────────────────────────────────────

const PRINT_BORDER = "1px solid #000";
const PRINT_BOX: React.CSSProperties = { border: PRINT_BORDER, padding: "3px 5px", fontSize: "8pt", verticalAlign: "top" };
const PRINT_HEAD: React.CSSProperties = { ...PRINT_BOX, backgroundColor: "#f0f0f0", fontWeight: "bold", width: "22%" };

/** 様式の 1 行 (見出し + 内容)。内部で定義すると毎レンダー別物になるのでここに置く */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <td style={PRINT_HEAD}>{label}</td>
      <td style={{ ...PRINT_BOX, whiteSpace: "pre-wrap" }}>{children || "　"}</td>
    </tr>
  );
}

export function PrintShujiiIken({ c }: { c: C }) {
  const s = (k: string) => String(c[k] ?? "");
  const arr = (k: string): string[] => (Array.isArray(c[k]) ? (c[k] as string[]) : []);
  const B = "1px solid #000";
  /** 選んだものに ☑、それ以外に □ を付けて様式どおりに並べる */
  const marks = (opts: readonly string[], picked: string[]) =>
    opts.map((o) => `${picked.includes(o) ? "☑" : "□"}${o}`).join("　");
  const pick = (opts: readonly string[], v: string) => marks(opts, v ? [v] : []);

  return (
    <div style={{ fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif', fontSize: "9pt", color: "#000", width: "190mm" }}>
      <div style={{ textAlign: "center", fontSize: "14pt", fontWeight: "bold", letterSpacing: "0.3em", marginBottom: "6px" }}>
        主治医意見書
      </div>
      <div style={{ fontSize: "8pt", marginBottom: "4px" }}>
        主治医として、本意見書が介護サービス計画作成等に利用されることに
        　{pick(["同意する", "同意しない"], s("consent"))}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "6px" }}>
        <tbody>
          <Line label="医師氏名">{s("doctor_name")}</Line>
          <Line label="医療機関名">{s("clinic_name")}</Line>
          <Line label="所在地">{s("clinic_address")}</Line>
          <Line label="電話 / FAX">{[s("clinic_tel"), s("clinic_fax")].filter(Boolean).join("　/　")}</Line>
          <Line label="(1) 最終診察日">{s("last_exam_date")}</Line>
          <Line label="(2) 意見書作成回数">{pick(["初回", "2回目以上"], s("write_count"))}</Line>
          <Line label="(3) 他科受診の有無">
            {pick(["有", "無"], s("other_dept"))}
            {s("other_dept") === "有" && `\n${marks(SHINRYOUKA, arr("other_dept_list"))}${s("other_dept_other") ? `　その他: ${s("other_dept_other")}` : ""}`}
          </Line>
        </tbody>
      </table>

      <div style={{ fontWeight: "bold", fontSize: "9pt", margin: "6px 0 2px" }}>１．傷病に関する意見</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <Line label="(1) 診断名">
            {[["dx1", "dx1_date"], ["dx2", "dx2_date"], ["dx3", "dx3_date"]]
              .map(([n, d], i) => (s(n) ? `${i + 1}. ${s(n)}${s(d) ? `（発症 ${s(d)}）` : ""}` : ""))
              .filter(Boolean).join("\n")}
          </Line>
          <Line label="(2) 症状の安定性">
            {pick(["安定", "不安定", "不明"], s("stability"))}
            {s("stability_note") ? `\n${s("stability_note")}` : ""}
          </Line>
          <Line label="(3) 経過・治療内容">{s("course_treatment")}</Line>
        </tbody>
      </table>

      <div style={{ fontWeight: "bold", fontSize: "9pt", margin: "6px 0 2px" }}>２．特別な医療（過去14日間以内に受けた医療のすべて）</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {Object.entries(TOKUBETSU_IRYOU).map(([g, opts]) => (
            <Line key={g} label={g}>{marks(opts, arr("special_care"))}</Line>
          ))}
        </tbody>
      </table>

      <div style={{ fontWeight: "bold", fontSize: "9pt", margin: "6px 0 2px" }}>３．心身の状態に関する意見</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <Line label="障害高齢者の自立度">{pick(SHOUGAI_JIRITSUDO, s("adl_level"))}</Line>
          <Line label="認知症高齢者の自立度">{pick(NINCHI_JIRITSUDO, s("dementia_level"))}</Line>
          <Line label="短期記憶">{pick(["問題なし", "問題あり"], s("short_memory"))}</Line>
          <Line label="意思決定の認知能力">{pick(["自立", "いくらか困難", "見守りが必要", "判断できない"], s("decision"))}</Line>
          <Line label="意思の伝達能力">{pick(["伝えられる", "いくらか困難", "具体的要求に限られる", "伝えられない"], s("communication"))}</Line>
          <Line label="(3) 周辺症状">
            {pick(["無", "有"], s("bpsd"))}
            {s("bpsd") === "有" && `\n${marks(SHUUHEN, arr("bpsd_list"))}`}
          </Line>
          <Line label="(4) 精神・神経症状">
            {pick(["無", "有"], s("neuro"))}
            {s("neuro") === "有" && `\n${s("neuro_name")}　専門医受診: ${s("neuro_specialist")}`}
          </Line>
          <Line label="(5) 身体の状態">
            {`利き腕 ${s("dominant_hand") || "—"}　身長 ${s("height_cm") || "—"}cm　体重 ${s("weight_kg") || "—"}kg`
              + `　過去6ヶ月の体重: ${s("weight_change") || "—"}`
              + `\n四肢欠損: ${s("limb_loss") || "—"}　麻痺: ${arr("paralysis").join("・") || "無"}`
              + `${s("paralysis_degree") ? `（${s("paralysis_degree")}）` : ""}`
              + `\n${marks(SHINTAI_ETC, arr("physical_other"))}`}
          </Line>
        </tbody>
      </table>

      <div style={{ fontWeight: "bold", fontSize: "9pt", margin: "6px 0 2px" }}>４．生活機能とサービスに関する意見</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <Line label="(1) 移動">
            {`屋外歩行: ${pick(["自立", "介助があればしている", "していない"], s("walk_outdoor"))}`
              + `\n車椅子: ${pick(["用いていない", "主に自分で操作している", "主に他人が操作している"], s("wheelchair"))}`
              + `\n歩行補助具・装具: ${pick(["用いていない", "屋外で使用", "屋内で使用"], s("walk_aid"))}`}
          </Line>
          <Line label="(2) 栄養・食生活">
            {`食事行為: ${pick(["自立ないし何とか自分で食べられる", "全面介助"], s("eating"))}`
              + `\n栄養状態: ${pick(["良好", "不良"], s("nutrition"))}`
              + `${s("nutrition_note") ? `\n${s("nutrition_note")}` : ""}`}
          </Line>
          <Line label="(3) 起こりうる状態">
            {marks(RISK, arr("risks"))}{s("risk_plan") ? `\n対処方針: ${s("risk_plan")}` : ""}
          </Line>
          <Line label="(4) 改善の見通し">{pick(["期待できる", "期待できない", "不明"], s("prognosis"))}</Line>
          <Line label="(5) 医学的管理">
            {marks(IGAKU_KANRI, arr("medical_services"))}
            {s("medical_services_other") ? `\nその他: ${s("medical_services_other")}` : ""}
          </Line>
          <Line label="(6) 留意事項">
            {marks(RYUUI, arr("cautions"))}{s("cautions_note") ? `\n${s("cautions_note")}` : ""}
          </Line>
          <Line label="(7) 感染症">
            {pick(["無", "有", "不明"], s("infection"))}{s("infection_name") ? `　${s("infection_name")}` : ""}
          </Line>
        </tbody>
      </table>

      <div style={{ fontWeight: "bold", fontSize: "9pt", margin: "6px 0 2px" }}>５．特記すべき事項</div>
      <div style={{ border: B, minHeight: "80px", padding: "5px", fontSize: "8pt", whiteSpace: "pre-wrap" }}>
        {s("remarks") || "　"}
      </div>
    </div>
  );
}
