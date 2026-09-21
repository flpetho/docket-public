# Icon source

The `d.` wordmark, rendered from HTML by headless Chrome — no image pipeline, no
dependency, and the mark stays editable as text.

    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
      --disable-gpu --hide-scrollbars --window-size=512,512 \
      --default-background-color=0b0b0cff --virtual-time-budget=3000 \
      --screenshot=../icon-512.png "file://$PWD/icon-512.html"

Each size is rendered at its own scale rather than downscaled, so the small icon
keeps its hinting. Geist at 500, `--fg` for the `d`, `--accent` for the period.

Two things that cost a round trip: flex centring centres the *margin* box, so a
negative `margin-right` pushes the ink right, not left; and `letter-spacing`
applies after the final glyph too, so the line box is wider than the ink.
