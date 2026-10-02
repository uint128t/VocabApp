const CEFR = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
const HEAD = /^- (?!\[)(.+)$/;
const CHILD = /^  - (.+)$/;
const SENSE_BOX = /^  - \[( |x)\] (.+)$/;
const SENSE_BODY = /^#(A1|A2|B1|B2|C1|C2) - (.+)$/;
const CHAPTER = /^### (.+)$/;
const CJK_RANGES = [
  [0x3000, 0x303f],
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
];

function isCjk(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    for (const [lo, hi] of CJK_RANGES) {
      if (c >= lo && c <= hi) return true;
    }
  }
  return false;
}

function splitLines(text) {
  return text.split(/\r?\n/);
}

// 主行只可能是「- 词头」或「- 词头 - 释义 [- 中文]」；多于三段时只把最后一段当释义。
function classify(segs) {
  const word = segs[0];
  const rest = segs.slice(1);
  const out = { word, definition: '', chinese: undefined };
  if (rest.length === 1) {
    out.definition = rest[0];
  } else if (rest.length >= 2) {
    const last = rest[rest.length - 1];
    if (rest.length === 2 && isCjk(last)) {
      out.definition = rest[0];
      out.chinese = rest[1];
    } else {
      out.definition = last;
    }
  }
  return out;
}

export function parse(text) {
  const lines = splitLines(text);
  const entries = [];
  const errors = [];
  const chapters = [];
  let chapter = null;
  let pending = null;

  const fail = (type, i, raw) =>
    errors.push({ type, line: i + 1, word: pending ? pending.word : undefined, raw });

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ch = CHAPTER.exec(raw);
    if (ch) {
      chapter = ch[1].trim();
      chapters.push({ letter: chapter, headerLine: i });
      pending = null;
      continue;
    }
    if (raw.trim() === '') {
      pending = null;
      continue;
    }
    const head = HEAD.exec(raw);
    if (head) {
      const segs = head[1].split(' - ');
      const c = classify(segs);
      const entry = {
        index: entries.length,
        chapter,
        checked: false,
        segments: segs,
        word: c.word,
        definition: c.definition,
        chinese: c.chinese,
        difficulty: null,
        example: null,
        childLine: null,
        childLines: [],
        senses: [],
        childIndex: null,
        lineStart: i,
        lineEnd: i,
        raw,
      };
      entries.push(entry);
      pending = entry;
      continue;
    }
    if (CHILD.test(raw)) {
      if (!pending) {
        errors.push({ type: 'orphanChild', line: i + 1, raw });
        continue;
      }
      pending.childLines.push(raw);
      pending.lineEnd = i;
      const box = SENSE_BOX.exec(raw);
      const sense = box ? parseSenseLine(i, box[2], raw, box[1] === 'x') : null;
      if (!sense) {
        fail('malformedChild', i, raw);
        continue;
      }
      pending.senses.push(sense);
      if (pending.senses.length === 1) {
        pending.childLine = raw;
        pending.childIndex = i;
        pending.difficulty = sense.level;
        pending.example = sense.example;
      }
      continue;
    }
    if (raw.startsWith('- [')) fail('malformedHead', i, raw);
  }

  for (const e of entries) {
    if (!e.definition && e.senses.length) e.definition = e.senses[0].definition || '';
    if (!e.definition) {
      errors.push({ type: 'missingDefinition', line: e.lineStart + 1, word: e.word, raw: e.raw });
    }
    // 掌握状态按义项推，分三档：一条都没勾是不掌握，全勾上才是完全掌握，中间那档是部分掌握。
    const done = e.senses.filter((s) => s.checked).length;
    e.mastery = !done ? 'none' : done === e.senses.length ? 'full' : 'partial';
  }

  const withMastery = (m) => entries.filter((e) => e.mastery === m).length;
  const senseCount = (pick) =>
    entries.reduce((n, e) => n + e.senses.filter((s) => pick(s.checked)).length, 0);
  const dupes = new Map();
  for (const e of entries) {
    const k = e.word.toLowerCase();
    if (!dupes.has(k)) dupes.set(k, []);
    dupes.get(k).push(e);
  }
  for (const list of dupes.values()) {
    if (list.length > 1) {
      for (const e of list) errors.push({ type: 'duplicateWord', line: e.lineStart + 1, word: e.word, raw: e.raw });
    }
  }
  const chapterDupes = new Map();
  for (const c of chapters) {
    chapterDupes.set(c.letter, (chapterDupes.get(c.letter) || 0) + 1);
  }
  for (const [letter, n] of chapterDupes) {
    if (n > 1) errors.push({ type: 'duplicateChapter', line: chapters.find((c) => c.letter === letter).headerLine + 1, word: letter });
  }

  errors.sort((a, b) => a.line - b.line);

  return {
    entries,
    chapters,
    errors,
    stats: {
      total: entries.length,
      full: withMastery('full'),
      partial: withMastery('partial'),
      none: withMastery('none'),
      senses: {
        total: senseCount(() => true),
        checked: senseCount((c) => c),
        unchecked: senseCount((c) => !c),
      },
      missingExample: entries.filter((e) => !e.example).length,
      missingDifficulty: entries.filter((e) => !e.difficulty).length,
    },
  };
}

