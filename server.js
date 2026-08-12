/**
 * ==========================================================
 * LINE Bot 収支管理アプリ - 統合版 server.js
 * ==========================================================
 * GitHubへのアップロードを簡単にするため、以下をすべて1ファイルに統合しています。
 *   1. カードマスタ（締め日/支払日ルール）
 *   2. 支払日の自動計算アルゴリズム
 *   3. 取引データストア（インメモリ。本来はDBに置き換える）
 *   4. 取引登録・照会サービス
 *   5. LINE返信メッセージのフォーマッタ
 *   6. 自由入力の自然文解析（正規表現版 / Claude APIベース版）
 *   7. Express + LINE Messaging API Webhook
 *
 * 本番運用では可読性・保守性のためファイル分割を推奨しますが、
 * GitHubのWeb UIから1つずつファイルを作るのが大変な間はこの1ファイル構成で
 * 動かし、慣れてきたら分割する、という進め方でも問題ありません。
 */

require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const Anthropic = require("@anthropic-ai/sdk");
const { randomUUID } = require("crypto");

// ==========================================================
// 1. カードマスタ（要件: 締め日/支払日ルールの保持）
// ==========================================================
// closingDay / paymentDay: 1〜31。月末を表す場合は 0
// paymentMonthOffset: 締め月から何ヶ月後に支払われるか（1=翌月払い、2=翌々月払い）
const cardMaster = [
  {
    id: "card_saison",
    userId: "u_001",
    name: "セゾンカード",
    closingDay: 10,
    paymentDay: 4,
    paymentMonthOffset: 1,
  },
  {
    id: "card_rakuten",
    userId: "u_001",
    name: "楽天カード",
    closingDay: 0, // 月末締め
    paymentDay: 27,
    paymentMonthOffset: 1,
  },
  {
    id: "card_mitsui",
    userId: "u_001",
    name: "三井住友カード",
    closingDay: 15,
    paymentDay: 10,
    paymentMonthOffset: 1,
  },
  {
    id: "card_jcb",
    userId: "u_001",
    name: "JCBカード",
    closingDay: 0,
    paymentDay: 10,
    paymentMonthOffset: 2, // 翌々月払い
  },
];

function findCardByName(userId, name) {
  return cardMaster.find((c) => c.userId === userId && c.name === name) || null;
}

function listCardsByUser(userId) {
  return cardMaster.filter((c) => c.userId === userId);
}

// ==========================================================
// 2. 支払日の自動計算アルゴリズム
// ==========================================================
function lastDayOfMonth(year, monthIndex /* 0-indexed */) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * @param {string} usageDateStr - 利用日 'YYYY-MM-DD'
 * @param {{closingDay:number, paymentDay:number, paymentMonthOffset:number}} card
 * @returns {string} 支払日 'YYYY-MM-DD'
 */
function calculateScheduledDate(usageDateStr, card) {
  if (!usageDateStr || !card) {
    throw new Error("usageDateStr と card は必須です");
  }

  const usageDate = new Date(`${usageDateStr}T00:00:00`);
  if (Number.isNaN(usageDate.getTime())) {
    throw new Error(`不正な日付です: ${usageDateStr}`);
  }

  const usageDay = usageDate.getDate();
  let closingYear = usageDate.getFullYear();
  let closingMonth = usageDate.getMonth();

  const closingDayEff =
    card.closingDay === 0 ? lastDayOfMonth(closingYear, closingMonth) : card.closingDay;

  // 締め日を過ぎている利用は、翌月の締めに繰り越す
  if (usageDay > closingDayEff) {
    closingMonth += 1;
    if (closingMonth > 11) {
      closingMonth = 0;
      closingYear += 1;
    }
  }

  let paymentMonth = closingMonth + card.paymentMonthOffset;
  let paymentYear = closingYear;
  while (paymentMonth > 11) {
    paymentMonth -= 12;
    paymentYear += 1;
  }

  const paymentDayEff =
    card.paymentDay === 0
      ? lastDayOfMonth(paymentYear, paymentMonth)
      : Math.min(card.paymentDay, lastDayOfMonth(paymentYear, paymentMonth));

  return toISODate(new Date(paymentYear, paymentMonth, paymentDayEff));
}

// ==========================================================
// 3. 取引データストア（本来は DB のテーブル: transactions）
// ==========================================================
const saison = cardMaster.find((c) => c.id === "card_saison");
const rakuten = cardMaster.find((c) => c.id === "card_rakuten");

