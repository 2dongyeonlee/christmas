# 정자동의 크리스마스 (christmas)

Cloudflare Worker 1개 = 페이지(public/app.html) + 저장 API(/api, D1).

## 최초 배포 (1회)
```bash
npm install
npx wrangler login                      # 브라우저에서 Cloudflare 로그인
npx wrangler d1 create christmas     # 출력된 database_id를 wrangler.toml에 붙여넣기
npx wrangler secret put ADMIN_KEY       # 관리자 키 입력 (초기화·편지 미리보기용)
npx wrangler deploy                     # → https://christmas.<계정>.workers.dev
```
- 선택: 모임 암호 `npx wrangler secret put GROUP_CODE` → 링크를 `?code=암호`로 공유
- 관리자 접속: `https://…/?admin=관리자키` (한 번 열면 그 브라우저에 저장, 주소창에서는 지워짐)

## 수정 후 재배포
`public/app.html` 교체 → `npx wrangler deploy`

## 저장 규칙 (서버에서 강제)
- people/{ID}: 처음 1회 생성, 이후엔 힌트만 수정 (열쇠 덮어쓰기 차단, 관리자 예외)
- notes: 추가만 가능, 최대 400통, 내용은 받는 사람 공개키로 암호화된 상태로만 저장
- draw/current: 단 1회 생성(동시 뽑기 차단), 초기화는 관리자만
- reveals/{ID}: 1회 기록, 초기화는 관리자만
