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
  planSetChecked,
  planSetEntry,
  planSetSenses,
  planSetSensesChecked,
} from './vocab.js';
import { createStore, createStateFile } from './store.js';
import { createSession } from './session.js';
import { createAi, defaultPrompts, CONTRACTS } from './ai.js';
import { createSettings, DEFAULTS, modelEndpoints } from './settings.js';
import { createCefr, CEFR_LEVELS } from './cefr.js';
import { loadConfig } from './config.js';

const PUBLIC = path.join(import.meta.dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const BODY_LIMIT = 1_000_000;
// 档位复判（任务三）一轮问几次：五次取平均，票数少了平均没意义。
const LEVEL_VOTES = 5;
const AI_STATUS = { aiConfig: 503, aiHttp: 502, aiNetwork: 502, aiEmpty: 502, aiJson: 502, aiShape: 502 };
const PLAN_STATUS = {
  wordExists: 409,
  parseErrors: 409,
  wordNotFound: 404,
};
const SESSION_STATUS = {
  examNotRunning: 409,
  examRunning: 409,
  examOutOfOrder: 409,
  examFinished: 409,
  examSettled: 409,
  examLocked: 409,
  examPaused: 409,
  examNotPaused: 409,
  examOpen: 409,
  examDone: 409,
  emptyScope: 400,
  badMode: 400,
  badCount: 400,
  badAnswers: 400,
  badSense: 400,
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
  // 客户端中途断开（界面上的「终止」）之后这里还会被走到：往销毁了的 socket 上写会抛，
  // 抛在处理函数外面就是未捕获异常。连接没了就没什么可回的，直接收工。
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message, details) {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}

// 上游失败原样端上去：没配模型就是 503、上游抽风就是 502，认不出的码按 502 兜底。
// 个别路由要另判（「测试连通」把 aiConfig 当输入错误报 400），用 configStatus 覆盖，
// 并顺手带上上游响应体。
function upstreamError(e, { configStatus = AI_STATUS.aiConfig, details } = {}) {
  const status = e.code === 'aiConfig' ? configStatus : AI_STATUS[e.code] || 502;
  return httpError(status, e.code || 'aiUnknown', e.message, details);
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

// 词表路径当前的状况：没填 / 不是文件 / 好着。设置页据此提示。
function vocabFileProblem(p) {
  if (!p) return '还没设置词表路径';
  try {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return null;
    return `找不到这个文件：${p}`;
  } catch (e) {
    return `这个路径打不开：${e.message}`;
  }
}

// 一批条目一次写盘、一份备份：重构与档位复判共用同一条写盘路径。
function commitEntries(store, items) {  return store.enqueue(() => {
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
}

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
  // 方括号会把词头写成 `- [x] atom`——那是带框主行的形状，整张表从此解析不出来。
  if (/[[\]]/.test(word)) throw httpError(400, 'badWord', '词头不能包含方括号');
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

export function createApp({ store, config, ai, settings, session, cefr }) {
  const openInEditor = (file) =>
    new Promise((resolve, reject) => {
      const child = spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' });
      child.on('error', reject);
      child.unref();
      resolve();
    });
  const grades = cefr || createCefr({ dataFile: config.cefrFile });
  const sessionRunner =
    session ||
    (ai
      ? createSession({
          store,
          ai,
          stateFile: createStateFile({ file: path.join(config.stateDir || path.join(import.meta.dirname, '.state'), 'session.json') }),
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
          vocabFile: s.vocabFile ?? null,
          vocabFileError: vocabFileProblem(s.vocabFile),
          hasKey: Boolean(config.keyNames?.length),
        },
      };
    },

    '/api/backups': () => ({ status: 200, body: { files: store.listBackups() } }),

    '/api/session': () => {
      if (!sessionRunner) throw httpError(503, 'aiUnavailable', '服务端未配置模型');
      const state = sessionRunner.status();
      return {
        status: 200,
        body: {
          state,
          current: sessionRunner.current(),
          study: sessionRunner.study(),
          preview: state ? sessionRunner.preview() : null,
        },
      };
    },

  };

  async function sessionCall(req, fn) {
    if (!sessionRunner) throw httpError(503, 'aiUnavailable', '服务端未配置模型');
    const body = await readJson(req);
    try {
      return { status: 200, body: await fn(body) };
    } catch (e) {
      if (SESSION_STATUS[e.code]) throw httpError(SESSION_STATUS[e.code], e.code, e.message);
      if (AI_STATUS[e.code]) throw httpError(AI_STATUS[e.code], e.code, e.message);
      throw httpError(500, 'sessionInternal', e.message);
    }
  }

  // 五次并行定档：串行要等五个来回，并行只等一个；问不出来（网络、坏 JSON、非法档位）的
  // 那些票记空票，不因为一张票废掉整条义项。参考档位一并交给模型，采信与否由它自己判断。
  async function voteLevel({ word, definition, example, referenceLevels, model }, signal) {
    const settled = await Promise.allSettled(
      Array.from({ length: LEVEL_VOTES }, () =>
        ai.levelVote({ word, definition, example, referenceLevels }, { model, signal }),
      ),
    );
    const votes = settled.map((r) => (r.status === 'fulfilled' ? r.value.level : null));
    // 只认 CEFR 六档的票：网络失败、坏 JSON、模型报了别的档位都算空票，不进平均。
    const valid = votes.filter((v) => CEFR_LEVELS.includes(v));
    if (!valid.length) {
      // 一张票都没成：把真实的失败原因端上去（没配模型就是 503、上游抽风就是 502），
      // 别让它埋在一句「没定出档位」后面。
      const first = settled.find((r) => r.status === 'rejected');
      throw httpError(
        AI_STATUS[first?.reason?.code] || 502,
        first?.reason?.code || 'noLevelVotes',
        first?.reason?.message || `五次都没给出合法档位：${JSON.stringify(votes)}`,
      );
    }
    const numbers = valid.map((v) => CEFR_LEVELS.indexOf(v));
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    // 平均后再四舍五入回档；.5 向上（偏向更难的那一档），并列时有记录可查。
    const level = CEFR_LEVELS[Math.min(CEFR_LEVELS.length - 1, Math.max(0, Math.round(mean)))];
    return {
      level,
      votes,
      valid: valid.length,
      agree: votes.filter((v) => v === level).length,
      mean: Number(mean.toFixed(2)),
    };
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
            trace: grades.trace(word),
          },
        };
      } catch (e) {
        throw upstreamError(e);
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
        throw upstreamError(e);
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
        throw upstreamError(e, { configStatus: 400, details: e.body });
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
        throw upstreamError(e);
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

    '/api/commit-mastery': async (req) => {
      const body = await readJson(req);
      const words = body.words;
      if (!Array.isArray(words) || !words.length) throw httpError(400, 'badWords', 'words 必须是非空数组');
      if (typeof body.checked !== 'boolean') throw httpError(400, 'badChecked', 'checked 必须是布尔值');
      const targets = words.map((raw) => readWord({ word: raw }));
      return store.enqueue(() => {
        const text = store.readFile();
        const edits = [];
        const skipped = [];
        let changed = 0;
        for (const word of targets) {
          const plan = planSetChecked(text, word, body.checked);
          if (plan.error) {
            skipped.push({ word, reason: plan.error.code, message: plan.error.message });
            continue;
          }
          if (plan.noop) continue;
          edits.push(...plan.edits);
          changed += 1;
        }
        const backup = edits.length ? store.writeWithBackup(applyEdits(text, edits)).backup : null;
        return { status: 200, body: { changed, skipped, backup } };
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

    '/api/refactor': async (req, _url, signal) => {
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
          { model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : currentSettings().model, signal },
        );
      } catch (e) {
        throw upstreamError(e);
      }
      const senses = proposal.senses.map((s, i) => ({
        ...s,
        checked: entry.senses[i] ? entry.senses[i].checked : entry.checked,
      }));
      const checked = senses.every((s) => s.checked);
      // 只探「结构上能不能写」：档位这会儿还是 null（等投票），拿它去探会一律报
      // badDifficulty，界面上就成了「无法写盘：难度必须属于 CEFR 六档：null」。档位一律是
      // 合法六档之一，所以借用该条现有的档位（没有就用第一条的）来探，结论不受影响。
      const probe = senses.map((s, i) => ({
        ...s,
        level: s.level || (entry.senses[i] && entry.senses[i].level) || entry.difficulty || 'B1',
      }));
      const plan = planSetEntry(text, word, { senses: probe, checked });
      return {
        status: 200,
        body: {
          word,
          current,
          senses,
          checked,
          note: proposal.note,
          referenceLevels,
          trace: grades.trace(word),
          writeable: !plan.error,
          error: plan.error || null,
        },
      };
    },

    '/api/refactor/commit': async (req) => {
      const body = await readJson(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) throw httpError(400, 'badItems', 'items 必须是非空数组');
      return commitEntries(store, items);
    },

    // 任务三：档位复判。plan 只出清单不调模型；vote 给一条义项跑五次取平均；commit 一次写盘。
    '/api/level/plan': async (req) => {
      const body = await readJson(req);
      const words = Array.isArray(body.words) ? body.words : [];
      if (!words.length) throw httpError(400, 'badWords', 'words 必须是非空数组');
      const entries = readEntries(store).entries;
      const items = [];
      const missing = [];
      for (const raw of words) {
        const word = readWord({ word: raw });
        const entry = entries.find((e) => e.word === word);
        if (!entry) {
          missing.push(word);
          continue;
        }
        const referenceLevels = grades.describe(word);
        // 档位依据没有落进 markdown，只有生成那一刻才知道。能复判的近似判据是「这个词
        // 在参考词表里有没有东西可依」：levels 与 related 都空，当初那条档位就是 AI 自判的。
        items.push({
          word,
          chapter: entry.chapter,
          checked: entry.checked,
          referenceLevels,
          trace: grades.trace(word),
          covered: referenceLevels.levels.length + referenceLevels.related.length,
          senses: entry.senses.map((s, i) => ({
            sense: i,
            level: s.level,
            definition: s.definition,
            chinese: s.chinese ?? null,
            example: s.example,
            checked: Boolean(s.checked),
          })),
        });
      }
      return { status: 200, body: { items, missing } };
    },

    // 定档：给一条义项跑五次取平均（D28 起是唯一的定档路径，D30 起也是草稿与重构的定档路径）。
    // 两种目标：词表里已有的按 sense 序号取；草稿卡里刚生成、还没写进词表的直接给 definition。
    '/api/level/vote': async (req, _url, signal) => {
      if (!ai) throw httpError(503, 'aiUnavailable', '服务端未配置模型');
      const body = await readJson(req);
      const word = readWord(body);
      const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : currentSettings().model;
      const referenceLevels = grades.describe(word);
      const trace = grades.trace(word);
      const definition = typeof body.definition === 'string' ? body.definition.trim() : '';
      if (definition) {
        const out = await voteLevel({
          word,
          definition,
          example: typeof body.example === 'string' ? body.example.trim() : '',
          referenceLevels,
          model,
        }, signal);
        return { status: 200, body: { word, sense: null, from: null, referenceLevels, trace, ...out } };
      }
      const entry = readEntries(store).entries.find((e) => e.word === word);
      if (!entry) throw httpError(404, 'wordNotFound', `未找到词头：${word}`);
      const index = body.sense === undefined ? 0 : body.sense;
      if (!Number.isInteger(index) || index < 0) throw httpError(400, 'badSense', 'sense 必须是非负整数');
      const sense = senseList(entry)[index];
      if (!sense) throw httpError(400, 'badSense', `义项序号超出范围：${index}`);
      const out = await voteLevel({
        word,
        definition: sense.definition || entry.definition,
        example: sense.example,
        referenceLevels,
        model,
      }, signal);
      return { status: 200, body: { word, sense: index, from: sense.level, referenceLevels, trace, ...out } };
    },

    '/api/level/commit': async (req) => {
      const body = await readJson(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) throw httpError(400, 'badItems', 'items 必须是非空数组');
      return commitEntries(store, items);
    },

    '/api/session/start': (req) =>
      sessionCall(req, async (body) => {
        const state = await sessionRunner.start(body);
        return { state, current: sessionRunner.current(), study: sessionRunner.study() };
      }),

    '/api/session/study/next': (req) => sessionCall(req, () => sessionRunner.nextStudy()),

    '/api/session/answer': (req) => sessionCall(req, (body) => sessionRunner.answer(body)),

    '/api/session/next': (req) => sessionCall(req, () => sessionRunner.advance()),

    '/api/session/skip': (req) => sessionCall(req, (body) => sessionRunner.skip(body.word, body.sense)),

    '/api/session/reveal': (req) => sessionCall(req, (body) => sessionRunner.reveal(body.word)),

    '/api/session/lang': (req) => sessionCall(req, (body) => sessionRunner.setLang(body.lang)),

    '/api/session/pause': (req) => sessionCall(req, () => sessionRunner.pause()),

    '/api/session/resume': (req) =>
      sessionCall(req, async () => {
        const res = await sessionRunner.resume();
        return { ...res, state: sessionRunner.status(), current: sessionRunner.current(), study: sessionRunner.study() };
      }),

    '/api/session/preview': (req) => sessionCall(req, () => sessionRunner.preview()),

    '/api/session/commit': (req) => sessionCall(req, () => sessionRunner.commit()),

    '/api/session/abort': (req) => sessionCall(req, () => sessionRunner.abort()),

    '/api/settings': async (req) => {
      const body = await readJson(req);
      // 词表路径必须指向一个真实文件；存绝对路径，免得相对路径跟着工作目录漂。
      if (body && typeof body === 'object' && !Array.isArray(body) && 'vocabFile' in body) {
        const raw = body.vocabFile;
        if (typeof raw === 'string' && raw.trim()) {
          const abs = path.resolve(raw.trim());
          const problem = vocabFileProblem(abs);
          if (problem) throw httpError(400, 'badVocabFile', problem);
          body.vocabFile = abs;
        }
      }
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

    // 一批定档/重构要跑几十上百次上游调用，界面上的「终止」就是把这条连接关掉。连接一断就
    // 把信号往下传，让还在等上游的那些 fetch 一起停手——不然它们会接着烧到有结果为止。
    const client = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) client.abort();
    });

    try {
      const { status, body } = await table[pathname](req, url, client.signal);
      sendJson(res, status, body);
    } catch (e) {
      if (e.status) sendError(res, e.status, e.code, e.message, e.details);
      else sendError(res, 500, 'internal', e.message);
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const config = loadConfig();
  const settings = createSettings({ stateFile: createStateFile({ file: config.settingsFile }), keyNames: config.keyNames });

  // 每个请求都按设置里的当前值找目标：设置页改完保存就立刻生效，不用重启。
  const store = createStore({
    file: () => settings.get().settings.vocabFile,
    backupDir: config.backupDir,
  });

  // 路径没填或文件不在，只是警告并照常起服务——否则你就进不了设置页去改它。
  // 词表本身解析坏了仍旧拒绝启动，那是数据问题，不该带着坏数据跑。
  const checked = (() => {
    const p = settings.get().settings.vocabFile;
    if (!p) return { level: 'warn', message: '还没设置词表路径，去「设置」里填一个' };
    if (!fs.existsSync(p)) return { level: 'warn', message: `词表文件不存在：${p}` };
    try {
      const { stats } = store.selfCheck();
      return {
        level: 'ok',
        message: `${stats.total} 条 · ${stats.senses.total} 条义项 · 已掌握 ${stats.checked} 词 / ${stats.senses.checked} 义项`,
      };
    } catch (e) {
      return { level: 'bad', message: e.message };
    }
  })();
  if (checked.level === 'ok') console.log(`词表自检通过：${checked.message}`);
  else if (checked.level === 'warn') console.log(`词表自检跳过：${checked.message}`);
  else {
    console.error(`启动失败：${checked.message}`);
    process.exit(1);
  }

  const ai = createAi({
    getDefaultModel: () => settings.get().settings.model,
    getPrompts: () => settings.get().settings.prompts,
    getEndpoints: () => modelEndpoints({ settings: settings.get().settings, keys: config.keys }),
  });
  createApp({ store, config, ai, settings }).listen(config.port, '127.0.0.1', () => {
    const s = settings.get();
    console.log(`Vocabulary 助手已就绪：http://127.0.0.1:${config.port}`);
    console.log(`数据源：${s.settings.vocabFile || '（还没设置，请在设置页填词表路径）'}`);
    console.log(`生效模型：${s.settings.model || '（未设置，请在设置页选择）'}${s.error ? '（settings.json 读取出错，已用默认值）' : ''}`);
    if (!config.keyNames?.length) console.log('提示：.env 里没有任何 VOCAB_KEY_名字=… 密钥，加词与自测暂不可用');
  });
}
