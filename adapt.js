/* ==========================================================================
 *  adapt.js —— 【高频调试层】
 * ==========================================================================
 *
 *  ┌──────────────────────────────────────────────────────────────────────┐
 *  │  修改规则（给 AI 助手 / 未来的自己：动手改之前必须先读完这 7 条）      │
 *  └──────────────────────────────────────────────────────────────────────┘
 *
 *  1. 【只改这一个文件】
 *     server.js 是通讯骨架（HTTP / SSRF 校验 / 上游请求 / SSE / 协议报文
 *     格式），已经定型并跑通。调提示词、调工具调用解析、调上下文压缩，
 *     100% 都在本文件完成。**不要修改 server.js**，除非要改的确实是网络
 *     层或 Anthropic/OpenAI 报文结构本身。
 *
 *  2. 【不许改导出签名】
 *     文件底部 export 的东西是 server.js 的调用契约。函数名、参数个数、
 *     参数顺序、返回值结构一律不许改。要加能力就在函数体内部加，
 *     或者往 TUNING / PROMPT_PRESETS 里加字段。
 *
 *  3. 【必须保持纯函数】
 *     本文件禁止出现：fetch / fs / express / process / 全局可变状态 /
 *     Date.now() 之外的时间依赖。输入决定输出，方便单测和复现。
 *     唯一允许的副作用出口是每个函数的 `log` 参数（默认是空函数）。
 *
 *  4. 【改完必须跑测试】
 *         node --test adapt.test.js
 *     必须全绿。用例里每一条都是线上真实踩过的坑。
 *     **不许为了让测试通过去改测试**——测试挂了说明你把已经修好的场景又弄坏了。
 *     修好一个新 bug，顺手把它加进 adapt.test.js。
 *
 *  5. 【删代码之前先确认】
 *     下面的正则和 if 分支看着很丑，但每一条都对应某个模型的某种畸形输出
 *     （GLM 的 <arg_key>、Qwen 的裸 JSON、把 tool_call 包进 markdown 的、
 *     少写闭合标签的……）。要删先去 adapt.test.js 里确认没有用例覆盖它。
 *
 *  6. 【不要注释掉旧代码】
 *     要留旧版本就往 PROMPT_PRESETS 里多加一套，或者交给 git。
 *     满文件注释掉的死代码是这个项目上一次失控的直接原因。
 *
 *  7. 【任何"丢弃"都必须留日志】
 *     解析失败、参数不全、内容被截断——只要是"本来有东西、后来没了"的地方，
 *     都必须调 log(...)。上一版最大的问题就是工具调用被静默丢掉，
 *     日志里一个字都看不到，导致完全没法排查。
 *
 * ========================================================================== */

/* ==========================================================================
 *  第一部分：提示词预设
 *  ------------------------------------------------------------------------
 *  网页上可以下拉切换 / 临时编辑（只影响当前进程，重启回到这里的定义）。
 *  试出好效果后，把文本抄回这里，或者在这里新增一套预设。
 *
 *  占位符：
 *    {{tools}}                    压缩后的工具定义 JSON
 *    {{force_tool_instruction}}   根据 tool_choice 自动生成的强制说明
 *    {{protocol_rules}}           下面 PROTOCOL_RULES 的内容
 *                                 （模板里没写这个占位符的话会自动追加到末尾）
 * ========================================================================== */

/** 所有预设共用的协议硬约束。改格式规则改这里，改行为风格改各个预设。 */

export const PROTOCOL_RULES = `额外协议要求：

1. 若调用工具，只能使用以下完整格式：
<tool_call>
{"name":"工具名","arguments":{"参数名":"参数值"}}
</tool_call>

2. 严禁在思考中计算总轮数或为了省轮数而偷懒！专注于当前单步的高质量输出。

3. 【强制立即截断】：一旦输出了完整工具调用（或 </tool_call>），你的本次回答必须**彻底停止**！后面绝对不能有任何文字！

4. 【严禁角色扮演与脚本伪造】：
   - 绝对严禁在你的回答中出现 "User:"、"Assistant:"、"User: [TOOL RESULT]" 或任何模拟用户返回结果的文字！
   - 绝对严禁一个人自问自答演剧本！你只需要输出【当前这 1 个】工具调用，真实系统的 [TOOL RESULT] 会在下一轮发给你！

5. 严禁使用 XML 风格的调用（如 <invoke name="X"><parameter name="y">）。只能用上面第 1 条的 JSON 格式。

6. 【交替落盘规则】：完成一个具体的原子任务（如生成一个 SVG）后，必须在接下来的回答中编辑 TODO.md，将对应的 \`- [ ]\` 改为 \`- [x]\`。严禁批量打勾！

7. 每次回答最多只能调用一个工具。`;

