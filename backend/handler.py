"""HID liveness kiosk backend.

One Lambda behind a Function URL. Routes:
  GET  /api/health
  GET  /api/config            POST /api/config
  GET  /api/users             POST /api/enroll        POST /api/users/delete
  POST /api/verify            POST /api/stepup
  POST /api/liveness/session
  GET  /api/attempts          POST /api/attempts/clear
  POST /api/explain

No face image is ever stored. Rekognition keeps face vectors; DynamoDB keeps
scores, reason codes and timings.
"""
import base64
import copy
import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import boto3

import offline
import schedule
from boto3.dynamodb.conditions import Key
from botocore.config import Config

REGION = os.environ.get("AWS_REGION", "us-east-1")
TABLE = os.environ["TABLE_NAME"]
COLLECTION = os.environ.get("COLLECTION_ID", "hid-kiosk-faces")
STREAM_ROLE_ARN = os.environ.get("STREAM_ROLE_ARN", "")
EXPLAIN_MODEL = os.environ.get("EXPLAIN_MODEL", "us.anthropic.claude-haiku-5-5")
VISION_MODEL = os.environ.get("VISION_MODEL", "us.anthropic.claude-haiku-4-5-20251001-v1:0")

_cfg = Config(retries={"max_attempts": 2, "mode": "standard"}, connect_timeout=2, read_timeout=6)
rek = boto3.client("rekognition", region_name=REGION, config=_cfg)
ddb = boto3.resource("dynamodb", region_name=REGION).Table(TABLE)
sts = boto3.client("sts", region_name=REGION)
bedrock = boto3.client("bedrock-runtime", region_name=REGION, config=Config(read_timeout=15))
# the in-loop vision check has a hard time limit so it can never break the 2 second budget
bedrock_fast = boto3.client("bedrock-runtime", region_name=REGION,
                            config=Config(read_timeout=1.0, connect_timeout=0.5, retries={"max_attempts": 1}))
pool = ThreadPoolExecutor(max_workers=8)

DEFAULT_CONFIG = {
    "tHigh": 0.80,          # spoof score at or above this counts as live
    "tLow": 0.35,           # spoof score at or below this is a spoof
    "idAllow": 92.0,        # face similarity needed for ALLOW
    "idVerify": 80.0,       # between idVerify and idAllow -> step-up
    "stepupIdMin": 88.0,    # similarity needed after a passed step-up
    "livenessPass": 85.0,   # Rekognition Face Liveness confidence needed
    "labelConf": 75.0,      # confidence for phone / screen / paper labels
    "visionConf": 0.7,      # confidence at which the vision check counts as a signal
    "blinkWindowSec": 12,   # a natural blink must have been seen this recently
    "lockoutFails": 3,
    "lockoutWindowSec": 300,
    # offline mode
    "offlineHours": 8,       # how far ahead the kiosk's cached schedule reaches; it expires after this
    "offlinePinTries": 3,    # wrong PINs on one badge before the kiosk locks it until it syncs
}

SCREEN_LABELS = {
    "Mobile Phone", "Phone", "Cell Phone", "Iphone", "Electronics", "Screen", "Monitor",
    "Display", "Computer Monitor", "LCD Screen", "TV", "Television", "Tablet Computer",
    "Laptop", "Computer", "Pc",
}
STRONG_SCREEN_LABELS = {"Mobile Phone", "Phone", "Cell Phone", "Iphone", "Tablet Computer", "Screen", "Monitor", "TV", "Television", "LCD Screen", "Display"}
HANDHELD_LABELS = {"Mobile Phone", "Phone", "Cell Phone", "Iphone", "Tablet Computer"}
PAPER_LABELS = {"Paper", "Photo Frame", "Poster", "Advertisement", "Mask", "Document", "Id Cards", "Photography", "Portrait"}
STRONG_PAPER_LABELS = {"Paper", "Photo Frame", "Poster", "Mask"}

_collection_ready = False
_config_cache = {"at": 0, "value": None}
_schedule_cache = {"at": 0, "value": None}


# ---------- helpers ----------

def _dec(o):
    if isinstance(o, float):
        return Decimal(str(round(o, 4)))
    if isinstance(o, dict):
        return {k: _dec(v) for k, v in o.items() if v is not None}
    if isinstance(o, (list, tuple)):
        return [_dec(v) for v in o]
    return o


def _undec(o):
    if isinstance(o, Decimal):
        return float(o) if o % 1 else int(o)
    if isinstance(o, dict):
        return {k: _undec(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_undec(v) for v in o]
    return o


def _resp(body, status=200):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(body),
    }


def _img(b64):
    if "," in b64[:64]:
        b64 = b64.split(",", 1)[1]
    return base64.b64decode(b64)


def get_config():
    now = time.time()
    if _config_cache["value"] and now - _config_cache["at"] < 15:
        return _config_cache["value"]
    cfg = dict(DEFAULT_CONFIG)
    try:
        item = ddb.get_item(Key={"pk": "CONFIG", "sk": "thresholds"}).get("Item")
        if item:
            for k, v in _undec(item).items():
                if k in cfg:
                    cfg[k] = v
    except Exception as e:  # noqa
        print("config read failed", e)
    _config_cache.update(at=now, value=cfg)
    return cfg


def get_schedule():
    """Campus schedule: defaults plus the operator's saved changes. Cached briefly."""
    now = time.time()
    if _schedule_cache["value"] and now - _schedule_cache["at"] < 15:
        return _schedule_cache["value"]
    item = ddb.get_item(Key={"pk": "CONFIG", "sk": "schedule"}).get("Item")
    value = schedule.merged(item.get("json") if item else None)
    _schedule_cache.update(at=now, value=value)
    return value


