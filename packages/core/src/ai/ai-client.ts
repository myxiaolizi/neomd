import type { AIConfig, AIChatMessage, AIStreamEvent, AIUsage } from '@neomd/shared';
import { getAIPreset } from '@neomd/shared';

/** AI 客户端：统一 OpenAI 兼容协议，支持流式输出与中断 */
export interface AIClientOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface ChatRequest {
  messages: AIChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  model?: string;
}

export interface ChatResponse {
  text: string;
  usage?: AIUsage;
}

export class AIClient {
  constructor(
    private config: AIConfig,
    private readonly options: AIClientOptions = {},
  ) {}

  updateConfig(config: AIConfig): void {
    this.config = config;
  }

  /** 必须绑定全局对象，否则以 this 为接收者调用会抛 Illegal invocation */
  private get fetchImpl(): typeof fetch {
    const impl = this.options.fetchImpl ?? globalThis.fetch;
    if (!impl) throw new Error('当前环境不支持 fetch');
    return impl.bind(globalThis) as typeof fetch;
  }

  private url(path: string): string {
    const preset = getAIPreset(this.config.provider);
    const base = (this.config.baseUrl || preset.baseUrl).replace(/\/+$/, '');
    return `${base}${path}`;
  }

  headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: req.model ?? this.config.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature ?? this.config.temperature,
      max_tokens: req.maxTokens ?? this.config.maxTokens,
      stream: false,
    };
    const res = await this.fetchImpl(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: this.options.signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`AI 请求失败 ${res.status}: ${err.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; delta?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.delta?.content ?? '';
    return {
      text,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : undefined,
    };
  }

  /** 流式对话，逐段回调 */
  async chatStream(req: ChatRequest, onEvent: (e: AIStreamEvent) => void): Promise<void> {
    const body = {
      model: req.model ?? this.config.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature ?? this.config.temperature,
      max_tokens: req.maxTokens ?? this.config.maxTokens,
      stream: true,
    };
    let res: Response;
    try {
      res = await this.fetchImpl(this.url('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: this.options.signal,
      });
    } catch (e) {
      onEvent({ type: 'error', error: (e as Error).message });
      return;
    }
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      onEvent({ type: 'error', error: `AI 请求失败 ${res.status}: ${err.slice(0, 300)}` });
      return;
    }
    if (!res.body) {
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      onEvent({ type: 'delta', text: data.choices?.[0]?.message?.content ?? '' });
      onEvent({ type: 'done' });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: AIUsage | undefined;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) onEvent({ type: 'delta', text: delta });
            if (json.usage) {
              usage = {
                promptTokens: json.usage.prompt_tokens ?? 0,
                completionTokens: json.usage.completion_tokens ?? 0,
                totalTokens: json.usage.total_tokens ?? 0,
              };
            }
          } catch {
            /* 忽略不完整的行 */
          }
        }
      }
      onEvent({ type: 'done', usage });
    } catch (e) {
      onEvent({ type: 'error', error: (e as Error).message });
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  /** 连通性检测：先试对话补全，若账户未充值/模型受限则回退验证 /models 鉴权 */
  async test(): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const started = Date.now();
    try {
      const res = await this.chat({
        messages: [{ role: 'user', content: '回复「ok」两个字，不要其他内容。' }],
        maxTokens: 16,
        temperature: 0,
      });
      if (res.text) {
        return { ok: true, message: res.text.slice(0, 80), latencyMs: Date.now() - started };
      }
    } catch {
      /* 继续尝试 /models 校验连通与鉴权 */
    }
    try {
      const m = await this.listModels();
      if (m.source === 'upstream' && m.models.length > 0) {
        return {
          ok: true,
          message: `接口与密钥验证通过（可用模型 ${m.models.length} 个）`,
          latencyMs: Date.now() - started,
        };
      }
      return { ok: false, message: m.message || '未获取到模型', latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, message: (e as Error).message, latencyMs: Date.now() - started };
    }
  }

  /** 拉取服务商最新模型列表：优先 /models 接口，失败回退静态预设 */
  async listModels(): Promise<{ models: string[]; source: 'upstream' | 'static'; message?: string }> {
    const preset = getAIPreset(this.config.provider);
    const staticModels = preset.models;
    if (!this.config.apiKey) {
      return { models: staticModels, source: 'static', message: '未配置 API Key，显示内置模型列表' };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      let res: Response;
      try {
        res = await this.fetchImpl(this.url('/models'), {
          method: 'GET',
          headers: this.headers(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        return { models: staticModels, source: 'static', message: `接口返回 ${res.status}，使用内置列表` };
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
      const list = (data.data ?? data.models ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (!list.length) {
        return { models: staticModels, source: 'static', message: '接口未返回模型，使用内置列表' };
      }
      list.sort((a, b) => a.localeCompare(b));
      return { models: list, source: 'upstream' };
    } catch (e) {
      return { models: staticModels, source: 'static', message: `获取失败：${(e as Error).message}` };
    }
  }
}

/* ------------------------------------------------------------------ */
/* 提示词模板                                                          */
/* ------------------------------------------------------------------ */

export const PROMPTS = {
  title: `你是笔记标题生成器。阅读用户给出的 Markdown 正文，生成一个准确、简洁的中文标题。
要求：
1. 只输出标题本身，不要引号、不要标点结尾、不要解释；
2. 长度 6-24 个汉字（英文概念可保留原词）；
3. 若正文含一级标题，可参考但需更精炼；
4. 不得包含 / \\ : * ? " < > | 等文件名非法字符。`,

  generate: `你是 Markdown 写作助手。根据用户指令生成结构清晰的 Markdown 内容。
要求：使用合适的标题层级、列表与代码块；不要输出解释性开场白；直接输出 Markdown 正文。`,

  polish: `你是中文写作润色助手。在不改变原意与事实的前提下，改进用户文本的表达：修正错别字与语病、统一术语、让句式更顺。
要求：保持原有 Markdown 结构（标题、列表、代码块、链接）不变；只输出润色后的 Markdown，不要任何说明。`,

  format: `你是 Markdown 排版助手。重新组织用户文本的结构：补全标题层级、把长段落拆成列表、为并列内容使用表格、为步骤使用有序列表。
要求：不增删事实信息；只输出排版后的 Markdown 正文。`,

  tags: `你是知识库标签助手。阅读 Markdown 正文，输出 3-6 个层级化中文标签，使用 / 分隔层级（如 技术/前端/Vue）。
只输出以逗号分隔的标签列表，不要解释。`,

  summary: `用不超过 80 字概括这段 Markdown 的核心内容，只输出摘要正文。`,
} as const;

