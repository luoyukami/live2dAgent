/**
 * Tests for doom-loop-detector.ts — DoomLoopDetector.
 *
 * Covers:
 *   - First call with a tool+args is always allowed
 *   - Consecutive identical calls up to threshold are allowed
 *   - (threshold + 1)-th identical call is blocked
 *   - Different args for same tool resets the count
 *   - Different tool is always allowed
 *   - reset() clears all counters
 *   - Custom threshold works
 *   - buildDoomLoopErrorOutput produces valid JSON
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { DoomLoopDetector, buildDoomLoopErrorOutput } from "./doom-loop-detector.js"

describe("DoomLoopDetector", () => {
  test("first call is always allowed", () => {
    const detector = new DoomLoopDetector(3)
    const result = detector.check("file.read", { path: "/tmp/x" })
    assert.equal(result.allowed, true)
  })

  test("consecutive identical calls up to threshold are allowed", () => {
    const detector = new DoomLoopDetector(3)

    // First 3 identical calls should be allowed
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true)
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true)
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true)
  })

  test("(threshold + 1)-th identical call is blocked", () => {
    const detector = new DoomLoopDetector(3)

    detector.check("file.read", { path: "/tmp/x" }) // 1st — allowed
    detector.check("file.read", { path: "/tmp/x" }) // 2nd — allowed
    detector.check("file.read", { path: "/tmp/x" }) // 3rd — allowed
    const result = detector.check("file.read", { path: "/tmp/x" }) // 4th — blocked

    assert.equal(result.allowed, false)
    assert.ok(result.reason)
    assert.ok(result.reason!.includes("blocked"))
    assert.ok(result.reason!.includes("file.read"))
  })

  test("different args for same tool resets the count", () => {
    const detector = new DoomLoopDetector(3)

    detector.check("file.read", { path: "/tmp/x" }) // 1st
    detector.check("file.read", { path: "/tmp/x" }) // 2nd
    detector.check("file.read", { path: "/tmp/x" }) // 3rd — still allowed
    // Different args
    detector.check("file.read", { path: "/tmp/y" }) // 1st again (different args)
    assert.equal(detector.check("file.read", { path: "/tmp/y" }).allowed, true) // 2nd with new args
    assert.equal(detector.check("file.read", { path: "/tmp/y" }).allowed, true) // 3rd with new args
    // 4th with identical new args should be blocked
    const result = detector.check("file.read", { path: "/tmp/y" })
    assert.equal(result.allowed, false)
  })

  test("different tool is always allowed independently", () => {
    const detector = new DoomLoopDetector(3)

    // Make 4 identical calls to file.read — should block on 4th
    detector.check("file.read", { path: "/tmp/x" })
    detector.check("file.read", { path: "/tmp/x" })
    detector.check("file.read", { path: "/tmp/x" })
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, false)

    // But different tool is still allowed
    assert.equal(detector.check("shell.run", { command: "ls" }).allowed, true)
    assert.equal(detector.check("shell.run", { command: "ls" }).allowed, true)
    assert.equal(detector.check("shell.run", { command: "ls" }).allowed, true)
    assert.equal(detector.check("shell.run", { command: "ls" }).allowed, false) // 4th blocked
  })

  test("reset clears all counters", () => {
    const detector = new DoomLoopDetector(3)

    detector.check("file.read", { path: "/tmp/x" })
    detector.check("file.read", { path: "/tmp/x" })
    detector.check("file.read", { path: "/tmp/x" })
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, false)

    detector.reset()

    // After reset, should be allowed again
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true)
  })

  test("custom threshold works", () => {
    const detector = new DoomLoopDetector(1) // Only 1 allowed, 2nd blocked

    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true)
    const result = detector.check("file.read", { path: "/tmp/x" })
    assert.equal(result.allowed, false)
  })

  test("threshold of 0 blocks every repetition", () => {
    const detector = new DoomLoopDetector(0) // 0 allowed means even first call is... 

    // With threshold 0: first call increments to 1, which is > 0, so blocked
    const result = detector.check("file.read", { path: "/tmp/x" })
    assert.equal(result.allowed, false)
  })

  test("args object key order independence", () => {
    const detector = new DoomLoopDetector(3)

    // Same args but different key order
    detector.check("tool", { a: "1", b: "2" })
    detector.check("tool", { b: "2", a: "1" }) // should be treated as same
    detector.check("tool", { a: "1", b: "2" }) // same as first
    const result = detector.check("tool", { b: "2", a: "1" }) // should be blocked (4th identical)

    assert.equal(result.allowed, false)
  })

  test("nested args are compared correctly", () => {
    const detector = new DoomLoopDetector(3)

    const args1 = { path: "/tmp/x", options: { recursive: true, force: false } }
    const args2 = { path: "/tmp/x", options: { recursive: true, force: false } }
    const args3 = { path: "/tmp/x", options: { recursive: true, force: true } } // different

    detector.check("tool", args1)
    detector.check("tool", args2) // same as args1
    detector.check("tool", args2) // same as args1
    assert.equal(detector.check("tool", args1).allowed, false) // 4th identical — blocked

    // Different args should reset
    assert.equal(detector.check("tool", args3).allowed, true) // new args — allowed
  })
})

describe("buildDoomLoopErrorOutput", () => {
  test("produces valid JSON with expected fields", () => {
    const output = buildDoomLoopErrorOutput(
      "file.read",
      "Doom loop blocked: tool \"file.read\" called 4 times with identical args",
    )

    const parsed = JSON.parse(output)
    assert.equal(parsed.status, "error")
    assert.equal(parsed.summary, "Repeated identical tool call blocked.")
    assert.ok(parsed.content.includes("Doom loop blocked"))
    assert.ok(parsed.content.includes("file.read"))
  })
})
