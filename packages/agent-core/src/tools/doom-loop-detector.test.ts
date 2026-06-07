/**
 * Tests for doom-loop-detector.ts — DoomLoopDetector.
 *
 * Covers:
 *   - First call with a tool+args is always allowed
 *   - Consecutive identical calls up to threshold are allowed
 *   - (threshold + 1)-th identical call is blocked
 *   - Different args for same tool resets the count
 *   - Different tool resets the count (truly consecutive tracking)
 *   - Non-consecutive pattern A,B,A,C,A,A — no false positives
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

    // Build consecutive count for args /tmp/x
    detector.check("file.read", { path: "/tmp/x" }) // count=1
    detector.check("file.read", { path: "/tmp/x" }) // count=2
    detector.check("file.read", { path: "/tmp/x" }) // count=3 — still allowed

    // Different args resets count to 1
    assert.equal(detector.check("file.read", { path: "/tmp/y" }).allowed, true) // count=1 (different args → reset)
    assert.equal(detector.check("file.read", { path: "/tmp/y" }).allowed, true) // count=2
    assert.equal(detector.check("file.read", { path: "/tmp/y" }).allowed, true) // count=3
    // 4th with same y-args should be blocked
    const result = detector.check("file.read", { path: "/tmp/y" })
    assert.equal(result.allowed, false)

    // Switching back to /tmp/x also resets (last was /tmp/y)
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true) // count=1 (reset!)
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true) // count=2
  })

  test("different tool resets the consecutive count", () => {
    const detector = new DoomLoopDetector(3)

    // Build up a consecutive count of 3 for file.read
    detector.check("file.read", { path: "/tmp/x" }) // count=1
    detector.check("file.read", { path: "/tmp/x" }) // count=2
    detector.check("file.read", { path: "/tmp/x" }) // count=3 (still allowed)

    // Switching to a different tool resets — shell.run starts at count=1
    assert.equal(detector.check("shell.run", { command: "ls" }).allowed, true) // count=1
    assert.equal(detector.check("shell.run", { command: "ls" }).allowed, true) // count=2
    assert.equal(detector.check("shell.run", { command: "ls" }).allowed, true) // count=3
    assert.equal(detector.check("shell.run", { command: "ls" }).allowed, false) // count=4 — blocked

    // Switching BACK to file.read resets again (was interrupted by different tool)
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true) // count=1 (reset!)
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true) // count=2
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true) // count=3
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, false) // count=4 — blocked
  })

  test("non-consecutive A,B,A,C,A,A does not accumulate across interruptions", () => {
    const detector = new DoomLoopDetector(3)

    // Sequence: A, B, A, C, A, A
    //          (file.read /tmp/x)(shell.run ls)(file.read /tmp/x)(shell.run pwd)(file.read /tmp/x)(file.read /tmp/x)
    // Every time a different tool appears, counts reset.
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true)  // A: count=1
    assert.equal(detector.check("shell.run", { command: "ls" }).allowed, true)   // B: count=1 (different tool)
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true)  // A: count=1 (reset — last was B)
    assert.equal(detector.check("shell.run", { command: "pwd" }).allowed, true)  // C: count=1 (different tool)
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true)  // A: count=1 (reset — last was C)
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true)  // A: count=2 (consecutive now)
    // 3rd consecutive A still allowed
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, true)  // A: count=3
    // 4th consecutive A should be blocked
    assert.equal(detector.check("file.read", { path: "/tmp/x" }).allowed, false) // A: count=4 > 3
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
