// ============================================================================
// 障害 サービス提供実績記録票 (J611) の生成ロジック検証。
//
//   対象: src/lib/shogai-densou/build.ts の buildShogaiDensou()
//         様式1 (0101 居宅介護) / 様式19 (1901 同行援護) / 様式3-1 (0301 重度訪問介護)
//
//   ⚠ **DB には一切書き込まない。** buildShogaiDensou は純関数 (入力 = 利用者+実績の
//     配列、出力 = 伝送ファイル文字列) なので、合成入力を直接渡して出力を突合できる。
//     テスト用 client を作る必要が無いので、後片付けの取りこぼしも起こらない。
//
//   ⚠ 合成入力の**形は実データから実測して決めた** (推測しない)。2026-06 の
//     kaigo_visit_schedule (system=障害 / status=completed / 12,373 行) を数えた結果:
//       重訪 3,643 行 (加算行 3,356 / 通常行 287)  (利用者×日) 265 日
//         1日1行 243 日 / 1日2行 22 日 (2行は全部 **別時刻**。同一時刻は 0)
//         ・2人 の通常行 0 / 287     熟練同行 0 / 3,643
//       同行援護 136 行 (通常 135)   居宅介護 8,507 行   行動援護 **0 行**
//       0時またぎ 141 行、うち J611 明細に出る (加算行以外) 37 行
//     ケース C/D/G は本番カバレッジ 0 の経路 = 実データでは検証できないので
//     ここで押さえる、という位置づけ。
//
//   使い方: npx tsx migrations/verify_j611_jisseki.mts
// ============================================================================
import {
  buildShogaiDensou,
  type ShogaiDensouUser,
  type ShogaiDensouVisit,
} from "../src/lib/shogai-densou/build";
import type { ShogaiSeikyuRow } from "../src/lib/shogai-seikyu/aggregate";

// ─── 合成入力のひな型 ────────────────────────────────────────────────────────
const baseRow = (over: Partial<ShogaiSeikyuRow> & { user_id: string; user_name: string }): ShogaiSeikyuRow => ({
  user_name_kana: "テスト",
  beneficiary_number: "1234567890",
  municipality: "121004",
  support_level: "区分6",
  self_payment_limit: 0,
  seiho: false,
  details: [],
  addons: [],
  addonUnits: 0,
  addonLabel: null,
  addonCode: null,
  totalUnits: 1000,
  unitPrice: 10,
  totalAmount: 10000,
  userAmount: 0,
  benefitAmount: 10000,
  jogenKanriKubun: "なし",
  jogenKanriOfficeNumber: null,
  jogenKanriOfficeName: null,
  kanriResult: null,
  kanriResultAmount: null,
  certStart: "2026-04-01",
  certEnd: "2027-03-31",
  shikyuryoOver: [],
  ...over,
});

const visit = (
  date: string,
  start: string | null,
  end: string | null,
  minutes: number | null,
  code: string,
  name: string,
  extra: Partial<ShogaiDensouVisit> = {},
): ShogaiDensouVisit => ({
  date,
  startTime: start,
  endTime: end,
  durationMinutes: minutes,
  category: null,
  serviceCode: code,
  serviceName: name,
  ...extra,
});

/** 重訪の段: convs[0] = 通常行 / convs[1..] = 加算行 (取込 script と同じ形) */
const juhoLadder = (
  date: string,
  start: string,
  end: string,
  minutes: number,
  headName: string,
  rungs: number,
): ShogaiDensouVisit[] => {
  const out = [visit(date, start, end, minutes, "121271", headName)];
  for (let i = 1; i < rungs; i++) {
    out.push(visit(date, start, end, minutes, "121281", "重訪Ⅱ日中１．５", { isAddon: true }));
  }
  return out;
};

const mkUser = (row: ShogaiSeikyuRow, visits: ShogaiDensouVisit[]): ShogaiDensouUser => ({
  row,
  visits,
  contracts: [],
  contractAmountText: null,
  contractStartDate: "2026-04-01",
  contractEntryNumber: "1",
  jogenOfficeLines: null,
});

const OPTS = { officeNumber: "1210101760", year: 2026, month: 6, unitPrice: 10, areaCategory: "その他" };

