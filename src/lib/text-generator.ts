import { streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import http from 'node:http';
import https from 'node:https';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import type { SSEEvent } from '@/types';
import { resolveProvider as resolveProviderUnified, toAiSdkConfig } from './provider-resolver';

interface OpenAICompatibleStreamPart {
  text?: string;
}

interface OpenAICompatibleChoice {
  delta?: {
    content?: string | Array<string | OpenAICompatibleStreamPart>;
  };
}

interface OpenAICompatibleChunk {
  choices?: OpenAICompatibleChoice[];
}

export interface StreamTextParams {
  providerId: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function buildPromptWithHistory(
  prompt: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (!history || history.length === 0) return prompt;

  const lines: string[] = [
    '<conversation_history>',
    '(This is a summary of earlier conversation turns for context. Tool calls shown here were already executed - do not repeat them or output their markers as text.)',
  ];

  for (const msg of history) {
    let content = msg.content;
    if (msg.role === 'assistant' && content.startsWith('[')) {
      try {
        const blocks = JSON.parse(content);
        const parts: string[] = [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) parts.push(block.text);
        }
        content = parts.length > 0 ? parts.join('\n') : '(assistant used tools)';
      } catch {
        // Keep original content when it is not structured tool JSON.
      }
    }
    lines.push(`${msg.role === 'user' ? 'Human' : 'Assistant'}: ${content}`);
  }

  lines.push('</conversation_history>');
  lines.push('');
  lines.push(prompt);
  return lines.join('\n');
}

async function* streamOpenAICompatibleText(params: {
  apiKey?: string;
  baseUrl?: string;
  modelId: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
}): AsyncIterable<string> {
  if (!params.baseUrl) {
    throw new Error('Missing base URL for OpenAI-compatible provider');
  }

  const url = `${params.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const messages = [
    ...(params.system ? [{ role: 'system', content: params.system }] : []),
    { role: 'user', content: params.prompt },
  ];
  const requestBody = JSON.stringify({
    model: params.modelId,
    messages,
    stream: true,
    ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
  });
  const requestUrl = new URL(url);
  const transport = requestUrl.protocol === 'http:' ? http : https;
  const proxyUrl = getProxyForUrl(url);
  const agent = proxyUrl
    ? (requestUrl.protocol === 'http:'
        ? new HttpProxyAgent(proxyUrl)
        : new HttpsProxyAgent(proxyUrl))
    : undefined;
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = transport.request({
      protocol: requestUrl.protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port || undefined,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
        ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
        ...(params.headers || {}),
      },
    }, resolve);

    req.on('error', reject);

    const abortSignal = params.abortSignal || AbortSignal.timeout(120_000);
    if (abortSignal.aborted) {
      req.destroy(new Error('Request aborted'));
      return;
    }
    abortSignal.addEventListener('abort', () => {
      req.destroy(new Error('Request aborted'));
    }, { once: true });

    req.write(requestBody);
    req.end();
  });

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    const body = await new Promise<string>((resolve, reject) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
      });
      response.on('end', () => resolve(text));
      response.on('error', reject);
    }).catch(() => '');
    throw new Error(body || `OpenAI-compatible request failed (${response.statusCode || 'unknown'})`);
  }

  let buffer = '';

  for await (const value of response) {
    buffer += Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;

      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const parsedRecord = typeof parsed === 'object' && parsed !== null
        ? parsed as OpenAICompatibleChunk
        : {};
      const choices = Array.isArray(parsedRecord.choices) ? parsedRecord.choices : [];
      for (const choice of choices) {
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta) {
          yield delta;
          continue;
        }
        if (Array.isArray(delta)) {
          for (const part of delta) {
            if (typeof part === 'string' && part) {
              yield part;
            } else if (typeof part !== 'string' && typeof part.text === 'string' && part.text) {
              yield part.text;
            }
          }
        }
      }
    }
  }
}

/**
 * Stream text from the user's current provider.
 * Returns an async iterable of text chunks.
 *
 * Provider resolution is fully delegated to the unified resolver.
 * No fallback logic here — the resolver's chain (explicit → session → global default → env)
 * is the single source of truth, matching the Claude Code SDK path.
 *
 * NOTE: Do NOT expand model aliases (sonnet/opus/haiku) here.
 * toAiSdkConfig() resolves model IDs through the provider's availableModels catalog,
 * which uses the short alias as modelId. Expanding aliases would break that lookup
 * for SDK proxy providers (Kimi, GLM, MiniMax, etc.) that expect short aliases.
 */
export async function* streamTextFromProvider(params: StreamTextParams): AsyncIterable<string> {
  const resolved = resolveProviderUnified({ providerId: params.providerId });

  if (!resolved.hasCredentials && !resolved.provider) {
    throw new Error('No text generation provider available. Please configure a provider in Settings.');
  }

  const config = toAiSdkConfig(resolved, params.model);

  // Inject process env if needed (bedrock/vertex)
  for (const [k, v] of Object.entries(config.processEnvInjections)) {
    process.env[k] = v;
  }

  // Build headers object for SDK clients (only if non-empty)
  const hasHeaders = config.headers && Object.keys(config.headers).length > 0;

  if (config.sdkType === 'openai') {
    for await (const chunk of streamOpenAICompatibleText({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      modelId: config.modelId,
      system: params.system,
      prompt: params.prompt,
      maxTokens: params.maxTokens || 4096,
      abortSignal: params.abortSignal,
      headers: config.headers,
    })) {
      yield chunk;
    }
    return;
  }

  let model;
  switch (config.sdkType) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        // apiKey and authToken are mutually exclusive in @ai-sdk/anthropic
        ...(config.authToken
          ? { authToken: config.authToken }
          : { apiKey: config.apiKey }),
        baseURL: config.baseUrl,
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      model = anthropic(config.modelId);
      break;
    }
    case 'google': {
      const google = createGoogleGenerativeAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      model = google(config.modelId);
      break;
    }
    case 'bedrock': {
      // Auth via process.env (AWS_REGION, AWS_ACCESS_KEY_ID, etc.) — already injected above
      const bedrock = createAmazonBedrock({
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      model = bedrock(config.modelId);
      break;
    }
    case 'vertex': {
      // Anthropic-on-Vertex: auth via process.env (CLOUD_ML_REGION, GOOGLE_APPLICATION_CREDENTIALS, etc.)
      const vertex = createVertexAnthropic({
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      model = vertex(config.modelId);
      break;
    }
  }

  const result = streamText({
    model: model!,
    system: params.system,
    prompt: params.prompt,
    maxOutputTokens: params.maxTokens || 4096,
    abortSignal: params.abortSignal || AbortSignal.timeout(120_000),
  });

  for await (const chunk of result.textStream) {
    yield chunk;
  }
}

/**
 * Generate complete text (non-streaming) from the user's current provider.
 * Useful when you need the full response as a string.
 */
export async function generateTextFromProvider(params: StreamTextParams): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of streamTextFromProvider(params)) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

export function streamSSEFromProvider(params: StreamTextParams & {
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      try {
        const prompt = buildPromptWithHistory(params.prompt, params.history);
        controller.enqueue(formatSSE({
          type: 'status',
          data: JSON.stringify({
            notification: true,
            message: `Connected (${params.model || 'model'})`,
            model: params.model,
            requested_model: params.model,
          }),
        }));

        for await (const chunk of streamTextFromProvider({
          ...params,
          prompt,
        })) {
          controller.enqueue(formatSSE({ type: 'text', data: chunk }));
        }

        controller.enqueue(formatSSE({
          type: 'result',
          data: JSON.stringify({ usage: null, model: params.model }),
        }));
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
      } catch (error) {
        controller.enqueue(formatSSE({
          type: 'error',
          data: error instanceof Error ? error.message : 'Text generation failed',
        }));
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
      } finally {
        controller.close();
      }
    },
  });
}
