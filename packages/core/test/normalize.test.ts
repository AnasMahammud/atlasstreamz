import { describe, expect, it } from 'vitest';
import { cleanChannelName, cleanTitle, genreFromName, splitGenres, splitRegion } from '../src/index.ts';

describe('title normalisation', () => {
  it.each([
    ['A Minecraft Movie - 2025', 'A Minecraft Movie', 2025],
    ['Crystal Lake (2026)', 'Crystal Lake', 2026],
    ['Superman [2025] 4K', 'Superman', 2025],
    ['Blade Runner 2049 (2017)', 'Blade Runner 2049', 2017],
    ['Mission: Impossible', 'Mission: Impossible', undefined],
    ['DE | Der Schuh des Manitu - 2001', 'Der Schuh des Manitu', 2001],
  ])('%s', (raw, title, year) => {
    const c = cleanTitle(raw);
    expect(c.title).toBe(title);
    expect(c.year).toBe(year);
  });

  it('keeps 2-letter look-alikes that are really titles', () => {
    expect(cleanTitle('It - 2017')).toMatchObject({ title: 'It', year: 2017, region: undefined });
    expect(splitRegion('IT - Drama').region).toBe('IT');
  });

  it('detects provider quality claims without trusting them as verified', () => {
    expect(cleanTitle('Dune Part Two 4K').qualityHint).toBe('4K');
    expect(cleanChannelName('UK: Sky Sports Main Event FHD')).toMatchObject({ title: 'Sky Sports Main Event', region: 'UK', qualityHint: 'FHD' });
    expect(cleanChannelName('Sportsnet+ 17 :').title).toBe('Sportsnet+ 17');
  });

  it('maps category names to genres and splits genre strings', () => {
    expect(genreFromName('U.K - Sky Sports')).toBe('sports');
    expect(genreFromName('U.K - News')).toBe('news');
    expect(genreFromName('Sci-Fi / Fantasy')).toBe('scifi');
    expect(genreFromName('Comedy')).toBe('comedy');
    expect(genreFromName('DE | Komödie')).toBe('comedy');
    expect(genreFromName('Documentary')).toBe('documentary');
    expect(genreFromName('Animation')).toBe('animation');
    expect(genreFromName('Family/Kids')).toBe('kids');
    expect(genreFromName('World Cup 2026 Replays')).toBe('sports');
    expect(cleanChannelName('Sky Sports Main Event HD 50FPS').title).toBe('Sky Sports Main Event');
    expect(splitGenres('Drama / Mystery')).toEqual(['Drama', 'Mystery']);
  });
});
