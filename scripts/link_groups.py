#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Resolve data/groups.json against countries.geojson -> data/country_groups.json

groups.json maps Roblox group id -> name, but it uses ISO 3166 official names
("Iran, Islamic Republic of") while countries.geojson uses common names
("Iran"), so a naive lookup silently loses ~10% of nations. data/group_aliases.json
carries the exceptions; this script FAILS (exit 1) on any nation it cannot
resolve, so a newly added group with a mismatched name surfaces at build time
instead of quietly vanishing from the map.

Optionally enriches each group from the Roblox API (member count, icon, owner,
shout). That is strictly best-effort: the Roblox API does not send permissive
CORS headers so the browser cannot do it, but a failure here must never break
a deploy. Use --no-fetch to skip it entirely.

Runs on Python 2.7 and 3.x.

Usage:
    python scripts/link_groups.py [--no-fetch] [--limit N]
"""

from __future__ import print_function

import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'data')

# --- py2/py3 compat ------------------------------------------------------
try:
    from urllib.request import urlopen, Request
    from urllib.error import URLError, HTTPError
except ImportError:  # Python 2
    from urllib2 import urlopen, Request, URLError, HTTPError


def load(name):
    with open(os.path.join(DATA, name), 'rb') as fh:
        return json.loads(fh.read().decode('utf-8'))


def get_json(url, timeout=20, retries=4):
    """Roblox rate-limits hard (429). Back off and retry rather than dropping
    the record -- a dropped record means a nation silently loses its data."""
    req = Request(url, headers={'User-Agent': 'un-map/1.0 (+github pages build)'})
    delay = 1.0
    for attempt in range(retries):
        try:
            fh = urlopen(req, timeout=timeout)
            try:
                return json.loads(fh.read().decode('utf-8'))
            finally:
                fh.close()
        except HTTPError as exc:
            if getattr(exc, 'code', None) == 429 and attempt < retries - 1:
                time.sleep(delay)
                delay *= 2.5
                continue
            raise
    raise RuntimeError('unreachable')


# --- resolve -------------------------------------------------------------

def resolve():
    groups = load('groups.json')
    orgs = set(load('organizations.json'))
    aliases = load('group_aliases.json')
    merges = load('merges.json')
    geo = load('countries.geojson')

    # feature name -> feature id
    feature_ids = {}
    odd_ids = []
    for f in geo['features']:
        p = f['properties']
        feature_ids[p['name']] = p['id']
        # The id is what URLs and country_groups.json key on, so an
        # editor-generated placeholder ("drawn_3") silently produces share
        # links like #drawn_3. Warn rather than fail: it is cosmetic.
        if p['id'] != p['name']:
            odd_ids.append((p['id'], p['name']))
    if odd_ids:
        print('WARNING: %d feature(s) have an id that is not their name; '
              'share links will use the id:' % len(odd_ids), file=sys.stderr)
        for i, n in odd_ids:
            print('  - id=%r name=%r' % (i, n), file=sys.stderr)

    # dependency name -> parent name, from merges.json
    parent_of = {}
    for parent, children in merges.items():
        for child in children:
            parent_of[child] = parent

    countries, dependencies, organizations, unresolved = {}, {}, [], []

    for gid, raw_name in sorted(groups.items(), key=lambda kv: kv[1]):
        if raw_name in orgs:
            organizations.append({'name': raw_name, 'groupId': str(gid)})
            continue

        name = aliases.get(raw_name, raw_name)
        entry = {'groupId': str(gid), 'groupName': raw_name}

        if name in feature_ids:
            countries[feature_ids[name]] = entry
        elif name in parent_of:
            # A dependency merged into its parent (Jersey -> United Kingdom):
            # real group, no polygon of its own. Show it under the parent.
            parent = parent_of[name]
            parent_id = feature_ids.get(parent)
            if parent_id is None:
                unresolved.append((raw_name, 'parent %r not in geojson' % parent))
                continue
            dep = dict(entry)
            dep['name'] = name
            dependencies.setdefault(parent_id, []).append(dep)
        else:
            unresolved.append((raw_name, 'no matching feature (tried %r)' % name))

    organizations.sort(key=lambda o: o['name'])
    for deps in dependencies.values():
        deps.sort(key=lambda d: d['name'])
    return countries, dependencies, organizations, unresolved


# --- Roblox enrichment (best effort) -------------------------------------

def fetch_icons(ids):
    """Batched. Returns {groupId: imageUrl}. The tr.rbxcdn.com URLs it returns
    load fine as <img src> client-side; only pixel access is CORS-restricted."""
    out = {}
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        url = ('https://thumbnails.roblox.com/v1/groups/icons?groupIds=%s'
               '&size=150x150&format=Png&isCircular=false' % ','.join(chunk))
        try:
            for row in get_json(url).get('data', []):
                if row.get('state') == 'Completed' and row.get('imageUrl'):
                    out[str(row['targetId'])] = row['imageUrl']
        except Exception as exc:
            print('  ! icons batch failed: %s' % exc, file=sys.stderr)
    return out


def fetch_details_batch(ids):
    """Batched name/description/owner. v2 accepts up to ~100 ids per call and
    is far more forgiving than v1 -- but it omits memberCount entirely."""
    out = {}
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        url = 'https://groups.roblox.com/v2/groups?groupIds=%s' % ','.join(chunk)
        try:
            for d in get_json(url).get('data', []):
                info = {'robloxName': d.get('name')}
                owner = d.get('owner') or {}
                if owner.get('username'):
                    info['owner'] = {
                        'username': owner.get('username'),
                        'displayName': owner.get('displayName') or owner.get('username'),
                        'userId': owner.get('id') or owner.get('userId'),
                    }
                desc = (d.get('description') or '').strip()
                if desc:
                    info['description'] = desc[:600]
                out[str(d['id'])] = dict((k, v) for k, v in info.items() if v)
        except Exception as exc:
            print('  ! details batch failed: %s' % exc, file=sys.stderr)
        time.sleep(0.4)
    return out


def fetch_member_count(gid):
    """memberCount and shout live ONLY on v1/groups/{id}, which is not
    batchable and rate-limits aggressively (429 at ~7 req/s)."""
    d = get_json('https://groups.roblox.com/v1/groups/%s' % gid)
    info = {}
    if d.get('memberCount') is not None:
        info['memberCount'] = d['memberCount']
    shout = d.get('shout') or {}
    if shout.get('body'):
        info['shout'] = {
            'body': shout['body'][:400],
            'poster': (shout.get('poster') or {}).get('username'),
            'updated': shout.get('updated'),
        }
    return info


def apply_cache(entries, cache):
    """Copy a previous run's enrichment onto freshly resolved entries."""
    n = 0
    for e in entries:
        cached = (cache or {}).get(e['groupId'])
        if cached:
            e.update(cached)
            n += 1
    return n