const transactions = [
  {
    id: "tx_seed_1",
    userId: "u_001",
    type: "expense",
    amount: 15000,
    currency: "JPY",
    title: "衣類購入",
    paymentMethod: "card",
    cardId: saison.id,
    cardName: saison.name,
    usageDate: "2026-08-05",
    scheduledDate: calculateScheduledDate("2026-08-05", saison),
    status: "scheduled",
    createdAt: new Date().toISOString(),
  },
  {
    id: "tx_seed_2",
    userId: "u_001",
    type: "expense",
    amount: 8000,
    currency: "JPY",
    title: "日用品",
    paymentMethod: "card",
    cardId: rakuten.id,
    cardName: rakuten.name,
    usageDate: "2026-08-20",
    scheduledDate: calculateScheduledDate("2026-08-20", rakuten),
    status: "scheduled",
    createdAt: new Date().toISOString(),
  },
  {
    id: "tx_seed_3",
    userId: "u_001",
    type: "income",
    amount: 300000,
    currency: "JPY",
    title: "A社",
    paymentMethod: "direct",
    scheduledDate: "2026-09-10",
    status: "scheduled",
    createdAt: new Date().toISOString(),
  },
];

function insertTransaction(tx) {
  transactions.push(tx);
  return tx;
}

function getUpcoming(userId, type, limit = 5) {
  const todayStr = new Date().toISOString().slice(0, 10);
  return transactions
    .filter(
      (t) =>
        t.userId === userId &&
        t.type === type &&
        t.status === "scheduled" &&
        t.scheduledDate >= todayStr
    )
    .sort((a, b) => (a.scheduledDate < b.scheduledDate ? -1 : 1))
    .slice(0, limit);
}

// ==========================================================
// 4. 取引登録・照会サービス
// ==========================================================
function registerExpenseByCard({ userId, cardName, amount, usageDate, title }) {
  const card = findCardByName(userId, cardName);
  if (!card) {
    throw new Error(`カードが見つかりません: ${cardName}`);
  }
  if (!amount || amount <= 0) {
    throw new Error("amount は正の数値である必要があります");
  }

  const scheduledDate = calculateScheduledDate(usageDate, card);

  return insertTransaction({
    id: randomUUID(),
    userId,
    type: "expense",
    amount,
    currency: "JPY",
    title: title || cardName,
    paymentMethod: "card",
    cardId: card.id,
    cardName: card.name,
    usageDate,
    scheduledDate,
    status: "scheduled",
    createdAt: new Date().toISOString(),
  });
}

function registerDirectTransaction({ userId, type, title, amount, scheduledDate, currency = "JPY" }) {
  return insertTransaction({
    id: randomUUID(),
    userId,
    type,
    amount,
    currency,
    title,
    paymentMethod: "direct",
    scheduledDate,
    status: "scheduled",
    createdAt: new Date().toISOString(),
  });
}

/** 自然文パーサー（regex/LLM共通）の出力を、適切な登録関数に振り分ける */
function registerFromParsedText(parsed, userId) {
  if (parsed.type === "expense" && parsed.cardName) {
    return registerExpenseByCard({
      userId,
      cardName: parsed.cardName,
      amount: parsed.amount,
      usageDate: parsed.date,
      title: parsed.title,
    });
  }
  return registerDirectTransaction({
    userId,
    type: parsed.type,
    title: parsed.title,
    amount: parsed.amount,
    scheduledDate: parsed.date,
    currency: parsed.currency || "JPY",
  });
}

function getUpcomingExpenses(userId, limit = 5) {
  return getUpcoming(userId, "expense", limit);
}

function getUpcomingIncomes(userId, limit = 5) {
  return getUpcoming(userId, "income", limit);
}

