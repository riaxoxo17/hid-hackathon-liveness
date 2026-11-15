"""Offline mode: what a kiosk may decide on its own when it cannot reach this service.

Design rules
  - The kiosk never opens on a face alone. Offline it needs: the badge, a live person (on-device
    spoof model, gaze and light checks), the cached schedule saying ALLOW, and the person's PIN.
  - The kiosk holds the minimum: one door's schedule as a string of ALLOW / STEP_UP / DENY letters per
    15-minute slot for the next few hours, the names of people who may pass that door, and salted PIN
    hashes. No face templates, no photos, no full timetable. It all expires after `hours`.
  - Anything the schedule would only allow with a step-up (exam entry, server room, grace period,
    curfew) is denied offline: the strong checks need the central service.
  - Every offline decision is logged without images and synced when the connection returns. The
    server re-checks each offline ALLOW against the current records and flags conflicts.
"""
import hashlib
import hmac
import os
import uuid
from datetime import datetime, timedelta

import schedule

PIN_ITER = 60000
SLOT_MIN = 15
LETTER = {"ALLOW": "A", "STEP_UP": "S", "DENY": "D"}
RANK = {"A": 0, "S": 1, "D": 2}


# ---------- PIN ----------

def hash_pin(pin, salt_hex=None):
    """PBKDF2-SHA256, the same function the kiosk can run with WebCrypto."""
    pin = str(pin or "").strip()
    if not (pin.isdigit() and 4 <= len(pin) <= 8):
        raise ValueError("PIN must be 4 to 8 digits")
    salt = bytes.fromhex(salt_hex) if salt_hex else os.urandom(16)
    h = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, PIN_ITER)
    return {"pinSalt": salt.hex(), "pinHash": h.hex(), "pinIter": PIN_ITER}


def check_pin(pin, rec):
    try:
        return hmac.compare_digest(hash_pin(pin, rec["pinSalt"])["pinHash"], rec["pinHash"])
    except Exception:  # noqa
        return False


# ---------- bundle ----------

def slots_for(user, zone_id, start, n, sch):
    """One letter per slot. A slot takes the stricter of the decisions at its start and end, so the
    kiosk never allows a moment the full schedule would not."""
    at = [LETTER[schedule.evaluate(user, zone_id, start + timedelta(minutes=SLOT_MIN * i), sch)["decision"]]
          for i in range(n + 1)]
    return "".join(max(at[i], at[i + 1], key=RANK.get) for i in range(n))


def build_bundle(users, zone_id, sch, cfg, now, hours=8):
    zone = sch["zones"].get(zone_id)
    if not zone:
        raise ValueError("Unknown door")
    start = now.replace(minute=(now.minute // SLOT_MIN) * SLOT_MIN, second=0, microsecond=0)
    n = int(hours * 60 / SLOT_MIN)
    people = {}
    for u in users:
        if not u.get("pinHash"):
            continue  # no PIN, no offline access
        slots = slots_for(u, zone_id, start, n, sch)
        if "A" not in slots:
            continue  # minimum information: only people this door could let in offline
        people[u["sk"]] = {"name": str(u.get("name", ""))[:40], "slots": slots,
                           "pinSalt": u["pinSalt"], "pinHash": u["pinHash"], "pinIter": int(u.get("pinIter", PIN_ITER))}
    keys = ("tHigh", "tLow", "gazeDelta", "gazeReactMs", "lightChallenge", "lightAmpPass", "lightZPass",
            "lightAmpFail", "offlinePinTries")
    return {
        "version": uuid.uuid4().hex[:12],
        "zone": zone_id, "zoneName": zone["name"], "kind": zone["kind"],
        "issuedAt": now.isoformat(), "start": start.strftime("%Y-%m-%dT%H:%M"),
        "expiresAt": (now + timedelta(hours=hours)).isoformat(), "hours": hours, "slotMin": SLOT_MIN,
        "users": people,
        "thresholds": {k: cfg[k] for k in keys if k in cfg},
    }


# ---------- sync ----------

def recheck(rec, user, sch):
    """Would the central service have agreed with this offline ALLOW? Returns a list of problems."""
    if rec.get("decision") != "ALLOW":
        return []
    if not user:
        return ["UNKNOWN_BADGE"]
    issues = []
    if user.get("status") == "suspended":
        issues.append("SUSPENDED_NOW")
    try:
        when = datetime.fromisoformat(str(rec.get("localTime"))[:16]).replace(tzinfo=schedule.IST)
    except ValueError:
        when = datetime.fromtimestamp(int(rec.get("at", 0)) / 1000, schedule.IST)
    acc = schedule.evaluate(user, rec.get("zone"), when, sch)
    if acc["decision"] != "ALLOW":
        issues.append("SCHEDULE_" + acc["reasons"][0])
    return issues
