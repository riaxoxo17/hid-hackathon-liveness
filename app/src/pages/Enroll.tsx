import { useEffect, useRef, useState } from 'react';
import { api, GUIDE } from '../lib/api';
import { useVision } from '../lib/useVision';
import { sleep, vision } from '../lib/vision';

const EMPTY = { badgeId: '', name: '', role: 'student', courses: [] as string[], resident: false, clearance: false, validFrom: '', validUntil: '', host: '', pin: '' };

export default function Enroll() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { status, analysis } = useVision(videoRef);
  const [users, setUsers] = useState<any[]>([]);
  const [sched, setSched] = useState<any>(null);
  const [f, setF] = useState({ ...EMPTY });
  const [editing, setEditing] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api.users().then((r) => setUsers(r.users)).catch(() => {});
  useEffect(() => {
    load();
    api.schedule().then(setSched).catch(() => {});
  }, []);

  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const toggleCourse = (c: string) => set('courses', f.courses.includes(c) ? f.courses.filter((x) => x !== c) : [...f.courses, c]);
  const clear = () => {
    setF({ ...EMPTY });
    setEditing(null);
    setConsent(false);
  };

  const expiring = (sched?.expiringRoles || ['visitor', 'contractor']).includes(f.role);
  const profile = () => ({ name: f.name.trim(), role: f.role, courses: f.role === 'student' ? f.courses : [], resident: f.resident, clearance: f.role === 'staff' && f.clearance, validFrom: f.validFrom, validUntil: f.validUntil, host: expiring ? f.host.trim() : '', ...(f.pin ? { pin: f.pin } : {}) });

  const enrol = async () => {
    setMsg(null);
    if (!f.badgeId.trim()) return setMsg({ ok: false, text: 'Enter a badge ID' });
    if (expiring && !f.validUntil) return setMsg({ ok: false, text: 'This role needs an access end date' });
    if (f.pin && !/^\d{4,8}$/.test(f.pin)) return setMsg({ ok: false, text: 'PIN must be 4 to 8 digits' });
    if (!consent) return setMsg({ ok: false, text: 'Tick the consent box first' });
    const a = vision.latest;
    if (!a?.box) return setMsg({ ok: false, text: GUIDE.NO_FACE });
    if (a.flags.length) return setMsg({ ok: false, text: GUIDE[a.flags[0]] || 'Adjust your position' });
    setBusy(true);
    try {
      const images: string[] = [];
      for (let i = 0; i < 3; i++) {
        const j = vision.captureJpeg(640, 0.85);
        if (j) images.push(j);
        await sleep(350);
      }
      const w = vision.window(1500);
      const r = await api.enroll({ badgeId: f.badgeId.trim(), consent, images, spoofScore: w.mean, ...profile() });
      setMsg({ ok: true, text: `Enrolled ${r.badgeId}. ${r.facesStored} face templates stored, no photos kept.` });
      clear();
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setMsg(null);
    try {
      await api.updateUser({ badgeId: editing, ...profile() });
      setMsg({ ok: true, text: `Updated ${editing}. Applies to the next check.` });
      clear();
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };

  const edit = (u: any) => {
    setEditing(u.badgeId);
    setF({ badgeId: u.badgeId, name: u.name, role: u.role, courses: u.courses || [], resident: !!u.resident, clearance: !!u.clearance, validFrom: u.validFrom || '', validUntil: u.validUntil || '', host: u.host || '', pin: '' });
    setMsg(null);
  };

  const suspend = async (u: any) => {
    const to = u.status === 'suspended' ? 'active' : 'suspended';
    if (to === 'suspended' && !confirm(`Suspend ${u.badgeId}? Their access ends on the next check.`)) return;
    await api.updateUser({ badgeId: u.badgeId, status: to }).catch((e) => alert(e.message));
    load();
  };

  const erase = async (id: string) => {
    if (!confirm(`Erase ${id} and all of their face templates?`)) return;
    await api.deleteUser(id).catch((e) => alert(e.message));
    load();
  };

  const hint = status === 'loading' ? 'Starting camera and models' : status === 'error' ? vision.error : analysis?.flags.length ? GUIDE[analysis.flags[0]] : 'Good. Hold still and press Enrol';

  return (
    <div className="kiosk">
      <section className="stage">
        <div className="camera">
          <video ref={videoRef} playsInline muted />
          <div className={`oval ${analysis?.box && !analysis.flags.length ? 'good' : ''}`} />
          <div className="banner">{hint}</div>
        </div>
        <h4>People ({users.length})</h4>
        <table className="grid">
          <thead>
            <tr><th>Badge</th><th>Name</th><th>Role</th><th>Courses</th><th>Flags</th><th>Valid until</th><th>Offline</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.badgeId}>
                <td><b>{u.badgeId}</b></td>
                <td>{u.name}</td>
                <td>{sched?.roles[u.role] || u.role}</td>
                <td>{(u.courses || []).join(', ')}</td>
                <td>{[u.resident && 'hostel resident', u.clearance && 'server room', u.host && `host: ${u.host}`].filter(Boolean).join(', ')}</td>
                <td>{u.validFrom ? `${u.validFrom} to ` : ''}{u.validUntil || 'no end date'}</td>
                <td>{u.hasPin ? 'PIN set' : 'no PIN (no offline access)'}</td>
                <td><span className={`chip ${u.status === 'suspended' ? 'deny' : 'allow'}`}>{u.status}</span></td>
                <td>
                  <button className="link" onClick={() => edit(u)}>Edit</button>{' · '}
                  <button className="link" onClick={() => suspend(u)}>{u.status === 'suspended' ? 'Reinstate' : 'Suspend'}</button>{' · '}
                  <button className="link" onClick={() => erase(u.badgeId)}>Erase</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <aside className="panel">
        <h3>{editing ? `Edit ${editing}` : 'Enrol a person'}</h3>
        <label className="field">
          Badge ID
          <input value={f.badgeId} disabled={!!editing} onChange={(e) => set('badgeId', e.target.value)} placeholder="e.g. PES1001" />
        </label>
        <label className="field">
          Name
          <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Display name" />
        </label>
        <label className="field">
          Role
          <select value={f.role} onChange={(e) => set('role', e.target.value)}>
            {Object.entries(sched?.roles || { student: 'Student' }).map(([k, v]) => (
              <option key={k} value={k}>{v as string}</option>
            ))}
          </select>
        </label>
        {f.role === 'student' && (
          <div className="field">
            Courses (decides which labs and exams they can enter)
            {Object.entries(sched?.courses || {}).map(([k, v]) => (
              <label className="check" key={k}>
                <input type="checkbox" checked={f.courses.includes(k)} onChange={() => toggleCourse(k)} /> {k} · {v as string}
              </label>
            ))}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={f.resident} onChange={(e) => set('resident', e.target.checked)} /> Hostel Block A resident
        </label>
        {f.role === 'staff' && (
          <label className="check">
            <input type="checkbox" checked={f.clearance} onChange={(e) => set('clearance', e.target.checked)} /> Cleared for the server room
          </label>
        )}
        {expiring && (
          <label className="field">
            Host (who they are visiting or working for)
            <input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="e.g. Prof. Rao, CS department" />
          </label>
        )}
        <label className="field">
          Access starts on (optional)
          <input type="date" value={f.validFrom} onChange={(e) => set('validFrom', e.target.value)} />
        </label>
        <label className="field">
          Access ends on {expiring ? '(required for this role)' : '(optional)'}
          <input type="date" value={f.validUntil} onChange={(e) => set('validUntil', e.target.value)} />
        </label>
        <label className="field">
          Offline PIN, 4 to 8 digits {editing ? '(leave empty to keep the current one)' : '(optional; without it, no access while the kiosk is offline)'}
          <input type="password" inputMode="numeric" maxLength={8} value={f.pin} onChange={(e) => set('pin', e.target.value.replace(/\D/g, ''))} placeholder="Stored only as a salted hash" />
        </label>
        {editing ? (
          <>
            <button className="primary" onClick={save}>Save changes</button>{' '}
            <button onClick={clear}>Cancel</button>
          </>
        ) : (
          <>
            <label className="check">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              I consent to my face template being stored for access control. No photo is kept, and I can ask for it to be erased.
            </label>
            <button className="primary" onClick={enrol} disabled={busy || status !== 'ready'}>
              {busy ? 'Enrolling' : 'Enrol'}
            </button>
          </>
        )}
        {msg && <p className={msg.ok ? 'ok' : 'err'}>{msg.text}</p>}
        <p className="muted">A liveness check runs at enrolment, so a photo cannot be enrolled. Access always has an end date for visitors, and suspending a person takes effect on their next check.</p>
      </aside>
    </div>
  );
}