// ─── J61 ファイルのパース ────────────────────────────────────────────────────
//   伝送レコード: "2",連番,<項目1>,<項目2>,… なので **項番 n = CSV index n+1**
type Rec = { kind: string; yoshiki: string; f: string[] };
function parseJ61(content: string): Rec[] {
  const out: Rec[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split(",").map((x) => x.replace(/^"|"$/g, ""));
    if (c[0] !== "2" || c[2] !== "J611") continue;
    out.push({ kind: c[3], yoshiki: c[8], f: c.slice(2) }); // f[i] = 項番 i+1
  }
  return out;
}
const item = (r: Rec, n: number) => r.f[n - 1] ?? "";

// ─── 突合ヘルパー ────────────────────────────────────────────────────────────
let ng = 0;
let total = 0;
function check(label: string, actual: unknown, expected: unknown) {
  total += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`    ✓ ${label}: ${a}`);
  } else {
    ng += 1;
    console.log(`    ✗ ${label}\n        期待: ${e}\n        実際: ${a}`);
  }
}
function note(s: string) {
  console.log(`    … ${s}`);
}

function run(name: string, users: ShogaiDensouUser[]) {
  console.log(`\n--- ${name} ---`);
  const res = buildShogaiDensou(users, OPTS);
  const recs = parseJ61(res.jissekiFile.content);
  return { recs, warnings: res.warnings };
}

// ════════════════════════════════════════════════════════════════════════════
// A. 重度訪問介護 — 段(加算行)が明細に出ないこと / 算定時間 / 通番 / 延べ時間
//    実データ形: 1日1行 (243/265 日) の最頻ケース
// ════════════════════════════════════════════════════════════════════════════
{
  const u = mkUser(
    baseRow({ user_id: "A", user_name: "重訪Ａ" }),
    juhoLadder("2026-06-01", "09:00", "14:00", 300, "重訪Ⅱ日中１．０", 9),
  );
  const { recs } = run("A 重訪 1日1訪問 5.0h (段 9 本 = 通常1 + 加算8)", [u]);
  const kihon = recs.filter((r) => r.kind === "01" && r.yoshiki === "0301");
  const meisai = recs.filter((r) => r.kind === "02" && r.yoshiki === "0301");
  check("明細行数 (加算8本は出ない)", meisai.length, 1);
  check("項8 提供通番", item(meisai[0], 8), "1");
  check("項9 日付", item(meisai[0], 9), "01");
  check("項14 開始時間", item(meisai[0], 14), "0900");
  check("項15 終了時間", item(meisai[0], 15), "1400");
  check("項16 算定時間数 (5.0h)", item(meisai[0], 16), "0500");
  check("項19 派遣人数", item(meisai[0], 19), "1");
  check("基本 項19 算定時間数計 (延べ 5.0h)", item(kihon[0], 19), "00500");
}

// ════════════════════════════════════════════════════════════════════════════
// B. 重訪 — 1日2訪問。通番は日単位で同一、算定時間は日合計を最終行だけに
//    実データ形: 3697aee6… 2026-06-18 の 08:00-10:30 | 15:30-21:00 をそのまま使用
// ════════════════════════════════════════════════════════════════════════════
{
  const u = mkUser(baseRow({ user_id: "B", user_name: "重訪Ｂ" }), [
    ...juhoLadder("2026-06-18", "08:00", "10:30", 150, "重訪Ⅱ日中１．０", 5),
    ...juhoLadder("2026-06-18", "15:30", "21:00", 330, "重訪Ⅱ日中１．０", 11),
  ]);
  const { recs } = run("B 重訪 1日2訪問 2.5h + 5.5h = 8.0h", [u]);
  const kihon = recs.filter((r) => r.kind === "01" && r.yoshiki === "0301");
  const meisai = recs.filter((r) => r.kind === "02" && r.yoshiki === "0301");
  check("明細行数", meisai.length, 2);
  check("項8 提供通番 (日単位で同一)", meisai.map((r) => item(r, 8)), ["1", "1"]);
  check("項14/15 時刻", meisai.map((r) => `${item(r, 14)}-${item(r, 15)}`), ["0800-1030", "1530-2100"]);
  check("項16 算定時間数 (最終行に日合計 8.0h)", meisai.map((r) => item(r, 16)), ["", "0800"]);
  check("基本 項19 算定時間数計", item(kihon[0], 19), "00800");
}

