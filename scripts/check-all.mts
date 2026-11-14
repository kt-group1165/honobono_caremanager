/**
 * ★ 金額に効く検査をまとめて回す (push 前のゲート)
 *
 *   npm run check:all              全部
 *   npm run check:all -- --fast    ★ 遅いもの (伝送突合 約4分) を飛ばす
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   check: が ★ 24 本まで増えて、どれを回せばよいか分からなくなった。
 *   ★ 「金額が変わったら落ちる」ものだけを 1 コマンドにまとめる。
 *
 * ⚠ ★ 「全部緑」は「正しい」ではありません。何を ★ 見ていないかは下の一覧に書きます。
 * ⚠ ここに無い check も価値はあります。★ 落ちても金額が動かないもの (帳票の空欄検査 等) を
 *   外しているだけです。
 */
import { spawnSync } from "node:child_process";

const FAST = process.argv.includes("--fast");

/**
 * kind
 *   "strict"   ★ 0 を目指す。壊れたら (=差が出たら) 落ちる
 *   "baseline" ★ 既知の差・既知のリスク件数を基準値として許容したうえでの PASS。0件PASSではない
 * knownDiff — baseline のとき、現在許容している既知差の件数 (数える単位が同じもののみ設定)。
 */
type Check = { name: string; script: string; why: string; slow?: boolean; kind?: "strict" | "baseline"; knownDiff?: number };

/**
 * ★ 「サンプル未投入で分母0のためPASS(exit 0)」を、出力本文の文言から機械的に検出する。
 * kaigo-app の *-sample-verify.mts / verify-jogen-kanri.mts はこの言い回しの規約に従う。
 * (2026-09-05 claude-06 指摘: PASSの中に「本当にPASS」と「未検証」が混ざって見分けが付かなかった)
 */
const NO_SAMPLE_MARKERS = ["サンプル未投入", "合格とは言わない", "合格でも不合格でもありません"];
function looksLikeNoSampleSkip(out: string): boolean {
  return NO_SAMPLE_MARKERS.some((m) => out.includes(m));
}

