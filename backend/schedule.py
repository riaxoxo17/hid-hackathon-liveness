"""Campus access schedule.

A live, recognised person is not automatically authorised. This module answers a separate question:
may this person go through this door at this time? It returns ALLOW, STEP_UP or DENY with reason
codes, and the kiosk combines that with the biometric result. The stricter answer always wins.

Rules, in order:
  1. No access record, not yet valid, or expired       -> DENY   (grants always expire)
  2. Door in lockdown                                  -> DENY, security staff excepted
  3. Suspended                                         -> DENY, except a resident at their own hostel,
                                                          who gets STEP_UP and a flag for the warden
  4. Residents-only door (hostel)                      -> residents only; STEP_UP during curfew hours
  5. High-security door (server room)                  -> cleared staff only, always STEP_UP
  6. Scheduled room (lab, auditorium)                  -> students only during a class or exam on
                                                          their own course list; exam entry is STEP_UP
  7. Open area (gate, library)                         -> permitted roles during opening hours;
                                                          STEP_UP within the grace period either side

The schedule is data: operators can edit it, and every edit is validated before it is saved.
A holiday is treated like a Sunday, and no classes or exams run on it.
"""
import copy
import json
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
KINDS = ("open", "scheduled", "residents", "secure")

DEFAULT_SCHEDULE = {
    "graceMin": 15,       # open areas: this close to opening or closing time gets a step-up, not a deny
    "classEarlyMin": 10,  # a class admits from this many minutes before it starts, until it ends
    "examEarlyMin": 30,   # an exam admits from this many minutes before it starts ...
    "examLateMin": 30,    # ... until this many minutes after it starts (late-entry cut-off)
    "holidays": [],       # dates (YYYY-MM-DD) treated like a Sunday, with no classes or exams
    "roles": {
        "student": "Student",
        "faculty": "Faculty",
        "staff": "Staff",
        "security": "Security",
        "visitor": "Visitor",
        "contractor": "Contractor",
    },
    "expiringRoles": ["visitor", "contractor"],  # these must be enrolled with an end date
    "courses": {
        "CS301": "Operating Systems Lab",
        "CS302": "Database Systems Lab",
        "HACK26": "HID Build Beyond Hackathon",
    },
    "zones": {
        "main_gate": {"name": "Main gate", "kind": "open", "lockdown": False,
                      "roles": ["student", "faculty", "staff", "visitor", "contractor"],
                      "days": ALL_DAYS, "from": "06:00", "to": "22:00"},
        "library": {"name": "Library", "kind": "open", "lockdown": False,
                    "roles": ["student", "faculty", "staff"],
                    "days": [0, 1, 2, 3, 4, 5], "from": "08:00", "to": "21:00"},
        "cs_lab": {"name": "CS Lab 2", "kind": "scheduled", "lockdown": False,
                   "staffRoles": ["faculty", "staff"],
                   "days": [0, 1, 2, 3, 4, 5], "from": "07:00", "to": "20:00"},
        "auditorium": {"name": "MRD Auditorium", "kind": "scheduled", "lockdown": False,
                       "staffRoles": ["faculty", "staff"],
                       "days": ALL_DAYS, "from": "07:00", "to": "21:00"},
        "hostel_a": {"name": "Hostel Block A", "kind": "residents", "lockdown": False,
                     "curfewFrom": "23:00", "curfewTo": "05:00"},
        "server_room": {"name": "Server room", "kind": "secure", "lockdown": False,
                        "roles": ["staff"]},
    },
    "sessions": [
        {"zone": "cs_lab", "course": "CS301", "kind": "class", "days": [0, 2], "from": "09:00", "to": "11:00"},
        {"zone": "cs_lab", "course": "CS302", "kind": "class", "days": [1, 3], "from": "14:00", "to": "16:00"},
        {"zone": "cs_lab", "course": "CS301", "kind": "exam", "days": [4], "from": "10:00", "to": "12:00"},
        {"zone": "cs_lab", "course": "CS302", "kind": "exam", "days": [5], "from": "15:00", "to": "17:00"},
        {"zone": "auditorium", "course": "HACK26", "kind": "class", "days": [5], "from": "08:00", "to": "20:00"},
    ],
}

