# Basemap of the Research Footprint Map

Two GeoJSON files that `assets/js/map.js` draws as SVG paths, so the map loads nothing
from a tile server or any other third party.

| File | Drawn at | Loaded | Bytes (raw) | Bytes (gzip -9) |
|---|---|---|---|---|
| `world-110m.json` | zoom 2-3 | with the map (`map-loader.js` starts it with Leaflet) | 86,272 | 31,050 |
| `world-50m.json` | zoom 4-7 | on the first zoom | 395,940 | 132,028 |

Budget: initial download at most 150 KB raw and 60 KB gzip; both files together at most
500 KB raw (482,212 together).

Each file is one `FeatureCollection` with a `meta` member and four features in drawing order,
told apart by `properties.class`:

| `class` | Geometry | Source layer | CSS class (map.js) |
|---|---|---|---|
| `land` | MultiPolygon | `ne_*_land` | `.map-land` |
| `lake` | MultiPolygon | `ne_*_lakes` | `.map-lake` |
| `border` | MultiLineString | `ne_*_admin_0_boundary_lines_land`, `FEATURECLA` "International boundary (verify)" | `.map-border` |
| `border-disputed` | MultiLineString | the same layer, every other `FEATURECLA`: "Disputed (please verify)", "Line of control (please verify)", "Indefinite (please verify)", "Indeterminant frontier", "Claim boundary" | `.map-border.map-border--disputed` |

map.js also derives coastlines (`.map-coast`) from the land rings, leaving out the edges
Natural Earth adds along the antimeridian and the South Pole, when the CSS gives
`.map-coast` a stroke.

## Source

Natural Earth v5.1.2 (released 2022-05-13), GeoJSON from the `geojson/` folder of
github.com/nvkelso/natural-earth-vector at tag `v5.1.2`, commit
`f1890d9f152c896d250a77557a5751a93d494776`. Downloaded 2026-11-05. The git blob SHA of each
download matched the repository tree at that commit (GitHub contents API).

| File | Bytes | SHA-256 |
|---|---|---|
| `ne_110m_land.geojson` | 138,160 | `9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9` |
| `ne_110m_lakes.geojson` | 36,648 | `eb02ecc86c82004fccbf979058bfabbbd6c2d07968c7844d38eb1c9152d2ffc9` |
| `ne_110m_admin_0_boundary_lines_land.geojson` | 340,010 | `d42479fd79552cca4eec7f85fcdca717a790d29ff06be7676f1af0568c6d3f7c` |
| `ne_50m_land.geojson` | 1,636,166 | `e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b` |
| `ne_50m_lakes.geojson` | 876,018 | `d350b75978b26fe839b797c2c529b2fb8f47fb3983c03f4964e36d5df9378a52` |
| `ne_50m_admin_0_boundary_lines_land.geojson` | 760,189 | `2faac4f6b34386f3d21b6e018cf151f241f00e5c936d44dd17d7d9bfb147fa48` |

Download into a new, empty folder (the files are data: parse them, never run them):

```bash
SHA=f1890d9f152c896d250a77557a5751a93d494776
for f in ne_110m_land ne_110m_lakes ne_110m_admin_0_boundary_lines_land \
         ne_50m_land ne_50m_lakes ne_50m_admin_0_boundary_lines_land; do
  curl -fsS -o "$f.geojson" "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/$SHA/geojson/$f.geojson"
done
```

## License

Public domain. From `LICENSE.md` at the commit above and from
naturalearthdata.com/about/terms-of-use/ (both read 2026-11-05): "All versions of Natural
Earth raster + vector map data found on this website are in the public domain. You may use
the maps in any manner, including modifying the content and design, electronic
dissemination, and offset printing." and "No permission is needed to use Natural Earth.
Crediting the authors is unnecessary." The map credits "Natural Earth" in its attribution
anyway, next to Leaflet.

## Boundaries

Natural Earth's default view: "Natural Earth's editorial policy is to show political
boundaries according to their de facto status. We show disputed areas and boundaries, too,
so you can repurpose to suit your needs." (naturalearthdata.com/about/disputed-boundaries-policy/,
read 2026-11-05). The files keep that default (`FEATURECLA`), not one of the
point-of-view columns (`FCLASS_*`); every non-international class is drawn dashed.

## Build

```bash
ruby scripts/build_basemap.rb PATH/TO/DOWNLOADS        # writes assets/data/basemap/world-*.json
ruby scripts/build_basemap.rb PATH/TO/DOWNLOADS --output /tmp/check   # anywhere else
```

Ruby standard library only (3.3 or later). The script checks every source against the
SHA-256 above (`--no-verify` skips that, for a newer Natural Earth release: then update
`SOURCES` in the script and this file). The output depends only on the inputs and the
script's constants; two builds give byte-identical files:

| Output | SHA-256 |
|---|---|
| `world-110m.json` | `1e15759e7d41281d0e809683b12e72899d24b544079606c88844d27c8eb5af56` |
| `world-50m.json` | `d5d250f16660b013d25d22b0673bf04cdd676b90802c57f7ec44fb55986174f5` |

What it does, per scale:

1. Weighted Visvalingam-Whyatt simplification (effective area, weighted by the vertex angle
   so spikes go first), measured in Web Mercator pixels at the highest zoom the file is
   drawn at: zoom 3 for 1:110m, zoom 7 for 1:50m. Thresholds (px²): land 6, lakes 6, lines 8
   at 1:110m; land 190, lakes 380, lines 120 at 1:50m.
2. Finer detail around the pins, where cluster and off-screen moves land: thresholds are
   multiplied by 0.4 (1:110m) or 0.2 (1:50m) inside four boxes (Europe with the
   Mediterranean and the Aegean coast; Korea; Auckland and the north of New Zealand; the US
   Southwest), rising to 1 over 4° outside them. Poleward of 50° the thresholds grow with
   the Web Mercator stretch, at most threefold. A pin added far from the boxes gets the
   standard detail until `DETAIL_BOXES` in the script is extended and the files rebuilt.
3. Never removed: vertices on the antimeridian (the pieces Natural Earth cut at 180° still
   meet), line endpoints, and both vertices of the coast or lake-shore segment where a
   boundary line ends (289 such vertices at 1:110m, 311 at 1:50m), so boundaries still end
   on the coast.
4. Coordinates rounded to 0.01°; repeated points dropped; rings smaller than 2 px² (1:110m,
   lakes 3 px²) or 60 px² (1:50m, lakes 380 px²) dropped, and small rings that came out as
   slivers or self-intersecting.

| Points | land | lakes | borders | disputed |
|---|---|---|---|---|
| 1:110m, source -> output | 5,143 -> 3,701 | 465 -> 205 | 2,952 -> 1,832 | 156 -> 101 |
| 1:50m, source -> output | 60,669 -> 18,715 | 19,778 -> 1,412 | 18,955 -> 6,468 | 904 -> 288 |

The 500 KB budget is what limits 1:50m: outside the boxes, coastlines at zoom 6-7 are
visibly generalized (northern Norway, for example), inside them they stay close to the
source.
