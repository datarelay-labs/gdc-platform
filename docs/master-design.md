# Generic Data Connector Platform Master Design

**Status:** SUPERSEDED  
**Superseded By:** [`docs/architecture/source-of-truth-index.md`](architecture/source-of-truth-index.md), [`PRODUCT-CHARTER v1.2.1`](source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt), [`docs/architecture/OSS-v1-ARCHITECTURE.md`](architecture/OSS-v1-ARCHITECTURE.md)

Do **not** use this document as Source of Truth. It predates PRODUCT-CHARTER v1.2.1, Destination First wizard, and Route Processing UX. Keep for historical runtime/entity design evidence only.

---

## 0. 문서 목적

이 문서는 **Generic Data Connector Platform** 프로젝트의 마스터 설계서이다.

이후 모든 설계, 구현, Cursor 프롬프트 작성, 기능 추가, 코드 리뷰, 아키텍처 변경 판단은 이 문서를 기준으로 한다.

이 프로젝트는 단순한 HTTP API 커넥터가 아니라, 장기적으로 다양한 Source에서 데이터를 수집하고, 이를 매핑·정규화·보강한 뒤, 여러 Destination으로 안정적으로 전달하는 경량 데이터 수집/전달 플랫폼을 목표로 한다.

---

# 1. 제품 개요

## 1.1 제품 정의

Generic Data Connector Platform은 외부 시스템으로부터 데이터를 수집하여 사용자 정의 규칙에 따라 파싱, 매핑, 보강한 뒤 Syslog 또는 Webhook 등으로 전달하는 웹 기반 경량 커넥터 플랫폼이다.

기본 흐름은 다음과 같다.

```text
Source → Parser → Mapper → Enrichment → Formatter → Router → Destination
```

초기 MVP는 HTTP API Polling 기반 수집에 집중한다.

향후에는 다음 Source까지 확장한다.

```text
- HTTP API Polling
- Database Query: Oracle, MySQL, PostgreSQL 등
- Webhook Receiver
```

Destination은 초기부터 다중 전송을 고려한다.

```text
- Single Syslog
- Multi Syslog
- Webhook
- Syslog + Webhook 동시 전송
```

---

## 1.2 최종 제품 목표

```text
외부 HTTP API, Database, Webhook Receiver로부터 데이터를 수집하고,
사용자가 정의한 필드 매핑 및 보강 규칙을 적용한 후,
Syslog 또는 Webhook으로 안정적으로 전달하는
경량 Source-to-Destination 데이터 커넥터 플랫폼 구축
```

---

## 1.3 제품 성격

이 제품은 Airbyte처럼 대규모 데이터 파이프라인을 목표로 하지 않는다.

목표는 다음과 같다.

```text
✔ 비전문가도 사용할 수 있는 UI
✔ 쉬운 배포
✔ Docker 기반 경량 운영
✔ 단일 관리자 구조
✔ API → Syslog/Webhook 빠른 연동
✔ 수집 데이터 유실 방지
✔ 운영 실패 로그 및 상태 추적
✔ 향후 DB/Webhook Receiver 확장 가능
```

---

# 2. 핵심 설계 철학

## 2.1 Source와 Destination 분리

절대 다음과 같이 설계하지 않는다.

```text
HTTP Connector → Syslog 설정
```

이 구조는 향후 DB Source, Webhook Receiver, Multi Destination 확장 시 무너진다.

반드시 다음 구조를 따른다.

```text
Source Adapter → Stream Runner → Mapping Engine → Destination Adapter
```

---

## 2.2 Connector와 Stream 분리

많은 보안 솔루션은 하나의 제품 안에 여러 API 엔드포인트를 가진다.

예: Cybereason

```text
- Malop API
- Hunting API
- Sensor API
- User API
```

각 API는 응답 구조, 주기, checkpoint, 필드 매핑, 중요도가 다르다.

따라서 Connector 하나에 모든 API를 억지로 넣지 않는다.

정확한 개념은 다음과 같다.

```text
Connector = 제품/인증/공통 설정 단위
Stream = 실제 데이터 수집 단위
```

예:

```text
Cybereason Connector
  ├─ Stream: Malop API
  ├─ Stream: Hunting API
  ├─ Stream: Sensor API
  └─ Stream: User API
```

---

## 2.3 실행 단위는 Stream

실제 polling, parsing, mapping, checkpoint, status, log는 Stream 단위로 관리한다.

```text
Connector는 논리 그룹
Stream은 실행 단위
```

예:

```text
Cybereason Connector: DEGRADED
  ├─ Malop Stream: RUNNING
  ├─ Hunting Stream: ERROR
  └─ Sensor Stream: STOPPED
```

하나의 Stream 실패가 반드시 Connector 전체 실패를 의미하지 않는다.

단, 인증 실패처럼 공통 Source 문제가 발생하면 Connector 또는 Source 전체가 ERROR 상태가 될 수 있다.

---

## 2.4 Mapping과 Enrichment 분리

단순히 API 필드를 추출하는 것만으로는 부족하다.

수신측 SIEM/XDR은 로그를 식별하기 위해 다음과 같은 정보를 필요로 한다.

