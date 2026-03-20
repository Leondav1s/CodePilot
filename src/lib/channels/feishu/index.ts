/**
 * FeishuChannelPlugin — implements ChannelPlugin for Feishu/Lark.
 *
 * Composes: gateway (WS), inbound (parsing), outbound (sending),
 * identity (bot info), policy (access control), card-controller (streaming).
 */

import type { InboundMessage, OutboundMessage, SendResult } from '../../bridge/types';
import type { ChannelPlugin, ChannelCapabilities, ChannelMeta, CardStreamController } from '../types';
import type { FeishuConfig } from './types';
import { loadFeishuConfig, validateFeishuConfig } from './config';
import { FeishuGateway } from './gateway';
import { parseInboundMessage } from './inbound';
import { sendMessage, addReaction, removeReaction } from './outbound';
import { isUserAuthorized } from './policy';
import { createCardStreamController } from './card-controller';
import { FeishuCardWebhookServer } from './card-webhook';
import fs from 'fs';
import os from 'os';
import path from 'path';

const FEISHU_DEBUG_LOG = path.join(os.homedir(), '.codepilot', 'feishu-card-debug.log');
interface FeishuCardActionValue {
  chatId?: string;
  callback_data?: string;
  action?: string;
  operation_id?: string;
}

interface FeishuCardActionEvent {
  action?: {
    value?: FeishuCardActionValue;
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

function appendFeishuDebugLog(line: string): void {
  try {
    fs.mkdirSync(path.dirname(FEISHU_DEBUG_LOG), { recursive: true });
    fs.appendFileSync(FEISHU_DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best effort
  }
}

const EMPTY_CARD_ACTION_RESPONSE = {};

export class FeishuChannelPlugin implements ChannelPlugin<FeishuConfig> {
  readonly meta: ChannelMeta = {
    channelType: 'feishu',
    displayName: 'Feishu / Lark',
  };

  private config: FeishuConfig | null = null;
  private gateway: FeishuGateway | null = null;
  private messageQueue: InboundMessage[] = [];
  private waitResolve: ((msg: InboundMessage | null) => void) | null = null;
  /** Track last received messageId per chatId for reaction acknowledgment. */
  private lastMessageIdByChat = new Map<string, string>();
  /** Track active reaction IDs per chatId so we can remove them on completion. */
  private activeReactions = new Map<string, { messageId: string; reactionId: string }>();
  /** Optional local HTTP callback server for interactive card actions. */
  private cardWebhookServer: FeishuCardWebhookServer | null = null;

  loadConfig(): FeishuConfig | null {
    this.config = loadFeishuConfig();
    return this.config;
  }

  getConfig(): FeishuConfig | null {
    return this.config;
  }

  getCapabilities(): ChannelCapabilities {
    return {
      streaming: true,
      threadReply: true,
      search: false,  // True server-side search requires user_access_token; we only have local filtering
      history: true,
      reactions: false,
    };
  }

  validateConfig(): string | null {
    if (!this.config) {
      this.loadConfig();
    }
    return validateFeishuConfig(this.config);
  }

  async start(): Promise<void> {
    if (!this.config) {
      this.config = loadFeishuConfig();
    }
    if (!this.config) throw new Error('Feishu config not loaded');

    this.gateway = new FeishuGateway(this.config);

    // Register message handler — pushes to internal queue
    this.gateway.registerMessageHandler((data: unknown) => {
      const msg = parseInboundMessage(data, this.config!);
      if (!msg) return;
      this.enqueueMessage(msg);
    });

    // Register card action handler — converts button clicks to callback messages.
    // Gateway guarantees 3-second response; this handler should stay lightweight.
    // In WS mode we do not return toast payloads here, because the SDK expects
    // either a replacement card object or no response body at all.
    // Supports two button value formats:
    //   1. { callback_data: "perm:allow:xxx" }  — CodePilot permission buttons
    //   2. { action: "app_auth_done", operation_id: "xxx" }  — OpenClaw-style buttons
    this.gateway.registerCardActionHandler(async (data: unknown) => {
      const event = (typeof data === 'object' && data !== null ? data : {}) as FeishuCardActionEvent;
      console.log('[feishu/plugin]', 'Card action raw event:', JSON.stringify(event).slice(0, 500));
      appendFeishuDebugLog(`[plugin] raw card action=${JSON.stringify(event).slice(0, 1500)}`);
      const value = event?.action?.value ?? {};
      // Feishu card.action.trigger v2 callback structure (per official docs):
      //   event.operator.open_id, event.context.open_chat_id, event.context.open_message_id
      // SDK InteractiveCardActionEvent (older type) flattens to:
      //   event.open_id, event.open_message_id
      // WSClient monkey-patch may deliver either format — try both paths.
      // Additionally, we embed chatId in button value as ultimate fallback.
      const chatId = event?.context?.open_chat_id || value.chatId || '';
      const messageId = event?.context?.open_message_id || event?.open_message_id || '';
      const userId = event?.operator?.open_id || event?.open_id || '';

      // Format 1: callback_data (permission buttons)
      const callbackData = value.callback_data;
      if (callbackData && chatId) {
        appendFeishuDebugLog(`[plugin] callback_data parsed chatId=${chatId} messageId=${messageId} userId=${userId} callback=${callbackData}`);
        const callbackMsg: InboundMessage = {
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
        console.log('[feishu/plugin]', 'Card action (callback_data):', callbackData);
        this.enqueueMessage(callbackMsg);
        return EMPTY_CARD_ACTION_RESPONSE;
      }

      // Format 2: action / operation_id (OpenClaw-style buttons)
      const action = value.action;
      const operationId = value.operation_id;
      if (action) {
        appendFeishuDebugLog(`[plugin] action parsed chatId=${chatId} messageId=${messageId} userId=${userId} action=${action} operationId=${operationId ?? ''}`);
        // Encode as callbackData so the existing bridge-manager callback path
        // can handle it. Format: "action:{action}:{operation_id}"
        const syntheticCallback = operationId
          ? `action:${action}:${operationId}`
          : `action:${action}`;
        const actionMsg: InboundMessage = {
          messageId: messageId || `card_action_${Date.now()}`,
          address: {
            channelType: 'feishu',
            chatId,
            userId,
          },
          text: '',
          timestamp: Date.now(),
          callbackData: syntheticCallback,
          callbackMessageId: messageId,
        };
        console.log('[feishu/plugin]', 'Card action (action):', action, operationId ?? '');
        this.enqueueMessage(actionMsg);
        return EMPTY_CARD_ACTION_RESPONSE;
      }

      // Unknown button format — still return a successful empty response.
      console.warn('[feishu/plugin]', 'Unknown card action value:', JSON.stringify(value).slice(0, 200));
      appendFeishuDebugLog(`[plugin] unknown card action value=${JSON.stringify(value).slice(0, 800)}`);
      return EMPTY_CARD_ACTION_RESPONSE;
    });

    this.cardWebhookServer = new FeishuCardWebhookServer(this.config, (msg) => {
      appendFeishuDebugLog(`[plugin] injected inbound callback messageId=${msg.messageId} callback=${msg.callbackData || ''}`);
      this.enqueueMessage(msg);
    });
    await this.cardWebhookServer.start();

    await this.gateway.start();
  }

  async stop(): Promise<void> {
    if (this.cardWebhookServer) {
      await this.cardWebhookServer.stop();
      this.cardWebhookServer = null;
    }
    if (this.gateway) {
      await this.gateway.stop();
      this.gateway = null;
    }
    // Unblock any waiting consumer
    if (this.waitResolve) {
      this.waitResolve(null);
      this.waitResolve = null;
    }
  }

  isRunning(): boolean {
    return this.gateway?.isRunning() ?? false;
  }

  private enqueueMessage(msg: InboundMessage): void {
    // Track messageId for reaction acknowledgment (skip callback messages)
    if (msg.messageId && !msg.callbackData) {
      this.lastMessageIdByChat.set(msg.address.chatId, msg.messageId);
    }
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve(msg);
    } else {
      this.messageQueue.push(msg);
    }
  }

  /** Allow non-WS integrations (for example Feishu card webhooks) to inject messages. */
  injectInboundMessage(msg: InboundMessage): void {
    this.enqueueMessage(msg);
  }

  async consumeOne(): Promise<InboundMessage | null> {
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!;
    }
    return new Promise<InboundMessage | null>((resolve) => {
      this.waitResolve = resolve;
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const client = this.gateway?.getRestClient();
    if (!client) return { ok: false, error: 'Not connected' };
    return sendMessage(client, message);
  }

  isAuthorized(userId: string, chatId: string): boolean {
    if (!this.config) return false;
    return isUserAuthorized(this.config, userId, chatId);
  }

  /** Add emoji reaction to acknowledge message receipt. */
  onMessageStart(chatId: string): void {
    const client = this.gateway?.getRestClient();
    const messageId = this.lastMessageIdByChat.get(chatId);
    if (!client || !messageId) return;
    // Fire-and-forget — don't block message processing
    addReaction(client, messageId, 'Typing').then((reactionId) => {
      if (reactionId) {
        this.activeReactions.set(chatId, { messageId, reactionId });
      }
    }).catch(() => {});
  }

  /** Remove the "processing" reaction after response is sent. */
  onMessageEnd(chatId: string): void {
    const client = this.gateway?.getRestClient();
    const reaction = this.activeReactions.get(chatId);
    if (!client || !reaction) return;
    this.activeReactions.delete(chatId);
    removeReaction(client, reaction.messageId, reaction.reactionId).catch(() => {});
  }

  getCardStreamController(): CardStreamController | null {
    const client = this.gateway?.getRestClient();
    if (!client) {
      console.log('[feishu/plugin] getCardStreamController: no client');
      return null;
    }
    if (!this.config) {
      console.log('[feishu/plugin] getCardStreamController: no config');
      return null;
    }
    return createCardStreamController(client, this.config.cardStreamConfig);
  }

  /** Expose gateway for direct access (e.g. message-actions need restClient). */
  get _gateway(): FeishuGateway | null {
    return this.gateway;
  }
}
