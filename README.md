# HID liveness kiosk

Face liveness and identity check for an entry kiosk. Built for the HID "Can You Spot a Spoof?" hackathon.
It returns ALLOW, REQUEST VERIFICATION or DENY, with the fast decision designed to finish within 2 seconds.

See [PLAN.md](PLAN.md) for the design and the judging criteria.

## How it decides

1. **On the kiosk (browser):** face landmarks (MediaPipe), a spoof model (MiniFASNet, ONNX) and a random
   two-step "follow the dot" eye-movement check that a photo or recorded video cannot follow.
2. **On AWS, in parallel:** face match (Rekognition face collection), phone / screen / paper detection
   (Rekognition labels), face attributes, and an independent vision check (Claude on Bedrock).
3. **Decision engine (Lambda):** two independent spoof signs deny; no spoof sign, a passed dot check and a
   face match allow; anything else asks for verification.
4. **Step-up:** guided retake, a random action (blink, open mouth, smile or turn), then Amazon Rekognition
   Face Liveness.

No face images are stored. Rekognition keeps face vectors; DynamoDB keeps scores, reason codes and timings.

## Layout

- `app/` Vite + React kiosk (tabs: Kiosk, Enrol, Operator, Results)
- `backend/handler.py` the Lambda: routes and decision engine
- `infra/` AWS CDK stack: Lambda, DynamoDB, S3 + CloudFront

## Deploy

Needs Node 20+, the AWS CLI and an AWS profile named `hid` for us-east-1 with CDK bootstrapped.

```bash
cd app && npm install && npx vite build
cd ../infra && npm install && npx cdk deploy --profile hid --require-approval never
```

The deploy prints the kiosk URL. Camera access needs HTTPS, which CloudFront provides.

## Status

Tested by hand on one laptop webcam with one enrolled person: real face, phone photo and phone video.
Printed photo, mask and wrong-badge cases are not yet measured. Thresholds are editable on the Operator tab.

## Offline mode (challenge 2)

When the kiosk cannot reach the central service (or **Simulate offline** is ticked on the Kiosk tab):

- **Safe local decision.** The spoof model and the gaze check both run on the kiosk,
  so the live-person check keeps working. Offline is stricter than online: one spoof sign is enough to deny.
- **No unsafe automatic access.** The kiosk never opens on a face alone. It needs the badge, a live
  person, the cached schedule saying ALLOW for this door and time, and the person's PIN. Anything the
  schedule would only allow after a step-up (exam entry, server room, grace period, curfew) is denied.
- **Fallback verification.** The PIN (set at enrolment, stored as a salted PBKDF2 hash) replaces the face
  match. Three wrong PINs lock the badge on that kiosk until it syncs. Denials point to security.
- **Minimum temporary data.** The cache (`/api/kiosk/bundle`) is one door's schedule as one letter per
  15-minute slot for the next 8 hours, plus names and PIN hashes of people that door could admit.
  No face data, no photos. It is deleted when it expires. The decision log holds badge, door, time,
  decision, reason codes and scores, with no images or PINs, and is deleted once synced (24 h at most).
- **Sync on reconnect.** The kiosk pings every 10 s; when the service is back it uploads the log
  (`/api/offline/sync`). Uploads are idempotent, and every offline ALLOW is re-checked against current
  records: a badge suspended or a schedule changed in the meantime is flagged on the Operator tab.
