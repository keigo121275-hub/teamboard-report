import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import OpenAI from 'openai';
import fs from 'fs';

// ── Firebase 初期化 ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── OpenAI 初期化 ──
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Chatwork 設定 ──
const CHATWORK_TOKEN = process.env.CHATWORK_API_TOKEN;
const CHATWORK_ROOM_ID = process.env.CHATWORK_ROOM_ID;
const PAGES_URL = 'https://keigo121275-hub.github.io/teamboard-report/';

// ── ユーティリティ ──
const daysUntil = (s) => {
  if (!s) return null;
  const n = new Date(); n.setHours(0,0,0,0);
  const d = new Date(s); d.setHours(0,0,0,0);
  return Math.round((d - n) / 86400000);
};

const getSignal = (task) => {
  const cfg = { redD:1, redP:70, yelD:3, yelP:50 };
  if (task.status === 'done') return 'done';
  if (!task.deadline) return 'green';
  const days = daysUntil(task.deadline);
  const pct = task.progress || 0;
  if (days < 0) return 'overdue';
  if (days <= cfg.redD && pct < cfg.redP) return 'red';
  if (days <= cfg.yelD && pct < cfg.yelP) return 'yellow';
  return 'green';
};

const toArray = (v) => !v ? [] : Array.isArray(v) ? v : [v];
const esc = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