function parseSenseLine(index, body, raw, checked) {
  const modern = SENSE_BODY.exec(body);
  if (!modern) return null;
  const parts = modern[2].split(' - ');
  const example = parts.pop().trim();
  const chinese = parts.length > 1 && isCjk(parts[parts.length - 1]) ? parts.pop().trim() : null;
  const definition = parts.join(' - ').trim();
  if (!definition || !example) return null;
  return { level: modern[1], definition, chinese, example, checked, index, raw };
}

export function sortKey(word) {
  return String(word).normalize('NFD').toLowerCase().replace(/[^a-z]/g, '');
}

// 主行只留词头（+ 旧式释义），掌握状态一律写在义项行上。
export function serializeHead(entry) {
  return `- ${entry.segments.join(' - ')}`;
}

export function serializeSense(sense) {
  if (!sense) return null;
  const parts = [sense.definition];
  if (sense.chinese) parts.push(sense.chinese);
  parts.push(sense.example);
  return `  - [${sense.checked ? 'x' : ' '}] #${sense.level} - ${parts.join(' - ')}`;
}

const checkedFor = (sense, index, entry, fallback) => {
  if (sense.checked !== undefined) return sense.checked === true;
  if (fallback !== undefined) return fallback === true;
  const existing = entry && entry.senses[index];
  return existing ? existing.checked === true : Boolean(entry && entry.mastery === 'full');
};

function err(code, message, details) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function guard(parsed) {
  if (parsed.errors.length) {
    return err('parseErrors', '文件存在解析错误，拒绝写盘', parsed.errors.slice(0, 20));
  }
  return null;
}

// 重复词头轮不到这里：parse 会把它记成错误，guard 在那之前就拦下了。
function findByWord(parsed, word) {
  const entry = parsed.entries.find((e) => e.word === word);
  if (!entry) return { error: err('wordNotFound', `未找到词头：${word}`) };
  return { entry };
}

// 分隔符是「- 词头 - 释义 - 例句」这套写法的骨架：释义里能出现它就会被拆错，
// 例句里同样——写进去之后再 parse，例句会被当成释义的尾巴。两层都拦住。
function validExample(example) {
  return typeof example === 'string' && example.trim() !== '' && !example.includes('\n') && !example.includes(' - ');
}

function entryLines({ word, senses }) {
  return [`- ${word}`, ...(senses || []).map((s) => serializeSense({ ...s, checked: s.checked === true }))];
}

