"""
迷你 MacCMS V10 mock —— 用于端到端测试采集链路
启动: python mock-maccms.py
访问: http://localhost:9999/api.php/provide/vod/?ac=detail&pg=1
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json

DATA = {
    "code": 1,
    "msg": "数据列表",
    "page": 1,
    "pagecount": 1,
    "limit": "20",
    "total": 2,
    "list": [
        {
            "vod_id": 1001,
            "vod_name": "测试电影：星际穿越",
            "vod_sub": "Interstellar",
            "type_id": 1,
            "type_name": "动作片",
            "vod_pic": "https://example.com/poster1.jpg",
            "vod_actor": "马修·麦康纳,安妮·海瑟薇",
            "vod_director": "克里斯托弗·诺兰",
            "vod_blurb": "一支探险队穿越虫洞寻找新家园",
            "vod_remarks": "HD",
            "vod_pubdate": "2014-11-07",
            "vod_total": 1,
            "vod_serial": "1",
            "vod_year": "2014",
            "vod_area": "美国",
            "vod_lang": "英语",
            "vod_content": "在不远的将来，地球面临严峻的环境危机...",
            "vod_play_from": "ckm3u8$$$kkm3u8",
            "vod_play_url": "正片$https://example.com/movie1.m3u8$$$正片$https://backup.com/movie1.m3u8",
            "vod_score": "9.3",
            "vod_time": "2026-04-26 12:00:00",
        },
        {
            "vod_id": 1002,
            "vod_name": "测试剧集：权力的游戏 第一季",
            "vod_sub": "Game of Thrones S1",
            "type_id": 2,
            "type_name": "电视剧",
            "vod_pic": "https://example.com/poster2.jpg",
            "vod_actor": "肖恩·宾,艾米莉亚·克拉克",
            "vod_director": "大卫·贝尼奥夫",
            "vod_blurb": "维斯特洛大陆的权力斗争",
            "vod_remarks": "全10集",
            "vod_pubdate": "2011-04-17",
            "vod_total": 10,
            "vod_serial": "10",
            "vod_year": "2011",
            "vod_area": "美国",
            "vod_lang": "英语",
            "vod_content": "维斯特洛七大王国的史诗故事...",
            "vod_play_from": "ckm3u8",
            "vod_play_url": "第1集$https://x.m3u8/s01e01.m3u8#第2集$https://x.m3u8/s01e02.m3u8#第3集$https://x.m3u8/s01e03.m3u8",
            "vod_score": "9.5",
            "vod_time": "2026-04-26 13:00:00",
        },
    ],
}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(DATA, ensure_ascii=False).encode("utf-8"))
    def log_message(self, *a): pass

if __name__ == "__main__":
    print("Mock MacCMS API on http://localhost:9999/api.php/provide/vod/")
    HTTPServer(("127.0.0.1", 9999), Handler).serve_forever()
