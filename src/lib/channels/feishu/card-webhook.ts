import http from 'http';
import * as lark from '@larksuiteoapi/node-sdk';
import { URL } from 'url';
import type { InboundMessage } from '../../bridge/types';
import type { FeishuConfig } from './types';

const LOG_TAG = '[feishu/card-webhook]';
const EMPTY_JSON_RESPONSE = {};

interface CardActionValue {
  chatId?: string;
  callback_data?: string;
  action?: string;
  operation_id?: string;
}

interface CardActionEvent {
  action?: {
    value?: CardActionValue;
  };
  context?: {
    open_chat_id?: string;
    open_message_id?: string;
  };
  open_message_id?: string;
  operator?: {
    open_id?: string;
  };
  open_id?: string;
}

function toInboundMessage(event: CardActionEvent): InboundMessage | null {
  const value = event?.action?.value ?? {};
  const chatId = event?.context?.open_chat_id || value.chatId || '';
  const messageId = event?.context?.open_message_id || event?.open_message_id || '';
  const userId = event?.operator?.open_id || event?.open_id || '';
  const callbackData = value.callback_data;

  if (callbackData && chatId) {
    return {
      messageId: messageId || `card_action_${Date.now()}`,
      address: {
        channelType: 'feishu',
        chatId,
        userId,
      },
      text: '',
      timestamp: Date.now(),
      callbackData,
      callbackMessageId: messageId,
    };
  }

  const action = value.action;
  const operationId = value.operation_id;
  if (action && chatId) {
    return {
      messageId: messageId || `card_action_${Date.now()}`,
      address: {
        channelType: 'feishu',
        chatId,
        userId,
      },
      text: '',
      timestamp: Date.now(),
      callbackData: operationId ? `action:${action}:${operationId}` : `action:${action}`,
      callbackMessageId: messageId,
    };
  }

  return null;
}

export class FeishuCardWebhookServer {
  private server: http.Server | null = null;

  constructor(
    private readonly config: FeishuConfig,
    private readonly onInboundMessage: (msg: InboundMessage) => void,
  ) {}

  async start(): Promise<void> {
    if (this.server || !this.config.cardWebhook.enabled) return;

    const cardDispatcher = new lark.CardActionHandler(
      {
        encryptKey: this.config.cardWebhook.encryptKey || '',
        verificationToken: this.config.cardWebhook.verificationToken || '',
      },
      async (data: CardActionEvent) => {
        const msg = toInboundMessage(data);
        if (msg) {
          this.onInboundMessage(msg);
        } else {
          console.warn(LOG_TAG, 'Unsupported card action payload');
        }
        // Feishu card callbacks require a valid JSON object response body
        // even when we choose to keep the original card unchanged.
        return EMPTY_JSON_RESPONSE;
      },
    );

    const handler = lark.adaptDefault(
      this.config.cardWebhook.path,
      cardDispatcher,
      { autoChallenge: true },
    );
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/healthz') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'GET' && req.url) {
        const parsedUrl = new URL(req.url, 'http://localhost');
        if (parsedUrl.pathname === this.config.cardWebhook.path) {
          const challenge = parsedUrl.searchParams.get('challenge');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(challenge ? { challenge } : { ok: true }));
          return;
        }
      }
      console.log(LOG_TAG, `Incoming ${req.method || 'UNKNOWN'} ${req.url || ''}`);
      handler(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(
        this.config.cardWebhook.port,
        this.config.cardWebhook.host,
        () => resolve(),
      );
    });

    console.log(
      LOG_TAG,
      `Listening on http://${this.config.cardWebhook.host}:${this.config.cardWebhook.port}${this.config.cardWebhook.path}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