// 调用方只给单条义项的旧式字段（definition/difficulty/example）时折成一条义项；
// 已经有义项的条目只替换第一条，其余原样留下，不丢义项。
function sensesFromPatch(entry, patch) {
  if (Array.isArray(patch.senses) && patch.senses.length) return patch.senses;
  if (!patch.definition && !patch.difficulty && !patch.example) return [];
  const first = (entry && entry.senses[0]) || null;
  const one = {
    level: patch.difficulty,
    definition: patch.definition,
    chinese: patch.chinese === null ? null : patch.chinese === undefined ? (first ? first.chinese : null) : patch.chinese,
    example: patch.example,
    checked: patch.checked === undefined ? Boolean(first && first.checked) : patch.checked,
  };
  return entry && entry.senses.length ? [one, ...entry.senses.slice(1)] : [one];
}

function validateSense(sense) {
  if (!sense || typeof sense !== 'object') return err('badSense', '义项必须是对象');
  if (!CEFR.has(sense.level)) return err('badDifficulty', `难度必须属于 CEFR 六档：${sense.level}`);
  if (typeof sense.definition !== 'string' || sense.definition.trim() === '' || sense.definition.includes('\n')) {
    return err('badDefinition', '义项释义不能为空或含换行');
  }
  if (sense.definition.includes(' - ')) return err('badDefinition', '义项释义不能包含分隔符');
  if (!validExample(sense.example)) return err('badExample', '例句不能为空、含换行或含分隔符「 - 」');
  if (sense.checked !== undefined && typeof sense.checked !== 'boolean') {
    return err('badChecked', '义项里的 checked 必须是布尔值');
  }
  if (sense.chinese !== undefined && sense.chinese !== null && sense.chinese !== '') {
    if (typeof sense.chinese !== 'string' || sense.chinese.includes('\n')) {
      return err('badChinese', '义项里的中文段格式不正确');
    }
    if (!isCjk(sense.chinese)) return err('badChinese', '义项里的中文段必须是中文');
  }
  return null;
}

// 一个词头能不能写进这张表，规矩只有这一处：分隔符「 - 」会把义项行拆开，换行会造出假主行，
// 方括号会写出 `- [x] atom`（带框主行的形状）——三者都能让整张表从此解析不出来。
// 读接口的参数（server.js 的 readWord）与写盘前的校验（validateFields）都过这里。
export function wordProblem(word) {
  if (!word) return err('badWord', '词头不能为空');
  if (word.includes(' - ')) return err('badWord', '词头不能包含分隔符');
  if (/[\r\n]/.test(word)) return err('badWord', '词头不能包含换行');
  if (/[[\]]/.test(word)) return err('badWord', '词头不能包含方括号');
  return null;
}

function validateFields({ word, checked, senses }) {
  if (typeof word !== 'string' || word.trim() === '' || word !== word.trim()) {
    return err('badWord', '词头不能为空或带首尾空格');
  }
  const bad = wordProblem(word);
  if (bad) return bad;
  if (checked !== undefined && typeof checked !== 'boolean') return err('badChecked', 'checked 必须是布尔值');
  if (!senses.length) return err('badSenses', '每个词至少要有一条义项');
  for (const sense of senses) {
    const bad = validateSense(sense);
    if (bad) return bad;
  }
  return null;
}

