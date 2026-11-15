// Network errors and timeouts are marked so the kiosk can tell "service unreachable" (go offline)
// from "service answered with an error".
export class NetworkError extends Error {}

async function call(path: string, body?: any, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e: any) {
    throw new NetworkError(e?.name === 'AbortError' ? 'Service did not answer in time' : 'Service unreachable');
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 502) throw new NetworkError(`Service unavailable (HTTP ${res.status})`);
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export const api = {
  health: () => call('health', undefined, 2500),
  bundle: (zone: string, clock?: string | null) => call('kiosk/bundle', { zone, clock: clock || null }),
  offlineSync: (kioskId: string, records: any[]) => call('offline/sync', { kioskId, records }, 15000),
  config: () => call('config'),
  setConfig: (c: any) => call('config', c),
  users: () => call('users'),
  schedule: () => call('schedule'),
  updateUser: (b: any) => call('users/update', b),
  setSchedule: (b: any) => call('schedule', b),
  lockdown: (zone: string, on: boolean) => call('schedule/lockdown', { zone, on }),
  enroll: (b: any) => call('enroll', b),
  deleteUser: (badgeId: string) => call('users/delete', { badgeId }),
  verify: (b: any) => call('verify', b),
  timing: (sk: string, totalMs: number, gaze?: any) => call('verify/timing', { sk, totalMs, gaze }),
  stepup: (b: any) => call('stepup', b),
  livenessSession: () => call('liveness/session', {}),
  attempts: () => call('attempts'),
  clearAttempts: (onlyTest: boolean) => call('attempts/clear', { onlyTest }),
  explain: (attempt: any) => call('explain', { attempt }),
};