// ════════════════════════════════════════════════════════════════════════════
// C. 重訪 — 同一時刻の 2 人派遣 (「・２人」コード 1 行 + 派遣人数 2)
//    build.ts が「設定例 No.4」として実装している形。**現挙動の記録**であって
//    正しさの確認ではない:
//      ・本番カバレッジ 0 (・2人 の通常行は 0/287)
//      ・ほのぼのの TJ には 人数2 の行が 1 つも無い (0/384)
//      ・同一時刻の 2 人派遣という日そのものが実データに無い (0/277 日。全部 時刻ずれ)
//    → この経路が実際に使われることになったら、まず ほのぼの側の実出力を確認すること
// ════════════════════════════════════════════════════════════════════════════
{
  const u = mkUser(baseRow({ user_id: "C", user_name: "重訪Ｃ" }), [
    visit("2026-06-03", "10:00", "14:00", 240, "121272", "重訪Ⅱ日中１．０・２人"),
    visit("2026-06-03", "10:00", "14:00", 240, "121282", "重訪Ⅱ日中１．５・２人", { isAddon: true }),
  ]);
  const { recs } = run("C 重訪 同一時刻2人派遣 4.0h (設定例 No.4)", [u]);
  const kihon = recs.filter((r) => r.kind === "01" && r.yoshiki === "0301");
  const meisai = recs.filter((r) => r.kind === "02" && r.yoshiki === "0301");
  check("明細行数 (1訪問=1行)", meisai.length, 1);
  check("項19 派遣人数", item(meisai[0], 19), "2");
  check("項16 算定時間数 (1人分のまま 4.0h)", item(meisai[0], 16), "0400");
  check("基本 項19 算定時間数計 (延べ = 4.0 × 2人)", item(kihon[0], 19), "00800");
}

// ════════════════════════════════════════════════════════════════════════════
// D. 重訪 — 2 人派遣 (実データは全部「時刻ずれ」。同一時刻は 0 件)
//
//    ⚠ 期待値は **_if_shogai.txt の記述ではなく ほのぼのの実出力**に合わせている。
//      仕様書 明細※3 は「時間がずれた場合は サービス提供回数 1人目'1'/2人目'2'」と
//      読めるが、202606 の TJ 384 行を実測したら ほのぼのは **提供回数を空**にし、
//      **派遣人数は全行 1** (人数2 は 0/384) だった。突合の相手は ほのぼのなので
//      実出力を正とする。
//
//    ほのぼの実出力 (鈴木 拓也 1221113051 / おゆみ野 6/1):
//        順1  0800-1530  算定 7.50h  提供回数""  人数1
//        順2  1145-1315  算定 1.50h  提供回数""  人数1
//      → 派遣順の系列ごとに **別の提供通番** で 1 行ずつ、各行が自分の算定時間を持つ
// ════════════════════════════════════════════════════════════════════════════
{
  const u = mkUser(baseRow({ user_id: "D", user_name: "重訪Ｄ" }), [
    visit("2026-06-01", "08:00", "15:30", 450, "121271", "重訪Ⅱ日中１．０"),
    visit("2026-06-01", "11:45", "13:15", 90, "121272", "重訪Ⅱ日中１．０・２人"),
  ]);
  const { recs } = run("D 重訪 2人派遣 (ほのぼの実出力 鈴木拓也 6/1 と同じ形)", [u]);
  const kihon = recs.filter((r) => r.kind === "01" && r.yoshiki === "0301");
  const meisai = recs.filter((r) => r.kind === "02" && r.yoshiki === "0301");
  check("明細行数", meisai.length, 2);
  check("項10 サービス提供回数 (ほのぼのは空)", meisai.map((r) => item(r, 10)), ["", ""]);
  check("項19 派遣人数 (ほのぼのは全行 1 — 384行中 人数2 は 0)", meisai.map((r) => item(r, 19)), ["1", "1"]);
  check("項8 提供通番 (派遣順の系列ごとに別番号)", meisai.map((r) => item(r, 8)), ["1", "2"]);
  check("項16 算定時間数 (系列ごとに自分の時間 7.5h / 1.5h)", meisai.map((r) => item(r, 16)), ["0750", "0150"]);
  check("基本 項19 算定時間数計 (= 明細の単純合計 9.0h。人数倍しない)", item(kihon[0], 19), "00900");
}

