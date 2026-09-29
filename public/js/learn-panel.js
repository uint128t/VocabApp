// 学习面板：抽 10 个还有义项没掌握的词，先逐个看一遍，再闭卷测这一轮。
// 渲染与动作都在 session-ui.js 里（与复习共用），这里只认领本面板的元素。

import { $ } from './core.js';
import { mountRound } from './session-ui.js';

const round = mountRound({ prefix: 'learn', mode: 'learn' });

$('#learnStart').addEventListener('click', () => round.start(false));
$('#learnRestart').addEventListener('click', () => round.start(true));
$('#learnPause').addEventListener('click', round.pause);
$('#learnResume').addEventListener('click', round.resume);
$('#learnAbort').addEventListener('click', round.abort);
$('#learnLang').addEventListener('change', (e) => round.setLang(e.target.value));

export const refreshLearn = round.refresh;
