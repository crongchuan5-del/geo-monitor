// 千聊 GEO 监控系统 — 云端部署版 (纯 PostgreSQL)
// Windows + Linux 通用
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

// ========== 数据库连接 ==========
const connStr = process.env.DATABASE_URL;
if (!connStr) { console.error('❌ DATABASE_URL 未设置'); process.exit(1); }

const pool = new Pool({
  connectionString: connStr,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

async function q(sql, params = []) {
  const r = await pool.query(sql, params);
  return r;
}

function safeJSON(raw, fallback) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ========== Express 配置 ==========
const APP_PASSWORD = process.env.APP_PASSWORD;
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 密码保护中间件
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/favicon.ico' || req.path === '/login') return next();
    const pwd = (req.headers.cookie || '').match(/app_password=([^;]+)/)?.[1] || req.query.auth;
    if (pwd === APP_PASSWORD) return next();
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  });
}
app.use(express.static(path.join(__dirname, '..', 'public')));

// ========== 登录 ==========
app.post('/login', (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    res.setHeader('Set-Cookie', 'app_password=' + req.body.password + '; Path=/; HttpOnly');
    res.json({ success: true });
  } else { res.status(401).json({ error: '密码错误' }); }
});

// ========== API 路由 ==========

// GET /api/runs
app.get('/api/runs', async (_req, res) => {
  const runs = (await q("SELECT run_id, run_name, status, created_at FROM monitoring_runs ORDER BY created_at DESC")).rows;
  res.json(runs);
});

// GET /api/runs/:runId
app.get('/api/runs/:runId', async (req, res) => {
  const run = (await q("SELECT * FROM monitoring_runs WHERE run_id = $1", [req.params.runId])).rows[0];
  if (!run) return res.status(404).json({ error: '任务不存在' });
  res.json(run);
});

// GET /api/runs/:runId/progress
app.get('/api/runs/:runId/progress', async (req, res) => {
  const rid = req.params.runId;
  const platforms = (await q("SELECT platform_id, display_name FROM platforms")).rows;
  const result = [];
  for (const p of platforms) {
    const total = (await q("SELECT COUNT(*) as cnt FROM run_items WHERE run_id = $1 AND platform_id = $2", [rid, p.platform_id])).rows[0].cnt;
    const completed = (await q("SELECT COUNT(*) as cnt FROM run_items WHERE run_id = $1 AND platform_id = $2 AND input_status = 'completed'", [rid, p.platform_id])).rows[0].cnt;
    result.push({ platform_id: p.platform_id, display_name: p.display_name, total, completed });
  }
  const allTotal = result.reduce((s, p) => s + p.total, 0);
  const allCompleted = result.reduce((s, p) => s + p.completed, 0);
  res.json({ platforms: result, total: allTotal, completed: allCompleted });
});

// GET /api/runs/:runId/pending
app.get('/api/runs/:runId/pending', async (req, res) => {
  const rid = req.params.runId;
  const plat = req.query.platform;
  let sql = `SELECT ri.run_item_id, ri.question_id, ri.platform_id, ri.input_status,
      q.question_text, q.intent_type, q.priority,
      p.display_name as platform_name
    FROM run_items ri
    JOIN questions q ON ri.question_id = q.question_id
    JOIN platforms p ON ri.platform_id = p.platform_id
    WHERE ri.run_id = $1 AND ri.input_status = 'pending'`;
  const params = [rid];
  if (plat) { sql += ' AND ri.platform_id = $2'; params.push(plat); }
  sql += ' ORDER BY p.platform_id, q.priority DESC, q.intent_type';
  const items = (await q(sql, params)).rows;
  res.json(items);
});

// GET /api/runs/:runId/answered
app.get('/api/runs/:runId/answered', async (req, res) => {
  const items = (await q(`SELECT ri.run_item_id, ri.question_id, ri.platform_id,
      q.question_text, p.display_name as platform_name,
      ar.answer_record_id, ar.answer_text, ar.collected_at,
      LENGTH(ar.answer_text) as answer_length
    FROM run_items ri
    JOIN questions q ON ri.question_id = q.question_id
    JOIN platforms p ON ri.platform_id = p.platform_id
    JOIN answer_records ar ON ri.answer_record_id = ar.answer_record_id
    WHERE ri.run_id = $1 AND ri.input_status = 'completed'
    ORDER BY p.platform_id, ri.updated_at DESC`, [req.params.runId])).rows;
  res.json(items);
});

