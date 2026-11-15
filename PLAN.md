# Build plan: "Can You Spot a Spoof?" (HID hackathon, 14 Nov 2026)

## 1. What the brief asks for

- A kiosk app that checks **liveness and identity** and returns **ALLOW / REQUEST VERIFICATION / DENY**.
- **Decision within 2 seconds.**
- Shown against **at least 2 spoof types** (printed photo, phone photo, video replay, mask).
- **Clear handling of low-confidence cases** with an extra verification step.
- **Measured results per scenario**: detection rate, false acceptance, false rejection, decision time.

## 1a. How we are judged (HID slides shown at the venue)

| Criterion | Weight | What the slide asks for | What we do for it |
|---|---|---|---|
| Problem-Solution Fit | 25% | Relevance, addresses the core challenges, understanding in framing the problem | Both checks (liveness and identity), all three outcomes, all four spoof types, 2-second timer on screen |
| Technical Implementation | 25% | Feasibility, use of APIs and frameworks, integration architecture, scalability | Architecture diagram, AWS services wired together, a slide on how it scales to many kiosks |
| Innovation & Creativity | 20% | New techniques, creative methods, differentiation from existing solutions | Passive-first with step-up only when unsure, spoof check on the device, reason codes, measured test mode |
| Functionality & Usability | 15% | Working prototype, user-friendly interface, achieves objectives | Clean kiosk screen with one clear instruction at a time, large ALLOW / VERIFY / DENY result |
| Presentation & Communication | 15% | Clear structure, explain technical details to a non-technical audience, answer judges' questions | Plain-language script, one analogy per idea, prepared answers to likely questions |

HID's "Performance Evaluation" slide shows the format they expect results in:

- liveness detection accuracy (their example: 99.4%)
- face authentication accuracy (99.2%)
- false acceptance rate, FAR (0.2%)
- false rejection rate, FRR (0.6%)
- decision time under 2 seconds
- "Validated across printed photo, screen replay, video, and mask attacks"

Our results page leads with these same five numbers in the same layout, with sample sizes next to them. All four attack types must appear in the test run, so a **mask attempt is now required**, not optional.

## 2. The finding that shapes everything

Amazon Rekognition Face Liveness, the plan we walked in with, takes **5 s best case, about 7 s average, 11 s worst case** by AWS's own FAQ. It cannot be the main check under a 2-second limit.
Source: https://docs.aws.amazon.com/rekognition/latest/dg/face-liveness-faq.html

So the design is two tiers:

1. **Fast passive tier (under 2 s, no user action).** Makes the ALLOW / DENY call for most people.
2. **Step-up tier (only when unsure).** Slower active checks, ending in Rekognition Face Liveness. This is the REQUEST VERIFICATION path.

This also matches how HID sells its own products: passive liveness that "requires no user action", processed on the device, with HID's Face Module passing iBeta Level 2 (0 of 750 attacks).
Source: https://www.biometricupdate.com/202509/ibeta-confirms-level-2-pad-compliance-for-hid-fpt-is-transunion-private-identity

## 3. Architecture

```
Browser (React kiosk, camera always on)                    AWS (us-east-1)
---------------------------------------                    ----------------
MediaPipe face landmarks -> quality gate
5 frames over ~0.6 s
  MiniFASNet x2 (ONNX, in browser)  -> spoof score
  moire / glare check               -> screen score
  virtual-camera label check
        |
        +-- one POST (best frame + full frame + badge ID) --> Lambda
                                                               in parallel:
                                                               - Rekognition face search (identity)
                                                               - Rekognition DetectLabels (phone/screen/paper)
                                                               - Rekognition DetectFaces (occlusion, sunglasses)
                                                               decision engine -> ALLOW / VERIFY / DENY + reason codes
                                                               DynamoDB audit row (no image stored)
        <-- decision, reason codes, per-stage timings ---------
Step-up (only on VERIFY):
  1. guided recapture  2. random action (turn / blink)  3. Rekognition Face Liveness
Operator dashboard: audit log, results table, Claude Haiku 5.5 explanation (not on the 2 s path)
```

### Why these choices

