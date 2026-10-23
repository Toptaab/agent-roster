export type Mood = 'working' | 'waiting' | 'idle' | 'done' | 'failed'

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Activity = { toolUseId: string; label: string }

// How the pane comes and goes: 'auto' opens while a subagent works and closes once none
// does; 'pinned', opened by hand with none at work, stays; 'hidden', closed by hand
// while one works, stays shut until the next spawn.
export type Drawer = 'auto' | 'pinned' | 'hidden'

// One card: the main loop (id 'main') or a subagent/teammate (its $.agent.list() id).
export type AgentCard = {
  id: string
  type: string
  description: string
  name?: string
  model: string
  parentId?: string
  mood: Mood
  startedAt: number
  endedAt?: number
  steps: number
  tokens: Tokens
  activity?: Activity
  // Main only: what the next request re-sends.
  contextTokens?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-roster': {
      agents: Record<string, AgentCard>
      sessionId: string
      frame: number
      // Whether the finished agents' history is unfolded.
      historyOpen: boolean
      drawer: Drawer
    }
  }
}
