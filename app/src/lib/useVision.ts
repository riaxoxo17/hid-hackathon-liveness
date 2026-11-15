import { useEffect, useState, RefObject } from 'react';
import { vision, Analysis } from './vision';

export function useVision(videoRef: RefObject<HTMLVideoElement>) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(vision.ready ? 'ready' : 'loading');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  useEffect(() => {
    let alive = true;
    let last = 0;
    const el = videoRef.current;
    vision
      .init()
      .then(() => {
        if (!alive || !el) return;
        vision.attach(el);
        setStatus('ready');
      })
      .catch(() => alive && setStatus('error'));
    const unsub = vision.subscribe((a) => {
      if (a.t - last > 160) {
        last = a.t;
        setAnalysis(a);
      }
    });
    return () => {
      alive = false;
      unsub();
      if (el) vision.detach(el);
    };
  }, []);
  return { status, analysis };
}