| Choice | Reason |
|---|---|
| Spoof model runs **in the browser** | No network hop, works if venue Wi-Fi is slow, and it is the "edge" design HID uses |
| **MiniFASNet V2 + V1SE** (Silent-Face) | Apache-2.0, ready ONNX files, about 1.2 MB each, most-used open model (1.8K stars) |
| Identity on **Rekognition face collection** | Stores face vectors, not photos; one call; works for badge + face (1:1) and face only (1:N) |
| **DetectLabels** for phone / screen / paper | Catches the device around the face; very visible in a demo |
| Decision made **on the server** | The browser cannot just post "ALLOW" |
| Bedrock **off the hot path** | A vision call takes about 1 s; used for operator explanations and as a second opinion during step-up |
| **Rekognition Face Liveness as last step-up** | iBeta Level 1 and 2 tested; uses the sandbox the way HID intended |

Model files:
- https://github.com/yakhyo/face-anti-spoofing/releases/download/weights/MiniFASNetV2.onnx (crop scale 2.7)
- https://github.com/yakhyo/face-anti-spoofing/releases/download/weights/MiniFASNetV1SE.onnx (crop scale 4.0)

## 4. Decision rules

Order matters. Each rule produces a reason code shown to the operator.

1. **Quality gate.** One face, large enough, facing the camera, lighting in range. Failure -> **VERIFY** with guidance ("move closer", "face the light"). Never DENY for bad lighting.
2. **Hard deny.** Phone / screen / paper detected around the face, virtual camera, or more than one face with a low spoof score -> **DENY**.
3. **Spoof score** (average of both models over 5 frames, adjusted by moire / glare):
   - at or above `T_high` -> live
   - at or below `T_low` -> **DENY**
   - in between -> **VERIFY**
4. **Identity.** Match at or above 95 and equal to the badge -> pass. 80 to 95 -> **VERIFY**. Below 80 or wrong person -> **DENY**.
5. **ALLOW** only if rules 1 to 4 all pass.
6. **Fail secure.** Any error or timeout -> VERIFY, never ALLOW.
7. **Lockout.** 3 failed attempts on one badge in 5 minutes -> DENY and flag for the operator.

`T_high`, `T_low` and the identity bands start at 0.85 / 0.40 / 95 and are tuned at the venue on our own recordings.

## 5. Step-up ladder (REQUEST VERIFICATION)

1. **Guided recapture** (about 2 s): fix the reported problem and retry the passive check.
2. **Random action** (about 3 s): one of turn left / turn right / blink, chosen at random and checked with face landmarks. The randomness is what beats a pre-recorded video.
3. **Rekognition Face Liveness** (about 5 to 8 s): confidence 85 or above, then identity match on its reference image.
4. Still failing -> DENY and send to the operator review queue.

The 2-second target applies to the passive decision. Step-up is slower by design, and we say so.

## 6. Test mode and metrics (highest value for judges)

A "test mode" switch in the app. Before each attempt the tester picks the ground truth: genuine, printed photo, phone photo, video replay, laptop/tablet replay, paper mask. Every attempt is logged with scores, decision and timings.

The results page opens with five headline numbers in HID's own format, each with its sample size:

- **Liveness detection accuracy**: correct live-or-spoof calls out of all attempts.
- **Face authentication accuracy**: correct same-person-or-not calls out of all identity attempts.
- **FAR**: spoofs or wrong people that got ALLOW.
- **FRR**: genuine enrolled users that got DENY.
- **Decision time**: typical and slowest.

Identity needs its own test: each member tries their own badge (should pass) and another member's badge (should fail).

Below the headline numbers, a per-scenario table:

| Column | Meaning |
|---|---|
| Attempts | sample size |
| Spoofs accepted (APCER) | false acceptance for that spoof type |
| Genuine rejected (BPCER) | false rejection |
| Sent to verification | step-up rate |
| Decision time p50 / p95 | from capture to decision |

Rules for honest numbers:
- Target about 30 attempts per spoof type and 60+ genuine attempts, across all team members and 3 lighting setups.
- Tune thresholds on one batch, report on a separate batch.
- With 0 errors in N tries, state the bound: "below 3/N at 95% confidence" (0 of 30 means below 10%).
- Report identity errors (wrong person accepted, right person rejected) separately from spoof errors.

## 7. Build order

Hours count from when building starts. Each stage ends with something demo-able.

