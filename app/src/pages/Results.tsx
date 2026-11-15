import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const ROWS: [string, string, (a: any) => boolean][] = [
  ['Genuine person, own badge', 'allow', (a) => a.test.presentation === 'genuine' && a.test.identity === 'self'],
  ['Genuine person, wrong badge', 'block', (a) => a.test.presentation === 'genuine' && a.test.identity === 'impostor'],
  ['Printed photo', 'block', (a) => a.test.presentation === 'print'],
  ['Phone photo (screen replay)', 'block', (a) => a.test.presentation === 'screen_photo'],
  ['Video replay', 'block', (a) => a.test.presentation === 'video'],
  ['Mask', 'block', (a) => a.test.presentation === 'mask'],
];

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export default function Results() {
  const [all, setAll] = useState<any[]>([]);
  const load = () => api.attempts().then((r) => setAll((r.attempts || []).filter((a: any) => a && typeof a.decision === 'string'))).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const retakes = all.filter((a) => a.test && a.finalDecision === 'RETAKE').length;
  // biometric metrics only: checks made at a door are also subject to the schedule, so they are left out
  const tests = all.filter((a) => a.test && !a.access && a.finalDecision !== 'RETAKE');
  const allowed = (a: any) => a.finalDecision === 'ALLOW';
  const genuine = tests.filter(ROWS[0][2]);
  const impostor = tests.filter(ROWS[1][2]);
  const attacks = tests.filter((a) => a.test.presentation !== 'genuine');
  const liveSet = [...genuine, ...attacks];
  const liveOk = genuine.filter(allowed).length + attacks.filter((a) => !allowed(a)).length;
  const idSet = [...genuine, ...impostor];
  const idOk = genuine.filter(allowed).length + impostor.filter((a) => !allowed(a)).length;
  const shouldBlock = [...attacks, ...impostor];
  const far = shouldBlock.filter(allowed).length;
  const frr = genuine.filter((a) => !allowed(a)).length;
  const times = tests.map((a) => a.totalMs).filter(Boolean);
  const within = times.filter((t) => t <= 2000).length;
  const stepups = tests.filter((a) => a.decision === 'VERIFY').length;

  return (
    <div className="page">
      <div className="headrow">
        <h3>Performance evaluation</h3>
        <button onClick={load}>Refresh</button>
      </div>
      <p className="muted">
        Measured on this kiosk from {tests.length} labelled test attempts. Turn on Test mode on the Kiosk tab, label each attempt, and the numbers update here.
      </p>
      <div className="tiles">
        <Tile big={pct(liveOk, liveSet.length)} label="liveness detection accuracy" sub={`${liveOk} of ${liveSet.length} genuine and spoof attempts`} />
        <Tile big={pct(idOk, idSet.length)} label="face authentication accuracy" sub={`${idOk} of ${idSet.length} own-badge and wrong-badge attempts`} />
        <Tile big={pct(far, shouldBlock.length)} label="false acceptance rate (FAR)" sub={`${far} of ${shouldBlock.length} spoofs and wrong badges allowed`} />
        <Tile big={pct(frr, genuine.length)} label="false rejection rate (FRR)" sub={`${frr} of ${genuine.length} genuine users not allowed`} />
        <Tile big={times.length ? `${(quantile(times, 0.5) / 1000).toFixed(2)} s` : 'n/a'} label="decision time (typical)" sub={times.length ? `95% within ${(quantile(times, 0.95) / 1000).toFixed(2)} s · ${pct(within, times.length)} under 2 s` : 'no timings yet'} />
      </div>

      <h4>By scenario</h4>
      <table className="grid">
        <thead>
          <tr>
            <th>Scenario</th><th>Attempts</th><th>Allowed</th><th>Denied</th><th>Left at verification</th><th>Needed step-up</th><th>Error rate</th><th>95% upper bound</th><th>Typical time</th><th>Slowest 5%</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([label, want, f]) => {
            const xs = tests.filter(f);
            const n = xs.length;
            const al = xs.filter(allowed).length;
            const de = xs.filter((a) => a.finalDecision === 'DENY').length;
            const ve = n - al - de;
            const errors = want === 'allow' ? n - al : al;
            const ts = xs.map((a) => a.totalMs).filter(Boolean);
            // exact one-sided bound for zero errors (rule of three), normal approximation otherwise
            const p = n ? errors / n : 0;
            const upper = !n ? 'n/a' : errors === 0 ? `${Math.min(100, (300 / n)).toFixed(0)}%` : `${Math.min(100, 100 * (p + 1.96 * Math.sqrt((p * (1 - p)) / n))).toFixed(0)}%`;
            return (
              <tr key={label}>
                <td>{label}</td>
                <td>{n}</td>
                <td>{al}</td>
                <td>{de}</td>
                <td>{ve}</td>
                <td>{xs.filter((a) => a.decision === 'VERIFY').length}</td>
                <td>{want === 'allow' ? 'rejected ' : 'accepted '}{pct(errors, n)}</td>
                <td>{upper}</td>
                <td>{ts.length ? `${(quantile(ts, 0.5) / 1000).toFixed(2)} s` : 'n/a'}</td>
                <td>{ts.length ? `${(quantile(ts, 0.95) / 1000).toFixed(2)} s` : 'n/a'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul className="notes">
        <li>Decision time is measured in the browser, from pressing Start check to the decision appearing. It covers the passive check; step-up checks take longer by design.</li>
        <li>{stepups} of {tests.length} test attempts needed a step-up. {retakes} retakes for lighting or position are excluded from the rates.</li>
        <li>An attempt counts as allowed only if the final outcome was Allow. A spoof left at "request verification" was not let in.</li>
        <li>The upper bound shows how high the true error rate could be given the sample size. With 0 errors in 30 attempts it is 10%.</li>
        <li>Only checks made with "No door" selected are counted here, so a schedule denial is never mistaken for a biometric rejection.</li>
        <li>Evaluated using ISO/IEC 30107-3 style metrics on a standard webcam. Not a certified test.</li>
      </ul>
    </div>
  );
}

function Tile({ big, label, sub }: { big: string; label: string; sub: string }) {
  return (
    <div className="tile">
      <b>{big}</b>
      <span>{label}</span>
      <small>{sub}</small>
    </div>
  );
}
