# Vocabulary 助手（VocabApp）

本目录躺着一个零依赖的本地 Node 网页工具，围着 `Vocabulary.md` 这张手工攒的英语词汇表转。加词、判定掌握程度、按义项重校整张表，都交给 AI；词汇表本身仍是唯一数据源。

双击本目录的 `VocabApp.bat` 启动，浏览器会打开 `http://127.0.0.1:5317/`。

本目录的 `Vocabulary.md` 是个软链，通到 Obsidian 库里那份真身。两边都能改，读写之前工具会把它们对齐（§2.7）。

`node --test` 是全部测试，206 条。

这份文档是唯一权威规格：数据格式、决策记录（D1–D24）、模块接口、AI 契约、本地 API、配置密钥、测试与踩坑，全在里面。接手时读完这一份就够了。它合并了早先的 `Vocabulary-app-design.md`、`Vocabulary-format.md`、`Vocabulary-app-handoff.md`，那三份已经删除。

---

## 1. 速览

### 1.1 它解决什么

`Vocabulary.md` 是按首字母分章的纯 markdown 词表，用 Obsidian 打开，遇生词就记一笔。改动有 `backups/` 兜底，目录本身也是 git 仓库，远端在 GitHub（§8）。

手工维护累在两处：每个新词都得自己想英英释义、例句和难度；「背过了」又全凭自我感觉，没有可检验的标准。这两处外包给 AI 之后，markdown 仍要当唯一数据源，于是既不引数据库，也不留平行副本。你在 Obsidian 里手改和工具写盘得能同时存在，整套设计的取舍都从这一条推出来。

### 1.2 五个面板

| 面板 | 做什么 |
|---|---|
| **加词** | 输入单词（逗号或换行批量）→ 逐张草稿卡（义项列表，四项都可改）→ 单条「写入」或「写入全部」 |
| **词表** | 全表 + 两套统计 + 筛选；平时行内直接勾选义项，条目右下角可「考这个词」就地问答（判定不写盘，通过的义项旁有一颗勾选按钮）；打开「复选模式」后可选多个词统一标记掌握状态或重构 |
| **学习** | 随机抽 10 个还有义项没掌握的词：先逐个把整词的义项与例句摊开看一遍（一次只出一个词），看完 10 个再闭卷逐个写英文释义，最后出清单勾选通过的义项 |
| **复习** | 随机抽 30 个整词已掌握的词，直接闭卷逐个写英文释义，最后出清单取消没通过的义项 |
| **设置** | 模型（全平级）、两套提示词覆盖与恢复默认、反馈语言、主题 |

### 1.3 非目标

间隔重复、统计报表、多端同步、账号体系都不在范围内。Obsidian 里手改这条路会一直留着。

---

## 2. 数据格式：`Vocabulary.md`

### 2.1 整体结构

- 按首字母分章节：`### A`、`### B`……词组按**整体**首字母归章（`take ... for granted` 归 T，不看第二个词）。
- 章节内按排序键排：转小写、丢掉所有非字母字符。`s'mores` 成了 `smores`，`a touch of` 成了 `atouchof`，`cliché` 成了 `cliche`，所以 `attic` 落在 `attentive` 之后、`authentic` 之前。
- 某个字母第一次出现词条时才新建该章节，章节之间空一行，文件末尾保留一个空行。

### 2.2 条目：主行只留词头，一条义项一行

```
- angle
  - [ ] #A2 - the space between two intersecting lines - The angle was 45 degrees.
  - [x] #C1 - to fish - He angled his line carefully.
```

- **主行**：`- ` 加词头。主行不带勾选框，掌握状态一律写在义项行上（§2.4）。
- **义项行**：两个空格缩进，接 `- `、`[ ]` 或 `[x]`、`#档位`、` - `、释义，随后可选一段中文、必有一段例句。
- 义项之间平级、同一缩进。行序就是义项顺序，不嵌套，也不分层。
- 每个词至少一条义项行，每条义项必须凑齐释义、档位、例句。少了义项行，整条就等于没有释义，解析会报错、工具拒绝读取。「缺例句」和「缺难度」在这套格式里无处容身，统计里那两个数字恒为 0。
- **不写词性标注**（2026-09-29 取消）。词头与释义里都不出现 `(v.)`、`(n.)` 这类标签。同一个词的不同词性各占一条义项，靠义项区分。`iron (v.)`、`substitute (n.)` 这种写法已经没了，现在就是一条 `iron`。
- AI 建议最多三条义项（手写与编辑不限），最常用的排在最前。

> **只认这一种写法**：带框的主行（`- [x] word`）、不带框的义项行（`  - #B1 · …`）、空框写成 `[]`，一律按语法错误处理。旧表在 2026-09-29 整表迁移完毕，代码里没有兼容分支。

### 2.3 单行规矩

- **释义**：英文，小写开头，末尾不加句号，不超过 8 个词，一行只装一个意思。多义就多开一行，不用 `;` 串。释义里不能出现 ` - `（那会破坏义项行的分段），也不能为空。
- **例句**：不超过 14 个词，日常真实语境，句末带句号（实际落在 7–10 词）。必须用到**词头本身**的屈折形态：`absorbed`、`mows`、`clichés` 都行，但 `admissible` 不能拿 `inadmissible` 充数。
- **词头**：一个词一条词条，不同词性写成它的多条义项。词组里的替位成分写 `...`，如 `take ... for granted`。
- **中文**：默认不写；需要时作为该义项的最后一段（`- 吸收`）。
- **分隔符**：段间固定 ` - `（ASCII 连字符，两侧各一个空格）。义项行的勾选框与 `#档位` 之间是一个空格。

### 2.4 勾选语义：状态只写在义项行上（D22 / 2026-09-29 改版）

- 每条义项行自带勾选框。`  - [ ] #B1 - …` 是未掌握，`  - [x] #B1 - …` 是已掌握。主行不带框，也就不存在什么「整词的框」需要同步。
- 词级的掌握状态是**推导出来的**：所有义项都勾上，这个词才算已掌握。统计和词表里「义项全掌握 / 还有义项没掌握」的筛选都读这个推导值，所以两处数字天然一致。
- 没有义项行的条目无处写状态，勾选会被拒（`noSenses`）。先去「编辑」里补一条义项。
- 每个词独立勾选，近义词、同根词之间不要求一致，工具也不去成对同步。

### 2.5 手工加词步骤

确认不重复，按排序键插到章节内正确的位置，主行写 `- 词头`，紧跟至少一条义项行（`  - [ ] #档位 - 释义 - 例句`）。该字母还没有章节就新建 `### X`，前后各空一行。也完全可以只用工具加词：markdown 是唯一真相，工具每次写盘前重读文件，只碰目标行。

### 2.6 自查清单

- [ ] 章节内仍是严格字母序，章节标题 `### X` 唯一
- [ ] 无重复词头
- [ ] 主行只有词头，没有 `[ ]`、`[x]`
- [ ] 每词至少一条义项行；每条义项凑齐勾选框、CEFR 六档档位、释义、例句
- [ ] 每词独立释义，没有同义词链，没有 `[refer to ...]`；词头与释义里都没有词性标注
- [ ] 释义不加句号、不超过 8 词；例句不超过 14 词、用到词头本身的形态、末尾有句号

### 2.7 写盘的硬约束

- **外科手术式行编辑**：每次写盘都是重新读磁盘、定位目标行、生成 `Edit`、备份、原子写（tmp + rename）。解析器不认识的行、章节标题、空行都不参与序列化，原样保留。整文件重写重排这种事不会发生。
- **编码换行**：固定 UTF-8 无 BOM（文件里有 `cliché` 这类非 ASCII 字符），写前检测现有换行风格并沿用（当前是 LF）。
- **备份**：写前把旧内容存成 `backups/Vocabulary.<ISO 时间>.md`，只留最近 20 份；文件名带自定义后缀的不会被轮转删掉。备份就是撤销入口。
- **链接感知 + 兜底对齐**（2026-09-29 加）：本目录的 `Vocabulary.md` 是库里头真身的链接，两个位置都能改。工具这边分三种情况处理：
  - **软链**：写前先 `realpath` 解析到真身，否则改名会把链接换成普通文件。真身被别的编辑器「写临时文件再改名」保存时，软链指向路径，会自动看到新内容，不必修。
  - **硬链**（`nlink > 1`）：不能用「写临时文件再改名」，因为改名只换掉一个名字，另一个名字留在旧 inode 上，两边内容会悄悄分叉。这种情况改成原处覆盖写。
  - **兜底**：每次读或写之前，`syncMirror()` 先比两边是不是同一个文件（`stat.ino`）。不是同一个（被改名式保存打断过），就**谁的时间戳新听谁的**：镜像新就把镜像内容写回真身，否则用真身刷新镜像，然后照原类型重建链接。重建软链要权限，权限不够退硬链，再不行退普通副本。链接断了也不会真的分叉，最多是「下一次访问时修一下」。
  - 单测覆盖了两种写模式、断链双向修复和软链重建，沙盒里也实测过。
