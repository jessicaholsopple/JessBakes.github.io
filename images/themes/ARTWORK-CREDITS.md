# Theme artwork — sources, licenses, credits

## Icons (35 of the 36 files below)

Every icon under `images/themes/icons/` **except `turkey.svg`** comes from
**Phosphor Icons** ("fill" weight), a professionally-designed, actively
maintained open-source icon library.

- Source: https://github.com/phosphor-icons/core
- License: **MIT** (full text below)
- Attribution: not required by the license; recorded here for provenance.
  The MIT notice is reproduced below to satisfy the license's "include the
  copyright notice" condition for redistributed copies.

Using one consistent, single-artist icon family (rather than mixing many
different illustrators' individual clip-art pieces, which is what Phase 1 of
this feature did and which read as dated/mismatched) is a deliberate choice
for visual cohesion. Each icon is a single-color shape applied via CSS
`mask-image`, so the *same* file is tinted with each theme's own accent
color (`--theme-accent` / `--theme-accent-2`) — no per-theme color variants
needed.

| File | Phosphor icon name |
|---|---|
| `icons/acorn.svg` | acorn |
| `icons/basket.svg` | basket |
| `icons/beach-ball.svg` | beach-ball |
| `icons/bell.svg` | bell |
| `icons/bird.svg` | bird |
| `icons/bone.svg` | bone |
| `icons/bowl-food.svg` | bowl-food |
| `icons/broom.svg` | broom |
| `icons/butterfly.svg` | butterfly |
| `icons/cat.svg` | cat |
| `icons/clover.svg` | clover |
| `icons/confetti.svg` | confetti |
| `icons/crown.svg` | crown |
| `icons/egg.svg` | egg |
| `icons/egg-crack.svg` | egg-crack |
| `icons/flag.svg` | flag |
| `icons/flower.svg` | flower |
| `icons/flower-tulip.svg` | flower-tulip |
| `icons/ghost.svg` | ghost |
| `icons/gift.svg` | gift |
| `icons/heart.svg` | heart |
| `icons/heart-straight.svg` | heart-straight |
| `icons/ice-cream.svg` | ice-cream |
| `icons/leaf.svg` | leaf |
| `icons/moon-stars.svg` | moon-stars |
| `icons/rabbit.svg` | rabbit |
| `icons/rainbow.svg` | rainbow |
| `icons/snowflake.svg` | snowflake |
| `icons/sparkle.svg` | sparkle |
| `icons/star.svg` | star |
| `icons/sun.svg` | sun |
| `icons/sunglasses.svg` | sunglasses |
| `icons/tree-evergreen.svg` | tree-evergreen |
| `icons/umbrella.svg` | umbrella |
| `icons/wind.svg` | wind |

### MIT License (Phosphor Icons)

```
MIT License

Copyright (c) 2023 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## The one non-Phosphor file: `icons/turkey.svg`

Phosphor's icon set has no turkey, and Thanksgiving reads much better with
one. This single file is kept from the original openclipart.org sourcing
pass:

| File | Title | Artist | Source | License |
|---|---|---|---|---|
| `icons/turkey.svg` | Thanksgiving Turkey | liftarn | https://openclipart.org/detail/319574 | CC0 1.0 |

CC0 1.0 (Creative Commons Zero / Public Domain Dedication) — free for any
use, including commercial, with no attribution legally required. It's a
single flat black silhouette (one `<path>`, no gradients or shading), which
is why it masks/recolors cleanly alongside the Phosphor icons instead of
looking out of place the way a fully-shaded cartoon illustration would.

## Attribution display

No on-site credit line is shown to visitors — Phosphor's MIT license and
the turkey silhouette's CC0 license both permit that. This file is the
repository's permanent record of provenance, kept up to date whenever theme
artwork changes.

## Design note: icon cluster, not clip art

Earlier revisions of this feature sourced full illustrated scenes and
frames from multiple different openclipart.org artists per theme (a bat
from one illustrator, a landscape from another, a turkey frame from a
third). Mixed together, that read as dated, mismatched clip art rather than
a designed theme. This revision instead builds every theme's seasonal
composition from a small, curated set (usually 5-6) of icons drawn from the
*same* single, modern, professionally-maintained icon family, arranged as a
scattered cluster and tinted with that theme's own palette. The only
intentional exception is the single Thanksgiving turkey silhouette above.