```text
vendor
product
log_type
event_source
collector_name
tenant
source_category
```

따라서 pipeline은 다음 순서로 고정한다.

```text
Raw Event
  ↓
Field Mapping
  ↓
Enrichment / Static Field Injection
  ↓
Format Conversion
  ↓
Destination Send
```

---

## 2.5 Checkpoint는 전송 성공 후 갱신

가장 중요한 안정성 원칙이다.

```text
데이터 수집 성공 ≠ 처리 완료
데이터 파싱 성공 ≠ 처리 완료
Destination 전송 성공 = checkpoint 갱신 가능
```

전송 실패 시 checkpoint를 갱신하면 데이터 유실이 발생한다.

따라서 checkpoint는 반드시 Destination 전송 성공 후에만 갱신한다.

---

## 2.6 Multi Destination은 초기부터 고려

초기 MVP에서도 Destination을 단일 output 컬럼으로 만들면 안 된다.

처음부터 다음 구조를 고려한다.

```text
Stream
  ├─ Route → Syslog A
  ├─ Route → Syslog B
  └─ Route → Webhook C
```

향후 다음 요구를 만족해야 한다.

```text
✔ 단일 Syslog 전송
✔ 복수 Syslog 동시 전송
✔ Webhook 단독 전송
✔ Syslog + Webhook 동시 전송
✔ Destination별 실패 정책
✔ Destination별 rate limit
```

---

# 3. 핵심 개념 정의

## 3.1 Connector

Connector는 제품 또는 외부 시스템 연동 단위이다.

예:

```text
Cybereason
CrowdStrike
Custom API
Oracle Security DB
Custom Webhook Receiver
```

Connector는 다음을 가진다.

```text
- 이름
- 설명
- 상태
- 공통 인증 또는 Source 설정
- 하나 이상의 Source
- 하나 이상의 Stream
```

---

## 3.2 Source

Source는 데이터를 가져오는 방식이다.

지원 예정 Source Type:

```text
HTTP_API_POLLING
DATABASE_QUERY
WEBHOOK_RECEIVER
```

MVP에서는 HTTP_API_POLLING만 구현한다.

---

## 3.3 Stream

Stream은 실제 데이터 수집 단위이다.

HTTP API의 경우 API endpoint 하나가 보통 Stream 하나가 된다.

예:

```text
Cybereason Malop Stream
Cybereason Hunting Stream
Custom API Alerts Stream
```

Database의 경우 query 하나가 Stream 하나가 된다.

예:

```text
Oracle Security Events Query
MySQL Audit Table Query
```

Webhook Receiver의 경우 receiver endpoint 하나가 Stream 하나가 된다.

예:

```text
POST /ingest/webhook/cybereason/malop
```

---

## 3.4 Mapping

Mapping은 원본 데이터에서 필요한 필드를 추출하고 출력 필드명으로 변환하는 작업이다.

예:

```text
$.malop.id      → event_id
$.severity      → severity
$.machine.name  → host_name
$.user.name     → user_name
```

UI에서는 사용자가 JSONPath를 직접 작성하지 않아도 되도록 한다.

```text
✔ JSON Preview
✔ 클릭 기반 필드 선택
✔ 자동 JSONPath 생성
✔ Mapping 결과 미리보기
```

---

## 3.5 Enrichment

Enrichment는 수신측에서 로그를 식별하고 라우팅할 수 있도록 고정 필드 또는 계산 필드를 추가하는 기능이다.

예:

```json
{
  "vendor": "Cybereason",
  "product": "EDR",
  "log_type": "malop",
  "event_source": "cybereason_malop_api",
  "collector_name": "generic-connector-01",
  "tenant": "default"
}
```

이 기능은 MVP 필수 기능이다.

---

## 3.6 Destination

Destination은 데이터를 전달할 대상이다.

지원 대상:

```text
SYSLOG_UDP
SYSLOG_TCP
SYSLOG_TLS  향후
WEBHOOK_POST
```

---

## 3.7 Route

Route는 Stream과 Destination을 연결한다.

예:

```text
Malop Stream → Stellar Syslog
Malop Stream → SIEM Webhook
Hunting Stream → Stellar Syslog
```

Route는 다음 설정을 가진다.

```text
- enabled
- delivery_mode
- failure_policy
- rate_limit
```

---

# 4. 전체 아키텍처

```text
[Browser]
  ↓
[React UI]
  ↓
[FastAPI Backend]
  ├─ Auth
  ├─ Connector Manager
  ├─ Source Manager
  ├─ Stream Manager
  ├─ Mapping Manager
  ├─ Enrichment Manager
  ├─ Destination Manager
  ├─ Route Manager
  ├─ Scheduler
  ├─ Runner Engine
  ├─ Parser / Mapper
  ├─ Enrichment Engine
  ├─ Formatter
  ├─ Router / Fan-out Engine
  ├─ Destination Sender
  ├─ Rate Limiter
  ├─ Checkpoint Manager
  ├─ Log Manager
  └─ Runtime State Manager
  ↓
[DB]
```

---

# 5. Backend 모듈 구조

