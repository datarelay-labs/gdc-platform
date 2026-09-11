FROM nginx:1.27-alpine

# Avoid Docker prepopulating a named volume at /etc/nginx/conf.d with this stub (breaks API proxy bootstrap).
RUN rm -f /etc/nginx/conf.d/default.conf

RUN apk add --no-cache openssl python3 wget

COPY nginx.conf /etc/nginx/nginx.conf
COPY default.conf.bootstrap /docker/default.conf.bootstrap
COPY reload_server.py /reload_server.py
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /reload_server.py

EXPOSE 80 443 8099

# Prefer HTTPS (when TLS is enabled, :80 redirects). Fall back to HTTP 200 without
# following redirects so bootstrap HTTP-only mode still passes.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget --no-check-certificate -qO- https://127.0.0.1/health >/dev/null 2>&1 || wget --max-redirect=0 -S -O /dev/null http://127.0.0.1/health 2>&1 | grep -q ' 200 '

ENTRYPOINT ["/entrypoint.sh"]
