# Cross-Product Report

Generated: 2026-08-14T10:04:26.547Z

## Counts
- Candidates (unique): 40428
- Candidate emissions (raw): 42228
- Duplicate emissions: 1800
- Valid: 35484
- NOT_APPLICABLE: 4944
- NOT_IMPLEMENTED combinations: 0
- Equation OK (C = V + NA + NI): true
- Browser: 15270
- API: 20214
- route-off: 4818
- route-on: 30666
- combination_id_set_hash: `8285aec76000366b242ed98222eeea2b16afc3f3e2567ea6be32c4fec18ce6b6`

## NOT_IMPLEMENTED suite IDs (frozen 20)
- auth__auth-destination-webhook-headers__status-partial
- dest__destination-ai-provider-post__partial
- governance__audit__review__api__route-off
- governance__audit__review__api__route-on
- governance__governance-delivery-require-review__partial
- governance__hash__review__api__route-off
- governance__hash__review__api__route-on
- governance__mask__review__api__route-off
- governance__mask__review__api__route-on
- governance__remove__review__api__route-off
- governance__remove__review__api__route-on
- governance__tokenize__review__api__route-off
- governance__tokenize__review__api__route-on
- processing__processing-enrichment-lookup__partial
- route__routes-per-route-protection-classification-policy__partial
- route__routes-per-route-transform__partial
- runtime__runtime-fault-injection-fixtures__partial
- runtime__runtime-rate-limit__partial
- source__source-ai-proxy-receiver__runtime_only
- wizard__wizard-step-route-processing__partial

## By source
- HTTP_API_POLLING: 22218
- S3_OBJECT_POLLING: 2312
- DATABASE_QUERY: 2312
- REMOTE_FILE_POLLING: 2312
- WEBHOOK_RECEIVER: 6330

## By destination
- WEBHOOK_POST: 7116
- SYSLOG_UDP: 7056
- SYSLOG_TCP: 7056
- SYSLOG_TLS: 14256

## By fault
- NONE: 32190
- http_401: 270
- http_403: 270
- http_429: 270
- http_500: 270
- http_timeout: 270
- malformed_response: 270
- syslog_destination_down: 288
- api_restart: 360
- runtime_restart: 360
- partial_route_failure: 360
- tls_certificate_error: 144
- webhook_destination_down: 72
- s3_unavailable: 30
- db_disconnect: 30
- sftp_unavailable: 30

## NA by rule
- R019f_BROWSER_ROUTE_OVERRIDE_UI: 2748
- R019g_BROWSER_FAULT_UI: 2196

## Shards
- Shard count: 32
- Total estimated cost: 1998786