```text
app/
  main.py
  config.py
  database.py

  auth/
    router.py
    service.py
    security.py

  connectors/
    router.py
    service.py
    models.py
    schemas.py

  sources/
    router.py
    service.py
    models.py
    schemas.py

  streams/
    router.py
    service.py
    models.py
    schemas.py

  mappings/
    router.py
    service.py
    models.py
    schemas.py

  enrichments/
    router.py
    service.py
    models.py
    schemas.py

  destinations/
    router.py
    service.py
    models.py
    schemas.py

  routes/
    router.py
    service.py
    models.py
    schemas.py

  scheduler/
    scheduler.py
    locks.py

  runners/
    base.py
    http_runner.py
    db_runner.py              # 향후
    webhook_receiver.py       # 향후
    stream_runner.py

  pollers/
    http_poller.py

  parsers/
    jsonpath_parser.py
    event_extractor.py

  mappers/
    mapper.py

  formatters/
    json_formatter.py
    syslog_formatter.py

  delivery/
    router.py
    syslog_sender.py
    webhook_sender.py

  rate_limit/
    source_limiter.py
    destination_limiter.py

  checkpoints/
    service.py
    models.py

  logs/
    service.py
    models.py

  runtime/
    state.py
    errors.py
```

---

# 6. 실행 흐름

## 6.1 HTTP API Polling 실행 흐름

```text
Scheduler
  ↓
Stream Lock 획득
  ↓
StreamRunner.run(stream_id)
  ↓
Source Rate Limit 확인
  ↓
HTTP Poller.fetch()
  ↓
Raw Response 저장 또는 샘플링
  ↓
Event Extractor
  ↓
JSONPath Mapping
  ↓
Enrichment 적용
  ↓
Formatter 적용
  ↓
Router Fan-out
  ↓
Destination Rate Limit 확인
  ↓
Syslog/Webhook Send
  ↓
성공한 이벤트 기준 Checkpoint 갱신
  ↓
Logs / Metrics 기록
  ↓
Stream Lock 해제
```

---

## 6.2 Webhook Receiver 실행 흐름, 향후

```text
External System
  ↓
POST /ingest/webhook/{receiver_key}
  ↓
Webhook 인증 검증
  ↓
Stream 식별
  ↓
Event Extractor
  ↓
Mapping
  ↓
Enrichment
  ↓
Formatter
  ↓
Router
  ↓
Destinations
  ↓
Logs
```

Webhook Receiver는 polling이 없다.

---

## 6.3 Database Query 실행 흐름, 향후

```text
Scheduler
  ↓
StreamRunner
  ↓
DB Connection
  ↓
Query 실행
  ↓
Checkpoint 조건 적용
  ↓
Rows → Events 변환
  ↓
Mapping
  ↓
Enrichment
  ↓
Router
  ↓
Destinations
  ↓
Checkpoint 갱신
```

예:

```sql
SELECT * FROM security_events
WHERE updated_at > :last_checkpoint
ORDER BY updated_at ASC
LIMIT 1000;
```

---

# 7. Source 설계

## 7.1 HTTP API Source

MVP에서 구현할 Source이다.

지원 항목:

```text
- Base URL
- Method: GET/POST
- Headers
- Params
- Body
- Auth
- Timeout
- Retry
- Rate Limit
- Checkpoint variable 치환
```

예:

```json
{
  "base_url": "https://api.example.com",
  "auth_type": "bearer_token",
  "timeout_seconds": 30
}
```

Stream config 예:

```json
{
  "method": "GET",
  "endpoint": "/api/malops",
  "params": {
    "from": "{{checkpoint.last_timestamp}}"
  },
  "headers": {},
  "event_array_path": "$.data.items"
}
```

---

## 7.2 Database Source, 향후

지원 예정:

```text
- Oracle
- MySQL
- PostgreSQL
```

설정 예:

```json
{
  "db_type": "mysql",
  "host": "10.10.10.10",
  "port": 3306,
  "database": "security",
  "username": "collector",
  "password_ref": "credential_id"
}
```

Stream config 예:

```json
{
  "query": "SELECT * FROM events WHERE id > :last_id ORDER BY id ASC LIMIT 1000",
  "checkpoint_field": "id",
  "batch_size": 1000
}
```

---

## 7.3 Webhook Receiver Source, 향후

상대 시스템이 데이터를 보내는 구조이다.

지원 예정:

```text
- 고유 receiver URL 생성
- Shared Secret 검증
- Header token 검증
- Payload preview
- Mapping
- Destination routing
```

예:

```text
POST /ingest/webhook/{receiver_key}
```

---

# 8. Stream 설계

Stream은 실제 실행 단위이다.

Stream별로 다음이 독립적이어야 한다.

```text
- endpoint 또는 query 또는 receiver path
- polling interval
- parser 설정
- mapping 설정
- enrichment 설정
- checkpoint 설정
- route 설정
- status
- logs
- rate limit
```

예:

```text
Cybereason Connector
  Source: HTTP API
  Streams:
    - Malop API, 1분 주기
    - Hunting API, 5분 주기
```

---

# 9. Mapping 설계

