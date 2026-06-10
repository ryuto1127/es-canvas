// Phase C: few-shot example。Anthropic prompt caching の対象として、1 ペア
// (user メッセージ + assistant tool_use)を会話履歴に挿入する。
//
// セッション5 設計メモ:
//  - sug_006 は company_value + evidence_id の使い方を 1 箇所だけ教えるための例
//    (キックオフの「iq_003 の rationale_source」指示は構造的不整合 — iq_003 は
//     interview_questions 配下で rationale_source を持たない — のため、新規
//     suggestion として再解釈。DECISIONS.md に記録)
//  - 2026-05-24 追補(internal_priority 欠落の追補):
//    Phase G 修正 (2026-05-23) で internal_priority を導入した際、
//    system.ts / tool schema は更新したが few-shot は更新し忘れていた。
//    Opus にとって few-shot は最も強い学習信号であり、文章指示と few-shot
//    構造の不整合が es4 出力での欠落を引き起こしていた(es1 で 8/8 出力、
//    es4 で 0/6 欠落)。本ファイルの 6 件すべてに internal_priority を
//    付与して構造的整合を回復する。具体値は system.ts L197-205 の規範
//    (10=最重要、5=標準、1=軽微 / company_value はブースト)を反映:
//      sug_001 (語尾調整): 3   — 軽微寄り表現指摘
//      sug_002 (STAR Action 解像度): 8 — 構造的指摘、高優先
//      sug_003 (語感重複 alternative): 4 — 表現レベル
//      sug_004 (学びの抽象性 rubric): 7 — 構造的指摘
//      sug_005 (Situation 補強): 6 — 標準的 convention
//      sug_006 (company_value 接続): 9 — 企業価値直結、最重要寄り
//  - 2026-05-26 追補(v2 Phase B2 — structural example 2 件追加):
//    structural カテゴリを system.ts に導入(Phase B2 Commit 1)。Opus が
//    structural の field 構造(structural_params + lost_content)と判定基準
//    (段落単位の構造操作 / 5 operations)を学習するため、教育的 example を
//    2 件追加する(load-bearing few-shot structure 同期、AGENTS.md L67-87)。
//    既存 sug_001-006 は完全無変更。具体値:
//      sug_007 (delete_paragraph): 8 — 構造的指摘、高優先
//      sug_008 (reorder_paragraphs): 7 — 構造的指摘
//    note: few-shot ES (ANALYZE_FEWSHOT_USER_MESSAGE) は 1 段落構造のため、
//    sug_007/008 は厳密な ES 本体整合よりも「structural の field 構造と
//    judgmental flow を Opus に教える教育目的」を優先した example。実 ES が
//    複数段落で構成された場合の判定パターンを示す。
//  - 2026-05-27 追補(エージェント的対話 — clarification_questions 例 1-2 件追加):
//    system.ts に「逆質問の規律」を追加(Task 3)。Opus が clarification_questions
//    の field 構造(id / question / rationale)と「無理に出さない / 1-3 件に絞る」
//    規律を学習するため、教育的 example を選別的に追加する(load-bearing few-shot
//    structure 同期、AGENTS.md「Load-bearing few-shot structure」)。
//    残り 7 件 suggestion は **clarification_questions field を持たない**
//    (optional のため省略)= 「質問は任意 = 出さなくてもよい」を構造的に学習させる。
//    具体値:
//      sug_002 (STAR Action 解像度): clarification_questions に q_001 を 1 件追加
//        — 「動機がエピソードの説得力に直結」する場合の suggestion-bound 質問例
//      global_clarification_questions: q_002 を 1 件追加
//        — 「ES 結末を具体事業に紐付ける」global 質問例
//    合計: suggestion-bound 1 + global 1 = 2 個 ≤ 3 件上限を満たす。
//
// 注意: 文字列に動的注入(template literal)を入れない。完全に静的に保つ。