- **写入串行**：进程内单队列，杜绝并发写坏文件。
- **主行多出来的段只认最后一段**：`- word - a - b` 这种（旧同义词链的残留）会把 `b` 当释义，编辑一次就被改写成规范形式。工具不为这类写法做任何特殊处理。

---

## 3. 决策记录

只列**现行**规则，已废止的见 3.2。

| # | 决策 | 理由 / 放弃的选项 |
|---|---|---|
| D1 | 零依赖 Node 本地服务，只绑 `127.0.0.1` | 需要直接读写本地文件，还要把密钥藏住。纯静态单 HTML 的方案放弃了（File System Access 权限每次重授、写回不可靠、密钥落在浏览器里）；Python 服务也放弃了（要装依赖，本机 Python 有编码踩坑史） |
| D2 | 难度用 CEFR 六档 `A1/A2/B1/B2/C1/C2` | 有外部锚点，AI 判定一致性最好，也与英英释义体系对齐。考试标签跨体系归属会冲突，1–5 星没有锚点，都放弃了 |
| D3 | 难度与例句放在缩进子行，主行不动 | 现有条目的排序与阅读体验零影响，AI 写入的数据与人工数据物理隔离 |
| D4 | 外科手术式行编辑，不做全量序列化重写 | 全量重写会把用户手改的、解析器不认识的内容一起覆盖掉 |
| D5 | 判定 PASS **不自动打勾** | 判定只说「对不对」，勾不勾由人点一下「勾选为已掌握」，可以再点撤销。误判不至于直接改动词表状态。这条主张现在落在词表条目里的「考这个词」上 |
| D7 | 调用路径用 `/chat/completions` | `/responses` 是 OpenAI 专有的，DashScope 兼容模式没有；「未来可换模型但保证 openai-compatible」这条要求下，它是唯一公因子 |
| D8 | 不依赖 structured outputs | 跨 provider 可移植性优先；改为提示词约束 JSON，加服务端容错解析（剥代码围栏、取首个平衡的 `{}`） |
| D9 | 中文释义默认不生成，但解析与序列化支持 | 做成加词面板的可选开关，零额外架构成本；需要时作义项的最后一段 |
| D10 | 取消同义词链与 `[refer to ...]`，每词独立释义 | 每个词写自己的释义，意思再近也各自表述 |
| D11 | 勾选状态独立，工具不得成对同步 | 近义词、同根词之间不要求一致 |
| D13 | 判定反馈提供中英开关，默认中文 | 语言只影响 `reason` 与 `suggestion`；判定标准、释义与例句的英文要求不变 |
| D14 | 编辑只改释义、中文、难度、例句、勾选，**不改词头** | 动词头会牵动排序与章节归属，还可能撞出重复词头，风险大于收益。要换词就「加词 + 删除旧行」（D17）。词头只读，里面的旧式多余段会在下次编辑时被规范化 |
| D15 | 轮次作答：每词最多三次机会，跑完统一结算 | 一轮上百条，逐词写盘会产生上百份备份且无法回看；改为作答进度实时写 `.state/session.json`（可暂停、可断点续测），结束时给「将勾选 / 将取消」清单、确认后一次写盘。闭卷模式下 AI 只能返回固定错误码（自由文本一律丢弃），`suggestion` 强制为空，`storedDefinition` 不发给模型，过程中不透答案 |
| D16 | 模型全平级：一切模型配置都在 `settings.json`，`.env` 只放密钥、`VOCAB_FILE`、`PORT`，工具绝不写 `.env` | 不再有 `.env` 默认接入点（`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`VOCAB_MODEL(S)`、`VOCAB_EXTRA_JSON` 全部废除）。`extraModels` 里每个模型自带 `{name, baseUrl, keyName, extra}`，相互平级、没有回退；密钥用 `VOCAB_KEY_名字=…` 存 `.env`，界面只选名字 |
| D17 | 词表可整条删除一个词（主行 + 义项行），两步内联确认 | 破坏性操作，所以「点一次变成『确认删除 xxx』、5 秒内再点一次才落盘」，不用原生弹窗（避免自动化与焦点问题）；写盘前照例备份。与整测不互斥：队列冻结在开始时，中途删掉的词在结算时按 `wordNotFound` 跳过 |
| D18 | CEFR 档位改为查表，模型不再猜难度 | 免费免密钥的官方 CEFR API 不存在（Cambridge EVP 只有网页，Oxford 官方 API 要申请且收费），所以落地为**内置查询表** `data/cefr.json`，分层优先并与许可一起记录（§4.5）。命中不了的记「CEFR 表外」：档位留空、界面标注、由人手动选，绝不回退成 AI 猜测 |
| D19 | 一词多义或多词性用**平级义项行**，每条义项自带 CEFR 档位 | 主行只留词头，每条义项一行同缩进。硬约束是每条义项都必须带释义、档位、例句；整条没有释义就解析报错，写入层对此有兜底与专门的单测。旧式「释义在主行、子行只放例句」的写法从 2026-09-29 起不再兼容（§3.2） |
| D20 | 删掉回填与「重查 CEFR」这类临时需求，词表改为「多选 + 逐词重构」 | 缺例句、缺难度、待规范化筛选，批量回填面板（含 `jobs.js`、`/api/backfill/*`、每批词数设置），以及「重查 CEFR」差异清单，都是当初为存量服务的一次性工具，现在下线；`data/cefr.json` 查表本身保留。词表每行加复选框，可「全选当前筛选」；选中若干词后「重构选中的词」，把该词现有内容（含原始 markdown 行）和查表得到的该词与派生词的参考档位一起交给 AI，返回补齐后的义项与一句改动说明，逐个可勾选、确认后一次写盘一份备份 |
| D21 | 生成草稿与逐词重构合并成同一个核心，档位由 AI 定、参考词表作为佐证 | `ai.sensesEntry({word, current, referenceLevels, withChinese})` 是唯一入口：`current:null` 就是草稿，带上现有内容就是重构；提示词与契约只有一套（`entry`）。返回 `senses[{level, levelBasis, definition, chinese, example}]`，`levelBasis` 必须如实标注 `reference`（档位取自参考词表）或 `judged`（词表没覆盖、AI 自判）。界面逐行显示「查表定档：CEFR-J B1 · Oxford B2」或「AI 判断（参考：…）」，一眼能看出哪些档位是权威、哪些是模型判断 |
| D22 | **掌握程度按义项，不按词** | 掌握状态只写在义项行的勾选框上，主行不带框；词级状态是推导值（所有义项都勾才算已掌握）。统计出词数与义项数两套数字；自测与整测的考核单元是「词 + 义项」，出题显示该义项自己的例句与「义项 n/m」，判定时把该义项的例句一并交给模型（否则非核心义项的正确回答会被误判），结算按义项写框。2026-09-29 改版把原先「多义项才写框、单义项状态留在主行」的做法整表迁移成现在这样，迁移脚本用完即删 |
| D23 | 词表平时只留义项级勾选框，批量操作收进「复选模式」 | 一行里同时挂着多选框、词级 ☑ 和义项框三样东西，读起来吵，也容易点错。改成两副面孔：平时只有义项行自带的框（那是掌握状态的唯一写盘开关），点开「复选模式」才换成词头前的多选框，义项框收起、编辑删除隐去，选中后统一「重构 / 标记为已掌握 / 标记为未掌握」，退出时清空已选。批量改掌握状态走新接口 `POST /api/commit-mastery`，一次写盘一份备份；若让前端循环调 `/api/set-checked`，几十个词会瞬间产生几十份备份，把 20 份的轮转上限冲掉 |
| D24 | 自测与整测都改成「一个词一张卡」 | 原先一题只挂一条义项，卡片上根本看不出这个词还有别的义项，翻到哪条全看运气。现在整词的义项都摆在卡上：本轮要考的逐条作答，其余的作参考摆着、不参与判定也不进结算。整测的队列因此从义项级改成词级（一个词只出现一次），义项级的记录（`word#sense`）、每条三次机会与结算粒度都不动。**留空与「不会」都算不会**：原来 SKIP 只是跳过，现在两者都按不会进结算清单，那颗按钮也就改名「不会」。判定仍逐条调模型，闭卷规矩不变 |
| D25 | 自测与整测换成「学习」与「复习」两种模式 | 用户反馈这两个模式效果不明显，要求换成语义清楚的两件事。**学习**：随机抽 10 个「还有义项没掌握」的词，先逐个摊开整词的义项与例句看一遍（一次只出一个词，看完点「下一个」），10 个看完再进测试段；**复习**：随机抽 30 个「整词已掌握」的词，直接进测试段。两者共用同一个状态机（词级队列、义项级记录、每条三次机会、暂停/继续/放弃、跨重启续测、结算清单一次写回加备份），差别只有三处：抽词池（未掌握 / 已掌握）、有没有看词段、结算方向（学习只勾选、复习只取消，这样学习时那些早就勾上的义项不会被误取消）。**抽词口径按词级**：一个词能否进池只看整词掌握状态，抽中后考它全部义项，与词表「难度按任一义项命中」的口径一致；池子不足就抽多少算多少，一个都没有时明确报「没有不认识的词」。**范围筛选（章节/难度/关键词）与自测的「只从未掌握抽」勾选框一并取消**：两个模式的池子已经由掌握状态定死，再加筛选会让「抽 10 个」这种定量抽词变得不可预测。**「考这个词」搬到词表条目右下角**：点开就地展开答题卡，逐条判定，通过的义项旁给一颗勾选按钮，不点不写盘（沿用 D5 的主张）。代价是自测面板上的「换例句」没了，逐义项生成例句在词表就地编辑里仍在。引擎与路由从 `exam` 改名为 `session`（`session.js` / `/api/session/*`），「整测」这个概念已经不存在，留着旧名会误导；状态文件版本升到 4，旧轮次作废；`GET /api/random` 随之删除，抽词统一由 `POST /api/session/start` 做。答题卡形态相对 D24 不变，只是不再有「本轮不考」的义项（整词全考） |

### 3.1 为什么最小单位是义项

一个词的不同义项难度可以差很远：`angle` 的「角」是 A2，「钓鱼」是 C1。背过一个词的核心义，不代表会用它的冷门义。所以掌握状态、判定、出题都下移到义项，词级那个 `[x]` 只是「全都会了」的汇总。

### 3.2 已废止 / 被取代

- **自测与整测两种模式**（连同自测的「就考这个」、每行的「换例句」、按章节/难度/关键词抽一轮与「只从未掌握抽」勾选框）：2026-09-30 被 D25 换成「学习」与「复习」。判定不写盘这条主张仍在（D5），落地位置改成词表条目里的「考这个词」。`GET /api/random` 一并删除。
- **整测的词级队列状态文件 `version: 3`**：D25 起状态文件为 `version: 4`，v3 及更早的进度一律当作没有进行中的轮次。
- **整测的义项级队列**（一题一条义项、状态文件 `version: 2`）：被 D24 换成词级队列后不再读取，旧进度一律当作没有进行中的轮次。
- **整测卡上的「生成新例句 / 替换表内例句」**：2026-09-30 移除。闭卷考试里生成例句等于把答案摆出来；后来自测那一侧的「换例句」也随 D25 一起没了，逐义项生成例句在词表就地编辑里仍在。
- **D6 存量回填**（网页面板、分批串行）：被 D20 下线，相关代码与设置项已删。当年的存量条目早已全部补完，勾选状态没被动过。
- **D12 规范化面板**：取消。同义词链与 `[refer to ...]` 早在 2026-09-06 手工拆完，解析器也不再为这类写法保留特殊分支。
- **旧式义项写法**（释义放主行、子行只放例句 `#级别 · 例句`、义项行不带勾选框、空框写成 `[]`）：2026-09-29 起不再兼容，一律按语法错误拒绝读取。迁移是一次性的（整表改写，备份在手），代码里没有兼容分支。
- **批量回填 / 重查 CEFR / 每批词数设置**：见 D20，已从代码、接口与界面移除。
- **词性标注**（在词头或释义里写 `(v.)`、`(n.)`，或不同词性分开建条目）：2026-09-29 取消。同一词的不同词性改用多条义项表达；`cefr.js` 里「按尾部括号选词性条目」的查询侧提示也一并删掉（括号内容现在只当噪声剥掉，带旧标注的词头仍能查到档位），各权威表里按词性分列的档位仍在 `describe()` 里给 AI 当参考。

---

## 4. 实现

### 4.1 模块与依赖方向

```
浏览器 (127.0.0.1:5317)
  public/index.html · public/style.css         五面板 UI，无框架、无路由、无构建
  public/app.js                               入口：装配下面这些模块，再读一次数据后启动
  public/js/core.js                           基础层：$ / api / toast / state / 面板切换
  public/js/sense-ui.js                       义项公共零件：编辑行 / 答题行 / 义项档位标签
  public/js/vocab-list.js                     词表：统计·列表·就地编辑·复选批量·重构·考这个词
  public/js/add-words.js                      加词：粘贴 → 出卡 → 写入
  public/js/session-ui.js                     学习与复习共用：看词卡·答题卡·结算清单·判定反馈
  public/js/learn-panel.js                    学习：先看后考两段
  public/js/review-panel.js                   复习：抽完直接考
  public/js/settings-panel.js                 设置与主题
        │ fetch JSON
        ▼
server.js     HTTP 服务 · 路由表 · 请求校验 · 错误封装 · 写入队列（末尾是 CLI 启动块）
   ├── vocab.js     纯字符串层：parse / serialize / sortKey / plan* / applyEdits
   ├── store.js     文件层：读 / 备份 / 原子写 / 软硬链处理与兜底对齐 / 串行队列 / createStateFile
   ├── config.js    .env 解析（密钥、词表与备份/设置/状态/CEFR 路径、端口）
   ├── settings.js  运行期偏好：DEFAULTS / createSettings（白名单校验）
   ├── ai.js        网络层：chat / sensesEntry / judgeEntry / exampleEntry / testTarget
   ├── cefr.js      CEFR 查表：parseQuery / createIndex / lookup / describe / sourceLabel
   └── session.js   学习/复习轮次状态机：mode / phase / queue / records · 三次机会 · 结算清单 · 一次写盘
        │
        ▼
   Vocabulary.md + .state/session.json + settings.json + data/cefr.json → OpenAI 兼容 /chat/completions
```

依赖是单向的：`server → {ai, session, cefr, settings} → {vocab, store}`。`vocab.js` 不 import 任何模块、不读文件、不碰网络，这是它能被纯字符串单测覆盖的前提，改动它必须只靠单测验证。`config.js` 只解析环境与路径，不碰业务；`store.js` 只管「怎么安全地读写那一个文件」，对词表长什么样一无所知。

前端也是一条单向链，没有环：`app.js → {vocab-list, add-words, learn-panel, review-panel, settings-panel} → {session-ui, sense-ui} → core`。面板模块各自认领自己的 DOM（`addEventListener` 写在模块里，`app.js` 只负责 import 与启动），数据刷新统一走 `vocab-list.js` 的 `loadEntries()`，跨面板的共享状态只有 `core.js` 的 `state` 与 `settings-panel.js` 的 `settings`。词表的 `selected` 与 `selectionMode` 是 `vocab-list.js` 私有的，别的面板改掌握状态一律回头调 `loadEntries()`，不直接碰它。档位常量 `CEFR` 只有 `core.js` 一份，前端任何地方都从这里取。

数据侧另有两个非运行期资产：`tools/build-cefr-data.mjs` 把 `data/sources/` 的原始清单编译成 `data/cefr.json`（随代码提交，便于复现），以及 `backups/` 里的历史快照。

### 4.2 vocab.js（纯字符串层）

| 函数 | 签名 | 说明 |
|---|---|---|
| `parse` | `(text) → {entries, chapters, errors, stats}` | 全量解析；`entries` 带 `lineStart/lineEnd/childLines/senses[]` 供行编辑定位；`stats` 含词级与义项级两套计数 |
| `sortKey` | `(word) → string` | 见 §2.1 |
| `serializeHead` / `serializeSense` | `(entry/sense) → string` | 主行（`- 词头`）/ 义项行（带勾选框的完整形式） |
| `planInsertEntry` | `(text, entry) → Edit` | 新词插入（按排序键定位，必要时新建章节）；只接受带 `senses` 的条目，平坦字段（definition/difficulty/example）会先折成一条义项 |
| `planSetChecked` | `(text, word, checked) → {edits, noop}` | **词级**勾选，等于把该词所有义项设成同一状态（内部转调下面的批量版） |
| `planSetSenseChecked` | `(text, word, index, checked) → {edits, noop}` | **义项级**勾选，只改那一条义项行 |
| `planSetSensesChecked` | `(text, word, [{index, checked}]) → {edits, noop}` | 批量版，一次写多条义项，轮次结算用。没有义项行的条目返回 `noSenses` |
| `planSetEntry` | `(text, word, patch) → {edits, noop}` | 行内编辑：`patch.senses` 重写整段义项；只给平坦字段时替换第一条，其余义项原样保留 |
| `planSetSenses` | `(text, word, senses) → {edits, noop}` | 只重写该词的义项块，主行不动（`/api/commit-senses`） |
| `planDeleteEntry` | `(text, word) → {edits, removed}` | 整条删除（主行 + 全部义项行） |
| `applyEdits` | `(text, edits[]) → string` | 按行号倒序应用，避免位移失效；区间重叠、插入点落在替换区间内、越界，一律抛错 |

`Edit = {type: insertBefore | insertAfter | replace, lineStart, lineEnd, newText, word}`。任一 plan 函数遇到目标缺失、重复词头或解析错误，返回 `{error}`，调用方必须拒绝写盘；义项字段不合规（缺释义、缺例句、档位非法、中文段不是中文）同样返回 `{error}`，错误码见 §4.9。

写盘有个通用约定：**只有内容真的变了才产生 edit**。`noop` 为真时服务端不写盘也不备份，前端会收到 `backup: null`。

### 4.3 store.js / config.js / settings.js

- **store.js**：`readFile()`、`writeWithBackup(text)`、`enqueue(fn)`（串行队列）、`listBackups()`、`selfCheck()`、`createStateFile({file})`（原子 JSON 写，用于考试进度与设置）。启动时校验词表存在可写，并做一次 `parse` 自检；失败就拒绝启动并打印错误行号。
- **config.js**：`loadConfig()` → `{dir, envFile, keys, keyNames, vocabFile, vocabMirror, cefrFile, backupDir, settingsFile, stateDir, port}`。密钥**只**来自 `VOCAB_KEY_*`；可覆盖的路径类环境变量见 §5。`vocabMirror` 只在 `VOCAB_FILE` 与本目录那份 `Vocabulary.md` 经 `realpath` 比对后确实是同一个文件时才给出，否则为 `null`：指到别处（沙盒副本、换台机器）时镜像必须关掉，否则两边 inode 不同，兜底逻辑会按时间戳把一份的内容盖到另一份上。
- **settings.js**：`DEFAULTS = {model:null, extraModels:[], lang:'zh', theme:'auto', prompts:{entry:null, judge:null}}`。`patch()` 做白名单校验，非法值报 `400 badSettings`，文件损坏时报 `settingsError` 且不静默覆盖。`normalizeModel` 要求 `name`、http(s) 的 `baseUrl`、`keyName`（必须对应 `.env` 里已有的密钥名），可选 `extra`（JSON 对象，≤2000 字符）。提示词键只有 `entry` 与 `judge`，空串等于恢复默认，不认识的键直接忽略。`modelEndpoints({settings, keys})` 把模型映射成调用目标。

### 4.4 session.js（学习 / 复习轮次）

- 一轮只有两种模式：`mode: 'learn'` 抽 10 个「还有义项没掌握」的词，`mode: 'review'` 抽 30 个「整词已掌握」的词。**抽词按词级**：一个词能否进池只看整词掌握状态，抽中后它**全部**义项都进队列，所以队列里不存在「本轮不考」的义项。池子不足就少抽几个，一个都没有时报 `400 emptyScope`。没有范围筛选，池子只由模式决定。
- 学习模式分两段：`phase: 'study'` 时一次只交回一个词（`study: {index, total, word, chapter, senses[]}`，每条义项带档位、释义、例句、中文与 `checked`），看词段只推进游标，不判分也不写盘；`POST /api/session/study/next` 推到底自动转 `phase: 'test'`。复习模式没有看词段，开局就在 `test`。
- 队列是**词级**的：`queue: [{word, senses:[…]}]`，洗牌之后一个词只出现一次；`records` 仍用 `word#sense` 做键。状态文件只认 `version: 4`，读到别的一律当作没有进行中的轮次；中途被删的词留在队列里，轮到它时被直接跨过去。
- 测试段里 `current()` 交回一整张卡：`{word, chapter, senses[], open, done, index, total, maxAttempts}`。每个义项是 `{sense, level, example, checked, result, via, reason, attempts, attemptsLeft}`。卡片**永远不暴露表内释义**。
- 每条义项最多 3 次机会。交卡时逐条处理：给了释义的调模型判，**留空的直接记「不会」**（不花模型调用），已经判出来的义项不再重复判。上游半路报错时把已判出来的先落盘再抛出，重交不会重复花钱。
- 界面上那颗「不会」按钮走 `skip`，把单条义项直接记成不会，同样不花模型调用。
- 一整张卡判完了才允许翻页（`advance`，还有义项悬着时 `409 examOpen`）。翻页不自动：卡片留在原地，让你先看完每一条的反馈。
- 结算 `preview` 出「将勾选 / 将取消 / 跳过」清单（每项带 `word`、`sense`、`level`），按词聚合后一次 `planSetSensesChecked` 写盘、一份备份。**方向由模式定**：`learn` 只把**通过**的义项列为「将勾选」（判过但没通过的那条本来就没勾，不动它），`review` 只把没通过的列为「将取消」，这样学习时那些早就勾上的义项不会被误取消。中途被删的词按 `wordNotFound` 跳过，不卡写盘。
- 可暂停（`paused`，之后作答、推进看词与结算一律 409，直到继续；看词段也能停下再接着看）、可放弃（词表零改动）、可强制重开。

### 4.5 cefr.js（查表定档，D18）

`createCefr({dataFile})` → `{lookup(word), sources(), describe(word)}`。

- `lookup(word)` 的顺序：① `parseQuery` 归一（小写、压空格、去标点；括号里的内容一律当噪声剥掉，所以带旧式 `(v.)` 的词头仍能查到）② 依次查 CEFR-J、Octanove、Oxford、Oxford Phrase List，同一个词有多个词性条目时取最低档并在 `label` 里注明 ③ 单词查不到就做**词形归并**再回查前三张表（`accounting→account`、`strengths→strength`），标签「词形归并自 X」④ 仍查不到就做**词根推测**（surface → lemma → family）：剥构词后缀（-ful/-less/-able/-ible/-ive/-al/-ic/-ment/-ness/-ity/-ance/-ent/… 含 -iness→y 这类变形）与常见前缀（un-/in-/im-/re-/dis-/de-/over-/under-/out-/mis-/pre-/non-/co-/sub-/inter-/super-…），最多迭代两轮，前后缀可以混着剥（`reopen→open`、`underappreciated→appreciate`、`coworker→work`、`heroic→hero`），标签「词根推测自 X」⑤ 仍查不到但在常用 2 万词内，就按词频标定区间给档，标注「按常用度推算（第 N 位）」⑥ 全都不中，`level: null`，界面显示「CEFR 表外」。第 ③④ 层只认权威表、不碰词频，剥出来的词根不在表里就老实标表外：`feckless` 不会因为 -less 被算成 `feck`。
- `describe(word)` 是给 AI 的参考：该词在各表里的档位（含按词性分列的条目）、**派生词**命中的档位（每项带 `via: 'lemma' | 'root'`，界面据此写「词形归并」或「词根推测」）、常用度排名。草稿与重构都会把它随请求一起发出去，界面据此显示档位依据。
- 数据在 `data/cefr.json`（运行期只读，头部带 `version` 与 `sources`；版本不认识时直接报错，不会猜着用）。源清单在 `data/sources/`，重建命令 `node tools/build-cefr-data.mjs`。
- 五张来源与许可：**CEFR-J Vocabulary Profile 1.5**（Tono Laboratory / TUFS，可免费用于研究与商用，**须注明出处**）、**Octanove Vocabulary Profile C1/C2 1.0**（CC BY-SA 4.0）、**The Oxford 3000/5000** 与 **The Oxford Phrase List**（Oxford University Press，仅个人自用、不对外分发）、**google-10000-english 20k 词频表**（只取排名）。
- 分层区间的标定办法：拿已知词对的词频排名取每档**中位数**，相邻档中位数的中点作分界，写进 `data/cefr.json` 的 `freqBands`。单测校验边界严格递增，且末段覆盖到 20000。

### 4.6 ai.js（网络层与契约）

- `chat(messages, {model, maxTokens, temperature=0})` → 文本。统一走 `POST {所选模型的 baseUrl}/chat/completions`；模型必须出现在 `settings.json` 的 `extraModels` 里，否则报 `aiConfig` 并点名是哪个模型；`baseUrl` 末尾误带 `/chat/completions` 会被剥掉。`Authorization: Bearer` 用该模型 `keyName` 对应的 `VOCAB_KEY_*`，body 附加参数只来自该模型自己的 `extra`。超时 90s，失败重试 2 次（退避 1s/3s），**仅**对网络错误与 5xx/429 重试，4xx 不重试。**上游返回空内容也算可重试**（`aiEmpty`）：`content` 是空串多半是一次坏生成，推理段吃光预算或网关抽风都有可能，报错文案里带上 `finish_reason` 与用量，下次一眼能看出是哪一种。
- `parseJsonTolerant`：剥代码围栏、取首个平衡的 `{...}`、单元素数组拆包。解析不出来就报错，不猜。要 JSON 的那三处（`sensesEntry` / `judgeEntry` / `exampleEntry`）在解析失败时**再要一次**，并把原始内容打到服务窗口（`[ai]` 开头）：一次坏生成不值得记成判定失败，留一行日志下次就不用靠猜。

**① 补齐义项 `sensesEntry({word, current, referenceLevels, withChinese})`（草稿与重构共用）**

- 输入：`word`；`current`（现有条目 `{checked, headDefinition, headChinese, senses[], rawLines[]}`，草稿时为 `null`）；`referenceLevels`（即 `cefr.describe(word)`）；`withChinese`（重构时若现有条目已有中文，服务端自动置真）。
- 输出 `{word, senses[{level, levelBasis, definition, chinese, example}], note}`，最多三条义项，最常用在前。服务端校验：档位必须属于 CEFR 六档，释义与例句非空，释义里不能含 ` - `；`levelBasis` 只认 `reference` 与 `judged`，缺省按 `judged`。
- 提示词规则写在 `ENTRY_RULES`：最多 3 条义项；definition 不超过 8 词、小写、无句号、无 ` - `；chinese 2–6 字（仅当要中文）；example 不超过 14 词且含词头屈折形；不得改词头；不得把两个意思或两种词性并成一条；**不得写 `(v.)`、`(n.)` 这类词性标注**；不得把档位当释义输出；`note` 用一句中文说明改了什么。
- 落盘走 `planSetEntry(senses)` 或 `planInsertEntry(senses)`，与编辑表单同一条路径。

**② 判定 `judgeEntry({word, userDefinition, userExample, storedDefinition, targetExample}, {lang, exam})`**

```json
{"pass":true,"reason":"释义抓住核心义；例句用法正确。","suggestion":"可以试试及物以外的用法：absorb information"}
```

- 释义：命中该词的核心义就算对，措辞不同、更宽泛都行。义项跑偏、写成中文、只写词性标注，判 fail。
- 例句：只判「这句话能不能证明你知道词义」。**语法小错、别扭表达、冠词缺失或误用、时态与单复数不一致、搭配不自然、把词用作其他词性，都不作为判错理由**（2026-09-11 定的口径）。例句 fail 只有三种情况：句子里根本没用到该词；句子体现的意思是错的或无关的；词拼写到认不出来。
- 例句可选，留空就只判释义，系统提示追加一句「本次没有例句，只判释义」。
- `storedDefinition` 只作「参考、可能不完美」，AI 主要依据自身词知识判定。
- `targetExample` 是**本次问的是哪条义项**的依据（学习、复习与词表的「考这个词」都传该义项的例句）。多义项缺了这个信息，正确回答会被误判成跑偏。
- `lang` 取 `zh`（默认）或 `en`，只决定 `reason` 与 `suggestion` 的语言，非法值回落 `zh`。`storedDefinition` 由服务端自己从文件读，不接受前端传入。
- **闭卷模式**（`exam:true`）有硬约束：`reason` 只能是固定代码 `ok | sense-off | word-not-used | wrong-pos | spelling | partial | unspecified`，服务端把任何自由文本丢弃并归为 `unspecified`，界面按代码出中英双语固定文案；`suggestion` 恒为空；`storedDefinition` 不发给模型。原因很实际：实测模型会把中文释义写进点评，光靠提示词管不住。

**③ 生成例句 `exampleEntry(word, definition)`** → `{example}`，单句不超过 14 词、含词头屈折形。只在用户点「生成例句」时调用，它只把新句子填进输入框，真写进表里仍走 `POST /api/commit-edit`。

**④ 连通性检测 `testTarget({baseUrl, apiKey, model, extra})`** → `{ok, model, baseUrl, latencyMs}`，设置页「测试连通」用。

### 4.7 本地 HTTP API

统一响应：成功 `200 {…}`；失败 `{error:{code,message,details?}}` 加 4xx/5xx。所有写接口内部都走 `store.enqueue`。

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/entries` | — | `{entries[], stats{total,checked,unchecked,senses{total,checked,unchecked},missingExample,missingDifficulty}}`；`checked` 是词级的「义项全勾」，每个 `senses[]` 项自带 `checked` |
| `POST /api/draft` | `{word, withChinese?, model?}` | `{word,senses[],note,referenceLevels}`；与重构共用 `sensesEntry`（D21） |
| `POST /api/example` | `{word, definition?, model?}` | `{example}` |
| `POST /api/commit-add` | `{word, senses:[{level,definition,chinese?,example?,checked?}], checked?}`；也接受平坦的 `{definition,difficulty,example,chinese?}`（折成一条义项） | `{entry,backup}`；词已存在 `409 wordExists`；缺释义/缺例句/档位非法 `400` |
| `POST /api/commit-edit` | `{word, checked?, senses:[{level,definition,chinese?,example?,checked?}]}`（重写整段义项）；或平坦的 `{word, definition, difficulty, example, chinese?}`（只改第一条义项，`chinese:null` 删该段、不传保持原值） | `{entry,backup,noop}`；无变化不写盘；义项缺释义/缺例句或档位非法 `400` |
| `POST /api/commit-senses` | `{word, senses[]}` | `{entry,backup}`；只重写义项块、主行不动；空数组 `400 badSenses`、词不存在 `404` |
| `POST /api/commit-delete` | `{word}` | `{word,removed,stats,backup}`；删主行 + 全部义项行，写盘前备份 |
| `POST /api/judge` | `{word, sense?, userDefinition, userExample, lang?}` | `{pass,reason,suggestion,sense,checked,backup:null}`；**判定本身不写盘**；`storedDefinition` 与 `targetExample` 由服务端自己读取 |
| `POST /api/set-checked` | `{word, sense?, checked}` | `{ok,word,sense,checked,backup}`；`sense` 缺省 0；状态本就一致时不写盘（`backup:null`） |
| `POST /api/commit-mastery` | `{words:[...], checked}` | `{changed,skipped:[{word,reason,message}],backup}`；**词级**掌握状态，一次写盘一份备份；查不到的词进 `skipped` 且不影响其余；全都没变化时 `backup:null` |
| `POST /api/refactor` | `{word, model?}` | `{word,current,senses[],checked,note,referenceLevels,writeable,error}`；只给建议不写盘；词不存在 `404`、无模型 `503` |
| `POST /api/refactor/commit` | `{items:[{word,senses[],checked?}]}` | `{changed,failed[],backup}`；逐词走 `planSetEntry`，一次写盘一份备份；写不进的词进 `failed` 并带原因 |
| `GET /api/session` | — | `{state,current,preview,study}`；没有进行中的轮次时 `state/current/preview` 皆为 `null`；`state` 带 `mode` 与 `phase`，学习模式的看词段另有 `study: {index,total,word,chapter,senses[]}` |
| `POST /api/session/start` | `{mode:'learn'\|'review', model?, lang?, force?}` | `{state,current,study}`；`mode` 非法时 `400 badMode`；池子里一个词都没有时 `400 emptyScope`；已有进度需 `force` |
| `POST /api/session/study/next` | `{}` | `{ok,study,phase,current}`；推进看词游标，推到底自动转测试段；复习模式或已在测试段时 `409` |
| `POST /api/session/answer` | `{word, answers:[{sense, definition}]}` | `{word, results:[{sense,pass,reason,resolved,via,attemptsLeft}], done, open, nextWord}`；**不含 suggestion**；没给释义的义项按「不会」记，那条的 `via` 是 `none`，仍未判完的义项不返回表内释义 |
| `POST /api/session/skip` | `{word, sense}` | `{word,sense,resolved:'fail',via:'skip',reason,done,open,nextWord}`；界面上就是「不会」，不花模型调用 |
| `POST /api/session/next` | `{}` | `{ok,cursor,finished,current}`；卡上还有义项没判完时 `409 examOpen` |
| `POST /api/session/reveal` | `{word}` | `{word, senses:[{sense,level,result,via,reason,attempts,definition,chinese,example}]}`；只给已判完的义项，一条都没判完时 `409 examLocked`，词表里没这个词 `404` |
| `POST /api/session/pause` `…/resume` `…/abort` | `{}` | 暂停保留全部进度；暂停后作答、推进看词与结算 `409 examPaused`；放弃不改词表 |
| `POST /api/session/lang` | `{lang}` | `{ok,lang}`；即时改本轮反馈语言并落盘 |
| `POST /api/session/preview` `…/commit` | — / `{}` | 清单 `{add[],remove[],unchanged,skipped[],total}` / 结算结果 `{changed,backup,state,…}`，`add/remove` 每项是 `{word,sense,level}`；清单方向由本轮的 `mode` 决定 |
| `GET/POST /api/settings` | 任意设置子集 | `{settings,settingsError,defaults,promptDefaults,contracts,models,keyNames,modelRoutes,envFile,settingsFile,vocabFile,hasKey}`；非法值 `400 badSettings` |
| `GET /api/backups` | — | `{files[]}` |
| `POST /api/open-config` | `{which:'env'\|'settings'}` | `{ok,file}`；用系统编辑器打开配置文件（不改内容） |
| `POST /api/test-model` | `{model?, baseUrl?, keyName, extra?}` | `{ok,model,baseUrl,latencyMs}`；密钥名不存在 `400 badKeyName` |

### 4.8 UI

单页五标签（加词 / 词表 / 学习 / 复习 / 设置），无框架、无路由、无构建。右上模型下拉对加词、学习与复习生效，默认取设置里的模型；任何写操作之后都有 toast 提示备份文件名。

前端按面板拆成 `public/js/` 下的八个模块（见 §4.1 的依赖图），`app.js` 只剩 import 与启动那几行。拆分的取向是「谁的面板谁认领」：每个模块在自己的作用域里给元素挂监听、渲染自己那块的 DOM，共享的只剩 `core.js`（`$` / `api` / `toast` / `state` / CEFR 常量 / 面板切换）、`sense-ui.js`（义项编辑行与答题行，词表、加词、学习、复习四处都要用，形状必须一致）和 `session-ui.js`（学习与复习共用的看词卡、答题卡、结算清单与判定反馈）。这样改一个面板不必再在同一份文件里往上翻一千行。

- **加词**：单词输入框（支持逗号或换行批量）加「附中文释义」开关，逐个出草稿卡片。草稿卡就是**义项行列表**，与编辑表单同一板块：每行是难度、释义、中文、例句，加上「生成例句」「删除」，行下标注档位依据（「查表定档：CEFR-J B1 · Oxford B2」或「AI 判断（参考：…）」），可「+ 添加义项」。单条「写入」或「**写入全部**」；缺例句或第一条没释义的会跳过并汇总原因。成功后卡片变灰、显示落点章节，词已存在则给「定位到该条」。
- **词表**：顶部六块统计砖（词数、义项数、已掌握与未掌握的词/义项各一块），左边栏底部另有一份掌握进度条。工具栏是搜索、章节、难度、掌握状态（**义项全掌握 / 还有义项没掌握**），加一个「复选模式」开关。**难度按义项算**：只要该词有任意一条义项命中所选档位就算命中；词头那行不标档位，档位只属于义项。每条义项行**行首各有自己的勾选框**，点一下即写盘并刷新，那是掌握状态的唯一入口。条目右下角另有一颗「考这个词」：点开就地展开答题卡，逐条填英文释义、逐条判定（走非闭卷那一支，判完给出表内对照与建议），通过的义项旁给一颗「勾选为已掌握」，**判定与展开都不写盘**，写盘只发生在你点那颗勾选按钮时，可以再点撤销；点了勾选不会把卡片冲掉，按「收起」回到词表行时才连统计一起刷新。点开「复选模式」后换一副面孔：义项行的框不再出现，词头前面长出多选框，行尾的「编辑」「删除」与「考这个词」也收起来；工具栏出现「全选当前筛选」，底下多一条操作栏（已选 N 个词、标记为已掌握、标记为未掌握、重构选中的词、清空选择）。批量标记走 `POST /api/commit-mastery`，几十个词也只写一次盘、只出一份备份。再点一次「退出复选」回到平时的样子，已选会清空。
- **多选 + 逐词重构**：选中若干词后点「重构选中的词」，前端逐个调 `POST /api/refactor`（进度显示「重构中 i/N：word」），建议落进下方面板：每行是复选框、词头、旧档 → 新档、新义项逐条（级别/释义/中文/例句）、改动说明、参考档位（含派生词），**默认全勾**。「确认写入」一次写盘一份备份，写不进的词标出原因，完成后刷新列表并清空选择。
- **单词编辑**：行内表单就是义项列表，每行有自己的勾选框、难度、释义、例句、可选中文，可「+ 添加义项」、逐行删除、逐行「生成例句」，另有一个「全部义项已掌握」批量勾（勾它等于把每行都勾上）。**每行都必须有释义和例句**，缺哪一行会就地提示。词头只读；保存等于一次写盘加一份备份，主行只写词头、每条义项写成自己那一行。词头里多出来的旧式段会在保存时被规范掉。
- **删除该词**：点一次「删除」变成红色的「确认删除 xxx」，5 秒内再点一次才落盘（超时自动解除，不弹窗）。一次移除主行与全部义项行，写盘前自动备份，toast 给备份文件名。学习或复习跑到一半删掉的词不会卡住结算。
- **学习**：工具栏只有反馈语言与「开始学习」。点一下就从「还有义项没掌握」的词里随机抽 10 个，进**看词段**：一次只出一个词，卡上是词头、`### 章节`、`第 i/N 个词` 与这个词**全部**的义项（档位、释义、例句，已经勾上的标「已掌握」当参考），按钮是「下一个 →」，第 10 个之后变成「开始测试这些词」。看词段不判分、不写盘，刷新或重启能接着看。看完进**测试段**：闭卷，一个词一张卡，释义遮住，每条义项一行——档位、例句、一个英文释义输入框，行尾一颗「不会」。填哪条判哪条，**留空与点「不会」都算不会**，两种都进结算清单；某条判错但还有机会时，行上保留你写的释义并标「还剩 n 次」，改一改可以再交一次。整张卡判完才出现「下一个词 →」，不自动翻页，方便你先把反馈看完。10 个词判完出清单：**通过的义项进「将勾选」**，勾选确认后一次写盘、一份备份。工具栏可切反馈语言（写进本轮状态、刷新后保持）、「暂停」（保留全部进度并落盘）／「继续本轮」／「放弃本轮」／「放弃并重开」；本轮还在跑时「开始学习」会收起来，要重来就点「放弃并重开」。进度实时落盘，刷新或重启服务都能接着考；池子里不足 10 个词就抽多少算多少。
- **复习**：工具栏同样只有反馈语言与「开始复习」。从「整词已掌握」的词里随机抽 30 个，**没有看词段**，直接进测试段——卡片、判定与翻页跟学习模式同一套。出清单时方向相反：**没通过的义项进「将取消」**，勾选确认后一次写盘、一份备份。其余（每条三次机会、暂停、跨重启续测、结算要勾选确认）与学习模式一致。**同一时刻只有一轮**：学习那轮没结束时，复习面板会写「学习模式的那一轮还没结束，去『学习』面板接着做」，这时点「开始复习」会被服务端挡下并说明原因。
- **设置**：默认模型（候选来自 `settings.json` 的 `extraModels`）、两套提示词覆盖与「恢复默认」（补齐义项、判定；清空即默认，固定契约只读展示在最后）、反馈语言、主题。模型区可「添加」「测试连通」「打开 .env」「打开 settings.json」，并明确提示工具不写 `.env`。
- **深浅色**：`html[data-theme]` 加 CSS 变量。`auto` 跟随 `prefers-color-scheme`，头部按钮在浅色、深色、跟随系统之间循环并写回设置；`<head>` 内联脚本先读 `localStorage` 定色，避免首帧闪白。
- **窄屏（≤920px）**：左侧栏收成顶部一条横向导航（品牌名藏起来、导航项的小字注释也藏起来），这条**吸顶**，往下滚也能直接切面板；掌握概览压成一行「共 N 词 · M 条义项」，两张进度条在窄屏下不显示（数字去词表的统计砖看），因为它自带 111px、是顶部显得特别大的主因。面板名那张顶栏（`.topbar`）在窄屏下改成随页面滚走，不再吸顶——两行都吸会永久吃掉一百多像素。义项行也在这档改版式：例句独占一行，释义跟在档位后面占满余下的宽度。

### 4.9 错误处理矩阵

| 场景 | 行为 |
|---|---|
| AI 返回非法 JSON | 容错解析；解析不出来再要一次；仍失败 → 报 `aiJson`，不写盘 |
| AI 返回空内容 | 判为可重试（`aiEmpty`），退避后重试；三次都空才报错，不写盘 |
| AI 返回非法 difficulty | 归一化（`b2`→`B2`）；归一不了 → 该义项丢弃 |
| AI 回显 word 与请求不符 | 该条丢弃，不做模糊匹配 |
| 词头重复（两章同词） | 拒绝写入，`409 duplicateWord`，要求人工确认 |
| 目标行区间解析失败 | 拒绝写盘，返回错误行号 |
| API 429/5xx/网络 | 退避重试 2 次。仍失败：学习与复习里该题不算作答、不消耗次数（可以再点一次）；加词与重构里该词进失败清单，不中断其余词 |
| 写盘抛错 | 保留原文件不动，报错 |
| Obsidian 同时改了文件 | 每次写前重读磁盘并重新定位锚点，不覆盖无关行；目标词行被删则 `404` 并跳过 |
| 义项序号越界 | `400 badSense`（`sense` 不是非负整数，或超出该词的义项数） |
| 条目没有任何义项行 | 勾选与编辑被拒：`400 noSenses`（先补一条义项） |
| 开轮次时 `mode` 不是 `learn`/`review` | `400 badMode` |
| 开轮次时池子里一个词都没有 | `400 emptyScope`（学习看「还有义项没掌握」的词，复习看「整词已掌握」的词） |
| 交卡时义项序号不在本轮的词里 | `400 badSense`（范围和顺序都以服务端的队列为准） |
| 交卡没带 `answers` 数组 | `400 badAnswers` |
| 看词段点「下一个」但已经在测试段 / 本轮是复习 | `409 examOutOfOrder` |
| 卡上还有义项没判完就要翻页 | `409 examOpen` |
| 对已经判完的义项再点「不会」 | `409 examDone` |
| 义项缺释义 / 缺例句 / 档位非法 / 中文段不是中文 | `400 badDefinition` / `badExample` / `badDifficulty` / `badChinese`，整个请求不写盘 |
| 文件写成旧格式（带框主行、义项行没框、`[]` 空框、`·` 子行） | 解析报 `malformedHead` / `malformedChild` → 拒绝读取（`/api/entries` 500 `parseErrors`），修好再开 |

---

## 5. 配置与密钥

`.env` 只放密钥、词表路径与端口，由你手工维护，工具绝不写它，改了要重启服务才生效：

```
# 密钥，名字自取（settings.json 里每个模型用 keyName 指向其中一把）
VOCAB_KEY_QWEN=<DashScope 的 key>
VOCAB_KEY_ZHIPU=<智谱的 key>

# 词表位置。推荐指向 Obsidian 库里的真身，Obsidian 手改和工具写入都走它
VOCAB_FILE=<你的词表绝对路径，例如 D:/Notes/Vocabulary.md>

PORT=5317
```

- **不要把 key 打进 shell 命令行。** 权限层会拦，而且没必要，服务端自己读。
- `VOCAB_FILE` 留空或指向本目录时，默认用本目录的 `Vocabulary.md`，也就是那个软链。换机器、把整个文件夹拷过去就能独立跑（见 §8 的「复制到别处」）。
- **模型全平级（D16）**：`settings.json` 的 `extraModels` 里每条是 `{name, baseUrl, keyName, extra}`。`baseUrl` 必填，是该模型自己的 http(s) 接入点，末尾误带 `/chat/completions` 会被剥掉；`keyName` 必填，必须对应 `.env` 里某把 `VOCAB_KEY_名字`；`extra` 是可选的每模型附加参数 JSON 对象。不同厂商的互斥参数就靠它解决：qwen3.8-flash 带 `{"enable_thinking":false}`，智谱填 `{}` 即不带附加参数。按条目取接入点与钥匙，配错就报错并点名。
- **密钥值只留在服务端**：`settings.json` 与所有 `/api/*` 响应里出现的都只是密钥名字，值不会露面，前端代码里也没有。加新模型等于 `.env` 加一把钥匙（如果还没有），再去设置页添一条带接入点的模型。
- 其余可覆盖路径（一般用不上，测试沙盒用）：`VOCAB_BACKUP_DIR`、`VOCAB_SETTINGS_FILE`、`VOCAB_STATE_DIR`、`VOCAB_CEFR_FILE`。
- 已知坑：DashScope 兼容模式下 qwen3 系列在非流式请求里带 `enable_thinking:true` 会报错，所以给这类模型配 `"extra": {"enable_thinking": false}`；OpenAI 官方端点会拒绝未知参数，对应模型的 `extra` 里别放它。
- 提醒：key 曾在对话里明文出现过，若是长期有效的账号级 key，建议去控制台轮换。

---

## 6. 测试

`node --test`，零依赖，209 条。所有文件测试跑在 `os.tmpdir()` 的 fixture 或副本上；只有「真实词表往返 / 字母序」那几个用例读本目录的 `Vocabulary.md`（走链接读到真身），**测试不写真实词表**。

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `test/vocab.test.js` | 35 | 无损往返（读真实词表逐字节校验主行与每条义项行）、`sortKey` 边界、插入位置与新建章节、**只接受新格式**（带框主行/无框义项行/`[]`/`·` 子行/孤儿子行都报错）、义项级勾选（单条/批量/词级）、`planSetEntry`（含只改第一条不丢义项）、`planSetSenses`、`planDeleteEntry`、`applyEdits` 重叠与越界拒绝、CRLF 保持 |
| `test/ai.test.js` | 34 | 容错解析（裸 JSON / 围栏 / 前后带话 / 数组包裹）、重试策略（429 两次后成功、400 不重试、空回复重试）、义项契约（废数据丢弃、最多三条、`levelBasis` 归一）、判定规则与语言、`targetExample` 传参、考试模式只回代码、例句生成与校验、没吐出可解析 JSON 时再要一次 |
| `test/server.test.js` | 57 | 全部路由的成功/校验/错误映射、密钥不外泄、`senses[].checked` 与词级 `checked`、判定义项、勾选义项写盘、批量标记掌握（一次写盘一份备份、跳过未知词、无变化不写盘）、学习与复习各一条完整轮次、重构与批量写盘、路径穿越与请求体上限、静态资源不带缓存且认 MIME（含 `public/js/` 下的模块） |
| `test/config.test.js` | 6 | `.env` 解析、密钥与端口与路径覆盖、`vocabMirror` 的开关判据（同一文件才开、指到别处或目标不存在就关掉） |
| `test/session.test.js` | 31 | 按模式分池（学习只取未掌握、复习只取已掌握）、抽词按词级整词入队、池子不足与空池、学习看词游标推进到底自动转测试段、复习没有看词段、**整词一张卡且逐义项判**、留空即不会（不花调用）、每条义项三次机会、上游半途失败保留已判结果、乱序与越界拒绝、reveal 只给已判完的义项、翻页门禁、跨过被删的词、结算方向（学习只勾选 / 复习只取消）、preview/commit（含中途删词跳过）、断点续测、旧版本状态文件被忽略、暂停/继续/放弃、语言切换 |
| `test/cefr.test.js` | 17 | 括号剥离、词形归并、**词根推测（两轮剥前缀后缀、根不在表里就表外）**、常用度兜底、表外不猜、真实词表全量跑（命中率下限）、数据文件自检 |
| `test/settings.test.js` | 13 | 白名单校验、未知提示词键被忽略、模型归一化、默认值 |
| `test/store.test.js` | 16 | 备份轮转只留 20 份、写入抛错原文件不变、原子写、selfCheck 报错误行号、**硬链原处写入**、**软链写到真身而不是链接名**、**断链双向修复（谁新听谁）加重建链接类型** |

前端那七个模块是纯搬迁，`node --test` 兜不住，验收靠浏览器逐面板走一遍（沙盒配方见下面）。

**人工端到端**（改完代码**必须重启服务**，Node 不热加载；只改 `public/` 刷新页面即可）：真 key 冒烟 1 词草稿加 1 次判定；沙盒副本上跑加词、学习、复习、考这个词、勾选、删除、重构各一条完整路径，`diff` 副本与原文件核对只有目标行变化，最后删副本。

沙盒配方（已验证）：把 `VOCAB_FILE`、`VOCAB_BACKUP_DIR`、`VOCAB_SETTINGS_FILE`、`VOCAB_STATE_DIR` 全指到 `%TEMP%/vocab-*` 里的副本，`PORT=5318`，跑完 `diff` 再删。镜像不必手动关：`VOCAB_FILE` 一指到副本，`vocabMirror` 判定两边不是同一个文件，自动变 `null`，真表不会被兜底逻辑碰到（启动日志会写「（无镜像）」）。

---

## 7. 进度与待办

### 7.1 里程碑（全部完成，除取消项）

| # | 里程碑 | 状态 |
|---|---|---|
| 0 | 连通性冒烟（真实 `/chat/completions`） | ✅ 2026-09-06 |
| 1 | 数据层 `vocab.js` + 单测，真实词表逐字节往返 | ✅ |
| 2 | 只读闭环 `store/config/server` + 列表 UI | ✅ 浏览器实测 |
| 3 | AI 加词 + 加词面板 | ✅ 副本实测（含新建章节、中文第三段） |
| 4 | 判定 + 勾选写回 + 撤销（现落在词表条目里的「考这个词」上） | ✅ 副本实测 |
| 5 | 规范化面板 | ❌ 取消（存量早已手工拆完） |
| 6 | 存量回填 | ✅ 旧条目全部补完后按 D20 整套下线 |
| 7 | 文档 | ✅（本文合并了它） |

### 7.2 追加功能

十二个：单词行内编辑 · 学习与复习两种模式（`session.js`，取代原先的自测与整测）· 深浅色 · 设置页 + 提示词覆盖 · 模型全平级（D16）· 删除该词（D17）· CEFR 查表（D18）· 多义项（D19）· 多选 + 逐词重构（D20）· 草稿/重构合流（D21）· 义项级掌握（D22）· 词根推测（任务二：`cefr.familyCandidates` 两轮剥前缀后缀，标签「词根推测自 X」，比只做词形归并时多认出一批词）。

### 7.3 待办

1. **任务三 难度 5 次取平均**：只针对 `levelBasis === 'judged'`（词表没覆盖、AI 自判）的义项，按钮触发跑 5 次，把六档折成数字取平均再四舍五入回档，记录一致度（如「AI 5 次均值 C1（4/5 一致）」），先出清单再写盘。**这是唯一还没动过的功能**（截至 2026-09-30）。
2. 勾选状态里相当一部分是早年手工勾的，用「复习」按实际表现重校一遍最划算；难度档同理，任务三做完后值得整表过一轮。
3. **加词与设置的视觉细节**：2026-09-30 第三轮逐处过了一遍，修掉三类问题。义项行的三个输入框漏写 `type`，整段表单样式都没吃到，深色下底色用浏览器默认值、浅色下是 2px 内凹边框加小一号字号；提交类按钮（词表的「保存」「确认写入」、加词的「写入」）没有主按钮样式，和旁边的次要按钮同款；窄窗口下义项行把释义与例句各挤到一百多像素、连带「+ 添加义项」文字折行。**还剩两处待定**，都不影响可用性：设置里「模型」那段把「默认模型」（选哪个）与「新增候选」（模型名/接入点/附加参数/密钥/添加）六个控件塞进同一个自动换行的行，换行点不受宽度控制、宽度分配也失衡（附加参数框远宽于密钥框），建议拆成两段；加词卡片上的档位依据会把同一来源的多个词性逐条列出，按来源去重能短近一半。

---

## 8. 目录结构、迁移与踩坑

**目录**（2026-09-29 从 Obsidian 库内的 `vocab-app` 迁到这里，脱离了库）：

```
VocabApp\             ← 代码 + 文档 + 配置，不在 Obsidian 库里
  README.md          唯一的权威规格（本文）
  server.js vocab.js store.js config.js settings.js ai.js cefr.js session.js
  public/            index.html · style.css · app.js（入口）+ js/ 七个面板模块
  test/              node --test 的全部用例
  data/              cefr.json + sources/（CEFR 原始清单）
  tools/             build-cefr-data.mjs
  backups/           写盘前的快照（只留最近 20 份）
  .env settings.json VocabApp.bat package.json .gitignore .gitattributes
  Vocabulary.md      ← 软链，指向下面那份真身
Notes\Vocabulary.md  ← 真身，Obsidian 库那边只留这一个文件
```

- **为什么放个链接**：工具默认在自己目录里找 `Vocabulary.md`，放个链进去，文件夹看起来是自包含的；数据真身留在 Obsidian 库里，你在 Obsidian 里照旧能看、能手改。`.env` 里的 `VOCAB_FILE` 仍指向库里那份真身，两条路读写同一份文件。**两个位置都可以随便改**，工具读写前会按 §2.7 的规则把两边对齐。
- **链接是软链**：它指向真身的路径，所以真身被「改名式保存」也能自动跟上（硬链在这种情况下会断）。建它要管理员权限或开发者模式，本机是用一次 UAC 建的；普通权限建不了，只能退硬链。重建命令大致是这样，把两个变量换成你自己的位置，会弹一次 UAC：
  ```
  $t='<真身路径>'; $m='VocabApp\Vocabulary.md'
  powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command',\"Remove-Item '$m' -Force; New-Item -ItemType SymbolicLink -Path '$m' -Target '$t'\""
  ```
  真断了也不用管：工具下次读写会按「谁新听谁的」把两边修好。重建软链没权限时会退成硬链，内容仍是同一份，只是少了「改名也跟得上」这层保险。
- **复制到别处**：把文件夹拷过去，**别带那个软链**（拷过去会变成悬空链接）。删掉它，在本地放一份自己的 `Vocabulary.md`，或把 `.env` 里的 `VOCAB_FILE` 指到目标机器上的词表，填上自己的 `VOCAB_KEY_*` 就能独立跑。想连数据一起带走，就拷一份真身文件放进目录、留空 `VOCAB_FILE`（默认就用本目录的 `Vocabulary.md`）。
- **这是 git 仓库，远端在 GitHub**：`github.com/uint128t/VocabApp`，**私有**。`data/cefr.json` 与 `data/sources/` 里是 Oxford 3000/5000 与 Phrase List，只有个人自用授权，别转公开；真要公开，先得把这批数据摘出去，只留 `tools/build-cefr-data.mjs` 和源清单说明。`.gitignore` 挡掉 `.env`、`settings.json`、`backups/`、`.state/` 和 `Vocabulary.md`（软链指向库里的真身，换机器就废）。`.gitattributes` 把换行钉成 LF（`data/sources/*.csv` 参与 `cefr.json` 构建，换行飘了数值会变），`VocabApp.bat` 单独用 CRLF。推送认证走 Git Credential Manager，本机已装，第一次推会弹窗选账号。
- **数据那边是 Obsidian 库**：你会同时手改 `Vocabulary.md`，所以 §2.7 的「外科手术式行编辑」不能省。
- **Bash 工具的默认 cwd 指向已失效的旧 OneDrive 路径**，调用 Bash 必须显式传工作目录，通常就是本目录。
- 权限层（auto mode）会拦：shell 里明文带 key、写含密钥的文件、用 `..` 相对路径访问 vault 内文件。绕行办法是绝对路径加 `.env` 由服务端读取。
- 正则里的 `\u` 转义会在写文件时塌成字面字符，判断 CJK 区间请用码点数值比较（见 `vocab.js` 的 `CJK_RANGES`）。
- agent 起的后台 `node server.js` 会在回合之间被回收；要服务长期在线就走 `VocabApp.bat`（独立窗口，关掉即停）。**移动或改名这个文件夹之前先关掉那个窗口**，否则目录被占用、移不动。
- `.bat` 必须 **CRLF + 纯 ASCII**：UTF-8 加 LF 的批处理会被 cmd 按多字节切碎，中文 `echo` 会报「不是内部或外部命令」。
- 环境：Windows 加 Node v24（`package.json` 为 `type=module`），零依赖。跑全量测试是 `node --test`，前台起服务是 `npm start`，重建 CEFR 查询表是 `node tools/build-cefr-data.mjs`。