## 9.1 Mapping 목적

Mapping은 원본 이벤트의 필드를 출력 이벤트 필드로 변환한다.

예:

```json
{
  "event_id": "$.id",
  "severity": "$.severity",
  "host_name": "$.machine.name",
  "user_name": "$.user.name",
  "description": "$.title"
}
```

---

## 9.2 Event Array Path

API 응답은 배열일 수도 있고 단일 객체일 수도 있다.

따라서 다음을 지원해야 한다.

```text
✔ event_array_path 설정 시 배열 추출
✔ event_array_path 없으면 single object 처리
✔ nested array 지원
```

예:

```json
{
  "event_array_path": "$.data.items"
}
```

---

## 9.3 JSONPath UX 정책

일반 사용자는 JSONPath를 모른다.

따라서 UI는 다음 기능을 제공해야 한다.

```text
✔ API Test
✔ JSON Preview
✔ 필드 클릭 선택
✔ 자동 JSONPath 생성
✔ 결과 미리보기
✔ 최종 이벤트 Preview
```

JSONata 같은 고급 표현식은 내부 엔진 또는 향후 고급 모드로만 고려한다.

기본 UI는 Mapping 기반이어야 한다.

---

# 10. Enrichment 설계

## 10.1 필요성

수신측 Syslog/SIEM/XDR은 로그를 수신할 때 IP, port, header, syslog tag, payload field 등을 기준으로 어떤 파서를 적용할지 결정한다.

API로 가져온 로그는 원본 그대로 보내면 수신측이 로그 종류를 인식하지 못할 수 있다.

따라서 전송 전 식별 필드를 추가해야 한다.

---

## 10.2 Enrichment 기능

지원 기능:

```text
✔ 고정 필드 추가
✔ vendor/product/log_type 추가
✔ event_source 추가
✔ collector_name 추가
✔ tenant 추가
✔ 기본값 설정
✔ 기존 필드 rename 또는 override 정책
```

예:

```json
{
  "vendor": "Cybereason",
  "product": "EDR",
  "log_type": "malop",
  "event_source": "cybereason_malop_api",
  "collector_name": "generic-connector-01",
  "tenant": "default"
}
```

---

## 10.3 Enrichment 적용 위치

```text
Raw Event
  ↓
Mapping
  ↓
Enrichment
  ↓
Formatter
  ↓
Destination
```

---

## 10.4 UI 구성

Mapping 화면에 다음 섹션을 둔다.

```text
Mapping UI
  ├─ Extract Fields
  ├─ Rename / Normalize Fields
  ├─ Add Static Fields
  └─ Preview Final Event
```

---

# 11. Formatter 설계

Formatter는 최종 이벤트를 Destination 전송 형식으로 변환한다.

MVP 지원:

```text
- JSON string
- Syslog message
```

향후 지원:

```text
- CEF
- LEEF
- Custom template
```

Syslog 전송 시 수신측 parser 식별을 위해 다음 요소를 설정할 수 있어야 한다.

```text
- syslog facility
- severity
- app_name
- hostname
- tag
- message prefix
- structured payload
```

예:

```text
<134>May 05 10:00:00 generic-connector cybereason_malop: {json payload}
```

---

# 12. Destination 설계

## 12.1 Destination Type

MVP 지원:

```text
SYSLOG_UDP
SYSLOG_TCP
WEBHOOK_POST
```

향후:

```text
SYSLOG_TLS
```

---

## 12.2 Syslog Destination 설정

```json
{
  "host": "10.10.10.100",
  "port": 514,
  "protocol": "udp",
  "facility": "local0",
  "severity": "info",
  "app_name": "generic-connector",
  "message_format": "json"
}
```

---

## 12.3 Webhook Destination 설정

```json
{
  "url": "https://receiver.example.com/events",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer {{credential.token}}"
  },
  "timeout_seconds": 30,
  "batch_size": 100
}
```

---

# 13. Route 설계

Route는 Stream과 Destination의 연결이다.

예:

```text
Malop Stream → Stellar Syslog
Malop Stream → Backup Syslog
Malop Stream → Webhook
```

Route별 설정:

```text
- enabled
- destination_id
- failure_policy
- rate_limit
- formatter override
```

---

## 13.1 Failure Policy

Destination별 장애 처리 정책을 지원한다.

```text
PAUSE_STREAM_ON_FAILURE
LOG_AND_CONTINUE
RETRY_AND_BACKOFF
DISABLE_ROUTE_ON_FAILURE
```

예:

```text
Primary Syslog 실패 → Stream Pause
Secondary Webhook 실패 → 로그만 남기고 계속
```

---

# 14. Checkpoint 설계

## 14.1 Checkpoint 목적

Checkpoint는 중복 수집과 데이터 유실을 방지한다.

---

## 14.2 Checkpoint Type

API마다 checkpoint 기준이 다르므로 Stream별 선택 가능해야 한다.

```text
TIMESTAMP
EVENT_ID
OFFSET
PAGE
CUSTOM_FIELD
NONE
```

---

## 14.3 Checkpoint 갱신 원칙

