import { describe, expect, it } from 'vitest';
import {
  XmltvStreamParser,
  normalizeLiveStreams,
  normalizeSeriesList,
  normalizeVodStreams,
  parseAccountInfo,
  parseSeriesInfo,
  parseVodInfo,
  parseXmltv,
  parseXmltvTime,
  xtreamFromPlaylistUrl,
  xtreamUrls,
} from '../src/index.ts';

describe('Xtream', () => {
  it('derives API credentials from a get.php playlist URL', () => {
    const c = xtreamFromPlaylistUrl('http://panel.example:8080/get.php?username=u1&password=p%402&type=m3u_plus&output=ts');
    expect(c).toEqual({ baseUrl: 'http://panel.example:8080', username: 'u1', password: 'p@2' });
    expect(xtreamFromPlaylistUrl('http://example.com/list.m3u')).toBeNull();
    expect(xtreamUrls.live(c!, 42)).toBe('http://panel.example:8080/live/u1/p%402/42.m3u8');
  });

  it('parses account info including invalid credentials', () => {
    expect(parseAccountInfo({ user_info: { auth: 0 } }).auth).toBe(false);
    const ok = parseAccountInfo({ user_info: { auth: 1, status: 'Active', exp_date: '1793552895', max_connections: '2', allowed_output_formats: ['m3u8', 'ts'] }, server_info: { timezone: 'Europe/Lisbon' } });
    expect(ok).toMatchObject({ auth: true, status: 'Active', maxConnections: 2, outputFormats: ['m3u8', 'ts'], serverTimezone: 'Europe/Lisbon' });
    expect(ok.expiresAt).toBe(1793552895000);
    expect(parseAccountInfo(null).auth).toBe(false);
  });

  it('normalises streams and tolerates junk rows', () => {
    const live = normalizeLiveStreams('p', [{ stream_id: 7, name: 'UK: BBC One FHD', category_id: '3', epg_channel_id: 'bbc1.uk', is_adult: 0, num: 1 }, { name: 'no id' }, null]);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: 'p:live:7', name: 'BBC One', region: 'UK', categoryId: 'p:category:live-3', epgId: 'bbc1.uk' });
    const vod = normalizeVodStreams('p', [{ stream_id: 9, name: 'A Minecraft Movie - 2025', rating: '6.3', container_extension: 'MKV', added: '1764087600', stream_icon: 'not-a-url' }]);
    expect(vod[0]).toMatchObject({ title: 'A Minecraft Movie', year: 2025, rating: 6.3, container: 'mkv', addedAt: 1764087600000, poster: undefined });
    const series = normalizeSeriesList('p', [{ series_id: 5, name: 'Crystal Lake (2026)', genre: 'Drama / Mystery', backdrop_path: ['https://img/a.jpg'] }]);
    expect(series[0]).toMatchObject({ title: 'Crystal Lake', year: 2026, genres: ['Drama', 'Mystery'], backdrop: 'https://img/a.jpg' });
    expect(normalizeVodStreams('p', { error: 'nope' })).toEqual([]);
  });

  it('prefers HH:MM:SS duration over a bogus duration_secs', () => {
    expect(parseVodInfo({ info: { duration: '01:41:09', duration_secs: '101' } }).runtimeMin).toBe(101);
    expect(parseVodInfo({ info: { duration_secs: '5400' } }).runtimeMin).toBe(90);
  });

  it('parses series info with object or array episode maps', () => {
    const asObj = parseSeriesInfo('p', '5', {
      seasons: [{ season_number: 1, cover_tmdb: 'https://img/s1.jpg' }],
      episodes: { '1': [{ id: '11', episode_num: 2, season: 1, title: 'Show - S01E02 - Second', info: { duration_secs: 3000, video: { height: 1080 } } }, { id: '10', episode_num: 1, season: 1, title: 'Show - S01E01 - First' }] },
    });
    expect(asObj.episodes.map((e) => e.title)).toEqual(['First', 'Second']);
    expect(asObj.episodes[1].reportedHeight).toBe(1080);
    expect(asObj.seasons).toEqual([{ number: 1, name: 'Season 1', episodeCount: 2, poster: 'https://img/s1.jpg' }]);
    const asArr = parseSeriesInfo('p', '5', { episodes: [[{ id: '20', season: 2, episode_num: 1, title: 'Pilot' }]] });
    expect(asArr.episodes[0]).toMatchObject({ season: 2, episode: 1, title: 'Pilot', seriesId: 'p:series:5' });
  });
});

describe('XMLTV', () => {
  it('parses timestamps with and without offsets', () => {
    expect(parseXmltvTime('20261025160000 +0100')).toBe(Date.UTC(2026, 9, 25, 15, 0, 0));
    expect(parseXmltvTime('20261025160000 -0530')).toBe(Date.UTC(2026, 9, 25, 21, 30, 0));
    expect(parseXmltvTime('20261025160000')).toBe(Date.UTC(2026, 9, 25, 16, 0, 0));
    expect(parseXmltvTime('20261025160000', 60)).toBe(Date.UTC(2026, 9, 25, 15, 0, 0));
    expect(parseXmltvTime('202610251600Z')).toBe(Date.UTC(2026, 9, 25, 16, 0, 0));
    expect(parseXmltvTime('garbage')).toBeUndefined();
  });

  const xml = `<?xml version="1.0"?><tv>
    <channel id="bbc1.uk"><display-name lang="de">BBC Eins</display-name><display-name lang="en">BBC One</display-name><icon src="https://img/bbc.png"/></channel>
    <programme start="20261025150000 +0000" stop="20261025160000 +0000" channel="bbc1.uk"><title lang="en">News &amp; Weather</title><desc><![CDATA[Headlines <live>]]></desc><category>News</category></programme>
    <programme start="20261025160000 +0000" stop="20261025150000 +0000" channel="bbc1.uk"><title>Backwards</title></programme>
    <programme start="20261025160000 +0000" stop="20261025170000 +0000" channel="other"><title>Filtered</title></programme>
    <programme start="20261026160000 +0000" stop="20261026170000 +0000" channel="bbc1.uk"><title>Too late</title></programme>
  </tv>`;

  it('parses channels and programmes, decoding entities and CDATA', () => {
    const r = parseXmltv(xml, { preferLangs: ['en'] });
    expect(r.channels[0]).toEqual({ id: 'bbc1.uk', name: 'BBC One', icon: 'https://img/bbc.png' });
    expect(r.programmes[0]).toMatchObject({ title: 'News & Weather', desc: 'Headlines <live>', category: 'News' });
    expect(r.skipped).toBe(1); // the backwards programme
  });

  it('applies channel filters and time windows while streaming in tiny chunks', () => {
    const titles: string[] = [];
    const p = new XmltvStreamParser({
      onProgramme: (x) => titles.push(x.title),
      channelFilter: (id) => id === 'bbc1.uk',
      windowStart: Date.UTC(2026, 9, 25, 0),
      windowEnd: Date.UTC(2026, 9, 26, 0),
    });
    for (let i = 0; i < xml.length; i += 7) p.push(xml.slice(i, i + 7));
    p.end();
    expect(titles).toEqual(['News & Weather']);
  });
});