def access_check(person, zone, clock):
    """Schedule decision for this person, door and time. Fails secure if the schedule cannot be read."""
    try:
        acc = schedule.evaluate(person, zone, schedule.now_ist(clock), get_schedule())
    except Exception as e:  # noqa
        print("schedule failed", repr(e))
        acc = {"zone": zone, "zoneName": zone, "decision": "DENY", "reasons": ["SCHEDULE_UNAVAILABLE"],
               "detail": "The access schedule could not be read.", "next": None, "strong": False}
    acc["clock"] = "demo" if clock else "live"
    return acc


def schedule_recheck(att):
    """Before a step-up grants access, the schedule is checked again: a lockdown or suspension may have
    started in the meantime. Returns the access result if it now denies, else None."""
    acc = att.get("access")
    if not acc:
        return None
    who = att.get("matchedBadge") or att.get("badgeId")
    person = _undec(ddb.get_item(Key={"pk": "USER", "sk": who}).get("Item") or {}) or None if who else None
    now = access_check(person, acc["zone"], att.get("clock"))
    return now if now["decision"] == "DENY" else None


def ensure_collection():
    global _collection_ready
    if _collection_ready:
        return
    try:
        rek.create_collection(CollectionId=COLLECTION)
    except rek.exceptions.ResourceAlreadyExistsException:
        pass
    _collection_ready = True


def timed(fn, *a, **kw):
    t = time.time()
    try:
        out = fn(*a, **kw)
        return out, None, int((time.time() - t) * 1000)
    except Exception as e:  # noqa
        return None, e, int((time.time() - t) * 1000)


# ---------- Rekognition calls ----------

def search_face(img):
    ensure_collection()
    return rek.search_faces_by_image(
        CollectionId=COLLECTION, Image={"Bytes": img}, MaxFaces=5,
        FaceMatchThreshold=60, QualityFilter="AUTO",
    )


def detect_labels(img):
    return rek.detect_labels(Image={"Bytes": img}, MaxLabels=25, MinConfidence=55)


def detect_faces(img):
    return rek.detect_faces(Image={"Bytes": img}, Attributes=["DEFAULT", "FACE_OCCLUDED", "SUNGLASSES", "EYES_OPEN"])


VISION_PROMPT = (
    "This is one frame from an access-control kiosk camera. Decide whether the main face is a LIVE person "
    "physically present, or a SPOOF: a face shown on a phone, tablet or laptop screen, a printed photo or "
    "paper, or a mask. Spoof cues: device bezel or screen edges, fingers holding a phone or sheet, paper "
    "edges or curl, screen glare or moire or pixel grid, a flat face with its own different background or "
    "lighting, a face much smaller or framed inside a rectangle, eye holes cut in paper. Live cues: natural "
    "3D shading, a body and shoulders continuous with the room, consistent lighting. Other people or laptops "
    "in the background do not matter. Reply with JSON only, no markdown: "
    '{"verdict":"live"|"spoof"|"unsure","confidence":0.0-1.0,"cue":"max 8 words"}'
)


def vision_check(img):
    """Second, independent opinion on live versus spoof from a vision model on Bedrock."""
    res = bedrock_fast.converse(
        modelId=VISION_MODEL,
        messages=[{"role": "user", "content": [{"image": {"format": "jpeg", "source": {"bytes": img}}},
                                               {"text": VISION_PROMPT}]}],
        inferenceConfig={"maxTokens": 50, "temperature": 0},
    )
    text = "".join(c.get("text", "") for c in res["output"]["message"]["content"])
    j = json.loads(text[text.index("{"): text.rindex("}") + 1])
    verdict = str(j.get("verdict", "unsure")).lower()
    if verdict not in ("live", "spoof", "unsure"):
        verdict = "unsure"
    return {"verdict": verdict, "confidence": float(j.get("confidence", 0)), "cue": str(j.get("cue", ""))[:80]}


def vision_result(res, err):
    if err is not None or res is None:
        print("vision check unavailable", repr(err))
        return {"verdict": "unavailable", "confidence": 0.0, "cue": ""}
    return res


def identity_from_search(res, err, badge_id):
    """Returns dict: status (MATCH|WEAK|MISMATCH|NO_MATCH|NO_FACE|ERROR), similarity, matchedBadge."""
    if err is not None:
        name = type(err).__name__
        if "InvalidParameter" in name:
            return {"status": "NO_FACE", "similarity": 0.0, "matchedBadge": None}
        print("search error", repr(err))
        return {"status": "ERROR", "similarity": 0.0, "matchedBadge": None}
    best = {}
    for m in res.get("FaceMatches", []):
        b = m["Face"].get("ExternalImageId")
        if b and m["Similarity"] > best.get(b, 0):
            best[b] = m["Similarity"]
    if not best:
        return {"status": "NO_MATCH", "similarity": 0.0, "matchedBadge": None}
    top_badge = max(best, key=best.get)
    if badge_id:
        sim = best.get(badge_id, 0.0)
        if sim == 0.0:
            return {"status": "MISMATCH", "similarity": best[top_badge], "matchedBadge": top_badge}
        return {"status": "CLAIMED", "similarity": sim, "matchedBadge": badge_id}
    return {"status": "CLAIMED", "similarity": best[top_badge], "matchedBadge": top_badge}


