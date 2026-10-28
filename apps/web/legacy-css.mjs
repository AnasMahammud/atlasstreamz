/**
 * PostCSS pass that keeps the interface usable on older TV browsers, mainly LG webOS 5, 6 and 22
 * (Chromium 68, 79 and 87), without changing what modern browsers do:
 *
 *  - clamp() / min() / max(), env() and dvh get a plain fallback declaration in front of them,
 *    worked out for a 1920×1080 TV screen. Custom properties get theirs in an
 *    `@supports not (clamp)` block, since old browsers accept any custom property value.
 *  - `inset` becomes top/right/bottom/left.
 *  - `:not(a, b)` becomes `:not(a):not(b)`.
 *  - Rules using :focus-visible are split from the rest of their selector list (an unknown
 *    pseudo-class drops the whole rule), and get a :focus copy for browsers without
 *    aspect-ratio (Chromium < 88, which includes every version without :focus-visible).
 *  - Flex containers with `gap` get margin fallbacks under `.no-flexgap`, which main.tsx sets
 *    on <html> when the browser can't do flex gap (Chromium < 84).
 */

// The TV layout runs at 1920×1080 CSS px; the root font size there is calc(0.62vw + 7.4px).
const UNIT = { '': 1, px: 1, vw: 19.2, vh: 10.8, vmin: 10.8, vmax: 19.2, rem: 19.3, em: 19.3 };
const MATH = /(?<![\w-])(clamp|min|max)\(/g;
const NEEDS_FALLBACK = /(?<![\w-])(clamp|min|max|env)\(|\d[dsl]v[hw]\b/;

/** Index of the parenthesis closing the one at `open`. */
function closing(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Split on `sep` at the top level only (not inside parentheses). */
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && (sep === ' ' ? /\s/.test(c) : c === sep)) {
      if (i > start) out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** A length expression in px at TV size, or NaN when it depends on %, var() or keywords. */
function px(expr) {
  if (/var\(|%|env\(/.test(expr)) return NaN;
  const js = expr.replace(/calc\(/g, '(').replace(/(\d*\.?\d+)(px|rem|em|vw|vh|vmin|vmax)?(?![\w.])/g, (_, n, u) => `(${n}*${UNIT[u ?? '']})`);
  if (!/^[\d+\-*/(). ]+$/.test(js)) return NaN;
  try {
    const v = Function(`return ${js}`)();
    return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
  } catch {
    return NaN;
  }
}

/** Pick the argument a TV-sized screen would end up using. */
function pick(fn, args) {
  const v = args.map(px);
  if (fn === 'clamp') {
    const [a, b, c] = v;
    if (![a, b, c].some(Number.isNaN)) return args[b < a ? 0 : b > c ? 2 : 1];
    return Number.isNaN(b) ? args[2] : args[1];
  }
  let best = -1;
  v.forEach((x, i) => {
    if (Number.isNaN(x)) return;
    if (best < 0 || (fn === 'min' ? x < v[best] : x > v[best])) best = i;
  });
  return args[best < 0 ? 0 : best];
}

/** The value with clamp/min/max resolved, env() replaced by its fallback and dvh by vh. */
export function fallbackValue(value) {
  let s = value;
  for (;;) {
    const matches = [...s.matchAll(MATH)];
    if (!matches.length) break;
    // The last match is the innermost, so arguments are free of math functions by the time
    // their enclosing call is resolved.
    const m = matches[matches.length - 1];
    const open = m.index + m[1].length;
    const close = closing(s, open);
    if (close < 0) break;
    const chosen = pick(m[1], splitTop(s.slice(open + 1, close), ','));
    s = s.slice(0, m.index) + chosen + s.slice(close + 1);
  }
  s = s.replace(/env\(\s*[\w-]+\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, fb) => (fb ? fb.trim() : '0px'));
  s = s.replace(/(\d)[dsl]v([hw])\b/g, '$1v$2');
  // calc() around a single term is fine everywhere, but keep the output tidy.
  return s.replace(/calc\((-?[\d.]+[a-z%]*)\)/g, '$1');
}

function expandInset(value) {
  const p = splitTop(value, ' ');
  const [t, r = t, b = t, l = r] = p;
  return { top: t, right: r, bottom: b, left: l };
}

/** `:not(.a, .b)` → `:not(.a):not(.b)` when every item is a simple compound selector. */
function splitNotLists(selector) {
  return selector.replace(/:not\(([^()]*)\)/g, (whole, inner) => {
    const items = inner.split(',').map((x) => x.trim());
    if (items.length < 2 || items.some((x) => !x || /[\s>+~]/.test(x))) return whole;
    return items.map((x) => `:not(${x})`).join('');
  });
}

function prefixWithClass(selector, cls) {
  if (/^(:root|html)\b/.test(selector)) return selector.replace(/^(:root|html)/, `$1.${cls}`);
  return `.${cls} ${selector}`;
}

/** A copy of `rule` with no declarations (and optionally other selectors). */
function emptyClone(rule, selectors) {
  const copy = rule.clone(selectors ? { selectors } : undefined);
  copy.removeAll();
  return copy;
}

const inKeyframes = (node) => {
  for (let p = node.parent; p; p = p.parent) if (p.type === 'atrule' && /keyframes$/.test(p.name)) return true;
  return false;
};

export default function legacyTvCss() {
  return {
    postcssPlugin: 'atlas-legacy-tv-css',
    Once(root, { AtRule }) {
      // 1. Declarations: inset, math functions, env(), dvh.
      const decls = [];
      root.walkDecls((d) => decls.push(d));
      const tokenFallbacks = new Map(); // rule -> [[prop, value]]
      for (const d of decls) {
        if (d.prop === 'inset') {
          const sides = expandInset(d.value);
          for (const side of ['top', 'right', 'bottom', 'left']) d.cloneBefore({ prop: side, value: sides[side] });
          d.remove();
          continue;
        }
        if (!NEEDS_FALLBACK.test(d.value)) continue;
        const fb = fallbackValue(d.value);
        if (fb === d.value) continue;
        if (d.prop.startsWith('--')) {
          if (d.parent?.type !== 'rule') continue;
          const list = tokenFallbacks.get(d.parent) ?? [];
          list.push([d.prop, fb]);
          tokenFallbacks.set(d.parent, list);
        } else {
          d.cloneBefore({ value: fb });
        }
      }
      for (const [rule, list] of tokenFallbacks) {
        const block = new AtRule({ name: 'supports', params: 'not (width: clamp(1px, 1px, 1px))', source: rule.source });
        const copy = emptyClone(rule);
        for (const [prop, value] of list) copy.append({ prop, value, source: rule.source });
        block.append(copy);
        rule.after(block);
      }

      // 2. Selectors: :not() lists, then :focus-visible.
      root.walkRules((rule) => {
        if (inKeyframes(rule)) return;
        if (rule.selector.includes(':not(')) rule.selector = splitNotLists(rule.selector);
        if (!rule.selector.includes(':focus-visible')) return;
        const fv = rule.selectors.filter((s) => s.includes(':focus-visible'));
        const other = rule.selectors.filter((s) => !s.includes(':focus-visible'));
        if (other.length) {
          rule.cloneBefore({ selectors: other });
          rule.selectors = fv;
        }
        const focus = fv.map((s) => s.replace(/:focus-visible/g, ':focus')).filter((s) => !other.includes(s));
        if (!focus.length) return;
        const block = new AtRule({ name: 'supports', params: 'not (aspect-ratio: 1 / 1)', source: rule.source });
        block.append(rule.clone({ selectors: focus }));
        rule.after(block);
      });

      // 3. Flex gap → margins on the children.
      root.walkRules((rule) => {
        if (inKeyframes(rule)) return;
        const own = {};
        rule.each((n) => {
          if (n.type === 'decl') own[n.prop] = fallbackValue(n.value);
        });
        if (!/^(inline-)?flex$/.test(own.display ?? '')) return;
        const gap = own.gap ? splitTop(own.gap, ' ') : [];
        const rowGap = own['row-gap'] ?? gap[0];
        const colGap = own['column-gap'] ?? gap[1] ?? gap[0];
        const flow = `${own['flex-direction'] ?? ''} ${own['flex-flow'] ?? ''}`;
        const column = /column/.test(flow);
        const wrap = /(^|\s)wrap/.test(`${own['flex-wrap'] ?? ''} ${own['flex-flow'] ?? ''}`);
        const main = column ? rowGap : colGap;
        const selectors = rule.selectors.filter((s) => !s.includes('::')).map((s) => prefixWithClass(s, 'no-flexgap'));
        if (!selectors.length) return;
        const added = [];
        if (main && main !== '0' && main !== 'normal') {
          added.push(emptyClone(rule, selectors.map((s) => `${s} > :not(:last-child)`)).append({ prop: column ? 'margin-bottom' : 'margin-right', value: main, source: rule.source }));
        }
        if (wrap && !column && rowGap && rowGap !== '0' && rowGap !== 'normal') {
          added.push(emptyClone(rule, selectors.map((s) => `${s} > *`)).append({ prop: 'margin-bottom', value: rowGap, source: rule.source }));
        }
        let at = rule;
        for (const r of added) {
          at.after(r);
          at = r;
        }
      });
    },
  };
}
legacyTvCss.postcss = true;