# reason codes that mean "the schedule said no", as opposed to a failed biometric check
DENY_CODES = {"ZONE_LOCKDOWN", "ACCESS_EXPIRED", "ACCESS_NOT_YET_VALID", "SUSPENDED", "NOT_A_RESIDENT",
              "ZONE_NOT_PERMITTED", "EXAM_ENTRY_CLOSED", "NOT_ON_ROSTER", "NOT_SCHEDULED_NOW", "OUTSIDE_HOURS",
              "NO_ACCESS_RECORD", "UNKNOWN_DOOR", "SCHEDULE_UNAVAILABLE"}


# ---------- loading and validation ----------

def merged(stored):
    """Default schedule with the operator's saved changes on top."""
    s = copy.deepcopy(DEFAULT_SCHEDULE)
    if stored:
        s.update(json.loads(stored) if isinstance(stored, str) else stored)
    return s


def _mins(hhmm):
    h, m = str(hhmm).strip().split(":")
    v = int(h) * 60 + int(m)
    if not 0 <= v <= 1440:
        raise ValueError(f"bad time {hhmm}")
    return v


def _days_ok(days):
    return isinstance(days, list) and days and all(isinstance(d, int) and 0 <= d <= 6 for d in days)


def validate(sch):
    """Raises ValueError with a readable message if the schedule cannot be used."""
    for key in ("roles", "courses", "zones", "sessions"):
        if key not in sch:
            raise ValueError(f"Schedule needs '{key}'")
    for zid, z in sch["zones"].items():
        if z.get("kind") not in KINDS:
            raise ValueError(f"Door {zid}: kind must be one of {', '.join(KINDS)}")
        if not z.get("name"):
            raise ValueError(f"Door {zid} needs a name")
        try:
            if z["kind"] in ("open", "scheduled"):
                if _mins(z["from"]) >= _mins(z["to"]):
                    raise ValueError("opening time must be before closing time")
                if not _days_ok(z.get("days")):
                    raise ValueError("days must be a list of numbers 0 (Mon) to 6 (Sun)")
            if z["kind"] == "residents":
                _mins(z["curfewFrom"]), _mins(z["curfewTo"])
        except (KeyError, ValueError) as e:
            raise ValueError(f"Door {zid}: {e}")
        for r in list(z.get("roles", [])) + list(z.get("staffRoles", [])):
            if r not in sch["roles"]:
                raise ValueError(f"Door {zid} refers to unknown role {r}")
    for i, s in enumerate(sch["sessions"]):
        where = f"Timetable row {i + 1}"
        if s.get("zone") not in sch["zones"] or sch["zones"][s["zone"]]["kind"] != "scheduled":
            raise ValueError(f"{where}: door must be a scheduled room")
        if s.get("course") not in sch["courses"]:
            raise ValueError(f"{where}: unknown course {s.get('course')}")
        if s.get("kind") not in ("class", "exam"):
            raise ValueError(f"{where}: kind must be class or exam")
        if not _days_ok(s.get("days")):
            raise ValueError(f"{where}: days must be a list of numbers 0 (Mon) to 6 (Sun)")
        try:
            if _mins(s["from"]) >= _mins(s["to"]):
                raise ValueError("start must be before end")
        except (KeyError, ValueError) as e:
            raise ValueError(f"{where}: {e}")
    for d in sch.get("holidays", []):
        try:
            datetime.strptime(str(d), "%Y-%m-%d")
        except ValueError:
            raise ValueError(f"Holiday '{d}' must be a date like 2026-11-14")
    for k in ("graceMin", "classEarlyMin", "examEarlyMin", "examLateMin"):
        if not 0 <= int(sch.get(k, 0)) <= 180:
            raise ValueError(f"{k} must be between 0 and 180 minutes")
    return True


# ---------- time ----------

def now_ist(simulated=None):
    """Kiosk time in IST. `simulated` ('YYYY-MM-DDTHH:MM') is the demo clock."""
    if simulated:
        try:
            return datetime.fromisoformat(str(simulated)[:16]).replace(tzinfo=IST)
        except ValueError:
            pass
    return datetime.now(IST)


def _fmt(day, mins):
    return f"{DAYS[day % 7]} {mins // 60:02d}:{mins % 60:02d}"


def _is_holiday(sch, when):
    return when.strftime("%Y-%m-%d") in sch.get("holidays", [])