// GET /api/run-items/:runItemId
app.get('/api/run-items/:runItemId', async (req, res) => {
  const item = (await q(`SELECT ri.*, q.question_text, q.intent_type, q.priority,
      p.display_name as platform_name,
      ar.answer_text, ar.answer_record_id, ar.collected_at
    FROM run_items ri
    JOIN questions q ON ri.question_id = q.question_id
    JOIN platforms p ON ri.platform_id = p.platform_id
    LEFT JOIN answer_records ar ON ri.answer_record_id = ar.answer_record_id
    WHERE ri.run_item_id = $1`, [req.params.runItemId])).rows[0];
  if (!item) return res.status(404).json({ error: '记录不存在' });
  res.json(item);
});

// POST /api/run-items/:runItemId/answer
app.post('/api/run-items/:runItemId/answer', async (req, res) => {
  const { runItemId } = req.params;
  const { answer_text } = req.body;
  if (!answer_text || !answer_text.trim()) return res.status(400).json({ error: '回答不能为空' });

  const item = (await q("SELECT * FROM run_items WHERE run_item_id = $1", [runItemId])).rows[0];
  if (!item) return res.status(404).json({ error: '不存在' });
  if (item.input_status === 'completed') return res.status(400).json({ error: '已录入' });

  const ts = now();
  const aid = uuidv4();
  const qt = (await q("SELECT question_text FROM questions WHERE question_id = $1", [item.question_id])).rows[0];

  await q(`INSERT INTO answer_records (answer_record_id, run_id, run_item_id, question_id, platform_id,
    collection_method, prompt_text, answer_text, collected_at, created_at)
    VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$8,$9)`,
    [aid, item.run_id, runItemId, item.question_id, item.platform_id, qt?.question_text || '', answer_text, ts, ts]);

  await q("UPDATE run_items SET input_status = 'completed', answer_record_id = $1, updated_at = $2 WHERE run_item_id = $3",
    [aid, ts, runItemId]);

  res.json({ success: true, answer_record_id: aid, run_item_id: runItemId });
});

// PUT /api/answer-records/:answerRecordId
app.put('/api/answer-records/:answerRecordId', async (req, res) => {
  const ts = now();
  await q("UPDATE answer_records SET answer_text = $1, updated_at = $2 WHERE answer_record_id = $3",
    [req.body.answer_text, ts, req.params.answerRecordId]);
  const rec = (await q("SELECT run_item_id FROM answer_records WHERE answer_record_id = $1", [req.params.answerRecordId])).rows[0];
  if (rec) await q("UPDATE answer_analysis SET geo_score = -1, geo_level = 'stale' WHERE run_item_id = $1", [rec.run_item_id]);
  res.json({ success: true, modified: true, message: '已保存，请重新分析' });
});

// GET /api/runs/:runId/analysis
app.get('/api/runs/:runId/analysis', async (req, res) => {
  const rows = (await q(`SELECT aa.*, q.question_text, q.intent_type, p.display_name as platform_name
    FROM answer_analysis aa
    JOIN questions q ON aa.question_id = q.question_id
    JOIN platforms p ON aa.platform_id = p.platform_id
    WHERE aa.run_id = $1 ORDER BY aa.geo_score ASC`, [req.params.runId])).rows;
  const enriched = rows.map(a => ({
    ...a,
    _parsed: {
      competitors: safeJSON(a.competitors_mentioned, []),
      fact_errors: safeJSON(a.fact_errors, []),
      suggestions: safeJSON(a.optimization_suggestions, []),
      content_influence: safeJSON(a.content_influence, {}),
      brand_mentioned: a.brand_mentioned === 1 || a.brand_mentioned === true,
      competitor_advantage: a.competitor_advantage === 1 || a.competitor_advantage === true,
    }
  }));
  res.json(enriched);
});

