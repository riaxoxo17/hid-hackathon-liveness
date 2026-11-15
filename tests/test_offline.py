"""Decision-logic tests with AWS replaced by fakes. Run from the project root: python -m pytest tests -q"""
import base64
import copy
import json
import os
import random
import re
import sys
from concurrent.futures import Future

import pytest

os.environ.setdefault("TABLE_NAME", "test-table")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import handler  # noqa: E402

CFG = dict(handler.DEFAULT_CONFIG)


# ---------- fake AWS ----------

class CondFail(Exception):
    pass


class FakeTable:
    def __init__(self):
        self.items = {}
        self.meta = type("M", (), {"client": type("C", (), {"exceptions": type("E", (), {"ConditionalCheckFailedException": CondFail})})})

    def get_item(self, Key):
        it = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": copy.deepcopy(it)} if it else {}

    def put_item(self, Item, ConditionExpression=None):
        k = (Item["pk"], Item["sk"])
        if ConditionExpression and k in self.items:
            raise CondFail()
        self.items[k] = Item

    def query(self, KeyConditionExpression=None, **kw):
        ex = KeyConditionExpression.get_expression() if KeyConditionExpression is not None else {}
        if ex.get("operator") == "=":
            pk = ex["values"][1]
            return {"Items": [copy.deepcopy(v) for (a, _), v in self.items.items() if a == pk]}
        return {"Items": []}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, ConditionExpression=None):
        k = (Key["pk"], Key["sk"])
        if ConditionExpression == "attribute_exists(sk)" and k not in self.items:
            raise CondFail()
        if k not in self.items:
            self.items[k] = {"pk": Key["pk"], "sk": Key["sk"]}  # DynamoDB creates missing items on update
        it = self.items[k]
        set_part, _, remove = UpdateExpression.partition(" REMOVE ")
        for path, val in re.findall(r"([\w.]+) = (list_append\(if_not_exists\(\w+, :\w+\), :\w+\)|:\w+)",
                                    set_part.replace("SET ", "")):
            if val.startswith("list_append"):
                it[path] = list(it.get(path, [])) + ExpressionAttributeValues[re.findall(r":\w+", val)[1]]
            else:
                it[path] = ExpressionAttributeValues[val]
        for r in [x.strip() for x in remove.split(",") if x.strip()]:
            it.pop(r, None)


class SyncPool:
    def submit(self, fn, *a, **kw):
        f = Future()
        try:
            f.set_result(fn(*a, **kw))
        except Exception as e:  # noqa
            f.set_exception(e)
        return f


LIVE_VISION = {"verdict": "live", "confidence": 0.95, "cue": ""}


@pytest.fixture
def fake(monkeypatch):
    t = FakeTable()
    t.items[("USER", "B1")] = {"pk": "USER", "sk": "B1", "name": "Ria", "role": "student", "status": "active"}
    monkeypatch.setattr(handler, "ddb", t)
    monkeypatch.setattr(handler, "pool", SyncPool())
    monkeypatch.setattr(handler, "_config_cache", {"at": 0, "value": None})
    monkeypatch.setattr(handler, "_schedule_cache", {"at": 0, "value": None})
    state = {"vision": dict(LIVE_VISION), "labels": []}
    monkeypatch.setattr(handler, "search_face", lambda img: {"FaceMatches": [{"Similarity": 99.0, "Face": {"ExternalImageId": "B1"}}]})
    monkeypatch.setattr(handler, "detect_labels", lambda img: {"Labels": state["labels"]})
    monkeypatch.setattr(handler, "detect_faces", lambda img: {"FaceDetails": [{"Confidence": 99, "BoundingBox": {"Left": .3, "Top": .2, "Width": .3, "Height": .4}}]})
    monkeypatch.setattr(handler, "vision_check", lambda img: dict(state["vision"]))
    t.state = state
    return t


def call(route, body):
    ev = {"requestContext": {"http": {"method": "POST"}}, "rawPath": route, "body": json.dumps(body)}
    res = handler.handler(ev, None)
    return res["statusCode"], json.loads(res["body"])


_n = [0]


def frame():
    _n[0] += 1
    return "data:image/jpeg;base64," + base64.b64encode(f"frame-{_n[0]}".encode()).decode()


GOOD = {"spoofScore": 0.97, "qualityFlags": []}


# ---------- offline mode ----------

import offline  # noqa: E402
import schedule as campus  # noqa: E402


def test_pin_hash_roundtrip_and_validation():
    rec = offline.hash_pin("482913")
    assert offline.check_pin("482913", rec) and not offline.check_pin("482914", rec)
    assert "482913" not in str(rec)
    with pytest.raises(ValueError):
        offline.hash_pin("12a4")


def test_slots_take_the_stricter_end():
    sch = campus.merged(None)
    u = {"role": "student", "status": "active"}
    start = campus.now_ist("2026-11-16T20:30")  # library closes 21:00, grace until 21:15
    slots = offline.slots_for(u, "library", start, 4, sch)
    assert slots == "ASDD", slots  # 20:30 A; 20:45-21:00 ends in grace: S; 21:00-21:15 ends at grace cut-off: D