def _window(sch, s):
    """Entry window of a session, in minutes of the day."""
    start, end = _mins(s["from"]), _mins(s["to"])
    if s["kind"] == "exam":
        return start - int(sch["examEarlyMin"]), start + int(sch["examLateMin"])
    return start - int(sch["classEarlyMin"]), end


def _label(sch, s):
    return f"{s['course']} {sch['courses'].get(s['course'], '')} {s['kind']}".replace("  ", " ")


def _next_session(sch, zone_id, courses, when):
    day, minute = when.weekday(), when.hour * 60 + when.minute
    for offset in range(0, 8):
        date = when + timedelta(days=offset)
        if _is_holiday(sch, date):
            continue
        d = (day + offset) % 7
        best = None
        for s in sch["sessions"]:
            if s["zone"] != zone_id or s["course"] not in courses or d not in s["days"]:
                continue
            opens, _ = _window(sch, s)
            if offset == 0 and opens <= minute:
                continue
            if best is None or opens < best[0]:
                best = (opens, f"{_label(sch, s)}, doors open {_fmt(d, opens)}")
        if best:
            return best[1]
    return None


def _next_opening(sch, zone, when):
    day, minute, start = when.weekday(), when.hour * 60 + when.minute, _mins(zone["from"])
    for offset in range(0, 8):
        date = when + timedelta(days=offset)
        d = 6 if _is_holiday(sch, date) else (day + offset) % 7
        if d in zone["days"] and (offset > 0 or minute < start):
            return f"opens {_fmt((day + offset) % 7, start)}"
    return None


def _hours(zone, day, minute, slack=0):
    return day in zone.get("days", ALL_DAYS) and _mins(zone["from"]) - slack <= minute < _mins(zone["to"]) + slack


def _in_curfew(zone, minute):
    a, b = _mins(zone["curfewFrom"]), _mins(zone["curfewTo"])
    return (minute >= a or minute < b) if a > b else a <= minute < b


# ---------- the check ----------

