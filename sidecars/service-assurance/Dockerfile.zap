# syntax=docker/dockerfile:1.7
FROM golang:1.26.3-alpine3.23@sha256:91eda9776261207ea25fd06b5b7fed8d397dd2c0a283e77f2ab6e91bfa71079d AS builder

WORKDIR /src
COPY sidecars/service-assurance/go.mod sidecars/service-assurance/go.sum ./
COPY sidecars/service-assurance/vendor ./vendor
COPY sidecars/service-assurance/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -mod=vendor -trimpath -buildvcs=false -ldflags="-s -w" -o /out/service-assurance-sidecar .

FROM ghcr.io/zaproxy/zaproxy:2.16.1@sha256:7840969c7c9fead565bf9734b12f49f6886db90b1d35b1f74d79710bbd081dab

RUN install -d -m 0755 /zap/wrk
COPY --from=builder --chown=1000:1000 --chmod=0555 /out/service-assurance-sidecar /usr/local/bin/service-assurance-sidecar
COPY --chown=1000:1000 service-assurance/rules /opt/service-assurance/rules

USER 1000:1000
ENV SERVICE_ASSURANCE_ENGINE=zap \
    SERVICE_ASSURANCE_ZAP_BINARY=/zap/zap-api-scan.py \
    SERVICE_ASSURANCE_ENGINE_VERSION=2.16.1 \
    SERVICE_ASSURANCE_ENGINE_DIGEST=sha256:7840969c7c9fead565bf9734b12f49f6886db90b1d35b1f74d79710bbd081dab \
    SERVICE_ASSURANCE_RULES_ROOT=/opt/service-assurance/rules \
    SERVICE_ASSURANCE_WORK_ROOT=/tmp/jobs
EXPOSE 8095
HEALTHCHECK NONE
ENTRYPOINT ["/usr/local/bin/service-assurance-sidecar"]
