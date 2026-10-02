import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import dgram from 'node:dgram';
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
import { createAi, CONTRACTS } from './ai.js';
import { createSettings, DEFAULTS, modelEndpoints } from './settings.js';
import { createCefr, CEFR_LEVELS } from './cefr.js';
import { loadConfig } from './config.js';
import { moduleDir } from './dirname.js';

const PUBLIC = path.join(moduleDir(import.meta.url), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const BODY_LIMIT = 1_000_000;
// 档位复判一轮问几次：并行问三次取平均。多问几次只是压单次判断的偶然性，三次够用，
// 而且一条义项每多一票就是多一次调用（全表 800 多条义项，五票比三票多两千次）。
const LEVEL_VOTES = 3;
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

// 只认本机回环的判定（设备迁移用，D46）：密钥值只有运行服务这台机器自己取得走，
// 局域网里的其他设备（哪怕开着 lanAccess）一律 403。
export function isLoopbackRequest(req) {
  const addr = req?.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function project(e) {
  return {
    chapter: e.chapter,
    word: e.word,
    definition: e.definition,
    chinese: e.chinese ?? null,
    mastery: e.mastery,
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
    : [{ level: e.difficulty, definition: null, chinese: e.chinese ?? null, example: e.example, checked: false }];

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

  // Windows 的原生文件选择框（词表路径的「浏览…」按钮）。服务是桌面进程，弹窗会出现在
  // 运行服务这台电脑的桌面上，所以只允许回环请求触发（见调用处）。取消时返回 null。
  const pickWindowsFile = () =>
    new Promise((resolve, reject) => {
      const script = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
        '$d = New-Object System.Windows.Forms.OpenFileDialog',
        "$d.Title = '选择词表文件（Vocabulary.md）'",
        "$d.Filter = 'Markdown 词表 (*.md)|*.md|文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*'",
        '$d.CheckFileExists = $true',
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }",
      ].join('\n');
      const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (c) => {
        out += c;
      });
      child.on('error', reject);
      child.on('close', () => resolve(out.trim() || null));
    });
  const sessionRunner =
    session ||
    (ai
      ? createSession({
          store,
          ai,
          stateFile: createStateFile({ file: path.join(config.stateDir || path.join(moduleDir(import.meta.url), '.state'), 'session.json') }),
        })
      : null);
  const settingsStore =
    settings ||
    createSettings({
      stateFile: createStateFile({ file: config.settingsFile || path.join(moduleDir(import.meta.url), 'settings.json') }),
      keyNames: () => Object.keys(config.readKeys()),
    });
  const currentSettings = () => settingsStore.get().settings;
  const modelList = () => [
    ...new Set([currentSettings().model, ...currentSettings().extraModels.map((m) => m.name)].filter(Boolean)),
  ];

  const getRoutes = {
    '/api/entries': () => ({ status: 200, body: readEntries(store) }),

    '/api/settings': (req) => {
      const { settings: s, error } = settingsStore.get();
      const keys = config.readKeys();
      return {
        status: 200,
        body: {
          settings: s,
          settingsError: error,
          defaults: DEFAULTS,
          contracts: { entry: CONTRACTS.entry, judge: CONTRACTS.judge },
          models: modelList(),
          keyNames: Object.keys(keys),
          // 前端按平台收功能：「打开配置文件」只有 Windows 有（notepad），密钥值管理只在移动版有（keysFile）；
          // local 是「前端就在运行服务这台机器上」——IP 回环判定，决定「浏览…」按钮能不能用
          // （它弹的是服务所在电脑的桌面文件框，只有本机亲眼看得到）。
          platform: process.platform,
          local: isLoopbackRequest(req),
          keysFile: config.keysFile,
          modelRoutes: Object.fromEntries(s.extraModels.map((m) => [m.name, { baseUrl: m.baseUrl, keyName: m.keyName }])),
          envFile: config.envFile,
          settingsFile: config.settingsFile,
          vocabFile: s.vocabFile ?? null,
          vocabFileError: vocabFileProblem(s.vocabFile),
          hasKey: Boolean(Object.keys(keys).length),
        },
      };
    },

    // 整表导出：把当前词表原文作为附件下发（移动版里这是把词表带出应用的正式通道）。
    '/api/vocab/export': () => {
      const text = store.readFile();
      const stamp = new Date().toISOString().slice(0, 10);
      return {
        status: 200,
        raw: true,
        headers: { 'content-disposition': `attachment; filename="Vocabulary-${stamp}.md"` },
        body: text,
      };
    },

    '/api/backups': () => ({ status: 200, body: { files: store.listBackups() } }),

    // 设备迁移（D46）：导出「密钥 + 设置」打成一份 .vocabpack（前端再拼上词表）。
    // 密钥值只在服务端出现过、只在回环请求里下发：LAN 上的其他设备取不走。
    '/api/migrate/export': (req) => {
      if (!isLoopbackRequest(req)) throw httpError(403, 'localOnly', '密钥只有运行服务这台机器自己导得走');
      const keys = config.readKeys();
      const { settings: s, error } = settingsStore.get();
      return {
        status: 200,
        raw: true,
        headers: { 'content-disposition': 'attachment; filename="vocab-device.vocabpack.json"' },
        body: `${JSON.stringify({ kind: 'vocabapp-pack', version: 1, exportedAt: new Date().toISOString(), keys, settings: s, settingsError: error || null }, null, 2)}\n`,
      };
    },

    // 进程启动以来的模型用量：一次批量跑几千次调用，前端拿两次读数相减就知道这轮花了多少。
    '/api/usage': () => ({ status: 200, body: { usage: ai ? ai.usage() : { calls: 0, prompt: 0, completion: 0, reasoning: 0 } } }),

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

  // 一票怎么算：只认 CEFR 六档（网络失败、坏 JSON、模型报了别的档位都算空票），
  // 六档折 0–5 取平均再四舍五入回档，`.5` 向上（偏向更难的那一档）。
  function tally(votes) {
    const valid = votes.filter((v) => CEFR_LEVELS.includes(v));
    if (!valid.length) return { level: null, votes, valid: 0, agree: 0, mean: null };
    const numbers = valid.map((v) => CEFR_LEVELS.indexOf(v));
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    const level = CEFR_LEVELS[Math.min(CEFR_LEVELS.length - 1, Math.max(0, Math.round(mean)))];
    return {
      level,
      votes,
      valid: valid.length,
      agree: votes.filter((v) => v === level).length,
      mean: Number(mean.toFixed(2)),
    };
  }

  // 一批义项一起定档：LEVEL_VOTES 遍并行，每遍都是同一批（一遍里每条各得一票）。
  // 好处是固定的那份规则与说明只摊一次；代价是一遍里出一条坏数据会连累同批的其他条目，
  // 所以前端按固定条数分批、坏的那个再回队列等下一批（D37）。
  async function voteLevelBatch(items, model, signal) {
    const rounds = await Promise.all(
      Array.from({ length: LEVEL_VOTES }, () =>
        ai.levelVoteBatch(items, { model, signal }).then(
          (r) => r.levels,
          (e) => ({ error: e }),
        ),
      ),
    );
    // 三遍全挂（没配模型、上游连不上）：把真实的失败端上去，别让它埋进每条的「没定出档位」。
    const dead = rounds.filter((r) => !Array.isArray(r));
    if (dead.length === rounds.length) throw upstreamError(dead[0].error);
    return items.map((_, i) => tally(rounds.map((r) => (Array.isArray(r) ? r[i] : null))));
  }

  const postRoutes = {
    '/api/draft': async (req) => {
      if (!ai) throw httpError(503, 'aiUnavailable', '服务端未配置模型');
      const body = await readJson(req);
      const word = readWord(body);
      try {
        const d = await ai.sensesEntry(
          { word, current: null, withChinese: body.withChinese === true },
          { model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : currentSettings().model },
        );
        return {
          status: 200,
          body: {
            word,
            senses: d.senses,
            note: d.note,
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
      // 「打开配置文件」用 Windows 的记事本；移动版界面上这两个按钮本来就藏起来，这里再兜一层
      if (process.platform !== 'win32') throw httpError(501, 'notSupported', '此平台不支持从界面打开配置文件');
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
      const apiKey = config.readKeys()[keyName] || '';
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
        checked: entry.mastery === 'full',
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
      let proposal;
      try {
        proposal = await ai.sensesEntry(
          { word, current, withChinese: entry.senses.some((s) => s.chinese) },
          { model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : currentSettings().model, signal },
        );
      } catch (e) {
        throw upstreamError(e);
      }
      const senses = proposal.senses.map((s, i) => ({
        ...s,
        checked: entry.senses[i] ? entry.senses[i].checked : entry.mastery === 'full',
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

    // 任务三：档位复判。plan 只出清单不调模型；vote 给一条义项跑三次取平均；commit 一次写盘。
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
          checked: entry.mastery === 'full',
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

    // 定档：一次判一批义项，每条跑三次取平均（D28 起是唯一的定档路径，D30 起也是草稿与重构
    // 的定档路径，D37 起一次带多条）。每个目标两种形态：给了 definition 就是还没写进词表的
    // 那一条（草稿卡、重构预览），否则按 sense 序号取词表里的那条。
    '/api/level/vote': async (req, _url, signal) => {
      if (!ai) throw httpError(503, 'aiUnavailable', '服务端未配置模型');
      const body = await readJson(req);
      const targets = Array.isArray(body.targets) ? body.targets : [];
      if (!targets.length) throw httpError(400, 'badTargets', 'targets 必须是非空数组');
      const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : currentSettings().model;
      // 词表只读一次：一批里可能有十几个词，逐条 readEntries 会把整张表反复解析。
      const entries = readEntries(store).entries;
      const items = targets.map((raw) => {
        const word = readWord(raw);
        const definition = typeof raw?.definition === 'string' ? raw.definition.trim() : '';
        const referenceLevels = grades.describe(word);
        const trace = grades.trace(word);
        if (definition) {
          return {
            word,
            sense: null,
            from: null,
            trace,
            referenceLevels,
            ask: { word, definition, example: typeof raw.example === 'string' ? raw.example.trim() : '', referenceLevels },
          };
        }
        const entry = entries.find((e) => e.word === word);
        if (!entry) throw httpError(404, 'wordNotFound', `未找到词头：${word}`);
        const index = raw.sense === undefined ? 0 : raw.sense;
        if (!Number.isInteger(index) || index < 0) throw httpError(400, 'badSense', 'sense 必须是非负整数');
        const sense = senseList(entry)[index];
        if (!sense) throw httpError(400, 'badSense', `义项序号超出范围：${index}`);
        return {
          word,
          sense: index,
          from: sense.level,
          trace,
          referenceLevels,
          ask: { word, definition: sense.definition || entry.definition, example: sense.example, referenceLevels },
        };
      });
      const out = await voteLevelBatch(items.map((it) => it.ask), model, signal);
      return {
        status: 200,
        body: {
          results: items.map((it, i) => ({
            word: it.word,
            sense: it.sense,
            from: it.from,
            trace: it.trace,
            referenceLevels: it.referenceLevels,
            ...out[i],
          })),
        },
      };
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
      return { status: 200, body: getRoutes['/api/settings'](req).body };
    },

    // 弹系统文件框选一份词表（Windows 桌面专用，D47）：只有回环请求能用——弹窗出现在
    // 运行服务这台电脑的桌面上，LAN 上的手机触发会弹在主人看不见的地方。取消返回 path: null。
    // 只负责「选」，不写盘：前端拿到路径再走保存流程，或另调 /api/vocab/import 把它导入。
    '/api/pick-file': async (req) => {
      if (process.platform !== 'win32') throw httpError(501, 'notSupported', '此平台不支持服务端文件对话框');
      if (!isLoopbackRequest(req)) throw httpError(403, 'localOnly', '文件对话框只会弹在运行服务这台电脑上');
      const picked = await pickWindowsFile();
      return { status: 200, body: { path: picked } };
    },

    // 直接读写外部文件（D48）：把词表切到**任意一个已有的 .md**——手机上「选取词表文件…」
    // 选中哪个就用哪个（原地读、原地写），放进 Syncthing 同步的文件夹即可自动同步。
    // 空文件按「把当前词表写过去，以后就用这个文件」处理；内容解析不过的原样拒收；
    // 读不了/写不进的（没权限、云盘位置）报 externalDenied，前端据此提示去开「所有文件访问」。
    '/api/vocab/use-file': async (req) => {
      const body = await readJson(req);
      const raw = typeof body?.path === 'string' ? body.path.trim() : '';
      if (!raw) throw httpError(400, 'badPath', 'path 不能为空');
      const target = path.resolve(raw);
      let stat;
      try {
        stat = fs.statSync(target);
      } catch {
        throw httpError(400, 'badPath', `找不到这个文件：${target}`);
      }
      if (!stat.isFile()) throw httpError(400, 'badPath', `这不是一个文件：${target}`);
      if (target === currentSettings().vocabFile) {
        return { status: 200, body: { stats: parse(store.readFile()).stats, vocabFile: target, copied: false } };
      }
      let text;
      try {
        text = fs.readFileSync(target, 'utf8');
      } catch (e) {
        throw httpError(400, 'externalDenied', `读不了这个文件（${e.code || e.message}）：若它在共享存储里，先在系统设置里允许「所有文件访问」`);
      }
      // 写权限用「同目录建个临时文件再删」来探：store 写盘也是同目录临时文件 + 改名
      try {
        const probe = path.join(path.dirname(target), `.vocabapp-write-test-${process.pid}`);
        fs.writeFileSync(probe, 'ok', 'utf8');
        fs.unlinkSync(probe);
      } catch (e) {
        throw httpError(400, 'externalDenied', `这个位置写不进去（${e.code || e.message}）：先在系统设置里允许「所有文件访问」`);
      }
      let copied = false;
      if (!text.trim()) {
        // 空文件（在新位置先建了个空 md 再选进来是常见用法）：把当前词表写过去
        text = store.readFile();
        fs.writeFileSync(target, text, 'utf8');
        copied = true;
      }
      const { stats, errors } = parse(text);
      if (errors.length) {
        throw httpError(400, 'parseErrors', '这份文件不是能解析的词表（是不是选错了文件？）', errors.slice(0, 20));
      }
      const patched = settingsStore.patch({ vocabFile: target });
      if (patched.error) throw httpError(400, patched.error.code, patched.error.message);
      return { status: 200, body: { stats, vocabFile: target, copied } };
    },

    // 整表导入：整份 Markdown 替换当前词表。先解析后写盘——解析不过的文件一个字节都不落，
    // 写盘前照例备份，导坏了能从备份里找回来。
    '/api/vocab/import': async (req) => {
      const body = await readJson(req);
      const text = typeof body?.text === 'string' ? body.text : null;
      if (text === null) throw httpError(400, 'badText', 'text 必须是字符串');
      if (!text.trim()) throw httpError(400, 'badText', '导入的内容是空的');
      const { stats, errors } = parse(text);
      if (errors.length) {
        throw httpError(400, 'parseErrors', '导入的词表解析失败，未写入', errors.slice(0, 20));
      }
      return store.enqueue(() => {
        const { backup } = store.writeWithBackup(text);
        return { status: 200, body: { stats, backup } };
      });
    },

    // 设备迁移（D46）：吃一份 .vocabpack，把「密钥 / 设置 / 词表」三块各自与本地比对，
    // 有冲突（两边不同且都不是空）就把两版内容一起摆出来，让前端画 diff、逐项来选。
    // 不做任何合并猜测：词表按章节行（`### X`）对齐，模型/提示词按语义拆分，密钥按名字。
    '/api/migrate/import': async (req) => {
      const body = await readJson(req);
      const pack = body?.pack;
      if (!pack || typeof pack !== 'object' || Array.isArray(pack) || pack.kind !== 'vocabapp-pack') {
        throw httpError(400, 'badPack', '这不是 Vocabulary 助手导出的设备包');
      }
      if (pack.version !== 1) throw httpError(400, 'badPack', `设备包版本不认识：${pack.version}`);
      // 哪几块参与导入由前端的第一步勾选决定（默认全选）
      const wants = (name) => body?.parts?.[name] !== false;

      // ---- 词表：按章节行对齐 ----
      const sections = (text) => {
        const map = new Map();
        let current = '';
        const chunks = String(text ?? '').split(/\r?\n/);
        for (const line of chunks) {
          const m = /^### (.+)$/.exec(line);
          if (m) current = m[1].trim();
          if (!map.has(current)) map.set(current, []);
          map.get(current).push(line);
        }
        for (const [k, v] of map) map.set(k, v.join('\n').replace(/\n+$/, ''));
        return map;
      };
      const localVocab = store.readFile();
      // 设备包分两半：pack 是 JSON（设置与密钥），词表原文放 pack.vocabText（导出的单文件里含它）；
      // 兼容分开传的 body.vocabText（早期形态与测试）。
      const remoteVocabRaw = typeof pack.vocabText === 'string' && pack.vocabText.trim() ? pack.vocabText : typeof body.vocabText === 'string' ? body.vocabText : null;
      const remoteVocab = remoteVocabRaw && remoteVocabRaw.trim() ? remoteVocabRaw : null;
      let vocab = null;
      if (wants('vocab') && remoteVocab !== null) {
        if (remoteVocab === localVocab) {
          vocab = { state: 'same', localText: localVocab, remoteText: remoteVocab };
        } else {
          const ls = sections(localVocab);
          const rs = sections(remoteVocab);
          const names = new Set([...ls.keys(), ...rs.keys()]);
          const entries = [];
          for (const name of names) {
            const l = ls.get(name) ?? null;
            const r = rs.get(name) ?? null;
            if (l === r) {
              entries.push({ section: name, state: 'same', localText: l, remoteText: r });
            } else if (l !== null && r !== null) {
              entries.push({ section: name || '（文件开头）', state: 'conflict', localText: l, remoteText: r });
            } else {
              entries.push({ section: name || '（文件开头）', state: 'one-sided', localText: l, remoteText: r });
            }
          }
          vocab = { state: entries.some((e) => e.state === 'conflict') ? 'conflict' : 'differs', entries, localText: localVocab, remoteText: remoteVocab };
        }
      }

      // ---- 设置：按字段语义拆分（不是整段比对象）----
      const localSettings = settingsStore.get().settings;
      // 远端设置按默认值补齐：设备包来自一次完整导出，字段本应齐全；缺的按「还是默认值」算，
      // 免得把手写包里的缺字段当成「远端要清空这项」。
      const remoteSettings = pack.settings && typeof pack.settings === 'object'
        ? { ...DEFAULTS, ...pack.settings, prompts: { ...DEFAULTS.prompts, ...(pack.settings.prompts || {}) } }
        : null;
      let settings = null;
      if (wants('settings') && remoteSettings) {
        const fields = [];
        const push = (field, label, localValue, remoteValue, { multi = false } = {}) => {
          const same = JSON.stringify(localValue ?? null) === JSON.stringify(remoteValue ?? null);
          // 「空」= null / undefined / 空数组 / 全 null 的对象（提示词那组两边都可能只写了一半）：
          // 一边空、另一边有值算单边（直接搬），两边都有值且不同才算冲突。
          const empty = (v) => {
            if (v === null || v === undefined) return true;
            if (multi && Array.isArray(v) && !v.length) return true;
            if (v && typeof v === 'object' && !Array.isArray(v)) return Object.values(v).every((x) => x === null || x === undefined);
            return false;
          };
          let state = 'same';
          if (!same) state = empty(localValue) ? 'one-sided' : empty(remoteValue) ? 'one-sided' : 'conflict';
          fields.push({ field, label, state, localValue: localValue ?? null, remoteValue: remoteValue ?? null, multi });
        };
        push('model', '默认模型', localSettings.model, remoteSettings.model);
        push('extraModels', '模型候选', localSettings.extraModels || [], remoteSettings.extraModels || [], { multi: true });
        push('prompts', '提示词覆盖', localSettings.prompts || {}, remoteSettings.prompts || {});
        push('lang', '反馈语言', localSettings.lang, remoteSettings.lang);
        push('theme', '主题', localSettings.theme, remoteSettings.theme);
        push('port', '端口', localSettings.port, remoteSettings.port);
        push('lanAccess', '局域网访问', localSettings.lanAccess, remoteSettings.lanAccess);
        push('vocabFile', '词表路径', localSettings.vocabFile, remoteSettings.vocabFile);
        settings = { state: fields.some((f) => f.state === 'conflict') ? 'conflict' : fields.some((f) => f.state === 'one-sided') ? 'differs' : 'same', fields };
      }

      // ---- 密钥：按名字，只报名字、有无与长度差，永不回显值 ----
      const localKeyVals = config.readKeys();
      const remoteKeyVals = pack.keys && typeof pack.keys === 'object' && !Array.isArray(pack.keys) ? pack.keys : {};
      let keys = null;
      if (wants('keys') && Object.keys(remoteKeyVals).length) {
        const entries = [];
        for (const name of new Set([...Object.keys(localKeyVals), ...Object.keys(remoteKeyVals)])) {
          const l = Object.prototype.hasOwnProperty.call(localKeyVals, name);
          const r = Object.prototype.hasOwnProperty.call(remoteKeyVals, name);
          const same = l && r && String(localKeyVals[name]) === String(remoteKeyVals[name]);
          entries.push({
            name,
            state: same ? 'same' : l && r ? 'conflict' : 'one-sided',
            local: l,
            remote: r,
            // 值不能看，给个长度提示：长度不同基本就是换了把钥匙
            localLen: l ? String(localKeyVals[name]).length : null,
            remoteLen: r ? String(remoteKeyVals[name]).length : null,
          });
        }
        keys = { state: entries.some((e) => e.state === 'conflict') ? 'conflict' : entries.some((e) => e.state === 'one-sided') ? 'differs' : 'same', entries };
      }

      return { status: 200, body: { vocab, settings, keys } };
    },

    // 迁移的写盘步（D46）：前端在冲突面板里逐项选完，把最终结果交回来一次写。
    // 词表原文整份替换（写前解析校验 + 备份）；设置与密钥逐字段/逐名字合并。
    '/api/migrate/commit': async (req) => {
      const body = await readJson(req);
      const out = {};
      if (typeof body?.vocabText === 'string' && body.vocabText.trim()) {
        const { errors, stats } = parse(body.vocabText);
        if (errors.length) throw httpError(400, 'parseErrors', '词表解析失败，未写入', errors.slice(0, 20));
        const written = await store.enqueue(() => {
          const { backup } = store.writeWithBackup(body.vocabText);
          return { stats, backup };
        });
        out.vocab = written;
      }
      if (body?.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) {
        const patched = settingsStore.patch(body.settings);
        if (patched.error) throw httpError(400, patched.error.code, patched.error.message);
        out.settings = patched.settings;
      }
      if (body?.keys && typeof body.keys === 'object' && !Array.isArray(body.keys)) {
        const entries = Object.entries(body.keys);
        for (const [name, value] of entries) {
          if (!/^[A-Za-z0-9_]+$/.test(name)) throw httpError(400, 'badKeyName', `密钥名只能用字母、数字和下划线：${name}`);
          if (typeof value !== 'string' || !value.trim()) throw httpError(400, 'badKeyName', `${name} 的值不能为空`);
        }
        if (config.keysFile) {
          const keysStore = createStateFile({ file: config.keysFile });
          const current = keysStore.read() || {};
          for (const [name, value] of entries) current[name] = value.trim();
          keysStore.write(current);
        } else {
          // 桌面版第一次导入密钥：生成项目目录里的 keys.json（config 会自动认出它），
          // .env 本体一个字节都不动（D16「工具绝不写 .env」保持成立）。
          const fallback = path.join(config.dir || moduleDir(import.meta.url), 'keys.json');
          const keysStore = createStateFile({ file: fallback });
          const current = keysStore.read() || {};
          for (const [name, value] of entries) current[name] = value.trim();
          keysStore.write(current);
          out.keysFile = fallback;
        }
        out.keys = Object.keys(config.readKeys()).sort();
      }
      return { status: 200, body: out };
    },

    // 密钥值管理（移动版专用，D45）：桌面版的密钥在 .env 里，由用户手工维护、工具绝不写；
    // 移动版没有可编辑的 .env，密钥值放应用沙盒的 keys.json，这里只写不读——
    // 密钥值永远不会出现在任何响应里。
    '/api/keys': async (req) => {
      if (!config.keysFile) throw httpError(501, 'notSupported', '此部署的密钥在 .env 里，请在服务器上手工维护');
      const body = await readJson(req);
      const input = body?.keys;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'badKeys', 'keys 必须是对象');
      const entries = Object.entries(input);
      if (!entries.length) throw httpError(400, 'badKeys', 'keys 不能为空');
      for (const [name, value] of entries) {
        if (!/^[A-Za-z0-9_]+$/.test(name)) throw httpError(400, 'badKeyName', `密钥名只能用字母、数字和下划线：${name}`);
        if (typeof value !== 'string' || !value.trim()) throw httpError(400, 'badKeyName', `${name} 的值不能为空`);
      }
      const keysStore = createStateFile({ file: config.keysFile });
      const current = keysStore.read() || {};
      for (const [name, value] of entries) current[name] = value.trim();
      keysStore.write(current);
      return { status: 200, body: { keyNames: Object.keys(config.readKeys()).sort() } };
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
      const out = await table[pathname](req, url, client.signal);
      // raw 响应（整表导出这类要带附件头的）绕过 JSON 封装，按调用方给的头原样下发
      if (out.raw) {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(out.status, {
          'content-type': 'text/markdown; charset=utf-8',
          'cache-control': 'no-store',
          ...(out.headers || {}),
        });
        res.end(out.body);
      } else {
        sendJson(res, out.status, out.body);
      }
    } catch (e) {
      if (e.status) sendError(res, e.status, e.code, e.message, e.details);
      else sendError(res, 500, 'internal', e.message);
    }
  });
}

// 找「真正对外的那个 IPv4」：UDP connect 不发包，只是让内核挑出口网卡，拿到的就是手机要用的地址。
// 按网卡顺序取第一个不行——本机 vgate0（虚拟机网卡）就排在 Wi-Fi 前面，手机照着敲连不上。
function primaryIPv4() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (ip) => {
      try {
        sock.close();
      } catch {}
      resolve(ip);
    };
    sock.once('error', () => done(null));
    try {
      sock.connect(53, '223.5.5.5', () => done(sock.address().address));
      setTimeout(() => done(null), 500);
    } catch {
      done(null);
    }
  });
}

// 移动版入口由 mobile-main.cjs 拉起（它先把数据路径指进应用沙盒、设 VOCAB_MOBILE=1）；
// 桌面版仍按「node server.js 直接运行」判定。
if (process.env.VOCAB_MOBILE === '1' || (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)) {
  const config = loadConfig();
  const settings = createSettings({
    stateFile: createStateFile({ file: config.settingsFile }),
    // 移动版能在运行期加密钥（/api/keys），keyNames 用取值函数，每次校验现读
    keyNames: () => Object.keys(config.readKeys()),
  });

  // 移动版（D45）：数据都在应用沙盒的 dataPath 里。首次启动还没有词表路径时，
  // 给它一个默认值并在缺文件时建一份空词表——安卓上用户没法手填路径，也 browse 不了文件系统。
  if (process.env.VOCAB_MOBILE === '1' && process.env.VOCAB_DATA_DIR) {
    const seedPath = path.join(process.env.VOCAB_DATA_DIR, 'Vocabulary.md');
    if (!settings.get().settings.vocabFile) settings.patch({ vocabFile: seedPath });
    if (!fs.existsSync(seedPath)) fs.writeFileSync(seedPath, '', 'utf8');
  }

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
        message: `${stats.total} 条 · ${stats.senses.total} 条义项 · 完全掌握 ${stats.full} 词 · 部分掌握 ${stats.partial} 词 · 已掌握 ${stats.senses.checked} 义项`,
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
    getEndpoints: () => modelEndpoints({ settings: settings.get().settings, keys: config.readKeys() }),
  });
  // 端口与访问范围在设置里（D44）：settings.json 的 port 与 lanAccess，改完要重启才生效——
  // listen 只在启动时发生一次。lanAccess 开着监听 0.0.0.0，同一网络里的手机就能打开；
  // 服务没有鉴权，这个口只该开在自家网络里。
  const current = settings.get();
  const port = current.settings.port;
  const host = current.settings.lanAccess ? '0.0.0.0' : '127.0.0.1';
  createApp({ store, config, ai, settings }).listen(port, host, () => {
    console.log(`Vocabulary 助手已就绪：http://127.0.0.1:${port}`);
    if (current.settings.lanAccess) {
      const ips = Object.values(os.networkInterfaces())
        .flat()
        .filter((a) => a && a.family === 'IPv4' && !a.internal)
        .map((a) => a.address);
      primaryIPv4().then((primary) => {
        const main = primary || ips[0];
        const others = ips.filter((ip) => ip !== main);
        console.log(`局域网访问已开启：同一网络里的设备用 http://${main || '<本机IP>'}:${port} 打开（服务没有密码，别在公共网络开）`);
        // 出口网卡猜错时（比如手机连的是另一张网卡），这一行里的地址可以挨个试
        if (others.length) console.log(`其他网卡地址：${others.map((ip) => `http://${ip}:${port}`).join('、')}`);
      });
    }
    console.log(`数据源：${current.settings.vocabFile || '（还没设置，请在设置页填词表路径）'}`);
    console.log(`生效模型：${current.settings.model || '（未设置，请在设置页选择）'}${current.error ? '（settings.json 读取出错，已用默认值）' : ''}`);
    if (!Object.keys(config.readKeys()).length) console.log('提示：还没有任何密钥，加词与自测暂不可用');
  });
}
