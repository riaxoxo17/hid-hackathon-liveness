import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, GUIDE, QUALITY_CODES, REASONS } from '../lib/api';
import { useVision } from '../lib/useVision';
import { sleep, vision } from '../lib/vision';
import { offline } from '../lib/offline';

// campus time (IST) as 'YYYY-MM-DDTHH:MM', the format the schedule and the offline cache use
const istNow = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16);

const LivenessCheck = lazy(() => import('./LivenessCheck'));

type Phase = 'idle' | 'checking' | 'result' | 'action' | 'liveness' | 'pin';
type Final = { decision: 'ALLOW' | 'DENY' | 'VERIFY'; reasons: string[]; via: string };

const ACTIONS = [
  { id: 'BLINK', text: 'Blink twice' },
  { id: 'MOUTH', text: 'Open your mouth wide' },
  { id: 'SMILE', text: 'Give a big smile' },
  { id: 'TURN', text: 'Turn your head to one side' },
];

const GAZE_DELTA = 0.045; // how far the irises must move, as a fraction of eye width

const PRESENTATIONS = [
  ['genuine', 'Genuine person'],
  ['print', 'Printed photo'],
  ['screen_photo', 'Phone photo'],
  ['video', 'Video replay'],
  ['mask', 'Mask'],
];

