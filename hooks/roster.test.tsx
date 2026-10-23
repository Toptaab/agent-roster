import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-roster',
  component: 'Pane',
  requestId: 'agent-roster',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('a spawned agent gets a card on every surface', async ($, on) => {
  // Each hook here stands for the engine beneath the plugin.
  mock.clock(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'roster' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const spawned = await $.agent.spawn({ prompt: 'Find the auth code.', description: 'find auth', subagentType: 'Explore' } as never)
  expect(spawned.agentId).toBe('a1')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /1 agent/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Explore/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('a finished agent folds into the history', async ($, on) => {
  mock.clock(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'roster' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.complete', () => ({ text: 'Found it.' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'Find the auth code.', description: 'find auth', subagentType: 'Explore' } as never)
  await $.turn.complete({ answer: 'Found it.', durationMs: 1000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'history' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'past-a1' })).toBeFalsy()

  await ui.press({ key: 'history' })
  expect(await ui.find({ type: 'Button', key: 'past-a1' })).toBeTruthy()
  await ui.unmount()
})
