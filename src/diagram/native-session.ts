import type { Plugin as PromisePlugin } from "@opencode/plugin"
import { Agent, Model, Plugin, Skill } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Permission } from "@opencode/schema/permission"
import { PromptInput } from "@opencode/schema/prompt-input"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
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
        create: async (input = {}, options) => await run(host.session.create({
          title: input.title ?? undefined, metadata: input.metadata ?? undefined,
          id: input.id == null ? undefined : Schema.decodeUnknownSync(Session.ID)(input.id),
          agent: input.agent == null ? undefined : Schema.decodeUnknownSync(Agent.ID)(input.agent),
          model: input.model == null ? undefined : Schema.decodeUnknownSync(Model.Ref)(input.model),
          location: input.location == null ? undefined : Schema.decodeUnknownSync(Location.PublicRef)(input.location),
          permissions: input.permissions == null ? undefined : Schema.decodeUnknownSync(Permission.Ruleset)(input.permissions),
        }).pipe(Effect.flatMap(Schema.encodeEffect(Session.Info))), { signal: options?.signal }) as Awaited<ReturnType<PromisePlugin.Context["session"]["create"]>>,
        prompt: async (input, options) => await run(host.session.prompt({
          ...Schema.decodeUnknownSync(PromptInput.Prompt)(input), ...id(input.sessionID),
          id: input.id == null ? undefined : Schema.decodeUnknownSync(SessionMessage.ID)(input.id),
          skills: input.skills?.map((skill) => ({ ...skill, id: Schema.decodeUnknownSync(Skill.ID)(skill.id) })),
          metadata: input.metadata ?? undefined, delivery: input.delivery ?? undefined, resume: input.resume ?? undefined,
        }).pipe(Effect.flatMap(Schema.encodeEffect(SessionInbox.User))), { signal: options?.signal }) as Awaited<ReturnType<PromisePlugin.Context["session"]["prompt"]>>,
        context: async (input, options) => await run(host.session.context(id(input.sessionID)).pipe(
          Effect.flatMap(Schema.encodeEffect(Schema.Array(SessionMessage.Info))),
        ), { signal: options?.signal }) as Awaited<ReturnType<PromisePlugin.Context["session"]["context"]>>,
        wait: (input, options) => run(host.session.wait(id(input.sessionID)), { signal: options?.signal }),
        update: (input, options) => run(host.session.update({ ...id(input.sessionID),
          title: input.title ?? undefined, metadata: input.metadata ?? undefined, archived: input.archived ?? undefined,
          permissions: input.permissions == null ? undefined : Schema.decodeUnknownSync(Permission.Ruleset)(input.permissions),
        }), { signal: options?.signal }),
        switchModel: (input, options) => run(host.session.switchModel({ ...id(input.sessionID),
          model: Schema.decodeUnknownSync(Model.Ref)(input.model),
        }), { signal: options?.signal }),
        // run waits for Effect interruption/finalizers, including admission's
        // activation gate. No detached request can outlive plugin cleanup.
      } }) }).effect(host)
    }),
  })
}
