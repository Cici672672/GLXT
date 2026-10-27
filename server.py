#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
格砺学堂 · 单端口 HTTP 服务

为什么要它：
  平台默认的静态托管等价于 `python -m http.server`，只认磁盘上真实存在的文件。
  本项目用的是 #/xxx 哈希路由，但用户/分享链接经常把 # 前面的东西丢了
  （比如直接访问 /settings、/detail/16），静态托管就会吐一个英文 404 页。

  这个服务在找不到文件时，一律回落到 index.html（HTTP 200），
  由前端路由自己解析路径，于是任何地址都不会再出现 404。

只依赖标准库，监听 $PORT，绑定 0.0.0.0。
"""

import os
import posixpath
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(ROOT, "index.html")

# 静态资源缓存：HTML 必须每次回源，否则发版后用户还在看旧页面
NO_CACHE_EXT = (".html", ".htm")


class Handler(SimpleHTTPRequestHandler):
    server_version = "GeliXuetang/1.0"
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---------- 工具 ----------
    def _local_path(self):
        """把 URL 里的 path 映射成磁盘路径，拒绝越界。"""
        raw = self.path.split("?", 1)[0].split("#", 1)[0]
        try:
            from urllib.parse import unquote
            raw = unquote(raw)
        except Exception:
            pass
        # 规范化，去掉 ../ 之类
        clean = posixpath.normpath(raw)
        if not clean.startswith("/"):
            clean = "/" + clean
        rel = clean.lstrip("/")
        target = os.path.abspath(os.path.join(ROOT, rel)) if rel else ROOT
        if not (target == ROOT or target.startswith(ROOT + os.sep)):
            return None
        return target

    def _send_index(self, head_only=False):
        try:
            with open(INDEX, "rb") as f:
                body = f.read()
        except OSError:
            self.send_error(500, "index.html missing")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _serve_file(self, path, head_only=False):
        ext = os.path.splitext(path)[1].lower()
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            return self._send_index(head_only)
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", str(len(body)))
        if ext in NO_CACHE_EXT:
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        else:
            self.send_header("Cache-Control", "public, max-age=600")
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _redirect_to_hash(self, head_only=False):
        """把 /settings、/detail/16 这类「丢了 #」的地址，补成 /#/settings 再进站。"""
        raw = self.path.split("#", 1)[0]
        query = ""
        if "?" in raw:
            raw, query = raw.split("?", 1)
        location = "/#" + raw + (("?" + query) if query else "")
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    # ---------- 路由 ----------
    def do_GET(self):
        target = self._local_path()
        if target is None:
            return self._send_index()
        if os.path.isdir(target):
            idx = os.path.join(target, "index.html")
            if os.path.isfile(idx):
                return self._serve_file(idx)
            return self._send_index()
        if os.path.isfile(target):
            return self._serve_file(target)

        raw_path = self.path.split("?", 1)[0]
        if "." in raw_path.rsplit("/", 1)[-1]:
            # 真·静态资源缺失：老实报 404（不会影响页面路由）
            return self.send_error(404, "File not found")
        # 关键：无扩展名的路径一律当作前端路由，补 # 后 302，永不 404
        return self._redirect_to_hash()

    def do_HEAD(self):
        target = self._local_path()
        if target and os.path.isfile(target):
            return self._serve_file(target, head_only=True)
        raw_path = self.path.split("?", 1)[0]
        if "." in raw_path.rsplit("/", 1)[-1]:
            return self.send_error(404, "File not found")
        return self._redirect_to_hash(head_only=True)

    def log_message(self, fmt, *args):
        sys.stderr.write("[geli] %s\n" % (fmt % args))


def main():
    port = int(os.environ.get("PORT", "3000"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    sys.stderr.write("[geli] serving %s on 0.0.0.0:%d\n" % (ROOT, port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