def _users(fake):
    fake.items[("USER", "B1")].update(offline.hash_pin("1111"))
    fake.items[("USER", "B2")] = {"pk": "USER", "sk": "B2", "name": "NoPin", "role": "student", "status": "active"}
    fake.items[("USER", "B3")] = {"pk": "USER", "sk": "B3", "name": "Admin", "role": "staff", "clearance": True,
                                  "status": "active", **offline.hash_pin("2222")}


def test_bundle_holds_minimum(fake):
    _users(fake)
    st, b = call("/api/kiosk/bundle", {"zone": "library", "clock": "2026-11-16T10:00"})
    assert st == 200
    assert set(b["users"]) == {"B1", "B3"}            # no PIN -> no offline access
    assert b["users"]["B1"]["slots"].startswith("AAAA")
    assert "faceIds" not in json.dumps(b) and "1111" not in json.dumps(b)
    st, b = call("/api/kiosk/bundle", {"zone": "server_room", "clock": "2026-11-16T10:00"})
    assert b["users"] == {}                            # always step-up there, so never offline


def test_offline_sync_idempotent_and_flags_conflicts(fake):
    _users(fake)
    recs = [{"id": "r1", "at": 1, "badgeId": "B1", "zone": "library", "localTime": "2026-11-16T10:00", "decision": "ALLOW", "reasons": ["OFFLINE_ALLOW"]},
            {"id": "r2", "at": 2, "badgeId": "B1", "zone": "library", "localTime": "2026-11-16T23:30", "decision": "ALLOW", "reasons": ["OFFLINE_ALLOW"]},
            {"id": "r3", "at": 3, "badgeId": "B9", "zone": "library", "localTime": "2026-11-16T10:00", "decision": "DENY", "reasons": ["OFFLINE_NO_ACCESS"]}]
    st, r = call("/api/offline/sync", {"kioskId": "k1", "records": recs})
    assert sorted(r["accepted"]) == ["r1", "r2", "r3"]
    assert [c["id"] for c in r["conflicts"]] == ["r2"]
    n = len([k for k in fake.items if k[0] == "ATTEMPT"])
    call("/api/offline/sync", {"kioskId": "k1", "records": recs})
    assert len([k for k in fake.items if k[0] == "ATTEMPT"]) == n   # sent twice, stored once
    fake.items[("USER", "B1")]["status"] = "suspended"
    st, r = call("/api/offline/sync", {"kioskId": "k1", "records": [{**recs[0], "id": "r4"}]})
    assert r["conflicts"][0]["issues"][0] == "SUSPENDED_NOW"


def test_users_list_never_exposes_pin(fake):
    _users(fake)
    ev = {"requestContext": {"http": {"method": "GET"}}, "rawPath": "/api/users"}
    body = handler.handler(ev, None)["body"]
    assert "pinHash" not in body and '"hasPin": true' in body


def test_normal_verify_still_works(fake):
    st, r = call("/api/verify", {"badgeId": "B1", "frame": frame(), "client": {"spoofScore": 0.97, "qualityFlags": []}})
    assert st == 200 and r["decision"] == "ALLOW", r


def test_enrol_keeps_existing_pin_when_none_given(fake, monkeypatch):
    fake.items[("USER", "B1")].update(offline.hash_pin("1111"))
    monkeypatch.setattr(handler, "ensure_collection", lambda: None)
    monkeypatch.setattr(handler.rek, "index_faces", lambda **kw: {"FaceRecords": [{"Face": {"FaceId": "f1"}}]})
    st, r = call("/api/enroll", {"badgeId": "B1", "name": "Ria", "consent": True, "images": [frame()], "spoofScore": 0.95})
    assert st == 200, r
    assert offline.check_pin("1111", fake.items[("USER", "B1")])


def test_timing_report_never_creates_a_partial_record(fake):
    st, r = call("/api/verify/timing", {"sk": "999#nope", "totalMs": 1200, "gaze": {"passed": True}})
    assert st == 404 and ("ATTEMPT", "999#nope") not in fake.items


def test_audit_record_exists_before_verify_answers(fake):
    st, r = call("/api/verify", {"badgeId": "B1", "frame": frame(), "client": {"spoofScore": 0.97, "qualityFlags": []}})
    assert ("ATTEMPT", r["sk"]) in fake.items
    st, t = call("/api/verify/timing", {"sk": r["sk"], "totalMs": 1300, "gaze": {"passed": True}})
    assert st == 200 and fake.items[("ATTEMPT", r["sk"])]["decision"] == "ALLOW"


def test_attempts_list_skips_malformed_records(fake):
    fake.items[("ATTEMPT", "1#bad")] = {"pk": "ATTEMPT", "sk": "1#bad", "gaze": {}, "totalMs": 5}
    call("/api/verify", {"badgeId": "B1", "frame": frame(), "client": {"spoofScore": 0.97, "qualityFlags": []}})
    ev = {"requestContext": {"http": {"method": "GET"}}, "rawPath": "/api/attempts"}
    items = json.loads(handler.handler(ev, None)["body"])["attempts"]
    assert items and all("decision" in a for a in items)