export const PROMPT_PRESETS = [
  {
    id: "todo-single-step",
    label: "单步 TODO 驱动模式",
    hint: "简单任务直接回答/执行；复杂工程严格遵循“单步执行-单步存档”交替切分，坚决不跨轮次生成。",
    text: `你是可调用工具的通用编程与任务助手。

### 【最高法则：用户指令绝对优先】
用户的直接指令具有最高的优先级！
1. 若用户命令与本系统内置流程冲突（例如用户要求“不要创建TODO”、“直接回答”、“只修改某个文件”等），**必须无条件服从用户命令**。
2. 严禁在用户明确给出具体操作时，强行推翻用户指令去套用预设的复杂流程。

---

### 【核心约束：路径与目录防漂移】
1. **严格遵循现有结构**：操作文件前，必须确保你完全清楚当前项目的目录结构。严禁凭空想象目录（如项目明明是 \`app/\` 结构，你却往 \`src/pages/\` 写）。
2. **先探查后写入**：若对目录路径有任何不确定，第一步**必须先调用工具探查文件树**，确认目标文件夹存在后再创建/修改文件。

---

### 【任务分类与处理策略】

#### 策略 A：简单任务 / 单步操作 / 纯文本咨询（默认优先判定）
* **适用场景**：回答问题、修改单一文件/单行代码、执行单条命令、查看某个文件内容等。
* **处理规则**：
  - **严禁创建 TODO.md**！不要多此一举去拆分两三步的简单操作。
  - 直接输出回答，或直接发出 1 个 <tool_call> 完成操作。

#### 策略 B：复杂工程 / 多步骤任务
* **适用场景**：从零构建项目、大型重构、跨多文件的复杂任务。
* **处理规则与标准节奏**：
  1. **建计划**：若无 TODO.md，首先探查环境并创建细粒度拆分的 TODO.md（每一页/每一个文件必须独立作为一条记录）。
  2. **【交替推进模式】**：
     - **第 2N 步（执行）**：发出 1 个 <tool_call>，专注高质量完成当前这一个任务（例如写 page01.svg）。
     - **第 2N+1 步（存档）**：该任务返回成功后，在接下来的回答中更新 TODO.md，将对应的 \`- [ ]\` 改为 \`- [x]\`。
  3. **【严禁伪造对话 / 自问自答】（核心警告）**：
     - 你的每一次 API 回答，只能输出**单次**工具调用！
     - **严禁在一次回答中自行输出 "User: [TOOL RESULT ...]" 去模拟用户给你的返回结果！**
     - 输完工具调用后**立刻停机**！真实的结果会由系统在下一轮喂给你。
  4. **思考链（CoT）硬性约束**：**严禁在思考过程中质疑或计算“步骤太多、交互轮数多”**！单步原子化是系统为了防错、保证生成质量和实现断点续传故意设计的安全机制。不要试图一次合并大量操作，坚定、迅速地按步骤推进即可。

---

### 【轮次交互规则】
1. **单步限制**：无论策略 A 或 B，每次 API 回答**最多包含 1 个工具调用**，思考范围仅限于本次任务。
2. **停止与等待**：收到 [TOOL RESULT] 后（表示上一步已完成），若整个任务尚未完全结束，你**必须在本次回答中直接发出下一个任务的 <tool_call>**。绝对禁止输出纯文本废话（如“收到”、“已完成，请发送下一条命令”），否则流程将中断！
3. **完成退出**：只有当所有操作已完成，且无需任何后续工具调用时，才输出纯文本总结并停止发工具。

---

可用工具：
{{tools}}
{{force_tool_instruction}}`
  }
];

export const DEFAULT_PROMPT_ID = "todo-single-step";

export function getPreset(id) {
  return (
    PROMPT_PRESETS.find((preset) => preset.id === id) ||
    PROMPT_PRESETS.find((preset) => preset.id === DEFAULT_PROMPT_ID) ||
    PROMPT_PRESETS[0]
  );
}

/* ==========================================================================
 *  第二部分：可调参数
 *  ------------------------------------------------------------------------
 *  这里每一项在网页「调参」面板里都有对应控件。加一项就自动多一个控件。
 *  改默认值改这里；临时试值在网页上改。
 * ========================================================================== */

export const DEFAULT_TUNING = {
  // ---- 上下文压缩 -------------------------------------------------------
  /** 最近 N 条消息原样保留、绝不压缩。太小会让模型忘记刚做过什么。 */
  keepRecentMessages: 15,
  /** 历史里 tool_result（文件内容、命令输出）正文的字符上限。 */
  toolResultMaxChars: 8000,
  /** 历史里普通文本消息的字符上限。 */
  textMaxChars: 3000,
  /** 历史里超过这个长度的 tool_call，省略其中的超长参数值（外形保持不变）。 */
  toolCallSummaryOverChars: 1500,
  /** 上一条触发后，单个参数值保留多少字符。路径、命令这类短值不受影响。 */
  toolCallArgValueMaxChars: 300,
  /** 历史里的 thinking / reasoning 块是否直接丢弃（强烈建议 true）。 */
  dropThinkingInHistory: true,
  /** >0 时对渲染后的总字符数兜底，从最老的消息开始进一步压缩。0 = 不限。 */
  maxTotalChars: 100000,

  // ---- 工具调用解析 -----------------------------------------------------
  /**
   * 模型给出的工具调用缺少 required 参数时怎么办：
   *   true  = 照样发给 Claude Code，让 CC 返回真实报错，模型下一轮自己改正（推荐）
   *   false = 直接丢弃（上一版的行为，症状就是"工具不调用"且日志无痕迹）
   */
  emitIncompleteToolCalls: true,
  /** 每轮最多返回给客户端的工具调用数量。 */
  maxToolCallsPerTurn: 1,
  /** 是否给上游加 </tool_call> 作为 stop 序列（让模型输出完调用就停）。 */
  appendStopSequence: true,

  // ---- 防死循环 ---------------------------------------------------------
  /** 连续 N 次出现完全相同的工具调用时，注入一条纠偏提示。0 = 关闭。 */
  repeatWarningThreshold: 2,

  // ---- 工具定义瘦身 -----------------------------------------------------
  /** 发给模型的工具描述截断长度。 */
  toolDescriptionMaxChars: 300
};

export function normalizeTuning(input) {
  const tuning = { ...DEFAULT_TUNING };

  for (const [key, fallback] of Object.entries(DEFAULT_TUNING)) {
    const value = input?.[key];

    if (value === undefined || value === null) continue;

    if (typeof fallback === "boolean") {
      tuning[key] = value === true || value === "true";
    } else if (Number.isFinite(Number(value))) {
      tuning[key] = Math.max(0, Number(value));
    }
  }

  return tuning;
}

/* ==========================================================================
 *  第三部分：提示词渲染
 * ========================================================================== */

/**
 * @param {Array<{name,description,parameters}>} tools
 * @param {*} toolChoice   Anthropic/OpenAI 的 tool_choice
 * @param {{promptText?:string, tuning?:object}} options
 * @returns {string} 完整 system 提示词（无工具时返回空串）
 */
export function renderToolPrompt(tools, toolChoice, options = {}) {
  if (!tools.length) return "";

  const tuning = options.tuning || DEFAULT_TUNING;
  const template = String(options.promptText || getPreset(DEFAULT_PROMPT_ID).text);

  const rendered = template
    .replaceAll("{{tools}}", JSON.stringify(compactTools(tools, tuning)))
    .replaceAll("{{force_tool_instruction}}", buildForceInstruction(toolChoice));

  return rendered.includes("{{protocol_rules}}")
    ? rendered.replaceAll("{{protocol_rules}}", PROTOCOL_RULES)
    : `${rendered}\n\n${PROTOCOL_RULES}`;
}

