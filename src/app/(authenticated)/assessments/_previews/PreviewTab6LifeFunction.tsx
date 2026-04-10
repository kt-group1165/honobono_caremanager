"use client";

import type { LifeFunction } from "../_types";
import { PVFrame, PVTitle, PVCircle, PVCheckLabel, cellBase, cellHead, cellLabel } from "../_preview";

interface Props { data: LifeFunction; userName: string; date: string; }

const CERT_ITEMS: { key: string; label: string; count: number }[] = [
  { key: "2-1", label: "2-1 移乗", count: 4 },
  { key: "2-2", label: "2-2 移動", count: 4 },
  { key: "2-3", label: "2-3 えん下", count: 3 },
  { key: "2-4", label: "2-4 食事摂取", count: 4 },
  { key: "2-5", label: "2-5 排尿", count: 4 },
  { key: "2-6", label: "2-6 排便", count: 4 },
  { key: "2-7", label: "2-7 口腔清潔", count: 3 },
  { key: "2-8", label: "2-8 洗顔", count: 3 },
  { key: "2-9", label: "2-9 整髪", count: 3 },
  { key: "2-10", label: "2-10 上衣の着脱", count: 4 },
  { key: "2-11", label: "2-11 ズボン等の着脱", count: 4 },
  { key: "2-12", label: "2-12 外出頻度", count: 3 },
  { key: "2-13", label: "2-13 飲水摂取", count: 4 },
];

function CheckMark({ on }: { on: boolean }) {
  return <span className="inline-block text-center" style={{ width: "4mm" }}>{on ? "○" : ""}</span>;
}

function SupportTable({ title, subtitle, rows, matrix }: { title: string; subtitle: string; rows: string[]; matrix: Record<string, any> | undefined }) {
  return (
    <>
      <div className="bg-blue-100 text-xs px-1 font-bold">{title}</div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7pt" }}>
        <thead>
          <tr>
            <th style={{ ...cellHead, width: "22mm" }} rowSpan={2}>{subtitle}</th>
            <th style={cellHead} colSpan={2}>援助の現状</th>
            <th style={cellHead} rowSpan={2}>希望</th>
            <th style={cellHead} rowSpan={2}>要援助→計画</th>
          </tr>
          <tr>
            <th style={cellHead}>家族実施</th>
            <th style={cellHead}>サービス実施</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const row = matrix?.[r] ?? { family_exec: false, service_exec: false, wish: false, needs_plan: false };
            return (
              <tr key={r}>
                <td style={cellBase}>{i + 1}) {r}</td>
                <td style={{ ...cellBase, textAlign: "center" }}><CheckMark on={row.family_exec} /></td>
                <td style={{ ...cellBase, textAlign: "center" }}><CheckMark on={row.service_exec} /></td>
                <td style={{ ...cellBase, textAlign: "center" }}><CheckMark on={row.wish} /></td>
                <td style={{ ...cellBase, textAlign: "center" }}><CheckMark on={row.needs_plan} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

export function PreviewTab6LifeFunction({ data, userName, date }: Props) {
  const c = data;
  const isSelected = (key: string, n: number) => {
    const v = c.certification_items?.[key] ?? "";
    return v.split(",").includes(String(n));
  };
  return (
    <PVFrame userName={userName} date={date}>
      <div className="text-sm font-bold mb-1">● 6-② 生活機能（食事・排泄等）</div>

      <div className="grid grid-cols-[1.2fr_1.3fr] gap-2">
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7.5pt" }}>
          <tbody>
            {CERT_ITEMS.map((item) => (
              <tr key={item.key}>
                <td style={{ ...cellLabel, width: "30mm" }}>{item.label}</td>
                <td style={cellBase}>
                  {Array.from({ length: item.count }, (_, i) => i + 1).map((n) => (
                    <span key={n} className="mr-1"><PVCircle on={isSelected(item.key, n)}>{n}</PVCircle></span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div>
          <SupportTable title="食事" subtitle="6-②2-1〜2-4関係" rows={["移乗介助", "移動介助", "摂取介助"]} matrix={c.meals} />
          <div className="bg-blue-100 text-xs px-1 font-bold mt-1">【特記、解決すべき課題など】</div>
          <div className="border border-black p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "10mm" }}>{c.meal_notes}</div>
          <SupportTable title="排泄等" subtitle="6-②2-5〜2-11関係" rows={["準備・後始末", "移乗移動介助", "排尿介助", "排便介助", "口腔清潔介助", "洗面介助", "整容介助", "更衣介助"]} matrix={c.toileting} />
          <div className="bg-blue-100 text-xs px-1 font-bold mt-1">【特記、解決すべき課題など】</div>
          <div className="border border-black p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "10mm" }}>{c.toilet_notes}</div>
          <SupportTable title="外出" subtitle="6-②2-12関係" rows={["移送・外出介助"]} matrix={c.outing} />
          <div className="bg-blue-100 text-xs px-1 font-bold mt-1">【特記、解決すべき課題など】</div>
          <div className="border border-black p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "10mm" }}>{c.outing_notes}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
        <div className="border border-black p-1">
          <div className="font-bold">&lt;その他食事の現状（6-②2-4関係）&gt;</div>
          <div>ア. 食事場所 {["食堂", "居室ベッド上", "布団上", "その他居室内", "その他"].map((x) => <PVCheckLabel key={x} on={c.meal_situation?.place?.includes(x) ?? false} label={x} />)}</div>
          <div>イ. 食堂までの段差 <PVCheckLabel on={c.meal_situation?.steps_to_dining === "あり"} label="あり" /><PVCheckLabel on={c.meal_situation?.steps_to_dining === "なし"} label="なし" /></div>
          <div>ウ. 咀嚼の状況 <PVCheckLabel on={c.meal_situation?.chewing_status === "問題なし"} label="問題なし" /><PVCheckLabel on={c.meal_situation?.chewing_status === "問題あり"} label="問題あり" /></div>
          <div>エ. 食事の内容 <PVCheckLabel on={c.meal_situation?.diet_type?.general ?? false} label="一般食" /></div>
        </div>
        <div className="border border-black p-1">
          <div className="font-bold">&lt;その他排泄の状況（6-②2-5、2-6関係）&gt;</div>
          <div>ア. 尿意 <PVCheckLabel on={c.toilet_awareness?.urination === "ある"} label="ある" /><PVCheckLabel on={c.toilet_awareness?.urination === "ときどきある"} label="ときどきある" /><PVCheckLabel on={c.toilet_awareness?.urination === "ない"} label="ない" /></div>
          <div>イ. 便意 <PVCheckLabel on={c.toilet_awareness?.defecation === "ある"} label="ある" /><PVCheckLabel on={c.toilet_awareness?.defecation === "ときどきある"} label="ときどきある" /><PVCheckLabel on={c.toilet_awareness?.defecation === "ない"} label="ない" /></div>
        </div>
      </div>
    </PVFrame>
  );
}