// Operator-facing meaning of each reason code.
export const REASONS: Record<string, string> = {
  LIVE_AND_MATCHED: 'Live person, identity matched',
  SPOOF_SCORE_LOW: 'Spoof model: not a live face',
  SPOOF_MODEL: 'On-device spoof model: not a live face',
  VISION_SPOOF: 'Vision check: looks like a screen, print or mask',
  VISION_UNSURE: 'Vision check: not confident it is a live person',
  NO_BLINK_SEEN: 'No natural blink seen yet',
  NO_GAZE_RESPONSE: 'Eyes did not follow the random dot',
  // offline mode (decided by the kiosk from its cached schedule)
  OFFLINE_ALLOW: 'Offline: live, PIN correct, cached schedule allows (provisional until synced)',
  OFFLINE_NO_BUNDLE: 'Offline: no valid cached schedule for this door',
  OFFLINE_BADGE_NEEDED: 'Offline: badge required (no face search offline)',
  OFFLINE_NO_ACCESS: 'Offline: not on the cached list for this door',
  OFFLINE_SCHEDULE_DENY: 'Offline: cached schedule says no for this time',
  OFFLINE_STEPUP_UNAVAILABLE: 'Offline: this entry needs a strong check that only works online',
  OFFLINE_NOT_LIVE: 'Offline: live-person checks failed',
  OFFLINE_SPOOF: 'Offline: two or more spoof signs',
  OFFLINE_PIN_WRONG: 'Offline: wrong PIN',
  OFFLINE_LOCKED: 'Offline: too many wrong PINs, locked until the kiosk reconnects',
  OFFLINE_CACHE: 'Decided from the kiosk cache',
  SPOOF_SCORE_UNSURE: 'Spoof model: not confident',
  SCREEN_AROUND_FACE: 'A phone or screen frames the face',
  PRINT_AROUND_FACE: 'A printed sheet frames the face',
  SCREEN_IN_SCENE: 'Phone or screen seen in the picture',
  PAPER_IN_SCENE: 'Paper or photo seen in the picture',
  VIRTUAL_CAMERA: 'Virtual camera software detected',
  IDENTITY_MISMATCH: 'Face belongs to a different badge',
  IDENTITY_LOW: 'Face does not match the badge',
  IDENTITY_UNSURE: 'Face match is borderline',
  NOT_ENROLLED: 'Face is not enrolled',
  FACE_NOT_CLEAR: 'No clear face in the picture',
  MULTIPLE_FACES: 'More than one face',
  FACE_COVERED: 'Face is partly covered',
  SUNGLASSES: 'Sunglasses',
  LOW_LIGHT: 'Lighting too dark',
  TOO_BRIGHT: 'Lighting too bright',
  TOO_FAR: 'Too far from the camera',
  TOO_CLOSE: 'Too close to the camera',
  FACE_NOT_ALIGNED: 'Not facing the camera',
  NOT_CENTRED: 'Face not centred',
  NO_FACE: 'No face',
  LOCKED_OUT: 'Too many failed attempts on this badge',
  SERVICE_ERROR: 'A check failed to run (fail secure)',
  ACTION_PASSED: 'Random action completed, identity matched',
  ACTION_NOT_COMPLETED: 'Random action not completed',
  STILL_UNSURE: 'Still not confident after the action',
  SPOOF_AFTER_ACTION: 'Spoof signs during the action',
  LIVENESS_PASSED: 'AWS Face Liveness passed, identity matched',
  LIVENESS_FAILED: 'AWS Face Liveness failed',
  LIVENESS_ERROR: 'AWS Face Liveness did not complete',
  STEPUP_ABANDONED: 'Verification not completed',
  RETAKE: 'Retake requested',
  ON_SCHEDULE: 'On the timetable for this room now',
  WITHIN_HOURS: 'Permitted role, within opening hours',
  STAFF_HOURS: 'Faculty or staff, within building hours',
  RESIDENT: 'Resident of this hostel',
  SECURITY_PATROL: 'Security staff',
  EXAM_ENTRY: 'Exam entry: strongest check required',
  HIGH_SECURITY_ZONE: 'High-security door: strongest check required',
  OFF_HOURS: 'Permitted role, but outside normal hours',
  CURFEW_HOURS: 'Resident entering during curfew hours',
  SUSPENDED_WELFARE_ACCESS: 'Suspended, hostel entry kept; warden notified',
  SUSPENDED: 'Access is suspended',
  ZONE_LOCKDOWN: 'Door is in lockdown',
  SCHEDULE_GRACE: 'Just outside opening hours (grace period)',
  ACCESS_NOT_YET_VALID: 'Access has not started yet',
  ACCESS_EXPIRED: 'Access has expired',
  NOT_SCHEDULED_NOW: 'Nothing scheduled for this person here now',
  NOT_ON_ROSTER: 'Not on the roster of the session in progress',
  EXAM_ENTRY_CLOSED: 'Exam late-entry window has closed',
  OUTSIDE_HOURS: 'Outside opening hours',
  ZONE_NOT_PERMITTED: 'Role is not permitted at this door',
  NOT_A_RESIDENT: 'Not a resident of this hostel',
  NO_ACCESS_RECORD: 'No access record',
  UNKNOWN_DOOR: 'Door is not in the schedule',
  SCHEDULE_UNAVAILABLE: 'Schedule could not be read (fail secure)',
};

// What the person at the kiosk is told. Deliberately generic for denials.
export const GUIDE: Record<string, string> = {
  LOW_LIGHT: 'Move to better light',
  TOO_BRIGHT: 'Too bright. Turn away from the light',
  TOO_FAR: 'Move closer',
  TOO_CLOSE: 'Move back a little',
  FACE_NOT_ALIGNED: 'Look straight at the camera',
  NOT_CENTRED: 'Centre your face in the frame',
  NO_FACE: 'Step in front of the camera',
  MULTIPLE_FACES: 'One person at a time',
  FACE_COVERED: 'Uncover your face',
  SUNGLASSES: 'Remove your sunglasses',
  FACE_NOT_CLEAR: 'Hold still and face the camera',
};

export const QUALITY_CODES = new Set(Object.keys(GUIDE));