def scene_signals(labels_res, faces_res):
    """Looks for a phone, screen or paper around the face, and for face problems."""
    out = {"labels": [], "screenAroundFace": False, "screenInScene": False, "paperInScene": False,
           "paperAroundFace": False, "faceCount": None, "backgroundFaces": 0, "occluded": False, "sunglasses": False}
    face_box = None
    if faces_res:
        faces = [f for f in faces_res.get("FaceDetails", []) if f.get("Confidence", 0) > 80]
        if faces:
            f = max(faces, key=lambda x: x["BoundingBox"]["Width"] * x["BoundingBox"]["Height"])
            # people further back (smaller faces) are ignored; only someone beside the user counts
            near = [x for x in faces if x["BoundingBox"]["Width"] >= 0.6 * f["BoundingBox"]["Width"]]
            out["faceCount"] = len(near)
            out["backgroundFaces"] = len(faces) - len(near)
        else:
            out["faceCount"] = 0
        if faces:
            face_box = f["BoundingBox"]
            out["occluded"] = bool(f.get("FaceOccluded", {}).get("Value")) and f["FaceOccluded"].get("Confidence", 0) > 85
            out["sunglasses"] = bool(f.get("Sunglasses", {}).get("Value")) and f["Sunglasses"].get("Confidence", 0) > 85
    if labels_res:
        cfg = get_config()
        for lab in labels_res.get("Labels", []):
            name, conf = lab["Name"], lab["Confidence"]
            is_screen, is_paper = name in SCREEN_LABELS, name in PAPER_LABELS
            if not (is_screen or is_paper):
                continue
            out["labels"].append({"name": name, "confidence": round(conf, 1)})
            if conf < cfg["labelConf"]:
                continue
            # room screens (projector, other laptops) are normal; only a hand-held device counts here
            if name in HANDHELD_LABELS or (name in STRONG_SCREEN_LABELS and conf >= 92):
                out["screenInScene"] = True
            if name in STRONG_PAPER_LABELS:
                out["paperInScene"] = True
            if face_box:
                cx = face_box["Left"] + face_box["Width"] / 2
                cy = face_box["Top"] + face_box["Height"] / 2
                for inst in lab.get("Instances", []):
                    b = inst["BoundingBox"]
                    inside = b["Left"] <= cx <= b["Left"] + b["Width"] and b["Top"] <= cy <= b["Top"] + b["Height"]
                    # a device that frames the face, but is not the whole picture
                    if inside and b["Width"] * b["Height"] < 0.85:
                        if name in STRONG_SCREEN_LABELS:
                            out["screenAroundFace"] = True
                        if name in STRONG_PAPER_LABELS:
                            out["paperAroundFace"] = True
    return out


# ---------- decision engine ----------

def spoof_signals(cfg, client, scene, vision):
    """Independent signs of a spoof. No single model is trusted on its own."""
    sig = []
    if float(client.get("spoofScore", 0)) <= cfg["tLow"]:
        sig.append("SPOOF_MODEL")
    if vision["verdict"] == "spoof" and vision["confidence"] >= cfg["visionConf"]:
        sig.append("VISION_SPOOF")
    if scene["screenInScene"]:
        sig.append("SCREEN_IN_SCENE")
    if scene["paperInScene"]:
        sig.append("PAPER_IN_SCENE")
    return sig


def decide(cfg, client, identity, scene, locked, vision):
    """Returns (decision, reasons).

    Two independent spoof signs -> DENY. No spoof sign, plus positive evidence of life and a matching
    identity -> ALLOW. Anything in between -> VERIFY (step-up). See PLAN.md section 4.
    """
    spoof = float(client.get("spoofScore", 0))
    if locked:
        return "DENY", ["LOCKED_OUT"]
    if client.get("virtualCamera"):
        return "DENY", ["VIRTUAL_CAMERA"]
    if scene["screenAroundFace"]:
        return "DENY", ["SCREEN_AROUND_FACE"]

    sig = spoof_signals(cfg, client, scene, vision)
    if len(sig) >= 2 or (scene["paperAroundFace"] and sig):
        return "DENY", sig

    st, sim = identity["status"], identity["similarity"]
    if st == "MISMATCH":
        return "DENY", ["IDENTITY_MISMATCH"]
    if st == "NO_MATCH":
        return "DENY", ["NOT_ENROLLED"]
    if st == "CLAIMED" and sim < cfg["idVerify"]:
        return "DENY", ["IDENTITY_LOW"]

    verify = list(sig)
    if st == "NO_FACE":
        verify.append("FACE_NOT_CLEAR")
    if st == "ERROR":
        verify.append("SERVICE_ERROR")
    if st == "CLAIMED" and sim < cfg["idAllow"]:
        verify.append("IDENTITY_UNSURE")
    # Positive evidence of life is the random gaze check, run on the kiosk while this request is in
    # flight. Its result arrives in r_client_timing, which downgrades an ALLOW if the check failed.
    vision_live = vision["verdict"] == "live" and vision["confidence"] >= cfg["visionConf"]
    if vision["verdict"] == "unavailable":
        # fall back to the on-device model alone, which must then be confident
        if spoof < cfg["tHigh"]:
            verify.append("SPOOF_SCORE_UNSURE")
    elif not vision_live and "VISION_SPOOF" not in sig:
        verify.append("VISION_UNSURE")
    elif spoof < cfg["tHigh"] and "SPOOF_MODEL" not in sig:
        pass  # model is lukewarm but vision says live and a blink was seen: accepted
    if scene["faceCount"] is not None and scene["faceCount"] > 1:
        verify.append("MULTIPLE_FACES")
    if scene["occluded"]:
        verify.append("FACE_COVERED")
    if scene["sunglasses"]:
        verify.append("SUNGLASSES")
    for q in client.get("qualityFlags", []) or []:
        if q not in verify:
            verify.append(str(q))
    if verify:
        return "VERIFY", verify
    return "ALLOW", ["LIVE_AND_MATCHED"]


