import type { Mood } from '../types'

// Clawd, pixel for pixel as Claude Code's welcome screen draws him:
//    ▐▛███▜▌
//   ▝▜█████▛▘
//     ▘▘ ▝▝
// with room around him for a hat above and a prop in either hand: 24 x 8 pixels,
// a quadrant block's 2 x 2 to a cell, so 12 columns by 4 rows.
export const SPRITE_WIDTH = 24
export const SPRITE_HEIGHT = 8
export const SPRITE_COLUMNS = SPRITE_WIDTH / 2
export const SPRITE_ROWS = SPRITE_HEIGHT / 2

const BODY = 0xd97757
const BODY_FAILED = 0x8a8580
const METAL = 0xc8c8c8
const GLASS = 0x9fd3e6
const SCREEN = 0x6fb7e8
const CASE = 0x9a9a9a
const HANDLE = 0x9b6a3c

// Clawd sits 2 pixels in and 2 down, an even shift that keeps his blocks his own.
const BODY_LEFT = 5
const BODY_RIGHT = 16
const BODY_TOP = 2
const ARMS_ROW = 4
const ARM_LEFT = [3, 4]
const ARM_RIGHT = [17, 18]
const LEGS_ROW = 6
const LEGS_STILL = [6, 8, 13, 15]
const LEGS_STEP = [5, 8, 13, 16]
// The eyes are holes in the body's second row: the left one's column, the right 7 over.
const EYES_ROW = 3
const EYE = 7
const EYE_GAP = 7

// What an agent type wears or holds; main goes as he is.
export type Skin = 'plain' | 'hardhat' | 'cap' | 'magnifier' | 'hammer' | 'laptop'

const SKINS: Record<string, Skin> = {
  main: 'plain',
  Explore: 'magnifier',
  Plan: 'hardhat',
  'general-purpose': 'hammer',
  fork: 'laptop',
  teammate: 'cap',
}

const SPARE_SKINS: readonly Skin[] = ['hardhat', 'cap', 'magnifier', 'hammer', 'laptop']

// A grid of colors, row-major; null is clear.
export type Pixels = (number | null)[][]

type Paint = (y: number, xs: readonly number[], color: number | null) => void

// Each prop, drawn over the body; a hat in the type's own color.
const PROPS: Record<Skin, (paint: Paint, tint: number) => void> = {
  plain: () => {},
  hardhat: (paint, tint) => {
    paint(0, range(6, 15), tint)
    paint(1, range(4, 17), tint)
  },
  cap: (paint, tint) => {
    paint(0, range(6, 15), tint)
    paint(1, range(5, 19), tint)
  },
  // A round lens raised in the right hand, its handle down to the hand.
  magnifier: paint => {
    paint(0, [20, 21], METAL)
    paint(1, [19, 22], METAL)
    paint(1, [20, 21], GLASS)
    paint(2, [20, 21], METAL)
    paint(3, [19], METAL)
  },
  // A hammer raised in the right hand.
  hammer: paint => {
    paint(0, range(18, 23), METAL)
    paint(1, range(18, 23), METAL)
    paint(2, [20], HANDLE)
    paint(3, [20], HANDLE)
  },
  // A laptop open at his left, his left arm short on its keys.
  laptop: paint => {
    paint(2, range(0, 3), SCREEN)
    paint(3, range(0, 3), SCREEN)
    paint(4, range(0, 3), CASE)
  },
}

export const skinOf = (type: string): Skin => SKINS[type] ?? pick(SPARE_SKINS, type, 'plain')

