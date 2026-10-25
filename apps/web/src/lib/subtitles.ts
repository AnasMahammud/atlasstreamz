/** Subtitle helpers: SRT → WebVTT conversion and cue timing offsets. */

export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.trim().split('\n');
      if (!lines.length) return '';
      // Drop the numeric index line if present.
      if (/^\d+$/.test(lines[0].trim())) lines.shift();
      if (!lines.length) return '';
      lines[0] = lines[0].replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').replace(/(^|\s)(\d{1,2}:\d{2}),(\d{3})/g, '$1$2.$3');
      return lines.join('\n');
    })
    .filter((b) => /-->/.test(b))
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

export function toVtt(name: string, text: string): string {
  if (/^﻿?WEBVTT/.test(text)) return text;
  if (/\.srt$/i.test(name) || /-->/.test(text)) return srtToVtt(text);
  throw new Error('Unsupported subtitle format. Use .srt or .vtt.');
}

/** Shift every cue in a track by `deltaSec` (positive delays subtitles). */
export function shiftTrack(track: TextTrack, deltaSec: number): void {
  if (!track.cues || deltaSec === 0) return;
  for (const cue of Array.from(track.cues)) {
    cue.startTime = Math.max(0, cue.startTime + deltaSec);
    cue.endTime = Math.max(cue.startTime + 0.05, cue.endTime + deltaSec);
  }
}
