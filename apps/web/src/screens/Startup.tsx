import { useEffect, useState } from 'react';
import { AtlasEmblem } from '../components/Brand.tsx';
import { prefersReducedMotion, storageGet, storageSet } from '../lib/device.ts';

/**
 * Cinematic startup: black → atmospheric glow → contours trace the emblem → glass fill →
 * wordmark → specular sweep → focus resolve → hand-off. ~2.6 s the first time, ~1 s on
 * return visits, a plain fade with reduced motion. Any key, click or tap skips it.
 */
export function Startup({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<'run' | 'out'>('run');
  const seen = storageGet('atlas.introSeen', false);
  const reduced = prefersReducedMotion();
  const total = reduced ? 450 : seen ? 1150 : 2700;

  useEffect(() => {
    storageSet('atlas.introSeen', true);
    const out = window.setTimeout(() => setPhase('out'), total);
    const done = window.setTimeout(onDone, total + 520);
    const skip = () => {
      window.clearTimeout(out);
      window.clearTimeout(done);
      setPhase('out');
      window.setTimeout(onDone, 380);
    };
    window.addEventListener('keydown', skip, { once: true });
    window.addEventListener('pointerdown', skip, { once: true });
    return () => {
      window.clearTimeout(out);
      window.clearTimeout(done);
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [onDone, total]);

  return (
    <div className={`startup ${phase} ${reduced ? 'reduced' : seen ? 'quick' : 'full'}`} role="img" aria-label="ATLAS">
      <div className="startup-glow" />
      <div className="startup-mark">
        <AtlasEmblem size={168} draw />
        <div className="startup-sheen" />
      </div>
      <div className="startup-word">ATLAS</div>
      <div className="startup-tag">Your Universe of Entertainment</div>
    </div>
  );
}