// The frame counter beats every tick. Working, the eyes read across the line and the legs
// step every second beat, a loop of 8; waiting looks aside and blinks; done and idle rest.
export const pixels = (mood: Mood, frame: number, type: string): Pixels => {
  const body = mood === 'failed' ? BODY_FAILED : BODY
  const grid: Pixels = Array.from({ length: SPRITE_HEIGHT }, () => Array.from({ length: SPRITE_WIDTH }, () => null))
  const paint: Paint = (y, xs, color) => {
    for (const x of xs) {
      grid[y]![x] = color
    }
  }
  const half = Math.floor(frame / 2)

  for (let y = BODY_TOP; y < BODY_TOP + 4; y++) {
    paint(y, range(BODY_LEFT, BODY_RIGHT), body)
  }

  paint(ARMS_ROW, [...ARM_LEFT, ...ARM_RIGHT], body)
  paint(LEGS_ROW, mood === 'working' && half % 2 === 1 ? LEGS_STEP : LEGS_STILL, body)

  const isBlink = (mood === 'idle' || mood === 'waiting') && frame % 8 === 0
  const shift = mood === 'working' ? ([0, 1, 0, -1][half % 4] ?? 0) : mood === 'waiting' ? 1 : 0

  if (!isBlink) {
    paint(EYES_ROW, [EYE + shift, EYE + EYE_GAP + shift], null)
  }

  PROPS[skinOf(type)](paint, tintOf(type))

  return grid
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

const DEFAULT = 0x01000000
const SPACE = 0x20
// The quadrant block for each set of lit pixels: bit 1 upper left, 2 upper right, 4 lower left, 8 lower right.
const QUADRANTS = [
  SPACE, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b,
  0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588,
]

// One cell: its lit pixels in their color on the terminal's own background, or, where two
// colors fill it, one on the other. A third color, or a second beside a gap, yields to the most.
const cellOf = (colors: readonly (number | null)[]) => {
  const counts = new Map<number, number>()

  for (const each of colors) {
    if (each !== null) {
      counts.set(each, (counts.get(each) ?? 0) + 1)
    }
  }

  const [first, second] = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([color]) => color)

  if (first === undefined) {
    return [SPACE, DEFAULT, DEFAULT]
  }

  const bits = colors.reduce<number>((sum, each, i) => (each === first ? sum | (1 << i) : sum), 0)
  const isFull = second !== undefined && counts.size === 2 && !colors.includes(null)

  return [QUADRANTS[bits] ?? SPACE, first, isFull ? second : DEFAULT]
}

// The Raster's cells, each the quadrant block for its 2 x 2 pixels.
export const rasterCells = (grid: Pixels) => {
  const words = new Uint32Array(SPRITE_COLUMNS * SPRITE_ROWS * 3)
  let at = 0

  for (let row = 0; row < SPRITE_ROWS; row++) {
    for (let column = 0; column < SPRITE_COLUMNS; column++) {
      const pixel = (dx: number, dy: number) => grid[row * 2 + dy]?.[column * 2 + dx] ?? null
      words.set(cellOf([pixel(0, 0), pixel(1, 0), pixel(0, 1), pixel(1, 1)]), at)
      at += 3
    }
  }

  return base64(new Uint8Array(words.buffer))
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const base64 = (bytes: Uint8Array) => {
  let out = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? ALPHABET.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? ALPHABET.charAt(n & 63) : '='
  }

  return out
}

const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`

// A pixel twice as tall as wide, as the terminal draws it.
const rects = (grid: Pixels) =>
  grid
    .flatMap((row, y) =>
      row.map((color, x) => (color === null ? '' : `<rect x="${x}" y="${y * 2}" width="1" height="2" fill="${hex(color)}"/>`)),
    )
    .join('')

const LOOP = 8
const BEAT_SECONDS = 0.4

// The desktop's sprite: one SVG whose frames take turns by SMIL, the terminal's loop of 8 beats,
// so it moves without redraws. Done and failed hold still.
export const svgSource = (mood: Mood, type: string) => {
  const isStill = mood === 'done' || mood === 'failed'
  const frames = isStill ? [1] : range(0, LOOP - 1)
  const keyTimes = frames.map(i => i / LOOP).join(';')
  const groups = frames.map(frame => {
    const grid = rects(pixels(mood, frame, type))

    if (isStill) {
      return `<g>${grid}</g>`
    }

    const values = frames.map(i => (i === frame ? 'visible' : 'hidden')).join(';')

    return `<g visibility="hidden"><animate attributeName="visibility" values="${values}" keyTimes="${keyTimes}" dur="${LOOP * BEAT_SECONDS}s" calcMode="discrete" repeatCount="indefinite"/>${grid}</g>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SPRITE_WIDTH} ${SPRITE_HEIGHT * 2}" shape-rendering="crispEdges">${groups.join('')}</svg>`
}

// The color an agent type's name is written in; main's is Clawd's own.
const TINTS: Record<string, number> = {
  main: BODY,
  Explore: 0x5b9a6e,
  Plan: 0x5b7fc4,
  'general-purpose': 0xc4a35b,
  fork: 0x9b6bc4,
  teammate: 0x4fa3a5,
}

const SPARE_TINTS = [0xc45b7f, 0x7fa34f, 0xa36b4f, 0x6b7fa3, 0xd4a017, 0x4f7fa3, 0xa34f8f, 0x3f9f8f]

// The same type always gets the same one.
const pick = <T,>(choices: readonly T[], type: string, fallback: T) => {
  let hash = 0

  for (const char of type) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }

  return choices[hash % choices.length] ?? fallback
}

export const tintOf = (type: string) => TINTS[type] ?? pick(SPARE_TINTS, type, BODY)

export const hexOf = hex
