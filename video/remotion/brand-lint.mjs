#!/usr/bin/env node
// Brand check for a generated video component: The Buy Box's rules, never its
// layouts. Every video designs its own scenes; this only makes sure they stay
// inside the brand. The Assembly stage runs it and fixes what it reports
// before rendering; CI runs it again and turns anything left into a warning.
//
// Two levels. A problem fails the check and has to be fixed. A note passes:
// it marks text a little outside the safe zone, which is allowed when a scene
// needs the room to keep from overlapping.
//
//   node brand-lint.mjs src/SomeVideo.tsx     exits 1 when there is a problem
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = process.argv[2]
if (!file) {
  console.error('usage: node brand-lint.mjs <component.tsx>')
  process.exit(2)
}
const src = fs.readFileSync(file, 'utf8')
const lineOf = (i) => src.slice(0, i).split('\n').length
const problems = []
const notes = []
const at = (i, msg) => problems.push(`${file}:${lineOf(i)}: ${msg}`)
const noteAt = (i, msg) => notes.push(`${file}:${lineOf(i)}: note: ${msg}`)
const once = (msg) => problems.push(`${file}: ${msg}`)

const PALETTE = ['#000000', '#FFFFFF', '#E6E7E8', '#6A6E72', '#FF5A1F', '#0E7A42']