/** ★ 落ちたら金額か返戻に効くものだけ */
const CHECKS: Check[] = [
  { name: "smoke", script: "smoke", why: "集計の回帰 (金額)。指紋で「データが変わった」と区別する" },
  { name: "invariant", script: "check:invariant", why: "★ 17条件を 全事業所・4制度に当てる (内部の関係が壊れていないか)" },
  { name: "densou", script: "check:densou", why: "伝送前の事前点検 (返戻・過大請求の元)" },
  { name: "anon", script: "check:anon", why: "★ 個人情報が anon から読めないか (分母は PostgREST の 228 表)" },
  { name: "no-pii", script: "check:no-pii", why: "★ 被保険者番号などが repo に新しく入らないか (DB 不使用・1.4 秒・負のコントロール付き。基準値方式)", kind: "baseline" },
  { name: "addon-lines", script: "check:addon-lines", why: "★ 加算行の 書式ずれ (制度で読み方が違う) と マスタ実在" },
  { name: "month-format", script: "check:month-format", why: "★ 月を表す text 列 39 個の 書式ずれ (書く側と読む側で違うと 0 件になる)" },
  // ★ 同じ規約を 2 箇所で別々に持っているもの の見張り。TS から .mjs を import できないため
  //   実績の行種マーカーが TS 側と取込 script 側に 二重定義されている。片方だけ直すと
  //   ★ 請求集計と実績記録票の判定が 黙って食い違う (落ちないので気づけない)。
  { name: "record-markers", script: "check:record-markers", why: "★ 行種マーカーの TS/.mjs 二重定義が ずれていないか" },
  //   ★ 同型。過去に 574 件の実バグ (キーが揃わず支給量欄が空・超過警告が出ない)。
  { name: "shikyuryo-keys", script: "check:shikyuryo-keys", why: "★ 支給量キーの TS/.mjs 二重定義が ずれていないか" },
  // ★ sample seed が「今も起動するか」だけを見る (DRY RUN・DB 書込なし)。
  //   ★ 2026-09-05 に 14 本中 2 本が起動しなくなっていた (_sample_data.mjs の変更に追随漏れ)。
  //   ★ 「検証済み」と文書にあっても 再実行したら動かない、が実在したので gate に置く。
  { name: "sample-seeds", script: "check:sample-seeds", why: "★ サンプル seed 14 本が DRY RUN で起動するか (壊れると検証手段ごと失う)" },
  // ★ 2026-09-14 新設。DB不要・ローカルJSON比較のみで軽い。1b2e9a0aで四街道6名が
  //   無関係commitに巻き込まれ対応表から消えた事故 (件数は変わらず検知できなかった)の再発防止。
  { name: "meisai-map-keys", script: "check:meisai-map-keys", why: "★ MEISAI対応表のキーが無関係commitで消えていないか (件数一致の入れ替わりも検知)" },
  // ★ 2026-09-05 に積み上がった純関数の検査。★ どれも 落ちたら金額が動く。
  //   ★ 1 本 2 秒程度で DB を使わないので gate に入れて問題ない。
  { name: "shuchu-gensan", script: "check:shuchu-gensan", why: "特定事業所集中減算 (80%/法人)" },
  { name: "kyotaku-addon-active", script: "check:kyotaku-addon-active", why: "居宅加算の月次有効判定・地域単価 (月末/翌月1日の境界)" },
  { name: "shogai-unit-price", script: "check:shogai-unit-price", why: "★ 障害の地域区分単価 (人件費割合 60%。介護の 70% と取り違えやすい)" },
  { name: "juho-tier", script: "check:juho-tier", why: "★ 重度訪問介護の段判定 (NFKC で Ⅱ が壊れる)" },
  { name: "shogai-fukushi-billing", script: "check:shogai-fukushi-billing", why: "障害福祉のコード検索" },
  { name: "same-building", script: "check:same-building", why: "同一建物減算" },
  { name: "seikatsu-enjo", script: "check:seikatsu-enjo", why: "生活援助中心型の回数制限" },
  { name: "visit-addons", script: "check:visit-addons", why: "訪問介護の加算 (116274 混入ガード)" },
  // ★ 2026-09-05 の 45 本仕分け (J) で ★ 「作ったのに 回す入口が無かった」と分かったもののうち、
  //   ★ 金額か返戻に直結する 9 本を編入。★ 全部 実行して EXIT=0 を確認済み。
  { name: "fb-zengin", script: "check:fb-zengin", why: "★ 全銀フォーマット (口座振替。桁・カナが崩れると 引き落とし不能)" },
  { name: "kohi-duplicate", script: "check:kohi-duplicate", why: "★ 公費の重複 (取込のたびに増える。部分公費が来た月に返戻)", slow: true },
  { name: "kohi-tiebreak", script: "check:kohi-tiebreak", why: "公費が複数あるときの採用順" },
  { name: "keikakuhi-8124", script: "check:keikakuhi-8124", why: "居宅介護支援費 8124 の組み立て" },
  { name: "kyufu-kanri-8222", script: "check:kyufu-kanri-8222", why: "給付管理票 8222 の組み立て" },
  { name: "kyufu-kanri-boundary", script: "check:kyufu-kanri-boundary", why: "給付管理票の境界値" },
  { name: "shogai-j11-boundary", script: "check:shogai-j11-boundary", why: "障害 J11 系の境界値" },
  { name: "shogai-j411-boundary", script: "check:shogai-j411-boundary", why: "障害 J411 (上限管理) の境界値" },
  { name: "gendo-allocation", script: "check:gendo-allocation", why: "区分支給限度基準額 超過の割振り (★ 超過単位は 自費金額に直結)" },
  // ★ 2026-09-05 新設。★ 2 つの役割: ① TS と 取込.mjs の按分ロジックが一致するか (総当たり)
  //   ② ★ 実データに 時間帯またぎの行が出現したら 検知する (★ 今 0 件。★ 出たら この経路が発火し始めた)
  { name: "shogai-code-from-time", script: "check:shogai-code-from-time", why: "★ 障害 時刻→コードの2実装一致 + またぎ行の出現監視 (基準値0件)" },
  // ★ 2026-09-05 新設。★ 5 箇所にコピーされていた「有効な計画を選ぶ」を一本化した純関数。
  { name: "careplan-selection", script: "check:careplan-selection", why: "★ 有効なケアプランの選択 (期限切れ判定の境界値。当日は期限切れにしない)" },
  // ★ ①status=active なのに期限切れ 284名 / ②実害 (有効な計画が隠れる) 0名 を基準値方式で。
  //   ★ ②が増えたら FAIL。★ ①は 更新されれば減る性質なので 参考情報。
  { name: "careplan-expiry", script: "check:careplan-expiry", why: "★ 期限切れケアプランの露出 (基準値: ①284名 ②実害0名)" },
  // ★ 2026-09-05 新設。★ 帳票に保存された 要介護度等が 現在の認定と食い違う問題 (218件) の是正。
  //   ★ 印刷プレビューだけ マスタ優先で引き直す (★ 編集フォームは 生の値のまま)。
  { name: "report-master-fields", script: "check:report-master-fields", why: "★ 帳票のマスタ引き直し (要介護度・認定日・保険者等を 印刷時に現在の認定から引く)" },
  // ★ 保存値とマスタのズレ件数 (基準値 218: 第1表122 / 利用票96)。★ 認定更新のたび自然に増えるので
  //   ★ 0 を目指さない。★ 想定外の急増だけを検知する。
  { name: "report-master-drift", script: "check:report-master-fields-drift", why: "★ 帳票の保存値と 印刷が選ぶ認定 (certification_id → 対象月に有効な認定 → 現在) のズレ件数 (基準値 1。2026-11-09 に印刷と同じ選び方へ是正)" },
  // ★ 2026-09-05 新設。★ 予防46 は レセプトが 0 件なので 実データでは一度も通っていない。
  //   ★ 純関数の合成テスト (DB 書込なし)。★ 事業所番号が入った日に 動くことの担保。
  { name: "yobo-shien-densou", script: "check:yobo-shien-densou", why: "★ 介護予防支援(46) の伝送組み立て (★ レセプト0件のため 合成テストのみ)" },
  // ★ 2026-09-05 修正 (B-1w)。★ 要支援に 介護給付のコードが付いていた (1,266単位 → 正 856単位)。
  //   ★ 訪問入浴は 稼働前で実データ 0 行のため ★ 未発火のうちに直した。★ 0 件維持の検査。
  { name: "bath-yobo-code", script: "check:bath-yobo-code", why: "★ 訪問入浴: 要支援に介護給付コードが付かないか (0件維持)" },
  { name: "kyotaku-matrix", script: "check:kyotaku-matrix", why: "居宅介護支援の単位数 (加算・減算・逓減)" },
  { name: "idou-summary", script: "check:idou-summary", why: "移動支援の負担額・上限" },
  { name: "shikyuryo-cap", script: "check:shikyuryo-cap", why: "★ 障害 支給量を超えた訪問を請求から外す判定 (ほのぼの準拠・1人換算)" },
  { name: "riyou-final", script: "check:riyou-final", why: "利用者請求書の最終額 (軽減・実費・繰越)" },
  { name: "beppyo-plan-units", script: "check:beppyo-plan-units", why: "★ 第7表 → 訪問介護の計画単位数 (同じ人に 2 件 / 限度超過は書かない。DB 不使用)" },
  { name: "sougou-shoguu", script: "check:sougou-shoguu", why: "総合事業の処遇改善 (自治体独自率)" },
  { name: "shoguu-4impl", script: "check:shoguu-4impl", why: "★ 処遇改善の % 計算が 4 制度の実装で一致するか" },
  { name: "service-code-gap", script: "check:service-code-gap", why: "★ 単位数0・加算率未設定のコードが 実発火しうるか",
    kind: "baseline" }, // 「理論上のみ」の件数は基準値 (0件を目指す検査ではない)。実発火(NG)は0を維持
  { name: "teigen", script: "check:teigen", why: "逓減制" },
  { name: "shogai-jogen", script: "check:shogai-jogen", why: "障害の上限額管理" },
  { name: "tokutei", script: "check:tokutei", why: "特定事業所加算" },
  // ★ 訪問入浴は 実データが 0 行だが、これだけは Supabase をモックする純関数テストなので
  //   ★ DB 書込を伴わない = gate に入れてよい (もう一方の check:bath-sample は
  //   サンプル投入が要るので 意図的に入れていない)。2026-09-05 に編入。
  { name: "bath-fixture", script: "check:bath-fixture", why: "★ 訪問入浴の請求 (DB書込不要のモックテスト。実データは 0 行)" },
  // ★ 2026-09-05 追加。apply.ts は本番コードなのに検証0本だった (parse.ts の fixture テストはあるが
  //   ★ DB反映ロジック=返戻フラグ/支払決定額/冪等性 は未検証)。Supabase を丸ごとモックするので DB書込不要。
  { name: "kokuho-tsuchi", script: "check:kokuho-tsuchi", why: "★ 国保連通知取込の DB 反映 (突合フォールバック・返戻/支払決定の冪等性・金額境界値。モックのみ)" },
  { name: "kyotaku-diff", script: "check:kyotaku-diff", why: "★ 居宅の伝送バイト照合 (ほのぼの実出力との突合。認定更新で差が増えるので 回帰だけ見張る)", slow: true,
    kind: "baseline" }, // 基準値=現状の一致率。認定更新のたび差が動くため0件を目指さない
  { name: "densou-diff", script: "check:densou-diff", why: "★ ほのぼの実出力との突合 (介護保険7拠点 + 障害17拠点)", slow: true,
    kind: "baseline" }, // 同上。分母が違う=データが変わった/一致数が下がった=回帰、で区別する運用
  // ★ 2026-11-09 新設 (FY-H)。負担割合証 (期間ごと) と認定行の割合の食い違い・負担割合証なしで請求した件数。
  //   表 client_benefit_certificates が未作成の間は ほのぼの CSV をメモリ上で見込みとして数える (出どころ=csv)。
  //   表を適用・取込したら出どころが db に変わり比較をやめる (exit 0・合格ではない) → 中身を見て --update。
  { name: "futan-period", script: "check:futan-period", why: "★ 負担割合証の期間と月ごとの負担割合 (食い違い・証なしで請求。基準値方式)", slow: true,
    kind: "baseline" }, // 2026-06: 証なし 559 名 / 食い違い 0 (件数は区分ごとなので合計に含めない)
];