export function planInsertEntry(text, entry) {
  const parsed = parse(text);
  const blocked = guard(parsed);
  if (blocked) return blocked;

  const bad = validateFields({ word: entry.word, checked: entry.checked, senses: sensesFromPatch(null, entry) });
  if (bad) return bad;
  const { word } = entry;

  if (parsed.entries.some((e) => e.word.toLowerCase() === word.toLowerCase())) {
    return err('wordExists', `词头已存在：${word}`);
  }

  const key = sortKey(word);
  const letter = key ? key[0].toUpperCase() : word[0].toUpperCase();
  const same = parsed.chapters.filter((c) => c.letter.toUpperCase() === letter);

  const lines = splitLines(text);
  const newLines = entryLines({ word, senses: sensesFromPatch(null, entry) });

  if (same.length === 1) {
    const siblings = parsed.entries.filter((e) => (e.chapter || '').toUpperCase() === letter);
    const after = siblings.filter((e) => sortKey(e.word) > key).sort((a, b) => a.lineStart - b.lineStart)[0];
    if (after) {
      return { type: 'insertBefore', lineStart: after.lineStart, lineEnd: after.lineStart, newText: newLines.join('\n'), word };
    }
    const last = siblings[siblings.length - 1];
    if (!last) {
      const header = parsed.chapters.find((c) => c.letter.toUpperCase() === letter).headerLine;
      const anchor = lines[header + 1] === '' ? header + 1 : header;
      return { type: 'insertAfter', lineStart: anchor, lineEnd: anchor, newText: newLines.join('\n'), word };
    }
    return { type: 'insertAfter', lineStart: last.lineEnd, lineEnd: last.lineEnd, newText: newLines.join('\n'), word };
  }

  const next = parsed.chapters
    .filter((c) => c.letter.toUpperCase() > letter)
    .sort((a, b) => (a.letter.toUpperCase() < b.letter.toUpperCase() ? -1 : 1))[0];
  if (next) {
    return {
      type: 'insertBefore',
      lineStart: next.headerLine,
      lineEnd: next.headerLine,
      newText: [`### ${letter}`, '', ...newLines, ''].join('\n'),
      word,
    };
  }
  const prev = parsed.chapters
    .filter((c) => c.letter.toUpperCase() < letter)
    .sort((a, b) => (a.letter.toUpperCase() < b.letter.toUpperCase() ? -1 : 1))
    .pop();
  const at = prev ? lines.length - (lines[lines.length - 1] === '' ? 1 : 0) : 0;
  const head = prev ? ['', `### ${letter}`, ''] : [`### ${letter}`, ''];
  return {
    type: 'insertBefore',
    lineStart: at,
    lineEnd: at,
    newText: [...head, ...newLines].join('\n'),
    word,
  };
}

export function planSetChecked(text, word, checked) {
  const parsed = parse(text);
  const blocked = guard(parsed);
  if (blocked) return blocked;
  const { entry, error } = findByWord(parsed, word);
  if (error) return error;
  if (typeof checked !== 'boolean') return err('badChecked', 'checked 必须是布尔值');
  return planSetSensesChecked(text, word, entry.senses.map((_, i) => ({ index: i, checked })));
}

export function planSetSensesChecked(text, word, states) {
  const parsed = parse(text);
  const blocked = guard(parsed);
  if (blocked) return blocked;
  const { entry, error } = findByWord(parsed, word);
  if (error) return error;
  if (!entry.senses.length) return err('noSenses', '该条目还没有义项行，先补一条义项再勾选');

  const wanted = new Map();
  for (const state of Array.isArray(states) ? states : []) {
    if (!state || typeof state.checked !== 'boolean') return err('badChecked', '义项里的 checked 必须是布尔值');
    if (!Number.isInteger(state.index) || state.index < 0 || state.index >= entry.senses.length) {
      return err('badSense', `义项序号超出范围：${state.index}`);
    }
    wanted.set(state.index, state.checked);
  }
  if (!wanted.size) return { edits: [], word, noop: true };

  const edits = [];
  entry.senses.forEach((sense, i) => {
    const checked = wanted.has(i) ? wanted.get(i) : sense.checked;
    if (checked === sense.checked) return;
    edits.push({
      type: 'replace',
      lineStart: sense.index,
      lineEnd: sense.index,
      newText: serializeSense({ ...sense, checked }),
      word,
    });
  });
  return { edits, word, noop: edits.length === 0 };
}