def is_locked(cfg, badge_id):
    if not badge_id:
        return False
    since = int((time.time() - cfg["lockoutWindowSec"]) * 1000)
    try:
        res = ddb.query(KeyConditionExpression=Key("pk").eq("ATTEMPT") & Key("sk").gt(f"{since:013d}"))
    except Exception as e:  # noqa
        print("lockout query failed", e)
        return False
    fails = 0
    for it in sorted(res.get("Items", []), key=lambda x: x["sk"], reverse=True):
        if it.get("badgeId") != badge_id or it.get("testLabel") or it.get("scheduleDeny"):
            continue
        if it.get("finalDecision") == "ALLOW":
            break
        if it.get("finalDecision") == "DENY":
            fails += 1
    return fails >= cfg["lockoutFails"]


# ---------- routes ----------

def r_health(_):
    return _resp({"ok": True, "time": int(time.time() * 1000)})


def r_get_config(_):
    return _resp(get_config())


def r_set_config(body):
    cfg = dict(DEFAULT_CONFIG)
    for k in cfg:
        if k in body:
            cfg[k] = float(body[k]) if isinstance(DEFAULT_CONFIG[k], float) else int(body[k])
    ddb.put_item(Item=_dec({"pk": "CONFIG", "sk": "thresholds", **cfg}))
    _config_cache.update(at=0, value=None)
    return _resp(cfg)


def _profile(body, old=None):
    """Access profile set at enrolment: who the person is to the campus schedule."""
    old = old or {}
    sch = get_schedule()
    role = str(body.get("role") or old.get("role") or "student")
    if role not in sch["roles"]:
        role = "student"
    courses = body.get("courses") if "courses" in body else old.get("courses", [])

    def date(k):
        if k not in body:
            return old.get(k)
        v = str(body.get(k) or "").strip()[:10]
        if not v:
            return None
        time.strptime(v, "%Y-%m-%d")
        return v

    return {
        "role": role,
        "courses": [c for c in (courses or []) if c in sch["courses"]],
        "resident": bool(body["resident"]) if "resident" in body else bool(old.get("resident")),
        "clearance": bool(body["clearance"]) if "clearance" in body else bool(old.get("clearance")),
        "validFrom": date("validFrom"),
        "validUntil": date("validUntil"),
        "host": (str(body.get("host") or "").strip()[:80] or None) if "host" in body else old.get("host"),
        "status": "suspended" if (body.get("status") or old.get("status")) == "suspended" else "active",
    }


def _profile_error(prof):
    if prof["role"] in get_schedule().get("expiringRoles", []) and not prof["validUntil"]:
        return f"{get_schedule()['roles'][prof['role']]} access needs an end date"
    return None


def r_schedule(_):
    d = dict(get_schedule())
    d["days"] = schedule.DAYS
    d["now"] = schedule.now_ist().strftime("%Y-%m-%dT%H:%M")
    return _resp(d)


def r_set_schedule(body):
    """Operator edits the schedule. Nothing is saved unless the whole schedule validates."""
    sch = schedule.merged({k: v for k, v in body.items() if k in schedule.DEFAULT_SCHEDULE})
    try:
        schedule.validate(sch)
    except Exception as e:  # noqa
        return _resp({"error": str(e)}, 400)
    ddb.put_item(Item={"pk": "CONFIG", "sk": "schedule", "json": json.dumps(sch)})
    _schedule_cache.update(at=0, value=None)
    return r_schedule(None)


def r_lockdown(body):
    """Lock down or reopen one door. Takes effect on the next check, including checks in mid step-up."""
    sch = copy.deepcopy(get_schedule())
    zone = sch["zones"].get(str(body.get("zone")))
    if not zone:
        return _resp({"error": "Unknown door"}, 404)
    zone["lockdown"] = bool(body.get("on"))
    ddb.put_item(Item={"pk": "CONFIG", "sk": "schedule", "json": json.dumps(sch)})
    _schedule_cache.update(at=0, value=None)
    return r_schedule(None)


def r_users(_):
    res = ddb.query(KeyConditionExpression=Key("pk").eq("USER"))
    users = []
    for i in _undec(res.get("Items", [])):
        u = {"badgeId": i["sk"], "name": i.get("name", ""), "faces": len(i.get("faceIds", [])),
             "enrolledAt": i.get("enrolledAt"), "suspendedAt": i.get("suspendedAt"), "hasPin": bool(i.get("pinHash"))}
        u.update(_profile({}, i))
        users.append(u)
    return _resp({"users": users})


def r_update_user(body):
    """Change a person's access profile, or suspend / reinstate them. Takes effect on the next check."""
    badge = str(body.get("badgeId", ""))
    item = ddb.get_item(Key={"pk": "USER", "sk": badge}).get("Item")
    if not item:
        return _resp({"error": "Not found"}, 404)
    item = _undec(item)
    try:
        prof = _profile(body, item)
    except ValueError:
        return _resp({"error": "Dates must look like 2026-11-14"}, 400)
    err = _profile_error(prof)
    if err:
        return _resp({"error": err}, 400)
    if prof["status"] == "suspended" and item.get("status") != "suspended":
        item["suspendedAt"] = int(time.time() * 1000)
    if prof["status"] == "active":
        item.pop("suspendedAt", None)
    item.update(prof)
    if body.get("pin"):
        try:
            item.update(offline.hash_pin(body["pin"]))
        except ValueError as e:
            return _resp({"error": str(e)}, 400)
    if body.get("name"):
        item["name"] = str(body["name"]).strip()
    ddb.put_item(Item=_dec(item))
    return _resp({"badgeId": badge, **prof})


