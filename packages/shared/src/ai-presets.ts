import type { AIConfig, AIProviderId } from './types';

export interface AIProviderPreset {
  id: AIProviderId;
  name: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  /** 官方文档 */
  docs: string;
  /** API Key 申请页面（设置页一键跳转） */
  console: string;
  /** 是否对浏览器直连友好（有 CORS），网页端仍统一走代理 */
  supportsCors: boolean;
  notes?: string;
}

export const AI_PRESETS: AIProviderPreset[] = [
  {
    id: 'platform',
    name: '平台积分',
    baseUrl: 'https://md.zhengl.vip/api/ai',
    models: ['deepseek-chat', 'deepseek-reasoner', 'mimo-v2.6-flash', 'mimo-v2.6-pro', 'qwen-plus', 'glm-4.6', 'hunyuan-turbos-latest'],
    defaultModel: 'mimo-v2.6-flash',
    docs: 'https://md.zhengl.vip/account?tab=credits',
    console: 'https://md.zhengl.vip/account?tab=credits',
    supportsCors: true,
    notes: '无需配置个人 API Key，自动使用管理员后台开通的 AI 渠道并按后台配置的计费方式扣除平台积分。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    docs: 'https://platform.deepseek.com/api-docs',
    console: 'https://platform.deepseek.com/api_keys',
    supportsCors: false,
    notes: 'OpenAI 兼容接口，路径为 /chat/completions。',
  },
  {
    id: 'xiaomi-mimo',
    name: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed'],
    defaultModel: 'mimo-v2.6-flash',
    docs: 'https://platform.xiaomimimo.com',
    console: 'https://platform.xiaomimimo.com',
    supportsCors: false,
    notes: 'OpenAI 兼容接口；模型名随账号权限变化，建议在设置中「获取最新列表」。',
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    defaultModel: 'qwen-plus',
    docs: 'https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope',
    console: 'https://bailian.console.aliyun.com/',
    supportsCors: false,
    notes: 'DashScope OpenAI 兼容模式。',
  },
  {
    id: 'tencent-hunyuan',
    name: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-turbos-latest', 'hunyuan-large', 'hunyuan-standard'],
    defaultModel: 'hunyuan-turbos-latest',
    docs: 'https://cloud.tencent.com/document/product/1729/111007',
    console: 'https://console.cloud.tencent.com/hunyuan/api-key',
    supportsCors: false,
    notes: 'OpenAI 兼容接口，使用控制台创建的 API Key。',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'],
    defaultModel: 'glm-4.6',
    docs: 'https://open.bigmodel.cn/dev/api',
    console: 'https://open.bigmodel.cn/usercenter/apikeys',
    supportsCors: false,
    notes: 'OpenAI 兼容接口。',
  },
  {
    id: 'volcengine-ark',
    name: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-pro-32k'],
    defaultModel: 'doubao-seed-1-6-250615',
    docs: 'https://www.volcengine.com/docs/82379/1298454',
    console: 'https://console.volcengine.com/ark',
    supportsCors: false,
    notes: '模型名也可填写推理接入点 ID（ep-xxxx）。',
  },
  {
    id: 'baidu-qianfan',
    name: '百度千帆',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    models: ['ernie-4.5-turbo-128k', 'ernie-4.0-8k', 'ernie-speed-128k'],
    defaultModel: 'ernie-4.5-turbo-128k',
    docs: 'https://cloud.baidu.com/doc/qianfan-api/index.html',
    console: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    supportsCors: false,
    notes: '千帆 v2 提供 OpenAI 兼容的 /chat/completions。',
  },
  {
    id: 'custom-openai',
    name: '自定义 OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini',
    docs: 'https://platform.openai.com/docs/api-reference',
    console: 'https://platform.openai.com/api-keys',
    supportsCors: true,
    notes: '任意兼容 /chat/completions 的服务，含本地 Ollama、vLLM、OneAPI。',
  },
];

export function getAIPreset(id: AIProviderId): AIProviderPreset {
  return AI_PRESETS.find((p) => p.id === id) ?? AI_PRESETS[0]!;
}

export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  models: [],
  temperature: 0.7,
  maxTokens: 4096,
  viaProxy: false,
  usePlatform: false,
};