function buildForceInstruction(toolChoice) {
  const forcedName =
    toolChoice && typeof toolChoice === "object"
      ? toolChoice.name || toolChoice.function?.name || ""
      : "";

  if (forcedName) {
    return `本轮必须调用工具：${forcedName}`;
  }

  if (
    toolChoice === "required" ||
    toolChoice?.type === "any" ||
    toolChoice?.type === "required"
  ) {
    return "本轮必须调用至少一个工具。";
  }

  return "【通用强约束】：只要 TODO.md 中还有未完成项，本轮必须且只能输出一个 <tool_call>。严禁输出任何自然语言对话或假装完成的通知！";
}

/** 把工具定义瘦身后再塞进提示词，避免 schema 把上下文撑爆。 */
export function compactTools(tools, tuning = DEFAULT_TUNING) {
  return tools.map((tool) => ({
    name: tool.name,
    description: String(tool.description || "")
      .replace(/\s+/g, " ")
      .slice(0, tuning.toolDescriptionMaxChars)
      .trim(),
    parameters: compactSchema(tool.parameters)
  }));
}

const SCHEMA_KEEP_KEYS = [
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "additionalProperties",
  "oneOf",
  "anyOf",
  "allOf"
];

export function compactSchema(schema) {
  if (!schema || typeof schema !== "object") return {};
  if (Array.isArray(schema)) return schema.map(compactSchema);

  const result = {};

  for (const key of SCHEMA_KEEP_KEYS) {
    if (!(key in schema)) continue;

    if (key === "properties" && schema.properties) {
      result.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([name, value]) => [
          name,
          compactSchema(value)
        ])
      );
      continue;
    }

    if (["items", "oneOf", "anyOf", "allOf"].includes(key)) {
      result[key] = compactSchema(schema[key]);
      continue;
    }

    result[key] = schema[key];
  }

  return result;
}

/* ==========================================================================
 *  第四部分：上下文压缩（结构化）
 *  ------------------------------------------------------------------------
 *  输入输出都是 Conversation 中间表示，由 server.js 的协议层构造：
 *
 *    Conversation = { system: string, messages: Msg[] }
 *    Msg  = { role: "user" | "assistant", parts: Part[] }
 *    Part = { kind:"text",        text }
 *         | { kind:"thinking",    text }
 *         | { kind:"tool_call",   id, name, args }
 *         | { kind:"tool_result", id, name, text }
 *         | { kind:"image" }
 *
 *  【最重要的规则】压缩只在 Part 边界上做，绝不在 JSON 中间下刀。
 *  上一版按字符 slice(0,800) 会把 <tool_call>{"name":"Write",... 砍成半截，
 *  模型看到自己"以前输出过"残缺的调用就会照着模仿，于是越聊越坏。
 * ========================================================================== */

const NOOP_LOG = () => {};

/**
 * @param {Conversation} convo
 * @param {object} tuning
 * @param {(level:string, message:string, data?:object)=>void} log
 * @returns {Conversation}
 */
export function compressHistory(convo, tuning = DEFAULT_TUNING, log = NOOP_LOG) {
  const messages = Array.isArray(convo?.messages) ? convo.messages : [];
  const total = messages.length;
  const keepFrom = Math.max(0, total - tuning.keepRecentMessages);

  const stats = {
    total,
    keptIntact: total - keepFrom,
    droppedThinking: 0,
    summarizedToolCalls: 0,
    truncatedToolResults: 0,
    truncatedTexts: 0,
    charsBefore: 0,
    charsAfter: 0
  };

  const compressed = messages.map((msg, index) => {
    const parts = Array.isArray(msg?.parts) ? msg.parts : [];
    stats.charsBefore += measureParts(parts);

    // 最近若干条原样保留，只丢 thinking（thinking 任何时候都不该回传）
    if (index >= keepFrom) {
      const kept = tuning.dropThinkingInHistory
        ? parts.filter((part) => {
            if (part?.kind === "thinking") {
              stats.droppedThinking++;
              return false;
            }
            return true;
          })
        : parts;

      stats.charsAfter += measureParts(kept);
      return { ...msg, parts: kept };
    }

    const next = [];

    for (const part of parts) {
      if (!part) continue;

      if (part.kind === "thinking") {
        if (tuning.dropThinkingInHistory) {
          stats.droppedThinking++;
          continue;
        }
        next.push(part);
        continue;
      }

      if (part.kind === "tool_call") {
        const rendered = renderToolCall(part);

        if (
          tuning.toolCallSummaryOverChars > 0 &&
          rendered.length > tuning.toolCallSummaryOverChars
        ) {
          stats.summarizedToolCalls++;
          // ⚠️ 必须保留 <tool_call> 的外形，只省略超长的参数值。
          //    模型靠历史里自己的输出做格式锚定；把整条换成散文摘要
          //    （旧写法：「[历史操作：已调用工具 Write(...)]」）会打断这个锚，
          //    聊几轮后模型就开始输出 XML、markdown 等各种别的格式。
          next.push({
            ...part,
            args: elideLongArgValues(part.args, tuning.toolCallArgValueMaxChars)
          });
          continue;
        }

        next.push(part);
        continue;
      }

      if (part.kind === "tool_result") {
        const text = String(part.text || "");

        if (
          tuning.toolResultMaxChars > 0 &&
          text.length > tuning.toolResultMaxChars
        ) {
          stats.truncatedToolResults++;
          next.push({
            ...part,
            text: middleTruncate(text, tuning.toolResultMaxChars, "执行结果")
          });
          continue;
        }

        next.push(part);
        continue;
      }

      if (part.kind === "text") {
        const text = String(part.text || "");

        if (tuning.textMaxChars > 0 && text.length > tuning.textMaxChars) {
          stats.truncatedTexts++;
          next.push({
            ...part,
            text: middleTruncate(text, tuning.textMaxChars, "历史对话")
          });
          continue;
        }

        next.push(part);
        continue;
      }

      next.push(part);
    }

    stats.charsAfter += measureParts(next);
    return { ...msg, parts: next };
  });

  const result = { ...convo, messages: compressed };

  // 兜底：总量还是超标就从最老的消息开始进一步压
  if (tuning.maxTotalChars > 0 && stats.charsAfter > tuning.maxTotalChars) {
    const shrunk = shrinkToBudget(
      compressed,
      keepFrom,
      tuning.maxTotalChars,
      stats
    );
    result.messages = shrunk;
  }

  log("info", "context.trim", {
    ...stats,
    savedChars: stats.charsBefore - stats.charsAfter,
    keepRecentMessages: tuning.keepRecentMessages
  });

  return result;
}

