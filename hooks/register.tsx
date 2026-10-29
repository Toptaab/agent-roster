import { atom, read, update } from 'claude-code'
import type { AgentInfo, ElementTable, EngineInterface, Register, RenderSurface, SessionMessage, Timer } from 'claude-code'

import type { AgentCard, Drawer, Mood, Tokens } from '../types'
import { SPRITE_COLUMNS, SPRITE_ROWS, hexOf, pixels, rasterCells, svgSource, tintOf } from './sprite'

const PANE = 'agent-roster'
// The progress pane: an agent's own conversation, for when the main view will not show it.
const LOG = 'agent-roster-log'
// How many of its latest messages the progress pane draws.
const LOG_MESSAGES = 30
const TITLE = 'Agents'
const MAIN = 'main'

const agents = atom({ plugin: 'agent-roster', key: 'agents' } as const, {})
const sessionId = atom({ plugin: 'agent-roster', key: 'sessionId' } as const, '')
const frame = atom({ plugin: 'agent-roster', key: 'frame' } as const, 0)
const historyOpen = atom({ plugin: 'agent-roster', key: 'historyOpen' } as const, false)
const drawer = atom({ plugin: 'agent-roster', key: 'drawer' } as const, 'auto' as Drawer)
const bandShown = atom({ plugin: 'agent-roster', key: 'bandShown' } as const, false)
const cardRow = atom({ plugin: 'agent-roster', key: 'cardRow' } as const, 0)
const watching = atom({ plugin: 'agent-roster', key: 'watching' } as const, '')

// The sprite's beat while anyone works, and how many beats between syncs with $.agent.list().
const TICK_MS = 400
const SYNC_EVERY = 5
// How long the pane lingers once the last subagent is done, so its ✓ is seen.
const CLOSE_AFTER_MS = 3000
// A terminal card's width (Clawd beside his words), the gap between cards in a row, and the
// least room for the words before Clawd steps out.
const CARD_COLUMNS = 40
const CARD_GAP = 2
const INFO_MIN_COLUMNS = 16
const HIDE_LABEL = '✕ hide'

const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const MOOD_OF: Record<AgentInfo['status'], Mood> = {
  pending: 'working',
  running: 'working',
  waiting: 'waiting',
  idle: 'waiting',
  completed: 'done',
  failed: 'failed',
  killed: 'failed',
}

const BADGE: Record<Mood, { glyph: string; word: string; color: string }> = {
  working: { glyph: '●', word: 'working', color: 'green' },
  waiting: { glyph: '◌', word: 'waiting', color: 'yellow' },
  idle: { glyph: '○', word: 'idle', color: 'gray' },
  done: { glyph: '✓', word: 'done', color: 'cyan' },
  failed: { glyph: '✗', word: 'failed', color: 'red' },
}

const shortModel = (model: string) => model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

