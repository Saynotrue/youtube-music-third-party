# Syncanto (vendored)

출처: https://github.com/alfzcore/Syncanto (MIT, 커밋 a7671f8)

lrclib에 가사가 없을 때 추가로 검색하는 가사 제공처 코드입니다.
원본 TypeScript를 CommonJS JavaScript로 컴파일해 필요한 파일만 넣었습니다.

- 사용하는 제공처: Musixmatch, Apple Music(lyrics.paxsenix.org 경유), NetEase, QQ Music, KuGou
- 수정한 부분: `providers/netease.js` — 원문 가사가 없을 때 중국어 번역 가사를 돌려주지 않도록 함
- 원본 라이브러리의 `getLyrics()`는 첫 검색 결과를 그대로 쓰므로 사용하지 않고,
  `search()` 결과를 server.js에서 가수/곡명/길이로 검증한 뒤 `getById()`로 가사를 가져옵니다.
