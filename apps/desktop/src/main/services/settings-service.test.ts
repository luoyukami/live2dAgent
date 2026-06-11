/**
 * SettingsService — emotionProfile sanitization contracts.
 *
 * These tests pin the contract that no malformed binding can ever leak into
 * the public settings object, regardless of whether the bad data arrived
 * via the persisted `settings.json` file or via a runtime patch.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_PROMPT_PRESET_SETTINGS } from "@live2d-agent/shared"
import { SettingsService } from "./settings-service.js"

/* ------------------------------------------------------------------ */
/*  Test harness                                                       */
/* ------------------------------------------------------------------ */

function makeTempUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "live2d-settings-test-"))
}

function writeSettingsJson(userDataDir: string, payload: unknown): void {
  writeFileSync(join(userDataDir, "settings.json"), JSON.stringify(payload, null, 2), "utf8")
}

function makeServiceWith(payload: Record<string, unknown>): { service: SettingsService; dir: string } {
  const dir = makeTempUserDataDir()
  writeSettingsJson(dir, payload)
  const service = new SettingsService(dir)
  return { service, dir }
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ */
/*  1. On-disk load: invalid entries are dropped, not spread in        */
/* ------------------------------------------------------------------ */

test("deepMergeDefaults: invalid emotionProfile bindings are dropped, valid ones survive", () => {
  const dir = makeTempUserDataDir()
  try {
    writeSettingsJson(dir, {
      live2d: {
        modelPath: "",
        scale: 1.2,
        x: 0,
        y: 0,
        // Mixed bag: one good entry, three with a single bad field (the
        // good fields should survive), and two entries that should be
        // dropped wholesale.
        emotionProfile: {
          happy: { motion: "tap_body", motionIndex: 2, expression: "smile", priority: 1 },
          sad: { motion: "idle", motionIndex: -1, expression: "frown" }, // bad motionIndex, keep the rest
          angry: { motion: 42, expression: "fury" }, // bad motion, keep expression
          confused: { motionIndex: "zero" }, // bad motionIndex, nothing else valid → drop entry
          bogus_emotion: { motion: "idle" }, // unknown emotion key → drop entry
          empty: {}, // nothing valid → drop entry
        },
      },
    })

    const { service } = { service: new SettingsService(dir) }
    const publicSettings = service.getPublicSettings()
    const profile = publicSettings.live2d.emotionProfile

    assert.ok(profile, "emotionProfile should still be present (at least one good entry)")

    // `happy` (fully good), `sad` (bad motionIndex stripped, rest kept),
    // and `angry` (bad motion stripped, expression kept) must survive.
    assert.deepEqual(Object.keys(profile).sort(), ["angry", "happy", "sad"])

    const happy = profile.happy
    assert.ok(happy, "happy binding must be present")
    assert.equal(happy.motion, "tap_body")
    assert.equal(happy.motionIndex, 2)
    assert.equal(happy.expression, "smile")
    assert.equal(happy.priority, 1)

    // `sad`: bad motionIndex stripped, the rest survives.
    const sad = profile.sad
    assert.ok(sad, "sad binding should survive with its good fields")
    assert.equal(sad?.motion, "idle")
    assert.equal(sad?.motionIndex, undefined, "negative motionIndex must be stripped")
    assert.equal(sad?.expression, "frown")

    // `angry`: bad motion stripped, expression survives.
    const angry = profile.angry
    assert.ok(angry, "angry binding should survive with its good fields")
    assert.equal(angry?.motion, undefined, "non-string motion must be stripped")
    assert.equal(angry?.expression, "fury")

    // Entries with no usable field must be gone.
    assert.equal(profile.confused, undefined, "fully-bad binding must be dropped")
    // `bogus_emotion` and `empty` are unknown keys, so the typed surface
    // doesn't expose them; check the underlying record shape.
    const rawProfile = profile as Record<string, unknown>
    assert.equal(rawProfile.bogus_emotion, undefined, "unknown emotion keys must not leak through")
    assert.equal(rawProfile.empty, undefined, "fully empty bindings must be dropped")

    // Internal state must agree with the public surface.
    const internal = service.get()
    assert.equal(internal.live2d.emotionProfile?.sad?.motionIndex, undefined)
  } finally {
    cleanup(dir)
  }
})

test("reasoningEffort defaults to low and validates public patches", () => {
  const { service, dir } = makeServiceWith({})
  try {
    assert.equal(service.getPublicSettings().reasoningEffort, "low")

    service.updatePublicPatch({ reasoningEffort: "high" })
    assert.equal(service.getPublicSettings().reasoningEffort, "high")

    assert.throws(
      () => service.updatePublicPatch({ reasoningEffort: "ultra" as never }),
      /Invalid reasoning effort/,
    )
  } finally {
    cleanup(dir)
  }
})

test("promptPresets default, merge, and accept public patches", () => {
  const { service, dir } = makeServiceWith({
    promptPresets: { userInfoPrompt: "用户偏好简洁回答。" },
  })
  try {
    const initial = service.getPublicSettings().promptPresets
    assert.equal(initial.rolePrompt, DEFAULT_PROMPT_PRESET_SETTINGS.rolePrompt)
    assert.equal(initial.userInfoPrompt, "用户偏好简洁回答。")

    service.updatePublicPatch({
      promptPresets: {
        rolePrompt: "你是测试助手。",
        userInfoPrompt: "用户使用 TypeScript。",
      },
    })

    const updated = service.getPublicSettings().promptPresets
    assert.equal(updated.rolePrompt, "你是测试助手。")
    assert.equal(updated.userInfoPrompt, "用户使用 TypeScript。")

    assert.throws(
      () => service.updatePublicPatch({ promptPresets: { rolePrompt: 42 as never } }),
      /promptPresets\.rolePrompt must be a string/,
    )
  } finally {
    cleanup(dir)
  }
})

test("deepMergeDefaults: a non-object emotionProfile does not poison the merged live2d object", () => {
  const dir = makeTempUserDataDir()
  try {
    // Common hand-edit mistakes: a string, an array, or null.
    for (const bad of ["happy", [1, 2, 3], null, 42]) {
      writeSettingsJson(dir, { live2d: { emotionProfile: bad } })
      const service = new SettingsService(dir)
      const profile = service.getPublicSettings().live2d.emotionProfile
      assert.equal(profile, undefined, `emotionProfile must be undefined when given ${JSON.stringify(bad)}`)
      // Other live2d fields must still load correctly.
      assert.ok(service.getPublicSettings().live2d, "live2d object itself must survive")
    }
  } finally {
    cleanup(dir)
  }
})

test("deepMergeDefaults: a fully-bad profile (no good entries) is replaced by undefined", () => {
  const { service, dir } = makeServiceWith({
    live2d: {
      // Every binding is fully malformed.
      emotionProfile: {
        happy: { motion: 1, expression: 2 }, // both fields bad
        sad: { motionIndex: -5 }, // only bad field
        confused: { motionIndex: "no" }, // only bad field
      },
    },
  })
  try {
    const profile = service.getPublicSettings().live2d.emotionProfile
    assert.equal(
      profile,
      undefined,
      "profile with zero usable entries must collapse to undefined (not {})",
    )
  } finally {
    cleanup(dir)
  }
})

/* ------------------------------------------------------------------ */
/*  2. Runtime patch: invalid entries are dropped, not applied         */
/* ------------------------------------------------------------------ */

test("updatePublicPatch: invalid emotionProfile bindings are dropped before being applied", () => {
  const { service, dir } = makeServiceWith({})
  try {
    service.updatePublicPatch({
      // Cast through `never` — the test deliberately feeds the public
      // patch validator a malformed binding shape to verify runtime defence.
      live2d: {
        emotionProfile: {
          happy: { motion: "tap_body", expression: "smile" }, // good
          sad: { motion: 99 }, // bad: motion must be string
          angry: { motion: "idle" }, // good
        } as never,
      },
    })

    const profile = service.getPublicSettings().live2d.emotionProfile
    assert.ok(profile, "profile should be set after patch")
    // `sad` survives with its non-string `motion` stripped (no other fields
    // were provided), so it collapses to no usable entry and is dropped.
    assert.deepEqual(Object.keys(profile).sort(), ["angry", "happy"])
    const rawProfile = profile as Record<string, unknown>
    assert.equal(rawProfile.sad, undefined, "fully-bad `sad` must not enter public settings")
    assert.equal(profile.happy?.motion, "tap_body")
    assert.equal(profile.happy?.expression, "smile")
    assert.equal(profile.angry?.motion, "idle")
  } finally {
    cleanup(dir)
  }
})

test("updatePublicPatch: a non-object emotionProfile in the patch is silently dropped (existing profile preserved)", () => {
  const { service, dir } = makeServiceWith({})
  try {
    // Seed an existing profile.
    service.updatePublicPatch({
      live2d: { emotionProfile: { happy: { motion: "tap_body" } } },
    })
    const before = service.getPublicSettings().live2d.emotionProfile
    assert.deepEqual(before, { happy: { motion: "tap_body" } })

    // Now send a malformed patch.
    service.updatePublicPatch({
      // @ts-expect-error — testing runtime defence
      live2d: { emotionProfile: "happy" },
    })

    const after = service.getPublicSettings().live2d.emotionProfile
    assert.deepEqual(
      after,
      { happy: { motion: "tap_body" } },
      "existing profile must survive a malformed patch (the key is dropped, not applied)",
    )
  } finally {
    cleanup(dir)
  }
})

test("updatePublicPatch: a fully-bad profile patch preserves the existing valid profile", () => {
  // The sanitizer returns `undefined` when zero usable entries survive. The
  // patch validator only adds `emotionProfile` to the patch in that case,
  // so a fully-malformed patch silently leaves the existing profile alone.
  const { service, dir } = makeServiceWith({})
  try {
    service.updatePublicPatch({
      live2d: { emotionProfile: { happy: { motion: "tap_body" } } },
    })

    service.updatePublicPatch({
      // Cast through `never` — the test deliberately feeds the public
      // patch validator a fully-malformed binding shape.
      live2d: {
        emotionProfile: {
          happy: { motion: 1, expression: 2 }, // both bad → entry dropped
          sad: { motionIndex: "no" }, // bad → entry dropped
        } as never,
      },
    })

    const profile = service.getPublicSettings().live2d.emotionProfile
    assert.deepEqual(
      profile,
      { happy: { motion: "tap_body" } },
      "a fully-malformed patch must not clear the existing valid profile",
    )
  } finally {
    cleanup(dir)
  }
})

/* ------------------------------------------------------------------ */
/*  3. Panel dimensions (ui.panelWidth / ui.panelHeight)               */
/* ------------------------------------------------------------------ */

test("default panel dimensions are 460 / 760", () => {
  const { service, dir } = makeServiceWith({})
  try {
    assert.equal(service.getPublicSettings().ui.panelWidth, 460)
    assert.equal(service.getPublicSettings().ui.panelHeight, 760)
  } finally {
    cleanup(dir)
  }
})

test("deepMergeDefaults: persisted panel dimensions override defaults", () => {
  const { service, dir } = makeServiceWith({ ui: { panelWidth: 500, panelHeight: 800 } })
  try {
    assert.equal(service.getPublicSettings().ui.panelWidth, 500)
    assert.equal(service.getPublicSettings().ui.panelHeight, 800)
  } finally {
    cleanup(dir)
  }
})

test("deepMergeDefaults: missing panel dimensions fall back to defaults", () => {
  // Simulate a settings.json saved by an older version without panel fields.
  const { service, dir } = makeServiceWith({
    ui: { width: 360, height: 720, windowMode: "dual" },
  })
  try {
    assert.equal(service.getPublicSettings().ui.panelWidth, 460)
    assert.equal(service.getPublicSettings().ui.panelHeight, 760)
  } finally {
    cleanup(dir)
  }
})

test("updatePublicPatch: panelWidth / panelHeight accept valid integers", () => {
  const { service, dir } = makeServiceWith({})
  try {
    service.updatePublicPatch({ ui: { panelWidth: 600, panelHeight: 900 } })
    assert.equal(service.getPublicSettings().ui.panelWidth, 600)
    assert.equal(service.getPublicSettings().ui.panelHeight, 900)
  } finally {
    cleanup(dir)
  }
})

test("updatePublicPatch: panel dimensions reject out-of-range values", () => {
  const { service, dir } = makeServiceWith({})
  try {
    assert.throws(
      () => service.updatePublicPatch({ ui: { panelWidth: 50 } }),
      /ui\.panelWidth must be a number between 200 and 4000/,
    )
    assert.throws(
      () => service.updatePublicPatch({ ui: { panelHeight: 5000 } }),
      /ui\.panelHeight must be a number between 200 and 4000/,
    )
    assert.throws(
      () => service.updatePublicPatch({ ui: { panelWidth: 350.5 } }),
      /ui\.panelWidth must be an integer between 200 and 4000/,
    )
  } finally {
    cleanup(dir)
  }
})

/* ------------------------------------------------------------------ */
/*  4. Round-trip persistence: bad data on disk does not survive reload */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  5. Window mode setting (ui.windowMode)                             */
/* ------------------------------------------------------------------ */

test("default windowMode is dual", () => {
  const { service, dir } = makeServiceWith({})
  try {
    assert.equal(service.getPublicSettings().ui.windowMode, "dual")
  } finally {
    cleanup(dir)
  }
})

test("deepMergeDefaults: invalid persisted windowMode falls back to dual", () => {
  const { service, dir } = makeServiceWith({ ui: { windowMode: "triple" } })
  try {
    assert.equal(service.getPublicSettings().ui.windowMode, "dual")
    assert.equal(service.get().ui.windowMode, "dual")
  } finally {
    cleanup(dir)
  }
})

test("updatePublicPatch: windowMode accepts dual and combined, rejects others", () => {
  const { service, dir } = makeServiceWith({})
  try {
    // Default is dual
    assert.equal(service.getPublicSettings().ui.windowMode, "dual")

    // Accept combined
    service.updatePublicPatch({ ui: { windowMode: "combined" } })
    assert.equal(service.getPublicSettings().ui.windowMode, "combined")

    // Revert to dual
    service.updatePublicPatch({ ui: { windowMode: "dual" } })
    assert.equal(service.getPublicSettings().ui.windowMode, "dual")

    // Reject invalid value
    assert.throws(
      () => service.updatePublicPatch({ ui: { windowMode: "triple" as never } }),
      /Invalid ui\.windowMode/,
    )
  } finally {
    cleanup(dir)
  }
})

test("companionWatch settings merge persisted values but disable proactive mode on startup", () => {
  const { service, dir } = makeServiceWith({
    companionWatch: {
      attachScreenshotOnUserMessage: true,
      proactiveEnabled: true,
      proactiveInterval: "random",
    },
  })
  try {
    assert.deepEqual(service.getPublicSettings().companionWatch, {
      attachScreenshotOnUserMessage: true,
      proactiveEnabled: false,
      proactiveInterval: "random",
    })
    const persisted = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Record<string, any>
    assert.equal(persisted.companionWatch.proactiveEnabled, false)
  } finally {
    cleanup(dir)
  }
})

test("updatePublicPatch: companionWatch accepts valid values and rejects invalid interval", () => {
  const dir = makeTempUserDataDir()
  try {
    const service = new SettingsService(dir)
    assert.deepEqual(service.getPublicSettings().companionWatch, {
      attachScreenshotOnUserMessage: false,
      proactiveEnabled: false,
      proactiveInterval: "30s",
    })

    service.updatePublicPatch({
      companionWatch: {
        attachScreenshotOnUserMessage: true,
        proactiveEnabled: true,
        proactiveInterval: "1m",
      },
    })

    assert.deepEqual(service.getPublicSettings().companionWatch, {
      attachScreenshotOnUserMessage: true,
      proactiveEnabled: true,
      proactiveInterval: "1m",
    })

    assert.throws(
      () => service.updatePublicPatch({ companionWatch: { proactiveInterval: "5m" as never } }),
      /Invalid companionWatch\.proactiveInterval/,
    )
  } finally {
    cleanup(dir)
  }
})

test("reload(): settings.json written by a previous session is re-sanitized on load", () => {
  const dir = makeTempUserDataDir()
  try {
    // Initial load with a valid profile.
    writeSettingsJson(dir, {
      live2d: { emotionProfile: { happy: { motion: "tap_body" } } },
    })
    const first = new SettingsService(dir)
    assert.deepEqual(first.getPublicSettings().live2d.emotionProfile, {
      happy: { motion: "tap_body" },
    })

    // Hand-edit the file to add a malformed binding (simulating a
    // user breaking the file or an older buggy version writing it).
    writeSettingsJson(dir, {
      live2d: {
        emotionProfile: {
          happy: { motion: "tap_body" },
          sad: { motion: 99 }, // bad
          bogus: { motion: "x" }, // unknown emotion key
        },
      },
    })

    const reloaded = new SettingsService(dir)
    const profile = reloaded.getPublicSettings().live2d.emotionProfile
    assert.deepEqual(
      Object.keys(profile ?? {}).sort(),
      ["happy"],
      "reloaded profile must only contain the well-formed `happy` binding",
    )
  } finally {
    cleanup(dir)
  }
})