| Hours | Stage | Done when |
|---|---|---|
| 0 to 0.5 | Repo, Vite React app, CDK stack skeleton, **measure Rekognition call times from Lambda** | App shows camera; timings known |
| 0.5 to 2.5 | **Core loop**: face landmarks + quality gate, MiniFASNet in browser, enrolment, Lambda identity search, decision engine | A real face gets ALLOW, a phone photo gets DENY, timer shows under 2 s |
| 2.5 to 4 | **Test mode + results page**, audit log in DynamoDB, DetectLabels rule, reason codes | Results table fills from live attempts |
| 4 to 5.5 | **Step-up**: guided recapture + random action | Dim lighting -> VERIFY -> action -> ALLOW |
| 5.5 to 7 | Rekognition Face Liveness step-up, operator dashboard, Haiku explanations, deploy to CloudFront | Hosted HTTPS link works |
| 7 to 8.5 | **Venue calibration and the real test run** (thresholds, all spoof types, all members) | Final numbers captured |
| 8.5 to end | Slides, demo rehearsal, backup screen recording | Demo runs twice cleanly |

**If behind, cut in this order:** Haiku explanations, moire check, operator dashboard polish, Face Liveness step-up. Never cut: core loop, test mode, results page with the five headline numbers, one working step-up, a tested mask attempt, kiosk screen polish.

Face Liveness moved later in the cut order: "use of APIs and integration architecture" is part of a 25% criterion, and it is our strongest AWS integration.

## 8. Team split (4 people)

- **A, detection:** MiniFASNet in the browser, landmarks, quality gate, moire / glare.
- **B, cloud:** CDK, Lambda, Rekognition collection, DynamoDB, decision engine, hosting.
- **C, app:** kiosk screen, enrolment, step-up flows, operator dashboard, timer.
- **D, evidence:** spoof props (prints, phone and laptop replays, and a mask: a printed face cut out with eye holes, curved over the face), test protocol, running attempts, slides and demo script.

## 9. Demo (4 minutes)

1. Genuine user -> ALLOW, timer under 2 s, broken down by stage.
2. Printed photo, phone photo, video replay -> DENY with reason codes. Hand a prop to a judge.
3. Dim light or partial cover -> REQUEST VERIFICATION -> random action -> ALLOW.
4. Results table with sample sizes and p95 time.
5. Operator view: audit log, lockout, "no face images stored".
6. Architecture and scale in one slide: the spoof check runs on each kiosk, so adding kiosks adds no load for it; identity runs on serverless AWS (Lambda, Rekognition, DynamoDB) that scales on its own.
7. Limits, stated plainly: plain webcam (HID uses multispectral hardware), small sample, 3D masks and camera injection only partly covered.

Presentation rules (15% of the score):
- Explain for a non-technical listener first. Example: "We check two things: is this a real person, and is it the right person. If we are not sure, we ask for one more proof instead of guessing."
- One slide per criterion, in the judges' order, so they can score as they listen.
- Prepare answers for: Why not just use AWS Face Liveness? What happens with a very good phone screen? What about masks and deepfakes? How does it scale to 1,000 doors? What do you store about my face? How did you get these numbers, and how big was the sample?

## 10. Words to use and avoid with HID engineers

- **Use:** presentation attack detection (PAD), bona fide, APCER / BPCER, passive-first with active step-up, edge processing, template not image, 1:1 verification, fail secure, reason codes, p95 decision time, "evaluated using ISO/IEC 30107-3 metrics".
- **Avoid:** "unspoofable", "100% accurate", "iBeta certified", "DPDP compliant", accuracy as the only number, blink detection presented as liveness.

## 11. Risks

| Risk | Mitigation |
|---|---|
| MiniFASNet input format is easy to get wrong (it needs BGR, 0 to 255, wide crop) | Check browser output against a Python reference on the same images in hour 1 |
| Thresholds tuned at a desk fail under auditorium lights | Calibrate at the venue; quality gate routes bad light to VERIFY |
| Venue Wi-Fi slows the Lambda call | Spoof check is local; show per-stage timer; phone hotspot as backup |
| Sharp phone screens fool the model | DetectLabels rule, moire check, step-up |
| Face Liveness component issues (single-use sessions, CDN assets) | Built last; random action step-up works without it |
| Sandbox credentials expire mid-build | Re-paste from Workshop Studio; takes one minute |
| Live demo fails | Backup screen recording made in the last hour |

## 12. Not yet verified

- Rekognition call times from Lambda (estimated 0.3 to 0.7 s). Measured in hour 0.
- MiniFASNet accuracy on our webcam and lighting. Vendor numbers come from other data.
- Whether DetectLabels reliably reports a phone or screen held near a face.
- The 30-day community scan returned little that was on topic; most findings come from AWS docs, vendor reports and model repositories.
