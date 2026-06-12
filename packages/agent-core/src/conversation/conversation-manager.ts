/**
 * ConversationManager — local conversation lifecycle & message store.
 *
 * Responsible for:
 *   1. Creating / activating / closing conversations.
 *   2. Storing user & assistant messages.
 *   3. Persisting `lastRemoteContextId` for WS continuation.
 *   4. Providing message history for ContextManager / model input building.
 *
 * This is a pure in-memory store. Phase 1 does not implement persistence.
 * The store is intentionally simple — no Reactive/observable wrappers.
 *
 * See docs/ws_model_communication_architecture.md §3.1 (ConversationManager).
 */
import type { RemoteContextId } from "../ws/ws-types.js"

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/** A single message in a conversation (plain-text only for Phase 1). */
export interface ConversationMessage {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt: number
}

/** A user-facing conversation. */
export interface Conversation {
  id: string
  title: string
  status: "active" | "idle" | "closed"
  createdAt: number
  updatedAt: number
  messages: ConversationMessage[]
  summary: string | null
  lastRemoteContextId: RemoteContextId | null
  lastActiveAt: number
}

/* ------------------------------------------------------------------ */
/*  ConversationManager                                                */
/* ------------------------------------------------------------------ */

export class ConversationManager {
  private conversations = new Map<string, Conversation>()

  /* ---- Lifecycle ---- */

  /**
   * Create a new conversation with status "active".
   * Generates a unique ID automatically.
   */
  createConversation(title?: string): Conversation {
    const id = this.generateId("conv")
    const now = Date.now()
    const conv: Conversation = {
      id,
      title: title ?? "New Conversation",
      status: "active",
      createdAt: now,
      updatedAt: now,
      messages: [],
      summary: null,
      lastRemoteContextId: null,
      lastActiveAt: now,
    }
    this.conversations.set(id, conv)
    return conv
  }

  /** Look up a conversation by ID. */
  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id)
  }

  /**
   * Mark a conversation as active (re-activate after idle).
   * Returns `undefined` if the conversation does not exist or is closed.
   */
  activateConversation(id: string): Conversation | undefined {
    const conv = this.conversations.get(id)
    if (!conv) return undefined
    if (conv.status === "closed") return undefined
    conv.status = "active"
    conv.updatedAt = Date.now()
    return conv
  }

  /**
   * Close a conversation permanently.
   * Returns `false` if the conversation does not exist.
   */
  closeConversation(id: string): boolean {
    const conv = this.conversations.get(id)
    if (!conv) return false
    conv.status = "closed"
    conv.updatedAt = Date.now()
    return true
  }

  /* ---- Message operations ---- */

  /**
   * Append a user message to the conversation.
   * Returns the created message, or `null` if the conversation doesn't exist.
   */
  appendUserMessage(conversationId: string, content: string): ConversationMessage | null {
    const conv = this.conversations.get(conversationId)
    if (!conv) return null
    const msg: ConversationMessage = {
      id: this.generateId("msg"),
      role: "user",
      content,
      createdAt: Date.now(),
    }
    conv.messages.push(msg)
    conv.updatedAt = Date.now()
    conv.lastActiveAt = Date.now()
    return msg
  }

  /**
   * Create an empty assistant message placeholder.
   * The RunController will fill in content incrementally as deltas arrive.
   */
  appendAssistantMessage(conversationId: string): ConversationMessage | null {
    const conv = this.conversations.get(conversationId)
    if (!conv) return null
    const msg: ConversationMessage = {
      id: this.generateId("msg"),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    }
    conv.messages.push(msg)
    conv.updatedAt = Date.now()
    conv.lastActiveAt = Date.now()
    return msg
  }

  /**
   * Replace the content of an assistant message.
   * Used by RunController when flushing accumulated delta.
   */
  updateAssistantMessage(conversationId: string, messageId: string, content: string): boolean {
    const conv = this.conversations.get(conversationId)
    if (!conv) return false
    const msg = conv.messages.find((m) => m.id === messageId)
    if (!msg || msg.role !== "assistant") return false
    msg.content = content
    conv.updatedAt = Date.now()
    conv.lastActiveAt = Date.now()
    return true
  }

  /**
   * Remove the latest turn that starts with a matching user message.
   *
   * Retry needs to re-run the same user input without leaving the failed turn
   * in local history. We delete the matching user message and everything after
   * it (assistant placeholder/partial reply/tool observations), then clear the
   * remote context pointer because it may refer to the removed tail.
   */
  removeLastTurnByUserContent(conversationId: string, content: string): boolean {
    const conv = this.conversations.get(conversationId)
    if (!conv) return false

    const startIndex = findLastIndex(conv.messages, (msg) => msg.role === "user" && msg.content === content)
    if (startIndex < 0) return false

    conv.messages.splice(startIndex)
    conv.lastRemoteContextId = null
    conv.updatedAt = Date.now()
    conv.lastActiveAt = Date.now()
    return true
  }

  /* ---- Remote context ---- */

  /** Persist the last remote context ID for WS continuation. */
  setLastRemoteContextId(conversationId: string, remoteContextId: RemoteContextId | null): boolean {
    const conv = this.conversations.get(conversationId)
    if (!conv) return false
    conv.lastRemoteContextId = remoteContextId
    conv.updatedAt = Date.now()
    return true
  }

  /* ---- Query ---- */

  /** Return a shallow copy of the conversation's message list. */
  getMessages(conversationId: string): ConversationMessage[] {
    const conv = this.conversations.get(conversationId)
    if (!conv) return []
    return [...conv.messages]
  }

  /** Return all conversations (useful for listing). */
  getAllConversations(): Conversation[] {
    return Array.from(this.conversations.values())
  }

  /* ---- Internal ---- */

  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index
  }
  return -1
}
