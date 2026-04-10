"use client";

import type { CognitionBehavior } from "../_types";
import { PVFrame, PVCircle, cellBase, cellLabel } from "../_preview";

interface Props { data: CognitionBehavior; userName: string; date: string; }

const COG: { key: string; label: string; count: number }[] = [
  { key: "3-1", label: "3-1 意思の伝達", count: 4 },
  { key: "3-2", label: "3-2 毎日の日課を理解する", count: 2 },
  { key: "3-3", label: "3-3 生年月日や年齢を答える", count: 2 },
  { key: "3-4", label: "3-4 面接調査の直前記憶", count: 2 },
  { key: "3-5", label: "3-5 自分の名前を答える", count: 2 },
  { key: "3-6", label: "3-6 今の季節を理解する", count: 2 },
  { key: "3-7", label: "3-7 自分のいる場所を答える", count: 2 },
  { key: "3-8", label: "3-8 徘徊", count: 3 },
  { key: "3-9", label: "3-9 外出すると戻れない（迷子）", count: 3 },
  { key: "3-10", label: "3-10 介護者の発言への反応", count: 3 },
];

const BEH: { key: string; label: string; count: number }[] = [
  { key: "4-1", label: "4-1 被害妄想（物を盗られたなど）", count: 3 },
  { key: "4-2", label: "4-2 作話をする", count: 3 },
  { key: "4-3", label: "4-3 感情が不安定になる", count: 3 },
  { key: "4-4", label: "4-4 昼夜の逆転", count: 3 },
  { key: "4-5", label: "4-5 しつこく同じ話をする", count: 3 },
  { key: "4-6", label: "4-6 大声を出す", count: 3 },
  { key: "4-7", label: "4-7 介護に抵抗する", count: 3 },
  { key: "4-8", label: "4-8 落ち着きがない（家に帰る等）", count: 3 },
  { key: "4-9", label: "4-9 外に出たがり目が離せない", count: 3 },
  { key: "4-10", label: "4-10 ものを集める、無断でもってくる", count: 3 },
  { key: "4-11", label: "4-11 物を壊す、衣類を破く", count: 3 },
  { key: "4-12", label: "4-12 ひどい物忘れ", count: 3 },
  { key: "4-13", label: "4-13 独り言や独り笑い", count: 3 },
  { key: "4-14", label: "4-14 自分勝手な行動", count: 3 },
  { key: "4-15", label: "4-15 話がまとまらない、会話にならない", count: 3 },
  { key: "4-16", label: "4-16 幻視・幻聴", count: 3 },
  { key: "4-17", label: "4-17 暴言・暴力", count: 3 },
  { key: "4-18", label: "4-18 目的なく動き回る", count: 3 },
  { key: "4-19", label: "4-19 火の始末・管理", count: 3 },
  { key: "4-20", label: "4-20 不潔行為", count: 3 },
  { key: "4-21", label: "4-21 異食行動", count: 3 },
];

export function PreviewTab6Cognition({ data, userName, date }: Props) {
  const c = data;
  const isSel = (items: Record<string, string> | undefined, key: string, n: number) => {
    const v = items?.[key] ?? "";
    return v.split(",").includes(String(n));
  };

  return (
    <PVFrame userName={userName} date={date}>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-sm font-bold">6-③ 認知機能</div>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7pt" }}>
            <tbody>
              {COG.map((item) => (
                <tr key={item.key}>
                  <td style={{ ...cellLabel, width: "40mm" }}>{item.label}</td>
                  <td style={cellBase}>
                    {Array.from({ length: item.count }, (_, i) => i + 1).map((n) => (
                      <span key={n} className="mr-1"><PVCircle on={isSel(c.cognition_items, item.key, n)}>{n}</PVCircle></span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="text-sm font-bold mt-2">6-④ 精神・行動障害</div>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7pt" }}>
            <tbody>
              {BEH.map((item) => (
                <tr key={item.key}>
                  <td style={{ ...cellLabel, width: "40mm" }}>{item.label}</td>
                  <td style={cellBase}>
                    {Array.from({ length: item.count }, (_, i) => i + 1).map((n) => (
                      <span key={n} className="mr-1"><PVCircle on={isSel(c.behavior_items, item.key, n)}>{n}</PVCircle></span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="text-xs">
          <div className="text-sm font-bold">6-③認知機能、6-④精神・行動障害 全般</div>
          <div className="bg-blue-100 px-1 font-bold">家族等からの情報と観察</div>
          <div className="border border-black p-1 whitespace-pre-wrap" style={{ minHeight: "25mm" }}>{c.family_observation}</div>

          <div className="grid grid-cols-2 gap-0">
            <div>
              <div className="bg-blue-100 px-1 font-bold text-center">援助の現状（家族）</div>
              <div className="border border-black p-1 whitespace-pre-wrap" style={{ minHeight: "20mm" }}>{c.support_current?.family}</div>
            </div>
            <div>
              <div className="bg-blue-100 px-1 font-bold text-center">（サービス）</div>
              <div className="border border-black border-l-0 p-1 whitespace-pre-wrap" style={{ minHeight: "20mm" }}>{c.support_current?.service}</div>
            </div>
          </div>

          <div className="bg-blue-100 px-1 font-bold">援助の希望/本人</div>
          <div className="border border-black p-1 whitespace-pre-wrap" style={{ minHeight: "15mm" }}>{c.support_wish_user}</div>

          <div className="bg-blue-100 px-1 font-bold">援助の希望/家族</div>
          <div className="border border-black p-1 whitespace-pre-wrap" style={{ minHeight: "15mm" }}>{c.support_wish_family}</div>

          <div className="bg-blue-100 px-1 font-bold">援助の計画</div>
          <div className="border border-black p-1 whitespace-pre-wrap" style={{ minHeight: "20mm" }}>{c.support_plan}</div>

          <div className="bg-blue-100 px-1 font-bold">【特記、解決すべき課題】</div>
          <div className="border border-black p-1 whitespace-pre-wrap" style={{ minHeight: "15mm" }}>{c.notes}</div>
        </div>
      </div>
    </PVFrame>
  );
}
