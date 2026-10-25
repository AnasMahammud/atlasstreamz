import { describe, expect, it } from 'vitest';
import { M3UCatalogBuilder, M3UStreamParser, classifyStreamUrl, parseEpisodeMarker, parseM3U, streamIdFromUrl } from '../src/index.ts';

describe('M3U parser', () => {
  it('parses header EPG urls, attributes and titles with commas', () => {
    const { header, entries } = parseM3U(
      '﻿#EXTM3U url-tvg="http://epg.example/a.xml,http://epg.example/b.xml" x-tvg-url="http://epg.example/c.xml"\r\n' +
        '#EXTINF:-1 tvg-ID="bbc1.uk" tvg-name="BBC One" tvg-logo="http://logo/bbc.png" group-title="UK, Entertainment",BBC One, London\r\n' +
        'http://p.example/live/u/p/101.ts\r\n',
    );
    expect(header.epgUrls).toEqual(['http://epg.example/a.xml', 'http://epg.example/b.xml', 'http://epg.example/c.xml']);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('BBC One, London');
    expect(entries[0].attrs['tvg-id']).toBe('bbc1.uk');
    expect(entries[0].group).toBe('UK, Entertainment');
  });

  it('handles chunk boundaries anywhere, including inside a line', () => {
    const text = '#EXTM3U\n#EXTINF:-1 group-title="News",CNN\nhttp://x/1.ts\n#EXTINF:-1,Sky\nhttp://x/2.ts';
    const out: string[] = [];
    const p = new M3UStreamParser((e) => out.push(e.title));
    for (const ch of text) p.push(ch);
    p.end();
    expect(out).toEqual(['CNN', 'Sky']);
  });

  it('keeps #EXTVLCOPT options, #EXTGRP groups, and skips stray comments', () => {
    const { entries } = parseM3U(
      '#EXTM3U\n#EXTINF:-1,Channel A\n#EXTGRP:Sports\n#EXTVLCOPT:http-user-agent=Mozilla/5.0\n# random comment\nhttp://x/a.m3u8\n',
    );
    expect(entries[0].group).toBe('Sports');
    expect(entries[0].options['http-user-agent']).toBe('Mozilla/5.0');
  });

  it('counts an EXTINF with no URL as skipped and ignores non-URL lines', () => {
    const r = parseM3U('#EXTM3U\n#EXTINF:-1,Broken\n#EXTINF:-1,Good\nhttp://x/g.ts\nnot a url\n');
    expect(r.entries.map((e) => e.title)).toEqual(['Good']);
    expect(r.skipped).toBe(2);
  });

  it('accepts bare URLs without EXTINF and old CR-only line endings', () => {
    const r = parseM3U('#EXTM3U\r#EXTINF:-1,One\rhttp://x/1.ts\rhttp://x/movies/two.mp4\r');
    expect(r.entries.map((e) => e.title)).toEqual(['One', 'two']);
  });

  it('classifies Xtream URLs and extracts stream ids', () => {
    expect(classifyStreamUrl('http://h/movie/u/p/123.mkv')).toBe('movie');
    expect(classifyStreamUrl('http://h/series/u/p/456.mp4')).toBe('episode');
    expect(classifyStreamUrl('http://h/u/p/789')).toBe('live');
    expect(classifyStreamUrl('http://h/live/u/p/789.m3u8')).toBe('live');
    expect(streamIdFromUrl('http://h/movie/u/p/123.mkv')).toBe('123');
  });

  it('parses episode markers', () => {
    expect(parseEpisodeMarker('Crystal Lake (2026) S01 E03')).toEqual({ show: 'Crystal Lake (2026)', season: 1, episode: 3, episodeTitle: undefined });
    expect(parseEpisodeMarker('The Office 2x05')).toEqual({ show: 'The Office', season: 2, episode: 5, episodeTitle: undefined });
    expect(parseEpisodeMarker('Genombrottet (2025) S01 Genombrottet (2025) - S01E02 - Leave No Stone Unturned')).toEqual({
      show: 'Genombrottet (2025)',
      season: 1,
      episode: 2,
      episodeTitle: 'Leave No Stone Unturned',
    });
    expect(parseEpisodeMarker('Superman')).toBeNull();
  });
});

describe('M3U catalogue builder', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="cnn.us" group-title="US News",CNN HD',
    'http://h/u/p/1001',
    '#EXTINF:-1 tvg-id="cnn.us" group-title="US News",CNN HD',
    'http://h/u/p/1001',
    '#EXTINF:-1 tvg-id="cnn.us" group-title="US News",CNN HD',
    'http://h/u/p/1002',
    '#EXTINF:-1 tvg-logo="https://img/p.jpg" group-title="Action",Superman (2025)',
    'http://h/movie/u/p/5001.mkv',
    '#EXTINF:-1 group-title="Drama Series",Crystal Lake (2026) S01 E01',
    'http://h/series/u/p/9001.mkv',
    '#EXTINF:-1 group-title="Drama Series",Crystal Lake (2026) S01 E02',
    'http://h/series/u/p/9002.mkv',
  ].join('\n');

  const build = () => {
    const b = new M3UCatalogBuilder('p1');
    parseM3U(playlist).entries.forEach((e) => b.add(e));
    return b.build();
  };

  it('drops exact duplicate URLs and links same-name channels as alternates', () => {
    const c = build();
    expect(c.duplicatesDropped).toBe(1);
    expect(c.channels).toHaveLength(2);
    expect(c.alternates.get('p1:live:1001')).toEqual(['p1:live:1002']);
    expect(c.channels[0].item.name).toBe('CNN');
    expect(c.channels[0].item.qualityHint).toBe('HD');
  });

  it('uses provider stream ids so ids survive reordering', () => {
    const a = build();
    const b = new M3UCatalogBuilder('p1');
    parseM3U(playlist).entries.reverse().forEach((e) => b.add(e));
    const reordered = b.build();
    expect(new Set(reordered.movies.map((m) => m.item.id))).toEqual(new Set(a.movies.map((m) => m.item.id)));
    expect(a.movies[0].item).toMatchObject({ id: 'p1:movie:5001', title: 'Superman', year: 2025, container: 'mkv' });
  });

  it('groups episodes into one series', () => {
    const c = build();
    expect(c.series).toHaveLength(1);
    expect(c.series[0]).toMatchObject({ title: 'Crystal Lake', year: 2026 });
    expect(c.episodes.map((e) => [e.item.season, e.item.episode])).toEqual([[1, 1], [1, 2]]);
    expect(c.categories.map((x) => x.kind).sort()).toEqual(['live', 'movie', 'series']);
  });
});