// few-shot で使う Example User Message(input フォーマット例)
export const ANALYZE_FEWSHOT_USER_MESSAGE = `[ES本体]
私が学生時代に頑張ったのは、サークル活動です。テニスサークルに3年間所属し、副幹事を務めました。最初は人見知りで上手く話せませんでしたが、コミュニケーションを意識した結果、後輩からも信頼されるようになりました。また、大会では団体戦で優勝することができ、達成感を感じました。この経験から、リーダーシップとチームワークの大切さを学びました。

[設問]
学生時代に最も力を入れたことを教えてください(400字以内)

[企業要約]
価値観: Think Deep, 誠実, Open Hands, Try First, User Compass
事業概要: B2B SaaS企業。AIを意思決定の基礎に据え、ファクトベースで判断する文化を重視。
ソースURL: https://example-saas.com/

# 承認済み evidence(rationale_source.evidence_id はこのリストからのみ選択可)
- ev_001: "Think Deep" (https://example-saas.com/about)

[添削条件]
プリセット: バランス
自由入力: (なし)

[ユーザー文脈]
(なし)
`;

// few-shot Assistant Tool Use 入力(analyze_es ツール呼び出しの input 部分の JSON)。
// AISuggestionSchema / AIInitialAnalysisOutputSchema に厳密に整合した形にしてある。
// 補足:
//   - sug_006 は company_value + evidence_id の使い方を 1 箇所だけ教える例
//   - sug_006 と sug_004 は同じ original を引いているが、視点が異なるため related で結ぶ
export const ANALYZE_FEWSHOT_ASSISTANT_INPUT = {
  es_state_version: 1,
  overall_assessment: {
    summary:
      "サークル活動を題材にした標準的なガクチカ。役職と結果は明示されているが、行動の解像度が低く、抽象的な学びで締めくくっており、企業価値観との接続が弱い。",
    strengths: [
      "3年間という継続性",
      "団体戦優勝という客観的成果",
      "副幹事という具体的役職",
    ],
    weaknesses: [
      "コミュニケーションの中身が不明",
      "規模・チーム構成が見えない",
      "学びが抽象的",
      "企業価値観への接続なし",
    ],
    preserved_voice_note: "端的でストレートな語り口。装飾を避ける素朴さがある",
  },
  suggestions: [
    {
      id: "sug_001",
      category: "convention",
      original: "頑張った",
      proposed: "取り組んだ",
      alternatives: [],
      rationale:
        "「頑張った」は主観的な努力の度合いを示す評価語で、読み手にはあなたが実際に何をしたかが伝わりません。ES では評価語を削り、行動や成果に紐づく動詞で具体性を出すのが定石です。ここでは「取り組んだ」に置き換えるだけでも、続く事実の重みが増します。",
      rationale_source: {
        type: "convention",
        reference: "動詞を具体化する ES 慣習(抽象的な評価語を削って事実に紐づける)",
      },
      related_suggestion_ids: ["sug_003"],
      internal_priority: 3,
    },
    {
      id: "sug_002",
      category: "convention",
      original: "コミュニケーションを意識した結果、後輩からも信頼されるようになりました",
      proposed:
        "後輩との1on1を月1回設定し、悩み相談の窓口になることで、徐々に信頼関係を築きました",
      alternatives: [],
      rationale:
        "ここでは「コミュニケーションを意識した」が抽象的で、実際に何をしたのかが読み手に伝わりません。ガクチカでは、信頼関係を築くまでの具体行動(頻度、場面、自分の判断)を一つでも書くと、面接官の頭にあなたの動き方が立ち上がります。月 1 回の 1on1 を例に、行動の解像度を上げる方向で書き直してみてください。",
      rationale_source: {
        type: "rubric",
        reference: "ガクチカ評価軸: 行動の解像度",
      },
      related_suggestion_ids: [],
      internal_priority: 8,
      clarification_questions: [
        {
          id: "q_001",
          question:
            "実際にどんな場面で「コミュニケーションを意識した」のですか?印象に残った一場面を教えてください",
          rationale:
            "「意識した」は内省ですが、その引き金になった具体的な場面が分かると、proposed の 1on1 例より書き手固有の行動が書けます。自分の判断点が一段深く言語化できる質問です",
        },
      ],
    },
    {
      id: "sug_003",
      category: "alternative",
      original: "達成感を感じました",
      proposed: "達成感を覚えました",
      alternatives: [
        { id: "alt_003_1", text: "達成感を覚えました", tone_hint: "より自然な語感" },
        { id: "alt_003_2", text: "手応えを得ました", tone_hint: "やや成果志向" },
        { id: "alt_003_3", text: "充実感を得ました", tone_hint: "原文のトーンを維持" },
      ],
      rationale:
        "「感じる」が直近の文と重複しており、語感が単調になります。これは主観的な好みであり、原文が誤っているわけではありません。原文の率直なトーンを保ちつつ、語感を整える選択肢として「覚えました」「手応えを得ました」等を検討してみてください。",
      rationale_source: {
        type: "linguistic",
        reference: "日本語の同根語重複(語感の主観的選好)",
      },
      related_suggestion_ids: [],
      internal_priority: 4,
    },
    {
      id: "sug_004",
      category: "convention",
      original: "リーダーシップとチームワークの大切さを学びました",
      proposed: "「個々の状況に応じた働きかけがチームの結束を生む」という学びを得ました",
      alternatives: [],
      rationale:
        "「リーダーシップ」「チームワーク」は誰でも書ける抽象語で、あなた固有の思考が読み取れません。学びを「個々の状況に応じた働きかけがチームの結束を生む」のように、自分の体験から言語化した形で書くと、思考の深さが伝わります。なお、同じ箇所への企業価値観接続案(関連指摘)も併存しているため、両者は同時採用すると同じ文を二度書き換える関係になります。どちらか一方を選ぶ前提で読み比べてください。",
      rationale_source: {
        type: "rubric",
        reference: "ガクチカ評価軸: 学びの解像度",
      },
      related_suggestion_ids: ["sug_006"],
      internal_priority: 7,
    },
    {
      id: "sug_005",
      category: "convention",
      original: "テニスサークルに3年間所属し、副幹事を務めました",
      proposed:
        "30人規模のテニスサークルに3年間所属し、副幹事として新歓・大会運営・後輩指導を担当しました",
      alternatives: [],
      rationale:
        "「テニスサークルに所属」「副幹事を務めた」だけでは、サークルの規模や、副幹事として担っていた責任範囲が読み手に伝わりません。冒頭でチームの人数と担当領域を補強しておくと、続くエピソードの背景が立ち上がり、面接官があなたの動き方をイメージできるようになります。これは表現の好みではなく、状況設定を整える構造的な補強です。",
      rationale_source: {
        type: "convention",
        reference: "状況設定の解像度を上げる ES 慣習(チーム規模と担当範囲を冒頭で明示する)",
      },
      related_suggestion_ids: [],
      internal_priority: 6,
    },
    {
      id: "sug_006",
      category: "convention",
      original: "リーダーシップとチームワークの大切さを学びました",
      proposed:
        "ファクトに基づいて仲間の状況を捉え、共に意思決定する習慣の重要性を学びました",
      alternatives: [],
      rationale:
        "ターゲット企業の「Think Deep」が示すデータ駆動の判断文化と接続できる学びの言語化に置き換えると、企業価値観への適合度が上がります。同じ箇所への独自視点案(関連指摘)も併存しているため、ユーザーは独自視点と企業価値観接続のどちらを優先するかを比較した上で、片方を採用してください。",
      rationale_source: {
        type: "company_value",
        reference: "Think Deep",
        url: "https://example-saas.com/about",
        evidence_id: "ev_001",
      },
      related_suggestion_ids: ["sug_004"],
      internal_priority: 9,
    },
    {
      id: "sug_007",
      category: "structural",
      original: "私が学生時代に頑張ったのは、サークル活動です。",
      proposed: "(段落削除:冒頭の宣言文段落を取り除き、直接エピソードに入る)",
      alternatives: [],
      rationale:
        "冒頭の一文は設問への直接的な答えだけで、実質的な情報を含んでいません。設問が既に「学生時代に最も力を入れたこと」を問うているため、冒頭で復唱する必要が薄く、字数を圧迫します。この一文が独立段落として書かれている場合は段落ごと削除して、直接エピソードに入る構成に変えると、限られた字数で具体的な行動と思考を厚く書けます。",
      rationale_source: {
        type: "convention",
        reference: "ガクチカ冒頭の宣言文を省いて事実に直接入る ES 慣習(設問復唱の省略)",
      },
      related_suggestion_ids: [],
      internal_priority: 8,
      structural_params: {
        operation: "delete_paragraph",
        target_paragraph_index: 0,
      },
      lost_content:
        "「学生時代に頑張ったのはサークル活動」という宣言。設問が既に同内容を問うているため情報損失は最小限。",
    },
    {
      id: "sug_008",
      category: "structural",
      original:
        "最初は人見知りで上手く話せませんでしたが、コミュニケーションを意識した結果、後輩からも信頼されるようになりました。また、大会では団体戦で優勝することができ、達成感を感じました。この経験から、リーダーシップとチームワークの大切さを学びました。",
      proposed:
        "[段落順を 2 → 0 → 1 に変更:学び・成果を冒頭、苦労を中盤、行動を末尾に並べ替えて結論先出しにする]",
      alternatives: [],
      rationale:
        "もしこのエピソードが「苦労 → 行動 → 学び」の 3 段落で書かれているなら、結論となる「学び」段落を冒頭に持ってくると、読み手が要点を最初に掴めます。ES の冒頭は面接官が最も注意を払う場所のため、結論先出しで掴みを強化する方が、面接に進む確率が上がります。段落順を入れ替えるだけで本文には手を入れない構造変更であり、書き手の表現はそのまま維持できます。",
      rationale_source: {
        type: "convention",
        reference: "結論先出し / STAR モデルの Result を冒頭に置く ES 慣習",
      },
      related_suggestion_ids: [],
      internal_priority: 7,
      structural_params: {
        operation: "reorder_paragraphs",
        new_order: [2, 0, 1],
      },
    },
  ],
  interview_questions: {
    generated_at_es_version: 1,
    is_stale: false,
    questions: [
      {
        id: "iq_001",
        question:
          "「人見知りで上手く話せなかった」状態から後輩に信頼されるまでの間に、一番転機となった出来事は何でしたか?",
        rationale: "心理的変化のプロセスが明示されていないため、面接で深掘りされる可能性が高い。",
        answer_hint:
          "具体的なエピソードを1つ用意。状況→意識した変化→具体行動→反応の順で話す。",
        purpose_hint: "自己内省の深さ・変化の言語化能力",
      },
      {
        id: "iq_002",
        question: "団体戦優勝に至るまで、副幹事として最も貢献したと自負する行動は何ですか?",
        rationale:
          "成果と自分の貢献の対応関係が薄い。「優勝した」は事実だが、自分が何をしたから優勝したかが見えない。",
        answer_hint:
          "成果を分解し、自分の働きかけが他メンバーや戦略に与えた影響を具体的に述べる。",
        purpose_hint: "成果への自己貢献の言語化",
      },
      {
        id: "iq_003",
        question:
          "貴社の「Think Deep」という指針に、ご自身のサークル経験はどう繋がりますか?",
        rationale:
          "ESには企業価値観との接続が書かれていない。志望動機系の質問で必ず聞かれる。",
        answer_hint:
          "AIを意思決定の基礎に据える文化と、自身が困難な状況でデータ分析を起点に判断した経験を結びつける。",
        purpose_hint: "企業理解と自己との接続",
      },
    ],
  },
  // 2026-05-27 エージェント的対話(AI 逆質問): global 質問の例 1 件。
  // 「ES 結末の抽象性 → 企業具体事業との接続」を聞き出す質問で、ユーザー回答を受けて
  // partial refresh で suggestion(sug_006)の rationale / proposed を refine できる経路を示す。
  // suggestion-bound(sug_002 の q_001)と合算で 2 件 ≤ 3 件上限を満たす。
  global_clarification_questions: [
    {
      id: "q_002",
      question:
        "企業のどの事業に最も貢献したいと考えていますか?サークル経験のどの場面と接続できそうですか?",
      rationale:
        "ES の結末「リーダーシップとチームワークの大切さを学んだ」が抽象的で、企業価値観との接続が読み取れません。事業を具体に絞った回答が得られれば、sug_006(Think Deep 接続)の rationale をより説得力ある形に refine できます",
    },
  ],
} as const;
