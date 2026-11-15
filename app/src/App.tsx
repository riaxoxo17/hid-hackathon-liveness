import { useEffect, useState } from 'react';
import Kiosk from './pages/Kiosk';
import Enroll from './pages/Enroll';
import Operator from './pages/Operator';
import Results from './pages/Results';
import { api } from './lib/api';
import { lazy, Suspense } from 'react';

const LivenessCheck = lazy(() => import('./pages/LivenessCheck'));

function LivenessTest() {
  const [s, setS] = useState<any>(null);
  const [out, setOut] = useState('starting');
  useEffect(() => {
    api.livenessSession().then(setS).catch((e) => setOut('session error ' + e.message));
  }, []);
  return (
    <div style={{ background: '#fff', color: '#111', minHeight: '100vh', padding: 20 }}>
      <p id="liveness-status">{out}</p>
      {s && (
        <Suspense fallback={<p>loading</p>}>
          <LivenessCheck sessionId={s.sessionId} region={s.region} credentials={s.credentials} onDone={async () => setOut('analysis complete')} onCancel={() => setOut('cancelled')} onError={(e: any) => { console.error('LIVENESS_ERROR', e?.state, e?.error?.message || e?.error || e); setOut('error ' + (e?.state || '') + ' ' + (e?.error?.message || '')); }} />
        </Suspense>
      )}
    </div>
  );
}


const TABS = ['Kiosk', 'Enrol', 'Operator', 'Results'] as const;

export default function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Kiosk');
  useEffect(() => {
    // keep the backend warm so the first check is not slowed by a cold start
    api.health().catch(() => {});
    const id = setInterval(() => api.health().catch(() => {}), 120000);
    return () => clearInterval(id);
  }, []);
  if (new URLSearchParams(location.search).has('liveness')) return <LivenessTest />;
  return (
    <div className="shell">
      <header>
        <div className="brand">
          <span className="logo">HID</span> Liveness Kiosk
        </div>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {tab === 'Kiosk' && <Kiosk />}
        {tab === 'Enrol' && <Enroll />}
        {tab === 'Operator' && <Operator />}
        {tab === 'Results' && <Results />}
      </main>
    </div>
  );
}