```text
✔ Destination 전송 성공 후에만 갱신
✔ partial success 시 성공한 이벤트까지만 갱신
✔ 실패 이벤트 이후 데이터는 다음 polling에서 재처리
```

---

## 14.4 Checkpoint 예

```json
{
  "type": "TIMESTAMP",
  "value": {
    "last_timestamp": "2026-05-05T10:00:00Z"
  }
}
```

```json
{
  "type": "EVENT_ID",
  "value": {
    "last_event_id": "abc-123"
  }
}
```

---

# 15. Rate Limit 설계

Rate Limit은 Source와 Destination 양쪽에 필요하다.

---

## 15.1 Source/API Rate Limit

API 제공자의 호출 제한을 보호하기 위한 기능이다.

지원 기능:

```text
✔ max requests per interval
✔ 429 처리
✔ Retry-After header 준수
✔ exponential backoff
✔ stream pause 정책
```

설정 예:

```json
{
  "max_requests": 60,
  "per_seconds": 60,
  "respect_retry_after": true,
  "on_429": "pause_stream",
  "backoff": {
    "type": "exponential",
    "initial_seconds": 5,
    "max_seconds": 300
  }
}
```

---

## 15.2 Destination Rate Limit

Syslog/Webhook 수신측 과부하를 방지하기 위한 기능이다.

지원 기능:

```text
✔ EPS 제한
✔ batch size
✔ burst
✔ throttle
✔ retry/backoff
```

설정 예:

```json
{
  "max_events": 100,
  "per_seconds": 1,
  "batch_size": 50,
  "burst": 200,
  "on_limit": "throttle"
}
```

---

## 15.3 상태

Rate limit 관련 상태:

```text
RATE_LIMITED_SOURCE
RATE_LIMITED_DESTINATION
```

---

# 16. 상태 설계

## 16.1 Connector 상태

```text
STOPPED
RUNNING
DEGRADED
ERROR
```

---

## 16.2 Stream 상태

```text
STOPPED
RUNNING
ERROR
PAUSED
PAUSED_SYSLOG_DOWN
RATE_LIMITED_SOURCE
RATE_LIMITED_DESTINATION
```

---

## 16.3 Route 상태

```text
ENABLED
DISABLED
ERROR
RATE_LIMITED
```

---

# 17. Error / Retry / Backoff 정책

## 17.1 API 실패

```text
HTTP timeout
HTTP 500
HTTP 429
Auth error
Invalid response
```

처리:

```text
retry → backoff → ERROR 또는 RATE_LIMITED_SOURCE
```

---

## 17.2 Destination 실패

```text
Syslog connection refused
Webhook timeout
Webhook 429
Webhook 500
```

처리:

```text
Route failure_policy 기준 처리
```

---

## 17.3 중복 실행 방지

Polling interval보다 처리 시간이 길어질 수 있다.

따라서 Stream별 lock이 필요하다.

```text
✔ stream mutex lock
✔ 실행 중이면 skip 또는 다음 주기 대기
✔ 중복 실행 금지
```

---

# 18. 로그 설계

## 18.1 로그 저장은 필수

실패 로그 저장은 필수 기능이다.

로그는 stage 기반으로 구조화한다.

---

## 18.2 로그 필드

```json
{
  "connector_id": 1,
  "stream_id": 10,
  "destination_id": 3,
  "route_id": 5,
  "stage": "webhook_send",
  "level": "ERROR",
  "message": "connection refused",
  "payload_sample": {},
  "retry_count": 2,
  "http_status": 500,
  "latency_ms": 1200,
  "error_code": "DESTINATION_CONNECTION_FAILED"
}
```

---

## 18.3 Stage 예

```text
source_fetch
source_rate_limit
parse
mapping
enrichment
format
route
syslog_send
webhook_send
checkpoint_update
```

---

# 19. DB 설계

## 19.1 connectors

```text
id
name
description
status
created_at
updated_at
```

---

## 19.2 sources

```text
id
connector_id
source_type
config_json
auth_json
enabled
created_at
updated_at
```

---

## 19.3 streams

```text
id
connector_id
source_id
name
stream_type
config_json
polling_interval
enabled
status
rate_limit_json
created_at
updated_at
```

---

## 19.4 mappings

```text
id
stream_id
event_array_path
field_mappings_json
raw_payload_mode
created_at
updated_at
```

---

## 19.5 enrichments

```text
id
stream_id
enrichment_json
override_policy
enabled
created_at
updated_at
```

---

## 19.6 destinations

```text
id
name
destination_type
config_json
rate_limit_json
enabled
created_at
updated_at
```

---

## 19.7 routes

```text
id
stream_id
destination_id
enabled
failure_policy
formatter_config_json
rate_limit_json
created_at
updated_at
```

---

## 19.8 checkpoints

```text
id
stream_id
checkpoint_type
checkpoint_value_json
updated_at
```

---

## 19.9 delivery_logs

```text
id
connector_id
stream_id
route_id
destination_id
stage
level
status
message
payload_sample
retry_count
http_status
latency_ms
error_code
created_at
```

---

## 19.10 credentials

```text
id
name
encrypted_value
created_at
updated_at
```

---