/**
 * ★ この一覧が見ていないもの。緑でも安心しないための明示
 * ★ 2026-11-13: 文書は古くなるので、件数で言えるものは ★ 回すたびに実測する (measureNotCovered)。
 *   実測できなかったときは「実測できず」と出して止めない (この一覧は合否に関わらない)。
 *   ハードコードのまま残るものは ★ 確かめた日付と出どころを書く。
 *   2026-11-13 に直した古い記載: 「福祉用具のほのぼの実出力が 1 本も無い」→ ケアサポ分は手元にある /
 *   「住宅改修の請求の実装が存在しない」→ 2026-10-15 に「請求はシステムの外」で決着 (DECISIONS_PENDING B-2h)
 */
async function measureNotCovered(): Promise<string[]> {
  const { readFileSync, readdirSync, existsSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  let env: Record<string, string> = {};
  try {
    env = Object.fromEntries(readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => l.includes("="))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { /* 下で「実測できず」になる */ }
  const count = async (q: string): Promise<string> => {
    try {
      const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${q}${q.includes("?") ? "&" : "?"}limit=1`,
        { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer: "count=exact" } });
      if (!r.ok) return `実測できず (${r.status})`;
      return (r.headers.get("content-range") ?? "").split("/")[1] ?? "実測できず";
    } catch (e) { return `実測できず (${e instanceof Error ? e.message : e})`; }
  };
  const months = async (): Promise<string> => {
    try {
      const m: Record<string, number> = {};
      for (let off = 0; ; off += 1000) {
        const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/kaigo_report_documents?select=id,report_month&report_type=eq.service-usage&order=id.asc&limit=1000&offset=${off}`,
          { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
        if (!r.ok) return `実測できず (${r.status})`;
        const d = (await r.json()) as { report_month: string | null }[];
        for (const x of d) m[x.report_month ?? "(なし)"] = (m[x.report_month ?? "(なし)"] ?? 0) + 1;
        if (d.length < 1000) break;
      }
      return Object.entries(m).sort().map(([k, v]) => `${k} ${v}`).join(" / ");
    } catch (e) { return `実測できず (${e instanceof Error ? e.message : e})`; }
  };
  /** 伝送データ/<拠点>/福祉用具/<月>/ほのぼのから/ にあるほのぼの実出力 (KK・明細書明細付) の拠点と月 */
  const fukuyoguFiles = (): string => {
    const base = join(ROOT, "伝送データ");
    if (!existsSync(base)) return "実測できず (伝送データが無い)";
    const hits: string[] = [];
    for (const area of readdirSync(base)) {
      const fy = join(base, area, "福祉用具");
      if (!existsSync(fy)) continue;
      const ms = readdirSync(fy).filter((m) => /^\d{6}$/.test(m) && existsSync(join(fy, m, "ほのぼのから"))
        && readdirSync(join(fy, m, "ほのぼのから")).some((f) => /^KK.*\.CSV$|^KDS0031/i.test(f)));
      if (ms.length) hits.push(`${area} ${ms[0]}〜${ms[ms.length - 1]} (${ms.length} か月)`);
    }
    return hits.length ? hits.join(" / ") : "0 拠点";
  };
  const [bathVisit, bathSched, yobo46, claimsAll, detail, usage] = await Promise.all([
    count("kaigo_bath_visit_records?select=id"), count("kaigo_bath_schedule?select=id"),
    count("kaigo_care_support_claims?select=id&care_support_code=like.46*"), count("kaigo_care_support_claims?select=id"),
    count("kaigo_report_documents?select=id&report_type=eq.service-usage-detail"), months(),
  ]);
  return [
    `訪問入浴の ★ 実データ — 実績 ${bathVisit} 行 / 予定 ${bathSched} 行 (check:bath-fixture はモック。★ 実データでは一度も通っていない)`,
    `介護予防支援(46) — ★ レセプト ${yobo46} 件 (居宅のレセプト全体 ${claimsAll} 件中)`,
    // ★ 無い事業所の名前を決め打ちで書かない (2026-11-13 に誉田 = Hanaムツミ の分が届き、「4 事業所は無い」が古くなった)
    `福祉用具 — order-app 側。★ ほのぼの実出力があるのは ${fukuyoguFiles()} だけ。` +
      "福祉用具 5 事業所 (ケアサポ・高品・誉田・茂原・花見川) のうち ここに出ない事業所は実出力が無い (請求規模は order-app fukuyogu-coverage-check を見る)",
    "住宅改修 — 請求はシステムの外 (2026-10-15 に決着。DECISIONS_PENDING B-2h/B-2j)。書類・進捗・原価は order-app 側",
    "payroll-app の給与本体 — ★ 別アプリ。apps/payroll-app 側で回す",
    "国保連からの通知取込 — ★ 実ファイルで一度も検証していない (check:kokuho-tsuchi はモック fixture のみ。" +
      "実ファイルは repo 内のどこにも見つからず (2026-11-13 にも 伝送データ・サービス実績データ・Box の出力先を探して 0 本)、初回取込時のプレビュー目視確認が必須。" +
      "また過誤決定(取消)通知は仕様書上も専用フィールドが無く、マイナス金額の通常通知と構造上区別できない)",
    `利用票 (第6表) の検証の月 — ★ 利用票は ${usage}。伝送 KY は 2026-06・2026-07 がある (check:riyouhyou-units が突き合わせられるのは両方そろう月だけ)`,
    `利用票 (第7表 別表 service-usage-detail) — ★ ${detail} 件 (別表を出した拠点の分だけ。` +
      "請求に効く限度額超過の割り振りは 第7表画面の GendoAllocationPanel が第7表の items から計算する)",
    // ★ 件数を書かない (2026-11-13 にここへ書いた「9,006 行中 1,491 行」が同じ日のうちに古くなった)。数は検査が毎回出す
    "利用票の福祉用具貸与の単位数 — ★ まだ全部は入っていない。件数は `npm run check:rental-units` (事業所別・出どころ別・基準値方式) を見ること。" +
      "残りは各拠点の別表を出して migrations/import_riyouhyou_bundle.mjs で埋める",
  ];
}

const results: { name: string; ok: boolean; ms: number; skipped?: boolean; out?: string; kind: "strict" | "baseline"; knownDiff?: number; noSample?: boolean }[] = [];
for (const c of CHECKS) {
  const kind = c.kind ?? "strict";
  if (FAST && c.slow) { results.push({ name: c.name, ok: true, ms: 0, skipped: true, kind, knownDiff: c.knownDiff }); continue; }
  process.stdout.write(`\n${"=".repeat(70)}\n▶ ${c.name}  — ${c.why}\n${"=".repeat(70)}\n`);
  const t = Date.now();
  // ⚠ stdio:"inherit" だと、この出力を tail 等に通したとき ★ 子の出力だけ落ちる。
  //   2026-09-04 に実際に踏んだ: invariant が FAIL したのに ★ 理由が残らなかった。
  //   pipe で受けて自分で出し、失敗したぶんは ★ 末尾に再掲する。
  const r = spawnSync("npm", ["run", c.script], { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  results.push({ name: c.name, ok: r.status === 0, ms: Date.now() - t, out, kind, knownDiff: c.knownDiff, noSample: looksLikeNoSampleSkip(out) });
}

console.log(`\n${"=".repeat(70)}\n結果\n${"=".repeat(70)}`);
for (const r of results) {
  const mark = r.skipped ? "－ skip" : r.noSample ? "？ 未検証" : r.ok ? "  PASS" : "★ FAIL";
  const kindTag = r.kind === "baseline" ? " [基準値]" : "";
  const noSampleTag = r.noSample ? " (サンプル未投入。合格ではない)" : "";
  console.log(`${mark}  ${r.name.padEnd(16)} ${r.skipped ? "" : `${(r.ms / 1000).toFixed(1)}s`}${kindTag}${noSampleTag}`);
}
// ── 負のコントロールの有無を ★ 実行時の出力から数える (2026-11-14 H 依頼) ─────────────────────────
//   ラベルを手で付けると古くなるので、各検査の出力に「負のコントロール」の行があるかで決める。
//   auto    = 「負のコントロール」を含む行があり、✗/鳴らない/失敗 を含まない (壊した実装・期待値を外す 等を毎回回している)
//   example = 「出てはいけない例のみ」を含む行 (境界の否定例があるだけ。壊した実装は回していない)
//   none    = 行が無い
//   broken  = 「負のコントロール」の行に ✗/鳴らない/失敗 がある → ★ FAIL にする
//   ⚠ 書式はまだ揃っていない (「■ 負のコントロール: … ✓」「(負のコントロール込み)」「§9 負のコントロール」などが混在)。
//     いまは「行があるか」までしか見ていない。揃えたら「■ 負のコントロール:」で始まる行に絞る
export function negControlStatus(out: string): "auto" | "example" | "none" | "broken" {
  const lines = out.split(/\r?\n/).filter((l) => l.includes("負のコントロール"));
  if (!lines.length) return "none";
  if (lines.some((l) => /✗|鳴らない|失敗/.test(l))) return "broken";
  if (lines.every((l) => l.includes("出てはいけない例のみ"))) return "example";
  return "auto";
}
{ // 境界 (DB 不要)
  const cases: [string, string][] = [
    ["■ 負のコントロール: 架空の被保番 → ① 1 ✓ 鳴る", "auto"],
    ["PASS — 20 件すべて一致 (負のコントロール込み)", "auto"],
    ["■ 負のコントロール (出てはいけない例のみ): 未定義コードは振替しない ✓", "example"],
    ["■ 負のコントロール: 一致キーが 1 つも無く実施できない ✗", "broken"],
    ["PASS — 10 件", "none"],
  ];
  const bad = cases.filter(([o, w]) => negControlStatus(o) !== w);
  if (bad.length) { console.error(`✗ negControlStatus の境界: ${bad.map(([o]) => o).join(" / ")}`); process.exit(1); }
}
const negOf = new Map(results.filter((r) => !r.skipped && r.out != null).map((r) => [r.name, negControlStatus(r.out!)]));
for (const r of results) if (negOf.get(r.name) === "broken") r.ok = false;
const negGroups = { auto: [] as string[], example: [] as string[], none: [] as string[], broken: [] as string[] };
for (const [n, st] of negOf) negGroups[st].push(n);
console.log(`★ 負のコントロール (出力から数えた・回した ${negOf.size} 本): あり ${negGroups.auto.length} / 出てはいけない例のみ ${negGroups.example.length} / ★ 出していない ${negGroups.none.length}${negGroups.broken.length ? ` / ✗ 鳴らない ${negGroups.broken.length} (FAIL)` : ""}`);
if (negGroups.example.length) console.log(`   出てはいけない例のみ: ${negGroups.example.join(", ")}`);
if (negGroups.none.length) console.log(`   出していない: ${negGroups.none.join(", ")}`);
if (negGroups.broken.length) console.log(`   ✗ 鳴らない: ${negGroups.broken.join(", ")}`);
console.log("   ⚠ 見ていないもの: 行を出していても中身が空振り (壊した実装が同じ結果を返す) の場合は見抜けない / --fast で飛ばした検査は数えていない");
console.log("");
const failed = results.filter((r) => !r.ok);
console.log("");
console.log("⚠ この一覧が ★ 見ていないもの (件数は今回の実測):");
for (const n of await measureNotCovered()) console.log(`   ${n}`);
console.log("");

// ★ [基準値] は「0件PASS」ではない。既知の差・既知のリスクを許容している検査を一覧化する
// (2026-09-05 claude-06 指摘: PASSの中に2種類が混ざっていて出力から区別が付かなかった)。
const baselineChecks = results.filter((r) => r.kind === "baseline" && !r.skipped);
if (baselineChecks.length) {
  console.log("★ 基準値方式の検査 (既知の差を許容したうえでのPASS。0件PASSではない):");
  for (const r of baselineChecks) {
    console.log(`   ${r.name.padEnd(16)} ${r.knownDiff != null ? `既知 ${r.knownDiff} 件` : "(件数は出力本文を参照)"}`);
  }
  const summable = baselineChecks.filter((r) => r.knownDiff != null);
  if (summable.length) {
    const total = summable.reduce((s, r) => s + (r.knownDiff ?? 0), 0);
    console.log(`   → 合計 (同一単位=既知差件数で数えられるもののみ): ${total} 件 (${summable.map((r) => r.name).join(" + ")})`);
  }
  console.log("");
}
const noSampleChecks = results.filter((r) => r.noSample);
if (noSampleChecks.length) {
  console.log(`？ サンプル未投入で「合格」でも「不合格」でもない検査: ${noSampleChecks.map((r) => r.name).join("、")}`);
  console.log("");
}
if (failed.length) {
  // ★ 失敗したものの出力を末尾に再掲する。上に流れて見えなくなるため
  const bar = "=".repeat(70);
  for (const f of failed) {
    console.log(`\n${bar}\n★ FAIL の再掲 — ${f.name}\n${bar}`);
    console.log((f.out ?? "").split("\n").slice(-40).join("\n"));
  }
  console.log(`\n★ FAIL ${failed.length} 件: ${failed.map((f) => f.name).join(" / ")}`);
  process.exit(1);
}
console.log(`PASS — ${results.filter((r) => !r.skipped).length} 本${FAST ? " (★ --fast: 伝送突合を飛ばしています)" : ""}`);
