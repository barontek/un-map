#!/usr/bin/env python3
"""Dev server for the UN RP map.

Serves the repo over HTTP (like python -m http.server) and additionally accepts
POST /api/save with a FeatureCollection JSON body, which it writes to
data/countries.geojson so the editor can save directly into the project.

Usage:  python3 scripts/serve.py [port]
"""
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAVE_PATH = os.path.join(ROOT, 'data', 'countries.geojson')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != '/api/save':
            self.send_error(404)
            return
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
            if not isinstance(data, dict) or 'features' not in data:
                raise ValueError('body is not a FeatureCollection')
            with open(SAVE_PATH, 'w') as f:
                json.dump(data, f)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True, 'features': len(data['features'])}).encode())
        except Exception as e:  # noqa: BLE001
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': False, 'error': str(e)}).encode())

    def log_message(self, *args):  # quiet
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
    print(f'UN RP map dev server on http://localhost:{port} (save -> {SAVE_PATH})')
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
