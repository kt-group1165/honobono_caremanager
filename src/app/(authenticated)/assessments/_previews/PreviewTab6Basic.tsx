"use client";

import type { BasicMotion } from "../_types";
import { PVFrame, PVTitle, PVCircle, PVCheckLabel, cellBase, cellHead, cellLabel } from "../_preview";

interface Props { data: BasicMotion; userName: string; date: string; }

const CERT_ITEMS: { key: string; label: string; count: number }[] = [
  { key: "1-1", label: "1-1 麻痺等（複数可）", count: 6 },
  { key: "1-2", label: "1-2 拘縮（複数可）", count: 5 },
  { key: "1-3", label: "1-3 寝返り", count: 3 },
  { key: "1-4", label: "1-4 起き上がり", count: 3 },
  { key: "1-5", label: "1-5 座位保持", count: 4 },
  { key: "1-6", label: "1-6 両足での立位保持", count: 3 },
  { key: "1-7", label: "1-7 歩行", count: 3 },
  { key: "1-8", label: "1-8 立ち上がり", count: 3 },
  { key: "1-9", label: "1-9 片足での立位保持", count: 3 },
  { key: "1-10", label: "1-10 洗身", count: 4 },
  { key: "1-11", label: "1-11 つめ切り", count: 3 },
  { key: "1-12", label: "1-12 視力", count: 5 },
  { key: "1-13", label: "1-13 聴力", count: 5 },
  { key: "1-14", label: "1-14 関節の動き（複数可）", count: 7 },
];

function CheckMark({ on }: { on: boolean }) {
  return <span className="inline-block text-center" style={{ width: "4mm" }}>{on ? "○" : ""}</span>;
}

export function PreviewTab6Basic({ data, userName, date }: Props) {
  const c = data;
  const isSelected = (key: string, n: number) => {
    const v = c.certification_items?.[key] ?? "";
    return v.split(",").includes(String(n));
  };

  return (
    <PVFrame userName={userName} date={date}>
      <PVTitle number="6">本人の基本動作等の状況と援助内容の詳細</PVTitle>
      <div className="text-sm font-bold mb-1">● 6-① 基本（身体機能・起居）動作</div>

      <div className="grid grid-cols-[1.2fr_1.3fr] gap-2">
        {/* 左: 要介護認定項目 */}
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7.5pt" }}>
          <tbody>
            {CERT_ITEMS.map((item) => (
              <tr key={item.key}>
                <td style={{ ...cellLabel, width: "35mm" }}>{item.label}</td>
                <td style={cellBase}>
                  {Array.from({ length: item.count }, (_, i) => i + 1).map((n) => (
                    <span key={n} className="mr-1">
                      <PVCircle on={isSelected(item.key, n)}>{n}</PVCircle>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 右: 体位変換・起居 + 入浴 */}
        <div>
          <div className="bg-blue-100 text-xs px-1 font-bold">体位変換・起居</div>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7pt" }}>
            <thead>
              <tr>
                <th style={{ ...cellHead, width: "22mm" }} rowSpan={2}>6-①1-1、1-2関係</th>
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
              {["体位変換介助", "起居介助"].map((r, i) => {
                const row = c.body_position?.[r] ?? { family_exec: false, service_exec: false, wish: false, needs_plan: false };
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
          <div className="mt-1 text-xs">
            リハビリの必要性
            <PVCheckLabel on={c.rehab_needed === "あり"} label="あり→P9" />
            <PVCheckLabel on={c.rehab_needed === "なし"} label="なし" />
          </div>

          <div className="bg-blue-100 text-xs px-1 font-bold mt-2">【特記、解決すべき課題など】</div>
          <div className="border border-black p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "15mm" }}>{c.basic_notes}</div>

          <div className="bg-blue-100 text-xs px-1 font-bold mt-2">入浴</div>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7pt" }}>
            <thead>
              <tr>
                <th style={{ ...cellHead, width: "22mm" }} rowSpan={2}>6-①1-10関係</th>
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
              {["準備・後始末", "移乗移動介助", "洗身介助", "洗髪介助", "清拭・部分浴", "褥瘡・皮膚疾患の対応"].map((r, i) => {
                const row = c.bathing?.[r] ?? { family_exec: false, service_exec: false, wish: false, needs_plan: false };
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
        </div>
      </div>

      <div className="mt-2 text-xs">
        <div className="bg-blue-100 px-1 font-bold">&lt;コミュニケーションの状況・方法（6-①1-12、1-13関係）&gt;</div>
        <div className="border border-black p-1">
          <div>ア. 視聴覚 {["眼鏡使用", "コンタクト使用", "補聴器使用"].map((x) => <PVCheckLabel key={x} on={c.communication?.visual_aid?.includes(x) ?? false} label={x} />)}</div>
          <div>イ. 電話 <PVCheckLabel on={c.communication?.phone === "あり"} label="あり" /><PVCheckLabel on={c.communication?.phone === "なし"} label="なし" /></div>
          <div>ウ. 言語障害 <PVCheckLabel on={c.communication?.language_disorder === "あり"} label="あり" /><PVCheckLabel on={c.communication?.language_disorder === "なし"} label="なし" /> （ {c.communication?.language_disorder_note} ）</div>
          <div>エ. コミュニケーション支援機器の使用 <PVCheckLabel on={c.communication?.comm_device === "あり"} label="あり" /><PVCheckLabel on={c.communication?.comm_device === "なし"} label="なし" /> （ {c.communication?.comm_device_note} ）</div>
        </div>
        <div className="bg-blue-100 px-1 font-bold mt-1">【特記、解決すべき課題など】</div>
        <div className="border border-black p-1 whitespace-pre-wrap" style={{ minHeight: "15mm" }}>{c.communication_notes}</div>
      </div>
    </PVFrame>
  );
}
