"use client";

import type { MedicalHealth } from "../_types";
import { PVFrame, PVCheck, cellBase, cellHead, cellLabel } from "../_preview";

interface Props { data: MedicalHealth; userName: string; date: string; }

const TREATMENTS_MAIN = [
  "1. 点滴の管理", "2. 中心静脈栄養", "3. 透析", "4. ストーマ（人工肛門）の処置",
  "5. 酸素療法", "6. レスピレーター（人工呼吸器）", "7. 気管切開の処置", "8. 疼痛の看護",
  "9. 経管栄養",
];

const TREATMENTS_SUB = [
  "10. モニター測定（血圧、心拍、酸素飽和度等）", "11. じょくそうの処置",
  "12. カテーテル（コンドームカテーテル、留置カテーテル、ウロストーマ等）",
];

const SPECIFIC = [
  "バイタルサインのチェック", "定期的な病状観察",
  "内服薬", "坐薬（緩下剤、解熱剤等）", "眼・耳・鼻等の外用薬の使用等", "温・冷あん法、湿布貼付等", "注射",
  "吸引", "吸入", "自己注射（インスリン療法）", "経管栄養法", "中心静脈栄養法",
  "酸素療法", "人工呼吸療法", "気管カニューレの管理", "自己導尿", "自己腹膜灌流",
  "膀胱留置カテーテル管理", "人工肛門・人工膀胱管理", "疼痛管理", "褥瘡管理",
];

function CheckMark({ on }: { on: boolean }) {
  return <span className="inline-block text-center" style={{ width: "4mm" }}>{on ? "○" : ""}</span>;
}

export function PreviewTab6Medical({ data, userName, date }: Props) {
  const c = data;
  return (
    <PVFrame userName={userName} date={date}>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-sm font-bold">● 6-⑥ 医療・健康関係</div>
        <div className="text-xs">※計画をする際には主治医の意見を求める場合あり</div>
      </div>

      <div className="grid grid-cols-[1fr_1.3fr_1.2fr] gap-2">
        {/* 左 */}
        <div className="text-xs">
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <tbody>
              <tr>
                <td style={{ ...cellLabel, width: "12mm", verticalAlign: "middle", writingMode: "vertical-rl", textAlign: "center" }} rowSpan={TREATMENTS_MAIN.length}>処置内容</td>
                <td style={cellBase}><PVCheck on={!!c.treatments?.[TREATMENTS_MAIN[0]]} /> {TREATMENTS_MAIN[0]}</td>
              </tr>
              {TREATMENTS_MAIN.slice(1).map((t) => (
                <tr key={t}><td style={cellBase}><PVCheck on={!!c.treatments?.[t]} /> {t}</td></tr>
              ))}
              <tr>
                <td style={{ ...cellLabel, width: "12mm", verticalAlign: "middle", writingMode: "vertical-rl", textAlign: "center" }} rowSpan={TREATMENTS_SUB.length}>特別な対応</td>
                <td style={cellBase}><PVCheck on={!!c.treatments?.[TREATMENTS_SUB[0]]} /> {TREATMENTS_SUB[0]}</td>
              </tr>
              {TREATMENTS_SUB.slice(1).map((t) => (
                <tr key={t}><td style={cellBase}><PVCheck on={!!c.treatments?.[t]} /> {t}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 中 */}
        <div>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7pt" }}>
            <thead>
              <tr>
                <th style={cellHead} rowSpan={2}></th>
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
              {["測定・観察", "薬剤の管理", "薬剤の使用", "受診・検査介助", "リハビリテーション", "医療処置の管理"].map((r, i) => {
                const row = c.support_matrix?.[r] ?? { family_exec: false, service_exec: false, wish: false, needs_plan: false };
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
          <div className="bg-blue-100 text-xs px-1 font-bold mt-1">【特記、生活上注意すべき課題など】</div>
          <div className="border border-black p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "30mm" }}>{c.notes}</div>
        </div>

        {/* 右: 具体的内容 */}
        <div>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7pt" }}>
            <thead>
              <tr>
                <th style={cellHead} colSpan={2}>現状 | 計画</th>
                <th style={cellHead}>具体的内容</th>
              </tr>
            </thead>
            <tbody>
              {SPECIFIC.map((s) => (
                <tr key={s}>
                  <td style={{ ...cellBase, textAlign: "center", width: "8mm" }}><PVCheck on={c.specific_contents_current?.includes(s) ?? false} /></td>
                  <td style={{ ...cellBase, textAlign: "center", width: "8mm" }}><PVCheck on={c.specific_contents_plan?.includes(s) ?? false} /></td>
                  <td style={cellBase}>{s}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </PVFrame>
  );
}
