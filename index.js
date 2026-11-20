/** Host half of the Team Model bundle: `spawn_teammate_with_model`.
 *
 * Dependency-free on purpose: profile-side bundles cannot resolve
 * `@deepseek-ai/*` packages (they live inside the packed app), so the tool
 * is registered as a plain object with raw JSON Schemas — the same pattern
 * the working local plugins (e.g. dsh-team-member-preset) use.
 */

import { parseModelRoute, buildAgentOptions, isRouteHonored, isSameSelection, selectionText } from './lib/route.js'
import { ensureActivationPatch, installActivationPatch, routeMarker } from './lib/activation-patch.js'

export const inject = ['tools', 'agentTeams', 'subagents', 'sessionPersistence']

const log = (...a) => console.log('[dsh-team-model]', ...a)

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

  // ── team_assign_model：会话中途改成员模型 ─────────────────────────────
  // 与 team_assign_preset 同一骨架。活体成员直接 agent.model.select()（与官方
  // session/selectModel 同一落点，下一轮请求即走新路由，history 头部插一条
  // "[model changed: …]" 通告）；离场成员往 session log 追加 model/selection
  // 事件（write 单写者 + seq 连续），冷恢复时投影终值接管 —— AgentModel.current()
  // 读 recordedSelection（pending ?? lastUsed），压过 descriptor 的 agentOptions。
  // reasoning_effort 用 ctx.llm.resolveCallConfig 预校验（官方 selectModel 同款），
  // 防止写进 log 一个 adapter 会拒的档位。

  const switches = new Map() // sessionId -> Promise，串行化同一成员的连续切换

  function fail(code, message) {
    const e = new Error(message)
    e.code = code
    return e
  }

  /** 末条 model/selection 事件（持久化 log 上的投影终值来源）。 */
  function lastPersistedSelection(events) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.type === 'model/selection') return e.data ?? null
    }
    return null
  }

  async function readPersistedSelection(sessionId) {
    const persistence = ctx.sessionPersistence
    if (persistence === undefined) return null
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
    } catch {
      return null
    }
    try {
      const all = await handle.read()
      return lastPersistedSelection(all.events)
    } catch {
      return null
    } finally {
      try { await handle.close() } catch { /* close 幂等 */ }
    }
  }

  async function assignModel(callerAgent, targetName, selection) {
    const teams = ctx.agentTeams
    const agents = ctx.agents
    if (teams === undefined || agents === undefined) {
      throw fail('unavailable', 'required services (agentTeams / agents) are absent')
    }

    let rows
    try {
      rows = teams.listMembers(callerAgent)
    } catch (error) {
      const code = String(error?.code ?? '')
      const msg = String(error?.message ?? error)
      if (code.includes('NOT_MEMBER') || /not a member/i.test(msg)) {
        throw fail('not-a-team', '当前会话不属于任何 Agent Team —— 先用 spawn_teammate 开团，再使用本工具')
      }
      throw error
    }

    const callerId = callerAgent.session?.id ?? callerAgent.id
    const leadRow = rows.find((r) => r.role === 'lead')
    if (leadRow === undefined || leadRow.id !== callerId) {
      throw fail('lead-only', '只有 Team Lead 可以指派成员模型（assign model）')
    }

    const wanted = String(targetName ?? '').trim()
    if (wanted === 'lead') {
      throw fail('lead-self', '目标为 lead 本会话 —— 用 GUI 的模型选择器或 /model 切换自己的模型')
    }
    const targetRow = rows.find((r) => r.role === 'teammate' && r.name === wanted)
    if (targetRow === undefined) {
      const names = rows.map((r) => (r.role === 'lead' ? 'lead' : r.name)).join(', ')
      throw fail('target-not-found', `找不到成员 "${targetName}"（可用: ${names}）`)
    }

    const targetAgent = agents.get(targetRow.id)

    // 只读：省略 model → 报告当前生效选择
    if (selection === undefined) {
      let current
      if (targetAgent !== undefined) {
        const recorded = targetAgent.model?.current()
        current = recorded ? { ...recorded } : null
      } else {
        current = await readPersistedSelection(targetRow.id)
      }
      return {
        target: targetRow.name,
        changed: false,
        selection: current ? { provider: current.provider, model: current.model, ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }) } : null,
        status: targetRow.status,
        text: `成员 "${targetRow.name}" 当前模型: ${selectionText(current)}（${targetRow.status}）。要切换请带 model="<provider>/<model>"。`,
      }
    }

    // effort 预校验：official selectModel 在记录前走 resolveCallConfig；adapter 拒的
    // 档位在这里就拒，不写脏 log。
    if (selection.reasoningEffort !== undefined) {
      const llm = ctx.get('llm')
      if (llm !== undefined) {
        try {
          await llm.resolveCallConfig({ provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort })
        } catch (error) {
          throw fail('effort-unsupported', String(error?.message ?? error))
        }
      }
    }

    // 离场成员：持久化通道（不需要活体）
    if (targetAgent === undefined) {
      const result = await persistSelection(targetRow.id, targetRow.name, selection)
      return result
    }

    // 活体成员：串行 → turnBoundary 守卫 → select
    const before = targetAgent.model?.current() ?? null
    const prev = switches.get(targetRow.id) ?? Promise.resolve()
    const turn = prev.then(async () => {
      const boundary = ctx.sessionProjections?.stateOf?.(targetAgent.session, 'turnBoundary')
      if (boundary !== undefined && boundary !== null
        && boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined) {
        throw fail('turn/open', `成员 "${targetRow.name}" 有轮次正在进行；等它空闲后再切模型`)
      }
      const current = targetAgent.model?.current() ?? null
      if (isSameSelection(current, selection)) {
        return { changed: false, previous: current }
      }
      targetAgent.model.select({ ...selection })
      return { changed: true, previous: current }
    })
    switches.set(targetRow.id, turn.catch(() => {}))
    const { changed, previous } = await turn
    return {
      target: targetRow.name,
      changed,
      selection: { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) },
      previous: previous ? { provider: previous.provider, model: previous.model, ...(previous.reasoningEffort === undefined ? {} : { reasoningEffort: previous.reasoningEffort }) } : null,
      text: changed
        ? `已把成员 "${targetRow.name}" 从 ${selectionText(previous)} 切到 ${selectionText(selection)}。它下一轮请求即走新路由（history 头部会带一条 model changed 通告）。`
        : `成员 "${targetRow.name}" 已是 ${selectionText(selection)}，无需切换。`,
    }
  }

  /** 往离场成员的 session log 追加 model/selection（写单写者 + seq 连续 + flush）。 */
  async function persistSelection(sessionId, memberName, selection) {
    const persistence = ctx.sessionPersistence
    if (persistence === undefined) throw fail('unavailable', 'sessionPersistence service absent')
    let handle
    try {
      handle = await persistence.open(sessionId, 'write')
    } catch (error) {
      if (error?.name === 'SessionAlreadyOwnedError') {
        throw fail('session-busy', `成员 "${memberName}" 的会话正在唤醒/写入中，稍后重试（写所有权被占用）`)
      }
      throw fail('persist-open-failed', `打开会话存储失败: ${error?.message ?? error}`)
    }
    try {
      const all = await handle.read()
      const seqs = all.events.map((e) => e.seq)
      const nextSeq = seqs.length > 0 ? seqs[seqs.length - 1] + 1 : 0
      const previous = lastPersistedSelection(all.events)
      if (isSameSelection(previous, selection)) {
        return {
          target: memberName,
          changed: false,
          selection: { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) },
          text: `成员 "${memberName}" 已是 ${selectionText(selection)}（持久化 log 末条即该选择），无需重复写入。`,
        }
      }
      await handle.append([{
        type: 'model/selection',
        seq: nextSeq,
        time: Date.now(),
        data: { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) },
      }])
      await handle.flush()
      return {
        target: memberName,
        changed: true,
        selection: { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) },
        previous: previous ? { provider: previous.provider, model: previous.model, ...(previous.reasoningEffort === undefined ? {} : { reasoningEffort: previous.reasoningEffort }) } : null,
        text: `已把 ${selectionText(selection)} 写入成员 "${memberName}" 的会话日志（seq ${nextSeq}）。它下次被唤醒/恢复时按投影终值走新路由。`,
      }
    } finally {
      try { await handle.close() } catch { /* close 幂等 */ }
    }
  }

  const SELECTION_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      provider: { type: 'string' },
      model: { type: 'string' },
      reasoningEffort: { type: 'string' },
    },
    required: ['provider', 'model'],
  }

  ctx.tools.register({
    name: 'team_assign_model',
    description:
      'Assign an LLM model route (provider/model and optional reasoning effort) to one Agent Team member session. Team Lead only. '
      + 'A live member switches immediately (takes effect on its next request); an inactive member gets the selection written into '
      + 'its session log and resumes on the new route. Omit `model` to read the member\'s current route and status. '
      + 'The target member must be idle (no running turn). Not for your own session — use the GUI model selector or /model for that.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Member name as returned by list_agents (its target).',
        },
        model: {
          type: 'string',
          description: 'Optional "<provider>/<model>" LLM route to assign. Omit to read the current route only.',
        },
        reasoning_effort: {
          type: 'string',
          description: 'Optional reasoning effort for the route. Requires model.',
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          changed: { type: 'boolean' },
          target: { type: 'string' },
          selection: { oneOf: [SELECTION_SCHEMA, { type: 'null' }] },
          previous: { oneOf: [SELECTION_SCHEMA, { type: 'null' }] },
          status: { type: 'string' },
        },
        required: ['text', 'changed', 'target'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const agent = exec === null || typeof exec !== 'object' ? undefined : exec.agent
      if (agent === undefined || agent === null) {
        throw fail('no-agent', 'tool run context has no live agent')
      }
      try {
        let selection
        if (args.model !== undefined && String(args.model).trim() !== '') {
          const route = parseModelRoute(args.model)
          if (route === undefined) {
            throw fail('bad-route', `model 必须是 "<provider>/<model>"，收到 "${args.model}"`)
          }
          if (args.reasoning_effort !== undefined) {
            selection = { ...route, reasoningEffort: String(args.reasoning_effort).trim() }
          } else {
            selection = route
          }
        }
        return await assignModel(agent, args.target, selection)
      } catch (error) {
        if (error !== null && typeof error === 'object' && typeof error.code === 'string') throw error
        throw fail('assign-failed', String(error?.message ?? error))
      }
    },
  })

  log('team_assign_model registered (Host layer, all presets)')

  return () => {
    disposeTool?.()
    patch.dispose()
  }
}
