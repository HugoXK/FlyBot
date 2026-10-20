import { MAX_NAME_LENGTH } from './limits.js' // = ds-bot roster's 40-character name truncation
import { MAX_TEAM_LENGTH } from './allocate.js'
import { PLAN_KEY, makePlan, planLine, reportPart } from './plan.js'
// Model tools. The caller comes from the tool context ({ botId }), never from arguments. A Bot
// creates only in its own downstream: `parent` must be the caller or one of its descendants (#447).
// Visible to every tree member (#16 Option B: not Main/root-only). maxChildren and depth are
// checked at the target parent; a new child is not granted. find_bots is read-only.
// tools.register keeps only type/description/enum/items from JSON Schema (minLength/maxLength
// are dropped), so every execute() validates its own arguments with validateArgs().

/** Returns null when args satisfy the schema's required/type/minLength/maxLength, else a reason. */
export function validateArgs(schema, args) {
  const a = args && typeof args === 'object' ? args : {}
  for (const key of schema.required ?? []) if (a[key] === undefined || a[key] === null) return `${key} is required`
  for (const [key, s] of Object.entries(schema.properties ?? {})) {
    const v = a[key]
    if (v === undefined || v === null) continue
    if (s.type === 'string') {
      if (typeof v !== 'string') return `${key} must be a string`
      const n = v.trim().length
      if (Number.isInteger(s.minLength) && n < s.minLength) return `${key} must be at least ${s.minLength} characters`
      if (Number.isInteger(s.maxLength) && n > s.maxLength) return `${key} must be at most ${s.maxLength} characters`
    }
    if (s.type === 'array' && !Array.isArray(v)) return `${key} must be a list`
  }
  if (schema.additionalProperties === false) {
    const extra = Object.keys(a).filter(k => !Object.hasOwn(schema.properties ?? {}, k))
    if (extra.length) return `unknown argument: ${extra.join(', ')}`
  }
  return null
}

export const LIST_CHILDREN_SCHEMA = Object.freeze({ type: 'object', properties: {}, additionalProperties: false })
export const CREATE_CHILD_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: MAX_NAME_LENGTH, description: 'Short domain name, e.g. "Cooking"' },
    role_description: { type: 'string', minLength: 1, maxLength: 1000, description: 'What the child is responsible for' },
    parent: { type: 'string', maxLength: 100, description: 'Optional: id or name of the Bot to create it under: you (default) or one of your descendants' },
  },
  required: ['name', 'role_description'],
  additionalProperties: false,
})
export const FIND_BOTS_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', maxLength: 200, description: 'Optional: a name or role to look for, e.g. "tester". Empty lists your whole branch.' },
  },
  additionalProperties: false,
})
export const CREATE_TEAM_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    team: { type: 'string', minLength: 1, maxLength: MAX_TEAM_LENGTH, description: 'Project or group name, e.g. "FlyBot". Its lead is named "<team> Lead".' },
    // The host keeps only type/description/enum/items, and DSH needs an object item to declare its keys, so members are "Name: role" strings.
    members: { type: 'array', items: { type: 'string' }, description: 'The roles, at least 2, each "Name: what it is responsible for", e.g. "Dev: writes and fixes the code"' },
    parent: { type: 'string', maxLength: 100, description: 'Optional: id or name of the Bot to put the lead under: you (default) or one of your descendants' },
  },
  required: ['team', 'members'],
  additionalProperties: false,
})
export const SET_PLAN_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    goal: { type: 'string', minLength: 1, maxLength: 300, description: 'One line: what the whole task is.' },
    parts: { type: 'array', items: { type: 'string' }, description: 'The parts you split it into, one short name each, in the wording a child will recognize. At most 12.' },
  },
  required: ['goal', 'parts'],
  additionalProperties: false,
})
export const REPORT_PART_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    part: { type: 'string', minLength: 1, maxLength: 60, description: 'The part you report on: its id (p2) or its name.' },
    status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'], description: 'done when finished; blocked when it cannot go on.' },
    note: { type: 'string', maxLength: 200, description: 'One short line of result or reason, when it helps.' },
  },
  required: ['part', 'status'],
  additionalProperties: false,
})
export const READ_PLAN_SCHEMA = Object.freeze({ type: 'object', properties: {}, additionalProperties: false })

