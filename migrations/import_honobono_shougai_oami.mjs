/**
 * ほのぼの(身障) → kaigo-app 障害利用者 取込 (リンクス大網白里事業所)
 *
 * 入力: migrations/shougai_import_oami.json
 *   (= 基本情報 CSV + 大網受給者証.pdf を parse_shougai_oami.py で構造化したもの)
 *
 * 生成データ (1 利用者あたり):
 *   ① clients                    1 行 (氏名+生年月日で既存重複はスキップ or 流用)
 *   ② client_office_assignments  1 行 (office = リンクス大網白里事業所)
 *   ③ shougai_certifications     現在有効(なければ最新)の受給者証 1〜N 行
 *
 * 重複判定 (花見川と同じ):
 *   - 氏名(正規化) + 生年月日 一致 → 既存 client を流用 (INSERT しない)
 *   - user_number 一致だけでは流用しない (短番号が事業所エントリ番号と衝突するため)
 *   - user_number は NOT NULL + unique:
 *       衝突 (23505) → 元番号+100000 でリナンバー
 *       ほのぼの側で番号なし → 999901〜 の連番を採番
 *   - 流用 client にも assignment / cert は不足分のみ追加
 *   - 大網の障害 36 名の多くは介護 STEP1 で既に clients に居るはず (= 流用される想定)
 *
 * 拡張列 (shougai_cert_more_fields.sql) は適用状況を自動検出:
 *   適用済 → issue_date / income_category / shikyuryo_details / flag_h30_after も保存
 *   未適用 → 上記は notes 内テキストとして保存
 *
 * マーカー: shougai_certifications.notes 先頭に '[ほのぼの取込 2026-07-17 大網身障]'
 *
 * Usage:
 *   node migrations/import_honobono_shougai_oami.mjs              # DRY RUN
 *   node migrations/import_honobono_shougai_oami.mjs --execute    # 本番実行
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { normalizeShikyuryo } from "./_shikyuryo_keys.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  try {
    const env = readFileSync(path, "utf8");
    const vars = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const SB_URL = envKaigo.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envKaigo.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY);

const TENANT_ID = "kt-group";
// env でマルチ事業所化 (未指定は大網デフォルト):
//   SH_OFFICE_ID  kaigo-app office_id
//   SH_MARKER     取込マーカー (notes 先頭・冪等キー)
//   SH_JSON       parse 出力 JSON ファイル名 (migrations/ 配下)
//   SH_LABEL      verify ログの事業所ラベル
// リンクス大網白里事業所=269d77bc / リンクスヘルパーステーション(茂原)=e08c3706-ad59-4913-b4e2-67f2675422e9
const OFFICE_ID = process.env.SH_OFFICE_ID || "269d77bc-5b61-4114-a2ea-e8dc2f220823";
const MARKER = process.env.SH_MARKER || "[ほのぼの取込 2026-07-17 大網身障]";
const OFFICE_LABEL = process.env.SH_LABEL || "大網";
const TODAY = new Date().toISOString().slice(0, 10);
const EXECUTE = process.argv.includes("--execute");

// 支給決定市町村 → 障害 市町村番号 (6 桁)
// 千葉市 = 121004: 花見川取込で確認済 (障害福祉は市単位。介護保険者番号 121012 等の区別とは別体系)
// 東金市 / 大網白里市 / 八街市 / 山武市 / 市原市 / 九十九里町 は未確認 → 推測で捏造せず warning。
//   → 市町村名がそのまま insurer_municipality に入り、伝送 build.ts が warning を出す。
//     ほのぼの受給者証画面で 6 桁を確認したらここに追記する。
// 全国地方公共団体コード (千葉県分)。migrations/fix_shogai_municipality_code.mjs と同じ出典。
//   ⚠ 伝送ファイルから逆引きして埋めない (循環)。公的コード表を根拠にすること。
/**
 * 障害福祉の市町村番号 = **JIS 市区町村コード 5 桁 + 検証数字 1 桁**。
 * 検証数字は保険者番号と同じ modulus 10 (重み 2,1,2,1,2 / 積が 2 桁なら各位を足す)。
 *
 * ⚠ 地方公共団体コード (総務省・modulus 11) とは**別物**。混同すると 1 桁ずれる。
 *   実際 2026-08-04 まで CITY_CODE には mod 11 由来の誤値が 8 件入っていた
 *   (東金 122131 / 大網白里 122394 / 八街 122301 / 山武 122343 /
 *    九十九里 124036 / 長生村 124231 / 長柄 124265 / 長南 124273)。
 *   DB 側は別途是正済みだったので実害は無かったが、新規事業所の取込で再発する状態だった。
 *
 * VERIFIED = ほのぼのの伝送ファイル (KJ/TJ の J121・J611 レコード) と
 *   parse 済 JSON の市町村名を受給者証番号で突合して**実証した**値。13 件すべて上の
 *   アルゴリズムと一致したので、未実証の市町村は算出して使う (算出値は warning を出す)。
 */
