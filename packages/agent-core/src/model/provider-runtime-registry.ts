/**
 * Provider Runtime Registry — maps provider IDs to factory functions.
 *
 * AssistantRuntime uses the registry to create the appropriate
 * ProviderRuntime for a given provider without knowing the
 * implementation details.
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §5.
 */

import type { ProviderRuntime } from "./model-runtime.js"

/* ------------------------------------------------------------------ */
/*  Factory types                                                      */
/* ------------------------------------------------------------------ */

export interface ProviderRuntimeFactoryInput {
  providerId: string
  model: string
  apiKey: string
  baseUrl: string
  headers?: Record<string, string>
}

export interface ProviderRuntimeFactory {
  create(input: ProviderRuntimeFactoryInput): ProviderRuntime
}

export interface ProviderRuntimeRegistry {
  register(providerId: string, factory: ProviderRuntimeFactory): void
  create(providerId: string, input: ProviderRuntimeFactoryInput): ProviderRuntime
}

/* ------------------------------------------------------------------ */
/*  DefaultRegistry implementation                                     */
/* ------------------------------------------------------------------ */

/**
 * Simple map-based registry. Thread-safe for single-process usage.
 *
 * ```ts
 * const registry = new DefaultProviderRuntimeRegistry()
 * registry.register("mimo", createMimoWsRuntime)
 * registry.register("openai-compatible", createMimoWsRuntime)
 * ```
 */
export class DefaultProviderRuntimeRegistry implements ProviderRuntimeRegistry {
  private readonly factories = new Map<string, ProviderRuntimeFactory>()

  register(providerId: string, factory: ProviderRuntimeFactory): void {
    if (this.factories.has(providerId)) {
      throw new Error(`Provider runtime already registered for "${providerId}"`)
    }
    this.factories.set(providerId, factory)
  }

  create(providerId: string, input: ProviderRuntimeFactoryInput): ProviderRuntime {
    const factory = this.factories.get(providerId)
    if (!factory) {
      throw new Error(`No provider runtime registered for "${providerId}"`)
    }
    return factory.create(input)
  }
}