// ==========================================================
// 5. LINE返信メッセージのフォーマッタ
// ==========================================================
function formatDateJP(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatYen(amount) {
  return `${amount.toLocaleString("ja-JP")}円`;
}

function formatExpenseReply(expenses) {
  if (expenses.length === 0) {
    return "直近の支出予定はありません。";
  }
  return expenses
    .map((e) => {
      const subject = e.paymentMethod === "card" ? e.cardName : e.title;
      return `${subject}で ${formatDateJP(e.scheduledDate)} に ${formatYen(e.amount)} の請求があります`;
    })
    .join("\n");
}

function formatIncomeReply(incomes) {
  if (incomes.length === 0) {
    return "直近の入金予定はありません。";
  }
  return incomes
    .map((i) => `${i.title}から ${formatDateJP(i.scheduledDate)} に ${formatYen(i.amount)} の振り込み予定があります`)
    .join("\n");
}

/** 例:「登録しました：2/10にセゾンカードで3,000円（ランチ）」 */
function formatRegistrationConfirmation(tx) {
  const dateLabel = formatDateJP(tx.scheduledDate);
  if (tx.paymentMethod === "card") {
    return `登録しました：${dateLabel}に${tx.cardName}で${formatYen(tx.amount)}（${tx.title}）`;
  }
  if (tx.type === "income") {
    return `登録しました：${dateLabel}に${tx.title}から${formatYen(tx.amount)}の入金予定です`;
  }
  return `登録しました：${dateLabel}に${formatYen(tx.amount)}（${tx.title}）の支出として記録しました`;
}

// ==========================================================
// 6-A. 自由入力の解析: 正規表現ベース（Pattern A）
// ==========================================================
const RELATIVE_DATE_WORDS = [
  ["明後日", 2],
  ["あさって", 2],
  ["明日", 1],
  ["今日", 0],
  ["本日", 0],
  ["昨日", -1],
];

const INCOME_KEYWORDS = ["振り込まれる", "振込まれる", "入金", "振り込み", "振込", "給与", "もらう", "受け取る"];
const EXPENSE_KEYWORDS = ["使った", "払った", "支払った", "購入", "買った", "食べた", "引き落とし"];

function resolveDate(text, referenceDate) {
  for (const [word, offsetDays] of RELATIVE_DATE_WORDS) {
    if (text.includes(word)) {
      const d = new Date(referenceDate);
      d.setDate(d.getDate() + offsetDays);
      return toISODate(d);
    }
  }
  const absMatch = text.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/);
  if (absMatch) {
    const month = parseInt(absMatch[1], 10) - 1;
    const day = parseInt(absMatch[2], 10);
    const year = referenceDate.getFullYear();
    let candidate = new Date(year, month, day);
    const refMidnight = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
    if (candidate < refMidnight) {
      candidate = new Date(year + 1, month, day);
    }
    return toISODate(candidate);
  }
  return toISODate(referenceDate); // 日付表現がなければ「今日」とみなす
}

function extractAmount(text) {
  const manMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*万\s*円?/);
  if (manMatch) {
    return Math.round(parseFloat(manMatch[1]) * 10000);
  }
  const yenMatch = text.match(/([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)\s*円/);
  if (yenMatch) {
    return parseInt(yenMatch[1].replace(/,/g, ""), 10);
  }
  return null;
}

function detectType(text) {
  if (INCOME_KEYWORDS.some((k) => text.includes(k))) return "income";
  if (EXPENSE_KEYWORDS.some((k) => text.includes(k))) return "expense";
  return null;
}

function extractCardName(text, userId) {
  const cards = listCardsByUser(userId);
  const found = cards.find((c) => {
    const shortName = c.name.replace(/カード$/, "");
    return text.includes(c.name) || text.includes(shortName);
  });
  return found ? found.name : null;
}

function extractTitle(text, type) {
  if (type === "income") {
    const fromMatch = text.match(/(.+?)から/);
    if (fromMatch) {
      const cleaned = fromMatch[1].replace(/^(今日|明日|明後日|あさって|昨日|本日)/, "").trim();
      if (cleaned) return cleaned;
    }
    return "振込";
  }
  const purposeMatch = text.match(/の\s*([^の、。\sをでに]+)\s*を/);
  if (purposeMatch) return purposeMatch[1];
  return null;
}

/** 外部APIを呼ばないため無料・低レイテンシだが、想定外の言い回しには弱い */
function parseTransactionTextRegex(text, { userId, referenceDate = new Date() } = {}) {
  const amount = extractAmount(text);
  const type = detectType(text);
  if (!amount || !type) return null;

  const date = resolveDate(text, referenceDate);
  const cardName = type === "expense" ? extractCardName(text, userId) : null;
  const title = extractTitle(text, type) || cardName || (type === "expense" ? "支出" : "振込");

  return { type, amount, currency: "JPY", title, date, cardName };
}

// ==========================================================
// 6-B. 自由入力の解析: Claude APIベース（Pattern B）
// ==========================================================
// ANTHROPIC_API_KEY は環境変数から自動的に読み込まれる
const anthropicClient = new Anthropic();

const LLM_SYSTEM_PROMPT_TEMPLATE = `あなたは家計簿アプリの入力解析アシスタントです。
ユーザーが入力した自然な日本語の文章から取引情報を抽出し、JSONのみを出力してください。
説明文・前置き・マークダウンのコードフェンスは一切付けないでください。

出力するJSONのスキーマ:
{
  "type": "income" または "expense",
  "amount": 数値（円、整数）,
  "cardName": 支出をカードで払った場合のみカード名の文字列、それ以外は null,
  "title": 品目名（支出の場合）または相手先名（収入の場合）,
  "date": "YYYY-MM-DD" 形式の絶対日付（「今日」「明日」等の相対表現は基準日から計算する）
}

登録されているカード名は次のいずれかのみです。これ以外の名称は使わず、
本文にカードへの言及がなければ cardName は null にしてください:
{{CARD_NAMES}}

amount が読み取れないなど、取引として解析できない入力の場合は
{"error": "unrecognized"} とだけ出力してください。`;