async function main() {
  console.log('📊 レポート生成開始...');

  const [tasksSnap, usersSnap] = await Promise.all([
    db.collection('tasks').get(),
    db.collection('users').get(),
  ]);

  const members = {};
  usersSnap.forEach(doc => { members[doc.id] = doc.data(); });

  const allTasks = [];
  tasksSnap.forEach(doc => { allTasks.push({ id: doc.id, ...doc.data() }); });

  const today = new Date();
  const todayStr = today.toLocaleDateString('ja-JP', { year:'numeric', month:'long', day:'numeric', weekday:'long' });
  const todayISO = today.toISOString().slice(0,10);

  const activeTasks = allTasks.filter(t => t.status !== 'done');
  const doneTasks = allTasks.filter(t => t.status === 'done');

  // タスクデータ整形
  const taskData = activeTasks.map(t => {
    const sig = getSignal(t);
    const assignees = toArray(t.assignedTo).map(uid => members[uid]?.name || '未設定').join('・') || '未設定';
    const creator = members[t.createdBy]?.name || '不明';
    const days = t.deadline ? daysUntil(t.deadline) : null;
    const subDone = t.subtasks?.filter(s => s.done).length || 0;
    const subTotal = t.subtasks?.length || 0;
    return { ...t, sig, assignees, creator, days, subDone, subTotal };
  });

  const redTasks    = taskData.filter(t => t.sig === 'red' || t.sig === 'overdue');
  const yellowTasks = taskData.filter(t => t.sig === 'yellow');
  const greenTasks  = taskData.filter(t => t.sig === 'green');

  // 担当者別集計
  const memberStats = {};
  activeTasks.forEach(t => {
    toArray(t.assignedTo).forEach(uid => {
      if (!members[uid]) return;
      if (!memberStats[uid]) memberStats[uid] = { name: members[uid].name, red:0, yellow:0, green:0, total:0 };
      const sig = getSignal(t);
      memberStats[uid].total++;
      if (sig === 'red' || sig === 'overdue') memberStats[uid].red++;
      else if (sig === 'yellow') memberStats[uid].yellow++;
      else memberStats[uid].green++;
    });
  });

  // OpenAI でアクションアイテム生成
  console.log('🤖 AIアクションアイテム生成中...');
  const prompt = `以下のタスクデータを分析して「今すぐやるべきこと」を優先度順に5〜8件、箇条書きで日本語で書いてください。
「誰が・何を・いつまでに」の形式で具体的に。JSON等は不要で箇条書きのみ返してください。

今日: ${todayISO}
進行中: ${activeTasks.length}件（🔴${redTasks.length}件 🟡${yellowTasks.length}件 🟢${greenTasks.length}件）
完了: ${doneTasks.length}件

${JSON.stringify(taskData.map(t => ({
  title: t.title,
  signal: t.sig,
  assignees: t.assignees,
  deadline: t.deadline || '未設定',
  daysLeft: t.days === null ? '未設定' : t.days < 0 ? `${Math.abs(t.days)}日超過` : t.days === 0 ? '本日期限' : `あと${t.days}日`,
  progress: `${t.progress||0}%`,
})), null, 2)}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });
  const actionItems = completion.choices[0].message.content.trim()
    .split('\n').filter(l => l.trim())
    .map(l => l.replace(/^[-・•]\s*/, '').trim());

  // ── HTMLカード生成 ──
  const sigLabel = { red:'🔴 危険', overdue:'🔴 期限超過', yellow:'🟡 注意', green:'🟢 順調', done:'✅ 完了' };
  const sigClass = { red:'red', overdue:'red', yellow:'yellow', green:'green', done:'done' };

  const taskCards = taskData.map(t => {
    const daysLabel = t.days === null ? '未設定'
      : t.days < 0 ? `${Math.abs(t.days)}日超過`
      : t.days === 0 ? '本日期限'
      : `あと${t.days}日`;
    const pct = t.progress || 0;
    const subsHtml = t.subTotal
      ? `<div class="sub-info">${t.subDone}/${t.subTotal} サブタスク完了</div>` : '';
    return `
    <div class="task-card ${sigClass[t.sig]}">
      <div class="task-sig">${sigLabel[t.sig]}</div>
      <div class="task-title">${esc(t.title)}</div>
      <div class="task-meta">
        <span>👤 ${esc(t.assignees)}</span>
        <span>📅 ${esc(t.deadline||'未設定')} (${daysLabel})</span>
      </div>
      <div class="prog-row">
        <div class="prog-bar"><div class="prog-fill" style="width:${pct}%;background:${t.sig==='red'||t.sig==='overdue'?'#ff5252':t.sig==='yellow'?'#ffcc00':'#22c55e'}"></div></div>
        <span class="prog-pct">${pct}%</span>
      </div>
      ${subsHtml}
    </div>`;
  }).join('');

  const memberCards = Object.values(memberStats).map(m => `
    <div class="member-card">
      <div class="member-name">${esc(m.name)}</div>
      <div class="member-stats">
        ${m.red ? `<span class="badge red">🔴 ${m.red}</span>` : ''}
        ${m.yellow ? `<span class="badge yellow">🟡 ${m.yellow}</span>` : ''}
        ${m.green ? `<span class="badge green">🟢 ${m.green}</span>` : ''}
        <span class="badge gray">計 ${m.total}件</span>
      </div>
    </div>`).join('');

  const actionHtml = actionItems.map(a => `<li>${esc(a)}</li>`).join('');

  // ── HTML生成 ──
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeamBoard レポート ${todayISO}</title>
<style>
  :root { --bg:#0d0f1a; --surface:#161929; --surface2:#1e2235; --border:#2e3455; --text:#e8eaf6; --muted:#7b84b8; --accent:#6c7bff; --red:#ff5252; --yellow:#ffcc00; --green:#22c55e; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:'Segoe UI','Hiragino Sans','Noto Sans JP',sans-serif; padding:20px; min-height:100vh; }
  .container { max-width:900px; margin:0 auto; }
  h1 { font-size:1.4rem; font-weight:800; margin-bottom:4px; }
  .date { color:var(--muted); font-size:.85rem; margin-bottom:24px; }
  .summary-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; margin-bottom:28px; }
  .summary-card { background:var(--surface); border-radius:12px; padding:16px; text-align:center; border:1px solid var(--border); }
  .summary-num { font-size:2rem; font-weight:800; }
  .summary-label { font-size:.75rem; color:var(--muted); margin-top:4px; }
  .red-num { color:var(--red); } .yellow-num { color:var(--yellow); } .green-num { color:var(--green); } .accent-num { color:var(--accent); }
  h2 { font-size:1rem; font-weight:700; margin-bottom:14px; padding-bottom:6px; border-bottom:1px solid var(--border); }
  section { margin-bottom:32px; }
  .task-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:12px; }
  .task-card { background:var(--surface); border-radius:12px; padding:16px; border:1px solid var(--border); border-left:3px solid var(--border); }
  .task-card.red { border-left-color:var(--red); } .task-card.yellow { border-left-color:var(--yellow); } .task-card.green { border-left-color:var(--green); }
  .task-sig { font-size:.72rem; font-weight:700; margin-bottom:6px; }
  .task-title { font-size:.92rem; font-weight:700; margin-bottom:8px; line-height:1.4; }
  .task-meta { font-size:.75rem; color:var(--muted); display:flex; flex-direction:column; gap:3px; margin-bottom:10px; }
  .prog-row { display:flex; align-items:center; gap:8px; }
  .prog-bar { flex:1; height:5px; background:var(--surface2); border-radius:99px; overflow:hidden; }
  .prog-fill { height:100%; border-radius:99px; transition:width .3s; }
  .prog-pct { font-size:.75rem; font-weight:700; min-width:32px; text-align:right; }
  .sub-info { font-size:.72rem; color:var(--muted); margin-top:6px; }
  .members-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }
  .member-card { background:var(--surface); border-radius:10px; padding:14px; border:1px solid var(--border); }
  .member-name { font-weight:700; font-size:.9rem; margin-bottom:8px; }
  .member-stats { display:flex; flex-wrap:wrap; gap:5px; }
  .badge { font-size:.72rem; padding:2px 8px; border-radius:99px; font-weight:600; }
  .badge.red { background:rgba(255,82,82,.15); color:var(--red); }
  .badge.yellow { background:rgba(255,204,0,.15); color:var(--yellow); }
  .badge.green { background:rgba(34,197,94,.15); color:var(--green); }
  .badge.gray { background:var(--surface2); color:var(--muted); }
  .action-list { list-style:none; display:flex; flex-direction:column; gap:10px; }
  .action-list li { background:var(--surface); border-radius:8px; padding:12px 16px; border-left:3px solid var(--accent); font-size:.88rem; line-height:1.6; }
  .footer { text-align:center; color:var(--muted); font-size:.75rem; margin-top:40px; padding-top:20px; border-top:1px solid var(--border); }
</style>
</head>
<body>
<div class="container">
  <h1>📊 TeamBoard 日次レポート</h1>
  <div class="date">${todayStr}</div>

  <div class="summary-grid">
    <div class="summary-card"><div class="summary-num accent-num">${activeTasks.length}</div><div class="summary-label">進行中</div></div>
    <div class="summary-card"><div class="summary-num red-num">${redTasks.length}</div><div class="summary-label">🔴 危険・超過</div></div>
    <div class="summary-card"><div class="summary-num yellow-num">${yellowTasks.length}</div><div class="summary-label">🟡 注意</div></div>
    <div class="summary-card"><div class="summary-num green-num">${greenTasks.length}</div><div class="summary-label">🟢 順調</div></div>
    <div class="summary-card"><div class="summary-num" style="color:var(--muted)">${doneTasks.length}</div><div class="summary-label">✅ 完了</div></div>
  </div>

  ${redTasks.length || yellowTasks.length ? `
  <section>
    <h2>🔴🟡 要注意タスク</h2>
    <div class="task-grid">${[...redTasks,...yellowTasks].map(t => taskCards.split('</div>').find(c => c.includes(esc(t.title))) + '</div>').join('')}</div>
  </section>` : ''}

  <section>
    <h2>📋 全タスク一覧</h2>
    <div class="task-grid">${taskCards}</div>
  </section>

  <section>
    <h2>👥 担当者別状況</h2>
    <div class="members-grid">${memberCards}</div>
  </section>

  <section>
    <h2>⚡ 今すぐやるべきこと</h2>
    <ul class="action-list">${actionHtml}</ul>
  </section>

  <div class="footer">TeamBoard 自動レポート・生成日時: ${new Date().toLocaleString('ja-JP')}</div>
</div>
</body>
</html>`;

  fs.writeFileSync('docs/index.html', html);
  console.log('✅ HTMLレポート生成完了');

  // Chatwork に URL を送信
  const message = `[info][title]📊 TeamBoard 日次レポート（${todayISO}）[/title]本日のタスク進捗レポートが更新されました。

🔴 危険・超過: ${redTasks.length}件
🟡 注意: ${yellowTasks.length}件
🟢 順調: ${greenTasks.length}件
✅ 完了: ${doneTasks.length}件

▼ 詳細レポートはこちら
${PAGES_URL}[/info]`;

  const res = await fetch(`https://api.chatwork.com/v2/rooms/${CHATWORK_ROOM_ID}/messages`, {
    method: 'POST',
    headers: { 'X-ChatWorkToken': CHATWORK_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `body=${encodeURIComponent(message)}`,
  });

  if (!res.ok) { const err = await res.text(); throw new Error(`Chatwork送信エラー: ${err}`); }
  console.log('✅ Chatwork 送信完了！');
}

main().catch(err => { console.error('❌ エラー:', err); process.exit(1); });
