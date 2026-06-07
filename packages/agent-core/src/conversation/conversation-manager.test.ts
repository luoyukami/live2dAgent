/**
 * ConversationManager unit tests.
 *
 * Phase 1 scope: create/get/close conversation, append/read messages,
 * remote context ID persistence.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { ConversationManager } from "./conversation-manager.js"
import type { ConversationMessage } from "./conversation-manager.js"

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

describe("ConversationManager lifecycle", () => {
  test("createConversation returns a conversation with default fields", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation()

    assert.ok(conv.id.startsWith("conv_"), `Expected id to start with "conv_", got ${conv.id}`)
    assert.equal(conv.title, "New Conversation")
    assert.equal(conv.status, "active")
    assert.equal(typeof conv.createdAt, "number")
    assert.equal(typeof conv.updatedAt, "number")
    assert.deepEqual(conv.messages, [])
    assert.equal(conv.summary, null)
    assert.equal(conv.lastRemoteContextId, null)
    assert.equal(typeof conv.lastActiveAt, "number")
  })

  test("createConversation with custom title", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation("My Chat")
    assert.equal(conv.title, "My Chat")
  })

  test("getConversation returns the conversation by id", () => {
    const mgr = new ConversationManager()
    const created = mgr.createConversation()
    const retrieved = mgr.getConversation(created.id)
    assert.equal(retrieved, created)
  })

  test("getConversation returns undefined for unknown id", () => {
    const mgr = new ConversationManager()
    assert.equal(mgr.getConversation("nonexistent"), undefined)
  })

  test("closeConversation marks the conversation as closed", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation()
    assert.equal(conv.status, "active")

    const result = mgr.closeConversation(conv.id)
    assert.equal(result, true)
    assert.equal(conv.status, "closed")
  })

  test("closeConversation returns false for unknown id", () => {
    const mgr = new ConversationManager()
    assert.equal(mgr.closeConversation("nonexistent"), false)
  })

  test("activateConversation on a closed conversation returns undefined", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation()
    mgr.closeConversation(conv.id)
    const result = mgr.activateConversation(conv.id)
    assert.equal(result, undefined)
  })

  test("activateConversation on an active conversation sets status to active", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation()
    const result = mgr.activateConversation(conv.id)
    assert.ok(result !== undefined)
    assert.equal(result!.status, "active")
  })

  test("getAllConversations returns all created conversations", () => {
    const mgr = new ConversationManager()
    const c1 = mgr.createConversation("Chat 1")
    const c2 = mgr.createConversation("Chat 2")
    const all = mgr.getAllConversations()
    assert.equal(all.length, 2)
    assert.ok(all.includes(c1))
    assert.ok(all.includes(c2))
  })
})

/* ------------------------------------------------------------------ */
/*  Messages                                                           */
/* ------------------------------------------------------------------ */

describe("ConversationManager messages", () => {
  test("appendUserMessage adds a user message and updates timestamps", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation()
    const before = conv.updatedAt

    // Small delay so timestamps differ
    const msg = mgr.appendUserMessage(conv.id, "Hello!")
    assert.ok(msg !== null)
    assert.equal(msg!.role, "user")
    assert.equal(msg!.content, "Hello!")
    assert.ok(msg!.id.startsWith("msg_"))
    assert.equal(typeof msg!.createdAt, "number")

    assert.equal(conv.messages.length, 1)
    assert.equal(conv.messages[0], msg)
    assert.ok(conv.updatedAt >= before)
    assert.ok(conv.lastActiveAt >= before)
  })

  test("appendUserMessage returns null for unknown conversation", () => {
    const mgr = new ConversationManager()
    assert.equal(mgr.appendUserMessage("nonexistent", "hi"), null)
  })

  test("appendAssistantMessage creates an empty assistant placeholder", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation()
    const msg = mgr.appendAssistantMessage(conv.id)
    assert.ok(msg !== null)
    assert.equal(msg!.role, "assistant")
    assert.equal(msg!.content, "")
    assert.equal(conv.messages.length, 1)
  })

  test("appendAssistantMessage returns null for unknown conversation", () => {
    const mgr = new ConversationManager()
    assert.equal(mgr.appendAssistantMessage("nonexistent"), null)
  })

  test("updateAssistantMessage replaces content of an assistant message", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation()
    const msg = mgr.appendAssistantMessage(conv.id)!

    const result = mgr.updateAssistantMessage(conv.id, msg.id, "Hello world")
    assert.equal(result, true)
    assert.equal(msg.content, "Hello world")
  })

  test("updateAssistantMessage returns false for unknown message id", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation()
    assert.equal(mgr.updateAssistantMessage(conv.id, "nonexistent", "x"), false)
  })

  test("updateAssistantMessage returns false for non-assistant messages", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation()
    const userMsg = mgr.appendUserMessage(conv.id, "hi")!
    assert.equal(mgr.updateAssistantMessage(conv.id, userMsg.id, "x"), false)
  })

  test("getMessages returns a copy of the messages array", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation()
    mgr.appendUserMessage(conv.id, "Hello")
    mgr.appendAssistantMessage(conv.id)

    const msgs = mgr.getMessages(conv.id)
    assert.equal(msgs.length, 2)
    // Verify it's a copy
    msgs.push({ id: "fake", role: "user", content: "fake", createdAt: 0 })
    assert.equal(conv.messages.length, 2)
  })

  test("getMessages returns empty array for unknown conversation", () => {
    const mgr = new ConversationManager()
    assert.deepEqual(mgr.getMessages("nonexistent"), [])
  })
})

/* ------------------------------------------------------------------ */
/*  Remote context ID                                                  */
/* ------------------------------------------------------------------ */

describe("ConversationManager remote context ID", () => {
  test("setLastRemoteContextId stores the remote context id", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation()
    const result = mgr.setLastRemoteContextId(conv.id, "ctx_abc123")
    assert.equal(result, true)
    assert.equal(conv.lastRemoteContextId, "ctx_abc123")
  })

  test("setLastRemoteContextId can clear (set to null)", () => {
    const mgr = new ConversationManager()
    const conv = mgr.createConversation()
    mgr.setLastRemoteContextId(conv.id, "ctx_abc")
    mgr.setLastRemoteContextId(conv.id, null)
    assert.equal(conv.lastRemoteContextId, null)
  })

  test("setLastRemoteContextId returns false for unknown conversation", () => {
    const mgr = new ConversationManager()
    assert.equal(mgr.setLastRemoteContextId("nonexistent", "ctx_1"), false)
  })
})