def enrich(entries, limit=None, cache=None):
    """entries: list of dicts each having 'groupId'. Mutated in place.

    Anything already present in `cache` (a previous run's output) is reused, so
    repeated runs top up the gaps instead of re-hammering a rate-limited API."""
    cache = cache or {}
    by_id = {}
    for e in entries:
        by_id.setdefault(e['groupId'], []).append(e)
    ids = sorted(by_id.keys())
    if limit:
        ids = ids[:limit]

    # 1. Carry forward whatever a previous run already resolved.
    reused = apply_cache(entries, cache)
    if reused:
        print('Reused %d cached group record(s).' % reused)

    # 2. Icons - one batched call per 50, very reliable.
    print('Fetching icons for %d groups...' % len(ids))
    icons = fetch_icons(ids)
    for gid, url in icons.items():
        for e in by_id.get(gid, []):
            e['icon'] = url
    print('  got %d icons' % len(icons))

    # 3. Name/description/owner - batched.
    print('Fetching details (batched)...')
    details = fetch_details_batch(ids)
    for gid, info in details.items():
        for e in by_id.get(gid, []):
            e.update(info)
    print('  got %d detail records' % len(details))

    # 4. Member counts - one request each, so go slowly and back off properly.
    todo = [g for g in ids if not any(e.get('memberCount') for e in by_id[g])]
    print('Fetching member counts for %d groups (v1 is not batchable)...' % len(todo))
    ok = 0
    for n, gid in enumerate(todo, 1):
        try:
            info = fetch_member_count(gid)   # get_json handles 429 backoff
            if info:
                for e in by_id.get(gid, []):
                    e.update(info)
                ok += 1
        except Exception as exc:
            print('  ! group %s: %s' % (gid, exc), file=sys.stderr)
        if n % 25 == 0:
            print('  %d/%d' % (n, len(todo)))
        time.sleep(0.5)
    print('  member counts: %d/%d' % (ok, len(todo)))
    return ok


