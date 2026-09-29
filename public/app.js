// 入口：装配各面板模块，然后读一次词表、设置与两个轮次面板。
import './js/core.js';
import './js/add-words.js';
import { refreshLearn } from './js/learn-panel.js';
import { refreshReview } from './js/review-panel.js';
import { loadEntries } from './js/vocab-list.js';
import { loadSettings } from './js/settings-panel.js';

await Promise.all([loadEntries(), loadSettings(), refreshLearn(), refreshReview()]);