const VERIFIED_CITY_CODE = {
  千葉市: "121004",
  市原市: "122192",
  茂原市: "122101",
  東金市: "122135",
  大網白里市: "122390",
  八街市: "122309",
  山武市: "122374",
  九十九里町: "124032",
  一宮町: "124214",
  睦沢町: "124222",
  長生村: "124230",
  長柄町: "124263",
  長南町: "124271",
  袖ケ浦市: "122291", // 2026-08-04 姉ム取込時に算出 → 伝送 (J121/J611) と一致して実証
  四街道市: "122283", // 2026-08-04 四街道の伝送 (KJ/TJ260701) に出現
  酒々井町: "123224", // 同上
};

/** JIS 市区町村コード (5 桁)。VERIFIED に無い市町村を算出するために持つ */
const JIS_CODE = {
  木更津市: "12206",
  白子町: "12424",
  いすみ市: "12238",
  大多喜町: "12441",
  御宿町: "12443",
  勝浦市: "12218",
  袖ケ浦市: "12229",
  君津市: "12225",
  富津市: "12226",
  四街道市: "12228",
  船橋市: "12204",
  八千代市: "12221",
  匝瑳市: "12235",
  松戸市: "12207",
  柏市: "12217",
  市川市: "12203",
  印西市: "12231",
  成田市: "12211",
  茂原市: "12210",
  東金市: "12213",
  大網白里市: "12239",
  長生村: "12423",
  御宿町: "12443",
};

/** 保険者番号と同じ modulus 10 の検証数字 */
function checkDigit(jis5) {
  const weights = [2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 5; i++) {
    const p = Number(jis5[i]) * weights[i];
    sum += p >= 10 ? Math.floor(p / 10) + (p % 10) : p;
  }
  return String((10 - (sum % 10)) % 10);
}

/** 算出で埋めた市町村 (warning 表示用) */
const computedCities = new Set();

const CITY_CODE = new Proxy(
  {},
  {
    get(_t, city) {
      if (typeof city !== "string") return undefined;
      if (VERIFIED_CITY_CODE[city]) return VERIFIED_CITY_CODE[city];
      const jis = JIS_CODE[city];
      if (!jis) return undefined;
      computedCities.add(city);
      return jis + checkDigit(jis);
    },
  },
);

const JSON_PATH = join(__dirname, process.env.SH_JSON || "shougai_import_oami.json");
const data = JSON.parse(readFileSync(JSON_PATH, "utf8"));

const norm = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");

function fmtQty(q) {
  return Object.entries(q || {})
    .map(([k, v]) =>
      v.hours != null ? `${k}${v.hours}時間${String(v.minutes ?? 0).padStart(2, "0")}分`
      : v.count != null ? `${k}${v.count}回` : k)
    .join(" / ");
}

