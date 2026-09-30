// 入口：装配各面板模块，然后读一次词表、设置与两个轮次面板。
import './js/core.js';
import './js/add-words.js';
import { refreshLearn } from './js/learn-panel.js';
import { refreshReview } from './js/review-panel.js';
import { loadEntries } from './js/vocab-list.js';
import { loadSettings, setVocabFileReload, setPanelsReload } from './js/settings-panel.js';

// 设置里换了词表路径，词表面板的数据就过期了——把重新读取接过去。
setVocabFileReload(loadEntries);
// 保存设置也要让学习/复习面板对一遍（反馈语言的默认值、可抽数量的上限都看设置与池子）。
setPanelsReload(() => Promise.all([refreshLearn(), refreshReview()]));

await Promise.all([loadEntries(), loadSettings(), refreshLearn(), refreshReview()]);
