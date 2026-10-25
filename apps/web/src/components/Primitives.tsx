import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { focusFirst, pushBack } from '../lib/focus.ts';
import { useUi } from '../lib/store.ts';
import { IconAlert, IconOffline } from './Icons.tsx';

/** Image that fades in when decoded and shows a titled fallback when missing/broken. */
export function Img({ src, alt, fallback, className, eager }: { src?: string; alt: string; fallback?: ReactNode; className?: string; eager?: boolean }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>(src ? 'loading' : 'error');
  useEffect(() => setState(src ? 'loading' : 'error'), [src]);
  return (
    <>
      {src && state !== 'error' && (
        <img
          src={src}
          alt={alt}
          className={`${className ?? ''} ${state === 'loaded' ? 'loaded' : ''}`}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setState('loaded')}
          onError={() => setState('error')}
          draggable={false}
        />
      )}
      {state === 'error' && fallback}
    </>
  );
}

/** AtlasGlassPanel */
export function GlassPanel({ children, className = '', strong, as: Tag = 'div', ...rest }: { children: ReactNode; className?: string; strong?: boolean; as?: any; [k: string]: any }) {
  return (
    <Tag className={`glass ${strong ? 'glass-strong' : ''} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

/** AtlasDialog: focus-trapped, back-dismissable glass sheet. */
export function Dialog({ open, onClose, title, children, actions, labelledBy, wide }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; actions?: ReactNode; labelledBy?: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    previous.current = document.activeElement as HTMLElement;
    const off = pushBack(() => {
      onClose();
      return true;
    });
    if (ref.current) focusFirst(ref.current);
    return () => {
      off();
      previous.current?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={onClose}>
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy ?? (title ? 'dialog-title' : undefined)}
            data-focus-trap
            className="dialog glass"
            style={wide ? { width: 'min(46rem, 100%)' } : undefined}
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
          >
            {title && <h2 id="dialog-title">{title}</h2>}
            {children}
            {actions && <div className="actions">{actions}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** AtlasToast host */
export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            className={`toast glass ${t.tone ?? ''}`}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <span className="dot" />
            <span>{t.text}</span>
            {t.action && (
              <button
                className="glass-btn sm"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

/** AtlasEmptyState */
export function EmptyState({ icon, title, body, actions, art }: { icon?: 'offline' | 'alert'; title: string; body?: ReactNode; actions?: ReactNode; art?: ReactNode }) {
  const Icon = icon === 'offline' ? IconOffline : icon === 'alert' ? IconAlert : null;
  return (
    <div className="empty">
      {art ?? (Icon && <Icon className="art" style={{ width: '3.5rem', height: '3.5rem', color: 'var(--text-3)' }} />)}
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

/** AtlasLoadingSkeleton for shelves and grids. */
export function ShelfSkeleton({ layout = 'poster', count = 8, title = true }: { layout?: 'poster' | 'landscape' | 'channel'; count?: number; title?: boolean }) {
  const cls = layout === 'poster' ? 'poster' : layout === 'landscape' ? 'landscape' : 'channel';
  const ratio = layout === 'poster' ? '2 / 3' : layout === 'landscape' ? '16 / 9' : '16 / 10';
  return (
    <section aria-hidden="true">
      {title && (
        <div className="row-head">
          <div className="skeleton" style={{ width: '14rem', height: '1.6rem', borderRadius: '0.5rem' }} />
        </div>
      )}
      <div className="shelf no-scrollbar" style={{ overflow: 'hidden' }}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={cls}>
            <div className="skeleton" style={{ aspectRatio: ratio, borderRadius: 'var(--r-md)' }} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Track whether an element is on screen (lazy rows). */
export function useInView<T extends Element>(rootMargin = '300px'): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setInView(true);
        io.disconnect();
      }
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [inView, rootMargin]);
  return [ref, inView];
}

/** Re-render every `ms` (live progress bars, clocks). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