export default function Kiosk() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { status, analysis } = useVision(videoRef);
  const [users, setUsers] = useState<any[]>([]);
  const [badgeId, setBadgeId] = useState('');
  const [sched, setSched] = useState<any>(null);
  const [zone, setZone] = useState('');
  const [clock, setClock] = useState('');
  const [testOn, setTestOn] = useState(false);
  const [presentation, setPresentation] = useState('genuine');
  const [identity, setIdentity] = useState('self');
  const [phase, setPhase] = useState<Phase>('idle');
  const [passive, setPassive] = useState<any>(null);
  const [final, setFinal] = useState<Final | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const [challenge, setChallenge] = useState<{ text: string; note: string } | null>(null);
  const [live, setLive] = useState<any>(null);
  const [message, setMessage] = useState('');
  const [dot, setDot] = useState<'L' | 'R' | null>(null);
  const busy = useRef(false);
  // offline mode
  const [, setNetTick] = useState(0);
  const [offlineInfo, setOfflineInfo] = useState<any>(null);
  const [pin, setPin] = useState('');
  const pinWait = useRef<((v: string | null) => void) | null>(null);
  const [syncMsg, setSyncMsg] = useState('');
  const door = zone || 'main_gate';

  useEffect(() => {
    api.users().then((r) => setUsers(r.users)).catch(() => {});
    api.schedule().then(setSched).catch(() => {});
  }, []);

  // connection watch: ping every 10 s; on reconnect the offline log is uploaded automatically
  useEffect(() => {
    const unsub = offline.subscribe(() => setNetTick((n) => n + 1));
    offline.ping();
    const id = setInterval(() => offline.ping(), 10000);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, []);
  // keep this door's offline cache fresh while online
  useEffect(() => {
    const get = () => offline.refresh(door, clock || null).catch((e) => offline.markDown(e));
    get();
    const id = setInterval(get, 5 * 60000);
    return () => clearInterval(id);
  }, [door, clock, offline.online, offline.forced]);
  useEffect(() => {
    if (offline.isOffline() || !offline.queue().length) return;
    offline.sync().then((r) => r && setSyncMsg(`Synced ${r.sent} offline decision(s)${r.conflicts.length ? `, ${r.conflicts.length} flagged for review` : ''}.`)).catch(() => {});
  }, [offline.online, offline.forced]);

  const reset = useCallback(() => {
    setPhase('idle');
    setPassive(null);
    setFinal(null);
    setTrail([]);
    setChallenge(null);
    setLive(null);
    setMessage('');
    setDot(null);
  }, []);

  const finish = (decision: Final['decision'], reasons: string[], via: string) => {
    setFinal({ decision, reasons, via });
    setChallenge(null);
    setLive(null);
    setPhase('result');
  };

  const startLiveness = async (sk: string) => {
    setTrail((t) => [...t, 'Escalated to AWS Face Liveness']);
    setChallenge({ text: 'One last check', note: 'Starting AWS Face Liveness' });
    try {
      const s = await api.livenessSession();
      setLive({ ...s, sk });
      setPhase('liveness');
      setChallenge(null);
    } catch (e: any) {
      await api.stepup({ sk, method: 'abandon' }).catch(() => {});
      finish('DENY', ['LIVENESS_ERROR'], 'Face Liveness');
    }
  };

  const livenessDone = async (error?: string) => {
    const sk = live.sk;
    if (error) setTrail((t) => [...t, `Face Liveness error: ${error}`]);
    try {
      const r = await api.stepup({ sk, method: 'liveness', sessionId: live.sessionId, error });
      setTrail((t) => [...t, `Face Liveness confidence ${r.livenessConfidence ?? 'n/a'}`]);
      finish(r.decision, r.reasons, 'Face Liveness');
    } catch {
      finish('DENY', ['LIVENESS_ERROR'], 'Face Liveness');
    }
  };

  const runAction = async (sk: string) => {
    const action = ACTIONS[Math.floor(Math.random() * ACTIONS.length)];
    setPhase('action');
    setTrail((t) => [...t, `Random action: ${action.text.toLowerCase()}`]);
    const neutral = () => {
      const a = vision.latest;
      return !!a && !!a.box && Math.abs(a.turn - 0.5) < 0.1 && a.blink < 0.35 && a.jaw < 0.2 && a.smile < 0.35;
    };
    const waitFor = async (cond: () => boolean, ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        if (cond()) return true;
        await sleep(50);
      }
      return false;
    };
    const scores: number[] = [];
    const collect = setInterval(() => {
      const a = vision.latest;
      if (a && a.spoof !== null && Math.abs(a.turn - 0.5) < 0.12) scores.push(a.spoof);
    }, 90);
    let passed = false;
    try {
      setChallenge({ text: 'Look straight at the camera', note: 'One more quick check' });
      await waitFor(neutral, 3000);
      setChallenge({ text: action.text, note: 'Then look back at the camera' });
      const L = () => vision.latest;
      if (action.id === 'BLINK') {
        let blinks = 0;
        for (let i = 0; i < 2; i++) {
          const closed = await waitFor(() => (L()?.blink ?? 0) > 0.45, i === 0 ? 5000 : 3000);
          if (!closed) break;
          const open = await waitFor(() => (L()?.blink ?? 1) < 0.25, 2000);
          if (!open) break;
          blinks++;
        }
        passed = blinks >= 2;
      } else if (action.id === 'MOUTH') {
        passed = await waitFor(() => !!L()?.box && (L()?.jaw ?? 0) > 0.45, 5000);
      } else if (action.id === 'SMILE') {
        passed = await waitFor(() => !!L()?.box && (L()?.smile ?? 0) > 0.4, 5000);
      } else {
        passed = await waitFor(() => !!L()?.box && Math.abs((L()?.turn ?? 0.5) - 0.5) > 0.17, 5000);
      }
      if (passed) {
        setChallenge({ text: 'Look back at the camera', note: 'Almost done' });
        passed = await waitFor(neutral, 3000);
        await sleep(250);
      }
    } finally {
      clearInterval(collect);
    }
    const spoofScore = scores.length ? scores.reduce((p, c) => p + c, 0) / scores.length : 0;
    setChallenge({ text: 'Checking', note: '' });
    try {
      const r = await api.stepup({ sk, method: 'action', action: action.id, passed, spoofScore, frame: passed ? vision.captureJpeg() : undefined });
      setTrail((t) => [...t, passed ? 'Action completed' : 'Action not completed']);
      if (r.decision === 'VERIFY') return startLiveness(sk);
      finish(r.decision, r.reasons, 'Random action');
    } catch {
      finish('DENY', ['SERVICE_ERROR'], 'Random action');
    }
  };

  // Random gaze check. A dot appears at a random side after a random short pause, and the eyes must
  // move to it. Then the dot either jumps to the other side or stays put (also random), and the eyes
  // must follow or hold. The second step starts the moment the first is detected, so a recorded video
  // would need the right two moves with the right timing. A photo cannot respond at all.
  const gazeCheck = async () => {
    const first: 'L' | 'R' = Math.random() < 0.5 ? 'L' : 'R';
    const second: 'JUMP' | 'HOLD' = Math.random() < 0.5 ? 'JUMP' : 'HOLD';
    const t0 = performance.now();
    let lastT = 0;
    const next = async (): Promise<number | null> => {
      const a = vision.latest;
      if (a?.box && a.t !== lastT) {
        lastT = a.t;
        return a.gaze;
      }
      await sleep(20);
      return null;
    };
    const result = (passed: boolean, stage: string, delta: number) => {
      setDot(null);
      return { passed, pattern: `${first}-${second}`, side: first, stage, delta: Math.round(delta * 1000) / 1000, ms: Math.round(performance.now() - t0) };
    };
    // quiet period of random length: where the eyes rest before the dot shows
    const quiet = 130 + Math.random() * 200;
    const base: number[] = [];
    while (performance.now() - t0 < quiet) {
      const g = await next();
      if (g !== null) base.push(g);
    }
    const recent = base.slice(-3);
    const b = recent.length ? recent.reduce((p, c) => p + c, 0) / recent.length : 0.5;
    // the camera image is not mirrored: looking to your own left moves the irises towards the image right
    const sign = first === 'L' ? 1 : -1;

    setDot(first);
    let tDot = performance.now(), hits = 0, wrong = 0, best = 0, ok = false;
    while (performance.now() - tDot < 900) {
      const g = await next();
      if (g === null) continue;
      const d = (g - b) * sign;
      if (d > best) best = d;
      hits = d > GAZE_DELTA ? hits + 1 : 0;
      wrong = d < -GAZE_DELTA ? wrong + 1 : 0;
      if (wrong >= 3) break;
      if (hits >= 2) {
        // faster than any human reaction means the movement was already under way: a replay
        ok = performance.now() - tDot > 110;
        break;
      }
    }
    if (!ok) return result(false, 'first', best);

    if (second === 'JUMP') {
      setDot(first === 'L' ? 'R' : 'L');
      tDot = performance.now();
      hits = 0;
      let best2 = 0;
      ok = false;
      while (performance.now() - tDot < 850) {
        const g = await next();
        if (g === null) continue;
        const d = (g - b) * -sign;
        if (d > best2) best2 = d;
        hits = d > GAZE_DELTA ? hits + 1 : 0;
        if (hits >= 2) {
          ok = performance.now() - tDot > 110;
          break;
        }
      }
      return result(ok, 'jump', Math.min(best, best2));
    }
    // HOLD: the dot stays, so the eyes must stay on it
    tDot = performance.now();
    let n = 0, on = 0;
    while (performance.now() - tDot < 430) {
      const g = await next();
      if (g === null) continue;
      n++;
      if ((g - b) * sign > GAZE_DELTA * 0.5) on++;
    }
    return result(n >= 3 && on / n >= 0.8, 'hold', best);
  };

  // Offline: the kiosk decides alone, and only ever more strictly than the central service would.
  const askPin = () =>
    new Promise<string | null>((resolve) => {
      setPin('');
      setPhase('pin');
      pinWait.current = resolve;
      setTimeout(() => {
        if (pinWait.current === resolve) {
          pinWait.current = null;
          resolve(null);
        }
      }, 30000);
    });
  const submitPin = (v: string | null) => {
    const f = pinWait.current;
    pinWait.current = null;
    f?.(v);
  };

  const runOffline = async (t0: number) => {
    const b = offline.bundle();
    const local = clock || istNow();
    const th = b?.thresholds || {};
    const info: any = { door, local, bundle: b ? `${b.zoneName}, version ${b.version}, valid until ${b.expiresAt.slice(11, 16)}` : 'none' };
    const record = (decision: 'ALLOW' | 'DENY', reasons: string[], extra: any = {}) => {
      offline.log({ localTime: local, badgeId, zone: door, zoneName: b?.zoneName || door, decision, reasons, schedule: extra.letter || '',
        spoofScore: extra.spoof ?? 0, gazePassed: !!extra.gaze, light: '', pin: extra.pin || '', bundleVersion: b?.version || '',
        test: testOn ? { presentation, identity } : undefined });
      setOfflineInfo({ ...info, ...extra, decision, reasons, totalMs: performance.now() - t0 });
      finish(decision, reasons, 'Offline kiosk');
    };
    setPhase('checking');
    if (!badgeId) return record('DENY', ['OFFLINE_BADGE_NEEDED']);
    if (!b || b.zone !== door) return record('DENY', ['OFFLINE_NO_BUNDLE']);
    // live-person checks, all on the device
    let w = vision.window(800);
    while (w.frames < 3 && performance.now() - t0 < 700) {
      await sleep(50);
      w = vision.window(800);
    }
    if (!vision.latest?.box || !w.frames) {
      setMessage(GUIDE.NO_FACE);
      setPhase('idle');
      return;
    }
    const gaze = await gazeCheck();
    const ev = { spoof: Math.round(w.mean * 100) / 100, gaze: gaze.passed };
    if (vision.virtualCamera) return record('DENY', ['VIRTUAL_CAMERA'], ev);
    const signs: string[] = [];
    if (w.mean <= (th.tLow ?? 0.35)) signs.push('SPOOF_MODEL');
    if (!gaze.passed) signs.push('NO_GAZE_RESPONSE');
    if (signs.length >= 2) return record('DENY', ['OFFLINE_SPOOF', ...signs], ev);
    if (signs.length || w.mean < (th.tHigh ?? 0.8)) return record('DENY', ['OFFLINE_NOT_LIVE', ...signs], ev);
    // cached schedule for this badge, door and time
    if (!b.users[badgeId]) return record('DENY', ['OFFLINE_NO_ACCESS'], ev);
    const letter = offline.scheduleLetter(b, badgeId, local);
    if (letter === 'D') return record('DENY', ['OFFLINE_SCHEDULE_DENY'], { ...ev, letter });
    if (letter === 'S') return record('DENY', ['OFFLINE_STEPUP_UNAVAILABLE'], { ...ev, letter });
    if (offline.fails(badgeId) >= (th.offlinePinTries ?? 3)) return record('DENY', ['OFFLINE_LOCKED'], { ...ev, letter });
    // fallback verification: the person's PIN, because offline there is no face match
    const entered = await askPin();
    setPhase('checking');
    if (entered === null) return record('DENY', ['STEPUP_ABANDONED'], { ...ev, letter, pin: 'none' });
    if (!(await offline.pinOk(b, badgeId, entered))) {
      offline.addFail(badgeId);
      return record('DENY', ['OFFLINE_PIN_WRONG'], { ...ev, letter, pin: 'wrong' });
    }
    return record('ALLOW', ['OFFLINE_ALLOW'], { ...ev, letter, pin: 'ok' });
  };

  const runCheck = useCallback(async () => {
    if (busy.current || status !== 'ready') return;
    busy.current = true;
    try {
      const t0 = performance.now();
      setFinal(null);
      setPassive(null);
      setTrail([]);
      setChallenge(null);
      setLive(null);
      setMessage('');
      setOfflineInfo(null);
      setPhase('checking');
      if (offline.isOffline()) return await runOffline(t0);
      // The spoof model runs continuously, so scores for the last moments are already there.
      let w = vision.window(800);
      while (w.frames < 3 && performance.now() - t0 < 700) {
        await sleep(50);
        w = vision.window(800);
      }
      const a = vision.latest;
      if (!a || !a.box || w.frames === 0) {
        setMessage(GUIDE.NO_FACE);
        setPhase('idle');
        return;
      }
      const frame = vision.captureJpeg();
      const ev = vision.evidence(12);
      const captureMs = performance.now() - t0;
      const gazeP = gazeCheck();
      const res = await api.verify({
        badgeId: badgeId || null,
        zone: zone || null,
        clock: clock || null,
        frame,
        client: { spoofScore: w.mean, spoofMin: w.min, frames: w.frames, qualityFlags: a.flags, virtualCamera: vision.virtualCamera, captureMs, padMs: a.padMs, blinkSeen: ev.blinkSeen, trackedMs: ev.trackedMs },
        test: testOn ? { presentation, identity } : null,
      });
      const gaze = await gazeP;
      const totalMs = performance.now() - t0;
      if (res.decision === 'ALLOW' && !gaze.passed) {
        // no eye movement towards the random dot: a photo or a replay. Ask for more proof.
        await api.timing(res.sk, totalMs, gaze).catch(() => {});
        res.decision = 'VERIFY';
        res.reasons = ['NO_GAZE_RESPONSE'];
      } else {
        api.timing(res.sk, totalMs, gaze).catch(() => {});
      }
      setPassive({ ...res, totalMs, captureMs, spoofMean: w.mean, spoofMin: w.min, frames: w.frames, ev, gaze });
      if (res.decision !== 'VERIFY') return finish(res.decision, res.reasons, 'Passive check');
      const onlyQuality = res.reasons.every((r: string) => QUALITY_CODES.has(r));
      setFinal({ decision: 'VERIFY', reasons: res.reasons, via: 'Passive check' });
      setPhase('result');
      if (!onlyQuality) {
        await sleep(900);
        // exam entry and high-security doors go straight to the strongest check
        if (res.stepup === 'liveness') await startLiveness(res.sk);
        else await runAction(res.sk);
      }
    } catch (e: any) {
      // the central service went away mid-check: decide offline (strictly) instead of failing
      if (offline.markDown(e)) {
        setTrail((t) => [...t, 'Connection lost: switched to offline mode']);
        await runOffline(performance.now());
        return;
      }
      // fail secure: an error never grants access
      setMessage(`Check could not run: ${e.message}`);
      finish('VERIFY', ['SERVICE_ERROR'], 'Passive check');
    } finally {
      busy.current = false;
    }
  }, [status, badgeId, zone, clock, testOn, presentation, identity, offline.online, offline.forced]);

  const retake = async () => {
    if (passive?.sk) await api.stepup({ sk: passive.sk, method: 'retake' }).catch(() => {});
    runCheck();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (phase === 'idle' || (phase === 'result' && final?.decision !== 'VERIFY')) runCheck();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, final, runCheck]);

  const hint = status === 'loading' ? 'Starting camera and models' : status === 'error' ? vision.error || 'Camera error' : message || (analysis?.flags.length ? GUIDE[analysis.flags[0]] : 'Ready. Press Start check');
  const who = users.find((u) => u.badgeId === (passive?.matchedBadge || badgeId));
  const quality = final?.decision === 'VERIFY' && (final.reasons.includes('SERVICE_ERROR') || final.reasons.every((r) => QUALITY_CODES.has(r)));
  const t = passive?.timing;
  const acc = passive?.access;
  // the schedule reason is shown only to someone already proven live and matched
  const scheduleDeny = final?.decision === 'DENY' && acc?.decision === 'DENY' && passive?.bioDecision === 'ALLOW';
  const network = passive ? Math.max(0, passive.totalMs - passive.captureMs - t.server) : 0;

  return (
    <div className="kiosk">
      {dot && <div className={`gazedot ${dot}`} />}
      <section className="stage">
        <div className="controls">
          <label>
            Badge
            <select value={badgeId} onChange={(e) => setBadgeId(e.target.value)} disabled={phase !== 'idle' && phase !== 'result'}>
              <option value="">Face only (search everyone)</option>
              {users.map((u) => (
                <option key={u.badgeId} value={u.badgeId}>
                  {u.badgeId} · {u.name}
                </option>
              ))}
            </select>
          </label>
          <div className={`net ${offline.isOffline() ? 'off' : 'on'}`}>
            <b>{offline.isOffline() ? 'OFFLINE' : 'ONLINE'}</b>
            <small>
              {offline.isOffline() ? (offline.forced ? 'simulated' : offline.lastError || 'no connection') : 'central service'} · cache {offline.bundle() ? `ok to ${offline.bundle()!.expiresAt.slice(11, 16)}` : 'none'} · {offline.queue().length} to sync
            </small>
            <label className="check">
              <input type="checkbox" checked={offline.forced} onChange={(e) => offline.setForced(e.target.checked)} /> Simulate offline
            </label>
          </div>
          <label>
            Door
            <select value={zone} onChange={(e) => setZone(e.target.value)}>
              <option value="">No door (biometric only)</option>
              {Object.entries(sched?.zones || {}).map(([k, z]: any) => (
                <option key={k} value={k}>{z.name}</option>
              ))}
            </select>
          </label>
          {zone && (
            <label>
              Clock {clock ? '(demo time)' : '(live)'}
              <input type="datetime-local" value={clock} onChange={(e) => setClock(e.target.value)} />
            </label>
          )}
          {zone && clock && <button onClick={() => setClock('')}>Use live time</button>}
          <label className="check">
            <input type="checkbox" checked={testOn} onChange={(e) => setTestOn(e.target.checked)} /> Test mode
          </label>
          {testOn && (
            <>
              <label>
                Presenting
                <select value={presentation} onChange={(e) => setPresentation(e.target.value)}>
                  {PRESENTATIONS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Badge is
                <select value={identity} onChange={(e) => setIdentity(e.target.value)}>
                  <option value="self">Their own</option>
                  <option value="impostor">Someone else's</option>
                </select>
              </label>
            </>
          )}
        </div>

        <div className={`camera ${final ? final.decision.toLowerCase() : ''}`}>
          <video ref={videoRef} playsInline muted style={{ visibility: phase === 'liveness' ? 'hidden' : 'visible' }} />
          {phase !== 'liveness' && <div className={`oval ${analysis?.box && !analysis.flags.length ? 'good' : ''}`} />}
          {phase === 'liveness' && live && (
            <div className="liveness">
              <Suspense fallback={<div className="banner">Loading Face Liveness</div>}>
                <LivenessCheck
                  sessionId={live.sessionId}
                  region={live.region}
                  credentials={live.credentials}
                  onDone={() => livenessDone()}
                  onCancel={async () => {
                    await api.stepup({ sk: live.sk, method: 'abandon' }).catch(() => {});
                    finish('DENY', ['STEPUP_ABANDONED'], 'Face Liveness');
                  }}
                  onError={async (e: any) => {
                    console.error('Face Liveness error', e);
                    await livenessDone(String(e?.state || e?.error?.message || e?.message || e));
                  }}
                />
              </Suspense>
            </div>
          )}
          {phase === 'idle' && <div className="banner">{hint}</div>}
          {phase === 'checking' && <div className="banner big">Follow the dot with your eyes</div>}
          {phase === 'pin' && (
            <div className="verdict verify">
              <h1>Enter your PIN</h1>
              <p>Offline mode: your PIN is needed instead of the face match</p>
              <input
                className="pin"
                type="password"
                inputMode="numeric"
                autoFocus
                maxLength={8}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && submitPin(pin)}
              />
              <div className="actions">
                <button className="primary" onClick={() => submitPin(pin)}>Confirm</button>
                <button onClick={() => submitPin(null)}>Cancel</button>
              </div>
            </div>
          )}
          {phase === 'action' && challenge && (
            <div className="banner big">
              {challenge.text}
              {challenge.note && <small>{challenge.note}</small>}
            </div>
          )}
          {phase === 'result' && final && (
            <div className={`verdict ${final.decision.toLowerCase()}`}>
              {final.decision === 'ALLOW' && (
                <>
                  <h1>Allow</h1>
                  {final.via === 'Offline kiosk' && <p className="sub">Offline mode · provisional, confirmed when the kiosk reconnects</p>}
                  <p>Welcome{who ? `, ${who.name}` : ''}</p>
                  {acc && <p className="sub">{acc.zoneName} · {acc.detail}</p>}
                </>
              )}
              {final.decision === 'DENY' && (
                <>
                  <h1>Deny</h1>
                  {final.via === 'Offline kiosk' && <p className="sub">Offline mode · if you need to get in, call security on ext. 100</p>}
                  {scheduleDeny ? (
                    <>
                      <p>{acc.detail}</p>
                      {acc.next && <p className="sub">Next: {acc.next}</p>}
                    </>
                  ) : (
                    <p>Access not granted. Please see the security desk.</p>
                  )}
                </>
              )}
              {final.decision === 'VERIFY' && (
                <>
                  <h1>Request verification</h1>
                  <p>{quality ? final.reasons.map((r) => GUIDE[r]).filter(Boolean)[0] || 'Please retake' : acc?.decision === 'STEP_UP' && passive?.bioDecision === 'ALLOW' ? acc.detail : 'One more quick check'}</p>
                </>
              )}
              {passive && <div className="time">Decision time {(passive.totalMs / 1000).toFixed(2)} s</div>}
            </div>
          )}
        </div>

        <div className="actions">
          {(phase === 'idle' || (phase === 'result' && final?.decision !== 'VERIFY')) && (
            <button className="primary" onClick={runCheck} disabled={status !== 'ready'}>
              {phase === 'result' ? 'Next check' : 'Start check'}
            </button>
          )}
          {phase === 'result' && quality && (
            <button className="primary" onClick={retake}>
              Retake
            </button>
          )}
          {phase === 'result' && (
            <button onClick={reset}>Clear</button>
          )}
          <span className="muted">Space or Enter also starts a check</span>
        </div>
      </section>

      <aside className="panel">
        <h3>Operator view</h3>
        {syncMsg && <p className="ok">{syncMsg}</p>}
        {offlineInfo && (
          <>
            <div className={`chip ${offlineInfo.decision.toLowerCase()}`}>Offline decision: {offlineInfo.decision}</div>
            <ul className="reasons">
              {offlineInfo.reasons.map((r: string, i: number) => (
                <li key={i}>
                  <code>{r}</code> {REASONS[r] || ''}
                </li>
              ))}
            </ul>
            <table className="kv">
              <tbody>
                <tr><td>Door and time</td><td>{offlineInfo.door} · {offlineInfo.local}</td></tr>
                <tr><td>Cached schedule</td><td>{offlineInfo.bundle}</td></tr>
                <tr><td>Schedule slot</td><td>{({ A: 'allow', S: 'step-up (not possible offline)', D: 'deny' } as any)[offlineInfo.letter] || 'not reached'}</td></tr>
                <tr><td>Spoof model</td><td>{offlineInfo.spoof ?? 'n/a'}</td></tr>
                <tr><td>Gaze check</td><td>{offlineInfo.gaze === undefined ? 'n/a' : offlineInfo.gaze ? 'followed the dot' : 'no response'}</td></tr>
                <tr><td>PIN</td><td>{offlineInfo.pin || 'not asked'}</td></tr>
                <tr><td>Time</td><td>{(offlineInfo.totalMs / 1000).toFixed(2)} s</td></tr>
              </tbody>
            </table>
            <p className="muted">Stored on this kiosk until synced: badge, door, time, decision, reason codes and scores. No images, no PIN.</p>
          </>
        )}
        {!passive && !offlineInfo && <p className="muted">Details of the last check appear here. The person at the kiosk never sees them.</p>}
        {testOn && analysis && (
          <div className="livebox">
            <div>Live spoof score: {analysis.spoof === null ? 'n/a' : analysis.spoof.toFixed(2)}</div>
            <div>Gaze {analysis.gaze.toFixed(3)} · blink {analysis.blink.toFixed(2)} · mouth {analysis.jaw.toFixed(2)} · smile {analysis.smile.toFixed(2)}</div>
            <div>Face size {(analysis.faceFrac * 100).toFixed(0)}% · brightness {analysis.brightness.toFixed(0)} · turn {analysis.turn.toFixed(2)}</div>
            <div>Model time {analysis.padMs.toFixed(0)} ms per frame</div>
          </div>
        )}
        {passive && (
          <>
            <div className={`chip ${passive.decision.toLowerCase()}`}>Passive: {passive.decision}</div>
            {final && final.via !== 'Passive check' && <div className={`chip ${final.decision.toLowerCase()}`}>Final: {final.decision} ({final.via})</div>}
            <h4>Reason codes</h4>
            <ul className="reasons">
              {[...passive.reasons, ...(final && final.via !== 'Passive check' ? final.reasons : [])].map((r: string, i: number) => (
                <li key={i}>
                  <code>{r}</code> {REASONS[r] || ''}
                </li>
              ))}
            </ul>
            {acc && (
              <>
                <h4>Access schedule</h4>
                <table className="kv">
                  <tbody>
                    <tr><td>Biometric result</td><td>{passive.bioDecision}</td></tr>
                    <tr><td>Schedule result</td><td><b>{acc.decision.replace('_', ' ')}</b> · <code>{acc.reasons.join(', ')}</code></td></tr>
                    <tr><td>Person</td><td>{passive.person ? `${passive.person.name} · ${sched?.roles[passive.person.role] || passive.person.role}` : 'unknown'}</td></tr>
                    <tr><td>Door and time</td><td>{acc.zoneName} · {acc.localTime} {acc.clock === 'demo' ? '(demo clock)' : ''}</td></tr>
                    <tr><td>Why</td><td>{acc.detail}{acc.next ? ` Next: ${acc.next}.` : ''}</td></tr>
                  </tbody>
                </table>
              </>
            )}
            <h4>Signals</h4>
            <table className="kv">
              <tbody>
                <tr><td>Vision check (AWS)</td><td>{passive.vision.verdict}{passive.vision.verdict !== 'unavailable' ? ` ${passive.vision.confidence.toFixed(2)}` : ''} {passive.vision.cue ? `· ${passive.vision.cue}` : ''}</td></tr>
                <tr><td>Gaze check</td><td>{passive.gaze.passed ? 'eyes followed the dot' : 'no response'} · pattern {passive.gaze.pattern} · stopped at {passive.gaze.stage} · moved {passive.gaze.delta} · {passive.gaze.ms} ms</td></tr>
                <tr><td>Natural blink</td><td>{passive.ev.blinkSeen ? 'seen' : 'not seen'} (information only)</td></tr>
                <tr><td>Spoof score (0 to 1)</td><td>{passive.spoofMean.toFixed(2)} avg, {passive.spoofMin.toFixed(2)} min, {passive.frames} frames</td></tr>
                <tr><td>Face match (0 to 100)</td><td>{passive.similarity} {passive.matchedBadge ? `to ${passive.matchedBadge}` : ''}</td></tr>
                <tr><td>Scene labels</td><td>{passive.scene.labels.length ? passive.scene.labels.map((l: any) => `${l.name} ${l.confidence}`).join(', ') : 'none'}</td></tr>
                <tr><td>Faces seen</td><td>{passive.scene.faceCount ?? 'n/a'} at the kiosk, {passive.scene.backgroundFaces ?? 0} in the background (ignored)</td></tr>
                <tr><td>Camera</td><td>{vision.cameraLabel || 'unknown'}{vision.virtualCamera ? ' (virtual)' : ''}</td></tr>
              </tbody>
            </table>
            <h4>Decision time: {(passive.totalMs / 1000).toFixed(2)} s {passive.totalMs <= 2000 ? '(within 2 s)' : '(over 2 s)'}</h4>
            <div className="bars">
              <Bar label="On device" ms={passive.captureMs} total={passive.totalMs} />
              <Bar label="Network" ms={network} total={passive.totalMs} />
              <Bar label="AWS checks" ms={t.server} total={passive.totalMs} />
            </div>
            <p className="muted">AWS calls run in parallel: face search {t.search} ms, scene labels {t.labels} ms, face attributes {t.faces} ms, vision check {t.vision} ms.</p>
            {trail.length > 0 && (
              <>
                <h4>Step-up</h4>
                <ol className="trail">
                  {trail.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

function Bar({ label, ms, total }: { label: string; ms: number; total: number }) {
  return (
    <div className="bar">
      <span>{label}</span>
      <div>
        <i style={{ width: `${Math.min(100, (ms / Math.max(total, 1)) * 100)}%` }} />
      </div>
      <b>{Math.round(ms)} ms</b>
    </div>
  );
}