export function planSetEntry(text, word, patch) {
  const parsed = parse(text);
  const blocked = guard(parsed);
  if (blocked) return blocked;
  const { entry, error } = findByWord(parsed, word);
  if (error) return error;
  const senses = sensesFromPatch(entry, patch);
  const bad = validateFields({ word: entry.word, checked: patch.checked, senses });
  if (bad) return bad;

  const next = senses.map((s, i) => ({
    level: s.level,
    definition: String(s.definition).trim(),
    chinese: s.chinese ? String(s.chinese).trim() : null,
    example: s.example.trim(),
    checked: checkedFor(s, i, entry, patch.checked),
  }));
  const head = `- ${entry.word}`;
  const lines = next.map((s) => serializeSense(s));
  const edits = [];
  if (head !== entry.raw) {
    edits.push({ type: 'replace', lineStart: entry.lineStart, lineEnd: entry.lineStart, newText: head, word });
  }
  const block = lines.join('\n');
  if (entry.childLines.join('\n') !== block) {
    edits.push(
      entry.childLines.length
        ? { type: 'replace', lineStart: entry.lineStart + 1, lineEnd: entry.lineEnd, newText: block, word }
        : { type: 'insertAfter', lineStart: entry.lineStart, lineEnd: entry.lineStart, newText: block, word },
    );
  }
  return { edits, word, noop: edits.length === 0 };
}

export function planDeleteEntry(text, word) {
  const parsed = parse(text);
  const blocked = guard(parsed);
  if (blocked) return blocked;
  const { entry, error } = findByWord(parsed, word);
  if (error) return error;
  const removed = entry.lineEnd - entry.lineStart + 1;
  return {
    edits: [{ type: 'replace', lineStart: entry.lineStart, lineEnd: entry.lineEnd, newText: '', word }],
    word,
    removed,
  };
}

export function applyEdits(text, edits) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const ops = edits.map((ed, order) => {
    if (!ed || typeof ed !== 'object') throw new Error('edit 必须是对象');
    if (ed.error) throw new Error(`edit 携带错误：${ed.error.code}`);
    const newLines = ed.newText === '' || ed.newText === undefined ? [] : String(ed.newText).split('\n');
    if (ed.type === 'insertBefore') return { kind: 'insert', at: ed.lineStart, end: ed.lineStart - 1, newLines, order };
    if (ed.type === 'insertAfter') return { kind: 'insert', at: ed.lineEnd + 1, end: ed.lineEnd, newLines, order };
    if (ed.type === 'replace') return { kind: 'replace', at: ed.lineStart, end: ed.lineEnd, newLines, order };
    throw new Error(`未知 edit 类型：${ed.type}`);
  });

  for (const op of ops) {
    if (!Number.isInteger(op.at) || !Number.isInteger(op.end)) throw new Error('edit 行号必须是整数');
    if (op.at < 0 || op.end >= lines.length || op.end < op.at - 1) {
      throw new Error(`edit 行号越界：${op.at}..${op.end}`);
    }
  }
  for (let i = 0; i < ops.length; i++) {
    for (let j = i + 1; j < ops.length; j++) {
      const a = ops[i];
      const b = ops[j];
      if (a.kind === 'replace' && b.kind === 'replace') {
        if (a.at <= b.end && b.at <= a.end) throw new Error(`edit 行区间重叠：${a.at}..${a.end} 与 ${b.at}..${b.end}`);
      }
      for (const [ins, rep] of [
        [a, b],
        [b, a],
      ]) {
        if (ins.kind === 'insert' && rep.kind === 'replace' && ins.at > rep.at && ins.at <= rep.end) {
          throw new Error(`edit 插入点落在被替换区间内：${ins.at}`);
        }
      }
    }
  }

  ops.sort((x, y) => y.at - x.at || y.order - x.order);
  for (const op of ops) {
    if (op.kind === 'replace') lines.splice(op.at, op.end - op.at + 1, ...op.newLines);
    else lines.splice(op.at, 0, ...op.newLines);
  }
  return lines.join(eol);
}
