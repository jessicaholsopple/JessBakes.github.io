# Theme artwork — sources, licenses, credits

All artwork below was downloaded from **openclipart.org**. Every file on
OpenClipart is released by its uploading artist under the
**Creative Commons Zero 1.0 Universal (CC0 1.0) Public Domain Dedication**
— free for any use, including commercial, with **no attribution legally
required**. Artist names are recorded here anyway as a courtesy and for
provenance, per Jessica's request to track creator/source/license for every
asset actually used.

No AI-generated art, no hand-drawn icons authored for this project, no emoji,
and no generic icon-font glyphs are used anywhere in the Themes feature —
every image below is real, pre-existing artwork by a named illustrator.

SVGs whose original file was large (mostly dense leaf/snowflake/frame
illustrations) were rasterized to WebP at a size appropriate to where they're
displayed, using `sharp-cli`, to keep page loads fast. Everything else is
served as the original vector, optimized with `svgo`. Nothing is hotlinked —
every file below is a local copy checked into this repo.

| Local file | Title | Artist | Source | License |
|---|---|---|---|---|
| `halloween/hero-landscape.svg` | Halloween Landscape – Colour Remix | j4p4n (remix of a piece by inky2010) | https://openclipart.org/detail/354541 | CC0 1.0 |
| `halloween/accent-bat.svg` | Cute Bat | SunKing2 | https://openclipart.org/detail/334259 | CC0 1.0 |
| `halloween/accent-ghost.svg` | Cute Ghost | SunKing2 | https://openclipart.org/detail/334261 | CC0 1.0 |
| `halloween/accent-jack-o-lantern.svg` | Jack-o-lantern | TrueCryer | https://openclipart.org/detail/334013 | CC0 1.0 |
| `thanksgiving/hero-frame.webp` | Turkey Frame – Colour Remix | j4p4n | https://openclipart.org/detail/350485 | CC0 1.0 |
| `thanksgiving/accent-turkey.svg` | Thanksgiving Turkey | liftarn | https://openclipart.org/detail/319574 | CC0 1.0 |
| `thanksgiving/accent-leafy-frame.webp` | Leafy Frame 27 (colour) | Firkin | https://openclipart.org/detail/301742 | CC0 1.0 |
| `christmas/hero-tree.svg` | Christmas Tree | drdixieshaffer | https://openclipart.org/detail/339787 | CC0 1.0 |
| `christmas/accent-gift-box.svg` | Cartoon Gift Box 1 | rdragon | https://openclipart.org/detail/189390 | CC0 1.0 |
| `christmas/accent-holly.svg` | Holly | GDJ | https://openclipart.org/detail/221091 | CC0 1.0 |
| `valentines/hero-floral-heart.webp` | Floral Heart Frame | Firkin | https://openclipart.org/detail/297064 | CC0 1.0 |
| `valentines/accent-rose.webp` | Rose Frame – Colour | j4p4n | https://openclipart.org/detail/291026 | CC0 1.0 |
| `new_years/accent-fireworks-blue.webp` | Blue Fireworks | eady | https://openclipart.org/detail/104497 | CC0 1.0 |
| `new_years/accent-fireworks-green.webp` | Green Fireworks | eady | https://openclipart.org/detail/104503 | CC0 1.0 |
| `new_years/accent-confetti.svg` | Confetti | mi_brami | https://openclipart.org/detail/166721 | CC0 1.0 |
| `st_patricks/accent-clover.svg` | Four Leaf Clover | liftarn | https://openclipart.org/detail/1325 | CC0 1.0 |
| `easter/hero-bunny.svg` | Funny Baby Bunny Sitting on an Easter Egg | palomaironique | https://openclipart.org/detail/131749 | CC0 1.0 |
| `easter/accent-flower-corner.webp` | Flower Corner Variation Frame | GDJ | https://openclipart.org/detail/227762 | CC0 1.0 |
| `fourth_of_july/hero-patriotic-stars.svg` | Patriotic Stars | Prawny | https://openclipart.org/detail/194490 | CC0 1.0 |
| `autumn/hero-autumn-border.webp` | Autumn Border | Arvin61r58 | https://openclipart.org/detail/227730 | CC0 1.0 |
| `summer/hero-sun.svg` | Cool Happy Sun | mystica | https://openclipart.org/detail/147721 | CC0 1.0 |
| `summer/accent-umbrella.svg` | Beach Umbrella | Simanek | https://openclipart.org/detail/170003 | CC0 1.0 |
| `winter/hero-snowman-scenery.svg` | Snowman Glossy in Winter Scenery | gem | https://openclipart.org/detail/100807 | CC0 1.0 |
| `winter/accent-snowflake-frame.webp` | Snowflake – Colour Frame | j4p4n | https://openclipart.org/detail/282010 | CC0 1.0 |

Spring uses `easter/accent-flower-corner.webp` (the same Flower Corner Variation
Frame) as its own hero accent — the file lives under `easter/` because it was
sourced for Easter first, but `theme-apply.js` references it from both themes
rather than duplicating the file.

Christmas's "snow" is drawn with pure CSS (radial-gradient dot layers, not an
image asset), so there is no snow file to credit separately.

## Attribution display

Because every asset above is CC0 and requires no attribution, no on-site
credit line is shown to visitors. This file is the repository's permanent
record of provenance, kept up to date whenever theme artwork changes.

## Rejected candidates

A number of other OpenClipart pieces were downloaded and reviewed for this
project but rejected as visually mismatched, low quality, or (in one case)
flagged in its own title as AI-generated:

- id `345968` ("...ai-generated-stained-glass-christmas-tree...") — explicitly
  AI-generated per its own title; never downloaded for use.
- Assorted rejected candidates (black-and-white line art clashing with the
  chosen flat-color style, a busy paisley-pattern pumpkin, a caution-tape-style
  heart frame, images with baked-in English text in a mismatched font) were
  reviewed in a local scratch grid and discarded before any were added to this
  repo.
