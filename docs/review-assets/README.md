# Review assets — IRL Waypoint 0.0.1

Images for the Twitch Developer Console (Version Details). Where each one goes:
[docs/TWITCH_CONSOLE.md](../TWITCH_CONSOLE.md), §1 and §8.

| File | Pixels | Console field | What it shows |
| --- | --- | --- | --- |
| `logo-100x100.png` | 100 × 100 PNG | Logo Image | The app mark: an amber waypoint pin at the end of a teal walking route, on the dark map plate of the UI, with a faint street grid. No text, so it stays readable at the small sizes Twitch shows logos at. |
| `discovery-300x200.png` | 300 × 200 PNG | Discovery Image | The same pin-and-route mark on the left, the **IRL Waypoint** wordmark on the right ("IRL" in amber, "Waypoint" in white) and the line "Viewers pick the next stop". |
| `screenshot-1024x768.png` | 1024 × 768 PNG | Screenshots | The real overlay on the review channel: the open map of Phuket with a quoted destination, route, GTA$ price and balance. Captured from the running UI by the QA stage, not drawn. |

All artwork is original and uses only the extension's own palette
(`web/src/shared/theme.css`: plate `#07100d`, waypoint amber `#ffc247`, route
teal `#45e0c0`, text `#eef4f7` / `#9fb0ba`) and the pin shape of the app icon
(`web/public/icons/icon.svg`). There are no Twitch, Rockstar Games or Grand
Theft Auto logos, artwork or fonts; the wordmark is set in Segoe UI Bold.

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
