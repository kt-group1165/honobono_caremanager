import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { apiKey, userInfo, services, mode } = body;

    if (!apiKey) {
      return NextResponse.json({ error: "APIキーが設定されていません" }, { status: 400 });
    }

    const anthropic = new Anthropic({ apiKey });

    // 利用者情報を整形
    const userContext = `
【利用者情報】
氏名: ${userInfo.name}
年齢: ${userInfo.age}歳
性別: ${userInfo.gender}
要介護度: ${userInfo.careLevel}
既往歴: ${userInfo.medicalHistory || "なし"}
ADL状況: ${userInfo.adlSummary || "情報なし"}
家族状況: ${userInfo.familySituation || "情報なし"}
特記事項: ${userInfo.notes || "なし"}
`.trim();

    // サービス情報を整形
    const serviceList = (services || [])
      .map((s: { type: string; content: string; frequency: string; provider: string }) =>
        `・${s.type}（${s.content}）${s.frequency} - ${s.provider}`
      )
      .join("\n");

    let systemPrompt = "";
    let userPrompt = "";

    if (mode === "from-services" || mode === "from-services-grouped") {
      const groupingRule = mode === "from-services-grouped"
        ? `- ニーズはできるだけ少なく（1〜2件が理想）まとめる。不自然にならない限り、複数のサービスを1つのニーズにグルーピングする
- 例えば「入浴介助」と「排泄介助」と「移動介助」は「自宅での安全な日常生活を送りたい」のような包括的なニーズにまとめる
- 「福祉用具」と「身体介護」も、関連があれば1つのニーズにまとめる
- 本当に性質が異なるもの（例：身体介護と通所リハビリの目的が明確に違う場合）のみ別のニーズに分ける`
        : `- サービスの種類ごとに適切なニーズ・目標をグルーピングしてください`;

      systemPrompt = `あなたは経験豊富な介護支援専門員（ケアマネージャー）です。
居宅サービス計画書（第2表）の作成を支援します。
利用者の状態とサービス内容から、適切なニーズ（生活全般の解決すべき課題）、長期目標、短期目標、サービス内容の文章を生成してください。

【ルール】
- ニーズは利用者本人の視点で「〜したい」「〜を維持したい」という表現を使う
- 長期目標は6ヶ月〜1年の達成目標、短期目標は3〜6ヶ月の具体的目標
- サービス内容は具体的な援助内容を箇条書きで
- 簡潔でわかりやすい日本語で書く
- 実際のケアプランとして使える質の文章にする
${groupingRule}

【出力形式】JSON形式で出力してください：
{
  "blocks": [
    {
      "needs": "ニーズの文章",
      "long_term_goal": "長期目標の文章",
      "short_term_goal": "短期目標の文章",
      "services": [
        {
          "content": "サービス内容の文章",
          "type": "サービス種別",
          "frequency": "頻度",
          "provider": "事業所名"
        }
      ]
    }
  ]
}`;

      userPrompt = `${userContext}

【利用するサービス】
${serviceList}

上記のサービスに合わせて、ケアプラン第2表の内容を生成してください。
サービスの種類ごとに適切なニーズ・目標をグルーピングしてください。`;

    } else {
      // ニーズから順にプラン全体を生成
      systemPrompt = `あなたは経験豊富な介護支援専門員（ケアマネージャー）です。
居宅サービス計画書（第2表）の作成を支援します。
利用者の情報から、適切なケアプラン全体を提案してください。

【ルール】
- ニーズは2〜4件程度
- 各ニーズに対して長期目標・短期目標・サービスを提案
- ニーズは利用者本人の視点で表現
- 実際のケアプランとして使える質の文章にする
- 簡潔でわかりやすい日本語

【出力形式】JSON形式で出力：
{
  "blocks": [
    {
      "needs": "ニーズ",
      "long_term_goal": "長期目標",
      "short_term_goal": "短期目標",
      "services": [
        { "content": "サービス内容", "type": "サービス種別", "frequency": "頻度", "provider": "" }
      ]
    }
  ],
  "overall_policy": "総合的な援助の方針"
}`;

      userPrompt = `${userContext}

この利用者に適切なケアプランを提案してください。`;
    }

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: userPrompt }],
      system: systemPrompt,
    });

    // レスポンスからJSONを抽出
    const responseText = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // JSONブロックを抽出
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "AIからの応答を解析できませんでした", raw: responseText }, { status: 500 });
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // コスト計算（Claude Sonnet: 入力$3/100万, 出力$15/100万, 1$=150円）
    const inputCost = (message.usage.input_tokens / 1_000_000) * 3 * 150;
    const outputCost = (message.usage.output_tokens / 1_000_000) * 15 * 150;
    const totalCostYen = Math.round((inputCost + outputCost) * 100) / 100;

    return NextResponse.json({
      success: true,
      data: parsed,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        estimated_cost_yen: totalCostYen,
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "不明なエラー";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
