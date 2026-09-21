import type { Plugin as PromisePlugin } from "@opencode/plugin"
import { Model, Plugin } from "@opencode/plugin/effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"

/** V2's Promise adapter ignores request options; use public Effect cancellation. */
export function withNativeSessionCancellation(plugin: PromisePlugin.Plugin) {
  return Plugin.define({
    id: plugin.id,
    effect: (host) => Effect.gen(function* () {
      const run = Effect.runPromiseWith(yield* Effect.context())
      const id = (sessionID: string) => ({ sessionID: Schema.decodeUnknownSync(Session.ID)(sessionID) })
      yield* fromPromise({ ...plugin, setup: (ctx) => plugin.setup({ ...ctx, session: {
        ...ctx.session,
        get: async (input, options) => await run(host.session.get(id(input.sessionID)).pipe(
          Effect.flatMap(Schema.encodeEffect(Session.Info)),
        ), { signal: options?.signal }) as Awaited<ReturnType<PromisePlugin.Context["session"]["get"]>>,
        wait: (input, options) => run(host.session.wait(id(input.sessionID)), { signal: options?.signal }),
        switchModel: (input, options) => run(host.session.switchModel({ ...id(input.sessionID),
          model: Schema.decodeUnknownSync(Model.Ref)(input.model),
        }), { signal: options?.signal }),
        // Creation/prompt admission are transactional mutations. Await their
        // completion, then explicitly interrupt and drain; never abandon them.
      } }) }).effect(host)
    }),
  })
}
