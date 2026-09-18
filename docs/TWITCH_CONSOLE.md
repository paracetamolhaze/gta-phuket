# Twitch Developer Console — values for IRL Waypoint 0.0.1

Everything to type into https://dev.twitch.tv/console/extensions for client id
`wjbmbxr2p39zcwwyybk3lt40zsks5x`, version **0.0.1**, field by field, in the
order the console shows them. Copy the values exactly. The reviewer notes are
in [TWITCH_REVIEW.md](../TWITCH_REVIEW.md).

Field names and rules come from Twitch's own documentation:
[Life Cycle Management](https://dev.twitch.tv/docs/extensions/life-cycle/),
[Submission Best Practices](https://dev.twitch.tv/docs/extensions/submission-best-practices/),
[Guidelines & Policies](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/)
(checked September 2026).

---

## 1. Version Details

| Field | Value |
| --- | --- |
| Name | `IRL Waypoint` |
| Summary | `Viewers pick a spot on a live map of Phuket and send the IRL streamer walking there.` |
| Description | the text in §1.1 below |
| Author Name | `Paracetamol` |
| General Category | `Viewer Engagement` |
| Game Category | *(empty — this is not a game extension)* |
| Author Email | `twitchacc11112@outlook.com` |
| Support Email | `twitchacc11112@outlook.com` |
| Privacy Policy URL | `https://gudinigta6.duckdns.org/privacy` |
| EULA / Terms of Service URL | `https://gudinigta6.duckdns.org/terms` |
| Logo Image | `docs/review-assets/logo-100x100.png` |
| Discovery Image | `docs/review-assets/discovery-300x200.png` |
| Screenshots | `docs/review-assets/screenshot-1024x768.png` |
| Taskbar Icon | `docs/review-assets/taskbar-24x24.png` (optional field; must be exactly 24 × 24 PNG) |

**Summary length.** Twitch documents no character limit for the Summary; the
only rule is *"It should be 1-2 brief sentences describing what your Extension
does"* (Life Cycle Management, "Summary"). The value above is one sentence of
84 characters. If the console's own counter ever refuses it, use the short
form (53 characters): `Send the IRL streamer to a spot on the map of Phuket.`

**General Category.** Twitch's list (Life Cycle Management, "General
Category") has eight options: Extension for Games, Games in Extensions,
Schedule and Countdowns, Polling and Voting, Loyalty and Recognition, Music,
Viewer Engagement, Streamer Tools. **Viewer Engagement** — *"Extensions that
provide different ways for viewers to engage, and do not fall into another
category"* — is the fit: viewers choose where the streamer walks. It is not a
game, not a poll, and GTA$ are a means to that end, not a loyalty or
leaderboard feature.

### 1.1 Description

The field takes plain text — no bullets, links or bold (Twitch Developer
Forums, [Description field too restrictive](https://discuss.dev.twitch.com/t/description-field-too-restrictive/20790)) —
so it is written as short paragraphs that still read well if the line breaks
are lost:

```text
IRL Waypoint puts a map of Phuket over an IRL stream. Viewers open it with the MAP button, search for a place or click it on the map, and see the walking route from the streamer's current position with the distance, the walking time and a price in GTA$.

GTA$ are points inside the extension, not money. Viewers get them only by redeeming the channel's Channel Points reward "Обмен ETH на GTA DOLLAR" (ETH is this channel's name for its Channel Points; 500 points give GTA$ 5 000). The redemption happens in Twitch's own Rewards menu and is credited automatically. There are no Bits and no real-money purchases.

With enough GTA$ a viewer sends the streamer to the chosen place in one click, and the route appears on the map for everyone. The streamer can always refuse a destination as impossible or unsafe; the GTA$ are then refunded in full.

The interface is in Russian. Sharing your Twitch identity is needed only for the GTA$ wallet; the map works without it. Made for one IRL channel in Phuket. Not affiliated with Rockstar Games or Take-Two Interactive.
```

---

## 2. Asset Hosting

| Field | Value |
| --- | --- |
| Testing Base URI | `https://gudinigta6.duckdns.org/` (must end with `/`; used by Local Test only — Hosted Test and review serve the uploaded zip) |
| Type of Extension | **Video - Fullscreen**, **Panel** and **Mobile** (not Video - Component) |
| Video - Fullscreen View Path | `video_overlay.html` |
| Mobile View Path | `mobile.html` |
| Panel Viewer Path | `panel.html` |
| Panel Height | `496` (px; the panel is 318 px wide and fits 318 × 496 without scrolling) |
| Config Path | `config.html` |
| Live Config Path | *(empty)* |

The paths are relative to the zip root: `web/scripts/check-extension-csp.mjs
--final` fails the build unless the three pages sit at the root of
`web/twitch-extension.zip`.

---

## 3. Capabilities

| Field | Value | Why |
| --- | --- | --- |
| Request Identity Link | **Yes** | The GTA$ wallet is keyed by the numeric Twitch user ID, the same ID Twitch sends with a Channel Points redemption. |
| Chat Capabilities | **No** | The extension never sends chat messages. |
| Bits | **No** | (Monetization tab, §4) |
| Configuration Service | **Custom / My Own Service** | Settings live in our backend; `Twitch.ext.configuration` is never used. |
| Required Configurations | *(empty)* | Nothing blocks activation. |
| Developer Writable Channel Segment | No | |
| Broadcaster Writable Channel Segment | No | |
| Allowlist for URL Fetching Domains | see below | |
| Allowlist for Image Domains | *(empty)* | Mapbox images arrive through `fetch`, never `<img>`. |
| Allowlist for Media Domains | *(empty)* | No audio or video. |
| Allowlisted Config URLs | `https://gudinigta6.duckdns.org/admin`<br>`https://gudinigta6.duckdns.org/privacy`<br>`https://gudinigta6.duckdns.org/terms` | `config.html` links to the owner's admin panel and to the two legal pages (new tab). |
| Allowlisted Panel URLs | *(empty)* | The panel opens no external links. |

**Allowlist for URL Fetching Domains**, one per line:

```text
https://gudinigta6.duckdns.org
wss://gudinigta6.duckdns.org
https://api.mapbox.com
https://events.mapbox.com
```

* `https://gudinigta6.duckdns.org` — our REST API (`/api/…`) and the
  Socket.IO long-polling fallback (`/socket.io/…`).
* `wss://gudinigta6.duckdns.org` — the Socket.IO WebSocket. Listed separately
  because CSP matches schemes strictly.
* `https://api.mapbox.com` — map style, vector tiles, fonts, sprites.
* `https://events.mapbox.com` — Mapbox GL's built-in telemetry.

---

## 4. Monetization

| Field | Value |
| --- | --- |
| Bits Support | **No** |
| Subscription Support | **No** |

GTA$ are obtained only through a Channel Points reward that the channel
itself owns; nothing in the extension is bought with money or Bits.

---

## 5. Files

Upload `web/twitch-extension.zip`, built from a clean checkout with:

```bash
npm ci
npm run ext:build -w web
```

The command prints the zip's size and SHA-256 and fails unless the final check
passes (see TWITCH_REVIEW.md §8). Do not zip `web/extension-build` by hand:
Windows' Compress-Archive writes `\` into entry names, which Twitch serves as
literal file names.

---

## 6. Access

| Field | Value |
| --- | --- |
| Testing Account Allowlist | `tiktokevelone888` (the review channel) and the owner's own account |
| Broadcaster allowlist for release | `tiktokevelone888` — recommended: this backend serves only channel 119989080 and refuses other channels' tokens |

---

## 7. Review submission

| Field | Value |
| --- | --- |
| Extension Review Channel URL | `https://www.twitch.tv/tiktokevelone888` |
| Walkthrough Guide and Change Log | sections 1, 2, 4 and 5 of TWITCH_REVIEW.md, then: `Full notes, glossary and build instructions: https://github.com/paracetamolhaze/gta-phuket/blob/master/TWITCH_REVIEW.md` (once pushed). Change log: `0.0.1 — first submission.` |
| Human-readable code | Yes. Our code is unminified; vendor libraries are unmodified published builds in their own files (TWITCH_REVIEW.md §8). Source: `https://github.com/paracetamolhaze/gta-phuket` |
| Test account | Not required. For a purchase test, write to `twitchacc11112@outlook.com` with the test account's login and it gets GTA$ credited (TWITCH_REVIEW.md §5). |

Before pressing **Submit for Review**:

1. The channel is live, and stays live for the review
   (*"All submitted review channels must be live during the time of review."*
   — Guidelines & Policies).
2. The backend runs with `REVIEW_DEMO_MODE=true` (Patong demo GPS), and the
   config page says the demo is on.
3. The exchange reward «Обмен ETH на GTA DOLLAR» is enabled on the channel
   (config page: Exchange Reward is OK).
4. `https://gudinigta6.duckdns.org/privacy` and `/terms` open from a phone on
   mobile data.

---

## 8. Asset files

| File | Pixels | Format | Bytes | Console field |
| --- | --- | --- | --- | --- |
| `docs/review-assets/logo-100x100.png` | 100 × 100 | PNG, RGB | 6 028 | Logo Image |
| `docs/review-assets/discovery-300x200.png` | 300 × 200 | PNG, RGB | 35 427 | Discovery Image |
| `docs/review-assets/taskbar-24x24.png` | 24 × 24 | PNG, RGBA | — | Taskbar Icon (optional) |
| `docs/review-assets/screenshot-1024x768.png` | 1024 × 768 | PNG  RGB | 192 170 | Screenshots (the real release bundle  map open  captured with headless Chrome) |

Twitch's requirements: logo *"must be a 100x100 PNG"*, discovery image *"must
be a 300x200 PNG"*, screenshots *"The minimum (and recommended) image size is
1024x768. Images must have a 4:3 aspect ratio."* (Life Cycle Management).
What each file shows and how it was made: [review-assets/README.md](review-assets/README.md).
