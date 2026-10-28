/** Subtitle helpers: SRT → WebVTT conversion (shared with the server) and cue timing offsets. */

export { srtToVtt, toVtt } from '@atlas/core';

/** Shift every cue in a track by `deltaSec` (positive delays subtitles). */
export function shiftTrack(track: TextTrack, deltaSec: number): void {
  if (!track.cues || deltaSec === 0) return;
  for (const cue of Array.from(track.cues)) {
    cue.startTime = Math.max(0, cue.startTime + deltaSec);
    cue.endTime = Math.max(cue.startTime + 0.05, cue.endTime + deltaSec);
  }
}
