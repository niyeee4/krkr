from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()

server = ThreadingHTTPServer(("0.0.0.0", 8081), Handler)
print("http://0.0.0.0:8080")
server.serve_forever()
