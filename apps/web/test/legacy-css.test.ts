import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
// @ts-expect-error plain ES module without type declarations
import legacyTvCss, { fallbackValue } from '../legacy-css.mjs';

/** Run the pass and normalise whitespace and final semicolons, which don't matter here. */
const run = async (css: string) =>
  (await postcss([legacyTvCss()]).process(css, { from: undefined })).css
    .replace(/;\s*}/g, '}')
    .replace(/\s*([{}])\s*/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();

describe('fallback values for older TV browsers (1920×1080)', () => {
  it('resolves clamp() to the value a TV screen would use', () => {
    expect(fallbackValue('clamp(14px, calc(0.62vw + 7.4px), 22px)')).toBe('calc(0.62vw + 7.4px)');
    expect(fallbackValue('clamp(7.5rem, 11.2vw, 15rem)')).toBe('11.2vw');
    expect(fallbackValue('clamp(1rem, 1vw, 5rem)')).toBe('1rem');
  });

  it('resolves min()/max(), preferring lengths it can compare over % and var()', () => {
    expect(fallbackValue('min(34rem, 100%)')).toBe('34rem');
    expect(fallbackValue('min(86vh, 56vw)')).toBe('86vh');
    expect(fallbackValue('min(36rem, calc(100vw - 2rem))')).toBe('36rem');
    expect(fallbackValue('max(1rem, 2vw)')).toBe('2vw');
  });

  it('replaces env() and dynamic viewport units, and leaves minmax() alone', () => {
    expect(fallbackValue('calc(1.5rem + env(safe-area-inset-bottom))')).toBe('calc(1.5rem + 0px)');
    expect(fallbackValue('calc(100dvh - 2 * var(--gutter))')).toBe('calc(100vh - 2 * var(--gutter))');
    expect(fallbackValue('repeat(auto-fill, minmax(var(--poster-w), 1fr))')).toBe('repeat(auto-fill, minmax(var(--poster-w), 1fr))');
  });
});

describe('legacy TV CSS pass', () => {
  it('puts a plain fallback before declarations using clamp()', async () => {
    expect(await run('h1 { font-size: clamp(2rem, 4vw, 5rem); }')).toBe('h1 { font-size: 4vw; font-size: clamp(2rem, 4vw, 5rem) }');
  });

  it('re-declares clamp() custom properties for browsers without clamp()', async () => {
    const out = await run(':root { --gutter: clamp(1rem, 4.2vw, 5rem); --r: 1rem; }');
    expect(out).toContain('@supports not (width: clamp(1px, 1px, 1px)) { :root { --gutter: 4.2vw } }');
  });

  it('expands inset', async () => {
    expect(await run('.a { inset: auto 0 0 0; }')).toBe('.a { top: auto; right: 0; bottom: 0; left: 0 }');
  });

  it('splits :not() lists and keeps other selectors working without :focus-visible', async () => {
    const out = await run('.btn:hover, .btn:focus-visible { color: red } :focus-visible:not(.a, .b) { outline: 0 }');
    expect(out).toContain('.btn:hover { color: red }');
    expect(out).toContain('.btn:focus-visible { color: red }');
    expect(out).toContain('@supports not (aspect-ratio: 1 / 1) { .btn:focus { color: red } }');
    expect(out).toContain(':focus-visible:not(.a):not(.b) { outline: 0 }');
    expect(out).toContain('@supports not (aspect-ratio: 1 / 1) { :focus:not(.a):not(.b) { outline: 0 } }');
  });

  it('gives flex containers with gap a margin fallback under .no-flexgap', async () => {
    const out = await run('.row { display: flex; gap: 1rem 2rem; } .col { display: flex; flex-direction: column; gap: 0.5rem; } :root[data-device="tv"] .bar { display: flex; gap: 1rem; }');
    expect(out).toContain('.no-flexgap .row > :not(:last-child) { margin-right: 2rem }');
    expect(out).toContain('.no-flexgap .col > :not(:last-child) { margin-bottom: 0.5rem }');
    expect(out).toContain(':root.no-flexgap[data-device="tv"] .bar > :not(:last-child) { margin-right: 1rem }');
  });

  it('leaves grid gaps and modern-only rules untouched', async () => {
    expect(await run('.g { display: grid; gap: 1rem; }')).toBe('.g { display: grid; gap: 1rem }');
  });
});
