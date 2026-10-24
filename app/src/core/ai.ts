import type { AiSettings } from './types';
import { sanitizeTitle, extractTitleFromMarkdown } from '../lib/util';

export interface AiTitleResult {
  title: string;
  source: 'ai' | 'fallback';
  error?: string;
}

/** 截断正文，控制 token 消耗 */
function clipContent(md: string, max = 2600): string {
  const body = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/^---[\s\S]*?---/, '')
    .trim();
  if (body.length <= max) return body;
  return body.slice(0, max);
}

/** 清洗模型输出 */
function cleanTitle(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '');
  t = t.split(/\r?\n/).find((l) => l.trim()) ?? t;
  t = t.replace(/^(标题|题目|Title)\s*[:：]\s*/i, '');
  t = t.replace(/^[#>*\-\s]+/, '');
  t = t.replace(/^["'“”‘’《〈【\[]+/, '').replace(/["'“”‘’》〉】\]]+$/, '');
  t = t.replace(/[。．.！!？?，,、；;：:]+$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  return sanitizeTitle(t);
}

/**
 * 通过 OpenAI 兼容接口生成标题。
 * 未配置或失败时回落到本地启发式提取，保证永不阻塞保存流程。
 */
export async function generateTitle(md: string, ai: AiSettings): Promise<AiTitleResult> {
  const fallback = extractTitleFromMarkdown(md) || '未命名笔记';

  if (!ai.enabled || !ai.apiKey || !ai.endpoint) {
    return { title: fallback, source: 'fallback' };
  }

  const body = clipContent(md);
  if (!body) return { title: fallback, source: 'fallback' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(ai.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: ai.systemPrompt },
          { role: 'user', content: `笔记正文如下：\n\n${body}` },
        ],
        temperature: 0.3,
        max_tokens: 64,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        title: fallback,
        source: 'fallback',
        error: `AI 接口 ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`,
      };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = json.choices?.[0]?.message?.content ?? '';
    const title = cleanTitle(raw);
    if (!title) return { title: fallback, source: 'fallback', error: 'AI 返回空标题' };
    return { title, source: 'ai' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      title: fallback,
      source: 'fallback',
      error: controller.signal.aborted ? 'AI 请求超时' : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}