async function parseTransactionTextLLM(text, { userId, referenceDate = new Date() } = {}) {
  const cardNames = listCardsByUser(userId).map((c) => c.name);
  const systemPrompt = LLM_SYSTEM_PROMPT_TEMPLATE.replace(
    "{{CARD_NAMES}}",
    cardNames.length > 0 ? cardNames.join("、") : "（登録済みカードなし）"
  );
  const todayStr = toISODate(referenceDate);

  let response;
  try {
    response = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: `基準日（今日の日付）: ${todayStr}\n入力文: ${text}` }],
    });
  } catch (err) {
    console.error("Claude API 呼び出しエラー:", err);
    return null;
  }

  const rawText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
  } catch (err) {
    console.error("LLM出力のJSONパースに失敗:", rawText);
    return null;
  }

  if (parsed.error) return null;

  if (typeof parsed.amount !== "number" || parsed.amount <= 0) return null;
  if (!["income", "expense"].includes(parsed.type)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.date || "")) return null;

  let cardName = parsed.cardName || null;
  if (cardName && !listCardsByUser(userId).some((c) => c.name === cardName)) {
    cardName = null; // マスタにないカード名は無視し、現金扱いにフォールバック
  }

  return {
    type: parsed.type,
    amount: Math.round(parsed.amount),
    currency: "JPY",
    title: (parsed.title && String(parsed.title).trim()) || cardName || "取引",
    date: parsed.date,
    cardName,
  };
}

// ==========================================================
// 6-C. 解析方式ディスパッチャ（環境変数で regex / llm を切り替え）
// ==========================================================
const NLP_STRATEGY = (process.env.NLP_PARSER_STRATEGY || "regex").toLowerCase();

async function parseTransactionText(text, { userId, referenceDate = new Date() } = {}) {
  if (NLP_STRATEGY === "llm") {
    const llmResult = await parseTransactionTextLLM(text, { userId, referenceDate });
    if (llmResult) return llmResult;
    return parseTransactionTextRegex(text, { userId, referenceDate }); // 失敗時はregexにフォールバック
  }
  return parseTransactionTextRegex(text, { userId, referenceDate });
}

// ==========================================================
// 7. Express + LINE Messaging API Webhook
// ==========================================================
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new line.Client(lineConfig);
const app = express();

const MENU_LABELS = { EXPENSE: "支出", INCOME: "収入" };

const PARSE_FAILURE_MESSAGE =
  "うまく読み取れませんでした。日付・金額（カード払いの場合はカード名も）を含めて入力してください。\n例：今日セゾンで3000円のランチを食べた";

/**
 * LINEのuserId → アプリ内部のuserIdへの解決。
 * 実運用では users テーブルで LINE userId と紐付けて管理する。
 * ここではサンプルとして固定ユーザーに解決している。
 */
function resolveUserId(lineUserId) {
  return "u_001";
}

async function handleFreeTextInput(text, userId) {
  const parsed = await parseTransactionText(text, { userId, referenceDate: new Date() });
  if (!parsed) {
    return PARSE_FAILURE_MESSAGE;
  }
  const transaction = registerFromParsedText(parsed, userId);
  return formatRegistrationConfirmation(transaction);
}

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userId = resolveUserId(event.source.userId);
  const text = event.message.text.trim();

  let replyText;
  if (text === MENU_LABELS.EXPENSE) {
    replyText = formatExpenseReply(getUpcomingExpenses(userId, 5));
  } else if (text === MENU_LABELS.INCOME) {
    replyText = formatIncomeReply(getUpcomingIncomes(userId, 5));
  } else {
    replyText = await handleFreeTextInput(text, userId);
  }

  if (!replyText) return null;
  return lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
}

app.post("/line/webhook", line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("LINE webhook error:", err);
    res.status(200).end(); // LINE側の再送ループを避けるため200を返す
  }
});

app.get("/health", (req, res) => res.status(200).send("ok"));

// このファイルを直接 `node server.js` で実行した場合のみサーバーを起動する
// （require で読み込んでテストする場合にサーバーが勝手に立ち上がらないようにするため）
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = {
  app,
  calculateScheduledDate,
  parseTransactionTextRegex,
  parseTransactionTextLLM,
  parseTransactionText,
  registerFromParsedText,
  formatRegistrationConfirmation,
  formatExpenseReply,
  formatIncomeReply,
};