ENRICHED_FIELDS = ('robloxName', 'memberCount', 'owner', 'description', 'shout', 'icon')


def load_cache(path):
    """Previous output, as {groupId: {enriched fields}}."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, 'rb') as fh:
            prev = json.loads(fh.read().decode('utf-8'))
    except Exception:
        return {}
    cache = {}
    buckets = list(prev.get('countries', {}).values()) + prev.get('organizations', [])
    for deps in prev.get('dependencies', {}).values():
        buckets.extend(deps)
    for e in buckets:
        gid = e.get('groupId')
        if not gid:
            continue
        keep = dict((k, e[k]) for k in ENRICHED_FIELDS if e.get(k) is not None)
        if keep:
            cache[gid] = keep
    return cache


# --- main ----------------------------------------------------------------

def main(argv):
    do_fetch = '--no-fetch' not in argv
    limit = None
    if '--limit' in argv:
        limit = int(argv[argv.index('--limit') + 1])

    countries, dependencies, organizations, unresolved = resolve()

    n_dep = sum(len(v) for v in dependencies.values())
    print('Resolved %d nations, %d dependencies, %d organizations'
          % (len(countries), n_dep, len(organizations)))
    for parent_id, deps in sorted(dependencies.items()):
        print('  %s <- %s' % (parent_id, ', '.join(d['name'] for d in deps)))

    if unresolved:
        print('\nERROR: %d group(s) could not be resolved to a country:'
              % len(unresolved), file=sys.stderr)
        for name, why in unresolved:
            print('  - %s: %s' % (name, why), file=sys.stderr)
        print('\nAdd the name to data/group_aliases.json, data/organizations.json,'
              '\nor data/merges.json as appropriate.', file=sys.stderr)
        return 1

    path = os.path.join(DATA, 'country_groups.json')

    all_entries = list(countries.values()) + organizations
    for deps in dependencies.values():
        all_entries.extend(deps)
    cache = load_cache(path)

    if do_fetch:
        try:
            enrich(all_entries, limit, cache=cache)
        except Exception as exc:
            # Never fail a deploy because Roblox is down; the group LINK is the
            # part that actually matters and it needs no network to produce.
            print('Enrichment failed (%s) - keeping cached values.' % exc, file=sys.stderr)
            apply_cache(all_entries, cache)
    else:
        # Carry the previous run's data forward, otherwise --no-fetch would
        # quietly overwrite a fully enriched file with bare ids.
        n = apply_cache(all_entries, cache)
        print('Skipping Roblox fetch (--no-fetch); reused %d cached record(s).' % n)

    out = {
        'countries': countries,
        'dependencies': dependencies,
        'organizations': organizations,
        'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    blob = json.dumps(out, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'))
    if not isinstance(blob, bytes):
        blob = blob.encode('utf-8')
    with open(path, 'wb') as fh:
        fh.write(blob)
    print('\nWrote %s (%.1f KB)' % (path, os.path.getsize(path) / 1024.0))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