async function main() {
  console.log(EXECUTE ? "🚀 EXECUTE モード" : "🔍 DRY RUN (--execute で本番実行)");
  console.log(`   取込元: ${JSON_PATH}`);
  console.log(`   利用者 ${data.clients.length} 名 / 受給者証 entry ${data.stats.total_cert_entries} 件 (取込対象 = 現在有効分のみ)`);

  // ── 拡張列 (shougai_cert_more_fields.sql) の適用検出 ──
  let extApplied = true;
  {
    const { error } = await sb
      .from("shougai_certifications")
      .select("issue_date, income_category, shikyuryo_details, flag_h30_after")
      .limit(1);
    if (error) {
      extApplied = false;
      console.log(`⚠️  拡張列 未適用 (${error.code}): 交付日/所得区分/支給量内訳は notes に格納します`);
      console.log("    → migrations/shougai_cert_more_fields.sql を SQL Editor で適用すると列に入ります");
    } else {
      console.log("✅ 拡張列 (shougai_cert_more_fields) 適用済 → フル項目で保存");
    }
  }

  // ── 上限管理区分 (jogen_kanri_kubun) の自動導出用 ──
  // 受給者証の上限管理事業所名を自事業所名と照合して 自/他/なし を機械判定する
  // (空=なし / 自事業所名と一致=自事業所+自障害番号 / それ以外=他事業所)。判断不要の転記。
  const { data: selfOffice } = await sb
    .from("offices")
    .select("name, business_number, shogai_business_number")
    .eq("id", OFFICE_ID)
    .maybeSingle();
  const SELF_NAME = selfOffice?.name ?? "";
  const SELF_SHOGAI_NUM = selfOffice?.shogai_business_number ?? selfOffice?.business_number ?? null;
  const normName = (s) => (s || "").normalize("NFKC").replace(/[\s　]/g, "");
  const deriveJogen = (officeName) => {
    if (!officeName) return { kubun: "なし", num: null };
    const a = normName(officeName), b = normName(SELF_NAME);
    return b && (a === b || a.includes(b) || b.includes(a))
      ? { kubun: "自事業所", num: SELF_SHOGAI_NUM }
      : { kubun: "他事業所", num: null };
  };

  // ── 既存 client の重複チェック (氏名正規化 + 生年月日) ──
  const existingByNameBirth = new Map();
  const existingByName = new Map();
  const existingByNumBirth = new Map();
  const existingByNumName = new Map(); // 利用者番号 + 氏名 (10桁番号の衝突救済)
  {
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const { data: rows, error } = await sb
        .from("clients")
        .select("id, user_number, name, birth_date")
        .eq("tenant_id", TENANT_ID)
        .is("deleted_at", null)
        .range(from, from + PAGE - 1);
      if (error) { console.error(`❌ 既存チェック失敗: ${error.message}`); process.exit(1); }
      for (const r of rows ?? []) {
        if (r.birth_date) existingByNameBirth.set(`${norm(r.name)}|${r.birth_date}`, r);
        // **利用者番号 + 生年月日**。異体字 (斎/齋・髙/高・﨑/崎) で氏名一致が外れても拾える。
        //   番号だけでは事業所エントリ番号と衝突するが、生年月日と併せれば安全。
        if (r.birth_date && r.user_number) existingByNumBirth.set(`${r.user_number}|${r.birth_date}`, r);
        if (r.user_number) existingByNumName.set(`${r.user_number}|${norm(r.name)}`, r);
        // 基本情報一覧表が無い事業所 (木更津など) 向けの氏名のみ索引。
        //   **一意なときだけ**流用する (同姓同名は誤結合になるので使わない)
        const k = norm(r.name);
        if (!existingByName.has(k)) existingByName.set(k, []);
        existingByName.get(k).push(r);
      }
      if (!rows || rows.length < PAGE) break;
      from += PAGE;
    }
  }

  // ── 既存 assignment / cert (二重 INSERT 防止) ──
  const { data: exAsg, error: e3 } = await sb
    .from("client_office_assignments")
    .select("client_id")
    .eq("office_id", OFFICE_ID);
  if (e3) { console.error(`❌ 既存 assignment 取得失敗: ${e3.message}`); process.exit(1); }
  const assignedClientIds = new Set((exAsg ?? []).map((r) => r.client_id));

  // ⚠ MARKER 付き (= 前回の自分の取込) は下で消して入れ直すので **既存に数えない**。
  //   数えると「既存だから plan から除外」→「削除」で消えたまま復活しない。
  const exCerts = [];
  for (let from = 0; ; from += 1000) {
    const { data, error: e4 } = await sb
      .from("shougai_certifications")
      .select("client_id, beneficiary_number, certification_start_date, notes")
      .range(from, from + 999);
    if (e4) { console.error(`❌ 既存 cert 取得失敗: ${e4.message}`); process.exit(1); }
    exCerts.push(...data);
    if (data.length < 1000) break;
  }
  const certKeys = new Set(
    exCerts
      .filter((r) => !(r.notes ?? "").startsWith(MARKER))
      .map((r) => `${r.client_id}|${r.beneficiary_number}|${r.certification_start_date}`),
  );

  // ── plan 構築 ──
  const plan = [];
  const cityWarn = new Set();
  const ambiguous = [];
  const backfillBirth = []; // 既存 client の birth_date が空 → 受給者証側の値で埋める
  for (const c of data.clients) {
    let existing = existingByNameBirth.get(`${norm(c.name)}|${c.birth_date}`) ?? null;
    let reuseReason = existing ? "氏名+生年月日" : null;
    if (!existing && c.birth_date && c.user_number) {
      const byNum = existingByNumBirth.get(`${c.user_number}|${c.birth_date}`);
      if (byNum) {
        existing = byNum;
        reuseReason = `利用者番号+生年月日 (氏名: ${byNum.name})`;
      }
    }
    // 受給者証一覧表しか無い事業所は生年月日が取れない。
    //   その場合に限り**氏名が一意に一致するとき**だけ既存 client を流用する。
    //   複数一致は誤結合の危険があるので中断させる (新規作成もしない)。
    if (!existing && !c.birth_date) {
      const cands = existingByName.get(norm(c.name)) ?? [];
      if (cands.length === 1) {
        existing = cands[0];
        reuseReason = "氏名のみ(生年月日なし)";
      } else if (cands.length > 1) {
        ambiguous.push(`${c.name} (${c.user_number}) → 既存 ${cands.map((x) => x.user_number).join(" / ")}`);
      }
    }
    // 逆パターン: **既存側**が生年月日なし。
    //   基本情報一覧表を後から受け取って再取込すると、先に受給者証だけで作った
    //   client (birth_date = null) と 氏名+生年月日 で一致せず、同じ人を
    //   100000+n にリナンバーして二重作成してしまう。
    //   実証: 木更津 — 8/4 に受給者証だけで 20 名作成 → 8/5 に基本情報付きで
    //   再取込したら 11 名が別 client として作られた。
    //   生年月日なしの同名が **一意** のときだけ流用し、生年月日を埋める。
    // 利用者番号 + 氏名 が一致するなら同一人物。
    //   受給者証側に生年月日が無い / 既存側と表記ゆれがある場合の最後の砦。
    //   ⚠ 番号だけでは流用しない (短番号が事業所エントリ番号と衝突するため)。
    if (!existing && c.user_number) {
      const byNumName = existingByNumName.get(`${c.user_number}|${norm(c.name)}`);
      if (byNumName) {
        existing = byNumName;
        reuseReason = "利用者番号+氏名";
      }
    }
    if (!existing && c.birth_date) {
      const cands = (existingByName.get(norm(c.name)) ?? []).filter((x) => !x.birth_date);
      if (cands.length === 1) {
        existing = cands[0];
        reuseReason = `氏名一致 (既存の生年月日が空 → ${c.birth_date} を補完)`;
        backfillBirth.push({ id: existing.id, name: c.name, birth_date: c.birth_date });
      } else if (cands.length > 1) {
        ambiguous.push(
          `${c.name} (${c.user_number}) → 生年月日が空の既存が複数: ${cands.map((x) => x.user_number).join(" / ")}`,
        );
      }
    }
    const clientId = existing ? existing.id : randomUUID();
    const certs = (c.current_certs ?? []).filter(
      (e) => !certKeys.has(`${clientId}|${e.cert_number}|${e.period_start}`),
    );
    for (const e of certs) {
      if (e.city && !CITY_CODE[e.city]) cityWarn.add(e.city);
    }
    plan.push({
      c, clientId,
      insertClient: !existing,
      reuseReason,
      insertAssignment: !assignedClientIds.has(clientId),
      certs,
    });
  }

  const nClients = plan.filter((p) => p.insertClient).length;
  const nReuse = plan.length - nClients;
  const nAsg = plan.filter((p) => p.insertAssignment).length;
  const nCerts = plan.reduce((s, p) => s + p.certs.length, 0);
  console.log(`\n📊 plan: clients 新規 ${nClients} / 既存流用 ${nReuse}、assignments ${nAsg}、certifications ${nCerts}`);
  for (const p of plan) {
    const tags = [];
    if (!p.insertClient) tags.push(`既存流用(${p.reuseReason})`);
    if (!p.insertAssignment) tags.push("assignment済");
    const certStr = p.certs
      .map((e) => {
        const expired = e.period_end && e.period_end < TODAY ? "⚠️期限切れ" : "";
        const cc = e.city ? (CITY_CODE[e.city] ? `${e.city}(${CITY_CODE[e.city]})` : `${e.city}⚠️番号未解決`) : "";
        return `${e.cert_number} ${e.period_start}〜${e.period_end} ${e.support_level ?? "非該当"} ${e.service ?? "?"} ${cc} ${expired}`;
      })
      .join(" | ");
    console.log(`  ${(p.c.user_number ?? "(番号なし)").padEnd(12)} ${p.c.name.padEnd(9)} ${certStr} ${tags.join(" ")}`);
  }
  if (cityWarn.size) {
    console.log(`\n⚠️  市町村番号 未解決 ${cityWarn.size} 件 (JIS_CODE に無い。受給者証で確認して追記):`);
    console.log(`   ${[...cityWarn].join(" / ")}`);
  }
  if (ambiguous.length) {
    console.error(`\n❌ 氏名が複数の既存利用者と一致 ${ambiguous.length} 件 (生年月日が無く一意に決められない):`);
    for (const a of ambiguous) console.error(`   ${a}`);
    console.error(`   → 基本情報一覧表を出して生年月日を入れるか、手で紐付けを決めてください。中断します。`);
    process.exit(2);
  }
  if (computedCities.size) {
    console.log(`\n⚠️  市町村番号 が**算出値** ${computedCities.size} 件 (伝送で実証されていない):`);
    for (const c of computedCities) console.log(`   ${c} → ${CITY_CODE[c]}  ← 初回伝送前に受給者証の実物と照合すること`);
    console.log(`   照合できたら VERIFIED_CITY_CODE に移すこと (アルゴリズムは実証 13/13 だが実物確認が原則)`);
  }
  if (data.warnings?.length) {
    console.log(`\n⚠️  parse 時警告 ${data.warnings.length} 件:`);
    for (const w of data.warnings) console.log(`   - ${w}`);
  }

  if (!EXECUTE) {
    console.log("\n🔍 DRY RUN 終了 (何も書き込んでいません)");
    return;
  }

  // ── 実行 ──
  // 受給者証は毎回入れ直す (再パース → 再取込 を何度も回すため)。
  // MARKER 付きだけを消すので手入力・他事業所の証は残る。
  {
    const ids = plan.map((p) => p.clientId);
    let removed = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const { error, count } = await sb
        .from("shougai_certifications")
        .delete({ count: "exact" })
        .in("client_id", ids.slice(i, i + 100))
        .like("notes", `${MARKER}%`);
      if (error) { console.error(`✗ 既存 cert 削除: ${error.message}`); process.exit(1); }
      removed += count ?? 0;
    }
    console.log(`既存 cert (${MARKER}) 削除: ${removed} 件\n`);
  }

  if (backfillBirth.length) {
    let bf = 0;
    for (const b of backfillBirth) {
      const { error } = await sb.from("clients").update({ birth_date: b.birth_date }).eq("id", b.id);
      if (error) { console.error(`✗ ${b.name} 生年月日 補完: ${error.message}`); process.exit(1); }
      bf++;
    }
    console.log(`既存 client の生年月日を補完: ${bf} 名
`);
  }

  let okC = 0, okA = 0, okS = 0, ng = 0;
  let blankSeq = 999901; // 番号なし利用者の採番 (999901〜)
  for (const p of plan) {
    const c = p.c;
    if (p.insertClient) {
      const clientRow = {
        id: p.clientId,
        tenant_id: TENANT_ID,
        user_number: c.user_number ?? null,
        name: c.name,
        furigana: c.furigana ?? null,
        gender: c.gender,
        birth_date: c.birth_date,
        postal_code: c.postal_code,
        address: c.address || null,
        phone: c.phone,
        mobile: c.mobile,
        office_id: OFFICE_ID,
        status: "active",
        is_facility: false,
        is_provisional: false,
      };
      if (!clientRow.user_number) {
        clientRow.user_number = String(blankSeq++);
        console.warn(`  ⚠️ ${c.name}: ほのぼの番号なし → user_number=${clientRow.user_number} を採番`);
      }
      let { error } = await sb.from("clients").insert(clientRow);
      // ほのぼの側で採番されなかった人は **2147483647 (int の最大値)** を共有する。
      //   1〜5 桁のリナンバー救済が効かず 23505 で失敗していた
      //   (いすみ 尾崎昌代 が茂原の佐藤喜美子と同じ 2147483647)。
      //   ゴミ番号は事業所を付けて一意化する (人が見て由来が分かる形にする)。
      if (error && error.code === "23505" && /^(2147483647|9{7,})$/.test(clientRow.user_number)) {
        const renum = `${clientRow.user_number}-${OFFICE_LABEL}-${blankSeq++}`;
        console.warn(`  ⚠️ ${c.name}: user_number=${clientRow.user_number} は採番漏れのゴミ値で衝突 → ${renum} にリナンバー`);
        ({ error } = await sb.from("clients").insert({ ...clientRow, user_number: renum }));
      } else if (error && error.code === "23505" && /^\d+$/.test(clientRow.user_number)) {
        // 利用者番号は**事業者エントリごとの採番**なので別人が同じ番号を持つ
        //   (東郷 大多和優衣 711000107 が既存の早坂忠夫と衝突)。
        //   1〜5 桁は +100000、それ以外は事業所ラベルを付けて一意化する
        //   (6 桁以上に +100000 すると別の実在番号とぶつかりうるため)。
        const n = clientRow.user_number;
        const renum = n.length <= 5 ? String(100000 + Number(n)) : `${n}-${OFFICE_LABEL}`;
        console.warn(`  ⚠️ ${c.name}: user_number=${n} が unique 衝突 (既存は別人) → ${renum} にリナンバー`);
        ({ error } = await sb.from("clients").insert({ ...clientRow, user_number: renum }));
      }
      if (error) { console.error(`  ✗ ${c.name} clients: ${error.message}`); ng++; continue; }
      okC++;
    }
    if (p.insertAssignment) {
      const { error } = await sb.from("client_office_assignments").insert({
        tenant_id: TENANT_ID,
        client_id: p.clientId,
        office_id: OFFICE_ID,
        start_date: TODAY,
      });
      if (error) { console.error(`  ✗ ${c.name} assignment: ${error.message}`); ng++; }
      else okA++;
    }
    // 同じ受給者証が事業種別ごとに複数回印字される
    // (身体障害者居宅介護事業 / 知的障害者居宅介護事業 で 1 枚の証が 2 行)。
    // 番号と期間が同じものは 1 枚に畳む。支給量が最も多い行を残す (他は部分集合)。
    const certs = [];
    for (const e of p.certs) {
      const key = `${e.cert_number}|${e.period_start}|${e.period_end}`;
      const prev = certs.findIndex((x) => `${x.cert_number}|${x.period_start}|${x.period_end}` === key);
      if (prev < 0) { certs.push(e); continue; }
      const n = (x) => Object.keys(x.quantities ?? {}).length;
      console.warn(`  ⚠️ ${c.name}: 受給者証 ${e.cert_number} が事業種別違いで重複 → 1 枚に畳む`);
      if (n(e) > n(certs[prev])) certs[prev] = e;
    }
    for (const e of certs) {
      const cityCode = CITY_CODE[e.city] ?? null;
      const noteLines = [
        MARKER,
        `事業種別: ${e.jigyou ?? ""}${e.service ? `【${e.service}】` : ""} ${e.city ?? ""}`,
        `交付日: ${e.issue_date ?? "?"} / 所得区分: ${e.income_category ?? "?"} / 上限月額: ${e.payment_limit ?? "?"}円`,
        `支給量: ${fmtQty(e.quantities)}`,
      ];
      if (!cityCode && e.city) noteLines.push(`⚠️ 市町村番号 未解決: ${e.city}`);
      const jg = deriveJogen(e.jogen_kanri_office);
      const row = {
        tenant_id: TENANT_ID,
        client_id: p.clientId,
        support_level: e.support_level ?? "非該当",
        certification_start_date: e.period_start,
        certification_end_date: e.period_end,
        beneficiary_number: e.cert_number,
        insurer_municipality: cityCode ?? e.city ?? null,
        service_types: e.service ? [e.service] : Object.keys(e.quantities ?? {}),
        copay_rate: 0.1,
        self_payment_limit: e.payment_limit ?? null,
        jogen_kanri_office_name: e.jogen_kanri_office ?? null,
        jogen_kanri_kubun: jg.kubun,
        jogen_kanri_office_number: jg.num,
        notes: noteLines.join("\n"),
      };
      if (extApplied) {
        row.issue_date = e.issue_date ?? null;
        row.income_category = e.income_category ?? null;
        // 受給者証 PDF の日本語キーのまま入れると画面・集計が読めない (574件の前例)。
        // ローマ字キーに正規化してから保存する。未知キーは落とさず警告する。
        {
          const { details, unknown } = normalizeShikyuryo(e.quantities);
          if (unknown.length) {
            console.warn(`⚠️  支給量の未知キー (保存しません): ${unknown.join(", ")} — migrations/_shikyuryo_keys.mjs に追加してください`);
          }
          row.shikyuryo_details = details;
        }
        row.flag_h30_after = !!e.flag_h30_after;
      }
      const { error } = await sb.from("shougai_certifications").insert(row);
      if (error) { console.error(`  ✗ ${c.name} cert ${e.cert_number}: ${error.message}`); ng++; }
      else okS++;
    }
  }

  console.log(`\n✅ 完了: clients ${okC} / assignments ${okA} / certifications ${okS}、失敗 ${ng}`);

  // ── 件数確認 (verify) ──
  const { count: cnt1 } = await sb
    .from("client_office_assignments")
    .select("*", { count: "exact", head: true })
    .eq("office_id", OFFICE_ID);
  const { count: cnt2 } = await sb
    .from("shougai_certifications")
    .select("*", { count: "exact", head: true })
    .like("notes", `${MARKER}%`);
  console.log(`🔎 verify: ${OFFICE_LABEL} assignments = ${cnt1}、取込マーカー付き certs = ${cnt2}`);
}

main().catch((e) => { console.error("❌ fatal:", e); process.exit(1); });