def r_enroll(body):
    badge = str(body.get("badgeId", "")).strip()
    name = str(body.get("name", "")).strip()
    if not badge or not badge.replace("-", "").replace("_", "").isalnum():
        return _resp({"error": "Badge ID must be letters, numbers, - or _"}, 400)
    if not body.get("consent"):
        return _resp({"error": "Consent is required to enrol"}, 400)
    try:
        new_profile = _profile(body, _undec(ddb.get_item(Key={"pk": "USER", "sk": badge}).get("Item") or {}))
    except ValueError:
        return _resp({"error": "Dates must look like 2026-11-14"}, 400)
    err = _profile_error(new_profile)
    if err:
        return _resp({"error": err}, 400)
    pin_fields = {}
    if body.get("pin"):
        try:
            pin_fields = offline.hash_pin(body["pin"])
        except ValueError as e:
            return _resp({"error": str(e)}, 400)
    if float(body.get("spoofScore", 0)) < get_config()["tHigh"]:
        return _resp({"error": "Liveness check failed at enrolment. Face the camera in good light and try again."}, 400)
    ensure_collection()
    face_ids = []
    for b64 in body.get("images", [])[:5]:
        try:
            res = rek.index_faces(CollectionId=COLLECTION, Image={"Bytes": _img(b64)}, ExternalImageId=badge,
                                  MaxFaces=1, QualityFilter="AUTO", DetectionAttributes=[])
            face_ids += [f["Face"]["FaceId"] for f in res.get("FaceRecords", [])]
        except Exception as e:  # noqa
            print("index error", repr(e))
    if not face_ids:
        return _resp({"error": "No clear face found. Move closer and face the light."}, 400)
    old = ddb.get_item(Key={"pk": "USER", "sk": badge}).get("Item") or {}
    ddb.put_item(Item=_dec({"pk": "USER", "sk": badge, "name": name or old.get("name", badge),
                            "faceIds": list(old.get("faceIds", [])) + face_ids,
                            "enrolledAt": int(time.time() * 1000), "consent": True,
                            **new_profile,
                            **({k: old[k] for k in ("pinSalt", "pinHash", "pinIter") if k in old} if not pin_fields else pin_fields)}))
    return _resp({"badgeId": badge, "facesStored": len(face_ids)})


def r_delete_user(body):
    badge = str(body.get("badgeId", ""))
    item = ddb.get_item(Key={"pk": "USER", "sk": badge}).get("Item")
    if not item:
        return _resp({"error": "Not found"}, 404)
    ids = list(item.get("faceIds", []))
    if ids:
        rek.delete_faces(CollectionId=COLLECTION, FaceIds=ids)
    ddb.delete_item(Key={"pk": "USER", "sk": badge})
    return _resp({"deleted": badge, "faceVectorsDeleted": len(ids)})


def r_verify(body):
    t0 = time.time()
    cfg = get_config()
    client = body.get("client") or {}
    badge = (str(body.get("badgeId")).strip() if body.get("badgeId") else None)
    test = body.get("test") or None
    img = _img(body["frame"])

    f_search = pool.submit(timed, search_face, img)
    f_labels = pool.submit(timed, detect_labels, img)
    f_faces = pool.submit(timed, detect_faces, img)
    f_vision = pool.submit(timed, vision_check, img)
    f_lock = pool.submit(is_locked, cfg, badge) if not test else None
    s_res, s_err, s_ms = f_search.result()
    l_res, l_err, l_ms = f_labels.result()
    d_res, d_err, d_ms = f_faces.result()
    locked = f_lock.result() if f_lock else False
    v_res, v_err, v_ms = f_vision.result()
    vision = vision_result(v_res, v_err)

    identity = identity_from_search(s_res, s_err, badge)
    scene = scene_signals(l_res, d_res)
    try:
        decision, reasons = decide(cfg, client, identity, scene, locked, vision)
    except Exception as e:  # fail secure
        print("decide failed", repr(e))
        decision, reasons = "VERIFY", ["SERVICE_ERROR"]
    if l_err or d_err:
        if decision == "ALLOW":
            decision, reasons = "VERIFY", ["SERVICE_ERROR"]

    # Access schedule: a live, recognised person is not automatically authorised for this door now.
    bio_decision, bio_reasons = decision, list(reasons)
    zone, access, person = body.get("zone") or None, None, None
    who = identity["matchedBadge"] if identity["status"] == "CLAIMED" else None
    if who:
        try:
            person = _undec(ddb.get_item(Key={"pk": "USER", "sk": who}).get("Item") or {}) or None
        except Exception as e:  # noqa
            print("user lookup failed", repr(e))
    if zone and bio_decision != "DENY":
        access = access_check(person, zone, body.get("clock"))
        decision, reasons = schedule.combine(bio_decision, bio_reasons, access)
    strong_stepup = bool(access and access.get("strong") and decision == "VERIFY")

    server_ms = int((time.time() - t0) * 1000)
    now = int(time.time() * 1000)
    attempt_id = uuid.uuid4().hex[:12]
    sk = f"{now:013d}#{attempt_id}"
    item = {
        "pk": "ATTEMPT", "sk": sk, "attemptId": attempt_id, "at": now,
        "badgeId": badge, "matchedBadge": identity["matchedBadge"],
        "decision": decision, "finalDecision": decision if decision != "VERIFY" else "VERIFY",
        "bioDecision": bio_decision, "access": access, "role": (person or {}).get("role"),
        "clock": body.get("clock") or None, "scheduleDeny": schedule.is_schedule_deny(decision, reasons),
        "reasons": reasons, "spoofScore": float(client.get("spoofScore", 0)),
        "spoofMin": float(client.get("spoofMin", 0)), "frames": int(client.get("frames", 0)),
        "similarity": float(identity["similarity"]), "identityStatus": identity["status"],
        "sceneLabels": scene["labels"], "faceCount": scene["faceCount"],
        "backgroundFaces": scene.get("backgroundFaces", 0), "vision": vision,
        "blinkSeen": bool(client.get("blinkSeen")), "trackedMs": int(client.get("trackedMs", 0)),
        "timing": {"server": server_ms, "search": s_ms, "labels": l_ms, "faces": d_ms, "vision": v_ms,
                   "clientCapture": int(client.get("captureMs", 0)), "clientPad": int(client.get("padMs", 0))},
        "test": test, "testLabel": (test or {}).get("presentation"),
        "steps": [],
    }
    # Written before answering: Lambda may freeze as soon as it has replied, so a background write
    # can be lost, and the kiosk's follow-up calls then find no attempt to update.
    try:
        ddb.put_item(Item=_dec(item))
    except Exception as e:  # noqa
        print("audit write failed", repr(e))
    return _resp({"attemptId": attempt_id, "sk": sk, "decision": decision, "reasons": reasons,
                  "similarity": round(identity["similarity"], 1), "matchedBadge": identity["matchedBadge"],
                  "scene": scene, "vision": vision, "timing": item["timing"], "thresholds": cfg,
                  "bioDecision": bio_decision, "bioReasons": bio_reasons, "access": access,
                  "stepup": "liveness" if strong_stepup else None,
                  "person": {"name": person.get("name"), "role": person.get("role") or "student"} if person else None})


