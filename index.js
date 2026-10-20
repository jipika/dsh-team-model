/** Host half of the Team Model bundle: `spawn_teammate_with_model`.
 *
 * Dependency-free on purpose: profile-side bundles cannot resolve
 * `@deepseek-ai/*` packages (they live inside the packed app), so the tool
 * is registered as a plain object with raw JSON Schemas — the same pattern
 * the working local plugins (e.g. dsh-team-member-preset) use.
 */

import { parseModelRoute, buildAgentOptions, isRouteHonored } from './lib/route.js'
import { ensureActivationPatch, installActivationPatch, routeMarker } from './lib/activation-patch.js'

export const inject = ['tools', 'agentTeams', 'subagents']

const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', enum: ['lead', 'teammate'] },
    status: { type: 'string', enum: ['running', 'inactive', 'provisioning', 'failed'] },
    description: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    model: { type: 'string' },
    diagnostics: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'name', 'role', 'status', 'diagnostics'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    member: MEMBER_VIEW_SCHEMA,
    routeHonored: { type: 'boolean' },
    requestedRoute: { type: 'string' },
    effectiveModel: { type: 'string' },
  },
  required: ['member', 'routeHonored'],
}

function teammateReminder(name, marker) {
  return `<system-reminder>
You are teammate "${name}".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>
${marker}
`
}

/** Register the additive tool; returns its cleanup. */
export function apply(ctx) {
  const patch = installActivationPatch(ctx)

  const disposeTool = ctx.tools.register({
    name: 'spawn_teammate_with_model',
    description: 'Create one named, durable teammate with an optional model route. Omit model to inherit the Lead route; supply "<provider>/<model>" to override it. Only the Team Lead may call this tool.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique lower-kebab-case teammate name.' },
        description: { type: 'string', description: 'Short description of the delegated responsibility.' },
        prompt: { type: 'string', description: 'Complete initial task for the teammate.' },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
        },
        model: {
          type: 'string',
          description: 'Optional "<provider>/<model>" LLM route for the teammate. Omit to inherit the Lead route.',
        },
        reasoning_effort: {
          type: 'string',
          description: 'Optional reasoning effort for the selected route. Requires model.',
        },
      },
      required: ['name', 'description', 'prompt'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) throw new Error('spawn_teammate_with_model requires a calling Agent')
      let membership
      try {
        membership = ctx.agentTeams.tryMembership(caller)
      } catch {
        membership = undefined
      }
      if (membership === undefined || membership.role !== 'lead') {
        throw new Error('only the Team Lead can create teammates (spawn_teammate_with_model)')
      }
      const context = args.context ?? 'fresh'
      const route = args.model === undefined ? undefined : parseModelRoute(args.model)
      if (args.model !== undefined && route === undefined) {
        throw new Error(`model must be "<provider>/<model>", got "${args.model}"`)
      }
      if (args.reasoning_effort !== undefined && route === undefined) {
        throw new Error('reasoning_effort requires model (supply provider and model together)')
      }
      const agentOptions = route === undefined
        ? undefined
        : buildAgentOptions(route, args.reasoning_effort)
      if (agentOptions !== undefined && !ensureActivationPatch(ctx)) {
        throw new Error('per-teammate routes are unavailable: the subagents.startActivation patch did not install')
      }
      const name = String(args.name).trim()
      const created = await ctx.agentTeams.spawnTeammate(caller, {
        name,
        description: args.description,
        prompt: [
          { type: 'text', text: teammateReminder(name, routeMarker(agentOptions)) },
          { type: 'text', text: args.prompt },
        ],
        context,
        provider: context === 'fork' ? 'fork' : 'spawn',
        // Forward-compatible: runtimes that forward agentOptions honor the
        // route; the activation patch below makes the current roster do so.
        ...(agentOptions === undefined ? {} : { agentOptions }),
        signal: exec.signal,
      })
      const live = ctx.agentTeams.listMembers(caller).find((m) => m.name === created.member.name)
      const member = live ?? created.member
      const effectiveModel = member.model
      const honored = isRouteHonored(route?.model, effectiveModel)
      if (!honored) {
        throw new Error(
          `the roster did not honour the per-teammate route (requested "${args.model}", effective model "${effectiveModel ?? 'unknown'}"). `
          + `Teammate "${created.member.name}" was created on the inherited route; its name is now reserved. `
          + `That means the subagents.startActivation patch is not installed in this host; retry with a fresh name after it is.`,
        )
      }
      return {
        member,
        routeHonored: honored,
        ...(args.model === undefined ? {} : { requestedRoute: args.model }),
        ...(effectiveModel === undefined ? {} : { effectiveModel }),
      }
    },
  })
  return () => {
    disposeTool?.()
    patch.dispose()
  }
}
