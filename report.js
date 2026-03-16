import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import OpenAI from 'openai';

// ── Firebase 初期化 ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── OpenAI 初期化 ──
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Chatwork 設定 ──
const CHATWORK_TOKEN = process.env.CHATWORK_API_TOKEN;
const CHATWORK_ROOM_ID = process.env.CHATWORK_ROOM_ID;

// ── ユーティリティ ──
const daysUntil = (s) => {
  if (!s) return null;
  const n = new Date(); n.setHours(0,0,0,0);
  const d = new Date(s); d.setHours(0,0,0,0);
  return Math.round((d - n) / 86400000);
};

const getSignal = (task, alertCfg = { redD:1, redP:70, yelD:3, yelP:50 }) => {
  if (task.status === 'done') return 'done';
  if (!task.deadline) return 'green';
  const days = daysUntil(task.deadline);
  const pct = task.progress || 0;
  if (days < 0) return 'overdue';
  if (days <= alertCfg.redD && pct < alertCfg.redP) return 'red';
  if (days <= alertCfg.yelD && pct < alertCfg.yelP) return 'yellow';
  return 'green';
};

const toAssigneeArray = (v) => !v ? [] : Array.isArray(v) ? v : [v];

async function main() {
  console.log('📊 TeamBoard 日次レポート生成開始...');

  // Firestore からデータ取得
  const [tasksSnap, usersSnap] = await Promise.all([
    db.collection('tasks').get(),
    db.collection('users').get(),
  ]);

  const members = {};
  usersSnap.forEach(doc => { members[doc.id] = doc.data(); });

  const allTasks = [];
  tasksSnap.forEach(doc => { allTasks.push({ id: doc.id, ...doc.data() }); });

  const today = new Date().toISOString().slice(0, 10);
  const activeTasks = allTasks.filter(t => t.status !== 'done');
  const doneTasks = allTasks.filter(t => t.status === 'done');

  const taskData = activeTasks.map(t => {
    const sig = getSignal(t);
    const assignees = toAssigneeArray(t.assignedTo)
      .map(uid => members[uid]?.name || '不明').join('・');
    const creator = members[t.createdBy]?.name || '不明';
    const days = t.deadline ? daysUntil(t.deadline) : null;
    const subDone = t.subtasks?.filter(s => s.done).length || 0;
    const subTotal = t.subtasks?.length || 0;
    const signalLabel = sig === 'overdue' ? '🔴期限超過'
      : sig === 'red' ? '🔴危険'
      : sig === 'yellow' ? '🟡注意'
      : '🟢順調';
    return {
      title: t.title,
      signal: signalLabel,
      assignees: assignees || '未設定',
      creator,
      deadline: t.deadline || '未設定',
      daysLeft: days === null ? '未設定'
        : days < 0 ? `${Math.abs(days)}日超過`
        : days === 0 ? '本日期限'
        : `あと${days}日`,
      progress: `${t.progress || 0}%`,
      subtasks: subTotal ? `${subDone}/${subTotal}完了` : 'なし',
    };
  });

  const redTasks = taskData.filter(t => t.signal.includes('🔴'));
  const yellowTasks = taskData.filter(t => t.signal.includes('🟡'));

  // OpenAI でレポート生成
  const prompt = `あなたはプロジェクトマネージャーアシスタントです。以下のタスクデータを分析して、日本語でプログレスレポートを作成してください。

今日の日付: ${today}

【タスクデータ】
進行中: ${activeTasks.length}件、完了: ${doneTasks.length}件
🔴危険/超過: ${redTasks.length}件、🟡注意: ${yellowTasks.length}件

${JSON.stringify(taskData, null, 2)}

【レポートの構成】
以下の4つのセクションを順番に、Chatworkに送るメッセージとして書いてください。

① 全体サマリー
 - 進行中・完了・危険・注意の件数
 - 全体的な健全度を一言でコメント

② 🔴危険・🟡注意タスク一覧
 - タスク名・担当者・期限・進捗を箇条書き
 - 危険な理由を一言添える

③ 担当者別の状況
 - 各担当者が何件抱えていて、どんな状態か

④ 今すぐやるべきこと（優先度順）
 - 「誰が・何を・いつまでに」の形式で具体的に
 - 期限超過・本日期限のものは最優先で記載

冒頭に「📊 TeamBoard 日次レポート（${today}）」というタイトルをつけてください。`;

  console.log('🤖 OpenAI でレポート生成中...');
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });

  const report = completion.choices[0].message.content.trim();
  console.log('✅ レポート生成完了');
  console.log(report);

  // Chatwork に送信
  console.log('📨 Chatwork に送信中...');
  const res = await fetch(`https://api.chatwork.com/v2/rooms/${CHATWORK_ROOM_ID}/messages`, {
    method: 'POST',
    headers: {
      'X-ChatWorkToken': CHATWORK_TOKEN,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `body=${encodeURIComponent(report)}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Chatwork送信エラー: ${err}`);
  }

  console.log('✅ Chatwork 送信完了！');
}

main().catch(err => {
  console.error('❌ エラー:', err);
  process.exit(1);
});