def _finish(sk, final, reasons, step, total_ms=None):
    expr = "SET finalDecision = :f, finalReasons = :r, steps = list_append(if_not_exists(steps, :e), :s)"
    vals = {":f": final, ":r": reasons, ":s": [_dec(step)], ":e": []}
    if total_ms is not None:
        expr += ", totalMs = :t"
        vals[":t"] = int(total_ms)
    ddb.update_item(Key={"pk": "ATTEMPT", "sk": sk}, UpdateExpression=expr, ExpressionAttributeValues=vals)


def r_client_timing(body):
    """Kiosk reports the measured end-to-end time and the result of the random gaze check."""
    sk, gaze = body["sk"], body.get("gaze")
    expr, vals = "SET totalMs = :t", {":t": int(body["totalMs"])}
    if gaze is not None:
        expr += ", gaze = :g"
        vals[":g"] = _dec(gaze)
    try:  # update the attempt only if it exists; never create a half-empty record
        ddb.update_item(Key={"pk": "ATTEMPT", "sk": sk}, UpdateExpression=expr, ExpressionAttributeValues=vals,
                        ConditionExpression="attribute_exists(sk)")
    except ddb.meta.client.exceptions.ConditionalCheckFailedException:
        return _resp({"ok": False, "error": "Unknown attempt"}, 404)
    if gaze is not None and not gaze.get("passed"):
        try:  # no gaze response: an ALLOW becomes REQUEST VERIFICATION
            ddb.update_item(Key={"pk": "ATTEMPT", "sk": sk},
                            UpdateExpression="SET decision = :v, finalDecision = :v, reasons = :r",
                            ConditionExpression="decision = :a",
                            ExpressionAttributeValues={":v": "VERIFY", ":a": "ALLOW", ":r": ["NO_GAZE_RESPONSE"]})
            return _resp({"decision": "VERIFY", "reasons": ["NO_GAZE_RESPONSE"]})
        except ddb.meta.client.exceptions.ConditionalCheckFailedException:
            pass
    return _resp({"ok": True})