// POST /api/runs/:runId/analyze — 批量分析（简化版：标记已有数据为已分析）
app.post('/api/runs/:runId/analyze', async (req, res) => {
  try {
    const runId = req.params.runId;
    // 检查任务是否存在
    const run = (await q("SELECT * FROM monitoring_runs WHERE run_id = $1", [runId])).rows[0];
    if (!run) return res.status(404).json({ error: '任务不存在' });

    // 更新状态
    await q("UPDATE monitoring_runs SET status = 'analyzing' WHERE run_id = $1", [runId]);

    // 获取所有已录入但未分析的 run_items
    const items = (await q(`SELECT ri.* FROM run_items ri
      JOIN answer_records ar ON ri.answer_record_id = ar.answer_record_id
      WHERE ri.run_id = $1 AND ri.input_status = 'completed' AND ri.analysis_status = 'not_started'
      AND ar.answer_text IS NOT NULL AND ar.answer_text != ''`, [runId])).rows;

    let analyzed = 0;
    let errors = [];

    for (const item of items) {
      try {
        const aId = uuidv4();
        const ts = now();
        await q(`INSERT INTO answer_analysis (analysis_id, answer_record_id, run_id, run_item_id, question_id, platform_id,
          brand_mentioned, brand_mention_count, brand_position,
          recommendation_level, recommendation_reason,
          competitors_mentioned, competitor_advantage, competitor_summary,
          cited_sources, content_influence,
          fact_accuracy_level, fact_errors,
          geo_score, geo_level, optimization_suggestions, cognition_coverage, analysis_json, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,0,0,'none','none','','[]',0,'','[]','{"suspected":false}','unknown','[]',50,'normal','[]','{}','{}',$7)`,
          [aId, item.answer_record_id, runId, item.run_item_id, item.question_id, item.platform_id, ts]);

        await q("UPDATE run_items SET analysis_status = 'analyzed', analysis_id = $1, updated_at = $2 WHERE run_item_id = $3",
          [aId, ts, item.run_item_id]);
        analyzed++;
      } catch (e) {
        errors.push(e.message);
      }
    }

    await q("UPDATE monitoring_runs SET status = 'completed', finished_at = $1 WHERE run_id = $2", [now(), runId]);

    res.json({
      success: true,
      totalAnswers: items.length,
      analyzed,
      failed: errors.length,
      skipped: 0,
      errors,
      runId,
      note: '简化分析模式：仅标记为已分析。完整 AI 分析需额外部署 LLM 模块。'
    });
  } catch (e) {
    await q("UPDATE monitoring_runs SET status = 'failed' WHERE run_id = $1", [req.params.runId]);
    res.status(500).json({ error: e.message, success: false });
  }
});

// GET /api/runs/:runId/analyze-status
app.get('/api/runs/:runId/analyze-status', async (req, res) => {
  const run = (await q("SELECT * FROM monitoring_runs WHERE run_id = $1", [req.params.runId])).rows[0];
  if (!run) return res.status(404).json({ error: '任务不存在' });
  const total = (await q("SELECT COUNT(*) as cnt FROM run_items WHERE run_id = $1", [req.params.runId])).rows[0].cnt;
  const completed = (await q("SELECT COUNT(*) as cnt FROM answer_analysis WHERE run_id = $1 AND geo_score >= 0", [req.params.runId])).rows[0].cnt;
  const failed = (await q("SELECT COUNT(*) as cnt FROM answer_analysis WHERE run_id = $1 AND geo_score < 0 AND geo_level != 'stale'", [req.params.runId])).rows[0].cnt;
  res.json({ status: run.status, total, completed, failed });
});

// GET /api/runs/:runId/report
app.get('/api/runs/:runId/report', async (req, res) => {
  const r = (await q("SELECT * FROM reports WHERE run_id = $1 ORDER BY generated_at DESC LIMIT 1", [req.params.runId])).rows[0];
  res.json(r || null);
});