export interface WritingTaskInput {
  content: string;
  instruction: string;
  context?: Record<string, string>;
}

/** 自动命名：从正文提取标题（支持用户自定义提示词） */
export async function generateTitle(client: AIClient, content: string, customPrompt?: string): Promise<string> {
  const excerpt = content.slice(0, 4000);
  const sysPrompt = customPrompt && customPrompt.trim() ? customPrompt.trim() : PROMPTS.title;
  const res = await client.chat({
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: excerpt || '（正文为空，请给出「空笔记」）' },
    ],
    temperature: 0.3,
    maxTokens: 64,
  });
  return cleanTitle(res.text);
}

export function cleanTitle(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^#+\s*/, '');
  t = t.replace(/^["'「『《]|["'」』》]$/g, '');
  t = t.replace(/[\\/:*?"<>|]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 60) t = t.slice(0, 60).trim();
  return t || '未命名笔记';
}

/** 生成正文 */
export async function generateContent(client: AIClient, input: WritingTaskInput): Promise<string> {
  const res = await client.chat({
    messages: [
      { role: 'system', content: PROMPTS.generate },
      { role: 'user', content: buildUserPrompt(PROMPTS.generate, input) },
    ],
  });
  return res.text.trim();
}

export async function polishContent(client: AIClient, input: WritingTaskInput): Promise<string> {
  const res = await client.chat({
    messages: [
      { role: 'system', content: PROMPTS.polish },
      { role: 'user', content: input.content },
    ],
  });
  return res.text.trim();
}

export async function formatContent(client: AIClient, input: WritingTaskInput): Promise<string> {
  const res = await client.chat({
    messages: [
      { role: 'system', content: PROMPTS.format },
      { role: 'user', content: input.content },
    ],
  });
  return res.text.trim();
}

export async function suggestTags(client: AIClient, content: string): Promise<string[]> {
  const res = await client.chat({
    messages: [
      { role: 'system', content: PROMPTS.tags },
      { role: 'user', content: content.slice(0, 4000) },
    ],
    maxTokens: 128,
    temperature: 0.2,
  });
  return res.text
    .split(/[,，\n]/)
    .map((t) => t.trim().replace(/^#/, ''))
    .filter(Boolean)
    .slice(0, 8);
}

function buildUserPrompt(system: string, input: WritingTaskInput): string {
  const parts: string[] = [];
  if (input.instruction.trim()) parts.push(`指令：${input.instruction.trim()}`);
  if (input.content.trim()) parts.push(`现有内容：\n${input.content.slice(0, 6000)}`);
  if (input.context) {
    const ctx = Object.entries(input.context)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    if (ctx) parts.push(`上下文：\n${ctx}`);
  }
  return parts.join('\n\n');
}
