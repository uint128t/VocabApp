import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  applyEdits,
  parse,
  planDeleteEntry,
  planInsertEntry,
  planSetEntry,
  planSetSenseChecked,
  planSetSenses,
  planSetSensesChecked,
} from './vocab.js';
import { createStore, createStateFile } from './store.js';
import { createExam } from './exam.js';
import { createAi, normalizeDifficulty, defaultPrompts, CONTRACTS } from './ai.js';
import { createSettings, DEFAULTS, modelEndpoints } from './settings.js';
import { createCefr } from './cefr.js';
import { loadConfig } from './config.js';

const PUBLIC = path.join(import.meta.dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const BODY_LIMIT = 1_000_000;
const AI_STATUS = { aiConfig: 503, aiHttp: 502, aiNetwork: 502, aiJson: 502, aiShape: 502 };
const PLAN_STATUS = {
  wordExists: 409,
  duplicateWord: 409,
  duplicateChapter: 409,
  parseErrors: 409,
  wordNotFound: 404,
};
const JOB_STATUS = { badBatchSize: 400, badWords: 400, jobRunning: 409, jobNotFound: 404 };
const EXAM_STATUS = {
  examNotRunning: 409,
  examRunning: 409,
  examOutOfOrder: 409,
  examFinished: 409,
  examSettled: 409,
  examLocked: 409,
  examPaused: 409,
  examNotPaused: 409,
  emptyScope: 400,
  badAnswer: 400,
  badLang: 400,
  wordNotFound: 404,
};

function httpError(status, code, message, details) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (details) e.details = details;
  return e;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message, details) {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}

function project(e) {
  return {
    chapter: e.chapter,
    word: e.word,
    definition: e.definition,
    chinese: e.chinese ?? null,
    checked: e.checked,
    difficulty: e.difficulty,
    example: e.example,
    senses: (e.senses || []).map((s) => ({
      level: s.level,
      definition: s.definition ?? null,
      chinese: s.chinese ?? null,
      example: s.example,
      checked: s.checked,
    })),
  };
}

const senseList = (e) =>
  e.senses.length
    ? e.senses
    : [{ level: e.difficulty, definition: null, chinese: e.chinese ?? null, example: e.example, checked: e.checked }];

const senseTarget = (e, sense, i) => ({
  word: e.word,
  sense: i,
  count: senseList(e).length,
  chapter: e.chapter,
  level: sense.level,
  definition: sense.definition || e.definition,
  chinese: sense.chinese ?? e.chinese ?? null,
  example: sense.example,
  checked: sense.checked,
});

function readEntries(store) {
  const { entries, errors, stats } = parse(store.readFile());
  if (errors.length) {
    throw httpError(500, 'parseErrors', '词表解析失败，已拒绝读取', errors.slice(0, 20));
  }
  return { entries: entries.map(project), stats };
}

function readWord(body) {
  const raw = body?.word;
  if (typeof raw !== 'string') throw httpError(400, 'badWord', 'word 必须是字符串');
  if (/[\r\n]/.test(raw)) throw httpError(400, 'badWord', '词头不能包含换行');
  const word = raw.replace(/\s+/g, ' ').trim();
  if (!word || word.includes(' - ')) {
    throw httpError(400, 'badWord', '词头不能为空或含分隔符');
  }
  return word;
}

function readAnswer(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw httpError(400, 'badAnswer', `${name} 不能为空`);
  }
  return value.trim();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) tooLarge = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(httpError(413, 'tooLarge', `请求体超过 ${BODY_LIMIT} 字节`));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => reject(httpError(400, 'badJson', '请求体读取失败')));
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  let body;
  try {
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, 'badJson', '请求体不是合法 JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'badJson', '请求体必须是 JSON 对象');
  }
  return body;
}