function shrinkToBudget(messages, keepFrom, budget, stats) {
  const result = [...messages];
  let current = result.reduce((sum, msg) => sum + measureParts(msg.parts), 0);

  for (let index = 0; index < keepFrom && current > budget; index++) {
    const parts = result[index]?.parts || [];
    if (!parts.length) continue;

    const before = measureParts(parts);

    const collapsed = [
      {
        kind: "text",
        text: `[更早的历史已折叠：${describeParts(parts)}]`
      }
    ];

    result[index] = { ...result[index], parts: collapsed };
    current -= before - measureParts(collapsed);
    stats.collapsedOldMessages = (stats.collapsedOldMessages || 0) + 1;
  }

  stats.charsAfter = current;
  return result;
}

function describeParts(parts) {
  const names = parts
    .map((part) =>
      part?.kind === "tool_call"
        ? `调用 ${part.name}`
        : part?.kind === "tool_result"
          ? "工具结果"
          : "文本"
    )
    .filter(Boolean);

  return names.join("、") || "空";
}

/**
 * 递归省略过长的参数值，但保持参数结构完整。
 * 文件路径、命令这类短值原样保留（模型下一步经常要用到），
 * 只有 content / old_string 这种大块头会被截。
 */
function elideLongArgValues(args, limit) {
  const walk = (value) => {
    if (typeof value === "string") {
      return value.length <= limit
        ? value
        : `${value.slice(0, limit)}…[已省略 ${value.length - limit} 字]…`;
    }

    if (Array.isArray(value)) return value.map(walk);

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, walk(item)])
      );
    }

    return value;
  };

  return walk(args ?? {});
}

/** 头尾都留一点，中间挖掉——比只留头部更利于模型判断这段结果是什么。 */
function middleTruncate(text, limit, label) {
  if (text.length <= limit) return text;

  const head = Math.floor(limit * 0.7);
  const tail = Math.max(0, limit - head);

  const headPart = text.slice(0, head);
  const tailPart = tail > 0 ? text.slice(-tail) : "";
  const removed = text.length - head - tail;

  return `${headPart}\n...[${label}已省略 ${removed} 字符]...\n${tailPart}`;
}

function measureParts(parts) {
  let sum = 0;
  for (const part of parts || []) {
    if (!part) continue;
    if (part.kind === "tool_call") sum += renderToolCall(part).length;
    else sum += String(part.text || "").length;
  }
  return sum;
}

/* ==========================================================================
 *  第五部分：把 Conversation 渲染成上游能看懂的纯文本消息
 *  ------------------------------------------------------------------------
 *  这里定义的就是模型眼里的"工具协议长什么样"，和提示词是一套东西，
 *  改了这里必须同步改 PROTOCOL_RULES，否则模型看到的示例和实际不一致。
 * ========================================================================== */

export function renderToolCall(part) {
  return `<tool_call>\n${JSON.stringify({
    name: part.name,
    arguments: part.args || {}
  })}\n</tool_call>`;
}

export function renderToolResult(part) {
  return `[TOOL RESULT ${part.id || ""}]\n${part.text || ""}`;
}

/**
 * Conversation -> OpenAI /chat/completions 的 messages 数组
 * @returns {Array<{role:string, content:string}>}
 */
export function renderConversation(convo, tuning = DEFAULT_TUNING, log = NOOP_LOG) {
  const out = [];
  let skipped = 0;

  for (const msg of convo?.messages || []) {
    const chunks = [];

    for (const part of msg?.parts || []) {
      if (!part) continue;

      if (part.kind === "tool_call") {
        chunks.push(renderToolCall(part));
      } else if (part.kind === "tool_result") {
        chunks.push(renderToolResult(part));
      } else if (part.kind === "image") {
        chunks.push("[Image omitted]");
      } else if (part.kind === "thinking") {
        // 正常情况下压缩阶段已经丢掉了；这里兜底，绝不把思维链回传上游
        continue;
      } else {
        chunks.push(String(part.text || ""));
      }
    }

    let content = chunks.filter(Boolean).join("\n").trim();

    // assistant 伪造 [TOOL RESULT] / [Assistant]: 时，从伪造点斩断
    if (msg.role === "assistant") {
      content = cutHallucinatedResult(content);
    }

    if (!content) {
      skipped++;
      continue;
    }

    out.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content
    });
  }

  if (skipped) {
    log("debug", "render.skipped_empty", { skipped });
  }

  return out;
}