// ════════════════════════════════════════════════════════════════════════════
// E. 0 時またぎ — 実データ形 (重訪 17:00-00:00 が 4 件 / 居宅 22:00-00:30 が実在)
// ════════════════════════════════════════════════════════════════════════════
{
  const u = mkUser(
    baseRow({ user_id: "E", user_name: "重訪Ｅ" }),
    juhoLadder("2026-06-05", "17:00", "00:00", 420, "重訪Ⅱ日中１．０", 13),
  );
  const { recs } = run("E 重訪 0時またぎ 17:00-00:00 (7.0h)", [u]);
  const meisai = recs.filter((r) => r.kind === "02" && r.yoshiki === "0301");
  check("明細行数 (日跨ぎで分割されない)", meisai.length, 1);
  check("項14 開始時間", item(meisai[0], 14), "1700");
  check("項15 終了時間", item(meisai[0], 15), "0000");
  check("項16 算定時間数 (7.0h)", item(meisai[0], 16), "0700");
  note("ほのぼのは 0 時で切って翌日行 + 日跨増コードを出す (SESSION_START B1)。当方は 1 行のまま");
}

{
  const u = mkUser(baseRow({ user_id: "E2", user_name: "居宅Ｅ" }), [
    visit("2026-06-10", "22:00", "00:30", 150, "111111", "身体深２．５"),
  ]);
  const { recs } = run("E2 居宅介護 0時またぎ 22:00-00:30 (2.5h)", [u]);
  const meisai = recs.filter((r) => r.kind === "02" && r.yoshiki === "0101");
  check("明細行数", meisai.length, 1);
  check("項14/15 時刻", `${item(meisai[0], 14)}-${item(meisai[0], 15)}`, "2200-0030");
  check("項16 算定時間数 (名称由来 2.5h)", item(meisai[0], 16), "0250");
}

// ════════════════════════════════════════════════════════════════════════════
// F. 同行援護 (様式19 1901) — 決定コード 153000 固定 / 合計欄は 項24・項26
//    実データ 136 行が該当する live な経路
// ════════════════════════════════════════════════════════════════════════════
{
  const u = mkUser(baseRow({ user_id: "F", user_name: "同援Ｆ" }), [
    visit("2026-06-06", "09:00", "11:00", 120, "151001", "同援日２．０"),
    visit("2026-06-07", "13:00", "16:00", 180, "151001", "同援日３．０"),
  ]);
  const { recs } = run("F 同行援護 2.0h + 3.0h", [u]);
  const kihon = recs.filter((r) => r.kind === "01" && r.yoshiki === "1901");
  const meisai = recs.filter((r) => r.kind === "02" && r.yoshiki === "1901");
  check("様式1901 の明細行数", meisai.length, 2);
  check("項11 サービス内容 (153000 固定)", meisai.map((r) => item(r, 11)), ["153000", "153000"]);
  check("項16 算定時間数", meisai.map((r) => item(r, 16)), ["0200", "0300"]);
  check("基本 項24 内訳 (合計スロット3)", item(kihon[0], 24), "00500");
  check("基本 項26 計 (合計スロット3)", item(kihon[0], 26), "00500");
  check("身体スロットの項19 は空", item(kihon[0], 19), "");
}

// ════════════════════════════════════════════════════════════════════════════
// G. 行動援護 (種類13) — 様式未対応。**黙って落とさず warning を出す**こと
//    実データ 0 行 (本番では発生しない) だが、提供開始時に気づける必要がある
// ════════════════════════════════════════════════════════════════════════════
{
  const u = mkUser(baseRow({ user_id: "G", user_name: "行動Ｇ" }), [
    visit("2026-06-08", "10:00", "12:00", 120, "131001", "行動援護２．０"),
  ]);
  const { recs, warnings } = run("G 行動援護 (未対応様式)", [u]);
  const meisai = recs.filter((r) => r.kind === "02");
  check("J611 明細は出さない", meisai.length, 0);
  check(
    "warning が出る",
    warnings.some((w) => w.includes("行動援護") && w.includes("様式")),
    true,
  );
  for (const w of warnings.filter((x) => x.includes("行動Ｇ"))) note(`warning: ${w}`);
}

console.log(`\n=== 結果: ${total} 件中 不一致 ${ng} 件 ===`);
console.log("※ DB への書き込みは行っていません (純関数テスト。後片付け不要)");
