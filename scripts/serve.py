#!/usr/bin/env python
"""Dev server for the UN RP map.

Serves the repo over HTTP (like python -m http.server) and additionally accepts
POST /api/save with a FeatureCollection JSON body, which it writes to
data/countries.geojson so the editor can save directly into the project.

Runs on Python 2.7 and 3.x. Threaded, because the viewer fires several fetches
at once and a single-threaded server stalls on them. Sends no-cache headers so
an edited file shows up on reload instead of serving a stale copy.

Usage:  python scripts/serve.py [port]        (default 8091)
"""

from __future__ import print_function

import json
import os
import sys
from collections import OrderedDict

try:                                  # Python 3
    from http.server import SimpleHTTPRequestHandler, HTTPServer
    from socketserver import ThreadingMixIn
    from urllib.parse import urlparse
except ImportError:                   # Python 2
    from SimpleHTTPServer import SimpleHTTPRequestHandler
    from BaseHTTPServer import HTTPServer
    from SocketServer import ThreadingMixIn
    from urlparse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAVE_PATH = os.path.join(ROOT, 'data', 'countries.geojson')


class Handler(SimpleHTTPRequestHandler):
    # Python 2's handler has no `directory` argument, so both versions just
    # serve the process's working directory (set to ROOT in main below).
    protocol_version = 'HTTP/1.0'

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        SimpleHTTPRequestHandler.end_headers(self)

    def send_head(self):
        # Never answer 304; always hand back the file as it is on disk.
        for h in ('If-Modified-Since', 'If-None-Match'):
            if h in self.headers:
                del self.headers[h]
        return SimpleHTTPRequestHandler.send_head(self)

    def _json(self, code, payload):
        body = json.dumps(payload)
        if not isinstance(body, bytes):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlparse(self.path).path != '/api/save':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', 0) or 0)
            raw = self.rfile.read(length)
            if isinstance(raw, bytes):
                raw = raw.decode('utf-8')
            # OrderedDict so keys keep the order the editor sent them in.
            # Python 2 dicts are unordered, and re-serialising through one
            # shuffles every properties block, producing a huge git diff for
            # what may be a one-country edit.
            data = json.loads(raw, object_pairs_hook=OrderedDict)
            if not isinstance(data, dict) or 'features' not in data:
                raise ValueError('body is not a FeatureCollection')

            # Write via a temp file so an interrupted save cannot truncate the
            # only copy of the hand-edited source of truth.
            tmp = SAVE_PATH + '.tmp'
            blob = json.dumps(data, ensure_ascii=False)
            if not isinstance(blob, bytes):
                blob = blob.encode('utf-8')
            with open(tmp, 'wb') as f:
                f.write(blob)
            if os.path.exists(SAVE_PATH):
                os.remove(SAVE_PATH)
            os.rename(tmp, SAVE_PATH)

            print('saved %d features -> %s' % (len(data['features']), SAVE_PATH))
            self._json(200, {'ok': True, 'features': len(data['features'])})
        except Exception as e:
            print('save failed: %s' % e, file=sys.stderr)
            self._json(400, {'ok': False, 'error': str(e)})

    def log_message(self, *args):   # quiet
        pass


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
    os.chdir(ROOT)
    print('UN RP map dev server on http://localhost:%d' % port)
    print('  editor saves to %s' % SAVE_PATH)
    print('  Ctrl+C to stop')
    try:
        Server(('127.0.0.1', port), Handler).serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')


if __name__ == '__main__':
    main()