# 20. UI 설계

## 20.1 주요 화면

```text
Login
Dashboard
Connector List
Connector Detail
Source Config
Stream Config
API Test
JSON Preview
Mapping UI
Enrichment UI
Destination Config
Route Config
Logs
Runtime Status
```

---

## 20.2 Connector Detail 화면

```text
Connector: Cybereason

Sources
  - HTTP API Source

Streams
  [✓] Malop API
  [✓] Hunting API
  [ ] Sensor API

Destinations
  - Stellar Syslog
  - Backup Syslog
  - SIEM Webhook

Routes
  Malop → Stellar Syslog
  Malop → SIEM Webhook
  Hunting → Stellar Syslog
```

---

## 20.3 Mapping UX

```text
1. API Test 실행
2. JSON 응답 미리보기
3. 이벤트 배열 선택
4. 필드 클릭
5. 출력 필드명 지정
6. Enrichment 필드 추가
7. 최종 이벤트 Preview
8. 저장
```

---

## 20.4 Rate Limit UI

Stream 설정:

```text
API Rate Limit
  - max requests
  - interval seconds
  - 429 handling
  - Retry-After 사용 여부
  - backoff 설정
```

Destination/Route 설정:

```text
Send Rate Limit
  - EPS
  - batch size
  - burst
  - throttle policy
```

---

# 21. Auth / Security 설계

이 프로젝트는 멀티유저를 지원하지 않는다.

하지만 관리자 로그인은 필수이다.

지원 기능:

```text
✔ 단일 관리자 계정
✔ JWT 로그인
✔ JWT expiration
✔ API Key / Token 암호화 저장
✔ HTTPS는 reverse proxy에서 처리 가능
```

민감정보 저장:

```text
credentials.encrypted_value
```

암호화 방식:

```text
AES 또는 Fernet 기반 대칭키 암호화
```

---

# 22. 배포 설계

## 22.1 Docker Compose

```text
docker-compose
  ├─ frontend: React
  ├─ backend: FastAPI
  └─ db: SQLite 또는 PostgreSQL
```

초기 개발은 SQLite로 가능하다.

운영 확장 시 PostgreSQL을 권장한다.

---

## 22.2 운영 필수 항목

```text
✔ healthcheck endpoint
✔ restart policy
✔ log rotation
✔ persistent volume
✔ environment variable 기반 설정
```

실행:

```bash
docker compose up -d
```

---

# 23. MVP 범위

## 23.1 MVP에서 반드시 구현

```text
✔ 관리자 로그인
✔ Connector CRUD
✔ HTTP API Source
✔ Multi Stream
✔ API Test
✔ JSON Preview
✔ JSONPath Mapping
✔ Enrichment / Static Field 추가
✔ Destination CRUD
✔ Route 설정
✔ Syslog UDP 전송
✔ Syslog TCP 전송
✔ Webhook POST 전송
✔ Multi Destination Fan-out
✔ Source Rate Limit 기본 기능
✔ Destination Rate Limit 기본 기능
✔ Checkpoint
✔ 실패 로그
✔ Stream Start / Stop
✔ 상태 표시
```

---

## 23.2 MVP에서 제외하되 구조는 고려

```text
Database Source
Webhook Receiver Source
OAuth2
Pagination 고급 처리
CEF/LEEF
TLS Syslog
Template Connector
RBAC
Multi User
Audit Log
대규모 분산 큐
```

---

# 24. 향후 확장

## 24.1 Database Source

```text
Oracle
MySQL
PostgreSQL
```

기능:

```text
- query 기반 수집
- checkpoint column
- batch size
- polling interval
- DB credential 암호화
```

---

## 24.2 Webhook Receiver

```text
External System → Platform Receiver → Mapping → Destination
```

기능:

```text
- receiver URL 생성
- shared secret
- header token
- payload preview
- route 설정
```

---

## 24.3 Advanced Formatter

```text
CEF
LEEF
Custom Template
Syslog RFC5424
```

---

## 24.4 Template Connector

자주 쓰는 솔루션용 템플릿을 제공한다.

예:

```text
Cybereason Malop
Cybereason Hunting
CrowdStrike Detection
Custom REST API
```

템플릿은 다음을 포함한다.

```text
- Source config 예시
- Stream endpoint
- 기본 mapping
- 기본 enrichment
- 기본 syslog tag
```

**Authoritative target (English spec):** versioned **Source Packs**, Template Registry, Template Builder, compatibility and validation policy — `specs/049-template-registry/spec.md`. Phase 1 implementation remains `specs/013-template-connector-system/spec.md`.

---

# 25. 구현 우선순위

## Phase 1: Backend Skeleton

```text
FastAPI 프로젝트 구조
DB 연결
Auth
기본 모델
```

## Phase 2: Core Data Model

```text
Connector
Source
Stream
Mapping
Enrichment
Destination
Route
Checkpoint
Logs
```

## Phase 3: HTTP API MVP

```text
HTTP Poller
API Test
JSON Preview
StreamRunner
```

## Phase 4: Mapping / Enrichment

```text
JSONPath parser
Mapping engine
Static field injection
Final event preview
```