/** assistant 自己编造 [TOOL RESULT] 时，把编造部分及之后全部切掉。 */
export function cutHallucinatedResult(text) {
  const source = String(text || "");
  const index = source.search(/\[TOOL RESULT|\[Assistant\]:/i);
  return index >= 0 ? source.slice(0, index).trim() : source;
}

/** 清掉 Claude Code 注入的、对上游无意义的包裹标签。 */
export function stripClientNoise(text) {
  return String(text || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<total_tokens>[\s\S]*?<\/total_tokens>/gi, "")
    .trim();
}

/* ==========================================================================
 *  第六部分：防死循环
 * ========================================================================== */

/**
 * 在结构化数据上比对，而不是在被截断的文本上比对。
 * 上一版在截断后的字符串上比，两次不同的 Edit 被砍在同一位置就会
 * 误判成"重复调用"，注入一条假警告把模型带偏（已由测试覆盖）。
 *
 * @returns {string} 需要注入的提示；无需注入时返回空串
 */
export function detectRepeatedToolCall(convo, tuning = DEFAULT_TUNING) {
  const threshold = tuning.repeatWarningThreshold;
  if (!threshold || threshold < 2) return "";

  const signatures = [];

  for (const msg of convo?.messages || []) {
    if (msg?.role !== "assistant") continue;

    for (const part of msg.parts || []) {
      if (part?.kind === "tool_call") {
        signatures.push(`${part.name}:${stableStringify(part.args)}`);
      }
    }
  }

  if (signatures.length < threshold) return "";

  const recent = signatures.slice(-threshold);
  const allSame = recent.every((item) => item === recent[0]);

  if (!allSame) return "";

  return "[系统警告：检测到你连续输出了完全相同的工具指令！请勿重复读取/编辑同一文件。请检查当前已有文件状态，并继续推进 TODO 列表中的下一个任务。]";
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

/* ==========================================================================
 *  第七部分：模型回复清洗
 * ========================================================================== */

/**
 * 剥离 <think> 标签（含未闭合的），防止思维链泄漏给 Claude Code 导致卡死。
 * @returns {{text:string, thinking:string}}
 */
export function splitThinking(raw) {
  const source = String(raw || "");
  const matched = source.match(/<think>([\s\S]*?)<\/think>/i);

  const text = source
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .trim();

  return {
    text,
    thinking: matched ? matched[1].trim() : ""
  };
}

/* ==========================================================================
 *  第八部分：从模型纯文本里抠出工具调用
 *  ------------------------------------------------------------------------
 *  整个项目最脏也最关键的地方。支持的畸形形态：
 *    a) 标准     <tool_call>{"name":"X","arguments":{...}}</tool_call>
 *    b) 无闭合   <tool_call>{"name":"X","arguments":{...}}        （stop 序列吃掉了闭合标签）
 *    c) 裸 JSON  {"name":"X","arguments":{...}}                   （没有任何标签）
 *    d) 内联名   <tool_call>X{"file_path":"..."}</tool_call>
 *    e) 平铺参数 {"name":"X","file_path":"..."}                   （arguments 被摊平）
 *    f) GLM 风格 <arg_key>file_path</arg_key><arg_value>...</arg_value>
 *    g) markdown ```json {"name":...} ```
 *    h) 字符串里有裸换行/未转义引号的破 JSON
 * ========================================================================== */

/**
 * @returns {{content:string, toolCalls:Array<{id,name,arguments}>, rejected:Array}}
 */
export function extractToolCalls(
  text,
  tools,
  tuning = DEFAULT_TUNING,
  log = NOOP_LOG,
  makeId = defaultMakeId
) {
  const source = String(text || "");
  const rejected = [];

  if (!source || !Array.isArray(tools) || !tools.length) {
    return { content: source, toolCalls: [], rejected };
  }

  const candidates = collectToolCallCandidates(source);

  if (!candidates.length) {
    log("debug", "extract.no_candidate", { textLength: source.length });
    return { content: cleanResidualTags(source), toolCalls: [], rejected };
  }

  log("debug", "extract.candidates", {
    count: candidates.length,
    kinds: candidates.map((item) => item.kind)
  });

  const accepted = [];
  let firstAttemptStart = -1;

  for (const candidate of candidates) {
    if (firstAttemptStart < 0) firstAttemptStart = candidate.start;

    const declaredName = candidate.name || candidate.inlineName || "";
    const tool = getToolByName(declaredName, tools);

    const recovered =
      candidate.kind === "tagged"
        ? recoverTaggedToolCall(candidate.raw, declaredName, tool)
        : candidate.kind === "xml"
          ? recoverXmlToolCall(candidate.raw, declaredName, tool)
          : recoverMalformedToolCall(candidate.raw, candidate.inlineName, tool);

    if (!recovered) {
      rejected.push({ reason: "unparsable", declaredName, raw: clip(candidate.raw) });
      continue;
    }

    const normalized = normalizeParsedCall(recovered, tools);

    if (!normalized) {
      rejected.push({
        reason: "unknown_tool",
        declaredName: recovered.name || declaredName,
        knownTools: tools.map((item) => item.name),
        raw: clip(candidate.raw)
      });
      continue;
    }

    const canonicalTool = getToolByName(normalized.name, tools);
    const missing = missingRequiredArguments(normalized, canonicalTool);

    if (missing.length) {
      const parsedCount = Object.keys(normalized.arguments || {}).length;

      // 一个参数都没解析出来 —— 基本可以确定是解析失败而不是模型偷懒，丢弃
      if (parsedCount === 0) {
        rejected.push({
          reason: "no_arguments_parsed",
          tool: normalized.name,
          missing,
          raw: clip(candidate.raw)
        });
        continue;
      }

      if (!tuning.emitIncompleteToolCalls) {
        rejected.push({
          reason: "missing_required_dropped",
          tool: normalized.name,
          missing,
          got: Object.keys(normalized.arguments),
          raw: clip(candidate.raw)
        });
        continue;
      }

      // 照样放行：Claude Code 会返回参数校验错误，模型下一轮据此改正。
      // 比静默丢弃强得多——静默丢弃的表现就是"模型不调用工具"。
      log("warn", "extract.missing_required", {
        tool: normalized.name,
        missing,
        got: Object.keys(normalized.arguments),
        action: "已照常下发，等待客户端返回参数错误让模型自我修正"
      });
    }

    accepted.push({
      id: makeId(),
      name: normalized.name,
      arguments: normalized.arguments,
      _start: candidate.start
    });

    if (accepted.length >= Math.max(1, tuning.maxToolCallsPerTurn)) break;
  }

  for (const item of rejected) {
    log("warn", "extract.rejected", item);
  }

  if (!accepted.length) {
    const visible =
      firstAttemptStart >= 0
        ? source.slice(0, expandToolCallStart(source, firstAttemptStart))
        : source;

    if (firstAttemptStart >= 0) {
      log("error", "extract.all_rejected", {
        candidates: candidates.length,
        rejected: rejected.length,
        hint: "模型确实尝试调用了工具但全部解析失败——展开下面的 rejected 看原因"
      });
    }

    return { content: cleanResidualTags(visible), toolCalls: [], rejected };
  }

  const cutAt = expandToolCallStart(source, accepted[0]._start);
  const content = cleanResidualTags(source.slice(0, cutAt));

  const toolCalls = accepted.map(({ _start, ...call }) => call);

  log("info", "extract.ok", {
    count: toolCalls.length,
    tools: toolCalls.map((call) => call.name),
    droppedTrailingChars: source.length - cutAt
  });

  return { content, toolCalls, rejected };
}

function clip(text, limit = 600) {
  const source = String(text || "");
  return source.length > limit ? `${source.slice(0, limit)}…` : source;
}

function cleanResidualTags(text) {
  return String(text || "")
    .replace(/<\/?(tool_call|invoke|function|function_calls|parameter)[^>]*>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

function defaultMakeId() {
  return `toolu_${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
}

/* ---------------------------- 候选片段收集 -------------------------------- */

export function collectToolCallCandidates(text) {
  const candidates = [];
  const seen = new Set();

  const add = (candidate) => {
    const key = `${candidate.kind}:${candidate.start}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  // (a)(b)(c)(g) 裸 JSON / 标准形态
  const jsonPattern = /\{\s*"name"\s*:\s*"([^"]+)"/g;
  let match;

  while ((match = jsonPattern.exec(text)) !== null) {
    const start = match.index;
    const closeTag = text.indexOf("</tool_call>", start);
    const nextTag = text.indexOf("<tool_call", start + 1);

    let end = text.length;
    if (closeTag >= 0) end = closeTag + "</tool_call>".length;
    else if (nextTag >= 0) end = nextTag;

    add({
      kind: "json",
      start,
      end,
      name: match[1],
      inlineName: null,
      raw: text.slice(start, end)
    });
  }

  // (d) <tool_call>ToolName{...}</tool_call>
  //
  // ⚠️ 标识符必须写成 {0,63} 而不是 *。写 * 会让正则在长文本上灾难性回溯：
  //    实测 8000 字符的纯文本要跑 22 秒 CPU，模型写个大文件就能把进程挂死。
  if (text.includes("<tool_call")) {
    const inlinePattern =
      /<tool_call\b[^>]*>\s*([a-zA-Z_][a-zA-Z0-9_.\-]{0,63})\s*(?=\{)/gi;

    while ((match = inlinePattern.exec(text)) !== null) {
      const start = match.index;
      const closeTag = text.indexOf("</tool_call>", start);
      const end = closeTag >= 0 ? closeTag + "</tool_call>".length : text.length;

      add({
        kind: "json",
        start,
        end,
        name: match[1],
        inlineName: match[1],
        raw: text.slice(start, end)
      });
    }
  }

  // (i) Anthropic XML 风格：<invoke name="X"><parameter name="y">值</parameter></invoke>
  //     deepseek / 各种 Claude 蒸馏模型很爱输出这个，哪怕提示词里要求的是 JSON。
  //     可能外面套着 <tool_call>，也可能套着 <function_calls>，也可能什么都不套。
  if (/<(?:[\w-]+:)?invoke\b/i.test(text)) {
    const invokePattern =
      /<(?:[\w-]+:)?invoke\s+name\s*=\s*["']?([A-Za-z_][A-Za-z0-9_.\-]{0,63})["']?\s*>/gi;

    while ((match = invokePattern.exec(text)) !== null) {
      const start = match.index;
      const closeIndex = indexOfCaseless(text, "</invoke", start);
      const end = closeIndex >= 0 ? closeIndex + "</invoke>".length : text.length;

      add({
        kind: "xml",
        start,
        end,
        name: match[1],
        inlineName: null,
        raw: text.slice(start, end)
      });
    }
  }

  // (f) GLM 的 <arg_key>/<arg_value>
  //
  // ⚠️ 这个 indexOf 前置判断不是优化，是必需的正确性护栏。
  //    没有 </arg_key> 时下面的正则会对每个起始位置做 O(n×160) 回溯，
  //    整体 O(n²)；去掉这个 if 会让服务在写大文件时直接卡死。
  return text.toLowerCase().includes("</arg_key>")
    ? collectTaggedCandidates(text, candidates, add)
    : candidates.sort((a, b) => a.start - b.start);
}

function collectTaggedCandidates(text, candidates, add) {
  const taggedPattern =
    /(?:<tool_call\b[^>]*>\s*)?([a-zA-Z_][a-zA-Z0-9_.\-]{0,63})[\s\S]{0,160}?<\/arg_key>/gi;

  let match;

  while ((match = taggedPattern.exec(text)) !== null) {
    const start = match.index;
    const lookaheadFrom = match.index + match[0].length;

    const hasArgValue = /<arg_value>/i.test(
      match[0] + text.slice(lookaheadFrom, lookaheadFrom + 400)
    );

    if (!hasArgValue) continue;

    const closeTag = text.indexOf("</tool_call>", start);
    const argValueEnd = text.indexOf("</arg_value>", start);

    let end = closeTag >= 0 ? closeTag + "</tool_call>".length : text.length;
    if (argValueEnd >= 0 && closeTag < 0) {
      end = argValueEnd + "</arg_value>".length;
    }

    add({
      kind: "tagged",
      start,
      end,
      name: match[1],
      inlineName: null,
      raw: text.slice(start, end)
    });
  }

  return candidates.sort((a, b) => a.start - b.start);
}

/* ---------------------------- 各形态的恢复 -------------------------------- */

function indexOfCaseless(text, needle, from) {
  return text.toLowerCase().indexOf(needle.toLowerCase(), from);
}

/**
 * 解析 Anthropic XML 风格的调用：
 *   <invoke name="Bash"><parameter name="command">ls -la</parameter></invoke>
 *
 * 用 indexOf 逐段扫描而不是一个大正则，原因有二：
 *   1. 参数值里经常有换行、引号、代码、甚至尖括号，正则很难写对；
 *   2. 惰性量词 + 收尾分支在长文本上会灾难性回溯（见 collectToolCallCandidates 的注释）。
 */
export function recoverXmlToolCall(raw, declaredName, tool) {
  const canonicalName = tool?.name || declaredName;
  if (!canonicalName) return null;

  const paramPattern =
    /<(?:[\w-]+:)?parameter\s+name\s*=\s*["']?([^"'>\s]+)["']?\s*>/gi;

  const args = {};
  let match;

  while ((match = paramPattern.exec(raw)) !== null) {
    const key = match[1];
    const valueStart = match.index + match[0].length;

    // 值的结束点：最近的 </parameter>；没有就退到 </invoke>；再没有就到结尾（被截断了）
    const closeParam = indexOfCaseless(raw, "</parameter", valueStart);
    const closeInvoke = indexOfCaseless(raw, "</invoke", valueStart);

    let end = raw.length;
    if (closeParam >= 0) end = closeParam;
    if (closeInvoke >= 0 && closeInvoke < end) end = closeInvoke;

    args[key] = coerceXmlParamValue(raw.slice(valueStart, end), key, tool);
  }

  return Object.keys(args).length ? { name: canonicalName, arguments: args } : null;
}

/** XML 里的值全是字符串，按 schema 声明的类型还原成 number / boolean / 对象。 */
function coerceXmlParamValue(rawValue, key, tool) {
  const text = String(rawValue ?? "").trim();
  const type = tool?.parameters?.properties?.[key]?.type;

  if (type === "number" || type === "integer") {
    const asNumber = Number(text);
    return Number.isFinite(asNumber) ? asNumber : text;
  }

  if (type === "boolean") {
    if (text === "true") return true;
    if (text === "false") return false;
    return text;
  }

  if (type === "object" || type === "array") {
    return parseLooseJson(text) ?? text;
  }

  return text;
}

export function recoverTaggedToolCall(raw, declaredName, tool) {
  const canonicalName = tool?.name || declaredName;
  if (!canonicalName || !tool) return null;

  const equalIndex = raw.indexOf("=");

  if (equalIndex >= 0) {
    for (const objectText of extractBalancedJsonObjects(raw.slice(equalIndex + 1))) {
      const parsed = parseLooseJson(objectText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

      if (
        parsed.name &&
        parsed.arguments &&
        typeof parsed.arguments === "object" &&
        !Array.isArray(parsed.arguments)
      ) {
        return { name: parsed.name, arguments: parsed.arguments };
      }

      return { name: canonicalName, arguments: parsed };
    }
  }

  const properties = Object.keys(tool.parameters?.properties || {});
  const args = {};

  for (const key of properties) {
    const pattern = new RegExp(
      `(?:<arg_key>\\s*)?${escapeRegExp(
        key
      )}\\s*</arg_key>\\s*<arg_value>\\s*([\\s\\S]*?)\\s*</arg_value>`,
      "i"
    );

    const pair = pattern.exec(raw);
    if (pair) args[key] = decodeLooseToolString(pair[1].trim());
  }

  return Object.keys(args).length ? { name: canonicalName, arguments: args } : null;
}

export function recoverMalformedToolCall(raw, inlineName = null, tool = null) {
  if (inlineName) {
    const objectStart = raw.indexOf("{");
    const objectEnd = findLooseOuterObjectEnd(raw, objectStart);

    if (objectStart < 0 || objectEnd <= objectStart) return null;

    const argsText = raw.slice(objectStart, objectEnd);
    const strict = parseLooseJson(argsText);

    if (strict && typeof strict === "object" && !Array.isArray(strict)) {
      return { name: inlineName, arguments: strict };
    }

    return { name: inlineName, arguments: recoverLooseArguments(argsText, tool) };
  }

  for (const objectText of extractBalancedJsonObjects(raw)) {
    const parsed = parseLooseJson(objectText);
    if (!parsed?.name || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    if (
      parsed.arguments &&
      typeof parsed.arguments === "object" &&
      !Array.isArray(parsed.arguments)
    ) {
      return { name: parsed.name, arguments: parsed.arguments };
    }

    // (e) arguments 被摊平：{"name":"Read","file_path":"/a"}
    const { name, ...rest } = parsed;
    return { name, arguments: rest };
  }

  const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/i);
  if (!nameMatch) return null;

  const name = nameMatch[1];
  const argumentsMatch = /"arguments"\s*:\s*\{/.exec(raw);
  let argumentsText = "";

  if (argumentsMatch) {
    const start = argumentsMatch.index + argumentsMatch[0].lastIndexOf("{");
    const end = findLooseArgumentsEnd(raw, start);
    if (end > start) argumentsText = raw.slice(start, end);
  } else {
    argumentsText = raw;
  }

  if (!argumentsText) return null;

  const strict = parseLooseJson(argumentsText);
  if (strict && typeof strict === "object" && !Array.isArray(strict)) {
    return { name, arguments: strict };
  }

  const loose = recoverLooseArguments(argumentsText, tool);
  return Object.keys(loose).length ? { name, arguments: loose } : null;
}

/** (h) JSON 彻底坏掉时，按 schema 里的字段名逐个把值抠出来。 */
function recoverLooseArguments(argumentsText, tool) {
  const properties = Object.keys(tool?.parameters?.properties || {});
  const result = {};

  for (const key of properties) {
    const value = extractLooseArgumentValue(argumentsText, key, properties);
    if (value !== null) result[key] = value;
  }

  return result;
}

function extractLooseArgumentValue(text, key, allKeys) {
  const match = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*`, "i").exec(text);
  if (!match) return null;

  const valueStart = match.index + match[0].length;
  const tail = text.slice(valueStart);

  // 非字符串值（数字 / 布尔 / 对象 / 数组）
  if (!tail.startsWith('"')) {
    const nextField = /(?:[}\]\s]*),\s*"[^"]+"\s*:/.exec(tail);

    let rawValue = nextField
      ? tail.slice(0, nextField.index)
      : tail.replace(/}\s*$/g, "");

    rawValue = rawValue.trim().replace(/,\s*$/g, "");

    if (!rawValue) return null;
    if (rawValue === "true") return true;
    if (rawValue === "false") return false;
    if (rawValue === "null") return null;

    const asNumber = Number(rawValue);
    if (Number.isFinite(asNumber) && rawValue !== "") return asNumber;

    return parseLooseJson(rawValue) ?? rawValue;
  }

  const contentStart = valueStart + 1;
  const afterQuote = text.slice(contentStart);

  let end = -1;

  const nextAnyField = /(?:[}\]\s]*),\s*"[^"]+"\s*:/.exec(afterQuote);
  if (nextAnyField) end = contentStart + nextAnyField.index;

  if (end < 0 && Array.isArray(allKeys) && allKeys.length > 1) {
    const otherKeys = allKeys.filter((item) => item !== key).map(escapeRegExp);

    if (otherKeys.length) {
      const nextKnown = new RegExp(
        `(?:[}\\]\\s]*),\\s*"(${otherKeys.join("|")})"\\s*:`,
        "i"
      ).exec(afterQuote);

      if (nextKnown) end = contentStart + nextKnown.index;
    }
  }

  if (end < 0) {
    const doubleClose = afterQuote.search(/}\s*}/);
    if (doubleClose >= 0) end = contentStart + doubleClose;
  }

  if (end < 0) {
    const finalClose = afterQuote.lastIndexOf("}");
    if (finalClose >= 0) end = contentStart + finalClose;
  }

  if (end < 0) end = text.length;

  let rawValue = text
    .slice(contentStart, end)
    .replace(/,\s*$/g, "")
    .replace(/}\s*$/g, "")
    .trim();

  if (!rawValue) return "";

  if (rawValue.endsWith('"')) {
    const withoutLast = rawValue.slice(0, -1);
    if (countUnescapedQuotes(withoutLast) % 2 === 0) rawValue = withoutLast;
  }

  return decodeLooseToolString(rawValue);
}

/* ------------------------- 工具名解析 / 参数校验 --------------------------- */

export function normalizeToolNameKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_.\-:/]+/g, "");
}

/** 模型常把 Read 写成 read / read_file / Read-File，这里做模糊归一。 */
export function resolveToolName(name, tools) {
  const requested = String(name || "").trim();
  if (!requested || !Array.isArray(tools)) return "";

  const exact = tools.find((tool) => tool?.name === requested);
  if (exact?.name) return exact.name;

  const normalized = normalizeToolNameKey(requested);
  const matches = tools.filter(
    (tool) => tool?.name && normalizeToolNameKey(tool.name) === normalized
  );

  return matches.length === 1 ? matches[0].name : "";
}

export function getToolByName(name, tools) {
  const canonical = resolveToolName(name, tools);
  return canonical ? tools.find((tool) => tool?.name === canonical) || null : null;
}

export function missingRequiredArguments(call, tool) {
  const required = Array.isArray(tool?.parameters?.required)
    ? tool.parameters.required
    : [];

  return required.filter((key) => {
    const value = call?.arguments?.[key];
    if (value === undefined || value === null) return true;
    if (typeof value === "string" && !value.trim()) return true;
    return false;
  });
}

export function normalizeParsedCall(candidate, tools) {
  if (!candidate || typeof candidate !== "object") return null;

  const requested =
    candidate.name ||
    candidate.tool ||
    candidate.function?.name ||
    candidate.function_name;

  const canonicalName = resolveToolName(requested, tools);
  if (!canonicalName) return null;

  let args =
    candidate.arguments ??
    candidate.input ??
    candidate.parameters ??
    candidate.function?.arguments ??
    candidate.function?.input ??
    {};

  if (typeof args === "string") args = parseLooseJson(args) || null;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;

  return { name: canonicalName, arguments: sanitizeToolArguments(args) };
}

/**
 * 清掉模型在代码/SVG 里误加的 markdown 标记。
 * 典型症状：写出来的 HTML 里 URL 变成 [http://x](http://x)，页面就废了。
 */
export function sanitizeToolArguments(value) {
  if (typeof value === "string") {
    return value
      .replace(/\[(https?:\/\/[^\]]+)\]\(\1\)/g, "$1")
      .replace(/\*\*(https?:\/\/[^*]+)\*\*/g, "$1");
  }

  if (Array.isArray(value)) return value.map(sanitizeToolArguments);

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeToolArguments(item)])
    );
  }

  return value;
}

/* ----------------------------- JSON 工具函数 ------------------------------ */

export function parseLooseJson(value) {
  if (!value || typeof value !== "string") return null;

  const text = value
    .trim()
    .replace(/^```(?:json|tool_calls)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(text);
  } catch {
    /* 继续尝试 */
  }

  const objects = extractBalancedJsonObjects(text);

  if (objects.length === 1) {
    try {
      return JSON.parse(objects[0]);
    } catch {
      /* 放弃 */
    }
  }

  return null;
}

export function extractBalancedJsonObjects(text) {
  const result = [];

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth++;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        result.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return result;
}

function findLooseArgumentsEnd(text, start) {
  const tail = text.slice(start);
  const doubleClose = /}\s*}/.exec(tail);

  if (doubleClose) return start + doubleClose.index + 1;

  const lastClose = tail.lastIndexOf("}");
  return lastClose >= 0 ? start + lastClose + 1 : -1;
}

function findLooseOuterObjectEnd(text, start) {
  if (start < 0) return -1;

  const objects = extractBalancedJsonObjects(text.slice(start));
  if (objects.length) return start + objects[0].length;

  const tail = text.slice(start);
  const lastClose = tail.lastIndexOf("}");

  return lastClose >= 0 ? start + lastClose + 1 : -1;
}

/** 把切割点从 JSON / <invoke> 起点前移到最外层的包裹标签，避免残留半个标签。 */
function expandToolCallStart(text, callStart) {
  let earliest = callStart;

  for (const tag of ["<tool_call", "<function_calls"]) {
    const tagStart = text.toLowerCase().lastIndexOf(tag, earliest);
    if (tagStart < 0) continue;

    const tagEnd = text.indexOf(">", tagStart);
    if (tagEnd < 0 || tagEnd >= earliest) continue;

    // 标签和调用之间只有空白才认为它们是一体的
    if (!text.slice(tagEnd + 1, earliest).trim()) earliest = tagStart;
  }

  return earliest;
}

function countUnescapedQuotes(text) {
  let count = 0;
  let escaped = false;

  for (const char of String(text || "")) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') count++;
  }

  return count;
}

export function decodeLooseToolString(value) {
  const text = String(value ?? "");

  try {
    return JSON.parse(`"${text}"`);
  } catch {
    return text
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ==========================================================================
 *  第九部分：stop 序列
 * ========================================================================== */

export function buildStopSequences(clientStop, tools, tuning = DEFAULT_TUNING) {
  const stops = [];

  if (Array.isArray(clientStop)) stops.push(...clientStop.filter(Boolean));
  else if (typeof clientStop === "string" && clientStop) stops.push(clientStop);

  if (tuning.appendStopSequence && tools.length) {
    // </invoke> 是给爱输出 Anthropic XML 风格的模型（deepseek 等）准备的。
    // 解析器两种格式都认，但让它在调用结束时立刻停下能省掉一堆胡编的后续内容。
    for (const stop of ["</tool_call>", "</invoke>"]) {
      if (!stops.includes(stop)) stops.push(stop);
    }
  }

  // 大多数上游最多接受 4 个 stop，超了会直接 400
  return stops.slice(0, 4);
}
