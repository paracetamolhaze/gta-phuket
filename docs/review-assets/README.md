# Review assets — IRL Waypoint 0.0.1

Images for the Twitch Developer Console (Version Details). Where each one goes:
[docs/TWITCH_CONSOLE.md](../TWITCH_CONSOLE.md), §1 and §8.

| File | Pixels | Console field | What it shows |
| --- | --- | --- | --- |
| `logo-100x100.png` | 100 × 100 PNG | Logo Image | The app mark: an amber waypoint pin at the end of a teal walking route, on the dark map plate of the UI, with a faint street grid. No text, so it stays readable at the small sizes Twitch shows logos at. |
| `discovery-300x200.png` | 300 × 200 PNG | Discovery Image | The same pin-and-route mark on the left, the **IRL Waypoint** wordmark on the right ("IRL" in amber, "Waypoint" in white) and the line "Viewers pick the next stop". |
| `screenshot-1024x768.png` | 1024 × 768 PNG, RGB | Screenshots | The real video overlay with the map open: the top strip (close, search, `GTA$ 5 000` and **+ ПОПОЛНИТЬ**), the walking route from the streamer's teal arrow to the yellow destination diamond, and the destination card for "THE COFFEE CLUB - Jungceylon" (0.8 km, ~9 min, `GTA$ 900`, **ОТПРАВИТЬ СТРИМЕРА**). Captured from the running UI, not drawn (see below). |

All artwork is original and uses only the extension's own palette
(`web/src/shared/theme.css`: plate `#07100d`, waypoint amber `#ffc247`, route
teal `#45e0c0`, text `#eef4f7` / `#9fb0ba`) and the pin shape of the app icon
(`web/public/icons/icon.svg`). There are no Twitch, Rockstar Games or Grand
Theft Auto logos, artwork or fonts; the wordmark is set in Segoe UI Bold.

## The screenshot

`screenshot-1024x768.png` is a capture of the real extension, not a mock-up.
The UI screenshot harness (`tools/ui-shots`, dev-only, never in the zip)
builds the pages with a stand-in Twitch helper, runs them against an isolated
demo API (its own database, `REVIEW_DEMO_MODE=true`, so the streamer's
position is Patong Beach), and drives headless Chrome over CDP. For this file
the player page was 1024 × 768 without the OBS minimap
(`harness-player.html?obs=0`), the map was opened with **🗺 КАРТА**, and
"Jungceylon" was searched and its first result picked. The capture was saved
as RGB PNG with Pillow. `node tools/ui-shots/shoot.mjs --out after` makes the
full set of states (1280 × 720 and 1920 × 1080, mobile, Panel).

## Previews for the owner (not for the console)

`preview/` holds full-size captures of the redesigned map button and opened
map, from the same harness:

| File | What it shows |
| --- | --- |
| `preview/1-map-button-over-minimap-1920x1080.png` | Collapsed overlay at 1920 × 1080: the **🗺 КАРТА** button directly above the OBS minimap, flush with its left edge and exactly as wide. |
| `preview/2-task-pill-and-button-1920x1080.png` | The same while a waypoint runs: the «Задание · … · 0.8 км» label above the button, the route on the minimap. |
| `preview/3-map-with-destination-card-1280x720.png` | The opened map at 1280 × 720 with the route and the destination card. |
| `preview/4-top-up-dialog-1280x720.png` | The top-up window «ПОПОЛНЕНИЕ GTA$» open over the map. |

## Sources and how to regenerate

`source/logo.html` and `source/discovery.html` hold the artwork as inline SVG.
They were rendered with headless Chrome at 4× and scaled down with Pillow
(Lanczos), which gives clean anti-aliasing without coloured ClearType fringes:

```bash
CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe"
"$CHROME" --headless=new --disable-gpu --disable-lcd-text --hide-scrollbars \
  --force-device-scale-factor=4 --window-size=100,100 \
  --screenshot=logo@4x.png "file:///$PWD/source/logo.html"
"$CHROME" --headless=new --disable-gpu --disable-lcd-text --hide-scrollbars \
  --force-device-scale-factor=4 --window-size=300,200 \
  --screenshot=discovery@4x.png "file:///$PWD/source/discovery.html"

python -c "
from PIL import Image
for src, dst, size in [('logo@4x.png', 'logo-100x100.png', (100, 100)),
                       ('discovery@4x.png', 'discovery-300x200.png', (300, 200))]:
    Image.open(src).convert('RGB').resize(size, Image.LANCZOS).save(dst, optimize=True)
"
```

Check the sizes before uploading:

```bash
python -c "from PIL import Image; import glob; [print(f, Image.open(f).size) for f in sorted(glob.glob('*.png'))]"
```