def evaluate(user, zone_id, when, sch=None):
    """Returns {decision, reasons, detail, next, strong}. `strong` asks for the strongest step-up."""
    sch = sch or DEFAULT_SCHEDULE
    zone = sch["zones"].get(zone_id)
    roles = sch["roles"]
    out = {"zone": zone_id, "zoneName": zone["name"] if zone else zone_id, "decision": "DENY", "reasons": [],
           "detail": "", "next": None, "strong": False, "localTime": when.strftime("%a %d %b %H:%M")}

    def done(decision, reason, detail, nxt=None, strong=False):
        out.update(decision=decision, reasons=[reason], detail=detail, next=nxt, strong=strong)
        return out

    if not zone:
        return done("DENY", "UNKNOWN_DOOR", "This door is not in the access schedule.")
    if not user:
        return done("DENY", "NO_ACCESS_RECORD", "No access record for this person.")

    role = user.get("role") or "student"
    role_name = roles.get(role, role)
    courses = list(user.get("courses") or [])
    out["role"] = role
    holiday = _is_holiday(sch, when)
    day = 6 if holiday else when.weekday()
    minute = when.hour * 60 + when.minute
    today = when.strftime("%Y-%m-%d")

    if user.get("validFrom") and today < str(user["validFrom"]):
        return done("DENY", "ACCESS_NOT_YET_VALID", f"Access starts on {user['validFrom']}.")
    if user.get("validUntil") and today > str(user["validUntil"]):
        return done("DENY", "ACCESS_EXPIRED", f"Access expired on {user['validUntil']}.")

    if zone.get("lockdown") and role != "security":
        return done("DENY", "ZONE_LOCKDOWN", f"{zone['name']} is in lockdown.")

    if user.get("status") == "suspended":
        if zone["kind"] == "residents" and user.get("resident"):
            return done("STEP_UP", "SUSPENDED_WELFARE_ACCESS",
                        "Suspended, but hostel entry continues until the warden decides. Warden notified.")
        return done("DENY", "SUSPENDED", "Access is suspended.")

    if zone["kind"] == "residents":
        if role == "security":
            return done("ALLOW", "SECURITY_PATROL", "Security staff.")
        if not user.get("resident"):
            return done("DENY", "NOT_A_RESIDENT", f"Not a resident of {zone['name']}.")
        if _in_curfew(zone, minute):
            return done("STEP_UP", "CURFEW_HOURS",
                        f"Resident entering during curfew hours ({zone['curfewFrom']} to {zone['curfewTo']}).")
        return done("ALLOW", "RESIDENT", f"Resident of {zone['name']}.")

    if zone["kind"] == "secure":
        if (role in zone.get("roles", []) or role == "security") and user.get("clearance"):
            return done("STEP_UP", "HIGH_SECURITY_ZONE",
                        "Cleared staff. This door always needs the strongest check.", strong=True)
        return done("DENY", "ZONE_NOT_PERMITTED", f"No clearance for the {zone['name']}.")

    if role == "security":
        return done("ALLOW", "SECURITY_PATROL", "Security staff.")

    if zone["kind"] == "scheduled":
        if role in zone.get("staffRoles", []):
            if _hours(zone, day, minute):
                return done("ALLOW", "STAFF_HOURS", f"{role_name} access during building hours.")
            return done("STEP_UP", "OFF_HOURS",
                        f"{role_name} access outside building hours ({zone['from']} to {zone['to']}).")
        running_other = None
        for s in ([] if holiday else sch["sessions"]):
            if s["zone"] != zone_id or day not in s["days"]:
                continue
            opens, closes = _window(sch, s)
            start, end = _mins(s["from"]), _mins(s["to"])
            if s["course"] in courses:
                if opens <= minute < closes:
                    if s["kind"] == "exam":
                        return done("STEP_UP", "EXAM_ENTRY",
                                    f"On the roster for the {_label(sch, s)} ({s['from']} to {s['to']}). "
                                    "Exam entry needs the strongest check.", strong=True)
                    return done("ALLOW", "ON_SCHEDULE", f"{_label(sch, s)}, {s['from']} to {s['to']}.")
                if s["kind"] == "exam" and closes <= minute < end:
                    return done("DENY", "EXAM_ENTRY_CLOSED",
                                f"Entry for the {_label(sch, s)} closed at {_fmt(day, closes)[4:]}.")
            elif start <= minute < end:
                running_other = s
        nxt = _next_session(sch, zone_id, courses, when)
        if running_other:
            return done("DENY", "NOT_ON_ROSTER",
                        f"{_label(sch, running_other)} is in progress and this person is not on its roster.", nxt)
        why = "Today is a holiday, so nothing is scheduled." if holiday else f"Nothing scheduled for this person in {zone['name']} now."
        return done("DENY", "NOT_SCHEDULED_NOW", why, nxt)

    # open area
    if role not in zone.get("roles", []):
        return done("DENY", "ZONE_NOT_PERMITTED", f"{role_name} access is not permitted at the {zone['name']}.")
    if _hours(zone, day, minute):
        return done("ALLOW", "WITHIN_HOURS", f"{zone['name']} is open ({zone['from']} to {zone['to']}).")
    if role in ("faculty", "staff"):
        return done("STEP_UP", "OFF_HOURS",
                    f"{role_name} access outside opening hours ({zone['from']} to {zone['to']}).")
    grace = int(sch.get("graceMin", 0))
    if grace and _hours(zone, day, minute, grace):
        return done("STEP_UP", "SCHEDULE_GRACE",
                    f"Within {grace} minutes of {zone['name']} opening hours ({zone['from']} to {zone['to']}).")
    why = f"{zone['name']} is closed today." if day not in zone["days"] else f"{zone['name']} is closed now ({zone['from']} to {zone['to']})."
    return done("DENY", "OUTSIDE_HOURS", why, _next_opening(sch, zone, when))


def combine(bio_decision, bio_reasons, access):
    """The stricter of the biometric result and the schedule result wins.

                       schedule ALLOW   schedule STEP_UP   schedule DENY
      biometric ALLOW  ALLOW            VERIFY             DENY
      biometric VERIFY VERIFY           VERIFY             DENY
      biometric DENY   DENY             DENY               DENY   (the schedule is never revealed)
    """
    if access is None or bio_decision == "DENY":
        return bio_decision, bio_reasons
    if access["decision"] == "DENY":
        return "DENY", access["reasons"]
    if access["decision"] == "STEP_UP":
        base = [] if bio_decision == "ALLOW" else list(bio_reasons)
        return "VERIFY", base + access["reasons"]
    return bio_decision, bio_reasons


def is_schedule_deny(decision, reasons):
    return decision == "DENY" and bool(reasons) and all(r in DENY_CODES for r in reasons)