## Phase 5: Destination / Routing

```text
Syslog UDP/TCP
Webhook POST
Fan-out Router
Failure policy
```

## Phase 6: Scheduler / Runtime

```text
Polling scheduler
Stream lock
Start/Stop
Status update
Checkpoint
```

## Phase 7: UI

```text
Connector Wizard
Mapping UI
Enrichment UI
Destination/Route UI
Logs UI
```

## Phase 8: Docker

```text
Dockerfile
Docker Compose
healthcheck
persistent volume
```

---

# 26. Cursor 작업 원칙

Cursor에게는 이 설계서를 한 번에 구현하라고 시키지 않는다.

반드시 단계별 프롬프트로 나눈다.

권장 Cursor 프롬프트 순서:

```text
1. 프로젝트 스캐폴딩
2. DB 모델 및 마이그레이션
3. Auth 구현
4. Connector/Source/Stream CRUD
5. Destination/Route CRUD
6. HTTP API Test 기능
7. Mapping/Enrichment 엔진
8. StreamRunner 구현
9. Scheduler 구현
10. Syslog/Webhook Sender 구현
11. Checkpoint/Logs 구현
12. React UI 구현
13. Docker Compose 구성
14. End-to-End 테스트
```

Cursor 프롬프트 작성 시 원칙:

```text
✔ 한 번에 하나의 범위만 요청
✔ 기존 코드 변경 범위를 명확히 제한
✔ 설계서와 다른 구조 도입 금지
✔ Source/Stream/Destination/Route 개념 유지
✔ 단일 output 구조 금지
✔ checkpoint는 전송 성공 후 갱신
✔ mapping과 enrichment 분리
✔ rate limit은 source/destination 양쪽 고려
```

---

# 27. 절대 변경하면 안 되는 핵심 원칙

```text
1. Connector와 Stream은 분리한다.
2. Source와 Destination은 분리한다.
3. 실행 단위는 Stream이다.
4. Destination은 Multi Destination 구조로 설계한다.
5. Stream과 Destination 연결은 Route로 관리한다.
6. Mapping과 Enrichment는 분리한다.
7. Checkpoint는 Destination 전송 성공 후에만 갱신한다.
8. Source Rate Limit과 Destination Rate Limit을 모두 고려한다.
9. 실패 로그는 구조화해서 저장한다.
10. MVP는 HTTP API 중심이지만 DB/Webhook Receiver 확장을 막는 구조를 만들지 않는다.
```

---

# 28. 최종 요약

이 프로젝트는 처음에는 다음을 빠르게 구현한다.

```text
HTTP API Polling
  → JSONPath Mapping
  → Enrichment
  → Multi Syslog/Webhook Forwarding
```

하지만 구조적으로는 다음을 지원할 수 있어야 한다.

```text
HTTP API Polling
Database Query
Webhook Receiver
  → Mapping
  → Enrichment
  → Formatter
  → Multi Destination Routing
```

따라서 최종 제품 정의는 다음과 같다.

```text
Generic Data Connector Platform은
다양한 Source에서 데이터를 수집하거나 수신하고,
이를 사용자가 정의한 방식으로 매핑·보강한 뒤,
여러 Destination으로 안정적으로 전달하는
웹 기반 경량 Source-to-Destination 데이터 커넥터 플랫폼이다.
```

이 문서를 앞으로 프로젝트의 기준 설계서로 사용한다.

---

# Master Design Addendum: Mapping UI UX

## 9.4 Mapping UI UX (MVP Mandatory)

Mapping UI는 WebhookRelay 스타일의 직관적인 Payload Preview UX를 참고하여, 비개발자도 JSONPath를 직접 작성하지 않고 매핑할 수 있도록 설계한다.

MVP 필수 기능:

- Raw JSON Tree Preview
- JSON 노드 클릭 기반 JSONPath 자동 생성
- Output Field Mapping Table
- Mapping Preview
- Enrichment 포함 Final Preview
- Before / After Preview

기본 화면 구성:

좌측:

- Raw Payload JSON Tree
- 선택한 노드의 JSONPath 표시
- 원본 값 Preview

우측:

- Output Field Mapping Table
- output_field
- source_json_path
- sample_value
- required 여부
- default_value

하단:

- Raw Event Preview
- Mapped Event Preview
- Enriched Final Event Preview

필수 제약:

- JSONPath 수동 입력만 제공하는 UI 금지
- Preview 없는 Mapping UI 금지
- Final Preview는 실제 Destination 전송 payload와 동일해야 한다
- Mapping과 Enrichment는 UI에서도 분리해서 보여야 한다

## 9.5 Mapping UI Advanced UX (Phase 2)

다음 기능은 MVP 이후 Phase 2에서 구현한다.

- JSON Tree → Mapping Table Drag & Drop
- 드롭 시 자동 Mapping 생성
- hover highlight
- drop feedback UI
- 중복 mapping 경고
- overwrite / append 선택

금지사항:

- Drag & Drop 때문에 Mapping 데이터 구조 변경 금지
- 클릭 기반 JSONPath 생성 기능 제거 금지
- Drag & Drop을 MVP 필수 범위에 포함하지 않는다