export function registerTreeTools(fb, tree) {
  const inTree = botId => tree.isMember(botId) // visibleTo is sync
  const fail = e => ({ error: e instanceof Error ? e.message : String(e) })
  return [
    fb.registerTool({
      name: 'list_children',
      description: 'List your direct child bots (id, name, role). These and your parent are the only bots you can message.',
      parameters: LIST_CHILDREN_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(LIST_CHILDREN_SCHEMA, args ?? {})
        if (bad) return fail(bad)
        const nodes = tree.snapshot()
        if (!nodes[botId]) return fail('this bot is not part of the tree')
        return { children: tree.childrenOf(nodes, botId).map(({ id, name, role }) => ({ id, name, role })), depth: tree.depthOf(nodes, botId), limits: tree.limits }
      },
    }),
    fb.registerTool({
      name: 'find_bots',
      description: 'Read-only. Search the Bots in your branch (for the root: the whole tree) by name or role, with role, parent, depth and path. Use it before creating a Bot, to reuse one that already fits.',
      parameters: FIND_BOTS_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(FIND_BOTS_SCHEMA, args ?? {})
        if (bad) return fail(bad)
        try { return tree.findBots(botId, args?.query) } catch (e) { return fail(e) }
      },
    }),
    fb.registerTool({
      name: 'create_child_bot',
      description: 'Create ONE new Bot under yourself, or under one of your descendants with parent, then delegate to it. If a Bot with the same role already exists in your branch, it is reused and nothing is created. Without parent, a group lead in your branch that fits the new role (e.g. "FlyBot Lead") takes it. Any tree bot may call this (not only the root).',
      parameters: CREATE_CHILD_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(CREATE_CHILD_SCHEMA, args)
        if (bad) return fail(bad)
        try { return await tree.allocateChild(botId, args.name, args.role_description, args.parent) } catch (e) { return fail(e) }
      },
    }),
    fb.registerTool({
      name: 'create_team',
      description: 'Create a team for one project or group: "<team> Lead" with its members as children, one slot under you (or under parent, one of your descendants). An existing lead of that group and existing Bots with the same roles in your branch are reused.',
      parameters: CREATE_TEAM_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(CREATE_TEAM_SCHEMA, args)
        if (bad) return fail(bad)
        try { return await tree.createTeam(botId, { team: args.team, members: args.members, parent: args.parent }) } catch (e) { return fail(e) }
      },
    }),
    fb.registerTool({
      name: 'set_plan',
      description: 'Record your split of a task into parts before you delegate (a coordinator). Each part gets an id (p1…) so a child can report with report_part. Replaces any earlier plan of yours.',
      parameters: SET_PLAN_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(SET_PLAN_SCHEMA, args)
        if (bad) return fail(bad)
        const { plan, error } = makePlan({ goal: args.goal, parts: args.parts })
        if (error) return fail(error)
        fb.setField(botId, PLAN_KEY, plan)
        tree.refreshPrompt(botId)
        return { plan: plan.parts.map(item => ({ id: item.id, name: item.name })), note: `Plan saved (${plan.parts.length} parts). Delegate each part to the child whose scope fits; each reports back with report_part.` }
      },
    }),
    fb.registerTool({
      name: 'report_part',
      description: 'Report progress on a plan part. A child reports to the plan of its parent; a coordinator reports on its own plan. status: todo, doing, done or blocked.',
      parameters: REPORT_PART_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(REPORT_PART_SCHEMA, args)
        if (bad) return fail(bad)
        const own = fb.getField(botId, PLAN_KEY)
        const parent = tree.parentOf(botId)
        const targetId = (own !== undefined && own !== null) || !tree.isMember(parent) ? botId : parent
        const { plan, part, error } = reportPart(fb.getField(targetId, PLAN_KEY), { part: args.part, status: args.status, note: args.note })
        if (error) return fail(error)
        fb.setField(targetId, PLAN_KEY, plan)
        tree.refreshPrompt(targetId)
        const who = targetId === botId ? 'your plan' : `${tree.snapshot()[targetId]?.name ?? 'your parent'}'s plan`
        return { part: { id: part.id, name: part.name, status: part.status }, note: `Reported "${part.name}" as ${part.status}, on ${who}.` }
      },
    }),
    fb.registerTool({
      name: 'read_plan',
      description: 'Read your own plan, and as a child the plan your parent made, with each part id, name, owner and status.',
      parameters: READ_PLAN_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(READ_PLAN_SCHEMA, args ?? {})
        if (bad) return fail(bad)
        const own = fb.getField(botId, PLAN_KEY) ?? null
        const parent = tree.parentOf(botId)
        const fromParent = tree.isMember(parent) ? (fb.getField(parent, PLAN_KEY) ?? null) : null
        return { plan: own, parent: fromParent, note: own ? (planLine(own) ?? 'Your plan is empty.') : 'You have no plan. Set one with set_plan before delegating.' }
      },
    }),
  ]
}
