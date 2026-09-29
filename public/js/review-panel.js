// 复习面板：抽 30 个整词已掌握的词，直接闭卷测，没过的把勾取消。
// 渲染与动作都在 session-ui.js 里（与学习共用），这里只认领本面板的元素。

import { $ } from './core.js';
import { mountRound } from './session-ui.js';

const round = mountRound({ prefix: 'review', mode: 'review' });

$('#reviewStart').addEventListener('click', () => round.start(false));
$('#reviewRestart').addEventListener('click', () => round.start(true));
$('#reviewPause').addEventListener('click', round.pause);
$('#reviewResume').addEventListener('click', round.resume);
$('#reviewAbort').addEventListener('click', round.abort);
$('#reviewLang').addEventListener('change', (e) => round.setLang(e.target.value));

export const refreshReview = round.refresh;
