"use client";

import type { DoctorOpinion } from "../_types";
import { PVFrame, PVCheckLabel, cellBase, cellLabel } from "../_preview";

interface Props { data: DoctorOpinion; userName: string; date: string; }

const RISKS = ["尿失禁", "転倒・骨折", "移動能力の低下", "褥瘡", "心肺機能の低下", "閉じこもり", "意欲低下", "徘徊", "低栄養", "摂食・嚥下機能低下", "脱水", "易感染性", "がん等による疼痛"];
const SERVICES_A = ["訪問診療", "訪問看護", "訪問歯科診療", "訪問薬剤管理指導"];
const SERVICES_B = ["訪問リハビリテーション", "短期入所療養介護", "訪問歯科衛生指導", "訪問栄養食事指導"];
const SERVICES_C = ["通所リハビリテーション", "老人保健施設", "介護医療院"];
const OBSERVATION = ["血圧", "摂食", "嚥下", "移動", "運動", "その他"];

export function PreviewTab6Doctor({ data, userName, date }: Props) {
  const c = data;
  return (
    <PVFrame userName={userName} date={date}>
      <div className="text-sm font-bold mb-2">介護に関する医師の意見（「主治医意見書」を転記）</div>

      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "8pt" }}>
        <tbody>
          <tr><td style={cellLabel} colSpan={2}>(1) 移動</td></tr>
          <tr>
            <td style={{ ...cellBase, width: "30mm" }}>屋外歩行</td>
            <td style={cellBase}>
              <PVCheckLabel on={c.movement?.outdoor_walk === "自立"} label="自立" />
              <PVCheckLabel on={c.movement?.outdoor_walk === "介助があればしている"} label="介助があればしている" />
              <PVCheckLabel on={c.movement?.outdoor_walk === "していない"} label="していない" />
            </td>
          </tr>
          <tr>
            <td style={cellBase}>車いすの使用</td>
            <td style={cellBase}>
              <PVCheckLabel on={c.movement?.wheelchair === "用いていない"} label="用いていない" />
              <PVCheckLabel on={c.movement?.wheelchair === "主に自分で操作している"} label="主に自分で操作している" />
              <PVCheckLabel on={c.movement?.wheelchair === "主に他人が操作している"} label="主に他人が操作している" />
            </td>
          </tr>
          <tr>
            <td style={cellBase}>歩行補助具・装具の使用（複数選択可）</td>
            <td style={cellBase}>
              {["用いていない", "屋外で使用", "屋内で使用"].map((x) => <PVCheckLabel key={x} on={c.movement?.walk_aid?.includes(x) ?? false} label={x} />)}
            </td>
          </tr>

          <tr><td style={cellLabel} colSpan={2}>(2) 栄養・食生活</td></tr>
          <tr>
            <td style={cellBase}>食事行為</td>
            <td style={cellBase}>
              <PVCheckLabel on={c.nutrition?.eating === "自立ないし何とか自分で食べられる"} label="自立ないし何とか自分で食べられる" />
              <PVCheckLabel on={c.nutrition?.eating === "全面介助"} label="全面介助" />
            </td>
          </tr>
          <tr>
            <td style={cellBase}>現在の栄養状態</td>
            <td style={cellBase}>
              <PVCheckLabel on={c.nutrition?.current_status === "良好"} label="良好" />
              <PVCheckLabel on={c.nutrition?.current_status === "不良"} label="不良" />
            </td>
          </tr>
          <tr>
            <td style={cellBase}>→ 栄養・食生活上の留意点</td>
            <td style={cellBase}>（ {c.nutrition?.notes} ）</td>
          </tr>

          <tr><td style={cellLabel} colSpan={2}>(3) 現在あるかまたは今後発生の可能性の高い状態とその対処方針</td></tr>
          <tr>
            <td style={cellBase} colSpan={2}>
              {RISKS.map((x) => <PVCheckLabel key={x} on={c.current_risks?.items?.includes(x) ?? false} label={x} />)}
              <PVCheckLabel on={!!c.current_risks?.other} label="その他" />（ {c.current_risks?.other} ）
            </td>
          </tr>
          <tr>
            <td style={cellBase}>→ 対処方針</td>
            <td style={cellBase}>（ {c.current_risks?.response} ）</td>
          </tr>

          <tr><td style={cellLabel} colSpan={2}>(4) サービス利用による生活機能の維持・改善の見通し</td></tr>
          <tr>
            <td style={cellBase} colSpan={2}>
              <PVCheckLabel on={c.improvement_outlook === "期待できる"} label="期待できる" />
              <PVCheckLabel on={c.improvement_outlook === "期待できない"} label="期待できない" />
              <PVCheckLabel on={c.improvement_outlook === "不明"} label="不明" />
            </td>
          </tr>

          <tr><td style={cellLabel} colSpan={2}>(5) 医学的管理の必要性 (特に必要性の高いものは[高]を選択)</td></tr>
          <tr>
            <td style={cellBase} colSpan={2}>
              <div className="grid grid-cols-4 gap-1">
                {[...SERVICES_A, ...SERVICES_B, ...SERVICES_C].map((s) => {
                  const v = c.medical_necessity?.[s];
                  return (
                    <div key={s}>
                      <PVCheckLabel on={!!v?.checked} label={s} />
                      {v?.checked && v?.high && <span className="ml-1 text-red-600">[高]</span>}
                    </div>
                  );
                })}
                <div>その他の医療系サービス（ {c.medical_necessity_other} ）</div>
              </div>
              <div className="mt-1"><PVCheckLabel on={c.no_special_item} label="特記すべき項目なし" /></div>
            </td>
          </tr>

          <tr><td style={cellLabel} colSpan={2}>(6) サービス提供時における医学的観点からの留意事項</td></tr>
          <tr>
            <td style={cellBase} colSpan={2}>
              <div className="grid grid-cols-3 gap-1">
                {OBSERVATION.map((x) => {
                  const v = c.observation_points?.[x];
                  return (
                    <div key={x}>
                      <PVCheckLabel on={!!v?.checked} label={x} />（ {v?.note} ）
                    </div>
                  );
                })}
              </div>
              <div className="mt-1"><PVCheckLabel on={c.no_special_observation} label="特記すべき項目なし" /></div>
            </td>
          </tr>

          <tr><td style={cellLabel} colSpan={2}>(7) 感染症の有無</td></tr>
          <tr>
            <td style={cellBase} colSpan={2}>
              <PVCheckLabel on={c.infection?.status === "無"} label="無" />
              <PVCheckLabel on={c.infection?.status === "有"} label="有" />
              （ {c.infection?.note} ）
              <PVCheckLabel on={c.infection?.status === "不明"} label="不明" />
            </td>
          </tr>
        </tbody>
      </table>
    </PVFrame>
  );
}
