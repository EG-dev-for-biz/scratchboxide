# VFX Thinking Mode: Negative Constraint Engineering

> **When to load:** Any task where a generative model (video, image, or motion) keeps producing an unwanted behavior despite positive prompt instructions — airborne objects, camera cuts, wrong anatomy, wrong orientation, reversed text, character name blocks, unintended morphs.

---

## The core idea

Generative models choose the **highest-probability path** given your input. If a failure mode keeps recurring, it means that failure is the highest-probability interpretation of your prompt. Positive instructions ("do X") compete with the model's priors. **Negative constraints** ("NEVER do Y") directly suppress the probability of specific outcomes, often more efficiently than adding more positive instruction.

Think of it as two separate dials:
- **Positive prompting** — describes what you want (raises probability of target)
- **Negative constraint engineering** — seals off failure modes (drops probability of specific unwanted outcomes)

Complex VFX shots often need both. Relying only on positive prompting leaves failure modes open.

In Scratchbox IDE, use `CONSTRAINT_SINGLE_TAKE`, `CONSTRAINT_NO_DRIFT`, `CONSTRAINT_NO_MORPH`, and `CONSTRAINT_NO_AIRBORNE` exported constants from `omniVideoPromptService.ts` plus `prependConstraints()` to place them in the correct position.

---

## Anatomy of an effective negative constraint block

```
CRITICAL INVARIANT — [FAILURE MODE NAME]:
- [Specific banned behavior, stated as an absolute]
- [Restatement from a different angle]
- [What MUST be true instead]
```

**Key principles:**
1. Name the failure mode explicitly — the model needs to know what category of behavior to avoid
2. State it as an absolute invariant, not a preference ("NEVER" / "AT NO POINT" / "ZERO" / "MUST NOT")
3. Restate it from 2–3 different angles — the model may interpret the same concept differently depending on wording
4. Follow with the positive form ("At every frame, X must be true") — this anchors what the constraint-satisfying state looks like

---

## Common VFX failure modes and their constraint blocks

### Airborne objects (card flips, product reveals)
```
CRITICAL INVARIANT — NO AIRBORNE FLIGHT:
- THE OBJECT MUST NEVER FLY, NEVER FLOAT, AND NEVER FLIP THROUGH THE AIR.
- AT NO POINT DOES THE OBJECT DETACH OR LEAVE THE SUBJECT'S HAND.
- THERE ARE ABSOLUTELY ZERO AIRBORNE FRAMES.
- At every single frame, the object remains firmly held, touched, and gripped.
```

### Camera cuts and editorial edits
```
CRITICAL REQUIREMENT — SINGLE CONTINUOUS UNINTERRUPTED TAKE WITH ZERO CUTS:
- Absolutely ZERO camera cuts throughout all [N] seconds.
- ZERO dissolves, ZERO jump cuts, ZERO camera angle changes.
- Completely locked-off static camera position throughout.
- The shot is one single continuous recording, never edited.
```

### Chirality / anatomy inversion
```
CRITICAL INVARIANT — RIGHT HAND THROUGHOUT:
- ALL ACTION IS PERFORMED BY ONE SINGLE RIGHT HAND.
- The thumb ALWAYS points to the LEFT in the dorsal phase.
- The forearm enters from the LOWER RIGHT, never the lower left.
- There is absolutely no left hand present at any point in the video.
```

### Object surface flipping (showing wrong face)
```
CRITICAL INVARIANT — FRONT FACE ONLY:
- The [object] MUST NEVER rotate to reveal its back face.
- ZERO frames show the [back surface / magnetic stripe / underside].
- The camera-facing surface is ALWAYS the front face throughout.
```

### Named entity / celebrity likeness blocks
When a model blocks on a real person's name, replace the named reference with:
- Precise **anatomical descriptors**: "muscular right hand", "index and middle fingers in a V"
- **Wardrobe descriptors**: "white compression sleeve on the wrist"
- **Kinematic descriptors**: "executing a three-point celebration pose"
- **Never**: the person's name, team name, or any identifiable proper noun

```
# BLOCKED
"[Athlete name]'s right hand in the celebration pose..."

# COMPLIANT
"An athletic basketball player's muscular right hand in a white compression sleeve,
 index and middle fingers extended vertically in a clear V separation, thumb pointing left..."
```

### Morphing / finger splay between poses
```
CRUCIAL MOTION CONSTRAINT:
- The fingers NEVER splay open between poses.
- The hand NEVER opens wide, dissolves, or morphs into a new configuration.
- Fingers stay under muscular tension throughout the entire transition.
- There is NO intermediate open-hand state between [pose A] and [pose B].
```

---

## Ordering in the prompt

Structure your prompt in this order for maximum effect:

```
1. [Shot description — what it is]
2. [CRITICAL REQUIREMENT — most important global constraint, e.g. single take]
3. [CRITICAL INVARIANT — object/anatomy constraints]
4. [CORE KINEMATICS — positive description of the action]
5. [MANDATORY — output specs (resolution, scale, framing)]
```

Place the most important constraints as early as possible. Models weight early tokens more heavily.

Use `prependConstraints(constraints, body)` from `omniVideoPromptService.ts` to enforce this ordering programmatically.

---

## Diagnosing which negative constraint to add

| Failure symptom | Root cause | Constraint to add |
|---|---|---|
| Object appears to fly or float | Model defaults to high-energy interpolation | `NO AIRBORNE FLIGHT` block |
| Camera cuts midway | Plate mismatch or model defaulting to editorial structure | `SINGLE CONTINUOUS TAKE` block + fix plates |
| Hand chirality flips | Dorsal→palmar transition probability | `RIGHT HAND THROUGHOUT` block |
| Object flips to wrong face | Unconstrained rotation | `FRONT FACE ONLY` block |
| Fingers splay open mid-transition | Model choosing lowest-energy pose path | `FINGERS NEVER SPLAY` block + add contact sheet stage |
| 400 `content_blocked` | Named entity in prompt text | Strip all proper nouns; use anatomical/kinematic descriptors |
| Prompt positive but model ignores it | Constraint not stated strongly enough | Escalate: "CRITICAL INVARIANT", "ABSOLUTELY", "ZERO", "MUST NOT", "AT NO POINT" |

---

## Anti-patterns

- **Burying the constraint** — placing it after 3 paragraphs of positive description. Move critical invariants to the top third of the prompt.
- **Soft language** — "please avoid" / "try not to" / "ideally". Use absolute language.
- **Single-angle statement** — stating the constraint only once in one phrasing. Restate from 2–3 angles.
- **No positive anchor** — stating only what not to do without anchoring what must be true instead. Always follow a negative with a positive form.