// Colours: only the six brand colours, flat.
for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
  let h = m[0].toUpperCase()
  if (h.length === 4) h = '#' + [...h.slice(1)].map((c) => c + c).join('')
  if (h.length === 9) h = h.slice(0, 7)
  if (!PALETTE.includes(h)) at(m.index, `colour ${m[0]} is not a brand colour; use BLACK, WHITE, CONCRETE, GRAPHITE, ORANGE or GREEN from ./brand`)
}
for (const m of src.matchAll(/\b(rgba?|hsla?)\(([^)]*)\)/g)) {
  const [r, g, b] = m[2].split(/[\s,/]+/).filter(Boolean).map(Number)
  const blackOrWhite = m[1].startsWith('rgb') && ((r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255))
  if (!blackOrWhite) at(m.index, `colour ${m[0]} is not a brand colour`)
}
for (const m of src.matchAll(/gradient\(/g)) at(m.index, 'gradients are off-brand: flat colour only')
for (const m of src.matchAll(/\b(boxShadow|textShadow)\s*:/g)) at(m.index, `${m[1]} is off-brand: the look is flat; put text in a solid box instead`)
for (const m of src.matchAll(/borderRadius\s*:\s*(\d+(?:\.\d+)?)\b/g)) {
  if (Number(m[1]) > 0) at(m.index, `borderRadius ${m[1]}: the brand is square-cornered ("50%" for a true circle is fine)`)
}

// Fonts: Archivo and Inter, through ./brand.
if (!/from\s+["']\.\/brand["']/.test(src)) once('does not import from ./brand, the only source for colours, fonts, logo and safe zone')
for (const m of src.matchAll(/from\s+["']\.\/(tokens|fonts|components\/[^"']+)["']/g)) at(m.index, `imports ./${m[1]}, the old look; use ./brand and design the scene here`)
for (const m of src.matchAll(/fontFamily\s*:\s*(["'`])([^"'`]*)\1/g)) {
  if (!m[2].includes('${')) at(m.index, `fontFamily "${m[2]}" is hard-coded; use HEAD (Archivo) or BODY (Inter) from ./brand`)
}
for (const m of src.matchAll(/AgencyFB|Fraunces/g)) at(m.index, `${m[0]} is the old typeface`)

// Size: nothing small.
for (const m of src.matchAll(/fontSize\s*(?::|=\{)\s*(\d+(?:\.\d+)?)\b/g)) {
  if (Number(m[1]) < 40) at(m.index, `fontSize ${m[1]} is below the 40px floor (MIN_TEXT)`)
}

// Every video: captions, and a closing frame with the logo and the follow ask.
if (!/<Captions\b/.test(src)) once('no <Captions> overlay; every video carries the synced captions')
if (!/LOGO_(WHITE|BLACK)/.test(src)) once('the logo never appears; the closing frame shows LOGO_WHITE (on black) or LOGO_BLACK (on white) from ./brand')
if (!/\bHANDLE\b|@thebuyboxre/.test(src)) once('no follow ask; the closing frame shows HANDLE (@thebuyboxre) from ./brand')

await checkPositions()

if (notes.length) console.log(notes.join('\n'))
if (problems.length) {
  console.log(problems.join('\n'))
  console.log(`\n${problems.length} brand problem(s). Fix them and run this again.`)
  process.exit(1)
}
console.log(`${file}: brand check passed${notes.length ? ` (${notes.length} note${notes.length > 1 ? 's' : ''}: text a little outside the safe zone, allowed where a scene needs the room)` : ''}`)

// Position: scene text aims for the safe zone and never reaches the captions.
// Read from the component's real structure (TypeScript's parser), not by
// pattern, because an offset only means something relative to its positioned
// parent: `bottom: 40` inside <SafeArea> or a card is fine, and the same value
// on a full-frame layer puts text behind the captions. Only offsets that
// resolve to numbers are judged; the rest is left to the prompt.
//
// The hard lines are the ones that cause a collision: the caption box, the
// area below the safe zone, and far past its other edges. Short of those,
// text outside the safe zone is a note, not a failure.
async function checkPositions() {
  let ts
  try {
    ts = (await import('typescript')).default
  } catch {
    console.log(`${file}: position check skipped (typescript is not installed here)`)
    return
  }

  // The lines come from brand.ts, so the check and the components can't
  // disagree about where they are.
  const B = { top: 180, right: 150, bottom: 440, left: 110, band: 200, captionTop: 160, slack: 40, H: 1920, W: 1080 }
  try {
    const brand = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'brand.ts'), 'utf8')
    const safe = brand.match(/SAFE\s*=\s*\{\s*top:\s*(\d+),\s*right:\s*(\d+),\s*bottom:\s*(\d+),\s*left:\s*(\d+)/)
    if (safe) Object.assign(B, { top: +safe[1], right: +safe[2], bottom: +safe[3], left: +safe[4] })
    const band = brand.match(/SCENE_BOTTOM\s*=\s*H\s*-\s*SAFE\.bottom\s*-\s*(\d+)/)
    if (band) B.band = +band[1]
    const cap = brand.match(/CAPTION_TOP\s*=\s*SAFE\.bottom\s*\+\s*(\d+)/)
    if (cap) B.captionTop = +cap[1]
    const slack = brand.match(/SAFE_SLACK\s*=\s*(\d+)/)
    if (slack) B.slack = +slack[1]
  } catch {}
  const SAFE = { top: B.top, right: B.right, bottom: B.bottom, left: B.left }
  const FLOOR = B.bottom + B.band // aim: scene content at least this far up from the bottom edge
  const CAPTION_TOP = B.bottom + B.captionTop // limit: below this, text hits the caption box
  const SLACK = B.slack
  const SCENE_BOTTOM = B.H - FLOOR
  const known = { H: B.H, W: B.W, SCENE_BOTTOM, SCENE_FLOOR: FLOOR, CAPTION_TOP, SAFE_SLACK: SLACK, SAFE_W: B.W - B.left - B.right }

  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  const num = (e) => {
    if (!e) return undefined
    if (ts.isParenthesizedExpression(e)) return num(e.expression)
    if (ts.isNumericLiteral(e)) return Number(e.text)
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
      const v = num(e.operand)
      return v === undefined ? undefined : -v
    }
    if (ts.isIdentifier(e) && e.text in known) return known[e.text]
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'SAFE') return SAFE[e.name.text]
    if (ts.isBinaryExpression(e)) {
      const a = num(e.left)
      const b = num(e.right)
      if (a === undefined || b === undefined) return undefined
      switch (e.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return a + b
        case ts.SyntaxKind.MinusToken: return a - b
        case ts.SyntaxKind.AsteriskToken: return a * b
        case ts.SyntaxKind.SlashToken: return b ? a / b : undefined
      }
    }
    return undefined
  }
  const str = (e) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined)

  const styleOf = (attributes) => {
    for (const a of attributes.properties) {
      if (!ts.isJsxAttribute(a) || a.name.getText(sf) !== 'style') continue
      const expr = a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined
      if (!expr || !ts.isObjectLiteralExpression(expr)) return {}
      const out = {}
      for (const p of expr.properties) {
        if (ts.isPropertyAssignment(p)) out[p.name.getText(sf).replace(/["']/g, '')] = p.initializer
      }
      return out
    }
    return {}
  }
  const bad = (node, msg) => at(node.getStart(sf), msg)
  const soft = (node, msg) => noteAt(node.getStart(sf), msg)
  const fix = 'Move it up, or put the scene text inside <SafeArea> from ./brand.'

  // Distance from the bottom edge: below the safe zone, or on the caption box,
  // is a collision; between the caption box and SCENE_FLOOR is room a scene
  // may borrow.
  function checkBottom(el, b, what) {
    if (b < SAFE.bottom) bad(el, `${what} puts this below the safe zone, under Instagram's caption and controls. ${fix}`)
    else if (b < CAPTION_TOP) bad(el, `${what} puts this on top of the captions, which reach ${CAPTION_TOP}px up. ${fix}`)
    else if (b < FLOOR) soft(el, `${what} dips ${FLOOR - b}px into the space kept above the captions; it still clears them.`)
  }

  function checkOffsets(el, style) {
    const t = num(style.top)
    const b = num(style.bottom)
    const l = num(style.left)
    const r = num(style.right)
    if (num(style.inset) === 0 || (t === 0 && b === 0)) return // a full-bleed layer
    if (b !== undefined && b > 0) checkBottom(el, b, `bottom: ${b}`)
    if (t !== undefined && t > 0 && t < SAFE.top) {
      if (t < SAFE.top - SLACK) bad(el, `top: ${t} is under Instagram's top bar (the safe zone starts at ${SAFE.top}; ${SLACK}px of slack). ${fix}`)
      else soft(el, `top: ${t} is ${SAFE.top - t}px above the safe zone.`)
    }
    if (t !== undefined && t > SCENE_BOTTOM) bad(el, `top: ${t} starts below the scene area (max ${SCENE_BOTTOM}), so the text runs into the captions. ${fix}`)
    if (l !== undefined && l > 0 && l < SAFE.left) {
      if (l < SAFE.left - SLACK) bad(el, `left: ${l} is too close to the edge (the safe zone starts at ${SAFE.left}; ${SLACK}px of slack). ${fix}`)
      else soft(el, `left: ${l} is ${SAFE.left - l}px outside the safe zone.`)
    }
    if (r !== undefined && r > 0 && r < SAFE.right) {
      if (r < SAFE.right - SLACK) bad(el, `right: ${r} is under Instagram's like and share buttons (the safe zone starts ${SAFE.right}px in; ${SLACK}px of slack). ${fix}`)
      else soft(el, `right: ${r} is ${SAFE.right - r}px into the like and share column.`)
    }
  }

  // ctx.frame: inside a full-frame AbsoluteFill, so offsets are frame-relative
  // ctx.positioned: inside some other positioned box, so offsets are relative to it
  // ctx.safe: inside <SafeArea>, which is the point
  function visit(node, ctx) {
    let next = ctx
    const el = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null
    if (el) {
      const tag = el.tagName.getText(sf)
      const style = styleOf(el.attributes)
      const position = str(style.position)
      if (tag === 'SafeArea') {
        if (ctx.frame && !ctx.positioned) checkOffsets(el, style) // overriding its insets moves it
        next = { ...ctx, safe: true, positioned: true }
      } else if (tag === 'AbsoluteFill') {
        if (!ctx.positioned && !ctx.safe) {
          next = { ...ctx, frame: true }
          const column = (str(style.flexDirection) ?? 'column') === 'column'
          if (str(style.justifyContent) === 'flex-end' && column) {
            checkBottom(el, num(style.paddingBottom) ?? 0, `content pushed to the bottom of the frame (paddingBottom ${num(style.paddingBottom) ?? 0})`)
          }
        }
      } else if (position === 'absolute' || position === 'fixed') {
        if (ctx.frame && !ctx.positioned && !ctx.safe) checkOffsets(el, style)
        next = { ...ctx, positioned: true }
      } else if (position === 'relative') {
        next = { ...ctx, positioned: true }
      }
    }
    ts.forEachChild(node, (c) => visit(c, next))
  }

  visit(sf, { frame: false, positioned: false, safe: false })
}
