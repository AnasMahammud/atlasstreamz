import { motion, useAnimationControls } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PIN_MAX, PIN_MIN } from '@atlas/core';
import { IconBackspace } from './Icons.tsx';

/**
 * AtlasPinInput. Works with a TV remote (D-pad over the keypad), a hardware keyboard
 * (digits typed anywhere), and touch. Submits automatically at `length` digits.
 */
export function PinPad({
  length = 4,
  onSubmit,
  error,
  busy,
  allowVariable,
  label = 'Enter PIN',
}: {
  length?: number;
  onSubmit: (pin: string) => void;
  error?: string | null;
  busy?: boolean;
  allowVariable?: boolean;
  label?: string;
}) {
  const [pin, setPin] = useState('');
  const controls = useAnimationControls();
  const max = allowVariable ? PIN_MAX : length;
  const firstKey = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (error) {
      setPin('');
      void controls.start({ x: [0, -14, 12, -8, 6, 0], transition: { duration: 0.42 } });
    }
  }, [error, controls]);

  useEffect(() => {
    requestAnimationFrame(() => firstKey.current?.focus({ preventScroll: true }));
  }, []);

  // Clear after each attempt so a repeated identical error still starts from empty.
  const submit = useCallback(
    (value: string) => {
      onSubmit(value);
      setPin('');
    },
    [onSubmit],
  );

  const press = useCallback(
    (d: string) => {
      if (busy) return;
      setPin((p) => {
        if (p.length >= max) return p;
        const next = p + d;
        if (!allowVariable && next.length === length) window.setTimeout(() => submit(next), 120);
        return next;
      });
    },
    [busy, max, allowVariable, length, submit],
  );

  const del = useCallback(() => setPin((p) => p.slice(0, -1)), []);

  // Remote "OK" and keyboard Enter are the same key. After typing digits Enter submits;
  // while navigating the keypad with arrows it presses the focused key.
  const typed = useRef(false);
  const pinRef = useRef(pin);
  pinRef.current = pin;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        typed.current = true;
        press(e.key);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (!pinRef.current) return; // empty: let Back close the dialog
        e.preventDefault();
        e.stopImmediatePropagation();
        del();
      } else if (e.key.startsWith('Arrow')) {
        typed.current = false;
      } else if (e.key === 'Enter' && typed.current && allowVariable) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (pinRef.current.length >= PIN_MIN) submit(pinRef.current);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [press, del, allowVariable, submit]);

  const dots = allowVariable ? Math.max(PIN_MIN, pin.length) : length;
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return (
    <div className="pinpad">
      <div className="t-caption" style={{ textAlign: 'center' }} id="pin-label">
        {label}
      </div>
      <motion.div className="pin-dots" animate={controls} role="status" aria-live="polite" aria-labelledby="pin-label" aria-label={`${pin.length} of ${dots} digits entered`}>
        {Array.from({ length: dots }, (_, i) => (
          <span key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
        ))}
      </motion.div>
      <div className="pin-error" role="alert">
        {error ?? ' '}
      </div>
      <div className="pin-keys">
        {keys.map((k, i) => (
          <button key={k} ref={i === 0 ? firstKey : undefined} className="pin-key glass" data-pin-key onClick={() => press(k)} disabled={busy}>
            {k}
          </button>
        ))}
        {allowVariable ? (
          <button className="pin-key glass ok" onClick={() => pin.length >= PIN_MIN && submit(pin)} disabled={busy || pin.length < PIN_MIN} aria-label="Confirm PIN">
            OK
          </button>
        ) : (
          <span />
        )}
        <button className="pin-key glass" data-pin-key onClick={() => press('0')} disabled={busy}>
          0
        </button>
        <button className="pin-key glass" onClick={del} aria-label="Delete digit" disabled={busy || !pin}>
          <IconBackspace style={{ width: '1.4rem', height: '1.4rem' }} />
        </button>
      </div>
    </div>
  );
}
