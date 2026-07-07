"use client";

import { useState } from "react";
import { BookOpen, Printer } from "lucide-react";

/* ═══════════════════════════════════════════════════════════════════════════
   ほのぼの改（仮）操作マニュアル — コンテンツ定義
   ─────────────────────────────────────────────────────────────────────────
   改訂のしかた:
   1. 機能が変わったら、該当セクションの body (JSX) を書き換える
   2. MANUAL_VERSION / MANUAL_UPDATED を更新する
   3. REVISIONS の先頭に 1 行追加する (新しい順)
   4. スクリーンショットは public/manual/ に png を置き、本文の該当手順の直後に
      <ManualImg src="/manual/xxx.png" caption="..." /> を差し込む
      (ファイルが無い間は「スクリーンショット準備中」の枠が出る)
   ═══════════════════════════════════════════════════════════════════════ */

export const MANUAL_VERSION = "1.1";
export const MANUAL_UPDATED = "2026-07-08";

type Revision = { version: string; date: string; note: string };

const REVISIONS: Revision[] = [
  {
    version: "1.1",
    date: "2026-07-08",
    note: "スクリーンショット増補・全セクションを手順書形式に改稿 (請求業務は Step 0〜5 の流れで詳説)",
  },
  { version: "1.0", date: "2026-07-07", note: "初版作成 (訪問介護版の業務フロー順)" },
];

type ManualSection = {
  id: string;
  title: string;
  body: React.ReactNode;
};

/* ── 本文用の小さな部品 ──────────────────────────────────────────────── */

/** スクリーンショット。public/manual/ に画像を置くと表示され、無ければ準備中の枠が出る */
function ManualImg({ src, caption }: { src: string; caption: string }) {
  const [missing, setMissing] = useState(false);
  return (
    <figure className="my-3 break-inside-avoid">
      {missing ? (
        <div className="flex h-36 items-center justify-center rounded-lg border-2 border-dashed border-gray-200 bg-gray-50 text-[12px] text-gray-400">
          （スクリーンショット準備中）
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- public/ 直下の静的マニュアル画像 (存在しない間は onError でプレースホルダに差替)
        <img
          src={src}
          alt={caption}
          onError={() => setMissing(true)}
          className="w-full rounded-lg border border-gray-200 shadow-sm"
        />
      )}
      <figcaption className="mt-1 text-center text-[11.5px] text-gray-500">
        ▲ {caption}
      </figcaption>
    </figure>
  );
}

/** 手順の番号リスト */
function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="ml-1 list-inside list-decimal space-y-1.5 text-[13.5px] leading-relaxed text-gray-800">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ol>
  );
}

/** 注意書き (⚠) */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-800">
      <span aria-hidden>⚠</span>
      <div>{children}</div>
    </div>
  );
}

/** 補足 (罫線ボックス) */
function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-[13px] leading-relaxed text-blue-800">
      {children}
    </div>
  );
}

/** 段落 */
function P({ children }: { children: React.ReactNode }) {
  return <p className="text-[13.5px] leading-relaxed text-gray-800">{children}</p>;
}