## 20.x WebhookRelay 참고 UI 적용 요소

WebhookRelay에서 참고할 UI 요소:

- Webhook/Payload Preview 중심 UX
- 입력 Payload와 출력 Payload를 비교하는 Before / After 구조
- JSON payload 기반 필드 선택 UX
- 테스트 payload 기반 Preview
- 설정 저장 전 결과 검증 흐름

이 프로젝트에 적용할 방식:

- API Test 결과를 Mapping UI의 Raw Payload Preview로 바로 연결한다
- 사용자는 JSON Tree에서 필드를 클릭하여 JSONPath를 생성한다
- Mapping 결과와 Enrichment 결과를 단계별로 확인한다
- Destination 전송 전 최종 Payload를 Preview한다
- 설정 저장 전 Test Run으로 실제 전송 전 결과를 검증한다

후순위:

- Drag & Drop
- AI Transform
- Function Transform
- Public Relay/NAT UX

---

---

# UI/UX Philosophy

The platform UI must follow a modern SaaS observability/security operations dashboard style.

Target UX direction:

- Webhook Relay inspired operational UX
- Datadog / Grafana Cloud / Vercel style spacing and layout
- Clean professional SaaS admin portal
- Minimal and operator-focused
- Runtime visibility first
- Dashboard-centric navigation
- Responsive layout
- Component-based frontend architecture

Preferred frontend stack:

- React
- Tailwind CSS
- shadcn/ui
- lucide-react
- recharts

Avoid:

- Legacy enterprise UI style
- Dense table-only layouts
- Bootstrap admin templates
- Heavy gradients
- Consumer/mobile-app styling

# Dashboard UX Principles

The dashboard is the operational center of the platform.

The first screen must provide:

- Runtime health overview
- Active/error stream visibility
- Delivery success/failure summary
- Recent runtime activity
- Connector health
- Stream execution visibility
- Route delivery visibility

Operators should understand platform health within 5 seconds.

# Global Navigation Structure

Primary sidebar navigation order:

- Dashboard
- Connectors
- Sources
- Streams
- Mappings
- Enrichments
- Destinations
- Routes
- Runtime
- Logs
- Settings

Sidebar must:

- remain persistent
- support collapse
- support active highlighting
- use icon-based navigation

# Mapping UI UX Policy

Mapping UI must prioritize usability for non-developers.

Preferred UX:

- JSON tree explorer
- Click-to-select fields
- Auto JSONPath generation
- Split preview layout
- Live event preview
- Drag-and-drop field mapping in future phase
- Interactive mapping workflow

Avoid:

- raw JSONPath-only workflow
- text-heavy configuration screens
---

# PLUGIN_ADAPTER_ISOLATION_DESIGN

## Design Goal

The platform must allow new integrations such as S3, Database Query, Webhook Receiver, OAuth2, Kafka, or vendor-specific APIs without breaking already working HTTP/API/JWT connectors.

Therefore, all new integration logic must be isolated into plugin-style adapters.

## Required Backend Layout

~~~text
app/sources/adapters/
  base.py
  registry.py
  http_api.py
  s3.py
  database.py
  webhook_receiver.py

app/connectors/auth/
  base.py
  registry.py
  basic.py
  bearer.py
  api_key.py
  vendor_jwt_exchange.py
  s3_access_key.py
  s3_iam_role.py

app/destinations/adapters/
  base.py
  registry.py
  syslog_udp.py
  syslog_tcp.py
  webhook_post.py
~~~

## Runtime Responsibility

StreamRunner must only control the common pipeline:

~~~text
lock
rate limit
source adapter execution
event extraction
mapping
enrichment
formatting
routing
destination adapter execution
checkpoint update after successful delivery
structured logs
single transaction commit
~~~

StreamRunner must not contain vendor-specific, source-specific, auth-specific, or destination-specific implementation details.

## Additive Extension Policy

When adding a new integration type:

~~~text
1. Add a new adapter or strategy file.
2. Register the new type in the appropriate registry.
3. Add focused tests for the new type.
4. Run existing regression tests.
5. Do not modify existing working adapters unless explicitly required.
6. Do not change checkpoint, route, delivery, or transaction semantics.
~~~

## Cursor Safety Rule

Cursor prompts must explicitly state:

~~~text
Follow PLUGIN_ADAPTER_ISOLATION_POLICY.
Implement the requested integration as an isolated adapter/strategy.
Do not modify unrelated existing adapters.
Do not add source/auth/vendor-specific branching to StreamRunner.
Do not change existing working connector behavior.
~~~

# English-Only Product Language Policy

## Language Policy

All project code, UI screens, labels, menus, buttons, placeholders, validation messages, API responses, logs, comments, documentation strings, seed/mock data, and Skill Spec content MUST be written in English only.

Korean or other non-English text is allowed only in external user communication, temporary Cursor prompts, or archived conversation notes. It MUST NOT be committed into product code, runtime UI, API schema, database seed data, tests, screenshots, or official project specifications.

Any new feature, refactor, UI change, or test must verify that user-facing and developer-facing product text remains English-only.