function serveStatic(name, res) {
  let abs;
  try {
    abs = path.resolve(PUBLIC, decodeURIComponent(name));
  } catch {
    return sendError(res, 400, 'badPath', '路径无法解码');
  }
  if (!abs.startsWith(PUBLIC + path.sep)) return sendError(res, 404, 'notFound', '未找到');
  if (path.basename(abs).startsWith('.')) return sendError(res, 404, 'notFound', '未找到');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return sendError(res, 404, 'notFound', '未找到');
  res.writeHead(200, {
    'content-type': MIME[path.extname(abs)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(abs).pipe(res);
}

export function createApp({ store, config, ai, settings, exam, openFile, cefr }) {
  const openInEditor = (file) =>
    openFile
      ? openFile(file)
      : new Promise((resolve, reject) => {
          const child = spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' });
          child.on('error', reject);
          child.unref();
          resolve();
        });
  const grades = cefr || createCefr({ dataFile: config.cefrFile });
  const examRunner =
    exam ||
    (ai
      ? createExam({
          store,
          ai,
          stateFile: createStateFile({ file: path.join(config.stateDir || path.join(import.meta.dirname, '.state'), 'exam.json') }),
        })
      : null);
  const settingsStore =
    settings ||
    createSettings({
      stateFile: createStateFile({ file: config.settingsFile || path.join(import.meta.dirname, 'settings.json') }),
      keyNames: config.keyNames,
    });
  const currentSettings = () => settingsStore.get().settings;
  const modelList = () => [
    ...new Set([currentSettings().model, ...currentSettings().extraModels.map((m) => m.name)].filter(Boolean)),
  ];

  const getRoutes = {
    '/api/entries': () => ({ status: 200, body: readEntries(store) }),

    '/api/settings': () => {
      const { settings: s, error } = settingsStore.get();
      return {
        status: 200,
        body: {
          settings: s,
          settingsError: error,
          defaults: DEFAULTS,
          promptDefaults: defaultPrompts(),
          contracts: { entry: CONTRACTS.entry, judge: CONTRACTS.judge },
          models: modelList(),
          keyNames: config.keyNames ?? [],
          modelRoutes: Object.fromEntries(s.extraModels.map((m) => [m.name, { baseUrl: m.baseUrl, keyName: m.keyName }])),
          envFile: config.envFile,
          settingsFile: config.settingsFile,
          vocabFile: config.vocabFile,
          hasKey: Boolean(config.keyNames?.length),
        },
      };
    },

    '/api/backups': () => ({ status: 200, body: { files: store.listBackups() } }),

    '/api/exam': () => {
      if (!examRunner) throw httpError(503, 'aiUnavailable', '服务端未配置模型');
      const state = examRunner.status();
      return {
        status: 200,
        body: { state, current: examRunner.current(), preview: state ? examRunner.preview() : null },
      };
    },

    '/api/random': (req, url) => {
      const raw = url.searchParams.get('count') ?? '1';
      const count = Number(raw);
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        throw httpError(400, 'badCount', 'count 必须是 1 到 50 的整数');
      }
      const onlyUnchecked = ['1', 'true'].includes(url.searchParams.get('onlyUnchecked') || '');
      const rawDifficulty = url.searchParams.get('difficulty');
      const difficulty = rawDifficulty ? normalizeDifficulty(rawDifficulty) : null;
      if (rawDifficulty && !difficulty) throw httpError(400, 'badDifficulty', `难度必须属于 CEFR 六档：${rawDifficulty}`);

      const pool = readEntries(store).entries.flatMap((e) =>
        senseList(e).map((sense, i) => senseTarget(e, sense, i)),
      );
      const filtered = pool.filter((t) => {
        if (difficulty && t.level !== difficulty) return false;
        if (onlyUnchecked && t.checked) return false;
        return true;
      });
      for (let i = filtered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
      }
      return { status: 200, body: { targets: filtered.slice(0, count) } };
    },

  };

  async function examCall(req, fn) {
    if (!examRunner) throw httpError(503, 'aiUnavailable', '服务端未配置模型');
    const body = await readJson(req);
    try {
      return { status: 200, body: await fn(body) };
    } catch (e) {
      if (EXAM_STATUS[e.code]) throw httpError(EXAM_STATUS[e.code], e.code, e.message);
      if (AI_STATUS[e.code]) throw httpError(AI_STATUS[e.code], e.code, e.message);
      throw httpError(500, 'examInternal', e.message);
    }
  }

  const postRoutes = {
    '/api/draft': async (req) => {
      if (!ai) throw httpError(503, 'aiUnavailable', '服务端未配置模型');
      const body = await readJson(req);
      const word = readWord(body);
      try {
        const d = await ai.sensesEntry(
          { word, current: null, referenceLevels: grades.describe(word), withChinese: body.withChinese === true },
          { model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : currentSettings().model },
        );
        return {
          status: 200,
          body: {
            word,
            senses: d.senses,
            note: d.note,
            referenceLevels: grades.describe(word),
          },
        };
      } catch (e) {
        throw httpError(AI_STATUS[e.code] || 502, e.code || 'aiUnknown', e.message);
      }
    },

    '/api/example': async (req) => {
      if (!ai) throw httpError(503, 'aiUnavailable', '服务端未配置模型');
      const body = await readJson(req);
      const word = readWord(body);
      const definition = typeof body.definition === 'string' ? body.definition.trim() : '';
      try {
        const example = await ai.exampleEntry(word, definition, {
          model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : currentSettings().model,
        });
        return { status: 200, body: example };
      } catch (e) {
        throw httpError(AI_STATUS[e.code] || 502, e.code || 'aiUnknown', e.message);
      }
    },

    '/api/open-config': async (req) => {
      const body = await readJson(req);
      const target = body.which === 'env' ? config.envFile : body.which === 'settings' ? config.settingsFile : null;
      if (!target) throw httpError(400, 'badTarget', "which 只能是 'env' 或 'settings'");
      if (!fs.existsSync(target)) throw httpError(404, 'fileNotFound', `文件不存在：${target}`);
      await openInEditor(target);
      return { status: 200, body: { ok: true, file: target } };
    },

    '/api/test-model': async (req) => {
      if (!ai) throw httpError(503, 'aiUnavailable', '服务端未配置模型');
      const body = await readJson(req);
      const keyName = typeof body.keyName === 'string' ? body.keyName.trim() : '';
      if (!keyName) throw httpError(400, 'badKeyName', '缺少密钥名');
      const apiKey = config.keys?.[keyName] || '';
      if (!apiKey) throw httpError(400, 'badKeyName', `.env 里没有名为 ${keyName} 的密钥（用 VOCAB_KEY_${keyName}=… 添加）`);
      const target = {
        baseUrl: typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : undefined,
        apiKey,
        model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
        extra: body.extra && typeof body.extra === 'object' && !Array.isArray(body.extra) ? body.extra : undefined,
      };
      try {
        return { status: 200, body: await ai.testTarget(target) };
      } catch (e) {
        if (e.code === 'aiConfig') throw httpError(400, e.code, e.message);
        throw httpError(AI_STATUS[e.code] || 502, e.code || 'aiUnknown', e.message, e.body);
      }
    },

    '/api/commit-add': async (req) => {
      const body = await readJson(req);
      const word = readWord(body);
      return store.enqueue(async () => {
        const text = store.readFile();
        const plan = planInsertEntry(text, {
          word,
          definition: body.definition,
          difficulty: body.difficulty,
          example: body.example,
          chinese: body.chinese || undefined,
          checked: body.checked,
          senses: Array.isArray(body.senses) ? body.senses : undefined,
        });
        if (plan.error) {
          throw httpError(
            PLAN_STATUS[plan.error.code] || 400,
            plan.error.code,
            plan.error.message,
            plan.error.details,
          );
        }
        const next = applyEdits(text, [plan]);
        const { backup } = store.writeWithBackup(next);
        const written = parse(next).entries.find((e) => e.word === word);
        return { status: 200, body: { entry: project(written), backup } };
      });
    },

    '/api/judge': async (req) => {
      if (!ai) throw httpError(503, 'aiUnavailable', '服务端未配置模型');
      const body = await readJson(req);
      const word = readWord(body);
      const userDefinition = readAnswer(body.userDefinition, 'userDefinition');
      const userExample = typeof body.userExample === 'string' ? body.userExample.trim() : '';

      const found = readEntries(store).entries.filter((e) => e.word === word);
      if (!found.length) throw httpError(404, 'wordNotFound', `未找到词头：${word}`);
      if (found.length > 1) throw httpError(409, 'duplicateWord', `词头重复：${word}`);
      const current = found[0];
      const index = Number.isInteger(body.sense) ? body.sense : 0;
      const sense = senseList(current)[index];
      if (!sense) throw httpError(400, 'badSense', `义项序号超出范围：${index}`);

      let verdict;
      try {
        verdict = await ai.judgeEntry(
          {
            word,
            userDefinition,
            userExample,
            storedDefinition: sense.definition || current.definition,
            targetExample: sense.example || '',
          },
          { lang: body.lang === 'en' || body.lang === 'zh' ? body.lang : currentSettings().lang },
        );
      } catch (e) {
        throw httpError(AI_STATUS[e.code] || 502, e.code || 'aiUnknown', e.message);
      }
      return {
        status: 200,
        body: { ...verdict, sense: index, checked: sense.checked, backup: null },
      };
    },

    '/api/set-checked': async (req) => {
      const body = await readJson(req);
      const word = readWord(body);
      if (typeof body.checked !== 'boolean') throw httpError(400, 'badChecked', 'checked 必须是布尔值');
      const index = body.sense === undefined ? 0 : body.sense;
      if (!Number.isInteger(index) || index < 0) throw httpError(400, 'badSense', 'sense 必须是非负整数');
      return store.enqueue(async () => {
        const text = store.readFile();
        const plan = planSetSensesChecked(text, word, [{ index, checked: body.checked }]);
        if (plan.error) {
          throw httpError(PLAN_STATUS[plan.error.code] || 400, plan.error.code, plan.error.message, plan.error.details);
        }
        if (plan.noop) return { status: 200, body: { ok: true, word, sense: index, checked: body.checked, backup: null } };
        const { backup } = store.writeWithBackup(applyEdits(text, plan.edits));
        return { status: 200, body: { ok: true, word, sense: index, checked: body.checked, backup } };
      });
    },

    '/api/commit-edit': async (req) => {
      const body = await readJson(req);
      const word = readWord(body);
      return store.enqueue(async () => {
        const text = store.readFile();
        const plan = planSetEntry(text, word, {
          definition: body.definition,
          difficulty: body.difficulty,
          example: body.example,
          chinese: body.chinese,
          checked: body.checked,
          senses: Array.isArray(body.senses) ? body.senses : undefined,
        });
        if (plan.error) {
          throw httpError(PLAN_STATUS[plan.error.code] || 400, plan.error.code, plan.error.message, plan.error.details);
        }
        if (plan.noop) {
          const unchanged = readEntries(store).entries.find((e) => e.word === word);
          return { status: 200, body: { entry: unchanged, backup: null, noop: true } };
        }
        const next = applyEdits(text, plan.edits);
        const { backup } = store.writeWithBackup(next);
        const after = parse(next).entries.find((e) => e.word === word);
        return { status: 200, body: { entry: project(after), backup, noop: false } };
      });
    },

    '/api/commit-delete': async (req) => {
      const body = await readJson(req);
      const word = readWord(body);
      return store.enqueue(async () => {
        const text = store.readFile();
        const plan = planDeleteEntry(text, word);
        if (plan.error) {
          throw httpError(PLAN_STATUS[plan.error.code] || 400, plan.error.code, plan.error.message, plan.error.details);
        }
        const next = applyEdits(text, plan.edits);
        const { backup } = store.writeWithBackup(next);
        return { status: 200, body: { word, removed: plan.removed, stats: parse(next).stats, backup } };
      });
    },



    '/api/commit-senses': async (req) => {
      const body = await readJson(req);
      const word = readWord(body);
      const senses = Array.isArray(body.senses) ? body.senses : null;
      if (!senses) throw httpError(400, 'badSenses', 'senses 必须是数组');
      return store.enqueue(async () => {
        const text = store.readFile();
        const plan = planSetSenses(text, word, senses);
        if (plan.error) {
          throw httpError(PLAN_STATUS[plan.error.code] || 400, plan.error.code, plan.error.message, plan.error.details);
        }
        const next = applyEdits(text, plan.edits);
        const { backup } = store.writeWithBackup(next);
        const after = parse(next).entries.find((e) => e.word === word);
        return { status: 200, body: { entry: project(after), backup } };
      });
    },

    '/api/refactor': async (req) => {
      if (!ai) throw httpError(503, 'aiUnavailable', '服务端未配置模型');
      const body = await readJson(req);
      const word = readWord(body);
      const text = store.readFile();
      const entry = parse(text).entries.find((e) => e.word === word);
      if (!entry) throw httpError(404, 'wordNotFound', `未找到词头：${word}`);
      const current = {
        checked: entry.checked,
        headDefinition: entry.definition || null,
        headChinese: entry.chinese ?? null,
        senses: entry.senses.map((s) => ({
          level: s.level,
          definition: s.definition,
          chinese: s.chinese,
          example: s.example,
        })),
        rawLines: [entry.raw, ...entry.childLines],
      };
      const referenceLevels = grades.describe(word);
      let proposal;
      try {
        proposal = await ai.sensesEntry(
          { word, current, referenceLevels, withChinese: entry.senses.some((s) => s.chinese) },
          { model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : currentSettings().model },
        );
      } catch (e) {
        throw httpError(AI_STATUS[e.code] || 502, e.code || 'aiUnknown', e.message);
      }
      const senses = proposal.senses.map((s, i) => ({
        ...s,
        checked: entry.senses[i] ? entry.senses[i].checked : entry.checked,
      }));
      const checked = senses.every((s) => s.checked);
      const plan = planSetEntry(text, word, { senses, checked });
      return {
        status: 200,
        body: {
          word,
          current,
          senses,
          checked,
          note: proposal.note,
          referenceLevels,
          writeable: !plan.error,
          error: plan.error || null,
        },
      };
    },

    '/api/refactor/commit': async (req) => {
      const body = await readJson(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) throw httpError(400, 'badItems', 'items 必须是非空数组');
      return store.enqueue(() => {
        const text = store.readFile();
        const edits = [];
        const failed = [];
        let written = 0;
        for (const item of items) {
          if (!item || typeof item.word !== 'string' || !item.word.trim()) {
            throw httpError(400, 'badItems', 'items 每项需要 word');
          }
          const word = item.word.trim();
          const plan = planSetEntry(text, word, { senses: item.senses, checked: item.checked });
          if (plan.error) {
            failed.push({ word, reason: plan.error.code, message: plan.error.message });
            continue;
          }
          if (plan.noop) continue;
          edits.push(...plan.edits);
          written += 1;
        }
        const backup = edits.length ? store.writeWithBackup(applyEdits(text, edits)).backup : null;
        return { status: 200, body: { changed: written, failed, backup } };
      });
    },

    '/api/exam/start': (req) =>
      examCall(req, async (body) => {
        const state = await examRunner.start(body);
        return { state, current: examRunner.current() };
      }),

    '/api/exam/answer': (req) => examCall(req, (body) => examRunner.answer(body)),

    '/api/exam/skip': (req) => examCall(req, (body) => examRunner.skip(body.word, body.sense)),

    '/api/exam/reveal': (req) => examCall(req, (body) => examRunner.reveal(body.word, body.sense)),

    '/api/exam/lang': (req) => examCall(req, (body) => examRunner.setLang(body.lang)),

    '/api/exam/pause': (req) => examCall(req, () => examRunner.pause()),

    '/api/exam/resume': (req) =>
      examCall(req, async () => {
        const res = await examRunner.resume();
        return { ...res, state: examRunner.status(), current: examRunner.current() };
      }),

    '/api/exam/preview': (req) => examCall(req, () => examRunner.preview()),

    '/api/exam/commit': (req) => examCall(req, () => examRunner.commit()),

    '/api/exam/abort': (req) => examCall(req, () => examRunner.abort()),

    '/api/settings': async (req) => {
      const body = await readJson(req);
      const out = settingsStore.patch(body);
      if (out.error) throw httpError(400, out.error.code, out.error.message);
      return { status: 200, body: getRoutes['/api/settings']().body };
    },


  };

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return sendError(res, 400, 'badUrl', '请求路径不合法');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendError(res, 400, 'badUrl', '请求路径不合法');
    }

    if (!pathname.startsWith('/api/')) return serveStatic(pathname === '/' ? 'index.html' : pathname.slice(1), res);

    const table = req.method === 'GET' ? getRoutes : req.method === 'POST' ? postRoutes : null;
    if (!table) return sendError(res, 405, 'methodNotAllowed', `${pathname} 不支持 ${req.method}`);
    if (!table[pathname]) {
      const known = getRoutes[pathname] || postRoutes[pathname];
      return sendError(res, known ? 405 : 404, known ? 'methodNotAllowed' : 'notFound', known ? `${pathname} 只接受 POST 或 GET` : `未知接口：${pathname}`);
    }

    try {
      const { status, body } = await table[pathname](req, url);
      sendJson(res, status, body);
    } catch (e) {
      if (e.status) sendError(res, e.status, e.code, e.message, e.details);
      else sendError(res, 500, 'internal', e.message);
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const config = loadConfig();
  const store = createStore({ file: config.vocabFile, backupDir: config.backupDir, mirrorFile: config.vocabMirror });
  try {
    const { stats } = store.selfCheck();
    console.log(`词表自检通过：${stats.total} 条 · ${stats.senses.total} 条义项 · 已掌握 ${stats.checked} 词 / ${stats.senses.checked} 义项`);
  } catch (e) {
    console.error(`启动失败：${e.message}`);
    process.exit(1);
  }
  const MIRROR_NOTE = {
    linked: '词表与本目录那份是同一个文件',
    'adopted-mirror': '本目录那份更新，已写回词表并重建链接',
    'refreshed-mirror': '已用词表内容刷新本目录那份并重建链接',
  };
  const synced = store.sync();
  if (synced.action !== 'linked') {
    const note = MIRROR_NOTE[String(synced.action).replace(/-(symlink|copied)$/, '')];
    console.log(`词表链接：${synced.action}${note ? `（${note}）` : ''}`);
  }
  const settings = createSettings({ stateFile: createStateFile({ file: config.settingsFile }), keyNames: config.keyNames });
  const ai = createAi({
    getDefaultModel: () => settings.get().settings.model,
    getPrompts: () => settings.get().settings.prompts,
    getEndpoints: () => modelEndpoints({ settings: settings.get().settings, keys: config.keys }),
  });
  createApp({ store, config, ai, settings }).listen(config.port, '127.0.0.1', () => {
    const s = settings.get();
    console.log(`Vocabulary 助手已就绪：http://127.0.0.1:${config.port}`);
    console.log(`数据源：${config.vocabFile}${config.vocabFile === config.vocabMirror ? '' : `（镜像：${config.vocabMirror}）`}`);
    console.log(`生效模型：${s.settings.model || '（未设置，请在设置页选择）'}${s.error ? '（settings.json 读取出错，已用默认值）' : ''}`);
    if (!config.keyNames?.length) console.log('提示：.env 里没有任何 VOCAB_KEY_名字=… 密钥，加词与自测暂不可用');
  });
}