def r_stepup(body):
    cfg = get_config()
    sk = body["sk"]
    att = ddb.get_item(Key={"pk": "ATTEMPT", "sk": sk}).get("Item")
    if not att:
        return _resp({"error": "Unknown attempt"}, 404)
    att = _undec(att)
    if att.get("decision") != "VERIFY" or att.get("finalDecision") in ("ALLOW", "DENY"):
        return _resp({"error": "Attempt is not waiting for verification"}, 409)
    badge = att.get("badgeId")
    method = body.get("method")
    step = {"method": method, "at": int(time.time() * 1000)}

    if method == "retake":
        _finish(sk, "RETAKE", ["RETAKE"], step)
        return _resp({"decision": "RETAKE", "reasons": ["RETAKE"]})

    if method == "abandon":
        _finish(sk, "DENY", ["STEPUP_ABANDONED"], step)
        return _resp({"decision": "DENY", "reasons": ["STEPUP_ABANDONED"]})

    if method == "action":
        passed = bool(body.get("passed"))
        spoof = float(body.get("spoofScore", 0))
        step.update(action=body.get("action"), passed=passed, spoofScore=spoof)
        if not passed:
            step["result"] = "ESCALATE"
            ddb.update_item(Key={"pk": "ATTEMPT", "sk": sk},
                            UpdateExpression="SET steps = list_append(if_not_exists(steps, :e), :s)",
                            ExpressionAttributeValues={":s": [_dec(step)], ":e": []})
            return _resp({"decision": "VERIFY", "reasons": ["ACTION_NOT_COMPLETED"], "next": "liveness"})
        img = _img(body["frame"])
        f_search = pool.submit(timed, search_face, img)
        f_labels = pool.submit(timed, detect_labels, img)
        f_faces = pool.submit(timed, detect_faces, img)
        f_vision = pool.submit(timed, vision_check, img)
        s_res, s_err, _ = f_search.result()
        l_res, _, _ = f_labels.result()
        d_res, _, _ = f_faces.result()
        v_res, v_err, _ = f_vision.result()
        vision = vision_result(v_res, v_err)
        identity = identity_from_search(s_res, s_err, badge)
        scene = scene_signals(l_res, d_res)
        vision_spoof = vision["verdict"] == "spoof" and vision["confidence"] >= cfg["visionConf"]
        step.update(similarity=identity["similarity"], identityStatus=identity["status"], vision=vision)
        if scene["screenAroundFace"]:
            final, reasons = "DENY", ["SPOOF_AFTER_ACTION"]
        elif identity["status"] == "MISMATCH":
            final, reasons = "DENY", ["IDENTITY_MISMATCH"]
        elif (identity["status"] == "CLAIMED" and identity["similarity"] >= cfg["stepupIdMin"]
              and not scene["screenInScene"] and not vision_spoof):
            # a completed random action is strong evidence of life; a paper mask with eye holes is
            # what the vision check and scene labels are there to catch
            final, reasons = "ALLOW", ["ACTION_PASSED"]
            blocked = schedule_recheck(att)
            if blocked:
                final, reasons = "DENY", blocked["reasons"]
        else:
            step["result"] = "ESCALATE"
            ddb.update_item(Key={"pk": "ATTEMPT", "sk": sk},
                            UpdateExpression="SET steps = list_append(if_not_exists(steps, :e), :s)",
                            ExpressionAttributeValues={":s": [_dec(step)], ":e": []})
            return _resp({"decision": "VERIFY", "reasons": ["STILL_UNSURE"], "next": "liveness"})
        step["result"] = final
        _finish(sk, final, reasons, step)
        return _resp({"decision": final, "reasons": reasons, "similarity": round(identity["similarity"], 1)})

    if method == "liveness":
        try:
            res = rek.get_face_liveness_session_results(SessionId=body["sessionId"])
        except Exception as e:  # noqa
            print("liveness results error", repr(e))
            step["result"] = "ERROR"
            _finish(sk, "DENY", ["LIVENESS_ERROR"], step)
            return _resp({"decision": "DENY", "reasons": ["LIVENESS_ERROR"]})
        conf = float(res.get("Confidence", 0))
        step.update(livenessConfidence=conf, status=res.get("Status"), clientError=str(body.get("error", ""))[:200] or None)
        if res.get("Status") != "SUCCEEDED" or conf < cfg["livenessPass"]:
            step["result"] = "DENY"
            _finish(sk, "DENY", ["LIVENESS_FAILED"], step)
            return _resp({"decision": "DENY", "reasons": ["LIVENESS_FAILED"], "livenessConfidence": round(conf, 1)})
        ref = (res.get("ReferenceImage") or {}).get("Bytes")
        s_res, s_err, _ = timed(search_face, ref) if ref else (None, ValueError("no reference"), 0)
        identity = identity_from_search(s_res, s_err, badge)
        step.update(similarity=identity["similarity"], identityStatus=identity["status"])
        if identity["status"] == "CLAIMED" and identity["similarity"] >= cfg["stepupIdMin"]:
            final, reasons = "ALLOW", ["LIVENESS_PASSED"]
            blocked = schedule_recheck(att)
            if blocked:
                final, reasons = "DENY", blocked["reasons"]
        else:
            final, reasons = "DENY", ["IDENTITY_MISMATCH" if identity["status"] == "MISMATCH" else "IDENTITY_LOW"]
        step["result"] = final
        _finish(sk, final, reasons, step)
        return _resp({"decision": final, "reasons": reasons, "livenessConfidence": round(conf, 1),
                      "similarity": round(identity["similarity"], 1)})

    return _resp({"error": "Unknown method"}, 400)


def r_kiosk_bundle(body):
    """What this kiosk needs to keep deciding safely if it loses the connection (see offline.py)."""
    cfg, sch = get_config(), get_schedule()
    zone = str(body.get("zone") or "main_gate")
    users = ddb.query(KeyConditionExpression=Key("pk").eq("USER")).get("Items", [])
    try:
        b = offline.build_bundle(_undec(users), zone, sch, cfg, schedule.now_ist(body.get("clock")),
                                 int(cfg.get("offlineHours", 8)))
    except ValueError as e:
        return _resp({"error": str(e)}, 400)
    return _resp(b)


def r_offline_sync(body):
    """The kiosk uploads the decisions it made offline. Idempotent: a record sent twice is stored once.
    Each offline ALLOW is re-checked against the current records; disagreements are flagged."""
    sch = get_schedule()
    kiosk = str(body.get("kioskId") or "kiosk")[:40]
    accepted, conflicts = [], []
    now = int(time.time() * 1000)
    users = {}
    for r in (body.get("records") or [])[:500]:
        rid = "".join(c for c in str(r.get("id", "")) if c.isalnum())[:32]
        if not rid:
            continue
        at = int(r.get("at") or now)
        badge = str(r.get("badgeId") or "")
        if badge not in users:
            it = ddb.get_item(Key={"pk": "USER", "sk": badge}).get("Item") if badge else None
            users[badge] = _undec(it) if it else None
        issues = offline.recheck(r, users[badge], sch)
        decision = r.get("decision") if r.get("decision") in ("ALLOW", "DENY") else "DENY"
        item = {
            "pk": "ATTEMPT", "sk": f"{at:013d}#{rid}", "attemptId": rid, "at": at, "source": "OFFLINE",
            "kioskId": kiosk, "syncedAt": now, "badgeId": badge or None, "matchedBadge": badge or None,
            "decision": decision, "finalDecision": decision, "reasons": [str(x)[:40] for x in (r.get("reasons") or [])][:8],
            "zone": r.get("zone"), "clock": r.get("localTime"), "bundleVersion": r.get("bundleVersion"),
            "spoofScore": float(r.get("spoofScore") or 0),
            "offline": {"gaze": bool(r.get("gazePassed")), "light": r.get("light"), "pin": r.get("pin")},
            "access": {"zone": r.get("zone"), "zoneName": r.get("zoneName"), "decision": r.get("schedule"),
                       "reasons": ["OFFLINE_CACHE"], "detail": "Decided by the kiosk from its cached schedule."},
            "conflict": issues or None, "test": r.get("test"), "testLabel": (r.get("test") or {}).get("presentation"),
            "steps": [],
        }
        try:
            ddb.put_item(Item=_dec(item), ConditionExpression="attribute_not_exists(sk)")
        except ddb.meta.client.exceptions.ConditionalCheckFailedException:
            pass  # already synced earlier
        accepted.append(rid)
        if issues:
            conflicts.append({"id": rid, "badgeId": badge, "issues": issues})
    return _resp({"accepted": accepted, "conflicts": conflicts})


