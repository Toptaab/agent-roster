import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-roster',
  component: 'Pane',
  requestId: 'agent-roster',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const FINISHED = { answer: 'Found it.', durationMs: 1000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' } as const

// Each hook here stands for the engine beneath the plugin; the panes it keeps are returned.
const world = (on: Parameters<TestBody>[1]) => {
  const clock = mock.clock(on)
  const panes = new Set<string>()
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'roster' } }))
  on('ui.open', (_, e) => {
    panes.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(id => ({ id, title: 'Agents', isShown: true, isFocused: false, isPlaced: true })) as never,
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.complete', () => ({ text: 'Found it.' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  return { clock, panes }
}

const spawn = { prompt: 'Find the auth code.', description: 'find auth', subagentType: 'Explore' } as never

test('a spawned agent gets a card on every surface', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const spawned = await $.agent.spawn(spawn)
  expect(spawned.agentId).toBe('a1')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /1 agent/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Explore/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('a finished agent folds into the history', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn)
  await $.turn.complete(FINISHED)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'history' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'past-a1' })).toBeFalsy()

  await ui.press({ key: 'history' })
  expect(await ui.find({ type: 'Button', key: 'past-a1' })).toBeTruthy()
  await ui.unmount()
})

test('the pane opens for a subagent and closes after the last one is done', async ($, on) => {
  const { clock, panes } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)
  expect(panes.has('agent-roster')).toBe(false)

  await $.agent.spawn(spawn)
  expect(panes.has('agent-roster')).toBe(true)

  await $.turn.complete(FINISHED)
  await clock.advance(1000)
  expect(panes.has('agent-roster')).toBe(true)
  await clock.advance(3000)
  expect(panes.has('agent-roster')).toBe(false)
})

test('a pane opened by hand stays, and closed by hand stays shut till the next spawn', async ($, on) => {
  const { clock, panes } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.command.run({ command: 'roster', args: '' } as never)
  await clock.advance(5000)
  expect(panes.has('agent-roster')).toBe(true)

  await $.agent.spawn(spawn)
  await $.command.run({ command: 'roster', args: '' } as never)
  await clock.advance(1000)
  expect(panes.has('agent-roster')).toBe(false)

  await $.agent.spawn(spawn)
  expect(panes.has('agent-roster')).toBe(true)
})

test('a hide holds while the subagent waits on a prompt', async ($, on) => {
  const { clock, panes } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn)
  await $.command.run({ command: 'roster', args: '' } as never)
  expect(panes.has('agent-roster')).toBe(false)

  await $.turn.complete({ ...FINISHED, reason: 'aborted' })
  await clock.advance(1000)
  await $.turn.start({ text: 'Go on.', turnId: 't2', agentId: 'a1' })
  await clock.advance(1000)
  expect(panes.has('agent-roster')).toBe(false)
})

const BAND = {
  plugin: 'agent-roster',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('the terminal shows the roster in the band, never a docked pane', async ($, on) => {
  const { clock, panes } = world(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>below</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const quiet = await $.ui.mount(BAND)
  expect(await quiet.find({ type: 'Text', text: /Agents/ })).toBeFalsy()
  await quiet.unmount()

  await $.agent.spawn(spawn)
  expect(panes.has('agent-roster')).toBe(false)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /1 agent/ })).toBeTruthy()
  // What the band held beneath is kept under the roster.
  expect(await band.find({ type: 'Text', text: /below/ })).toBeTruthy()

  await band.press({ key: 'hide' })
  await band.unmount()
  const hidden = await $.ui.mount(BAND)
  expect(await hidden.find({ type: 'Text', text: /1 agent/ })).toBeFalsy()
  await hidden.unmount()

  await $.turn.complete(FINISHED)
  await clock.advance(5000)
  await $.command.run({ command: 'roster', args: '' } as never)
  const pinned = await $.ui.mount(BAND)
  expect(await pinned.find({ type: 'Button', key: 'history' })).toBeTruthy()
  await pinned.unmount()
  expect(panes.has('agent-roster')).toBe(false)
})

test('cards that overflow the band wrap into rows, one shown at a time', async ($, on) => {
  world(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>below</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawn)

  // 50 columns hold one 40-column card a row: main, then Explore below.
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 50 } })
  expect(await band.find({ type: 'Text', text: /row 1\/2/ })).toBeTruthy()
  expect(await band.find({ type: 'Text', text: /opus/ })).toBeTruthy()
  expect(await band.find({ type: 'Text', text: /haiku/ })).toBeFalsy()
  await band.unmount()

  const wide = await $.ui.mount(BAND)
  expect(await wide.find({ type: 'Text', text: /row 1\// })).toBeFalsy()
  expect(await wide.find({ type: 'Text', text: /haiku/ })).toBeTruthy()
  await wide.unmount()
})