// POST /api/runs — 创建任务
app.post('/api/runs', async (req, res) => {
  try {
    const { runName, questionIds, platformIds, customQuestions } = req.body;
    if (!runName || !platformIds) return res.status(400).json({ error: '缺少必填字段' });

    const allQIds = [...(questionIds || [])];
    const ts = now();

    if (customQuestions?.length) {
      for (const cq of customQuestions) {
        if (!cq.question_text || !cq.question_text.trim()) continue;
        const qId = 'q-custom-' + uuidv4().slice(0, 8);
        await q(`INSERT INTO questions (question_id, question_text, intent_type, priority, status, created_at, updated_at)
          VALUES ($1,$2,$3,'medium','active',$4,$5)`,
          [qId, cq.question_text.trim(), cq.intent_type || 'recommend', ts, ts]);
        allQIds.push(qId);
      }
    }

    const runId = uuidv4();
    await q(`INSERT INTO monitoring_runs (run_id, run_name, run_type, status, selected_questions, selected_platforms, started_at, created_by, created_at)
      VALUES ($1,$2,'manual','pending_input',$3,$4,$5,$6,$7)`,
      [runId, runName, JSON.stringify(allQIds), JSON.stringify(platformIds), ts, '网页操作', ts]);

    let itemCount = 0;
    for (const qid of allQIds) {
      for (const pid of platformIds) {
        await q(`INSERT INTO run_items (run_item_id, run_id, question_id, platform_id, input_status, analysis_status, created_at, updated_at)
          VALUES ($1,$2,$3,$4,'pending','not_started',$5,$6)`,
          [uuidv4(), runId, qid, pid, ts, ts]);
        itemCount++;
      }
    }

    res.json({ run: { run_id: runId, run_name: runName, status: 'pending_input' }, runItemCount: itemCount, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/questions
app.get('/api/questions', async (_req, res) => {
  res.json((await q("SELECT * FROM questions ORDER BY intent_type, priority DESC")).rows);
});

// GET /api/platforms
app.get('/api/platforms', async (_req, res) => {
  res.json((await q("SELECT * FROM platforms ORDER BY display_name")).rows);
});

// GET /api/brand-facts
app.get('/api/brand-facts', async (_req, res) => {
  res.json((await q("SELECT * FROM brand_facts WHERE status = 'active' ORDER BY fact_type")).rows);
});

// GET /api/cognition-assets
app.get('/api/cognition-assets', async (_req, res) => {
  res.json((await q("SELECT * FROM brand_cognition_assets WHERE status = 'active' ORDER BY importance_level DESC")).rows);
});

// GET /api/contents
app.get('/api/contents', async (_req, res) => {
  res.json((await q("SELECT content_id, title, content_type, platform, core_claims, target_keywords, LENGTH(content_text) as body_len, enrich_status FROM content_library WHERE status = 'published' ORDER BY published_at DESC")).rows);
});

// GET /api/dashboard
app.get('/api/dashboard', async (_req, res) => {
  const [tasks, analyses, avgGeo, answers, recent] = await Promise.all([
    q("SELECT COUNT(*) as cnt FROM monitoring_runs"),
    q("SELECT COUNT(*) as cnt FROM answer_analysis"),
    q("SELECT AVG(geo_score) as avg FROM answer_analysis WHERE geo_score >= 0"),
    q("SELECT COUNT(*) as cnt FROM answer_records"),
    q("SELECT * FROM monitoring_runs ORDER BY created_at DESC LIMIT 5")
  ]);
  res.json({
    totalTasks: Number(tasks.rows[0].cnt),
    totalAnalyses: Number(analyses.rows[0].cnt),
    avgGeo: Math.round((Number(avgGeo.rows[0].avg) || 0) * 10) / 10,
    totalAnswers: Number(answers.rows[0].cnt),
    recentTasks: recent.rows
  });
});

// ===== 趋势 API =====
app.get('/api/trends/questions', async (_req, res) => {
  const rows = (await q("SELECT DISTINCT q.question_id, q.question_text FROM questions q JOIN answer_analysis aa ON q.question_id = aa.question_id ORDER BY q.question_text")).rows;
  res.json(rows);
});

app.get('/api/trends/platforms', async (_req, res) => {
  const rows = (await q("SELECT DISTINCT p.platform_id, p.display_name FROM platforms p JOIN answer_analysis aa ON p.platform_id = aa.platform_id ORDER BY p.display_name")).rows;
  res.json(rows);
});

app.get('/api/trends/question/:qid', async (req, res) => {
  const snaps = (await q("SELECT * FROM question_trend_snapshots WHERE question_id = $1 ORDER BY collected_at", [req.params.qid])).rows;
  const byPlatform = {};
  snaps.forEach(s => { if (!byPlatform[s.platform_id]) byPlatform[s.platform_id] = []; byPlatform[s.platform_id].push(s); });
  res.json({ question_id: req.params.qid, snapshots: snaps, by_platform: byPlatform });
});

app.get('/api/trends/platform/:pid', async (req, res) => {
  const snaps = (await q("SELECT * FROM question_trend_snapshots WHERE platform_id = $1 ORDER BY collected_at", [req.params.pid])).rows;
  const byQuestion = {};
  snaps.forEach(s => { if (!byQuestion[s.question_id]) byQuestion[s.question_id] = []; byQuestion[s.question_id].push(s); });
  res.json({ platform_id: req.params.pid, snapshots: snaps, by_question: byQuestion });
});

// ===== 页面路由 =====
app.get('/trends', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'trends.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'input.html')));
app.get('/input', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'input.html')));

// ===== 启动 =====
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ 千聊 GEO 监控系统已启动`);
  console.log(`   本地: http://localhost:${PORT}/dashboard`);
  console.log(`   数据库: Supabase PostgreSQL`);
  console.log(`   密码保护: ${APP_PASSWORD ? '已启用' : '未启用'}\n`);
});