def r_liveness_session(_):
    session = rek.create_face_liveness_session(Settings={"AuditImagesLimit": 0})
    creds = sts.assume_role(RoleArn=STREAM_ROLE_ARN, RoleSessionName="kiosk-liveness", DurationSeconds=900)["Credentials"]
    return _resp({"sessionId": session["SessionId"], "region": REGION, "credentials": {
        "accessKeyId": creds["AccessKeyId"], "secretAccessKey": creds["SecretAccessKey"],
        "sessionToken": creds["SessionToken"], "expiration": creds["Expiration"].isoformat()}})


def r_attempts(_):
    items, kwargs = [], {"KeyConditionExpression": Key("pk").eq("ATTEMPT"), "ScanIndexForward": False}
    while len(items) < 2000:
        res = ddb.query(**kwargs)
        items += res.get("Items", [])
        if "LastEvaluatedKey" not in res:
            break
        kwargs["ExclusiveStartKey"] = res["LastEvaluatedKey"]
    # skip any malformed record (e.g. a partial write) so the operator screens never break
    return _resp({"attempts": [a for a in _undec(items) if isinstance(a.get("decision"), str)]})


def r_clear_attempts(body):
    only_test = bool(body.get("onlyTest"))
    res = ddb.query(KeyConditionExpression=Key("pk").eq("ATTEMPT"))
    n = 0
    with ddb.batch_writer() as bw:
        for it in res.get("Items", []):
            if only_test and not it.get("testLabel"):
                continue
            bw.delete_item(Key={"pk": "ATTEMPT", "sk": it["sk"]})
            n += 1
    return _resp({"deleted": n})


def r_explain(body):
    a = body.get("attempt") or {}
    facts = {k: a.get(k) for k in ("decision", "finalDecision", "reasons", "finalReasons", "spoofScore",
                                    "similarity", "identityStatus", "sceneLabels", "faceCount", "steps", "timing")}
    prompt = ("You explain access-kiosk decisions to a security operator. Using only these facts, write 2 short "
              "plain-English sentences: what the system decided and why. No jargon, no advice, no markdown. "
              "spoofScore is 0 to 1 (higher means more likely a live person); similarity is 0 to 100.\n\n"
              + json.dumps(facts, default=str))
    try:
        res = bedrock.converse(modelId=EXPLAIN_MODEL, messages=[{"role": "user", "content": [{"text": prompt}]}],
                               inferenceConfig={"maxTokens": 200})
        text = "".join(c.get("text", "") for c in res["output"]["message"]["content"]).strip()
        return _resp({"explanation": text, "model": EXPLAIN_MODEL})
    except Exception as e:  # noqa
        print("explain failed", repr(e))
        return _resp({"explanation": "Explanation service unavailable. Reason codes: " + ", ".join(a.get("reasons", [])),
                      "model": None})


ROUTES = {
    ("GET", "/api/health"): r_health,
    ("GET", "/api/config"): r_get_config,
    ("POST", "/api/config"): r_set_config,
    ("GET", "/api/users"): r_users,
    ("GET", "/api/schedule"): r_schedule,
    ("POST", "/api/users/update"): r_update_user,
    ("POST", "/api/schedule"): r_set_schedule,
    ("POST", "/api/schedule/lockdown"): r_lockdown,
    ("POST", "/api/enroll"): r_enroll,
    ("POST", "/api/users/delete"): r_delete_user,
    ("POST", "/api/verify"): r_verify,
    ("POST", "/api/verify/timing"): r_client_timing,
    ("POST", "/api/kiosk/bundle"): r_kiosk_bundle,
    ("POST", "/api/offline/sync"): r_offline_sync,
    ("POST", "/api/stepup"): r_stepup,
    ("POST", "/api/liveness/session"): r_liveness_session,
    ("GET", "/api/attempts"): r_attempts,
    ("POST", "/api/attempts/clear"): r_clear_attempts,
    ("POST", "/api/explain"): r_explain,
}


def handler(event, _ctx):
    http = event.get("requestContext", {}).get("http", {})
    method, path = http.get("method", "GET"), event.get("rawPath", "/")
    fn = ROUTES.get((method, path.rstrip("/") or "/"))
    if not fn:
        return _resp({"error": "Not found", "path": path}, 404)
    body = {}
    if event.get("body"):
        raw = event["body"]
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode("utf-8")
        try:
            body = json.loads(raw)
        except Exception:  # noqa
            return _resp({"error": "Invalid JSON"}, 400)
    try:
        return fn(body)
    except Exception as e:  # noqa
        print("route failed", path, repr(e))
        return _resp({"error": "Server error", "detail": type(e).__name__}, 500)
