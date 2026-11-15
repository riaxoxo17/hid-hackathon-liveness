import { useEffect, useState } from 'react';
import { api, REASONS } from '../lib/api';

const FIELDS: [string, string][] = [
  ['tHigh', 'Spoof score needed to count as live (0 to 1)'],
  ['tLow', 'Spoof score at or below this is denied (0 to 1)'],
  ['idAllow', 'Face match needed for Allow (0 to 100)'],
  ['idVerify', 'Face match below this is denied (0 to 100)'],
  ['stepupIdMin', 'Face match needed after a step-up'],
  ['livenessPass', 'AWS Face Liveness confidence needed'],
  ['labelConf', 'Confidence for phone / screen / paper labels'],
  ['visionConf', 'Vision check confidence needed (0 to 1)'],
  ['blinkWindowSec', 'Natural blink must be this recent (seconds)'],
  ['lockoutFails', 'Failed attempts before lockout'],
  ['lockoutWindowSec', 'Lockout window (seconds)'],
];

export default function Operator() {
  const [attempts, setAttempts] = useState<any[]>([]);
  const [cfg, setCfg] = useState<any>(null);
  const [explain, setExplain] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState('');
  const [sched, setSched] = useState<any>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [schedMsg, setSchedMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const lock = async (zone: string, on: boolean) => {
    if (on && !confirm('Lock down this door? Everyone except security is denied from the next check.')) return;
    api.lockdown(zone, on).then(setSched).catch((e) => setSchedMsg({ ok: false, text: e.message }));
  };
  const saveSchedule = async () => {
    try {
      const s = await api.setSchedule(JSON.parse(edit || '{}'));
      setSched(s);
      setEdit(null);
      setSchedMsg({ ok: true, text: 'Schedule saved. Applies to the next check.' });
    } catch (e: any) {
      setSchedMsg({ ok: false, text: e.message.includes('JSON') ? 'That is not valid JSON.' : e.message });
    }
  };

  // skip malformed records instead of crashing the whole tab
  const load = () => api.attempts().then((r) => setAttempts((r.attempts || []).filter((a: any) => a && typeof a.decision === 'string'))).catch(() => {});
  useEffect(() => {
    load();
    api.config().then(setCfg).catch(() => {});
    api.schedule().then(setSched).catch(() => {});
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const doExplain = async (a: any) => {
    setExplain((e) => ({ ...e, [a.sk]: 'Asking Claude' }));
    const r = await api.explain(a).catch((e) => ({ explanation: e.message }));
    setExplain((e) => ({ ...e, [a.sk]: r.explanation }));
  };

  const save = async () => {
    const c = await api.setConfig(cfg).catch((e) => alert(e.message));
    if (c) {
      setCfg(c);
      setSaved('Saved. Applies to the next check.');
      setTimeout(() => setSaved(''), 3000);
    }
  };

  const fails: Record<string, number> = {};
  const cutoff = Date.now() - (cfg?.lockoutWindowSec ?? 300) * 1000;
  attempts.filter((a) => a.at > cutoff && a.badgeId && !a.testLabel && a.finalDecision === 'DENY').forEach((a) => (fails[a.badgeId] = (fails[a.badgeId] || 0) + 1));
  const locked = Object.entries(fails).filter(([, n]) => n >= (cfg?.lockoutFails ?? 3));

  return (
    <div className="page">
      <div className="cols">
        <section>
          <h3>Audit log</h3>
          <p className="muted">Every check is logged with scores, reason codes and timings. No face images are stored anywhere.</p>
          {locked.length > 0 && <p className="err">Locked out: {locked.map(([b, n]) => `${b} (${n} failures)`).join(', ')}</p>}
          <table className="grid">
            <thead>
              <tr>
                <th>Time</th><th>Badge</th><th>Door</th><th>Passive</th><th>Final</th><th>Reasons</th><th>Spoof</th><th>Vision</th><th>Gaze</th><th>Match</th><th>Time</th><th>Test label</th><th></th>
              </tr>
            </thead>
            <tbody>
              {attempts.slice(0, 150).map((a) => (
                <>
                  <tr key={a.sk}>
                    <td>{new Date(a.at).toLocaleTimeString()}</td>
                    <td title={a.conflict ? `Flagged at sync: ${a.conflict.join(', ')}` : ''}>
                      {a.badgeId || a.matchedBadge || 'face only'}
                      {a.source === 'OFFLINE' && <span className="chip verify">offline</span>}
                      {a.conflict && <span className="chip deny">review: {a.conflict.join(', ')}</span>}
                    </td>
                    <td title={a.access?.detail}>{a.access ? `${a.access.zoneName}: ${a.access.decision.replace('_', ' ')}` : ''}</td>
                    <td><span className={`chip ${String(a.decision).toLowerCase()}`}>{a.decision}</span></td>
                    <td><span className={`chip ${String(a.finalDecision).toLowerCase()}`}>{a.finalDecision}</span></td>
                    <td title={[...(a.reasons || []), ...(a.finalReasons || [])].map((r: string) => REASONS[r] || r).join('; ')}>
                      {[...(a.reasons || []), ...(a.finalReasons || [])].join(', ')}
                    </td>
                    <td>{Number(a.spoofScore).toFixed(2)}</td>
                    <td title={a.vision?.cue}>{a.vision ? `${a.vision.verdict} ${Number(a.vision.confidence).toFixed(2)}` : ''}</td>
                    <td>{a.gaze ? `${a.gaze.passed ? 'yes' : 'no'} ${a.gaze.pattern || a.gaze.side} ${a.gaze.delta}` : ''}</td>
                    <td>{Number(a.similarity).toFixed(0)}</td>
                    <td>{a.totalMs ? `${(a.totalMs / 1000).toFixed(2)} s` : `${a.timing?.server} ms`}</td>
                    <td>{a.test ? `${a.test.presentation} / ${a.test.identity}` : ''}</td>
                    <td><button className="link" onClick={() => doExplain(a)}>Explain</button></td>
                  </tr>
                  {explain[a.sk] && (
                    <tr key={a.sk + 'x'} className="explain">
                      <td colSpan={13}>{explain[a.sk]}</td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </section>
        <aside className="panel">
          <h3>Campus schedule</h3>
          {sched && (
            <>
              <table className="kv">
                <tbody>
                  {Object.entries(sched.zones).map(([k, z]: any) => (
                    <tr key={k}>
                      <td>{z.name}</td>
                      <td>
                        {z.kind === 'open' && `${z.roles.map((r: string) => sched.roles[r]).join(', ')} · ${z.from} to ${z.to}`}
                        {z.kind === 'scheduled' && `Students by timetable only · faculty and staff ${z.from} to ${z.to}`}
                        {z.kind === 'residents' && `Residents only · step-up during curfew ${z.curfewFrom} to ${z.curfewTo}`}
                        {z.kind === 'secure' && 'Cleared staff only · always the strongest check'}
                        {z.lockdown && <span className="chip deny" style={{ marginLeft: 6 }}>LOCKDOWN</span>}
                      </td>
                      <td>
                        <button className="link" onClick={() => lock(k, !z.lockdown)}>{z.lockdown ? 'Reopen' : 'Lock down'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4>Timetable</h4>
              <table className="kv">
                <tbody>
                  {sched.sessions.map((s: any, i: number) => (
                    <tr key={i}>
                      <td>{s.course} {s.kind}</td>
                      <td>{sched.zones[s.zone]?.name} · {s.days.map((d: number) => sched.days[d]).join(', ')} {s.from} to {s.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">
                A class admits from {sched.classEarlyMin} minutes before it starts. An exam admits from {sched.examEarlyMin} minutes before until {sched.examLateMin} minutes after it starts, and always needs AWS Face Liveness. Open areas give a step-up, not a deny, within {sched.graceMin} minutes of opening hours. Holidays: {sched.holidays.length ? sched.holidays.join(', ') : 'none'}.
              </p>
              <button onClick={() => setEdit(edit === null ? JSON.stringify({ graceMin: sched.graceMin, holidays: sched.holidays, courses: sched.courses, zones: sched.zones, sessions: sched.sessions }, null, 2) : null)}>
                {edit === null ? 'Edit schedule' : 'Close editor'}
              </button>
              {edit !== null && (
                <>
                  <textarea className="json" value={edit} onChange={(e) => setEdit(e.target.value)} spellCheck={false} />
                  <button className="primary" onClick={saveSchedule}>Save schedule</button>
                  <p className="muted">Days are numbers: 0 is Monday, 6 is Sunday. The schedule is checked before it is saved; a mistake is rejected with the reason.</p>
                </>
              )}
              {schedMsg && <p className={schedMsg.ok ? 'ok' : 'err'}>{schedMsg.text}</p>}
            </>
          )}
          <h3 style={{ marginTop: 18 }}>Thresholds</h3>
          {cfg &&
            FIELDS.map(([k, label]) => (
              <label className="field" key={k}>
                {label}
                <input type="number" step="any" value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} />
              </label>
            ))}
          <button className="primary" onClick={save}>Save thresholds</button>
          {saved && <p className="ok">{saved}</p>}
          <h4>Data</h4>
          <button onClick={async () => { if (confirm('Delete all test-mode attempts?')) { await api.clearAttempts(true); load(); } }}>Clear test attempts</button>{' '}
          <button onClick={async () => { if (confirm('Delete the whole audit log?')) { await api.clearAttempts(false); load(); } }}>Clear all attempts</button>
        </aside>
      </div>
    </div>
  );
}
