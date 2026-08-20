# UN World Map

Interactive map for the Roblox Model United Nations community. Every nation is
clickable and shows its status, its Roblox group, member count and description.

No build step, no npm, no framework — plain HTML/CSS/JS with Leaflet from a CDN.

---

## Running it locally

```bash
python scripts/serve.py 8091
```

Then open <http://localhost:8091>. Works on Python 2.7 and 3.x.

`serve.py` also accepts `POST /api/save`, which is how the editor writes back to
`data/countries.geojson`. It binds to `127.0.0.1` only, so it is not reachable
from other machines.

> `serve.sh` is a Linux/macOS convenience wrapper around the same script.

---

## How the map works

`map.png` **is** the coordinate system. It is 2753×1399, and every country
polygon in `data/countries.geojson` is stored in those pixel units, drawn with
Leaflet's `CRS.Simple`. There is no real-world projection involved.

Three render modes, in the top-right control:

| Mode | What it draws |
|---|---|
| **Vector** (default) | Smooth polygons on a dark ocean. Crisp at any zoom. |
| **Pixel** | The same polygons snapped to whole pixels, matching the blocky look of the original artwork. |
| **Classic** | The original `map.png` with a translucent interactive layer on top. |

Countries smaller than 10 px² (San Marino, Nauru, …) are too small to click, so
they render as labelled markers instead.

---

## Editing the map

Open <http://localhost:8091/editor.html> with the dev server running.

- Click a country to edit only its borders and vertices.
- Change its name or status in the properties panel, then **Apply**.
- **Export GeoJSON** saves straight back to `data/countries.geojson`.

The editor is deliberately **not deployed** — the Pages workflow copies an
explicit file list that excludes it.

`data/countries.geojson` is the hand-edited source of truth. Everything else in
`data/` is either an input to the scripts or generated from it.

---

## Adding a nation's Roblox group

1. Add the group id and nation name to `data/groups.json`:

   ```json
   "784829105": "Russian Federation"
   ```

2. Regenerate the lookup:

   ```bash
   python scripts/link_groups.py
   ```

If the name does not match a country on the map, the script **fails and tells
you which one**, rather than letting the nation quietly lose its group. Fix it
by adding an entry to one of:

- `data/group_aliases.json` — the name is spelled differently on the map
  (`"Iran, Islamic Republic of"` → `"Iran"`). Eight of these already exist.
- `data/organizations.json` — it is an organisation, not a nation (NATO, the
  African Union, …). These appear in the Organizations section instead.
- `data/merges.json` — it is a dependency folded into a parent country
  (Jersey → United Kingdom). These appear under the parent.

3. Commit the updated `data/country_groups.json`.

### Why that file is committed

Member counts come from `groups.roblox.com/v1/groups/{id}`, which is **not
batchable and rate-limits aggressively** — a from-scratch fetch only lands about
60% of them. `link_groups.py` therefore treats the existing file as a cache and
only fetches what is missing, and the committed copy guarantees the deployed
site has complete data even if Roblox is unreachable during a deploy.

Re-run `python scripts/link_groups.py` any time to refresh; run it a second
time if some counts are still missing.

---

## Deploying

Push to `master` (or `main`). `.github/workflows/deploy.yml` then:

1. Runs `link_groups.py` — validates the group join, tops up anything missing.
2. Runs `simplify_geojson.py` — 1.75 MB → ~480 KB (~150 KB gzipped).
3. Copies the public file list into `public/` and verifies nothing is missing.
4. Publishes to GitHub Pages.

A weekly scheduled run refreshes member counts on the live site.

**If you add a new front-end file, add it to the `cp` line in that workflow** —
it copies an explicit list, so anything not named there simply will not deploy.

---

## Layout of the repo

```
index.html      the viewer
app.js          all viewer logic
config.js       shared constants: image size, status colours and labels
styles.css      the whole theme (design tokens live in :root)
map.png         the original artwork, 2753×1399

editor.html     border/status editor (local only, not deployed)
editor.js

data/
  countries.geojson       source of truth, hand-edited via the editor
  countries.min.geojson   generated at deploy time (gitignored)
  groups.json             Roblox group id -> nation name
  group_aliases.json      spelling differences between the two files above
  organizations.json      entries that are organisations, not nations
  merges.json             dependencies folded into a parent country
  country_groups.json     generated + committed; the joined, enriched lookup
  status_overrides.json   manual status assignments (build_data.py input)
  markers.json            optional event pins; empty by default
  calibration.json        SVG -> PNG pixel fit (build_data.py input)

scripts/
  serve.py                dev server with the editor's save endpoint
  link_groups.py          joins groups.json to the map, enriches from Roblox
  simplify_geojson.py     shrinks the geometry for the web
  build_data.py           regenerates countries.geojson from an external SVG
```

---

## Changing the look

Every colour lives in the `:root` block at the top of `styles.css`. Status
colours are the one exception — they live in `STATUS_META` in `config.js`,
because the editor needs them too, and are applied to the legend and map at
runtime.

Changing a status colour or label means editing `config.js` only.

---

## URLs

- `#Japan` — opens with that nation selected and framed.
- `?status=sc` — opens with the Security Council filter applied.
- Both combine: `?status=p5#France`.

The **Copy link** button in a nation's panel produces one of these.
