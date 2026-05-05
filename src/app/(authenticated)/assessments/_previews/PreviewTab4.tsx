"use client";

import type { Housing } from "../_types";
import { PVFrame, PVTitle, PVCheckLabel, cellBase, cellLabel } from "../_preview";

interface Props { data: Housing; userName: string; date: string; }

export function PreviewTab4({ data, userName, date }: Props) {
  const c = data;
  return (
    <PVFrame userName={userName} date={date}>
      <PVTitle number="4">住居等の状況</PVTitle>

      <div className="grid grid-cols-[1fr_60mm] gap-2">
        <div>
          <div className="border border-black p-1 text-xs">
            <div>
              <PVCheckLabel on={c.type === "1戸建て"} label="1戸建て" />
              <PVCheckLabel on={c.type === "集合住宅"} label="集合住宅" />
            </div>
            <div className="mt-1">
              賃貸・所有・社宅等・公営住宅・その他（ {c.tenure_other} ）
            </div>
          </div>
          <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "2mm" }}>
            <tbody>
              <tr>
                <td style={cellLabel} rowSpan={6}>居室等の状況</td>
                <td style={cellBase}>
                  ア. <PVCheckLabel on={c.living_room.has_private === "あり"} label="専用居室あり" />
                  <PVCheckLabel on={c.living_room.has_private === "なし"} label="専用居室なし" />
                </td>
              </tr>
              <tr>
                <td style={cellBase}>
                  イ. <PVCheckLabel on={c.living_room.floor.includes("1階")} label="1階" />
                  <PVCheckLabel on={c.living_room.floor.includes("2階")} label="2階" />
                  <PVCheckLabel on={c.living_room.floor.includes("その他")} label="その他" />
                  （ {c.living_room.floor_other} ）階 ⇒ エレベーター
                  <PVCheckLabel on={c.living_room.elevator === "有"} label="有" />
                  <PVCheckLabel on={c.living_room.elevator === "無"} label="無" />
                </td>
              </tr>
              <tr>
                <td style={cellBase}>
                  ウ. <PVCheckLabel on={c.living_room.bed_type.includes("布団")} label="布団" />
                  <PVCheckLabel on={c.living_room.bed_type.includes("ベッド")} label="ベッド" /> ⇒
                  <PVCheckLabel on={c.living_room.bed_sub.includes("固定式")} label="固定式" />
                  <PVCheckLabel on={c.living_room.bed_sub.includes("ギャッチ")} label="ギャッチ" />
                  <PVCheckLabel on={c.living_room.bed_sub.includes("電動")} label="電動" />
                </td>
              </tr>
              <tr>
                <td style={cellBase}>
                  エ. 陽あたり
                  <PVCheckLabel on={c.living_room.sunlight === "良"} label="良" />
                  <PVCheckLabel on={c.living_room.sunlight === "普通"} label="普通" />
                  <PVCheckLabel on={c.living_room.sunlight === "悪"} label="悪" />
                </td>
              </tr>
              <tr>
                <td style={cellBase}>
                  オ. 暖房
                  <PVCheckLabel on={c.living_room.heating === "あり"} label="あり" />
                  <PVCheckLabel on={c.living_room.heating === "なし"} label="なし" />
                  カ. 冷房
                  <PVCheckLabel on={c.living_room.cooling === "あり"} label="あり" />
                  <PVCheckLabel on={c.living_room.cooling === "なし"} label="なし" />
                </td>
              </tr>
              <tr><td style={cellBase}>&nbsp;</td></tr>

              <tr>
                <td style={cellLabel} rowSpan={3}>トイレ</td>
                <td style={cellBase}>
                  ア. <PVCheckLabel on={c.toilet.type.includes("和式")} label="和式" />
                  <PVCheckLabel on={c.toilet.type.includes("洋式")} label="洋式" />
                  <PVCheckLabel on={c.toilet.type.includes("その他")} label="その他" />
                </td>
              </tr>
              <tr>
                <td style={cellBase}>
                  イ. 手すり
                  <PVCheckLabel on={c.toilet.handrail === "あり"} label="あり" />
                  <PVCheckLabel on={c.toilet.handrail === "なし"} label="なし" />
                </td>
              </tr>
              <tr>
                <td style={cellBase}>
                  ウ. トイレまでの段差
                  <PVCheckLabel on={c.toilet.steps === "あり"} label="あり" />
                  <PVCheckLabel on={c.toilet.steps === "なし"} label="なし" />
                </td>
              </tr>

              <tr>
                <td style={cellLabel} rowSpan={3}>浴室</td>
                <td style={cellBase}>
                  ア. <PVCheckLabel on={c.bathroom.availability === "自宅にあり"} label="自宅にあり" />
                  <PVCheckLabel on={c.bathroom.availability === "自宅になし"} label="自宅になし" />
                </td>
              </tr>
              <tr>
                <td style={cellBase}>
                  イ. 手すり
                  <PVCheckLabel on={c.bathroom.handrail === "あり"} label="あり" />
                  <PVCheckLabel on={c.bathroom.handrail === "なし"} label="なし" />
                </td>
              </tr>
              <tr>
                <td style={cellBase}>
                  ウ. 浴室までの段差
                  <PVCheckLabel on={c.bathroom.steps === "あり"} label="あり" />
                  <PVCheckLabel on={c.bathroom.steps === "なし"} label="なし" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="border border-black p-1 text-xs">
          <div className="bg-blue-100 text-center">家屋（居室を含む）見取図 ※段差には▲を記入</div>
          <div className="whitespace-pre-wrap" style={{ minHeight: "100mm" }}>{c.layout_notes}</div>
        </div>
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "2mm" }}>
        <tbody>
          <tr>
            <td style={cellLabel}>諸設備</td>
            <td style={cellBase}>
              調理器具
              <PVCheckLabel on={c.equipment.cooking === "ガス"} label="ガス" />
              <PVCheckLabel on={c.equipment.cooking === "IH"} label="IH" />
              　暖房器具
              {["ガス", "電気", "灯油", "その他"].map((h) => <PVCheckLabel key={h} on={c.equipment.heating_device.includes(h)} label={h} />)}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="bg-blue-100 text-xs px-1 py-0.5 mt-1">【周辺環境・立地環境・その他住居に関する特記事項】</div>
      <div className="border border-black p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "20mm" }}>{c.notes}</div>
    </PVFrame>
  );
}