/** 小見出し */
function H({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-4 mb-1.5 text-[14px] font-bold text-gray-900">{children}</h3>;
}

/** 用語のミニ解説 (初めての方向け) */
function Word({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="my-1 flex items-start gap-2 text-[12.5px] leading-relaxed text-gray-600">
      <span className="shrink-0 rounded bg-gray-100 px-1.5 py-px font-medium text-gray-700">
        {term}
      </span>
      <span>{children}</span>
    </div>
  );
}

/** 画面上のボタン・タブ名の表記 */
function Btn({ children }: { children: React.ReactNode }) {
  return (
    <span className="mx-0.5 inline-block rounded border border-gray-300 bg-gray-50 px-1.5 py-px text-[12px] font-medium text-gray-800">
      <b>{children}</b>
    </span>
  );
}

/* ── セクション定義 (訪問介護版の業務フロー順) ─────────────────────────── */

const SECTIONS: ManualSection[] = [
  /* ═══ 1. はじめに ═══ */
  {
    id: "hajimeni",
    title: "1. はじめに",
    body: (
      <>
        <P>
          ほのぼの改（仮）は、訪問介護の「予定・実績・計画書・請求・国保連への伝送」までを
          1 つのシステムで管理する介護管理システムです。訪問介護版とケアマネ版 (居宅介護支援)
          があり、選択中の事業所の種別に合わせてメニューが自動的に切り替わります。
        </P>
        <Word term="国保連">
          国民健康保険団体連合会。介護保険の給付費 (保険で支払われる 9 割など) を
          事業所が毎月請求する窓口です。
        </Word>

        <H>ログインする</H>
        <P>まずはシステムにログインします。ID とパスワードは管理者から配布されます。</P>
        <Steps
          items={[
            "ブラウザ (Edge / Chrome など) でシステムの URL を開きます。",
            "「ログイン ID または メールアドレス」を入力します。",
            "「パスワード」を入力します。",
            <>
              <Btn>ログイン</Btn> ボタンを押します。
            </>,
          ]}
        />
        <Note>
          新しい端末 (パソコン・スマホ) から初めてログインすると
          「新しい端末からのログインです。管理者の承認をお待ちください。」と表示されます。
          管理者が承認するとログインできるようになります。
        </Note>

        <H>画面の見方 — ダッシュボードとサイドバー</H>
        <P>
          ログインすると最初にダッシュボード (ホーム画面) が開きます。左側のサイドバーが
          メニューで、「日常業務」「請求業務」「障害福祉」「管理」のグループに分かれています。
          毎日の仕事は上から順に、月に一度の請求は「請求業務」から行います。
        </P>
        <Steps
          items={[
            "サイドバーの項目をクリックすると各画面に移動します。",
            "サイドバー上部の ◀ ボタンで、サイドバーを細く折りたたむことができます。",
            "「通知」に未読があると赤いバッジで件数が表示されます。",
            "いま操作している事業所は、サイドバー左下の「🏢 事業所名」で確認できます。",
          ]}
        />
        <ManualImg
          src="/manual/01-sidebar.png"
          caption="ダッシュボードとサイドバー (訪問介護版)。左下に選択中の事業所名が表示されます"
        />
        <Tip>
          ダッシュボードには「利用者数」「今月の請求額」「今月のサービス件数」
          「ケアプラン期限切れ (30 日以内)」のカードと、最近登録された利用者・直近のサービス実績が
          表示されます。毎朝ここを見るだけで状況をひととおり確認できます。
        </Tip>
        <P>
          複数の事業所に所属している場合、画面を開いたときは前回選択していた事業所が
          自動的に選ばれます。別の事業所に切り替えると、メニューや一覧の内容も
          その事業所のものに切り替わります。
        </P>
      </>
    ),
  },

  /* ═══ 2. 利用者管理 ═══ */
  {
    id: "users",
    title: "2. 利用者管理",
    body: (
      <>
        <P>
          利用者 (サービスを受ける方) の情報を登録・管理する画面です。予定・実績・請求は
          すべてここに登録した利用者情報が元になるため、最初に整えておく大事な画面です。
        </P>

        <H>利用者を探す</H>
        <Steps
          items={[
            "サイドバーの「利用者管理」を開きます。左側に利用者の一覧が表示されます。",
            <>
              上部の <Btn>自事業所</Btn> / <Btn>全利用者</Btn> で表示範囲を、
              <Btn>全種別</Btn> / <Btn>介護</Btn> / <Btn>障害</Btn> / <Btn>両方</Btn>{" "}
              で保険の種別を絞り込めます。
            </>,
            "利用者名をクリックすると、右側に詳細 (基本情報タブ) が表示されます。",
          ]}
        />
        <ManualImg
          src="/manual/02-users.png"
          caption="利用者管理。左が利用者一覧 (絞り込みボタン付き)、右が基本情報タブ"
        />
        <Tip>
          利用者データは <Btn>CSV取込</Btn> / <Btn>CSV出力</Btn>{" "}
          ボタンで一括の取り込み・書き出しもできます。
        </Tip>

        <H>新しい利用者を登録する</H>
        <Steps
          items={[
            <>
              一覧画面の <Btn>新規利用者登録</Btn> ボタンを押します。
            </>,
            "氏名・かな・生年月日 (必須) を入力します。",
            <>
              <Btn>登録</Btn> を押すと利用者が作成されます。続けて詳細画面の各タブで
              情報を追加していきます。
            </>,
          ]}
        />
        <ManualImg src="/manual/02-users-new.png" caption="新規利用者登録フォーム" />

        <H>タブの構成</H>
        <P>利用者詳細は次のタブに分かれています (利用者の属性によって表示が変わります)。</P>
        <ul className="ml-1 list-inside list-disc space-y-1 text-[13.5px] leading-relaxed text-gray-800">
          <li>
            <b>基本情報</b> — 基本情報 / 親族・関係者 / 既往歴 / ADL / 健康管理。
            基本情報には利用料の口座振替に使う口座情報 (金融機関・支店・種別・番号・名義カナ)
            も入力します。
          </li>
          <li>
            <b>介護保険</b> — 介護認定 / 医療保険
          </li>
          <li>
            <b>ケアプラン管理</b> — 計画概要
          </li>
          <li>
            <b>障害福祉</b> — 受給者証 (詳細) / 障害支援区分
          </li>
        </ul>
        <Word term="ADL">
          日常生活動作 (食事・入浴・移動など) のこと。どこまでご自身でできるかを記録します。
        </Word>

        <H>親族・関係者を登録する</H>
        <Steps
          items={[
            "「基本情報」タブの中の「親族・関係者」を開きます。",
            <>
              <Btn>追加</Btn> でご家族や緊急連絡先を登録します。続柄・電話番号・
              キーパーソン (主な連絡先になる方) かどうかを入力します。
            </>,
          ]}
        />
        <ManualImg src="/manual/02-family.png" caption="親族・関係者タブ" />

        <H>介護認定を登録する (請求の元になる大事な画面)</H>
        <P>
          「介護保険」→「介護認定」タブでは、保険証と認定 (要介護度) の情報を管理します。
          過去の認定も履歴として一覧に残り、現在有効な要介護度がバッジで表示されます。
        </P>
        <Word term="要介護度">
          介護の必要度を示す区分 (要支援 1〜2、要介護 1〜5)。市区町村の認定調査で決まり、
          請求できるサービスや限度額がこれで変わります。
        </Word>
        <Steps
          items={[
            "「介護保険」→「介護認定」タブを開くと、認定の履歴一覧が表示されます。",
            <>
              新しい認定を追加するときは <Btn>＋新規</Btn>、認定期間の更新は{" "}
              <Btn>認定更新</Btn>、入力内容の保存・保険変更は <Btn>登録/保険変更</Btn>{" "}
              を使います。
            </>,
          ]}
        />
        <ManualImg
          src="/manual/02-kaigo-nintei.png"
          caption="介護保険 → 介護認定タブ。認定の履歴一覧と現在の要介護度バッジ"
        />
        <P>編集フォームでは、次の情報を入力します。黄色の欄は必須です。</P>
        <Steps
          items={[
            "保険証情報 — 被保険者番号 / 保険者番号 / 保険者名 / 給付率 / 保険証有効期間 (黄色 = 必須)",
            <>
              公費情報 (紫色の枠) — 法別番号 (例: 12 = 生活保護) を選ぶと、負担者番号 (8 桁)・
              受給者番号 (7 桁) を入力できます。
            </>,
            "認定情報 — 要介護度 / 認定有効期間 (黄色 = 必須)",
            <>
              担当居宅介護支援事業所 (水色の枠) — 事業所番号 (10 桁) を入力します。
              事業所名は任意です。
            </>,
          ]}
        />
        <ManualImg
          src="/manual/02-nintei-form.png"
          caption="介護認定の編集フォーム。紫の枠が公費情報 (生活保護など)、水色の枠が担当居宅介護支援事業所"
        />
        <Word term="公費">
          生活保護など、利用者負担分を公費 (国や自治体) が負担する制度。該当する方だけ入力します。
        </Word>
        <Note>
          「担当居宅介護支援事業所番号」は、国保連請求の明細書 (様式第二) と伝送ファイルにそのまま
          反映されます。未入力のままだと請求画面の月次情報で「担当居宅未設定」の警告が出ますので、
          利用開始時に必ず入力してください。
        </Note>
      </>
    ),
  },

  /* ═══ 3. 予定と実績 ═══ */
  {
    id: "yotei-jisseki",
    title: "3. 予定と実績",
    body: (
      <>
        <P>
          日々の訪問は「① 週間パターンを登録 → ② 月間へ展開して 1 か月分の予定を作る →
          ③ シフトで確認・調整 → ④ 実績を入力して完成にする」の 4 ステップで管理します。
          この流れを毎月繰り返すのが基本です。
        </P>

        <H>① パターン登録 — 毎週のきまった訪問を登録する</H>
        <P>
          「毎週月曜 9:00 に身体介護 30 分」のような、毎週繰り返す訪問の型 (パターン)
          を利用者ごとに登録する画面です。
        </P>
        <Steps
          items={[
            "サイドバーの「パターン登録」を開き、利用者を選びます。",
            <>
              <Btn>＋パターン追加</Btn> を押し、曜日・開始/終了時刻・サービス内容・担当者を
              入力して保存します。
            </>,
            "画面右上の展開対象年月 (年月の入力欄) を選びます。",
            <>
              緑色の <Btn>月間へ展開</Btn> ボタンを押すと、週間パターンがその月の該当曜日
              すべてに予定として自動生成されます。
            </>,
          ]}
        />
        <ManualImg
          src="/manual/03-patterns.png"
          caption="パターン登録。右上に「＋パターン追加」と緑の「月間へ展開」ボタン"
        />
        <Note>
          展開の対象になるのは「保存済み」のパターンだけです。保存していないと
          「展開できる保存済パターンがありません」と表示されます。先に保存してから展開してください。
        </Note>

        <H>② シフト管理で確認・調整する</H>
        <P>
          展開した予定は「利用状況・シフト管理」の月間カレンダーで確認します。個別の日だけ
          時間を変えたい、臨時の訪問を追加したい、お休みで削除したい、といった調整はここで行います。
        </P>
        <Steps
          items={[
            "サイドバーの「利用状況・シフト管理」を開き、対象月を選びます。",
            "月間カレンダーで予定の抜け・重なりがないか確認します。",
            "調整したい日の予定をクリックして、時間の変更・追加・削除を行います。",
          ]}
        />
        <ManualImg
          src="/manual/03-shift.png"
          caption="利用状況・シフト管理。月間カレンダーで予定を確認・調整します"
        />

        <H>③ サービス提供表（実績）— 実績を入力して確定する</H>
        <P>
          実際に訪問したかどうか (実績) を記録し、月の実績を「完成」として確定する画面です。
          ここで完成にした実績が、そのまま請求の集計対象になります。
        </P>
        <Steps
          items={[
            "サイドバーの「サービス提供表（実績）」を開き、対象の年月を選びます。",
            "左の一覧から利用者を選びます (選ぶまでは下のようなガイド画面が表示されます)。",
          ]}
        />
        <ManualImg
          src="/manual/03-provision.png"
          caption="サービス提供表（実績）。まず左の一覧から利用者を選びます"
        />
        <Steps
          items={[
            "利用者を選ぶと、予定の列と実績の列が並んだグリッドが表示されます。実施した日の実績を入力します。",
            <>
              入力が終わったら <Btn>保存</Btn> を押し、<Btn>完成にする</Btn> で状態を
              「下書き (黄)」から「完成 (緑)」に切り替えます。
            </>,
          ]}
        />
        <ManualImg
          src="/manual/03-provision-detail.png"
          caption="利用者選択後のグリッド。予定と実績が並び、入力後に「完成にする」で確定します"
        />
        <Note>
          請求の集計対象になるのは「完成」になった実績だけです。月末〜請求前に必ず全利用者を
          「完成」にしてください。修正が必要になったら <Btn>下書きに戻す</Btn> で戻せます。
        </Note>
        <Tip>
          ケアプランデータ連携 (第 6 表) の CSV 取込・出力や、
          <Btn>居宅事業所に実績送信</Btn> (居宅介護支援事業所への月次実績の送付)
          もこの画面から行えます。
        </Tip>
      </>
    ),
  },

  /* ═══ 4. 計画書・手順書 ═══ */
  {
    id: "keikakusho",
    title: "4. 計画書・手順書",
    body: (
      <>
        <P>
          サービス提供の根拠になる書類 (訪問介護計画書・手順書・アセスメント) を作成する画面です。
          いずれも「複製して変更点だけ直す」のが最短で、ゼロから入力し直す必要はありません。
        </P>

        <H>訪問介護計画書</H>
        <P>
          利用者ごとのサービス計画 (目標・提供内容) を作成する画面です。運営指導 (実地指導)
          でも必ず確認される書類です。
        </P>
        <Steps
          items={[
            "サイドバーの「訪問介護計画書」を開くと、作成済みの計画書が一覧表示されます。",
            <>
              <Btn>新規作成</Btn> で新しく作成します。前回の内容を引き継ぎたいときは{" "}
              <Btn>複製</Btn> を使うと入力の手間が省けます。
            </>,
            <>
              完成したら <Btn>印刷</Btn> でそのまま印刷し、利用者の同意 (署名) をもらいます。
            </>,
          ]}
        />
        <ManualImg src="/manual/04-care-plan.png" caption="訪問介護計画書の一覧" />

        <H>手順書</H>
        <P>
          訪問時のサービス手順 (何を・どの順で・何分で行うか) を登録する画面です。
          ヘルパーが誰でも同じ手順でサービスできるようにするための書類です。
        </P>
        <Steps
          items={[
            "サイドバーの「手順書」を開き、利用者を選びます。",
            <>
              <Btn>新規作成</Btn> または既存の手順書からの <Btn>複製</Btn> で作成します。
            </>,
            "手順 (ステップ) ごとに内容と所要時間を入力して保存します。",
          ]}
        />
        <ManualImg src="/manual/04-procedures.png" caption="手順書の一覧" />

        <H>アセスメント</H>
        <P>
          利用者の心身の状態や生活環境を評価・記録する画面です。計画書を作る前の
          「現状把握」にあたります。
        </P>
        <Steps
          items={[
            "サイドバーの「アセスメント」を開きます。",
            <>
              <Btn>新規作成</Btn> でアセスメントを作成し、各項目を入力します。
            </>,
            <>
              入力後に <Btn>印刷</Btn> で帳票として出力できます。
            </>,
          ]}
        />
        <ManualImg src="/manual/04-assessment.png" caption="アセスメントの一覧" />
      </>
    ),
  },

  /* ═══ 5. 請求業務 ═══ */
  {
    id: "seikyu",
    title: "5. 請求業務 (毎月の流れ)",
    body: (
      <>
        <P>
          サイドバーの「請求」を開くと、月次の請求業務を 1 画面で行えます。画面上部の 4 つのタブ{" "}
          <Btn>月次情報</Btn> <Btn>介護請求</Btn> <Btn>利用請求</Btn> <Btn>国保請求</Btn>{" "}
          を使い、毎月次の順番で進めます。
        </P>
        <Steps
          items={[
            "Step 0 (前提) — サービス提供表（実績）を「完成」にしておく",
            "Step 1 — 「月次情報」で請求情報が揃っているか確認する",
            "Step 2 — 「介護請求」で明細書・請求書を発行する (未発行 → 発行済)",
            "Step 3 — 内容を確認して「国保対象」にする (発行済 → 国保対象)",
            "Step 4 — 「国保請求」で伝送ファイルを出力し、国保連に送信する",
            "Step 5 — 「利用請求」で利用者向け請求書を発行し、実費・入金を管理する",
          ]}
        />
        <Word term="様式第一 / 様式第二">
          国保連請求の帳票の正式名。様式第一が「請求書」(事業所単位の合計)、
          様式第二が「明細書」(利用者ごとの明細) です。
        </Word>
        <Tip>
          <b>共通の操作</b> — 画面左の「全 / あ / か / さ /… / 他」のカナ索引をクリックすると
          利用者を絞り込めます。対象月は「◀ 年月 ▶」の月ナビで切り替えます (件数も表示されます)。
        </Tip>

        <H>Step 0 (前提) — 実績を「完成」にしておく</H>
        <P>
          請求の集計対象になるのは、サービス提供表（実績）で「完成」になった実績だけです。
          請求作業を始める前に、第 3 章の手順で対象月の全利用者の実績を「完成」に
          しておいてください。
        </P>

        <H>Step 1 — 月次情報で請求前のチェック</H>
        <P>
          <Btn>月次情報</Btn> タブで、利用者ごとの請求情報が揃っているかを確認します。
          一覧には 保険変更 / 保険者 / 被保険者番号 / 利用者名 / 利用者番号 / 作成区分 /
          支援事業所番号 / 居宅介護支援事業所名 / 区分支給限度基準内単位数 が表示されます。
        </P>
        <Steps
          items={[
            "「◀ 年月 ▶」で対象月を選びます。",
            "一覧に警告バッジが出ていないかを確認します (下記参照)。",
            "画面下部のフッタで件数・実績・合計単位数を確認します。",
          ]}
        />
        <ul className="ml-1 list-inside list-disc space-y-1 text-[13.5px] leading-relaxed text-gray-800">
          <li>
            <b className="text-red-600">認定切れ</b> (赤バッジ) — 認定有効期間が切れています。
            利用者管理の介護認定タブで <Btn>認定更新</Btn> してください。
          </li>
          <li>
            <b className="text-orange-600">担当居宅未設定</b> (橙バッジ) —
            担当居宅介護支援事業所番号が未入力です。介護認定タブで入力してください。
          </li>
        </ul>
        <ManualImg
          src="/manual/05-seikyu-tabs.png"
          caption="月次情報タブ。上部に 4 つのタブ、左にカナ索引。橙の「担当居宅未設定」バッジが警告です"
        />
        <Note>
          警告を残したまま先に進むと、返戻 (国保連から請求が差し戻されること) の原因になります。
          必ずこの段階で解消してください。
        </Note>

        <H>Step 2 — 介護請求で明細書・請求書を発行する</H>
        <P>
          <Btn>介護請求</Btn> タブで、国保連向けの明細書 (様式第二)・請求書 (様式第一)
          を発行します。利用者ごとの請求の状態は{" "}
          <b>未発行 (灰) → 発行済 (緑) → 国保対象 (赤)</b> と進みます (再請求は琥珀色)。
        </P>
        <Steps
          items={[
            "「◀ 年月 ▶」で対象月を選びます。一覧に利用者ごとの単位数・請求額が並びます。",
            <>
              請求する行にチェックを入れ、<Btn>明細書 (N件)</Btn> で明細書 (様式第二) を
              印刷します。印刷すると状態が「未発行」から「発行済」に変わります。
            </>,
            <>
              <Btn>請求書</Btn> で請求書 (様式第一) を印刷します。行の中の <Btn>明細書</Btn>{" "}
              ボタンで 1 人分だけの印刷もできます。
            </>,
          ]}
        />
        <ManualImg
          src="/manual/05-kaigo-seikyu.png"
          caption="介護請求タブ。状態バッジ (発行済 / 未発行) と行ごとの明細書ボタン、上部のツールバー"
        />
        <Tip>
          <Btn>未発行のみ</Btn> で未発行の行だけに絞り込み、<Btn>確認用CSV</Btn> で
          Excel 確認用の CSV を出力できます。フッタには合計件数 / 合計単位数 / 国保件数と、
          保険単位数・公費単位数・保険請求額・公費請求額・利用者負担額などの集計が表示されます。
        </Tip>

        <H>Step 3 — 内容を確認して国保対象にする</H>
        <Steps
          items={[
            "行をクリックして選択すると、右側の「明細情報」ペインにサービスの明細が表示されます。内容を確認します。",
            <>
              内容が確定したら、行にチェックを入れて <Btn>国保対象</Btn> を押します。
              状態が「発行済」から「国保対象」に変わり、国保請求タブに並ぶようになります。
            </>,
          ]}
        />
        <ManualImg
          src="/manual/05-kaigo-detail.png"
          caption="行を選択した状態。ツールバーの「明細書 (5件)」「請求書」「国保対象」「未発行のみ」ボタンで操作します"
        />

        <H>月遅れ・返戻・過誤の扱い</H>
        <Word term="月遅れ">
          実績の確定が間に合わず、翌月以降にまとめて請求すること。
        </Word>
        <Word term="返戻">
          国保連の審査で請求が差し戻されること。原因を直して再請求します。
        </Word>
        <Word term="過誤">
          一度支払われた請求を取り下げて出し直すこと (保険者経由の手続きが必要です)。
        </Word>
        <P>
          介護請求タブでは、行ごとの <Btn>月遅</Btn> / <Btn>返戻</Btn> の選択と{" "}
          <Btn>過誤</Btn> の◯トグルでこれらを管理します。過去月の月遅れ・返戻分は
          「過去月の月遅れ・返戻 N 件を当月請求に合流しています」という琥珀色の帯とともに
          当月の請求に自動で合流し、当月分と一緒に発行・伝送できます。
        </P>

        <H>Step 4 — 国保請求で伝送ファイルを出力する</H>
        <P>
          <Btn>国保請求</Btn> タブには、Step 3 で「国保対象」にした利用者が並びます。
          ここから国保連へ送る伝送ファイルを出力します。
        </P>
        <Steps
          items={[
            "提供年月 / 保険者番号 / 被保険者番号 / 利用者名 / 要介護度 / 単位数 / 保険請求額 / 利用者負担 を確認します。",
            <>
              出力する行にチェックを入れ、<Btn>伝送ファイル (N件)</Btn> を押すと
              伝送ファイル (様式第一 7111 + 様式第二 7131、Shift_JIS 形式) がダウンロードされます。
            </>,
            "ダウンロードしたファイルを国保中央会の「伝送通信ソフト」に取り込み、送信します (毎月 1〜10 日が送信期間です)。",
          ]}
        />
        <ManualImg
          src="/manual/05-kokuho.png"
          caption="国保請求タブ。「伝送ファイル」ボタンで国保連へ送るファイルを出力します"
        />
        <Note>
          明細書・請求書の「発行」はこのタブではできません。発行は「介護請求」タブで行います。
          内容の事前確認には <Btn>確認用CSV</Btn> を使ってください。
        </Note>

        <H>Step 5 — 利用請求で利用者への請求と入金管理</H>
        <P>
          <Btn>利用請求</Btn> タブでは、利用者本人に請求する分 (1〜3 割の自己負担 + 保険外の実費)
          の請求書発行と入金管理を行います。状態バッジは{" "}
          <b>未発行 (灰) / 請求済 (青) / 入金完 (緑) / 一部入金 (琥珀) / 未収 (赤)</b> の
          5 種類です。
        </P>
        <Steps
          items={[
            <>
              一覧で対象にチェックを入れ、緑の <Btn>請求書 (N件)</Btn> で利用者向けの請求書を
              発行します。支払方法 (振込 / 現金 / 口座振替) と請求書発行日は行内で変更できます。
            </>,
            <>
              口座振替の場合は青の <Btn>FBデータ (N件)</Btn> で全銀フォーマットのデータ
              (銀行に渡す引き落としデータ) を出力します。
            </>,
          ]}
        />
        <ManualImg
          src="/manual/05-riyou-seikyu.png"
          caption="利用請求タブ。「請求書」「FBデータ」ボタンと、世帯合算用の「名寄」列"
        />
        <Steps
          items={[
            <>
              保険外の実費は、行を選択して右側の「利用明細欄」の「利用実費（保険外）」で
              入力します。項目・単価・数量を入れて <Btn>追加</Btn> します
              (交通費 / キャンセル料 / 日用品費 / その他 のサジェストがあります)。
            </>,
            <>
              入金があったら「入金管理」で入金額・入金日・方法を入れて <Btn>入金登録</Btn>{" "}
              します。回収できない場合は <Btn>未収</Btn> にします。
            </>,
            "画面下の 2 段フッタで、請求額合計・入金額合計・未入金件数を確認します。",
          ]}
        />
        <ManualImg
          src="/manual/05-riyou-detail.png"
          caption="利用請求タブの全景。右に利用明細欄 (明細 + 利用実費 + 入金管理)、下に集計フッタ"
        />
        <Tip>
          <b>名寄 (世帯合算)</b> — 同じ世帯の 2 名以上に「名寄」チェックを入れて請求書を発行すると、
          1 枚の世帯合算請求書になります (ご夫婦で 1 通にまとめたいときなどに使います)。
        </Tip>
      </>
    ),
  },

  /* ═══ 6. 給付管理・居宅 ═══ */
  {
    id: "kyufu-kanri",
    title: "6. 給付管理・居宅 (ケアマネ版)",
    body: (
      <>
        <P>
          ケアマネ版 (居宅介護支援) の「給付管理」では、給付管理票の作成と
          居宅介護支援費の国保連請求を行います。
        </P>
        <Word term="給付管理票">
          ケアマネ (居宅介護支援事業所) が「この利用者は今月どの事業所のサービスを
          何単位使ったか」を国保連に報告する書類。サービス事業所の請求と突き合わせて審査されます。
        </Word>
        <Steps
          items={[
            "対象月を選びます。上部のサマリカードで対象利用者数・限度額内 / 超過・合計単位を確認できます。",
            <>
              <Btn>一括生成</Btn> を押すと、実績から給付管理票が自動作成されます。
            </>,
            "利用者の行を開くと明細 (サービス種別 / 事業所名 / 計画単位数 / 限度額管理対象単位数 / 超過単位数) が表示されます。計画単位数などはここで直接修正できます。",
            <>
              内容を確認したら <Btn>確定</Btn> します (<Btn>取消</Btn> で下書きに戻せます)。
            </>,
            <>
              <Btn>伝送ファイル</Btn> を押すと、給付管理票 (8211/8221) と計画費請求 (7111/8121)
              の 2 ファイル (Shift_JIS) が出力されます。伝送通信ソフトに取り込んで送信します。
            </>,
          ]}
        />
        <ManualImg
          src="/manual/06-benefits.png"
          caption="給付管理。上部のサマリカードと利用者ごとの一覧"
        />
        <Note>
          伝送の対象になるのは「確定」済みのデータだけです。また、生年月日・性別・認定期間・
          事業所番号・年度別単位数などが未登録だと出力時に警告が表示されます。警告のまま出力すると
          伝送ソフトの取込チェックでエラーになる可能性があります。
        </Note>
        <Tip>
          <Btn>確認用CSV</Btn> は Excel で内容を確認するための CSV です (伝送形式ではありません)。
        </Tip>
      </>
    ),
  },

  /* ═══ 7. 障害福祉 ═══ */
  {
    id: "shogai",
    title: "7. 障害福祉の請求",
    body: (
      <>
        <P>
          障害福祉サービス (居宅介護・重度訪問介護など) の請求は「障害請求」で行います。
          対象月に「確定」済みのサービス提供実績があることが前提です
          (障害福祉 → サービス提供実績 で記録を確定しておいてください)。
        </P>

        <H>画面の見方</H>
        <Steps
          items={[
            "サイドバーの「障害請求」を開き、対象月を選びます。",
            "左の一覧に利用者 (受給者証番号 / 利用者名 / 区分 / 総単位数 / 給付費請求額 / 利用者負担) が並びます。",
            "行をクリックすると、右側に明細情報 (サービス / 単位数 / 回数 / 総費用額 / 負担上限月額 / 利用者負担額 / 介護給付費請求額) が表示されます。",
          ]}
        />
        <ManualImg
          src="/manual/07-shogai.png"
          caption="障害請求。左が利用者一覧、右が選択した利用者の明細情報"
        />
        <P>生活保護の方は負担なしとして扱われます。</P>

        <H>上限額管理</H>
        <Word term="上限額管理">
          複数の事業所を利用している場合に、利用者負担の合計が負担上限月額を超えないよう
          調整するしくみ。管理を担当する事業所 (上限管理事業所) が調整結果をまとめます。
        </Word>
        <ul className="ml-1 list-inside list-disc space-y-1 text-[13.5px] leading-relaxed text-gray-800">
          <li>
            <b>上限管理なし</b> — 対象外と表示されます。そのまま請求できます。
          </li>
          <li>
            <b>他事業所が管理者</b> — 管理結果の区分 (1 充当 / 2 上限以下 / 3 結果票どおり)
            を選び、必要に応じて調整後負担額を入力して保存します。
          </li>
          <li>
            <b>自事業所が管理者</b> — 次の手順で調整します。
          </li>
        </ul>
        <Steps
          items={[
            "関係事業所の表 (事業所 / 総費用額 / 利用者負担額 / 管理結果後) に、他事業所分の行を追加します。",
            <>
              <Btn>調整計算</Btn> を押すと、上限を超えないよう負担額が自動調整されます。
            </>,
            <>
              <Btn>保存 (請求に反映)</Btn> で調整結果を請求に反映します。
            </>,
            <>
              <Btn>結果票印刷</Btn> で上限額管理結果票を印刷し、関係事業所に渡します。
            </>,
          ]}
        />
        <ManualImg
          src="/manual/07-shogai-jogen.png"
          caption="利用者負担上限額管理 (当事業所が管理者の場合)。調整計算 → 保存 → 結果票印刷 の順に操作します"
        />
        <Note>
          上限管理の設定 (管理事業所の登録) は、利用者管理 → 障害福祉 → 受給者証 のタブで行います。
        </Note>

        <H>伝送ファイルの出力</H>
        <Steps
          items={[
            <>
              <Btn>伝送ファイル</Btn> を押すと、請求書・明細書 (J11) / 実績記録票 (J61) /
              上限管理結果票 (J41 ※自事業所が管理者の場合のみ) の伝送ファイル (Shift_JIS) が
              出力されます。
            </>,
            "出力したファイルを「電子請求受付システム」に取り込み、送信します。",
          ]}
        />
        <Tip>
          内容の事前確認には <Btn>確認用CSV</Btn> を使ってください。
        </Tip>
      </>
    ),
  },

  /* ═══ 8. こまったとき (FAQ) ═══ */
  {
    id: "faq",
    title: "8. こまったとき (FAQ)",
    body: (
      <>
        <H>Q1. 予定が表示されない</H>
        <P>
          パターン登録で <Btn>月間へ展開</Btn> を実行したか確認してください。展開の対象になるのは
          保存済みのパターンだけです。また、シフト管理・提供表で見ている「対象月」が正しいかも
          確認してください。
        </P>
        <H>Q2. 実績が請求に出てこない</H>
        <P>
          サービス提供表（実績）が「完成」になっているか確認してください。「下書き」のままだと
          請求に集計されません。実績の入力漏れがないかもあわせて確認します。
        </P>
        <H>Q3. 「認定切れ」の警告が出る</H>
        <P>
          認定有効期間が切れています。利用者管理 → 介護保険 → 介護認定 タブで{" "}
          <Btn>認定更新</Btn> を行い、新しい認定有効期間を登録してください。
        </P>
        <H>Q4. 「担当居宅未設定」の警告が出る</H>
        <P>
          利用者管理 → 介護保険 → 介護認定 タブの水色のボックスに、担当居宅介護支援事業所番号
          (10 桁) を入力してください。この番号は明細書 (様式第二) に反映されるため、未入力のまま
          請求すると返戻の原因になります。
        </P>
        <H>Q5. 国保請求タブに利用者が出てこない</H>
        <P>
          「介護請求」タブで <Btn>国保対象</Btn> にした利用者だけが国保請求タブに並びます。
          状態が「未発行」「発行済」のままになっていないか、介護請求タブで確認してください。
        </P>
        <H>Q6. 伝送ファイルの取込でエラーになる</H>
        <P>
          出力時に「以下の項目が不足しています…」の警告が出ていた場合は、その項目
          (生年月日・性別・認定期間・事業所番号など) を先に登録してから出力し直してください。
          それでも解決しない場合は、伝送ソフトのエラー画面をそのまま管理者に送ってください。
        </P>
        <H>Q7. 印刷したらメニュー (サイドバー) が写ってしまう</H>
        <P>
          最新版では修正済みです。古い画面が残っている可能性があるので、ブラウザを再読み込み
          (Ctrl + F5) してからもう一度印刷してください。
        </P>
      </>
    ),
  },
];

/* ═══════════════════════════════════════════════════════════════════════════
   表示コンポーネント
   ═══════════════════════════════════════════════════════════════════════ */

export function ManualContent() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden print:block print:overflow-visible">
      {/* ── ヘッダー ── */}
      <div className="flex items-center justify-between border-b bg-white px-6 py-3 shrink-0 print:border-0 print:px-0">
        <div className="flex items-center gap-3">
          <BookOpen size={22} className="text-blue-600 print:hidden" />
          <div>
            <h1 className="text-lg font-bold text-gray-900">
              ほのぼの改（仮）操作マニュアル
            </h1>
            <p className="text-[11.5px] text-gray-500">
              第 {MANUAL_VERSION} 版 ・ 最終更新 {MANUAL_UPDATED}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 print:hidden"
        >
          <Printer size={14} />
          印刷
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden print:block print:overflow-visible">
        {/* ── 左: 目次 (印刷時は非表示) ── */}
        <nav className="w-56 shrink-0 overflow-y-auto border-r bg-white p-4 print:hidden">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            目次
          </p>
          <ul className="space-y-0.5">
            {SECTIONS.map((sec) => (
              <li key={sec.id}>
                <a
                  href={`#${sec.id}`}
                  className="block rounded px-2 py-1.5 text-[12.5px] text-gray-700 hover:bg-blue-50 hover:text-blue-700"
                >
                  {sec.title}
                </a>
              </li>
            ))}
            <li>
              <a
                href="#kaitei-rireki"
                className="block rounded px-2 py-1.5 text-[12.5px] text-gray-700 hover:bg-blue-50 hover:text-blue-700"
              >
                更新履歴
              </a>
            </li>
          </ul>
        </nav>

        {/* ── 右: 本文 ── */}
        <main className="flex-1 overflow-y-auto bg-gray-50 print:overflow-visible print:bg-white">
          <div className="mx-auto max-w-3xl space-y-6 p-6 print:max-w-none print:space-y-4 print:p-0">
            {SECTIONS.map((sec) => (
              <section
                key={sec.id}
                id={sec.id}
                className="scroll-mt-4 rounded-lg border bg-white p-5 shadow-sm print:rounded-none print:border-0 print:p-0 print:shadow-none"
              >
                <h2 className="mb-3 border-b border-gray-100 pb-2 text-[16px] font-bold text-gray-900">
                  {sec.title}
                </h2>
                <div className="space-y-2">{sec.body}</div>
              </section>
            ))}

            {/* ── 更新履歴 ── */}
            <section
              id="kaitei-rireki"
              className="scroll-mt-4 rounded-lg border bg-white p-5 shadow-sm print:break-inside-avoid print:rounded-none print:border-0 print:p-0 print:shadow-none"
            >
              <h2 className="mb-3 border-b border-gray-100 pb-2 text-[16px] font-bold text-gray-900">
                更新履歴
              </h2>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b bg-gray-50 text-left text-[11.5px] text-gray-500">
                    <th className="px-3 py-1.5 w-16">版</th>
                    <th className="px-3 py-1.5 w-28">日付</th>
                    <th className="px-3 py-1.5">内容</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {REVISIONS.map((r) => (
                    <tr key={r.version}>
                      <td className="px-3 py-1.5 tabular-nums">{r.version}</td>
                      <td className="px-3 py-1.5 tabular-nums">{r.date}</td>
                      <td className="px-3 py-1.5 text-gray-700">{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <p className="pb-8 text-center text-[11px] text-gray-400 print:pb-0">
              ほのぼの改（仮）操作マニュアル 第 {MANUAL_VERSION} 版 ({MANUAL_UPDATED})
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
