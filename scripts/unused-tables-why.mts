/**
 * 0 行の table が **なぜ 0 行か** を実データで分類する (READ ONLY)。
 *
 *   npx tsx scripts/unused-tables-why.mts
 *
 * ── 考え方 ───────────────────────────────────────────────────────────────
 *   unused-tables-check.mts は「数えて参照元を出す」まで。こちらは分類する。
 *   ★ 分類の根拠は **推測ではなく共起** にする:
 *
 *     ある file が table A と B の両方に書く。A は行がある。B は 0 行。
 *       → その処理は **動いている**。なのに B だけ入らない。★ E (書けていない)
 *
 *     書き込みが app のソースに 1 つも無い
 *       → 画面から作れない。C (別表に移った) か D (画面が無い)
 *
 *     書き込みはあるが 共起する table も全部 0 行
 *       → その処理自体が一度も動いていない。A/B (未運用) の可能性が高い
 *
 * ⚠ **列挙して、未分類が残ったら落とす** (規則 3-11)。手で保守する一覧にしない。
 * ⚠ grep なので動的に組む `.from(variable)` は拾えない。0 行でも使われている可能性はある。
 * ⚠ 「書き込みがある」と「画面から辿り着ける」は別 (規則 1-8)。導線は別途 grep する。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const APPS_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const APPS = [
  ["kaigo-app", "kaigo-app/src"], ["order-app", "order-app/app"], ["order-app", "order-app/lib"],
  ["payroll-app", "payroll-app/src"], ["calendar-app", "calendar-app/app"], ["calendar-app", "calendar-app/lib"],
] as const;

// ---------------------------------------------------------------- ソースを読む
const files = new Set<string>();
for (const [, dir] of APPS) {
  let out = "";
  try {
    out = execFileSync("grep", ["-rl", "--include=*.ts", "--include=*.tsx", '\.from("', path.join(APPS_ROOT, dir)],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch { continue; }
  for (const f of out.split("\n")) if (f.trim()) files.add(f.trim());
}

/** file → { reads, writes:Array<{t,line}> } */
const perFile = new Map<string, { reads: Set<string>; writes: { t: string; line: number }[] }>();
const allTables = new Set<string>();
for (const f of files) {
  let src = "";
  try { src = readFileSync(f, "utf8"); } catch { continue; }
  const reads = new Set<string>();
  const writes: { t: string; line: number }[] = [];
  for (const m of src.matchAll(/\.from\("([a-z_0-9]+)"\)([\s\S]{0,220})/g)) {
    const t = m[1];
    // ⚠ `supabase.storage.from("bucket")` は **table ではない**。除外しないと
    //   backups / signatures が「0 行の table」に化ける (2026-09-03 実測で 2 件混入していた)。
    if (/\.storage\s*$/.test(src.slice(Math.max(0, m.index - 60), m.index))) continue;
    allTables.add(t);
    // ⚠ チェーンは複数行になるので後続 220 文字を見る。select だけなら読み取り
    if (/\.(insert|upsert)\s*\(/.test(m[2])) {
      writes.push({ t, line: src.slice(0, m.index).split(String.fromCharCode(10)).length });
    } else reads.add(t);
  }
  perFile.set(f, { reads, writes });
}

// ---------------------------------------------------------------- 行数を引く
const tables = [...allTables].sort();
const counts = new Map<string, number | null>();
await Promise.all(tables.map(async (t) => {
  const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
  counts.set(t, error ? null : (count ?? 0));
}));
const zero = tables.filter((t) => counts.get(t) === 0);

// ⚠ 共起だけでは E は立証できない (2026-09-03 実測)。
//   「相手に行がある」の中身が **seed script が一度に入れた行**だと、
//   その処理が app から動いた証拠にならない。実際 3 件とも深掘りしたら:
//     demo_logs      ← demo_loans 32行は seed_demo_units_caresupo.mjs が 2026-07-03 に一括投入
//     kyotaku_monthly← records 401行のうち居宅は 1名/1か月/同日投入のテスト分だけ
//     shogai_payments← 相手が 1 行しかない (「動いた」と言うには弱い)
//   → **created_at が 2 日以上に散っているか**を足す。散っていれば人が使った跡。
//
//   ⚠ **それでも E は立証できない。**残る穴は「分岐」。40 行以内でも if の別の枝なら
//     相手の行はその枝で入ったもので、こちらの枝が動いた証拠にならない。実例:
//       payroll_kyotaku_attendance_monthly は records=401行/4日分散 で E に残るが、
//       401 行の内訳は 本社366 / 福祉用具4 / 居宅31 で、月次を書くのは
//       `isKyotaku && monthlyDirty` の枝だけ。居宅の 31 行は 1名・1か月・同日投入だった。
//       → 実際は A/B。**E 候補は人が 1 件ずつ確認するためのもの**で、結論ではない。
const spread = new Map<string, number | null>();
await Promise.all(tables.map(async (t) => {
  if ((counts.get(t) ?? 0) <= 0) return;
  const { data, error } = await sb.from(t).select("created_at").limit(1000);
  if (error) { spread.set(t, null); return; } // created_at が無い表
  const days = new Set((data ?? []).map((r) => String((r as { created_at?: string }).created_at ?? "").slice(0, 10)));
  days.delete("");
  spread.set(t, days.size);
}));
console.log(`【分母】app が参照する table ${tables.length} 種 / ★ 0 行 ${zero.length} 種\n`);

// ---------------------------------------------------------------- 分類する
const short = (f: string) => f.split(/[\/]/).slice(-3).join("/");
type Cls = "E" | "E?" | "CD" | "AB";

/**
 * ★ 人が 1 件ずつコードを読んで確定させた注記。
 *
 * 共起 (代理指標) には限界がある — 40 行以内でも if の別の枝なら、相手の行は
 * その枝で入ったもので「こちらが動いた証拠」にならない (payroll_kyotaku_attendance_monthly
 * で実証済み: 相手 401行/4日分散で E 判定されたが、居宅の枝は 1名・1か月・同日投入のテスト分
 * だけで実際は A/B だった)。
 *
 * ★ F 類型 (材料が無いので意図的に止まっている。壊れていない) は共起では検出できないので、
 * ここに人が確認した結果を書く。`cls` は自動分類を上書きする (自動判定の限界を反映)。
 */
const MANUAL_NOTES: Partial<Record<string, { cls: Cls; note: string }>> = {
  chiiki_recipient_certs: {
    cls: "AB",
    note:
      "★ F (材料が無く意図的に止まっている・壊れていない)。移動支援のコード解決が " +
      "fail-closed でこの証を要求するが、本番に地域生活支援の受給者証が 1 件も登録されて " +
      "いないため 0 行のまま。登録導線 (画面) はあるが使われていない。バグではない。",
  },
  client_hospitalizations: {
    cls: "AB",
    note:
      "★ F (材料が無く意図的に止まっている)。障害の入院等 127xxx を出すには入院期間の " +
      "登録が要るが、登録する画面/導線がそもそも無い (import_meisai_shougai_records.mjs が " +
      "「未算定のため対象外」として除外している設計)。入れるなら登録導線が先。",
  },
  client_rental_history: {
    cls: "AB",
    note:
      "★ 確認済み (2026-09-05)。order-app ClientsTab.tsx の手入力フォーム (追加/編集/削除・" +
      "エラーは alert() で必ず表示) で書ける。同じ画面の実績計算は client_rental_history が " +
      "無い利用者を order_items(status='rental_started') から自動補完する設計 " +
      "(コード上「orderItemsから補完」と明記)。つまり通常は補完で足りるため手入力が " +
      "不要 = 0 行は健全。E ではない。",
  },
  payroll_kyotaku_attendance_monthly: {
    cls: "AB",
    note:
      "★ 確認済み (2026-09-04)。共起先 payroll_kyotaku_attendance_records=401行 は " +
      "本社366/福祉用具4/居宅31 の内訳で、月次テーブルを書くのは isKyotaku && monthlyDirty " +
      "の枝だけ。居宅の31行は1名(笠原道代)・1か月(2025-01)・全部2026-05-18投入のテストデータ " +
      "だけで、居宅の出勤簿は一度も本番運用されていない。★ if の別の枝を共起が拾った誤検出の実例。",
  },
  kaigo_service_code_import_batches: {
    cls: "AB",
    note:
      "★ 確認済み (2026-09-05)。★ 過去に本物の E バグだった — 表に file_name/" +
      "closed_count/skipped_count/reverted_at 列が無く insert が PGRST204 で必ず失敗して " +
      "いたことがコード内コメントに詳細に残っている (2026-09-03)。migrations/" +
      "service_code_import_batch_missing_columns.sql で是正済みで、OpenAPI 確認でも " +
      "必要な列は全部揃っている (RENAME 済み inserted_count 含む)。★ 直った後まだ誰も " +
      "サービスコードの再取込を実行していないだけ。⚠ 該当 SQL ファイルの先頭コメントは " +
      "まだ「未適用」のままなので applied_archive/ への移動含め更新が要る (別件・軽微)。",
  },
};
const rows: { t: string; cls: Cls; why: string; ev: string[]; note?: string }[] = [];

for (const t of zero) {
  const writers = [...perFile.entries()].filter(([, v]) => v.writes.some((w) => w.t === t));
  if (writers.length === 0) {
    const readers = [...perFile.entries()].filter(([, v]) => v.reads.has(t));
    rows.push({
      t, cls: "CD",
      why: "app に書き込み (insert/upsert) が無い — 画面からは作れない",
      ev: readers.slice(0, 3).map(([f]) => `読むだけ: ${short(f)}`),
    });
    continue;
  }
  // 共起: **同じ処理**の中で書かれる他の table に行があるか。
  //   ⚠ 「同じ file」だと弱すぎる (clients=9096行 と同居しているだけで E になる)。
  //     近接行 (既定 NEAR 行以内) に絞って「同じハンドラ」を近似する。
  const NEAR = 40;
  const live: string[] = [];
  for (const [, v] of writers) {
    for (const mine of v.writes.filter((w) => w.t === t)) {
      for (const o of v.writes) {
        if (o.t === t) continue;
        if (Math.abs(o.line - mine.line) > NEAR) continue;
        const n = counts.get(o.t);
        if (n != null && n > 0) {
          const d = spread.get(o.t);
          const tag = d == null ? "作成日不明" : d <= 1 ? "★ 全行が同日 = seed の疑い" : `${d} 日に分散`;
          live.push(`${o.t}=${n}行 (${Math.abs(o.line - mine.line)}行離れ / ${tag})`);
        }
      }
    }
  }
  const uniq = [...new Set(live)];
  // ★ 相手が 2 日以上に分散している場合だけ E とする。同日一括 = seed の疑いなので E? に落とす
  const strong = uniq.some((l) => /日に分散/.test(l));
  if (uniq.length && strong) {
    rows.push({
      t, cls: "E",
      why: "★ 同じ処理の中で書かれる別 table には行がある = その処理は動いている。この table だけ入っていない",
      ev: [...writers.slice(0, 2).map(([f]) => `書き込み: ${short(f)}`), `共起: ${uniq.slice(0, 4).join(" / ")}`],
    });
  } else if (uniq.length) {
    rows.push({
      t, cls: "E?",
      why: "共起する table に行はあるが **全行が同日投入 = seed の疑い**。app から動いた証拠にならない",
      ev: [...writers.slice(0, 2).map(([f]) => `書き込み: ${short(f)}`), `共起: ${uniq.slice(0, 3).join(" / ")}`],
    });
  } else {
    rows.push({
      t, cls: "AB",
      why: "書き込みはあるが同じ処理の共起 table も 0 行 = その処理自体が一度も動いていない",
      ev: writers.slice(0, 3).map(([f]) => `書き込み: ${short(f)}`),
    });
  }
}

// ★ 人が確認した結果 (MANUAL_NOTES) で自動分類を上書きする。共起は代理指標に過ぎず、
//   if の別の枝を区別できない限界があるため、確認済みのものは人の判断を優先する。
for (const r of rows) {
  const m = MANUAL_NOTES[r.t];
  if (!m) continue;
  r.cls = m.cls;
  r.note = m.note;
}

const order: Cls[] = ["E", "E?", "AB", "CD"];
const label: Record<Cls, string> = {
  E: "★ E 候補 — 処理は動いているのにこの table だけ 0 行",
  "E?": "E? — 共起はあるが相手が同日一括投入 (seed の疑い) で立証にならない",
  AB: "A/B — その処理自体が一度も動いていない (未運用)",
  CD: "C/D — app に書き込みが無い (別表に移った / 画面が無い)",
};
for (const c of order) {
  const g = rows.filter((r) => r.cls === c);
  if (!g.length) continue;
  console.log(`\n══ ${label[c]} — ${g.length} 種 ══`);
  for (const r of g) {
    console.log(`  ${r.t}`);
    console.log(`      ${r.why}`);
    for (const e of r.ev) console.log(`      ${e}`);
    if (r.note) console.log(`      ${r.note}`);
  }
}

// 未分類チェックの後で MANUAL_NOTES に載っているのに zero リストに無い名前が
// あれば気づけるようにする (table 名の変更・削除に追随できていない証拠)
{
  const knownButMissing = Object.keys(MANUAL_NOTES).filter((t) => !rows.some((r) => r.t === t));
  if (knownButMissing.length) {
    console.log(`\n⚠ MANUAL_NOTES にあるが今回 0 行リストに無い (是正されたか名前が変わった): ${knownButMissing.join(", ")}`);
  }
}

// ---------------------------------------------------------- ★ 逆側の軸
//   「実装はあるがデータが無い」の裏返し = **データはあるのに app が読まない**。
//   こちらのほうが規模が大きいことがある (2026-09-03: hs_* だけで 4 万行超)。
//   分母は OpenAPI (GET /rest/v1/) — grep ではなく **DB に実在する表**。
{
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const j = (await res.json()) as { definitions?: Record<string, unknown> };
  const exists = Object.keys(j.definitions ?? {});
  const unref = exists.filter((t) => !allTables.has(t)).sort();
  const withRows: { t: string; n: number }[] = [];
  await Promise.all(unref.map(async (t) => {
    const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
    if (!error && (count ?? 0) > 0) withRows.push({ t, n: count ?? 0 });
  }));
  withRows.sort((a, b) => b.n - a.n);
  console.log(`
══ ★ 逆側 — DB に実在するが app が .from で参照しない — ${unref.length} 種 ══`);
  console.log(`   うち **行がある** ${withRows.length} 種 (合計 ${withRows.reduce((a, r) => a + r.n, 0).toLocaleString()} 行)`);
  for (const r of withRows) console.log(`     ${String(r.n).padStart(7)} 行  ${r.t}`);
  console.log(`   ⚠ 「読まれていない」だけで、消してよいとは限らない (取込の中間表・監査ログ)。`);
}

// ★ 未分類が残ったら落とす (手で保守する一覧にしない)
const unclassified = zero.filter((t) => !rows.some((r) => r.t === t));
console.log(`\n合計 ${rows.length} / 0 行 ${zero.length}`);
if (unclassified.length) {
  console.error(`\n✗ 未分類が ${unclassified.length} 種: ${unclassified.join(", ")}`);
  process.exit(1);
}
console.log("✓ 未分類なし");