const compact = (tokens: number) => {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  }

  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`
  }

  return String(tokens)
}

const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)

  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

const totalOf = (tokens: Tokens) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite

// Done and failed agents leave the live list for the folded history below it.
const isOver = (card: AgentCard) => card.id !== MAIN && (card.mood === 'done' || card.mood === 'failed')

// What a tool call is doing, in a few words: the tool and its most telling argument.
const activityOf = (tool: string, input: Record<string, unknown>) => {
  const hint = ['description', 'pattern', 'command', 'file_path', 'path', 'url', 'query', 'prompt']
    .map(key => input[key])
    .find((value): value is string => typeof value === 'string' && value.length > 0)
  const name = tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool

  return hint ? `${name} ${hint.replace(/\s+/g, ' ').slice(0, 48)}` : name
}

const cardOf = (id: string, fields: Partial<AgentCard> & Pick<AgentCard, 'type' | 'model' | 'startedAt'>): AgentCard => ({
  id,
  description: '',
  mood: 'working',
  steps: 0,
  tokens: NO_TOKENS,
  ...fields,
})

const patch = ($: EngineInterface, id: string, fn: (card: AgentCard) => AgentCard) =>
  update($, agents, all => (all[id] ? { ...all, [id]: fn(all[id]) } : all))

let ticker: Timer | undefined

// The main loop's card, made at the start and again after a reload or a /clear.
const ensureMain = async ($: EngineInterface) => {
  const [model, now, id] = await Promise.all([$.session.model(), $.clock.now(), $.session.id()])
  await update($, sessionId, () => id)
  await update($, agents, all =>
    all[MAIN] ? all : { ...all, [MAIN]: cardOf(MAIN, { type: 'main', model, startedAt: now, mood: 'idle' }) },
  )
}

// Statuses the events do not say (a teammate gone idle, a killed task), and agents spawned
// before this load, from the engine's own list.
const sync = async ($: EngineInterface) => {
  const [listed, now] = await Promise.all([$.agent.list(), $.clock.now()])
  await update($, agents, all => {
    const next = { ...all }

    for (const info of listed) {
      const mood = MOOD_OF[info.status]
      const known = next[info.id]

      if (!known) {
        next[info.id] = cardOf(info.id, {
          type: info.type,
          description: info.description,
          name: info.name,
          parentId: info.parentId,
          model: '',
          startedAt: now,
          mood,
        })
      } else if (known.mood !== mood && !(known.mood === 'done' && mood === 'working')) {
        const isOver = mood === 'done' || mood === 'failed'
        next[info.id] = { ...known, mood, endedAt: isOver ? (known.endedAt ?? now) : undefined }
      }
    }

    return next
  })
}

const isSubagentAtWork = (all: Record<string, AgentCard>) =>
  Object.values(all).some(card => card.id !== MAIN && card.mood === 'working')

// Still under way, though maybe paused on a permission prompt: a hide holds through it.
const isSubagentUnderWay = (all: Record<string, AgentCard>) =>
  Object.values(all).some(card => card.id !== MAIN && (card.mood === 'working' || card.mood === 'waiting'))

// The terminal draws the roster in the band above the prompt, not a pane: a pane docked
// beside the transcript shares its rows, and a row of Thai there (its marks take no cell,
// which the terminal and the engine count apart) shifts the pane's half of the row.
let surface: RenderSurface | null = null
// How many rows of cards the band's last drawing wrapped into.
let cardRows = 0
const isBand = () => surface === 'terminal'

const isUp = async ($: EngineInterface) =>
  isBand() ? read($, bandShown) : (await $.ui.panes()).some(pane => pane.id === PANE)

const show = async ($: EngineInterface) => {
  await ensureMain($)

  if (isBand()) {
    await update($, bandShown, () => true)
  } else {
    await $.ui.open({ id: PANE, title: TITLE })
  }
}

const unshow = async ($: EngineInterface) => {
  if (isBand()) {
    await update($, bandShown, () => false)
  } else {
    await $.ui.close({ id: PANE })
  }
}

let quietSince: number | undefined
let isReconciling = false

// Opens or closes the pane to match the drawer and whether a subagent works.
const reconcile = async ($: EngineInterface) => {
  if (isReconciling) {
    return
  }

  isReconciling = true

  try {
    const [all, mode, isShown, now] = await Promise.all([read($, agents), read($, drawer), isUp($), $.clock.now()])
    const isBusy = isSubagentAtWork(all)
    quietSince = isBusy ? undefined : (quietSince ?? now)

    if (mode === 'hidden' && !isSubagentUnderWay(all)) {
      await update($, drawer, () => 'auto' as Drawer)
    }

    if (!isShown && (mode === 'pinned' || (mode === 'auto' && isBusy))) {
      await show($)
    } else if (isShown && mode === 'auto' && !isBusy && now - (quietSince ?? now) >= CLOSE_AFTER_MS) {
      await unshow($)
    }
  } finally {
    isReconciling = false
  }
}

const startTicker = ($: EngineInterface) => {
  ticker?.cancel()
  let beats = 0
  ticker = $.clock.every(TICK_MS, () => {
    void (async () => {
      const all = await read($, agents)
      const isBusy = Object.values(all).some(card => card.mood === 'working' || card.mood === 'waiting')

      if (isBusy) {
        await update($, frame, n => (n + 1) % 1024)
      }

      if (++beats % SYNC_EVERY === 0 && Object.keys(all).length > 1) {
        await sync($)
      }

      await reconcile($)
    })().catch(() => {})
  })
}

// A close by hand: shut until the next spawn while one works, else back to auto.
const hide = async ($: EngineInterface) => {
  const isBusy = isSubagentUnderWay(await read($, agents))
  await update($, drawer, () => (isBusy ? 'hidden' : 'auto') as Drawer)
}

// The person's toggle, from /roster or the pane's own button.
const toggle = async ($: EngineInterface) => {
  if (await isUp($)) {
    await hide($)
    await unshow($)

    return 'Agents roster closed.'
  }

  const isBusy = isSubagentAtWork(await read($, agents))
  await update($, drawer, () => (isBusy ? 'auto' : 'pinned') as Drawer)
  await show($)

  return 'Agents roster opened.'
}

// Its transcript in the main view; where the surface will not switch (the desktop app's tasks
// list holds no such agent), a pane of the roster's own that reads its conversation instead.
const openTranscript = async ($: EngineInterface, card: AgentCard) => {
  const shown = await $.ui.view({ agentId: card.id })

  if (!shown.deny) {
    return
  }

  await update($, watching, () => card.id)
  const name = card.name ?? card.type
  const opened = await $.ui.open({ id: LOG, title: `${name} · progress`, focus: true, closeOnEscape: true })

  if (!opened.isPlaced) {
    $.ui.toast(shown.deny)
  }
}

// One line of an agent's conversation: its words, or a tool call and how it went.
const logLinesOf = (messages: readonly SessionMessage[]) =>
  messages.slice(-LOG_MESSAGES).flatMap((message, i) => {
    const words = message.text.replace(/\s+/g, ' ').trim()
    const said = words ? [{ key: `m${i}`, text: `${message.role === 'user' ? '›' : '◆'} ${words.slice(0, 240)}`, dim: message.role === 'user' }] : []
    const calls = message.toolUses.map(use => ({
      key: use.tool_use_id,
      text: `${use.isError ? '✗' : use.text === undefined ? '…' : '✓'} ${activityOf(use.tool, use.input)}`,
      dim: true,
    }))

    return [...said, ...calls]
  })

// What every surface draws the roster from.
const rosterOf = async ($: EngineInterface) => {
  const all = await read($, agents)
  const session = await read($, sessionId)
  const now = await $.clock.now()
  const cards = Object.values(all).sort((a, b) =>
    a.id === MAIN ? -1 : b.id === MAIN ? 1 : a.startedAt - b.startedAt,
  )
  const subagents = cards.filter(card => card.id !== MAIN)
  const subTotal = subagents.reduce((sum, card) => sum + totalOf(card.tokens), 0)
  const allTotal = cards.reduce((sum, card) => sum + totalOf(card.tokens), 0)
  const working = cards.filter(card => card.mood === 'working').length

  const nameOf = (card: AgentCard) => (card.id === MAIN ? 'main' : (card.name ?? card.type))
  const clockOf = (card: AgentCard) => elapsed((card.endedAt ?? now) - card.startedAt)
  // Each card's context window as of its last step, not its billed sum: every step re-sends it.
  // Main shows its context alone: the session's whole conversation, against the compaction line.
  const tokenLine = (card: AgentCard) =>
    card.id === MAIN
      ? `ctx ${compact(card.contextTokens ?? 0)}`
      : `ctx ${compact(card.contextTokens ?? 0)} ↓${compact(card.tokens.output)}` +
        ` · ${card.steps} step${card.steps === 1 ? '' : 's'}`
  const detailOf = (card: AgentCard) =>
    card.activity ? `▶ ${card.activity.label}` : card.description ? `“${card.description}”` : ''
  const summary =
    `${working} working · ${subagents.length} agent${subagents.length === 1 ? '' : 's'}` +
    ` · Σ ${compact(subTotal)} sub / ${compact(allTotal)} all`

  const live = cards.filter(card => !isOver(card))
  const history = cards.filter(isOver).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const isHistoryOpen = await read($, historyOpen)
  const toggleHistory = () => update($, historyOpen, open => !open)
  const historyLabel = `${isHistoryOpen ? '▾' : '▸'} history (${history.length})`
  const historyLine = (card: AgentCard) =>
    `${BADGE[card.mood].glyph} ${nameOf(card)} · ctx ${compact(card.contextTokens ?? 0)} · ${clockOf(card)}` +
    (card.description ? ` · ${card.description}` : '')

  return { session, summary, live, history, isHistoryOpen, toggleHistory, historyLabel, historyLine, nameOf, clockOf, tokenLine, detailOf }
}

// The terminal's roster, in quadrant-block sprites: the band above the prompt draws it, and a
// pane would. `columns` is the room the site gives it.
const drawTerminal = async ($: EngineInterface, elements: ElementTable<'terminal'>, columns: number) => {
  const { session, summary, live, history, isHistoryOpen, toggleHistory, historyLabel, historyLine, nameOf, clockOf, tokenLine, detailOf } =
    await rosterOf($)
  const { Box, Text, Button, Raster } = elements
  const beat = await read($, frame)
  // Cards stand side by side and wrap into rows, of which the band shows one: the wheel moves it.
  const cardColumns = Math.min(CARD_COLUMNS, columns)
  const hasRoom = cardColumns - SPRITE_COLUMNS - 1 >= INFO_MIN_COLUMNS
  const perRow = Math.max(1, Math.floor((columns + CARD_GAP) / (cardColumns + CARD_GAP)))
  const rows = Array.from({ length: Math.ceil(live.length / perRow) }, (_, i) => live.slice(i * perRow, (i + 1) * perRow))
  cardRows = rows.length
  const shown = Math.min(await read($, cardRow), Math.max(0, rows.length - 1))
  const fitTo = (width: number) => (text: string) => (text.length > width ? `${text.slice(0, width - 1)}…` : text)
  const fit = fitTo(Math.max(10, cardColumns - (hasRoom ? SPRITE_COLUMNS + 1 : 0)))
  const fitRow = fitTo(columns)
  // First in the header, where a narrow band does not cut it.
  const where = rows.length > 1 ? ` · row ${shown + 1}/${rows.length} ↕` : ''
  // The header has the row to itself, less the hide button and its gap.
  const fitHeader = fitTo(Math.max(10, columns - HIDE_LABEL.length - 1))

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        <Button key="hide" plain dimColor label={HIDE_LABEL} onPress={() => toggle($)} />
        <Text dimColor>{fitHeader(`Agents${where} · session ${session.slice(0, 8)} · ${summary}`)}</Text>
      </Box>
      <Box flexDirection="row" columnGap={CARD_GAP}>
        {(rows[shown] ?? []).map(card => {
          const badge = BADGE[card.mood]
          const tint = tintOf(card.type)

          return (
            <Box key={card.id} flexDirection="row" gap={1} width={cardColumns}>
              {hasRoom && (
                <Raster
                  key={`sprite-${card.id}`}
                  columns={SPRITE_COLUMNS}
                  rows={SPRITE_ROWS}
                  cells={rasterCells(pixels(card.mood, beat, card.type))}
                />
              )}
              <Box flexDirection="column">
                <Text>
                  <Text bold color={hexOf(tint)}>
                    {nameOf(card)}
                  </Text>
                  <Text dimColor> {fit(shortModel(card.model))}</Text>
                </Text>
                <Text>
                  <Text color={badge.color}>
                    {badge.glyph} {badge.word}
                  </Text>
                  <Text dimColor> {clockOf(card)}</Text>
                </Text>
                <Text>
                  {fit(tokenLine(card))}
                </Text>
                <Text dimColor>{fit(detailOf(card))}</Text>
                {card.id !== MAIN ? (
                  <Button key={`view-${card.id}`} plain dimColor label="↗ transcript" onPress={() => openTranscript($, card)} />
                ) : (
                  <Text> </Text>
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
      {history.length > 0 && (
        <Box flexDirection="column">
          <Button key="history" plain dimColor label={historyLabel} onPress={toggleHistory} />
          {isHistoryOpen &&
            history.map(card => (
              <Button
                key={`past-${card.id}`}
                plain
                dimColor
                label={fitRow(historyLine(card))}
                onPress={() => openTranscript($, card)}
              />
            ))}
        </Box>
      )}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    surface = e.surface
    await $.command.register({
      name: 'roster',
      description: 'Open or close the agents roster; it opens by itself while subagents work (args: clear)',
    })
    await ensureMain($)
    startTicker($)

    return started
  })

  // The pane's close mark or Escape: the person's, so the drawer remembers it.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await hide($)
    }

    if (e.id === LOG) {
      await update($, watching, () => '')
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    ticker = undefined

    return next(e)
  })

  on('command.run', { command: 'roster' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, agents, all =>
        Object.fromEntries(Object.entries(all).filter(([, card]) => card.mood !== 'done' && card.mood !== 'failed')),
      )

      return { text: 'Cleared finished agents.' }
    }

    return { text: await toggle($) }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)

    if (spawned.agentId) {
      const id = spawned.agentId
      const now = await $.clock.now()
      await update($, agents, all => ({
        ...all,
        [id]: cardOf(id, {
          type: e.subagentType,
          description: e.description,
          name: e.name,
          parentId: e.parentAgentId,
          model: spawned.model,
          startedAt: now,
        }),
      }))
      // A new spawn ends a close by hand: the pane comes back for it.
      await update($, drawer, mode => (mode === 'hidden' ? 'auto' : mode))
      await reconcile($)
    }

    return spawned
  })

  on('turn.start', async ($, e, next) => {
    const id = e.agentId ?? MAIN

    if (id === MAIN) {
      await ensureMain($)
    }

    await patch($, id, card => ({ ...card, mood: 'working', endedAt: undefined }))

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const usage = response.usage

    if (usage) {
      await patch($, e.agentId ?? MAIN, card => ({
        ...card,
        model: card.model || usage.model,
        steps: card.steps + 1,
        tokens: {
          input: card.tokens.input + usage.input_tokens,
          output: card.tokens.output + usage.output_tokens,
          cacheRead: card.tokens.cacheRead + usage.cache_read_input_tokens,
          cacheWrite: card.tokens.cacheWrite + usage.cache_creation_input_tokens,
        },
        contextTokens:
          usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
      }))
    }

    return response
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const toolUseId = e.tool_use_id ?? ''
    await patch($, id, card => ({
      ...card,
      activity: { toolUseId, label: activityOf(e.tool, e as unknown as Record<string, unknown>) },
    }))

    try {
      return await next(e)
    } finally {
      await patch($, id, card => (card.activity?.toolUseId === toolUseId ? { ...card, activity: undefined } : card))
    }
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const now = await $.clock.now()
    const mood: Mood =
      id === MAIN ? 'idle' : e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'waiting' : 'failed'
    await patch($, id, card => ({ ...card, mood, activity: undefined, endedAt: id === MAIN ? undefined : now }))

    return next(e)
  })

  // The terminal's roster, over whatever else the band holds (token-garden's forecast).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey || !(await read($, bandShown))) {
      return next(e)
    }

    const elements = $.ui.resolve(e)
    const { Box } = elements

    return (
      <Box flexDirection="column">
        {await drawTerminal($, elements, e.props.bodyColumns)}
        {await next(e)}
      </Box>
    )
  })

  // With cards in more than one row, the wheel over the band steps through them, a row a tick.
  on('ui.scroll', async ($, e, next) => {
    if (e.component !== 'AbovePrompt' || !isBand() || cardRows <= 1 || !(await read($, bandShown))) {
      return next(e)
    }

    const step = Math.sign(e.by)
    await update($, cardRow, row => Math.min(cardRows - 1, Math.max(0, row + step)))

    return {}
  })

  // The progress pane: redrawn as the card it reads changes, a step or a tool call at a time.
  on('ui.render', { component: 'Pane', requestId: LOG }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const id = await read($, watching)
    const card = (await read($, agents))[id]
    await read($, frame)
    const found = id ? await $.session.messages({ agentId: id }) : { deny: 'No agent chosen.' }

    if ('deny' in found) {
      return <Text dimColor>{found.deny}</Text>
    }

    const badge = card ? BADGE[card.mood] : undefined
    const lines = logLinesOf(found)

    return (
      <Box flexDirection="column" gap={1}>
        {card && badge && (
          <Text>
            <Text color={badge.color}>
              {badge.glyph} {badge.word}
            </Text>
            <Text dimColor>
              {' '}
              · {elapsed((card.endedAt ?? (await $.clock.now())) - card.startedAt)} · {card.steps} step
              {card.steps === 1 ? '' : 's'}
              {card.description ? ` · ${card.description}` : ''}
            </Text>
          </Text>
        )}
        <Box flexDirection="column">
          {lines.length === 0 ? (
            <Text dimColor>Nothing yet.</Text>
          ) : (
            lines.map(line => (
              <Text key={line.key} dimColor={line.dim}>
                {line.text}
              </Text>
            ))
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { session, summary, live, history, isHistoryOpen, toggleHistory, historyLabel, historyLine, nameOf, clockOf, tokenLine, detailOf } =
      await rosterOf($)

    if (e.surface === 'desktop') {
      const { Box, Text, Button, Svg } = $.ui.resolve(e)

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>
              session {session.slice(0, 8)} · {summary}
            </Text>
            <Button key="hide" plain dimColor label="Hide" onPress={() => toggle($)} />
          </Box>
          {live.map(card => {
            const badge = BADGE[card.mood]
            const tint = tintOf(card.type)

            return (
              <Box key={card.id} flexDirection="row" gap={2} padding={1} borderStyle="round" borderColor={hexOf(tint)}>
                <Svg
                  source={svgSource(card.mood, card.type)}
                  alt={`Claude, ${nameOf(card)}, ${badge.word}`}
                  width={96}
                  height={64}
                  isInteractive
                />
                <Box flexDirection="column" flexGrow={1}>
                  <Text>
                    <Text bold>{nameOf(card)}</Text>
                    <Text dimColor>
                      {' '}
                      {card.type !== nameOf(card) ? `${card.type} · ` : ''}
                      {shortModel(card.model)}
                    </Text>
                  </Text>
                  <Text>
                    <Text color={badge.color}>
                      {badge.glyph} {badge.word}
                    </Text>
                    <Text dimColor> · {clockOf(card)}</Text>
                  </Text>
                  <Text>
                    {tokenLine(card)}
                  </Text>
                  {detailOf(card) && <Text dimColor>{detailOf(card)}</Text>}
                  {card.id !== MAIN && (
                    <Button key={`view-${card.id}`} label="Open transcript" onPress={() => openTranscript($, card)} />
                  )}
                </Box>
              </Box>
            )
          })}
          {history.length > 0 && (
            <Box flexDirection="column">
              <Button key="history" plain dimColor label={historyLabel} onPress={toggleHistory} />
              {isHistoryOpen &&
                history.map(card => (
                  <Button
                    key={`past-${card.id}`}
                    plain
                    dimColor
                    label={historyLine(card)}
                    onPress={() => openTranscript($, card)}
                  />
                ))}
            </Box>
          )}
        </Box>
      )
    }

    if (e.surface === 'terminal') {
      return drawTerminal($, $.ui.resolve(e), e.props.bodyColumns)
    }

    // vscode and mobile: words alone.
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text dimColor>{summary}</Text>
        {live.map(card => (
          <Text key={card.id}>
            {BADGE[card.mood].glyph} {nameOf(card)} · {tokenLine(card)} · {clockOf(card)}
          </Text>
        ))}
        {history.length > 0 && <Text dimColor>history ({history.length})</Text>}
      </Box>
    )
  })
}
